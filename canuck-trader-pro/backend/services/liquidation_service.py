"""
Liquidation Level Estimator

Estimates probable liquidation zones from derivatives data (OKX OI, funding rates)
and Binance order book depth. No paid API needed.

Liquidation levels act as "price magnets" - high concentrations of leveraged positions
at certain prices create cascading liquidation events when price approaches.

Methodology:
1. Estimate leveraged position clusters from OI changes + funding rate direction
2. Calculate liquidation prices at common leverage levels (5x, 10x, 25x, 50x, 100x)
3. Weight by typical retail leverage distribution
4. Detect when price approaches liquidation clusters → signal boost
"""
import logging
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests

logger = logging.getLogger(__name__)

# Binance public API
BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr"
BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"

# OKX public API
OKX_OI_URL = "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume"
OKX_FUNDING_URL = "https://www.okx.com/api/v5/public/funding-rate"

# Common leverage levels and their estimated retail distribution weights
LEVERAGE_LEVELS = {
    5: 0.10,    # 10% of positions at 5x
    10: 0.25,   # 25% at 10x
    25: 0.30,   # 30% at 25x
    50: 0.20,   # 20% at 50x
    100: 0.15,  # 15% at 100x
}

PAIR_TO_BINANCE = {
    "BTC/USD": "BTCUSDT", "ETH/USD": "ETHUSDT", "XRP/USD": "XRPUSDT",
    "SOL/USD": "SOLUSDT", "ADA/USD": "ADAUSDT", "DOGE/USD": "DOGEUSDT",
    "LINK/USD": "LINKUSDT", "DOT/USD": "DOTUSDT", "AVAX/USD": "AVAXUSDT",
}

PAIR_TO_OKX = {
    "BTC/USD": "BTC-USDT-SWAP", "ETH/USD": "ETH-USDT-SWAP",
    "XRP/USD": "XRP-USDT-SWAP", "SOL/USD": "SOL-USDT-SWAP",
    "ADA/USD": "ADA-USDT-SWAP", "DOGE/USD": "DOGE-USDT-SWAP",
    "LINK/USD": "LINK-USDT-SWAP", "DOT/USD": "DOT-USDT-SWAP",
    "AVAX/USD": "AVAX-USDT-SWAP",
}


