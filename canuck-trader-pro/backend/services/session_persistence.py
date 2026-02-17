"""
Session State Persistence

Saves/restores full trading bot state for 24/7 VPS operation.
Handles graceful shutdown (SIGTERM) and crash recovery.
Auto-saves every 60 seconds when bot is active.
"""

import json
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("session_persistence")

STATE_PATH = Path("data/session_state.json")


def save_full_state(trader) -> bool:
    """Save complete bot state to disk."""
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)

        state = {
            "version": 2,
            "saved_at": time.time(),
            "saved_at_human": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),

            # Trading state
            "cycle_count": trader.cycle_count,
            "trades_today": trader.trades_today,
            "wins_today": trader.wins_today,
            "losses_today": trader.losses_today,
            "paused": trader.paused,
            "start_time": trader.start_time,

            # Risk manager state
            "balance": trader.risk.balance,
            "daily_pnl": trader.risk.daily_pnl,
            "peak_balance": trader.risk.peak_balance,
            "daily_start_balance": trader.risk.daily_start_balance,
            "positions": {
                s: {
                    "side": p["side"],
                    "entry": p["entry"],
                    "size_usd": p["size_usd"],
                    "stop": p["stop"],
                    "target": p["target"],
                    "initial_stop": p.get("initial_stop", p["stop"]),
                    "high_water": p.get("high_water", p["entry"]),
                    "low_water": p.get("low_water", p["entry"]),
                    "partial_exited": p.get("partial_exited", False),
                    "open_time": p.get("open_time", time.time()),
                    "top_signal": p.get("top_signal", ""),
                }
                for s, p in trader.risk.positions.items()
            },
            "trade_history": trader.risk.trade_history[-100:] if hasattr(trader.risk, 'trade_history') else [],

            # Adaptive weights
            "adaptive_weights": _safe_export("adaptive_weights"),

            # Circuit breaker
            "circuit_breaker": _safe_export("circuit_breaker"),

            # Beast mode
            "beast_mode": _safe_export("beast_mode"),

            # Adaptive threshold
            "adaptive_conf_threshold": trader._adaptive_conf_threshold,
            "conf_threshold_history": trader._conf_threshold_history[-200:],

            # Bot was active
            "was_active": not trader.paused,
        }

        # Write atomically (write to temp, then rename)
        temp_path = STATE_PATH.with_suffix(".tmp")
        with open(temp_path, "w") as f:
            json.dump(state, f, indent=2, default=str)
        temp_path.replace(STATE_PATH)

        logger.debug(f"Session state saved ({len(state['positions'])} positions, balance=${state['balance']:.2f})")
        return True
    except Exception as e:
        logger.error(f"Failed to save session state: {e}")
        return False


def restore_full_state(trader) -> dict:
    """Restore bot state from disk. Returns summary of what was restored."""
    if not STATE_PATH.exists():
        return {"restored": False, "reason": "No saved state found"}

    try:
        with open(STATE_PATH) as f:
            state = json.load(f)

        age_seconds = time.time() - state.get("saved_at", 0)
        age_hours = age_seconds / 3600

        # Don't restore if state is older than 24 hours
        if age_hours > 24:
            return {"restored": False, "reason": f"State too old ({age_hours:.1f}h)"}

        # Restore trading counters
        trader.cycle_count = state.get("cycle_count", 0)
        trader.trades_today = state.get("trades_today", 0)
        trader.wins_today = state.get("wins_today", 0)
        trader.losses_today = state.get("losses_today", 0)

        # Restore risk manager
        trader.risk.balance = state.get("balance", trader.risk.balance)
        trader.risk.daily_pnl = state.get("daily_pnl", 0)
        trader.risk.peak_balance = state.get("peak_balance", trader.risk.balance)
        trader.risk.daily_start_balance = state.get("daily_start_balance", trader.risk.balance)

        # Restore positions
        positions = state.get("positions", {})
        for symbol, pos_data in positions.items():
            trader.risk.positions[symbol] = {
                "side": pos_data["side"],
                "entry": pos_data["entry"],
                "size_usd": pos_data["size_usd"],
                "stop": pos_data["stop"],
                "target": pos_data["target"],
                "initial_stop": pos_data.get("initial_stop", pos_data["stop"]),
                "high_water": pos_data.get("high_water", pos_data["entry"]),
                "low_water": pos_data.get("low_water", pos_data["entry"]),
                "partial_exited": pos_data.get("partial_exited", False),
                "open_time": pos_data.get("open_time", time.time()),
                "top_signal": pos_data.get("top_signal", ""),
            }

        # Restore adaptive weights
        _safe_import("adaptive_weights", state.get("adaptive_weights"))

        # Restore adaptive threshold
        trader._adaptive_conf_threshold = state.get("adaptive_conf_threshold", 40)
        trader._conf_threshold_history = state.get("conf_threshold_history", [])

        # Restore was_active flag for info, but do NOT auto-resume
        # User must click "Start Simulation" in the UI to begin trading
        was_active = state.get("was_active", False)
        # trader.paused stays True — requires manual start via UI

        summary = {
            "restored": True,
            "age_hours": round(age_hours, 1),
            "balance": state.get("balance", 0),
            "positions_restored": len(positions),
            "trades_today": state.get("trades_today", 0),
            "was_active": was_active,
            "saved_at": state.get("saved_at_human", "unknown"),
        }

        logger.info(f"Session restored: ${summary['balance']:.2f}, {summary['positions_restored']} positions, {summary['age_hours']:.1f}h old")
        return summary

    except Exception as e:
        logger.error(f"Failed to restore session state: {e}")
        return {"restored": False, "reason": str(e)}


def get_session_status(trader) -> dict:
    """Get current session info for dashboard."""
    uptime = time.time() - trader.start_time
    return {
        "uptime_seconds": round(uptime),
        "uptime_human": _format_duration(uptime),
        "cycle_count": trader.cycle_count,
        "trades_today": trader.trades_today,
        "wins_today": trader.wins_today,
        "losses_today": trader.losses_today,
        "balance": round(trader.risk.balance, 2),
        "daily_pnl": round(trader.risk.daily_pnl, 2),
        "positions_open": len(trader.risk.positions),
        "paused": trader.paused,
        "last_save": _get_last_save_time(),
        "adaptive_threshold": trader._adaptive_conf_threshold,
    }


def _format_duration(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    return f"{h}h {m}m"


def _get_last_save_time() -> str:
    if STATE_PATH.exists():
        try:
            with open(STATE_PATH) as f:
                state = json.load(f)
            return state.get("saved_at_human", "unknown")
        except Exception:
            pass
    return "never"


def _safe_export(module_name: str):
    """Try to export state from a service module."""
    try:
        from services import adaptive_weights, circuit_breaker, beast_mode
        module_map = {
            "adaptive_weights": adaptive_weights,
            "circuit_breaker": circuit_breaker,
            "beast_mode": beast_mode,
        }
        mod = module_map.get(module_name)
        if mod and hasattr(mod, "export_state"):
            return mod.export_state()
    except Exception:
        pass
    return None


def _safe_import(module_name: str, state):
    """Try to import state into a service module."""
    if not state:
        return
    try:
        from services import adaptive_weights, circuit_breaker, beast_mode
        module_map = {
            "adaptive_weights": adaptive_weights,
            "circuit_breaker": circuit_breaker,
            "beast_mode": beast_mode,
        }
        mod = module_map.get(module_name)
        if mod and hasattr(mod, "import_state"):
            mod.import_state(state)
    except Exception:
        pass
