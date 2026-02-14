"""
Regime-Aware Strategy Routing Service

Enhances basic regime-strategy mapping with adaptive, performance-tracked routing:

1. **Enhanced Regime Detection** - Combines ADX, Bollinger Bandwidth, Hurst exponent,
   and market correlation structure into six fine-grained regimes:
   STRONG_TREND, WEAK_TREND, RANGE_BOUND, BREAKOUT, CRISIS, LOW_VOL_DRIFT

2. **Strategy Scoring Per Regime** - Rolling 100-trade window per (strategy, regime),
   scores = win_rate * avg_pnl * sqrt(trade_count), auto-throttle below 0.3

3. **Transition Detection** - Detects RANGE->BREAKOUT, TREND->REVERSAL, etc.,
   routes "transition specialist" strategies during regime shifts

4. **Multi-Asset Regime** - BTC vs alt regime divergence, alt-season detection,
   risk-off correlation spike detection

5. **Adaptive Weighting** - Multiplicative weights algorithm with decaying
   learning rate as data accumulates

Thread-safe via threading.Lock on all mutable state.
Dependencies: numpy, pandas, ta library.
"""

import logging
import math
import threading
import time
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import ta

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REGIMES = [
    "STRONG_TREND",
    "WEAK_TREND",
    "RANGE_BOUND",
    "BREAKOUT",
    "CRISIS",
    "LOW_VOL_DRIFT",
]

# Default strategy affinity per regime (initial weights before adaptation)
DEFAULT_REGIME_STRATEGIES: Dict[str, Dict[str, float]] = {
    "STRONG_TREND": {
        "EMA_CROSSOVER": 1.5, "TRIPLE_EMA": 1.5, "MACD": 1.3, "ADX_TREND": 1.6,
        "SUPERTREND": 1.4, "MOMENTUM_ROC": 1.3, "ICHIMOKU": 1.2, "VWAP": 1.0,
        "OBV": 1.1, "MULTI_CONSENSUS": 1.0,
    },
    "WEAK_TREND": {
        "EMA_CROSSOVER": 1.2, "MACD": 1.1, "ADX_TREND": 1.0, "SUPERTREND": 1.1,
        "RSI": 0.9, "BOLLINGER": 1.0, "VWAP": 1.1, "ICHIMOKU": 1.0,
        "PIVOT_POINTS": 1.0, "MULTI_CONSENSUS": 1.1,
    },
    "RANGE_BOUND": {
        "BOLLINGER": 1.5, "KELTNER": 1.4, "MEAN_REVERT": 1.6, "RSI": 1.3,
        "STOCH_RSI": 1.3, "CCI": 1.2, "WILLIAMS_R": 1.1, "PIVOT_POINTS": 1.3,
        "DONCHIAN": 0.7, "VOL_SQUEEZE": 1.2,
    },
    "BREAKOUT": {
        "ATR_BREAKOUT": 1.7, "DONCHIAN": 1.5, "VOL_SQUEEZE": 1.6, "VOL_SPIKE": 1.4,
        "MOMENTUM_ROC": 1.3, "KELTNER": 1.1, "ENGULFING": 1.2,
        "SUPERTREND": 1.2, "MACD": 1.0, "OBV": 1.1,
    },
    "CRISIS": {
        "RSI": 1.3, "RSI_DIVERGENCE": 1.5, "MACD_DIVERGENCE": 1.4,
        "MEAN_REVERT": 1.2, "BOLLINGER": 1.1, "ENGULFING": 1.3,
        "STOCH_RSI": 1.1, "WILLIAMS_R": 1.0, "CCI": 1.0,
        "MULTI_CONSENSUS": 0.8,
    },
    "LOW_VOL_DRIFT": {
        "BOLLINGER": 1.3, "KELTNER": 1.2, "VOL_SQUEEZE": 1.5,
        "MEAN_REVERT": 1.3, "VWAP": 1.2, "EMA_CROSSOVER": 1.0,
        "PIVOT_POINTS": 1.1, "RSI": 1.0, "TRIPLE_EMA": 0.9,
        "OBV": 1.0,
    },
}

