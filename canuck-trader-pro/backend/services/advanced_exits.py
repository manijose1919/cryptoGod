"""
Advanced Exit Strategies for Crypto Trading Bot

Two complementary exit strategies that protect profits and limit losses:

1. Volatility Regime Exit — Tightens stops when volatility regime changes
   since entry (e.g., LOW→HIGH vol doubles ATR → move stop to breakeven+0.1%).

2. Time-Decay Exit — Scales down profit targets over time so positions don't
   sit open indefinitely.  After 30/60/120/240 min the target shrinks until
   eventually we accept breakeven.

Usage:
    exits = get_advanced_exits()
    signals = exits.get_exit_signals("BTCUSD", position, df, current_price)
"""

import logging
import threading
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

try:
    from ta.volatility import AverageTrueRange
except ImportError:
    AverageTrueRange = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Volatility regime thresholds (ATR as % of price)
VOL_REGIME_LOW = 0.003      # < 0.3% ATR/price
VOL_REGIME_MED = 0.008      # 0.3-0.8%
# Above 0.8% → HIGH

ATR_PERIOD = 14

# Time-decay schedule (seconds → target multiplier)
TIME_DECAY_SCHEDULE = [
    (30 * 60,  0.75),   # 30 min → 75% of original target distance
    (60 * 60,  0.50),   # 60 min → 50%
    (120 * 60, 0.0),    # 120 min → any profit above fee floor
    (240 * 60, -1.0),   # 240 min → breakeven or better (sentinel)
]

FEE_FLOOR_PCT = 0.0015  # 0.15% minimum to cover round-trip fees


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _classify_vol_regime(atr_pct: float) -> str:
    """Classify volatility regime from ATR as a fraction of price."""
    if atr_pct < VOL_REGIME_LOW:
        return "LOW"
    elif atr_pct < VOL_REGIME_MED:
        return "MEDIUM"
    return "HIGH"


def _compute_atr(df: pd.DataFrame, period: int = ATR_PERIOD) -> Optional[pd.Series]:
    """Compute ATR series from OHLC dataframe.

    Expects columns: 'high', 'low', 'close' (or 'h', 'l', 'c').
    """
    # Normalise column names — accept both long and short forms
    col_map = {}
    for col in df.columns:
        lc = col.lower()
        if lc in ("high", "h"):
            col_map["high"] = col
        elif lc in ("low", "l"):
            col_map["low"] = col
        elif lc in ("close", "c"):
            col_map["close"] = col

    if not all(k in col_map for k in ("high", "low", "close")):
        logger.warning("DataFrame missing required OHLC columns for ATR")
        return None

    high = df[col_map["high"]].astype(float)
    low = df[col_map["low"]].astype(float)
    close = df[col_map["close"]].astype(float)

    if len(df) < period + 1:
        logger.debug("Not enough candles (%d) for ATR period %d", len(df), period)
        return None

    # Prefer ta library if available; fallback to manual Wilder smoothing
    if AverageTrueRange is not None:
        indicator = AverageTrueRange(high=high, low=low, close=close, window=period)
        return indicator.average_true_range()

    # Manual ATR calculation
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    atr = tr.copy()
    atr.iloc[:period] = np.nan
    atr.iloc[period] = tr.iloc[1 : period + 1].mean()
    for i in range(period + 1, len(tr)):
        atr.iloc[i] = (atr.iloc[i - 1] * (period - 1) + tr.iloc[i]) / period

    return atr


# ---------------------------------------------------------------------------
# Advanced Exits Service
# ---------------------------------------------------------------------------

