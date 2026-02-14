"""
Auto Signal Scanner
Port of services/signalScanner.js.

Scans all 10 Canadian-allowed tickers across multiple timeframes.
Uses multi-indicator confluence (RSI, EMA, MACD, Bollinger, Volume).
Generates scored BUY/SELL signals.
"""

import time
import math
import logging
import asyncio
from typing import Callable, Awaitable

logger = logging.getLogger("signal_scanner")

SCAN_INTERVAL_S = 60
SCAN_TIMEFRAMES = ["5m", "15m", "1h"]
SIGNAL_COOLDOWN_S = 300
MIN_SCORE_BUY = 3
MIN_SCORE_SELL = 3
MAX_SIGNALS = 100

TICKERS = [
    "BTCUSD", "ETHUSD", "XRPUSD", "BNBUSD", "SOLUSD",
    "ADAUSD", "DOGEUSD", "LINKUSD", "DOTUSD", "AVAXUSD",
]


# ============================================
# MATH HELPERS
# ============================================

def _ema(data: list[float], period: int) -> list[float]:
    if not data:
        return []
    k = 2 / (period + 1)
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


def _rma(data: list[float], period: int) -> list[float]:
    result = [float("nan")] * len(data)
    alpha = 1 / period
    if len(data) < period:
        return result
    s = sum(data[:period])
    result[period - 1] = s / period
    for i in range(period, len(data)):
        prev = result[i - 1] if not math.isnan(result[i - 1]) else 0
        result[i] = alpha * data[i] + (1 - alpha) * prev
    return result


def _stdev(data: list[float], period: int) -> list[float]:
    result = [float("nan")] * len(data)
    if len(data) < period:
        return result
    for i in range(period - 1, len(data)):
        sl = data[i - period + 1 : i + 1]
        mean = sum(sl) / period
        var = sum((x - mean) ** 2 for x in sl) / period
        result[i] = math.sqrt(var)
    return result


def _calc_rsi(closes: list[float], period: int = 14) -> list[float]:
    changes = [0.0] + [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(c, 0) for c in changes]
    losses = [max(-c, 0) for c in changes]
    avg_gain = _rma(gains, period)
    avg_loss = _rma(losses, period)
    rsi = []
    for i in range(len(closes)):
        ag, al = avg_gain[i], avg_loss[i]
        if math.isnan(ag) or math.isnan(al):
            rsi.append(50)
        elif al == 0:
            rsi.append(100)
        else:
            rsi.append(100 - (100 / (1 + ag / al)))
    return rsi


def _calc_macd(closes, fast=12, slow=26, signal=9):
    ema_fast = _ema(closes, fast)
    ema_slow = _ema(closes, slow)
    macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]
    signal_line = _ema(macd_line, signal)
    histogram = [m - s for m, s in zip(macd_line, signal_line)]
    return macd_line, signal_line, histogram


def _calc_bollinger(closes, period=20, mult=2):
    basis = _sma(closes, period)
    sd = _stdev(closes, period)
    upper = [b + mult * (s if not math.isnan(s) else 0) for b, s in zip(basis, sd)]
    lower = [b - mult * (s if not math.isnan(s) else 0) for b, s in zip(basis, sd)]
    return basis, upper, lower


def _calc_atr(highs, lows, closes, period=14):
    tr = []
    for i in range(len(highs)):
        if i == 0:
            tr.append(highs[i] - lows[i])
        else:
            tr.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    return _rma(tr, period)


# ============================================
# ANALYSIS ENGINE
# ============================================

