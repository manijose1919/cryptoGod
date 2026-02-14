"""
Canuck-Trader-Pro - Main Entry Point
Orchestrates: market data → 25 strategies → local ML → risk management → ZMQ broadcast.
Now also runs FastAPI HTTP server for the React frontend.
"""
import json
import logging
import signal
import sys
import time
import threading

import numpy as np
import pandas as pd
import ta

import config
from feature_engineer import build_feature_vector
from local_ai import LocalAI
from market_data import MarketData
from risk_manager import RiskManager
from sentiment_analyzer import SentimentAnalyzer
from strategy_engine import StrategyEngine
from zmq_server import ZMQServer
from services.mlofi_service import get_mlofi_service
from services.liquidation_service import get_liquidation_service
from services.derivatives_pressure import get_derivatives_pressure
from services.event_loop import EventDrivenLoop
from services.regime_detector import get_regime_detector
from services.vpin_service import get_vpin_calculator
from services.cross_asset import get_cross_asset_analyzer
from services import circuit_breaker
from services import beast_mode
from services import profit_methods
from services import adaptive_weights
from services.mtf_confluence import get_mtf_confluence
from services.time_filters import get_combined_time_adjustment
from services.signal_scanner import analyze_candles
from services.anomaly_detector import get_anomaly_detector
from services.meta_learner import get_meta_learner
from services.metrics_service import get_metrics
from services.rl_agent import get_rl_agent
from services.sequence_model import get_sequence_predictor
from services.binance_ws import get_binance_ws
from services.smart_order_router import get_smart_router
from services.iceberg_orders import get_iceberg_splitter
from services.telegram_alerts import get_telegram
from services.hyperopt import get_hyperoptimizer
from services.execution_algos import get_execution_manager, ExecAlgo
from services.walk_forward import get_walk_forward_engine
from services.session_persistence import save_full_state, restore_full_state, get_session_status
from services.stacking_ensemble import get_stacking_ensemble
from services.advanced_exits import get_advanced_exits
from services.portfolio_heat import get_portfolio_heat
from services.orderbook_heatmap import get_orderbook_heatmap
from services.funding_carry import get_funding_carry
from services.calibration_monitor import get_calibration_monitor
from services.stress_test import get_stress_tester
from services.data_integrity import get_data_integrity
from services.stat_arb import get_stat_arb
from services.redis_cache import get_redis_cache
from services.transformer_model import get_transformer_model
from services.lstm_model import get_lstm_model
from services.online_learning import get_online_learner
from services.smart_exits import get_smart_exits
from services.ws_multiplexer import get_ws_multiplexer
from services.portfolio_risk import get_portfolio_risk
from services.parallel_engine import get_parallel_engine
from services.microstructure import get_microstructure
from services.feature_selector import get_feature_selector
from services.regime_router import get_regime_router
from services.trade_journal import get_trade_journal
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Logging Setup ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(config.LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger("main")


class CanuckTrader:
    """Main trading engine orchestrator."""

    def __init__(self):
        logger.info("=" * 60)
        logger.info("  CANUCK-TRADER-PRO starting up...")
        logger.info(f"  Mode: {'PAPER' if config.PAPER_TRADING else 'LIVE'}")
        logger.info(f"  Pairs: {len(config.PAIRS)}")
        logger.info(f"  Strategies: 25")
        logger.info(f"  AI: Local ML (GradientBoosting + VADER + Adaptive Weights)")
        logger.info("=" * 60)

        self.market = MarketData()
        self.engine = StrategyEngine()
        self.risk = RiskManager()
        self.ai = LocalAI()
        self.sentiment = SentimentAnalyzer(self.ai)
        self.zmq = ZMQServer()
        self.mlofi = get_mlofi_service()
        self.liquidation = get_liquidation_service()
        self.derivatives = get_derivatives_pressure()
        self.event_loop = EventDrivenLoop()
        self.regime = get_regime_detector()
        self.vpin = get_vpin_calculator()
        self.cross_asset = get_cross_asset_analyzer()
        self.mtf = get_mtf_confluence()
        self.anomaly = get_anomaly_detector()
        self.meta_learner = get_meta_learner()
        self.metrics = get_metrics()
        # Lazy-initialized heavy services (deferred until first use)
        self._rl_agent = None
        self._seq_model = None
        self._hyperopt = None
        self._walk_forward = None
        self._stacking = None
        self._stat_arb = None
        self._transformer = None
        self._lstm = None
        self._online_learner = None
        self._portfolio_risk = None

        # Lightweight services (instant init)
        self.binance_ws = get_binance_ws()
        self.smart_router = get_smart_router()
        self.smart_router.set_binance_ws(self.binance_ws)
        self.iceberg = get_iceberg_splitter()
        self.telegram = get_telegram()
        self.exec_manager = get_execution_manager()
        self.advanced_exits = get_advanced_exits()
        self.portfolio_heat = get_portfolio_heat()
        self.ob_heatmap = get_orderbook_heatmap()
        self.funding_carry = get_funding_carry()
        self.calibration = get_calibration_monitor()
        self.stress_tester = get_stress_tester()
        self.data_integrity = get_data_integrity()
        self.redis = get_redis_cache()
        self.smart_exits_svc = get_smart_exits()
        self.microstructure = get_microstructure()
        self.feature_selector = get_feature_selector()
        self.regime_router = get_regime_router()
        self.journal = get_trade_journal()
        self._thread_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="pair-analysis")  # KVM8: 8 threads

        # Adaptive confidence threshold (learned from performance)
        self._adaptive_conf_threshold = config.MIN_CONFIDENCE if hasattr(config, 'MIN_CONFIDENCE') else 40
        self._conf_threshold_history: list = []  # (threshold, win_rate) pairs

        # Regime-strategy mapping
        self._regime_strategy_map = {
            "UPTREND": {"EMA_CROSSOVER", "TRIPLE_EMA", "MACD", "ADX_TREND", "SUPERTREND", "MOMENTUM_ROC", "VWAP", "ICHIMOKU"},
            "DOWNTREND": {"RSI", "STOCH_RSI", "WILLIAMS_R", "CCI", "MEAN_REVERT", "RSI_DIVERGENCE", "MACD_DIVERGENCE", "ENGULFING"},
            "SIDEWAYS": {"BOLLINGER", "KELTNER", "DONCHIAN", "VOL_SQUEEZE", "MEAN_REVERT", "PIVOT_POINTS", "ATR_BREAKOUT"},
            "HIGH_VOL": {"ATR_BREAKOUT", "DONCHIAN", "VOL_SPIKE", "MOMENTUM_ROC", "ENGULFING"},
            "LOW_VOL": {"BOLLINGER", "KELTNER", "VOL_SQUEEZE", "MEAN_REVERT", "VWAP"},
        }

        # Nightly task tracking
        self._last_nightly_run = 0

        # Initialize circuit breaker & beast mode with starting balance
        circuit_breaker.set_daily_balance(config.STARTING_BALANCE)
        beast_mode.set_session_balance(config.STARTING_BALANCE)

        self.paused = False
        self.cycle_count = 0
        self.start_time = time.time()
        self.trades_today = 0
        self.wins_today = 0
        self.losses_today = 0
        self._last_scan = {}       # symbol -> full scan data
        self._last_trade = None

        # Backfill historical candles on startup (async, best-effort)
        try:
            self.market.backfill_historical(timeframes=["5m", "15m", "1h"], limit=200)
        except Exception as e:
            logger.warning(f"Historical backfill failed (non-critical): {e}")

        # Session persistence: restore previous state if available
        self._auto_save_interval = 60  # seconds
        self._last_auto_save = time.time()
        try:
            restore_result = restore_full_state(self)
            if restore_result.get("restored"):
                logger.info(f"Session restored: ${restore_result['balance']:.2f}, "
                            f"{restore_result['positions_restored']} positions, "
                            f"{restore_result['age_hours']:.1f}h old")
                if restore_result.get("was_active"):
                    logger.info("Previous session was active - auto-resuming bot")
            else:
                logger.info(f"No session to restore: {restore_result.get('reason', 'unknown')}")
        except Exception as e:
            logger.warning(f"Session restore failed (non-critical): {e}")

        self._setup_commands()

    # ── Lazy-init properties for heavy services ─────────────────────────────

    @property
    def rl_agent(self):
        if self._rl_agent is None:
            self._rl_agent = get_rl_agent()
            logger.debug("RL agent initialized (lazy)")
        return self._rl_agent

    @property
    def seq_model(self):
        if self._seq_model is None:
            self._seq_model = get_sequence_predictor()
            logger.debug("Sequence model initialized (lazy)")
        return self._seq_model

    @property
    def hyperopt(self):
        if self._hyperopt is None:
            self._hyperopt = get_hyperoptimizer()
            logger.debug("Hyperoptimizer initialized (lazy)")
        return self._hyperopt

    @property
    def walk_forward(self):
        if self._walk_forward is None:
            self._walk_forward = get_walk_forward_engine()
            logger.debug("Walk-forward engine initialized (lazy)")
        return self._walk_forward

    @property
    def stacking(self):
        if self._stacking is None:
            self._stacking = get_stacking_ensemble()
            logger.debug("Stacking ensemble initialized (lazy)")
        return self._stacking

    @property
    def stat_arb(self):
        if self._stat_arb is None:
            self._stat_arb = get_stat_arb()
            logger.debug("Stat arb initialized (lazy)")
        return self._stat_arb

    @property
    def transformer(self):
        if self._transformer is None:
            self._transformer = get_transformer_model()
            logger.debug("Transformer model initialized (lazy)")
        return self._transformer

    @property
    def lstm(self):
        if self._lstm is None:
            self._lstm = get_lstm_model()
            logger.debug("LSTM model initialized (lazy)")
        return self._lstm

    @property
    def online_learner(self):
        if self._online_learner is None:
            self._online_learner = get_online_learner()
            logger.debug("Online learner initialized (lazy)")
        return self._online_learner

    @property
    def portfolio_risk(self):
        if self._portfolio_risk is None:
            self._portfolio_risk = get_portfolio_risk()
            logger.debug("Portfolio risk initialized (lazy)")
        return self._portfolio_risk

    def _setup_commands(self):
        """Register ZMQ command handlers."""
        self.zmq.register_command("pause", self._cmd_pause)
        self.zmq.register_command("resume", self._cmd_resume)
        self.zmq.register_command("panic", self._cmd_panic)
        self.zmq.register_command("status", self._cmd_status)
        self.zmq.register_command("portfolio", self._cmd_portfolio)
        self.zmq.register_command("ai_stats", self._cmd_ai_stats)

    def _cmd_pause(self, params):
        self.paused = True
        logger.info("PAUSED by dashboard command")
        return {"status": "paused"}

    def _cmd_resume(self, params):
        self.paused = False
        logger.info("RESUMED by dashboard command")
        return {"status": "running"}

    def _cmd_panic(self, params):
        logger.warning("PANIC SELL triggered!")
        prices = self.market.get_current_prices()
        closed = []
        for symbol in list(self.risk.positions.keys()):
            if symbol in prices:
                result = self.risk.close_position(symbol, prices[symbol])
                if result:
                    result["reason"] = "PANIC_SELL"
                    closed.append(result)
                    self.zmq.publish_trade(result)
                    self.ai.record_trade_outcome(symbol, result.get("side", "BUY"), result["pnl_pct"])
        self.paused = True
        return {"status": "panic_executed", "closed": closed}

    def _cmd_status(self, params):
        ai_stats = self.ai.get_model_stats()
        return {
            "paused": self.paused,
            "cycle": self.cycle_count,
            "positions": len(self.risk.positions),
            "halted": self.risk.halted,
            "ai_method": ai_stats["predictor"]["method"],
            "ai_samples": ai_stats["predictor"]["training_samples"],
        }

    def _cmd_portfolio(self, params):
        return self.risk.get_portfolio_state()

    def _cmd_ai_stats(self, params):
        return self.ai.get_model_stats()

    # ── Asset Intelligence ─────────────────────────────────────────────────

    def _compute_asset_intel(self, symbol: str, df: pd.DataFrame) -> dict:
        """Compute volatility profile and asset intelligence for a pair."""
        close = df["close"]
        high = df["high"]
        low = df["low"]
        volume = df["volume"]
        n = len(df)

        # Volatility (ATR %)
        atr_val = 0
        if n >= 15:
            atr_val = ta.volatility.AverageTrueRange(high, low, close, window=14).average_true_range().iloc[-1]
        atr_pct = (atr_val / close.iloc[-1] * 100) if close.iloc[-1] else 0

        # Returns
        ret_1h = ((close.iloc[-1] - close.iloc[-12]) / close.iloc[-12] * 100) if n > 12 else 0
        ret_24h = ((close.iloc[-1] - close.iloc[-288]) / close.iloc[-288] * 100) if n > 288 else 0
        ret_5m = ((close.iloc[-1] - close.iloc[-2]) / close.iloc[-2] * 100) if n > 2 else 0

        # Volume profile
        avg_vol = volume.rolling(20).mean().iloc[-1] if n >= 20 else volume.mean()
        vol_ratio = (volume.iloc[-1] / avg_vol) if avg_vol > 0 else 1.0

        # RSI
        rsi_val = ta.momentum.rsi(close, window=14).iloc[-1] if n >= 15 else 50

        # Trend (EMA 20 vs 50)
        trend = "NEUTRAL"
        if n >= 50:
            ema20 = ta.trend.ema_indicator(close, window=20).iloc[-1]
            ema50 = ta.trend.ema_indicator(close, window=50).iloc[-1]
            if ema20 > ema50 * 1.002:
                trend = "BULLISH"
            elif ema20 < ema50 * 0.998:
                trend = "BEARISH"

        # Bollinger position
        bb_pos = 50
        if n >= 20:
            bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
            bb_upper = bb.bollinger_hband().iloc[-1]
            bb_lower = bb.bollinger_lband().iloc[-1]
            bb_range = bb_upper - bb_lower
            if bb_range > 0:
                bb_pos = round((close.iloc[-1] - bb_lower) / bb_range * 100, 1)

        return {
            "symbol": symbol,
            "price": round(float(close.iloc[-1]), 6),
            "atr_pct": round(atr_pct, 3),
            "volatility": "HIGH" if atr_pct > 1.5 else "MEDIUM" if atr_pct > 0.5 else "LOW",
            "ret_5m": round(ret_5m, 3),
            "ret_1h": round(ret_1h, 3),
            "ret_24h": round(ret_24h, 3),
            "volume_ratio": round(vol_ratio, 2),
            "rsi": round(rsi_val, 1),
            "trend": trend,
            "bb_position": bb_pos,
        }

    # ── Main Analysis Cycle ────────────────────────────────────────────────

    def _analyze_pair(self, symbol: str, df: pd.DataFrame, all_data: dict = None) -> dict:
        """Run full analysis on one pair. Returns scan data for that pair."""
        # 1. Run 25 strategies
        signals = self.engine.run_all(df)

        # 1b. Regime-based strategy filtering — disable strategies bad for current regime
        try:
            regime_info = self.regime.detect(df)
            current_regime = regime_info.get("regime", "SIDEWAYS")
            allowed_strategies = self._regime_strategy_map.get(current_regime, set())
            if allowed_strategies:
                for sig in signals:
                    if sig["name"] not in allowed_strategies and sig["signal"] != "HOLD":
                        sig["confidence"] = int(sig["confidence"] * 0.3)  # Heavily penalize, don't zero
        except Exception:
            current_regime = "UNKNOWN"

        raw_consensus = self.engine.get_consensus(signals)

        # 2. Fetch MLOFI features + cross-asset features
        mlofi_features = self.mlofi.get_features(symbol)
        cross_asset_features = self.cross_asset.get_features(symbol)

        # 2b. Compute MTF alignment score
        mtf_data = self.mtf.compute_alignment(symbol, df)
        mtf_score = mtf_data["score"]

        # 3. Run local AI analysis (with MLOFI + cross-asset + MTF + temporal)
        last_trade_time = self._last_trade["ts"] if self._last_trade else self.start_time
        minutes_since = (time.time() - last_trade_time) / 60.0
        ai_result = self.ai.analyze_trade(symbol, signals, df,
                                          mlofi_features=mlofi_features,
                                          cross_asset_features=cross_asset_features,
                                          mtf_score=mtf_score,
                                          minutes_since_last_trade=minutes_since)
        action = ai_result["action"]
        confidence = ai_result["confidence"]

        # 4. Apply MLOFI confidence adjustment
        mlofi_adj = self.mlofi.get_confidence_adjustment(symbol, action)
        if mlofi_adj != 0:
            confidence = max(0, min(95, confidence + mlofi_adj))

        # 4b. Apply liquidation proximity adjustment
        liq_adj = self.liquidation.get_confidence_adjustment(symbol, action)
        if liq_adj != 0:
            confidence = max(0, min(95, confidence + liq_adj))

        # 4c. Apply sentiment adjustment
        try:
            sentiment = self.sentiment.get_sentiment(symbol)
            sent_score = sentiment.get("score", 0)  # -100 to 100
            # Strong sentiment alignment: boost; strong disagreement: penalize
            if action == "BUY" and sent_score > 20:
                confidence = min(95, confidence + min(10, int(sent_score / 10)))
            elif action == "BUY" and sent_score < -30:
                confidence = max(0, confidence - min(10, int(abs(sent_score) / 10)))
            elif action == "SELL" and sent_score < -20:
                confidence = min(95, confidence + min(10, int(abs(sent_score) / 10)))
            elif action == "SELL" and sent_score > 30:
                confidence = max(0, confidence - min(10, int(sent_score / 10)))
        except Exception as e:
            logger.debug(f"Sentiment fetch error for {symbol}: {e}")

        # 4d. Apply derivatives pressure adjustment
        deriv_adj = self.derivatives.get_confidence_adjustment(symbol, action)
        if deriv_adj != 0:
            confidence = max(0, min(95, confidence + deriv_adj))
        # Feed funding rate to carry service
        try:
            deriv_data = self.derivatives.get_pressure(symbol)
            fr = deriv_data.get("funding_rate")
            if fr is not None:
                self.funding_carry.record_funding_rate(symbol, fr, time.time())
        except Exception:
            pass

        # 4e. Regime detection for strategy filtering
        regime_data = self.regime.detect(symbol, df)

        # 4f. VPIN toxic flow detection
        self.vpin.initialize_from_candles(symbol, df.tail(50))
        vpin_adj = self.vpin.get_confidence_adjustment(symbol, action)
        if vpin_adj != 0:
            confidence = max(0, min(95, confidence + vpin_adj))

        # 4g. Multi-timeframe confluence
        mtf_adj = self.mtf.get_confidence_adjustment(symbol, action, df)
        if mtf_adj != 0:
            confidence = max(0, min(95, confidence + mtf_adj))

        # 4h. Time-of-day filter
        time_adj = get_combined_time_adjustment()
        if time_adj["total_adjustment"] != 0:
            confidence = max(0, min(95, confidence + time_adj["total_adjustment"]))

        # 4i. Signal scanner cross-check (multi-indicator confluence)
        try:
            candle_dicts = [{"c": r["close"], "h": r["high"], "l": r["low"], "v": r.get("volume", 0)} for _, r in df.iterrows()]
            scanner_result = analyze_candles(candle_dicts, symbol.replace("/", ""))
            if scanner_result["signal"] == action and scanner_result["score"] >= 5:
                confidence = min(95, confidence + 5)
            elif scanner_result["signal"] and scanner_result["signal"] != action and scanner_result["score"] >= 5:
                confidence = max(0, confidence - 5)
        except Exception:
            pass

        # 4j. Anomaly detection (Isolation Forest)
        anomaly_adj = self.anomaly.get_confidence_adjustment(symbol, action, df)
        if anomaly_adj != 0:
            confidence = max(0, min(95, confidence + anomaly_adj))

        # 4j0. Volatility breakout filter (ATR expansion/compression)
        try:
            if len(df) >= 30:
                atr_series = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"], window=14).average_true_range()
                curr_atr = atr_series.iloc[-1]
                avg_atr = atr_series.rolling(20).mean().iloc[-1]
                if avg_atr > 0:
                    atr_ratio = curr_atr / avg_atr
                    if atr_ratio > 2.0 and action in ("BUY", "SELL"):
                        # Volatility expansion: favor breakout signals
                        confidence = min(95, confidence + 8)
                    elif atr_ratio < 0.5 and action in ("BUY", "SELL"):
                        # Volatility compression: favor mean-reversion
                        confidence = min(95, confidence + 5)
        except Exception:
            pass

        # 4j1. Gap detection (price gaps between candle close and next open)
        try:
            if len(df) >= 3:
                prev_close = df["close"].iloc[-2]
                curr_open = df["open"].iloc[-1]
                gap_pct = (curr_open - prev_close) / prev_close * 100
                if abs(gap_pct) > 0.5:  # Significant gap (>0.5%)
                    if gap_pct > 0 and action == "BUY":
                        confidence = min(95, confidence + 5)  # Gap up confirms BUY
                    elif gap_pct < 0 and action == "SELL":
                        confidence = min(95, confidence + 5)  # Gap down confirms SELL
                    elif gap_pct > 0.8 and action == "SELL":
                        confidence = min(95, confidence + 8)  # Large gap up → fade opportunity
                    elif gap_pct < -0.8 and action == "BUY":
                        confidence = min(95, confidence + 8)  # Large gap down → bounce opportunity
        except Exception:
            pass

        # 4j2. Bollinger Bandwidth squeeze detection
        try:
            if len(df) >= 20:
                bb = ta.volatility.BollingerBands(df["close"], window=20, window_dev=2)
                bandwidth = bb.bollinger_wband().iloc[-1]
                bw_mean = bb.bollinger_wband().rolling(50).mean().iloc[-1] if len(df) >= 50 else bandwidth
                if bw_mean > 0 and bandwidth < bw_mean * 0.5:
                    # Squeeze detected: low volatility, expect breakout
                    if action in ("BUY", "SELL"):
                        confidence = min(95, confidence + 7)
        except Exception:
            pass

        # 4j3. Orderflow delta divergence (buy vs sell volume approximation)
        try:
            if len(df) >= 5:
                # Approximate: if close > open, volume is "buy"; if close < open, volume is "sell"
                recent = df.tail(5)
                buy_vol = recent.loc[recent["close"] >= recent["open"], "volume"].sum()
                sell_vol = recent.loc[recent["close"] < recent["open"], "volume"].sum()
                total = buy_vol + sell_vol
                if total > 0:
                    delta = (buy_vol - sell_vol) / total  # -1 to +1
                    if action == "BUY" and delta > 0.3:
                        confidence = min(95, confidence + 5)
                    elif action == "BUY" and delta < -0.3:
                        confidence = max(0, confidence - 5)
                    elif action == "SELL" and delta < -0.3:
                        confidence = min(95, confidence + 5)
                    elif action == "SELL" and delta > 0.3:
                        confidence = max(0, confidence - 5)
        except Exception:
            pass

        # 4k. Mean reversion after extreme moves (>3% in 12 candles = 1h on 5m)
        if len(df) >= 13:
            ret_1h = (df["close"].iloc[-1] - df["close"].iloc[-13]) / df["close"].iloc[-13]
            rsi_val = asset_intel.get("rsi", 50)
            if ret_1h < -0.03 and rsi_val < 30 and action == "BUY":
                confidence = min(95, confidence + 10)
            elif ret_1h > 0.03 and rsi_val > 70 and action == "SELL":
                confidence = min(95, confidence + 10)

        # 4l. Relative strength / anti-correlation boost
        try:
            ca_data = self.cross_asset.get_full_analysis(symbol)
            rel_mom = ca_data.get("btc_relative_momentum", 0)
            # If this alt is outperforming BTC while BTC is dropping, boost BUY confidence
            if action == "BUY" and rel_mom > 0.5:
                confidence = min(95, confidence + 5)
            elif action == "SELL" and rel_mom < -0.5:
                confidence = min(95, confidence + 5)
        except Exception:
            pass

        # 4m. Sequence model (GRU) prediction
        try:
            seq_adj = self.seq_model.get_confidence_adjustment(df, action)
            confidence = max(0, min(95, confidence + seq_adj))
            # Record training sample for sequence model
            self.seq_model.record_sequence(df)
        except Exception:
            pass

        # 4n. RL agent confidence adjustment
        try:
            pos_info = {
                "has_position": symbol in self.risk.positions,
                "unrealized_pnl": self.risk.positions.get(symbol, {}).get("unrealized_pnl", 0),
                "hold_duration_min": (time.time() - self.risk.positions.get(symbol, {}).get("entry_time", time.time())) / 60 if symbol in self.risk.positions else 0,
            }
            last_features = self.ai._last_features.get(symbol)
            if last_features is not None:
                rl_adj = self.rl_agent.get_confidence_adjustment(last_features, pos_info, action)
                confidence = max(0, min(95, confidence + rl_adj))
                # Step the RL agent (for learning)
                self.rl_agent.step(last_features, pos_info, reward=0.0)
        except Exception:
            pass

        # 4o. Order book heatmap signals
        try:
            depth_data = self.binance_ws.get_depth(symbol)
            if depth_data:
                self.ob_heatmap.analyze_depth(symbol, depth_data)
                ob_adj = self.ob_heatmap.get_confidence_adjustment(symbol, action)
                if ob_adj != 0:
                    confidence = max(0, min(95, confidence + ob_adj))
        except Exception:
            pass

        # 4p. Funding rate carry signal
        try:
            funding_adj = self.funding_carry.get_confidence_adjustment(symbol, action)
            if funding_adj != 0:
                confidence = max(0, min(95, confidence + funding_adj))
        except Exception:
            pass

        # 4q. Calibration correction (adjust for historical over/under-confidence)
        try:
            confidence = self.calibration.get_confidence_correction(confidence)
        except Exception:
            pass

        # 4r. Stacking ensemble meta-prediction
        try:
            base_preds = {
                "ml_ensemble": action,
                "ml_confidence": ai_result["confidence"],
                "rl_action": "BUY" if (pos_info.get("has_position") and action == "BUY") else action,
                "sequence_direction": "UP" if confidence > 55 else "DOWN" if confidence < 45 else "FLAT",
                "consensus_action": raw_consensus.get("top_signal", {}).get("signal", "HOLD") if raw_consensus.get("top_signal") else "HOLD",
            }
            meta_pred = self.stacking.get_meta_prediction(base_preds)
            if meta_pred.get("confidence", 0) > 0:
                # Blend: 70% original + 30% meta
                meta_conf = meta_pred["confidence"]
                confidence = int(confidence * 0.7 + meta_conf * 0.3)
                if meta_pred["action"] != action and meta_pred["confidence"] > 70:
                    action = meta_pred["action"]
        except Exception:
            pass

        # 4s. Transformer model confidence adjustment
        try:
            last_features = self.ai._last_features.get(symbol)
            if last_features is not None:
                # Build a pseudo-sequence from recent feature snapshots
                feat_seq = self.ai._feature_history.get(symbol, [])
                if len(feat_seq) >= 5:
                    trans_adj = self.transformer.get_confidence_adjustment(feat_seq[-20:], action)
                    confidence = max(0, min(95, confidence + trans_adj))
                    self.transformer.record_sequence(last_features, action)
        except Exception:
            pass

        # 4t. LSTM sequence model adjustment
        try:
            lstm_adj = self.lstm.get_confidence_adjustment(df, action, symbol)
            confidence = max(0, min(95, confidence + lstm_adj))
            self.lstm.record_sample(df, action, symbol)
        except Exception:
            pass

        # 4u. Online learning adjustment
        try:
            last_features = self.ai._last_features.get(symbol)
            if last_features is not None:
                ol_adj = self.online_learner.get_confidence_adjustment(last_features, action)
                confidence = max(0, min(95, confidence + ol_adj))
        except Exception:
            pass

        # 4v. Regime-aware strategy routing (reweight signals)
        try:
            routed = self.regime_router.route_strategies(signals, df, symbol)
            # Use routed signals to re-check top signal weight
            best_routed = max(routed, key=lambda s: s.get("confidence", 0) * (1 if s["signal"] == action else 0.5), default=None)
            if best_routed and best_routed.get("regime_weight", 1.0) < 0.5:
                confidence = max(0, int(confidence * 0.7))  # Penalize if regime disfavors
        except Exception:
            pass

        # 4w. Microstructure liquidity/toxicity adjustment
        try:
            micro_adj = self.microstructure.get_confidence_adjustment(symbol, action)
            if micro_adj != 0:
                confidence = max(0, min(95, confidence + micro_adj))
        except Exception:
            pass

        # 4x. Feature importance tracking
        try:
            last_features = self.ai._last_features.get(symbol)
            if last_features is not None:
                self.feature_selector.record_prediction(last_features, action, None)
        except Exception:
            pass

        # 5. Asset intelligence
        asset_intel = self._compute_asset_intel(symbol, df)

        # Build per-strategy breakdown for scanner
        strategy_breakdown = []
        for sig in signals:
            strategy_breakdown.append({
                "name": sig["name"],
                "signal": sig["signal"],
                "confidence": sig["confidence"],
            })

        # Scan data for this pair
        scan_entry = {
            "symbol": symbol,
            "price": asset_intel["price"],
            "action": action,
            "confidence": confidence,
            "buy_count": raw_consensus["buy_count"],
            "sell_count": raw_consensus["sell_count"],
            "hold_count": raw_consensus["hold_count"],
            "agreement": ai_result.get("agreement", False),
            "method": ai_result.get("ml_prediction", {}).get("method", "heuristic"),
            "strategies": strategy_breakdown,
            "asset_intel": asset_intel,
            "reasoning": ai_result.get("reasoning", ""),
        }
        self._last_scan[symbol] = scan_entry

        # Publish signals
        self.zmq.publish_signals(symbol, {
            "consensus": {
                "action": action,
                "confidence": confidence,
                "buy_count": raw_consensus["buy_count"],
                "sell_count": raw_consensus["sell_count"],
                "hold_count": raw_consensus["hold_count"],
                "agreement": ai_result.get("agreement", False),
                "method": ai_result.get("ml_prediction", {}).get("method", "heuristic"),
            },
            "active_count": raw_consensus["buy_count"] + raw_consensus["sell_count"],
        })

        # Maybe open a trade (adaptive threshold)
        effective_threshold = max(self._adaptive_conf_threshold, config.MIN_SIGNAL_CONFIDENCE)
        if action == "HOLD" or confidence < effective_threshold:
            return scan_entry
        if not self.risk.can_open_position(symbol):
            return scan_entry

        # Circuit breaker check
        cb_status = circuit_breaker.should_pause_trading()
        if cb_status["paused"]:
            self.zmq.publish_log("WARN", f"Circuit breaker active: {cb_status['reason']} ({cb_status['remaining_minutes']}min)")
            return scan_entry

        # Portfolio heat check
        heat_data = self.portfolio_heat.calculate_heat(self.risk.positions, self.risk.balance)
        heat_adj = self.portfolio_heat.get_position_size_adjustment(heat_data["heat"])
        if heat_adj == 0.0:
            return scan_entry  # portfolio too hot, no new positions

        # Portfolio correlation check
        corr_mult = self.risk.check_portfolio_correlation(symbol, all_data or {})
        if corr_mult == 0.0:
            return scan_entry  # skip: too correlated with existing positions

        dd = self.risk.check_drawdown()
        size_mult = dd["size_multiplier"]
        size_mult *= corr_mult  # correlation risk reduction
        size_mult *= heat_adj   # portfolio heat reduction
        # Apply regime-based position multiplier
        size_mult *= self.regime.get_position_multiplier(symbol, df)
        # Apply beast mode compound multiplier (streak-based)
        compound = beast_mode.get_compound_multiplier()
        size_mult *= compound["multiplier"]
        entry_price = df["close"].iloc[-1]
        # Beast mode dynamic targets (volatility-adjusted TP/SL)
        candle_dicts = [{"h": r["high"], "l": r["low"], "c": r["close"], "v": r.get("volume", 0)} for _, r in df.tail(50).iterrows()]
        beast_targets = beast_mode.get_dynamic_targets(candle_dicts)
        stop_price = self.risk.atr_stop_loss(df, entry_price, side=action)
        target_price = self.risk.atr_take_profit(df, entry_price, side=action)
        # Use beast mode targets if they are tighter/better
        beast_stop = entry_price * (1 - beast_targets["stop_loss_pct"] / 100) if action == "BUY" else entry_price * (1 + beast_targets["stop_loss_pct"] / 100)
        beast_target = entry_price * (1 + beast_targets["take_profit_pct"] / 100) if action == "BUY" else entry_price * (1 - beast_targets["take_profit_pct"] / 100)
        # Pick the tighter stop and wider target
        if action == "BUY":
            stop_price = max(stop_price, beast_stop)  # tighter = higher for BUY
            target_price = max(target_price, beast_target)
        else:
            stop_price = min(stop_price, beast_stop)  # tighter = lower for SELL
            target_price = min(target_price, beast_target)
        # Volatility-adjusted sizing from beast mode
        vol_adj = beast_mode.adjust_for_volatility(1.0, candle_dicts)
        size_mult *= vol_adj["multiplier"]
        position_usd = self.risk.calculate_position_size(entry_price, stop_price)
        position_usd *= size_mult
        # Apply adaptive strategy weight sizing
        top_signal = raw_consensus.get("top_signal", {}).get("name", "") if raw_consensus.get("top_signal") else ""
        if top_signal and not adaptive_weights.is_strategy_throttled(top_signal):
            position_usd = adaptive_weights.adjust_position_size(top_signal, position_usd, self.risk.balance)
        elif top_signal and adaptive_weights.is_strategy_throttled(top_signal):
            return scan_entry  # Strategy performing too poorly, skip
        # Anti-martingale streak adjustment
        size_mult *= self.risk.anti_martingale_multiplier()
        # Intraday VaR limit
        var_check = self.risk.check_intraday_var()
        if var_check["exceeded"]:
            size_mult *= var_check["size_multiplier"]
        # Apply CVaR tail-risk cap
        position_usd = self.risk.cvar_position_cap(position_usd)
        # Portfolio-level risk budget (CPPI)
        try:
            pr_budget = self.portfolio_risk.get_dynamic_position_budget(
                self.risk.balance, self.risk.peak_balance if hasattr(self.risk, 'peak_balance') else self.risk.balance,
                current_regime)
            if pr_budget.get("position_budget", float("inf")) < position_usd:
                position_usd = pr_budget["position_budget"]
        except Exception:
            pass
        # Microstructure liquidity adjustment
        try:
            micro_mult = self.microstructure.get_position_size_adjustment(symbol)
            position_usd *= micro_mult
        except Exception:
            pass
        # Apply slippage estimation
        slip = self.risk.estimate_slippage(symbol, position_usd, action)
        if slip["should_reduce"]:
            position_usd = slip["adjusted_size"]

        if position_usd < 1.0:
            return scan_entry

        # Smart order routing: simulate price improvement
        routing = self.smart_router.simulate_price_improvement(symbol, action, entry_price, position_usd)
        entry_price = routing["improved_price"]

        # Iceberg order splitting for large orders
        iceberg_result = self.iceberg.execute_split_order(
            self.risk, symbol, entry_price, position_usd, stop_price, target_price, action
        )
        self.trades_today += 1

        trade_info = {
            "symbol": symbol,
            "action": action,
            "entry": entry_price,
            "size_usd": round(position_usd, 2),
            "stop": round(stop_price, 6),
            "target": round(target_price, 6),
            "confidence": confidence,
            "strategies_agreeing": raw_consensus["buy_count"] if action == "BUY" else raw_consensus["sell_count"],
            "top_signal": raw_consensus["top_signal"]["name"] if raw_consensus.get("top_signal") else "N/A",
            "ai_method": ai_result.get("ml_prediction", {}).get("method", "heuristic"),
            "ai_agreement": ai_result.get("agreement", False),
            "reasoning": ai_result.get("reasoning", ""),
            "ts": time.time(),
        }
        self._last_trade = trade_info
        self.zmq.publish_trade(trade_info)
        self.zmq.publish_log("INFO", f"{action} {symbol} @ {entry_price:.6f} (conf: {confidence})")
        self.telegram.alert_trade_entry(trade_info)
        return scan_entry

    def _update_adaptive_threshold(self):
        """Learn optimal confidence threshold from recent trade history."""
        history = self._conf_threshold_history
        if len(history) < 30:
            return

        # Test thresholds from 30 to 70, find one with best win rate * trade_count balance
        best_score = 0
        best_thresh = self._adaptive_conf_threshold

        for thresh in range(30, 71, 5):
            trades_above = [(c, w) for c, w in history if c >= thresh]
            if len(trades_above) < 5:
                continue
            win_rate = sum(w for _, w in trades_above) / len(trades_above)
            # Score: win_rate * sqrt(trade_count) — rewards both accuracy and volume
            score = win_rate * (len(trades_above) ** 0.5)
            if score > best_score:
                best_score = score
                best_thresh = thresh

        if best_thresh != self._adaptive_conf_threshold:
            logger.info(f"Adaptive threshold: {self._adaptive_conf_threshold} → {best_thresh}")
            self._adaptive_conf_threshold = best_thresh

    def _check_service_exits(self, prices: dict, all_data: dict):
        """Let services trigger early exits on open positions."""
        for symbol, pos in list(self.risk.positions.items()):
            price = prices.get(symbol)
            if not price:
                continue
            df = all_data.get(symbol)
            if df is None:
                continue

            exit_reasons = []

            # VPIN toxic flow exit
            try:
                vpin_data = self.vpin.calculate(symbol)
                if vpin_data.get("vpin", 0) > 0.8:
                    exit_reasons.append("VPIN_TOXIC")
            except Exception:
                pass

            # Anomaly exit
            try:
                anomaly_data = self.anomaly.check(df)
                if anomaly_data.get("is_anomaly") and anomaly_data.get("score", 0) > 0.9:
                    exit_reasons.append("ANOMALY_EXTREME")
            except Exception:
                pass

            # Derivatives pressure exit
            try:
                deriv_data = self.derivatives.get_pressure(symbol)
                pressure = deriv_data.get("composite_score", 0)
                if pos["side"] == "BUY" and pressure < -70:
                    exit_reasons.append("DERIV_PRESSURE_SELL")
                elif pos["side"] == "SELL" and pressure > 70:
                    exit_reasons.append("DERIV_PRESSURE_BUY")
            except Exception:
                pass

            # Correlation break exit (BTC drops >2% while holding alt)
            try:
                if symbol != "BTC/USD":
                    btc_price_now = prices.get("BTC/USD")
                    btc_df = all_data.get("BTC/USD")
                    if btc_df is not None and len(btc_df) >= 2 and btc_price_now:
                        btc_ret = (btc_df["close"].iloc[-1] - btc_df["close"].iloc[-2]) / btc_df["close"].iloc[-2]
                        if btc_ret < -0.02 and pos["side"] == "BUY":
                            exit_reasons.append("BTC_CRASH_CORR")
            except Exception:
                pass

            # Advanced exits: volatility regime change + time-decay
            try:
                adv_exits = self.advanced_exits.get_exit_signals(symbol, pos, df, price)
                for ae in adv_exits:
                    if ae.get("should_exit"):
                        exit_reasons.append(ae["reason"])
                    elif ae.get("new_stop"):
                        pos["stop"] = ae["new_stop"]
            except Exception:
                pass

            # Smart exits: Chandelier, PSAR, Keltner, volume dry-up, momentum exhaustion, time-weighted
            try:
                smart_exit_signals = self.smart_exits_svc.check_exits(symbol, pos, df, price)
                for se in smart_exit_signals:
                    if se.get("should_exit") and se.get("urgency", 0) >= 6:
                        exit_reasons.append(f"SMART_{se['type']}")
                # Update trailing stop from smart exits
                trail_stop = self.smart_exits_svc.get_trailing_stop(symbol, pos, df)
                if trail_stop > 0:
                    if pos["side"] == "BUY" and trail_stop > pos.get("stop", 0):
                        pos["stop"] = trail_stop
                    elif pos["side"] == "SELL" and (pos.get("stop", float("inf")) == float("inf") or trail_stop < pos["stop"]):
                        pos["stop"] = trail_stop
            except Exception:
                pass

            # If any exit reason triggered, close position
            if exit_reasons:
                reason = "+".join(exit_reasons)
                self.risk.close_position(symbol, price, reason=reason)
                self.zmq.publish_log("WARN", f"SERVICE EXIT {symbol}: {reason}")
                self.telegram.alert_trade_exit({
                    "symbol": symbol, "pnl_pct": 0, "pnl_usd": 0, "reason": reason
                })

    def _run_nightly_tasks(self, all_data: dict):
        """Run hyperopt + walk-forward + DB maintenance once per day (at ~00:00 UTC)."""
        import datetime
        now = datetime.datetime.utcnow()
        if now.hour != 0 or (time.time() - self._last_nightly_run) < 82800:  # 23 hours min gap
            return

        self._last_nightly_run = time.time()
        self.zmq.publish_log("INFO", "Starting nightly optimization tasks...")

        # DB maintenance: backup, cleanup, vacuum
        try:
            from services.database_service import backup_database, cleanup_old_data, vacuum_database
            backup_database()
            cleanup_old_data(days=30)
            vacuum_database()
            self.zmq.publish_log("INFO", "DB maintenance complete (backup + cleanup + vacuum)")
        except Exception as e:
            logger.warning(f"DB maintenance error: {e}")

        # Pick the pair with most data for optimization
        best_df = max(all_data.values(), key=len) if all_data else None
        if best_df is not None and len(best_df) >= 200:
            # Run hyperopt in background
            self.hyperopt.run_in_background(best_df, n_trials=30)
            self.zmq.publish_log("INFO", "Hyperopt started (30 trials)")

            # Run walk-forward validation
            try:
                wf_result = self.walk_forward.walk_forward(best_df, n_windows=3)
                if "error" not in wf_result:
                    self.zmq.publish_log("INFO",
                        f"Walk-forward: {wf_result.get('total_trades', 0)} trades, "
                        f"WR={wf_result.get('overall_win_rate', 0):.1f}%, "
                        f"Sharpe={wf_result.get('avg_sharpe', 0):.2f}")
            except Exception as e:
                logger.warning(f"Walk-forward error: {e}")

    def run_cycle(self):
        """One full analysis cycle across all pairs."""
        self.cycle_count += 1
        cycle_start = time.time()

        # 1. Fetch market data
        all_data = self.market.fetch_all_pairs()
        if not all_data:
            self.zmq.publish_log("WARN", "No market data available")
            return

        # 2. Prices, event detection, and stop checks
        prices = self.market.get_current_prices()
        self.zmq.publish_prices(prices)

        # Feed prices to event-driven loop for adaptive speed
        event_info = self.event_loop.update_prices(prices)
        if event_info["events"]:
            for evt in event_info["events"]:
                self.zmq.publish_log("INFO", f"EVENT: {evt['type']} {evt['symbol']} {evt['direction']} {evt['change_pct']}%")

        closed_trades = self.risk.check_stops(prices)
        for trade in closed_trades:
            trade["ts"] = time.time()
            self._last_trade = trade
            self.zmq.publish_trade(trade)
            self.ai.record_trade_outcome(trade["symbol"], trade.get("side", "BUY"), trade["pnl_pct"])
            # Feed circuit breaker & beast mode & meta-learner
            pnl_pct = trade.get("pnl_pct", 0)
            top_signal = trade.get("top_signal", "")
            circuit_breaker.record_trade_result(pnl_pct / 100, top_signal, trade["symbol"])
            beast_mode.record_trade_result(pnl_pct / 100, trade["symbol"], top_signal)
            adaptive_weights.record_strategy_result(top_signal, pnl_pct / 100)
            # Meta-learner: record which strategy led to this outcome
            last_features = self.ai._last_features.get(trade["symbol"])
            if last_features is not None and top_signal:
                self.meta_learner.record_outcome(last_features, top_signal, pnl_pct)
            # RL agent: record shaped trade reward
            hold_min = trade.get("hold_duration_min", 0)
            self.rl_agent.record_trade_reward(pnl_pct, hold_duration_min=hold_min)
            # Stacking ensemble: record outcome for meta-learner training
            outcome = "BUY" if pnl_pct > 0 else "SELL"  # simplification
            self.stacking.record_base_predictions(
                {"ml_confidence": trade.get("confidence", 50), "top_signal": top_signal},
                outcome
            )
            # Calibration monitor: record prediction outcome
            self.calibration.record_outcome(trade.get("confidence", 50), pnl_pct > 0)
            # Trade journal: record full trade with context
            try:
                self.journal.record_trade({
                    "ticker": trade["symbol"],
                    "strategy": top_signal,
                    "entry_price": trade.get("entry", 0),
                    "exit_price": trade.get("exit_price", trade.get("entry", 0)),
                    "pnl": trade.get("pnl_usd", 0),
                    "pnl_percent": pnl_pct,
                    "confidence": trade.get("confidence", 50),
                    "regime": trade.get("regime", "UNKNOWN"),
                    "hold_duration_s": trade.get("hold_duration_min", 0) * 60,
                })
            except Exception:
                pass
            # Online learning: incremental update with trade outcome
            try:
                last_features = self.ai._last_features.get(trade["symbol"])
                if last_features is not None:
                    outcome = "BUY" if pnl_pct > 0 else "SELL"
                    self.online_learner.update(last_features, outcome, {
                        "pnl": pnl_pct, "confidence": trade.get("confidence", 50),
                        "hold_time": trade.get("hold_duration_min", 0),
                    })
                    # Experience replay
                    self.online_learner.replay_batch(batch_size=16)
            except Exception:
                pass
            # Feature selector: record outcome for importance tracking
            try:
                last_features = self.ai._last_features.get(trade["symbol"])
                if last_features is not None:
                    self.feature_selector.record_prediction(
                        last_features, "WIN" if pnl_pct > 0 else "LOSS",
                        "WIN" if pnl_pct > 0 else "LOSS"
                    )
            except Exception:
                pass
            # Regime router: record strategy performance by regime
            try:
                self.regime_router.record_trade_result(top_signal, trade.get("regime", "UNKNOWN"), pnl_pct)
            except Exception:
                pass
            # Telegram alert
            self.telegram.alert_trade_exit(trade)
            # Prometheus metrics
            self.metrics.inc("trading_trades_total", labels={"outcome": "win" if pnl_pct > 0 else "loss"})
            self.metrics.observe("trading_pnl_percent", pnl_pct, labels={"symbol": trade["symbol"]})
            self.metrics.inc("trading_pnl_usd_total", trade.get("pnl_usd", 0))
            if pnl_pct > 0:
                self.wins_today += 1
            else:
                self.losses_today += 1

            # Adaptive threshold learning
            trade_conf = trade.get("confidence", 50)
            self._conf_threshold_history.append((trade_conf, 1 if pnl_pct > 0 else 0))
            if len(self._conf_threshold_history) > 200:
                self._conf_threshold_history = self._conf_threshold_history[-200:]
            if len(self._conf_threshold_history) >= 30:
                self._update_adaptive_threshold()

        # Update beast mode balance
        beast_mode.update_balance(self.risk.balance)

        # 2b. Service-driven exit signals on open positions
        try:
            self._check_service_exits(prices, all_data)
        except Exception as e:
            logger.debug(f"Service exits error: {e}")

        # 3. Momentum rotation: rank pairs, analyze top 5 + any with open positions
        ranked_pairs = []
        for symbol, df in all_data.items():
            if len(df) >= 13:
                mom = (df["close"].iloc[-1] - df["close"].iloc[-13]) / df["close"].iloc[-13] * 100
                avg_vol = df["volume"].rolling(20).mean().iloc[-1] if len(df) >= 20 else df["volume"].mean()
                vol_ratio = df["volume"].iloc[-1] / avg_vol if avg_vol > 0 else 1.0
                ranked_pairs.append((symbol, abs(mom) * vol_ratio))
            else:
                ranked_pairs.append((symbol, 0))
        ranked_pairs.sort(key=lambda x: x[1], reverse=True)
        top_symbols = {s for s, _ in ranked_pairs[:5]}
        top_symbols |= set(self.risk.positions.keys())  # Always include open positions

        # Analyze selected pairs in PARALLEL (4 threads on KVM4)
        futures = {}
        for symbol, df in all_data.items():
            if symbol not in top_symbols:
                continue
            future = self._thread_pool.submit(self._analyze_pair, symbol, df, all_data)
            futures[future] = symbol
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                logger.debug(f"Pair analysis error {futures[future]}: {e}")

        # 3b. Run profit methods (swing, DCA, grid) alongside day trading
        try:
            ticker_candles = {}
            for symbol, df in all_data.items():
                ticker_key = symbol.replace("/", "")
                candle_dicts = [{"c": r["close"], "h": r["high"], "l": r["low"], "v": r.get("volume", 0)} for _, r in df.iterrows()]
                ticker_candles[ticker_key] = candle_dicts

                # Check profit method exits first
                if symbol in prices:
                    pm_exits = profit_methods.check_profit_method_exits(ticker_key, prices[symbol])
                    for ex in pm_exits:
                        self.zmq.publish_log("INFO", f"[PM-EXIT] {ex['method']} {ticker_key}: {ex.get('reason', '')}")

                # Run profit methods for entries
                pm_actions = profit_methods.run_profit_methods(ticker_key, candle_dicts, self.risk.balance, self.risk.balance)
                for pm_action in pm_actions:
                    self.zmq.publish_log("INFO", f"[PM] {pm_action['method']} {ticker_key}: {pm_action.get('reason', '')}")

            # Cross-pair methods (arb + pair trading)
            arb_signals = profit_methods.process_arbitrage(ticker_candles, self.risk.balance)
            for sig in arb_signals:
                self.zmq.publish_log("INFO", f"[ARB] {sig['pair']}: z={sig['z_score']:.2f} → {sig['action']}")
            pair_signals = profit_methods.process_pair_trading(ticker_candles, self.risk.balance)
            for sig in pair_signals:
                self.zmq.publish_log("INFO", f"[PAIR] {sig['pair']}: z={sig['z_score']:.2f}, corr={sig['correlation']:.2f}")
        except Exception as e:
            logger.debug(f"Profit methods error: {e}")

        # 3c. Statistical arbitrage signals
        try:
            price_series = {s: df["close"] for s, df in all_data.items() if len(df) >= 50}
            stat_arb_signals = self.stat_arb.get_signals(price_series)
            for sig in stat_arb_signals:
                if sig["signal"] != "CLOSE":
                    self.zmq.publish_log("INFO", f"[STAT-ARB] {sig['pair']}: z={sig['z_score']:.2f} → {sig['signal']} (conf={sig['confidence']})")
        except Exception as e:
            logger.debug(f"Stat arb error: {e}")

        # 3d. Data integrity check (every 10 cycles)
        if self.cycle_count % 10 == 0:
            try:
                report = self.data_integrity.get_data_report(all_data)
                if report.get("issues_found", 0) > 0:
                    self.zmq.publish_log("WARN", f"Data integrity: {report['issues_found']} issues across {report['pairs_checked']} pairs")
                if report.get("stale_pairs"):
                    self.zmq.publish_log("WARN", f"Stale data: {', '.join(report['stale_pairs'])}")
            except Exception:
                pass

        # 4. Publish full scan
        self.zmq.publish_scan(self._last_scan)

        # 5. Portfolio
        portfolio = self.risk.get_portfolio_state()
        self.zmq.publish_portfolio(portfolio)

        # 6. Risk state
        dd = self.risk.check_drawdown()
        self.zmq.publish_risk({
            "drawdown": dd,
            "daily_pnl": round(self.risk.daily_pnl, 2),
            "daily_loss_limit": round(self.risk.daily_start_balance * config.MAX_DAILY_LOSS_PCT, 2),
            "halted": self.risk.halted,
            "kelly_fraction": round(self.risk.kelly_fraction() * 100, 2),
            "max_position_pct": config.MAX_POSITION_PCT * 100,
            "open_positions": len(self.risk.positions),
            "positions": {s: {
                "side": p["side"], "entry": p["entry"],
                "stop": p["stop"], "target": p["target"],
                "size_usd": p["size_usd"],
                "unrealized_pnl": round(
                    ((prices.get(s, p["entry"]) - p["entry"]) / p["entry"] * 100)
                    if p["side"] == "BUY" else
                    ((p["entry"] - prices.get(s, p["entry"])) / p["entry"] * 100), 3
                ),
            } for s, p in self.risk.positions.items()},
        })

        # 7. Session summary (includes circuit breaker + beast mode status)
        uptime = time.time() - self.start_time
        cb_status = circuit_breaker.should_pause_trading()
        beast_status = beast_mode.get_compound_multiplier()
        self.zmq.publish_session({
            "uptime": round(uptime),
            "cycles": self.cycle_count,
            "trades_today": self.trades_today,
            "wins_today": self.wins_today,
            "losses_today": self.losses_today,
            "paused": self.paused,
            "mode": "PAPER" if config.PAPER_TRADING else "LIVE",
            "pairs_active": len(all_data),
            "loop_interval": self.event_loop.current_interval,
            "loop_mode": self.event_loop.current_mode,
            "circuit_breaker": cb_status,
            "beast_mode": {"multiplier": beast_status["multiplier"], "reason": beast_status["reason"]},
            "profit_methods": profit_methods.get_status(),
        })

        # 8. Strategy rankings (every 5 cycles)
        if self.cycle_count % 5 == 0:
            rankings = self.ai.strategy_weighter.get_rankings()
            ai_stats = self.ai.get_model_stats()
            self.zmq.publish_strategies({
                "rankings": rankings,
                "ai_stats": ai_stats,
            })

        # 9. Sentiment (every 30 cycles ~ 5 min)
        if self.cycle_count % 30 == 0:
            try:
                sentiments = self.sentiment.get_all_sentiments()
                self.zmq.publish_sentiment({
                    s: {
                        "score": v.get("score", 0),
                        "summary": v.get("summary", ""),
                        "bullish_count": v.get("bullish_count", 0),
                        "bearish_count": v.get("bearish_count", 0),
                    }
                    for s, v in sentiments.items()
                })
            except Exception as e:
                logger.warning(f"Sentiment error: {e}")

        # 10. AI summary (every 60 cycles ~ 10 min)
        if self.cycle_count % 60 == 0:
            try:
                summary = self.ai.get_market_summary(portfolio)
                self.zmq.publish_ai_analysis("MARKET", {"summary": summary})
                stats = self.ai.get_model_stats()
                self.zmq.publish_ai_analysis("MODEL_STATS", stats)
            except Exception as e:
                logger.warning(f"AI summary error: {e}")

        elapsed = time.time() - cycle_start
        # Prometheus: per-cycle gauges
        self.metrics.set_gauge("trading_cycle_duration_seconds", elapsed)
        self.metrics.set_gauge("trading_cycle_count", self.cycle_count)
        self.metrics.set_gauge("trading_balance_usd", self.risk.balance)
        self.metrics.set_gauge("trading_positions_open", len(self.risk.positions))
        self.metrics.set_gauge("trading_wins_today", self.wins_today)
        self.metrics.set_gauge("trading_losses_today", self.losses_today)
        self.metrics.observe("trading_cycle_latency", elapsed)
        self.zmq.publish_log("DEBUG", f"Cycle {self.cycle_count} in {elapsed:.1f}s | {len(all_data)} pairs | {len(self.risk.positions)} positions")

        # 11. Nightly optimization tasks (hyperopt + walk-forward)
        try:
            self._run_nightly_tasks(all_data)
        except Exception as e:
            logger.debug(f"Nightly tasks error: {e}")

        # 12. Apply hyperopt best params if available (every 100 cycles)
        if self.cycle_count % 100 == 0:
            best = self.hyperopt.get_best_params()
            if best.get("min_confidence"):
                old = self._adaptive_conf_threshold
                new = int(best["min_confidence"])
                if abs(new - old) > 3:
                    self._adaptive_conf_threshold = new
                    logger.info(f"Hyperopt override: confidence threshold {old} → {new}")

    def run_loop(self):
        """Event-driven trading engine loop (runs in a background thread).

        Uses adaptive interval: 10s normal, 3s on price moves, 1s on surges.
        """
        self.zmq.start_command_listener()

        # Start Binance WebSocket for real-time data
        try:
            self.binance_ws.start()
            logger.info("Binance WebSocket streaming started")
        except Exception as e:
            logger.warning(f"Binance WebSocket start failed (non-critical): {e}")

        # Start multi-exchange WebSocket multiplexer (KVM8: 3 exchanges concurrently)
        try:
            ws_mux = get_ws_multiplexer()
            ws_mux.start([p.replace("/", "") for p in config.PAIRS[:5]])  # Top 5 pairs
            logger.info("Multi-exchange WebSocket multiplexer started (Binance + OKX + Bybit)")
        except Exception as e:
            logger.warning(f"WS multiplexer start failed (non-critical): {e}")

        logger.info("Trading engine loop starting (event-driven)...")
        self.zmq.publish_log("INFO", "Canuck-Trader-Pro online! (Event-driven ML engine)")

        while True:
            try:
                self.zmq.publish_heartbeat()
                if not self.paused:
                    self.run_cycle()
                else:
                    self.zmq.publish_log("INFO", "Paused - waiting for resume")

                # Auto-save session state every 60 seconds
                if time.time() - self._last_auto_save >= self._auto_save_interval:
                    try:
                        save_full_state(self)
                        self._last_auto_save = time.time()
                    except Exception as e:
                        logger.debug(f"Auto-save failed: {e}")

                # Adaptive sleep: shorter when market is active
                interval = self.event_loop.current_interval
                time.sleep(interval)
            except Exception as e:
                logger.error(f"Main loop error: {e}", exc_info=True)
                self.zmq.publish_log("ERROR", str(e))
                time.sleep(5)

    def _graceful_shutdown(self, signum=None, frame=None):
        """Save state before shutdown."""
        sig_name = signal.Signals(signum).name if signum else "UNKNOWN"
        logger.info(f"Received {sig_name} - saving session state before shutdown...")
        try:
            save_full_state(self)
            logger.info("Session state saved successfully")
            self.telegram.alert_session_summary({
                "reason": sig_name,
                "balance": self.risk.balance,
                "trades_today": self.trades_today,
                "wins_today": self.wins_today,
                "losses_today": self.losses_today,
                "positions_open": len(self.risk.positions),
            })
        except Exception as e:
            logger.error(f"Failed to save session state on shutdown: {e}")
        sys.exit(0)

    def run(self):
        """Start FastAPI server + trading loop."""
        import uvicorn
        from app import set_canuck_trader

        # Register graceful shutdown handlers
        signal.signal(signal.SIGINT, self._graceful_shutdown)
        signal.signal(signal.SIGTERM, self._graceful_shutdown)

        # Share the trader instance with FastAPI routes
        set_canuck_trader(self)

        # Start trading engine in background thread
        engine_thread = threading.Thread(target=self.run_loop, daemon=True, name="trading-engine")
        engine_thread.start()
        logger.info(f"Trading engine started in background thread")

        # Run FastAPI server in the main thread (blocking)
        logger.info(f"Starting FastAPI server on port {config.HTTP_PORT}...")
        uvicorn.run(
            "app:app",
            host="0.0.0.0",
            port=config.HTTP_PORT,
            log_level="info",
            access_log=False,
        )


def start_api_only():
    """Start only the FastAPI server without the trading engine (for development)."""
    import uvicorn
    logger.info(f"Starting FastAPI server (API-only mode) on port {config.HTTP_PORT}...")
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=config.HTTP_PORT,
        log_level="info",
        reload=True,
    )


if __name__ == "__main__":
    if "--api-only" in sys.argv:
        start_api_only()
    else:
        trader = CanuckTrader()
        trader.run()
