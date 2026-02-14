"""
Data Integrity Service - Validates market data quality for the trading bot.

Checks for:
- OHLC consistency (high >= max(open,close), low <= min(open,close))
- Zero or negative volumes
- Duplicate timestamps
- Missing candles / gaps in time series
- Extreme price jumps between consecutive candles
- Stale data detection
"""

import logging
import threading
import time
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger("data_integrity")

_instance: Optional["DataIntegrity"] = None
_instance_lock = threading.Lock()


def get_data_integrity() -> "DataIntegrity":
    """Return the singleton DataIntegrity instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = DataIntegrity()
    return _instance


class DataIntegrity:
    """Validates market data quality and freshness."""

    # Thresholds
    EXTREME_JUMP_PCT = 5.0       # % change between consecutive candles
    STALENESS_FACTOR = 2.0       # multiplier on expected interval before data is stale
    MIN_CANDLES_FOR_GAP = 3      # need at least this many candles to detect gaps

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_reports: dict = {}  # symbol -> last validation result

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def validate_candles(self, symbol: str, df: pd.DataFrame) -> dict:
        """Run all quality checks on a candle DataFrame.

        Expected columns: open (o), high (h), low (l), close (c), volume (v),
        and a timestamp column (t / time / timestamp).

        Returns:
            {
                "valid": bool,
                "issues": [{"type": str, "severity": "WARNING"|"ERROR", "detail": str}, ...],
                "quality_score": int  # 0-100
            }
        """
        with self._lock:
            issues: list[dict] = []

            if df is None or df.empty:
                issues.append({
                    "type": "EMPTY_DATA",
                    "severity": "ERROR",
                    "detail": f"{symbol}: DataFrame is empty or None",
                })
                result = {"valid": False, "issues": issues, "quality_score": 0}
                self._last_reports[symbol] = result
                return result

            # Normalise column names so we accept both verbose and short forms
            col_map = self._normalise_columns(df)
            if col_map is None:
                issues.append({
                    "type": "MISSING_COLUMNS",
                    "severity": "ERROR",
                    "detail": f"{symbol}: Required OHLCV columns not found. Columns present: {list(df.columns)}",
                })
                result = {"valid": False, "issues": issues, "quality_score": 0}
                self._last_reports[symbol] = result
                return result

            o, h, l, c, v, ts = (
                col_map["open"],
                col_map["high"],
                col_map["low"],
                col_map["close"],
                col_map["volume"],
                col_map.get("time"),
            )

            total_rows = len(df)
            penalty = 0.0  # deducted from 100

            # 1. OHLC consistency
            ohlc_issues = self._check_ohlc(df, o, h, l, c, symbol)
            if ohlc_issues:
                bad_count = ohlc_issues["count"]
                pct = bad_count / total_rows * 100
                severity = "ERROR" if pct > 10 else "WARNING"
                issues.append({
                    "type": "OHLC_INCONSISTENCY",
                    "severity": severity,
                    "detail": f"{symbol}: {bad_count}/{total_rows} candles ({pct:.1f}%) have OHLC violations",
                })
                penalty += min(pct * 2, 40)

            # 2. Zero / negative volume
            vol_issues = self._check_volume(df, v, symbol)
            if vol_issues:
                bad_count = vol_issues["count"]
                pct = bad_count / total_rows * 100
                severity = "ERROR" if pct > 20 else "WARNING"
                issues.append({
                    "type": "BAD_VOLUME",
                    "severity": severity,
                    "detail": f"{symbol}: {bad_count}/{total_rows} candles ({pct:.1f}%) have zero or negative volume",
                })
                penalty += min(pct, 20)

            # 3. Duplicate timestamps
            if ts is not None:
                dup_issues = self._check_duplicates(df, ts, symbol)
                if dup_issues:
                    dup_count = dup_issues["count"]
                    issues.append({
                        "type": "DUPLICATE_TIMESTAMPS",
                        "severity": "ERROR",
                        "detail": f"{symbol}: {dup_count} duplicate timestamps found",
                    })
                    penalty += min(dup_count / total_rows * 100 * 3, 30)

            # 4. Gap detection
            if ts is not None and total_rows >= self.MIN_CANDLES_FOR_GAP:
                gap_issues = self._check_gaps(df, ts, symbol)
                if gap_issues:
                    gap_count = gap_issues["count"]
                    severity = "ERROR" if gap_count > 5 else "WARNING"
                    issues.append({
                        "type": "CANDLE_GAPS",
                        "severity": severity,
                        "detail": (
                            f"{symbol}: {gap_count} gaps detected "
                            f"(expected interval ~{gap_issues['expected_interval_sec']:.0f}s)"
                        ),
                    })
                    penalty += min(gap_count * 2, 20)

            # 5. Extreme price jumps
            jump_issues = self._check_extreme_jumps(df, c, symbol)
            if jump_issues:
                jump_count = jump_issues["count"]
                max_jump = jump_issues["max_jump_pct"]
                severity = "ERROR" if max_jump > 15 else "WARNING"
                issues.append({
                    "type": "EXTREME_PRICE_JUMP",
                    "severity": severity,
                    "detail": (
                        f"{symbol}: {jump_count} jumps >{self.EXTREME_JUMP_PCT}% detected "
                        f"(max {max_jump:.2f}%)"
                    ),
                })
                penalty += min(jump_count * 3, 25)

            quality_score = max(0, min(100, int(100 - penalty)))
            has_errors = any(i["severity"] == "ERROR" for i in issues)
            valid = not has_errors and quality_score >= 50

            result = {
                "valid": valid,
                "issues": issues,
                "quality_score": quality_score,
            }
            self._last_reports[symbol] = result
            return result

    def check_freshness(
        self,
        symbol: str,
        last_candle_time: float,
        expected_interval_sec: int = 300,
    ) -> dict:
        """Check whether data for a symbol is stale.

        Args:
            symbol: Trading pair (for logging).
            last_candle_time: Unix timestamp (seconds) of the most recent candle.
            expected_interval_sec: Expected candle interval in seconds (default 300 = 5m).

        Returns:
            {"fresh": bool, "age_seconds": float, "stale": bool}
        """
        try:
            now = time.time()
            age = now - last_candle_time
            stale_threshold = expected_interval_sec * self.STALENESS_FACTOR
            is_stale = age > stale_threshold

            if is_stale:
                logger.warning(
                    "%s data is stale: age=%.0fs, threshold=%.0fs",
                    symbol,
                    age,
                    stale_threshold,
                )

            return {
                "fresh": not is_stale,
                "age_seconds": round(age, 2),
                "stale": is_stale,
            }
        except Exception as exc:
            logger.error("Freshness check failed for %s: %s", symbol, exc)
            return {"fresh": False, "age_seconds": float("inf"), "stale": True}

    def get_data_report(self, all_data: dict) -> dict:
        """Run validation on every pair and return an aggregate report.

        Args:
            all_data: Mapping of symbol -> pd.DataFrame (candle data).

        Returns:
            {
                "pairs_checked": int,
                "issues_found": int,
                "stale_pairs": [str, ...],
                "quality_scores": {symbol: int, ...},
                "recommendation": str,
            }
        """
        pairs_checked = 0
        total_issues = 0
        stale_pairs: list[str] = []
        quality_scores: dict[str, int] = {}

        for symbol, df in all_data.items():
            try:
                pairs_checked += 1

                # Validate candles
                result = self.validate_candles(symbol, df)
                quality_scores[symbol] = result["quality_score"]
                total_issues += len(result["issues"])

                # Freshness check (use last row timestamp if available)
                ts_col = self._find_time_column(df)
                if ts_col is not None and not df.empty:
                    last_ts = float(df[ts_col].iloc[-1])
                    freshness = self.check_freshness(symbol, last_ts)
                    if freshness["stale"]:
                        stale_pairs.append(symbol)

            except Exception as exc:
                logger.error("Report generation failed for %s: %s", symbol, exc)
                quality_scores[symbol] = 0
                total_issues += 1

        # Build recommendation
        avg_quality = (
            np.mean(list(quality_scores.values())) if quality_scores else 0
        )
        stale_ratio = len(stale_pairs) / max(pairs_checked, 1)

        if avg_quality >= 90 and stale_ratio == 0:
            recommendation = "ALL_CLEAR: Data quality is excellent across all pairs."
        elif avg_quality >= 70 and stale_ratio < 0.2:
            recommendation = (
                "MINOR_ISSUES: Most data is good. Review flagged pairs before trading."
            )
        elif avg_quality >= 50:
            recommendation = (
                "DEGRADED: Data quality is below normal. "
                "Reduce position sizes or pause low-quality pairs."
            )
        else:
            recommendation = (
                "CRITICAL: Significant data quality problems detected. "
                "Halt automated trading until data feeds are restored."
            )

        return {
            "pairs_checked": pairs_checked,
            "issues_found": total_issues,
            "stale_pairs": stale_pairs,
            "quality_scores": quality_scores,
            "recommendation": recommendation,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _normalise_columns(self, df: pd.DataFrame) -> Optional[dict]:
        """Map DataFrame columns to canonical OHLCV + time names.

        Accepts both short (o,h,l,c,v,t) and long (open,high,low,close,volume,time/timestamp) forms.
        Returns a dict with keys open/high/low/close/volume/time mapped to actual column names,
        or None if required columns are missing.
        """
        cols = {col.lower(): col for col in df.columns}
        mapping: dict[str, Optional[str]] = {}

        for canonical, alternatives in [
            ("open", ["open", "o"]),
            ("high", ["high", "h"]),
            ("low", ["low", "l"]),
            ("close", ["close", "c"]),
            ("volume", ["volume", "v", "vol"]),
        ]:
            found = None
            for alt in alternatives:
                if alt in cols:
                    found = cols[alt]
                    break
            if found is None:
                return None
            mapping[canonical] = found

        # Time column is optional
        for alt in ["t", "time", "timestamp", "date", "datetime"]:
            if alt in cols:
                mapping["time"] = cols[alt]
                break

        return mapping

    def _find_time_column(self, df: pd.DataFrame) -> Optional[str]:
        """Return the name of the time column if present, else None."""
        if df is None or df.empty:
            return None
        cols = {col.lower(): col for col in df.columns}
        for alt in ["t", "time", "timestamp", "date", "datetime"]:
            if alt in cols:
                return cols[alt]
        return None

    def _check_ohlc(
        self, df: pd.DataFrame, o: str, h: str, l: str, c: str, symbol: str
    ) -> Optional[dict]:
        """Check that high >= max(open,close) and low <= min(open,close)."""
        try:
            open_arr = pd.to_numeric(df[o], errors="coerce")
            high_arr = pd.to_numeric(df[h], errors="coerce")
            low_arr = pd.to_numeric(df[l], errors="coerce")
            close_arr = pd.to_numeric(df[c], errors="coerce")

            max_oc = np.maximum(open_arr.values, close_arr.values)
            min_oc = np.minimum(open_arr.values, close_arr.values)

            # Allow tiny floating-point tolerance
            tol = 1e-10
            high_violation = high_arr.values < (max_oc - tol)
            low_violation = low_arr.values > (min_oc + tol)

            bad_mask = high_violation | low_violation
            # Ignore NaN rows
            bad_mask = bad_mask & ~(
                np.isnan(open_arr.values)
                | np.isnan(high_arr.values)
                | np.isnan(low_arr.values)
                | np.isnan(close_arr.values)
            )
            bad_count = int(np.sum(bad_mask))

            if bad_count > 0:
                return {"count": bad_count}
            return None
        except Exception as exc:
            logger.error("OHLC check failed for %s: %s", symbol, exc)
            return None

    def _check_volume(
        self, df: pd.DataFrame, v: str, symbol: str
    ) -> Optional[dict]:
        """Check for zero or negative volume values."""
        try:
            vol = pd.to_numeric(df[v], errors="coerce")
            bad_count = int((vol <= 0).sum()) - int(vol.isna().sum())
            bad_count = max(0, bad_count)
            if bad_count > 0:
                return {"count": bad_count}
            return None
        except Exception as exc:
            logger.error("Volume check failed for %s: %s", symbol, exc)
            return None

    def _check_duplicates(
        self, df: pd.DataFrame, ts: str, symbol: str
    ) -> Optional[dict]:
        """Check for duplicate timestamp values."""
        try:
            dup_count = int(df[ts].duplicated().sum())
            if dup_count > 0:
                return {"count": dup_count}
            return None
        except Exception as exc:
            logger.error("Duplicate check failed for %s: %s", symbol, exc)
            return None

    def _check_gaps(
        self, df: pd.DataFrame, ts: str, symbol: str
    ) -> Optional[dict]:
        """Detect missing candles based on median interval between timestamps."""
        try:
            times = pd.to_numeric(df[ts], errors="coerce").dropna().sort_values()
            if len(times) < self.MIN_CANDLES_FOR_GAP:
                return None

            diffs = np.diff(times.values)
            if len(diffs) == 0:
                return None

            expected_interval = float(np.median(diffs))
            if expected_interval <= 0:
                return None

            # A gap is where the diff exceeds 1.5x the expected interval
            gap_threshold = expected_interval * 1.5
            gap_count = int(np.sum(diffs > gap_threshold))

            if gap_count > 0:
                return {
                    "count": gap_count,
                    "expected_interval_sec": expected_interval,
                }
            return None
        except Exception as exc:
            logger.error("Gap check failed for %s: %s", symbol, exc)
            return None

    def _check_extreme_jumps(
        self, df: pd.DataFrame, c: str, symbol: str
    ) -> Optional[dict]:
        """Detect consecutive candles with >EXTREME_JUMP_PCT % change."""
        try:
            close = pd.to_numeric(df[c], errors="coerce").dropna()
            if len(close) < 2:
                return None

            pct_change = np.abs(np.diff(close.values) / close.values[:-1]) * 100
            jump_mask = pct_change > self.EXTREME_JUMP_PCT
            jump_count = int(np.sum(jump_mask))

            if jump_count > 0:
                max_jump = float(np.max(pct_change))
                return {"count": jump_count, "max_jump_pct": max_jump}
            return None
        except Exception as exc:
            logger.error("Jump check failed for %s: %s", symbol, exc)
            return None
