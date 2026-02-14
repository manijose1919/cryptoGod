"""
Funding Rate Carry Service

Uses perpetual futures funding rates to generate directional trading signals
for crypto spot trading. When longs pay shorts (positive funding), the market
is over-leveraged long — bearish bias. When shorts pay longs (negative funding),
the market is over-leveraged short — bullish bias.

Singleton access via get_funding_carry().
"""

import logging
import threading
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────
FUNDING_BULL_THRESHOLD = -0.0005   # -0.05%: shorts paying longs → bullish
FUNDING_BEAR_THRESHOLD = 0.0005    #  0.05%: longs paying shorts → bearish
FUNDING_EXTREME = 0.001            #  0.1%: extreme leverage imbalance

MAX_SNAPSHOTS_PER_SYMBOL = 100
MIN_SNAPSHOTS_FOR_TREND = 3


class FundingCarry:
    """Thread-safe funding rate tracker and signal generator."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # symbol -> list of (timestamp, rate) tuples, newest last
        self._history: Dict[str, List[Tuple[float, float]]] = defaultdict(list)
        logger.info("FundingCarry service initialised")

    # ── Data ingestion ────────────────────────────────────────────────────────

    def record_funding_rate(self, symbol: str, rate: float, timestamp: float) -> None:
        """
        Store a funding rate snapshot.

        Args:
            symbol: Trading pair, e.g. "BTC/USD".
            rate: Funding rate as a decimal (0.0001 = 0.01%).
            timestamp: Unix epoch seconds.
        """
        with self._lock:
            history = self._history[symbol]

            # Avoid duplicate timestamps
            if history and history[-1][0] == timestamp:
                return

            history.append((timestamp, rate))

            # Trim to keep only the most recent snapshots
            if len(history) > MAX_SNAPSHOTS_PER_SYMBOL:
                self._history[symbol] = history[-MAX_SNAPSHOTS_PER_SYMBOL:]

            logger.debug(
                "Recorded funding rate for %s: %.6f (snapshots: %d)",
                symbol, rate, len(self._history[symbol]),
            )

    # ── Signal generation ─────────────────────────────────────────────────────

    def get_funding_signal(self, symbol: str) -> Dict:
        """
        Derive a directional signal from current and recent funding rates.

        Returns:
            {
                "signal": "LONG" | "SHORT" | "NEUTRAL",
                "funding_rate": float,
                "trend": "RISING" | "FALLING" | "FLAT",
                "confidence": int (0-100),
            }
        """
        with self._lock:
            history = self._history.get(symbol, [])

        neutral = {
            "signal": "NEUTRAL",
            "funding_rate": 0.0,
            "trend": "FLAT",
            "confidence": 0,
        }

        if not history:
            return neutral

        current_rate = history[-1][1]
        trend = self._compute_trend(history)
        signal, confidence = self._rate_to_signal(current_rate, trend)

        return {
            "signal": signal,
            "funding_rate": current_rate,
            "trend": trend,
            "confidence": confidence,
        }

    # ── Confidence adjustment for external signals ────────────────────────────

    def get_confidence_adjustment(self, symbol: str, action: str) -> int:
        """
        Return a confidence modifier (-10 to +10) based on whether the current
        funding rate confirms or contradicts the proposed trade direction.

        Args:
            symbol: Trading pair.
            action: "BUY" or "SELL" (the proposed trade direction).

        Returns:
            Positive value if funding confirms, negative if it contradicts.
        """
        sig = self.get_funding_signal(symbol)
        rate = sig["funding_rate"]
        funding_signal = sig["signal"]

        action_upper = action.upper()
        if action_upper not in ("BUY", "SELL"):
            logger.warning("Unknown action '%s' for confidence adjustment", action)
            return 0

        # Map action to expected funding signal alignment
        # BUY is confirmed by LONG signal, SELL by SHORT signal
        confirms = (
            (action_upper == "BUY" and funding_signal == "LONG")
            or (action_upper == "SELL" and funding_signal == "SHORT")
        )
        contradicts = (
            (action_upper == "BUY" and funding_signal == "SHORT")
            or (action_upper == "SELL" and funding_signal == "LONG")
        )

        abs_rate = abs(rate)
        extreme = abs_rate >= FUNDING_EXTREME

        if confirms:
            return 10 if extreme else 5
        elif contradicts:
            return -10 if extreme else -5
        else:
            # NEUTRAL funding — no meaningful adjustment
            return 0

    # ── Helpers (called under lock or with copied data) ───────────────────────

    @staticmethod
    def _compute_trend(history: List[Tuple[float, float]]) -> str:
        """Determine whether funding rates are RISING, FALLING, or FLAT."""
        if len(history) < MIN_SNAPSHOTS_FOR_TREND:
            return "FLAT"

        # Use up to the last 10 snapshots for trend detection
        recent = history[-10:]
        rates = np.array([r for _, r in recent], dtype=np.float64)

        # Simple linear regression slope via numpy
        x = np.arange(len(rates), dtype=np.float64)
        try:
            coeffs = np.polyfit(x, rates, 1)
            slope = coeffs[0]
        except (np.linalg.LinAlgError, ValueError):
            return "FLAT"

        # Slope threshold: anything below this is noise
        slope_threshold = 1e-6

        if slope > slope_threshold:
            return "RISING"
        elif slope < -slope_threshold:
            return "FALLING"
        return "FLAT"

    @staticmethod
    def _rate_to_signal(rate: float, trend: str) -> Tuple[str, int]:
        """
        Convert a funding rate + trend into a signal and confidence.

        Logic:
          - Positive funding (longs pay shorts) → bearish → SHORT
          - Negative funding (shorts pay longs) → bullish → LONG
          - Between thresholds → NEUTRAL

        Confidence scales with magnitude and trend alignment.
        """
        abs_rate = abs(rate)

        # ── Determine raw signal ──────────────────────────────────────────────
        if rate >= FUNDING_BEAR_THRESHOLD:
            signal = "SHORT"
        elif rate <= FUNDING_BULL_THRESHOLD:
            signal = "LONG"
        else:
            # Within the dead zone
            return "NEUTRAL", 0

        # ── Base confidence from magnitude ────────────────────────────────────
        # Map |rate| from threshold..extreme → 30..80, clamped
        threshold = FUNDING_BEAR_THRESHOLD  # symmetric thresholds
        if abs_rate >= FUNDING_EXTREME:
            base_confidence = 80
        else:
            # Linear interpolation between threshold and extreme
            t = (abs_rate - threshold) / (FUNDING_EXTREME - threshold)
            base_confidence = int(30 + t * 50)

        # ── Trend bonus / penalty ─────────────────────────────────────────────
        # Rising funding reinforces SHORT, falling funding reinforces LONG
        trend_bonus = 0
        if signal == "SHORT" and trend == "RISING":
            trend_bonus = 15
        elif signal == "SHORT" and trend == "FALLING":
            trend_bonus = -10
        elif signal == "LONG" and trend == "FALLING":
            trend_bonus = 15
        elif signal == "LONG" and trend == "RISING":
            trend_bonus = -10

        confidence = max(0, min(100, base_confidence + trend_bonus))
        return signal, confidence

    # ── Diagnostics ───────────────────────────────────────────────────────────

    def get_status(self) -> Dict:
        """Return a summary of tracked symbols and snapshot counts."""
        with self._lock:
            return {
                symbol: {
                    "snapshots": len(hist),
                    "latest_rate": hist[-1][1] if hist else None,
                    "latest_ts": hist[-1][0] if hist else None,
                }
                for symbol, hist in self._history.items()
            }


# ── Singleton ─────────────────────────────────────────────────────────────────

_instance: Optional[FundingCarry] = None
_instance_lock = threading.Lock()


def get_funding_carry() -> FundingCarry:
    """Return the singleton FundingCarry instance (thread-safe lazy init)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = FundingCarry()
    return _instance
