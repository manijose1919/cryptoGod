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
    """Get recent trade journal entries with real stats from trade_memory."""
    journal = get_trade_journal()
    stats = journal.get_trade_stats()

    # If journal table is empty, compute stats from trade_memory (the real trade log)
    if stats.get("overall", {}).get("total_trades", 0) == 0:
        try:
            from services.database_service import get_db
            db = get_db()
            rows = db.execute(
                "SELECT pnl_percent, outcome, hold_duration, strategy, ticker "
                "FROM trade_memory WHERE outcome IS NOT NULL AND hold_duration >= 1.0 "
                "ORDER BY created_at DESC LIMIT 2000"
            ).fetchall()
            if rows:
                trades = [{"pnl_percent": r[0], "outcome": r[1], "hold_min": r[2],
                           "strategy": r[3], "ticker": r[4]} for r in rows]
                wins = [t for t in trades if t["outcome"] == "WIN"]
                losses = [t for t in trades if t["outcome"] == "LOSS"]
                win_pcts = [t["pnl_percent"] for t in wins]
                loss_pcts = [abs(t["pnl_percent"]) for t in losses]
                total = len(trades)
                win_rate = len(wins) / total * 100 if total else 0

                # Per-strategy breakdown
                strat_map = {}
                for t in trades:
                    s = t["strategy"]
                    if s not in strat_map:
                        strat_map[s] = {"trades": 0, "wins": 0, "pnl_sum": 0}
                    strat_map[s]["trades"] += 1
                    strat_map[s]["pnl_sum"] += t["pnl_percent"]
                    if t["outcome"] == "WIN":
                        strat_map[s]["wins"] += 1
                per_strategy = {
                    s: {"trades": v["trades"],
                        "win_rate": round(v["wins"] / v["trades"] * 100, 1) if v["trades"] else 0,
                        "total_pnl_pct": round(v["pnl_sum"], 3)}
                    for s, v in strat_map.items()
                }

                gross_win = sum(win_pcts) if win_pcts else 0
                gross_loss = sum(loss_pcts) if loss_pcts else 0

                stats = {
                    "overall": {
                        "total_trades": total,
                        "wins": len(wins),
                        "losses": len(losses),
                        "breakeven": total - len(wins) - len(losses),
                        "win_rate": round(win_rate, 1),
                        "total_pnl_pct": round(sum(t["pnl_percent"] for t in trades), 3),
                        "avg_pnl_pct": round(sum(t["pnl_percent"] for t in trades) / total, 4) if total else 0,
                        "avg_win_pct": round(sum(win_pcts) / len(win_pcts), 4) if win_pcts else 0,
                        "avg_loss_pct": round(sum(loss_pcts) / len(loss_pcts), 4) if loss_pcts else 0,
                        "largest_win_pct": round(max(win_pcts), 4) if win_pcts else 0,
                        "largest_loss_pct": round(max(loss_pcts), 4) if loss_pcts else 0,
                        "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else 0,
                        "avg_hold_min": round(sum(t["hold_min"] for t in trades) / total, 1) if total else 0,
                    },
                    "per_strategy": per_strategy,
                    "per_asset": {},
                    "streaks": {"longest_win": 0, "longest_loss": 0, "current_streak": 0, "current_type": "NONE"},
                    "risk_adjusted": {"sharpe": 0, "sortino": 0, "calmar": 0},
                    "source": "trade_memory",
                }
        except Exception:
            pass

    return {
        "entries": journal.get_recent_entries(20),
        "stats": stats,
        "recommendations": journal.get_recommendations(),
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


@router.get("/api/ml/status")
async def ml_status():
    """Get ML status in format expected by MLDashboard frontend component."""
    from services.database_service import get_db

    trader = get_trader()
    has_model = False
    latest_model = None
    model_history = []
    prediction_accuracy = {"total": 0, "correct": None, "avg_confidence": None, "accuracy_pct": None}

    # ── Real trade win rate from DB (this is what matters) ──
    # Bot writes completed trades to trade_memory (not trades table)
    # Only count trades held >= 1 minute to exclude garbage micro-trades
    real_win_rate = 0.0
    total_trades = 0
    total_wins = 0
    total_losses = 0
    total_breakeven = 0
    avg_pnl = 0.0
    try:
        db = get_db()
        row = db.execute(
            "SELECT COUNT(*) as total, "
            "SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins, "
            "SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses, "
            "SUM(CASE WHEN outcome='BREAKEVEN' THEN 1 ELSE 0 END) as breakeven, "
            "AVG(pnl_percent) as avg_pnl "
            "FROM trade_memory WHERE outcome IS NOT NULL AND hold_duration >= 1.0"
        ).fetchone()
        total_trades = row["total"] or 0
        total_wins = row["wins"] or 0
        total_losses = row["losses"] or 0
        total_breakeven = row["breakeven"] or 0
        avg_pnl = round(row["avg_pnl"] or 0, 4)
        if total_trades > 0:
            real_win_rate = round(total_wins / total_trades * 100, 1)
    except Exception:
        pass

    # ── ML model info (separate from trade performance) ──
    ml_model_accuracy = 0.0
    try:
        transformer = get_transformer_model()
        t_status = transformer.get_status()
        if t_status.get("trained"):
            has_model = True
            ml_model_accuracy = t_status.get("accuracy", 0) or 0
            latest_model = {
                "id": 1,
                "modelType": "Transformer-Lite + LSTM + Online",
                "accuracy": real_win_rate,  # Show REAL win rate, not ML training accuracy
                "mlModelAccuracy": round(ml_model_accuracy, 1),  # Keep ML accuracy separate
                "sampleCount": total_trades,  # Real trade count
                "trainedAt": int(time.time() * 1000),
            }
    except Exception:
        pass

    # ── Prediction accuracy from online learner ──
    try:
        ol = get_online_learner()
        ol_status = ol.get_status()
        total_preds = ol_status.get("total_predictions", 0)
        val_acc = ol_status.get("validation_accuracy", 0)
        if total_preds > 0:
            prediction_accuracy = {
                "total": total_preds,
                "correct": int(total_preds * val_acc) if val_acc else None,
                "avg_confidence": None,
                "accuracy_pct": round(val_acc * 100, 1) if val_acc else None,
            }
    except Exception:
        pass

    return {
        "hasModel": has_model,
        "latestModel": latest_model,
        "predictionAccuracy": prediction_accuracy,
        "modelHistory": model_history,
        # ── Real trade performance (new fields) ──
        "tradePerformance": {
            "winRate": real_win_rate,
            "totalTrades": total_trades,
            "wins": total_wins,
            "losses": total_losses,
            "breakeven": total_breakeven,
            "avgPnlPercent": avg_pnl,
        },
    }


@router.get("/api/ml/predictions/{ticker}")
async def ml_predictions(ticker: str):
    """Get ML predictions for a ticker."""
    trader = get_trader()
    predictions = []
    try:
        if trader and hasattr(trader, 'local_ai'):
            ai = trader.local_ai
            symbol = ticker.replace("USD", "/USD") if "/" not in ticker else ticker
            result = ai.analyze_trade(symbol, "BUY", {})
            if result:
                predictions.append({
                    "id": 1,
                    "timestamp": int(time.time() * 1000),
                    "prediction": result.get("direction", "HOLD"),
                    "confidence": result.get("confidence", 0),
                    "actual_outcome": None,
                    "was_correct": None,
                })
    except Exception:
        pass
    return {"predictions": predictions}


@router.get("/api/ml/feature-importance")
async def ml_feature_importance():
    """Get ML feature importance rankings."""
    fs = get_feature_selector()
    top = fs.get_top_features(20)
    result = []
    for i, feat in enumerate(top):
        if isinstance(feat, dict):
            result.append({
                "name": feat.get("feature", f"feature_{i}"),
                "importance": feat.get("importance", 0),
                "rank": i + 1,
            })
        elif isinstance(feat, (list, tuple)) and len(feat) >= 2:
            result.append({
                "name": str(feat[0]),
                "importance": float(feat[1]),
                "rank": i + 1,
            })
    return result


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
