"""
Feature Engineer
Converts raw strategy signals + OHLCV data into ML-ready feature vectors.
"""
import numpy as np
import pandas as pd
import ta


SIGNAL_MAP = {"BUY": 1.0, "HOLD": 0.0, "SELL": -1.0}

# Canonical strategy order (must match ALL_STRATEGIES in strategy_engine.py)
STRATEGY_NAMES = [
    "EMA_CROSSOVER", "TRIPLE_EMA", "MACD", "ADX_TREND", "SUPERTREND",
    "RSI", "STOCH_RSI", "WILLIAMS_R", "CCI", "MOMENTUM_ROC",
    "BOLLINGER", "KELTNER", "ATR_BREAKOUT", "DONCHIAN", "VOL_SQUEEZE",
    "VWAP", "OBV", "VOL_SPIKE",
    "MEAN_REVERT", "ICHIMOKU", "PIVOT_POINTS", "ENGULFING",
    "RSI_DIVERGENCE", "MACD_DIVERGENCE", "MULTI_CONSENSUS",
]


def signals_to_features(signals: list[dict]) -> np.ndarray:
    """Convert 25 strategy signal dicts into a flat feature vector.

    Per strategy: [direction (-1/0/1), confidence (0-1)]
    Total: 50 features from strategies.
    """
    features = []
    # Build lookup by name
    sig_map = {s["name"]: s for s in signals}

    for name in STRATEGY_NAMES:
        sig = sig_map.get(name, {"signal": "HOLD", "confidence": 0})
        direction = SIGNAL_MAP.get(sig["signal"], 0.0)
        confidence = float(sig.get("confidence", 0)) / 100.0
        features.extend([direction, confidence])

    return np.array(features, dtype=np.float64)


