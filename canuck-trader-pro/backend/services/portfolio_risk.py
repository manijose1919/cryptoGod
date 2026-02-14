"""
Portfolio Risk Management Service

Extends the base RiskManager with portfolio-level analytics:
- Portfolio VaR (Historical, Parametric, Component, Marginal)
- Conditional VaR / Expected Shortfall (CVaR)
- Risk Parity Allocation (equal risk contribution optimization)
- Tail Risk Hedging Signals (skewness, kurtosis monitoring)
- Dynamic Drawdown Control (CPPI-style position budgeting)
- Regime-Conditional Risk Limits

All computations use numpy for performance and avoid external paid APIs.
"""

import logging
import threading
import time
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regime-conditional risk limits
# ---------------------------------------------------------------------------

REGIME_RISK_LIMITS: Dict[str, Dict[str, float]] = {
    "UPTREND": {"max_drawdown": 0.08, "max_position": 0.25},
    "TRENDING_UP": {"max_drawdown": 0.08, "max_position": 0.25},
    "SIDEWAYS": {"max_drawdown": 0.05, "max_position": 0.15},
    "RANGING": {"max_drawdown": 0.05, "max_position": 0.15},
    "DOWNTREND": {"max_drawdown": 0.03, "max_position": 0.10},
    "TRENDING_DOWN": {"max_drawdown": 0.03, "max_position": 0.10},
    "HIGH_VOL": {"max_drawdown": 0.04, "max_position": 0.12},
    "VOLATILE": {"max_drawdown": 0.04, "max_position": 0.12},
}

# CPPI parameters
CPPI_FLOOR_START_MULT = 0.85      # Floor = starting_balance * 0.85
CPPI_FLOOR_PEAK_MULT = 0.90       # Floor = peak_balance * 0.90
CPPI_MULTIPLIER_AGGRESSIVE = 5    # conservative multiplier
CPPI_MULTIPLIER_DEFAULT = 3       # aggressive multiplier

# Tail risk thresholds
KURTOSIS_FAT_TAIL_THRESHOLD = 4.0
SKEWNESS_LEFT_TAIL_THRESHOLD = -1.0
TAIL_RISK_POSITION_REDUCTION = 0.30  # reduce 30% on fat tails

# Risk parity optimization
RISK_PARITY_MAX_ITER = 500
RISK_PARITY_TOLERANCE = 1e-8
RISK_PARITY_LEARNING_RATE = 0.01


