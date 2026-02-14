"""
WebSocket Multiplexer Service

Manages concurrent WebSocket connections to Binance, OKX, and Bybit for
real-time market data aggregation. All connections are to public endpoints
(no API keys required). Data from USDT pairs on external exchanges is used
for analytics only — actual trading executes on Crypto.com with USD pairs.

Each exchange runs in its own thread with an independent asyncio event loop.
Provides unified callbacks, cross-exchange spread detection, and aggregated
trade flow analysis.
"""

import asyncio
import json
import logging
import time
import threading
from collections import defaultdict, deque
from typing import Callable, Optional

import websockets

logger = logging.getLogger("ws_multiplexer")

# ---------------------------------------------------------------------------
# Symbol mapping: internal format -> exchange-specific format
# We use USDT pairs on external exchanges for data only.
# ---------------------------------------------------------------------------

SUPPORTED_BASES = ["BTC", "ETH", "XRP", "BNB", "SOL", "ADA", "DOGE", "LINK", "DOT", "AVAX"]

# Internal uses slash format: "BTC/USD"
# We map to each exchange's convention (all USDT since we only read data)

def _build_symbol_maps():
    """Build forward and reverse maps for all supported symbols."""
    binance = {}   # "BTC/USD" -> "btcusdt"
    okx = {}       # "BTC/USD" -> "BTC-USDT"
    bybit = {}     # "BTC/USD" -> "BTCUSDT"
    for base in SUPPORTED_BASES:
        internal = f"{base}/USD"
        binance[internal] = f"{base.lower()}usdt"
        okx[internal] = f"{base}-USDT"
        bybit[internal] = f"{base}USDT"
    return binance, okx, bybit


BINANCE_SYMBOLS, OKX_SYMBOLS, BYBIT_SYMBOLS = _build_symbol_maps()

# Reverse maps for incoming message decoding
_BINANCE_REVERSE = {v: k for k, v in BINANCE_SYMBOLS.items()}
_OKX_REVERSE = {v: k for k, v in OKX_SYMBOLS.items()}
_BYBIT_REVERSE = {v: k for k, v in BYBIT_SYMBOLS.items()}

# ---------------------------------------------------------------------------
# Exchange WebSocket URLs
# ---------------------------------------------------------------------------

BINANCE_WS_URL = "wss://stream.binance.com:9443/stream"
OKX_WS_URL = "wss://ws.okx.com:8443/ws/v5/public"
BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/spot"

# ---------------------------------------------------------------------------
# Multiplexer
# ---------------------------------------------------------------------------

