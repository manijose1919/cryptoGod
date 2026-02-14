"""
Redis Caching Service with graceful in-memory fallback.

Provides a unified caching layer for the trading backend. When Redis is
available (localhost:6379, 2GB maxmemory), it uses Redis. When Redis is
unavailable or the library is not installed, it falls back to a thread-safe
in-memory dictionary with TTL support.

Usage:
    from services.redis_cache import get_redis_cache

    cache = get_redis_cache()
    cache.set("candles:BTCUSD:1m", candle_data, ttl=10)
    data = cache.get("candles:BTCUSD:1m")
    data = cache.get_or_compute("features:BTCUSD", compute_fn, ttl=5)
"""

import json
import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Try importing redis; set a flag so we know whether the library exists.
# ---------------------------------------------------------------------------
try:
    import redis as _redis_lib
    REDIS_LIB_AVAILABLE = True
except ImportError:
    _redis_lib = None  # type: ignore[assignment]
    REDIS_LIB_AVAILABLE = False

# ---------------------------------------------------------------------------
# Default TTLs by key prefix (seconds)
# ---------------------------------------------------------------------------
DEFAULT_TTLS: Dict[str, int] = {
    "candles":     10,
    "features":     5,
    "predictions": 15,
    "sentiment":  300,
    "orderbook":    3,
    "indicators":  10,
    "portfolio":    5,
}


def _ttl_for_key(key: str) -> int:
    """Return the default TTL for a key based on its prefix, or 60s."""
    prefix = key.split(":")[0] if ":" in key else key
    return DEFAULT_TTLS.get(prefix, 60)


# ---------------------------------------------------------------------------
# JSON encoder that handles numpy types
# ---------------------------------------------------------------------------
class _NumpyEncoder(json.JSONEncoder):
    """JSON encoder that converts numpy types to Python natives."""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, (np.bool_,)):
            return bool(obj)
        return super().default(obj)


def _serialize(value: Any) -> str:
    """Serialize a Python object to a JSON string."""
    return json.dumps(value, cls=_NumpyEncoder)


def _deserialize(raw: str) -> Any:
    """Deserialize a JSON string back to a Python object."""
    return json.loads(raw)


# ---------------------------------------------------------------------------
# In-memory fallback store (thread-safe, TTL-aware)
# ---------------------------------------------------------------------------
class _MemoryStore:
    """Thread-safe in-memory dict with per-key TTL expiration."""

    def __init__(self) -> None:
        self._data: Dict[str, Tuple[str, float]] = {}  # key -> (json_str, expiry_ts)
        self._lock = threading.Lock()

    # -- helpers --

    def _is_expired(self, expiry: float) -> bool:
        return time.monotonic() > expiry

    def _evict_expired(self) -> None:
        """Remove all expired entries (call under lock)."""
        now = time.monotonic()
        expired = [k for k, (_, exp) in self._data.items() if now > exp]
        for k in expired:
            del self._data[k]

    # -- public API matching the subset we need --

    def get(self, key: str) -> Optional[str]:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            raw, expiry = entry
            if self._is_expired(expiry):
                del self._data[key]
                return None
            return raw

    def set(self, key: str, value: str, ex: int = 60) -> None:
        with self._lock:
            self._data[key] = (value, time.monotonic() + ex)

    def delete(self, *keys: str) -> int:
        removed = 0
        with self._lock:
            for k in keys:
                if k in self._data:
                    del self._data[k]
                    removed += 1
        return removed

    def keys(self, pattern: str = "*") -> List[str]:
        """Return keys matching a simple glob pattern (supports * only)."""
        import fnmatch
        with self._lock:
            self._evict_expired()
            return [k for k in self._data if fnmatch.fnmatch(k, pattern)]

    def mget(self, keys: List[str]) -> List[Optional[str]]:
        return [self.get(k) for k in keys]

    def pipeline(self) -> "_MemoryPipeline":
        return _MemoryPipeline(self)

    def dbsize(self) -> int:
        with self._lock:
            self._evict_expired()
            return len(self._data)

    def ping(self) -> bool:
        return True