def analyze_candles(candles: list[dict], ticker: str) -> dict:
    if not candles or len(candles) < 50:
        return {"signal": None, "score": 0, "details": []}

    closes = [c["c"] for c in candles]
    highs = [c["h"] for c in candles]
    lows = [c["l"] for c in candles]
    volumes = [c.get("v", 0) for c in candles]
    n = len(closes)
    price = closes[-1]
    prev_price = closes[-2]

    rsi = _calc_rsi(closes)
    rsi_val = rsi[-1]
    rsi_prev = rsi[-2]

    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)

    macd_line, signal_line, histogram = _calc_macd(closes)
    macd_val, macd_signal_val = macd_line[-1], signal_line[-1]
    macd_prev, macd_signal_prev = macd_line[-2], signal_line[-2]
    hist_val, hist_prev = histogram[-1], histogram[-2]

    bb_basis, bb_upper, bb_lower = _calc_bollinger(closes)
    bb_u, bb_l, bb_b = bb_upper[-1], bb_lower[-1], bb_basis[-1]
    bb_width = (bb_u - bb_l) / bb_b if bb_b else 0

    atr = _calc_atr(highs, lows, closes)
    atr_val = atr[-1] if not math.isnan(atr[-1]) else 0
    atr_pct = atr_val / price * 100 if price else 0

    vol_sma = _sma(volumes, 20)
    vol_ratio = volumes[-1] / vol_sma[-1] if vol_sma[-1] and not math.isnan(vol_sma[-1]) and vol_sma[-1] > 0 else 1

    buy_score = sell_score = 0
    buy_details: list[str] = []
    sell_details: list[str] = []

    # 1. RSI
    if rsi_val < 30:
        buy_score += 2; buy_details.append(f"RSI oversold ({rsi_val:.0f})")
    elif rsi_val < 40 and rsi_val > rsi_prev:
        buy_score += 1; buy_details.append(f"RSI recovering ({rsi_val:.0f})")
    if rsi_val > 70:
        sell_score += 2; sell_details.append(f"RSI overbought ({rsi_val:.0f})")
    elif rsi_val > 60 and rsi_val < rsi_prev:
        sell_score += 1; sell_details.append(f"RSI weakening ({rsi_val:.0f})")

    # 2. EMA crossovers
    ema9_now, ema9_prev = ema9[-1], ema9[-2]
    ema21_now, ema21_prev = ema21[-1], ema21[-2]
    if ema9_prev <= ema21_prev and ema9_now > ema21_now:
        buy_score += 2; buy_details.append("EMA 9/21 golden cross")
    if ema9_prev >= ema21_prev and ema9_now < ema21_now:
        sell_score += 2; sell_details.append("EMA 9/21 death cross")

    # 3. Price vs EMA50
    if price > ema50[-1]:
        buy_score += 1; buy_details.append("Above EMA50 (uptrend)")
    else:
        sell_score += 1; sell_details.append("Below EMA50 (downtrend)")

    # 4. MACD
    if macd_prev <= macd_signal_prev and macd_val > macd_signal_val:
        buy_score += 2; buy_details.append("MACD bullish cross")
    if macd_prev >= macd_signal_prev and macd_val < macd_signal_val:
        sell_score += 2; sell_details.append("MACD bearish cross")
    if hist_val > 0 and hist_val > hist_prev:
        buy_score += 1; buy_details.append("MACD histogram rising")
    if hist_val < 0 and hist_val < hist_prev:
        sell_score += 1; sell_details.append("MACD histogram falling")

    # 5. Bollinger Bands
    if price <= bb_l:
        buy_score += 2; buy_details.append("Price at lower Bollinger")
    if price >= bb_u:
        sell_score += 2; sell_details.append("Price at upper Bollinger")
    if bb_width < 0.02:
        buy_score += 1; buy_details.append(f"BB squeeze (width: {bb_width * 100:.1f}%)")

    # 6. Volume
    if vol_ratio > 1.5:
        if price > prev_price:
            buy_score += 1; buy_details.append(f"Volume spike ({vol_ratio:.1f}x) + up")
        else:
            sell_score += 1; sell_details.append(f"Volume spike ({vol_ratio:.1f}x) + down")

    # 7. Momentum
    roc5 = ((price - closes[-6]) / closes[-6]) * 100 if n > 5 else 0
    if roc5 > 2:
        buy_score += 1; buy_details.append(f"Strong momentum +{roc5:.1f}%")
    if roc5 < -2:
        sell_score += 1; sell_details.append(f"Weak momentum {roc5:.1f}%")

    # 8. Support/Resistance
    recent_low = min(lows[-20:])
    recent_high = max(highs[-20:])
    rng = recent_high - recent_low
    if rng > 0:
        pos = (price - recent_low) / rng
        if pos < 0.15 and price > prev_price:
            buy_score += 1; buy_details.append("Bouncing off support")
        if pos > 0.85 and price < prev_price:
            sell_score += 1; sell_details.append("Rejecting from resistance")

    signal = None
    score = 0
    if buy_score >= MIN_SCORE_BUY and buy_score > sell_score + 1:
        signal = "BUY"
        score = buy_score
    elif sell_score >= MIN_SCORE_SELL and sell_score > buy_score + 1:
        signal = "SELL"
        score = sell_score

    return {
        "signal": signal,
        "score": score,
        "buy_score": buy_score,
        "sell_score": sell_score,
        "rsi": rsi_val,
        "macd": macd_val,
        "price": price,
        "atr_pct": atr_pct,
        "vol_ratio": vol_ratio,
        "details": buy_details if signal == "BUY" else sell_details if signal == "SELL" else [],
    }


