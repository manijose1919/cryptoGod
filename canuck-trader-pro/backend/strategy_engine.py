"""
Strategy Engine - 25 Trading Strategies
Each strategy returns: {"signal": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "name": str}
All use pandas + ta library (pure Python, no TA-Lib dependency).
"""
import logging
from typing import Dict, List

import numpy as np
import pandas as pd
import ta

logger = logging.getLogger(__name__)


def _safe(func):
    """Decorator: catch exceptions in strategies, return HOLD."""
    def wrapper(df: pd.DataFrame, **kwargs):
        try:
            return func(df, **kwargs)
        except Exception as e:
            logger.debug(f"Strategy {func.__name__} error: {e}")
            return {"signal": "HOLD", "confidence": 0, "name": func.__name__}
    return wrapper


# ═══════════════════════════════════════════════════════════════════════════
# TREND-FOLLOWING STRATEGIES (1-5)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def ema_crossover(df: pd.DataFrame, fast: int = 9, slow: int = 21) -> dict:
    """1. EMA Crossover: fast EMA crosses above/below slow EMA."""
    ema_fast = ta.trend.ema_indicator(df["close"], window=fast)
    ema_slow = ta.trend.ema_indicator(df["close"], window=slow)
    prev_fast, curr_fast = ema_fast.iloc[-2], ema_fast.iloc[-1]
    prev_slow, curr_slow = ema_slow.iloc[-2], ema_slow.iloc[-1]

    if prev_fast <= prev_slow and curr_fast > curr_slow:
        spread = abs(curr_fast - curr_slow) / curr_slow * 100
        return {"signal": "BUY", "confidence": min(80, 50 + spread * 20), "name": "EMA_CROSSOVER"}
    elif prev_fast >= prev_slow and curr_fast < curr_slow:
        spread = abs(curr_fast - curr_slow) / curr_slow * 100
        return {"signal": "SELL", "confidence": min(80, 50 + spread * 20), "name": "EMA_CROSSOVER"}
    return {"signal": "HOLD", "confidence": 0, "name": "EMA_CROSSOVER"}


@_safe
def triple_ema(df: pd.DataFrame) -> dict:
    """2. Triple EMA: EMA(8) > EMA(21) > EMA(55) = uptrend."""
    e8 = ta.trend.ema_indicator(df["close"], window=8).iloc[-1]
    e21 = ta.trend.ema_indicator(df["close"], window=21).iloc[-1]
    e55 = ta.trend.ema_indicator(df["close"], window=55).iloc[-1]

    if e8 > e21 > e55:
        return {"signal": "BUY", "confidence": 65, "name": "TRIPLE_EMA"}
    elif e8 < e21 < e55:
        return {"signal": "SELL", "confidence": 65, "name": "TRIPLE_EMA"}
    return {"signal": "HOLD", "confidence": 0, "name": "TRIPLE_EMA"}


@_safe
def macd_signal(df: pd.DataFrame) -> dict:
    """3. MACD crossover + histogram direction."""
    macd = ta.trend.MACD(df["close"])
    macd_line = macd.macd().iloc[-1]
    signal_line = macd.macd_signal().iloc[-1]
    hist = macd.macd_diff().iloc[-1]
    prev_hist = macd.macd_diff().iloc[-2]

    if macd_line > signal_line and hist > 0 and hist > prev_hist:
        return {"signal": "BUY", "confidence": 60 + min(20, abs(hist) * 500), "name": "MACD"}
    elif macd_line < signal_line and hist < 0 and hist < prev_hist:
        return {"signal": "SELL", "confidence": 60 + min(20, abs(hist) * 500), "name": "MACD"}
    return {"signal": "HOLD", "confidence": 0, "name": "MACD"}


@_safe
def adx_trend(df: pd.DataFrame, period: int = 14) -> dict:
    """4. ADX trend strength: ADX > 25 = strong trend, use +DI/-DI for direction."""
    adx_indicator = ta.trend.ADXIndicator(df["high"], df["low"], df["close"], window=period)
    adx = adx_indicator.adx().iloc[-1]
    plus_di = adx_indicator.adx_pos().iloc[-1]
    minus_di = adx_indicator.adx_neg().iloc[-1]

    if adx > 25:
        conf = min(85, 50 + (adx - 25) * 1.5)
        if plus_di > minus_di:
            return {"signal": "BUY", "confidence": conf, "name": "ADX_TREND"}
        else:
            return {"signal": "SELL", "confidence": conf, "name": "ADX_TREND"}
    return {"signal": "HOLD", "confidence": 0, "name": "ADX_TREND"}