class _MemoryPipeline:
    """Minimal pipeline emulation for the in-memory store."""

    def __init__(self, store: _MemoryStore) -> None:
        self._store = store
        self._ops: List[Callable[[], Any]] = []

    def set(self, key: str, value: str, ex: int = 60) -> "_MemoryPipeline":
        self._ops.append(lambda k=key, v=value, e=ex: self._store.set(k, v, ex=e))
        return self

    def execute(self) -> List[Any]:
        results = []
        for op in self._ops:
            results.append(op())
        self._ops.clear()
        return results


# ---------------------------------------------------------------------------
# Main cache service
# ---------------------------------------------------------------------------
class RedisCache:
    """
    Caching layer backed by Redis (preferred) or an in-memory dict (fallback).

    Thread-safe. All values are JSON-serialized before storage so complex
    Python objects (dicts, lists, numpy arrays) are handled transparently.
    """

    def __init__(self) -> None:
        self._backend: str = "memory"
        self._store: Any = None  # redis.Redis or _MemoryStore
        self._lock = threading.Lock()

        # hit / miss counters
        self._hits: int = 0
        self._misses: int = 0
        self._counter_lock = threading.Lock()

        self._connect()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _connect(self) -> None:
        """Attempt Redis connection; fall back to memory on any failure."""
        if not REDIS_LIB_AVAILABLE:
            logger.info("redis-py not installed -- using in-memory cache fallback")
            self._store = _MemoryStore()
            self._backend = "memory"
            return

        try:
            client = _redis_lib.Redis(
                host="localhost",
                port=6379,
                db=0,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=1,
                retry_on_timeout=True,
            )
            client.ping()

            # Configure maxmemory (2 GB) with allkeys-lru eviction so Redis
            # never exceeds the budget on the 32 GB KVM8.
            try:
                client.config_set("maxmemory", "2gb")
                client.config_set("maxmemory-policy", "allkeys-lru")
            except _redis_lib.ResponseError:
                # May lack CONFIG permission in managed Redis; that is fine.
                pass

            self._store = client
            self._backend = "redis"
            logger.info("Redis cache connected (localhost:6379, 2 GB limit)")

        except Exception as exc:
            logger.warning("Redis unavailable (%s) -- using in-memory cache fallback", exc)
            self._store = _MemoryStore()
            self._backend = "memory"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _record_hit(self) -> None:
        with self._counter_lock:
            self._hits += 1

    def _record_miss(self) -> None:
        with self._counter_lock:
            self._misses += 1

    def _safe(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """
        Execute *fn* against the store.  If Redis raises a connection error,
        transparently switch to the memory backend and retry once.
        """
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            if self._backend == "redis":
                logger.warning("Redis error (%s) -- switching to in-memory fallback", exc)
                with self._lock:
                    if self._backend == "redis":  # double-check under lock
                        self._store = _MemoryStore()
                        self._backend = "memory"
                # Retry on the new backend
                return fn(*args, **kwargs)
            raise

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: str) -> Optional[Any]:
        """Return the cached value for *key*, or ``None`` on miss."""
        raw = self._safe(self._store.get, key)
        if raw is None:
            self._record_miss()
            return None
        self._record_hit()
        return _deserialize(raw)

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """Cache *value* under *key* with a TTL in seconds.

        If *ttl* is ``None`` the default for the key prefix is used (see
        ``DEFAULT_TTLS``), falling back to 60 s.
        """
        if ttl is None:
            ttl = _ttl_for_key(key)
        raw = _serialize(value)
        self._safe(self._store.set, key, raw, ex=ttl)

    def get_or_compute(
        self,
        key: str,
        compute_fn: Callable[[], Any],
        ttl: Optional[int] = None,
    ) -> Any:
        """Return cached value for *key*; on miss call *compute_fn*, cache and return it."""
        cached = self.get(key)
        if cached is not None:
            return cached
        value = compute_fn()
        self.set(key, value, ttl=ttl)
        return value

    def invalidate(self, pattern: str) -> int:
        """Delete all keys matching *pattern* (glob-style). Returns count deleted."""
        keys = self._safe(self._store.keys, pattern)
        if not keys:
            return 0
        return self._safe(self._store.delete, *keys)

    # ------------------------------------------------------------------
    # Batch operations
    # ------------------------------------------------------------------

    def batch_get(self, keys: List[str]) -> Dict[str, Any]:
        """Get multiple keys at once. Returns ``{key: value}`` for hits only."""
        raw_values = self._safe(self._store.mget, keys)
        result: Dict[str, Any] = {}
        for key, raw in zip(keys, raw_values):
            if raw is not None:
                self._record_hit()
                result[key] = _deserialize(raw)
            else:
                self._record_miss()
        return result

    def batch_set(self, items: Dict[str, Any], ttl: Optional[int] = None) -> None:
        """Set multiple key-value pairs. Per-key default TTL is used when *ttl* is ``None``."""
        pipe = self._safe(self._store.pipeline)
        for key, value in items.items():
            effective_ttl = ttl if ttl is not None else _ttl_for_key(key)
            raw = _serialize(value)
            pipe.set(key, raw, ex=effective_ttl)
        self._safe(pipe.execute)

    # ------------------------------------------------------------------
    # Status / monitoring
    # ------------------------------------------------------------------

    def get_status(self) -> Dict[str, Any]:
        """Return cache health information."""
        with self._counter_lock:
            total = self._hits + self._misses
            hit_rate = (self._hits / total) if total > 0 else 0.0
            hits = self._hits
            misses = self._misses

        try:
            key_count = self._store.dbsize()
        except Exception:
            key_count = -1

        return {
            "backend": self._backend,
            "keys": key_count,
            "hit_rate": round(hit_rate, 4),
            "hits": hits,
            "misses": misses,
            "total_requests": hits + misses,
        }

    def reset_stats(self) -> None:
        """Reset hit/miss counters."""
        with self._counter_lock:
            self._hits = 0
            self._misses = 0

    # ------------------------------------------------------------------
    # Convenience: typed helpers for common key patterns
    # ------------------------------------------------------------------

    def get_candles(self, symbol: str, timeframe: str) -> Optional[Any]:
        return self.get(f"candles:{symbol}:{timeframe}")

    def set_candles(self, symbol: str, timeframe: str, data: Any) -> None:
        self.set(f"candles:{symbol}:{timeframe}", data, ttl=DEFAULT_TTLS["candles"])

    def get_features(self, symbol: str) -> Optional[Any]:
        return self.get(f"features:{symbol}")

    def set_features(self, symbol: str, data: Any) -> None:
        self.set(f"features:{symbol}", data, ttl=DEFAULT_TTLS["features"])

    def get_predictions(self, symbol: str) -> Optional[Any]:
        return self.get(f"predictions:{symbol}")

    def set_predictions(self, symbol: str, data: Any) -> None:
        self.set(f"predictions:{symbol}", data, ttl=DEFAULT_TTLS["predictions"])

    def get_sentiment(self, symbol: str) -> Optional[Any]:
        return self.get(f"sentiment:{symbol}")

    def set_sentiment(self, symbol: str, data: Any) -> None:
        self.set(f"sentiment:{symbol}", data, ttl=DEFAULT_TTLS["sentiment"])

    def get_orderbook(self, symbol: str) -> Optional[Any]:
        return self.get(f"orderbook:{symbol}")

    def set_orderbook(self, symbol: str, data: Any) -> None:
        self.set(f"orderbook:{symbol}", data, ttl=DEFAULT_TTLS["orderbook"])

    def get_indicators(self, symbol: str, timeframe: str) -> Optional[Any]:
        return self.get(f"indicators:{symbol}:{timeframe}")

    def set_indicators(self, symbol: str, timeframe: str, data: Any) -> None:
        self.set(f"indicators:{symbol}:{timeframe}", data, ttl=DEFAULT_TTLS["indicators"])

    def get_portfolio(self) -> Optional[Any]:
        return self.get("portfolio:state")

    def set_portfolio(self, data: Any) -> None:
        self.set("portfolio:state", data, ttl=DEFAULT_TTLS["portfolio"])

    def invalidate_symbol(self, symbol: str) -> int:
        """Purge every cached entry for *symbol* across all prefixes."""
        total = 0
        for prefix in DEFAULT_TTLS:
            total += self.invalidate(f"{prefix}:{symbol}*")
        return total


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
_instance: Optional[RedisCache] = None
_instance_lock = threading.Lock()


def get_redis_cache() -> RedisCache:
    """Return the singleton ``RedisCache`` instance (lazy-initialized)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = RedisCache()
    return _instance
