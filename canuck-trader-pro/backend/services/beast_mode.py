"""
Beast Mode - Maximum Performance Trading Engine
Port of services/beastMode.js.

1. Detects market regime per ticker (UPTREND/SIDEWAYS/DOWNTREND)
2. Routes to matching strategy pools per regime
3. Adjusts position sizes based on ATR volatility
4. Compounds on winning streaks, scales back on losses
5. Sets dynamic take-profit/stop-loss per ticker volatility
6. Tracks hot/cold streaks to drive aggression level
"""

import time
import logging

logger = logging.getLogger("beast_mode")

# ============================================
# STATE
# ============================================

_streak_state = {
    "consecutive_wins": 0,
    "consecutive_losses": 0,
    "total_wins": 0,
    "total_losses": 0,
    "total_pnl": 0.0,
    "best_streak": 0,
    "worst_streak": 0,
    "recent_trades": [],
    "session_start_balance": 0.0,
    "current_balance": 0.0,
    "peak_balance": 0.0,
}

_regime_cache: dict[str, dict] = {}
REGIME_CACHE_TTL = 30  # seconds


# ============================================
# HELPERS
# ============================================

def _calc_ema(data: list[float], period: int) -> list[float]:
    if not data:
        return []
    k = 2.0 / (period + 1)
    result = [data[0]]
    for i in range(1, len(data)):
        result.append(data[i] * k + result[-1] * (1 - k))
    return result


def _calc_rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
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
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1 + rs))


def _calc_atr(candles: list[dict], period: int = 14) -> float:
    """Calculate ATR from OHLCV candle dicts with keys h, l, c."""
    if len(candles) < period + 1:
        ranges = [c["h"] - c["l"] for c in candles]
        return sum(ranges) / len(ranges) if ranges else 0
    trs = []
    for i in range(1, len(candles)):
        tr = max(
            candles[i]["h"] - candles[i]["l"],
            abs(candles[i]["h"] - candles[i - 1]["c"]),
            abs(candles[i]["l"] - candles[i - 1]["c"]),
        )
        trs.append(tr)
    recent = trs[-period:]
    return sum(recent) / len(recent)


# ============================================
# 1. REGIME DETECTION
# ============================================

def get_market_regime(candles: list[dict], ticker: str = "") -> str:
    if ticker:
        cached = _regime_cache.get(ticker)
        if cached and time.time() - cached["timestamp"] < REGIME_CACHE_TTL:
            return cached["regime"]

    if len(candles) < 35:
        return "SIDEWAYS"

    closes = [c["c"] for c in candles]
    ema10 = _calc_ema(closes, 10)
    ema30 = _calc_ema(closes, 30)
    rsi = _calc_rsi(closes, 14)

    ema10_now = ema10[-1]
    ema30_now = ema30[-1]
    ema10_prev = ema10[-6] if len(ema10) > 5 else ema10[0]
    ema10_slope = (ema10_now - ema10_prev) / ema10_prev * 100 if ema10_prev else 0
    spread = (ema10_now - ema30_now) / ema30_now * 100 if ema30_now else 0

    if spread > 0.1 and ema10_slope > 0 and rsi > 45:
        regime = "UPTREND"
    elif spread < -0.1 and ema10_slope < 0 and rsi < 55:
        regime = "DOWNTREND"
    else:
        regime = "SIDEWAYS"

    if ticker:
        _regime_cache[ticker] = {
            "regime": regime,
            "timestamp": time.time(),
            "ema10": ema10_now,
            "ema30": ema30_now,
            "rsi": rsi,
            "spread": f"{spread:.3f}",
            "slope": f"{ema10_slope:.3f}",
        }

    return regime


# ============================================
# 2. STRATEGY POOL BY REGIME
# ============================================

def get_strategy_pool(regime: str) -> list[str]:
    pools = {
        "UPTREND": ["TREND", "MOMENTUM", "SWING", "ADAPTIVE"],
        "SIDEWAYS": ["GRID", "PAIR_LONG", "ARB", "MM", "DCA"],
        "DOWNTREND": ["DCA", "GRID", "ADAPTIVE"],
    }
    return pools.get(regime, ["TREND", "MOMENTUM", "ADAPTIVE"])


