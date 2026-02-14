"""
Telegram Alert Service

Sends trade notifications, drawdown alerts, and daily summaries via Telegram Bot API.
Uses native urllib — no extra packages needed.
Rate-limited to 1 message per second.

Setup:
1. Create a bot via @BotFather on Telegram
2. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
"""

import logging
import time
import os
import json
import threading
from collections import deque
from urllib.request import Request, urlopen
from urllib.error import URLError
from typing import Optional

logger = logging.getLogger("telegram")

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

RATE_LIMIT_SEC = 1.0  # Min interval between messages


class TelegramAlerts:
    """Send alerts to Telegram with rate limiting."""

    def __init__(self, bot_token: str = "", chat_id: str = ""):
        self.bot_token = bot_token or BOT_TOKEN
        self.chat_id = chat_id or CHAT_ID
        self._enabled = bool(self.bot_token and self.chat_id)
        self._queue: deque = deque(maxlen=50)
        self._last_send_time = 0
        self._send_count = 0
        self._error_count = 0
        self._lock = threading.Lock()

        if self._enabled:
            logger.info("Telegram alerts enabled")
        else:
            logger.info("Telegram alerts disabled (no BOT_TOKEN/CHAT_ID)")

    def _send_message(self, text: str, parse_mode: str = "HTML"):
        """Send a message via Telegram Bot API."""
        if not self._enabled:
            return False

        # Rate limiting
        now = time.time()
        elapsed = now - self._last_send_time
        if elapsed < RATE_LIMIT_SEC:
            time.sleep(RATE_LIMIT_SEC - elapsed)

        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        payload = json.dumps({
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True,
        }).encode("utf-8")

        try:
            req = Request(url, data=payload, headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=10) as resp:
                self._last_send_time = time.time()
                self._send_count += 1
                return True
        except URLError as e:
            self._error_count += 1
            logger.warning(f"Telegram send failed: {e}")
            return False
        except Exception as e:
            self._error_count += 1
            logger.warning(f"Telegram error: {e}")
            return False

    def _send_async(self, text: str):
        """Send message in background thread to not block trading."""
        threading.Thread(target=self._send_message, args=(text,), daemon=True).start()

    # ── Alert Methods ──────────────────────────────────────────────────

    def alert_trade_entry(self, trade: dict):
        """Alert when a new trade is opened."""
        symbol = trade.get("symbol", "?")
        action = trade.get("action", "?")
        entry = trade.get("entry", 0)
        size = trade.get("size_usd", 0)
        confidence = trade.get("confidence", 0)
        strategy = trade.get("top_signal", "?")

        emoji = "\U0001f7e2" if action == "BUY" else "\U0001f534"
        text = (
            f"{emoji} <b>Trade Entry</b>\n"
            f"<b>{action}</b> {symbol}\n"
            f"Price: ${entry:,.2f}\n"
            f"Size: ${size:,.2f}\n"
            f"Confidence: {confidence}%\n"
            f"Strategy: {strategy}"
        )
        self._send_async(text)

    def alert_trade_exit(self, trade: dict):
        """Alert when a trade is closed."""
        symbol = trade.get("symbol", "?")
        pnl_pct = trade.get("pnl_pct", 0)
        pnl_usd = trade.get("pnl_usd", 0)
        reason = trade.get("reason", "?")

        emoji = "\U0001f4b0" if pnl_pct > 0 else "\U0001f4a5"
        text = (
            f"{emoji} <b>Trade Exit</b>\n"
            f"{symbol}: {pnl_pct:+.2f}% (${pnl_usd:+.2f})\n"
            f"Reason: {reason}"
        )
        self._send_async(text)

    def alert_drawdown(self, current_dd: float, max_dd: float):
        """Alert on significant drawdown."""
        text = (
            f"\U000026a0 <b>Drawdown Alert</b>\n"
            f"Current: {current_dd:.1f}%\n"
            f"Max: {max_dd:.1f}%\n"
            f"Risk level: {'HIGH' if current_dd > 5 else 'MODERATE'}"
        )
        self._send_async(text)

    def alert_circuit_breaker(self, reason: str):
        """Alert when circuit breaker triggers."""
        text = (
            f"\U0001f6d1 <b>Circuit Breaker Triggered</b>\n"
            f"Reason: {reason}\n"
            f"Trading paused automatically"
        )
        self._send_async(text)

    def alert_session_summary(self, summary: dict):
        """Send daily/session summary."""
        trades = summary.get("total_trades", 0)
        pnl = summary.get("total_pnl", 0)
        win_rate = summary.get("win_rate", 0)
        balance = summary.get("balance", 0)

        emoji = "\U0001f4c8" if pnl > 0 else "\U0001f4c9"
        text = (
            f"{emoji} <b>Session Summary</b>\n"
            f"Trades: {trades}\n"
            f"P&L: ${pnl:+.2f}\n"
            f"Win Rate: {win_rate:.1f}%\n"
            f"Balance: ${balance:,.2f}"
        )
        self._send_async(text)

    def alert_whale_movement(self, symbol: str, direction: str, details: str = ""):
        """Alert on detected whale/smart money movement."""
        emoji = "\U0001f433"
        text = (
            f"{emoji} <b>Whale Alert</b>\n"
            f"{symbol}: {direction}\n"
            f"{details}"
        )
        self._send_async(text)

    def send_custom(self, message: str):
        """Send a custom message."""
        self._send_async(message)

    def test_connection(self) -> dict:
        """Test the Telegram bot connection."""
        if not self._enabled:
            return {"success": False, "reason": "Not configured (missing BOT_TOKEN or CHAT_ID)"}

        ok = self._send_message("\U00002705 Canuck-Trader-Pro connected!")
        return {
            "success": ok,
            "bot_token_set": bool(self.bot_token),
            "chat_id_set": bool(self.chat_id),
        }

    def get_status(self) -> dict:
        return {
            "enabled": self._enabled,
            "messages_sent": self._send_count,
            "errors": self._error_count,
            "bot_configured": bool(self.bot_token),
            "chat_configured": bool(self.chat_id),
        }


# Singleton
_instance: Optional[TelegramAlerts] = None


def get_telegram() -> TelegramAlerts:
    global _instance
    if _instance is None:
        _instance = TelegramAlerts()
    return _instance
