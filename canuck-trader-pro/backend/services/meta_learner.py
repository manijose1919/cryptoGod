"""
Meta-Learning Strategy Selector

Trains a lightweight model to predict which strategy will perform best
given current market conditions (features). Routes trades to the predicted-best strategy.
"""

import logging
import time
from typing import Optional
from collections import defaultdict

import numpy as np
from sklearn.ensemble import RandomForestClassifier

logger = logging.getLogger("meta_learner")

STRATEGY_NAMES = [
    "EMA_CROSSOVER", "TRIPLE_EMA", "MACD", "ADX_TREND", "SUPERTREND",
    "RSI", "STOCH_RSI", "WILLIAMS_R", "CCI", "MOMENTUM_ROC",
    "BOLLINGER", "KELTNER", "ATR_BREAKOUT", "DONCHIAN", "VOL_SQUEEZE",
    "VWAP", "OBV", "VOL_SPIKE",
    "MEAN_REVERT", "ICHIMOKU", "PIVOT_POINTS", "ENGULFING",
    "RSI_DIVERGENCE", "MACD_DIVERGENCE", "MULTI_CONSENSUS",
]


class MetaLearner:
    """Predicts which strategy will work best for current conditions."""

    MIN_SAMPLES = 30
    RETRAIN_INTERVAL = 20

    def __init__(self):
        self.model: Optional[RandomForestClassifier] = None
        self._X: list = []  # market features at trade time
        self._y: list = []  # index of best strategy
        self._outcomes: list = []  # full outcome records
        self._samples_since_train = 0
        self._strategy_performance: dict = defaultdict(lambda: {"wins": 0, "losses": 0, "total_pnl": 0})

    def record_outcome(self, market_features: np.ndarray, strategy_name: str, pnl_pct: float):
        """Record which strategy was used and its outcome."""
        if strategy_name not in STRATEGY_NAMES:
            return

        # Track per-strategy performance
        perf = self._strategy_performance[strategy_name]
        perf["total_pnl"] += pnl_pct
        if pnl_pct > 0:
            perf["wins"] += 1
        else:
            perf["losses"] += 1

        # For meta-learning: label = index of the strategy
        strat_idx = STRATEGY_NAMES.index(strategy_name)

        # Only record as positive example if profitable
        if pnl_pct > 0.1:
            # Use first 20 market features (returns, vol, RSI, etc.)
            if len(market_features) >= 20:
                mkt_feats = market_features[50:70].tolist()  # market features portion
                self._X.append(mkt_feats)
                self._y.append(strat_idx)
                self._samples_since_train += 1

        # Auto-retrain
        if len(self._y) >= self.MIN_SAMPLES and self._samples_since_train >= self.RETRAIN_INTERVAL:
            self._train()

    def predict_best_strategy(self, market_features: np.ndarray) -> dict:
        """Predict which strategy will perform best.

        Returns: {strategy: str, confidence: float, top_3: list}
        """
        if self.model is None or len(self._y) < self.MIN_SAMPLES:
            return self._heuristic_ranking()

        if len(market_features) < 70:
            return self._heuristic_ranking()

        mkt_feats = market_features[50:70].reshape(1, -1)
        proba = self.model.predict_proba(mkt_feats)[0]

        # Get top 3 strategies
        top_indices = np.argsort(proba)[-3:][::-1]
        top_3 = []
        for idx in top_indices:
            # Map back to actual strategy name
            if idx < len(self.model.classes_):
                strat_idx = self.model.classes_[idx]
                if strat_idx < len(STRATEGY_NAMES):
                    top_3.append({
                        "strategy": STRATEGY_NAMES[strat_idx],
                        "probability": round(float(proba[idx]) * 100, 1),
                    })

        best = top_3[0] if top_3 else {"strategy": "MULTI_CONSENSUS", "probability": 50}

        return {
            "strategy": best["strategy"],
            "confidence": best["probability"],
            "top_3": top_3,
            "method": "ml",
            "training_samples": len(self._y),
        }

    def get_strategy_boost(self, strategy_name: str, market_features: np.ndarray) -> int:
        """Get confidence boost if this strategy is predicted as best.

        Returns: 0-10 confidence boost.
        """
        prediction = self.predict_best_strategy(market_features)
        if prediction["strategy"] == strategy_name:
            return min(10, max(0, int(prediction["confidence"] / 10)))
        if any(s["strategy"] == strategy_name for s in prediction.get("top_3", [])):
            return 3
        return 0

    def _heuristic_ranking(self) -> dict:
        """Fallback ranking based on observed performance."""
        if not self._strategy_performance:
            return {"strategy": "MULTI_CONSENSUS", "confidence": 50, "top_3": [], "method": "default"}

        ranked = []
        for name, perf in self._strategy_performance.items():
            total = perf["wins"] + perf["losses"]
            if total >= 3:
                win_rate = perf["wins"] / total
                ranked.append((name, win_rate, perf["total_pnl"]))

        if not ranked:
            return {"strategy": "MULTI_CONSENSUS", "confidence": 50, "top_3": [], "method": "default"}

        ranked.sort(key=lambda x: x[2], reverse=True)  # sort by total PnL
        top_3 = [{"strategy": r[0], "probability": round(r[1] * 100, 1)} for r in ranked[:3]]

        return {
            "strategy": ranked[0][0],
            "confidence": round(ranked[0][1] * 100, 1),
            "top_3": top_3,
            "method": "heuristic",
            "training_samples": len(self._y),
        }

    def _train(self):
        """Train the meta-learner model."""
        X = np.array(self._X)
        y = np.array(self._y)

        unique = np.unique(y)
        if len(unique) < 2:
            return

        self.model = RandomForestClassifier(
            n_estimators=50, max_depth=4, min_samples_leaf=3, random_state=42
        )
        self.model.fit(X, y)
        self._samples_since_train = 0
        logger.info(f"Meta-learner trained on {len(y)} samples, {len(unique)} strategies")

    def get_status(self) -> dict:
        return {
            "model_trained": self.model is not None,
            "training_samples": len(self._y),
            "strategy_performance": {
                name: {
                    "wins": perf["wins"],
                    "losses": perf["losses"],
                    "win_rate": round(perf["wins"] / (perf["wins"] + perf["losses"]) * 100, 1) if perf["wins"] + perf["losses"] > 0 else 0,
                    "total_pnl": round(perf["total_pnl"], 3),
                }
                for name, perf in self._strategy_performance.items()
            },
        }


_instance: Optional[MetaLearner] = None


def get_meta_learner() -> MetaLearner:
    global _instance
    if _instance is None:
        _instance = MetaLearner()
    return _instance