def market_features(df: pd.DataFrame) -> np.ndarray:
    """Extract market features from OHLCV DataFrame.

    Features (20):
    - Returns: 1, 3, 5, 10, 20 candle lookback
    - Volatility: ATR(14) normalized, rolling std(20)
    - Volume: current/SMA(20) ratio, volume trend (5-period change)
    - RSI(14)
    - MACD histogram
    - Bollinger %B (position within bands)
    - Price vs EMA(20) distance %
    - Price vs EMA(50) distance %
    - Candle body ratio (|close-open| / (high-low))
    - Upper wick ratio
    - Lower wick ratio
    - Hour-of-day sin/cos (cyclical encoding)
    - Consecutive green/red candles count
    """
    close = df["close"]
    high = df["high"]
    low = df["low"]
    opn = df["open"]
    volume = df["volume"]
    n = len(df)

    features = []

    # Returns at various lookbacks
    for lb in [1, 3, 5, 10, 20]:
        if n > lb:
            ret = (close.iloc[-1] - close.iloc[-1 - lb]) / close.iloc[-1 - lb]
        else:
            ret = 0.0
        features.append(ret)

    # ATR normalized by price
    if n >= 15:
        atr = ta.volatility.AverageTrueRange(high, low, close, window=14).average_true_range().iloc[-1]
        features.append(atr / close.iloc[-1] if close.iloc[-1] else 0)
    else:
        features.append(0.0)

    # Rolling std normalized
    if n >= 20:
        std = close.rolling(20).std().iloc[-1]
        features.append(std / close.iloc[-1] if close.iloc[-1] else 0)
    else:
        features.append(0.0)

    # Volume ratio
    if n >= 20:
        vol_sma = volume.rolling(20).mean().iloc[-1]
        features.append(volume.iloc[-1] / vol_sma if vol_sma > 0 else 1.0)
    else:
        features.append(1.0)

    # Volume trend (5-period)
    if n >= 6:
        vol_change = (volume.iloc[-1] - volume.iloc[-6]) / volume.iloc[-6] if volume.iloc[-6] > 0 else 0
        features.append(vol_change)
    else:
        features.append(0.0)

    # RSI
    if n >= 15:
        rsi_val = ta.momentum.rsi(close, window=14).iloc[-1]
        features.append(rsi_val / 100.0)  # normalize to 0-1
    else:
        features.append(0.5)

    # MACD histogram
    if n >= 30:
        macd = ta.trend.MACD(close)
        hist = macd.macd_diff().iloc[-1]
        features.append(hist / close.iloc[-1] if close.iloc[-1] else 0)
    else:
        features.append(0.0)

    # Bollinger %B
    if n >= 20:
        bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
        bb_upper = bb.bollinger_hband().iloc[-1]
        bb_lower = bb.bollinger_lband().iloc[-1]
        bb_range = bb_upper - bb_lower
        pct_b = (close.iloc[-1] - bb_lower) / bb_range if bb_range > 0 else 0.5
        features.append(pct_b)
    else:
        features.append(0.5)

    # Price vs EMA(20) distance %
    if n >= 20:
        ema20 = ta.trend.ema_indicator(close, window=20).iloc[-1]
        features.append((close.iloc[-1] - ema20) / ema20 if ema20 else 0)
    else:
        features.append(0.0)

    # Price vs EMA(50) distance %
    if n >= 50:
        ema50 = ta.trend.ema_indicator(close, window=50).iloc[-1]
        features.append((close.iloc[-1] - ema50) / ema50 if ema50 else 0)
    else:
        features.append(0.0)

    # Candle body ratio
    candle_range = high.iloc[-1] - low.iloc[-1]
    body = abs(close.iloc[-1] - opn.iloc[-1])
    features.append(body / candle_range if candle_range > 0 else 0)

    # Upper wick ratio
    upper_wick = high.iloc[-1] - max(close.iloc[-1], opn.iloc[-1])
    features.append(upper_wick / candle_range if candle_range > 0 else 0)

    # Lower wick ratio
    lower_wick = min(close.iloc[-1], opn.iloc[-1]) - low.iloc[-1]
    features.append(lower_wick / candle_range if candle_range > 0 else 0)

    # Hour-of-day cyclical (sin/cos) - from timestamp if available
    if "timestamp" in df.columns and hasattr(df["timestamp"].iloc[-1], "hour"):
        hour = df["timestamp"].iloc[-1].hour
        features.append(np.sin(2 * np.pi * hour / 24))
        features.append(np.cos(2 * np.pi * hour / 24))
    else:
        features.append(0.0)
        features.append(0.0)

    # Consecutive green/red candles
    streak = 0
    for i in range(n - 1, max(n - 11, -1), -1):
        if close.iloc[i] > opn.iloc[i]:
            if streak >= 0:
                streak += 1
            else:
                break
        elif close.iloc[i] < opn.iloc[i]:
            if streak <= 0:
                streak -= 1
            else:
                break
        else:
            break
    features.append(streak / 10.0)  # normalize

    return np.array(features, dtype=np.float64)


def build_feature_vector(
    signals: list[dict],
    df: pd.DataFrame,
    mlofi_features: np.ndarray = None,
    cross_asset_features: np.ndarray = None,
    mtf_score: float = 0.0,
    minutes_since_last_trade: float = 0.0,
) -> np.ndarray:
    """Build complete feature vector: strategy (50) + market (20) + MLOFI (20) + cross-asset (5) + extra (4) = 99."""
    from datetime import datetime, timezone
    strat_feats = signals_to_features(signals)
    mkt_feats = market_features(df)
    parts = [strat_feats, mkt_feats]
    if mlofi_features is not None and len(mlofi_features) == 20:
        parts.append(mlofi_features)
    else:
        parts.append(np.zeros(20, dtype=np.float64))
    if cross_asset_features is not None and len(cross_asset_features) == 5:
        parts.append(cross_asset_features)
    else:
        parts.append(np.zeros(5, dtype=np.float64))
    # Extra features (4): MTF score + day_of_week_sin + day_of_week_cos + minutes_since_trade
    now = datetime.now(timezone.utc)
    dow = now.weekday()  # 0=Mon, 6=Sun
    extra = np.array([
        mtf_score / 100.0,                              # MTF alignment (0-1)
        np.sin(2 * np.pi * dow / 7),                    # day-of-week cyclical
        np.cos(2 * np.pi * dow / 7),
        min(minutes_since_last_trade / 60.0, 1.0),      # minutes since last trade (normalized, cap at 1h)
    ], dtype=np.float64)
    parts.append(extra)

    # Feature interactions (10): products of key market features for non-linear patterns
    base = np.concatenate(parts)
    interactions = _compute_interactions(mkt_feats)
    return np.concatenate([base, interactions])


