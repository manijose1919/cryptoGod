"""
SQLite Database Service
Persistent storage for trades, learning data, candle history, and settings.
Port of services/database.js using Python stdlib sqlite3.
"""

import sqlite3
import os
import logging
import time
import json
from pathlib import Path

logger = logging.getLogger("database")

_db: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized. Call initialize_database() first.")
    return _db


def initialize_database(data_dir: str | None = None) -> sqlite3.Connection:
    global _db

    if data_dir is None:
        data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
    Path(data_dir).mkdir(parents=True, exist_ok=True)

    db_path = os.path.join(data_dir, "trading.db")
    _db = sqlite3.connect(db_path, check_same_thread=False)
    _db.row_factory = sqlite3.Row

    # Enable WAL mode
    _db.execute("PRAGMA journal_mode = WAL")
    _db.execute("PRAGMA foreign_keys = ON")

    _db.executescript("""
        -- Core trade history
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            strategy TEXT NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            quantity REAL NOT NULL,
            pnl REAL,
            pnl_percent REAL,
            outcome TEXT CHECK(outcome IN ('WIN','LOSS','BREAKEVEN')),
            reason TEXT,
            entry_time INTEGER NOT NULL,
            exit_time INTEGER,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Candle history for backtesting
        CREATE TABLE IF NOT EXISTS candle_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            UNIQUE(ticker, timeframe, time)
        );
        CREATE INDEX IF NOT EXISTS idx_candle_lookup
            ON candle_history(ticker, timeframe, time);

        -- AI learning trade memory
        CREATE TABLE IF NOT EXISTS trade_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            strategy TEXT NOT NULL,
            entry_price REAL,
            exit_price REAL,
            entry_time INTEGER,
            exit_time INTEGER,
            pnl REAL,
            pnl_percent REAL,
            outcome TEXT CHECK(outcome IN ('WIN','LOSS','BREAKEVEN')),
            hold_duration REAL,
            market_volatility TEXT,
            market_trend TEXT,
            market_volume TEXT,
            tc_value REAL,
            momentum_value REAL,
            whale_value REAL,
            confluence_score REAL,
            ai_analysis TEXT,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Learned patterns from AI analysis
        CREATE TABLE IF NOT EXISTS learned_patterns (
            id TEXT PRIMARY KEY,
            description TEXT,
            tc_range_low REAL,
            tc_range_high REAL,
            momentum_range_low REAL,
            momentum_range_high REAL,
            volatility TEXT,
            trend TEXT,
            success_rate REAL,
            sample_size INTEGER,
            recommendation TEXT,
            updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Parameter adjustment history
        CREATE TABLE IF NOT EXISTS parameter_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            params_json TEXT NOT NULL,
            win_rate REAL,
            profit_factor REAL,
            total_trades INTEGER,
            reason TEXT,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Trading sessions
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time INTEGER NOT NULL,
            end_time INTEGER,
            initial_budget REAL,
            final_value REAL,
            total_trades INTEGER DEFAULT 0,
            win_rate REAL,
            pnl REAL,
            notes TEXT
        );

        -- Sentiment snapshots
        CREATE TABLE IF NOT EXISTS sentiment_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            source TEXT NOT NULL,
            score REAL,
            raw_data TEXT,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_sentiment_lookup
            ON sentiment_snapshots(ticker, created_at);

        -- System activity logs
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time INTEGER NOT NULL,
            message TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Key-value settings store
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        );

        -- Performance indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_trades_ticker
            ON trades(ticker, created_at);
        CREATE INDEX IF NOT EXISTS idx_trades_strategy
            ON trades(strategy, created_at);
        CREATE INDEX IF NOT EXISTS idx_trades_outcome
            ON trades(outcome, created_at);
        CREATE INDEX IF NOT EXISTS idx_trade_memory_ticker
            ON trade_memory(ticker, created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_start
            ON sessions(start_time);
        CREATE INDEX IF NOT EXISTS idx_system_logs_time
            ON system_logs(time);
        CREATE INDEX IF NOT EXISTS idx_parameter_history_created
            ON parameter_history(created_at);
    """)

    logger.info(f"Initialized SQLite at {db_path}")
    return _db


def close_database():
    global _db
    if _db:
        _db.close()
        _db = None
        logger.info("Database connection closed")


# ============================================
# TRADES
# ============================================

