"""
Persistence Routes - SQLite CRUD
Port of routes/persistence.js.

All /api/db/* endpoints for trades, candles, sessions, settings, etc.
"""

import json
from fastapi import APIRouter, HTTPException, Query, Request

from services.database_service import (
    insert_trade, get_trades, get_trade_count,
    insert_trade_memory, get_trade_memories,
    upsert_learned_pattern, get_learned_patterns,
    insert_parameter_snapshot, get_parameter_history, get_latest_parameters,
    insert_session, update_session, get_sessions,
    insert_candles_batch, get_candles, get_candle_count,
    insert_sentiment_snapshot, get_sentiment_history,
    set_setting, get_setting, get_all_settings,
)

router = APIRouter()


# ============================================
# TRADES
# ============================================

@router.get("/api/db/trades")
async def api_get_trades(
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    strategy: str | None = Query(None),
):
    trades = get_trades(limit, offset, strategy)
    total = get_trade_count(strategy)
    return {"trades": trades, "total": total, "limit": limit, "offset": offset}


@router.post("/api/db/trades")
async def api_create_trade(request: Request):
    body = await request.json()
    required = ["ticker", "strategy", "entryPrice", "quantity", "entryTime"]
    if not all(body.get(f) for f in required):
        raise HTTPException(400, f"Missing required fields: {', '.join(required)}")
    row_id = insert_trade({
        "ticker": body["ticker"], "strategy": body["strategy"],
        "entry_price": body["entryPrice"], "exit_price": body.get("exitPrice"),
        "quantity": body["quantity"], "pnl": body.get("pnl"),
        "pnl_percent": body.get("pnlPercent"), "outcome": body.get("outcome"),
        "reason": body.get("reason"), "entry_time": body["entryTime"],
        "exit_time": body.get("exitTime"),
    })
    return {"id": row_id}


# ============================================
# TRADE MEMORY
# ============================================

@router.get("/api/db/trade-memory")
async def api_get_trade_memory(limit: int = Query(500, ge=1, le=5000)):
    memories = get_trade_memories(limit)
    return {"memories": memories, "count": len(memories)}


@router.post("/api/db/trade-memory")
async def api_create_trade_memory(request: Request):
    m = await request.json()
    if not m.get("ticker") or not m.get("strategy"):
        raise HTTPException(400, "Missing required fields: ticker, strategy")

    conditions = m.get("marketConditions", {})
    indicators = m.get("indicators", {})
    row_id = insert_trade_memory({
        "ticker": m["ticker"], "strategy": m["strategy"],
        "entry_price": m.get("entryPrice"), "exit_price": m.get("exitPrice"),
        "entry_time": m.get("entryTime"), "exit_time": m.get("exitTime"),
        "pnl": m.get("pnl"), "pnl_percent": m.get("pnlPercent"),
        "outcome": m.get("outcome"), "hold_duration": m.get("holdDuration"),
        "market_volatility": conditions.get("volatility"),
        "market_trend": conditions.get("trend"),
        "market_volume": conditions.get("volume"),
        "tc_value": indicators.get("tcValue"),
        "momentum_value": indicators.get("momentumValue"),
        "whale_value": indicators.get("whaleValue"),
        "confluence_score": indicators.get("confluenceScore"),
        "ai_analysis": m.get("aiAnalysis"),
    })
    return {"id": row_id}


# ============================================
# LEARNED PATTERNS
# ============================================

@router.get("/api/db/learned-patterns")
async def api_get_learned_patterns():
    return {"patterns": get_learned_patterns()}


@router.put("/api/db/learned-patterns/{pattern_id}")
async def api_upsert_learned_pattern(pattern_id: str, request: Request):
    p = await request.json()
    conditions = p.get("conditions", {})
    tc_range = conditions.get("tcRange", [p.get("tcRangeLow", 0), p.get("tcRangeHigh", 100)])
    mom_range = conditions.get("momentumRange", [p.get("momentumRangeLow", 0), p.get("momentumRangeHigh", 100)])
    upsert_learned_pattern({
        "id": pattern_id,
        "description": p.get("description", ""),
        "tc_range_low": tc_range[0] if isinstance(tc_range, list) and len(tc_range) > 0 else 0,
        "tc_range_high": tc_range[1] if isinstance(tc_range, list) and len(tc_range) > 1 else 100,
        "momentum_range_low": mom_range[0] if isinstance(mom_range, list) and len(mom_range) > 0 else 0,
        "momentum_range_high": mom_range[1] if isinstance(mom_range, list) and len(mom_range) > 1 else 100,
        "volatility": conditions.get("volatility", p.get("volatility", "")),
        "trend": conditions.get("trend", p.get("trend", "")),
        "success_rate": p.get("successRate", 0),
        "sample_size": p.get("sampleSize", 0),
        "recommendation": p.get("recommendation", "AVOID"),
    })
    return {"success": True}