class PortfolioRisk:
    """Thread-safe portfolio-level risk analytics (singleton).

    Provides VaR, CVaR, risk parity, tail risk monitoring,
    CPPI-style drawdown control, and regime-conditional limits.
    """

    _instance: Optional["PortfolioRisk"] = None
    _init_lock = threading.Lock()

    def __new__(cls) -> "PortfolioRisk":
        with cls._init_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._lock = threading.Lock()
                cls._instance._created_at = time.time()
                cls._instance._computation_count = 0
                cls._instance._last_var_result: Optional[dict] = None
                cls._instance._last_cvar_result: Optional[dict] = None
                cls._instance._last_tail_risk: Optional[dict] = None
                logger.info("PortfolioRisk singleton created")
            return cls._instance

    # ======================================================================
    # Portfolio VaR (Value at Risk)
    # ======================================================================

    def compute_portfolio_var(
        self,
        positions: Dict[str, float],
        prices: Dict[str, float],
        returns_data: Dict[str, List[float]],
        confidence: float = 0.95,
    ) -> dict:
        """Compute multi-method portfolio Value at Risk.

        Parameters
        ----------
        positions : dict
            Mapping of symbol -> quantity held (number of units).
        prices : dict
            Mapping of symbol -> current price per unit.
        returns_data : dict
            Mapping of symbol -> list of historical percentage returns
            (as decimals, e.g. 0.02 for +2%).
        confidence : float
            Confidence level (0.95 for 95%, 0.99 for 99%).

        Returns
        -------
        dict
            historical_var, parametric_var, component_var, marginal_var,
            portfolio_value, confidence, correlation_matrix, etc.
        """
        with self._lock:
            self._computation_count += 1

            try:
                symbols = sorted(positions.keys())
                if not symbols:
                    return self._empty_var_result(confidence)

                # Filter to symbols with sufficient return data
                valid_symbols = [
                    s for s in symbols
                    if s in returns_data and len(returns_data[s]) >= 10
                       and s in prices
                ]
                if not valid_symbols:
                    return self._empty_var_result(confidence)

                # Build aligned return matrix
                min_len = min(len(returns_data[s]) for s in valid_symbols)
                if min_len < 10:
                    return self._empty_var_result(confidence)

                returns_matrix = np.array(
                    [returns_data[s][-min_len:] for s in valid_symbols],
                    dtype=np.float64,
                )  # shape: (n_assets, n_periods)

                # Portfolio weights (value-weighted)
                values = np.array(
                    [positions.get(s, 0) * prices.get(s, 0) for s in valid_symbols],
                    dtype=np.float64,
                )
                portfolio_value = float(np.sum(values))
                if portfolio_value <= 0:
                    return self._empty_var_result(confidence)

                weights = values / portfolio_value  # shape: (n_assets,)

                # Portfolio returns = weighted sum of asset returns
                portfolio_returns = returns_matrix.T @ weights  # shape: (n_periods,)

                alpha = 1 - confidence

                # 1) Historical VaR: percentile of portfolio return distribution
                historical_var_95 = float(-np.percentile(portfolio_returns, alpha * 100))
                historical_var_99 = float(-np.percentile(portfolio_returns, 1.0))

                # 2) Parametric VaR: assumes normal distribution + correlation
                cov_matrix = np.cov(returns_matrix)
                if cov_matrix.ndim == 0:
                    # Single asset, np.cov returns scalar
                    cov_matrix = np.array([[float(cov_matrix)]])

                portfolio_variance = float(weights @ cov_matrix @ weights)
                portfolio_std = np.sqrt(max(0, portfolio_variance))
                portfolio_mean = float(np.mean(portfolio_returns))

                # Z-score for confidence level
                z_score = self._normal_z_score(confidence)
                parametric_var = float(-(portfolio_mean - z_score * portfolio_std))

                # 3) Correlation matrix
                corr_matrix = self._safe_corrcoef(returns_matrix)

                # 4) Component VaR: contribution of each position to total VaR
                #    ComponentVaR_i = w_i * (Cov_i . w) / sigma_p * VaR_total
                component_var = {}
                if portfolio_std > 0:
                    marginal_contribution = cov_matrix @ weights  # (n_assets,)
                    for i, sym in enumerate(valid_symbols):
                        beta_i = marginal_contribution[i] / portfolio_variance
                        comp_var = float(weights[i] * beta_i * parametric_var)
                        component_var[sym] = round(comp_var, 8)
                else:
                    for sym in valid_symbols:
                        component_var[sym] = 0.0

                # 5) Marginal VaR: change in VaR from adding $1 to position i
                #    MarginalVaR_i = beta_i * VaR_p / portfolio_value
                marginal_var = {}
                if portfolio_std > 0 and portfolio_value > 0:
                    marginal_contribution = cov_matrix @ weights
                    for i, sym in enumerate(valid_symbols):
                        beta_i = marginal_contribution[i] / portfolio_variance
                        mvar = float(beta_i * parametric_var / portfolio_value)
                        marginal_var[sym] = round(mvar, 10)
                else:
                    for sym in valid_symbols:
                        marginal_var[sym] = 0.0

                result = {
                    "historical_var": {
                        "var_95": round(historical_var_95, 6),
                        "var_99": round(historical_var_99, 6),
                        "var_95_usd": round(historical_var_95 * portfolio_value, 2),
                        "var_99_usd": round(historical_var_99 * portfolio_value, 2),
                    },
                    "parametric_var": {
                        "var": round(parametric_var, 6),
                        "var_usd": round(parametric_var * portfolio_value, 2),
                        "portfolio_mean": round(portfolio_mean, 6),
                        "portfolio_std": round(portfolio_std, 6),
                    },
                    "component_var": component_var,
                    "marginal_var": marginal_var,
                    "portfolio_value": round(portfolio_value, 2),
                    "confidence": confidence,
                    "n_assets": len(valid_symbols),
                    "n_periods": min_len,
                    "symbols": valid_symbols,
                    "weights": {
                        s: round(float(weights[i]), 6)
                        for i, s in enumerate(valid_symbols)
                    },
                    "correlation_matrix": {
                        valid_symbols[i]: {
                            valid_symbols[j]: round(float(corr_matrix[i, j]), 4)
                            for j in range(len(valid_symbols))
                        }
                        for i in range(len(valid_symbols))
                    },
                    "sufficient_data": True,
                }

                self._last_var_result = result
                return result

            except Exception as exc:
                logger.exception("Error computing portfolio VaR: %s", exc)
                return self._empty_var_result(confidence)

    # ======================================================================
    # CVaR / Expected Shortfall
    # ======================================================================

    def compute_cvar(
        self,
        positions: Dict[str, float],
        prices: Dict[str, float],
        returns_data: Dict[str, List[float]],
    ) -> dict:
        """Compute Conditional VaR (Expected Shortfall) at 95% and 99%.

        CVaR = average loss in the worst (1-confidence)% of scenarios.
        More conservative than VaR, better captures tail risk.

        Parameters
        ----------
        positions : dict
            Mapping of symbol -> quantity held.
        prices : dict
            Mapping of symbol -> current price.
        returns_data : dict
            Mapping of symbol -> list of historical returns (decimals).

        Returns
        -------
        dict
            cvar_95, cvar_99, worst_scenarios, comparison_to_var, etc.
        """
        with self._lock:
            try:
                symbols = sorted(positions.keys())
                valid_symbols = [
                    s for s in symbols
                    if s in returns_data and len(returns_data[s]) >= 10
                       and s in prices
                ]
                if not valid_symbols:
                    return self._empty_cvar_result()

                min_len = min(len(returns_data[s]) for s in valid_symbols)
                if min_len < 10:
                    return self._empty_cvar_result()

                returns_matrix = np.array(
                    [returns_data[s][-min_len:] for s in valid_symbols],
                    dtype=np.float64,
                )

                values = np.array(
                    [positions.get(s, 0) * prices.get(s, 0) for s in valid_symbols],
                    dtype=np.float64,
                )
                portfolio_value = float(np.sum(values))
                if portfolio_value <= 0:
                    return self._empty_cvar_result()

                weights = values / portfolio_value
                portfolio_returns = returns_matrix.T @ weights

                # VaR thresholds
                var_95 = float(np.percentile(portfolio_returns, 5))
                var_99 = float(np.percentile(portfolio_returns, 1))

                # CVaR = mean of returns below VaR threshold
                tail_95 = portfolio_returns[portfolio_returns <= var_95]
                tail_99 = portfolio_returns[portfolio_returns <= var_99]

                cvar_95 = float(np.mean(tail_95)) if len(tail_95) > 0 else var_95
                cvar_99 = float(np.mean(tail_99)) if len(tail_99) > 0 else var_99

                # Worst scenarios (5 worst returns)
                sorted_returns = np.sort(portfolio_returns)
                n_worst = min(5, len(sorted_returns))
                worst_scenarios = [
                    round(float(sorted_returns[i]), 6) for i in range(n_worst)
                ]

                result = {
                    "cvar_95": {
                        "value": round(-cvar_95, 6),
                        "value_usd": round(-cvar_95 * portfolio_value, 2),
                        "description": "Average loss in worst 5% of scenarios",
                    },
                    "cvar_99": {
                        "value": round(-cvar_99, 6),
                        "value_usd": round(-cvar_99 * portfolio_value, 2),
                        "description": "Average loss in worst 1% of scenarios",
                    },
                    "var_comparison": {
                        "var_95": round(-var_95, 6),
                        "cvar_95": round(-cvar_95, 6),
                        "cvar_exceeds_var_by": round(
                            (-cvar_95 - (-var_95)) / max(abs(var_95), 1e-10) * 100, 2
                        ),
                    },
                    "worst_scenarios": worst_scenarios,
                    "tail_observations_95": len(tail_95),
                    "tail_observations_99": len(tail_99),
                    "portfolio_value": round(portfolio_value, 2),
                    "n_periods": min_len,
                    "sufficient_data": True,
                }

                self._last_cvar_result = result
                return result

            except Exception as exc:
                logger.exception("Error computing CVaR: %s", exc)
                return self._empty_cvar_result()

    # ======================================================================
    # Risk Parity Allocation
    # ======================================================================

    def get_risk_parity_weights(
        self, returns_dict: Dict[str, List[float]]
    ) -> dict:
        """Compute risk parity weights: equal risk contribution from each asset.

        Uses iterative gradient descent to find weights where each asset
        contributes equally to portfolio variance.

        Parameters
        ----------
        returns_dict : dict
            Mapping of symbol -> list of historical returns (decimals).

        Returns
        -------
        dict
            weights (symbol -> float), risk_contributions, converged, iterations.
        """
        with self._lock:
            try:
                symbols = sorted(returns_dict.keys())
                valid_symbols = [
                    s for s in symbols if len(returns_dict[s]) >= 20
                ]
                if len(valid_symbols) < 2:
                    # With 0-1 assets, equal weight is trivially correct
                    if len(valid_symbols) == 1:
                        return {
                            "weights": {valid_symbols[0]: 1.0},
                            "risk_contributions": {valid_symbols[0]: 1.0},
                            "converged": True,
                            "iterations": 0,
                            "n_assets": 1,
                        }
                    return {
                        "weights": {},
                        "risk_contributions": {},
                        "converged": False,
                        "iterations": 0,
                        "n_assets": 0,
                        "error": "Need at least 2 assets with >= 20 return observations",
                    }

                n = len(valid_symbols)
                min_len = min(len(returns_dict[s]) for s in valid_symbols)
                returns_matrix = np.array(
                    [returns_dict[s][-min_len:] for s in valid_symbols],
                    dtype=np.float64,
                )

                cov = np.cov(returns_matrix)
                if cov.ndim == 0:
                    cov = np.array([[float(cov)]])

                # Ensure covariance matrix is positive semi-definite
                # Add small regularization if needed
                min_eig = np.min(np.real(np.linalg.eigvals(cov)))
                if min_eig < 0:
                    cov += np.eye(n) * (abs(min_eig) + 1e-8)

                # Initialize with equal weights
                weights = np.ones(n) / n
                target_risk = 1.0 / n  # equal risk contribution

                converged = False
                iteration = 0

                for iteration in range(1, RISK_PARITY_MAX_ITER + 1):
                    # Portfolio variance
                    portfolio_var = float(weights @ cov @ weights)
                    if portfolio_var <= 0:
                        break

                    portfolio_std = np.sqrt(portfolio_var)

                    # Marginal risk contribution: d(sigma_p)/d(w_i) = (Cov @ w)_i / sigma_p
                    marginal_risk = (cov @ weights) / portfolio_std

                    # Risk contribution: RC_i = w_i * marginal_risk_i
                    risk_contrib = weights * marginal_risk
                    total_risk = np.sum(risk_contrib)

                    if total_risk <= 0:
                        break

                    # Normalized risk contribution
                    risk_contrib_pct = risk_contrib / total_risk

                    # Gradient: difference from target equal contribution
                    gradient = risk_contrib_pct - target_risk

                    # Check convergence
                    if np.max(np.abs(gradient)) < RISK_PARITY_TOLERANCE:
                        converged = True
                        break

                    # Update weights via gradient descent
                    # Decrease weight for over-contributing assets, increase for under
                    weights -= RISK_PARITY_LEARNING_RATE * gradient * weights

                    # Project onto simplex (ensure sum = 1, all >= 0)
                    weights = np.maximum(weights, 1e-6)
                    weights /= np.sum(weights)

                # Final risk contribution computation
                portfolio_var = float(weights @ cov @ weights)
                portfolio_std = np.sqrt(max(0, portfolio_var))
                if portfolio_std > 0:
                    marginal_risk = (cov @ weights) / portfolio_std
                    risk_contrib = weights * marginal_risk
                    total_risk = float(np.sum(risk_contrib))
                    risk_contrib_pct = (
                        risk_contrib / total_risk if total_risk > 0
                        else np.ones(n) / n
                    )
                else:
                    risk_contrib_pct = np.ones(n) / n

                return {
                    "weights": {
                        s: round(float(weights[i]), 6)
                        for i, s in enumerate(valid_symbols)
                    },
                    "risk_contributions": {
                        s: round(float(risk_contrib_pct[i]), 6)
                        for i, s in enumerate(valid_symbols)
                    },
                    "converged": converged,
                    "iterations": iteration,
                    "n_assets": n,
                    "portfolio_std": round(portfolio_std, 8),
                }

            except Exception as exc:
                logger.exception("Error computing risk parity weights: %s", exc)
                return {
                    "weights": {},
                    "risk_contributions": {},
                    "converged": False,
                    "iterations": 0,
                    "n_assets": 0,
                    "error": str(exc),
                }

    # ======================================================================
    # Tail Risk Hedging Signals
    # ======================================================================

    def check_tail_risk(
        self, returns_data: Dict[str, List[float]]
    ) -> dict:
        """Monitor portfolio skewness and kurtosis for tail risk signals.

        Parameters
        ----------
        returns_data : dict
            Mapping of symbol -> list of historical returns (decimals).

        Returns
        -------
        dict
            skewness, kurtosis, fat_tails (bool), left_skewed (bool),
            hedge_signal, position_reduction, drawdown_distribution.
        """
        with self._lock:
            try:
                # Aggregate all returns into a portfolio-level view
                all_returns: List[float] = []
                per_asset: Dict[str, dict] = {}

                for symbol, rets in returns_data.items():
                    if len(rets) < 20:
                        continue
                    arr = np.array(rets[-200:], dtype=np.float64)  # last 200 periods

                    skew = float(self._skewness(arr))
                    kurt = float(self._kurtosis(arr))
                    per_asset[symbol] = {
                        "skewness": round(skew, 4),
                        "kurtosis": round(kurt, 4),
                        "fat_tails": kurt > KURTOSIS_FAT_TAIL_THRESHOLD,
                        "left_skewed": skew < SKEWNESS_LEFT_TAIL_THRESHOLD,
                    }
                    all_returns.extend(rets[-200:])

                if len(all_returns) < 20:
                    result = {
                        "portfolio_skewness": 0.0,
                        "portfolio_kurtosis": 3.0,
                        "fat_tails": False,
                        "left_skewed": False,
                        "hedge_signal": "NONE",
                        "position_reduction": 0.0,
                        "per_asset": {},
                        "drawdown_distribution": {},
                        "sufficient_data": False,
                    }
                    self._last_tail_risk = result
                    return result

                portfolio_arr = np.array(all_returns, dtype=np.float64)
                port_skew = float(self._skewness(portfolio_arr))
                port_kurt = float(self._kurtosis(portfolio_arr))

                fat_tails = port_kurt > KURTOSIS_FAT_TAIL_THRESHOLD
                left_skewed = port_skew < SKEWNESS_LEFT_TAIL_THRESHOLD

                # Determine hedge signal
                hedge_signal = "NONE"
                position_reduction = 0.0

                if fat_tails and left_skewed:
                    hedge_signal = "STRONG_HEDGE"
                    position_reduction = TAIL_RISK_POSITION_REDUCTION + 0.10  # 40%
                elif fat_tails:
                    hedge_signal = "REDUCE_SIZE"
                    position_reduction = TAIL_RISK_POSITION_REDUCTION  # 30%
                elif left_skewed:
                    hedge_signal = "HEDGE_CORRELATED"
                    position_reduction = 0.15  # 15%

                # Drawdown distribution from cumulative returns
                dd_dist = self._drawdown_distribution(portfolio_arr)

                result = {
                    "portfolio_skewness": round(port_skew, 4),
                    "portfolio_kurtosis": round(port_kurt, 4),
                    "fat_tails": fat_tails,
                    "left_skewed": left_skewed,
                    "hedge_signal": hedge_signal,
                    "position_reduction": round(position_reduction, 4),
                    "per_asset": per_asset,
                    "drawdown_distribution": dd_dist,
                    "sufficient_data": True,
                    "thresholds": {
                        "kurtosis_fat_tail": KURTOSIS_FAT_TAIL_THRESHOLD,
                        "skewness_left_tail": SKEWNESS_LEFT_TAIL_THRESHOLD,
                    },
                }

                self._last_tail_risk = result
                return result

            except Exception as exc:
                logger.exception("Error checking tail risk: %s", exc)
                return {
                    "portfolio_skewness": 0.0,
                    "portfolio_kurtosis": 3.0,
                    "fat_tails": False,
                    "left_skewed": False,
                    "hedge_signal": "NONE",
                    "position_reduction": 0.0,
                    "per_asset": {},
                    "drawdown_distribution": {},
                    "sufficient_data": False,
                    "error": str(exc),
                }

    # ======================================================================
    # Dynamic Drawdown Control (CPPI)
    # ======================================================================

    def get_dynamic_position_budget(
        self,
        balance: float,
        peak_balance: float,
        regime: str = "SIDEWAYS",
    ) -> dict:
        """Compute CPPI-style dynamic position budget.

        CPPI (Constant Proportion Portfolio Insurance):
        - Floor = max(starting_capital * 0.85, peak * 0.90)
        - Cushion = portfolio_value - floor
        - Position budget = min(cushion * multiplier, portfolio_value)

        Parameters
        ----------
        balance : float
            Current portfolio value.
        peak_balance : float
            Highest portfolio value observed.
        regime : str
            Current market regime for multiplier selection.

        Returns
        -------
        dict
            floor, cushion, multiplier, position_budget, budget_pct,
            regime, utilization.
        """
        with self._lock:
            try:
                if balance <= 0:
                    return {
                        "floor": 0.0,
                        "cushion": 0.0,
                        "multiplier": 0,
                        "position_budget": 0.0,
                        "budget_pct": 0.0,
                        "regime": regime,
                        "utilization": 0.0,
                        "warning": "Balance is zero or negative",
                    }

                starting_floor = balance * CPPI_FLOOR_START_MULT
                peak_floor = peak_balance * CPPI_FLOOR_PEAK_MULT
                floor = max(starting_floor, peak_floor)

                cushion = max(0.0, balance - floor)

                # Multiplier varies by regime:
                #   Aggressive regimes (UPTREND) use higher multiplier (more exposure)
                #   Defensive regimes (DOWNTREND, HIGH_VOL) use lower multiplier
                regime_upper = regime.upper()
                if regime_upper in ("UPTREND", "TRENDING_UP"):
                    multiplier = CPPI_MULTIPLIER_AGGRESSIVE
                elif regime_upper in ("DOWNTREND", "TRENDING_DOWN", "HIGH_VOL", "VOLATILE"):
                    multiplier = CPPI_MULTIPLIER_DEFAULT
                else:
                    multiplier = 4  # moderate for SIDEWAYS/RANGING

                position_budget = min(cushion * multiplier, balance)
                budget_pct = position_budget / balance if balance > 0 else 0.0

                # Utilization: how much of the cushion is being used
                utilization = (
                    1.0 - (cushion / (balance - floor * 0.5))
                    if (balance - floor * 0.5) > 0
                    else 1.0
                )
                utilization = max(0.0, min(1.0, utilization))

                # Warning if cushion is dangerously thin
                warning = None
                if cushion <= 0:
                    warning = "FLOOR BREACHED: cushion is zero. No new positions allowed."
                elif budget_pct < 0.10:
                    warning = "Low cushion: position budget under 10% of portfolio."

                result = {
                    "floor": round(floor, 2),
                    "cushion": round(cushion, 2),
                    "multiplier": multiplier,
                    "position_budget": round(position_budget, 2),
                    "budget_pct": round(budget_pct, 4),
                    "regime": regime,
                    "utilization": round(utilization, 4),
                    "balance": round(balance, 2),
                    "peak_balance": round(peak_balance, 2),
                }
                if warning:
                    result["warning"] = warning

                return result

            except Exception as exc:
                logger.exception("Error computing CPPI budget: %s", exc)
                return {
                    "floor": 0.0,
                    "cushion": 0.0,
                    "multiplier": 0,
                    "position_budget": 0.0,
                    "budget_pct": 0.0,
                    "regime": regime,
                    "utilization": 0.0,
                    "error": str(exc),
                }

    # ======================================================================
    # Regime-Conditional Risk Limits
    # ======================================================================

    def get_regime_risk_limits(self, regime: str) -> dict:
        """Return risk limits for the given market regime.

        Parameters
        ----------
        regime : str
            Market regime: UPTREND, SIDEWAYS, DOWNTREND, HIGH_VOL
            (also accepts TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE).

        Returns
        -------
        dict
            max_drawdown, max_position, regime, description.
        """
        regime_upper = regime.upper()
        limits = REGIME_RISK_LIMITS.get(regime_upper)

        if limits is None:
            # Fallback to SIDEWAYS (most conservative general regime)
            limits = REGIME_RISK_LIMITS["SIDEWAYS"]
            logger.warning(
                "Unknown regime '%s', defaulting to SIDEWAYS limits", regime
            )

        descriptions = {
            "UPTREND": "Favorable trend: wider drawdown tolerance, larger positions allowed.",
            "TRENDING_UP": "Favorable trend: wider drawdown tolerance, larger positions allowed.",
            "SIDEWAYS": "Neutral market: moderate risk limits, standard position sizing.",
            "RANGING": "Neutral market: moderate risk limits, standard position sizing.",
            "DOWNTREND": "Adverse trend: tight drawdown limit, small positions only.",
            "TRENDING_DOWN": "Adverse trend: tight drawdown limit, small positions only.",
            "HIGH_VOL": "High volatility: tight drawdown, reduced position sizes.",
            "VOLATILE": "High volatility: tight drawdown, reduced position sizes.",
        }

        return {
            "max_drawdown": limits["max_drawdown"],
            "max_drawdown_pct": round(limits["max_drawdown"] * 100, 1),
            "max_position": limits["max_position"],
            "max_position_pct": round(limits["max_position"] * 100, 1),
            "regime": regime_upper,
            "description": descriptions.get(
                regime_upper, "Unknown regime. Using conservative defaults."
            ),
        }

    # ======================================================================
    # Full Risk Report
    # ======================================================================

    def get_full_risk_report(
        self,
        positions: Dict[str, float],
        prices: Dict[str, float],
        returns_data: Dict[str, List[float]],
        regime: str = "SIDEWAYS",
        balance: Optional[float] = None,
        peak_balance: Optional[float] = None,
    ) -> dict:
        """Generate a comprehensive portfolio risk report.

        Aggregates VaR, CVaR, tail risk, CPPI budget, regime limits,
        and risk parity analysis into a single report.

        Parameters
        ----------
        positions : dict
            Mapping of symbol -> quantity held.
        prices : dict
            Mapping of symbol -> current price.
        returns_data : dict
            Mapping of symbol -> list of historical returns (decimals).
        regime : str
            Current market regime.
        balance : float, optional
            Current portfolio value. If None, computed from positions * prices.
        peak_balance : float, optional
            Peak portfolio value. If None, equals balance.

        Returns
        -------
        dict
            Comprehensive risk report with all sub-analyses.
        """
        # We intentionally do NOT hold the lock for the full report;
        # each sub-method acquires it independently to avoid deadlocks.
        try:
            # Compute balance from positions if not provided
            if balance is None:
                balance = sum(
                    positions.get(s, 0) * prices.get(s, 0)
                    for s in positions
                    if s in prices
                )
            if peak_balance is None:
                peak_balance = balance

            # Run all analyses
            var_result = self.compute_portfolio_var(
                positions, prices, returns_data, confidence=0.95
            )
            cvar_result = self.compute_cvar(positions, prices, returns_data)
            tail_risk = self.check_tail_risk(returns_data)
            cppi_budget = self.get_dynamic_position_budget(
                balance, peak_balance, regime
            )
            regime_limits = self.get_regime_risk_limits(regime)
            risk_parity = self.get_risk_parity_weights(returns_data)

            # Compute overall risk score (0-100, higher = more risk)
            risk_score = self._compute_risk_score(
                var_result, cvar_result, tail_risk, cppi_budget, regime_limits
            )

            return {
                "timestamp": time.time(),
                "portfolio_value": round(balance, 2),
                "risk_score": risk_score,
                "var": var_result,
                "cvar": cvar_result,
                "tail_risk": tail_risk,
                "cppi_budget": cppi_budget,
                "regime_limits": regime_limits,
                "risk_parity": risk_parity,
                "regime": regime,
                "recommendations": self._generate_recommendations(
                    risk_score, var_result, cvar_result, tail_risk,
                    cppi_budget, regime_limits
                ),
            }

        except Exception as exc:
            logger.exception("Error generating full risk report: %s", exc)
            return {
                "timestamp": time.time(),
                "portfolio_value": 0.0,
                "risk_score": {"score": 50, "label": "UNKNOWN"},
                "error": str(exc),
            }

    # ======================================================================
    # Status
    # ======================================================================

    def get_status(self) -> dict:
        """Return service health and summary statistics.

        Returns
        -------
        dict
            active, uptime_s, computation_count, last results summary.
        """
        with self._lock:
            uptime = time.time() - self._created_at

            status = {
                "active": True,
                "uptime_s": round(uptime, 1),
                "computation_count": self._computation_count,
                "has_var_data": self._last_var_result is not None,
                "has_cvar_data": self._last_cvar_result is not None,
                "has_tail_risk_data": self._last_tail_risk is not None,
            }

            # Include last tail risk signal if available
            if self._last_tail_risk and self._last_tail_risk.get("sufficient_data"):
                status["last_tail_risk_signal"] = {
                    "hedge_signal": self._last_tail_risk["hedge_signal"],
                    "skewness": self._last_tail_risk["portfolio_skewness"],
                    "kurtosis": self._last_tail_risk["portfolio_kurtosis"],
                }

            # Include last VaR summary if available
            if self._last_var_result and self._last_var_result.get("sufficient_data"):
                status["last_var_summary"] = {
                    "historical_var_95": self._last_var_result["historical_var"]["var_95"],
                    "parametric_var": self._last_var_result["parametric_var"]["var"],
                    "n_assets": self._last_var_result["n_assets"],
                }

            return status

    # ======================================================================
    # Internal helpers
    # ======================================================================

    @staticmethod
    def _normal_z_score(confidence: float) -> float:
        """Approximate z-score for normal distribution confidence level.

        Uses rational approximation of the inverse normal CDF.
        Accurate to ~4 decimal places for confidence in [0.90, 0.999].
        """
        # Abramowitz & Stegun approximation (rational)
        p = confidence
        if p >= 1.0:
            return 4.0
        if p <= 0.5:
            return 0.0

        # Compute for upper tail
        t = np.sqrt(-2.0 * np.log(1.0 - p))
        # Coefficients for rational approximation
        c0, c1, c2 = 2.515517, 0.802853, 0.010328
        d1, d2, d3 = 1.432788, 0.189269, 0.001308
        z = t - (c0 + c1 * t + c2 * t * t) / (
            1.0 + d1 * t + d2 * t * t + d3 * t * t * t
        )
        return float(z)

    @staticmethod
    def _skewness(arr: np.ndarray) -> float:
        """Compute sample skewness (Fisher's definition)."""
        n = len(arr)
        if n < 3:
            return 0.0
        mean = np.mean(arr)
        std = np.std(arr, ddof=1)
        if std == 0:
            return 0.0
        m3 = np.mean((arr - mean) ** 3)
        return float(m3 / (std ** 3))

    @staticmethod
    def _kurtosis(arr: np.ndarray) -> float:
        """Compute sample excess kurtosis (Fisher's definition).

        Normal distribution has excess kurtosis = 0; we return the
        non-excess (standard) kurtosis here so that normal = 3.0.
        """
        n = len(arr)
        if n < 4:
            return 3.0  # assume normal
        mean = np.mean(arr)
        std = np.std(arr, ddof=1)
        if std == 0:
            return 3.0
        m4 = np.mean((arr - mean) ** 4)
        return float(m4 / (std ** 4))

    @staticmethod
    def _safe_corrcoef(returns_matrix: np.ndarray) -> np.ndarray:
        """Compute correlation matrix with NaN safety."""
        try:
            corr = np.corrcoef(returns_matrix)
            if corr.ndim == 0:
                return np.array([[1.0]])
            # Replace NaNs with 0 (no correlation assumed)
            corr = np.nan_to_num(corr, nan=0.0)
            # Ensure diagonal is 1.0
            np.fill_diagonal(corr, 1.0)
            return corr
        except Exception:
            n = returns_matrix.shape[0]
            return np.eye(n)

    @staticmethod
    def _drawdown_distribution(returns: np.ndarray) -> dict:
        """Compute drawdown statistics from a return series.

        Returns percentiles of the drawdown distribution.
        """
        if len(returns) < 5:
            return {"sufficient_data": False}

        # Cumulative returns
        cum_returns = np.cumprod(1.0 + returns)
        running_max = np.maximum.accumulate(cum_returns)
        drawdowns = (running_max - cum_returns) / np.where(
            running_max > 0, running_max, 1.0
        )

        return {
            "max_drawdown": round(float(np.max(drawdowns)), 6),
            "mean_drawdown": round(float(np.mean(drawdowns)), 6),
            "median_drawdown": round(float(np.median(drawdowns)), 6),
            "p95_drawdown": round(float(np.percentile(drawdowns, 95)), 6),
            "current_drawdown": round(float(drawdowns[-1]), 6),
            "n_periods": len(returns),
            "sufficient_data": True,
        }

    def _compute_risk_score(
        self,
        var_result: dict,
        cvar_result: dict,
        tail_risk: dict,
        cppi_budget: dict,
        regime_limits: dict,
    ) -> dict:
        """Compute an aggregate risk score from 0 (safe) to 100 (extreme risk).

        Weighted combination of:
        - VaR magnitude (25%)
        - CVaR magnitude (25%)
        - Tail risk signals (20%)
        - CPPI cushion utilization (15%)
        - Regime risk level (15%)
        """
        score = 0.0

        # VaR component (0-25): higher VaR = higher score
        if var_result.get("sufficient_data"):
            var_pct = var_result["historical_var"]["var_95"]
            # 0% VaR = 0 score, 5%+ VaR = 25 score
            var_score = min(25.0, (var_pct / 0.05) * 25.0) if var_pct > 0 else 0.0
            score += var_score

        # CVaR component (0-25): higher CVaR = higher score
        if cvar_result.get("sufficient_data"):
            cvar_pct = cvar_result["cvar_95"]["value"]
            cvar_score = min(25.0, (cvar_pct / 0.08) * 25.0) if cvar_pct > 0 else 0.0
            score += cvar_score

        # Tail risk component (0-20)
        if tail_risk.get("sufficient_data"):
            tail_score = 0.0
            if tail_risk["fat_tails"]:
                tail_score += 10.0
            if tail_risk["left_skewed"]:
                tail_score += 10.0
            score += tail_score

        # CPPI cushion component (0-15): lower cushion = higher score
        budget_pct = cppi_budget.get("budget_pct", 0.5)
        # 100% budget = 0 score, 0% budget = 15 score
        cppi_score = max(0.0, (1.0 - budget_pct) * 15.0)
        score += cppi_score

        # Regime component (0-15)
        regime_scores = {
            "UPTREND": 3, "TRENDING_UP": 3,
            "SIDEWAYS": 7, "RANGING": 7,
            "DOWNTREND": 12, "TRENDING_DOWN": 12,
            "HIGH_VOL": 15, "VOLATILE": 15,
        }
        regime = regime_limits.get("regime", "SIDEWAYS")
        score += regime_scores.get(regime, 7)

        score = round(min(100.0, max(0.0, score)), 1)

        if score <= 20:
            label = "LOW"
        elif score <= 40:
            label = "MODERATE"
        elif score <= 60:
            label = "ELEVATED"
        elif score <= 80:
            label = "HIGH"
        else:
            label = "EXTREME"

        return {"score": score, "label": label}

    @staticmethod
    def _generate_recommendations(
        risk_score: dict,
        var_result: dict,
        cvar_result: dict,
        tail_risk: dict,
        cppi_budget: dict,
        regime_limits: dict,
    ) -> List[str]:
        """Generate actionable risk management recommendations."""
        recs: List[str] = []

        # Risk score based
        score = risk_score.get("score", 50)
        if score >= 80:
            recs.append(
                "EXTREME risk level: consider closing all positions or "
                "hedging immediately."
            )
        elif score >= 60:
            recs.append(
                "HIGH risk: reduce position sizes by at least 30% and "
                "tighten stop-losses."
            )

        # Tail risk based
        if tail_risk.get("sufficient_data"):
            signal = tail_risk.get("hedge_signal", "NONE")
            if signal == "STRONG_HEDGE":
                recs.append(
                    "STRONG tail risk: fat tails AND left skew detected. "
                    "Reduce all positions by 40% and avoid adding correlated assets."
                )
            elif signal == "REDUCE_SIZE":
                recs.append(
                    "Fat tails detected (kurtosis > {:.1f}): reduce position "
                    "sizes by 30% to protect against outlier moves.".format(
                        KURTOSIS_FAT_TAIL_THRESHOLD
                    )
                )
            elif signal == "HEDGE_CORRELATED":
                recs.append(
                    "Left-skewed returns (skewness < {:.1f}): hedge by "
                    "diversifying into uncorrelated assets or reducing "
                    "exposure to most-correlated positions.".format(
                        SKEWNESS_LEFT_TAIL_THRESHOLD
                    )
                )

        # CPPI budget based
        if cppi_budget.get("warning"):
            recs.append(f"CPPI warning: {cppi_budget['warning']}")
        elif cppi_budget.get("budget_pct", 1.0) < 0.20:
            recs.append(
                "CPPI cushion thin: only {:.1f}% of portfolio available for "
                "new positions. Prioritize protecting existing gains.".format(
                    cppi_budget.get("budget_pct", 0) * 100
                )
            )

        # VaR based
        if var_result.get("sufficient_data"):
            var_pct = var_result["historical_var"]["var_95"]
            if var_pct > 0.03:
                recs.append(
                    "Portfolio VaR at {:.2f}% (95% confidence): daily loss "
                    "could exceed {:.2f}% in 1-in-20 scenarios. Consider "
                    "reducing concentrated positions.".format(
                        var_pct * 100, var_pct * 100
                    )
                )

        # Regime based
        regime = regime_limits.get("regime", "SIDEWAYS")
        max_dd = regime_limits.get("max_drawdown_pct", 5)
        max_pos = regime_limits.get("max_position_pct", 15)
        if regime in ("DOWNTREND", "TRENDING_DOWN"):
            recs.append(
                f"Downtrend regime: max drawdown {max_dd}%, max position "
                f"{max_pos}%. Focus on capital preservation."
            )
        elif regime in ("HIGH_VOL", "VOLATILE"):
            recs.append(
                f"High volatility regime: max drawdown {max_dd}%, max "
                f"position {max_pos}%. Use wider stops, smaller sizes."
            )

        if not recs:
            recs.append(
                "Risk levels within normal parameters. Continue current "
                "strategy with standard position sizing."
            )

        return recs

    @staticmethod
    def _empty_var_result(confidence: float) -> dict:
        """Return an empty VaR result when insufficient data exists."""
        return {
            "historical_var": {
                "var_95": 0.0, "var_99": 0.0,
                "var_95_usd": 0.0, "var_99_usd": 0.0,
            },
            "parametric_var": {
                "var": 0.0, "var_usd": 0.0,
                "portfolio_mean": 0.0, "portfolio_std": 0.0,
            },
            "component_var": {},
            "marginal_var": {},
            "portfolio_value": 0.0,
            "confidence": confidence,
            "n_assets": 0,
            "n_periods": 0,
            "symbols": [],
            "weights": {},
            "correlation_matrix": {},
            "sufficient_data": False,
        }

    @staticmethod
    def _empty_cvar_result() -> dict:
        """Return an empty CVaR result when insufficient data exists."""
        return {
            "cvar_95": {"value": 0.0, "value_usd": 0.0, "description": "Insufficient data"},
            "cvar_99": {"value": 0.0, "value_usd": 0.0, "description": "Insufficient data"},
            "var_comparison": {"var_95": 0.0, "cvar_95": 0.0, "cvar_exceeds_var_by": 0.0},
            "worst_scenarios": [],
            "tail_observations_95": 0,
            "tail_observations_99": 0,
            "portfolio_value": 0.0,
            "n_periods": 0,
            "sufficient_data": False,
        }


# ---------------------------------------------------------------------------
# Public singleton accessor
# ---------------------------------------------------------------------------

def get_portfolio_risk() -> PortfolioRisk:
    """Return the singleton PortfolioRisk instance."""
    return PortfolioRisk()