def insert_trade(trade: dict) -> int:
    db = get_db()
    cur = db.execute(
        """INSERT INTO trades (ticker, strategy, entry_price, exit_price, quantity,
           pnl, pnl_percent, outcome, reason, entry_time, exit_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            trade["ticker"], trade["strategy"], trade["entry_price"],
            trade.get("exit_price"), trade["quantity"],
            trade.get("pnl"), trade.get("pnl_percent"),
            trade.get("outcome"), trade.get("reason"),
            trade["entry_time"], trade.get("exit_time"),
        ),
    )
    db.commit()
    return cur.lastrowid


def get_trades(limit: int = 500, offset: int = 0, strategy: str | None = None) -> list[dict]:
    db = get_db()
    if strategy:
        rows = db.execute(
            "SELECT * FROM trades WHERE strategy = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (strategy, limit, offset),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM trades ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_trade_count(strategy: str | None = None) -> int:
    db = get_db()
    if strategy:
        return db.execute("SELECT COUNT(*) as count FROM trades WHERE strategy = ?", (strategy,)).fetchone()["count"]
    return db.execute("SELECT COUNT(*) as count FROM trades").fetchone()["count"]


# ============================================
# TRADE MEMORY (AI Learning)
# ============================================

def insert_trade_memory(memory: dict) -> int:
    db = get_db()
    cur = db.execute(
        """INSERT INTO trade_memory (ticker, strategy, entry_price, exit_price,
           entry_time, exit_time, pnl, pnl_percent, outcome, hold_duration,
           market_volatility, market_trend, market_volume,
           tc_value, momentum_value, whale_value, confluence_score, ai_analysis)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            memory["ticker"], memory["strategy"],
            memory.get("entry_price"), memory.get("exit_price"),
            memory.get("entry_time"), memory.get("exit_time"),
            memory.get("pnl"), memory.get("pnl_percent"),
            memory.get("outcome"), memory.get("hold_duration"),
            memory.get("market_volatility"), memory.get("market_trend"),
            memory.get("market_volume"), memory.get("tc_value"),
            memory.get("momentum_value"), memory.get("whale_value"),
            memory.get("confluence_score"), memory.get("ai_analysis"),
        ),
    )
    db.commit()
    return cur.lastrowid


def get_trade_memories(limit: int = 500) -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM trade_memory ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


# ============================================
# LEARNED PATTERNS
# ============================================

def upsert_learned_pattern(pattern: dict):
    db = get_db()
    now_ms = int(time.time() * 1000)
    db.execute(
        """INSERT INTO learned_patterns (id, description, tc_range_low, tc_range_high,
           momentum_range_low, momentum_range_high, volatility, trend,
           success_rate, sample_size, recommendation, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             description = excluded.description,
             tc_range_low = excluded.tc_range_low,
             tc_range_high = excluded.tc_range_high,
             momentum_range_low = excluded.momentum_range_low,
             momentum_range_high = excluded.momentum_range_high,
             volatility = excluded.volatility,
             trend = excluded.trend,
             success_rate = excluded.success_rate,
             sample_size = excluded.sample_size,
             recommendation = excluded.recommendation,
             updated_at = excluded.updated_at""",
        (
            pattern["id"], pattern.get("description", ""),
            pattern.get("tc_range_low", 0), pattern.get("tc_range_high", 100),
            pattern.get("momentum_range_low", 0), pattern.get("momentum_range_high", 100),
            pattern.get("volatility", ""), pattern.get("trend", ""),
            pattern.get("success_rate", 0), pattern.get("sample_size", 0),
            pattern.get("recommendation", "AVOID"), now_ms,
        ),
    )
    db.commit()


