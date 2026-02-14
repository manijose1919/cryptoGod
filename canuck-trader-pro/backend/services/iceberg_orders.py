"""
Iceberg Order Splitting Service

Splits large orders into smaller randomized chunks with jittered timing
to reduce market impact and avoid detection by other algorithms.
"""

import logging
import time
import random
from typing import Optional

logger = logging.getLogger("iceberg_orders")

# Configuration
MIN_CHUNK_USD = 5.0          # Minimum chunk size
MAX_CHUNKS = 10              # Maximum number of splits
SIZE_JITTER = 0.3            # ±30% randomization on chunk sizes
DELAY_BASE_SEC = 0.5         # Base delay between chunks
DELAY_JITTER_SEC = 1.0       # Random additional delay
LARGE_ORDER_THRESHOLD = 100  # Orders above this USD get split


class IcebergSplitter:
    """Splits large orders into smaller chunks."""

    def __init__(self):
        self._total_orders_split = 0
        self._total_chunks_executed = 0

    def should_split(self, size_usd: float) -> bool:
        """Determine if an order should be split."""
        return size_usd > LARGE_ORDER_THRESHOLD

    def plan_chunks(self, size_usd: float, price: float) -> list[dict]:
        """Plan how to split an order into chunks.

        Returns list of {size_usd, delay_sec, chunk_num}.
        """
        if not self.should_split(size_usd):
            return [{"size_usd": size_usd, "delay_sec": 0, "chunk_num": 1}]

        # Calculate number of chunks
        n_chunks = min(MAX_CHUNKS, max(2, int(size_usd / 50)))

        base_chunk = size_usd / n_chunks
        chunks = []
        remaining = size_usd

        for i in range(n_chunks):
            if i == n_chunks - 1:
                # Last chunk gets whatever remains
                chunk_size = remaining
            else:
                # Randomize chunk size ±30%
                jitter = 1.0 + random.uniform(-SIZE_JITTER, SIZE_JITTER)
                chunk_size = base_chunk * jitter
                chunk_size = max(MIN_CHUNK_USD, min(chunk_size, remaining - MIN_CHUNK_USD * (n_chunks - i - 1)))

            delay = 0 if i == 0 else DELAY_BASE_SEC + random.uniform(0, DELAY_JITTER_SEC)

            chunks.append({
                "size_usd": round(chunk_size, 2),
                "delay_sec": round(delay, 2),
                "chunk_num": i + 1,
            })
            remaining -= chunk_size

        self._total_orders_split += 1
        self._total_chunks_executed += len(chunks)

        logger.debug(f"Order ${size_usd:.2f} split into {len(chunks)} chunks: {[c['size_usd'] for c in chunks]}")
        return chunks

    def execute_split_order(
        self,
        risk_manager,
        symbol: str,
        entry_price: float,
        total_size_usd: float,
        stop_price: float,
        target_price: float,
        side: str,
    ) -> dict:
        """Execute a split order by opening position in chunks.

        In paper trading, this simulates the splitting by adjusting the
        average entry price slightly (simulating small slippage per chunk).
        """
        chunks = self.plan_chunks(total_size_usd, entry_price)

        if len(chunks) == 1:
            # No splitting needed
            risk_manager.open_position(symbol, entry_price, total_size_usd, stop_price, target_price, side)
            return {
                "split": False,
                "chunks": 1,
                "total_size": total_size_usd,
                "avg_price": entry_price,
            }

        # Simulate price impact per chunk
        # Each chunk moves price slightly against us
        impact_per_chunk = 0.0001  # 0.01% per chunk (very small)
        total_cost = 0.0
        total_qty = 0.0

        for chunk in chunks:
            # Simulate small price movement between chunks
            chunk_idx = chunk["chunk_num"] - 1
            if side == "BUY":
                chunk_price = entry_price * (1 + impact_per_chunk * chunk_idx)
            else:
                chunk_price = entry_price * (1 - impact_per_chunk * chunk_idx)

            qty = chunk["size_usd"] / chunk_price
            total_cost += chunk["size_usd"]
            total_qty += qty

        avg_price = total_cost / total_qty if total_qty > 0 else entry_price

        # Open single position at average price (paper trading simplification)
        risk_manager.open_position(symbol, avg_price, total_size_usd, stop_price, target_price, side)

        return {
            "split": True,
            "chunks": len(chunks),
            "total_size": round(total_size_usd, 2),
            "avg_price": round(avg_price, 6),
            "price_impact_pct": round(abs(avg_price - entry_price) / entry_price * 100, 4),
            "chunk_sizes": [c["size_usd"] for c in chunks],
        }

    def get_status(self) -> dict:
        return {
            "total_orders_split": self._total_orders_split,
            "total_chunks_executed": self._total_chunks_executed,
            "threshold_usd": LARGE_ORDER_THRESHOLD,
            "max_chunks": MAX_CHUNKS,
        }


# Singleton
_instance: Optional[IcebergSplitter] = None


def get_iceberg_splitter() -> IcebergSplitter:
    global _instance
    if _instance is None:
        _instance = IcebergSplitter()
    return _instance