def is_strategy_allowed_for_regime(strategy: str, regime: str) -> bool:
    return strategy in get_strategy_pool(regime)


# ============================================
# 3. VOLATILITY-ADJUSTED POSITION SIZING
# ============================================

def adjust_for_volatility(base_amount: float, candles: list[dict]) -> dict:
    if len(candles) < 10:
        return {"amount": base_amount, "multiplier": 1.0, "atr_percent": 0}

    atr = _calc_atr(candles, 14)
    price = candles[-1]["c"]
    atr_pct = (atr / price) * 100 if price else 0

    if atr_pct > 2.0:
        mult = 0.6
    elif atr_pct > 1.0:
        mult = 0.8
    elif atr_pct > 0.5:
        mult = 1.0
    elif atr_pct > 0.2:
        mult = 1.2
    else:
        mult = 1.4

    return {"amount": base_amount * mult, "multiplier": mult, "atr_percent": atr_pct}


# ============================================
# 4. COMPOUNDING ACCELERATOR
# ============================================

def get_compound_multiplier() -> dict:
    s = _streak_state
    mult = 1.0
    reason = "Neutral"

    if s["consecutive_wins"] >= 5:
        mult = 1.5
        reason = f"Hot streak: {s['consecutive_wins']} wins -> 1.5x"
    elif s["consecutive_wins"] >= 3:
        mult = 1.25
        reason = f"Win streak: {s['consecutive_wins']} wins -> 1.25x"

    if s["consecutive_losses"] >= 5:
        mult = 0.5
        reason = f"Cold streak: {s['consecutive_losses']} losses -> 0.5x"
    elif s["consecutive_losses"] >= 3:
        mult = 0.7
        reason = f"Losing: {s['consecutive_losses']} losses -> 0.7x"

    if s["session_start_balance"] > 0 and s["current_balance"] > 0:
        growth = (s["current_balance"] - s["session_start_balance"]) / s["session_start_balance"] * 100
        if growth >= 30:
            mult *= 1.3
            reason += f" | Account +{growth:.0f}% -> 1.3x bonus"
        elif growth >= 15:
            mult *= 1.15
            reason += f" | Account +{growth:.0f}% -> 1.15x bonus"
        elif growth < -10:
            mult *= 0.8
            reason += f" | Account {growth:.0f}% -> 0.8x safety"

    mult = max(0.4, min(2.0, mult))
    return {"multiplier": mult, "reason": reason}


# ============================================
# 5. DYNAMIC PROFIT TARGETS
# ============================================

def get_dynamic_targets(candles: list[dict]) -> dict:
    if len(candles) < 10:
        return {"take_profit_pct": 1.5, "stop_loss_pct": 0.6, "regime": "NORMAL"}

    atr = _calc_atr(candles, 14)
    price = candles[-1]["c"]
    atr_pct = (atr / price) * 100 if price else 0

    if atr_pct > 1.5:
        return {"take_profit_pct": 3.0, "stop_loss_pct": 1.2, "regime": "HIGH_VOL"}    # 2.5:1 R:R
    elif atr_pct > 0.5:
        return {"take_profit_pct": 2.0, "stop_loss_pct": 0.8, "regime": "NORMAL"}      # 2.5:1 R:R
    else:
        return {"take_profit_pct": 1.5, "stop_loss_pct": 0.6, "regime": "LOW_VOL"}     # 2.5:1 R:R


def check_dynamic_exit(position: dict, current_price: float, candles: list[dict]) -> dict:
    open_price = position["open_price"]
    pnl_pct = ((current_price - open_price) / open_price) * 100 if open_price else 0
    fee_adjusted = pnl_pct - 0.15
    targets = get_dynamic_targets(candles)
    hold_ms = time.time() * 1000 - position.get("entry_time", time.time() * 1000)
    hold_min = hold_ms / 60000

    if fee_adjusted >= targets["take_profit_pct"]:
        return {
            "should_exit": True,
            "reason": f"[BEAST-TP] +{fee_adjusted:.2f}% after fees >= {targets['take_profit_pct']}% target ({targets['regime']})",
            "pnl_percent": pnl_pct,
        }
    if pnl_pct <= -targets["stop_loss_pct"]:
        return {
            "should_exit": True,
            "reason": f"[BEAST-SL] {pnl_pct:.2f}% <= -{targets['stop_loss_pct']}% stop ({targets['regime']})",
            "pnl_percent": pnl_pct,
        }
    if hold_min > 15 and fee_adjusted < 0:
        return {
            "should_exit": True,
            "reason": f"[BEAST-TIME] Stale position: {fee_adjusted:.2f}% after fees, {hold_min:.0f}min",
            "pnl_percent": pnl_pct,
        }
    return {"should_exit": False, "reason": "", "pnl_percent": pnl_pct}


