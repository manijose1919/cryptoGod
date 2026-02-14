"""
Multi-Level Order Flow Imbalance (MLOFI) Service

Tracks bid/ask changes across 10 depth levels to generate
high-quality short-term directional signals.

MLOFI is the single most predictive short-term feature for price direction,
reducing forecast RMSE by 65-75% compared to single-level OFI.
"""
import logging
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests

logger = logging.getLogger(__name__)

# Binance public API (no auth needed)
BINANCE_OB_URL = "https://api.binance.com/api/v3/depth"
BINANCE_TRADES_URL = "https://api.binance.com/api/v3/trades"

# Map our pairs to Binance symbols
PAIR_TO_BINANCE = {
    "BTC/USD": "BTCUSDT",
    "ETH/USD": "ETHUSDT",
    "XRP/USD": "XRPUSDT",
    "SOL/USD": "SOLUSDT",
    "ADA/USD": "ADAUSDT",
    "DOGE/USD": "DOGEUSDT",
    "LINK/USD": "LINKUSDT",
    "DOT/USD": "DOTUSDT",
    "AVAX/USD": "AVAXUSDT",
}

OB_DEPTH_LEVELS = 10
MAX_SNAPSHOTS = 60  # keep last 60 snapshots (~5 min at 5s intervals)
TRADE_HISTORY_SIZE = 200


