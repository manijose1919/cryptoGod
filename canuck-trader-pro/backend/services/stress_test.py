"""
Stress Test Service

Runs hypothetical stress-test scenarios against the current portfolio to
evaluate resilience under extreme market conditions.

Scenarios tested:
  1. Flash Crash (10%)
  2. Flash Crash Severe (20%)
  3. BTC Crash with alt-coin correlation amplification
  4. Funding Squeeze (all stops hit)
  5. Liquidity Drain (5x slippage)
  6. Black Swan (30% drop)
"""

import logging
import threading
from typing import Optional

import numpy as np

logger = logging.getLogger("stress_test")

# ---------------------------------------------------------------------------
# Scenario definitions
# ---------------------------------------------------------------------------

_SCENARIOS = [
    {
        "name": "Flash Crash (10%)",
        "description": "All assets drop 10% instantly",
        "drop_pct": 0.10,
        "btc_drop": 0.10,
        "alt_drop": 0.10,
        "mode": "uniform",
    },
    {
        "name": "Flash Crash Severe (20%)",
        "description": "All assets drop 20% instantly",
        "drop_pct": 0.20,
        "btc_drop": 0.20,
        "alt_drop": 0.20,
        "mode": "uniform",
    },
    {
        "name": "BTC Crash + Alt Correlation",
        "description": "BTC drops 15%, alts drop 25% due to correlation amplification",
        "drop_pct": 0.15,
        "btc_drop": 0.15,
        "alt_drop": 0.25,
        "mode": "btc_alt",
    },
    {
        "name": "Funding Squeeze",
        "description": "All positions hit stop-loss simultaneously",
        "drop_pct": 0.0,
        "btc_drop": 0.0,
        "alt_drop": 0.0,
        "mode": "stop_loss",
    },
    {
        "name": "Liquidity Drain",
        "description": "Slippage increases 5x, each position loses 3%",
        "drop_pct": 0.03,
        "btc_drop": 0.03,
        "alt_drop": 0.03,
        "mode": "uniform",
    },
    {
        "name": "Black Swan (30%)",
        "description": "30% drop across all assets",
        "drop_pct": 0.30,
        "btc_drop": 0.30,
        "alt_drop": 0.30,
        "mode": "uniform",
    },
]

# Default stop-loss percentage used for the funding-squeeze scenario when a
# position does not provide its own.
_DEFAULT_STOP_LOSS_PCT = 0.05  # 5%

# Liquidation threshold – if total equity drops below this fraction of the
# initial portfolio value we consider the portfolio "liquidated".
_LIQUIDATION_THRESHOLD = 0.20  # 80% loss


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def _is_btc(symbol: str) -> bool:
    """Return True if the symbol represents a BTC position."""
    sym = symbol.upper()
    return sym.startswith("BTC") or "BTC" in sym.split("/")[0] if "/" in sym else sym.startswith("BTC")


def _position_value(pos: dict) -> float:
    """Compute the market value of a single position.

    Accepts either:
      - {"qty": float, "price": float}
      - {"value": float}
    """
    if "value" in pos:
        return float(pos["value"])
    qty = float(pos.get("qty", pos.get("quantity", 0)))
    price = float(pos.get("price", pos.get("avg_price", pos.get("current_price", 0))))
    return qty * price


def _apply_scenario(
    positions: dict[str, dict],
    scenario: dict,
) -> tuple[float, str]:
    """Apply a single scenario to positions and return (total_loss, worst_symbol).

    Returns absolute loss (positive number) and the symbol that lost the most.
    """
    total_loss = 0.0
    worst_loss = 0.0
    worst_symbol = ""

    for symbol, pos in positions.items():
        value = _position_value(pos)
        if value <= 0:
            continue

        mode = scenario["mode"]

        if mode == "stop_loss":
            sl = float(pos.get("stop_loss_pct", _DEFAULT_STOP_LOSS_PCT))
            loss = value * sl
        elif mode == "btc_alt":
            drop = scenario["btc_drop"] if _is_btc(symbol) else scenario["alt_drop"]
            loss = value * drop
        else:  # uniform
            loss = value * scenario["drop_pct"]

        total_loss += loss
        if loss > worst_loss:
            worst_loss = loss
            worst_symbol = symbol

    return total_loss, worst_symbol


