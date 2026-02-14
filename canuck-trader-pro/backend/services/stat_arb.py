"""
Statistical Arbitrage Service
Detects cointegrated cryptocurrency pairs and generates spread trading signals.
"""

import logging
import threading
from collections import deque
from itertools import combinations
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

logger = logging.getLogger(__name__)

_instance: "StatArbService | None" = None
_instance_lock = threading.Lock()


def get_stat_arb() -> "StatArbService":
    """Return the singleton StatArbService instance."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = StatArbService()
    return _instance


class StatArbService:
    """Finds cointegrated pairs and generates mean-reversion signals."""

    CORRELATION_THRESHOLD = 0.7
    SPREAD_HISTORY_LEN = 200
    Z_ENTRY = 2.0
    Z_EXIT = 0.5

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # {(sym1, sym2): deque of spread values}
        self._spread_history: dict[tuple[str, str], deque[float]] = {}
        logger.info("StatArbService initialised")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def find_pairs(self, price_data: dict[str, pd.Series]) -> list[dict[str, Any]]:
        """Test all pair combinations and return those with correlation > threshold.

        Parameters
        ----------
        price_data : dict mapping symbol -> pd.Series of close prices

        Returns
        -------
        list of dicts with keys: pair, correlation, z_score, half_life
        """
        results: list[dict[str, Any]] = []
        symbols = list(price_data.keys())

        if len(symbols) < 2:
            return results

        with self._lock:
            for sym1, sym2 in combinations(symbols, 2):
                try:
                    s1 = price_data[sym1].dropna()
                    s2 = price_data[sym2].dropna()

                    # Align on common index
                    common = s1.index.intersection(s2.index)
                    if len(common) < 30:
                        continue
                    s1 = s1.loc[common]
                    s2 = s2.loc[common]

                    corr = float(s1.corr(s2))
                    if abs(corr) < self.CORRELATION_THRESHOLD:
                        continue

                    spread = self._compute_spread(s1, s2)
                    z = self._z_score(spread)
                    hl = compute_half_life(spread)

                    # Update history
                    key = (sym1, sym2)
                    if key not in self._spread_history:
                        self._spread_history[key] = deque(maxlen=self.SPREAD_HISTORY_LEN)
                    self._spread_history[key].append(float(spread.iloc[-1]))

                    results.append({
                        "pair": (sym1, sym2),
                        "correlation": round(corr, 4),
                        "z_score": round(z, 4),
                        "half_life": round(hl, 2),
                    })
                except Exception:
                    logger.exception("Error analysing pair %s/%s", sym1, sym2)

        return results

    def get_signals(self, price_data: dict[str, pd.Series]) -> list[dict[str, Any]]:
        """Generate LONG_SPREAD / SHORT_SPREAD / CLOSE signals for cointegrated pairs.

        Signal logic (based on spread z-score):
        * z >  2.0  -> SHORT_SPREAD  (sell sym1, buy sym2)
        * z < -2.0  -> LONG_SPREAD   (buy sym1, sell sym2)
        * |z| < 0.5 -> CLOSE         (unwind position)
        """
        pairs = self.find_pairs(price_data)
        signals: list[dict[str, Any]] = []

        for p in pairs:
            z = p["z_score"]
            corr = p["correlation"]

            if z > self.Z_ENTRY:
                signal = "SHORT_SPREAD"
                confidence = min(100.0, abs(z) / 4.0 * 100.0 * abs(corr))
            elif z < -self.Z_ENTRY:
                signal = "LONG_SPREAD"
                confidence = min(100.0, abs(z) / 4.0 * 100.0 * abs(corr))
            elif abs(z) < self.Z_EXIT:
                signal = "CLOSE"
                confidence = min(100.0, (1.0 - abs(z) / self.Z_EXIT) * 100.0 * abs(corr))
            else:
                # In the dead zone (0.5 <= |z| <= 2.0) – no actionable signal
                continue

            signals.append({
                "pair": p["pair"],
                "signal": signal,
                "z_score": p["z_score"],
                "confidence": round(confidence, 1),
                "correlation": p["correlation"],
            })

        return signals

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_spread(s1: pd.Series, s2: pd.Series) -> pd.Series:
        """OLS hedge-ratio spread: s1 - beta * s2."""
        model = LinearRegression()
        model.fit(s2.values.reshape(-1, 1), s1.values)
        beta = float(model.coef_[0])
        return s1 - beta * s2

    @staticmethod
    def _z_score(spread: pd.Series) -> float:
        """Current z-score of the spread series."""
        mean = spread.mean()
        std = spread.std()
        if std == 0 or np.isnan(std):
            return 0.0
        return float((spread.iloc[-1] - mean) / std)


def compute_half_life(spread: pd.Series) -> float:
    """Ornstein-Uhlenbeck half-life estimation via OLS.

    Regresses delta(spread) on lagged spread to estimate the
    mean-reversion speed (lambda). Half-life = -ln(2) / lambda.

    Returns
    -------
    float  Half-life in candle periods. Clamped to [1, 500] to avoid
           degenerate values.
    """
    try:
        spread_arr = spread.values
        if len(spread_arr) < 10:
            return float("inf")

        lagged = spread_arr[:-1]
        delta = np.diff(spread_arr)

        # Remove NaN / inf
        mask = np.isfinite(lagged) & np.isfinite(delta)
        lagged = lagged[mask]
        delta = delta[mask]

        if len(lagged) < 5:
            return float("inf")

        model = LinearRegression()
        model.fit(lagged.reshape(-1, 1), delta)
        lam = float(model.coef_[0])

        if lam >= 0:
            # Not mean-reverting
            return float("inf")

        half_life = -np.log(2) / lam
        return float(np.clip(half_life, 1.0, 500.0))
    except Exception:
        logger.exception("Half-life computation failed")
        return float("inf")
