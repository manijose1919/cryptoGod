"""
Profit Methods Service
Port of services/profitMethods.js.

6 profit methods running alongside day trading:
1. Swing Trading - Higher TF analysis, S/R levels, R:R filtering, trailing stops
2. Smart DCA - Timer-based buys, smart dip/pump multiplier, auto take-profit
3. Grid Trading - Range detection, buy/sell at grid levels, sideways market profits
4. Market Making - Virtual bid/ask spread capture, inventory management
5. Arbitrage - Stat arb via z-score, cross-pair divergence
6. Pair Trading - Correlation tracking, z-score entry/exit, market-neutral
"""

import time
import math
import logging

logger = logging.getLogger("profit_methods")

# ============================================
# CONFIGURATION
# ============================================

PM_CONFIG = {
    "GRID": {
        "ENABLED": True, "GRID_COUNT": 10,
        "PORTFOLIO_ALLOCATION": 0.20, "MIN_RANGE_PERCENT": 1.0,
    },
    "DCA": {
        "ENABLED": True, "INTERVAL_S": 120, "BASE_ALLOCATION": 0.02,
        "MAX_DIP_MULTIPLIER": 3.0, "MIN_PUMP_MULTIPLIER": 0.3,
        "TAKE_PROFIT_PERCENT": 5, "DIP_THRESHOLD": 1.0, "PUMP_THRESHOLD": 1.0,
    },
    "ARBITRAGE": {
        "ENABLED": True, "MIN_SPREAD_ZSCORE": 1.2,
        "MIN_CONFIDENCE": 50, "PORTFOLIO_ALLOCATION": 0.10,
    },
    "PAIR_TRADING": {
        "ENABLED": True, "ENTRY_ZSCORE": 2.0, "EXIT_ZSCORE": 0.5,
        "MIN_CORRELATION": 0.5, "PORTFOLIO_ALLOCATION": 0.10,
    },
    "SWING": {
        "ENABLED": True, "MIN_CONFIDENCE": 25, "MIN_RISK_REWARD": 1.5,
        "PORTFOLIO_ALLOCATION": 0.20, "TRAILING_STOP_TRIGGER": 2,
    },
    "MARKET_MAKING": {
        "ENABLED": True, "PORTFOLIO_ALLOCATION": 0.05,
        "ORDER_EXPIRY_S": 300, "MIN_SPREAD_PERCENT": 0.01,
    },
}

CORRELATED_PAIRS = [
    ("BTCUSD", "ETHUSD"), ("ETHUSD", "SOLUSD"), ("BTCUSD", "SOLUSD"),
    ("DOGEUSD", "ADAUSD"), ("BTCUSD", "XRPUSD"), ("ETHUSD", "LINKUSD"),
    ("SOLUSD", "AVAXUSD"), ("BTCUSD", "ADAUSD"), ("ETHUSD", "DOTUSD"),
]

# Internal state
_swing_positions: dict = {}
_dca_positions: dict = {}
_grid_states: dict = {}
_mm_states: dict = {}
_pair_ratios: dict = {}
_pair_correlations: dict = {}

_method_stats = {
    "swing": {"trades": 0, "pnl": 0.0},
    "dca": {"trades": 0, "pnl": 0.0},
    "grid": {"trades": 0, "pnl": 0.0},
    "mm": {"trades": 0, "pnl": 0.0},
    "arb": {"trades": 0, "pnl": 0.0},
    "pair": {"trades": 0, "pnl": 0.0},
}


# ============================================
# HELPERS
# ============================================

def _ema(data: list[float], period: int) -> list[float]:
    if not data:
        return []
    k = 2.0 / (period + 1)
    result = [data[0]]
    for i in range(1, len(data)):
        result.append(data[i] * k + result[-1] * (1 - k))
    return result


def _pearson_correlation(x: list[float], y: list[float]) -> float:
    n = min(len(x), len(y))
    if n < 10:
        return 0
    xs, ys = x[-n:], y[-n:]
    xm = sum(xs) / n
    ym = sum(ys) / n
    cov = xv = yv = 0.0
    for i in range(n):
        dx = xs[i] - xm
        dy = ys[i] - ym
        cov += dx * dy
        xv += dx * dx
        yv += dy * dy
    d = math.sqrt(xv * yv)
    return cov / d if d > 0 else 0


