"""
Market Regime Detection using Gaussian Mixture Models

Detects market regimes from price returns and volatility observations:
1. TRENDING_UP - Strong upward momentum, low-moderate volatility
2. TRENDING_DOWN - Strong downward momentum, low-moderate volatility
3. RANGING - Low momentum, low volatility (mean-reverting)
4. VOLATILE - High volatility, uncertain direction

Uses sklearn GaussianMixture (equivalent to HMM for regime detection
when applied to return/volatility feature space).

Strategy mapping:
- TRENDING_UP → TREND, MOMENTUM, BREAKOUT
- TRENDING_DOWN → REVERSAL, MEAN_REVERSION, SELL signals
- RANGING → MEAN_REVERSION, RANGE, grid trading
- VOLATILE → reduce position size, wider stops, ADAPTIVE
"""
import logging
import time
from collections import defaultdict
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.mixture import GaussianMixture

logger = logging.getLogger(__name__)

# Regime names ordered by typical GMM cluster assignment
# Will be re-mapped based on cluster characteristics
REGIMES = ["TRENDING_UP", "TRENDING_DOWN", "RANGING", "VOLATILE"]

# Strategy recommendations per regime
REGIME_STRATEGIES = {
    "TRENDING_UP": {
        "enabled": ["EMA_CROSSOVER", "TRIPLE_EMA", "MACD", "ADX_TREND", "SUPERTREND",
                     "MOMENTUM_ROC", "ICHIMOKU", "VWAP"],
        "position_mult": 1.2,
        "confidence_bonus": 5,
    },
    "TRENDING_DOWN": {
        "enabled": ["RSI", "STOCH_RSI", "WILLIAMS_R", "CCI", "MEAN_REVERT",
                     "BOLLINGER", "ENGULFING"],
        "position_mult": 0.8,
        "confidence_bonus": 0,
    },
    "RANGING": {
        "enabled": ["BOLLINGER", "KELTNER", "MEAN_REVERT", "PIVOT_POINTS",
                     "RSI", "STOCH_RSI", "CCI", "DONCHIAN"],
        "position_mult": 1.0,
        "confidence_bonus": 0,
    },
    "VOLATILE": {
        "enabled": ["VOL_SQUEEZE", "VOL_SPIKE",
                     "DONCHIAN", "KELTNER", "ENGULFING"],
        "position_mult": 0.5,
        "confidence_bonus": -5,
    },
}


