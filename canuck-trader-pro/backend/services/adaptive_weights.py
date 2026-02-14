"""
Adaptive Strategy Weights Service
Port of services/adaptiveWeights.js.

Tracks per-strategy performance and dynamically adjusts allocations.
Uses exponential decay so recent performance matters more than old.
"""

import time
import logging

logger = logging.getLogger("adaptive_weights")

STRATEGIES = [
    "TREND", "BREAKOUT", "WHALE", "CONFLUENCE", "MOMENTUM", "DIVERGENCE", "ADAPTIVE",
    "SWING", "DCA", "GRID", "ARB", "PAIR_LONG", "MM",
]
BASE_WEIGHT = 1.0 / len(STRATEGIES)
EMA_ALPHA = 0.1

_strategy_stats: dict[str, dict] = {}


def _get_or_create(strategy: str) -> dict:
    if strategy not in _strategy_stats:
        _strategy_stats[strategy] = {
            "strategy": strategy,
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "total_pnl": 0.0,
            "recent_pnls": [],
            "weight": BASE_WEIGHT,
            "ema_win_rate": 0.5,
            "ema_pnl": 0.0,
            "last_update": time.time() * 1000,
        }
    return _strategy_stats[strategy]


# Initialize all
for _s in STRATEGIES:
    _get_or_create(_s)


def record_strategy_result(strategy: str, pnl: float):
    stats = _get_or_create(strategy)
    stats["trades"] += 1
    stats["total_pnl"] += pnl
    if pnl > 0:
        stats["wins"] += 1
    elif pnl < 0:
        stats["losses"] += 1

    stats["recent_pnls"].append(pnl)
    if len(stats["recent_pnls"]) > 50:
        stats["recent_pnls"].pop(0)

    win_result = 1 if pnl > 0 else 0
    stats["ema_win_rate"] = stats["ema_win_rate"] * (1 - EMA_ALPHA) + win_result * EMA_ALPHA
    stats["ema_pnl"] = stats["ema_pnl"] * (1 - EMA_ALPHA) + pnl * EMA_ALPHA
    stats["last_update"] = time.time() * 1000

    _recalculate_weights()


def _recalculate_weights():
    all_stats = list(_strategy_stats.values())
    scores = []

    for stats in all_stats:
        if stats["trades"] < 3:
            scores.append({"strategy": stats["strategy"], "score": 1.0})
            continue

        win_rate_score = stats["ema_win_rate"]

        active = [s for s in all_stats if s["trades"] >= 3]
        all_pnls = [s["ema_pnl"] for s in active] if active else [0]
        max_pnl = max(max(all_pnls), 0.001)
        min_pnl = min(min(all_pnls), -0.001)
        pnl_range = max_pnl - min_pnl or 1
        pnl_score = (stats["ema_pnl"] - min_pnl) / pnl_range

        recent5 = stats["recent_pnls"][-5:]
        recent_wins = sum(1 for p in recent5 if p > 0)
        streak_score = recent_wins / len(recent5) if recent5 else 0.5

        score = win_rate_score * 0.4 + pnl_score * 0.4 + streak_score * 0.2
        scores.append({"strategy": stats["strategy"], "score": max(0.05, score)})

    total_score = sum(item["score"] for item in scores)
    for item in scores:
        stats = _strategy_stats.get(item["strategy"])
        if stats:
            adaptive_weight = item["score"] / total_score
            stats["weight"] = adaptive_weight * 0.5 + BASE_WEIGHT * 0.5


def get_strategy_weight(strategy: str) -> float:
    stats = _strategy_stats.get(strategy)
    return stats["weight"] if stats else BASE_WEIGHT


def get_all_weights() -> dict:
    weights = {}
    for key, stats in _strategy_stats.items():
        weights[key] = {
            "weight": round(stats["weight"], 4),
            "trades": stats["trades"],
            "win_rate": f"{stats['wins'] / stats['trades'] * 100:.1f}%" if stats["trades"] > 0 else "N/A",
            "ema_win_rate": f"{stats['ema_win_rate'] * 100:.1f}%",
            "total_pnl": f"{stats['total_pnl']:.4f}",
            "ema_pnl": f"{stats['ema_pnl']:.6f}",
        }
    return weights


def adjust_position_size(strategy: str, base_amount: float, portfolio_value: float) -> float:
    weight = get_strategy_weight(strategy)
    normalized = weight / BASE_WEIGHT
    mult = max(0.3, min(2.5, normalized))
    adjusted = base_amount * mult
    return min(adjusted, portfolio_value * 0.25)


def get_strategy_ranking() -> list[dict]:
    ranked = sorted(
        [s for s in _strategy_stats.values() if s["trades"] >= 3],
        key=lambda s: s["weight"],
        reverse=True,
    )
    return [
        {
            "rank": i + 1,
            "strategy": s["strategy"],
            "weight": f"{s['weight'] * 100:.1f}%",
            "trades": s["trades"],
            "win_rate": f"{s['wins'] / s['trades'] * 100:.1f}%" if s["trades"] > 0 else "N/A",
            "pnl": f"{s['total_pnl']:.4f}",
        }
        for i, s in enumerate(ranked)
    ]


def is_strategy_throttled(strategy: str) -> bool:
    stats = _strategy_stats.get(strategy)
    if not stats or stats["trades"] < 15:
        return False
    return stats["weight"] < BASE_WEIGHT * 0.15


# ============================================
# STATE EXPORT / IMPORT
# ============================================

def export_state() -> dict:
    data = {}
    for key, stats in _strategy_stats.items():
        data[key] = {
            "strategy": stats["strategy"],
            "trades": stats["trades"],
            "wins": stats["wins"],
            "losses": stats["losses"],
            "total_pnl": stats["total_pnl"],
            "recent_pnls": stats["recent_pnls"][-50:],
            "weight": stats["weight"],
            "ema_win_rate": stats["ema_win_rate"],
            "ema_pnl": stats["ema_pnl"],
            "last_update": stats["last_update"],
        }
    return data


def import_state(state: dict | None):
    if not state:
        return
    for key, saved in state.items():
        stats = _get_or_create(key)
        for field in ["trades", "wins", "losses", "total_pnl", "weight", "ema_win_rate", "ema_pnl", "last_update"]:
            if field in saved:
                stats[field] = saved[field]
        stats["recent_pnls"] = saved.get("recent_pnls", [])


def get_status() -> dict:
    return {
        "weights": get_all_weights(),
        "ranking": get_strategy_ranking(),
        "base_weight": f"{BASE_WEIGHT:.4f}",
        "total_strategies": len(_strategy_stats),
        "active_strategies": sum(1 for s in _strategy_stats.values() if s["trades"] > 0),
    }
