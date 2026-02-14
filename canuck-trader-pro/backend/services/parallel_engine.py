"""
Parallel Processing Manager for KVM8 (8 vCPU)

Maximizes CPU utilization across analysis cycles by distributing work
across thread and process pools.

- Thread pool (8 workers): I/O-bound tasks (API calls, WS fetches, DB writes)
- Process pool (6 workers): CPU-bound tasks (indicators, ML, feature engineering)
- Async priority queue: HIGH (trade decisions), MEDIUM (analysis), LOW (logging)
- Pipeline pattern: fetch -> indicators -> strategies -> ML -> risk check
- Batch processing for multi-pair parallel analysis

Usage:
    from services.parallel_engine import get_parallel_engine

    engine = get_parallel_engine()
    future = engine.submit_io(fetch_candles, "BTCUSD", priority="HIGH")
    result = future.result(timeout=10)
    engine.shutdown()
"""

import logging
import multiprocessing
import os
import queue
import threading
import time
import traceback
from concurrent.futures import (
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    as_completed,
)
from dataclasses import dataclass, field
from enum import IntEnum
from multiprocessing import shared_memory
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
THREAD_WORKERS = 8   # 1 per vCPU — I/O-bound tasks
PROCESS_WORKERS = 6  # Leave 2 cores for main loop + OS — CPU-bound tasks

DEFAULT_IO_TIMEOUT = 30.0     # seconds
DEFAULT_CPU_TIMEOUT = 60.0    # seconds
QUEUE_POLL_INTERVAL = 0.05    # 50ms queue poll
STATS_WINDOW = 300            # 5 minutes for rolling stats


# ---------------------------------------------------------------------------
# Priority levels
# ---------------------------------------------------------------------------
class Priority(IntEnum):
    HIGH = 0    # Trade decisions — processed first
    MEDIUM = 1  # Analysis — standard priority
    LOW = 2     # Logging / metrics — best-effort


_PRIORITY_MAP = {
    "HIGH": Priority.HIGH,
    "MEDIUM": Priority.MEDIUM,
    "LOW": Priority.LOW,
}


def _resolve_priority(p) -> Priority:
    """Accept Priority enum, string, or int."""
    if isinstance(p, Priority):
        return p
    if isinstance(p, str):
        return _PRIORITY_MAP.get(p.upper(), Priority.MEDIUM)
    if isinstance(p, int):
        return Priority(min(max(p, 0), 2))
    return Priority.MEDIUM


# ---------------------------------------------------------------------------
# Queued task wrapper
# ---------------------------------------------------------------------------
@dataclass(order=True)
class QueuedTask:
    """Priority-queue-compatible task wrapper.

    Ordering: lower priority value = higher urgency, then earlier deadline.
    """
    priority: int
    deadline: float                           # unix timestamp; 0 = no deadline
    sequence: int = field(compare=True)       # tiebreaker for FIFO within priority
    fn: Callable = field(compare=False)
    args: tuple = field(default_factory=tuple, compare=False)
    kwargs: dict = field(default_factory=dict, compare=False)
    future: Future = field(default_factory=Future, compare=False)
    callback: Optional[Callable] = field(default=None, compare=False)
    pool: str = field(default="thread", compare=False)  # "thread" or "process"


# ---------------------------------------------------------------------------
# Shared-memory helpers for large DataFrames (process pool)
# ---------------------------------------------------------------------------
class SharedDataFrame:
    """Wrap a numpy array in shared memory for zero-copy IPC.

    Stores the raw float64 buffer + shape so a child process can reconstruct
    the array without pickling the whole DataFrame.
    """

    def __init__(self, arr: np.ndarray):
        self._shape = arr.shape
        self._dtype = arr.dtype
        nbytes = arr.nbytes
        self._shm = shared_memory.SharedMemory(create=True, size=max(nbytes, 1))
        shared_arr = np.ndarray(self._shape, dtype=self._dtype, buffer=self._shm.buf)
        shared_arr[:] = arr[:]
        self.name = self._shm.name

    @property
    def shape(self) -> tuple:
        return self._shape

    @property
    def dtype(self):
        return self._dtype

    def to_numpy(self) -> np.ndarray:
        """Reconstruct array from shared memory (read-only view)."""
        shm = shared_memory.SharedMemory(name=self.name, create=False)
        arr = np.ndarray(self._shape, dtype=self._dtype, buffer=shm.buf).copy()
        shm.close()
        return arr

    def cleanup(self):
        """Release and unlink the shared memory block."""
        try:
            self._shm.close()
            self._shm.unlink()
        except Exception:
            pass