class MLOFIService:
    """Multi-Level Order Flow Imbalance tracker."""

    def __init__(self):
        # Previous order book state per symbol: {symbol: {"bids": [...], "asks": [...]}}
        self._prev_ob: Dict[str, dict] = {}
        # Rolling OFI history: {symbol: [np.array(10), ...]}
        self._ofi_history: Dict[str, list] = defaultdict(list)
        # Recent trades for trade imbalance: {symbol: [{"price", "qty", "isBuyerMaker"}, ...]}
        self._recent_trades: Dict[str, list] = defaultdict(list)
        # Cache: {symbol: (timestamp, data)}
        self._cache: Dict[str, Tuple[float, dict]] = {}
        self._cache_ttl = 3  # seconds
        logger.info("MLOFI service initialized")

    def _fetch_order_book(self, binance_symbol: str) -> Optional[dict]:
        """Fetch order book from Binance (10 levels)."""
        try:
            resp = requests.get(
                BINANCE_OB_URL,
                params={"symbol": binance_symbol, "limit": OB_DEPTH_LEVELS},
                timeout=5,
            )
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            logger.debug(f"OB fetch error {binance_symbol}: {e}")
        return None

    def _fetch_recent_trades(self, binance_symbol: str) -> Optional[list]:
        """Fetch recent trades from Binance."""
        try:
            resp = requests.get(
                BINANCE_TRADES_URL,
                params={"symbol": binance_symbol, "limit": 50},
                timeout=5,
            )
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            logger.debug(f"Trades fetch error {binance_symbol}: {e}")
        return None

    def _compute_ofi(self, symbol: str, current_ob: dict) -> np.ndarray:
        """Compute OFI at each of 10 depth levels.

        OFI_level = delta(bid_size) - delta(ask_size) at each level.
        Positive OFI = buy pressure increasing.
        """
        ofi = np.zeros(OB_DEPTH_LEVELS, dtype=np.float64)

        bids = current_ob.get("bids", [])[:OB_DEPTH_LEVELS]
        asks = current_ob.get("asks", [])[:OB_DEPTH_LEVELS]

        prev = self._prev_ob.get(symbol)
        if prev is None:
            # First snapshot - store and return zeros
            self._prev_ob[symbol] = {"bids": bids, "asks": asks}
            return ofi

        prev_bids = prev["bids"]
        prev_asks = prev["asks"]

        for i in range(min(OB_DEPTH_LEVELS, len(bids), len(prev_bids))):
            curr_bid_sz = float(bids[i][1]) if i < len(bids) else 0
            prev_bid_sz = float(prev_bids[i][1]) if i < len(prev_bids) else 0
            curr_ask_sz = float(asks[i][1]) if i < len(asks) else 0
            prev_ask_sz = float(prev_asks[i][1]) if i < len(prev_asks) else 0
            ofi[i] = (curr_bid_sz - prev_bid_sz) - (curr_ask_sz - prev_ask_sz)

        # Update prev state
        self._prev_ob[symbol] = {"bids": bids, "asks": asks}
        return ofi

    def _compute_trade_imbalance(self, symbol: str, trades: list) -> dict:
        """Classify trades as buyer/seller-initiated and compute imbalance."""
        buy_vol = 0.0
        sell_vol = 0.0
        for t in trades:
            qty = float(t.get("qty", 0))
            if t.get("isBuyerMaker", False):
                sell_vol += qty  # buyer maker = sell-initiated
            else:
                buy_vol += qty

        total = buy_vol + sell_vol
        imbalance = (buy_vol - sell_vol) / total if total > 0 else 0
        return {
            "buy_volume": round(buy_vol, 4),
            "sell_volume": round(sell_vol, 4),
            "imbalance": round(imbalance, 4),  # -1 to +1
            "total_volume": round(total, 4),
        }

    def _compute_spread_dynamics(self, ob: dict) -> dict:
        """Compute bid-ask spread and depth metrics."""
        bids = ob.get("bids", [])
        asks = ob.get("asks", [])

        if not bids or not asks:
            return {"spread_pct": 0, "bid_depth": 0, "ask_depth": 0, "depth_imbalance": 0}

        best_bid = float(bids[0][0])
        best_ask = float(asks[0][0])
        mid = (best_bid + best_ask) / 2
        spread_pct = (best_ask - best_bid) / mid * 100 if mid > 0 else 0

        bid_depth = sum(float(b[1]) for b in bids[:OB_DEPTH_LEVELS])
        ask_depth = sum(float(a[1]) for a in asks[:OB_DEPTH_LEVELS])
        total_depth = bid_depth + ask_depth
        depth_imbalance = (bid_depth - ask_depth) / total_depth if total_depth > 0 else 0

        return {
            "spread_pct": round(spread_pct, 6),
            "bid_depth": round(bid_depth, 4),
            "ask_depth": round(ask_depth, 4),
            "depth_imbalance": round(depth_imbalance, 4),
        }

    def update(self, symbol: str) -> Optional[dict]:
        """Fetch latest OB + trades and compute MLOFI features for a symbol.

        Returns dict with all MLOFI features or None on error.
        """
        now = time.time()
        cached = self._cache.get(symbol)
        if cached and now - cached[0] < self._cache_ttl:
            return cached[1]

        binance_sym = PAIR_TO_BINANCE.get(symbol)
        if not binance_sym:
            return None

        # Fetch order book
        ob = self._fetch_order_book(binance_sym)
        if not ob:
            return None

        # Compute OFI
        ofi_vector = self._compute_ofi(symbol, ob)

        # Store OFI history
        history = self._ofi_history[symbol]
        history.append(ofi_vector.copy())
        if len(history) > MAX_SNAPSHOTS:
            history.pop(0)

        # Compute rolling OFI (average over last N snapshots)
        rolling_ofi = np.mean(history[-10:], axis=0) if len(history) >= 2 else ofi_vector

        # Fetch recent trades
        trades_raw = self._fetch_recent_trades(binance_sym)
        trade_imb = {"buy_volume": 0, "sell_volume": 0, "imbalance": 0, "total_volume": 0}
        if trades_raw:
            trade_imb = self._compute_trade_imbalance(symbol, trades_raw)

        # Spread dynamics
        spread = self._compute_spread_dynamics(ob)

        # Aggregate OFI signal
        weighted_ofi = sum(ofi_vector[i] * (OB_DEPTH_LEVELS - i) for i in range(OB_DEPTH_LEVELS))
        ofi_signal = 1 if weighted_ofi > 0 else (-1 if weighted_ofi < 0 else 0)

        # Confidence from OFI magnitude
        ofi_magnitude = abs(weighted_ofi)
        # Normalize to 0-100 based on typical ranges (auto-calibrated)
        if len(history) >= 10:
            magnitudes = [abs(sum(h[i] * (OB_DEPTH_LEVELS - i) for i in range(OB_DEPTH_LEVELS))) for h in history[-30:]]
            max_mag = max(magnitudes) if magnitudes else 1
            ofi_confidence = min(100, int(ofi_magnitude / max_mag * 100)) if max_mag > 0 else 0
        else:
            ofi_confidence = min(100, int(ofi_magnitude * 10))

        result = {
            "symbol": symbol,
            "ofi_per_level": ofi_vector.tolist(),
            "rolling_ofi": rolling_ofi.tolist(),
            "weighted_ofi": round(float(weighted_ofi), 4),
            "ofi_signal": ofi_signal,  # -1, 0, 1
            "ofi_confidence": ofi_confidence,  # 0-100
            "trade_imbalance": trade_imb,
            "spread": spread,
            "snapshots": len(history),
            "timestamp": now,
        }

        self._cache[symbol] = (now, result)
        return result

    def get_features(self, symbol: str) -> np.ndarray:
        """Get MLOFI feature vector (20 features) for ML model input.

        Features:
        - ofi_level_0 through ofi_level_9 (10 features)
        - rolling_ofi_0 through rolling_ofi_4 (top 5 levels, 5 features)
        - weighted_ofi (1 feature)
        - trade_imbalance (1 feature)
        - spread_pct (1 feature)
        - depth_imbalance (1 feature)
        - ofi_confidence normalized (1 feature)
        Total: 20 features
        """
        data = self.update(symbol)
        if data is None:
            return np.zeros(20, dtype=np.float64)

        features = []

        # OFI per level (10)
        ofi = data["ofi_per_level"]
        for i in range(OB_DEPTH_LEVELS):
            features.append(ofi[i] if i < len(ofi) else 0)

        # Rolling OFI top 5 levels (5)
        rofi = data["rolling_ofi"]
        for i in range(5):
            features.append(rofi[i] if i < len(rofi) else 0)

        # Weighted OFI (1)
        features.append(data["weighted_ofi"])

        # Trade imbalance (1)
        features.append(data["trade_imbalance"]["imbalance"])

        # Spread pct (1)
        features.append(data["spread"]["spread_pct"])

        # Depth imbalance (1)
        features.append(data["spread"]["depth_imbalance"])

        # OFI confidence normalized (1)
        features.append(data["ofi_confidence"] / 100.0)

        return np.array(features, dtype=np.float64)

    def get_confidence_adjustment(self, symbol: str, proposed_direction: str) -> int:
        """Get confidence adjustment (-15 to +15) based on MLOFI alignment.

        If OFI aligns with proposed direction: positive boost.
        If OFI opposes: negative penalty.
        """
        data = self.update(symbol)
        if data is None or data["ofi_confidence"] < 10:
            return 0

        ofi_signal = data["ofi_signal"]
        confidence = data["ofi_confidence"]

        if proposed_direction == "BUY":
            if ofi_signal > 0:
                return min(15, int(confidence * 0.15))
            elif ofi_signal < 0:
                return max(-15, -int(confidence * 0.15))
        elif proposed_direction == "SELL":
            if ofi_signal < 0:
                return min(15, int(confidence * 0.15))
            elif ofi_signal > 0:
                return max(-15, -int(confidence * 0.15))

        return 0

    def get_all_symbols(self) -> Dict[str, dict]:
        """Get MLOFI data for all configured symbols."""
        results = {}
        for pair in PAIR_TO_BINANCE:
            data = self.update(pair)
            if data:
                results[pair] = data
        return results


# Module-level singleton
_mlofi_service: Optional[MLOFIService] = None


def get_mlofi_service() -> MLOFIService:
    global _mlofi_service
    if _mlofi_service is None:
        _mlofi_service = MLOFIService()
    return _mlofi_service
