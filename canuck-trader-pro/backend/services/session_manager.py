"""
Session Manager
Manages trading sessions, credentials, and persistent state.
Port of services/sessionManager.js.
"""

import json
import logging
import os
import time

logger = logging.getLogger("session_manager")

_sessions: dict[str, "TradingSession"] = {}


class TradingSession:
    def __init__(self, api_key: str, secret_key: str):
        self.api_key = api_key
        self.secret_key = secret_key
        self.created_at = time.time()
        self.last_activity = time.time()
        self.id = os.urandom(32).hex()

    def update_activity(self):
        self.last_activity = time.time()

    def is_expired(self, max_age_s: float = 86400) -> bool:
        return time.time() - self.last_activity > max_age_s


def create_session(api_key: str, secret_key: str) -> str:
    session = TradingSession(api_key, secret_key)
    _sessions[session.id] = session
    return session.id


def get_session(session_id: str) -> TradingSession | None:
    session = _sessions.get(session_id)
    if session:
        session.update_activity()
        return session
    return None


def delete_session(session_id: str) -> bool:
    return _sessions.pop(session_id, None) is not None


def clean_expired_sessions() -> int:
    expired = [sid for sid, s in _sessions.items() if s.is_expired()]
    for sid in expired:
        del _sessions[sid]
    return len(expired)


def persist_bot_state(state: dict) -> bool:
    """Persist global bot state to database settings."""
    try:
        from services.database_service import set_setting
        state["updated_at"] = int(time.time() * 1000)
        set_setting("bot_state_persistent", json.dumps(state))
        return True
    except Exception as e:
        logger.error(f"Persist state error: {e}")
        return False


def restore_bot_state() -> dict | None:
    """Restore global bot state from database settings."""
    try:
        from services.database_service import get_setting
        raw = get_setting("bot_state_persistent")
        if not raw:
            return None
        state = json.loads(raw)
        # Don't restore if older than 7 days
        if time.time() * 1000 - state.get("updated_at", 0) > 7 * 86400 * 1000:
            return None
        return state
    except Exception as e:
        logger.error(f"Restore state error: {e}")
        return None


def get_active_session_ids() -> list[str]:
    return list(_sessions.keys())