@_safe
def supertrend(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0) -> dict:
    """5. Supertrend indicator: ATR-based trend bands."""
    atr = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"], window=period).average_true_range()
    hl2 = (df["high"] + df["low"]) / 2
    upper = hl2 + multiplier * atr
    lower = hl2 - multiplier * atr

    close = df["close"]
    supertrend_dir = pd.Series(index=df.index, dtype=float)
    supertrend_dir.iloc[0] = 1

    for i in range(1, len(df)):
        if close.iloc[i] > upper.iloc[i - 1]:
            supertrend_dir.iloc[i] = 1
        elif close.iloc[i] < lower.iloc[i - 1]:
            supertrend_dir.iloc[i] = -1
        else:
            supertrend_dir.iloc[i] = supertrend_dir.iloc[i - 1]

    curr = supertrend_dir.iloc[-1]
    prev = supertrend_dir.iloc[-2]

    if curr == 1 and prev == -1:
        return {"signal": "BUY", "confidence": 70, "name": "SUPERTREND"}
    elif curr == -1 and prev == 1:
        return {"signal": "SELL", "confidence": 70, "name": "SUPERTREND"}
    elif curr == 1:
        return {"signal": "BUY", "confidence": 40, "name": "SUPERTREND"}
    return {"signal": "SELL", "confidence": 40, "name": "SUPERTREND"}


# ═══════════════════════════════════════════════════════════════════════════
# MOMENTUM STRATEGIES (6-10)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def rsi_strategy(df: pd.DataFrame, period: int = 14) -> dict:
    """6. RSI: Oversold < 30 = BUY, Overbought > 70 = SELL."""
    rsi = ta.momentum.rsi(df["close"], window=period).iloc[-1]
    if rsi < 30:
        return {"signal": "BUY", "confidence": 55 + (30 - rsi), "name": "RSI"}
    elif rsi > 70:
        return {"signal": "SELL", "confidence": 55 + (rsi - 70), "name": "RSI"}
    return {"signal": "HOLD", "confidence": 0, "name": "RSI"}


@_safe
def stochastic_rsi(df: pd.DataFrame) -> dict:
    """7. Stochastic RSI: combines RSI with stochastic oscillator."""
    stoch = ta.momentum.StochRSIIndicator(df["close"])
    k = stoch.stochrsi_k().iloc[-1] * 100
    d = stoch.stochrsi_d().iloc[-1] * 100

    if k < 20 and k > d:
        return {"signal": "BUY", "confidence": 60, "name": "STOCH_RSI"}
    elif k > 80 and k < d:
        return {"signal": "SELL", "confidence": 60, "name": "STOCH_RSI"}
    return {"signal": "HOLD", "confidence": 0, "name": "STOCH_RSI"}


@_safe
def williams_r(df: pd.DataFrame, period: int = 14) -> dict:
    """8. Williams %R: momentum oscillator (-100 to 0)."""
    wr = ta.momentum.WilliamsRIndicator(df["high"], df["low"], df["close"], lbp=period).williams_r().iloc[-1]
    if wr < -80:
        return {"signal": "BUY", "confidence": 55, "name": "WILLIAMS_R"}
    elif wr > -20:
        return {"signal": "SELL", "confidence": 55, "name": "WILLIAMS_R"}
    return {"signal": "HOLD", "confidence": 0, "name": "WILLIAMS_R"}


@_safe
def cci_strategy(df: pd.DataFrame, period: int = 20) -> dict:
    """9. CCI: Commodity Channel Index, oversold/overbought."""
    cci = ta.trend.CCIIndicator(df["high"], df["low"], df["close"], window=period).cci().iloc[-1]
    if cci < -100:
        return {"signal": "BUY", "confidence": 55 + min(20, abs(cci + 100) / 5), "name": "CCI"}
    elif cci > 100:
        return {"signal": "SELL", "confidence": 55 + min(20, abs(cci - 100) / 5), "name": "CCI"}
    return {"signal": "HOLD", "confidence": 0, "name": "CCI"}