def _z_score(values: list[float]) -> dict:
    if len(values) < 2:
        return {"mean": 0, "std": 0, "z": 0, "current": 0}
    current = values[-1]
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    std = math.sqrt(var)
    return {"mean": mean, "std": std, "z": (current - mean) / std if std > 0 else 0, "current": current}


# ============================================
# 1. SWING TRADING
# ============================================

def _find_key_levels(candles: list[dict]) -> dict:
    if len(candles) < 20:
        p = candles[-1]["c"] if candles else 0
        return {"support": p * 0.97, "resistance": p * 1.03}

    price = candles[-1]["c"]
    pivots = []
    for i in range(2, len(candles) - 2):
        h = candles[i]["h"]
        if h > candles[i - 1]["h"] and h > candles[i - 2]["h"] and h > candles[i + 1]["h"] and h > candles[i + 2]["h"]:
            pivots.append(h)
        l = candles[i]["l"]
        if l < candles[i - 1]["l"] and l < candles[i - 2]["l"] and l < candles[i + 1]["l"] and l < candles[i + 2]["l"]:
            pivots.append(l)

    supports = sorted([p for p in pivots if p < price], reverse=True)
    resistances = sorted([p for p in pivots if p > price])
    return {
        "support": supports[0] if supports else price * 0.97,
        "resistance": resistances[0] if resistances else price * 1.03,
    }


def analyze_swing_setup(ticker: str, candles: list[dict]) -> dict:
    if len(candles) < 30:
        return {"has_setup": False, "setup": None}

    price = candles[-1]["c"]
    levels = _find_key_levels(candles)
    closes = [c["c"] for c in candles]
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50)

    signals = []
    above_ema20 = price > ema20[-1]
    above_ema50 = price > ema50[-1]
    emas_bullish = ema20[-1] > ema50[-1]
    signals.append({"bullish": above_ema20 and above_ema50 and emas_bullish, "weight": 25})

    near_support = (price - levels["support"]) / levels["support"] < 0.015 if levels["support"] > 0 else False
    bouncing = near_support and price > candles[-2]["c"]
    signals.append({"bullish": bouncing, "weight": 20})

    avg_vol = sum(c.get("v", 0) for c in candles[-20:]) / 20
    recent_vol = sum(c.get("v", 0) for c in candles[-3:]) / 3
    signals.append({"bullish": recent_vol > avg_vol * 1.2, "weight": 15})

    change10 = ((price - closes[-11]) / closes[-11] * 100) if len(closes) > 10 else 0
    signals.append({"bullish": change10 > 0.5, "weight": 15})

    long_trend = price > ema50[-1] if len(closes) > 50 else True
    signals.append({"bullish": long_trend, "weight": 15})

    prev20_high = max(c["h"] for c in candles[-40:-20]) if len(candles) >= 40 else price * 1.01
    is_breakout = price > prev20_high and change10 > 1
    signals.append({"bullish": is_breakout, "weight": 10})

    confidence = sum(s["weight"] for s in signals if s["bullish"])
    if confidence < PM_CONFIG["SWING"]["MIN_CONFIDENCE"]:
        return {"has_setup": False, "setup": None}

    target_price = levels["resistance"]
    stop_loss = levels["support"] * 0.995
    target_pct = ((target_price - price) / price) * 100
    risk_pct = ((price - stop_loss) / price) * 100
    rr = target_pct / risk_pct if risk_pct > 0 else 0

    if rr < PM_CONFIG["SWING"]["MIN_RISK_REWARD"] or target_pct < 1:
        return {"has_setup": False, "setup": None}

    return {
        "has_setup": True,
        "setup": {
            "ticker": ticker, "entry_price": price, "target_price": target_price,
            "stop_loss": stop_loss, "target_pct": target_pct, "risk_pct": risk_pct,
            "risk_reward": rr, "confidence": confidence,
            "reason": f"Swing: R:R={rr:.1f}, tgt={target_pct:.1f}%",
        },
    }


