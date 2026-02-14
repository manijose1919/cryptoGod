"""
Calibration Monitor Service

Tracks model calibration - whether predicted confidence levels match actual win rates.
Uses a rolling window of recent predictions and outcomes to compute calibration curves,
confidence corrections, and overconfidence/underconfidence diagnostics.
"""

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

ROLLING_WINDOW_SIZE = 1000
BUCKET_SIZE = 10  # 0-10, 10-20, ..., 90-100
NUM_BUCKETS = 10
MIN_BUCKET_COUNT = 5  # Minimum samples in a bucket to compute meaningful stats


@dataclass
class PredictionRecord:
    """A single prediction with its metadata and outcome."""
    confidence: int
    action: str
    symbol: str
    timestamp: float
    won: Optional[bool] = None
    outcome_recorded: bool = False


@dataclass
class BucketStats:
    """Aggregated stats for a confidence bucket."""
    range_label: str
    bucket_midpoint: float
    total: int = 0
    wins: int = 0

    @property
    def actual_win_rate(self) -> float:
        if self.total == 0:
            return 0.0
        return self.wins / self.total

    @property
    def calibration_error(self) -> float:
        """Absolute difference between predicted confidence and actual win rate."""
        if self.total < MIN_BUCKET_COUNT:
            return 0.0
        predicted = self.bucket_midpoint / 100.0
        return abs(predicted - self.actual_win_rate)


