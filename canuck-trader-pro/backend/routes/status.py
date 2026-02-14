"""
Status Routes
/api/status - Portfolio, logs, bot state
/api/system/status - All service statuses
"""

import time
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from services import circuit_breaker, beast_mode, adaptive_weights, profit_methods
from services.metrics_service import get_metrics
from services.binance_ws import get_binance_ws
from services.rl_agent import get_rl_agent
from services.sequence_model import get_sequence_predictor
from services.telegram_alerts import get_telegram
from services.session_persistence import save_full_state, get_session_status
from services.stress_test import get_stress_tester
from services.calibration_monitor import get_calibration_monitor
from services.redis_cache import get_redis_cache
from services.portfolio_risk import get_portfolio_risk
from services.trade_journal import get_trade_journal
from services.feature_selector import get_feature_selector
from services.regime_router import get_regime_router
from services.microstructure import get_microstructure
from services.online_learning import get_online_learner
from services.data_integrity import get_data_integrity
from services.transformer_model import get_transformer_model
from services.lstm_model import get_lstm_model

router = APIRouter()


def get_trader():
    from app import get_canuck_trader
    return get_canuck_trader()


def get_app_state():
    from app import get_app_state as _get
    return _get()


@router.get("/api/status")
async def get_status():
    trader = get_trader()
    state = get_app_state()

    portfolio = {}
    logs = state.get("logs", [])
    bot_state = state.get("bot_state", {"is_active": False})

    if trader:
        risk_state = trader.risk.get_portfolio_state()
        portfolio = {
            "cash": risk_state.get("balance", 0),
            "positions": risk_state.get("positions", {}),
            "total_value": risk_state.get("total_value", 0),
        }

    return {
        "portfolio": portfolio,
        "logs": logs[-100:],
        "botState": bot_state,
        "uptime": time.time() - state.get("start_time", time.time()),
        "cycle": trader.cycle_count if trader else 0,
    }


@router.get("/api/risk-budget")
async def get_risk_budget():
    """Get CVaR risk budget, Kelly fraction, drawdown, daily limits."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    return trader.risk.get_risk_budget()


@router.get("/api/risk/var")
async def get_var():
    """Get intraday VaR metrics."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    return {
        "intraday_var": trader.risk.check_intraday_var(),
        "var_cvar": trader.risk.compute_var_cvar(),
    }


@router.get("/api/monte-carlo")
async def get_monte_carlo():
    """Run Monte Carlo stress test simulation."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    return trader.risk.monte_carlo_simulation()


@router.post("/api/telegram/test")
async def test_telegram():
    """Test Telegram bot connection."""
    return get_telegram().test_connection()


@router.get("/api/telegram/status")
async def telegram_status():
    """Get Telegram alert service status."""
    return get_telegram().get_status()


@router.get("/metrics")
async def prometheus_metrics():
    """Prometheus-compatible metrics endpoint."""
    metrics = get_metrics()
    return PlainTextResponse(metrics.export_text(), media_type="text/plain; version=0.0.4")


@router.get("/api/system/status")
async def get_system_status():
    trader = get_trader()
    state = get_app_state()

    return {
        "trading_engine": {
            "running": trader is not None,
            "paused": trader.paused if trader else False,
            "cycle_count": trader.cycle_count if trader else 0,
            "trades_today": trader.trades_today if trader else 0,
            "mode": "PAPER" if (not trader or True) else "LIVE",  # config.PAPER_TRADING
        },
        "circuit_breaker": circuit_breaker.get_status(),
        "beast_mode": beast_mode.get_status(),
        "adaptive_weights": adaptive_weights.get_status(),
        "profit_methods": profit_methods.get_status(),
        "websocket": {
            "clients": state.get("ws_clients", 0),
        },
        "database": {
            "initialized": state.get("db_initialized", False),
        },
        "questrade": state.get("questrade_status", {"authenticated": False}),
        "binance_ws": get_binance_ws().get_status(),
        "rl_agent": get_rl_agent().get_status(),
        "sequence_model": get_sequence_predictor().get_status(),
        "redis_cache": get_redis_cache().get_status(),
        "online_learner": get_online_learner().get_status(),
        "regime_router": get_regime_router().get_status(),
        "trade_journal": get_trade_journal().get_status(),
    }


@router.get("/api/health")
async def health_check():
    """Health check endpoint for VPS monitoring."""
    trader = get_trader()
    result = {
        "status": "ok",
        "uptime": time.time() - get_app_state().get("start_time", time.time()),
        "trading_active": trader is not None and not trader.paused if trader else False,
        "positions_open": len(trader.risk.positions) if trader else 0,
        "ts": time.time(),
    }
    try:
        import os
        import psutil
        proc = psutil.Process(os.getpid())
        result["memory_mb"] = round(proc.memory_info().rss / 1024 / 1024, 1)
        result["cpu_percent"] = proc.cpu_percent(interval=0)
    except ImportError:
        pass
    return result


@router.get("/api/session/status")
async def session_status():
    """Get current session info for dashboard."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    return get_session_status(trader)


@router.post("/api/session/pause")
async def session_pause():
    """Pause the trading bot."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    trader.paused = True
    save_full_state(trader)
    return {"status": "paused", "saved": True}


@router.post("/api/session/resume")
async def session_resume():
    """Resume the trading bot."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    trader.paused = False
    return {"status": "running"}