# ============================================
# 6. STREAK TRACKER
# ============================================

def record_trade_result(pnl: float, ticker: str = "", strategy: str = ""):
    s = _streak_state
    s["total_pnl"] += pnl
    s["recent_trades"].append({"pnl": pnl, "time": time.time() * 1000, "ticker": ticker, "strategy": strategy})
    if len(s["recent_trades"]) > 50:
        s["recent_trades"].pop(0)

    if pnl > 0:
        s["consecutive_wins"] += 1
        s["consecutive_losses"] = 0
        s["total_wins"] += 1
        s["best_streak"] = max(s["best_streak"], s["consecutive_wins"])
    elif pnl < 0:
        s["consecutive_losses"] += 1
        s["consecutive_wins"] = 0
        s["total_losses"] += 1
        s["worst_streak"] = max(s["worst_streak"], s["consecutive_losses"])


def update_balance(balance: float):
    s = _streak_state
    s["current_balance"] = balance
    s["peak_balance"] = max(s["peak_balance"], balance)
    if s["session_start_balance"] == 0:
        s["session_start_balance"] = balance


def set_session_balance(balance: float):
    s = _streak_state
    s["session_start_balance"] = balance
    s["current_balance"] = balance
    s["peak_balance"] = balance


# ============================================
# STATE EXPORT / IMPORT
# ============================================

def export_state() -> dict:
    return {**_streak_state, "recent_trades": _streak_state["recent_trades"][-50:]}


def import_state(state: dict | None):
    if not state:
        return
    for key in _streak_state:
        if key in state:
            _streak_state[key] = state[key]
    if not isinstance(_streak_state["recent_trades"], list):
        _streak_state["recent_trades"] = []


def get_status() -> dict:
    s = _streak_state
    total = s["total_wins"] + s["total_losses"]
    win_rate = f"{s['total_wins'] / total * 100:.1f}" if total > 0 else "0.0"
    compound = get_compound_multiplier()

    regimes = {}
    for ticker, data in _regime_cache.items():
        regimes[ticker] = {
            "regime": data["regime"],
            "ema10": f"{data.get('ema10', 0):.2f}",
            "ema30": f"{data.get('ema30', 0):.2f}",
            "rsi": f"{data.get('rsi', 0):.1f}",
            "spread": data.get("spread", "0"),
            "slope": data.get("slope", "0"),
            "age_seconds": round(time.time() - data["timestamp"]),
        }

    growth_pct = "0.00%"
    if s["session_start_balance"] > 0:
        g = (s["current_balance"] - s["session_start_balance"]) / s["session_start_balance"] * 100
        growth_pct = f"{g:.2f}%"

    return {
        "enabled": True,
        "streak": {
            "consecutive_wins": s["consecutive_wins"],
            "consecutive_losses": s["consecutive_losses"],
            "total_wins": s["total_wins"],
            "total_losses": s["total_losses"],
            "win_rate": win_rate + "%",
            "best_streak": s["best_streak"],
            "worst_streak": s["worst_streak"],
            "total_pnl": f"{s['total_pnl']:.4f}",
        },
        "compounding": compound,
        "balance": {
            "session_start": f"{s['session_start_balance']:.2f}",
            "current": f"{s['current_balance']:.2f}",
            "peak": f"{s['peak_balance']:.2f}",
            "growth_percent": growth_pct,
        },
        "regimes": regimes,
        "recent_trades": [
            {
                "pnl": f"{t['pnl']:.4f}",
                "ticker": t.get("ticker", ""),
                "strategy": t.get("strategy", ""),
                "age_seconds": round((time.time() * 1000 - t["time"]) / 1000),
            }
            for t in s["recent_trades"][-10:]
        ],
    }
