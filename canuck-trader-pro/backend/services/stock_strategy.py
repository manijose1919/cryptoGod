"""
Stock Strategy Engine
Port of services/StrategyEngine.js.

10 strategies for stock trading with real ADX, Gap, Pivot, and SELL signals.
"""

import math
import logging

logger = logging.getLogger("stock_strategy")


def _ema(data: list[float], period: int) -> list[float]:
    if not data:
        return []
    k = 2.0 / (period + 1)
    result = [data[0]]
    for i in range(1, len(data)):
        result.append(data[i] * k + result[-1] * (1 - k))
    return result


def _sma(data: list[float], period: int) -> list[float]:
    result = [float("nan")] * len(data)
    if len(data) < period:
        return result
    s = sum(data[:period])
    result[period - 1] = s / period
    for i in range(period, len(data)):
        s = s - data[i - period] + data[i]
        result[i] = s / period
    return result


def _rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50
    gains = losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        diff = closes[i] - closes[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses -= diff
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def _adx(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float:
    """Average Directional Index."""
    n = len(closes)
    if n < period + 1:
        return 0

    plus_dm_list = []
    minus_dm_list = []
    tr_list = []

    for i in range(1, n):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm_list.append(up if up > down and up > 0 else 0)
        minus_dm_list.append(down if down > up and down > 0 else 0)
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        tr_list.append(tr)

    if len(tr_list) < period:
        return 0

    atr = sum(tr_list[:period]) / period
    plus_dm_sum = sum(plus_dm_list[:period]) / period
    minus_dm_sum = sum(minus_dm_list[:period]) / period

    for i in range(period, len(tr_list)):
        atr = (atr * (period - 1) + tr_list[i]) / period
        plus_dm_sum = (plus_dm_sum * (period - 1) + plus_dm_list[i]) / period
        minus_dm_sum = (minus_dm_sum * (period - 1) + minus_dm_list[i]) / period

    if atr == 0:
        return 0
    plus_di = (plus_dm_sum / atr) * 100
    minus_di = (minus_dm_sum / atr) * 100
    di_sum = plus_di + minus_di
    dx = abs(plus_di - minus_di) / di_sum * 100 if di_sum > 0 else 0
    return dx


def _macd(closes: list[float]) -> tuple[float, float, float]:
    if len(closes) < 26:
        return 0, 0, 0
    fast = _ema(closes, 12)
    slow = _ema(closes, 26)
    macd_line = [f - s for f, s in zip(fast, slow)]
    signal = _ema(macd_line, 9)
    hist = macd_line[-1] - signal[-1]
    return macd_line[-1], signal[-1], hist


class StockStrategyEngine:
    """10 stock trading strategies."""

    def evaluate(self, candles: list[dict], ticker: str = "") -> list[dict]:
        if not candles or len(candles) < 30:
            return []

        closes = [c["c"] for c in candles]
        highs = [c["h"] for c in candles]
        lows = [c["l"] for c in candles]
        volumes = [c.get("v", 0) for c in candles]
        price = closes[-1]
        prev = closes[-2]

        signals = []

        # 1. EMA Crossover (9/21)
        ema9 = _ema(closes, 9)
        ema21 = _ema(closes, 21)
        if ema9[-2] <= ema21[-2] and ema9[-1] > ema21[-1]:
            signals.append({"strategy": "EMA_CROSS", "signal": "BUY", "confidence": 70, "reason": "EMA 9/21 golden cross"})
        elif ema9[-2] >= ema21[-2] and ema9[-1] < ema21[-1]:
            signals.append({"strategy": "EMA_CROSS", "signal": "SELL", "confidence": 70, "reason": "EMA 9/21 death cross"})

        # 2. RSI
        rsi_val = _rsi(closes)
        if rsi_val < 30:
            signals.append({"strategy": "RSI", "signal": "BUY", "confidence": 65, "reason": f"RSI oversold ({rsi_val:.0f})"})
        elif rsi_val > 70:
            signals.append({"strategy": "RSI", "signal": "SELL", "confidence": 65, "reason": f"RSI overbought ({rsi_val:.0f})"})

        # 3. MACD
        macd_val, macd_sig, macd_hist = _macd(closes)
        if macd_hist > 0 and closes[-1] > closes[-2]:
            signals.append({"strategy": "MACD", "signal": "BUY", "confidence": 60, "reason": "MACD histogram positive"})
        elif macd_hist < 0 and closes[-1] < closes[-2]:
            signals.append({"strategy": "MACD", "signal": "SELL", "confidence": 60, "reason": "MACD histogram negative"})

        # 4. ADX Trend
        adx_val = _adx(highs, lows, closes)
        if adx_val > 25:
            if price > _ema(closes, 20)[-1]:
                signals.append({"strategy": "ADX_TREND", "signal": "BUY", "confidence": 55 + min(20, adx_val - 25), "reason": f"Strong trend ADX={adx_val:.0f}"})
            else:
                signals.append({"strategy": "ADX_TREND", "signal": "SELL", "confidence": 55, "reason": f"Strong downtrend ADX={adx_val:.0f}"})

        # 5. Volume Breakout
        avg_vol = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else sum(volumes) / len(volumes)
        vol_ratio = volumes[-1] / avg_vol if avg_vol > 0 else 1
        high20 = max(highs[-20:])
        if vol_ratio > 2 and price > high20 * 0.99:
            signals.append({"strategy": "VOL_BREAKOUT", "signal": "BUY", "confidence": 75, "reason": f"Volume breakout ({vol_ratio:.1f}x)"})

        # 6. Mean Reversion (Bollinger)
        sma20 = _sma(closes, 20)
        if not math.isnan(sma20[-1]):
            std_vals = closes[-20:]
            mean = sum(std_vals) / 20
            std = math.sqrt(sum((x - mean) ** 2 for x in std_vals) / 20)
            bb_lower = mean - 2 * std
            bb_upper = mean + 2 * std
            if price <= bb_lower:
                signals.append({"strategy": "MEAN_REVERT", "signal": "BUY", "confidence": 65, "reason": "Price at lower Bollinger"})
            elif price >= bb_upper:
                signals.append({"strategy": "MEAN_REVERT", "signal": "SELL", "confidence": 65, "reason": "Price at upper Bollinger"})

        # 7. Gap Detection
        if len(candles) >= 2:
            gap_pct = ((candles[-1]["o"] - candles[-2]["c"]) / candles[-2]["c"]) * 100
            if gap_pct > 1:
                signals.append({"strategy": "GAP", "signal": "SELL", "confidence": 55, "reason": f"Gap up {gap_pct:.1f}% (fade)"})
            elif gap_pct < -1:
                signals.append({"strategy": "GAP", "signal": "BUY", "confidence": 55, "reason": f"Gap down {gap_pct:.1f}% (recovery)"})

        # 8. Pivot Points
        prev_h, prev_l, prev_c = highs[-2], lows[-2], closes[-2]
        pivot = (prev_h + prev_l + prev_c) / 3
        s1 = 2 * pivot - prev_h
        r1 = 2 * pivot - prev_l
        if price < s1 and price > closes[-2]:
            signals.append({"strategy": "PIVOT", "signal": "BUY", "confidence": 60, "reason": f"Bouncing off S1 ({s1:.2f})"})
        elif price > r1 and price < closes[-2]:
            signals.append({"strategy": "PIVOT", "signal": "SELL", "confidence": 60, "reason": f"Rejecting R1 ({r1:.2f})"})

        # 9. Momentum (ROC)
        if len(closes) > 10:
            roc = ((price - closes[-11]) / closes[-11]) * 100
            if roc > 3:
                signals.append({"strategy": "MOMENTUM", "signal": "BUY", "confidence": 55, "reason": f"Strong momentum +{roc:.1f}%"})
            elif roc < -3:
                signals.append({"strategy": "MOMENTUM", "signal": "SELL", "confidence": 55, "reason": f"Weak momentum {roc:.1f}%"})

        # 10. VWAP (if volume data available)
        if sum(volumes) > 0 and len(candles) >= 10:
            cum_vol = sum(volumes[-20:])
            cum_pv = sum(c["c"] * c.get("v", 0) for c in candles[-20:])
            vwap = cum_pv / cum_vol if cum_vol > 0 else price
            if price < vwap * 0.99:
                signals.append({"strategy": "VWAP", "signal": "BUY", "confidence": 55, "reason": f"Below VWAP ({vwap:.2f})"})
            elif price > vwap * 1.01:
                signals.append({"strategy": "VWAP", "signal": "SELL", "confidence": 55, "reason": f"Above VWAP ({vwap:.2f})"})

        return signals

    def get_consensus(self, signals: list[dict]) -> dict:
        buys = [s for s in signals if s["signal"] == "BUY"]
        sells = [s for s in signals if s["signal"] == "SELL"]
        if len(buys) > len(sells) + 1:
            avg_conf = sum(s["confidence"] for s in buys) / len(buys)
            return {"action": "BUY", "confidence": avg_conf, "buy_count": len(buys), "sell_count": len(sells), "signals": signals}
        elif len(sells) > len(buys) + 1:
            avg_conf = sum(s["confidence"] for s in sells) / len(sells)
            return {"action": "SELL", "confidence": avg_conf, "buy_count": len(buys), "sell_count": len(sells), "signals": signals}
        return {"action": "HOLD", "confidence": 0, "buy_count": len(buys), "sell_count": len(sells), "signals": signals}
