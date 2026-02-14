"""
Anomaly Detector - Isolation Forest for unusual market conditions.

Detects anomalous market states that may represent high-conviction entry opportunities:
- Extreme volume + directional move = institutional activity
- Unusual price-volume divergence = accumulation/distribution
- Abnormal volatility regime change = breakout incoming
"""

import logging
import time
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

logger = logging.getLogger("anomaly_detector")

_cache: dict = {}
CACHE_TTL = 30


class AnomalyDetector:
    """Detects unusual market conditions using Isolation Forest."""

    def __init__(self):
        self._models: dict = {}  # symbol -> fitted IsolationForest
        self._last_train: dict = {}  # symbol -> timestamp
        self.RETRAIN_INTERVAL = 300  # retrain every 5 minutes

    def detect(self, symbol: str, df: pd.DataFrame) -> dict:
        """Detect if current market state is anomalous.

        Returns: {is_anomalous: bool, anomaly_score: float, direction: str, confidence_adjustment: int}
        """
        cached = _cache.get(symbol)
        if cached and time.time() - cached["ts"] < CACHE_TTL:
            return cached["data"]

        if df is None or len(df) < 50:
            return {"is_anomalous": False, "anomaly_score": 0, "direction": "NEUTRAL", "confidence_adjustment": 0}

        # Build feature matrix from recent candles
        features = self._build_anomaly_features(df)
        if features is None or len(features) < 30:
            return {"is_anomalous": False, "anomaly_score": 0, "direction": "NEUTRAL", "confidence_adjustment": 0}

        # Train or retrain model
        last_train = self._last_train.get(symbol, 0)
        if symbol not in self._models or time.time() - last_train > self.RETRAIN_INTERVAL:
            self._train(symbol, features[:-1])  # train on all but last (current) candle

        model = self._models.get(symbol)
        if model is None:
            return {"is_anomalous": False, "anomaly_score": 0, "direction": "NEUTRAL", "confidence_adjustment": 0}

        # Score the current candle
        current = features[-1:].reshape(1, -1)
        score = model.decision_function(current)[0]  # negative = more anomalous
        prediction = model.predict(current)[0]  # -1 = anomaly, 1 = normal

        is_anomalous = prediction == -1

        # Determine direction of anomaly
        close = df["close"]
        ret_5 = (close.iloc[-1] - close.iloc[-6]) / close.iloc[-6] if len(close) > 5 else 0
        vol_ratio = df["volume"].iloc[-1] / df["volume"].rolling(20).mean().iloc[-1] if len(df) >= 20 and df["volume"].rolling(20).mean().iloc[-1] > 0 else 1.0

        direction = "NEUTRAL"
        if is_anomalous:
            if ret_5 > 0.005 and vol_ratio > 1.5:
                direction = "BUY"
            elif ret_5 < -0.005 and vol_ratio > 1.5:
                direction = "SELL"

        # Confidence adjustment
        adj = 0
        if is_anomalous and direction != "NEUTRAL":
            # Stronger anomaly = larger adjustment
            adj = min(10, max(0, int(-score * 5)))  # score is negative for anomalies

        result = {
            "is_anomalous": bool(is_anomalous),
            "anomaly_score": round(float(score), 4),
            "direction": direction,
            "confidence_adjustment": adj,
            "vol_ratio": round(float(vol_ratio), 2),
            "ret_5": round(float(ret_5 * 100), 3),
        }

        _cache[symbol] = {"data": result, "ts": time.time()}
        return result

    def get_confidence_adjustment(self, symbol: str, action: str, df: pd.DataFrame) -> int:
        """Get confidence adjustment based on anomaly detection.

        Boosts if anomaly direction matches trade action.
        """
        result = self.detect(symbol, df)
        if not result["is_anomalous"]:
            return 0
        if result["direction"] == action:
            return result["confidence_adjustment"]
        elif result["direction"] != "NEUTRAL":
            return -result["confidence_adjustment"]  # penalize opposing
        return 0

    def _build_anomaly_features(self, df: pd.DataFrame) -> Optional[np.ndarray]:
        """Build per-candle feature matrix for anomaly detection."""
        close = df["close"].values
        volume = df["volume"].values
        high = df["high"].values
        low = df["low"].values

        n = len(df)
        if n < 30:
            return None

        features = []
        for i in range(20, n):
            # Returns
            ret_1 = (close[i] - close[i-1]) / close[i-1] if close[i-1] > 0 else 0
            ret_5 = (close[i] - close[i-5]) / close[i-5] if close[i-5] > 0 else 0

            # Volatility
            window = close[i-20:i]
            std = np.std(window) / np.mean(window) if np.mean(window) > 0 else 0

            # Volume ratio
            vol_mean = np.mean(volume[i-20:i])
            vol_ratio = volume[i] / vol_mean if vol_mean > 0 else 1.0

            # Price range
            candle_range = (high[i] - low[i]) / close[i] if close[i] > 0 else 0

            # Body ratio
            body = abs(close[i] - close[max(0, i-1)])
            total_range = high[i] - low[i]
            body_ratio = body / total_range if total_range > 0 else 0

            features.append([ret_1, ret_5, std, vol_ratio, candle_range, body_ratio])

        return np.array(features)

    def _train(self, symbol: str, features: np.ndarray):
        """Train Isolation Forest on historical feature matrix."""
        if len(features) < 20:
            return

        model = IsolationForest(
            n_estimators=100,
            contamination=0.05,  # expect 5% anomalies
            random_state=42,
            n_jobs=-1,
        )
        model.fit(features)
        self._models[symbol] = model
        self._last_train[symbol] = time.time()


_instance: Optional[AnomalyDetector] = None


def get_anomaly_detector() -> AnomalyDetector:
    global _instance
    if _instance is None:
        _instance = AnomalyDetector()
    return _instance