@_safe
def momentum_rate(df: pd.DataFrame, period: int = 10) -> dict:
    """10. Rate of Change: momentum = (close - close[n]) / close[n]."""
    roc = ta.momentum.ROCIndicator(df["close"], window=period).roc().iloc[-1]
    if roc > 2:
        return {"signal": "BUY", "confidence": 50 + min(30, roc * 3), "name": "MOMENTUM_ROC"}
    elif roc < -2:
        return {"signal": "SELL", "confidence": 50 + min(30, abs(roc) * 3), "name": "MOMENTUM_ROC"}
    return {"signal": "HOLD", "confidence": 0, "name": "MOMENTUM_ROC"}


# ═══════════════════════════════════════════════════════════════════════════
# VOLATILITY STRATEGIES (11-15)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def bollinger_bands(df: pd.DataFrame, period: int = 20, std_dev: float = 2.0) -> dict:
    """11. Bollinger Bands: price at lower band = BUY, upper = SELL."""
    bb = ta.volatility.BollingerBands(df["close"], window=period, window_dev=std_dev)
    close = df["close"].iloc[-1]
    upper = bb.bollinger_hband().iloc[-1]
    lower = bb.bollinger_lband().iloc[-1]
    mid = bb.bollinger_mavg().iloc[-1]
    width = (upper - lower) / mid if mid else 0

    if close <= lower:
        return {"signal": "BUY", "confidence": 60 + min(20, width * 500), "name": "BOLLINGER"}
    elif close >= upper:
        return {"signal": "SELL", "confidence": 60 + min(20, width * 500), "name": "BOLLINGER"}
    return {"signal": "HOLD", "confidence": 0, "name": "BOLLINGER"}


@_safe
def keltner_channel(df: pd.DataFrame, period: int = 20, atr_mult: float = 2.0) -> dict:
    """12. Keltner Channel: EMA ± ATR*mult."""
    kc = ta.volatility.KeltnerChannel(df["high"], df["low"], df["close"], window=period, window_atr=period)
    close = df["close"].iloc[-1]
    upper = kc.keltner_channel_hband().iloc[-1]
    lower = kc.keltner_channel_lband().iloc[-1]

    if close <= lower:
        return {"signal": "BUY", "confidence": 60, "name": "KELTNER"}
    elif close >= upper:
        return {"signal": "SELL", "confidence": 60, "name": "KELTNER"}
    return {"signal": "HOLD", "confidence": 0, "name": "KELTNER"}


@_safe
def atr_breakout(df: pd.DataFrame, period: int = 14, mult: float = 1.5) -> dict:
    """13. ATR Breakout: price move > mult * ATR = breakout signal."""
    atr = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"], window=period).average_true_range()
    curr_atr = atr.iloc[-1]
    price_move = df["close"].iloc[-1] - df["close"].iloc[-2]

    if abs(price_move) > mult * curr_atr:
        if price_move > 0:
            return {"signal": "BUY", "confidence": 65, "name": "ATR_BREAKOUT"}
        else:
            return {"signal": "SELL", "confidence": 65, "name": "ATR_BREAKOUT"}
    return {"signal": "HOLD", "confidence": 0, "name": "ATR_BREAKOUT"}


@_safe
def donchian_channel(df: pd.DataFrame, period: int = 20) -> dict:
    """14. Donchian Channel: breakout above period-high = BUY."""
    dc = ta.volatility.DonchianChannel(df["high"], df["low"], df["close"], window=period)
    close = df["close"].iloc[-1]
    upper = dc.donchian_channel_hband().iloc[-1]
    lower = dc.donchian_channel_lband().iloc[-1]

    if close >= upper:
        return {"signal": "BUY", "confidence": 60, "name": "DONCHIAN"}
    elif close <= lower:
        return {"signal": "SELL", "confidence": 60, "name": "DONCHIAN"}
    return {"signal": "HOLD", "confidence": 0, "name": "DONCHIAN"}