class AdvancedExits:
    """Thread-safe advanced exit strategy manager."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Cache entry-time ATR per symbol to compare against current
        self._entry_atr: Dict[str, float] = {}
        self._entry_regime: Dict[str, str] = {}
        logger.info("AdvancedExits service initialised")

    # ------------------------------------------------------------------
    # Public: register entry context
    # ------------------------------------------------------------------

    def register_entry(self, symbol: str, df: pd.DataFrame, current_price: float) -> None:
        """Record the ATR and vol regime at entry time for later comparison."""
        with self._lock:
            atr_series = _compute_atr(df)
            if atr_series is not None and not atr_series.empty:
                entry_atr = float(atr_series.iloc[-1])
                atr_pct = entry_atr / current_price if current_price > 0 else 0.0
                self._entry_atr[symbol] = entry_atr
                self._entry_regime[symbol] = _classify_vol_regime(atr_pct)
                logger.debug(
                    "Registered entry for %s: ATR=%.6f regime=%s",
                    symbol, entry_atr, self._entry_regime[symbol],
                )

    def clear_entry(self, symbol: str) -> None:
        """Remove cached entry data after position is closed."""
        with self._lock:
            self._entry_atr.pop(symbol, None)
            self._entry_regime.pop(symbol, None)

    # ------------------------------------------------------------------
    # 1. Volatility Regime Exit
    # ------------------------------------------------------------------

    def check_volatility_exit(
        self, symbol: str, pos: dict, df: pd.DataFrame
    ) -> Dict:
        """Check if volatility regime changed enough to warrant tighter stops.

        Parameters
        ----------
        symbol : str
            Trading pair e.g. "BTCUSD".
        pos : dict
            Position dict with keys: side, entry, stop, target, open_time, size_usd.
        df : pd.DataFrame
            Recent OHLC candle data.

        Returns
        -------
        dict
            {"should_exit": bool, "reason": str, "new_stop": float}
        """
        result: Dict = {"should_exit": False, "reason": "", "new_stop": 0.0}

        try:
            with self._lock:
                entry_atr = self._entry_atr.get(symbol)
                entry_regime = self._entry_regime.get(symbol)

            atr_series = _compute_atr(df)
            if atr_series is None or atr_series.dropna().empty:
                return result

            current_atr = float(atr_series.iloc[-1])
            entry_price = float(pos.get("entry", 0))
            stop_price = float(pos.get("stop", 0))
            side = pos.get("side", "BUY")

            if entry_price <= 0:
                return result

            current_atr_pct = current_atr / entry_price
            current_regime = _classify_vol_regime(current_atr_pct)

            # --- Case 1: ATR doubled since entry → tighten to breakeven + 0.1%
            if entry_atr is not None and entry_atr > 0 and current_atr >= entry_atr * 2.0:
                breakeven_offset = entry_price * 0.001  # 0.1%
                if side == "BUY":
                    new_stop = entry_price + breakeven_offset
                else:
                    new_stop = entry_price - breakeven_offset

                # Only tighten, never loosen
                if side == "BUY" and (stop_price == 0 or new_stop > stop_price):
                    result["should_exit"] = False  # don't exit yet, just tighten
                    result["reason"] = (
                        f"ATR doubled ({entry_atr:.4f}→{current_atr:.4f}): "
                        f"stop tightened to breakeven+0.1%"
                    )
                    result["new_stop"] = new_stop
                    return result
                elif side == "SELL" and (stop_price == 0 or new_stop < stop_price):
                    result["should_exit"] = False
                    result["reason"] = (
                        f"ATR doubled ({entry_atr:.4f}→{current_atr:.4f}): "
                        f"stop tightened to breakeven+0.1%"
                    )
                    result["new_stop"] = new_stop
                    return result

            # --- Case 2: Regime shifted LOW → HIGH → tighten stop 50%
            if entry_regime == "LOW" and current_regime == "HIGH":
                if stop_price != 0 and entry_price != 0:
                    # Move stop 50% closer to entry
                    gap = abs(entry_price - stop_price)
                    half_gap = gap * 0.5
                    if side == "BUY":
                        new_stop = entry_price - half_gap
                        if new_stop > stop_price:
                            result["should_exit"] = False
                            result["reason"] = (
                                f"Vol regime LOW→HIGH: stop tightened 50% "
                                f"({stop_price:.2f}→{new_stop:.2f})"
                            )
                            result["new_stop"] = new_stop
                            return result
                    else:
                        new_stop = entry_price + half_gap
                        if new_stop < stop_price:
                            result["should_exit"] = False
                            result["reason"] = (
                                f"Vol regime LOW→HIGH: stop tightened 50% "
                                f"({stop_price:.2f}→{new_stop:.2f})"
                            )
                            result["new_stop"] = new_stop
                            return result

        except Exception:
            logger.exception("Error in check_volatility_exit for %s", symbol)

        return result

    # ------------------------------------------------------------------
    # 2. Time-Decay Exit
    # ------------------------------------------------------------------

    def check_time_decay_exit(
        self, symbol: str, pos: dict, current_price: float
    ) -> Dict:
        """Check if position has been open long enough to decay the profit target.

        Parameters
        ----------
        symbol : str
            Trading pair.
        pos : dict
            Position dict with keys: side, entry, stop, target, open_time, size_usd.
        current_price : float
            Current market price.

        Returns
        -------
        dict
            {"should_exit": bool, "reason": str, "adjusted_target": float}
        """
        result: Dict = {"should_exit": False, "reason": "", "adjusted_target": 0.0}

        try:
            entry_price = float(pos.get("entry", 0))
            target_price = float(pos.get("target", 0))
            open_time = pos.get("open_time", 0)
            side = pos.get("side", "BUY")

            if entry_price <= 0 or open_time <= 0:
                return result

            # open_time may be epoch seconds or milliseconds
            if open_time > 1e12:
                open_time_s = open_time / 1000.0
            else:
                open_time_s = float(open_time)

            elapsed_s = time.time() - open_time_s
            if elapsed_s < 0:
                return result

            # Original target distance
            if target_price > 0:
                original_distance = abs(target_price - entry_price)
            else:
                # No explicit target — use 1% as default assumption
                original_distance = entry_price * 0.01

            fee_floor = entry_price * FEE_FLOOR_PCT

            # Walk through the decay schedule (sorted ascending by time)
            active_mult: Optional[float] = None
            active_threshold_s = 0
            for threshold_s, mult in TIME_DECAY_SCHEDULE:
                if elapsed_s >= threshold_s:
                    active_mult = mult
                    active_threshold_s = threshold_s

            if active_mult is None:
                # Position is younger than first decay step
                return result

            elapsed_min = int(elapsed_s / 60)

            # --- 240 min+ : exit at breakeven or better ---
            if active_mult == -1.0:
                if side == "BUY":
                    in_profit = current_price >= entry_price
                else:
                    in_profit = current_price <= entry_price

                if in_profit:
                    result["should_exit"] = True
                    result["reason"] = (
                        f"Time decay ({elapsed_min}min): exiting at breakeven or better"
                    )
                    result["adjusted_target"] = entry_price
                return result

            # --- 120 min+ : exit at any profit above fee floor ---
            if active_mult == 0.0:
                if side == "BUY":
                    profit = current_price - entry_price
                else:
                    profit = entry_price - current_price

                if profit >= fee_floor:
                    result["should_exit"] = True
                    result["reason"] = (
                        f"Time decay ({elapsed_min}min): exiting at "
                        f"{profit / entry_price * 100:.3f}% profit (above fee floor)"
                    )
                    result["adjusted_target"] = (
                        entry_price + fee_floor if side == "BUY"
                        else entry_price - fee_floor
                    )
                return result

            # --- 30 / 60 min : scale target ---
            decayed_distance = original_distance * active_mult
            decayed_distance = max(decayed_distance, fee_floor)

            if side == "BUY":
                adjusted_target = entry_price + decayed_distance
                hit_target = current_price >= adjusted_target
            else:
                adjusted_target = entry_price - decayed_distance
                hit_target = current_price <= adjusted_target

            result["adjusted_target"] = adjusted_target

            if hit_target:
                result["should_exit"] = True
                result["reason"] = (
                    f"Time decay ({elapsed_min}min): decayed target hit at "
                    f"{adjusted_target:.2f} ({active_mult * 100:.0f}% of original)"
                )

        except Exception:
            logger.exception("Error in check_time_decay_exit for %s", symbol)

        return result

    # ------------------------------------------------------------------
    # 3. Combined exit signal check
    # ------------------------------------------------------------------

    def get_exit_signals(
        self,
        symbol: str,
        pos: dict,
        df: pd.DataFrame,
        current_price: float,
    ) -> List[Dict]:
        """Run all advanced exit checks and return a list of triggered signals.

        Parameters
        ----------
        symbol : str
            Trading pair.
        pos : dict
            Position dict with keys: side, entry, stop, target, open_time, size_usd.
        df : pd.DataFrame
            Recent OHLC candle data.
        current_price : float
            Current market price.

        Returns
        -------
        list[dict]
            Each dict has: type, should_exit, reason, and strategy-specific fields.
        """
        signals: List[Dict] = []

        try:
            # Volatility regime check
            vol_result = self.check_volatility_exit(symbol, pos, df)
            if vol_result["reason"]:
                signals.append({
                    "type": "VOLATILITY_REGIME",
                    "should_exit": vol_result["should_exit"],
                    "reason": vol_result["reason"],
                    "new_stop": vol_result["new_stop"],
                })

            # Time-decay check
            td_result = self.check_time_decay_exit(symbol, pos, current_price)
            if td_result["reason"]:
                signals.append({
                    "type": "TIME_DECAY",
                    "should_exit": td_result["should_exit"],
                    "reason": td_result["reason"],
                    "adjusted_target": td_result["adjusted_target"],
                })

        except Exception:
            logger.exception("Error in get_exit_signals for %s", symbol)

        return signals


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[AdvancedExits] = None
_instance_lock = threading.Lock()


def get_advanced_exits() -> AdvancedExits:
    """Return the singleton AdvancedExits instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = AdvancedExits()
    return _instance
