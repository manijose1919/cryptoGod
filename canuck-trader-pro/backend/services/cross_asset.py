"""
Cross-Asset Correlation Features

Adds inter-market signals to the ML feature vector:
1. BTC correlation - how correlated is this asset with BTC?
2. BTC-relative momentum - is this asset diverging from BTC?
3. Sector rotation - are altcoins leading or lagging BTC?
4. Cross-pair momentum divergence

These features catch "BTC dumps but ETH holds" or "altcoin season starting" patterns.
"""
import logging
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests

logger = logging.getLogger(__name__)

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"

SYMBOLS = {
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


class CrossAssetAnalyzer:
    """Computes cross-asset features for ML model input."""

    def __init__(self):
        self._price_cache: Dict[str, Tuple[float, list]] = {}  # symbol -> (ts, prices)
        self._cache_ttl = 60  # 1 minute
        logger.info("Cross-asset analyzer initialized")

    def _fetch_recent_closes(self, binance_symbol: str, n: int = 100) -> Optional[list]:
        """Fetch recent close prices from Binance."""
        cached = self._price_cache.get(binance_symbol)
        if cached and time.time() - cached[0] < self._cache_ttl:
            return cached[1]

        try:
            resp = requests.get(
                BINANCE_KLINES_URL,
                params={"symbol": binance_symbol, "interval": "5m", "limit": n},
                timeout=5,
            )
            if resp.status_code == 200:
                closes = [float(k[4]) for k in resp.json()]
                self._price_cache[binance_symbol] = (time.time(), closes)
                return closes
        except Exception as e:
            logger.debug(f"Cross-asset fetch error {binance_symbol}: {e}")
        return None

    def compute_btc_correlation(self, symbol: str, lookback: int = 50) -> float:
        """Compute rolling Pearson correlation with BTC.

        Returns correlation coefficient (-1 to 1).
        """
        if symbol == "BTC/USD":
            return 1.0

        btc_prices = self._fetch_recent_closes("BTCUSDT")
        sym_binance = SYMBOLS.get(symbol)
        if not sym_binance:
            return 0.0

        sym_prices = self._fetch_recent_closes(sym_binance)
        if not btc_prices or not sym_prices:
            return 0.0

        n = min(len(btc_prices), len(sym_prices), lookback)
        if n < 10:
            return 0.0

        btc_ret = np.diff(np.log(btc_prices[-n:])) if all(p > 0 for p in btc_prices[-n:]) else np.zeros(n - 1)
        sym_ret = np.diff(np.log(sym_prices[-n:])) if all(p > 0 for p in sym_prices[-n:]) else np.zeros(n - 1)

        if len(btc_ret) < 2 or np.std(btc_ret) == 0 or np.std(sym_ret) == 0:
            return 0.0

        return float(np.corrcoef(btc_ret, sym_ret)[0, 1])

    def compute_btc_relative_momentum(self, symbol: str, lookback: int = 20) -> float:
        """Compute momentum of this asset relative to BTC.

        Positive = outperforming BTC, Negative = underperforming.
        """
        if symbol == "BTC/USD":
            return 0.0

        btc_prices = self._fetch_recent_closes("BTCUSDT")
        sym_binance = SYMBOLS.get(symbol)
        if not sym_binance:
            return 0.0

        sym_prices = self._fetch_recent_closes(sym_binance)
        if not btc_prices or not sym_prices:
            return 0.0

        n = min(len(btc_prices), len(sym_prices), lookback + 1)
        if n < 5:
            return 0.0

        btc_ret = (btc_prices[-1] - btc_prices[-n]) / btc_prices[-n] if btc_prices[-n] > 0 else 0
        sym_ret = (sym_prices[-1] - sym_prices[-n]) / sym_prices[-n] if sym_prices[-n] > 0 else 0

        return sym_ret - btc_ret  # relative outperformance

    def compute_altcoin_rotation(self) -> float:
        """Compute altcoin season indicator.

        Positive = altcoins outperforming BTC (alt season)
        Negative = BTC outperforming altcoins (BTC dominance)
        Returns score from -1 to 1.
        """
        btc_prices = self._fetch_recent_closes("BTCUSDT")
        if not btc_prices or len(btc_prices) < 20:
            return 0.0

        btc_ret = (btc_prices[-1] - btc_prices[-20]) / btc_prices[-20] if btc_prices[-20] > 0 else 0

        alt_rets = []
        for sym, bsym in SYMBOLS.items():
            if sym == "BTC/USD":
                continue
            prices = self._fetch_recent_closes(bsym)
            if prices and len(prices) >= 20 and prices[-20] > 0:
                ret = (prices[-1] - prices[-20]) / prices[-20]
                alt_rets.append(ret)

        if not alt_rets:
            return 0.0

        avg_alt_ret = np.mean(alt_rets)
        # Normalize: positive = alt season
        diff = avg_alt_ret - btc_ret
        return max(-1, min(1, diff * 20))  # scale for sensitivity

    def compute_cross_momentum_divergence(self, symbol: str) -> float:
        """Detect when an asset's momentum diverges from the sector.

        Large positive = outperforming peers (potential reversion)
        Large negative = underperforming peers
        """
        sym_binance = SYMBOLS.get(symbol)
        if not sym_binance:
            return 0.0

        sym_prices = self._fetch_recent_closes(sym_binance)
        if not sym_prices or len(sym_prices) < 20 or sym_prices[-20] <= 0:
            return 0.0

        sym_ret = (sym_prices[-1] - sym_prices[-20]) / sym_prices[-20]

        peer_rets = []
        for s, bs in SYMBOLS.items():
            if s == symbol:
                continue
            prices = self._fetch_recent_closes(bs)
            if prices and len(prices) >= 20 and prices[-20] > 0:
                peer_rets.append((prices[-1] - prices[-20]) / prices[-20])

        if not peer_rets:
            return 0.0

        avg_peer = np.mean(peer_rets)
        std_peer = np.std(peer_rets) if len(peer_rets) > 1 else 0.01

        # Z-score of this asset vs peers
        if std_peer > 0:
            return max(-3, min(3, (sym_ret - avg_peer) / std_peer))
        return 0.0

    def get_features(self, symbol: str) -> np.ndarray:
        """Get cross-asset feature vector (5 features) for ML model.

        Features:
        1. BTC correlation (0-1)
        2. BTC relative momentum (-1 to 1)
        3. Altcoin rotation (-1 to 1)
        4. Cross-momentum divergence (z-score)
        5. Correlation change (current - lagged, detects correlation breakdown)
        """
        btc_corr = self.compute_btc_correlation(symbol)
        btc_rel_mom = self.compute_btc_relative_momentum(symbol)
        alt_rotation = self.compute_altcoin_rotation()
        divergence = self.compute_cross_momentum_divergence(symbol)
        # Correlation change: compare 50-bar vs 20-bar correlation
        corr_50 = self.compute_btc_correlation(symbol, lookback=50)
        corr_20 = self.compute_btc_correlation(symbol, lookback=20)
        corr_change = corr_20 - corr_50

        return np.array([btc_corr, btc_rel_mom, alt_rotation, divergence, corr_change], dtype=np.float64)

    def get_full_analysis(self, symbol: str) -> dict:
        """Full cross-asset analysis for API/dashboard."""
        features = self.get_features(symbol)
        return {
            "symbol": symbol,
            "btc_correlation": round(float(features[0]), 4),
            "btc_relative_momentum": round(float(features[1]), 4),
            "altcoin_rotation": round(float(features[2]), 4),
            "cross_momentum_divergence": round(float(features[3]), 4),
            "correlation_change": round(float(features[4]), 4),
            "interpretation": self._interpret(features),
        }

    def _interpret(self, features: np.ndarray) -> str:
        corr, rel_mom, alt_rot, div, corr_chg = features
        parts = []
        if corr > 0.8:
            parts.append("High BTC correlation")
        elif corr < 0.3:
            parts.append("Low BTC correlation (independent)")
        if rel_mom > 0.02:
            parts.append("Outperforming BTC")
        elif rel_mom < -0.02:
            parts.append("Underperforming BTC")
        if alt_rot > 0.3:
            parts.append("Alt season signal")
        elif alt_rot < -0.3:
            parts.append("BTC dominance")
        if abs(div) > 1.5:
            parts.append(f"Diverging from peers (z={div:.1f})")
        if abs(corr_chg) > 0.2:
            parts.append("Correlation breakdown detected")
        return "; ".join(parts) if parts else "Normal cross-asset behavior"


# Module-level singleton
_analyzer: Optional[CrossAssetAnalyzer] = None


def get_cross_asset_analyzer() -> CrossAssetAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = CrossAssetAnalyzer()
    return _analyzer
