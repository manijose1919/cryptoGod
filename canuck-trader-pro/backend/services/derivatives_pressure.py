"""
Derivatives Pressure Composite Score

Combines multiple derivatives signals into a single directional pressure score:
1. Funding rate bias (from OKX)
2. Open interest change trend
3. Liquidation proximity (from liquidation_service)
4. MLOFI order flow (from mlofi_service)

Score: -100 (extreme bearish pressure) to +100 (extreme bullish pressure)
"""
import logging
import time
from collections import defaultdict
from typing import Dict, Optional, Tuple

import numpy as np
import requests

logger = logging.getLogger(__name__)

# OKX public APIs
OKX_FUNDING_URL = "https://www.okx.com/api/v5/public/funding-rate"
OKX_OI_URL = "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume"

PAIR_TO_OKX = {
    "BTC/USD": "BTC-USDT-SWAP", "ETH/USD": "ETH-USDT-SWAP",
    "XRP/USD": "XRP-USDT-SWAP", "SOL/USD": "SOL-USDT-SWAP",
    "ADA/USD": "ADA-USDT-SWAP", "DOGE/USD": "DOGE-USDT-SWAP",
    "LINK/USD": "LINK-USDT-SWAP", "DOT/USD": "DOT-USDT-SWAP",
    "AVAX/USD": "AVAX-USDT-SWAP",
}

# Component weights in composite score
WEIGHTS = {
    "funding": 0.25,       # Funding rate direction
    "oi_change": 0.20,     # OI trend
    "liquidation": 0.25,   # Liquidation proximity
    "mlofi": 0.30,         # Order flow imbalance
}


class DerivativesPressure:
    """Computes a composite derivatives pressure score."""

    def __init__(self):
        self._cache: Dict[str, Tuple[float, dict]] = {}
        self._cache_ttl = 15  # seconds
        self._oi_history: Dict[str, list] = defaultdict(list)
        logger.info("Derivatives pressure service initialized")

    def _fetch_funding_rate(self, okx_inst: str) -> Optional[float]:
        """Fetch funding rate from OKX."""
        try:
            resp = requests.get(OKX_FUNDING_URL, params={"instId": okx_inst}, timeout=5)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data:
                    return float(data[0].get("fundingRate", 0))
        except Exception as e:
            logger.debug(f"Funding rate error: {e}")
        return None

    def _fetch_oi(self, okx_inst: str) -> Optional[float]:
        """Fetch open interest from OKX."""
        try:
            # Use the coin name from instrument
            coin = okx_inst.split("-")[0]
            resp = requests.get(
                OKX_OI_URL,
                params={"ccy": coin, "period": "5m"},
                timeout=5,
            )
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data:
                    return float(data[0][1])  # openInterest field
        except Exception as e:
            logger.debug(f"OI fetch error: {e}")
        return None

    def _funding_score(self, rate: Optional[float]) -> float:
        """Convert funding rate to directional score (-100 to 100).

        Positive funding = longs pay shorts = crowded long = bearish pressure
        Negative funding = shorts pay longs = crowded short = bullish pressure
        """
        if rate is None:
            return 0.0
        # Funding rates typically range from -0.01% to +0.03%
        # Normalize to -100..100 scale
        score = -rate * 100000  # invert: positive funding = bearish
        return max(-100, min(100, score))

    def _oi_change_score(self, symbol: str, current_oi: Optional[float]) -> float:
        """Score OI change trend (-100 to 100).

        Rising OI + rising price = bullish conviction
        Rising OI + falling price = bearish conviction
        Falling OI = positions closing, trend weakening
        """
        if current_oi is None:
            return 0.0

        history = self._oi_history[symbol]
        history.append(current_oi)
        if len(history) > 20:
            history.pop(0)

        if len(history) < 3:
            return 0.0

        # OI change rate over last few snapshots
        recent = np.array(history[-5:])
        if recent[0] == 0:
            return 0.0

        change_pct = (recent[-1] - recent[0]) / recent[0] * 100
        # Normalize: +-5% change -> +-100 score
        return max(-100, min(100, change_pct * 20))

    def _liquidation_score(self, symbol: str) -> float:
        """Get liquidation proximity score from liquidation service."""
        try:
            from services.liquidation_service import get_liquidation_service
            svc = get_liquidation_service()
            data = svc.update(symbol)
            if data and data["magnet_signal"]["strength"] > 0:
                magnet = data["magnet_signal"]
                if magnet["signal"] == "BULLISH":
                    return magnet["strength"]  # short squeeze -> bullish
                elif magnet["signal"] == "BEARISH":
                    return -magnet["strength"]  # long cascade -> bearish
        except Exception:
            pass
        return 0.0

    def _mlofi_score(self, symbol: str) -> float:
        """Get MLOFI order flow score."""
        try:
            from services.mlofi_service import get_mlofi_service
            svc = get_mlofi_service()
            data = svc.update(symbol)
            if data:
                # weighted_ofi direction * confidence
                direction = data["ofi_signal"]  # -1, 0, 1
                confidence = data["ofi_confidence"]  # 0-100
                return direction * confidence
        except Exception:
            pass
        return 0.0

    def compute(self, symbol: str) -> dict:
        """Compute the composite derivatives pressure score.

        Returns dict with composite score and component breakdown.
        """
        now = time.time()
        cached = self._cache.get(symbol)
        if cached and now - cached[0] < self._cache_ttl:
            return cached[1]

        okx_inst = PAIR_TO_OKX.get(symbol)

        # Compute each component
        funding_rate = self._fetch_funding_rate(okx_inst) if okx_inst else None
        oi = self._fetch_oi(okx_inst) if okx_inst else None

        components = {
            "funding": self._funding_score(funding_rate),
            "oi_change": self._oi_change_score(symbol, oi),
            "liquidation": self._liquidation_score(symbol),
            "mlofi": self._mlofi_score(symbol),
        }

        # Weighted composite
        composite = sum(components[k] * WEIGHTS[k] for k in WEIGHTS)
        composite = max(-100, min(100, composite))

        # Direction and strength
        if composite > 10:
            direction = "BULLISH"
        elif composite < -10:
            direction = "BEARISH"
        else:
            direction = "NEUTRAL"

        result = {
            "symbol": symbol,
            "composite_score": round(composite, 1),
            "direction": direction,
            "strength": round(abs(composite), 1),
            "components": {k: round(v, 1) for k, v in components.items()},
            "weights": WEIGHTS,
            "funding_rate": funding_rate,
            "open_interest": oi,
            "timestamp": now,
        }

        self._cache[symbol] = (now, result)
        return result

    def get_confidence_adjustment(self, symbol: str, proposed_direction: str) -> int:
        """Get confidence adjustment (-10 to +10) based on derivatives pressure.

        Aligns proposed trade direction with derivatives pressure.
        """
        data = self.compute(symbol)
        score = data["composite_score"]

        if abs(score) < 15:
            return 0

        # Scale to -10..+10
        adjustment = int(score / 10)

        if proposed_direction == "BUY":
            return max(-10, min(10, adjustment))
        elif proposed_direction == "SELL":
            return max(-10, min(10, -adjustment))
        return 0


# Module-level singleton
_derivatives_pressure: Optional[DerivativesPressure] = None


def get_derivatives_pressure() -> DerivativesPressure:
    global _derivatives_pressure
    if _derivatives_pressure is None:
        _derivatives_pressure = DerivativesPressure()
    return _derivatives_pressure
