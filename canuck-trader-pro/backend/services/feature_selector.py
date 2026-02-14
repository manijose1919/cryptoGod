"""
Feature Importance & Dynamic Selection Service

Tracks which features matter most and dynamically selects the best subset.

Capabilities:
1. Permutation importance - shuffle each column, measure accuracy drop
2. Simplified SHAP-like values - marginal contribution estimation
3. Rolling feature importance with drift detection
4. Dynamic feature selection (top 80% by importance, prune bottom 10%)
5. Correlation pruning (>0.95 Pearson)
6. Feature health monitoring (NaN rates, distribution shifts)

Thread-safe singleton accessed via get_feature_selector().
"""

import logging
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sklearn.metrics import accuracy_score

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from feature_engineer import FEATURE_NAMES, FEATURE_COUNT

logger = logging.getLogger("feature_selector")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ROLLING_WINDOW = 1000           # Samples for rolling importance
PERMUTATION_INTERVAL = 500      # Recompute permutation importance every N predictions
N_PERMUTATION_REPEATS = 5       # Repeats per feature for stability
ACTIVE_FEATURE_PERCENTILE = 80  # Top 80% by importance stay active
DROP_PERCENTILE = 10            # Bottom 10% get dropped
RECHECK_INTERVAL = 200          # Re-include dropped features every N predictions
CORRELATION_THRESHOLD = 0.95    # Prune features correlated above this
NAN_ALERT_THRESHOLD = 0.05      # Alert when >5% NaN rate
DRIFT_Z_THRESHOLD = 2.5         # Z-score threshold for importance drift
MIN_SAMPLES_FOR_IMPORTANCE = 50 # Minimum samples before computing importance
SHAP_BACKGROUND_SIZE = 100      # Background samples for SHAP approximation