def _reconstruct_shared_array(name: str, shape: tuple, dtype) -> np.ndarray:
    """Reconstruct a numpy array from shared memory in a child process."""
    shm = shared_memory.SharedMemory(name=name, create=False)
    arr = np.ndarray(shape, dtype=dtype, buffer=shm.buf).copy()
    shm.close()
    return arr


# ---------------------------------------------------------------------------
# Top-level helper functions for process pool (must be picklable)
# ---------------------------------------------------------------------------
def _process_wrapper(fn: Callable, args: tuple, kwargs: dict) -> Any:
    """Wrapper executed in child processes."""
    return fn(*args, **kwargs)


def _compute_indicators_for_pair(pair: str, ohlcv: np.ndarray) -> Tuple[str, dict]:
    """Compute a standard set of indicators for one pair.

    Designed to run in a child process. Accepts raw OHLCV numpy array
    with columns: [open, high, low, close, volume].
    Returns (pair, indicators_dict).
    """
    try:
        if ohlcv is None or len(ohlcv) < 5:
            return pair, {"error": "insufficient data"}

        close = ohlcv[:, 3]
        high = ohlcv[:, 1]
        low = ohlcv[:, 2]
        volume = ohlcv[:, 4] if ohlcv.shape[1] > 4 else np.ones(len(close))

        n = len(close)
        result: dict = {}

        # --- SMA ---
        for period in (7, 20, 50):
            if n >= period:
                result[f"sma_{period}"] = float(np.mean(close[-period:]))

        # --- EMA ---
        for period in (9, 21):
            if n >= period:
                multiplier = 2.0 / (period + 1)
                ema = np.empty(n)
                ema[0] = close[0]
                for i in range(1, n):
                    ema[i] = close[i] * multiplier + ema[i - 1] * (1 - multiplier)
                result[f"ema_{period}"] = float(ema[-1])

        # --- RSI (14) ---
        period = 14
        if n > period:
            deltas = np.diff(close)
            gains = np.where(deltas > 0, deltas, 0.0)
            losses = np.where(deltas < 0, -deltas, 0.0)
            avg_gain = np.mean(gains[-period:])
            avg_loss = np.mean(losses[-period:])
            if avg_loss > 0:
                rs = avg_gain / avg_loss
                result["rsi_14"] = float(100.0 - 100.0 / (1.0 + rs))
            else:
                result["rsi_14"] = 100.0

        # --- ATR (14) ---
        if n > period:
            tr = np.maximum(
                high[1:] - low[1:],
                np.maximum(
                    np.abs(high[1:] - close[:-1]),
                    np.abs(low[1:] - close[:-1]),
                ),
            )
            result["atr_14"] = float(np.mean(tr[-period:]))

        # --- VWAP ---
        if n >= 1 and np.sum(volume) > 0:
            typical = (high + low + close) / 3.0
            cum_tp_vol = np.cumsum(typical * volume)
            cum_vol = np.cumsum(volume)
            mask = cum_vol > 0
            if np.any(mask):
                result["vwap"] = float(cum_tp_vol[-1] / cum_vol[-1])

        # --- Bollinger Bands (20, 2) ---
        bb_period = 20
        if n >= bb_period:
            sma = np.mean(close[-bb_period:])
            std = np.std(close[-bb_period:], ddof=1)
            result["bb_upper"] = float(sma + 2.0 * std)
            result["bb_lower"] = float(sma - 2.0 * std)
            result["bb_middle"] = float(sma)

        # --- MACD (12, 26, 9) ---
        if n >= 26:
            def _ema_arr(data, span):
                m = 2.0 / (span + 1)
                out = np.empty(len(data))
                out[0] = data[0]
                for i in range(1, len(data)):
                    out[i] = data[i] * m + out[i - 1] * (1 - m)
                return out

            ema12 = _ema_arr(close, 12)
            ema26 = _ema_arr(close, 26)
            macd_line = ema12 - ema26
            signal_line = _ema_arr(macd_line, 9)
            result["macd"] = float(macd_line[-1])
            result["macd_signal"] = float(signal_line[-1])
            result["macd_histogram"] = float(macd_line[-1] - signal_line[-1])

        # --- Volume stats ---
        if n >= 20:
            result["volume_sma_20"] = float(np.mean(volume[-20:]))
            result["volume_ratio"] = float(
                volume[-1] / np.mean(volume[-20:])
            ) if np.mean(volume[-20:]) > 0 else 1.0

        result["last_close"] = float(close[-1])
        result["candle_count"] = n

        return pair, result
    except Exception as exc:
        return pair, {"error": str(exc)}