def _compute_interactions(mkt_feats: np.ndarray) -> np.ndarray:
    """Compute 10 interaction features from key market signals.

    Pairs chosen for economic meaning:
    1. RSI * volume_ratio (overbought/oversold with volume confirmation)
    2. ret_1 * vol_ratio (momentum with volume)
    3. ATR_norm * bb_pctb (volatility * mean-reversion signal)
    4. ret_5 * ema20_dist (trend confirmation)
    5. macd_hist * rsi (momentum confluence)
    6. body_ratio * vol_ratio (strong candle + volume)
    7. ret_1 * candle_streak (continuation signal)
    8. atr_norm * ret_1 (vol-adjusted momentum)
    9. bb_pctb * ema50_dist (mean reversion + trend)
    10. rsi^2 (non-linearity in overbought/oversold)
    """
    # mkt_feats indices: 0-4=returns, 5=atr, 6=std, 7=vol_ratio, 8=vol_trend,
    # 9=rsi, 10=macd, 11=bb_pctb, 12=ema20, 13=ema50, 14=body, 15=upper_wick,
    # 16=lower_wick, 17=hour_sin, 18=hour_cos, 19=streak
    if len(mkt_feats) < 20:
        return np.zeros(10, dtype=np.float64)
    rsi = mkt_feats[9]
    vol_ratio = mkt_feats[7]
    ret_1 = mkt_feats[0]
    ret_5 = mkt_feats[2]
    atr = mkt_feats[5]
    bb = mkt_feats[11]
    ema20 = mkt_feats[12]
    ema50 = mkt_feats[13]
    macd = mkt_feats[10]
    body = mkt_feats[14]
    streak = mkt_feats[19]
    return np.array([
        rsi * vol_ratio,
        ret_1 * vol_ratio,
        atr * bb,
        ret_5 * ema20,
        macd * rsi,
        body * vol_ratio,
        ret_1 * streak,
        atr * ret_1,
        bb * ema50,
        rsi * rsi,
    ], dtype=np.float64)


FEATURE_COUNT = len(STRATEGY_NAMES) * 2 + 20 + 20 + 5 + 4 + 10  # 50 + 20 + 20 + 5 + 4 + 10 = 109

FEATURE_NAMES = []
for name in STRATEGY_NAMES:
    FEATURE_NAMES.append(f"{name}_dir")
    FEATURE_NAMES.append(f"{name}_conf")
FEATURE_NAMES.extend([
    "ret_1", "ret_3", "ret_5", "ret_10", "ret_20",
    "atr_norm", "std_norm", "vol_ratio", "vol_trend",
    "rsi", "macd_hist", "bb_pctb", "ema20_dist", "ema50_dist",
    "body_ratio", "upper_wick", "lower_wick",
    "hour_sin", "hour_cos", "candle_streak",
])
# MLOFI features (20)
FEATURE_NAMES.extend([
    f"ofi_level_{i}" for i in range(10)
] + [
    f"rolling_ofi_{i}" for i in range(5)
] + [
    "weighted_ofi", "trade_imbalance", "spread_pct", "depth_imbalance", "ofi_confidence",
])
# Cross-asset features (5)
FEATURE_NAMES.extend([
    "btc_correlation", "btc_relative_momentum", "altcoin_rotation",
    "cross_momentum_divergence", "correlation_change",
])
# Extra features (4)
FEATURE_NAMES.extend(["mtf_alignment_score", "dow_sin", "dow_cos", "minutes_since_trade"])
# Interaction features (10)
FEATURE_NAMES.extend([
    "rsi_x_vol", "ret1_x_vol", "atr_x_bb", "ret5_x_ema20",
    "macd_x_rsi", "body_x_vol", "ret1_x_streak", "atr_x_ret1",
    "bb_x_ema50", "rsi_squared",
])