def check_swing_exit(ticker: str, current_price: float) -> dict:
    pos = _swing_positions.get(ticker)
    if not pos:
        return {"should_exit": False, "reason": "", "pnl_percent": 0}
    pnl_pct = ((current_price - pos["entry_price"]) / pos["entry_price"]) * 100
    pos["highest_price"] = max(pos.get("highest_price", current_price), current_price)

    if current_price >= pos["target_price"]:
        return {"should_exit": True, "reason": f"Swing target: +{pnl_pct:.2f}%", "pnl_percent": pnl_pct}
    if current_price <= pos["stop_loss"]:
        return {"should_exit": True, "reason": f"Swing stop: {pnl_pct:.2f}%", "pnl_percent": pnl_pct}
    if pnl_pct > PM_CONFIG["SWING"]["TRAILING_STOP_TRIGGER"]:
        trailing = pos["entry_price"] * (1 + pnl_pct * 0.005)
        if current_price < trailing:
            return {"should_exit": True, "reason": f"Swing trail: +{pnl_pct:.2f}%", "pnl_percent": pnl_pct}
    return {"should_exit": False, "reason": "", "pnl_percent": pnl_pct}


# ============================================
# 2. SMART DCA
# ============================================

def process_dca(ticker: str, candles: list[dict], cash: float, budget: float) -> dict | None:
    if not PM_CONFIG["DCA"]["ENABLED"] or len(candles) < 5:
        return None

    base = budget * PM_CONFIG["DCA"]["BASE_ALLOCATION"]
    if base <= 0:
        return None

    pos = _dca_positions.get(ticker)
    last_buy = pos.get("last_buy_time", 0) if pos else 0
    if time.time() - last_buy < PM_CONFIG["DCA"]["INTERVAL_S"]:
        return None

    price = candles[-1]["c"]
    prices20 = [c["c"] for c in candles[-20:]]
    avg20 = sum(prices20) / len(prices20)
    recent_high = max(c["h"] for c in candles[-20:])
    dip = ((recent_high - price) / recent_high) * 100
    vs_avg = ((price - avg20) / avg20) * 100
    cfg = PM_CONFIG["DCA"]

    mult = 1.0
    reason = "Normal range -> 1x"
    if dip > cfg["DIP_THRESHOLD"] * 3:
        mult = cfg["MAX_DIP_MULTIPLIER"]
        reason = f"Major dip: {dip:.1f}% -> {mult}x"
    elif dip > cfg["DIP_THRESHOLD"] * 2:
        mult = 2.0
        reason = f"Moderate dip -> 2x"
    elif dip > cfg["DIP_THRESHOLD"]:
        mult = 1.5
        reason = f"Small dip -> 1.5x"
    elif vs_avg > cfg["PUMP_THRESHOLD"] * 2:
        mult = cfg["MIN_PUMP_MULTIPLIER"]
        reason = f"Above avg -> {mult}x"

    buy_amount = min(base * mult, cash * 0.1)
    if buy_amount < 0.10:
        return None

    return {"should_buy": True, "ticker": ticker, "amount": buy_amount, "multiplier": mult, "reason": f"DCA: {reason}", "price": price}


def record_dca_buy(ticker: str, price: float, quantity: float, amount: float):
    existing = _dca_positions.get(ticker)
    if existing:
        total_qty = existing["total_quantity"] + quantity
        total_inv = existing["total_invested"] + amount
        existing.update({
            "total_invested": total_inv, "total_quantity": total_qty,
            "avg_entry_price": total_inv / total_qty,
            "buys": existing["buys"] + 1,
            "last_buy_time": time.time(), "last_buy_price": price,
        })
    else:
        _dca_positions[ticker] = {
            "ticker": ticker, "total_invested": amount, "total_quantity": quantity,
            "avg_entry_price": price, "buys": 1,
            "last_buy_time": time.time(), "last_buy_price": price,
        }


def check_dca_take_profit(ticker: str, current_price: float) -> dict:
    pos = _dca_positions.get(ticker)
    if not pos:
        return {"should_sell": False, "pnl_percent": 0, "reason": ""}
    pnl = ((current_price - pos["avg_entry_price"]) / pos["avg_entry_price"]) * 100
    if pnl >= PM_CONFIG["DCA"]["TAKE_PROFIT_PERCENT"]:
        return {"should_sell": True, "pnl_percent": pnl, "reason": f"DCA TP: +{pnl:.2f}%"}
    return {"should_sell": False, "pnl_percent": pnl, "reason": ""}


# ============================================
# 3. GRID TRADING
# ============================================

