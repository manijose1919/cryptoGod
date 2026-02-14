"""
Circuit Breaker + Kelly Position Sizing Service
Port of services/circuitBreaker.js.

Auto-pauses trading after:
  - 6 consecutive losses (Beast Mode)
  - 15% daily drawdown (Beast Mode)
  - 12 losses in 1 hour (Beast Mode)

Kelly Criterion: calculates optimal position size from historical win rate & avg win/loss.
"""

import time
import logging
from datetime import date

logger = logging.getLogger("circuit_breaker")

# ============================================
# STATE
# ============================================

_trade_history: list[dict] = []
_consecutive_losses = 0
_consecutive_wins = 0
_daily_pnl = 0.0
_daily_start_balance = 0.0
_daily_date = date.today().isoformat()
_paused_until = 0.0
_pause_reason = ""
_pause_count = 0

CONFIG = {
    "MAX_CONSECUTIVE_LOSSES": 6,
    "MAX_DAILY_DRAWDOWN_PERCENT": 15,
    "MAX_HOURLY_LOSSES": 12,
    "PAUSE_DURATION_MS": 3 * 60 * 1000,  # 3 min
    "ESCALATING_PAUSE": False,
}


# ============================================
# CIRCUIT BREAKER
# ============================================

def record_trade_result(pnl: float, strategy: str = "UNKNOWN", ticker: str = ""):
    global _consecutive_losses, _consecutive_wins, _daily_pnl, _daily_date, _pause_count

    today = date.today().isoformat()
    if today != _daily_date:
        _daily_pnl = 0.0
        _daily_date = today
        _pause_count = 0

    _trade_history.append({"time": time.time() * 1000, "pnl": pnl, "strategy": strategy, "ticker": ticker})
    _daily_pnl += pnl

    if len(_trade_history) > 500:
        del _trade_history[: len(_trade_history) - 500]

    if pnl < 0:
        _consecutive_losses += 1
        _consecutive_wins = 0
    elif pnl > 0:
        _consecutive_wins += 1
        _consecutive_losses = 0

    _check_triggers()


def set_daily_balance(balance: float):
    global _daily_start_balance
    _daily_start_balance = balance


def _check_triggers():
    global _paused_until, _pause_reason, _consecutive_losses

    if _consecutive_losses >= CONFIG["MAX_CONSECUTIVE_LOSSES"]:
        _trigger_pause(f"{_consecutive_losses} consecutive losses")
        return

    if _daily_start_balance > 0:
        dd_pct = (-_daily_pnl / _daily_start_balance) * 100
        if dd_pct >= CONFIG["MAX_DAILY_DRAWDOWN_PERCENT"]:
            _trigger_pause(f"Daily drawdown {dd_pct:.1f}% exceeds {CONFIG['MAX_DAILY_DRAWDOWN_PERCENT']}%")
            return

    one_hour_ago = time.time() * 1000 - 3600000
    hourly_losses = sum(1 for t in _trade_history if t["time"] > one_hour_ago and t["pnl"] < 0)
    if hourly_losses >= CONFIG["MAX_HOURLY_LOSSES"]:
        _trigger_pause(f"{hourly_losses} losses in last hour")


def _trigger_pause(reason: str):
    global _paused_until, _pause_reason, _pause_count, _consecutive_losses
    _pause_count += 1
    duration = CONFIG["PAUSE_DURATION_MS"] * _pause_count if CONFIG["ESCALATING_PAUSE"] else CONFIG["PAUSE_DURATION_MS"]
    _paused_until = time.time() * 1000 + duration
    _pause_reason = reason
    _consecutive_losses = 0
    logger.warning(f"Trading paused for {duration // 60000}min. Reason: {reason}")


def should_pause_trading() -> dict:
    now = time.time() * 1000
    if now < _paused_until:
        remaining = int((_paused_until - now) / 60000) + 1
        return {"paused": True, "reason": _pause_reason, "remaining_minutes": remaining}
    return {"paused": False, "reason": "", "remaining_minutes": 0}


def reset_circuit_breaker():
    global _paused_until, _pause_reason, _consecutive_losses, _pause_count
    _paused_until = 0
    _pause_reason = ""
    _consecutive_losses = 0
    _pause_count = 0


# ============================================
# KELLY CRITERION
# ============================================

