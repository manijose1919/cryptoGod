"""
Market Data Routes
/api/market-data - Candle data via ccxt (auto-save to SQLite)
/api/instruments - List available trading pairs
"""

from fastapi import APIRouter, Query, HTTPException
import config

router = APIRouter()


def get_trader():
    """Lazy import to avoid circular dependency."""
    from app import get_canuck_trader
    return get_canuck_trader()


@router.get("/api/market-data")
async def get_market_data(
    instrument: str = Query(None, description="Instrument name e.g. BTC_USD"),
    instrument_name: str = Query(None, description="Alias for instrument (frontend compat)"),
    timeframe: str = Query("5m", description="Candle timeframe"),
    count: int = Query(200, ge=1, le=1000),
):
    # Accept either 'instrument' or 'instrument_name' query param
    instrument = instrument or instrument_name or "BTC_USD"
    try:
        # Convert frontend format (BTC_USD) to ccxt format (BTC/USD)
        symbol = instrument.replace("_", "/")
        trader = get_trader()

        if trader and trader.market:
            df = trader.market.fetch_ohlcv(symbol, timeframe, limit=count)
            if df is not None and not df.empty:
                candles = []
                for _, row in df.iterrows():
                    candles.append({
                        "t": int(row["timestamp"].timestamp() * 1000) if hasattr(row["timestamp"], "timestamp") else int(row["timestamp"]),
                        "o": row["open"],
                        "h": row["high"],
                        "l": row["low"],
                        "c": row["close"],
                        "v": row["volume"],
                    })

                # Auto-save to SQLite
                try:
                    from services.database_service import insert_candles_batch
                    ticker_name = instrument.replace("/", "_")
                    batch = [
                        {"ticker": ticker_name, "timeframe": timeframe, "time": c["t"],
                         "open": c["o"], "high": c["h"], "low": c["l"], "close": c["c"], "volume": c["v"]}
                        for c in candles
                    ]
                    insert_candles_batch(batch)
                except Exception:
                    pass

                return {"data": candles, "instrument": instrument, "timeframe": timeframe}

        return {"data": [], "instrument": instrument, "timeframe": timeframe}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/market-data/batch")
async def get_market_data_batch(
    timeframe: str = Query("5m", description="Candle timeframe"),
    count: int = Query(200, ge=1, le=1000),
):
    """Fetch candle data for ALL configured pairs in a single request.
    Saves 8 HTTP round-trips vs fetching each pair individually.
    """
    trader = get_trader()
    if not trader or not trader.market:
        return {"pairs": {}, "timeframe": timeframe}

    result = {}
    for pair in config.PAIRS:
        instrument = pair.replace("/", "_")
        try:
            df = trader.market.fetch_ohlcv(pair, timeframe, limit=count)
            if df is not None and not df.empty:
                candles = []
                for _, row in df.iterrows():
                    candles.append({
                        "t": int(row["timestamp"].timestamp() * 1000) if hasattr(row["timestamp"], "timestamp") else int(row["timestamp"]),
                        "o": row["open"],
                        "h": row["high"],
                        "l": row["low"],
                        "c": row["close"],
                        "v": row["volume"],
                    })
                result[instrument] = candles
        except Exception:
            result[instrument] = []

    return {"pairs": result, "timeframe": timeframe}


@router.get("/api/instruments")
async def get_instruments():
    try:
        trader = get_trader()
        instruments = []
        for pair in config.PAIRS:
            ticker = pair.replace("/", "_")
            instruments.append({
                "instrument_name": ticker,
                "symbol": ticker,
                "base_currency": pair.split("/")[0],
                "quote_currency": pair.split("/")[1],
                "inst_type": "CCY_PAIR",
                "tradable": True,
                "beta_product": False,
            })
        return {"instruments": instruments}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