def _run_strategy_for_pair(pair: str, indicators: dict, config: dict) -> Tuple[str, dict]:
    """Run strategy evaluation for one pair in a child process.

    Returns (pair, signal_dict) with action, confidence, and reasoning.
    """
    try:
        result: dict = {"pair": pair, "action": "HOLD", "confidence": 0.0, "reasons": []}

        close = indicators.get("last_close", 0)
        rsi = indicators.get("rsi_14")
        macd_hist = indicators.get("macd_histogram")
        bb_upper = indicators.get("bb_upper")
        bb_lower = indicators.get("bb_lower")
        ema_9 = indicators.get("ema_9")
        ema_21 = indicators.get("ema_21")
        volume_ratio = indicators.get("volume_ratio", 1.0)

        buy_score = 0.0
        sell_score = 0.0
        reasons: list = []

        # RSI signal
        if rsi is not None:
            if rsi < 30:
                buy_score += 25
                reasons.append(f"RSI oversold ({rsi:.1f})")
            elif rsi > 70:
                sell_score += 25
                reasons.append(f"RSI overbought ({rsi:.1f})")

        # MACD signal
        if macd_hist is not None:
            if macd_hist > 0:
                buy_score += 15
                reasons.append("MACD bullish")
            else:
                sell_score += 15
                reasons.append("MACD bearish")

        # Bollinger Band signal
        if bb_lower is not None and bb_upper is not None and close > 0:
            if close <= bb_lower:
                buy_score += 20
                reasons.append("Price at lower BB")
            elif close >= bb_upper:
                sell_score += 20
                reasons.append("Price at upper BB")

        # EMA crossover
        if ema_9 is not None and ema_21 is not None:
            if ema_9 > ema_21:
                buy_score += 15
                reasons.append("EMA 9 > 21 (bullish)")
            else:
                sell_score += 15
                reasons.append("EMA 9 < 21 (bearish)")

        # Volume confirmation
        if volume_ratio > 1.5:
            buy_score *= 1.2
            sell_score *= 1.2
            reasons.append(f"High volume ({volume_ratio:.1f}x)")

        # Determine action
        min_confidence = config.get("min_confidence", 40)
        if buy_score > sell_score and buy_score >= min_confidence:
            result["action"] = "BUY"
            result["confidence"] = round(min(buy_score, 100), 1)
        elif sell_score > buy_score and sell_score >= min_confidence:
            result["action"] = "SELL"
            result["confidence"] = round(min(sell_score, 100), 1)
        else:
            result["action"] = "HOLD"
            result["confidence"] = round(max(buy_score, sell_score), 1)

        result["reasons"] = reasons
        result["buy_score"] = round(buy_score, 1)
        result["sell_score"] = round(sell_score, 1)

        return pair, result
    except Exception as exc:
        return pair, {"pair": pair, "action": "HOLD", "confidence": 0, "error": str(exc)}


