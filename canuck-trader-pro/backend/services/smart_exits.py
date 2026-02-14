"""
Smart Exit Strategies for Crypto Trading Bot

Complements advanced_exits.py with additional sophisticated exit techniques:

1. Chandelier Exit     - ATR-based trailing stop from highest high / lowest low
2. Parabolic SAR Exit  - Acceleration-factor trailing stop
3. Keltner Channel Exit- Exit on Keltner band breach opposite to position
4. Volume Dry-Up Exit  - Exit when volume collapses (< 30% of 20-period avg)
5. Momentum Exhaustion - RSI divergence from price (hidden bearish/bullish div)
6. Time-Weighted Exit  - Decaying profit targets over 4 time tiers
7. Break-Even Stop     - Move stop to entry + fees after +0.5%
8. Partial Take-Profit - Scale out in thirds (50% / 100% target + trailing)

Usage:
    exits = get_smart_exits()
    signals = exits.check_exits("BTCUSD", position, df, current_price)
    trailing = exits.get_trailing_stop("BTCUSD", position, df)
    partial  = exits.should_partial_exit("BTCUSD", position, current_price)
"""

import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

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

ATR_PERIOD = 14
CHANDELIER_ATR_MULT = 3.0           # Chandelier exit: 3x ATR trailing
PSAR_AF_INIT = 0.02                  # Parabolic SAR initial acceleration factor
PSAR_AF_STEP = 0.02                  # AF increment per new extreme
PSAR_AF_MAX = 0.20                   # Maximum AF
KELTNER_EMA_PERIOD = 20              # Keltner middle = EMA(20)
KELTNER_ATR_MULT = 2.0              # Keltner band width = 2x ATR
VOLUME_DRYUP_THRESHOLD = 0.30       # Exit below 30% of 20-period avg volume
VOLUME_LOOKBACK = 20                 # Volume averaging window
RSI_PERIOD = 14                      # RSI period for momentum exhaustion
RSI_DIVERGENCE_LOOKBACK = 10         # Bars to check for divergence
FEE_ROUND_TRIP_PCT = 0.0015          # 0.15% round-trip fee
BREAKEVEN_PROFIT_TRIGGER = 0.005     # Move stop to breakeven after +0.5%

# Time-weighted exit schedule (seconds -> target multiplier)
TIME_WEIGHTED_SCHEDULE = [
    (0,        1.00),   # 0-15 min:  full target
    (15 * 60,  0.75),   # 15-30 min: 75% of target
    (30 * 60,  0.50),   # 30-60 min: 50% of target
    (60 * 60,  0.00),   # 60 min+:   market exit (take whatever PnL)
]

# Partial take-profit tiers (fraction_of_target, fraction_of_position)
PARTIAL_TP_TIERS = [
    (0.50, 1 / 3),   # 1st third at 50% of target
    (1.00, 1 / 3),   # 2nd third at 100% of target
    # Remaining 1/3 runs with trailing stop
]


# ---------------------------------------------------------------------------
# Per-Position State
# ---------------------------------------------------------------------------

@dataclass
class PositionState:
    """Mutable tracking state for a single open position."""
    symbol: str
    side: str                           # "BUY" or "SELL"
    entry_price: float
    entry_time: float                   # epoch seconds
    highest_high: float = 0.0           # since entry (for chandelier / trailing)
    lowest_low: float = float("inf")    # since entry
    partial_exits_done: int = 0         # how many partial TPs executed (0-2)
    breakeven_activated: bool = False   # has stop been moved to breakeven?
    psar_value: float = 0.0            # current Parabolic SAR level
    psar_af: float = PSAR_AF_INIT      # current acceleration factor
    psar_extreme: float = 0.0          # extreme point in current trend
    psar_initialised: bool = False      # has PSAR been seeded?
    last_update_time: float = 0.0       # last time we updated tracking
    # RSI divergence tracking
    recent_price_highs: list = field(default_factory=list)
    recent_rsi_at_highs: list = field(default_factory=list)
    recent_price_lows: list = field(default_factory=list)
    recent_rsi_at_lows: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalise_ohlcv(df: pd.DataFrame) -> Optional[pd.DataFrame]:
    """Return a DataFrame with normalised columns: open, high, low, close, volume.

    Accepts both short (o, h, l, c, v) and long column name forms.
    Returns None if essential columns are missing.
    """
    col_map: Dict[str, str] = {}
    for col in df.columns:
        lc = col.lower()
        if lc in ("open", "o"):
            col_map["open"] = col
        elif lc in ("high", "h"):
            col_map["high"] = col
        elif lc in ("low", "l"):
            col_map["low"] = col
        elif lc in ("close", "c"):
            col_map["close"] = col
        elif lc in ("volume", "v", "vol"):
            col_map["volume"] = col

    required = ("high", "low", "close")
    if not all(k in col_map for k in required):
        return None

    out = pd.DataFrame()
    for target, src in col_map.items():
        out[target] = pd.to_numeric(df[src], errors="coerce")

    return out