class WSMultiplexer:
    """
    Aggregates real-time WebSocket data from Binance, OKX, and Bybit.

    Each exchange connection runs in its own daemon thread with an independent
    asyncio event loop. Thread-safe data stores are protected by locks.
    """

    def __init__(self):
        # Subscribed symbols (internal format, e.g. "BTC/USD")
        self._symbols: list[str] = []
        self._symbols_lock = threading.Lock()

        # Per-exchange threads and loops
        self._threads: dict[str, threading.Thread] = {}
        self._loops: dict[str, asyncio.AbstractEventLoop] = {}
        self._running = False

        # ------------------------------------------------------------------
        # Thread-safe data stores
        # ------------------------------------------------------------------
        self._ticker_lock = threading.Lock()
        # {symbol: {exchange: {bid, ask, last, time}}}
        self._tickers: dict[str, dict[str, dict]] = defaultdict(dict)

        self._trade_lock = threading.Lock()
        # {symbol: deque of trade dicts} — unified across exchanges
        self._trades: dict[str, deque] = defaultdict(lambda: deque(maxlen=5000))

        self._orderbook_lock = threading.Lock()
        # {symbol: {exchange: {bids, asks, time}}}
        self._orderbooks: dict[str, dict[str, dict]] = defaultdict(dict)

        # Deduplication: set of (exchange, trade_id) — bounded LRU via deque
        self._seen_trade_ids: deque = deque(maxlen=50_000)
        self._seen_set: set = set()
        self._dedup_lock = threading.Lock()

        # Callbacks
        self._on_trade_cbs: list[Callable] = []
        self._on_ticker_cbs: list[Callable] = []
        self._on_orderbook_cbs: list[Callable] = []

        # Stats
        self._stats_lock = threading.Lock()
        self._stats: dict[str, dict] = {
            "binance": {"messages": 0, "connected": False, "reconnects": 0, "last_msg": 0.0},
            "okx": {"messages": 0, "connected": False, "reconnects": 0, "last_msg": 0.0},
            "bybit": {"messages": 0, "connected": False, "reconnects": 0, "last_msg": 0.0},
        }
        self._start_time = 0.0

    # ------------------------------------------------------------------
    # Callbacks
    # ------------------------------------------------------------------

    def on_trade(self, callback: Callable):
        """Register callback: callback(exchange, symbol, trade_dict)."""
        self._on_trade_cbs.append(callback)

    def on_ticker(self, callback: Callable):
        """Register callback: callback(exchange, symbol, ticker_dict)."""
        self._on_ticker_cbs.append(callback)

    def on_orderbook(self, callback: Callable):
        """Register callback: callback(exchange, symbol, orderbook_dict)."""
        self._on_orderbook_cbs.append(callback)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, symbols: list[str] | None = None):
        """Start WebSocket connections to all exchanges.

        Args:
            symbols: List of internal symbols, e.g. ["BTC/USD", "ETH/USD"].
                     Defaults to all supported symbols.
        """
        if self._running:
            logger.warning("Multiplexer already running")
            return

        with self._symbols_lock:
            if symbols:
                self._symbols = [s for s in symbols if s in BINANCE_SYMBOLS]
            else:
                self._symbols = [f"{b}/USD" for b in SUPPORTED_BASES]

        self._running = True
        self._start_time = time.time()

        exchanges = [
            ("binance", self._run_binance),
            ("okx", self._run_okx),
            ("bybit", self._run_bybit),
        ]
        for name, target in exchanges:
            t = threading.Thread(target=target, daemon=True, name=f"ws-{name}")
            self._threads[name] = t
            t.start()

        logger.info(
            f"WebSocket multiplexer started: {len(self._symbols)} symbols "
            f"across {len(exchanges)} exchanges"
        )

    def stop(self):
        """Gracefully disconnect all exchange WebSockets."""
        if not self._running:
            return
        self._running = False

        # Signal each event loop to stop
        for name, loop in self._loops.items():
            if loop and loop.is_running():
                loop.call_soon_threadsafe(loop.stop)

        # Wait for threads to finish (with timeout)
        for name, thread in self._threads.items():
            thread.join(timeout=5)
            if thread.is_alive():
                logger.warning(f"{name} thread did not exit cleanly")

        self._threads.clear()
        self._loops.clear()
        logger.info("WebSocket multiplexer stopped")

    def subscribe(self, symbol: str):
        """Add a symbol to all exchange feeds at runtime.

        For exchanges that support dynamic subscription, the new streams are
        added on-the-fly. Otherwise they take effect on next reconnect.
        """
        with self._symbols_lock:
            if symbol not in self._symbols and symbol in BINANCE_SYMBOLS:
                self._symbols.append(symbol)
                logger.info(f"Subscribed to {symbol}")
                # Trigger dynamic subscribe on exchanges that support it
                self._dynamic_subscribe(symbol)

    def unsubscribe(self, symbol: str):
        """Remove a symbol from all exchange feeds at runtime."""
        with self._symbols_lock:
            if symbol in self._symbols:
                self._symbols.remove(symbol)
                logger.info(f"Unsubscribed from {symbol}")
                self._dynamic_unsubscribe(symbol)

    # ------------------------------------------------------------------
    # Dynamic subscribe/unsubscribe helpers
    # ------------------------------------------------------------------

    def _dynamic_subscribe(self, symbol: str):
        """Send subscribe messages to running exchange connections."""
        # Binance: combined stream doesn't support dynamic sub — reconnect needed
        # OKX: supports subscribe messages
        loop = self._loops.get("okx")
        if loop and loop.is_running():
            okx_sym = OKX_SYMBOLS.get(symbol)
            if okx_sym:
                args = [
                    {"channel": "trades", "instId": okx_sym},
                    {"channel": "tickers", "instId": okx_sym},
                    {"channel": "books5", "instId": okx_sym},
                ]
                msg = json.dumps({"op": "subscribe", "args": args})
                asyncio.run_coroutine_threadsafe(
                    self._send_to_exchange("okx", msg), loop
                )

        # Bybit: supports subscribe messages
        loop = self._loops.get("bybit")
        if loop and loop.is_running():
            bybit_sym = BYBIT_SYMBOLS.get(symbol)
            if bybit_sym:
                msg = json.dumps({
                    "op": "subscribe",
                    "args": [
                        f"publicTrade.{bybit_sym}",
                        f"orderbook.1.{bybit_sym}",
                        f"tickers.{bybit_sym}",
                    ],
                })
                asyncio.run_coroutine_threadsafe(
                    self._send_to_exchange("bybit", msg), loop
                )

    def _dynamic_unsubscribe(self, symbol: str):
        """Send unsubscribe messages to running exchange connections."""
        loop = self._loops.get("okx")
        if loop and loop.is_running():
            okx_sym = OKX_SYMBOLS.get(symbol)
            if okx_sym:
                args = [
                    {"channel": "trades", "instId": okx_sym},
                    {"channel": "tickers", "instId": okx_sym},
                    {"channel": "books5", "instId": okx_sym},
                ]
                msg = json.dumps({"op": "unsubscribe", "args": args})
                asyncio.run_coroutine_threadsafe(
                    self._send_to_exchange("okx", msg), loop
                )

        loop = self._loops.get("bybit")
        if loop and loop.is_running():
            bybit_sym = BYBIT_SYMBOLS.get(symbol)
            if bybit_sym:
                msg = json.dumps({
                    "op": "unsubscribe",
                    "args": [
                        f"publicTrade.{bybit_sym}",
                        f"orderbook.1.{bybit_sym}",
                        f"tickers.{bybit_sym}",
                    ],
                })
                asyncio.run_coroutine_threadsafe(
                    self._send_to_exchange("bybit", msg), loop
                )

    async def _send_to_exchange(self, exchange: str, message: str):
        """Send a raw message to a connected exchange WebSocket."""
        ws = self._active_ws.get(exchange)
        if ws:
            try:
                await ws.send(message)
            except Exception as e:
                logger.debug(f"Failed to send to {exchange}: {e}")

    # Holds active websocket references for dynamic sub/unsub
    _active_ws: dict[str, object] = {}

    # ------------------------------------------------------------------
    # Deduplication
    # ------------------------------------------------------------------

    def _is_duplicate_trade(self, exchange: str, trade_id: str) -> bool:
        """Check if we have already processed this trade."""
        key = (exchange, trade_id)
        with self._dedup_lock:
            if key in self._seen_set:
                return True
            # Evict oldest if at capacity
            if len(self._seen_trade_ids) >= self._seen_trade_ids.maxlen:
                evicted = self._seen_trade_ids[0]
                self._seen_set.discard(evicted)
            self._seen_trade_ids.append(key)
            self._seen_set.add(key)
            return False

    # ------------------------------------------------------------------
    # Stat helpers
    # ------------------------------------------------------------------

    def _inc_msg(self, exchange: str):
        with self._stats_lock:
            self._stats[exchange]["messages"] += 1
            self._stats[exchange]["last_msg"] = time.time()

    def _set_connected(self, exchange: str, connected: bool):
        with self._stats_lock:
            self._stats[exchange]["connected"] = connected

    def _inc_reconnect(self, exchange: str):
        with self._stats_lock:
            self._stats[exchange]["reconnects"] += 1

    # ------------------------------------------------------------------
    # Fire callbacks (in try/except to never break the stream)
    # ------------------------------------------------------------------

    def _fire_trade(self, exchange: str, symbol: str, trade: dict):
        for cb in self._on_trade_cbs:
            try:
                cb(exchange, symbol, trade)
            except Exception:
                pass

    def _fire_ticker(self, exchange: str, symbol: str, ticker: dict):
        for cb in self._on_ticker_cbs:
            try:
                cb(exchange, symbol, ticker)
            except Exception:
                pass

    def _fire_orderbook(self, exchange: str, symbol: str, book: dict):
        for cb in self._on_orderbook_cbs:
            try:
                cb(exchange, symbol, book)
            except Exception:
                pass

    # ==================================================================
    #  BINANCE
    # ==================================================================

    def _run_binance(self):
        """Thread entry: run Binance WebSocket in its own event loop."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loops["binance"] = loop
        try:
            loop.run_until_complete(self._binance_connect_loop())
        except Exception as e:
            logger.error(f"Binance loop fatal: {e}")
        finally:
            loop.close()

    async def _binance_connect_loop(self):
        """Binance connection with exponential backoff reconnect."""
        backoff = 1.0
        while self._running:
            try:
                await self._binance_stream()
                backoff = 1.0  # Reset on clean disconnect
            except Exception as e:
                self._set_connected("binance", False)
                self._inc_reconnect("binance")
                logger.warning(f"Binance disconnected ({e}), reconnecting in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _binance_stream(self):
        """Subscribe to Binance combined stream."""
        with self._symbols_lock:
            symbols = list(self._symbols)

        streams = []
        for sym in symbols:
            bn = BINANCE_SYMBOLS.get(sym)
            if not bn:
                continue
            streams.append(f"{bn}@trade")
            streams.append(f"{bn}@bookTicker")
            streams.append(f"{bn}@kline_1m")

        if not streams:
            logger.warning("Binance: no streams to subscribe")
            await asyncio.sleep(10)
            return

        url = f"{BINANCE_WS_URL}?streams={'/'.join(streams)}"

        async with websockets.connect(
            url,
            ping_interval=20,
            ping_timeout=10,
            max_size=10 * 1024 * 1024,
        ) as ws:
            self._active_ws["binance"] = ws
            self._set_connected("binance", True)
            logger.info(f"Binance connected: {len(streams)} streams for {len(symbols)} symbols")

            while self._running:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                    data = json.loads(raw)
                    self._inc_msg("binance")
                    self._process_binance(data)
                except asyncio.TimeoutError:
                    await ws.ping()
                except websockets.ConnectionClosed:
                    raise
                except Exception as e:
                    logger.debug(f"Binance message error: {e}")

            self._active_ws.pop("binance", None)

    def _process_binance(self, data: dict):
        """Route Binance combined-stream message."""
        stream = data.get("stream", "")
        payload = data.get("data", {})

        if "@trade" in stream and "@bookTicker" not in stream:
            self._handle_binance_trade(stream, payload)
        elif "@bookTicker" in stream:
            self._handle_binance_book_ticker(stream, payload)
        elif "@kline" in stream:
            self._handle_binance_kline(stream, payload)

    def _handle_binance_trade(self, stream: str, data: dict):
        bn_sym = stream.split("@")[0]
        symbol = _BINANCE_REVERSE.get(bn_sym)
        if not symbol:
            return

        trade_id = str(data.get("t", ""))
        if self._is_duplicate_trade("binance", trade_id):
            return

        price = float(data.get("p", 0))
        qty = float(data.get("q", 0))
        is_buyer_maker = data.get("m", False)
        ts = data.get("T", int(time.time() * 1000))

        trade = {
            "exchange": "binance",
            "symbol": symbol,
            "price": price,
            "quantity": qty,
            "side": "SELL" if is_buyer_maker else "BUY",
            "trade_id": trade_id,
            "timestamp": ts,
        }

        with self._trade_lock:
            self._trades[symbol].append(trade)

        self._fire_trade("binance", symbol, trade)

    def _handle_binance_book_ticker(self, stream: str, data: dict):
        bn_sym = stream.split("@")[0]
        symbol = _BINANCE_REVERSE.get(bn_sym)
        if not symbol:
            return

        bid = float(data.get("b", 0))
        ask = float(data.get("a", 0))
        bid_qty = float(data.get("B", 0))
        ask_qty = float(data.get("A", 0))

        ticker = {
            "bid": bid,
            "ask": ask,
            "bid_qty": bid_qty,
            "ask_qty": ask_qty,
            "last": (bid + ask) / 2,
            "time": time.time(),
        }

        with self._ticker_lock:
            self._tickers[symbol]["binance"] = ticker

        self._fire_ticker("binance", symbol, ticker)

    def _handle_binance_kline(self, stream: str, data: dict):
        """Process Binance kline — update ticker last price from close."""
        bn_sym = stream.split("@")[0]
        symbol = _BINANCE_REVERSE.get(bn_sym)
        if not symbol:
            return

        k = data.get("k", {})
        close = float(k.get("c", 0))
        if close > 0:
            with self._ticker_lock:
                existing = self._tickers[symbol].get("binance", {})
                existing["last"] = close
                existing["kline_close"] = close
                existing["kline_time"] = k.get("t", 0)
                self._tickers[symbol]["binance"] = existing

    # ==================================================================
    #  OKX
    # ==================================================================

    def _run_okx(self):
        """Thread entry: run OKX WebSocket in its own event loop."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loops["okx"] = loop
        try:
            loop.run_until_complete(self._okx_connect_loop())
        except Exception as e:
            logger.error(f"OKX loop fatal: {e}")
        finally:
            loop.close()

    async def _okx_connect_loop(self):
        backoff = 1.0
        while self._running:
            try:
                await self._okx_stream()
                backoff = 1.0
            except Exception as e:
                self._set_connected("okx", False)
                self._inc_reconnect("okx")
                logger.warning(f"OKX disconnected ({e}), reconnecting in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _okx_stream(self):
        with self._symbols_lock:
            symbols = list(self._symbols)

        args = []
        for sym in symbols:
            okx_sym = OKX_SYMBOLS.get(sym)
            if not okx_sym:
                continue
            args.append({"channel": "trades", "instId": okx_sym})
            args.append({"channel": "tickers", "instId": okx_sym})
            args.append({"channel": "books5", "instId": okx_sym})

        if not args:
            logger.warning("OKX: no channels to subscribe")
            await asyncio.sleep(10)
            return

        async with websockets.connect(
            OKX_WS_URL,
            ping_interval=25,
            ping_timeout=10,
            max_size=10 * 1024 * 1024,
        ) as ws:
            self._active_ws["okx"] = ws
            self._set_connected("okx", True)

            # Subscribe
            subscribe_msg = json.dumps({"op": "subscribe", "args": args})
            await ws.send(subscribe_msg)
            logger.info(f"OKX connected: {len(args)} channels for {len(symbols)} symbols")

            while self._running:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                    data = json.loads(raw)
                    self._inc_msg("okx")

                    # OKX sends ping frames that the websockets library handles,
                    # but also sends {"op": "ping"} that need a pong response
                    if data.get("op") == "ping":
                        await ws.send(json.dumps({"op": "pong"}))
                        continue

                    # Skip subscription confirmations
                    if "event" in data:
                        continue

                    self._process_okx(data)
                except asyncio.TimeoutError:
                    # Send OKX ping
                    await ws.send("ping")
                except websockets.ConnectionClosed:
                    raise
                except Exception as e:
                    logger.debug(f"OKX message error: {e}")

            self._active_ws.pop("okx", None)

    def _process_okx(self, data: dict):
        """Route OKX message by channel."""
        arg = data.get("arg", {})
        channel = arg.get("channel", "")
        records = data.get("data", [])
        if not records:
            return

        inst_id = arg.get("instId", "")
        symbol = _OKX_REVERSE.get(inst_id)
        if not symbol:
            return

        if channel == "trades":
            for rec in records:
                self._handle_okx_trade(symbol, rec)
        elif channel == "tickers":
            for rec in records:
                self._handle_okx_ticker(symbol, rec)
        elif channel.startswith("books"):
            for rec in records:
                self._handle_okx_orderbook(symbol, rec)

    def _handle_okx_trade(self, symbol: str, rec: dict):
        trade_id = str(rec.get("tradeId", ""))
        if self._is_duplicate_trade("okx", trade_id):
            return

        price = float(rec.get("px", 0))
        qty = float(rec.get("sz", 0))
        side = rec.get("side", "buy").upper()
        ts = int(rec.get("ts", time.time() * 1000))

        trade = {
            "exchange": "okx",
            "symbol": symbol,
            "price": price,
            "quantity": qty,
            "side": side,
            "trade_id": trade_id,
            "timestamp": ts,
        }

        with self._trade_lock:
            self._trades[symbol].append(trade)

        self._fire_trade("okx", symbol, trade)

    def _handle_okx_ticker(self, symbol: str, rec: dict):
        bid = float(rec.get("bidPx", 0))
        ask = float(rec.get("askPx", 0))
        last = float(rec.get("last", 0))

        ticker = {
            "bid": bid,
            "ask": ask,
            "bid_qty": float(rec.get("bidSz", 0)),
            "ask_qty": float(rec.get("askSz", 0)),
            "last": last,
            "vol_24h": float(rec.get("vol24h", 0)),
            "time": time.time(),
        }

        with self._ticker_lock:
            self._tickers[symbol]["okx"] = ticker

        self._fire_ticker("okx", symbol, ticker)

    def _handle_okx_orderbook(self, symbol: str, rec: dict):
        bids = [(float(b[0]), float(b[1])) for b in rec.get("bids", [])]
        asks = [(float(a[0]), float(a[1])) for a in rec.get("asks", [])]

        book = {
            "bids": bids,
            "asks": asks,
            "time": time.time(),
        }

        with self._orderbook_lock:
            self._orderbooks[symbol]["okx"] = book

        self._fire_orderbook("okx", symbol, book)

    # ==================================================================
    #  BYBIT
    # ==================================================================

    def _run_bybit(self):
        """Thread entry: run Bybit WebSocket in its own event loop."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loops["bybit"] = loop
        try:
            loop.run_until_complete(self._bybit_connect_loop())
        except Exception as e:
            logger.error(f"Bybit loop fatal: {e}")
        finally:
            loop.close()

    async def _bybit_connect_loop(self):
        backoff = 1.0
        while self._running:
            try:
                await self._bybit_stream()
                backoff = 1.0
            except Exception as e:
                self._set_connected("bybit", False)
                self._inc_reconnect("bybit")
                logger.warning(f"Bybit disconnected ({e}), reconnecting in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _bybit_stream(self):
        with self._symbols_lock:
            symbols = list(self._symbols)

        args = []
        for sym in symbols:
            bybit_sym = BYBIT_SYMBOLS.get(sym)
            if not bybit_sym:
                continue
            args.append(f"publicTrade.{bybit_sym}")
            args.append(f"orderbook.1.{bybit_sym}")
            args.append(f"tickers.{bybit_sym}")

        if not args:
            logger.warning("Bybit: no topics to subscribe")
            await asyncio.sleep(10)
            return

        async with websockets.connect(
            BYBIT_WS_URL,
            ping_interval=20,
            ping_timeout=10,
            max_size=10 * 1024 * 1024,
        ) as ws:
            self._active_ws["bybit"] = ws
            self._set_connected("bybit", True)

            subscribe_msg = json.dumps({"op": "subscribe", "args": args})
            await ws.send(subscribe_msg)
            logger.info(f"Bybit connected: {len(args)} topics for {len(symbols)} symbols")

            # Bybit requires ping every 20s to keep alive
            last_ping = time.time()

            while self._running:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=20)
                    data = json.loads(raw)
                    self._inc_msg("bybit")

                    # Skip subscription confirmations and pong responses
                    if data.get("op") in ("subscribe", "pong"):
                        continue
                    if "success" in data and "ret_msg" in data:
                        continue

                    self._process_bybit(data)
                except asyncio.TimeoutError:
                    pass
                except websockets.ConnectionClosed:
                    raise
                except Exception as e:
                    logger.debug(f"Bybit message error: {e}")

                # Periodic heartbeat ping
                now = time.time()
                if now - last_ping >= 18:
                    try:
                        await ws.send(json.dumps({"op": "ping"}))
                        last_ping = now
                    except Exception:
                        raise websockets.ConnectionClosed(None, None)

            self._active_ws.pop("bybit", None)

    def _process_bybit(self, data: dict):
        """Route Bybit message by topic."""
        topic = data.get("topic", "")
        records = data.get("data", [])

        # Bybit topics: "publicTrade.BTCUSDT", "orderbook.1.BTCUSDT", "tickers.BTCUSDT"
        parts = topic.split(".")
        if len(parts) < 2:
            return

        if topic.startswith("publicTrade."):
            bybit_sym = parts[1]
            symbol = _BYBIT_REVERSE.get(bybit_sym)
            if symbol and isinstance(records, list):
                for rec in records:
                    self._handle_bybit_trade(symbol, rec)

        elif topic.startswith("orderbook."):
            # "orderbook.1.BTCUSDT"
            bybit_sym = parts[2] if len(parts) >= 3 else ""
            symbol = _BYBIT_REVERSE.get(bybit_sym)
            if symbol:
                # For orderbook, data is a dict not a list
                book_data = data.get("data", {})
                if isinstance(book_data, dict):
                    self._handle_bybit_orderbook(symbol, book_data)

        elif topic.startswith("tickers."):
            bybit_sym = parts[1]
            symbol = _BYBIT_REVERSE.get(bybit_sym)
            if symbol:
                tick_data = data.get("data", {})
                if isinstance(tick_data, dict):
                    self._handle_bybit_ticker(symbol, tick_data)

    def _handle_bybit_trade(self, symbol: str, rec: dict):
        trade_id = str(rec.get("i", ""))
        if self._is_duplicate_trade("bybit", trade_id):
            return

        price = float(rec.get("p", 0))
        qty = float(rec.get("v", 0))
        side = rec.get("S", "Buy").upper()
        ts = int(rec.get("T", time.time() * 1000))

        trade = {
            "exchange": "bybit",
            "symbol": symbol,
            "price": price,
            "quantity": qty,
            "side": side,
            "trade_id": trade_id,
            "timestamp": ts,
        }

        with self._trade_lock:
            self._trades[symbol].append(trade)

        self._fire_trade("bybit", symbol, trade)

    def _handle_bybit_ticker(self, symbol: str, rec: dict):
        bid = float(rec.get("bid1Price", 0) or 0)
        ask = float(rec.get("ask1Price", 0) or 0)
        last = float(rec.get("lastPrice", 0) or 0)

        ticker = {
            "bid": bid,
            "ask": ask,
            "bid_qty": float(rec.get("bid1Size", 0) or 0),
            "ask_qty": float(rec.get("ask1Size", 0) or 0),
            "last": last,
            "vol_24h": float(rec.get("volume24h", 0) or 0),
            "time": time.time(),
        }

        with self._ticker_lock:
            self._tickers[symbol]["bybit"] = ticker

        self._fire_ticker("bybit", symbol, ticker)

    def _handle_bybit_orderbook(self, symbol: str, rec: dict):
        bids = [(float(b[0]), float(b[1])) for b in rec.get("b", [])]
        asks = [(float(a[0]), float(a[1])) for a in rec.get("a", [])]

        book = {
            "bids": bids,
            "asks": asks,
            "time": time.time(),
        }

        with self._orderbook_lock:
            self._orderbooks[symbol]["bybit"] = book

        self._fire_orderbook("bybit", symbol, book)

    # ==================================================================
    #  Public Query Methods
    # ==================================================================

    def get_best_price(self, symbol: str) -> dict:
        """Get the best bid/ask across all exchanges for a symbol.

        Returns:
            {
                "best_bid": float, "best_bid_exchange": str,
                "best_ask": float, "best_ask_exchange": str,
                "spread_bps": float,  # basis points
                "exchanges": {exchange: {bid, ask, last}}
            }
        """
        with self._ticker_lock:
            exchange_tickers = dict(self._tickers.get(symbol, {}))

        if not exchange_tickers:
            return {
                "best_bid": 0, "best_bid_exchange": "",
                "best_ask": 0, "best_ask_exchange": "",
                "spread_bps": 0, "exchanges": {},
            }

        best_bid = 0.0
        best_bid_ex = ""
        best_ask = float("inf")
        best_ask_ex = ""
        exchanges = {}

        for ex, tick in exchange_tickers.items():
            bid = tick.get("bid", 0)
            ask = tick.get("ask", 0)
            last = tick.get("last", 0)
            exchanges[ex] = {"bid": bid, "ask": ask, "last": last}

            if bid > best_bid:
                best_bid = bid
                best_bid_ex = ex
            if 0 < ask < best_ask:
                best_ask = ask
                best_ask_ex = ex

        if best_ask == float("inf"):
            best_ask = 0

        mid = (best_bid + best_ask) / 2 if (best_bid > 0 and best_ask > 0) else 1
        spread_bps = ((best_ask - best_bid) / mid) * 10_000 if mid > 0 else 0

        return {
            "best_bid": best_bid,
            "best_bid_exchange": best_bid_ex,
            "best_ask": best_ask,
            "best_ask_exchange": best_ask_ex,
            "spread_bps": round(spread_bps, 2),
            "exchanges": exchanges,
        }

    def get_trade_flow(self, symbol: str, window_seconds: int = 60) -> dict:
        """Analyze aggregated trade flow across all exchanges.

        Args:
            symbol: Internal symbol, e.g. "BTC/USD"
            window_seconds: Lookback window in seconds (default 60)

        Returns:
            {
                "buy_volume": float, "sell_volume": float,
                "buy_count": int, "sell_count": int,
                "net_flow": float,  # positive = net buying
                "vwap": float,
                "total_trades": int,
                "exchanges": {exchange: {buy_vol, sell_vol, count}}
            }
        """
        cutoff_ms = (time.time() - window_seconds) * 1000

        with self._trade_lock:
            all_trades = list(self._trades.get(symbol, []))

        buy_vol = 0.0
        sell_vol = 0.0
        buy_count = 0
        sell_count = 0
        price_x_vol = 0.0
        total_vol = 0.0
        per_exchange: dict[str, dict] = defaultdict(lambda: {"buy_vol": 0.0, "sell_vol": 0.0, "count": 0})

        for t in all_trades:
            if t["timestamp"] < cutoff_ms:
                continue

            vol = t["price"] * t["quantity"]
            ex = t["exchange"]
            per_exchange[ex]["count"] += 1

            if t["side"] == "BUY":
                buy_vol += vol
                buy_count += 1
                per_exchange[ex]["buy_vol"] += vol
            else:
                sell_vol += vol
                sell_count += 1
                per_exchange[ex]["sell_vol"] += vol

            price_x_vol += t["price"] * t["quantity"]
            total_vol += t["quantity"]

        vwap = price_x_vol / total_vol if total_vol > 0 else 0.0

        return {
            "buy_volume": round(buy_vol, 2),
            "sell_volume": round(sell_vol, 2),
            "buy_count": buy_count,
            "sell_count": sell_count,
            "net_flow": round(buy_vol - sell_vol, 2),
            "vwap": round(vwap, 2),
            "total_trades": buy_count + sell_count,
            "window_seconds": window_seconds,
            "exchanges": dict(per_exchange),
        }

    def get_cross_exchange_spread(self, symbol: str) -> dict:
        """Calculate price differences between exchanges.

        Returns:
            {
                "max_spread_bps": float,
                "arb_opportunity": bool,
                "pairs": [
                    {
                        "buy_on": str, "sell_on": str,
                        "buy_price": float, "sell_price": float,
                        "spread_bps": float
                    }
                ],
                "prices": {exchange: last_price}
            }
        """
        with self._ticker_lock:
            exchange_tickers = dict(self._tickers.get(symbol, {}))

        prices: dict[str, float] = {}
        for ex, tick in exchange_tickers.items():
            last = tick.get("last", 0)
            if last > 0:
                prices[ex] = last

        if len(prices) < 2:
            return {
                "max_spread_bps": 0,
                "arb_opportunity": False,
                "pairs": [],
                "prices": prices,
            }

        pairs = []
        max_spread = 0.0
        exchanges = list(prices.keys())

        for i in range(len(exchanges)):
            for j in range(i + 1, len(exchanges)):
                ex_a, ex_b = exchanges[i], exchanges[j]
                p_a, p_b = prices[ex_a], prices[ex_b]

                # Find which is cheaper (buy there, sell at the higher one)
                if p_a < p_b:
                    buy_ex, sell_ex = ex_a, ex_b
                    buy_p, sell_p = p_a, p_b
                else:
                    buy_ex, sell_ex = ex_b, ex_a
                    buy_p, sell_p = p_b, p_a

                mid = (buy_p + sell_p) / 2
                spread_bps = ((sell_p - buy_p) / mid) * 10_000 if mid > 0 else 0

                pairs.append({
                    "buy_on": buy_ex,
                    "sell_on": sell_ex,
                    "buy_price": round(buy_p, 4),
                    "sell_price": round(sell_p, 4),
                    "spread_bps": round(spread_bps, 2),
                })

                if spread_bps > max_spread:
                    max_spread = spread_bps

        # Arb opportunity if spread > 15 bps (0.15%) which covers round-trip fees
        arb = max_spread > 15

        pairs.sort(key=lambda p: p["spread_bps"], reverse=True)

        return {
            "max_spread_bps": round(max_spread, 2),
            "arb_opportunity": arb,
            "pairs": pairs,
            "prices": {k: round(v, 4) for k, v in prices.items()},
        }

    def get_status(self) -> dict:
        """Get per-exchange connection status and message rates.

        Returns:
            {
                "running": bool,
                "uptime_seconds": float,
                "symbols": list,
                "exchanges": {
                    exchange: {
                        "connected": bool, "messages": int,
                        "messages_per_sec": float, "reconnects": int,
                        "last_msg_ago": float
                    }
                }
            }
        """
        uptime = time.time() - self._start_time if self._start_time else 0
        now = time.time()

        with self._stats_lock:
            exchanges = {}
            for ex, s in self._stats.items():
                msg_rate = s["messages"] / max(uptime, 1)
                last_ago = now - s["last_msg"] if s["last_msg"] > 0 else -1
                exchanges[ex] = {
                    "connected": s["connected"],
                    "messages": s["messages"],
                    "messages_per_sec": round(msg_rate, 1),
                    "reconnects": s["reconnects"],
                    "last_msg_ago_sec": round(last_ago, 1) if last_ago >= 0 else None,
                }

        with self._symbols_lock:
            symbols = list(self._symbols)

        total_trades = 0
        with self._trade_lock:
            for dq in self._trades.values():
                total_trades += len(dq)

        return {
            "running": self._running,
            "uptime_seconds": round(uptime, 0),
            "symbols": symbols,
            "symbol_count": len(symbols),
            "total_trades_buffered": total_trades,
            "dedup_cache_size": len(self._seen_set),
            "exchanges": exchanges,
        }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[WSMultiplexer] = None
_instance_lock = threading.Lock()


def get_ws_multiplexer() -> WSMultiplexer:
    """Get or create the singleton WSMultiplexer instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = WSMultiplexer()
    return _instance
