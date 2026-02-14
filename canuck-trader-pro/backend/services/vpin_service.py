"""
VPIN - Volume-Synchronized Probability of Informed Trading

Measures the probability that trading activity is driven by informed traders
(who know something the market doesn't). High VPIN = toxic order flow =
large directional moves likely incoming.

Implementation:
1. Classify each trade as buyer/seller-initiated using tick rule
2. Aggregate into volume buckets (not time buckets)
3. Compute VPIN = |V_buy - V_sell| / V_total for each bucket
4. Rolling average VPIN over N buckets
5. Signal when VPIN exceeds historical threshold

Key insight: Volume clocks > time clocks for detecting informed trading
because informed traders trade more aggressively.
"""
import logging
import time
from collections import defaultdict, deque
from typing import Dict, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

BUCKET_VOLUME = 50  # volume per bucket (in units of the asset)
N_BUCKETS = 50       # rolling window for VPIN calculation
VPIN_HIGH_THRESHOLD = 0.7  # above this = likely informed trading
VPIN_EXTREME_THRESHOLD = 0.85  # above this = very toxic flow


class VPINCalculator:
    """Calculates Volume-synchronized Probability of Informed Trading."""

    def __init__(self, bucket_volume: float = BUCKET_VOLUME, n_buckets: int = N_BUCKETS):
        self.bucket_volume = bucket_volume
        self.n_buckets = n_buckets

        # Per-symbol state
        self._buy_vol: Dict[str, float] = defaultdict(float)
        self._sell_vol: Dict[str, float] = defaultdict(float)
        self._current_bucket_vol: Dict[str, float] = defaultdict(float)
        self._buckets: Dict[str, deque] = {}  # symbol -> deque of (buy_vol, sell_vol)
        self._last_price: Dict[str, float] = {}

        # Cache
        self._cache: Dict[str, Tuple[float, dict]] = {}
        self._cache_ttl = 5

        logger.info(f"VPIN initialized (bucket={bucket_volume}, window={n_buckets})")

    def _classify_trade(self, symbol: str, price: float, volume: float) -> str:
        """Classify trade as BUY or SELL using tick rule.

        Tick rule: If price > last price, trade is buyer-initiated.
        If price < last price, trade is seller-initiated.
        If equal, use previous classification.
        """
        last = self._last_price.get(symbol)
        self._last_price[symbol] = price

        if last is None:
            return "BUY"  # default first trade

        if price > last:
            return "BUY"
        elif price < last:
            return "SELL"
        return "BUY"  # unchanged = assume buyer

    def add_trade(self, symbol: str, price: float, volume: float):
        """Process a single trade and update VPIN buckets."""
        side = self._classify_trade(symbol, price, volume)

        if side == "BUY":
            self._buy_vol[symbol] += volume
        else:
            self._sell_vol[symbol] += volume
        self._current_bucket_vol[symbol] += volume

        # Check if bucket is full
        if self._current_bucket_vol[symbol] >= self.bucket_volume:
            # Complete the bucket
            if symbol not in self._buckets:
                self._buckets[symbol] = deque(maxlen=self.n_buckets)

            self._buckets[symbol].append({
                "buy": self._buy_vol[symbol],
                "sell": self._sell_vol[symbol],
                "total": self._current_bucket_vol[symbol],
            })

            # Reset for next bucket
            self._buy_vol[symbol] = 0
            self._sell_vol[symbol] = 0
            self._current_bucket_vol[symbol] = 0

    def add_candle(self, symbol: str, open_price: float, high: float, low: float,
                   close: float, volume: float):
        """Approximate trade classification from OHLCV candle.

        Uses close vs open to determine net direction,
        splits volume proportionally.
        """
        if volume <= 0:
            return

        # Proportion of volume that was buying vs selling
        candle_range = high - low
        if candle_range > 0:
            # Close position within range indicates buy/sell ratio
            close_position = (close - low) / candle_range  # 0=bearish, 1=bullish
        else:
            close_position = 0.5

        buy_vol = volume * close_position
        sell_vol = volume * (1 - close_position)

        self._buy_vol[symbol] += buy_vol
        self._sell_vol[symbol] += sell_vol
        self._current_bucket_vol[symbol] += volume

        self._last_price[symbol] = close

        # Check if bucket is full
        if self._current_bucket_vol[symbol] >= self.bucket_volume:
            if symbol not in self._buckets:
                self._buckets[symbol] = deque(maxlen=self.n_buckets)

            self._buckets[symbol].append({
                "buy": self._buy_vol[symbol],
                "sell": self._sell_vol[symbol],
                "total": self._current_bucket_vol[symbol],
            })

            self._buy_vol[symbol] = 0
            self._sell_vol[symbol] = 0
            self._current_bucket_vol[symbol] = 0

    def compute_vpin(self, symbol: str) -> dict:
        """Compute current VPIN for a symbol.

        Returns: {vpin, signal, confidence, n_buckets, history}
        """
        now = time.time()
        cached = self._cache.get(symbol)
        if cached and now - cached[0] < self._cache_ttl:
            return cached[1]

        buckets = self._buckets.get(symbol)
        if not buckets or len(buckets) < 5:
            result = {
                "symbol": symbol,
                "vpin": 0,
                "signal": "NEUTRAL",
                "confidence": 0,
                "n_buckets": len(buckets) if buckets else 0,
                "sufficient_data": False,
            }
            self._cache[symbol] = (now, result)
            return result

        # VPIN = average of |buy - sell| / total across recent buckets
        vpin_values = []
        for b in buckets:
            total = b["total"]
            if total > 0:
                imbalance = abs(b["buy"] - b["sell"]) / total
                vpin_values.append(imbalance)

        vpin = np.mean(vpin_values) if vpin_values else 0

        # Direction: are informed traders buying or selling?
        recent_buy = sum(b["buy"] for b in list(buckets)[-10:])
        recent_sell = sum(b["sell"] for b in list(buckets)[-10:])
        if recent_buy > recent_sell * 1.2:
            informed_direction = "BUY"
        elif recent_sell > recent_buy * 1.2:
            informed_direction = "SELL"
        else:
            informed_direction = "NEUTRAL"

        # Signal based on VPIN level
        if vpin >= VPIN_EXTREME_THRESHOLD:
            signal = "EXTREME_TOXIC"
            confidence = 90
        elif vpin >= VPIN_HIGH_THRESHOLD:
            signal = "HIGH_TOXIC"
            confidence = 70
        elif vpin >= 0.5:
            signal = "ELEVATED"
            confidence = 40
        else:
            signal = "NORMAL"
            confidence = 0

        # Historical VPIN trend
        if len(vpin_values) >= 20:
            recent_vpin = np.mean(vpin_values[-10:])
            older_vpin = np.mean(vpin_values[-20:-10])
            trend = "RISING" if recent_vpin > older_vpin * 1.1 else (
                "FALLING" if recent_vpin < older_vpin * 0.9 else "STABLE"
            )
        else:
            trend = "INSUFFICIENT"

        result = {
            "symbol": symbol,
            "vpin": round(float(vpin), 4),
            "signal": signal,
            "informed_direction": informed_direction,
            "confidence": confidence,
            "trend": trend,
            "n_buckets": len(buckets),
            "sufficient_data": True,
            "buy_sell_ratio": round(recent_buy / recent_sell, 3) if recent_sell > 0 else 999,
            "timestamp": now,
        }

        self._cache[symbol] = (now, result)
        return result

    def get_confidence_adjustment(self, symbol: str, proposed_direction: str) -> int:
        """Adjust confidence based on VPIN.

        High VPIN aligned with direction → boost (riding informed flow)
        High VPIN opposing direction → strong penalty (fighting informed traders)
        """
        data = self.compute_vpin(symbol)
        if not data["sufficient_data"] or data["confidence"] < 30:
            return 0

        vpin = data["vpin"]
        informed_dir = data["informed_direction"]

        if informed_dir == proposed_direction:
            # Aligned with informed flow → positive
            return min(10, int(vpin * 12))
        elif informed_dir != "NEUTRAL":
            # Fighting informed traders → penalty
            return max(-15, -int(vpin * 18))

        return 0

    def initialize_from_candles(self, symbol: str, df):
        """Bulk-initialize VPIN from historical OHLCV DataFrame."""
        for _, row in df.iterrows():
            self.add_candle(
                symbol,
                float(row["open"]), float(row["high"]),
                float(row["low"]), float(row["close"]),
                float(row["volume"]),
            )


# Module-level singleton
_vpin: Optional[VPINCalculator] = None


def get_vpin_calculator() -> VPINCalculator:
    global _vpin
    if _vpin is None:
        _vpin = VPINCalculator()
    return _vpin