def _compute_atr(df: pd.DataFrame, period: int = ATR_PERIOD) -> Optional[pd.Series]:
    """Compute ATR series. df must have columns high, low, close."""
    ndf = _normalise_ohlcv(df)
    if ndf is None:
        return None

    high = ndf["high"]
    low = ndf["low"]
    close = ndf["close"]

    if len(ndf) < period + 1:
        return None

    if AverageTrueRange is not None:
        indicator = AverageTrueRange(high=high, low=low, close=close, window=period)
        return indicator.average_true_range()

    # Manual Wilder-smoothed ATR
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    atr = tr.copy()
    atr.iloc[:period] = np.nan
    atr.iloc[period] = tr.iloc[1:period + 1].mean()
    for i in range(period + 1, len(tr)):
        atr.iloc[i] = (atr.iloc[i - 1] * (period - 1) + tr.iloc[i]) / period

    return atr


def _compute_ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average."""
    return series.ewm(span=period, adjust=False).mean()


def _compute_rsi(close: pd.Series, period: int = RSI_PERIOD) -> pd.Series:
    """Compute RSI from a close-price series."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi


# ---------------------------------------------------------------------------
# SmartExits Service
# ---------------------------------------------------------------------------

class SmartExits:
    """Thread-safe smart exit strategy manager with per-position state tracking."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._positions: Dict[str, PositionState] = {}
        self._stats = {
            "exits_checked": 0,
            "exits_triggered": 0,
            "partial_exits": 0,
            "breakeven_stops_set": 0,
            "chandelier_exits": 0,
            "psar_exits": 0,
            "keltner_exits": 0,
            "volume_dryup_exits": 0,
            "momentum_exhaustion_exits": 0,
            "time_weighted_exits": 0,
        }
        logger.info("SmartExits service initialised")

    # ------------------------------------------------------------------
    # Position state management
    # ------------------------------------------------------------------

    def register_position(
        self,
        symbol: str,
        side: str,
        entry_price: float,
        entry_time: Optional[float] = None,
    ) -> None:
        """Register a new position for tracking. Call on entry."""
        with self._lock:
            self._positions[symbol] = PositionState(
                symbol=symbol,
                side=side.upper(),
                entry_price=entry_price,
                entry_time=entry_time or time.time(),
                highest_high=entry_price,
                lowest_low=entry_price,
                last_update_time=time.time(),
            )
            logger.debug(
                "Registered position %s %s @ %.6f", side, symbol, entry_price
            )

    def close_position(self, symbol: str) -> None:
        """Remove position state after exit."""
        with self._lock:
            self._positions.pop(symbol, None)
            logger.debug("Closed position tracking for %s", symbol)

    def _get_state(self, symbol: str) -> Optional[PositionState]:
        """Retrieve position state (caller must hold lock)."""
        return self._positions.get(symbol)

    def _ensure_state(self, symbol: str, position: dict) -> PositionState:
        """Get or lazily create position state from a position dict."""
        state = self._positions.get(symbol)
        if state is None:
            side = position.get("side", "BUY")
            entry = float(position.get("entry", 0))
            open_time = position.get("open_time", 0)
            if open_time > 1e12:
                open_time = open_time / 1000.0
            state = PositionState(
                symbol=symbol,
                side=side,
                entry_price=entry,
                entry_time=float(open_time) if open_time else time.time(),
                highest_high=entry,
                lowest_low=entry,
                last_update_time=time.time(),
            )
            self._positions[symbol] = state
        return state

    def _update_tracking(
        self, state: PositionState, df: pd.DataFrame, current_price: float
    ) -> None:
        """Update highest_high, lowest_low, and PSAR from latest candle data."""
        ndf = _normalise_ohlcv(df)
        if ndf is not None and len(ndf) > 0:
            last_high = float(ndf["high"].iloc[-1])
            last_low = float(ndf["low"].iloc[-1])
        else:
            last_high = current_price
            last_low = current_price

        # Update extremes
        if last_high > state.highest_high:
            state.highest_high = last_high
        if current_price > state.highest_high:
            state.highest_high = current_price

        if last_low < state.lowest_low:
            state.lowest_low = last_low
        if current_price < state.lowest_low:
            state.lowest_low = current_price

        state.last_update_time = time.time()

    # ------------------------------------------------------------------
    # 1. Chandelier Exit
    # ------------------------------------------------------------------

    def _check_chandelier_exit(
        self,
        state: PositionState,
        df: pd.DataFrame,
        current_price: float,
    ) -> Optional[Dict]:
        """Trailing stop based on ATR from the highest high (long) or lowest low (short)."""
        atr_series = _compute_atr(df)
        if atr_series is None or atr_series.dropna().empty:
            return None

        atr = float(atr_series.iloc[-1])
        if atr <= 0:
            return None

        if state.side == "BUY":
            stop_level = state.highest_high - CHANDELIER_ATR_MULT * atr
            triggered = current_price <= stop_level
        else:
            stop_level = state.lowest_low + CHANDELIER_ATR_MULT * atr
            triggered = current_price >= stop_level

        if triggered:
            self._stats["chandelier_exits"] += 1
            return {
                "type": "CHANDELIER_EXIT",
                "should_exit": True,
                "urgency": 7,
                "reason": (
                    f"Chandelier exit triggered: price {current_price:.4f} "
                    f"{'below' if state.side == 'BUY' else 'above'} "
                    f"stop {stop_level:.4f} "
                    f"(HH={state.highest_high:.4f}, LL={state.lowest_low:.4f}, "
                    f"ATR={atr:.4f}, mult={CHANDELIER_ATR_MULT})"
                ),
                "stop_level": stop_level,
            }
        return None

    # ------------------------------------------------------------------
    # 2. Parabolic SAR Exit
    # ------------------------------------------------------------------

    def _check_psar_exit(
        self,
        state: PositionState,
        df: pd.DataFrame,
        current_price: float,
    ) -> Optional[Dict]:
        """Parabolic SAR trailing stop with acceleration factor."""
        ndf = _normalise_ohlcv(df)
        if ndf is None or len(ndf) < 3:
            return None

        high = float(ndf["high"].iloc[-1])
        low = float(ndf["low"].iloc[-1])

        # Initialise PSAR on first call
        if not state.psar_initialised:
            if state.side == "BUY":
                # SAR starts below price
                state.psar_value = state.lowest_low
                state.psar_extreme = state.highest_high
            else:
                # SAR starts above price
                state.psar_value = state.highest_high
                state.psar_extreme = state.lowest_low
            state.psar_af = PSAR_AF_INIT
            state.psar_initialised = True
            return None

        # Update PSAR
        prev_sar = state.psar_value
        af = state.psar_af
        ep = state.psar_extreme

        new_sar = prev_sar + af * (ep - prev_sar)

        if state.side == "BUY":
            # Long position: SAR trails below
            # Clamp SAR to be no higher than the previous two lows
            if len(ndf) >= 2:
                prev_low = float(ndf["low"].iloc[-2])
                new_sar = min(new_sar, prev_low, low)

            if high > ep:
                # New extreme point
                state.psar_extreme = high
                state.psar_af = min(af + PSAR_AF_STEP, PSAR_AF_MAX)

            # Check for exit: price crossed below SAR
            if current_price <= new_sar:
                state.psar_value = new_sar
                self._stats["psar_exits"] += 1
                return {
                    "type": "PSAR_EXIT",
                    "should_exit": True,
                    "urgency": 7,
                    "reason": (
                        f"Parabolic SAR exit: price {current_price:.4f} "
                        f"crossed below SAR {new_sar:.4f} (AF={state.psar_af:.2f})"
                    ),
                    "sar_level": new_sar,
                }
        else:
            # Short position: SAR trails above
            if len(ndf) >= 2:
                prev_high = float(ndf["high"].iloc[-2])
                new_sar = max(new_sar, prev_high, high)

            if low < ep:
                state.psar_extreme = low
                state.psar_af = min(af + PSAR_AF_STEP, PSAR_AF_MAX)

            if current_price >= new_sar:
                state.psar_value = new_sar
                self._stats["psar_exits"] += 1
                return {
                    "type": "PSAR_EXIT",
                    "should_exit": True,
                    "urgency": 7,
                    "reason": (
                        f"Parabolic SAR exit: price {current_price:.4f} "
                        f"crossed above SAR {new_sar:.4f} (AF={state.psar_af:.2f})"
                    ),
                    "sar_level": new_sar,
                }

        state.psar_value = new_sar
        return None

    # ------------------------------------------------------------------
    # 3. Keltner Channel Exit
    # ------------------------------------------------------------------

    def _check_keltner_exit(
        self,
        state: PositionState,
        df: pd.DataFrame,
        current_price: float,
    ) -> Optional[Dict]:
        """Exit when price breaks outside the Keltner channel opposite to position."""
        ndf = _normalise_ohlcv(df)
        if ndf is None or len(ndf) < max(KELTNER_EMA_PERIOD, ATR_PERIOD) + 1:
            return None

        atr_series = _compute_atr(df)
        if atr_series is None or atr_series.dropna().empty:
            return None

        close = ndf["close"]
        ema_mid = _compute_ema(close, KELTNER_EMA_PERIOD)
        atr = atr_series

        upper_band = ema_mid + KELTNER_ATR_MULT * atr
        lower_band = ema_mid - KELTNER_ATR_MULT * atr

        current_upper = float(upper_band.iloc[-1])
        current_lower = float(lower_band.iloc[-1])
        current_mid = float(ema_mid.iloc[-1])

        if state.side == "BUY" and current_price < current_lower:
            self._stats["keltner_exits"] += 1
            return {
                "type": "KELTNER_EXIT",
                "should_exit": True,
                "urgency": 8,
                "reason": (
                    f"Keltner channel exit (long): price {current_price:.4f} "
                    f"broke below lower band {current_lower:.4f} "
                    f"(mid={current_mid:.4f}, upper={current_upper:.4f})"
                ),
                "lower_band": current_lower,
                "upper_band": current_upper,
            }
        elif state.side == "SELL" and current_price > current_upper:
            self._stats["keltner_exits"] += 1
            return {
                "type": "KELTNER_EXIT",
                "should_exit": True,
                "urgency": 8,
                "reason": (
                    f"Keltner channel exit (short): price {current_price:.4f} "
                    f"broke above upper band {current_upper:.4f} "
                    f"(mid={current_mid:.4f}, lower={current_lower:.4f})"
                ),
                "lower_band": current_lower,
                "upper_band": current_upper,
            }

        return None

    # ------------------------------------------------------------------
    # 4. Volume Dry-Up Exit
    # ------------------------------------------------------------------

    def _check_volume_dryup_exit(
        self,
        state: PositionState,
        df: pd.DataFrame,
    ) -> Optional[Dict]:
        """Exit when current volume falls below 30% of 20-period average."""
        ndf = _normalise_ohlcv(df)
        if ndf is None or "volume" not in ndf.columns:
            return None

        vol = ndf["volume"].dropna()
        if len(vol) < VOLUME_LOOKBACK + 1:
            return None

        avg_volume = float(vol.iloc[-(VOLUME_LOOKBACK + 1):-1].mean())
        current_volume = float(vol.iloc[-1])

        if avg_volume <= 0:
            return None

        volume_ratio = current_volume / avg_volume

        if volume_ratio < VOLUME_DRYUP_THRESHOLD:
            self._stats["volume_dryup_exits"] += 1
            return {
                "type": "VOLUME_DRYUP_EXIT",
                "should_exit": True,
                "urgency": 5,
                "reason": (
                    f"Volume dry-up: current vol {current_volume:.0f} is "
                    f"{volume_ratio * 100:.1f}% of 20-period avg {avg_volume:.0f} "
                    f"(threshold: {VOLUME_DRYUP_THRESHOLD * 100:.0f}%)"
                ),
                "volume_ratio": volume_ratio,
                "avg_volume": avg_volume,
                "current_volume": current_volume,
            }

        return None

    # ------------------------------------------------------------------
    # 5. Momentum Exhaustion Exit (RSI Divergence)
    # ------------------------------------------------------------------

    def _check_momentum_exhaustion_exit(
        self,
        state: PositionState,
        df: pd.DataFrame,
        current_price: float,
    ) -> Optional[Dict]:
        """Exit on RSI divergence from price.

        Long: price makes new highs but RSI is declining (bearish divergence).
        Short: price makes new lows but RSI is rising (bullish divergence).
        """
        ndf = _normalise_ohlcv(df)
        if ndf is None or len(ndf) < RSI_PERIOD + RSI_DIVERGENCE_LOOKBACK + 1:
            return None

        close = ndf["close"]
        rsi = _compute_rsi(close, RSI_PERIOD)

        lookback = RSI_DIVERGENCE_LOOKBACK
        recent_close = close.iloc[-lookback:].values
        recent_rsi = rsi.iloc[-lookback:].values

        # Drop NaN values
        valid_mask = ~(np.isnan(recent_close) | np.isnan(recent_rsi))
        if valid_mask.sum() < 3:
            return None

        recent_close = recent_close[valid_mask]
        recent_rsi = recent_rsi[valid_mask]

        if state.side == "BUY":
            # Bearish divergence: price making higher highs, RSI making lower highs
            price_max_idx = np.argmax(recent_close)
            # Check if the highest price is in the last third of the lookback
            if price_max_idx >= len(recent_close) * 2 // 3:
                # Find previous local high in first half
                first_half_max_idx = np.argmax(recent_close[: len(recent_close) // 2])
                if (
                    recent_close[price_max_idx] > recent_close[first_half_max_idx]
                    and recent_rsi[price_max_idx] < recent_rsi[first_half_max_idx]
                ):
                    current_rsi = float(recent_rsi[-1])
                    self._stats["momentum_exhaustion_exits"] += 1
                    return {
                        "type": "MOMENTUM_EXHAUSTION_EXIT",
                        "should_exit": True,
                        "urgency": 6,
                        "reason": (
                            f"Bearish RSI divergence: price new high "
                            f"{recent_close[price_max_idx]:.4f} but RSI declining "
                            f"({recent_rsi[first_half_max_idx]:.1f} -> "
                            f"{recent_rsi[price_max_idx]:.1f}), "
                            f"current RSI={current_rsi:.1f}"
                        ),
                        "rsi": current_rsi,
                        "divergence_type": "BEARISH",
                    }

        else:
            # Bullish divergence: price making lower lows, RSI making higher lows
            price_min_idx = np.argmin(recent_close)
            if price_min_idx >= len(recent_close) * 2 // 3:
                first_half_min_idx = np.argmin(recent_close[: len(recent_close) // 2])
                if (
                    recent_close[price_min_idx] < recent_close[first_half_min_idx]
                    and recent_rsi[price_min_idx] > recent_rsi[first_half_min_idx]
                ):
                    current_rsi = float(recent_rsi[-1])
                    self._stats["momentum_exhaustion_exits"] += 1
                    return {
                        "type": "MOMENTUM_EXHAUSTION_EXIT",
                        "should_exit": True,
                        "urgency": 6,
                        "reason": (
                            f"Bullish RSI divergence: price new low "
                            f"{recent_close[price_min_idx]:.4f} but RSI rising "
                            f"({recent_rsi[first_half_min_idx]:.1f} -> "
                            f"{recent_rsi[price_min_idx]:.1f}), "
                            f"current RSI={current_rsi:.1f}"
                        ),
                        "rsi": current_rsi,
                        "divergence_type": "BULLISH",
                    }

        return None

    # ------------------------------------------------------------------
    # 6. Time-Weighted Exit
    # ------------------------------------------------------------------

    def _check_time_weighted_exit(
        self,
        state: PositionState,
        current_price: float,
        position: dict,
    ) -> Optional[Dict]:
        """Reduces profit target over time. After 60min, exits at market."""
        target_price = float(position.get("target", 0))
        entry = state.entry_price
        if entry <= 0:
            return None

        elapsed_s = time.time() - state.entry_time
        if elapsed_s < 0:
            return None

        # Determine original target distance
        if target_price > 0:
            original_distance = abs(target_price - entry)
        else:
            original_distance = entry * 0.01  # 1% default

        fee_floor = entry * FEE_ROUND_TRIP_PCT

        # Find the active multiplier
        active_mult: Optional[float] = None
        for threshold_s, mult in reversed(TIME_WEIGHTED_SCHEDULE):
            if elapsed_s >= threshold_s:
                active_mult = mult
                break

        if active_mult is None:
            return None

        elapsed_min = elapsed_s / 60.0

        # 60 min+: market exit - take whatever PnL exists
        if active_mult == 0.0:
            if state.side == "BUY":
                pnl_pct = (current_price - entry) / entry
            else:
                pnl_pct = (entry - current_price) / entry

            self._stats["time_weighted_exits"] += 1
            return {
                "type": "TIME_WEIGHTED_EXIT",
                "should_exit": True,
                "urgency": 9,
                "reason": (
                    f"Time-weighted exit ({elapsed_min:.0f}min): "
                    f"market exit, current PnL={pnl_pct * 100:.3f}%"
                ),
                "elapsed_minutes": elapsed_min,
                "target_multiplier": 0.0,
                "current_pnl_pct": pnl_pct,
            }

        # Full target (0-15min): no early exit
        if active_mult >= 1.0:
            return None

        # Decayed target (15-30 or 30-60 min)
        decayed_distance = max(original_distance * active_mult, fee_floor)

        if state.side == "BUY":
            adjusted_target = entry + decayed_distance
            hit = current_price >= adjusted_target
        else:
            adjusted_target = entry - decayed_distance
            hit = current_price <= adjusted_target

        if hit:
            self._stats["time_weighted_exits"] += 1
            return {
                "type": "TIME_WEIGHTED_EXIT",
                "should_exit": True,
                "urgency": 6,
                "reason": (
                    f"Time-weighted exit ({elapsed_min:.0f}min): "
                    f"decayed target hit at {adjusted_target:.4f} "
                    f"({active_mult * 100:.0f}% of original)"
                ),
                "elapsed_minutes": elapsed_min,
                "target_multiplier": active_mult,
                "adjusted_target": adjusted_target,
            }

        return None

    # ------------------------------------------------------------------
    # 7. Break-Even Stop
    # ------------------------------------------------------------------

    def _check_breakeven_stop(
        self,
        state: PositionState,
        current_price: float,
        position: dict,
    ) -> Optional[Dict]:
        """Move stop to entry + fees after position is 0.5% in profit.

        Returns a signal if the stop should be moved, but does not exit.
        """
        if state.breakeven_activated:
            return None

        entry = state.entry_price
        if entry <= 0:
            return None

        if state.side == "BUY":
            pnl_pct = (current_price - entry) / entry
        else:
            pnl_pct = (entry - current_price) / entry

        if pnl_pct >= BREAKEVEN_PROFIT_TRIGGER:
            state.breakeven_activated = True
            fee_offset = entry * FEE_ROUND_TRIP_PCT
            if state.side == "BUY":
                new_stop = entry + fee_offset
            else:
                new_stop = entry - fee_offset

            self._stats["breakeven_stops_set"] += 1
            return {
                "type": "BREAKEVEN_STOP",
                "should_exit": False,
                "urgency": 3,
                "reason": (
                    f"Break-even stop activated: PnL {pnl_pct * 100:.2f}% "
                    f">= {BREAKEVEN_PROFIT_TRIGGER * 100:.1f}% threshold. "
                    f"Stop moved to {new_stop:.4f} (entry + fees)"
                ),
                "new_stop": new_stop,
            }

        return None

    # ------------------------------------------------------------------
    # 8. Partial Take-Profit
    # ------------------------------------------------------------------

    def _check_partial_tp(
        self,
        state: PositionState,
        current_price: float,
        position: dict,
    ) -> Optional[Dict]:
        """Check if any partial take-profit tier has been reached."""
        if state.partial_exits_done >= len(PARTIAL_TP_TIERS):
            return None

        entry = state.entry_price
        target_price = float(position.get("target", 0))
        if entry <= 0:
            return None

        if target_price > 0:
            target_distance = abs(target_price - entry)
        else:
            target_distance = entry * 0.01

        tier_frac, position_frac = PARTIAL_TP_TIERS[state.partial_exits_done]
        threshold_distance = target_distance * tier_frac

        if state.side == "BUY":
            current_distance = current_price - entry
        else:
            current_distance = entry - current_price

        if current_distance >= threshold_distance:
            state.partial_exits_done += 1
            tier_label = f"{state.partial_exits_done}/{len(PARTIAL_TP_TIERS) + 1}"
            pct_target = tier_frac * 100

            self._stats["partial_exits"] += 1
            return {
                "type": "PARTIAL_TAKE_PROFIT",
                "should_exit": False,  # partial, not full
                "urgency": 4,
                "reason": (
                    f"Partial TP tier {tier_label}: "
                    f"price reached {pct_target:.0f}% of target. "
                    f"Sell {position_frac * 100:.0f}% of position"
                ),
                "exit_fraction": position_frac,
                "tier": state.partial_exits_done,
                "total_tiers": len(PARTIAL_TP_TIERS) + 1,
                "remaining_uses_trailing": state.partial_exits_done >= len(PARTIAL_TP_TIERS),
            }

        return None

    # ------------------------------------------------------------------
    # Public API: check_exits
    # ------------------------------------------------------------------

    def check_exits(
        self,
        symbol: str,
        position: dict,
        df: pd.DataFrame,
        current_price: float,
    ) -> List[Dict]:
        """Run all smart exit checks and return list of triggered exits.

        Parameters
        ----------
        symbol : str
            Trading pair, e.g. "BTCUSD".
        position : dict
            Position dict with keys: side, entry, stop, target, open_time, size_usd.
        df : pd.DataFrame
            Recent OHLC(V) candle data.
        current_price : float
            Current market price.

        Returns
        -------
        list[dict]
            Each dict has: type, should_exit, urgency (1-10), reason,
            and strategy-specific fields.
        """
        signals: List[Dict] = []

        try:
            with self._lock:
                self._stats["exits_checked"] += 1
                state = self._ensure_state(symbol, position)
                self._update_tracking(state, df, current_price)

                # 1. Chandelier Exit
                sig = self._check_chandelier_exit(state, df, current_price)
                if sig is not None:
                    signals.append(sig)

                # 2. Parabolic SAR Exit
                sig = self._check_psar_exit(state, df, current_price)
                if sig is not None:
                    signals.append(sig)

                # 3. Keltner Channel Exit
                sig = self._check_keltner_exit(state, df, current_price)
                if sig is not None:
                    signals.append(sig)

                # 4. Volume Dry-Up Exit
                sig = self._check_volume_dryup_exit(state, df)
                if sig is not None:
                    signals.append(sig)

                # 5. Momentum Exhaustion (RSI Divergence)
                sig = self._check_momentum_exhaustion_exit(state, df, current_price)
                if sig is not None:
                    signals.append(sig)

                # 6. Time-Weighted Exit
                sig = self._check_time_weighted_exit(state, current_price, position)
                if sig is not None:
                    signals.append(sig)

                # 7. Break-Even Stop
                sig = self._check_breakeven_stop(state, current_price, position)
                if sig is not None:
                    signals.append(sig)

                # 8. Partial Take-Profit
                sig = self._check_partial_tp(state, current_price, position)
                if sig is not None:
                    signals.append(sig)

                if any(s.get("should_exit") for s in signals):
                    self._stats["exits_triggered"] += 1

        except Exception:
            logger.exception("Error in check_exits for %s", symbol)

        return signals

    # ------------------------------------------------------------------
    # Public API: get_trailing_stop
    # ------------------------------------------------------------------

    def get_trailing_stop(
        self,
        symbol: str,
        position: dict,
        df: pd.DataFrame,
    ) -> float:
        """Compute the best (tightest protective) trailing stop from all methods.

        Returns the stop price that offers the most protection. For longs,
        this is the highest of all trailing stop values. For shorts, the lowest.

        Parameters
        ----------
        symbol : str
            Trading pair.
        position : dict
            Position dict with keys: side, entry, stop, target, open_time.
        df : pd.DataFrame
            Recent OHLC(V) candle data.

        Returns
        -------
        float
            Recommended trailing stop price, or 0.0 if no stop can be computed.
        """
        try:
            with self._lock:
                state = self._ensure_state(symbol, position)
                current_price = float(
                    position.get("current_price", state.highest_high)
                )
                self._update_tracking(state, df, current_price)

                stops: List[float] = []

                # Chandelier stop
                atr_series = _compute_atr(df)
                if atr_series is not None and not atr_series.dropna().empty:
                    atr = float(atr_series.iloc[-1])
                    if atr > 0:
                        if state.side == "BUY":
                            stops.append(state.highest_high - CHANDELIER_ATR_MULT * atr)
                        else:
                            stops.append(state.lowest_low + CHANDELIER_ATR_MULT * atr)

                # Parabolic SAR stop
                if state.psar_initialised and state.psar_value > 0:
                    stops.append(state.psar_value)

                # Keltner lower/upper band
                ndf = _normalise_ohlcv(df)
                if ndf is not None and len(ndf) >= max(KELTNER_EMA_PERIOD, ATR_PERIOD) + 1:
                    if atr_series is not None:
                        close = ndf["close"]
                        ema_mid = _compute_ema(close, KELTNER_EMA_PERIOD)
                        if state.side == "BUY":
                            lower = ema_mid - KELTNER_ATR_MULT * atr_series
                            val = float(lower.iloc[-1])
                            if not math.isnan(val):
                                stops.append(val)
                        else:
                            upper = ema_mid + KELTNER_ATR_MULT * atr_series
                            val = float(upper.iloc[-1])
                            if not math.isnan(val):
                                stops.append(val)

                # Break-even stop
                if state.breakeven_activated:
                    fee_offset = state.entry_price * FEE_ROUND_TRIP_PCT
                    if state.side == "BUY":
                        stops.append(state.entry_price + fee_offset)
                    else:
                        stops.append(state.entry_price - fee_offset)

                if not stops:
                    return 0.0

                # Filter out NaN and invalid
                stops = [s for s in stops if not math.isnan(s) and s > 0]
                if not stops:
                    return 0.0

                # For longs: tightest stop = highest value (closest to price)
                # For shorts: tightest stop = lowest value (closest to price)
                if state.side == "BUY":
                    return max(stops)
                else:
                    return min(stops)

        except Exception:
            logger.exception("Error in get_trailing_stop for %s", symbol)
            return 0.0

    # ------------------------------------------------------------------
    # Public API: should_partial_exit
    # ------------------------------------------------------------------

    def should_partial_exit(
        self,
        symbol: str,
        position: dict,
        current_price: float,
    ) -> Dict:
        """Check if a partial take-profit is recommended.

        Parameters
        ----------
        symbol : str
            Trading pair.
        position : dict
            Position dict with keys: side, entry, target, size_usd.
        current_price : float
            Current market price.

        Returns
        -------
        dict
            {
                "should_partial": bool,
                "exit_fraction": float,     # fraction of position to exit
                "tier": int,                # which tier (1, 2, or 3)
                "total_tiers": int,
                "reason": str,
                "remaining_action": str,    # "HOLD" or "TRAILING_STOP"
            }
        """
        result: Dict[str, Any] = {
            "should_partial": False,
            "exit_fraction": 0.0,
            "tier": 0,
            "total_tiers": len(PARTIAL_TP_TIERS) + 1,
            "reason": "",
            "remaining_action": "HOLD",
        }

        try:
            with self._lock:
                state = self._ensure_state(symbol, position)

                if state.partial_exits_done >= len(PARTIAL_TP_TIERS):
                    result["reason"] = (
                        "All partial TP tiers exhausted; "
                        "remaining 1/3 riding with trailing stop"
                    )
                    result["remaining_action"] = "TRAILING_STOP"
                    return result

                entry = state.entry_price
                target_price = float(position.get("target", 0))
                if entry <= 0:
                    return result

                if target_price > 0:
                    target_distance = abs(target_price - entry)
                else:
                    target_distance = entry * 0.01

                tier_frac, position_frac = PARTIAL_TP_TIERS[state.partial_exits_done]
                threshold_distance = target_distance * tier_frac

                if state.side == "BUY":
                    current_distance = current_price - entry
                else:
                    current_distance = entry - current_price

                if current_distance >= threshold_distance:
                    state.partial_exits_done += 1
                    self._stats["partial_exits"] += 1

                    result["should_partial"] = True
                    result["exit_fraction"] = position_frac
                    result["tier"] = state.partial_exits_done
                    result["reason"] = (
                        f"Partial TP tier {state.partial_exits_done}: "
                        f"price reached {tier_frac * 100:.0f}% of target distance. "
                        f"Exit {position_frac * 100:.0f}% of position."
                    )

                    if state.partial_exits_done >= len(PARTIAL_TP_TIERS):
                        result["remaining_action"] = "TRAILING_STOP"
                    else:
                        result["remaining_action"] = "HOLD"
                else:
                    progress = (
                        (current_distance / threshold_distance * 100)
                        if threshold_distance > 0
                        else 0.0
                    )
                    next_tier = state.partial_exits_done + 1
                    result["reason"] = (
                        f"Not yet at tier {next_tier} "
                        f"({tier_frac * 100:.0f}% of target). "
                        f"Progress: {progress:.1f}%"
                    )

        except Exception:
            logger.exception("Error in should_partial_exit for %s", symbol)

        return result

    # ------------------------------------------------------------------
    # Public API: get_status
    # ------------------------------------------------------------------

    def get_status(self) -> Dict:
        """Return service status and accumulated statistics.

        Returns
        -------
        dict
            Service metadata and per-strategy exit counters.
        """
        with self._lock:
            positions_info = {}
            for sym, st in self._positions.items():
                positions_info[sym] = {
                    "side": st.side,
                    "entry_price": st.entry_price,
                    "highest_high": st.highest_high,
                    "lowest_low": st.lowest_low,
                    "partial_exits_done": st.partial_exits_done,
                    "breakeven_activated": st.breakeven_activated,
                    "psar_value": st.psar_value,
                    "psar_af": st.psar_af,
                    "psar_initialised": st.psar_initialised,
                    "elapsed_seconds": time.time() - st.entry_time,
                }

            return {
                "service": "SmartExits",
                "active_positions": len(self._positions),
                "positions": positions_info,
                "stats": dict(self._stats),
            }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[SmartExits] = None
_instance_lock = threading.Lock()


def get_smart_exits() -> SmartExits:
    """Return the singleton SmartExits instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = SmartExits()
    return _instance