# ---------------------------------------------------------------------------
# StressTester class (thread-safe singleton)
# ---------------------------------------------------------------------------

class StressTester:
    """Runs hypothetical stress-test scenarios against a portfolio."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        logger.info("StressTester initialised")

    # ------------------------------------------------------------------
    # run_scenarios
    # ------------------------------------------------------------------

    def run_scenarios(
        self,
        positions: dict[str, dict],
        balance: float,
    ) -> dict:
        """Run all predefined stress scenarios and return an aggregate report.

        Parameters
        ----------
        positions : dict
            Mapping of symbol -> position dict.  Each position dict should
            contain at least ``qty`` + ``price`` **or** ``value``.
        balance : float
            Total portfolio balance (cash + positions) in USD.

        Returns
        -------
        dict
            ``{"scenarios": [...], "max_loss_usd": float, "max_loss_pct": float,
               "overall_resilience": "HIGH" | "MEDIUM" | "LOW"}``
        """
        with self._lock:
            return self._run_scenarios_locked(positions, balance)

    def _run_scenarios_locked(
        self,
        positions: dict[str, dict],
        balance: float,
    ) -> dict:
        if balance <= 0:
            logger.warning("run_scenarios called with zero/negative balance")
            return {
                "scenarios": [],
                "max_loss_usd": 0.0,
                "max_loss_pct": 0.0,
                "overall_resilience": "HIGH",
            }

        results: list[dict] = []
        max_loss_usd = 0.0
        max_loss_pct = 0.0

        for scenario in _SCENARIOS:
            try:
                loss_usd, worst_sym = _apply_scenario(positions, scenario)
                loss_pct = (loss_usd / balance) * 100.0 if balance > 0 else 0.0
                surviving = (loss_usd / balance) < (1.0 - _LIQUIDATION_THRESHOLD) if balance > 0 else True

                entry = {
                    "name": scenario["name"],
                    "description": scenario["description"],
                    "loss_usd": round(loss_usd, 2),
                    "loss_pct": round(loss_pct, 2),
                    "worst_position": worst_sym or "N/A",
                    "surviving": surviving,
                }
                results.append(entry)

                if loss_usd > max_loss_usd:
                    max_loss_usd = loss_usd
                if loss_pct > max_loss_pct:
                    max_loss_pct = loss_pct

            except Exception:
                logger.exception("Error running scenario %s", scenario["name"])
                results.append({
                    "name": scenario["name"],
                    "description": scenario["description"],
                    "loss_usd": 0.0,
                    "loss_pct": 0.0,
                    "worst_position": "ERROR",
                    "surviving": True,
                })

        # Overall resilience rating
        if max_loss_pct >= 50:
            resilience = "LOW"
        elif max_loss_pct >= 25:
            resilience = "MEDIUM"
        else:
            resilience = "HIGH"

        return {
            "scenarios": results,
            "max_loss_usd": round(max_loss_usd, 2),
            "max_loss_pct": round(max_loss_pct, 2),
            "overall_resilience": resilience,
        }

    # ------------------------------------------------------------------
    # get_risk_score
    # ------------------------------------------------------------------

    def get_risk_score(
        self,
        positions: dict[str, dict],
        balance: float,
    ) -> dict:
        """Compute an overall portfolio risk score from 0 (safe) to 100 (extreme).

        Factors:
          - Concentration risk: how much of the portfolio is in a single asset.
          - Total exposure: ratio of invested capital to total balance.
          - Worst-case drawdown: max loss from the stress scenarios.

        Parameters
        ----------
        positions : dict
            Symbol -> position dict.
        balance : float
            Total portfolio balance in USD.

        Returns
        -------
        dict
            ``{"score": int, "rating": str, "recommendation": str}``
        """
        with self._lock:
            return self._get_risk_score_locked(positions, balance)

    def _get_risk_score_locked(
        self,
        positions: dict[str, dict],
        balance: float,
    ) -> dict:
        if balance <= 0 or not positions:
            return {
                "score": 0,
                "rating": "LOW_RISK",
                "recommendation": "No open positions – portfolio is fully in cash.",
            }

        try:
            # --- Concentration risk (0-100) ---
            values = np.array([_position_value(p) for p in positions.values()], dtype=np.float64)
            total_invested = float(np.sum(values))

            if total_invested <= 0:
                return {
                    "score": 0,
                    "rating": "LOW_RISK",
                    "recommendation": "No meaningful exposure detected.",
                }

            weights = values / total_invested
            # Herfindahl-Hirschman style: sum of squared weights.
            # 1 position = 1.0, perfectly spread N positions = 1/N.
            hhi = float(np.sum(weights ** 2))
            # Normalise: 1 position → 100, many equally-weighted → low
            n = len(values)
            if n > 1:
                min_hhi = 1.0 / n
                concentration_score = ((hhi - min_hhi) / (1.0 - min_hhi)) * 100.0
            else:
                concentration_score = 100.0
            concentration_score = np.clip(concentration_score, 0, 100)

            # --- Exposure risk (0-100) ---
            exposure_ratio = total_invested / balance
            # >1.0 means leveraged
            exposure_score = float(np.clip(exposure_ratio * 60, 0, 100))

            # --- Worst-case drawdown risk (0-100) ---
            scenario_report = self._run_scenarios_locked(positions, balance)
            max_loss_pct = scenario_report["max_loss_pct"]
            drawdown_score = float(np.clip(max_loss_pct * 1.5, 0, 100))

            # --- Weighted composite ---
            composite = (
                0.30 * float(concentration_score)
                + 0.30 * exposure_score
                + 0.40 * drawdown_score
            )
            score = int(np.clip(round(composite), 0, 100))

            # Rating buckets
            if score <= 25:
                rating = "LOW_RISK"
            elif score <= 50:
                rating = "MODERATE"
            elif score <= 75:
                rating = "HIGH_RISK"
            else:
                rating = "CRITICAL"

            # Recommendation
            recommendation = self._build_recommendation(
                score, rating, concentration_score, exposure_score, drawdown_score, positions
            )

            return {
                "score": score,
                "rating": rating,
                "recommendation": recommendation,
            }

        except Exception:
            logger.exception("Error computing risk score")
            return {
                "score": 50,
                "rating": "MODERATE",
                "recommendation": "Unable to fully assess risk – review positions manually.",
            }

    @staticmethod
    def _build_recommendation(
        score: int,
        rating: str,
        concentration: float,
        exposure: float,
        drawdown: float,
        positions: dict,
    ) -> str:
        parts: list[str] = []

        if concentration > 60:
            symbols = list(positions.keys())
            if symbols:
                values = [(s, _position_value(p)) for s, p in positions.items()]
                values.sort(key=lambda x: x[1], reverse=True)
                top = values[0][0]
                parts.append(f"High concentration in {top} – consider diversifying.")

        if exposure > 70:
            parts.append("Total exposure is very high – reduce position sizes or increase cash buffer.")

        if drawdown > 60:
            parts.append("Worst-case drawdown is severe – tighten stop-losses or hedge with inverse positions.")

        if not parts:
            if rating == "LOW_RISK":
                parts.append("Portfolio risk is well managed. No immediate action required.")
            elif rating == "MODERATE":
                parts.append("Risk is acceptable but monitor concentration and drawdown levels.")
            else:
                parts.append("Review open positions and consider reducing overall exposure.")

        return " ".join(parts)


# ---------------------------------------------------------------------------
# Singleton access
# ---------------------------------------------------------------------------

_instance: Optional[StressTester] = None
_instance_lock = threading.Lock()


def get_stress_tester() -> StressTester:
    """Return the singleton StressTester instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = StressTester()
    return _instance