def calculate_kelly_fraction(min_trades: int = 5) -> dict:
    completed = [t for t in _trade_history if t["pnl"] != 0]
    if len(completed) < min_trades:
        return {
            "kelly_full": 0.1,
            "kelly_half": 0.05,
            "kelly_quarter": 0.025,
            "recommended": 0.05,
            "confidence": "LOW",
            "stats": {"trades": len(completed), "min_required": min_trades},
        }

    wins = [t for t in completed if t["pnl"] > 0]
    losses = [t for t in completed if t["pnl"] < 0]
    win_rate = len(wins) / len(completed)
    avg_win = sum(t["pnl"] for t in wins) / len(wins) if wins else 0
    avg_loss = abs(sum(t["pnl"] for t in losses) / len(losses)) if losses else 1

    b = avg_win / avg_loss if avg_loss > 0 else 1
    kelly_full = max(0, (b * win_rate - (1 - win_rate)) / b)
    kelly_half = kelly_full / 2
    kelly_quarter = kelly_full / 4
    recommended = min(0.40, kelly_half)

    confidence = "LOW"
    if len(completed) >= 50:
        confidence = "HIGH"
    elif len(completed) >= 20:
        confidence = "MEDIUM"

    pf = "N/A"
    if losses and avg_loss > 0:
        pf = f"{avg_win * len(wins) / (avg_loss * len(losses)):.2f}"

    return {
        "kelly_full": min(1, kelly_full),
        "kelly_half": min(0.5, kelly_half),
        "kelly_quarter": min(0.25, kelly_quarter),
        "recommended": recommended,
        "confidence": confidence,
        "stats": {
            "trades": len(completed),
            "win_rate": f"{win_rate * 100:.1f}%",
            "avg_win": f"{avg_win:.4f}",
            "avg_loss": f"{avg_loss:.4f}",
            "profit_factor": pf,
            "expectancy": f"{win_rate * avg_win - (1 - win_rate) * avg_loss:.4f}",
        },
    }


def get_kelly_position_size(portfolio_value: float) -> dict:
    kelly = calculate_kelly_fraction()
    return {
        "amount": portfolio_value * kelly["recommended"],
        "fraction": kelly["recommended"],
        "kelly": kelly,
    }


def get_strategy_kelly(strategy: str, portfolio_value: float) -> dict:
    strat_trades = [t for t in _trade_history if t["strategy"] == strategy and t["pnl"] != 0]
    if len(strat_trades) < 5:
        return {"amount": portfolio_value * 0.05, "fraction": 0.05, "confidence": "LOW"}

    wins = [t for t in strat_trades if t["pnl"] > 0]
    losses = [t for t in strat_trades if t["pnl"] < 0]
    win_rate = len(wins) / len(strat_trades)
    avg_win = sum(t["pnl"] for t in wins) / len(wins) if wins else 0
    avg_loss = abs(sum(t["pnl"] for t in losses) / len(losses)) if losses else 1
    b = avg_win / avg_loss if avg_loss > 0 else 1
    kelly_half = max(0, (b * win_rate - (1 - win_rate)) / b) / 2
    recommended = min(0.25, kelly_half)
    return {
        "amount": portfolio_value * recommended,
        "fraction": recommended,
        "confidence": "HIGH" if len(strat_trades) >= 20 else "MEDIUM",
    }


# ============================================
# STATE EXPORT / IMPORT
# ============================================

def export_state() -> dict:
    return {
        "trade_history": _trade_history[-500:],
        "consecutive_losses": _consecutive_losses,
        "consecutive_wins": _consecutive_wins,
        "daily_pnl": _daily_pnl,
        "daily_start_balance": _daily_start_balance,
        "daily_date": _daily_date,
        "paused_until": _paused_until,
        "pause_reason": _pause_reason,
        "pause_count": _pause_count,
    }


def import_state(state: dict | None):
    global _consecutive_losses, _consecutive_wins, _daily_pnl, _daily_start_balance
    global _daily_date, _paused_until, _pause_reason, _pause_count
    if not state:
        return
    _trade_history.clear()
    _trade_history.extend(state.get("trade_history", []))
    _consecutive_losses = state.get("consecutive_losses", 0)
    _consecutive_wins = state.get("consecutive_wins", 0)
    _daily_pnl = state.get("daily_pnl", 0)
    _daily_start_balance = state.get("daily_start_balance", 0)
    _daily_date = state.get("daily_date", date.today().isoformat())
    _paused_until = state.get("paused_until", 0)
    _pause_reason = state.get("pause_reason", "")
    _pause_count = state.get("pause_count", 0)


def get_status() -> dict:
    pause_check = should_pause_trading()
    kelly = calculate_kelly_fraction()
    one_hour_ago = time.time() * 1000 - 3600000
    hourly = [t for t in _trade_history if t["time"] > one_hour_ago]
    hourly_wins = sum(1 for t in hourly if t["pnl"] > 0)
    hourly_losses = sum(1 for t in hourly if t["pnl"] < 0)

    return {
        "paused": pause_check["paused"],
        "pause_reason": pause_check["reason"],
        "pause_remaining_min": pause_check["remaining_minutes"],
        "consecutive_losses": _consecutive_losses,
        "consecutive_wins": _consecutive_wins,
        "daily_pnl": f"{_daily_pnl:.4f}",
        "daily_drawdown_percent": f"{(-_daily_pnl / _daily_start_balance * 100):.2f}" if _daily_start_balance > 0 else "0",
        "hourly": {"trades": len(hourly), "wins": hourly_wins, "losses": hourly_losses},
        "total_trades": len(_trade_history),
        "pause_count": _pause_count,
        "kelly": kelly,
    }