def _detect_grid_range(candles: list[dict], grid_count: int = 10) -> dict:
    recent = min(50, len(candles))
    sorted_prices = sorted(c["c"] for c in candles[-recent:])
    p10 = sorted_prices[int(len(sorted_prices) * 0.05)]
    p90 = sorted_prices[int(len(sorted_prices) * 0.95)]
    return {
        "upper_bound": p90 * 1.005, "lower_bound": p10 * 0.995,
        "grid_count": grid_count,
        "grid_spacing": (p90 * 1.005 - p10 * 0.995) / grid_count,
        "investment_per_grid": 0,
    }


def init_grid(ticker: str, candles: list[dict], total_budget: float, grid_count: int = 10):
    config = _detect_grid_range(candles, grid_count)
    config["investment_per_grid"] = total_budget / grid_count
    price = candles[-1]["c"]
    levels = []
    for i in range(grid_count + 1):
        lp = config["lower_bound"] + i * config["grid_spacing"]
        levels.append({
            "price": lp, "type": "BUY" if lp < price else "SELL",
            "filled": False, "fill_price": None, "pnl": 0,
        })
    _grid_states[ticker] = {
        "config": config, "levels": levels, "total_pnl": 0,
        "filled_buys": 0, "filled_sells": 0, "is_active": True, "last_update": time.time(),
    }


def process_grid(ticker: str, candles: list[dict], cash: float) -> dict | None:
    if not PM_CONFIG["GRID"]["ENABLED"] or len(candles) < 10:
        return None
    price = candles[-1]["c"]
    prev_price = candles[-2]["c"]

    state = _grid_states.get(ticker)
    if not state:
        budget = cash * PM_CONFIG["GRID"]["PORTFOLIO_ALLOCATION"]
        if budget < 0.10:
            return None
        init_grid(ticker, candles, budget)
        state = _grid_states.get(ticker)
    else:
        ub, lb = state["config"]["upper_bound"], state["config"]["lower_bound"]
        buf = (ub - lb) * 0.1
        if price > ub + buf or price < lb - buf:
            budget = cash * PM_CONFIG["GRID"]["PORTFOLIO_ALLOCATION"]
            if budget < 0.10:
                return None
            init_grid(ticker, candles, budget)
            state = _grid_states.get(ticker)

    if not state or not state["is_active"]:
        return None

    for i, level in enumerate(state["levels"]):
        if level["filled"]:
            continue
        if level["type"] == "BUY" and prev_price > level["price"] and price <= level["price"]:
            level["filled"] = True
            level["fill_price"] = price
            state["filled_buys"] += 1
            if i + 1 < len(state["levels"]):
                state["levels"][i + 1]["type"] = "SELL"
                state["levels"][i + 1]["filled"] = False
            return {"action": "BUY", "ticker": ticker, "price": price, "amount": state["config"]["investment_per_grid"],
                    "reason": f"Grid BUY: level {i}"}
        if level["type"] == "SELL" and prev_price < level["price"] and price >= level["price"]:
            buy_levels = [l for l in state["levels"][:i] if l["filled"] and l["type"] == "BUY"]
            buy_price = buy_levels[-1]["fill_price"] if buy_levels else level["price"] - state["config"]["grid_spacing"]
            pnl = ((price - buy_price) / buy_price) * 100
            level["filled"] = True
            level["fill_price"] = price
            level["pnl"] = pnl
            state["filled_sells"] += 1
            state["total_pnl"] += pnl
            if i - 1 >= 0:
                state["levels"][i - 1]["type"] = "BUY"
                state["levels"][i - 1]["filled"] = False
            return {"action": "SELL", "ticker": ticker, "price": price, "amount": state["config"]["investment_per_grid"],
                    "reason": f"Grid SELL: level {i} (+{pnl:.2f}%)"}
    return None


# ============================================
# 4. MARKET MAKING (simplified)
# ============================================

def process_market_making(ticker: str, candles: list[dict], cash: float) -> dict | None:
    if not PM_CONFIG["MARKET_MAKING"]["ENABLED"] or len(candles) < 15:
        return None
    spreads = [((c["h"] - c["l"]) / c["c"]) * 100 for c in candles[-20:]]
    avg_spread = sum(spreads) / len(spreads)
    if avg_spread < PM_CONFIG["MARKET_MAKING"]["MIN_SPREAD_PERCENT"]:
        return None
    # Simplified: just report opportunity
    return None  # Real MM requires order book access


# ============================================
# 5. ARBITRAGE
# ============================================