@_safe
def volatility_squeeze(df: pd.DataFrame) -> dict:
    """15. Volatility Squeeze: BB inside Keltner = squeeze, breakout coming."""
    bb = ta.volatility.BollingerBands(df["close"], window=20, window_dev=2)
    kc = ta.volatility.KeltnerChannel(df["high"], df["low"], df["close"], window=20, window_atr=20)

    bb_upper = bb.bollinger_hband().iloc[-1]
    bb_lower = bb.bollinger_lband().iloc[-1]
    kc_upper = kc.keltner_channel_hband().iloc[-1]
    kc_lower = kc.keltner_channel_lband().iloc[-1]

    in_squeeze = bb_lower > kc_lower and bb_upper < kc_upper
    prev_bb_lower = bb.bollinger_lband().iloc[-2]
    prev_kc_lower = kc.keltner_channel_lband().iloc[-2]
    prev_bb_upper = bb.bollinger_hband().iloc[-2]
    prev_kc_upper = kc.keltner_channel_hband().iloc[-2]
    was_in_squeeze = prev_bb_lower > prev_kc_lower and prev_bb_upper < prev_kc_upper

    if was_in_squeeze and not in_squeeze:
        # Squeeze released - direction from momentum
        mom = df["close"].iloc[-1] - df["close"].iloc[-3]
        if mom > 0:
            return {"signal": "BUY", "confidence": 70, "name": "VOL_SQUEEZE"}
        else:
            return {"signal": "SELL", "confidence": 70, "name": "VOL_SQUEEZE"}
    return {"signal": "HOLD", "confidence": 0, "name": "VOL_SQUEEZE"}


# ═══════════════════════════════════════════════════════════════════════════
# VOLUME STRATEGIES (16-18)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def vwap_strategy(df: pd.DataFrame) -> dict:
    """16. VWAP: price above VWAP = bullish, below = bearish."""
    typical = (df["high"] + df["low"] + df["close"]) / 3
    cum_vol = df["volume"].cumsum()
    cum_tp_vol = (typical * df["volume"]).cumsum()
    vwap = cum_tp_vol / cum_vol
    close = df["close"].iloc[-1]
    vwap_val = vwap.iloc[-1]

    pct_from_vwap = (close - vwap_val) / vwap_val * 100
    if close > vwap_val and pct_from_vwap < 2:
        return {"signal": "BUY", "confidence": 55, "name": "VWAP"}
    elif close < vwap_val and pct_from_vwap > -2:
        return {"signal": "SELL", "confidence": 55, "name": "VWAP"}
    return {"signal": "HOLD", "confidence": 0, "name": "VWAP"}


@_safe
def obv_strategy(df: pd.DataFrame) -> dict:
    """17. On-Balance Volume: OBV trend confirms price trend."""
    obv = ta.volume.OnBalanceVolumeIndicator(df["close"], df["volume"]).on_balance_volume()
    obv_sma = obv.rolling(20).mean()

    if obv.iloc[-1] > obv_sma.iloc[-1] and obv.iloc[-2] <= obv_sma.iloc[-2]:
        return {"signal": "BUY", "confidence": 55, "name": "OBV"}
    elif obv.iloc[-1] < obv_sma.iloc[-1] and obv.iloc[-2] >= obv_sma.iloc[-2]:
        return {"signal": "SELL", "confidence": 55, "name": "OBV"}
    return {"signal": "HOLD", "confidence": 0, "name": "OBV"}


@_safe
def volume_spike(df: pd.DataFrame, mult: float = 2.0) -> dict:
    """18. Volume Spike: volume > mult * 20-SMA volume + price direction."""
    vol_sma = df["volume"].rolling(20).mean().iloc[-1]
    curr_vol = df["volume"].iloc[-1]
    price_change = df["close"].iloc[-1] - df["close"].iloc[-2]

    if curr_vol > mult * vol_sma:
        conf = min(75, 50 + (curr_vol / vol_sma - mult) * 10)
        if price_change > 0:
            return {"signal": "BUY", "confidence": conf, "name": "VOL_SPIKE"}
        else:
            return {"signal": "SELL", "confidence": conf, "name": "VOL_SPIKE"}
    return {"signal": "HOLD", "confidence": 0, "name": "VOL_SPIKE"}


# ═══════════════════════════════════════════════════════════════════════════
# PATTERN / MEAN-REVERSION STRATEGIES (19-22)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def mean_reversion(df: pd.DataFrame, period: int = 20, threshold: float = 2.0) -> dict:
    """19. Mean Reversion: z-score from SMA, extreme = snap-back expected."""
    sma = df["close"].rolling(period).mean()
    std = df["close"].rolling(period).std()
    z = (df["close"].iloc[-1] - sma.iloc[-1]) / std.iloc[-1] if std.iloc[-1] > 0 else 0

    if z < -threshold:
        return {"signal": "BUY", "confidence": 55 + min(25, abs(z) * 8), "name": "MEAN_REVERT"}
    elif z > threshold:
        return {"signal": "SELL", "confidence": 55 + min(25, abs(z) * 8), "name": "MEAN_REVERT"}
    return {"signal": "HOLD", "confidence": 0, "name": "MEAN_REVERT"}


