"""
Questrade Routes
All /api/questrade/* endpoints for auth, accounts, candles, orders, paper trading, bot control.
"""

import asyncio
import time
import logging

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter()
logger = logging.getLogger("questrade_routes")

# These will be set by app.py during startup
_questrade_service = None
_paper_trader = None
_stock_strategy = None
_bot_state = {
    "is_active": False,
    "is_paper": True,
    "account_id": None,
    "watchlist": ["SHOP", "TD", "RY", "BNS", "ENB", "CNR", "CP", "BMO", "BCE", "T"],
    "loop_task": None,
    "loop_ms": 5000,
}


def init_questrade(questrade_service, paper_trader, stock_strategy):
    global _questrade_service, _paper_trader, _stock_strategy
    _questrade_service = questrade_service
    _paper_trader = paper_trader
    _stock_strategy = stock_strategy


# ============================================
# AUTH
# ============================================

@router.post("/api/questrade/auth")
async def questrade_auth(request: Request):
    body = await request.json()
    refresh_token = body.get("refreshToken")
    is_practice = body.get("isPractice", False)
    try:
        _questrade_service.is_practice = is_practice
        await _questrade_service.authenticate(refresh_token)
        return {"success": True, "message": "Authenticated", "status": _questrade_service.get_status()}
    except Exception as e:
        raise HTTPException(401, str(e))


@router.get("/api/questrade/status")
async def questrade_status():
    return _questrade_service.get_status() if _questrade_service else {"authenticated": False}


# ============================================
# ACCOUNTS
# ============================================

@router.get("/api/questrade/accounts")
async def questrade_accounts():
    try:
        accounts = await _questrade_service.get_accounts()
        return {"accounts": accounts}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/questrade/balance/{account_id}")
async def questrade_balance(account_id: str):
    try:
        balance = await _questrade_service.get_balance(account_id)
        return balance
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/questrade/positions/{account_id}")
async def questrade_positions(account_id: str):
    try:
        positions = await _questrade_service.get_positions(account_id)
        return {"positions": positions}
    except Exception as e:
        raise HTTPException(500, str(e))


# ============================================
# MARKET DATA
# ============================================

@router.get("/api/questrade/candles")
async def questrade_candles(
    ticker: str = Query(...),
    interval: str = Query("5m"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    try:
        candles = await _questrade_service.get_candles_by_ticker(ticker, interval, start, end)
        return {"candles": candles, "count": len(candles)}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/questrade/search")
async def questrade_search(prefix: str = Query(...)):
    try:
        symbols = await _questrade_service.search_symbol(prefix)
        return {"symbols": symbols}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/questrade/symbols")
async def questrade_symbols(exchange: str = Query("TSX")):
    try:
        # Search popular Canadian tickers
        prefixes = ["SH", "TD", "RY", "BN", "CN", "CP", "ENB", "BMO", "BB", "AC"]
        all_symbols = []
        for prefix in prefixes:
            try:
                syms = await _questrade_service.search_symbol(prefix)
                filtered = [s for s in syms if s.get("listingExchange") == exchange and s.get("securityType") == "Stock"]
                all_symbols.extend(filtered)
            except Exception:
                pass
        # Dedupe
        seen = set()
        unique = []
        for s in all_symbols:
            if s["symbolId"] not in seen:
                seen.add(s["symbolId"])
                unique.append(s)
        return {"symbols": unique}
    except Exception as e:
        raise HTTPException(500, str(e))


# ============================================
# ORDERS
# ============================================

@router.post("/api/questrade/order")
async def questrade_order(request: Request):
    body = await request.json()
    account_id = body.get("accountId")
    if not account_id:
        raise HTTPException(400, "Missing accountId")
    try:
        result = await _questrade_service.place_order(account_id, body.get("order", {}))
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


# ============================================
# PAPER TRADING
# ============================================

@router.get("/api/questrade/paper/summary")
async def paper_summary():
    return _paper_trader.get_account_summary() if _paper_trader else {}


@router.get("/api/questrade/paper/history")
async def paper_history(limit: int = Query(100)):
    return {"history": _paper_trader.get_history(limit) if _paper_trader else []}


@router.post("/api/questrade/paper/reset")
async def paper_reset(request: Request):
    body = await request.json()
    cash = body.get("startingCash")
    return _paper_trader.reset(cash) if _paper_trader else {"success": False}


# ============================================
# BOT CONTROL
# ============================================

async def _questrade_bot_loop():
    while _bot_state["is_active"]:
        try:
            for ticker in _bot_state["watchlist"]:
                try:
                    candles = await _questrade_service.get_candles_by_ticker(ticker, "5m")
                    if not candles or len(candles) < 30:
                        continue

                    signals = _stock_strategy.evaluate(candles, ticker)
                    consensus = _stock_strategy.get_consensus(signals)

                    if consensus["action"] == "BUY" and consensus["confidence"] >= 55:
                        price = candles[-1]["c"]
                        qty = max(1, int((_paper_trader.cash * 0.05) / price))
                        if qty > 0 and _paper_trader.cash >= qty * price:
                            _paper_trader.buy(ticker, qty, price)

                    elif consensus["action"] == "SELL" and ticker in _paper_trader.positions:
                        price = candles[-1]["c"]
                        qty = _paper_trader.positions[ticker]["quantity"]
                        _paper_trader.sell(ticker, qty, price)

                except Exception as e:
                    logger.error(f"Bot error for {ticker}: {e}")

            # Update prices
            for ticker in list(_paper_trader.positions.keys()):
                try:
                    candles = await _questrade_service.get_candles_by_ticker(ticker, "1m")
                    if candles:
                        _paper_trader.update_prices({ticker: candles[-1]["c"]})
                except Exception:
                    pass

        except Exception as e:
            logger.error(f"Questrade bot loop error: {e}")

        await asyncio.sleep(_bot_state["loop_ms"] / 1000)


@router.post("/api/questrade/bot/start")
async def start_questrade_bot(request: Request):
    if _bot_state["is_active"]:
        return {"success": False, "message": "Bot already running"}

    body = await request.json()
    _bot_state["is_active"] = True
    _bot_state["watchlist"] = body.get("watchlist", _bot_state["watchlist"])
    _bot_state["loop_task"] = asyncio.create_task(_questrade_bot_loop())
    return {"success": True, "message": "Questrade bot started"}


@router.post("/api/questrade/bot/stop")
async def stop_questrade_bot():
    _bot_state["is_active"] = False
    if _bot_state["loop_task"]:
        _bot_state["loop_task"].cancel()
        _bot_state["loop_task"] = None
    return {"success": True, "message": "Questrade bot stopped"}
