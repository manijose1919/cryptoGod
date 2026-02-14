"""
Feed Routes
/api/feeds/live - Live market feed data
"""

import json
import time

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


def _sanitize(obj):
    """Convert numpy types to native Python for JSON serialization."""
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def get_trader():
    from app import get_canuck_trader
    return get_canuck_trader()


@router.get("/api/feeds/live")
async def live_feed():
    trader = get_trader()
    if not trader:
        return {"prices": {}, "scan": {}, "ts": time.time()}

    data = {
        "prices": trader.market.get_current_prices() if hasattr(trader.market, "get_current_prices") else {},
        "scan": _sanitize(trader._last_scan),
        "last_trade": _sanitize(trader._last_trade),
        "cycle": trader.cycle_count,
        "paused": trader.paused,
        "ts": time.time(),
    }
    return JSONResponse(content=data)
