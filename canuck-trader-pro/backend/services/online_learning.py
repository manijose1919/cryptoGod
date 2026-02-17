"""
Online Learning / Experience Replay / Curriculum Learning Service

Dramatically improves learning pace by combining three techniques:

1. **Online Learning** - Incremental SGDClassifier updates via partial_fit().
   No full retraining required; each new trade outcome refines the model.
   Learning rate decays exponentially (0.01 * 0.999^n).

2. **Experience Replay Buffer** - Prioritised circular buffer (10,000 capacity).
   High-error samples are replayed more often. Importance sampling weights
   correct for the priority bias during mini-batch updates.

3. **Curriculum Learning** - Three-phase difficulty schedule:
   Phase 1 (0-200 samples):   High-confidence trades only (>70)
   Phase 2 (200-1000 samples): Medium-confidence trades (>50)
   Phase 3 (1000+ samples):    Learn from everything
   Auto-progression based on model accuracy on a held-out validation set.
"""

import logging
import math
import threading
import time
from typing import Dict, List, Optional, Tuple

import numpy as np
from sklearn.linear_model import SGDClassifier
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("online_learning")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BUFFER_CAPACITY = 10_000
DEFAULT_BATCH_SIZE = 32
INITIAL_LEARNING_RATE = 0.01
LR_DECAY = 0.999
MIN_LEARNING_RATE = 1e-5

# Priority replay
PRIORITY_ALPHA = 0.6        # How much prioritisation (0 = uniform, 1 = full priority)
PRIORITY_BETA_START = 0.4   # Importance-sampling exponent (annealed to 1.0)
PRIORITY_BETA_INCREMENT = 0.001
PRIORITY_EPSILON = 1e-6     # Small constant so zero-error samples still get sampled

# Curriculum phase boundaries (accelerated for paper trading data collection)
PHASE_1_LIMIT = 10         # Was 200 — skip to phase 2 fast
PHASE_2_LIMIT = 30         # Was 1000 — skip to phase 3 fast
PHASE_1_CONFIDENCE_MIN = 10  # Was 70 — accept almost everything in phase 1
PHASE_2_CONFIDENCE_MIN = 5   # Was 50 — accept everything in phase 2

# Validation set fraction for curriculum auto-progression
VALIDATION_FRACTION = 0.15
ACCURACY_THRESHOLD_PHASE2 = 0.55   # Must hit 55% to advance from phase 1
ACCURACY_THRESHOLD_PHASE3 = 0.58   # Must hit 58% to advance from phase 2

# Action encoding
ACTION_MAP = {"BUY": 0, "SELL": 1, "HOLD": 2}
ACTION_NAMES = {0: "BUY", 1: "SELL", 2: "HOLD"}
ALL_CLASSES = np.array([0, 1, 2])


# ---------------------------------------------------------------------------
# Experience Replay Buffer with Prioritisation
# ---------------------------------------------------------------------------