# ---------------------------------------------------------------------------
# ParallelEngine
# ---------------------------------------------------------------------------
class ParallelEngine:
    """Manages thread and process pools with priority task queue.

    Optimized for KVM8's 8 vCPU:
      - 8 I/O threads (API, WS, DB)
      - 6 CPU processes (indicators, ML, features)
      - Priority queue with deadline support
      - Pipeline chaining across stages
    """

    def __init__(
        self,
        thread_workers: int = THREAD_WORKERS,
        process_workers: int = PROCESS_WORKERS,
    ):
        self._thread_workers = thread_workers
        self._process_workers = process_workers

        # Pools
        self._thread_pool: Optional[ThreadPoolExecutor] = None
        self._process_pool: Optional[ProcessPoolExecutor] = None

        # Priority queue + dispatcher thread
        self._task_queue: queue.PriorityQueue[QueuedTask] = queue.PriorityQueue()
        self._sequence_counter = 0
        self._seq_lock = threading.Lock()

        self._dispatcher_thread: Optional[threading.Thread] = None
        self._running = False

        # Shared memory registry (for cleanup)
        self._shared_blocks: List[SharedDataFrame] = []
        self._shared_lock = threading.Lock()

        # Stats
        self._stats_lock = threading.Lock()
        self._tasks_submitted = 0
        self._tasks_completed = 0
        self._tasks_failed = 0
        self._tasks_skipped = 0  # past deadline
        self._task_latencies: List[float] = []
        self._start_time = time.time()

        # Start pools and dispatcher
        self._start()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def _start(self):
        """Initialize pools and start the queue dispatcher."""
        logger.info(
            "ParallelEngine starting: %d I/O threads, %d CPU processes",
            self._thread_workers,
            self._process_workers,
        )

        self._thread_pool = ThreadPoolExecutor(
            max_workers=self._thread_workers,
            thread_name_prefix="pe-io",
        )
        self._process_pool = ProcessPoolExecutor(
            max_workers=self._process_workers,
        )

        self._running = True
        self._dispatcher_thread = threading.Thread(
            target=self._dispatch_loop,
            name="pe-dispatcher",
            daemon=True,
        )
        self._dispatcher_thread.start()
        logger.info("ParallelEngine ready")

    def shutdown(self, wait: bool = True, timeout: float = 10.0):
        """Gracefully shut down all pools and the dispatcher.

        Drains the queue, waits for running tasks up to *timeout* seconds,
        then force-terminates remaining work.
        """
        logger.info("ParallelEngine shutting down (wait=%s, timeout=%.1fs)", wait, timeout)
        self._running = False

        # Wake up the dispatcher so it exits
        if self._dispatcher_thread and self._dispatcher_thread.is_alive():
            self._dispatcher_thread.join(timeout=timeout)

        # Shutdown pools
        if self._thread_pool:
            self._thread_pool.shutdown(wait=wait)
            self._thread_pool = None

        if self._process_pool:
            self._process_pool.shutdown(wait=wait)
            self._process_pool = None

        # Cleanup shared memory
        with self._shared_lock:
            for shm in self._shared_blocks:
                shm.cleanup()
            self._shared_blocks.clear()

        logger.info(
            "ParallelEngine shutdown complete. "
            "Submitted=%d, Completed=%d, Failed=%d, Skipped=%d",
            self._tasks_submitted,
            self._tasks_completed,
            self._tasks_failed,
            self._tasks_skipped,
        )

    # ------------------------------------------------------------------
    # Queue dispatcher
    # ------------------------------------------------------------------
    def _dispatch_loop(self):
        """Background thread that pulls tasks from the priority queue
        and dispatches them to the appropriate pool."""
        while self._running:
            try:
                task: QueuedTask = self._task_queue.get(timeout=QUEUE_POLL_INTERVAL)
            except queue.Empty:
                continue

            # Deadline check
            if task.deadline > 0 and time.time() > task.deadline:
                with self._stats_lock:
                    self._tasks_skipped += 1
                task.future.set_exception(
                    TimeoutError(f"Task past deadline by {time.time() - task.deadline:.2f}s")
                )
                logger.debug("Skipped expired task (priority=%d)", task.priority)
                continue

            # Submit to appropriate pool
            try:
                pool = self._thread_pool if task.pool == "thread" else self._process_pool
                if pool is None:
                    task.future.set_exception(RuntimeError("Pool not available"))
                    continue

                submit_time = time.time()

                if task.pool == "process":
                    internal_future = pool.submit(
                        _process_wrapper, task.fn, task.args, task.kwargs
                    )
                else:
                    internal_future = pool.submit(task.fn, *task.args, **task.kwargs)

                # Chain result to the external future
                def _on_done(f, ext_future=task.future, cb=task.callback, t0=submit_time):
                    elapsed = time.time() - t0
                    with self._stats_lock:
                        self._task_latencies.append(elapsed)
                        if len(self._task_latencies) > 1000:
                            self._task_latencies = self._task_latencies[-500:]

                    exc = f.exception()
                    if exc:
                        with self._stats_lock:
                            self._tasks_failed += 1
                        if not ext_future.done():
                            ext_future.set_exception(exc)
                    else:
                        with self._stats_lock:
                            self._tasks_completed += 1
                        result = f.result()
                        if not ext_future.done():
                            ext_future.set_result(result)
                        # Invoke callback
                        if cb is not None:
                            try:
                                cb(result)
                            except Exception:
                                logger.warning("Task callback error", exc_info=True)

                internal_future.add_done_callback(_on_done)

            except Exception as exc:
                with self._stats_lock:
                    self._tasks_failed += 1
                if not task.future.done():
                    task.future.set_exception(exc)
                logger.error("Dispatch error: %s", exc)

        # Drain remaining queue items on shutdown
        drained = 0
        while not self._task_queue.empty():
            try:
                task = self._task_queue.get_nowait()
                if not task.future.done():
                    task.future.set_exception(RuntimeError("Engine shutting down"))
                drained += 1
            except queue.Empty:
                break
        if drained:
            logger.info("Drained %d remaining tasks from queue on shutdown", drained)

    # ------------------------------------------------------------------
    # Submit helpers
    # ------------------------------------------------------------------
    def _next_seq(self) -> int:
        with self._seq_lock:
            self._sequence_counter += 1
            return self._sequence_counter

    def submit_io(
        self,
        fn: Callable,
        *args: Any,
        priority: str = "MEDIUM",
        deadline: float = 0.0,
        callback: Optional[Callable] = None,
        **kwargs: Any,
    ) -> Future:
        """Submit an I/O-bound task to the thread pool.

        Args:
            fn: The callable to execute.
            *args: Positional arguments for *fn*.
            priority: "HIGH", "MEDIUM", or "LOW".
            deadline: Unix timestamp; task is skipped if past this time.
                      0 means no deadline.
            callback: Optional callback invoked with the result on success.
            **kwargs: Keyword arguments for *fn*.

        Returns:
            A Future whose result will be set when the task completes.
        """
        p = _resolve_priority(priority)
        future: Future = Future()
        task = QueuedTask(
            priority=int(p),
            deadline=deadline,
            sequence=self._next_seq(),
            fn=fn,
            args=args,
            kwargs=kwargs,
            future=future,
            callback=callback,
            pool="thread",
        )
        with self._stats_lock:
            self._tasks_submitted += 1
        self._task_queue.put(task)
        return future

    def submit_cpu(
        self,
        fn: Callable,
        *args: Any,
        callback: Optional[Callable] = None,
        **kwargs: Any,
    ) -> Future:
        """Submit a CPU-bound task to the process pool.

        The function *fn* and all arguments must be picklable (top-level
        functions, not lambdas or closures).

        Args:
            fn: Picklable callable to execute in a child process.
            *args: Positional arguments.
            callback: Optional callback invoked with the result on success.
            **kwargs: Keyword arguments.

        Returns:
            A Future whose result will be set when the task completes.
        """
        future: Future = Future()
        task = QueuedTask(
            priority=int(Priority.MEDIUM),
            deadline=0.0,
            sequence=self._next_seq(),
            fn=fn,
            args=args,
            kwargs=kwargs,
            future=future,
            callback=callback,
            pool="process",
        )
        with self._stats_lock:
            self._tasks_submitted += 1
        self._task_queue.put(task)
        return future

    # ------------------------------------------------------------------
    # Batch / map operations
    # ------------------------------------------------------------------
    def map_parallel(
        self,
        fn: Callable,
        items: Sequence,
        pool: str = "thread",
        timeout: Optional[float] = None,
    ) -> List[Any]:
        """Apply *fn* to each item in *items* using the specified pool.

        Args:
            fn: Callable that takes one positional argument.
            items: Iterable of arguments.
            pool: "thread" for I/O work, "process" for CPU work.
            timeout: Max seconds to wait for all results.

        Returns:
            List of results in the same order as *items*.
        """
        if pool == "process" and self._process_pool:
            executor = self._process_pool
        elif self._thread_pool:
            executor = self._thread_pool
        else:
            raise RuntimeError("Pools not initialized")

        futures_map: Dict[Future, int] = {}
        for idx, item in enumerate(items):
            if pool == "process":
                f = executor.submit(_process_wrapper, fn, (item,), {})
            else:
                f = executor.submit(fn, item)
            futures_map[f] = idx

        results = [None] * len(items)
        effective_timeout = timeout or (DEFAULT_CPU_TIMEOUT if pool == "process" else DEFAULT_IO_TIMEOUT)

        for f in as_completed(futures_map, timeout=effective_timeout):
            idx = futures_map[f]
            try:
                results[idx] = f.result()
            except Exception as exc:
                logger.warning("map_parallel item %d failed: %s", idx, exc)
                results[idx] = exc

        return results

    # ------------------------------------------------------------------
    # Batch processing — multi-pair analysis
    # ------------------------------------------------------------------
    def fetch_market_data_parallel(
        self,
        symbols: List[str],
        fetch_fn: Callable[[str], Any],
        timeout: float = DEFAULT_IO_TIMEOUT,
    ) -> Dict[str, Any]:
        """Fetch market data for all symbols concurrently via thread pool.

        Args:
            symbols: List of trading pair symbols (e.g. ["BTCUSD", "ETHUSD"]).
            fetch_fn: Callable that takes a symbol string and returns market data.
            timeout: Max seconds to wait for all fetches.

        Returns:
            Dict mapping symbol -> fetched data (or Exception on failure).
        """
        if not self._thread_pool:
            raise RuntimeError("Thread pool not initialized")

        futures: Dict[Future, str] = {}
        for sym in symbols:
            f = self._thread_pool.submit(fetch_fn, sym)
            futures[f] = sym

        results: Dict[str, Any] = {}
        for f in as_completed(futures, timeout=timeout):
            sym = futures[f]
            try:
                results[sym] = f.result()
            except Exception as exc:
                logger.warning("fetch_market_data_parallel %s failed: %s", sym, exc)
                results[sym] = exc

        return results

    def compute_indicators_parallel(
        self,
        pairs_data: Dict[str, np.ndarray],
        timeout: float = DEFAULT_CPU_TIMEOUT,
    ) -> Dict[str, dict]:
        """Compute indicators for all pairs using the process pool.

        Args:
            pairs_data: Dict mapping pair name to OHLCV numpy array with
                        columns [open, high, low, close, volume].
            timeout: Max seconds to wait.

        Returns:
            Dict mapping pair name to indicators dict.
        """
        if not self._process_pool:
            raise RuntimeError("Process pool not initialized")

        futures: Dict[Future, str] = {}
        for pair, ohlcv in pairs_data.items():
            f = self._process_pool.submit(_compute_indicators_for_pair, pair, ohlcv)
            futures[f] = pair

        results: Dict[str, dict] = {}
        for f in as_completed(futures, timeout=timeout):
            pair_key = futures[f]
            try:
                returned_pair, indicators = f.result()
                results[returned_pair] = indicators
            except Exception as exc:
                logger.warning("compute_indicators_parallel %s failed: %s", pair_key, exc)
                results[pair_key] = {"error": str(exc)}

        return results

    def analyze_pairs_parallel(
        self,
        pairs_data: Dict[str, np.ndarray],
        config: Optional[dict] = None,
        timeout: float = DEFAULT_CPU_TIMEOUT,
    ) -> Dict[str, dict]:
        """Full parallel analysis: compute indicators then run strategies.

        Runs indicator computation across all pairs in the process pool,
        then runs strategy evaluation across all pairs in the process pool.

        Args:
            pairs_data: Dict mapping pair name to OHLCV numpy array.
            config: Optional strategy configuration dict.
            timeout: Max seconds for each stage.

        Returns:
            Dict mapping pair name to analysis result with keys:
                indicators, signal, action, confidence, reasons.
        """
        cfg = config or {}

        # Stage 1: Compute indicators for all pairs in parallel
        logger.debug("analyze_pairs_parallel: computing indicators for %d pairs", len(pairs_data))
        t0 = time.time()
        all_indicators = self.compute_indicators_parallel(pairs_data, timeout=timeout)
        t_ind = time.time() - t0
        logger.debug("Indicators computed in %.3fs", t_ind)

        # Stage 2: Run strategy evaluation in parallel
        if not self._process_pool:
            raise RuntimeError("Process pool not initialized")

        futures: Dict[Future, str] = {}
        for pair, indicators in all_indicators.items():
            if "error" in indicators:
                continue
            f = self._process_pool.submit(_run_strategy_for_pair, pair, indicators, cfg)
            futures[f] = pair

        signals: Dict[str, dict] = {}
        for f in as_completed(futures, timeout=timeout):
            pair_key = futures[f]
            try:
                returned_pair, signal = f.result()
                signals[returned_pair] = signal
            except Exception as exc:
                logger.warning("Strategy eval %s failed: %s", pair_key, exc)
                signals[pair_key] = {"action": "HOLD", "confidence": 0, "error": str(exc)}

        t_total = time.time() - t0
        logger.info(
            "analyze_pairs_parallel: %d pairs in %.3fs (indicators=%.3fs, strategies=%.3fs)",
            len(pairs_data), t_total, t_ind, t_total - t_ind,
        )

        # Merge indicators + signals
        combined: Dict[str, dict] = {}
        for pair in pairs_data:
            combined[pair] = {
                "indicators": all_indicators.get(pair, {}),
                "signal": signals.get(pair, {"action": "HOLD", "confidence": 0}),
                "action": signals.get(pair, {}).get("action", "HOLD"),
                "confidence": signals.get(pair, {}).get("confidence", 0),
                "reasons": signals.get(pair, {}).get("reasons", []),
            }

        return combined

    # ------------------------------------------------------------------
    # Pipeline pattern
    # ------------------------------------------------------------------
    def run_pipeline(
        self,
        symbols: List[str],
        stages: List[Dict[str, Any]],
        timeout_per_stage: float = 30.0,
    ) -> Dict[str, Any]:
        """Execute a multi-stage pipeline across symbols.

        Each stage is a dict:
            {
                "name": "compute_indicators",
                "fn": callable(symbol, prev_result) -> result,
                "pool": "thread" | "process",
            }

        Data flows from one stage to the next: stage N receives the output
        of stage N-1 for each symbol.

        Args:
            symbols: List of symbols to process.
            stages: Ordered list of stage definitions.
            timeout_per_stage: Max seconds per stage.

        Returns:
            Dict mapping symbol -> final stage result.
        """
        # Initial data: just the symbol name
        current_data: Dict[str, Any] = {s: s for s in symbols}

        for stage_def in stages:
            stage_name = stage_def.get("name", "unnamed")
            stage_fn = stage_def["fn"]
            pool_type = stage_def.get("pool", "thread")

            logger.debug("Pipeline stage '%s' starting (%d symbols)", stage_name, len(current_data))
            t0 = time.time()

            executor = (
                self._process_pool if pool_type == "process" else self._thread_pool
            )
            if executor is None:
                raise RuntimeError(f"Pool '{pool_type}' not available for stage '{stage_name}'")

            futures: Dict[Future, str] = {}
            for sym, prev_result in current_data.items():
                if pool_type == "process":
                    f = executor.submit(_process_wrapper, stage_fn, (sym, prev_result), {})
                else:
                    f = executor.submit(stage_fn, sym, prev_result)
                futures[f] = sym

            next_data: Dict[str, Any] = {}
            for f in as_completed(futures, timeout=timeout_per_stage):
                sym = futures[f]
                try:
                    next_data[sym] = f.result()
                except Exception as exc:
                    logger.warning(
                        "Pipeline stage '%s' failed for %s: %s", stage_name, sym, exc
                    )
                    next_data[sym] = {"error": str(exc), "stage": stage_name}

            elapsed = time.time() - t0
            logger.debug("Pipeline stage '%s' completed in %.3fs", stage_name, elapsed)
            current_data = next_data

        return current_data

    # ------------------------------------------------------------------
    # Shared memory management
    # ------------------------------------------------------------------
    def share_dataframe(self, arr: np.ndarray) -> SharedDataFrame:
        """Place a numpy array into shared memory for process-pool access.

        The caller is responsible for calling cleanup() on the returned
        SharedDataFrame when done, or it will be cleaned up on shutdown.
        """
        sdf = SharedDataFrame(arr)
        with self._shared_lock:
            self._shared_blocks.append(sdf)
        return sdf

    # ------------------------------------------------------------------
    # Monitoring / status
    # ------------------------------------------------------------------
    def get_utilization(self) -> dict:
        """Return CPU usage per core, thread/process pool counts."""
        try:
            import psutil
            cpu_per_core = psutil.cpu_percent(interval=0.1, percpu=True)
            cpu_avg = psutil.cpu_percent(interval=0)
            mem = psutil.virtual_memory()
            memory_info = {
                "total_gb": round(mem.total / (1024 ** 3), 2),
                "used_gb": round(mem.used / (1024 ** 3), 2),
                "percent": mem.percent,
            }
        except ImportError:
            cpu_per_core = []
            cpu_avg = 0.0
            memory_info = {}

        # Thread pool active count
        thread_active = 0
        if self._thread_pool:
            # ThreadPoolExecutor tracks _work_queue size
            try:
                thread_active = self._thread_pool._work_queue.qsize()
            except Exception:
                pass

        # Process pool active
        process_active = 0
        if self._process_pool:
            try:
                process_active = len(self._process_pool._processes)
            except Exception:
                pass

        return {
            "cpu_per_core": cpu_per_core,
            "cpu_average": cpu_avg,
            "memory": memory_info,
            "thread_pool": {
                "max_workers": self._thread_workers,
                "queued_tasks": thread_active,
            },
            "process_pool": {
                "max_workers": self._process_workers,
                "active_processes": process_active,
            },
            "task_queue_depth": self._task_queue.qsize(),
        }

    def get_status(self) -> dict:
        """Return engine status and performance stats."""
        with self._stats_lock:
            latencies = list(self._task_latencies)
            submitted = self._tasks_submitted
            completed = self._tasks_completed
            failed = self._tasks_failed
            skipped = self._tasks_skipped

        avg_latency = float(np.mean(latencies)) if latencies else 0.0
        p50_latency = float(np.percentile(latencies, 50)) if latencies else 0.0
        p95_latency = float(np.percentile(latencies, 95)) if latencies else 0.0
        p99_latency = float(np.percentile(latencies, 99)) if latencies else 0.0

        uptime = time.time() - self._start_time
        throughput = completed / uptime if uptime > 0 else 0.0

        return {
            "running": self._running,
            "uptime_seconds": round(uptime, 1),
            "thread_workers": self._thread_workers,
            "process_workers": self._process_workers,
            "tasks": {
                "submitted": submitted,
                "completed": completed,
                "failed": failed,
                "skipped_deadline": skipped,
                "in_queue": self._task_queue.qsize(),
                "success_rate": round(
                    completed / max(submitted, 1) * 100, 1
                ),
            },
            "latency": {
                "avg_ms": round(avg_latency * 1000, 2),
                "p50_ms": round(p50_latency * 1000, 2),
                "p95_ms": round(p95_latency * 1000, 2),
                "p99_ms": round(p99_latency * 1000, 2),
                "samples": len(latencies),
            },
            "throughput_per_sec": round(throughput, 2),
            "shared_memory_blocks": len(self._shared_blocks),
        }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
_instance: Optional[ParallelEngine] = None
_instance_lock = threading.Lock()


def get_parallel_engine() -> ParallelEngine:
    """Return the singleton ParallelEngine instance.

    Thread-safe via double-checked locking.
    """
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = ParallelEngine()
    return _instance