@router.get("/api/stress-test")
async def stress_test():
    """Run stress test scenarios on current portfolio."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    tester = get_stress_tester()
    return {
        "scenarios": tester.run_scenarios(trader.risk.positions, trader.risk.balance),
        "risk_score": tester.get_risk_score(trader.risk.positions, trader.risk.balance),
    }


@router.get("/api/calibration")
async def calibration():
    """Get model calibration curve."""
    return get_calibration_monitor().get_calibration_curve()


@router.post("/api/session/save")
async def session_save():
    """Force a session state save."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    success = save_full_state(trader)
    return {"saved": success}


# ── New KVM8 Service Routes ──────────────────────────────────────────────


@router.get("/api/data-integrity")
async def data_integrity():
    """Get data integrity report across all pairs."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    try:
        all_data = trader.market.fetch_all_pairs()
        return get_data_integrity().get_data_report(all_data)
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/portfolio-risk")
async def portfolio_risk():
    """Get full portfolio risk report (VaR, CVaR, tail risk, CPPI)."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    try:
        all_data = trader.market.fetch_all_pairs()
        prices = trader.market.get_current_prices()
        returns_data = {}
        for s, df in all_data.items():
            if len(df) >= 20:
                returns_data[s] = df["close"].pct_change().dropna()
        regime = "SIDEWAYS"
        try:
            regime = trader.regime.detect(list(all_data.values())[0]).get("regime", "SIDEWAYS")
        except Exception:
            pass
        return get_portfolio_risk().get_full_risk_report(
            trader.risk.positions, prices, returns_data, regime
        )
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/journal")
async def get_journal():
    """Get recent trade journal entries."""
    return {
        "entries": get_trade_journal().get_recent_entries(20),
        "stats": get_trade_journal().get_trade_stats(),
        "recommendations": get_trade_journal().get_recommendations(),
    }


@router.post("/api/journal/generate")
async def generate_journal():
    """Force-generate a journal entry for current session."""
    return get_trade_journal().generate_journal_entry()


@router.get("/api/journal/patterns")
async def journal_patterns():
    """Get recurring trade patterns analysis."""
    return get_trade_journal().get_pattern_analysis()


@router.get("/api/journal/time-analysis")
async def journal_time():
    """Get hour-of-day performance analysis."""
    return get_trade_journal().get_time_analysis()


@router.get("/api/regime")
async def get_regime():
    """Get current market regime analysis."""
    trader = get_trader()
    if not trader:
        return {"error": "Trader not initialized"}
    try:
        all_data = trader.market.fetch_all_pairs()
        regimes = {}
        for symbol, df in all_data.items():
            if len(df) >= 30:
                regimes[symbol] = get_regime_router().get_current_regime(df, symbol)
        return {
            "regimes": regimes,
            "strategy_matrix": get_regime_router().get_strategy_regime_matrix(),
            "multi_asset": get_regime_router().get_multi_asset_regime(),
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/features/importance")
async def feature_importance():
    """Get feature importance rankings and health."""
    fs = get_feature_selector()
    return {
        "top_features": fs.get_top_features(20),
        "health": fs.get_feature_health(),
        "status": fs.get_status(),
    }


@router.get("/api/ml/models")
async def ml_models_status():
    """Get status of all ML models."""
    result = {}
    try:
        result["transformer"] = get_transformer_model().get_status()
    except Exception:
        result["transformer"] = {"error": "not initialized"}
    try:
        result["lstm"] = get_lstm_model().get_status()
    except Exception:
        result["lstm"] = {"error": "not initialized"}
    try:
        result["online_learner"] = get_online_learner().get_status()
    except Exception:
        result["online_learner"] = {"error": "not initialized"}
    try:
        result["calibration"] = get_calibration_monitor().get_calibration_curve()
    except Exception:
        result["calibration"] = {"error": "not initialized"}
    return result


@router.get("/api/microstructure/{symbol}")
async def microstructure(symbol: str):
    """Get market microstructure analysis for a symbol."""
    micro = get_microstructure()
    symbol_fmt = symbol.replace("USD", "/USD") if "/" not in symbol else symbol
    return {
        "liquidity_score": micro.get_liquidity_score(symbol_fmt),
        "toxicity_score": micro.get_toxicity_score(symbol_fmt),
        "position_adjustment": micro.get_position_size_adjustment(symbol_fmt),
        "status": micro.get_status(),
    }


@router.get("/api/cache/status")
async def cache_status():
    """Get Redis cache status."""
    return get_redis_cache().get_status()


@router.get("/api/services/status")
async def all_services_status():
    """Get comprehensive status of all services."""
    trader = get_trader()
    result = {
        "redis": get_redis_cache().get_status(),
        "calibration": get_calibration_monitor().get_status() if hasattr(get_calibration_monitor(), 'get_status') else {},
        "journal": get_trade_journal().get_status(),
        "feature_selector": get_feature_selector().get_status(),
        "regime_router": get_regime_router().get_status(),
        "microstructure": get_microstructure().get_status(),
    }
    if trader:
        result["portfolio_heat"] = trader.portfolio_heat.get_status() if hasattr(trader.portfolio_heat, 'get_status') else {}
        result["data_integrity"] = trader.data_integrity.get_status() if hasattr(trader.data_integrity, 'get_status') else {}
    return result
