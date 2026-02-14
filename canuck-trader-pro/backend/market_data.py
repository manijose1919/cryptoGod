"""
Market Data Fetcher
Uses ccxt to pull OHLCV candles from Crypto.com exchange.
Persists candles to SQLite for backtesting and MTF cache.
"""
import logging
import time
from typing import Dict, List, Optional

import ccxt
import pandas as pd

import config

logger = logging.getLogger(__name__)

_db_available = False
try:
    from services import database_service as db_svc
    _db_available = True
except Exception:
    pass


class MarketData:
    """Fetches and caches OHLCV data from Crypto.com via ccxt."""

    def __init__(self):
        exchange_config = {"enableRateLimit": True}
        if config.CRYPTO_COM_API_KEY:
            exchange_config["apiKey"] = config.CRYPTO_COM_API_KEY
            exchange_config["secret"] = config.CRYPTO_COM_SECRET
        self.exchange = ccxt.cryptocom(exchange_config)

        # Cache: { "BTC/USD:5m": (timestamp, DataFrame) }
        self._cache: Dict[str, tuple] = {}
        self._cache_ttl = 5  # seconds

    def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = config.DEFAULT_TIMEFRAME,
        limit: int = config.CANDLE_LIMIT,
    ) -> Optional[pd.DataFrame]:
        """Fetch OHLCV candles, returns DataFrame with columns: timestamp, open, high, low, close, volume."""
        cache_key = f"{symbol}:{timeframe}"
        now = time.time()

        # Return cached if fresh
        if cache_key in self._cache:
            cached_time, cached_df = self._cache[cache_key]
            if now - cached_time < self._cache_ttl:
                return cached_df

        try:
            raw = self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            if not raw:
                logger.warning(f"No data returned for {symbol} {timeframe}")
                return None

            df = pd.DataFrame(raw, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
            df = df.astype({
                "open": float, "high": float, "low": float,
                "close": float, "volume": float,
            })
            self._cache[cache_key] = (now, df)

            # Persist to SQLite for backtesting / MTF cache
            self._persist_candles(symbol, timeframe, df)

            return df

        except ccxt.NetworkError as e:
            logger.error(f"Network error fetching {symbol}: {e}")
        except ccxt.ExchangeError as e:
            logger.error(f"Exchange error fetching {symbol}: {e}")
        except Exception as e:
            logger.error(f"Unexpected error fetching {symbol}: {e}")
        return None

    def fetch_ticker(self, symbol: str) -> Optional[dict]:
        """Fetch current ticker (bid, ask, last, volume)."""
        try:
            return self.exchange.fetch_ticker(symbol)
        except Exception as e:
            logger.error(f"Error fetching ticker {symbol}: {e}")
            return None

    def fetch_all_pairs(self, timeframe: str = config.DEFAULT_TIMEFRAME) -> Dict[str, pd.DataFrame]:
        """Fetch OHLCV for all configured pairs. Returns {symbol: DataFrame}."""
        results = {}
        for symbol in config.PAIRS:
            df = self.fetch_ohlcv(symbol, timeframe)
            if df is not None and len(df) >= 20:
                results[symbol] = df
            else:
                logger.warning(f"Skipping {symbol}: insufficient data")
        return results

    def _persist_candles(self, symbol: str, timeframe: str, df: pd.DataFrame):
        """Save candles to SQLite (non-blocking, best-effort)."""
        if not _db_available:
            return
        try:
            # Convert symbol format: "BTC/USD" -> "BTCUSD"
            ticker = symbol.replace("/", "")
            rows = []
            for _, row in df.iterrows():
                ts = int(row["timestamp"].timestamp() * 1000)
                rows.append({
                    "ticker": ticker, "timeframe": timeframe, "time": ts,
                    "open": row["open"], "high": row["high"], "low": row["low"],
                    "close": row["close"], "volume": row["volume"],
                })
            db_svc.insert_candles_batch(rows)
        except Exception as e:
            logger.debug(f"Candle persist error (non-critical): {e}")

    def fetch_candles_from_db(
        self, symbol: str, timeframe: str, limit: int = 500,
    ) -> Optional[pd.DataFrame]:
        """Load historical candles from DB (for backtesting or MTF)."""
        if not _db_available:
            return None
        try:
            ticker = symbol.replace("/", "")
            rows = db_svc.get_candles(ticker, timeframe, limit=limit)
            if not rows or len(rows) < 20:
                return None
            df = pd.DataFrame(rows)
            df["timestamp"] = pd.to_datetime(df["time"], unit="ms")
            df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype({
                "open": float, "high": float, "low": float,
                "close": float, "volume": float,
            })
            return df
        except Exception as e:
            logger.debug(f"DB candle load error: {e}")
            return None

    def backfill_historical(self, timeframes: List[str] | None = None, limit: int = 500):
        """Backfill historical candles from exchange into DB on startup.

        Only fetches data for symbol/timeframe combos that are missing or sparse.
        """
        if not _db_available:
            logger.info("DB not available, skipping backfill")
            return

        timeframes = timeframes or ["5m", "15m", "1h"]
        filled = 0

        for symbol in config.PAIRS:
            ticker = symbol.replace("/", "")
            for tf in timeframes:
                try:
                    existing = db_svc.get_candle_count(ticker, tf)
                    if existing >= limit * 0.8:
                        continue  # Already have enough data

                    logger.info(f"Backfilling {symbol} {tf} ({existing} existing, fetching {limit})")
                    df = self.fetch_ohlcv(symbol, tf, limit=limit)
                    if df is not None and len(df) > 0:
                        self._persist_candles(symbol, tf, df)
                        filled += len(df)
                        time.sleep(0.5)  # Rate limit
                except Exception as e:
                    logger.warning(f"Backfill error {symbol} {tf}: {e}")

        if filled > 0:
            logger.info(f"Backfilled {filled} candles across {len(config.PAIRS)} pairs")

    def get_current_prices(self) -> Dict[str, float]:
        """Get latest price for all pairs."""
        prices = {}
        for symbol in config.PAIRS:
            ticker = self.fetch_ticker(symbol)
            if ticker and ticker.get("last"):
                prices[symbol] = float(ticker["last"])
        return prices