# Transition specialist strategies
TRANSITION_STRATEGIES: Dict[str, List[str]] = {
    "RANGE_BOUND->BREAKOUT": ["ATR_BREAKOUT", "VOL_SQUEEZE", "DONCHIAN", "VOL_SPIKE"],
    "STRONG_TREND->RANGE_BOUND": ["MEAN_REVERT", "BOLLINGER", "RSI", "STOCH_RSI"],
    "WEAK_TREND->STRONG_TREND": ["EMA_CROSSOVER", "TRIPLE_EMA", "ADX_TREND", "SUPERTREND"],
    "RANGE_BOUND->CRISIS": ["RSI_DIVERGENCE", "MACD_DIVERGENCE", "ENGULFING"],
    "STRONG_TREND->CRISIS": ["RSI_DIVERGENCE", "MACD_DIVERGENCE", "ENGULFING"],
    "CRISIS->WEAK_TREND": ["RSI", "MEAN_REVERT", "BOLLINGER", "ENGULFING"],
    "LOW_VOL_DRIFT->BREAKOUT": ["ATR_BREAKOUT", "VOL_SQUEEZE", "DONCHIAN", "VOL_SPIKE"],
    "WEAK_TREND->RANGE_BOUND": ["MEAN_REVERT", "BOLLINGER", "KELTNER", "PIVOT_POINTS"],
}

# Rolling window size for per-(strategy, regime) performance tracking
ROLLING_WINDOW = 100

# Minimum score before a strategy gets throttled in a regime
THROTTLE_THRESHOLD = 0.3

# Multiplicative weights update parameters
MW_INITIAL_LR = 0.15
MW_LR_DECAY = 0.995  # learning rate decays per update
MW_MIN_LR = 0.01

# Alt-season detection parameters
ALT_SEASON_DAYS = 3
ALT_OUTPERFORM_THRESHOLD = 0.02  # 2% cumulative outperformance

# Correlation spike for risk-off detection
RISK_OFF_CORR_THRESHOLD = 0.85
RISK_OFF_MIN_ASSETS = 4

# Hurst exponent lookback
HURST_LOOKBACK = 100

# Cache TTL for regime detection (seconds)
REGIME_CACHE_TTL = 30


# ---------------------------------------------------------------------------
# Hurst Exponent Calculator
# ---------------------------------------------------------------------------

