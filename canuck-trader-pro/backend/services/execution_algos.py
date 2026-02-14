"""
TWAP / VWAP Execution Algorithms

Splits large orders into smaller slices to minimize market impact.
- TWAP: Time-Weighted Average Price - equal slices at regular intervals
- VWAP: Volume-Weighted Average Price - size slices proportional to expected volume

Both track execution quality vs benchmark for reporting.
"""
import logging
import time
from enum import Enum
from typing import Callable, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)


class ExecAlgo(str, Enum):
    TWAP = "TWAP"
    VWAP = "VWAP"


class ExecutionOrder:
    """Represents a parent order being executed via slicing algorithm."""

    def __init__(
        self,
        symbol: str,
        side: str,
        total_usd: float,
        algo: ExecAlgo,
        n_slices: int = 5,
        duration_seconds: float = 60,
        volume_profile: Optional[list] = None,
    ):
        self.symbol = symbol
        self.side = side
        self.total_usd = total_usd
        self.algo = algo
        self.n_slices = max(2, n_slices)
        self.duration = duration_seconds
        self.volume_profile = volume_profile  # for VWAP: expected volume per slice

        self.created_at = time.time()
        self.slices: List[dict] = []
        self.filled_slices: List[dict] = []
        self.current_slice_idx = 0
        self.completed = False
        self.cancelled = False

        # Compute slice schedule
        self._compute_slices()

    def _compute_slices(self):
        """Compute the execution schedule."""
        interval = self.duration / self.n_slices

        if self.algo == ExecAlgo.TWAP:
            # Equal slices
            slice_usd = self.total_usd / self.n_slices
            for i in range(self.n_slices):
                self.slices.append({
                    "idx": i,
                    "target_usd": round(slice_usd, 2),
                    "scheduled_time": self.created_at + i * interval,
                    "status": "PENDING",
                })
        elif self.algo == ExecAlgo.VWAP:
            # Size proportional to volume profile
            if self.volume_profile and len(self.volume_profile) >= self.n_slices:
                profile = self.volume_profile[:self.n_slices]
            else:
                # Default volume profile: U-shape (higher at open/close)
                profile = self._default_volume_profile(self.n_slices)

            total_weight = sum(profile)
            for i in range(self.n_slices):
                weight = profile[i] / total_weight if total_weight > 0 else 1.0 / self.n_slices
                self.slices.append({
                    "idx": i,
                    "target_usd": round(self.total_usd * weight, 2),
                    "scheduled_time": self.created_at + i * interval,
                    "weight": round(weight, 4),
                    "status": "PENDING",
                })

    def _default_volume_profile(self, n: int) -> list:
        """Generate default U-shaped volume profile (higher at start/end)."""
        x = np.linspace(0, np.pi, n)
        profile = 1.5 - np.cos(x)  # U-shape
        return profile.tolist()

    def get_next_slice(self) -> Optional[dict]:
        """Get the next slice to execute, if it's time."""
        now = time.time()
        for s in self.slices:
            if s["status"] == "PENDING" and now >= s["scheduled_time"]:
                return s
        return None

    def fill_slice(self, idx: int, fill_price: float, fill_usd: float):
        """Record a filled slice."""
        for s in self.slices:
            if s["idx"] == idx:
                s["status"] = "FILLED"
                s["fill_price"] = fill_price
                s["fill_usd"] = fill_usd
                s["fill_time"] = time.time()
                self.filled_slices.append(s)
                break

        # Check if all done
        if all(s["status"] == "FILLED" for s in self.slices):
            self.completed = True

    def get_execution_quality(self, benchmark_vwap: Optional[float] = None) -> dict:
        """Compute execution quality metrics."""
        if not self.filled_slices:
            return {"status": "NO_FILLS"}

        prices = [s["fill_price"] for s in self.filled_slices]
        sizes = [s["fill_usd"] for s in self.filled_slices]
        total_filled = sum(sizes)

        # Execution VWAP
        exec_vwap = sum(p * s for p, s in zip(prices, sizes)) / total_filled if total_filled > 0 else 0

        result = {
            "algo": self.algo.value,
            "slices_filled": len(self.filled_slices),
            "slices_total": self.n_slices,
            "total_filled_usd": round(total_filled, 2),
            "total_target_usd": round(self.total_usd, 2),
            "exec_vwap": round(exec_vwap, 6),
            "avg_price": round(np.mean(prices), 6),
            "price_range": round(max(prices) - min(prices), 6),
            "completed": self.completed,
        }

        # Slippage vs benchmark
        if benchmark_vwap and benchmark_vwap > 0:
            if self.side == "BUY":
                slippage_bps = (exec_vwap - benchmark_vwap) / benchmark_vwap * 10000
            else:
                slippage_bps = (benchmark_vwap - exec_vwap) / benchmark_vwap * 10000
            result["slippage_bps"] = round(slippage_bps, 2)
            result["benchmark_vwap"] = round(benchmark_vwap, 6)

        return result

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "algo": self.algo.value,
            "total_usd": self.total_usd,
            "n_slices": self.n_slices,
            "duration": self.duration,
            "slices": self.slices,
            "filled": len(self.filled_slices),
            "completed": self.completed,
            "cancelled": self.cancelled,
            "quality": self.get_execution_quality(),
        }