# ============================================
# PARAMETER HISTORY
# ============================================

@router.get("/api/db/parameter-history")
async def api_get_parameter_history(limit: int = Query(50, ge=1, le=500)):
    return {"history": get_parameter_history(limit)}


@router.get("/api/db/parameter-history/latest")
async def api_get_latest_parameters():
    return {"latest": get_latest_parameters()}


@router.post("/api/db/parameter-history")
async def api_create_parameter_snapshot(request: Request):
    body = await request.json()
    params = body.get("params")
    if not params:
        raise HTTPException(400, "Missing required field: params")
    params_json = params if isinstance(params, str) else json.dumps(params)
    row_id = insert_parameter_snapshot({
        "params_json": params_json,
        "win_rate": body.get("winRate"),
        "profit_factor": body.get("profitFactor"),
        "total_trades": body.get("totalTrades"),
        "reason": body.get("reason"),
    })
    return {"id": row_id}


# ============================================
# SESSIONS
# ============================================

@router.get("/api/db/sessions")
async def api_get_sessions(limit: int = Query(50, ge=1, le=500)):
    return {"sessions": get_sessions(limit)}


@router.post("/api/db/sessions")
async def api_create_session(request: Request):
    body = await request.json()
    if not body.get("startTime"):
        raise HTTPException(400, "Missing required field: startTime")
    row_id = insert_session({
        "start_time": body["startTime"],
        "initial_budget": body.get("initialBudget", 0),
        "notes": body.get("notes"),
    })
    return {"id": row_id}


@router.put("/api/db/sessions/{session_id}")
async def api_update_session(session_id: int, request: Request):
    body = await request.json()
    update_session(session_id, {
        "end_time": body.get("endTime"),
        "final_value": body.get("finalValue"),
        "total_trades": body.get("totalTrades", 0),
        "win_rate": body.get("winRate"),
        "pnl": body.get("pnl"),
    })
    return {"success": True}


# ============================================
# CANDLE HISTORY
# ============================================

@router.get("/api/db/candles")
async def api_get_candles(
    ticker: str = Query(...),
    timeframe: str = Query(...),
    start: int | None = Query(None),
    end: int | None = Query(None),
    limit: int = Query(1000, ge=1, le=10000),
):
    candles = get_candles(ticker, timeframe, start, end, limit)
    total = get_candle_count(ticker, timeframe)
    return {"candles": candles, "count": len(candles), "total": total}


@router.post("/api/db/candles/batch")
async def api_insert_candles_batch(request: Request):
    body = await request.json()
    candles = body.get("candles", [])
    if not isinstance(candles, list) or len(candles) == 0:
        raise HTTPException(400, "candles must be a non-empty array")
    insert_candles_batch(candles)
    return {"inserted": len(candles)}


# ============================================
# SENTIMENT SNAPSHOTS
# ============================================

@router.get("/api/db/sentiment/{ticker}")
async def api_get_sentiment(ticker: str, hours: int = Query(24, ge=1, le=168)):
    history = get_sentiment_history(ticker, hours)
    return {"history": history, "count": len(history)}


@router.post("/api/db/sentiment")
async def api_create_sentiment(request: Request):
    body = await request.json()
    if not body.get("ticker") or not body.get("source"):
        raise HTTPException(400, "Missing required fields: ticker, source")
    raw = body.get("rawData")
    if raw and not isinstance(raw, str):
        raw = json.dumps(raw)
    row_id = insert_sentiment_snapshot({
        "ticker": body["ticker"],
        "source": body["source"],
        "score": body.get("score"),
        "raw_data": raw,
    })
    return {"id": row_id}


# ============================================
# SETTINGS
# ============================================

@router.get("/api/db/settings")
async def api_get_all_settings():
    return {"settings": get_all_settings()}


@router.get("/api/db/settings/{key}")
async def api_get_setting(key: str):
    value = get_setting(key)
    return {"key": key, "value": value}


@router.put("/api/db/settings/{key}")
async def api_put_setting(key: str, request: Request):
    body = await request.json()
    value = body.get("value")
    if value is None:
        raise HTTPException(400, "Missing required field: value")
    stored = value if isinstance(value, str) else json.dumps(value)
    set_setting(key, stored)
    return {"success": True}
