"""
Local AI - Replaces GeminiAgent with fully local ML models.
Same interface so main.py and sentiment_analyzer.py can swap seamlessly.
"""
import json
import logging
import time
from typing import Optional

import numpy as np
import pandas as pd

from feature_engineer import build_feature_vector, STRATEGY_NAMES
from ml_models import TradePredictor, SentimentScorer, StrategyWeighter

logger = logging.getLogger(__name__)


class LocalAI:
    """Self-contained AI engine using local ML models. No external API calls.

    Components:
    - TradePredictor: GradientBoosting classifier → BUY/SELL/HOLD with confidence
    - SentimentScorer: VADER + crypto lexicon → headline sentiment
    - StrategyWeighter: Adaptive strategy weights from trade outcomes

    Learning loop:
    1. Strategies produce signals → feature vector
    2. TradePredictor predicts action (heuristic first, ML after 50 trades)
    3. Trade executes → outcome recorded
    4. Models retrain incrementally
    5. Strategy weights adapt to what's actually working
    """

    def __init__(self):
        self.trade_predictor = TradePredictor()
        self.sentiment_scorer = SentimentScorer()
        self.strategy_weighter = StrategyWeighter()

        self._last_features: dict = {}  # symbol -> feature vector (for recording outcomes)
        self._last_signals: dict = {}   # symbol -> signals list
        self._feature_history: dict = {}  # symbol -> list of recent feature vectors (for transformer)
        self._trade_count = 0

        logger.info("LocalAI initialized (no external API dependencies)")
        logger.info(f"  Trade predictor: {len(self.trade_predictor.y_history)} training samples")
        logger.info(f"  Sentiment scorer: VADER + {len(self.sentiment_scorer.analyzer.lexicon)} terms")

    def analyze_trade(self, symbol: str, signals: list[dict], df: pd.DataFrame,
                      mlofi_features: np.ndarray = None, cross_asset_features: np.ndarray = None,
                      mtf_score: float = 0.0, minutes_since_last_trade: float = 0.0) -> dict:
        """Analyze a potential trade setup using local ML.

        Returns: {"action": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "reasoning": str, ...}
        """
        # Build feature vector (includes MLOFI + cross-asset + MTF + temporal features)
        features = build_feature_vector(signals, df, mlofi_features=mlofi_features,
                                        cross_asset_features=cross_asset_features,
                                        mtf_score=mtf_score,
                                        minutes_since_last_trade=minutes_since_last_trade)

        # Store for later outcome recording
        self._last_features[symbol] = features
        self._last_signals[symbol] = signals
        # Track feature history for transformer sequence model
        if symbol not in self._feature_history:
            self._feature_history[symbol] = []
        self._feature_history[symbol].append(features)
        if len(self._feature_history[symbol]) > 30:
            self._feature_history[symbol] = self._feature_history[symbol][-30:]

        # Get ML prediction
        ml_prediction = self.trade_predictor.predict(features)

        # Get weighted consensus from adaptive strategy weights
        weighted_consensus = self.strategy_weighter.get_weighted_consensus(signals)

        # Combine ML prediction with weighted consensus
        final = self._combine_predictions(ml_prediction, weighted_consensus)

        # Build reasoning string
        method = ml_prediction["method"]
        training_n = ml_prediction.get("training_samples", 0)
        top_strat = weighted_consensus["top_signal"]["name"] if weighted_consensus.get("top_signal") else "none"

        final["reasoning"] = (
            f"{method.upper()} model ({training_n} samples) | "
            f"Top strategy: {top_strat} | "
            f"ML says {ml_prediction['action']} ({ml_prediction['confidence']}%), "
            f"Weighted consensus says {weighted_consensus['action']} ({weighted_consensus['confidence']}%)"
        )
        final["ml_prediction"] = ml_prediction
        final["weighted_consensus"] = weighted_consensus
        final["feature_count"] = len(features)

        return final

    def _combine_predictions(self, ml_pred: dict, weighted_cons: dict) -> dict:
        """Combine ML prediction and weighted strategy consensus.

        - If both agree: boost confidence
        - If they disagree: use higher-confidence one but reduce confidence
        - ML weight increases as training samples grow
        """
        ml_action = ml_pred["action"]
        ml_conf = ml_pred["confidence"]
        wc_action = weighted_cons["action"]
        wc_conf = weighted_cons["confidence"]

        # ML weight scales with training data (0.3 at minimum, up to 0.6)
        samples = ml_pred.get("training_samples", 0)
        if ml_pred["method"] == "ml":
            ml_weight = min(0.6, 0.3 + samples / 500)
        else:
            ml_weight = 0.3  # heuristic mode: lean on consensus more

        wc_weight = 1.0 - ml_weight

        if ml_action == wc_action:
            # Agreement: blend confidences with bonus
            blended_conf = ml_conf * ml_weight + wc_conf * wc_weight
            agreement_bonus = 10
            return {
                "action": ml_action,
                "confidence": round(min(95, blended_conf + agreement_bonus), 1),
                "agreement": True,
            }
        else:
            # Disagreement: pick the stronger signal, penalize confidence
            if ml_conf * ml_weight > wc_conf * wc_weight:
                action = ml_action
                conf = ml_conf * ml_weight
            else:
                action = wc_action
                conf = wc_conf * wc_weight

            # Penalty for disagreement
            disagreement_penalty = 15
            conf = max(0, conf - disagreement_penalty)

            # If both have low confidence and disagree, HOLD
            if conf < 30:
                return {"action": "HOLD", "confidence": 0, "agreement": False}

            return {
                "action": action,
                "confidence": round(conf, 1),
                "agreement": False,
            }

    def record_trade_outcome(self, symbol: str, action: str, pnl_pct: float):
        """Record a completed trade outcome for model learning."""
        features = self._last_features.get(symbol)
        signals = self._last_signals.get(symbol)

        if features is not None:
            self.trade_predictor.record_outcome(features, action, pnl_pct)
            self._trade_count += 1

        if signals:
            self.strategy_weighter.record_outcome(signals, pnl_pct)

        # Clean up stored state
        self._last_features.pop(symbol, None)
        self._last_signals.pop(symbol, None)

        logger.info(
            f"Recorded outcome for {symbol}: {action} → {pnl_pct:+.2f}% "
            f"(total training samples: {len(self.trade_predictor.y_history)})"
        )

    def score_sentiment(self, headlines: list[str], symbol: str) -> dict:
        """Score news sentiment using local VADER + crypto lexicon.

        Returns: {"score": -100 to 100, "summary": str}
        """
        return self.sentiment_scorer.score_headlines(headlines, symbol)

    def get_market_summary(self, portfolio_state: dict) -> str:
        """Generate a market summary from portfolio state (template-based, no LLM)."""
        balance = portfolio_state.get("balance", 0)
        total_pnl = portfolio_state.get("total_pnl", 0)
        pnl_pct = portfolio_state.get("total_pnl_pct", 0)
        win_rate = portfolio_state.get("win_rate", 0)
        total_trades = portfolio_state.get("total_trades", 0)
        dd = portfolio_state.get("drawdown", {})
        dd_pct = dd.get("drawdown_pct", 0)
        open_positions = len(portfolio_state.get("positions", {}))

        # Determine portfolio health
        if pnl_pct > 5:
            health = "Strong performance"
        elif pnl_pct > 0:
            health = "Positive territory"
        elif pnl_pct > -3:
            health = "Slight drawdown"
        else:
            health = "Under pressure"

        # Strategy insights
        rankings = self.strategy_weighter.get_rankings()
        top_3 = [r["strategy"] for r in rankings[:3]]
        bottom_3 = [r["strategy"] for r in rankings[-3:]]

        # Model status
        predictor_status = "ML active" if self.trade_predictor.model else f"Heuristic ({len(self.trade_predictor.y_history)}/{TradePredictor.MIN_SAMPLES} samples to ML)"

        return (
            f"{health}. Balance: ${balance:.2f} ({pnl_pct:+.1f}%). "
            f"Win rate: {win_rate:.0f}% across {total_trades} trades. "
            f"Drawdown: {dd_pct:.1f}%. {open_positions} open positions. "
            f"Best strategies: {', '.join(top_3)}. "
            f"Weakest: {', '.join(bottom_3)}. "
            f"AI: {predictor_status}."
        )

    def explain_last_prediction(self, symbol: str) -> dict:
        """Explain the last prediction for a symbol using SHAP."""
        features = self._last_features.get(symbol)
        if features is None:
            return {"available": False, "reason": f"No recent prediction for {symbol}"}
        return self.trade_predictor.explain_prediction(features)

    def get_model_stats(self) -> dict:
        """Get comprehensive AI model statistics for dashboard."""
        return {
            "predictor": {
                "method": "ensemble" if self.trade_predictor.model else "heuristic",
                "training_samples": len(self.trade_predictor.y_history),
                "min_for_ml": TradePredictor.MIN_SAMPLES,
                "feature_importances": self.trade_predictor.get_feature_importances(),
                "sub_model_scores": self.trade_predictor.get_sub_model_scores(),
            },
            "strategy_rankings": self.strategy_weighter.get_rankings(),
            "total_outcomes_recorded": self._trade_count,
        }
