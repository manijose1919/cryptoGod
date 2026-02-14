"""
Stacking Ensemble Meta-Model

Takes predictions from multiple base models (ML ensemble, RL agent, GRU sequence
model, anomaly detector) and combines them via a LogisticRegression meta-learner
for higher-quality trading signals.

The meta-learner trains on observed base-model predictions paired with actual
outcomes, learning which models to trust under which conditions.
"""

import logging
import threading
import time
from collections import deque
from typing import Dict, List, Optional

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("stacking_ensemble")

# Base model keys expected in prediction dicts
BASE_MODELS = ["ml_ensemble", "rl_agent", "sequence_model", "anomaly_detector"]

# Action encoding
ACTION_MAP = {"BUY": 0, "SELL": 1, "HOLD": 2}
ACTION_NAMES = {0: "BUY", 1: "SELL", 2: "HOLD"}

# Training thresholds
MIN_SAMPLES_TO_TRAIN = 100
MAX_BUFFER_SIZE = 500


def _encode_action(action: str) -> int:
    """Map action string to integer label."""
    return ACTION_MAP.get(action.upper(), 2)


def _extract_features(predictions: Dict[str, dict]) -> np.ndarray:
    """Convert a dict of base-model predictions into a flat feature vector.

    Per base model we extract:
      - action encoded as one-hot (3 values: BUY, SELL, HOLD)
      - confidence (0-100 scaled to 0-1)
    Total features: 4 models * 4 values = 16
    """
    features: List[float] = []
    for model_key in BASE_MODELS:
        pred = predictions.get(model_key, {})
        action = pred.get("action", "HOLD").upper()
        confidence = float(pred.get("confidence", 0))

        # One-hot action
        one_hot = [0.0, 0.0, 0.0]
        idx = _encode_action(action)
        one_hot[idx] = 1.0
        features.extend(one_hot)

        # Normalised confidence
        features.append(confidence / 100.0)

    return np.array(features, dtype=np.float64)


def _count_agreement(predictions: Dict[str, dict]) -> int:
    """Count how many base models agree on the majority action."""
    votes: Dict[str, int] = {"BUY": 0, "SELL": 0, "HOLD": 0}
    for model_key in BASE_MODELS:
        pred = predictions.get(model_key, {})
        action = pred.get("action", "HOLD").upper()
        if action in votes:
            votes[action] += 1
    return max(votes.values()) if votes else 0


