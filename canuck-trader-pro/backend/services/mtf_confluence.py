"""
Multi-Timeframe Confluence Service

Fetches 5m, 15m, 1h candles and checks trend alignment across timeframes.
EMA direction + RSI agreement = confluence score (0-100).
Higher confluence → higher confidence adjustment.
"""

import logging
import time

import numpy as np
import pandas as pd
import ta

logger = logging.getLogger("mtf_confluence")

_cache: dict = {}  # symbol -> {data, timestamp}
CACHE_TTL = 30  # seconds


def _compute_tf_trend(df: pd.DataFrame) -> dict:
    """Compute trend indicators for a single timeframe."""
    if df is None or len(df) < 30:
        return {"trend": 0, "rsi": 50, "momentum": 0}

    close = df["close"]

    # EMA trend: +1 bullish, -1 bearish, 0 neutral
    ema20 = ta.trend.ema_indicator(close, window=20).iloc[-1]
    ema50 = ta.trend.ema_indicator(close, window=min(50, len(df) - 1)).iloc[-1]
    trend = 0
    if ema20 > ema50 * 1.001:
        trend = 1
    elif ema20 < ema50 * 0.999:
        trend = -1

    # RSI
    rsi = ta.momentum.rsi(close, window=14).iloc[-1]

    # Short-term momentum (5-period ROC)
    roc = ((close.iloc[-1] - close.iloc[-6]) / close.iloc[-6] * 100) if len(close) > 5 else 0

    return {"trend": trend, "rsi": rsi, "momentum": roc}


class MTFConfluence:
    """Multi-timeframe trend alignment analyzer."""

    def __init__(self, market_data=None):
        self.market = market_data

    def compute_alignment(self, symbol: str, df_5m: pd.DataFrame,
                          df_15m: pd.DataFrame = None, df_1h: pd.DataFrame = None) -> dict:
        """Compute MTF alignment score.

        Args:
            symbol: Trading pair
            df_5m: 5-minute candles (primary timeframe)
            df_15m: 15-minute candles (optional, will derive from 5m if None)
            df_1h: 1-hour candles (optional, will derive from 5m if None)

        Returns:
            {score: 0-100, direction: BUY/SELL/NEUTRAL, tf_details: {...}}
        """
        # Check cache
        cached = _cache.get(symbol)
        if cached and time.time() - cached["timestamp"] < CACHE_TTL:
            return cached["data"]

        # Compute 5m trend
        tf_5m = _compute_tf_trend(df_5m)

        # Derive 15m and 1h from 5m if not provided
        if df_15m is None and df_5m is not None and len(df_5m) >= 45:
            df_15m = self._resample(df_5m, 3)  # 3x 5m = 15m
        if df_1h is None and df_5m is not None and len(df_5m) >= 120:
            df_1h = self._resample(df_5m, 12)  # 12x 5m = 1h

        tf_15m = _compute_tf_trend(df_15m)
        tf_1h = _compute_tf_trend(df_1h)

        # Alignment scoring
        trends = [tf_5m["trend"], tf_15m["trend"], tf_1h["trend"]]
        rsis = [tf_5m["rsi"], tf_15m["rsi"], tf_1h["rsi"]]

        # Count bullish/bearish alignment
        bullish_count = sum(1 for t in trends if t > 0)
        bearish_count = sum(1 for t in trends if t < 0)

        # RSI alignment
        rsi_bullish = sum(1 for r in rsis if r > 50)
        rsi_bearish = sum(1 for r in rsis if r < 50)

        # Compute score (0-100)
        if bullish_count >= 2 or bearish_count >= 2:
            aligned_count = max(bullish_count, bearish_count)
            rsi_aligned = rsi_bullish if bullish_count > bearish_count else rsi_bearish
            # Base: 33 per aligned timeframe + 10 per RSI alignment
            score = aligned_count * 25 + rsi_aligned * 8
            direction = "BUY" if bullish_count > bearish_count else "SELL"
        else:
            score = 20  # mixed / neutral
            direction = "NEUTRAL"

        score = min(100, max(0, score))

        result = {
            "score": round(score),
            "direction": direction,
            "bullish_tfs": bullish_count,
            "bearish_tfs": bearish_count,
            "tf_details": {
                "5m": tf_5m,
                "15m": tf_15m,
                "1h": tf_1h,
            },
        }

        _cache[symbol] = {"data": result, "timestamp": time.time()}
        return result

    def get_confidence_adjustment(self, symbol: str, action: str, df_5m: pd.DataFrame) -> int:
        """Get confidence adjustment based on MTF alignment.

        Returns: -15 to +15 adjustment.
        """
        alignment = self.compute_alignment(symbol, df_5m)
        score = alignment["score"]
        direction = alignment["direction"]

        # If action matches MTF direction, boost
        if direction == action:
            if score >= 80:
                return 15
            elif score >= 60:
                return 10
            elif score >= 40:
                return 5
            return 0
        elif direction == "NEUTRAL":
            return 0
        else:
            # Action opposes MTF direction, penalize
            if score >= 80:
                return -15
            elif score >= 60:
                return -10
            elif score >= 40:
                return -5
            return 0

    def _resample(self, df: pd.DataFrame, factor: int) -> pd.DataFrame:
        """Resample 5m candles to a higher timeframe by grouping rows."""
        n = len(df)
        rows = n // factor * factor  # trim to multiple of factor
        if rows < factor * 10:
            return None

        df_trim = df.iloc[-rows:].copy()
        groups = np.arange(len(df_trim)) // factor

        resampled = pd.DataFrame({
            "open": df_trim.groupby(groups)["open"].first().values,
            "high": df_trim.groupby(groups)["high"].max().values,
            "low": df_trim.groupby(groups)["low"].min().values,
            "close": df_trim.groupby(groups)["close"].last().values,
            "volume": df_trim.groupby(groups)["volume"].sum().values if "volume" in df_trim.columns else np.zeros(rows // factor),
        })
        return resampled


_instance: MTFConfluence = None


def get_mtf_confluence(market_data=None) -> MTFConfluence:
    global _instance
    if _instance is None:
        _instance = MTFConfluence(market_data)
    return _instance