def combine_timeframe_signals(results: dict) -> dict | None:
    signals: dict[str, dict] = {}
    for tf, analysis in results.items():
        if not analysis.get("signal"):
            continue
        weight = 2 if tf == "1h" else 1.5 if tf == "15m" else 1
        sig = analysis["signal"]
        if sig not in signals:
            signals[sig] = {"total_score": 0, "timeframes": [], "details": [], "price": analysis["price"], "rsi": analysis["rsi"]}
        signals[sig]["total_score"] += analysis["score"] * weight
        signals[sig]["timeframes"].append(tf)
        signals[sig]["details"].extend(f"[{tf}] {d}" for d in analysis["details"])

    best = None
    best_score = 0
    for sig, data in signals.items():
        if data["total_score"] > best_score:
            best = {"signal": sig, **data}
            best_score = data["total_score"]
    return best


# ============================================
# SCANNER CLASS
# ============================================

class SignalScanner:
    def __init__(
        self,
        fetch_market_data: Callable,
        add_log: Callable,
        inject_signal: Callable | None = None,
    ):
        self.fetch_market_data = fetch_market_data
        self.add_log = add_log
        self.inject_signal = inject_signal or (lambda s: None)
        self._task: asyncio.Task | None = None
        self.enabled = True
        self.last_signal_time: dict[str, float] = {}
        self.scan_count = 0
        self.signals: list[dict] = []
        self.last_scan_results: dict[str, dict] = {}

    def start(self):
        if self._task:
            return
        self.add_log("[Signal Scanner] Auto-scanner started", "SPECIAL")
        self._task = asyncio.ensure_future(self._loop())

    def stop(self):
        if self._task:
            self._task.cancel()
            self._task = None
        self.add_log("[Signal Scanner] Auto-scanner stopped", "INFO")

    async def _loop(self):
        while self.enabled:
            try:
                await self.scan()
            except Exception as e:
                logger.error(f"Scan error: {e}")
            await asyncio.sleep(SCAN_INTERVAL_S)

    async def scan(self):
        self.scan_count += 1
        results: dict[str, dict] = {}

        for ticker in TICKERS:
            results[ticker] = {}
            for tf in SCAN_TIMEFRAMES:
                try:
                    candles = await self.fetch_market_data(ticker, tf)
                    if candles and len(candles) >= 50:
                        results[ticker][tf] = analyze_candles(candles, ticker)
                except Exception:
                    pass

        new_signals = 0
        for ticker, tf_results in results.items():
            combined = combine_timeframe_signals(tf_results)
            self.last_scan_results[ticker] = {
                "timestamp": time.time() * 1000,
                "timeframes": tf_results,
                "combined": combined,
            }

            if not combined:
                continue

            last_t = self.last_signal_time.get(ticker, 0)
            if time.time() - last_t < SIGNAL_COOLDOWN_S:
                continue

            if len(combined["timeframes"]) < 2 and combined["total_score"] < 8:
                continue

            signal_obj = {
                "id": time.time() + hash(ticker) % 1000 / 1000,
                "signal": combined["signal"],
                "ticker": ticker,
                "instrument": ticker.replace("USD", "_USD"),
                "price": combined.get("price", 0),
                "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "timeframe": "+".join(combined["timeframes"]),
                "source": "auto-scanner",
                "score": combined["total_score"],
                "rsi": combined.get("rsi"),
                "details": combined["details"][:6],
                "confidence": min(100, round(combined["total_score"] * 8)),
            }

            self.signals = [signal_obj] + self.signals[:MAX_SIGNALS - 1]
            self.last_signal_time[ticker] = time.time()
            self.inject_signal(signal_obj)
            new_signals += 1

            detail_str = ", ".join(combined["details"][:3])
            self.add_log(
                f"[Scanner] {combined['signal']} {ticker} | Score: {combined['total_score']:.0f} | {'+'.join(combined['timeframes'])} | {detail_str}",
                "BUY" if combined["signal"] == "BUY" else "SELL",
            )

    def get_signals(self, limit: int = MAX_SIGNALS) -> list[dict]:
        return self.signals[:limit]

    def get_status(self) -> dict:
        return {
            "enabled": self.enabled,
            "scanning": self._task is not None,
            "scan_count": self.scan_count,
            "signal_count": len(self.signals),
            "tickers": TICKERS,
            "timeframes": SCAN_TIMEFRAMES,
            "interval_s": SCAN_INTERVAL_S,
            "cooldown_s": SIGNAL_COOLDOWN_S,
            "last_results": {
                ticker: {
                    "signal": data.get("combined", {}).get("signal") if data.get("combined") else None,
                    "score": data.get("combined", {}).get("total_score", 0) if data.get("combined") else 0,
                    "timeframes": data.get("combined", {}).get("timeframes", []) if data.get("combined") else [],
                    "timestamp": data.get("timestamp"),
                }
                for ticker, data in self.last_scan_results.items()
            },
        }