@_safe
def ichimoku_cloud(df: pd.DataFrame) -> dict:
    """20. Ichimoku Cloud: price above cloud = bullish, below = bearish."""
    ich = ta.trend.IchimokuIndicator(df["high"], df["low"])
    span_a = ich.ichimoku_a().iloc[-1]
    span_b = ich.ichimoku_b().iloc[-1]
    close = df["close"].iloc[-1]
    conversion = ich.ichimoku_conversion_line().iloc[-1]
    base = ich.ichimoku_base_line().iloc[-1]

    cloud_top = max(span_a, span_b)
    cloud_bottom = min(span_a, span_b)

    if close > cloud_top and conversion > base:
        return {"signal": "BUY", "confidence": 65, "name": "ICHIMOKU"}
    elif close < cloud_bottom and conversion < base:
        return {"signal": "SELL", "confidence": 65, "name": "ICHIMOKU"}
    return {"signal": "HOLD", "confidence": 0, "name": "ICHIMOKU"}


@_safe
def pivot_points(df: pd.DataFrame) -> dict:
    """21. Pivot Points: support/resistance from prior period H/L/C."""
    h = df["high"].iloc[-2]
    l = df["low"].iloc[-2]
    c = df["close"].iloc[-2]
    pivot = (h + l + c) / 3
    s1 = 2 * pivot - h
    r1 = 2 * pivot - l

    close = df["close"].iloc[-1]
    if close < s1:
        return {"signal": "BUY", "confidence": 55, "name": "PIVOT_POINTS"}
    elif close > r1:
        return {"signal": "SELL", "confidence": 55, "name": "PIVOT_POINTS"}
    return {"signal": "HOLD", "confidence": 0, "name": "PIVOT_POINTS"}


@_safe
def engulfing_pattern(df: pd.DataFrame) -> dict:
    """22. Engulfing candlestick pattern detection."""
    o1, c1 = df["open"].iloc[-2], df["close"].iloc[-2]
    o2, c2 = df["open"].iloc[-1], df["close"].iloc[-1]

    bearish_prev = c1 < o1
    bullish_curr = c2 > o2

    if bearish_prev and bullish_curr and c2 > o1 and o2 < c1:
        return {"signal": "BUY", "confidence": 60, "name": "ENGULFING"}

    bullish_prev = c1 > o1
    bearish_curr = c2 < o2

    if bullish_prev and bearish_curr and c2 < o1 and o2 > c1:
        return {"signal": "SELL", "confidence": 60, "name": "ENGULFING"}
    return {"signal": "HOLD", "confidence": 0, "name": "ENGULFING"}


# ═══════════════════════════════════════════════════════════════════════════
# DIVERGENCE & ADVANCED STRATEGIES (23-25)
# ═══════════════════════════════════════════════════════════════════════════

@_safe
def rsi_divergence(df: pd.DataFrame, period: int = 14, lookback: int = 10) -> dict:
    """23. RSI Divergence: price makes new low but RSI makes higher low = bullish divergence."""
    rsi = ta.momentum.rsi(df["close"], window=period)
    prices = df["close"].iloc[-lookback:]
    rsis = rsi.iloc[-lookback:]

    price_min_idx = prices.idxmin()
    price_min = prices.min()
    rsi_at_price_min = rsis.loc[price_min_idx]

    # Check if current price is near recent low but RSI is higher
    curr_price = prices.iloc[-1]
    curr_rsi = rsis.iloc[-1]

    pct_from_low = (curr_price - price_min) / price_min * 100 if price_min else 0

    if pct_from_low < 0.5 and curr_rsi > rsi_at_price_min + 5:
        return {"signal": "BUY", "confidence": 65, "name": "RSI_DIVERGENCE"}

    price_max = prices.max()
    price_max_idx = prices.idxmax()
    rsi_at_price_max = rsis.loc[price_max_idx]
    pct_from_high = (price_max - curr_price) / price_max * 100 if price_max else 0

    if pct_from_high < 0.5 and curr_rsi < rsi_at_price_max - 5:
        return {"signal": "SELL", "confidence": 65, "name": "RSI_DIVERGENCE"}
    return {"signal": "HOLD", "confidence": 0, "name": "RSI_DIVERGENCE"}


