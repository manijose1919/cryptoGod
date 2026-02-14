"""
FastAPI Application
Main application with CORS, static files, rate limiting, WebSocket, and all route modules.
Replaces the Node.js Express server (server.js).
"""

import os
import time
import logging
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from services.database_service import initialize_database
from services.websocket_relay import WebSocketRelay
from services.questrade_service import QuestradeService
from services.paper_trader import PaperTrader
from services.stock_strategy import StockStrategyEngine

from routes import market, auth, status, persistence, questrade, ai, feeds
from services.auth_service import get_auth_service, get_auth_middleware, get_auth_router

logger = logging.getLogger("app")

# ============================================
# GLOBALS (shared with routes via accessor functions)
# ============================================

_canuck_trader = None  # Set by main.py after CanuckTrader is created
_app_state = {
    "start_time": time.time(),
    "logs": [],
    "bot_state": {"is_active": False},
    "db_initialized": False,
    "ws_clients": 0,
    "questrade_status": {"authenticated": False},
}


def set_canuck_trader(trader):
    global _canuck_trader
    _canuck_trader = trader


def get_canuck_trader():
    return _canuck_trader


def get_app_state() -> dict:
    _app_state["ws_clients"] = ws_relay.client_count
    return _app_state


def add_log(message: str, log_type: str = "INFO"):
    log_entry = {
        "id": int(time.time() * 1000),
        "time": int(time.time() * 1000),
        "message": f"[Backend] {message}",
        "type": log_type,
    }
    _app_state["logs"] = [log_entry] + _app_state["logs"][:99]
    logger.info(f"[{log_type}] {message}")

    try:
        from services.database_service import insert_system_log
        insert_system_log(log_entry)
    except Exception:
        pass


# ============================================
# SERVICE INSTANCES
# ============================================

ws_relay = WebSocketRelay()
_sse_clients: set = set()  # asyncio.Queue instances for SSE


async def push_to_sse(data: dict):
    """Push data to all SSE clients."""
    for q in list(_sse_clients):
        try:
            q.put_nowait(data)
        except Exception:
            pass


questrade_service = QuestradeService()
paper_trader = PaperTrader(questrade_service, 100000)
stock_strategy = StockStrategyEngine()


# ============================================
# RATE LIMITING
# ============================================

_rate_limit_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 100


async def rate_limit_middleware(request: Request, call_next):
    ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Clean old entries
    _rate_limit_store[ip] = [t for t in _rate_limit_store[ip] if t > now - RATE_LIMIT_WINDOW]

    if len(_rate_limit_store[ip]) >= RATE_LIMIT_MAX:
        return JSONResponse(
            status_code=429,
            content={"message": "Too many requests. Please try again later."},
        )

    _rate_limit_store[ip].append(now)
    return await call_next(request)


# ============================================
# CREATE APP
# ============================================

def create_app() -> FastAPI:
    app = FastAPI(title="Canuck-Trader-Pro API", version="2.0.0")

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:3033", "http://31.97.7.138:3033", "http://31.97.7.138:3000"],
        allow_origin_regex=r"http://localhost:\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Rate limiting
    app.middleware("http")(rate_limit_middleware)

    # JWT Authentication middleware (after rate limiting)
    try:
        app.middleware("http")(get_auth_middleware())
    except Exception as e:
        logger.warning(f"Auth middleware init skipped: {e}")

    # Initialize database
    @app.on_event("startup")
    async def startup():
        try:
            data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
            initialize_database(data_dir)
            _app_state["db_initialized"] = True
            logger.info("Database initialized")
        except Exception as e:
            logger.error(f"Database init error: {e}")

        # Initialize Questrade routes
        questrade.init_questrade(questrade_service, paper_trader, stock_strategy)
        add_log("FastAPI server started", "INFO")

    @app.on_event("shutdown")
    async def shutdown():
        from services.database_service import close_database
        close_database()
        add_log("FastAPI server stopped", "INFO")

    # Mount all route modules
    app.include_router(market.router)
    app.include_router(auth.router)
    app.include_router(status.router)
    app.include_router(persistence.router)
    app.include_router(questrade.router)
    app.include_router(ai.router)
    app.include_router(feeds.router)

    # Auth routes (JWT login/refresh/change-password)
    try:
        app.include_router(get_auth_router())
    except Exception as e:
        logger.warning(f"Auth routes init skipped: {e}")

    # WebSocket endpoint
    @app.websocket("/ws/market")
    async def websocket_endpoint(websocket: WebSocket):
        await ws_relay.connect(websocket)
        try:
            while True:
                # Keep connection alive, receive pings
                data = await websocket.receive_text()
                # Client can send commands if needed
        except WebSocketDisconnect:
            await ws_relay.disconnect(websocket)
        except Exception:
            await ws_relay.disconnect(websocket)

    # SSE endpoint (fallback for clients that can't use WebSocket)
    @app.get("/api/events")
    async def sse_events(request: Request):
        """Server-Sent Events stream for real-time updates."""
        import asyncio
        import json

        async def event_stream():
            queue: asyncio.Queue = asyncio.Queue(maxsize=100)
            _sse_clients.add(queue)
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        data = await asyncio.wait_for(queue.get(), timeout=30)
                        yield f"data: {json.dumps(data)}\n\n"
                    except asyncio.TimeoutError:
                        yield f"data: {json.dumps({'type': 'heartbeat', 'ts': time.time()})}\n\n"
            finally:
                _sse_clients.discard(queue)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Serve built React frontend (production)
    dist_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "dist")
    # Also check project root for dist (when running from different CWD)
    if not os.path.exists(dist_dir):
        alt_dist = os.path.join(os.getcwd(), "dist")
        if os.path.exists(alt_dist):
            dist_dir = alt_dist

    if os.path.exists(dist_dir):
        logger.info(f"Serving frontend from {dist_dir}")

        # Serve /assets subdirectory
        assets_dir = os.path.join(dist_dir, "assets")
        if os.path.exists(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        # SPA catch-all: serve static files if they exist, otherwise index.html
        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            # Don't intercept API or WebSocket routes
            if full_path.startswith("api/") or full_path.startswith("ws/"):
                return JSONResponse(status_code=404, content={"message": "Not found"})

            # Try to serve the exact file from dist (e.g. vite.svg, favicon.ico)
            if full_path:
                file_path = os.path.join(dist_dir, full_path)
                if os.path.isfile(file_path):
                    return FileResponse(file_path)

            # SPA fallback: serve index.html for all other routes
            index_path = os.path.join(dist_dir, "index.html")
            if os.path.exists(index_path):
                return FileResponse(index_path)
            return JSONResponse(status_code=404, content={"message": "Frontend not built. Run npm run build"})
    else:
        logger.info(f"No dist/ found at {dist_dir} - frontend not served (use Vite dev server)")

    return app


# Create the app instance
app = create_app()
