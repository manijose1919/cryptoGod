"""
Local ML Models
- TradePredictor: Voting ensemble (XGBoost + RF + LightGBM + GradientBoosting) with online retraining
- SentimentScorer: VADER + crypto-specific lexicon
- StrategyWeighter: Adaptive strategy weighting from trade outcomes
"""
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
from sklearn.ensemble import (
    GradientBoostingClassifier,
    RandomForestClassifier,
    VotingClassifier,
)
from sklearn.preprocessing import StandardScaler
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import xgboost as xgb
import lightgbm as lgb

from feature_engineer import FEATURE_COUNT, FEATURE_NAMES, STRATEGY_NAMES

logger = logging.getLogger(__name__)

MODEL_DIR = Path("models")
MODEL_DIR.mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════
# TRADE PREDICTOR
# ═══════════════════════════════════════════════════════════════════════════

class TradePredictor:
    """Predicts BUY/SELL/HOLD with confidence using a 4-model voting ensemble.

    Ensemble: XGBoost + RandomForest + LightGBM + GradientBoosting (soft voting).
    Starts with a heuristic fallback, transitions to ML after MIN_SAMPLES trades.
    Retrains every RETRAIN_INTERVAL new samples.
    """

    MIN_SAMPLES = 50          # minimum trades before using ML
    RETRAIN_INTERVAL = 25     # retrain after this many new samples
    LABELS = ["SELL", "HOLD", "BUY"]  # class order
    LABEL_MAP = {"SELL": 0, "HOLD": 1, "BUY": 2}

    def __init__(self):
        self.model: Optional[VotingClassifier] = None
        self.scaler = StandardScaler()
        self.X_history: list = []  # feature vectors
        self.y_history: list = []  # labels (0=SELL, 1=HOLD, 2=BUY)
        self.samples_since_train = 0
        self._sub_model_scores: dict = {}  # individual model accuracies from last train
        self._selected_features: Optional[np.ndarray] = None  # mask of top features
        self._calibrator = None  # isotonic calibration
        self._mi_scores: Optional[np.ndarray] = None  # mutual information scores
        # Online learner (SGD) for immediate updates between ensemble retrains
        self._online_model = None
        self._online_scaler = StandardScaler()
        self._online_samples = 0
        self._load()

    def _model_path(self):
        return MODEL_DIR / "trade_predictor.joblib"

    def _data_path(self):
        return MODEL_DIR / "trade_data.npz"

    def _load(self):
        """Load saved model and training data."""
        if self._model_path().exists():
            try:
                saved = joblib.load(self._model_path())
                self.model = saved["model"]
                self.scaler = saved["scaler"]
                logger.info("Loaded trade predictor model")
            except Exception as e:
                logger.warning(f"Could not load model (will retrain): {e}")
                self.model = None

        if self._data_path().exists():
            try:
                data = np.load(self._data_path(), allow_pickle=True)
                X_raw = data["X"].tolist()
                y_raw = data["y"].tolist()
                # Filter out samples with wrong feature count (from older versions)
                valid_X, valid_y = [], []
                for x, y in zip(X_raw, y_raw):
                    if len(x) == FEATURE_COUNT:
                        valid_X.append(x)
                        valid_y.append(y)
                dropped = len(X_raw) - len(valid_X)
                if dropped > 0:
                    logger.info(f"Dropped {dropped} old samples (wrong feature dim)")
                self.X_history = valid_X
                self.y_history = valid_y
                logger.info(f"Loaded {len(self.y_history)} training samples (dim={FEATURE_COUNT})")
            except Exception as e:
                logger.warning(f"Could not load training data: {e}")

    def _save(self):
        """Persist model and training data."""
        if self.model is not None:
            joblib.dump({"model": self.model, "scaler": self.scaler}, self._model_path())

        if self.X_history:
            np.savez(self._data_path(), X=np.array(self.X_history), y=np.array(self.y_history))

    def record_outcome(self, features: np.ndarray, action: str, pnl_pct: float):
        """Record a trade outcome for learning.

        Derives the correct label from actual PnL, accounting for real trading costs.
        Fee-aware thresholds: round-trip fees ~0.15-0.52% + slippage ~0.08%.
        A trade is only labeled as profitable if it exceeded ALL costs.
        """
        # Fee-aware break-even threshold (covers fees + slippage for most exchanges)
        break_even_pct = 0.38  # ~0.30% round-trip fees + 0.08% slippage

        if pnl_pct > break_even_pct:
            # Trade was profitable after costs → the action was correct
            label = self.LABEL_MAP.get(action, 1)
        elif pnl_pct < -break_even_pct:
            # Trade lost money after costs → opposite action was better
            if action == "BUY":
                label = self.LABEL_MAP["SELL"]
            elif action == "SELL":
                label = self.LABEL_MAP["BUY"]
            else:
                label = self.LABEL_MAP["HOLD"]
        else:
            # Within break-even zone → HOLD was the right call
            label = self.LABEL_MAP["HOLD"]

        self.X_history.append(features.tolist())
        self.y_history.append(label)
        self.samples_since_train += 1

        # Online learning: incremental SGD update
        self._online_update(features, label)

        # Auto-retrain ensemble
        if len(self.y_history) >= self.MIN_SAMPLES and self.samples_since_train >= self.RETRAIN_INTERVAL:
            self._train()

        self._save()

    def _online_update(self, features: np.ndarray, label: int):
        """Incremental update using SGDClassifier for real-time learning."""
        from sklearn.linear_model import SGDClassifier
        X = features.reshape(1, -1)

        if self._online_model is None:
            self._online_model = SGDClassifier(
                loss="modified_huber",  # gives probability estimates
                penalty="l2",
                alpha=0.001,
                random_state=42,
                warm_start=True,
            )
            # Need to see all classes before partial_fit
            if len(self.y_history) < 5:
                return
            X_init = np.array(self.X_history[-5:])
            y_init = np.array(self.y_history[-5:])
            self._online_scaler.fit(X_init)
            X_init_scaled = self._online_scaler.transform(X_init)
            self._online_model.partial_fit(X_init_scaled, y_init, classes=[0, 1, 2])
            self._online_samples = 5
            return

        try:
            # Incremental scaling update
            self._online_scaler.partial_fit(X)
            X_scaled = self._online_scaler.transform(X)
            self._online_model.partial_fit(X_scaled, [label])
            self._online_samples += 1
        except Exception:
            pass

    def _build_ensemble(self) -> VotingClassifier:
        """Build a 4-model soft-voting ensemble."""
        n_classes = 3
        estimators = [
            ("xgb", xgb.XGBClassifier(
                n_estimators=100,
                max_depth=4,
                learning_rate=0.1,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_weight=5,
                num_class=n_classes,
                objective="multi:softprob",
                eval_metric="mlogloss",
                use_label_encoder=False,
                random_state=42,
                verbosity=0,
            )),
            ("rf", RandomForestClassifier(
                n_estimators=150,
                max_depth=6,
                min_samples_leaf=5,
                max_features="sqrt",
                random_state=42,
                n_jobs=-1,
            )),
            ("lgbm", lgb.LGBMClassifier(
                n_estimators=100,
                max_depth=4,
                learning_rate=0.1,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_samples=5,
                num_class=n_classes,
                objective="multiclass",
                random_state=42,
                verbose=-1,
            )),
            ("gb", GradientBoostingClassifier(
                n_estimators=100,
                max_depth=4,
                learning_rate=0.1,
                subsample=0.8,
                min_samples_leaf=5,
                random_state=42,
            )),
        ]
        return VotingClassifier(estimators=estimators, voting="soft")

    def _train(self):
        """Train/retrain the 4-model voting ensemble on accumulated data.

        Uses chronological train/test split (80/20) to prevent look-ahead bias.
        Applies SMOTE oversampling ONLY to training data (prevents data leakage).
        """
        X = np.array(self.X_history)
        y = np.array(self.y_history)

        # Need at least 2 classes
        unique_classes, class_counts = np.unique(y, return_counts=True)
        if len(unique_classes) < 2:
            logger.info("Not enough class diversity to train yet")
            return

        logger.info(f"Training 4-model ensemble on {len(y)} samples...")
        logger.info(f"  Class distribution: {dict(zip(unique_classes, class_counts))}")

        # Chronological train/test split (80/20) — no shuffle to prevent look-ahead bias
        n_test = max(1, len(y) // 5)
        n_train = len(y) - n_test
        X_train_raw, X_test_raw = X[:n_train], X[n_train:]
        y_train, y_test = y[:n_train], y[n_train:]

        logger.info(f"  Split: train={n_train}, test={n_test}")

        # Fit scaler on TRAINING data only (prevents data leakage)
        self.scaler = StandardScaler()
        X_train_scaled = self.scaler.fit_transform(X_train_raw)
        X_test_scaled = self.scaler.transform(X_test_raw)

        X_scaled = X_train_scaled
        y = y_train

        # Apply SMOTE to TRAINING data only (after split, preventing data leakage)
        train_classes, train_counts = np.unique(y_train, return_counts=True)
        max_count = max(train_counts) if len(train_counts) > 0 else 0
        min_count = min(train_counts) if len(train_counts) > 0 else 0
        if max_count > min_count * 2 and min_count >= 3 and len(train_classes) >= 2:
            try:
                from imblearn.over_sampling import SMOTE
                smote = SMOTE(random_state=42, k_neighbors=min(5, min_count - 1))
                X_balanced, y_balanced = smote.fit_resample(X_train_scaled, y_train)
                new_counts = dict(zip(*np.unique(y_balanced, return_counts=True)))
                logger.info(f"  SMOTE applied to train only: {n_train} -> {len(y_balanced)} samples, classes: {new_counts}")
                X_scaled = X_balanced
                y = y_balanced
            except Exception as e:
                logger.warning(f"  SMOTE failed, using original data: {e}")

        # Feature selection via mutual information (drop features with MI < 0.01)
        try:
            from sklearn.feature_selection import mutual_info_classif
            mi_scores = mutual_info_classif(X_scaled, y, random_state=42)
            self._mi_scores = mi_scores
            # Select features with MI > threshold (keep at least 50% of features)
            threshold = 0.01
            mask = mi_scores >= threshold
            if mask.sum() < len(mi_scores) * 0.5:
                # If too many dropped, keep top 50%
                cutoff = np.percentile(mi_scores, 50)
                mask = mi_scores >= cutoff
            self._selected_features = mask
            n_selected = mask.sum()
            n_dropped = len(mask) - n_selected
            logger.info(f"  Feature selection: kept {n_selected}/{len(mask)} features (dropped {n_dropped})")
            X_train = X_scaled[:, mask]
        except Exception as e:
            logger.debug(f"Feature selection skipped: {e}")
            self._selected_features = None
            X_train = X_scaled

        self.model = self._build_ensemble()
        self.model.fit(X_train, y)
        self.samples_since_train = 0

        # Log individual model scores — report BOTH in-sample and test set scores
        self._sub_model_scores = {}
        for name, est in self.model.named_estimators_.items():
            try:
                train_score = est.score(X_train, y)
                # Apply feature selection to test set for scoring
                X_test_input = X_test_scaled[:, self._selected_features] if self._selected_features is not None else X_test_scaled
                test_score = est.score(X_test_input, y_test)
                self._sub_model_scores[name] = {
                    "train": round(train_score, 4),
                    "test": round(test_score, 4),
                }
            except Exception:
                pass
        logger.info(f"Sub-model scores (train/test): {self._sub_model_scores}")

        # Report test set accuracy for the full ensemble
        try:
            X_test_input = X_test_scaled[:, self._selected_features] if self._selected_features is not None else X_test_scaled
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                ensemble_test_acc = self.model.score(X_test_input, y_test)
            logger.info(f"Ensemble test accuracy: {ensemble_test_acc:.4f}")
        except Exception as e:
            logger.debug(f"Could not compute ensemble test accuracy: {e}")

        # Prediction calibration (isotonic regression)
        try:
            from sklearn.calibration import CalibratedClassifierCV
            from sklearn.model_selection import cross_val_predict
            if len(y) >= 30:
                # Get uncalibrated probabilities via cross-validation
                cv_folds = min(5, len(np.unique(y)))
                uncal_proba = cross_val_predict(self.model, X_train, y, cv=cv_folds, method="predict_proba")
                # Fit isotonic calibration
                from sklearn.isotonic import IsotonicRegression
                # Calibrate the max-probability prediction
                max_proba = uncal_proba.max(axis=1)
                correct = (np.argmax(uncal_proba, axis=1) == y).astype(float)
                self._calibrator = IsotonicRegression(out_of_bounds="clip")
                self._calibrator.fit(max_proba, correct)
                logger.info("  Prediction calibration (isotonic) fitted")
        except Exception as e:
            logger.debug(f"Calibration skipped: {e}")
            self._calibrator = None

        # Log feature importances (average across tree-based models)
        importances = self._compute_avg_importances()
        if importances is not None:
            # Map back to original feature indices if selection was applied
            if self._selected_features is not None:
                full_imp = np.zeros(len(self._selected_features))
                full_imp[self._selected_features] = importances
                importances = full_imp
            top_idx = np.argsort(importances)[-10:][::-1]
            top_feats = [(FEATURE_NAMES[i] if i < len(FEATURE_NAMES) else f"f{i}", round(importances[i], 4)) for i in top_idx]
            logger.info(f"Top features (ensemble avg): {top_feats}")

        self._save()
        logger.info("4-model ensemble trained and saved")

    def _compute_avg_importances(self) -> Optional[np.ndarray]:
        """Average feature importances across all sub-models that support it."""
        if self.model is None:
            return None
        all_imp = []
        for name, est in self.model.named_estimators_.items():
            if hasattr(est, "feature_importances_"):
                imp = est.feature_importances_
                # Normalize to sum=1
                s = imp.sum()
                if s > 0:
                    all_imp.append(imp / s)
        if not all_imp:
            return None
        return np.mean(all_imp, axis=0)

    def predict(self, features: np.ndarray) -> dict:
        """Predict trade action from feature vector.

        Returns: {"action": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "method": "ml"|"heuristic"}
        """
        if self.model is not None and len(self.y_history) >= self.MIN_SAMPLES:
            return self._predict_ml(features)
        # Try online model as intermediate step
        if self._online_model is not None and self._online_samples >= 10:
            return self._predict_online(features)
        return self._predict_heuristic(features)

    def _predict_online(self, features: np.ndarray) -> dict:
        """Prediction using online SGD model (before ensemble is trained)."""
        try:
            X = features.reshape(1, -1)
            X_scaled = self._online_scaler.transform(X)
            proba = self._online_model.predict_proba(X_scaled)[0]
            pred_idx = np.argmax(proba)
            confidence = proba[pred_idx] * 100
            return {
                "action": self.LABELS[pred_idx],
                "confidence": round(confidence, 1),
                "probabilities": {self.LABELS[i]: round(p * 100, 1) for i, p in enumerate(proba)},
                "method": "online_sgd",
                "training_samples": self._online_samples,
            }
        except Exception:
            return self._predict_heuristic(features)

    def _predict_ml(self, features: np.ndarray) -> dict:
        """ML-based prediction using 4-model voting ensemble."""
        import warnings
        X = features.reshape(1, -1)
        X_scaled = self.scaler.transform(X)

        # Apply feature selection mask
        if self._selected_features is not None:
            X_input = X_scaled[:, self._selected_features]
        else:
            X_input = X_scaled

        # Ensemble soft-vote probabilities (suppress LightGBM feature name warnings)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            proba = self.model.predict_proba(X_input)[0]
        pred_idx = np.argmax(proba)
        confidence = proba[pred_idx] * 100

        # Apply calibration if available
        if self._calibrator is not None:
            try:
                calibrated = self._calibrator.predict([proba[pred_idx]])[0]
                confidence = calibrated * 100
            except Exception:
                pass

        # Also get individual model predictions for transparency
        sub_predictions = {}
        for name, est in self.model.named_estimators_.items():
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    sub_proba = est.predict_proba(X_input)[0]
                sub_pred = np.argmax(sub_proba)
                sub_predictions[name] = {
                    "action": self.LABELS[sub_pred],
                    "confidence": round(float(sub_proba[sub_pred]) * 100, 1),
                }
            except Exception:
                pass

        # Count agreement among sub-models
        actions = [v["action"] for v in sub_predictions.values()]
        agreement = actions.count(self.LABELS[pred_idx]) / len(actions) if actions else 0

        return {
            "action": self.LABELS[pred_idx],
            "confidence": round(confidence, 1),
            "probabilities": {self.LABELS[i]: round(p * 100, 1) for i, p in enumerate(proba)},
            "method": "ensemble",
            "training_samples": len(self.y_history),
            "sub_models": sub_predictions,
            "model_agreement": round(agreement * 100, 1),
        }

    def _predict_heuristic(self, features: np.ndarray) -> dict:
        """Rule-based fallback when insufficient training data.

        Uses strategy consensus from the feature vector directly.
        """
        # Strategy features are first 50 values: pairs of (direction, confidence)
        buy_score = 0.0
        sell_score = 0.0

        for i in range(0, min(50, len(features)), 2):
            direction = features[i]
            conf = features[i + 1]
            if direction > 0:
                buy_score += conf
            elif direction < 0:
                sell_score += conf

        total = buy_score + sell_score
        if total == 0:
            return {"action": "HOLD", "confidence": 0, "method": "heuristic", "training_samples": len(self.y_history)}

        if buy_score > sell_score:
            confidence = (buy_score / total) * 100 * min(1.0, buy_score / 3.0)
            return {"action": "BUY", "confidence": round(min(85, confidence), 1), "method": "heuristic",
                    "training_samples": len(self.y_history)}
        elif sell_score > buy_score:
            confidence = (sell_score / total) * 100 * min(1.0, sell_score / 3.0)
            return {"action": "SELL", "confidence": round(min(85, confidence), 1), "method": "heuristic",
                    "training_samples": len(self.y_history)}

        return {"action": "HOLD", "confidence": 0, "method": "heuristic", "training_samples": len(self.y_history)}

    def get_feature_importances(self) -> dict:
        """Return feature importance rankings averaged across ensemble models."""
        importances = self._compute_avg_importances()
        if importances is None:
            return {}
        return {FEATURE_NAMES[i]: round(float(importances[i]), 4)
                for i in range(min(len(FEATURE_NAMES), len(importances)))}

    def get_sub_model_scores(self) -> dict:
        """Return individual sub-model accuracy scores from last training."""
        return self._sub_model_scores.copy()

    def explain_prediction(self, features: np.ndarray) -> dict:
        """Explain a prediction using SHAP values.

        Returns top contributing features with their SHAP values.
        """
        if self.model is None or len(self.y_history) < self.MIN_SAMPLES:
            return {"available": False, "reason": "Model not trained yet"}

        try:
            import shap

            X = features.reshape(1, -1)
            X_scaled = self.scaler.transform(X)
            X_input = X_scaled[:, self._selected_features] if self._selected_features is not None else X_scaled

            # Use RandomForest sub-model for SHAP (supports multiclass TreeExplainer)
            rf_model = self.model.named_estimators_.get("rf")
            if rf_model is None:
                return {"available": False, "reason": "RF model not found in ensemble"}

            explainer = shap.TreeExplainer(rf_model)
            shap_values = explainer.shap_values(X_input)

            # Get prediction class
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                pred_class = np.argmax(self.model.predict_proba(X_input)[0])

            # SHAP values for predicted class
            # Newer SHAP: shape (1, n_features, n_classes) or list of arrays
            if isinstance(shap_values, np.ndarray) and shap_values.ndim == 3:
                sv = shap_values[0, :, pred_class]  # (features,) for predicted class
            elif isinstance(shap_values, list):
                sv = shap_values[pred_class][0]
            else:
                sv = shap_values[0]

            # Map SHAP values back to original feature indices
            if self._selected_features is not None:
                original_indices = np.where(self._selected_features)[0]
            else:
                original_indices = np.arange(len(sv))

            # Top contributing features (by absolute SHAP value)
            n_features = min(len(sv), len(original_indices))
            indexed = [(original_indices[i], sv[i]) for i in range(n_features)]
            indexed.sort(key=lambda x: abs(x[1]), reverse=True)

            top_features = []
            for orig_i, val in indexed[:15]:
                name = FEATURE_NAMES[orig_i] if orig_i < len(FEATURE_NAMES) else f"feature_{orig_i}"
                top_features.append({
                    "feature": name,
                    "shap_value": round(float(val), 6),
                    "raw_value": round(float(features[orig_i]), 6) if orig_i < len(features) else 0,
                    "direction": "positive" if val > 0 else "negative",
                })

            # Extract base value safely
            ev = explainer.expected_value
            if hasattr(ev, '__len__') and len(ev) > pred_class:
                base_val = float(ev[pred_class])
            elif hasattr(ev, '__float__'):
                base_val = float(ev)
            else:
                base_val = 0.0

            return {
                "available": True,
                "predicted_class": self.LABELS[pred_class],
                "base_value": round(base_val, 6),
                "top_features": top_features,
            }
        except Exception as e:
            logger.warning(f"SHAP explanation failed: {e}")
            return {"available": False, "reason": str(e)}


# ═══════════════════════════════════════════════════════════════════════════
# SENTIMENT SCORER (VADER + Crypto Lexicon)
# ═══════════════════════════════════════════════════════════════════════════

# Crypto-specific sentiment additions for VADER
CRYPTO_LEXICON = {
    # Bullish
    "bullish": 2.5, "moon": 2.0, "mooning": 2.5, "pump": 1.5, "rally": 2.0,
    "breakout": 2.0, "ath": 2.5, "all-time high": 2.5, "adoption": 1.5,
    "accumulate": 1.5, "accumulation": 1.5, "hodl": 1.0, "buy the dip": 2.0,
    "institutional": 1.5, "etf approved": 3.0, "etf approval": 3.0,
    "partnership": 1.5, "upgrade": 1.5, "mainnet": 1.5, "halving": 1.5,
    "bullrun": 2.5, "bull run": 2.5, "support held": 1.5, "recovery": 1.5,
    "green": 1.0, "surge": 2.0, "surging": 2.0, "soaring": 2.0,
    # Bearish
    "bearish": -2.5, "crash": -3.0, "crashing": -3.0, "dump": -2.0,
    "dumping": -2.5, "rug pull": -3.5, "rugpull": -3.5, "scam": -3.0,
    "hack": -3.0, "hacked": -3.5, "exploit": -2.5, "bankrupt": -3.5,
    "bankruptcy": -3.5, "sec lawsuit": -2.5, "regulation": -1.0,
    "ban": -2.5, "banned": -3.0, "fud": -1.5, "sell-off": -2.5,
    "selloff": -2.5, "capitulation": -2.5, "liquidation": -2.0,
    "liquidated": -2.5, "fear": -1.5, "panic": -2.5, "plunge": -2.5,
    "red": -1.0, "resistance rejected": -1.5, "death cross": -2.0,
    "delisted": -3.0, "delisting": -2.5, "insolvent": -3.5,
    # Neutral/Moderate
    "consolidation": 0.5, "sideways": 0.0, "volatile": -0.5,
    "whale": 0.5, "whales": 0.5,
}


class SentimentScorer:
    """Local sentiment analysis using VADER with crypto-specific lexicon."""

    def __init__(self):
        self.analyzer = SentimentIntensityAnalyzer()
        # Inject crypto-specific terms
        self.analyzer.lexicon.update(CRYPTO_LEXICON)
        logger.info(f"Sentiment scorer initialized with {len(CRYPTO_LEXICON)} crypto terms")

    def score_headline(self, headline: str) -> float:
        """Score a single headline. Returns -1.0 to 1.0."""
        scores = self.analyzer.polarity_scores(headline)
        return scores["compound"]

    def score_headlines(self, headlines: list[str], symbol: str = "") -> dict:
        """Score a batch of headlines. Returns {score: -100..100, summary: str, details: [...]}."""
        if not headlines:
            return {"score": 0, "summary": "No news available", "details": []}

        scored = []
        for h in headlines:
            s = self.score_headline(h)
            scored.append({"headline": h, "score": round(s * 100, 1)})

        scores = [s["score"] for s in scored]
        avg_score = sum(scores) / len(scores) if scores else 0

        # Detect extremes
        bullish = [s for s in scored if s["score"] > 30]
        bearish = [s for s in scored if s["score"] < -30]

        if avg_score > 30:
            mood = "Strongly bullish"
        elif avg_score > 10:
            mood = "Mildly bullish"
        elif avg_score < -30:
            mood = "Strongly bearish"
        elif avg_score < -10:
            mood = "Mildly bearish"
        else:
            mood = "Neutral"

        summary = f"{mood} sentiment ({len(bullish)} bullish, {len(bearish)} bearish headlines)"

        return {
            "score": round(avg_score, 1),
            "summary": summary,
            "details": scored[:10],
            "bullish_count": len(bullish),
            "bearish_count": len(bearish),
        }


# ═══════════════════════════════════════════════════════════════════════════
# STRATEGY WEIGHTER (Adaptive)
# ═══════════════════════════════════════════════════════════════════════════

class StrategyWeighter:
    """Tracks which strategies are most profitable and adjusts weights.

    Each strategy starts with weight 1.0. After trades, winning strategies
    get boosted, losing strategies get dampened. Used to weight consensus.
    """

    DECAY_RATE = 0.95       # weight decay per evaluation (prevents runaway)
    BOOST_AMOUNT = 0.15     # boost for correct prediction
    PENALTY_AMOUNT = 0.10   # penalty for wrong prediction
    MIN_WEIGHT = 0.2
    MAX_WEIGHT = 3.0

    def __init__(self):
        self.weights = {name: 1.0 for name in STRATEGY_NAMES}
        self.strategy_stats = {name: {"wins": 0, "losses": 0, "total": 0} for name in STRATEGY_NAMES}
        self._load()

    def _path(self):
        return MODEL_DIR / "strategy_weights.json"

    def _load(self):
        if self._path().exists():
            try:
                with open(self._path()) as f:
                    data = json.load(f)
                self.weights = data.get("weights", self.weights)
                self.strategy_stats = data.get("stats", self.strategy_stats)
                logger.info("Loaded strategy weights")
            except Exception as e:
                logger.warning(f"Could not load strategy weights: {e}")

    def _save(self):
        with open(self._path(), "w") as f:
            json.dump({"weights": self.weights, "stats": self.strategy_stats}, f, indent=2)

    def record_outcome(self, signals: list[dict], pnl_pct: float):
        """Update strategy weights based on trade outcome.

        Strategies that agreed with a winning trade get boosted.
        Strategies that agreed with a losing trade get penalized.
        """
        profitable = pnl_pct > 0.38  # Fee-aware: must exceed round-trip fees + slippage

        for sig in signals:
            name = sig.get("name", "")
            if name not in self.weights:
                continue
            if sig["signal"] == "HOLD":
                continue

            self.strategy_stats[name]["total"] += 1

            if profitable:
                self.strategy_stats[name]["wins"] += 1
                self.weights[name] = min(self.MAX_WEIGHT,
                                         self.weights[name] + self.BOOST_AMOUNT)
            else:
                self.strategy_stats[name]["losses"] += 1
                self.weights[name] = max(self.MIN_WEIGHT,
                                         self.weights[name] - self.PENALTY_AMOUNT)

        # Apply decay to all weights (prevents runaway)
        for name in self.weights:
            self.weights[name] = max(self.MIN_WEIGHT,
                                     self.weights[name] * self.DECAY_RATE + (1 - self.DECAY_RATE))

        self._save()

    def get_weighted_consensus(self, signals: list[dict]) -> dict:
        """Produce a weighted consensus using adaptive strategy weights.

        Returns same format as StrategyEngine.get_consensus() but weighted.
        """
        buy_score = 0.0
        sell_score = 0.0
        buy_signals = []
        sell_signals = []

        for sig in signals:
            name = sig.get("name", "")
            weight = self.weights.get(name, 1.0)
            conf = sig.get("confidence", 0) / 100.0

            if sig["signal"] == "BUY" and conf > 0:
                weighted = conf * weight
                buy_score += weighted
                buy_signals.append({**sig, "weight": round(weight, 2), "weighted_conf": round(weighted * 100, 1)})
            elif sig["signal"] == "SELL" and conf > 0:
                weighted = conf * weight
                sell_score += weighted
                sell_signals.append({**sig, "weight": round(weight, 2), "weighted_conf": round(weighted * 100, 1)})

        total_active = buy_score + sell_score
        if total_active == 0:
            return {
                "action": "HOLD", "confidence": 0,
                "buy_count": 0, "sell_count": 0,
                "active_signals": [], "top_signal": None, "method": "weighted",
            }

        if buy_score > sell_score:
            action = "BUY"
            confidence = (buy_score / total_active) * 100
            active = sorted(buy_signals, key=lambda s: s["weighted_conf"], reverse=True)
        elif sell_score > buy_score:
            action = "SELL"
            confidence = (sell_score / total_active) * 100
            active = sorted(sell_signals, key=lambda s: s["weighted_conf"], reverse=True)
        else:
            action = "HOLD"
            confidence = 0
            active = []

        # Bonus for many strategies agreeing
        agree_count = len(buy_signals) if action == "BUY" else len(sell_signals)
        consensus_bonus = min(15, agree_count * 3)
        confidence = min(95, confidence + consensus_bonus)

        return {
            "action": action,
            "confidence": round(confidence, 1),
            "buy_count": len(buy_signals),
            "sell_count": len(sell_signals),
            "hold_count": len(signals) - len(buy_signals) - len(sell_signals),
            "active_signals": active[:10],
            "top_signal": active[0] if active else None,
            "method": "weighted",
        }

    def get_rankings(self) -> list[dict]:
        """Get strategy performance rankings."""
        rankings = []
        for name in STRATEGY_NAMES:
            stats = self.strategy_stats.get(name, {})
            total = stats.get("total", 0)
            wins = stats.get("wins", 0)
            rankings.append({
                "strategy": name,
                "weight": round(self.weights.get(name, 1.0), 3),
                "win_rate": round(wins / total * 100, 1) if total > 0 else 0,
                "total_trades": total,
            })
        rankings.sort(key=lambda r: r["weight"], reverse=True)
        return rankings