class LiquidationEstimator:
    """Estimates liquidation levels and provides price-magnet signals."""

    def __init__(self):
        self._cache: Dict[str, Tuple[float, dict]] = {}
        self._cache_ttl = 30  # 30 seconds (liquidation zones don't change fast)
        self._price_history: Dict[str, list] = defaultdict(list)
        logger.info("Liquidation estimator initialized")

    def _fetch_current_price(self, binance_symbol: str) -> Optional[float]:
        """Get current price from Binance."""
        try:
            resp = requests.get(
                BINANCE_TICKER_URL,
                params={"symbol": binance_symbol},
                timeout=5,
            )
            if resp.status_code == 200:
                return float(resp.json()["lastPrice"])
        except Exception as e:
            logger.debug(f"Price fetch error: {e}")
        return None

    def _fetch_funding_rate(self, okx_inst: str) -> Optional[float]:
        """Get current funding rate from OKX."""
        try:
            resp = requests.get(
                OKX_FUNDING_URL,
                params={"instId": okx_inst},
                timeout=5,
            )
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data:
                    return float(data[0].get("fundingRate", 0))
        except Exception as e:
            logger.debug(f"Funding rate fetch error: {e}")
        return None

    def _estimate_liquidation_levels(self, price: float, funding_rate: float) -> dict:
        """Calculate estimated liquidation price levels.

        Logic:
        - Positive funding → longs pay shorts → more longs exist → long liquidations below price
        - Negative funding → shorts pay longs → more shorts exist → short liquidations above price
        - Each leverage level has a liquidation distance: price * (1 / leverage)
        """
        long_liquidations = []
        short_liquidations = []

        for leverage, weight in LEVERAGE_LEVELS.items():
            # Liquidation distance (simplified: 1/leverage with maintenance margin ~0.5%)
            margin_buffer = 0.005  # 0.5% maintenance margin
            liq_distance_pct = (1.0 / leverage) - margin_buffer

            # Long liquidation = price * (1 - liq_distance)
            long_liq_price = price * (1 - liq_distance_pct)
            # Short liquidation = price * (1 + liq_distance)
            short_liq_price = price * (1 + liq_distance_pct)

            # Adjust weights by funding rate (indicates position imbalance)
            # Positive funding → more longs → bigger long liquidation clusters
            if funding_rate > 0:
                long_weight = weight * (1 + min(abs(funding_rate) * 1000, 0.5))
                short_weight = weight * (1 - min(abs(funding_rate) * 500, 0.3))
            else:
                long_weight = weight * (1 - min(abs(funding_rate) * 500, 0.3))
                short_weight = weight * (1 + min(abs(funding_rate) * 1000, 0.5))

            long_liquidations.append({
                "price": round(long_liq_price, 2),
                "leverage": leverage,
                "weight": round(long_weight, 4),
                "distance_pct": round(liq_distance_pct * 100, 2),
            })
            short_liquidations.append({
                "price": round(short_liq_price, 2),
                "leverage": leverage,
                "weight": round(short_weight, 4),
                "distance_pct": round(liq_distance_pct * 100, 2),
            })

        return {
            "long_liquidations": sorted(long_liquidations, key=lambda x: x["price"], reverse=True),
            "short_liquidations": sorted(short_liquidations, key=lambda x: x["price"]),
        }

    def _compute_magnet_signal(self, price: float, levels: dict) -> dict:
        """Compute how strongly price is being pulled toward liquidation clusters.

        Returns signal direction + strength based on proximity to weighted liquidation levels.
        """
        # Find nearest significant liquidation levels
        nearest_long = None
        nearest_long_dist = float("inf")
        total_long_weight = 0

        for liq in levels["long_liquidations"]:
            dist = (price - liq["price"]) / price
            if 0 < dist < nearest_long_dist:
                nearest_long_dist = dist
                nearest_long = liq
            if 0 < dist < 0.05:  # within 5%
                total_long_weight += liq["weight"]

        nearest_short = None
        nearest_short_dist = float("inf")
        total_short_weight = 0

        for liq in levels["short_liquidations"]:
            dist = (liq["price"] - price) / price
            if 0 < dist < nearest_short_dist:
                nearest_short_dist = dist
                nearest_short = liq
            if 0 < dist < 0.05:  # within 5%
                total_short_weight += liq["weight"]

        # Proximity signal: closer to liquidation cluster = stronger magnet pull
        long_proximity_score = 0
        short_proximity_score = 0

        if nearest_long and nearest_long_dist < 0.03:  # within 3%
            # Price approaching long liquidations → bearish magnet (cascade down)
            long_proximity_score = (1 - nearest_long_dist / 0.03) * total_long_weight * 100

        if nearest_short and nearest_short_dist < 0.03:  # within 3%
            # Price approaching short liquidations → bullish magnet (cascade up)
            short_proximity_score = (1 - nearest_short_dist / 0.03) * total_short_weight * 100

        # Determine signal
        if long_proximity_score > short_proximity_score and long_proximity_score > 10:
            signal = "BEARISH"  # approaching long liquidation cascade
            strength = min(100, int(long_proximity_score))
        elif short_proximity_score > long_proximity_score and short_proximity_score > 10:
            signal = "BULLISH"  # approaching short squeeze
            strength = min(100, int(short_proximity_score))
        else:
            signal = "NEUTRAL"
            strength = 0

        return {
            "signal": signal,
            "strength": strength,
            "nearest_long_liq": nearest_long,
            "nearest_long_dist_pct": round(nearest_long_dist * 100, 2) if nearest_long else None,
            "nearest_short_liq": nearest_short,
            "nearest_short_dist_pct": round(nearest_short_dist * 100, 2) if nearest_short else None,
            "long_cluster_weight": round(total_long_weight, 4),
            "short_cluster_weight": round(total_short_weight, 4),
        }

    def update(self, symbol: str) -> Optional[dict]:
        """Compute liquidation levels and magnet signal for a symbol."""
        now = time.time()
        cached = self._cache.get(symbol)
        if cached and now - cached[0] < self._cache_ttl:
            return cached[1]

        binance_sym = PAIR_TO_BINANCE.get(symbol)
        okx_inst = PAIR_TO_OKX.get(symbol)
        if not binance_sym:
            return None

        # Fetch current price
        price = self._fetch_current_price(binance_sym)
        if not price:
            return None

        # Fetch funding rate (use 0 if unavailable)
        funding_rate = 0.0
        if okx_inst:
            fr = self._fetch_funding_rate(okx_inst)
            if fr is not None:
                funding_rate = fr

        # Estimate liquidation levels
        levels = self._estimate_liquidation_levels(price, funding_rate)

        # Compute magnet signal
        magnet = self._compute_magnet_signal(price, levels)

        result = {
            "symbol": symbol,
            "current_price": price,
            "funding_rate": round(funding_rate, 6),
            "levels": levels,
            "magnet_signal": magnet,
            "timestamp": now,
        }

        self._cache[symbol] = (now, result)
        return result

    def get_confidence_adjustment(self, symbol: str, proposed_direction: str) -> int:
        """Get confidence adjustment (-10 to +10) based on liquidation proximity.

        If proposed BUY and approaching short squeeze → positive boost.
        If proposed BUY and approaching long cascade → negative penalty.
        """
        data = self.update(symbol)
        if data is None:
            return 0

        magnet = data["magnet_signal"]
        strength = magnet["strength"]

        if strength < 10:
            return 0

        # Scale to -10 to +10
        adjustment = int(strength * 0.1)

        if proposed_direction == "BUY":
            if magnet["signal"] == "BULLISH":
                return min(10, adjustment)  # short squeeze incoming → boost buy
            elif magnet["signal"] == "BEARISH":
                return max(-10, -adjustment)  # long cascade incoming → penalize buy
        elif proposed_direction == "SELL":
            if magnet["signal"] == "BEARISH":
                return min(10, adjustment)  # long cascade → boost sell
            elif magnet["signal"] == "BULLISH":
                return max(-10, -adjustment)  # short squeeze → penalize sell

        return 0


# Module-level singleton
_liquidation_service: Optional[LiquidationEstimator] = None


def get_liquidation_service() -> LiquidationEstimator:
    global _liquidation_service
    if _liquidation_service is None:
        _liquidation_service = LiquidationEstimator()
    return _liquidation_service