def process_arbitrage(ticker_data: dict[str, list[dict]], cash: float) -> list[dict]:
    if not PM_CONFIG["ARBITRAGE"]["ENABLED"]:
        return []
    results = []
    for t1, t2 in CORRELATED_PAIRS:
        if t1 not in ticker_data or t2 not in ticker_data:
            continue
        c1 = [c["c"] for c in ticker_data[t1]]
        c2 = [c["c"] for c in ticker_data[t2]]
        if len(c1) < 20 or len(c2) < 20:
            continue
        n = min(len(c1), len(c2))
        ratios = [c1[i] / c2[i] for i in range(n) if c2[i] > 0]
        if len(ratios) < 10:
            continue
        zs = _z_score(ratios)
        if abs(zs["z"]) >= PM_CONFIG["ARBITRAGE"]["MIN_SPREAD_ZSCORE"]:
            results.append({
                "pair": f"{t1}/{t2}", "z_score": zs["z"],
                "action": "SELL_T1_BUY_T2" if zs["z"] > 0 else "BUY_T1_SELL_T2",
                "reason": f"Arb z={zs['z']:.2f} on {t1}/{t2}",
            })
    return results


# ============================================
# 6. PAIR TRADING
# ============================================

def process_pair_trading(ticker_data: dict[str, list[dict]], cash: float) -> list[dict]:
    if not PM_CONFIG["PAIR_TRADING"]["ENABLED"]:
        return []
    results = []
    for t1, t2 in CORRELATED_PAIRS:
        if t1 not in ticker_data or t2 not in ticker_data:
            continue
        c1 = [c["c"] for c in ticker_data[t1]]
        c2 = [c["c"] for c in ticker_data[t2]]
        n = min(len(c1), len(c2))
        if n < 20:
            continue
        corr = _pearson_correlation(c1[-n:], c2[-n:])
        if corr < PM_CONFIG["PAIR_TRADING"]["MIN_CORRELATION"]:
            continue
        spread = [c1[i] - c2[i] for i in range(n)]
        zs = _z_score(spread)
        if abs(zs["z"]) >= PM_CONFIG["PAIR_TRADING"]["ENTRY_ZSCORE"]:
            results.append({
                "pair": f"{t1}/{t2}", "correlation": corr, "z_score": zs["z"],
                "action": "SELL_T1_BUY_T2" if zs["z"] > 0 else "BUY_T1_SELL_T2",
                "reason": f"Pair z={zs['z']:.2f}, corr={corr:.2f}",
            })
    return results


# ============================================
# RUN ALL / STATUS
# ============================================

def run_profit_methods(ticker: str, candles: list[dict], cash: float, budget: float) -> list[dict]:
    actions = []
    swing = analyze_swing_setup(ticker, candles)
    if swing["has_setup"]:
        actions.append({"method": "SWING", "ticker": ticker, **swing["setup"]})

    dca = process_dca(ticker, candles, cash, budget)
    if dca:
        actions.append({"method": "DCA", **dca})

    grid = process_grid(ticker, candles, cash)
    if grid:
        actions.append({"method": "GRID", **grid})

    return actions


def check_profit_method_exits(ticker: str, current_price: float) -> list[dict]:
    exits = []
    swing_exit = check_swing_exit(ticker, current_price)
    if swing_exit["should_exit"]:
        exits.append({"method": "SWING", "ticker": ticker, **swing_exit})
    dca_exit = check_dca_take_profit(ticker, current_price)
    if dca_exit["should_sell"]:
        exits.append({"method": "DCA", "ticker": ticker, **dca_exit})
    return exits


def get_status() -> dict:
    return {
        "methods": PM_CONFIG,
        "stats": _method_stats,
        "swing_positions": len(_swing_positions),
        "dca_positions": len(_dca_positions),
        "grid_active": sum(1 for s in _grid_states.values() if s["is_active"]),
        "mm_active": sum(1 for s in _mm_states.values()),
        "pair_positions": len(_pair_correlations),
    }


def export_state() -> dict:
    return {
        "swing_positions": _swing_positions,
        "dca_positions": _dca_positions,
        "method_stats": _method_stats,
    }


def import_state(state: dict | None):
    if not state:
        return
    _swing_positions.update(state.get("swing_positions", {}))
    _dca_positions.update(state.get("dca_positions", {}))
    for k, v in state.get("method_stats", {}).items():
        if k in _method_stats:
            _method_stats[k] = v