class RegimeDetector:
    """Detects market regime using Gaussian Mixture Model on returns + volatility."""

    def __init__(self, n_regimes: int = 4, lookback: int = 100):
        self.n_regimes = n_regimes
        self.lookback = lookback
        self._model: Optional[GaussianMixture] = None
        self._regime_map: Dict[int, str] = {}  # cluster_id -> regime name
        self._cache: Dict[str, Tuple[float, dict]] = {}
        self._cache_ttl = 30
        self._history: Dict[str, list] = defaultdict(list)
        logger.info(f"Regime detector initialized ({n_regimes} regimes)")

    def _extract_features(self, df: pd.DataFrame) -> np.ndarray:
        """Extract return and volatility features for regime detection.

        Features per observation:
        1. 5-period return
        2. 20-period return
        3. 5-period realized volatility (std of returns)
        4. 20-period realized volatility
        5. Return acceleration (ret_5 - ret_20)
        """
        close = df["close"].values
        n = len(close)
        if n < 25:
            return np.array([]).reshape(0, 5)

        features = []
        for i in range(20, n):
            ret_5 = (close[i] - close[i - 5]) / close[i - 5] if close[i - 5] > 0 else 0
            ret_20 = (close[i] - close[i - 20]) / close[i - 20] if close[i - 20] > 0 else 0

            # Realized vol
            returns_5 = np.diff(close[i - 5:i + 1]) / close[i - 5:i]
            returns_20 = np.diff(close[i - 20:i + 1]) / close[i - 20:i]
            vol_5 = np.std(returns_5) if len(returns_5) > 1 else 0
            vol_20 = np.std(returns_20) if len(returns_20) > 1 else 0

            acceleration = ret_5 - ret_20

            features.append([ret_5, ret_20, vol_5, vol_20, acceleration])

        return np.array(features)

    def _map_clusters_to_regimes(self, model: GaussianMixture, X: np.ndarray) -> Dict[int, str]:
        """Map GMM cluster IDs to human-readable regime names based on cluster means."""
        means = model.means_  # shape: (n_clusters, n_features)
        # Features: [ret_5, ret_20, vol_5, vol_20, acceleration]

        # Sort clusters by characteristics
        cluster_info = []
        for i in range(len(means)):
            cluster_info.append({
                "id": i,
                "avg_return": (means[i][0] + means[i][1]) / 2,
                "avg_vol": (means[i][2] + means[i][3]) / 2,
            })

        mapping = {}

        # Highest vol cluster = VOLATILE
        vol_sorted = sorted(cluster_info, key=lambda c: c["avg_vol"], reverse=True)
        mapping[vol_sorted[0]["id"]] = "VOLATILE"

        # Among remaining: highest return = TRENDING_UP
        remaining = [c for c in cluster_info if c["id"] != vol_sorted[0]["id"]]
        ret_sorted = sorted(remaining, key=lambda c: c["avg_return"], reverse=True)

        if len(ret_sorted) >= 1:
            mapping[ret_sorted[0]["id"]] = "TRENDING_UP"
        if len(ret_sorted) >= 2:
            mapping[ret_sorted[-1]["id"]] = "TRENDING_DOWN"
        if len(ret_sorted) >= 3:
            mapping[ret_sorted[1]["id"]] = "RANGING"

        # Fill any unmapped
        for i in range(self.n_regimes):
            if i not in mapping:
                mapping[i] = "RANGING"

        return mapping

    def detect(self, symbol: str, df: pd.DataFrame) -> dict:
        """Detect current market regime for a symbol.

        Returns: {regime, confidence, regime_probs, history, strategy_rec}
        """
        now = time.time()
        cached = self._cache.get(symbol)
        if cached and now - cached[0] < self._cache_ttl:
            return cached[1]

        X = self._extract_features(df)
        if len(X) < 30:
            result = {
                "symbol": symbol,
                "regime": "RANGING",
                "confidence": 0,
                "regime_probs": {},
                "strategy_rec": REGIME_STRATEGIES["RANGING"],
                "sufficient_data": False,
            }
            self._cache[symbol] = (now, result)
            return result

        # Fit GMM
        n_components = min(self.n_regimes, len(X) // 10)
        n_components = max(2, n_components)

        try:
            model = GaussianMixture(
                n_components=n_components,
                covariance_type="full",
                n_init=3,
                random_state=42,
            )
            model.fit(X)
            self._model = model
            self._regime_map = self._map_clusters_to_regimes(model, X)
        except Exception as e:
            logger.warning(f"GMM fit failed: {e}")
            result = {
                "symbol": symbol,
                "regime": "RANGING",
                "confidence": 0,
                "regime_probs": {},
                "strategy_rec": REGIME_STRATEGIES["RANGING"],
                "sufficient_data": False,
            }
            self._cache[symbol] = (now, result)
            return result

        # Predict regime for most recent observation
        latest = X[-1:].reshape(1, -1)
        probs = model.predict_proba(latest)[0]
        pred_cluster = np.argmax(probs)
        regime = self._regime_map.get(pred_cluster, "RANGING")
        confidence = float(probs[pred_cluster]) * 100

        # Build probability dict
        regime_probs = {}
        for cluster_id, prob in enumerate(probs):
            regime_name = self._regime_map.get(cluster_id, f"CLUSTER_{cluster_id}")
            regime_probs[regime_name] = round(float(prob) * 100, 1)

        # Track history
        history = self._history[symbol]
        history.append({"regime": regime, "confidence": round(confidence, 1), "ts": now})
        if len(history) > 50:
            history.pop(0)

        # Regime stability (how long we've been in this regime)
        streak = 0
        for h in reversed(history):
            if h["regime"] == regime:
                streak += 1
            else:
                break

        result = {
            "symbol": symbol,
            "regime": regime,
            "confidence": round(confidence, 1),
            "regime_probs": regime_probs,
            "strategy_rec": REGIME_STRATEGIES.get(regime, REGIME_STRATEGIES["RANGING"]),
            "streak": streak,
            "sufficient_data": True,
            "features": {
                "ret_5": round(float(X[-1][0]) * 100, 3),
                "ret_20": round(float(X[-1][1]) * 100, 3),
                "vol_5": round(float(X[-1][2]) * 100, 3),
                "vol_20": round(float(X[-1][3]) * 100, 3),
            },
            "timestamp": now,
        }

        self._cache[symbol] = (now, result)
        return result

    def get_confidence_adjustment(self, symbol: str, df: pd.DataFrame, strategy_name: str, proposed_direction: str) -> int:
        """Adjust confidence based on whether strategy fits current regime.

        +5 if strategy is recommended for this regime
        -5 if strategy is not recommended
        """
        data = self.detect(symbol, df)
        if not data["sufficient_data"]:
            return 0

        rec = data["strategy_rec"]
        enabled = rec.get("enabled", [])
        bonus = rec.get("confidence_bonus", 0)

        if strategy_name in enabled:
            return max(0, 5 + bonus)
        return min(0, -5 + bonus)

    def get_position_multiplier(self, symbol: str, df: pd.DataFrame) -> float:
        """Get position size multiplier based on current regime."""
        data = self.detect(symbol, df)
        return data["strategy_rec"].get("position_mult", 1.0)


# Module-level singleton
_detector: Optional[RegimeDetector] = None


def get_regime_detector() -> RegimeDetector:
    global _detector
    if _detector is None:
        _detector = RegimeDetector()
    return _detector