@_safe
def macd_divergence(df: pd.DataFrame, lookback: int = 15) -> dict:
    """24. MACD Divergence: price/MACD histogram divergence."""
    macd = ta.trend.MACD(df["close"])
    hist = macd.macd_diff()
    prices = df["close"].iloc[-lookback:]
    hists = hist.iloc[-lookback:]

    # Bullish: price lower low, MACD hist higher low
    if prices.iloc[-1] <= prices.min() * 1.005:
        recent_hist_min = hists.min()
        curr_hist = hists.iloc[-1]
        if curr_hist > recent_hist_min * 0.8 and recent_hist_min < 0:
            return {"signal": "BUY", "confidence": 60, "name": "MACD_DIVERGENCE"}

    # Bearish: price higher high, MACD hist lower high
    if prices.iloc[-1] >= prices.max() * 0.995:
        recent_hist_max = hists.max()
        curr_hist = hists.iloc[-1]
        if curr_hist < recent_hist_max * 0.8 and recent_hist_max > 0:
            return {"signal": "SELL", "confidence": 60, "name": "MACD_DIVERGENCE"}
    return {"signal": "HOLD", "confidence": 0, "name": "MACD_DIVERGENCE"}


@_safe
def multi_timeframe_consensus(df: pd.DataFrame) -> dict:
    """25. Multi-indicator consensus: combines RSI + MACD + BB for confirmation."""
    # RSI
    rsi_val = ta.momentum.rsi(df["close"], window=14).iloc[-1]
    rsi_bull = rsi_val < 40
    rsi_bear = rsi_val > 60

    # MACD
    macd = ta.trend.MACD(df["close"])
    macd_bull = macd.macd_diff().iloc[-1] > 0
    macd_bear = macd.macd_diff().iloc[-1] < 0

    # Bollinger
    bb = ta.volatility.BollingerBands(df["close"], window=20, window_dev=2)
    close = df["close"].iloc[-1]
    bb_bull = close < bb.bollinger_lband().iloc[-1] * 1.01
    bb_bear = close > bb.bollinger_hband().iloc[-1] * 0.99

    # EMA trend
    ema20 = ta.trend.ema_indicator(df["close"], window=20).iloc[-1]
    ema_bull = close > ema20
    ema_bear = close < ema20

    bull_score = sum([rsi_bull, macd_bull, bb_bull, ema_bull])
    bear_score = sum([rsi_bear, macd_bear, bb_bear, ema_bear])

    if bull_score >= 3:
        return {"signal": "BUY", "confidence": 50 + bull_score * 10, "name": "MULTI_CONSENSUS"}
    elif bear_score >= 3:
        return {"signal": "SELL", "confidence": 50 + bear_score * 10, "name": "MULTI_CONSENSUS"}
    return {"signal": "HOLD", "confidence": 0, "name": "MULTI_CONSENSUS"}


# ═══════════════════════════════════════════════════════════════════════════
# STRATEGY ENGINE
# ═══════════════════════════════════════════════════════════════════════════

ALL_STRATEGIES = [
    # Trend (1-5)
    ema_crossover, triple_ema, macd_signal, adx_trend, supertrend,
    # Momentum (6-10)
    rsi_strategy, stochastic_rsi, williams_r, cci_strategy, momentum_rate,
    # Volatility (11-15)
    bollinger_bands, keltner_channel, atr_breakout, donchian_channel, volatility_squeeze,
    # Volume (16-18)
    vwap_strategy, obv_strategy, volume_spike,
    # Pattern (19-22)
    mean_reversion, ichimoku_cloud, pivot_points, engulfing_pattern,
    # Divergence (23-25)
    rsi_divergence, macd_divergence, multi_timeframe_consensus,
]


