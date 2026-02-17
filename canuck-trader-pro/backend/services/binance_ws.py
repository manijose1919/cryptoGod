"""
Binance WebSocket Streaming Service

Streams real-time trade, kline, and depth data from Binance public WebSocket.
No API key required — uses public endpoints only.
Feeds data to anomaly detector and provides real-time price updates.
"""

import asyncio
import json
import logging
import time
import threading
from typing import Callable, Optional
from collections import defaultdict, deque

import websockets

logger = logging.getLogger("binance_ws")

BINANCE_WS_URL = "wss://stream.binance.com:9443/ws"
BINANCE_STREAM_URL = "wss://stream.binance.com:9443/stream"

# Map our symbols to Binance format: BTC/USD -> btcusdt (Binance uses USDT)
SYMBOL_MAP = {
    "BTC/USD": "btcusdt",
    "ETH/USD": "ethusdt",
    "XRP/USD": "xrpusdt",
    "BNB/USD": "bnbusdt",
    "SOL/USD": "solusdt",
    "ADA/USD": "adausdt",
    "DOGE/USD": "dogeusdt",
    "LINK/USD": "linkusdt",
    "DOT/USD": "dotusdt",
    "AVAX/USD": "avaxusdt",
}


class BinanceWebSocket:
    """Streams real-time market data from Binance."""

    def __init__(self, symbols: list[str] | None = None):
        self.symbols = symbols or list(SYMBOL_MAP.keys())
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # Latest data per symbol
        self._prices: dict[str, float] = {}
        self._trades: dict[str, deque] = defaultdict(lambda: deque(maxlen=100))
        self._klines: dict[str, dict] = {}
        self._depth: dict[str, dict] = {}
        self._last_update: dict[str, float] = {}

        # Callbacks
        self._on_trade: list[Callable] = []
        self._on_kline: list[Callable] = []
        self._on_depth: list[Callable] = []

        # Stats
        self._message_count = 0
        self._start_time = 0
        self._reconnect_count = 0

    def on_trade(self, callback: Callable):
        self._on_trade.append(callback)

    def on_kline(self, callback: Callable):
        self._on_kline.append(callback)

    def on_depth(self, callback: Callable):
        self._on_depth.append(callback)

    def start(self):
        """Start WebSocket streaming in a background thread."""
        if self._running:
            return
        self._running = True
        self._start_time = time.time()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="binance-ws")
        self._thread.start()
        logger.info(f"Binance WebSocket started for {len(self.symbols)} symbols")

    def stop(self):
        """Stop streaming."""
        self._running = False
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        logger.info("Binance WebSocket stopped")

    def get_price(self, symbol: str) -> Optional[float]:
        return self._prices.get(symbol)

    def get_recent_trades(self, symbol: str, limit: int = 50) -> list:
        trades = list(self._trades.get(symbol, []))
        return trades[-limit:]

    def get_depth_snapshot(self, symbol: str) -> dict:
        return self._depth.get(symbol, {})

    def get_latest_kline(self, symbol: str) -> dict:
        return self._klines.get(symbol, {})

    def _run_loop(self):
        """Run the async event loop in a thread."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect_with_retry())
        except Exception as e:
            logger.error(f"WebSocket loop error: {e}")
        finally:
            self._loop.close()

    async def _connect_with_retry(self):
        """Connect with exponential backoff retry."""
        backoff = 5
        max_backoff = 300  # 5 minutes max (was 60s, reduces log spam when geoblocked)

        while self._running:
            try:
                await self._stream()
                backoff = 5  # Reset only on successful stream (not on every failure)
            except Exception as e:
                self._reconnect_count += 1
                # Only log every 10th retry to avoid spam when geoblocked
                if self._reconnect_count <= 3 or self._reconnect_count % 10 == 0:
                    logger.warning(f"WebSocket disconnected ({e}), retry #{self._reconnect_count}, next in {backoff}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)

    async def _stream(self):
        """Main streaming loop — subscribes to combined stream."""
        # Build stream names
        streams = []
        for symbol in self.symbols:
            bn_sym = SYMBOL_MAP.get(symbol)
            if not bn_sym:
                continue
            streams.append(f"{bn_sym}@trade")
            streams.append(f"{bn_sym}@kline_1m")
            streams.append(f"{bn_sym}@depth5@1000ms")

        url = f"{BINANCE_STREAM_URL}?streams={'/'.join(streams)}"

        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            logger.info(f"Connected to Binance WebSocket ({len(streams)} streams)")
            while self._running:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=30)
                    self._process_message(json.loads(msg))
                except asyncio.TimeoutError:
                    # Send ping to keep alive
                    await ws.ping()
                except websockets.ConnectionClosed:
                    raise
                except Exception as e:
                    logger.debug(f"Message processing error: {e}")

    def _process_message(self, data: dict):
        """Route incoming message to appropriate handler."""
        self._message_count += 1
        stream = data.get("stream", "")
        payload = data.get("data", {})

        if "@trade" in stream:
            self._handle_trade(stream, payload)
        elif "@kline" in stream:
            self._handle_kline(stream, payload)
        elif "@depth" in stream:
            self._handle_depth(stream, payload)

    def _handle_trade(self, stream: str, data: dict):
        """Process trade event."""
        bn_sym = stream.split("@")[0]
        symbol = self._reverse_symbol(bn_sym)
        if not symbol:
            return

        price = float(data.get("p", 0))
        qty = float(data.get("q", 0))
        is_buyer_maker = data.get("m", False)

        self._prices[symbol] = price
        self._last_update[symbol] = time.time()

        trade = {
            "price": price,
            "quantity": qty,
            "side": "SELL" if is_buyer_maker else "BUY",
            "time": data.get("T", int(time.time() * 1000)),
        }
        self._trades[symbol].append(trade)

        for cb in self._on_trade:
            try:
                cb(symbol, trade)
            except Exception:
                pass

    def _handle_kline(self, stream: str, data: dict):
        """Process kline/candle event."""
        bn_sym = stream.split("@")[0]
        symbol = self._reverse_symbol(bn_sym)
        if not symbol:
            return

        k = data.get("k", {})
        kline = {
            "open": float(k.get("o", 0)),
            "high": float(k.get("h", 0)),
            "low": float(k.get("l", 0)),
            "close": float(k.get("c", 0)),
            "volume": float(k.get("v", 0)),
            "closed": k.get("x", False),
            "time": k.get("t", 0),
        }
        self._klines[symbol] = kline

        if kline["closed"]:
            for cb in self._on_kline:
                try:
                    cb(symbol, kline)
                except Exception:
                    pass

    def _handle_depth(self, stream: str, data: dict):
        """Process order book depth snapshot."""
        bn_sym = stream.split("@")[0]
        symbol = self._reverse_symbol(bn_sym)
        if not symbol:
            return

        bids = [(float(p), float(q)) for p, q in data.get("bids", [])]
        asks = [(float(p), float(q)) for p, q in data.get("asks", [])]

        self._depth[symbol] = {
            "bids": bids,
            "asks": asks,
            "bid_total": sum(q for _, q in bids),
            "ask_total": sum(q for _, q in asks),
            "spread": (asks[0][0] - bids[0][0]) / bids[0][0] * 100 if bids and asks else 0,
            "time": time.time(),
        }

        for cb in self._on_depth:
            try:
                cb(symbol, self._depth[symbol])
            except Exception:
                pass

    def _reverse_symbol(self, bn_sym: str) -> Optional[str]:
        """Convert Binance symbol back to our format."""
        for our, theirs in SYMBOL_MAP.items():
            if theirs == bn_sym:
                return our
        return None

    def get_status(self) -> dict:
        uptime = time.time() - self._start_time if self._start_time else 0
        return {
            "running": self._running,
            "symbols": len(self.symbols),
            "messages_received": self._message_count,
            "messages_per_sec": round(self._message_count / max(uptime, 1), 1),
            "reconnects": self._reconnect_count,
            "uptime_seconds": round(uptime, 0),
            "prices_available": len(self._prices),
            "latest_prices": {s: round(p, 2) for s, p in list(self._prices.items())[:5]},
        }


# Singleton
_instance: Optional[BinanceWebSocket] = None


def get_binance_ws() -> BinanceWebSocket:
    global _instance
    if _instance is None:
        _instance = BinanceWebSocket()
    return _instance
