"""
Portfolio Heat Manager
Tracks total portfolio risk exposure and prevents over-exposure.
Heat = sum of (position_size / balance * distance_to_stop%) for all positions.
"""

import logging
import threading
from typing import Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Asset-sector mapping (Canadian-compliant USD pairs)
# ---------------------------------------------------------------------------
SECTOR_MAP: Dict[str, str] = {
    "BTC": "major",
    "ETH": "major",
    "SOL": "alt-L1",
    "ADA": "alt-L1",
    "DOT": "alt-L1",
    "LINK": "alt-L1",
    "AVAX": "alt-L1",
    "DOGE": "other",
    "XRP": "other",
    "BNB": "other",
}

MAX_HEAT: float = 30.0
MAX_SECTOR_HEAT: float = MAX_HEAT * 0.5  # 15.0
DOMINANT_HEAT_THRESHOLD: float = 0.40  # 40 % of total heat


def _base_symbol(symbol: str) -> str:
    """Extract the base asset from a pair string (e.g. 'BTCUSD' -> 'BTC')."""
    upper = symbol.upper()
    for suffix in ("USD", "USDT", "USDC"):
        if upper.endswith(suffix):
            return upper[: -len(suffix)]
    return upper


class PortfolioHeat:
    """Thread-safe portfolio heat tracker (singleton)."""

    _instance: Optional["PortfolioHeat"] = None
    _init_lock = threading.Lock()

    def __new__(cls) -> "PortfolioHeat":
        with cls._init_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._lock = threading.Lock()
                logger.info("PortfolioHeat singleton created (max_heat=%.1f)", MAX_HEAT)
            return cls._instance

    # ------------------------------------------------------------------
    # Core heat calculation
    # ------------------------------------------------------------------

    def calculate_heat(self, positions: dict, balance: float) -> dict:
        """Compute total portfolio heat.

        Parameters
        ----------
        positions : dict
            Mapping of symbol -> position dict.  Each position must contain:
                - ``size`` (float): notional value of the position
                - ``entry_price`` (float): average entry price
                - ``stop_loss`` (float): current stop-loss price
        balance : float
            Total account balance (cash + positions).

        Returns
        -------
        dict
            heat, max_heat, can_add_position, heat_per_position, recommendation
        """
        with self._lock:
            try:
                if balance <= 0:
                    logger.warning("Balance is <= 0 (%.4f); returning max heat", balance)
                    return {
                        "heat": MAX_HEAT,
                        "max_heat": MAX_HEAT,
                        "can_add_position": False,
                        "heat_per_position": {},
                        "recommendation": "Invalid balance — no trading allowed.",
                    }

                heat_per_position: Dict[str, float] = {}
                total_heat: float = 0.0

                for symbol, pos in positions.items():
                    try:
                        size = float(pos.get("size", 0))
                        entry = float(pos.get("entry_price", 0))
                        stop = float(pos.get("stop_loss", 0))

                        if entry <= 0 or size <= 0:
                            heat_per_position[symbol] = 0.0
                            continue

                        distance_pct = abs(entry - stop) / entry * 100.0
                        position_heat = (size / balance) * distance_pct
                        position_heat = float(np.clip(position_heat, 0.0, MAX_HEAT))

                        heat_per_position[symbol] = round(position_heat, 4)
                        total_heat += position_heat
                    except (TypeError, ValueError, ZeroDivisionError) as exc:
                        logger.error("Error computing heat for %s: %s", symbol, exc)
                        heat_per_position[symbol] = 0.0

                total_heat = round(float(np.clip(total_heat, 0.0, 100.0)), 4)
                can_add = total_heat < MAX_HEAT

                recommendation = self._build_recommendation(total_heat)

                return {
                    "heat": total_heat,
                    "max_heat": MAX_HEAT,
                    "can_add_position": can_add,
                    "heat_per_position": heat_per_position,
                    "recommendation": recommendation,
                }

            except Exception as exc:
                logger.exception("Unexpected error in calculate_heat: %s", exc)
                return {
                    "heat": MAX_HEAT,
                    "max_heat": MAX_HEAT,
                    "can_add_position": False,
                    "heat_per_position": {},
                    "recommendation": "Error calculating heat — blocking new positions.",
                }

    # ------------------------------------------------------------------
    # Position-size adjustment
    # ------------------------------------------------------------------

    @staticmethod
    def get_position_size_adjustment(heat: float) -> float:
        """Return a multiplier (0.0–1.0) to scale new position sizes.

        Heat 0–15   → 1.0  (full size)
        Heat 15–25  → linear 1.0 → 0.3
        Heat 25–30  → 0.1  (minimal)
        Heat 30+    → 0.0  (no new positions)
        """
        try:
            heat = float(heat)
            if heat < 0:
                heat = 0.0

            if heat <= 15.0:
                return 1.0
            if heat <= 25.0:
                # Linear interpolation: 15→1.0, 25→0.3
                return float(np.interp(heat, [15.0, 25.0], [1.0, 0.3]))
            if heat <= 30.0:
                return 0.1
            return 0.0
        except (TypeError, ValueError):
            logger.error("Invalid heat value for size adjustment: %s", heat)
            return 0.0

    # ------------------------------------------------------------------
    # Sector heat
    # ------------------------------------------------------------------

    def get_sector_heat(self, positions: dict) -> dict:
        """Group positions by sector and return per-sector heat.

        Returns
        -------
        dict
            Mapping of sector -> {"heat": float, "symbols": list, "over_limit": bool}
            plus a ``max_sector_heat`` key.
        """
        with self._lock:
            try:
                sector_heat: Dict[str, Dict] = {}

                for symbol, pos in positions.items():
                    base = _base_symbol(symbol)
                    sector = SECTOR_MAP.get(base, "other")

                    if sector not in sector_heat:
                        sector_heat[sector] = {"heat": 0.0, "symbols": []}

                    # Use pre-computed per-position heat if available,
                    # otherwise approximate with size ratio.
                    pos_heat = float(pos.get("heat", 0.0))
                    sector_heat[sector]["heat"] = round(
                        sector_heat[sector]["heat"] + pos_heat, 4
                    )
                    sector_heat[sector]["symbols"].append(symbol)

                for sector_data in sector_heat.values():
                    sector_data["over_limit"] = sector_data["heat"] > MAX_SECTOR_HEAT

                return {
                    "sectors": sector_heat,
                    "max_sector_heat": MAX_SECTOR_HEAT,
                }
            except Exception as exc:
                logger.exception("Error in get_sector_heat: %s", exc)
                return {"sectors": {}, "max_sector_heat": MAX_SECTOR_HEAT}

    # ------------------------------------------------------------------
    # Reduction advice
    # ------------------------------------------------------------------

    def should_reduce_position(
        self, symbol: str, positions: dict, balance: float
    ) -> dict:
        """Check if *symbol* dominates portfolio heat and suggest reduction.

        If a single position contributes > 40 % of total heat the method
        recommends a partial exit proportional to the excess.

        Returns
        -------
        dict
            reduce, symbol, reduce_pct, reason
        """
        with self._lock:
            try:
                result = self.calculate_heat.__wrapped__(self, positions, balance)  # type: ignore[attr-defined]
            except AttributeError:
                # calculate_heat is not wrapped; call without lock since we
                # already hold it — use an internal unlocked helper instead.
                result = self._calculate_heat_unlocked(positions, balance)

            total_heat = result["heat"]
            heat_map = result["heat_per_position"]

            if total_heat <= 0 or symbol not in heat_map:
                return {
                    "reduce": False,
                    "symbol": symbol,
                    "reduce_pct": 0.0,
                    "reason": "Position not found or zero heat.",
                }

            pos_heat = heat_map[symbol]
            share = pos_heat / total_heat

            if share > DOMINANT_HEAT_THRESHOLD:
                excess = share - DOMINANT_HEAT_THRESHOLD
                reduce_pct = round(min(excess / share * 100.0, 50.0), 2)
                reason = (
                    f"{symbol} contributes {share * 100:.1f}% of total heat "
                    f"({pos_heat:.2f}/{total_heat:.2f}). "
                    f"Recommend reducing by {reduce_pct:.1f}% to rebalance."
                )
                logger.info("Heat reduction suggested: %s", reason)
                return {
                    "reduce": True,
                    "symbol": symbol,
                    "reduce_pct": reduce_pct,
                    "reason": reason,
                }

            return {
                "reduce": False,
                "symbol": symbol,
                "reduce_pct": 0.0,
                "reason": (
                    f"{symbol} heat share is {share * 100:.1f}% — "
                    f"within acceptable range."
                ),
            }

    # ------------------------------------------------------------------
    # Internal helpers (no lock)
    # ------------------------------------------------------------------

    def _calculate_heat_unlocked(self, positions: dict, balance: float) -> dict:
        """Same logic as ``calculate_heat`` but without acquiring the lock.

        Used internally when the lock is already held.
        """
        if balance <= 0:
            return {
                "heat": MAX_HEAT,
                "max_heat": MAX_HEAT,
                "can_add_position": False,
                "heat_per_position": {},
                "recommendation": "Invalid balance — no trading allowed.",
            }

        heat_per_position: Dict[str, float] = {}
        total_heat: float = 0.0

        for symbol, pos in positions.items():
            try:
                size = float(pos.get("size", 0))
                entry = float(pos.get("entry_price", 0))
                stop = float(pos.get("stop_loss", 0))

                if entry <= 0 or size <= 0:
                    heat_per_position[symbol] = 0.0
                    continue

                distance_pct = abs(entry - stop) / entry * 100.0
                position_heat = (size / balance) * distance_pct
                position_heat = float(np.clip(position_heat, 0.0, MAX_HEAT))

                heat_per_position[symbol] = round(position_heat, 4)
                total_heat += position_heat
            except (TypeError, ValueError, ZeroDivisionError) as exc:
                logger.error("Error computing heat for %s: %s", symbol, exc)
                heat_per_position[symbol] = 0.0

        total_heat = round(float(np.clip(total_heat, 0.0, 100.0)), 4)
        can_add = total_heat < MAX_HEAT
        recommendation = self._build_recommendation(total_heat)

        return {
            "heat": total_heat,
            "max_heat": MAX_HEAT,
            "can_add_position": can_add,
            "heat_per_position": heat_per_position,
            "recommendation": recommendation,
        }

    @staticmethod
    def _build_recommendation(heat: float) -> str:
        if heat <= 10.0:
            return "Low heat — portfolio has room for new positions."
        if heat <= 20.0:
            return "Moderate heat — consider tightening stops on existing positions."
        if heat <= MAX_HEAT:
            return "High heat — reduce exposure or wait for exits before adding."
        return "CRITICAL — portfolio heat exceeds maximum. Close positions immediately."


# ---------------------------------------------------------------------------
# Public singleton accessor
# ---------------------------------------------------------------------------

def get_portfolio_heat() -> PortfolioHeat:
    """Return the singleton PortfolioHeat instance."""
    return PortfolioHeat()
