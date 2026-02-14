"""
Purged Temporal Cross-Validation Service

Prevents look-ahead bias in backtesting by enforcing time-ordered
train/test splits with embargo periods between folds. Implements:

1. Purged K-Fold: standard time-series CV with embargo gap after each test fold
2. Combinatorial Purged CV (CPCV): tests all C(n_groups, n_test_groups)
   combinations for more robust evaluation
3. Model evaluation wrapper that computes per-fold metrics, overfitting score,
   and aggregated statistics

Embargo removes samples within embargo_pct * total_samples after each test
fold to prevent information leakage from overlapping labels.
"""

import logging
import threading
from itertools import combinations
from typing import (
    Any,
    Dict,
    Generator,
    List,
    Optional,
    Tuple,
)

import numpy as np
from sklearn.metrics import accuracy_score, log_loss
from sklearn.base import BaseEstimator, clone

logger = logging.getLogger(__name__)

_instance: Optional["TemporalCV"] = None
_instance_lock = threading.Lock()


def get_temporal_cv() -> "TemporalCV":
    """Singleton accessor for the TemporalCV service."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = TemporalCV()
                logger.info("TemporalCV service initialized")
    return _instance


class TemporalCV:
    """Thread-safe purged temporal cross-validation engine."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Purged K-Fold
    # ------------------------------------------------------------------

    def purged_kfold(
        self,
        X: np.ndarray,
        y: np.ndarray,
        timestamps: np.ndarray,
        n_splits: int = 5,
        embargo_pct: float = 0.01,
    ) -> Generator[Tuple[np.ndarray, np.ndarray], None, None]:
        """
        Time-ordered K-Fold with purged embargo gap.

        Sorts samples by timestamp, splits into n_splits sequential folds,
        and for each fold removes an embargo window of size
        embargo_pct * n_samples immediately after the test set to prevent
        leakage from overlapping feature/label windows.

        Yields:
            (train_indices, test_indices) for each fold.
        """
        n_samples = len(X)
        if n_samples < n_splits:
            raise ValueError(
                f"n_samples ({n_samples}) must be >= n_splits ({n_splits})"
            )

        sorted_idx = np.argsort(timestamps)
        embargo_size = max(1, int(n_samples * embargo_pct))

        fold_size = n_samples // n_splits

        for fold in range(n_splits):
            test_start = fold * fold_size
            test_end = (fold + 1) * fold_size if fold < n_splits - 1 else n_samples

            test_idx = sorted_idx[test_start:test_end]

            # Embargo: remove samples right after the test fold
            embargo_end = min(test_end + embargo_size, n_samples)

            # Train = everything before test + everything after embargo
            train_before = sorted_idx[:test_start]
            train_after = sorted_idx[embargo_end:]
            train_idx = np.concatenate([train_before, train_after])

            if len(train_idx) == 0:
                logger.warning(
                    "Fold %d has empty training set (embargo too large), skipping",
                    fold,
                )
                continue

            logger.debug(
                "Fold %d: train=%d, test=%d, embargo=%d samples removed",
                fold,
                len(train_idx),
                len(test_idx),
                embargo_end - test_end,
            )

            yield train_idx, test_idx

    # ------------------------------------------------------------------
    # Combinatorial Purged CV (CPCV)
    # ------------------------------------------------------------------

    def combinatorial_purged_cv(
        self,
        X: np.ndarray,
        y: np.ndarray,
        timestamps: np.ndarray,
        n_groups: int = 5,
        n_test_groups: int = 2,
        embargo_pct: float = 0.01,
    ) -> Generator[Tuple[np.ndarray, np.ndarray], None, None]:
        """
        Combinatorial Purged Cross-Validation (CPCV) per Marcos Lopez de Prado.

        Divides the time-sorted data into n_groups contiguous blocks, then
        iterates over all C(n_groups, n_test_groups) combinations of test
        blocks. For each combination, an embargo is applied after every
        test block boundary.

        Yields:
            (train_indices, test_indices) for each combination.
        """
        n_samples = len(X)
        if n_samples < n_groups:
            raise ValueError(
                f"n_samples ({n_samples}) must be >= n_groups ({n_groups})"
            )
        if n_test_groups >= n_groups:
            raise ValueError(
                f"n_test_groups ({n_test_groups}) must be < n_groups ({n_groups})"
            )

        sorted_idx = np.argsort(timestamps)
        embargo_size = max(1, int(n_samples * embargo_pct))

        # Build group boundaries
        group_boundaries: List[Tuple[int, int]] = []
        group_size = n_samples // n_groups
        for g in range(n_groups):
            start = g * group_size
            end = (g + 1) * group_size if g < n_groups - 1 else n_samples
            group_boundaries.append((start, end))

        n_combos = 0
        for test_combo in combinations(range(n_groups), n_test_groups):
            test_mask = np.zeros(n_samples, dtype=bool)
            embargo_mask = np.zeros(n_samples, dtype=bool)

            for g in test_combo:
                start, end = group_boundaries[g]
                test_mask[start:end] = True

                # Apply embargo after each test group
                embargo_end = min(end + embargo_size, n_samples)
                embargo_mask[end:embargo_end] = True

            # Train = not test and not embargoed
            train_mask = ~test_mask & ~embargo_mask

            test_idx = sorted_idx[test_mask]
            train_idx = sorted_idx[train_mask]

            if len(train_idx) == 0 or len(test_idx) == 0:
                logger.warning(
                    "CPCV combo %s has empty train or test set, skipping",
                    test_combo,
                )
                continue

            n_combos += 1
            logger.debug(
                "CPCV combo %s: train=%d, test=%d",
                test_combo,
                len(train_idx),
                len(test_idx),
            )

            yield train_idx, test_idx

        logger.info("CPCV generated %d fold combinations", n_combos)

    # ------------------------------------------------------------------
    # Model evaluation
    # ------------------------------------------------------------------

    def evaluate_model(
        self,
        model: BaseEstimator,
        X: np.ndarray,
        y: np.ndarray,
        timestamps: np.ndarray,
        method: str = "purged_kfold",
        n_splits: int = 5,
        embargo_pct: float = 0.01,
        n_groups: int = 5,
        n_test_groups: int = 2,
    ) -> Dict[str, Any]:
        """
        Run temporal CV on a sklearn-compatible model and return metrics.

        Args:
            model: sklearn estimator (must support fit/predict/predict_proba).
            X: Feature matrix (n_samples, n_features).
            y: Target labels (n_samples,).
            timestamps: Array of timestamps for ordering.
            method: "purged_kfold" or "combinatorial_purged".
            n_splits: Number of folds for purged_kfold.
            embargo_pct: Fraction of samples to embargo.
            n_groups: Groups for CPCV.
            n_test_groups: Test groups per CPCV combo.

        Returns:
            Dict with folds, mean_accuracy, std_accuracy, mean_sharpe,
            and overfitting_score.
        """
        with self._lock:
            return self._evaluate_model_internal(
                model, X, y, timestamps, method,
                n_splits, embargo_pct, n_groups, n_test_groups,
            )

    def _evaluate_model_internal(
        self,
        model: BaseEstimator,
        X: np.ndarray,
        y: np.ndarray,
        timestamps: np.ndarray,
        method: str,
        n_splits: int,
        embargo_pct: float,
        n_groups: int,
        n_test_groups: int,
    ) -> Dict[str, Any]:
        """Internal evaluation logic (caller must hold _lock)."""
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y)
        timestamps = np.asarray(timestamps)

        if len(X) != len(y) or len(X) != len(timestamps):
            raise ValueError(
                f"Length mismatch: X={len(X)}, y={len(y)}, timestamps={len(timestamps)}"
            )

        if method == "purged_kfold":
            fold_gen = self.purged_kfold(X, y, timestamps, n_splits, embargo_pct)
        elif method == "combinatorial_purged":
            fold_gen = self.combinatorial_purged_cv(
                X, y, timestamps, n_groups, n_test_groups, embargo_pct,
            )
        else:
            raise ValueError(f"Unknown CV method: {method}")

        folds: List[Dict[str, Any]] = []
        train_accuracies: List[float] = []
        test_accuracies: List[float] = []
        sharpe_ratios: List[float] = []

        for fold_num, (train_idx, test_idx) in enumerate(fold_gen):
            try:
                fold_model = clone(model)

                X_train, y_train = X[train_idx], y[train_idx]
                X_test, y_test = X[test_idx], y[test_idx]

                # Check for degenerate labels
                unique_train = np.unique(y_train)
                if len(unique_train) < 2:
                    logger.warning(
                        "Fold %d has only one class in training set, skipping",
                        fold_num,
                    )
                    continue

                fold_model.fit(X_train, y_train)

                # Train metrics
                train_pred = fold_model.predict(X_train)
                train_acc = accuracy_score(y_train, train_pred)
                train_accuracies.append(train_acc)

                # Test metrics
                test_pred = fold_model.predict(X_test)
                test_acc = accuracy_score(y_test, test_pred)
                test_accuracies.append(test_acc)

                # Sharpe-like metric from prediction returns
                sharpe = self._compute_prediction_sharpe(y_test, test_pred)
                sharpe_ratios.append(sharpe)

                # Log loss if model supports predict_proba
                test_logloss: Optional[float] = None
                if hasattr(fold_model, "predict_proba"):
                    try:
                        test_proba = fold_model.predict_proba(X_test)
                        unique_test = np.unique(y_test)
                        if len(unique_test) >= 2:
                            test_logloss = float(
                                log_loss(y_test, test_proba, labels=fold_model.classes_)
                            )
                    except Exception:
                        pass

                fold_result: Dict[str, Any] = {
                    "fold": fold_num,
                    "train_size": len(train_idx),
                    "test_size": len(test_idx),
                    "train_accuracy": round(train_acc, 4),
                    "test_accuracy": round(test_acc, 4),
                    "sharpe_ratio": round(sharpe, 4),
                }
                if test_logloss is not None:
                    fold_result["test_logloss"] = round(test_logloss, 4)

                folds.append(fold_result)

                logger.info(
                    "Fold %d: train_acc=%.4f, test_acc=%.4f, sharpe=%.4f",
                    fold_num, train_acc, test_acc, sharpe,
                )

            except Exception as e:
                logger.error("Fold %d failed: %s", fold_num, e)
                folds.append({
                    "fold": fold_num,
                    "error": str(e),
                })

        if not test_accuracies:
            logger.error("All folds failed or were skipped")
            return {
                "folds": folds,
                "mean_accuracy": 0.0,
                "std_accuracy": 0.0,
                "mean_sharpe": 0.0,
                "overfitting_score": float("inf"),
            }

        mean_train_acc = float(np.mean(train_accuracies))
        mean_test_acc = float(np.mean(test_accuracies))
        std_test_acc = float(np.std(test_accuracies))
        mean_sharpe = float(np.mean(sharpe_ratios))

        # Overfitting score: ratio of train vs test performance
        # >2.0 indicates likely overfitting
        if mean_test_acc > 0:
            overfitting_score = mean_train_acc / mean_test_acc
        else:
            overfitting_score = float("inf")

        result = {
            "folds": folds,
            "mean_accuracy": round(mean_test_acc, 4),
            "std_accuracy": round(std_test_acc, 4),
            "mean_sharpe": round(mean_sharpe, 4),
            "overfitting_score": round(overfitting_score, 4),
            "mean_train_accuracy": round(mean_train_acc, 4),
            "n_folds_completed": len(test_accuracies),
        }

        if overfitting_score > 2.0:
            logger.warning(
                "Overfitting detected: train/test ratio=%.2f (threshold=2.0)",
                overfitting_score,
            )

        logger.info(
            "CV complete: method=%s, accuracy=%.4f +/- %.4f, sharpe=%.4f, overfit=%.4f",
            method, mean_test_acc, std_test_acc, mean_sharpe, overfitting_score,
        )

        return result

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_prediction_sharpe(
        y_true: np.ndarray,
        y_pred: np.ndarray,
        annualization_factor: float = 252.0,
    ) -> float:
        """
        Compute a Sharpe-like metric from correct/incorrect predictions.

        Treats each prediction as a +1 (correct) or -1 (incorrect) return,
        then computes annualized Sharpe ratio. This approximates how
        profitable the model's signals would be.
        """
        returns = np.where(y_pred == y_true, 1.0, -1.0)
        if len(returns) < 2 or np.std(returns) == 0:
            return 0.0
        sharpe = (np.mean(returns) / np.std(returns)) * np.sqrt(annualization_factor)
        return float(sharpe)