class StrategyEngine:
    """Runs all 25 strategies and produces consensus signals."""

    def __init__(self):
        self.strategies = ALL_STRATEGIES
        self._indicator_cache: Dict[int, Dict] = {}  # df id → precomputed indicators

    def _precompute_indicators(self, df: pd.DataFrame) -> Dict:
        """Pre-compute commonly used indicators once. Avoids duplicate ta-lib calls."""
        df_id = id(df)
        if df_id in self._indicator_cache:
            return self._indicator_cache[df_id]

        cache = {}
        close = df["close"]
        n = len(df)
        try:
            if n >= 10:
                cache["ema_8"] = ta.trend.ema_indicator(close, window=8)
                cache["ema_9"] = ta.trend.ema_indicator(close, window=9)
            if n >= 22:
                cache["ema_21"] = ta.trend.ema_indicator(close, window=21)
                cache["rsi_14"] = ta.momentum.rsi(close, window=14)
            if n >= 30:
                cache["macd"] = ta.trend.MACD(close)
            if n >= 56:
                cache["ema_55"] = ta.trend.ema_indicator(close, window=55)
            if n >= 21:
                cache["bb"] = ta.volatility.BollingerBands(close, window=20, window_dev=2)
            if n >= 15:
                cache["atr"] = ta.volatility.AverageTrueRange(df["high"], df["low"], close, window=14).average_true_range()
        except Exception:
            pass

        # Keep only last 20 cached DataFrames to avoid memory leak
        if len(self._indicator_cache) > 20:
            oldest = next(iter(self._indicator_cache))
            del self._indicator_cache[oldest]
        self._indicator_cache[df_id] = cache
        return cache

    def run_all(self, df: pd.DataFrame) -> List[dict]:
        """Run all strategies on a DataFrame. Returns list of signal dicts.
        Pre-computes common indicators for reuse across strategies."""
        # Pre-compute shared indicators (strategies can optionally use df._indicators)
        indicators = self._precompute_indicators(df)
        # Attach to DataFrame temporarily for strategy access
        df.attrs["_indicators"] = indicators
        results = []
        for strategy_fn in self.strategies:
            result = strategy_fn(df)
            results.append(result)
        return results

    def get_consensus(self, signals: List[dict], min_confidence: int = 40) -> dict:
        """Aggregate strategy signals into a consensus.

        Returns: {
            "action": "BUY"|"SELL"|"HOLD",
            "confidence": 0-100,
            "buy_count": int,
            "sell_count": int,
            "hold_count": int,
            "active_signals": [list of non-HOLD signals],
            "top_signal": strongest signal dict,
        }
        """
        buys = [s for s in signals if s["signal"] == "BUY" and s["confidence"] >= min_confidence]
        sells = [s for s in signals if s["signal"] == "SELL" and s["confidence"] >= min_confidence]
        holds = [s for s in signals if s["signal"] == "HOLD" or s["confidence"] < min_confidence]

        active = buys + sells
        active.sort(key=lambda s: s["confidence"], reverse=True)

        buy_count = len(buys)
        sell_count = len(sells)

        if buy_count == 0 and sell_count == 0:
            return {
                "action": "HOLD",
                "confidence": 0,
                "buy_count": 0,
                "sell_count": 0,
                "hold_count": len(holds),
                "active_signals": [],
                "top_signal": None,
            }

        if buy_count > sell_count:
            avg_conf = sum(s["confidence"] for s in buys) / buy_count
            # Bonus for consensus
            consensus_bonus = min(20, (buy_count - sell_count) * 4)
            action = "BUY"
        elif sell_count > buy_count:
            avg_conf = sum(s["confidence"] for s in sells) / sell_count
            consensus_bonus = min(20, (sell_count - buy_count) * 4)
            action = "SELL"
        else:
            # Tie - go with higher average confidence
            buy_avg = sum(s["confidence"] for s in buys) / buy_count if buys else 0
            sell_avg = sum(s["confidence"] for s in sells) / sell_count if sells else 0
            if buy_avg >= sell_avg:
                action = "BUY"
                avg_conf = buy_avg
            else:
                action = "SELL"
                avg_conf = sell_avg
            consensus_bonus = 0

        final_conf = min(95, avg_conf + consensus_bonus)

        return {
            "action": action,
            "confidence": round(final_conf, 1),
            "buy_count": buy_count,
            "sell_count": sell_count,
            "hold_count": len(holds),
            "active_signals": active[:10],
            "top_signal": active[0] if active else None,
        }

    def analyze(self, df: pd.DataFrame) -> dict:
        """Full analysis: run all strategies + produce consensus."""
        signals = self.run_all(df)
        consensus = self.get_consensus(signals)
        return {
            "signals": signals,
            "consensus": consensus,
        }