class CalibrationMonitor:
    """
    Monitors model calibration by comparing predicted confidence levels
    against actual win rates across confidence buckets.

    Thread-safe via threading.Lock for all mutable state access.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._predictions: deque[PredictionRecord] = deque(maxlen=ROLLING_WINDOW_SIZE)
        self._outcome_records: deque[Tuple[int, bool]] = deque(maxlen=ROLLING_WINDOW_SIZE)
        logger.info("CalibrationMonitor initialized (window=%d)", ROLLING_WINDOW_SIZE)

    def record_prediction(self, confidence: int, action: str, symbol: str) -> None:
        """
        Record a new prediction.

        Args:
            confidence: Predicted confidence level (0-100).
            action: The action taken (e.g., 'BUY', 'SELL', 'HOLD').
            symbol: The trading symbol (e.g., 'BTCUSD').
        """
        confidence = self._clamp_confidence(confidence)
        record = PredictionRecord(
            confidence=confidence,
            action=action,
            symbol=symbol,
            timestamp=time.time(),
        )
        with self._lock:
            self._predictions.append(record)
        logger.debug(
            "Recorded prediction: confidence=%d action=%s symbol=%s",
            confidence, action, symbol,
        )

    def record_outcome(self, confidence: int, won: bool) -> None:
        """
        Record whether a prediction at a given confidence level was correct.

        Args:
            confidence: The confidence level of the original prediction (0-100).
            won: True if the trade was profitable, False otherwise.
        """
        confidence = self._clamp_confidence(confidence)
        with self._lock:
            self._outcome_records.append((confidence, won))
            # Also try to match to the most recent unresolved prediction with
            # the same confidence, walking backwards.
            for record in reversed(self._predictions):
                if not record.outcome_recorded and record.confidence == confidence:
                    record.won = won
                    record.outcome_recorded = True
                    break
        logger.debug(
            "Recorded outcome: confidence=%d won=%s", confidence, won,
        )

    def get_calibration_curve(self) -> Dict:
        """
        Compute the calibration curve by grouping trades into confidence buckets.

        Returns:
            Dictionary with:
              - buckets: list of bucket dicts with range, predicted, actual_win_rate, count
              - overall_calibration_error: weighted mean absolute calibration error
              - is_overconfident: True if model confidence systematically exceeds win rate
              - is_underconfident: True if model confidence systematically trails win rate
        """
        with self._lock:
            outcomes = list(self._outcome_records)

        buckets = self._build_buckets(outcomes)
        bucket_dicts = []
        total_weighted_error = 0.0
        total_weighted_count = 0
        overconfident_weighted = 0.0
        underconfident_weighted = 0.0
        signed_total = 0

        for bucket in buckets:
            bucket_dict = {
                "range": bucket.range_label,
                "predicted": bucket.bucket_midpoint,
                "actual_win_rate": round(bucket.actual_win_rate, 4),
                "count": bucket.total,
            }
            bucket_dicts.append(bucket_dict)

            if bucket.total >= MIN_BUCKET_COUNT:
                weight = bucket.total
                total_weighted_error += bucket.calibration_error * weight
                total_weighted_count += weight

                predicted_rate = bucket.bucket_midpoint / 100.0
                diff = predicted_rate - bucket.actual_win_rate
                signed_total += diff * weight

                if diff > 0:
                    overconfident_weighted += diff * weight
                else:
                    underconfident_weighted += abs(diff) * weight

        overall_error = 0.0
        if total_weighted_count > 0:
            overall_error = total_weighted_error / total_weighted_count

        is_overconfident = False
        is_underconfident = False
        if total_weighted_count > 0:
            net_bias = signed_total / total_weighted_count
            # Use a small threshold to avoid noise
            if net_bias > 0.02:
                is_overconfident = True
            elif net_bias < -0.02:
                is_underconfident = True

        return {
            "buckets": bucket_dicts,
            "overall_calibration_error": round(overall_error, 4),
            "is_overconfident": is_overconfident,
            "is_underconfident": is_underconfident,
        }

    def get_confidence_correction(self, confidence: int) -> int:
        """
        Adjust a raw confidence value based on historical calibration data.

        If the model says 70% but the actual win rate at the 70% bucket is 55%,
        the corrected confidence is 55.

        Args:
            confidence: Raw model confidence (0-100).

        Returns:
            Corrected confidence (0-100).
        """
        confidence = self._clamp_confidence(confidence)

        with self._lock:
            outcomes = list(self._outcome_records)

        buckets = self._build_buckets(outcomes)
        bucket_index = self._get_bucket_index(confidence)

        if bucket_index < 0 or bucket_index >= len(buckets):
            return confidence

        bucket = buckets[bucket_index]

        # Need enough data to make a meaningful correction
        if bucket.total < MIN_BUCKET_COUNT:
            # Try to interpolate from neighboring buckets
            corrected = self._interpolate_correction(confidence, buckets)
            if corrected is not None:
                return corrected
            return confidence

        # The corrected confidence is the actual win rate expressed as 0-100
        actual_pct = bucket.actual_win_rate * 100.0
        corrected = int(round(actual_pct))
        corrected = max(0, min(100, corrected))

        if corrected != confidence:
            logger.debug(
                "Confidence correction: %d -> %d (bucket %s, n=%d, actual=%.2f%%)",
                confidence, corrected, bucket.range_label, bucket.total,
                bucket.actual_win_rate * 100,
            )

        return corrected

    def get_status(self) -> Dict:
        """
        Get overall calibration monitor status and diagnostics.

        Returns:
            Dictionary with total predictions, outcomes, calibration error,
            overconfidence flag, and actionable recommendations.
        """
        with self._lock:
            total_predictions = len(self._predictions)
            total_outcomes = len(self._outcome_records)
            resolved = sum(1 for p in self._predictions if p.outcome_recorded)

        curve = self.get_calibration_curve()
        recommendations: List[str] = []

        if total_outcomes < 20:
            recommendations.append(
                f"Insufficient data ({total_outcomes} outcomes). "
                f"Need at least 20 for meaningful calibration."
            )
        else:
            error = curve["overall_calibration_error"]
            if error > 0.15:
                recommendations.append(
                    f"High calibration error ({error:.1%}). "
                    f"Model confidence is poorly aligned with actual outcomes."
                )
            elif error > 0.08:
                recommendations.append(
                    f"Moderate calibration error ({error:.1%}). "
                    f"Consider applying confidence corrections."
                )
            else:
                recommendations.append(
                    f"Good calibration ({error:.1%}). "
                    f"Model confidence is well-aligned with outcomes."
                )

            if curve["is_overconfident"]:
                recommendations.append(
                    "Model is overconfident: predicted confidence exceeds actual win rates. "
                    "Apply negative corrections or raise entry thresholds."
                )
            if curve["is_underconfident"]:
                recommendations.append(
                    "Model is underconfident: actual win rates exceed predicted confidence. "
                    "Consider lowering entry thresholds to capture more profitable trades."
                )

            # Check for empty buckets in the high-confidence range
            high_buckets = [
                b for b in curve["buckets"]
                if b["predicted"] >= 60 and b["count"] < MIN_BUCKET_COUNT
            ]
            if high_buckets:
                ranges = ", ".join(b["range"] for b in high_buckets)
                recommendations.append(
                    f"Sparse data in high-confidence buckets ({ranges}). "
                    f"Corrections for these ranges are unreliable."
                )

        return {
            "total_predictions": total_predictions,
            "total_outcomes": total_outcomes,
            "resolved_predictions": resolved,
            "overall_calibration_error": curve["overall_calibration_error"],
            "is_overconfident": curve["is_overconfident"],
            "is_underconfident": curve["is_underconfident"],
            "recommendations": recommendations,
            "window_size": ROLLING_WINDOW_SIZE,
        }

    # -------------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _clamp_confidence(confidence: int) -> int:
        """Clamp confidence to valid 0-100 range."""
        return max(0, min(100, int(confidence)))

    @staticmethod
    def _get_bucket_index(confidence: int) -> int:
        """Map a confidence value (0-100) to a bucket index (0-9)."""
        # 0-9 -> 0, 10-19 -> 1, ..., 90-100 -> 9
        index = confidence // BUCKET_SIZE
        return min(index, NUM_BUCKETS - 1)

    @staticmethod
    def _build_buckets(outcomes: List[Tuple[int, bool]]) -> List[BucketStats]:
        """Build bucket stats from a list of (confidence, won) tuples."""
        buckets: List[BucketStats] = []
        for i in range(NUM_BUCKETS):
            low = i * BUCKET_SIZE
            high = (i + 1) * BUCKET_SIZE
            midpoint = (low + high) / 2.0
            label = f"{low}-{high}"
            buckets.append(BucketStats(range_label=label, bucket_midpoint=midpoint))

        for confidence, won in outcomes:
            idx = min(confidence // BUCKET_SIZE, NUM_BUCKETS - 1)
            buckets[idx].total += 1
            if won:
                buckets[idx].wins += 1

        return buckets

    @staticmethod
    def _interpolate_correction(
        confidence: int, buckets: List[BucketStats]
    ) -> Optional[int]:
        """
        Attempt to interpolate a correction from neighboring buckets
        when the target bucket has insufficient data.
        """
        target_idx = min(confidence // BUCKET_SIZE, NUM_BUCKETS - 1)

        # Find nearest buckets with enough data
        lower_idx: Optional[int] = None
        upper_idx: Optional[int] = None

        for i in range(target_idx - 1, -1, -1):
            if buckets[i].total >= MIN_BUCKET_COUNT:
                lower_idx = i
                break

        for i in range(target_idx + 1, NUM_BUCKETS):
            if buckets[i].total >= MIN_BUCKET_COUNT:
                upper_idx = i
                break

        if lower_idx is not None and upper_idx is not None:
            # Linear interpolation between the two neighboring buckets
            lower_mid = buckets[lower_idx].bucket_midpoint
            upper_mid = buckets[upper_idx].bucket_midpoint
            lower_rate = buckets[lower_idx].actual_win_rate
            upper_rate = buckets[upper_idx].actual_win_rate

            if upper_mid == lower_mid:
                return None

            t = (confidence - lower_mid) / (upper_mid - lower_mid)
            t = max(0.0, min(1.0, t))
            interpolated_rate = lower_rate + t * (upper_rate - lower_rate)
            corrected = int(round(interpolated_rate * 100.0))
            return max(0, min(100, corrected))

        if lower_idx is not None:
            return int(round(buckets[lower_idx].actual_win_rate * 100.0))

        if upper_idx is not None:
            return int(round(buckets[upper_idx].actual_win_rate * 100.0))

        return None


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[CalibrationMonitor] = None
_instance_lock = threading.Lock()


def get_calibration_monitor() -> CalibrationMonitor:
    """Return the singleton CalibrationMonitor instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = CalibrationMonitor()
                logger.info("CalibrationMonitor singleton created")
    return _instance