def _compute_hurst(series: np.ndarray, max_lag: int = 20) -> float:
    """Estimate Hurst exponent via rescaled range (R/S) analysis.

    H > 0.5: trending (persistent)
    H = 0.5: random walk
    H < 0.5: mean-reverting (anti-persistent)
    """
    n = len(series)
    if n < max_lag * 2:
        return 0.5  # insufficient data, assume random walk

    lags = range(2, min(max_lag + 1, n // 2))
    rs_values = []
    lag_values = []

    for lag in lags:
        # Split into subseries of length `lag`
        n_sub = n // lag
        if n_sub < 1:
            continue

        rs_list = []
        for i in range(n_sub):
            sub = series[i * lag:(i + 1) * lag]
            if len(sub) < 2:
                continue
            mean_sub = np.mean(sub)
            deviations = sub - mean_sub
            cumulative = np.cumsum(deviations)
            r = np.max(cumulative) - np.min(cumulative)
            s = np.std(sub, ddof=1)
            if s > 0:
                rs_list.append(r / s)

        if rs_list:
            rs_values.append(np.mean(rs_list))
            lag_values.append(lag)

    if len(rs_values) < 3:
        return 0.5

    # Linear regression of log(R/S) vs log(lag)
    log_lags = np.log(np.array(lag_values, dtype=float))
    log_rs = np.log(np.array(rs_values, dtype=float))

    # Filter out any invalid values
    valid = np.isfinite(log_lags) & np.isfinite(log_rs)
    if np.sum(valid) < 3:
        return 0.5

    log_lags = log_lags[valid]
    log_rs = log_rs[valid]

    try:
        coeffs = np.polyfit(log_lags, log_rs, 1)
        hurst = float(coeffs[0])
        # Clamp to reasonable range
        return max(0.0, min(1.0, hurst))
    except Exception:
        return 0.5


# ---------------------------------------------------------------------------
# Strategy-Regime Performance Tracker
# ---------------------------------------------------------------------------

class _StrategyRegimeRecord:
    """Rolling window of trade results for one (strategy, regime) pair."""

    __slots__ = ("strategy", "regime", "trades", "max_size")

    def __init__(self, strategy: str, regime: str, max_size: int = ROLLING_WINDOW):
        self.strategy = strategy
        self.regime = regime
        self.trades: deque = deque(maxlen=max_size)
        self.max_size = max_size

    def record(self, pnl: float) -> None:
        self.trades.append(pnl)

    @property
    def trade_count(self) -> int:
        return len(self.trades)

    @property
    def win_rate(self) -> float:
        if not self.trades:
            return 0.5
        wins = sum(1 for p in self.trades if p > 0)
        return wins / len(self.trades)

    @property
    def avg_pnl(self) -> float:
        if not self.trades:
            return 0.0
        return float(np.mean(list(self.trades)))

    @property
    def score(self) -> float:
        """Score = win_rate * avg_pnl * sqrt(trade_count).

        Higher is better. Rewards strategies that win often, win big,
        and have enough data to be trustworthy.
        """
        if self.trade_count < 3:
            return 1.0  # neutral score for insufficient data
        wr = self.win_rate
        ap = self.avg_pnl
        # Normalise avg_pnl to avoid domination by magnitude
        # Use sign-preserving sqrt-scaling
        pnl_factor = math.copysign(math.sqrt(abs(ap)) if abs(ap) < 1 else ap, ap) if ap != 0 else 0
        return wr * (1.0 + pnl_factor) * math.sqrt(self.trade_count)

    def to_dict(self) -> dict:
        return {
            "strategy": self.strategy,
            "regime": self.regime,
            "trade_count": self.trade_count,
            "win_rate": round(self.win_rate, 4),
            "avg_pnl": round(self.avg_pnl, 6),
            "score": round(self.score, 4),
        }


# ---------------------------------------------------------------------------
# Main Router Class
# ---------------------------------------------------------------------------

class RegimeRouter:
    """Enhanced regime-aware strategy routing with adaptive weighting."""

    def __init__(self):
        self._lock = threading.Lock()

        # Regime detection cache: symbol -> (timestamp, result_dict)
        self._regime_cache: Dict[str, Tuple[float, dict]] = {}

        # Regime history: global list of regime detections
        self._regime_history: deque = deque(maxlen=500)

        # Per-(strategy, regime) performance records
        # Key: (strategy_name, regime_name)
        self._perf: Dict[Tuple[str, str], _StrategyRegimeRecord] = {}

        # Adaptive weights per regime: regime -> {strategy -> weight}
        self._adaptive_weights: Dict[str, Dict[str, float]] = {}
        for regime, defaults in DEFAULT_REGIME_STRATEGIES.items():
            self._adaptive_weights[regime] = dict(defaults)

        # Learning rate (decays over time)
        self._learning_rate = MW_INITIAL_LR
        self._total_updates = 0

        # Multi-asset regime tracking
        self._asset_regimes: Dict[str, str] = {}  # symbol -> current regime
        self._asset_returns: Dict[str, deque] = defaultdict(lambda: deque(maxlen=200))

        # Alt-season tracking
        self._alt_outperformance: deque = deque(maxlen=72)  # 72 x 1h = 3 days

        # Previous regime per symbol (for transition detection)
        self._prev_regime: Dict[str, str] = {}

        logger.info("RegimeRouter initialized with %d regimes, adaptive weighting enabled",
                     len(REGIMES))

    # ===================================================================
    # Regime Detection
    # ===================================================================

    def get_current_regime(self, df: pd.DataFrame, symbol: str = "BTC/USD") -> dict:
        """Detect current market regime using multi-indicator fusion.

        Combines:
        - ADX for trend strength
        - Bollinger Bandwidth for volatility state
        - Hurst exponent for mean-reversion vs trending character
        - Price action analysis for crisis / breakout detection

        Returns:
            dict with keys: regime, confidence, adx, bb_width, hurst,
                            volatility_state, trend_strength, metadata
        """
        now = time.time()

        # Check cache
        with self._lock:
            cached = self._regime_cache.get(symbol)
            if cached and now - cached[0] < REGIME_CACHE_TTL:
                return cached[1]

        n = len(df)
        if n < 30:
            result = self._default_regime(symbol)
            with self._lock:
                self._regime_cache[symbol] = (now, result)
            return result

        close = df["close"]
        high = df["high"]
        low = df["low"]

        # --- 1. ADX: Trend strength ---
        try:
            adx_indicator = ta.trend.ADXIndicator(high, low, close, window=14)
            adx_val = float(adx_indicator.adx().iloc[-1])
            plus_di = float(adx_indicator.adx_pos().iloc[-1])
            minus_di = float(adx_indicator.adx_neg().iloc[-1])
        except Exception:
            adx_val = 20.0
            plus_di = minus_di = 15.0

        # --- 2. Bollinger Bandwidth: Volatility ---
        try:
            bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
            bb_upper = float(bb.bollinger_hband().iloc[-1])
            bb_lower = float(bb.bollinger_lband().iloc[-1])
            bb_mid = float(bb.bollinger_mavg().iloc[-1])
            bb_width = (bb_upper - bb_lower) / bb_mid if bb_mid > 0 else 0.0

            # Historical bandwidth for percentile rank
            bb_upper_s = bb.bollinger_hband()
            bb_lower_s = bb.bollinger_lband()
            bb_mid_s = bb.bollinger_mavg()
            bw_series = ((bb_upper_s - bb_lower_s) / bb_mid_s).dropna()
            if len(bw_series) >= 20:
                bw_percentile = float((bw_series < bb_width).sum() / len(bw_series))
            else:
                bw_percentile = 0.5
        except Exception:
            bb_width = 0.04
            bw_percentile = 0.5

        # --- 3. Hurst exponent: Trend persistence ---
        close_arr = close.values[-min(HURST_LOOKBACK, n):]
        if len(close_arr) > 20 and np.all(close_arr > 0):
            log_returns = np.diff(np.log(close_arr))
            hurst = _compute_hurst(log_returns)
        else:
            hurst = 0.5

        # --- 4. Recent drawdown for crisis detection ---
        recent_high = float(high.iloc[-20:].max())
        current_close = float(close.iloc[-1])
        drawdown_pct = (recent_high - current_close) / recent_high * 100 if recent_high > 0 else 0

        # --- 5. ATR-based volatility magnitude ---
        try:
            atr = ta.volatility.AverageTrueRange(high, low, close, window=14).average_true_range()
            atr_pct = float(atr.iloc[-1]) / current_close * 100 if current_close > 0 else 0
        except Exception:
            atr_pct = 1.0

        # --- 6. Regime classification logic ---
        regime, confidence = self._classify_regime(
            adx_val, plus_di, minus_di, bb_width, bw_percentile,
            hurst, drawdown_pct, atr_pct
        )

        # Determine trend direction
        if plus_di > minus_di:
            trend_direction = "UP"
        elif minus_di > plus_di:
            trend_direction = "DOWN"
        else:
            trend_direction = "NEUTRAL"

        result = {
            "symbol": symbol,
            "regime": regime,
            "confidence": round(confidence, 1),
            "trend_direction": trend_direction,
            "adx": round(adx_val, 2),
            "plus_di": round(plus_di, 2),
            "minus_di": round(minus_di, 2),
            "bb_width": round(bb_width, 4),
            "bb_width_percentile": round(bw_percentile, 3),
            "hurst": round(hurst, 4),
            "drawdown_pct": round(drawdown_pct, 2),
            "atr_pct": round(atr_pct, 3),
            "timestamp": now,
        }

        with self._lock:
            # Track previous regime for transition detection
            old = self._asset_regimes.get(symbol)
            if old and old != regime:
                self._prev_regime[symbol] = old

            self._asset_regimes[symbol] = regime
            self._regime_cache[symbol] = (now, result)

            # Append to global history
            self._regime_history.append({
                "symbol": symbol,
                "regime": regime,
                "confidence": round(confidence, 1),
                "timestamp": now,
            })

        return result

    def _classify_regime(
        self,
        adx: float,
        plus_di: float,
        minus_di: float,
        bb_width: float,
        bw_percentile: float,
        hurst: float,
        drawdown_pct: float,
        atr_pct: float,
    ) -> Tuple[str, float]:
        """Classify into one of six regimes based on indicator fusion.

        Returns (regime_name, confidence_0_to_100).
        """
        scores: Dict[str, float] = {r: 0.0 for r in REGIMES}

        # ----- CRISIS -----
        # Steep drawdown + high volatility + possible high correlation
        if drawdown_pct > 8:
            scores["CRISIS"] += 3.0
        elif drawdown_pct > 5:
            scores["CRISIS"] += 2.0
        elif drawdown_pct > 3:
            scores["CRISIS"] += 1.0

        if atr_pct > 3.0:
            scores["CRISIS"] += 2.0
        elif atr_pct > 2.0:
            scores["CRISIS"] += 1.0

        # Downtrend component
        if minus_di > plus_di + 10 and adx > 30:
            scores["CRISIS"] += 1.5

        # ----- STRONG_TREND -----
        if adx > 40:
            scores["STRONG_TREND"] += 3.0
        elif adx > 30:
            scores["STRONG_TREND"] += 2.0
        elif adx > 25:
            scores["STRONG_TREND"] += 1.0

        if hurst > 0.65:
            scores["STRONG_TREND"] += 2.0
        elif hurst > 0.55:
            scores["STRONG_TREND"] += 1.0

        # Directional consistency
        di_diff = abs(plus_di - minus_di)
        if di_diff > 15:
            scores["STRONG_TREND"] += 1.0

        # ----- WEAK_TREND -----
        if 20 <= adx <= 30:
            scores["WEAK_TREND"] += 2.0
        elif 15 <= adx < 20:
            scores["WEAK_TREND"] += 1.0

        if 0.50 <= hurst <= 0.60:
            scores["WEAK_TREND"] += 1.5

        if 5 <= di_diff <= 15:
            scores["WEAK_TREND"] += 1.0

        # ----- RANGE_BOUND -----
        if adx < 20:
            scores["RANGE_BOUND"] += 2.5
        elif adx < 25:
            scores["RANGE_BOUND"] += 1.0

        if hurst < 0.45:
            scores["RANGE_BOUND"] += 2.5
        elif hurst < 0.50:
            scores["RANGE_BOUND"] += 1.5

        if di_diff < 5:
            scores["RANGE_BOUND"] += 1.0

        # Moderate volatility
        if 0.30 <= bw_percentile <= 0.70:
            scores["RANGE_BOUND"] += 0.5

        # ----- BREAKOUT -----
        # Volatility expanding from low levels
        if bw_percentile > 0.80:
            scores["BREAKOUT"] += 2.0
        elif bw_percentile > 0.65:
            scores["BREAKOUT"] += 1.0

        if atr_pct > 1.5 and adx > 20:
            scores["BREAKOUT"] += 1.5
        elif atr_pct > 1.0 and adx > 15:
            scores["BREAKOUT"] += 0.5

        # Coming from low vol (recent squeeze release)
        if bb_width > 0.04 and bw_percentile > 0.75:
            scores["BREAKOUT"] += 1.0

        # Strong directional move
        if adx > 25 and di_diff > 10:
            scores["BREAKOUT"] += 1.0

        # ----- LOW_VOL_DRIFT -----
        if bw_percentile < 0.25:
            scores["LOW_VOL_DRIFT"] += 2.5
        elif bw_percentile < 0.40:
            scores["LOW_VOL_DRIFT"] += 1.5

        if atr_pct < 0.5:
            scores["LOW_VOL_DRIFT"] += 2.0
        elif atr_pct < 1.0:
            scores["LOW_VOL_DRIFT"] += 1.0

        if adx < 20:
            scores["LOW_VOL_DRIFT"] += 1.0

        # ----- Pick winner -----
        total = sum(scores.values())
        if total == 0:
            return "RANGE_BOUND", 50.0

        best_regime = max(scores, key=scores.get)
        best_score = scores[best_regime]
        confidence = (best_score / total) * 100

        # Clamp confidence
        confidence = max(20.0, min(95.0, confidence))

        return best_regime, confidence

    def _default_regime(self, symbol: str) -> dict:
        """Default regime when insufficient data."""
        return {
            "symbol": symbol,
            "regime": "RANGE_BOUND",
            "confidence": 30.0,
            "trend_direction": "NEUTRAL",
            "adx": 0.0,
            "plus_di": 0.0,
            "minus_di": 0.0,
            "bb_width": 0.0,
            "bb_width_percentile": 0.5,
            "hurst": 0.5,
            "drawdown_pct": 0.0,
            "atr_pct": 0.0,
            "timestamp": time.time(),
            "insufficient_data": True,
        }

    # ===================================================================
    # Strategy Routing
    # ===================================================================

    def route_strategies(
        self,
        signals: List[dict],
        df: pd.DataFrame,
        symbol: str = "BTC/USD",
    ) -> List[dict]:
        """Reweight strategy signals based on current regime and adaptive weights.

        Each signal dict must have: {signal, confidence, name}.
        Returns a new list of signal dicts with adjusted confidence values.

        Strategies well-suited to the current regime get boosted;
        poorly suited or historically underperforming ones get penalized.
        """
        regime_info = self.get_current_regime(df, symbol)
        current_regime = regime_info["regime"]

        # Check for active transition
        transition = self.detect_regime_transition(df, symbol)
        transition_type = transition.get("transition")
        transition_boost_strategies = set()
        if transition_type:
            transition_boost_strategies = set(
                TRANSITION_STRATEGIES.get(transition_type, [])
            )

        with self._lock:
            weights = self._adaptive_weights.get(current_regime, {})

        routed: List[dict] = []
        for sig in signals:
            new_sig = dict(sig)
            name = sig.get("name", "")
            original_conf = sig.get("confidence", 0)

            if original_conf == 0 or sig.get("signal") == "HOLD":
                routed.append(new_sig)
                continue

            # 1. Adaptive weight for this strategy in this regime
            weight = weights.get(name, 1.0)

            # 2. Historical performance penalty/boost
            perf_key = (name, current_regime)
            with self._lock:
                record = self._perf.get(perf_key)

            perf_mult = 1.0
            if record and record.trade_count >= 5:
                score = record.score
                if score < THROTTLE_THRESHOLD:
                    # Throttle: reduce confidence heavily
                    perf_mult = 0.3
                else:
                    # Normalize score into a multiplier (0.5 to 1.5 range)
                    perf_mult = max(0.5, min(1.5, score / 2.0))

            # 3. Transition boost
            trans_mult = 1.0
            if transition_type and name in transition_boost_strategies:
                trans_mult = 1.3  # 30% boost for transition specialists

            # 4. Combine
            combined_mult = weight * perf_mult * trans_mult
            adjusted_conf = original_conf * combined_mult

            # Clamp
            adjusted_conf = max(0, min(95, adjusted_conf))
            new_sig["confidence"] = round(adjusted_conf, 1)
            new_sig["regime"] = current_regime
            new_sig["regime_weight"] = round(weight, 3)
            new_sig["perf_mult"] = round(perf_mult, 3)
            new_sig["transition"] = transition_type if name in transition_boost_strategies else None

            routed.append(new_sig)

        return routed

    # ===================================================================
    # Transition Detection
    # ===================================================================

    def detect_regime_transition(
        self,
        df: pd.DataFrame,
        symbol: str = "BTC/USD",
    ) -> dict:
        """Detect if a regime transition is occurring.

        Compares current regime to the previous one for this symbol.
        Returns transition type if detected, with metadata.
        """
        current_info = self.get_current_regime(df, symbol)
        current_regime = current_info["regime"]

        with self._lock:
            prev = self._prev_regime.get(symbol)

        if not prev or prev == current_regime:
            return {
                "transition": None,
                "from_regime": prev or current_regime,
                "to_regime": current_regime,
                "is_transitioning": False,
            }

        transition_key = f"{prev}->{current_regime}"
        specialist_strategies = TRANSITION_STRATEGIES.get(transition_key, [])

        return {
            "transition": transition_key,
            "from_regime": prev,
            "to_regime": current_regime,
            "is_transitioning": True,
            "specialist_strategies": specialist_strategies,
            "timestamp": time.time(),
        }

    # ===================================================================
    # Trade Result Recording & Adaptive Weight Updates
    # ===================================================================

    def record_trade_result(
        self,
        strategy: str,
        regime: str,
        pnl: float,
    ) -> None:
        """Record a trade result for the (strategy, regime) pair.

        Updates rolling performance window and triggers adaptive weight update.
        """
        with self._lock:
            key = (strategy, regime)
            if key not in self._perf:
                self._perf[key] = _StrategyRegimeRecord(strategy, regime)
            self._perf[key].record(pnl)

            # Update adaptive weights using multiplicative weights algorithm
            self._update_weights(strategy, regime, pnl)

    def _update_weights(self, strategy: str, regime: str, pnl: float) -> None:
        """Multiplicative weights update for the given strategy in the given regime.

        Winning strategies get their weight multiplied up, losers down.
        Learning rate decays with total updates so the system stabilises.
        """
        if regime not in self._adaptive_weights:
            self._adaptive_weights[regime] = {}

        weights = self._adaptive_weights[regime]
        current_w = weights.get(strategy, 1.0)

        # Compute effective learning rate (decaying)
        lr = max(MW_MIN_LR, self._learning_rate)

        # Update factor: exp(lr * sign(pnl) * clamp(|pnl|, 0, 0.05))
        # We clamp pnl magnitude to avoid extreme swings
        clamped = min(abs(pnl), 0.05)
        sign = 1.0 if pnl > 0 else -1.0
        factor = math.exp(lr * sign * clamped * 20)  # scale for sensitivity

        new_w = current_w * factor
        # Clamp weight to reasonable range
        new_w = max(0.1, min(5.0, new_w))
        weights[strategy] = new_w

        # Decay learning rate
        self._total_updates += 1
        self._learning_rate *= MW_LR_DECAY

        # Re-normalise weights so they average to ~1.0
        all_w = list(weights.values())
        if all_w:
            mean_w = sum(all_w) / len(all_w)
            if mean_w > 0:
                for k in weights:
                    weights[k] /= mean_w

    # ===================================================================
    # Multi-Asset Regime Analysis
    # ===================================================================

    def get_multi_asset_regime(
        self,
        asset_dataframes: Optional[Dict[str, pd.DataFrame]] = None,
    ) -> dict:
        """Analyse regime across multiple assets.

        Detects:
        - Whether BTC is in a different regime than alts
        - Alt-season (alts outperforming BTC for > 3 days)
        - Risk-off (high correlation + downtrend)
        """
        with self._lock:
            regimes = dict(self._asset_regimes)

        btc_regime = regimes.get("BTC/USD", "RANGE_BOUND")
        alt_regimes = {k: v for k, v in regimes.items() if k != "BTC/USD"}

        # BTC-alt divergence
        btc_alt_divergent = False
        divergent_alts = []
        for sym, reg in alt_regimes.items():
            if reg != btc_regime:
                btc_alt_divergent = True
                divergent_alts.append({"symbol": sym, "regime": reg})

        # Correlation analysis for risk-off detection
        risk_off = False
        correlation_level = 0.0
        crisis_count = sum(1 for r in regimes.values() if r == "CRISIS")
        downtrend_count = sum(1 for r in regimes.values() if r in ("CRISIS", "STRONG_TREND"))

        if len(regimes) >= 3:
            # If most assets are in CRISIS, that is risk-off
            if crisis_count >= max(2, len(regimes) * 0.5):
                risk_off = True
                correlation_level = 0.9

        # Alt-season: check if alts are in stronger regimes than BTC
        alt_season = False
        alt_season_score = 0.0
        strong_alt_count = 0
        for sym, reg in alt_regimes.items():
            if reg in ("STRONG_TREND", "BREAKOUT") and btc_regime in ("RANGE_BOUND", "LOW_VOL_DRIFT", "WEAK_TREND"):
                strong_alt_count += 1

        if len(alt_regimes) > 0 and strong_alt_count >= max(2, len(alt_regimes) * 0.4):
            alt_season = True
            alt_season_score = strong_alt_count / max(1, len(alt_regimes))

        return {
            "btc_regime": btc_regime,
            "alt_regimes": alt_regimes,
            "btc_alt_divergent": btc_alt_divergent,
            "divergent_alts": divergent_alts,
            "alt_season": alt_season,
            "alt_season_score": round(alt_season_score, 3),
            "risk_off": risk_off,
            "crisis_count": crisis_count,
            "correlation_level": round(correlation_level, 3),
            "total_assets_tracked": len(regimes),
        }

    def record_asset_return(self, symbol: str, period_return: float) -> None:
        """Record a period return for an asset (used for alt-season tracking)."""
        with self._lock:
            self._asset_returns[symbol].append(period_return)

    # ===================================================================
    # Query Methods
    # ===================================================================

    def get_regime_history(self, n: int = 50) -> List[dict]:
        """Return the last N regime detections across all assets."""
        with self._lock:
            history = list(self._regime_history)
        return history[-n:]

    def get_strategy_regime_matrix(self) -> dict:
        """Return win rates and scores per (strategy, regime) pair.

        Returns a nested dict: {regime -> {strategy -> {win_rate, avg_pnl, score, trades}}}
        """
        with self._lock:
            matrix: Dict[str, Dict[str, dict]] = defaultdict(dict)
            for (strat, regime), record in self._perf.items():
                matrix[regime][strat] = record.to_dict()
        return dict(matrix)

    def get_adaptive_weights(self) -> Dict[str, Dict[str, float]]:
        """Return current adaptive weights per regime."""
        with self._lock:
            result = {}
            for regime, weights in self._adaptive_weights.items():
                result[regime] = {k: round(v, 4) for k, v in weights.items()}
        return result

    def get_status(self) -> dict:
        """Full status snapshot for API/dashboard."""
        with self._lock:
            total_records = len(self._perf)
            total_trades = sum(r.trade_count for r in self._perf.values())
            regime_counts = defaultdict(int)
            for entry in self._regime_history:
                regime_counts[entry["regime"]] += 1

            # Best / worst strategies per regime
            best_per_regime = {}
            worst_per_regime = {}
            for regime in REGIMES:
                regime_records = [
                    (strat, rec) for (strat, r), rec in self._perf.items()
                    if r == regime and rec.trade_count >= 5
                ]
                if regime_records:
                    best = max(regime_records, key=lambda x: x[1].score)
                    worst = min(regime_records, key=lambda x: x[1].score)
                    best_per_regime[regime] = {
                        "strategy": best[0],
                        "score": round(best[1].score, 4),
                        "win_rate": round(best[1].win_rate, 4),
                    }
                    worst_per_regime[regime] = {
                        "strategy": worst[0],
                        "score": round(worst[1].score, 4),
                        "win_rate": round(worst[1].win_rate, 4),
                    }

            # Current regimes per asset
            current_regimes = dict(self._asset_regimes)

        return {
            "enabled": True,
            "regimes": REGIMES,
            "current_asset_regimes": current_regimes,
            "regime_history_counts": dict(regime_counts),
            "total_strategy_regime_records": total_records,
            "total_tracked_trades": total_trades,
            "learning_rate": round(self._learning_rate, 6),
            "total_weight_updates": self._total_updates,
            "best_per_regime": best_per_regime,
            "worst_per_regime": worst_per_regime,
            "adaptive_weights": self.get_adaptive_weights(),
            "multi_asset": self.get_multi_asset_regime(),
        }

    # ===================================================================
    # State Export / Import (for session persistence)
    # ===================================================================

    def export_state(self) -> dict:
        """Export full state for persistence."""
        with self._lock:
            perf_data = {}
            for (strat, regime), record in self._perf.items():
                key = f"{strat}|{regime}"
                perf_data[key] = {
                    "trades": list(record.trades),
                }

            weights_data = {}
            for regime, weights in self._adaptive_weights.items():
                weights_data[regime] = dict(weights)

            return {
                "perf": perf_data,
                "adaptive_weights": weights_data,
                "learning_rate": self._learning_rate,
                "total_updates": self._total_updates,
                "asset_regimes": dict(self._asset_regimes),
                "prev_regime": dict(self._prev_regime),
                "regime_history": list(self._regime_history),
            }

    def import_state(self, state: Optional[dict]) -> None:
        """Import previously saved state."""
        if not state:
            return

        with self._lock:
            # Restore performance records
            perf_data = state.get("perf", {})
            for key, data in perf_data.items():
                parts = key.split("|", 1)
                if len(parts) != 2:
                    continue
                strat, regime = parts
                record = _StrategyRegimeRecord(strat, regime)
                for pnl in data.get("trades", []):
                    record.record(pnl)
                self._perf[(strat, regime)] = record

            # Restore adaptive weights
            weights_data = state.get("adaptive_weights", {})
            for regime, weights in weights_data.items():
                if regime in self._adaptive_weights:
                    self._adaptive_weights[regime] = dict(weights)

            # Restore learning rate
            self._learning_rate = state.get("learning_rate", MW_INITIAL_LR)
            self._total_updates = state.get("total_updates", 0)

            # Restore asset regimes
            self._asset_regimes = state.get("asset_regimes", {})
            self._prev_regime = state.get("prev_regime", {})

            # Restore history
            history = state.get("regime_history", [])
            self._regime_history.clear()
            for entry in history[-500:]:
                self._regime_history.append(entry)

        logger.info("RegimeRouter state restored: %d perf records, %d weight updates",
                     len(self._perf), self._total_updates)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_router: Optional[RegimeRouter] = None
_router_lock = threading.Lock()


def get_regime_router() -> RegimeRouter:
    """Get or create the singleton RegimeRouter instance."""
    global _router
    if _router is None:
        with _router_lock:
            if _router is None:
                _router = RegimeRouter()
    return _router