class ExecutionManager:
    """Manages active execution orders."""

    def __init__(self):
        self.active_orders: Dict[str, ExecutionOrder] = {}  # symbol -> order
        self.completed_orders: List[dict] = []
        self._max_completed = 100

    def create_order(
        self,
        symbol: str,
        side: str,
        total_usd: float,
        algo: ExecAlgo = ExecAlgo.TWAP,
        n_slices: int = 5,
        duration_seconds: float = 60,
    ) -> ExecutionOrder:
        """Create a new execution order.

        For small orders (<$100), use single fill instead of slicing.
        """
        if total_usd < 100:
            n_slices = 1
            duration_seconds = 0

        order = ExecutionOrder(
            symbol=symbol,
            side=side,
            total_usd=total_usd,
            algo=algo,
            n_slices=n_slices,
            duration_seconds=duration_seconds,
        )
        self.active_orders[symbol] = order
        logger.info(f"Execution order: {algo.value} {side} {symbol} ${total_usd:.2f} in {n_slices} slices over {duration_seconds}s")
        return order

    def process_slices(self, current_prices: Dict[str, float]) -> List[dict]:
        """Process pending slices for all active orders. Returns list of fills to execute."""
        fills_to_execute = []

        for symbol, order in list(self.active_orders.items()):
            if order.completed or order.cancelled:
                self._archive_order(symbol)
                continue

            price = current_prices.get(symbol)
            if not price:
                continue

            next_slice = order.get_next_slice()
            if next_slice:
                fills_to_execute.append({
                    "symbol": symbol,
                    "side": order.side,
                    "usd": next_slice["target_usd"],
                    "slice_idx": next_slice["idx"],
                    "price": price,
                    "algo": order.algo.value,
                })
                # Auto-fill (in paper mode, fill immediately)
                order.fill_slice(next_slice["idx"], price, next_slice["target_usd"])

        return fills_to_execute

    def _archive_order(self, symbol: str):
        """Move completed order to history."""
        order = self.active_orders.pop(symbol, None)
        if order:
            self.completed_orders.append(order.to_dict())
            if len(self.completed_orders) > self._max_completed:
                self.completed_orders.pop(0)

    def cancel_order(self, symbol: str) -> bool:
        """Cancel an active execution order."""
        if symbol in self.active_orders:
            self.active_orders[symbol].cancelled = True
            self._archive_order(symbol)
            return True
        return False

    def get_status(self) -> dict:
        return {
            "active_orders": {s: o.to_dict() for s, o in self.active_orders.items()},
            "completed_count": len(self.completed_orders),
            "recent_completed": self.completed_orders[-5:],
        }


# Module-level singleton
_exec_manager: Optional[ExecutionManager] = None


def get_execution_manager() -> ExecutionManager:
    global _exec_manager
    if _exec_manager is None:
        _exec_manager = ExecutionManager()
    return _exec_manager
