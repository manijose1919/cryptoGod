"""
WebSocket Relay Service
Broadcasts candle/trade updates to connected frontend clients via FastAPI WebSocket.
"""

import asyncio
import json
import logging
import time

from fastapi import WebSocket

logger = logging.getLogger("ws_relay")


class WebSocketRelay:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self.clients.add(ws)
        logger.info(f"WebSocket client connected ({len(self.clients)} total)")

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self.clients.discard(ws)
        logger.info(f"WebSocket client disconnected ({len(self.clients)} total)")

    async def broadcast(self, message: dict):
        """Send a message to all connected clients."""
        if not self.clients:
            return
        data = json.dumps(message)
        disconnected = []
        async with self._lock:
            for ws in self.clients:
                try:
                    await ws.send_text(data)
                except Exception:
                    disconnected.append(ws)

        for ws in disconnected:
            async with self._lock:
                self.clients.discard(ws)

    async def broadcast_prices(self, prices: dict):
        await self.broadcast({"type": "prices", "data": prices, "ts": time.time()})

    async def broadcast_candle(self, ticker: str, candle: dict):
        await self.broadcast({"type": "candle", "ticker": ticker, "data": candle, "ts": time.time()})

    async def broadcast_trade(self, trade: dict):
        await self.broadcast({"type": "trade", "data": trade, "ts": time.time()})

    async def broadcast_signal(self, signal: dict):
        await self.broadcast({"type": "signal", "data": signal, "ts": time.time()})

    async def broadcast_heartbeat(self):
        await self.broadcast({"type": "heartbeat", "ts": time.time(), "clients": len(self.clients)})

    async def broadcast_portfolio(self, portfolio: dict):
        await self.broadcast({"type": "portfolio", "data": portfolio, "ts": time.time()})

    async def broadcast_log(self, level: str, message: str):
        await self.broadcast({"type": "log", "level": level, "message": message, "ts": time.time()})

    async def broadcast_scan(self, scan_data: list):
        await self.broadcast({"type": "scan", "data": scan_data, "ts": time.time()})

    async def broadcast_cycle_summary(self, summary: dict):
        await self.broadcast({"type": "cycle_summary", "data": summary, "ts": time.time()})

    async def broadcast_ml_update(self, ml_status: dict):
        await self.broadcast({"type": "ml_update", "data": ml_status, "ts": time.time()})

    @property
    def client_count(self) -> int:
        return len(self.clients)