class PrioritisedReplayBuffer:
    """Circular buffer storing (features, outcome, metadata) with priority-based sampling.

    Priority = |predicted_confidence - actual_outcome_score| + epsilon.
    Higher prediction errors are replayed more frequently. Importance sampling
    weights correct the bias introduced by non-uniform sampling.
    """

    def __init__(self, capacity: int = BUFFER_CAPACITY):
        self.capacity = capacity
        self.buffer: List[Optional[dict]] = [None] * capacity
        self.priorities: np.ndarray = np.zeros(capacity, dtype=np.float64)
        self.position: int = 0
        self.size: int = 0
        self.total_adds: int = 0
        self.total_replays: int = 0
        self.beta: float = PRIORITY_BETA_START

    def add(self, features: np.ndarray, outcome: int, metadata: dict,
            priority: float = 1.0):
        """Add an experience to the buffer with an initial priority."""
        idx = self.position
        self.buffer[idx] = {
            "features": features.copy(),
            "outcome": outcome,
            "metadata": metadata.copy() if metadata else {},
            "added_at": time.time(),
        }
        self.priorities[idx] = max(priority, PRIORITY_EPSILON)
        self.position = (self.position + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)
        self.total_adds += 1

    def sample(self, batch_size: int = DEFAULT_BATCH_SIZE
               ) -> Tuple[List[dict], np.ndarray, np.ndarray]:
        """Sample a prioritised mini-batch.

        Returns:
            experiences: list of dicts from the buffer
            indices: array of buffer indices (for priority update)
            is_weights: importance-sampling weights (normalised)
        """
        if self.size == 0:
            return [], np.array([]), np.array([])

        batch_size = min(batch_size, self.size)

        # Compute sampling probabilities from priorities
        prios = self.priorities[:self.size]
        probs = prios ** PRIORITY_ALPHA
        prob_sum = probs.sum()
        if prob_sum == 0:
            probs = np.ones(self.size) / self.size
        else:
            probs = probs / prob_sum

        indices = np.random.choice(self.size, size=batch_size, replace=False, p=probs)

        # Importance-sampling weights
        self.beta = min(1.0, self.beta + PRIORITY_BETA_INCREMENT)
        weights = (self.size * probs[indices]) ** (-self.beta)
        weights = weights / weights.max()  # Normalise so max weight = 1

        experiences = [self.buffer[i] for i in indices]
        self.total_replays += batch_size

        return experiences, indices, weights

    def update_priorities(self, indices: np.ndarray, new_priorities: np.ndarray):
        """Update priorities for sampled experiences (after computing new errors)."""
        for idx, prio in zip(indices, new_priorities):
            self.priorities[idx] = max(float(prio), PRIORITY_EPSILON)

    def get_stats(self) -> dict:
        """Return buffer statistics."""
        active_prios = self.priorities[:self.size] if self.size > 0 else np.array([0.0])
        return {
            "buffer_size": self.size,
            "buffer_capacity": self.capacity,
            "total_adds": self.total_adds,
            "total_replays": self.total_replays,
            "avg_priority": round(float(active_prios.mean()), 4),
            "max_priority": round(float(active_prios.max()), 4),
            "min_priority": round(float(active_prios.min()), 4),
            "beta": round(self.beta, 4),
        }


# ---------------------------------------------------------------------------
# Curriculum Manager
# ---------------------------------------------------------------------------

class CurriculumManager:
    """Three-phase difficulty schedule for training data admission.

    Phase 1: Only high-confidence, clear-outcome trades.
    Phase 2: Include medium-confidence trades.
    Phase 3: Learn from everything.
    Auto-progression based on validation accuracy.
    """

    def __init__(self):
        self.phase: int = 1
        self.total_processed: int = 0
        self.phase_samples: Dict[int, int] = {1: 0, 2: 0, 3: 0}
        self.phase_accepted: Dict[int, int] = {1: 0, 2: 0, 3: 0}
        self.validation_accuracy: float = 0.0
        self._force_advanced: bool = False

    def should_accept(self, confidence: float, pnl_pct: float,
                      holding_time: float = 1.0) -> bool:
        """Decide whether to accept this sample given the current phase.

        Args:
            confidence: Trade confidence score (0-100).
            pnl_pct: Realised PnL percentage.
            holding_time: Holding time in minutes (for difficulty scoring).

        Returns:
            True if the sample passes the curriculum filter.
        """
        self.total_processed += 1
        self.phase_samples[self.phase] = self.phase_samples.get(self.phase, 0) + 1

        accepted = False
        if self.phase == 1:
            # Only learn from high-confidence trades with clear outcomes
            accepted = confidence >= PHASE_1_CONFIDENCE_MIN and abs(pnl_pct) > 0.1
        elif self.phase == 2:
            # Include medium-confidence trades
            accepted = confidence >= PHASE_2_CONFIDENCE_MIN
        else:
            # Phase 3: learn from everything
            accepted = True

        if accepted:
            self.phase_accepted[self.phase] = self.phase_accepted.get(self.phase, 0) + 1

        return accepted

    def difficulty_score(self, pnl_pct: float, confidence: float,
                         holding_time: float = 1.0) -> float:
        """Score difficulty of a sample: easier (higher score) = better for early learning.

        Formula: abs(pnl) * confidence * (1 / holding_time_variance)
        Higher score = easier sample (strong signal, clear outcome).
        """
        ht_variance = max(0.1, abs(holding_time - 30.0))  # deviation from typical 30m
        score = abs(pnl_pct) * (confidence / 100.0) * (1.0 / ht_variance)
        return round(score, 4)

    def check_progression(self, accuracy: float, total_accepted: int):
        """Check if the model should progress to the next curriculum phase.

        Args:
            accuracy: Current model accuracy on validation set (0-1).
            total_accepted: Total samples accepted so far.
        """
        self.validation_accuracy = accuracy
        old_phase = self.phase

        if self.phase == 1:
            # Progress if enough samples AND accuracy is above threshold
            if total_accepted >= PHASE_1_LIMIT and accuracy >= ACCURACY_THRESHOLD_PHASE2:
                self.phase = 2
            elif total_accepted >= PHASE_1_LIMIT * 2:
                # Force-advance if stuck in phase 1 too long
                self.phase = 2
                self._force_advanced = True
        elif self.phase == 2:
            if total_accepted >= PHASE_2_LIMIT and accuracy >= ACCURACY_THRESHOLD_PHASE3:
                self.phase = 3
            elif total_accepted >= PHASE_2_LIMIT * 2:
                self.phase = 3
                self._force_advanced = True

        if self.phase != old_phase:
            logger.info(
                f"Curriculum advanced: phase {old_phase} -> {self.phase} "
                f"(samples={total_accepted}, accuracy={accuracy:.3f})"
            )

    def get_status(self) -> dict:
        return {
            "phase": self.phase,
            "phase_description": {
                1: "High-confidence only (>70 conf, clear outcomes)",
                2: "Medium-confidence included (>50 conf)",
                3: "Full learning (all samples)",
            }[self.phase],
            "total_processed": self.total_processed,
            "phase_samples": dict(self.phase_samples),
            "phase_accepted": dict(self.phase_accepted),
            "validation_accuracy": round(self.validation_accuracy, 4),
            "force_advanced": self._force_advanced,
        }


