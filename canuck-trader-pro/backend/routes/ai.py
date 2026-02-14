"""
AI Routes
/api/ai/analyze - AI trade analysis (uses LocalAI)
/api/brain/thoughts - AI thinking log
"""

import pandas as pd
from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

_brain_thoughts: list[dict] = []


def get_trader():
    from app import get_canuck_trader
    return get_canuck_trader()


@router.post("/api/ai/analyze")
async def ai_analyze(request: Request):
    try:
        body = await request.json()
        ticker = body.get("ticker", "BTC/USD")
        signals = body.get("signals", [])
        candles = body.get("candles", [])

        trader = get_trader()
        if not trader or not trader.ai:
            return {"action": "HOLD", "confidence": 0, "reasoning": "AI not initialized"}

        # Build DataFrame from candles if provided, otherwise fetch from market
        df = None
        if candles and len(candles) >= 10:
            df = pd.DataFrame(candles)
            # Normalize column names from frontend format
            col_map = {"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "t": "timestamp"}
            df.rename(columns={k: v for k, v in col_map.items() if k in df.columns}, inplace=True)
            for col in ["open", "high", "low", "close", "volume"]:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            # Fetch fresh data via market module
            symbol = ticker.replace("_", "/") if "_" in ticker else ticker
            if "/" not in symbol:
                # Convert BTCUSD -> BTC/USD
                for base in ["BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "LINK", "DOT", "AVAX"]:
                    if symbol.startswith(base):
                        symbol = f"{base}/{symbol[len(base):]}"
                        break
            df = trader.market.fetch_ohlcv(symbol)

        if df is None or len(df) < 10:
            return {"action": "HOLD", "confidence": 0, "reasoning": "Insufficient candle data"}

        result = trader.ai.analyze_trade(ticker, signals, df)
        return {
            "action": result.get("action", "HOLD"),
            "confidence": result.get("confidence", 0),
            "reasoning": result.get("reasoning", ""),
            "agreement": result.get("agreement", False),
            "method": result.get("ml_prediction", {}).get("method", "heuristic"),
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/brain/thoughts")
async def get_thoughts(limit: int = 50):
    return {"thoughts": _brain_thoughts[:limit], "count": len(_brain_thoughts)}


def add_thought(thought: dict):
    _brain_thoughts.insert(0, thought)
    if len(_brain_thoughts) > 50:
        _brain_thoughts.pop()


# ── MLOFI Routes ──────────────────────────────────────────────────────────

@router.get("/api/mlofi/{ticker}")
async def get_mlofi(ticker: str):
    """Get MLOFI (Multi-Level Order Flow Imbalance) data for a ticker."""
    from services.mlofi_service import get_mlofi_service
    service = get_mlofi_service()
    # Convert ticker format: BTCUSD -> BTC/USD
    symbol = ticker
    if "/" not in ticker and "_" not in ticker:
        for base in ["BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "LINK", "DOT", "AVAX"]:
            if ticker.startswith(base):
                symbol = f"{base}/{ticker[len(base):]}"
                break
    elif "_" in ticker:
        symbol = ticker.replace("_", "/")
    data = service.update(symbol)
    if data is None:
        return {"error": "No MLOFI data available", "symbol": symbol}
    return data


@router.get("/api/mlofi")
async def get_all_mlofi():
    """Get MLOFI data for all configured symbols."""
    from services.mlofi_service import get_mlofi_service
    service = get_mlofi_service()
    return service.get_all_symbols()


# ── Liquidation Routes ────────────────────────────────────────────────────

def _normalize_ticker(ticker: str) -> str:
    """Convert BTCUSD or BTC_USD to BTC/USD."""
    if "/" in ticker:
        return ticker
    if "_" in ticker:
        return ticker.replace("_", "/")
    for base in ["BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "LINK", "DOT", "AVAX"]:
        if ticker.startswith(base):
            return f"{base}/{ticker[len(base):]}"
    return ticker


@router.get("/api/liquidation/{ticker}")
async def get_liquidation(ticker: str):
    """Get estimated liquidation levels and magnet signal for a ticker."""
    from services.liquidation_service import get_liquidation_service
    service = get_liquidation_service()
    symbol = _normalize_ticker(ticker)
    data = service.update(symbol)
    if data is None:
        return {"error": "No liquidation data available", "symbol": symbol}
    return data


# ── Derivatives Pressure Routes ───────────────────────────────────────────

@router.get("/api/derivatives-pressure/{ticker}")
async def get_derivatives_pressure(ticker: str):
    """Get composite derivatives pressure score for a ticker."""
    from services.derivatives_pressure import get_derivatives_pressure as get_dp
    service = get_dp()
    symbol = _normalize_ticker(ticker)
    return service.compute(symbol)


# ── Backtest Routes ───────────────────────────────────────────────────────

@router.get("/api/explain/{ticker}")
async def explain_prediction(ticker: str):
    """Get SHAP explanation for the last prediction on a ticker."""
    trader = get_trader()
    if not trader or not trader.ai:
        return {"available": False, "reason": "AI not initialized"}
    symbol = _normalize_ticker(ticker)
    return trader.ai.explain_last_prediction(symbol)


@router.get("/api/cross-asset/{ticker}")
async def get_cross_asset(ticker: str):
    """Get cross-asset correlation analysis for a ticker."""
    from services.cross_asset import get_cross_asset_analyzer
    analyzer = get_cross_asset_analyzer()
    symbol = _normalize_ticker(ticker)
    return analyzer.get_full_analysis(symbol)


@router.get("/api/vpin/{ticker}")
async def get_vpin(ticker: str):
    """Get VPIN (Volume-synchronized Probability of Informed Trading) for a ticker."""
    from services.vpin_service import get_vpin_calculator
    calc = get_vpin_calculator()
    symbol = _normalize_ticker(ticker)
    # Initialize from recent candles if needed
    trader = get_trader()
    if trader:
        df = trader.market.fetch_ohlcv(symbol)
        if df is not None and len(df) > 0:
            calc.initialize_from_candles(symbol, df)
    return calc.compute_vpin(symbol)


@router.get("/api/regime/{ticker}")
async def get_regime(ticker: str):
    """Get market regime detection for a ticker."""
    from services.regime_detector import get_regime_detector
    detector = get_regime_detector()
    symbol = _normalize_ticker(ticker)
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    df = trader.market.fetch_ohlcv(symbol)
    if df is None or len(df) < 30:
        return {"error": "Not enough data", "symbol": symbol}
    return detector.detect(symbol, df)


@router.post("/api/backtest/run")
async def run_backtest(request: Request):
    """Run a backtest on historical data."""
    from services.walk_forward import get_walk_forward_engine
    body = await request.json()
    ticker = body.get("ticker", "BTC/USD")
    timeframe = body.get("timeframe", "5m")
    count = body.get("count", 500)
    strategy_filter = body.get("strategies", None)
    position_pct = body.get("position_pct", 0.10)
    stop_atr_mult = body.get("stop_atr_mult", 2.0)
    min_confidence = body.get("min_confidence", 40)

    # Fetch candles
    trader = get_trader()
    if not trader:
        raise HTTPException(500, "Trader not initialized")

    symbol = _normalize_ticker(ticker)
    df = trader.market.fetch_ohlcv(symbol, timeframe=timeframe, limit=count)
    if df is None or len(df) < 50:
        raise HTTPException(400, f"Not enough data for {symbol}")

    engine = get_walk_forward_engine()
    result = engine.run_backtest(
        df,
        strategy_filter=strategy_filter,
        position_pct=position_pct,
        stop_atr_mult=stop_atr_mult,
        min_confidence=min_confidence,
    )
    return {"ticker": ticker, "timeframe": timeframe, "candles": len(df), **result.to_dict()}


@router.post("/api/backtest/walk-forward")
async def run_walk_forward(request: Request):
    """Run walk-forward analysis."""
    from services.walk_forward import get_walk_forward_engine
    body = await request.json()
    ticker = body.get("ticker", "BTC/USD")
    timeframe = body.get("timeframe", "5m")
    count = body.get("count", 1000)
    n_windows = body.get("n_windows", 5)

    trader = get_trader()
    if not trader:
        raise HTTPException(500, "Trader not initialized")

    symbol = _normalize_ticker(ticker)
    df = trader.market.fetch_ohlcv(symbol, timeframe=timeframe, limit=count)
    if df is None or len(df) < 200:
        raise HTTPException(400, f"Not enough data for walk-forward ({symbol})")

    engine = get_walk_forward_engine()
    result = engine.walk_forward(df, n_windows=n_windows)
    return {"ticker": ticker, "timeframe": timeframe, "candles": len(df), **result}