def get_learned_patterns() -> list[dict]:
    db = get_db()
    rows = db.execute("SELECT * FROM learned_patterns ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


# ============================================
# PARAMETER HISTORY
# ============================================

def insert_parameter_snapshot(snapshot: dict) -> int:
    db = get_db()
    cur = db.execute(
        """INSERT INTO parameter_history (params_json, win_rate, profit_factor, total_trades, reason)
           VALUES (?, ?, ?, ?, ?)""",
        (
            snapshot["params_json"], snapshot.get("win_rate"),
            snapshot.get("profit_factor"), snapshot.get("total_trades"),
            snapshot.get("reason"),
        ),
    )
    db.commit()
    return cur.lastrowid


def get_parameter_history(limit: int = 50) -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM parameter_history ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def get_latest_parameters() -> dict | None:
    db = get_db()
    row = db.execute(
        "SELECT * FROM parameter_history ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


# ============================================
# SESSIONS
# ============================================

def insert_session(session: dict) -> int:
    db = get_db()
    cur = db.execute(
        """INSERT INTO sessions (start_time, initial_budget, notes)
           VALUES (?, ?, ?)""",
        (session["start_time"], session.get("initial_budget", 0), session.get("notes")),
    )
    db.commit()
    return cur.lastrowid


def update_session(session_id: int, updates: dict):
    db = get_db()
    db.execute(
        """UPDATE sessions SET end_time = ?, final_value = ?,
           total_trades = ?, win_rate = ?, pnl = ?
           WHERE id = ?""",
        (
            updates.get("end_time"), updates.get("final_value"),
            updates.get("total_trades", 0), updates.get("win_rate"),
            updates.get("pnl"), session_id,
        ),
    )
    db.commit()


def get_sessions(limit: int = 50) -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


# ============================================
# CANDLE HISTORY
# ============================================

def insert_candles_batch(candles: list[dict]):
    db = get_db()
    db.executemany(
        """INSERT OR IGNORE INTO candle_history (ticker, timeframe, time, open, high, low, close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                c["ticker"], c["timeframe"], c["time"],
                c["open"], c["high"], c["low"], c["close"], c["volume"],
            )
            for c in candles
        ],
    )
    db.commit()


def get_candles(
    ticker: str, timeframe: str,
    start: int | None = None, end: int | None = None,
    limit: int = 1000,
) -> list[dict]:
    db = get_db()
    query = "SELECT * FROM candle_history WHERE ticker = ? AND timeframe = ?"
    params: list = [ticker, timeframe]

    if start is not None:
        query += " AND time >= ?"
        params.append(start)
    if end is not None:
        query += " AND time <= ?"
        params.append(end)

    query += " ORDER BY time ASC LIMIT ?"
    params.append(limit)

    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def get_candle_count(ticker: str, timeframe: str) -> int:
    db = get_db()
    return db.execute(
        "SELECT COUNT(*) as count FROM candle_history WHERE ticker = ? AND timeframe = ?",
        (ticker, timeframe),
    ).fetchone()["count"]


# ============================================
# SENTIMENT SNAPSHOTS
# ============================================

def insert_sentiment_snapshot(snapshot: dict) -> int:
    db = get_db()
    raw = snapshot.get("raw_data")
    if raw and not isinstance(raw, str):
        raw = json.dumps(raw)
    cur = db.execute(
        """INSERT INTO sentiment_snapshots (ticker, source, score, raw_data)
           VALUES (?, ?, ?, ?)""",
        (snapshot["ticker"], snapshot["source"], snapshot.get("score"), raw),
    )
    db.commit()
    return cur.lastrowid


def get_sentiment_history(ticker: str, hours: int = 24) -> list[dict]:
    db = get_db()
    cutoff = int(time.time() * 1000) - (hours * 3600 * 1000)
    rows = db.execute(
        "SELECT * FROM sentiment_snapshots WHERE ticker = ? AND created_at > ? ORDER BY created_at ASC",
        (ticker, cutoff),
    ).fetchall()
    return [dict(r) for r in rows]


# ============================================
# SYSTEM LOGS
# ============================================

def insert_system_log(log: dict):
    db = get_db()
    db.execute(
        "INSERT INTO system_logs (time, message, type) VALUES (?, ?, ?)",
        (log["time"], log["message"], log["type"]),
    )
    db.commit()


def get_system_logs(limit: int = 100) -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT * FROM system_logs ORDER BY time DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


# ============================================
# SETTINGS
# ============================================

def set_setting(key: str, value: str):
    db = get_db()
    now_ms = int(time.time() * 1000)
    db.execute(
        """INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (key, value, now_ms),
    )
    db.commit()


def get_setting(key: str) -> str | None:
    db = get_db()
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def get_all_settings() -> list[dict]:
    db = get_db()
    rows = db.execute("SELECT * FROM settings ORDER BY key").fetchall()
    return [dict(r) for r in rows]


# ============================================
# MAINTENANCE
# ============================================

def cleanup_old_data(days: int = 30):
    """Remove data older than N days. Call weekly."""
    db = get_db()
    cutoff_ms = int((time.time() - days * 86400) * 1000)
    tables_cols = [
        ("candle_history", "time"),
        ("sentiment_snapshots", "created_at"),
        ("system_logs", "created_at"),
    ]
    total = 0
    for table, col in tables_cols:
        cur = db.execute(f"DELETE FROM {table} WHERE {col} < ?", (cutoff_ms,))
        total += cur.rowcount
    db.commit()
    if total > 0:
        db.execute("PRAGMA optimize")
        logger.info(f"Cleaned {total} old rows (>{days}d)")
    return total


def get_db_stats() -> dict:
    """Return row counts for monitoring."""
    db = get_db()
    stats = {}
    for table in ["trades", "candle_history", "trade_memory", "sessions", "sentiment_snapshots", "system_logs"]:
        try:
            stats[table] = db.execute(f"SELECT COUNT(*) as c FROM {table}").fetchone()["c"]
        except Exception:
            stats[table] = 0
    return stats


def vacuum_database():
    """Run VACUUM to reclaim space and optimize. Call weekly."""
    db = get_db()
    try:
        # WAL checkpoint first
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # VACUUM requires no active transactions
        db.execute("VACUUM")
        # Re-analyze for query planner
        db.execute("ANALYZE")
        logger.info("Database VACUUM + ANALYZE completed")
    except Exception as e:
        logger.error(f"Database vacuum error: {e}")


def backup_database():
    """Create a timestamped backup of the database. Call daily."""
    import shutil
    try:
        db_path = Path(_data_dir) / DB_NAME if _data_dir else Path("data") / DB_NAME
        backup_dir = db_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)

        # Timestamped backup
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"trading_{timestamp}.db"

        # WAL checkpoint before backup
        db = get_db()
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        shutil.copy2(str(db_path), str(backup_path))
        logger.info(f"Database backed up to {backup_path}")

        # Keep only last 7 backups
        backups = sorted(backup_dir.glob("trading_*.db"))
        for old_backup in backups[:-7]:
            old_backup.unlink()
            logger.debug(f"Removed old backup: {old_backup}")

    except Exception as e:
        logger.error(f"Database backup error: {e}")