# ---------------------------------------------------------------------------
# Online Learner (Main Service)
# ---------------------------------------------------------------------------

class OnlineLearner:
    """Combines online learning, experience replay, and curriculum learning.

    Uses scikit-learn's SGDClassifier with partial_fit() for incremental
    updates, a prioritised replay buffer for high-error re-learning, and
    a three-phase curriculum for difficulty-based sample admission.

    Thread-safe: all public methods acquire the internal lock.
    """

    def __init__(self):
        self._lock = threading.Lock()

        # Online model
        self._model = SGDClassifier(
            loss="log_loss",
            learning_rate="constant",
            eta0=INITIAL_LEARNING_RATE,
            penalty="l2",
            alpha=1e-4,
            warm_start=True,
            random_state=42,
        )
        self._scaler = StandardScaler()
        self._model_fitted = False
        self._scaler_fitted = False

        # Running statistics for feature normalisation (exponential weighted)
        self._running_mean: Optional[np.ndarray] = None
        self._running_var: Optional[np.ndarray] = None
        self._ema_alpha = 0.01  # EMA smoothing factor for running stats

        # Experience replay
        self._replay_buffer = PrioritisedReplayBuffer(BUFFER_CAPACITY)

        # Curriculum
        self._curriculum = CurriculumManager()

        # Learning rate schedule
        self._update_count: int = 0
        self._current_lr: float = INITIAL_LEARNING_RATE

        # Tracking
        self._total_updates: int = 0
        self._total_replays: int = 0
        self._correct_predictions: int = 0
        self._total_predictions: int = 0
        self._recent_losses: List[float] = []  # last 100 log-loss values
        self._outcome_counts: Dict[str, int] = {"BUY": 0, "SELL": 0, "HOLD": 0}
        self._created_at: float = time.time()

        # Validation buffer (small held-out set for curriculum progression)
        self._val_features: List[np.ndarray] = []
        self._val_outcomes: List[int] = []
        self._max_val_size: int = 200

        logger.info("OnlineLearner initialised")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _encode_outcome(self, outcome: str) -> int:
        """Map outcome string to integer class label."""
        outcome_upper = outcome.upper().strip()
        if outcome_upper in ACTION_MAP:
            return ACTION_MAP[outcome_upper]
        # Map win/loss/draw to BUY/SELL/HOLD
        if outcome_upper in ("WIN", "PROFIT", "SUCCESS"):
            return ACTION_MAP["BUY"]
        if outcome_upper in ("LOSS", "FAIL", "STOP_LOSS"):
            return ACTION_MAP["SELL"]
        return ACTION_MAP["HOLD"]

    def _update_running_stats(self, features: np.ndarray):
        """Update exponentially weighted running mean and variance."""
        if self._running_mean is None:
            self._running_mean = features.copy().astype(np.float64)
            self._running_var = np.zeros_like(features, dtype=np.float64)
        else:
            alpha = self._ema_alpha
            diff = features - self._running_mean
            self._running_mean += alpha * diff
            self._running_var = (1 - alpha) * (self._running_var + alpha * diff * diff)

    def _normalise_features(self, features: np.ndarray) -> np.ndarray:
        """Normalise features using running statistics."""
        if self._running_mean is None:
            return features.copy()
        std = np.sqrt(self._running_var + 1e-8)
        return (features - self._running_mean) / std

    def _decay_learning_rate(self):
        """Apply exponential decay to the learning rate."""
        self._current_lr = max(
            MIN_LEARNING_RATE,
            INITIAL_LEARNING_RATE * (LR_DECAY ** self._update_count)
        )
        self._model.eta0 = self._current_lr
        # SGDClassifier reads eta0 at each partial_fit when learning_rate="constant"

    def _compute_priority(self, features: np.ndarray, outcome: int) -> float:
        """Compute priority = |predicted_confidence - actual_outcome|.

        Higher prediction error -> higher priority for replay.
        """
        if not self._model_fitted:
            return 1.0  # Default high priority before model is ready

        try:
            normed = self._normalise_features(features).reshape(1, -1)
            proba = self._model.predict_proba(normed)[0]
            # Actual outcome as one-hot
            actual = np.zeros(len(proba))
            if outcome < len(actual):
                actual[outcome] = 1.0
            # Priority = L1 distance between predicted proba and actual
            priority = float(np.abs(proba - actual).sum())
            return max(priority, PRIORITY_EPSILON)
        except Exception:
            return 1.0

    def _fit_or_partial_fit(self, X: np.ndarray, y: np.ndarray,
                            sample_weight: Optional[np.ndarray] = None):
        """Perform a partial_fit (or first fit) on the model."""
        try:
            if not self._model_fitted:
                self._model.partial_fit(X, y, classes=ALL_CLASSES,
                                        sample_weight=sample_weight)
                self._model_fitted = True
            else:
                self._model.partial_fit(X, y, sample_weight=sample_weight)
            self._update_count += 1
            self._total_updates += 1
            self._decay_learning_rate()
        except Exception as e:
            logger.error(f"Model update failed: {e}")

    def _compute_validation_accuracy(self) -> float:
        """Compute accuracy on the held-out validation set."""
        if len(self._val_features) < 10 or not self._model_fitted:
            return 0.0
        try:
            X = np.array(self._val_features)
            y = np.array(self._val_outcomes)
            X_normed = np.array([self._normalise_features(x) for x in X])
            preds = self._model.predict(X_normed)
            accuracy = float(np.mean(preds == y))
            return accuracy
        except Exception:
            return 0.0

    def _add_to_validation(self, features: np.ndarray, outcome: int):
        """Optionally add to the validation set (with probability VALIDATION_FRACTION)."""
        if np.random.random() < VALIDATION_FRACTION:
            if len(self._val_features) >= self._max_val_size:
                # Replace a random entry
                idx = np.random.randint(0, self._max_val_size)
                self._val_features[idx] = features.copy()
                self._val_outcomes[idx] = outcome
            else:
                self._val_features.append(features.copy())
                self._val_outcomes.append(outcome)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, features: np.ndarray, outcome: str, metadata: Optional[dict] = None
               ) -> dict:
        """Incremental update with a new trade outcome.

        Args:
            features: Feature vector (numpy array).
            outcome: Trade outcome string ("BUY", "SELL", "HOLD", "WIN", "LOSS", etc.).
            metadata: Optional dict with extra context (confidence, pnl_pct, holding_time).

        Returns:
            Dict with update result: accepted, phase, priority, lr.
        """
        with self._lock:
            if metadata is None:
                metadata = {}

            outcome_int = self._encode_outcome(outcome)
            outcome_name = ACTION_NAMES.get(outcome_int, "HOLD")
            self._outcome_counts[outcome_name] = self._outcome_counts.get(outcome_name, 0) + 1

            confidence = float(metadata.get("confidence", 50))
            pnl_pct = float(metadata.get("pnl_pct", 0.0))
            holding_time = float(metadata.get("holding_time", 30.0))

            # Curriculum filter
            accepted = self._curriculum.should_accept(confidence, pnl_pct, holding_time)

            if not accepted:
                return {
                    "accepted": False,
                    "reason": f"Curriculum phase {self._curriculum.phase} filter",
                    "phase": self._curriculum.phase,
                    "total_updates": self._total_updates,
                }

            # Ensure feature vector is valid
            features = np.asarray(features, dtype=np.float64).flatten()
            if features.size == 0:
                return {"accepted": False, "reason": "Empty feature vector"}

            # Update running statistics
            self._update_running_stats(features)

            # Normalise
            normed = self._normalise_features(features).reshape(1, -1)

            # Compute priority before updating the model
            priority = self._compute_priority(features, outcome_int)

            # Add to replay buffer
            self._replay_buffer.add(features, outcome_int, metadata, priority)

            # Add to validation set
            self._add_to_validation(features, outcome_int)

            # Incremental model update
            y = np.array([outcome_int])
            self._fit_or_partial_fit(normed, y)

            # Check curriculum progression periodically
            total_accepted = sum(self._curriculum.phase_accepted.values())
            if total_accepted % 50 == 0 and total_accepted > 0:
                val_acc = self._compute_validation_accuracy()
                self._curriculum.check_progression(val_acc, total_accepted)

            return {
                "accepted": True,
                "phase": self._curriculum.phase,
                "priority": round(priority, 4),
                "learning_rate": self._current_lr,
                "total_updates": self._total_updates,
                "buffer_size": self._replay_buffer.size,
                "difficulty_score": self._curriculum.difficulty_score(
                    pnl_pct, confidence, holding_time
                ),
            }

    def replay_batch(self, batch_size: int = DEFAULT_BATCH_SIZE) -> dict:
        """Sample a prioritised mini-batch from the replay buffer and train.

        Args:
            batch_size: Number of experiences to sample and train on.

        Returns:
            Dict with replay results: samples_trained, avg_priority, avg_is_weight.
        """
        with self._lock:
            if self._replay_buffer.size < batch_size:
                return {
                    "samples_trained": 0,
                    "reason": f"Buffer too small ({self._replay_buffer.size}/{batch_size})",
                }

            experiences, indices, is_weights = self._replay_buffer.sample(batch_size)

            if len(experiences) == 0:
                return {"samples_trained": 0, "reason": "Empty sample"}

            # Build training batch
            feature_list = []
            outcome_list = []
            for exp in experiences:
                feat = self._normalise_features(exp["features"])
                feature_list.append(feat)
                outcome_list.append(exp["outcome"])

            X = np.array(feature_list)
            y = np.array(outcome_list)

            # Train with importance-sampling weights
            self._fit_or_partial_fit(X, y, sample_weight=is_weights)
            self._total_replays += 1

            # Update priorities based on new prediction errors
            new_priorities = np.zeros(len(indices))
            try:
                proba = self._model.predict_proba(X)
                for i, (exp, prob_row) in enumerate(zip(experiences, proba)):
                    actual = np.zeros(len(prob_row))
                    out = exp["outcome"]
                    if out < len(actual):
                        actual[out] = 1.0
                    new_priorities[i] = float(np.abs(prob_row - actual).sum())
            except Exception:
                new_priorities[:] = 1.0

            self._replay_buffer.update_priorities(indices, new_priorities)

            return {
                "samples_trained": len(experiences),
                "avg_priority": round(float(new_priorities.mean()), 4),
                "avg_is_weight": round(float(is_weights.mean()), 4),
                "learning_rate": self._current_lr,
                "total_replays": self._total_replays,
            }

    def predict(self, features: np.ndarray) -> dict:
        """Predict action and confidence from the online model.

        Args:
            features: Feature vector (numpy array).

        Returns:
            Dict with action, confidence, probabilities.
        """
        with self._lock:
            if not self._model_fitted:
                return {
                    "action": "HOLD",
                    "confidence": 0,
                    "probabilities": {"BUY": 0.33, "SELL": 0.33, "HOLD": 0.34},
                    "model_ready": False,
                }

            features = np.asarray(features, dtype=np.float64).flatten()
            normed = self._normalise_features(features).reshape(1, -1)

            try:
                proba = self._model.predict_proba(normed)[0]
                pred_class = int(np.argmax(proba))
                action = ACTION_NAMES.get(pred_class, "HOLD")
                confidence = round(float(proba[pred_class]) * 100, 1)

                # Build probability dict
                prob_dict = {}
                classes = self._model.classes_
                for i, cls in enumerate(classes):
                    name = ACTION_NAMES.get(int(cls), "HOLD")
                    prob_dict[name] = round(float(proba[i]), 4)

                # Track prediction accuracy (if we later get the outcome)
                self._total_predictions += 1

                return {
                    "action": action,
                    "confidence": confidence,
                    "probabilities": prob_dict,
                    "model_ready": True,
                    "updates_seen": self._total_updates,
                }
            except Exception as e:
                logger.error(f"Prediction failed: {e}")
                return {
                    "action": "HOLD",
                    "confidence": 0,
                    "probabilities": {"BUY": 0.33, "SELL": 0.33, "HOLD": 0.34},
                    "model_ready": False,
                    "error": str(e),
                }

    def get_confidence_adjustment(self, features: np.ndarray,
                                  proposed_action: str) -> int:
        """Get a confidence adjustment (-10 to +10) for a proposed action.

        Positive = model agrees with the proposed action.
        Negative = model disagrees.

        Args:
            features: Feature vector.
            proposed_action: Proposed action string ("BUY", "SELL", "HOLD").

        Returns:
            Integer adjustment in range [-10, +10].
        """
        with self._lock:
            if not self._model_fitted or self._total_updates < 30:
                return 0  # Not enough data to adjust

            features = np.asarray(features, dtype=np.float64).flatten()
            normed = self._normalise_features(features).reshape(1, -1)

            try:
                proba = self._model.predict_proba(normed)[0]
                proposed_int = ACTION_MAP.get(proposed_action.upper(), 2)

                # Find probability of the proposed action
                classes = list(self._model.classes_)
                if proposed_int in classes:
                    idx = classes.index(proposed_int)
                    proposed_prob = float(proba[idx])
                else:
                    proposed_prob = 0.0

                # Find probability of the best action
                best_prob = float(proba.max())
                best_class = int(self._model.classes_[np.argmax(proba)])

                if best_class == proposed_int:
                    # Model agrees: boost proportional to confidence
                    adjustment = int(round((proposed_prob - 0.33) * 30))
                else:
                    # Model disagrees: penalty proportional to disagreement
                    disagreement = best_prob - proposed_prob
                    adjustment = -int(round(disagreement * 15))

                return max(-10, min(10, adjustment))

            except Exception as e:
                logger.error(f"Confidence adjustment failed: {e}")
                return 0

    def get_curriculum_phase(self) -> dict:
        """Get current curriculum learning status.

        Returns:
            Dict with phase, samples processed, accuracy, difficulty info.
        """
        with self._lock:
            status = self._curriculum.get_status()
            status["validation_accuracy"] = round(
                self._compute_validation_accuracy(), 4
            )
            status["validation_set_size"] = len(self._val_features)
            return status

    def get_replay_stats(self) -> dict:
        """Get experience replay buffer statistics.

        Returns:
            Dict with buffer size, avg priority, replay count.
        """
        with self._lock:
            stats = self._replay_buffer.get_stats()
            stats["total_replay_cycles"] = self._total_replays
            return stats

    def get_status(self) -> dict:
        """Get comprehensive status of the online learning system.

        Returns:
            Dict with model status, training stats, curriculum, replay, and config.
        """
        with self._lock:
            uptime = time.time() - self._created_at
            val_acc = self._compute_validation_accuracy()

            return {
                "model_fitted": self._model_fitted,
                "total_updates": self._total_updates,
                "total_replays": self._total_replays,
                "total_predictions": self._total_predictions,
                "current_learning_rate": round(self._current_lr, 6),
                "update_count": self._update_count,
                "outcome_counts": dict(self._outcome_counts),
                "validation_accuracy": round(val_acc, 4),
                "validation_set_size": len(self._val_features),
                "curriculum": self._curriculum.get_status(),
                "replay_buffer": self._replay_buffer.get_stats(),
                "running_stats_initialised": self._running_mean is not None,
                "uptime_seconds": round(uptime, 1),
                "config": {
                    "buffer_capacity": BUFFER_CAPACITY,
                    "default_batch_size": DEFAULT_BATCH_SIZE,
                    "initial_learning_rate": INITIAL_LEARNING_RATE,
                    "lr_decay": LR_DECAY,
                    "min_learning_rate": MIN_LEARNING_RATE,
                    "priority_alpha": PRIORITY_ALPHA,
                    "curriculum_phases": {
                        1: f"High-confidence only (>{PHASE_1_CONFIDENCE_MIN})",
                        2: f"Medium-confidence (>{PHASE_2_CONFIDENCE_MIN})",
                        3: "Full learning",
                    },
                },
            }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[OnlineLearner] = None
_instance_lock = threading.Lock()


def get_online_learner() -> OnlineLearner:
    """Get or create the singleton OnlineLearner instance."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = OnlineLearner()
                logger.info("OnlineLearner singleton created")
    return _instance