class StackingEnsemble:
    """Stacking meta-learner that combines base model predictions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

        # Meta-learner components
        self._model: Optional[LogisticRegression] = None
        self._scaler: StandardScaler = StandardScaler()
        self._is_trained: bool = False

        # Training buffer (circular)
        self._feature_buffer: deque = deque(maxlen=MAX_BUFFER_SIZE)
        self._label_buffer: deque = deque(maxlen=MAX_BUFFER_SIZE)

        # Stats
        self._total_recorded: int = 0
        self._last_train_time: float = 0.0
        self._train_count: int = 0
        self._accuracy: float = 0.0

        logger.info("StackingEnsemble initialised (min_samples=%d, buffer=%d)",
                     MIN_SAMPLES_TO_TRAIN, MAX_BUFFER_SIZE)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record_base_predictions(self, predictions: Dict[str, dict], actual_outcome: str) -> None:
        """Store base model predictions paired with the actual outcome for training.

        Args:
            predictions: Dict keyed by base-model name, each value has
                         {"action": str, "confidence": float, ...}
            actual_outcome: The true label — "BUY", "SELL", or "HOLD".
        """
        if actual_outcome.upper() not in ACTION_MAP:
            logger.warning("Invalid outcome '%s', skipping record", actual_outcome)
            return

        features = _extract_features(predictions)
        label = _encode_action(actual_outcome)

        with self._lock:
            self._feature_buffer.append(features)
            self._label_buffer.append(label)
            self._total_recorded += 1

            # Auto-train when threshold reached and periodically afterward
            buffer_len = len(self._label_buffer)
            if buffer_len >= MIN_SAMPLES_TO_TRAIN:
                samples_since = self._total_recorded - (self._train_count * MIN_SAMPLES_TO_TRAIN)
                if not self._is_trained or samples_since >= 50:
                    self._train_locked()

    def get_meta_prediction(self, predictions: Dict[str, dict]) -> dict:
        """Generate a combined prediction from base model outputs.

        Args:
            predictions: Dict keyed by base-model name, each value has
                         {"action": str, "confidence": float, ...}

        Returns:
            {
                "action": "BUY" | "SELL" | "HOLD",
                "confidence": 0-100,
                "method": "stacking_ensemble",
                "base_models_agreed": int,
            }
        """
        agreement = _count_agreement(predictions)

        with self._lock:
            if not self._is_trained:
                return self._fallback_vote(predictions, agreement)

            try:
                features = _extract_features(predictions).reshape(1, -1)
                features_scaled = self._scaler.transform(features)

                proba = self._model.predict_proba(features_scaled)[0]
                pred_idx = int(np.argmax(proba))
                confidence = float(np.max(proba)) * 100.0

                # Map predicted class back through the model's class labels
                action_label = int(self._model.classes_[pred_idx])
                action = ACTION_NAMES.get(action_label, "HOLD")

                return {
                    "action": action,
                    "confidence": round(min(100.0, max(0.0, confidence)), 1),
                    "method": "stacking_ensemble",
                    "base_models_agreed": agreement,
                }

            except Exception as exc:
                logger.error("Meta-prediction failed: %s", exc)
                return self._fallback_vote(predictions, agreement)

    def get_status(self) -> dict:
        """Return diagnostic status of the stacking ensemble."""
        with self._lock:
            return {
                "is_trained": self._is_trained,
                "buffer_size": len(self._label_buffer),
                "total_recorded": self._total_recorded,
                "train_count": self._train_count,
                "accuracy": round(self._accuracy, 3),
                "last_train_time": self._last_train_time,
                "min_samples": MIN_SAMPLES_TO_TRAIN,
                "max_buffer": MAX_BUFFER_SIZE,
            }

    # ------------------------------------------------------------------
    # Internal helpers (must be called with self._lock held)
    # ------------------------------------------------------------------

    def _train_locked(self) -> None:
        """Train the meta-learner on the current buffer. Caller holds _lock."""
        X = np.array(list(self._feature_buffer))
        y = np.array(list(self._label_buffer))

        unique_classes = np.unique(y)
        if len(unique_classes) < 2:
            logger.info("Skipping training — only %d class(es) in buffer", len(unique_classes))
            return

        try:
            self._scaler = StandardScaler()
            X_scaled = self._scaler.fit_transform(X)

            model = LogisticRegression(
                C=1.0,
                max_iter=500,
                solver="lbfgs",
                multi_class="multinomial",
                class_weight="balanced",
            )
            model.fit(X_scaled, y)

            # In-sample accuracy for monitoring
            preds = model.predict(X_scaled)
            self._accuracy = float(np.mean(preds == y))

            self._model = model
            self._is_trained = True
            self._train_count += 1
            self._last_train_time = time.time()

            logger.info(
                "Stacking meta-learner trained (#%d) — %d samples, accuracy %.1f%%, classes %s",
                self._train_count, len(y), self._accuracy * 100, unique_classes.tolist(),
            )

        except Exception as exc:
            logger.error("Meta-learner training failed: %s", exc)

    @staticmethod
    def _fallback_vote(predictions: Dict[str, dict], agreement: int) -> dict:
        """Confidence-weighted majority vote when meta-learner is not yet trained."""
        weighted_scores: Dict[str, float] = {"BUY": 0.0, "SELL": 0.0, "HOLD": 0.0}

        for model_key in BASE_MODELS:
            pred = predictions.get(model_key, {})
            action = pred.get("action", "HOLD").upper()
            conf = float(pred.get("confidence", 0))
            if action in weighted_scores:
                weighted_scores[action] += conf

        total_weight = sum(weighted_scores.values())
        if total_weight == 0:
            return {
                "action": "HOLD",
                "confidence": 0,
                "method": "stacking_ensemble",
                "base_models_agreed": agreement,
            }

        best_action = max(weighted_scores, key=weighted_scores.get)  # type: ignore[arg-type]
        confidence = (weighted_scores[best_action] / total_weight) * 100.0

        return {
            "action": best_action,
            "confidence": round(min(100.0, max(0.0, confidence)), 1),
            "method": "stacking_ensemble",
            "base_models_agreed": agreement,
        }


# ------------------------------------------------------------------
# Singleton
# ------------------------------------------------------------------

_instance: Optional[StackingEnsemble] = None
_instance_lock = threading.Lock()


def get_stacking_ensemble() -> StackingEnsemble:
    """Return the singleton StackingEnsemble instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = StackingEnsemble()
    return _instance