class FeatureSelector:
    """Tracks feature importance and dynamically selects the best subset."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._num_features = FEATURE_COUNT
        self._feature_names = list(FEATURE_NAMES)

        # --- Permutation importance ---
        self._permutation_importance: np.ndarray = np.ones(self._num_features, dtype=np.float64)
        self._last_permutation_at: int = 0  # prediction count when last computed

        # --- SHAP-like values ---
        self._shap_accumulator: np.ndarray = np.zeros(self._num_features, dtype=np.float64)
        self._shap_count: int = 0
        self._background_samples: deque = deque(maxlen=SHAP_BACKGROUND_SIZE)

        # --- Rolling importance tracking ---
        self._rolling_importances: deque = deque(maxlen=ROLLING_WINDOW)
        self._previous_top_features: List[str] = []
        self._drift_alerts: List[Dict[str, Any]] = []

        # --- Dynamic feature selection ---
        self._active_mask: np.ndarray = np.ones(self._num_features, dtype=bool)
        self._dropped_features: set = set()  # indices of currently dropped features
        self._drop_streak: np.ndarray = np.zeros(self._num_features, dtype=np.int32)
        self._last_recheck_at: int = 0

        # --- Feature health ---
        self._nan_counts: np.ndarray = np.zeros(self._num_features, dtype=np.int64)
        self._inf_counts: np.ndarray = np.zeros(self._num_features, dtype=np.int64)
        self._total_observations: int = 0
        self._running_mean: np.ndarray = np.zeros(self._num_features, dtype=np.float64)
        self._running_m2: np.ndarray = np.zeros(self._num_features, dtype=np.float64)
        self._baseline_mean: Optional[np.ndarray] = None
        self._baseline_std: Optional[np.ndarray] = None
        self._baseline_set_at: int = 0

        # --- Prediction history for permutation importance ---
        self._X_buffer: deque = deque(maxlen=ROLLING_WINDOW)
        self._y_buffer: deque = deque(maxlen=ROLLING_WINDOW)

        # --- Correlation tracking ---
        self._correlation_pruned: set = set()  # indices pruned due to correlation

        # --- Counters ---
        self._prediction_count: int = 0

        logger.info(
            "FeatureSelector initialised: %d features, rolling window=%d",
            self._num_features, ROLLING_WINDOW,
        )

    # -----------------------------------------------------------------------
    # Permutation importance
    # -----------------------------------------------------------------------

    def compute_importance(
        self,
        model: Any,
        X: np.ndarray,
        y: np.ndarray,
    ) -> Dict[str, float]:
        """Compute permutation importance for each feature.

        Shuffles each feature column independently, measures accuracy drop.
        Higher drop = more important feature.

        Args:
            model: Fitted sklearn-compatible model with .predict() method.
            X: Feature matrix, shape (n_samples, n_features).
            y: True labels, shape (n_samples,).

        Returns:
            Dict mapping feature name to importance score (accuracy drop).
        """
        with self._lock:
            n_samples, n_features = X.shape
            if n_samples < MIN_SAMPLES_FOR_IMPORTANCE:
                logger.warning(
                    "Only %d samples, need %d for permutation importance",
                    n_samples, MIN_SAMPLES_FOR_IMPORTANCE,
                )
                return {name: 0.0 for name in self._feature_names}

            n_feat = min(n_features, self._num_features)

            # Baseline accuracy
            baseline_pred = model.predict(X)
            baseline_acc = accuracy_score(y, baseline_pred)

            importances = np.zeros(n_feat, dtype=np.float64)

            for col in range(n_feat):
                drops = []
                for _ in range(N_PERMUTATION_REPEATS):
                    X_permuted = X.copy()
                    rng = np.random.default_rng()
                    X_permuted[:, col] = rng.permutation(X_permuted[:, col])
                    perm_pred = model.predict(X_permuted)
                    perm_acc = accuracy_score(y, perm_pred)
                    drops.append(baseline_acc - perm_acc)
                importances[col] = float(np.mean(drops))

            # Pad if fewer columns than expected
            full_importances = np.zeros(self._num_features, dtype=np.float64)
            full_importances[:n_feat] = importances

            self._permutation_importance = full_importances
            self._last_permutation_at = self._prediction_count

            # Update rolling importance tracking
            self._rolling_importances.append(full_importances.copy())

            # Check for drift in top features
            self._check_importance_drift()

            # Update active feature mask based on new importances
            self._update_active_features()

            result = {}
            for i, name in enumerate(self._feature_names):
                result[name] = float(full_importances[i])

            logger.info(
                "Permutation importance computed: baseline_acc=%.4f, top feature=%s (%.6f)",
                baseline_acc,
                self._feature_names[int(np.argmax(full_importances))],
                float(np.max(full_importances)),
            )
            return result

    # -----------------------------------------------------------------------
    # SHAP-like values (simplified TreeSHAP approximation)
    # -----------------------------------------------------------------------

    def get_shap_values(self, features: np.ndarray, model: Any = None) -> Dict[str, float]:
        """Estimate per-feature contribution using marginal contribution method.

        For each feature, compare model prediction with the feature present vs
        replaced by its background distribution mean. This is a fast approximation
        of SHAP marginal contribution.

        Args:
            features: 1D feature vector, shape (n_features,).
            model: Fitted sklearn-compatible model with .predict_proba() or .predict().

        Returns:
            Dict mapping feature name to its estimated contribution.
        """
        with self._lock:
            n = min(len(features), self._num_features)
            shap_values = np.zeros(self._num_features, dtype=np.float64)

            if model is None or len(self._background_samples) < 10:
                # Return accumulated average SHAP values if no model provided
                if self._shap_count > 0:
                    avg_shap = self._shap_accumulator / self._shap_count
                    return {
                        self._feature_names[i]: float(avg_shap[i])
                        for i in range(self._num_features)
                    }
                return {name: 0.0 for name in self._feature_names}

            # Get base prediction
            padded = np.zeros(self._num_features, dtype=np.float64)
            padded[:n] = features[:n]
            x_input = padded.reshape(1, -1)

            base_pred = self._get_prediction_value(model, x_input)

            # Background mean from stored samples
            bg_array = np.array(list(self._background_samples), dtype=np.float64)
            bg_mean = np.mean(bg_array, axis=0)

            # For each feature, replace with background mean and measure change
            for col in range(n):
                x_modified = padded.copy()
                x_modified[col] = bg_mean[col]
                mod_pred = self._get_prediction_value(model, x_modified.reshape(1, -1))
                shap_values[col] = base_pred - mod_pred

            # Accumulate absolute SHAP values for tracking
            self._shap_accumulator += np.abs(shap_values)
            self._shap_count += 1

            return {
                self._feature_names[i]: float(shap_values[i])
                for i in range(self._num_features)
            }

    def _get_prediction_value(self, model: Any, X: np.ndarray) -> float:
        """Extract a scalar prediction value from model.

        Uses predict_proba (class 0 probability) if available, else predict.
        """
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(X)
            # Return probability of positive class (index 0 = BUY typically)
            return float(proba[0, 0]) if proba.shape[1] > 1 else float(proba[0, 0])
        return float(model.predict(X)[0])

    # -----------------------------------------------------------------------
    # Rolling feature importance & drift detection
    # -----------------------------------------------------------------------

    def _check_importance_drift(self) -> None:
        """Detect significant changes in feature importance rankings.

        Called internally after each permutation importance computation.
        Compares current top features against historical average. Alerts
        when top features shift or when individual importance z-scores
        exceed threshold.
        """
        if len(self._rolling_importances) < 3:
            return

        recent = np.array(list(self._rolling_importances), dtype=np.float64)
        mean_imp = np.mean(recent, axis=0)
        std_imp = np.std(recent, axis=0)

        # Current importance
        current = self._permutation_importance

        # Check for individual feature drift
        new_alerts = []
        for i in range(self._num_features):
            if std_imp[i] > 1e-10:
                z = abs(current[i] - mean_imp[i]) / std_imp[i]
                if z > DRIFT_Z_THRESHOLD:
                    new_alerts.append({
                        "feature": self._feature_names[i],
                        "z_score": float(z),
                        "current_importance": float(current[i]),
                        "mean_importance": float(mean_imp[i]),
                        "timestamp": time.time(),
                    })

        # Check if top 10 features changed
        current_top = list(np.argsort(current)[::-1][:10])
        current_top_names = [self._feature_names[i] for i in current_top]

        if self._previous_top_features:
            prev_set = set(self._previous_top_features)
            curr_set = set(current_top_names)
            changed = curr_set - prev_set
            if changed:
                new_alerts.append({
                    "type": "top_features_changed",
                    "new_entries": list(changed),
                    "dropped": list(prev_set - curr_set),
                    "timestamp": time.time(),
                })
                logger.warning(
                    "Top features changed: +%s, -%s",
                    list(changed), list(prev_set - curr_set),
                )

        self._previous_top_features = current_top_names

        if new_alerts:
            # Keep only recent alerts (last 50)
            self._drift_alerts.extend(new_alerts)
            if len(self._drift_alerts) > 50:
                self._drift_alerts = self._drift_alerts[-50:]

    # -----------------------------------------------------------------------
    # Dynamic feature selection
    # -----------------------------------------------------------------------

    def _update_active_features(self) -> None:
        """Update the active feature mask based on current importance scores.

        - Top 80% by importance stay active.
        - Bottom 10% that consistently rank low get dropped.
        - Dropped features re-checked periodically.
        """
        imp = self._permutation_importance.copy()

        # Handle case where all importances are zero
        if np.all(imp <= 0):
            self._active_mask[:] = True
            return

        # Sort by importance descending
        sorted_idx = np.argsort(imp)[::-1]

        # Cumulative importance threshold
        total_imp = np.sum(np.maximum(imp, 0))
        if total_imp <= 0:
            self._active_mask[:] = True
            return

        cumsum = 0.0
        active_threshold = total_imp * (ACTIVE_FEATURE_PERCENTILE / 100.0)
        drop_threshold = total_imp * (DROP_PERCENTILE / 100.0)

        new_mask = np.zeros(self._num_features, dtype=bool)

        for idx in sorted_idx:
            cumsum += max(imp[idx], 0)
            if cumsum <= active_threshold:
                new_mask[idx] = True
            else:
                # Still include features above the drop threshold individually
                if imp[idx] > 0:
                    new_mask[idx] = True

        # Bottom 10% tracking for drop streaks
        bottom_cutoff = np.percentile(imp, DROP_PERCENTILE)
        for i in range(self._num_features):
            if imp[i] <= bottom_cutoff:
                self._drop_streak[i] += 1
            else:
                self._drop_streak[i] = 0

        # Drop features with 3+ consecutive bottom rankings
        for i in range(self._num_features):
            if self._drop_streak[i] >= 3:
                new_mask[i] = False
                self._dropped_features.add(i)

        # Periodic recheck: re-include dropped features
        if (self._prediction_count - self._last_recheck_at) >= RECHECK_INTERVAL:
            self._last_recheck_at = self._prediction_count
            if self._dropped_features:
                logger.info(
                    "Rechecking %d dropped features", len(self._dropped_features),
                )
                for idx in list(self._dropped_features):
                    new_mask[idx] = True
                self._dropped_features.clear()
                self._drop_streak[:] = 0

        # Remove correlation-pruned features
        for idx in self._correlation_pruned:
            new_mask[idx] = False

        # Ensure at least 20 features are active
        if np.sum(new_mask) < 20:
            top_20 = sorted_idx[:20]
            for idx in top_20:
                new_mask[idx] = True

        self._active_mask = new_mask
        logger.info(
            "Active features updated: %d / %d active (%d dropped, %d corr-pruned)",
            int(np.sum(new_mask)),
            self._num_features,
            len(self._dropped_features),
            len(self._correlation_pruned),
        )

    # -----------------------------------------------------------------------
    # Feature correlation pruning
    # -----------------------------------------------------------------------

    def prune_correlated_features(self, X: np.ndarray) -> set:
        """Remove highly correlated features (>0.95 Pearson).

        Keeps the feature with higher permutation importance from each
        correlated pair.

        Args:
            X: Feature matrix, shape (n_samples, n_features).

        Returns:
            Set of pruned feature indices.
        """
        with self._lock:
            n_samples, n_features = X.shape
            n_feat = min(n_features, self._num_features)

            if n_samples < 30:
                logger.warning("Too few samples (%d) for correlation pruning", n_samples)
                return set()

            # Compute correlation matrix
            # Handle NaN/inf by replacing with 0
            X_clean = np.nan_to_num(X[:, :n_feat], nan=0.0, posinf=0.0, neginf=0.0)

            # Standardize to avoid numerical issues
            std = np.std(X_clean, axis=0)
            zero_std = std < 1e-10
            std[zero_std] = 1.0  # avoid division by zero

            X_norm = (X_clean - np.mean(X_clean, axis=0)) / std

            # Pearson correlation
            corr = np.corrcoef(X_norm.T)
            corr = np.nan_to_num(corr, nan=0.0)

            pruned = set()
            imp = self._permutation_importance[:n_feat]

            for i in range(n_feat):
                if i in pruned:
                    continue
                for j in range(i + 1, n_feat):
                    if j in pruned:
                        continue
                    if abs(corr[i, j]) > CORRELATION_THRESHOLD:
                        # Drop the less important one
                        if imp[i] >= imp[j]:
                            pruned.add(j)
                            logger.debug(
                                "Pruned %s (corr=%.3f with %s, lower importance)",
                                self._feature_names[j], corr[i, j],
                                self._feature_names[i],
                            )
                        else:
                            pruned.add(i)
                            logger.debug(
                                "Pruned %s (corr=%.3f with %s, lower importance)",
                                self._feature_names[i], corr[i, j],
                                self._feature_names[j],
                            )
                            break  # i is pruned, move on

            self._correlation_pruned = pruned

            # Update active mask
            for idx in pruned:
                self._active_mask[idx] = False

            logger.info(
                "Correlation pruning complete: %d features pruned (threshold=%.2f)",
                len(pruned), CORRELATION_THRESHOLD,
            )
            return pruned

    # -----------------------------------------------------------------------
    # Feature health monitoring
    # -----------------------------------------------------------------------

    def _update_health(self, features: np.ndarray) -> None:
        """Update running health statistics for a single feature vector.

        Tracks NaN/inf rates and running mean/variance using Welford's
        online algorithm for numerically stable incremental stats.
        """
        n = min(len(features), self._num_features)
        self._total_observations += 1

        for i in range(n):
            val = features[i]

            if np.isnan(val):
                self._nan_counts[i] += 1
                continue
            if np.isinf(val):
                self._inf_counts[i] += 1
                continue

            # Welford's online algorithm for running mean and variance
            count = self._total_observations
            delta = val - self._running_mean[i]
            self._running_mean[i] += delta / count
            delta2 = val - self._running_mean[i]
            self._running_m2[i] += delta * delta2

        # Set baseline after first 200 observations
        if self._total_observations == 200 and self._baseline_mean is None:
            self._baseline_mean = self._running_mean.copy()
            variance = self._running_m2 / max(self._total_observations - 1, 1)
            self._baseline_std = np.sqrt(np.maximum(variance, 0))
            self._baseline_set_at = self._total_observations
            logger.info("Feature health baseline set at %d observations", self._total_observations)

    def get_feature_health(self) -> Dict[str, Any]:
        """Get comprehensive feature health report.

        Returns:
            Dict with per-feature NaN rates, inf rates, distribution drift
            alerts, and overall health summary.
        """
        with self._lock:
            total = max(self._total_observations, 1)

            nan_rates = self._nan_counts / total
            inf_rates = self._inf_counts / total

            # Distribution drift detection
            drift_alerts = []
            if self._baseline_mean is not None and self._total_observations > 400:
                current_mean = self._running_mean.copy()
                current_var = self._running_m2 / max(self._total_observations - 1, 1)
                current_std = np.sqrt(np.maximum(current_var, 0))

                for i in range(self._num_features):
                    # Mean shift detection
                    if self._baseline_std[i] > 1e-10:
                        z_mean = abs(current_mean[i] - self._baseline_mean[i]) / self._baseline_std[i]
                        if z_mean > 3.0:
                            drift_alerts.append({
                                "feature": self._feature_names[i],
                                "type": "mean_shift",
                                "z_score": float(z_mean),
                                "baseline_mean": float(self._baseline_mean[i]),
                                "current_mean": float(current_mean[i]),
                            })

                    # Variance shift detection (F-test approximation)
                    if self._baseline_std[i] > 1e-10:
                        var_ratio = current_std[i] / self._baseline_std[i]
                        if var_ratio > 2.0 or var_ratio < 0.5:
                            drift_alerts.append({
                                "feature": self._feature_names[i],
                                "type": "variance_shift",
                                "variance_ratio": float(var_ratio),
                                "baseline_std": float(self._baseline_std[i]),
                                "current_std": float(current_std[i]),
                            })

            # NaN alerts
            nan_alert_features = []
            for i in range(self._num_features):
                rate = float(nan_rates[i])
                if rate > NAN_ALERT_THRESHOLD:
                    nan_alert_features.append({
                        "feature": self._feature_names[i],
                        "nan_rate": rate,
                        "nan_count": int(self._nan_counts[i]),
                    })

            # Per-feature details
            per_feature = {}
            for i in range(self._num_features):
                name = self._feature_names[i]
                variance = (
                    self._running_m2[i] / max(self._total_observations - 1, 1)
                    if self._total_observations > 1 else 0.0
                )
                per_feature[name] = {
                    "nan_rate": float(nan_rates[i]),
                    "inf_rate": float(inf_rates[i]),
                    "mean": float(self._running_mean[i]),
                    "std": float(np.sqrt(max(variance, 0))),
                    "is_active": bool(self._active_mask[i]),
                }

            return {
                "total_observations": self._total_observations,
                "nan_alert_features": nan_alert_features,
                "drift_alerts": drift_alerts,
                "features": per_feature,
                "healthy_feature_count": int(
                    np.sum((nan_rates < NAN_ALERT_THRESHOLD) & (inf_rates < NAN_ALERT_THRESHOLD))
                ),
                "total_features": self._num_features,
            }

    # -----------------------------------------------------------------------
    # Record prediction (main entry point for tracking)
    # -----------------------------------------------------------------------

    def record_prediction(
        self,
        features: np.ndarray,
        prediction: Any,
        outcome: Any,
        model: Any = None,
    ) -> None:
        """Record a prediction for tracking and periodic recomputation.

        Should be called after each prediction with the eventual outcome.

        Args:
            features: 1D feature vector used for the prediction.
            prediction: Model's prediction (e.g., "BUY", "SELL", 0, 1).
            outcome: Actual outcome / label.
            model: Optional model reference for auto-recomputation.
        """
        with self._lock:
            n = min(len(features), self._num_features)
            padded = np.zeros(self._num_features, dtype=np.float64)
            padded[:n] = features[:n]

            # Update health stats
            self._update_health(padded)

            # Store in buffers
            self._X_buffer.append(padded.copy())
            self._y_buffer.append(outcome)
            self._background_samples.append(padded.copy())

            self._prediction_count += 1

            # Auto-trigger permutation importance recomputation
            if (
                model is not None
                and (self._prediction_count - self._last_permutation_at) >= PERMUTATION_INTERVAL
                and len(self._X_buffer) >= MIN_SAMPLES_FOR_IMPORTANCE
            ):
                logger.info(
                    "Auto-triggering permutation importance at prediction #%d",
                    self._prediction_count,
                )
                X = np.array(list(self._X_buffer), dtype=np.float64)
                y = np.array(list(self._y_buffer))
                # Release lock temporarily for the heavy computation
                self._lock.release()
                try:
                    self.compute_importance(model, X, y)
                finally:
                    self._lock.acquire()

    # -----------------------------------------------------------------------
    # Public accessors
    # -----------------------------------------------------------------------

    def get_top_features(self, n: int = 20) -> List[str]:
        """Return top N feature names ranked by permutation importance.

        Args:
            n: Number of features to return (default 20).

        Returns:
            List of feature names, most important first.
        """
        with self._lock:
            n = min(n, self._num_features)
            sorted_idx = np.argsort(self._permutation_importance)[::-1]
            return [self._feature_names[i] for i in sorted_idx[:n]]

    def get_feature_mask(self) -> np.ndarray:
        """Return boolean mask of currently active features.

        Returns:
            np.ndarray of shape (n_features,) with True for active features.
        """
        with self._lock:
            return self._active_mask.copy()

    def get_status(self) -> Dict[str, Any]:
        """Return comprehensive status of the feature selector.

        Returns:
            Dict with all key metrics, counts, and configuration.
        """
        with self._lock:
            # Top 10 features by importance
            sorted_idx = np.argsort(self._permutation_importance)[::-1]
            top_10 = [
                {
                    "name": self._feature_names[i],
                    "importance": float(self._permutation_importance[i]),
                    "active": bool(self._active_mask[i]),
                }
                for i in sorted_idx[:10]
            ]

            # Bottom 5 features
            bottom_5 = [
                {
                    "name": self._feature_names[i],
                    "importance": float(self._permutation_importance[i]),
                    "active": bool(self._active_mask[i]),
                    "drop_streak": int(self._drop_streak[i]),
                }
                for i in sorted_idx[-5:]
            ]

            # Average SHAP values
            avg_shap = {}
            if self._shap_count > 0:
                shap_avg = self._shap_accumulator / self._shap_count
                shap_sorted = np.argsort(shap_avg)[::-1]
                for i in shap_sorted[:10]:
                    avg_shap[self._feature_names[i]] = float(shap_avg[i])

            # Health summary
            total = max(self._total_observations, 1)
            nan_rates = self._nan_counts / total
            unhealthy_count = int(np.sum(nan_rates > NAN_ALERT_THRESHOLD))

            return {
                "total_features": self._num_features,
                "active_features": int(np.sum(self._active_mask)),
                "dropped_features": len(self._dropped_features),
                "correlation_pruned": len(self._correlation_pruned),
                "prediction_count": self._prediction_count,
                "samples_in_buffer": len(self._X_buffer),
                "last_permutation_at": self._last_permutation_at,
                "permutation_interval": PERMUTATION_INTERVAL,
                "next_permutation_in": max(
                    0, PERMUTATION_INTERVAL - (self._prediction_count - self._last_permutation_at)
                ),
                "top_10_features": top_10,
                "bottom_5_features": bottom_5,
                "avg_shap_top_10": avg_shap,
                "drift_alerts": self._drift_alerts[-5:],
                "unhealthy_features": unhealthy_count,
                "total_observations": self._total_observations,
                "shap_samples_accumulated": self._shap_count,
                "background_samples": len(self._background_samples),
            }

    # -----------------------------------------------------------------------
    # Utility helpers
    # -----------------------------------------------------------------------

    def get_importance_dict(self) -> Dict[str, float]:
        """Return current permutation importance as a name->score dict."""
        with self._lock:
            return {
                self._feature_names[i]: float(self._permutation_importance[i])
                for i in range(self._num_features)
            }

    def apply_mask(self, X: np.ndarray) -> np.ndarray:
        """Zero out inactive features in a feature matrix or vector.

        This preserves array shape (important for model compatibility)
        while effectively disabling dropped features.

        Args:
            X: Feature matrix (n_samples, n_features) or vector (n_features,).

        Returns:
            Masked copy with inactive features set to 0.
        """
        with self._lock:
            X_masked = X.copy()
            mask = self._active_mask
            n = min(X.shape[-1], len(mask))
            if X_masked.ndim == 1:
                X_masked[:n][~mask[:n]] = 0.0
            else:
                X_masked[:, :n][:, ~mask[:n]] = 0.0
            return X_masked

    def reset(self) -> None:
        """Reset all state. Useful for testing or full retraining."""
        with self._lock:
            self._permutation_importance[:] = 1.0
            self._last_permutation_at = 0
            self._shap_accumulator[:] = 0.0
            self._shap_count = 0
            self._background_samples.clear()
            self._rolling_importances.clear()
            self._previous_top_features = []
            self._drift_alerts = []
            self._active_mask[:] = True
            self._dropped_features.clear()
            self._drop_streak[:] = 0
            self._last_recheck_at = 0
            self._nan_counts[:] = 0
            self._inf_counts[:] = 0
            self._total_observations = 0
            self._running_mean[:] = 0.0
            self._running_m2[:] = 0.0
            self._baseline_mean = None
            self._baseline_std = None
            self._baseline_set_at = 0
            self._X_buffer.clear()
            self._y_buffer.clear()
            self._correlation_pruned.clear()
            self._prediction_count = 0
            logger.info("FeatureSelector reset to initial state")


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[FeatureSelector] = None
_instance_lock = threading.Lock()


def get_feature_selector() -> FeatureSelector:
    """Get or create the singleton FeatureSelector instance.

    Thread-safe lazy initialization.

    Returns:
        The global FeatureSelector instance.
    """
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = FeatureSelector()
    return _instance
