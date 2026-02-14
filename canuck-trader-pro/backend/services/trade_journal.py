"""
Trade Journal & Analytics Service

Comprehensive post-mortem analysis of every trade and session.

Features:
  - Full-context trade recording with auto-tagging (WIN/LOSS, QUICK/SLOW, etc.)
  - Auto-generated session summaries every 20 trades
  - Per-strategy, per-asset, per-regime P&L breakdowns
  - Recurring loss-pattern detection (wrong regime, oversize, bad timing)
  - Time-of-day performance heat map
  - Actionable recommendations from historical data
  - Risk-adjusted statistics: Sharpe, Sortino, Calmar

Thread-safe via threading.Lock on all mutable state.
Persists to SQLite ``trade_journal`` / ``journal_entries`` tables.
"""

import json
import logging
import math
import sqlite3
import threading
import time
import uuid
from collections import defaultdict
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TRADES_PER_SESSION_SUMMARY = 20
QUICK_TRADE_SECONDS = 300        # < 5 min
SLOW_TRADE_SECONDS = 3600        # > 1 hour
LARGE_TRADE_PNL_THRESHOLD = 0.5  # absolute PnL > 0.5 % of entry
TRADING_FEE_ROUND_TRIP = 0.0015  # 0.15 %

# Tags
TAG_WIN = "WIN"
TAG_LOSS = "LOSS"
TAG_BREAKEVEN = "BREAKEVEN"
TAG_QUICK = "QUICK"
TAG_SLOW = "SLOW"
TAG_LARGE = "LARGE"
TAG_SMALL = "SMALL"
TAG_TREND = "TREND"
TAG_COUNTER_TREND = "COUNTER_TREND"

# Loss-pattern labels
LOSS_ENTRY_TOO_EARLY = "ENTRY_TOO_EARLY"
LOSS_EXIT_TOO_LATE = "EXIT_TOO_LATE"
LOSS_WRONG_REGIME = "WRONG_REGIME"
LOSS_OVERSIZE = "OVERSIZE"
LOSS_AGAINST_TREND = "AGAINST_TREND"
LOSS_LOW_CONFIDENCE = "LOW_CONFIDENCE"
LOSS_HIGH_VOLATILITY = "HIGH_VOLATILITY"


# ---------------------------------------------------------------------------
# Helper: safe division
# ---------------------------------------------------------------------------

def _safe_div(a: float, b: float, default: float = 0.0) -> float:
    return a / b if b != 0 else default


# ---------------------------------------------------------------------------
# TradeJournal
# ---------------------------------------------------------------------------

class TradeJournal:
    """Singleton trade journal with SQLite persistence and analytics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._trades: list[dict] = []
        self._journal_entries: list[dict] = []
        self._session_trade_counter = 0
        self._current_session_id: Optional[str] = None
        self._db: Optional[sqlite3.Connection] = None
        self._initialized = False
        self._peak_equity = 0.0
        self._equity_curve: list[float] = []
        logger.info("TradeJournal created (not yet initialised)")

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def initialize(self, db: Optional[sqlite3.Connection] = None) -> None:
        """Create tables.  Accepts an existing connection or opens the shared one."""
        with self._lock:
            if self._initialized:
                return
            if db is not None:
                self._db = db
            else:
                try:
                    from services.database_service import get_db
                    self._db = get_db()
                except Exception:
                    logger.warning("database_service unavailable; journal is memory-only")
            if self._db is not None:
                self._ensure_tables()
                self._load_from_db()
            self._initialized = True
            logger.info("TradeJournal initialised (%d trades loaded)", len(self._trades))

    def _ensure_tables(self) -> None:
        assert self._db is not None
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS trade_journal (
                id TEXT PRIMARY KEY,
                ticker TEXT NOT NULL,
                strategy TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL,
                quantity REAL NOT NULL,
                pnl REAL,
                pnl_percent REAL,
                fees REAL DEFAULT 0,
                net_pnl REAL,
                outcome TEXT,
                tags TEXT,
                confidence REAL,
                regime TEXT,
                signals TEXT,
                features TEXT,
                entry_time INTEGER NOT NULL,
                exit_time INTEGER,
                hold_duration_s REAL,
                session_id TEXT,
                loss_patterns TEXT,
                notes TEXT,
                created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_tj_ticker ON trade_journal(ticker, created_at);
            CREATE INDEX IF NOT EXISTS idx_tj_strategy ON trade_journal(strategy, created_at);
            CREATE INDEX IF NOT EXISTS idx_tj_outcome ON trade_journal(outcome, created_at);
            CREATE INDEX IF NOT EXISTS idx_tj_session ON trade_journal(session_id);
            CREATE INDEX IF NOT EXISTS idx_tj_regime ON trade_journal(regime, outcome);

            CREATE TABLE IF NOT EXISTS journal_entries (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                entry_type TEXT DEFAULT 'SESSION_SUMMARY',
                trade_count INTEGER,
                win_rate REAL,
                total_pnl REAL,
                best_trade TEXT,
                worst_trade TEXT,
                strategy_breakdown TEXT,
                regime_breakdown TEXT,
                time_heatmap TEXT,
                drawdown_analysis TEXT,
                recommendations TEXT,
                created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_je_session ON journal_entries(session_id);
            CREATE INDEX IF NOT EXISTS idx_je_created ON journal_entries(created_at);
        """)

    def _load_from_db(self) -> None:
        """Load recent trades into memory for analytics."""
        assert self._db is not None
        try:
            rows = self._db.execute(
                "SELECT * FROM trade_journal ORDER BY created_at DESC LIMIT 2000"
            ).fetchall()
            self._trades = [self._row_to_dict(r) for r in reversed(rows)]

            entry_rows = self._db.execute(
                "SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT 100"
            ).fetchall()
            self._journal_entries = [self._row_to_dict(r) for r in reversed(entry_rows)]

            # Rebuild equity curve
            self._equity_curve = []
            cumulative = 0.0
            for t in self._trades:
                cumulative += t.get("net_pnl") or t.get("pnl") or 0.0
                self._equity_curve.append(cumulative)
            self._peak_equity = max(self._equity_curve) if self._equity_curve else 0.0
        except Exception as e:
            logger.error("Failed to load journal from DB: %s", e)

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        for key in ("tags", "signals", "features", "loss_patterns",
                     "best_trade", "worst_trade", "strategy_breakdown",
                     "regime_breakdown", "time_heatmap", "drawdown_analysis",
                     "recommendations"):
            if key in d and isinstance(d[key], str):
                try:
                    d[key] = json.loads(d[key])
                except (json.JSONDecodeError, TypeError):
                    pass
        return d

    # ------------------------------------------------------------------
    # Trade Recording
    # ------------------------------------------------------------------

    def record_trade(self, trade_data: dict) -> dict:
        """Record a completed trade with full context.

        Expected keys (all optional except ticker, strategy, entry_price, quantity, entry_time):
            ticker, strategy, entry_price, exit_price, quantity, pnl, pnl_percent,
            confidence, regime, signals (list), features (dict),
            entry_time (epoch ms), exit_time (epoch ms), notes
        """
        with self._lock:
            trade = self._build_trade_record(trade_data)
            self._trades.append(trade)

            # Update equity curve
            net = trade.get("net_pnl") or trade.get("pnl") or 0.0
            prev = self._equity_curve[-1] if self._equity_curve else 0.0
            self._equity_curve.append(prev + net)
            self._peak_equity = max(self._peak_equity, self._equity_curve[-1])

            # Persist
            self._persist_trade(trade)

            # Auto session summary
            self._session_trade_counter += 1
            journal_entry = None
            if self._session_trade_counter >= TRADES_PER_SESSION_SUMMARY:
                journal_entry = self._generate_session_summary_unlocked()
                self._session_trade_counter = 0

            # Trim in-memory list
            if len(self._trades) > 5000:
                self._trades = self._trades[-3000:]
                self._rebuild_equity_curve()

            logger.debug("Recorded trade %s %s pnl=%.4f tags=%s",
                         trade["ticker"], trade["strategy"],
                         trade.get("net_pnl", 0), trade.get("tags"))

            result = {"trade_id": trade["id"], "tags": trade.get("tags", [])}
            if journal_entry:
                result["journal_entry_id"] = journal_entry["id"]
            return result

    def _build_trade_record(self, d: dict) -> dict:
        trade_id = d.get("id") or uuid.uuid4().hex[:16]
        entry_price = d.get("entry_price", 0)
        exit_price = d.get("exit_price")
        quantity = d.get("quantity", 0)
        entry_time = d.get("entry_time", int(time.time() * 1000))
        exit_time = d.get("exit_time")

        # Compute PnL if not provided
        pnl = d.get("pnl")
        pnl_percent = d.get("pnl_percent")
        if pnl is None and exit_price is not None and entry_price > 0:
            pnl = (exit_price - entry_price) * quantity
        if pnl_percent is None and exit_price is not None and entry_price > 0:
            pnl_percent = ((exit_price - entry_price) / entry_price) * 100

        # Fees
        notional = entry_price * quantity
        fees = notional * TRADING_FEE_ROUND_TRIP
        net_pnl = (pnl - fees) if pnl is not None else None

        # Hold duration
        hold_duration_s = None
        if exit_time is not None and entry_time:
            hold_duration_s = (exit_time - entry_time) / 1000.0

        # Outcome
        outcome = d.get("outcome")
        if outcome is None and net_pnl is not None:
            if net_pnl > 0:
                outcome = "WIN"
            elif net_pnl < 0:
                outcome = "LOSS"
            else:
                outcome = "BREAKEVEN"

        # Tags
        tags = self._compute_tags(outcome, hold_duration_s, pnl_percent,
                                  d.get("regime"), d.get("strategy"))

        # Loss patterns
        loss_patterns = []
        if outcome == "LOSS":
            loss_patterns = self._detect_loss_patterns(d, hold_duration_s, pnl_percent)

        trade = {
            "id": trade_id,
            "ticker": d.get("ticker", "UNKNOWN"),
            "strategy": d.get("strategy", "UNKNOWN"),
            "entry_price": entry_price,
            "exit_price": exit_price,
            "quantity": quantity,
            "pnl": pnl,
            "pnl_percent": pnl_percent,
            "fees": fees,
            "net_pnl": net_pnl,
            "outcome": outcome,
            "tags": tags,
            "confidence": d.get("confidence"),
            "regime": d.get("regime"),
            "signals": d.get("signals"),
            "features": d.get("features"),
            "entry_time": entry_time,
            "exit_time": exit_time,
            "hold_duration_s": hold_duration_s,
            "session_id": self._current_session_id or d.get("session_id"),
            "loss_patterns": loss_patterns,
            "notes": d.get("notes"),
            "created_at": int(time.time() * 1000),
        }
        return trade

    def _compute_tags(self, outcome: Optional[str], hold_s: Optional[float],
                      pnl_pct: Optional[float], regime: Optional[str],
                      strategy: Optional[str]) -> list[str]:
        tags: list[str] = []

        # WIN / LOSS / BREAKEVEN
        if outcome:
            tags.append(outcome)

        # QUICK / SLOW
        if hold_s is not None:
            if hold_s < QUICK_TRADE_SECONDS:
                tags.append(TAG_QUICK)
            elif hold_s > SLOW_TRADE_SECONDS:
                tags.append(TAG_SLOW)

        # LARGE / SMALL
        if pnl_pct is not None:
            if abs(pnl_pct) > LARGE_TRADE_PNL_THRESHOLD:
                tags.append(TAG_LARGE)
            else:
                tags.append(TAG_SMALL)

        # TREND / COUNTER_TREND
        if regime and strategy:
            trend_strategies = {"TREND", "MOMENTUM", "BREAKOUT", "MA_CROSSOVER",
                                "EMA_CROSSOVER", "TRIPLE_EMA", "MACD", "SUPERTREND"}
            counter_strategies = {"MEAN_REVERSION", "REVERSAL", "RSI", "BOLLINGER",
                                  "MEAN_REVERT"}
            regime_upper = regime.upper()
            strategy_upper = strategy.upper()
            if "UP" in regime_upper and strategy_upper in trend_strategies:
                tags.append(TAG_TREND)
            elif "DOWN" in regime_upper and strategy_upper in counter_strategies:
                tags.append(TAG_TREND)
            elif "UP" in regime_upper and strategy_upper in counter_strategies:
                tags.append(TAG_COUNTER_TREND)
            elif "DOWN" in regime_upper and strategy_upper in trend_strategies:
                tags.append(TAG_COUNTER_TREND)

        return tags

    def _detect_loss_patterns(self, d: dict, hold_s: Optional[float],
                              pnl_pct: Optional[float]) -> list[str]:
        patterns: list[str] = []
        confidence = d.get("confidence")
        regime = d.get("regime", "")
        strategy = d.get("strategy", "")
        features = d.get("features") or {}

        # Entry too early: quick loss (< 2 min)
        if hold_s is not None and hold_s < 120:
            patterns.append(LOSS_ENTRY_TOO_EARLY)

        # Exit too late: slow loss (> 30 min with significant drawdown)
        if hold_s is not None and hold_s > 1800 and pnl_pct is not None and pnl_pct < -1.0:
            patterns.append(LOSS_EXIT_TOO_LATE)

        # Wrong regime: trend strategy in ranging/volatile, or reversal in trending
        trend_strats = {"TREND", "MOMENTUM", "BREAKOUT", "EMA_CROSSOVER", "MACD"}
        revert_strats = {"MEAN_REVERSION", "REVERSAL", "RSI", "BOLLINGER", "RANGE"}
        regime_upper = regime.upper() if regime else ""
        strat_upper = strategy.upper()

        if strat_upper in trend_strats and ("RANGING" in regime_upper or "VOLATILE" in regime_upper):
            patterns.append(LOSS_WRONG_REGIME)
        if strat_upper in revert_strats and "TRENDING" in regime_upper:
            patterns.append(LOSS_WRONG_REGIME)

        # Oversize: position > 20% of equity or volatility-adjusted oversize
        volatility = features.get("volatility") or features.get("vol_20")
        if volatility and isinstance(volatility, (int, float)) and volatility > 3.0:
            patterns.append(LOSS_HIGH_VOLATILITY)

        # Low confidence entry
        if confidence is not None and confidence < 40:
            patterns.append(LOSS_LOW_CONFIDENCE)

        # Against trend
        if strat_upper in trend_strats and "DOWN" in regime_upper:
            patterns.append(LOSS_AGAINST_TREND)
        if strat_upper in revert_strats and "UP" in regime_upper:
            patterns.append(LOSS_AGAINST_TREND)

        return patterns

    def _persist_trade(self, trade: dict) -> None:
        if self._db is None:
            return
        try:
            self._db.execute(
                """INSERT OR REPLACE INTO trade_journal
                   (id, ticker, strategy, entry_price, exit_price, quantity,
                    pnl, pnl_percent, fees, net_pnl, outcome, tags,
                    confidence, regime, signals, features,
                    entry_time, exit_time, hold_duration_s, session_id,
                    loss_patterns, notes, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    trade["id"], trade["ticker"], trade["strategy"],
                    trade["entry_price"], trade.get("exit_price"),
                    trade["quantity"], trade.get("pnl"), trade.get("pnl_percent"),
                    trade.get("fees", 0), trade.get("net_pnl"),
                    trade.get("outcome"),
                    json.dumps(trade.get("tags", [])),
                    trade.get("confidence"), trade.get("regime"),
                    json.dumps(trade.get("signals")) if trade.get("signals") else None,
                    json.dumps(trade.get("features")) if trade.get("features") else None,
                    trade["entry_time"], trade.get("exit_time"),
                    trade.get("hold_duration_s"), trade.get("session_id"),
                    json.dumps(trade.get("loss_patterns", [])),
                    trade.get("notes"), trade.get("created_at"),
                ),
            )
            self._db.commit()
        except Exception as e:
            logger.error("Failed to persist trade: %s", e)

    def _rebuild_equity_curve(self) -> None:
        self._equity_curve = []
        cumulative = 0.0
        for t in self._trades:
            cumulative += t.get("net_pnl") or t.get("pnl") or 0.0
            self._equity_curve.append(cumulative)
        self._peak_equity = max(self._equity_curve) if self._equity_curve else 0.0

    # ------------------------------------------------------------------
    # Session Journal
    # ------------------------------------------------------------------

    def start_session(self, session_id: Optional[str] = None) -> str:
        with self._lock:
            self._current_session_id = session_id or uuid.uuid4().hex[:12]
            self._session_trade_counter = 0
            logger.info("Journal session started: %s", self._current_session_id)
            return self._current_session_id

    def end_session(self) -> Optional[dict]:
        with self._lock:
            if self._current_session_id is None:
                return None
            entry = self._generate_session_summary_unlocked()
            self._current_session_id = None
            self._session_trade_counter = 0
            return entry

    def generate_journal_entry(self, session_id: Optional[str] = None) -> dict:
        """Generate a comprehensive journal entry.  If session_id is None, covers all trades."""
        with self._lock:
            return self._generate_session_summary_unlocked(session_id=session_id)

    def _generate_session_summary_unlocked(self, session_id: Optional[str] = None) -> dict:
        sid = session_id or self._current_session_id
        if sid:
            trades = [t for t in self._trades if t.get("session_id") == sid]
        else:
            trades = list(self._trades)

        if not trades:
            empty_entry = {
                "id": uuid.uuid4().hex[:16],
                "session_id": sid,
                "entry_type": "SESSION_SUMMARY",
                "trade_count": 0,
                "win_rate": 0,
                "total_pnl": 0,
                "best_trade": None,
                "worst_trade": None,
                "strategy_breakdown": {},
                "regime_breakdown": {},
                "time_heatmap": {},
                "drawdown_analysis": {},
                "recommendations": [],
                "created_at": int(time.time() * 1000),
            }
            self._journal_entries.append(empty_entry)
            return empty_entry

        completed = [t for t in trades if t.get("outcome")]
        wins = [t for t in completed if t["outcome"] == "WIN"]
        losses = [t for t in completed if t["outcome"] == "LOSS"]
        win_rate = _safe_div(len(wins), len(completed)) * 100

        pnls = [t.get("net_pnl") or t.get("pnl") or 0.0 for t in completed]
        total_pnl = sum(pnls)

        # Best / worst trade
        best_trade = max(completed, key=lambda t: t.get("net_pnl") or t.get("pnl") or 0) if completed else None
        worst_trade = min(completed, key=lambda t: t.get("net_pnl") or t.get("pnl") or 0) if completed else None

        best_summary = self._trade_summary(best_trade) if best_trade else None
        worst_summary = self._trade_summary(worst_trade) if worst_trade else None

        # Per-strategy breakdown
        strategy_breakdown = self._strategy_breakdown(completed)

        # Per-regime breakdown
        regime_breakdown = self._regime_breakdown(completed)

        # Time heatmap
        time_heatmap = self._time_heatmap(completed)

        # Drawdown analysis
        drawdown_analysis = self._drawdown_analysis(completed)

        # Recommendations from this batch
        recommendations = self._build_recommendations_unlocked(completed)

        entry = {
            "id": uuid.uuid4().hex[:16],
            "session_id": sid,
            "entry_type": "SESSION_SUMMARY",
            "trade_count": len(completed),
            "win_rate": round(win_rate, 1),
            "total_pnl": round(total_pnl, 6),
            "best_trade": best_summary,
            "worst_trade": worst_summary,
            "strategy_breakdown": strategy_breakdown,
            "regime_breakdown": regime_breakdown,
            "time_heatmap": time_heatmap,
            "drawdown_analysis": drawdown_analysis,
            "recommendations": recommendations,
            "created_at": int(time.time() * 1000),
        }

        self._journal_entries.append(entry)
        if len(self._journal_entries) > 500:
            self._journal_entries = self._journal_entries[-300:]

        # Persist
        self._persist_journal_entry(entry)

        return entry

    @staticmethod
    def _trade_summary(t: dict) -> dict:
        return {
            "id": t.get("id"),
            "ticker": t.get("ticker"),
            "strategy": t.get("strategy"),
            "pnl": t.get("net_pnl") or t.get("pnl"),
            "pnl_percent": t.get("pnl_percent"),
            "regime": t.get("regime"),
            "confidence": t.get("confidence"),
            "hold_duration_s": t.get("hold_duration_s"),
            "entry_time": t.get("entry_time"),
        }

    def _strategy_breakdown(self, trades: list[dict]) -> dict:
        by_strat: Dict[str, list[dict]] = defaultdict(list)
        for t in trades:
            by_strat[t.get("strategy", "UNKNOWN")].append(t)

        result = {}
        for strat, strades in by_strat.items():
            pnls = [t.get("net_pnl") or t.get("pnl") or 0 for t in strades]
            w = [t for t in strades if t.get("outcome") == "WIN"]
            l = [t for t in strades if t.get("outcome") == "LOSS"]
            avg_win = _safe_div(sum(t.get("net_pnl") or t.get("pnl") or 0 for t in w), len(w))
            avg_loss = abs(_safe_div(sum(t.get("net_pnl") or t.get("pnl") or 0 for t in l), len(l)))
            gross_win = sum(t.get("net_pnl") or t.get("pnl") or 0 for t in w)
            gross_loss = abs(sum(t.get("net_pnl") or t.get("pnl") or 0 for t in l))

            result[strat] = {
                "trades": len(strades),
                "wins": len(w),
                "losses": len(l),
                "win_rate": round(_safe_div(len(w), len(strades)) * 100, 1),
                "total_pnl": round(sum(pnls), 6),
                "avg_pnl": round(_safe_div(sum(pnls), len(strades)), 6),
                "avg_win": round(avg_win, 6),
                "avg_loss": round(avg_loss, 6),
                "profit_factor": round(_safe_div(gross_win, gross_loss), 2) if gross_loss > 0 else float("inf") if gross_win > 0 else 0,
                "expectancy": round(
                    _safe_div(len(w), len(strades)) * avg_win -
                    _safe_div(len(l), len(strades)) * avg_loss, 6
                ),
            }
        return result

    def _regime_breakdown(self, trades: list[dict]) -> dict:
        by_regime: Dict[str, list[dict]] = defaultdict(list)
        for t in trades:
            by_regime[t.get("regime") or "UNKNOWN"].append(t)

        result = {}
        for regime, rtrades in by_regime.items():
            pnls = [t.get("net_pnl") or t.get("pnl") or 0 for t in rtrades]
            w = sum(1 for t in rtrades if t.get("outcome") == "WIN")
            result[regime] = {
                "trades": len(rtrades),
                "wins": w,
                "losses": len(rtrades) - w,
                "win_rate": round(_safe_div(w, len(rtrades)) * 100, 1),
                "total_pnl": round(sum(pnls), 6),
                "avg_pnl": round(_safe_div(sum(pnls), len(rtrades)), 6),
            }
        return result

    def _time_heatmap(self, trades: list[dict]) -> dict:
        """Performance by hour-of-day (UTC)."""
        by_hour: Dict[int, list[float]] = defaultdict(list)
        for t in trades:
            entry_ms = t.get("entry_time")
            if entry_ms is None:
                continue
            # Convert epoch ms to hour
            hour = int((entry_ms / 1000) % 86400) // 3600
            net = t.get("net_pnl") or t.get("pnl") or 0.0
            by_hour[hour].append(net)

        heatmap = {}
        for hour in range(24):
            pnls = by_hour.get(hour, [])
            wins = sum(1 for p in pnls if p > 0)
            total = len(pnls)
            heatmap[f"{hour:02d}:00"] = {
                "trades": total,
                "wins": wins,
                "losses": total - wins,
                "win_rate": round(_safe_div(wins, total) * 100, 1) if total else 0,
                "total_pnl": round(sum(pnls), 6),
                "avg_pnl": round(_safe_div(sum(pnls), total), 6) if total else 0,
            }
        return heatmap

    def _drawdown_analysis(self, trades: list[dict]) -> dict:
        """Compute drawdown statistics from trade sequence."""
        if not trades:
            return {"max_drawdown": 0, "max_drawdown_duration_trades": 0,
                    "current_drawdown": 0, "recovery_factor": 0}

        equity = []
        cumulative = 0.0
        for t in trades:
            cumulative += t.get("net_pnl") or t.get("pnl") or 0.0
            equity.append(cumulative)

        peak = 0.0
        max_dd = 0.0
        max_dd_duration = 0
        current_dd_duration = 0
        current_dd = 0.0

        for eq in equity:
            if eq > peak:
                peak = eq
                current_dd_duration = 0
            dd = peak - eq
            if dd > 0:
                current_dd_duration += 1
            if dd > max_dd:
                max_dd = dd
                max_dd_duration = current_dd_duration
            current_dd = dd

        total_profit = equity[-1] if equity else 0
        recovery_factor = _safe_div(total_profit, max_dd) if max_dd > 0 else float("inf") if total_profit > 0 else 0

        return {
            "max_drawdown": round(max_dd, 6),
            "max_drawdown_duration_trades": max_dd_duration,
            "current_drawdown": round(current_dd, 6),
            "current_equity": round(equity[-1], 6) if equity else 0,
            "peak_equity": round(peak, 6),
            "recovery_factor": round(recovery_factor, 2) if isinstance(recovery_factor, float) and not math.isinf(recovery_factor) else "inf",
        }

    def _persist_journal_entry(self, entry: dict) -> None:
        if self._db is None:
            return
        try:
            self._db.execute(
                """INSERT OR REPLACE INTO journal_entries
                   (id, session_id, entry_type, trade_count, win_rate, total_pnl,
                    best_trade, worst_trade, strategy_breakdown, regime_breakdown,
                    time_heatmap, drawdown_analysis, recommendations, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    entry["id"], entry.get("session_id"), entry.get("entry_type"),
                    entry.get("trade_count"), entry.get("win_rate"),
                    entry.get("total_pnl"),
                    json.dumps(entry.get("best_trade")),
                    json.dumps(entry.get("worst_trade")),
                    json.dumps(entry.get("strategy_breakdown")),
                    json.dumps(entry.get("regime_breakdown")),
                    json.dumps(entry.get("time_heatmap")),
                    json.dumps(entry.get("drawdown_analysis")),
                    json.dumps(entry.get("recommendations")),
                    entry.get("created_at"),
                ),
            )
            self._db.commit()
        except Exception as e:
            logger.error("Failed to persist journal entry: %s", e)

    # ------------------------------------------------------------------
    # Statistics
    # ------------------------------------------------------------------

    def get_trade_stats(self, filters: Optional[dict] = None) -> dict:
        """Compute comprehensive statistics, optionally filtered.

        Supported filters: strategy, ticker, regime, outcome, since (epoch ms), until (epoch ms).
        """
        with self._lock:
            trades = self._apply_filters(self._trades, filters)
            return self._compute_stats(trades)

    def _apply_filters(self, trades: list[dict], filters: Optional[dict]) -> list[dict]:
        if not filters:
            return list(trades)
        result = trades
        if "strategy" in filters:
            result = [t for t in result if t.get("strategy") == filters["strategy"]]
        if "ticker" in filters:
            result = [t for t in result if t.get("ticker") == filters["ticker"]]
        if "regime" in filters:
            result = [t for t in result if t.get("regime") == filters["regime"]]
        if "outcome" in filters:
            result = [t for t in result if t.get("outcome") == filters["outcome"]]
        if "since" in filters:
            result = [t for t in result if (t.get("entry_time") or 0) >= filters["since"]]
        if "until" in filters:
            result = [t for t in result if (t.get("entry_time") or 0) <= filters["until"]]
        return result

    def _compute_stats(self, trades: list[dict]) -> dict:
        if not trades:
            return self._empty_stats()

        completed = [t for t in trades if t.get("outcome")]
        if not completed:
            return self._empty_stats()

        wins = [t for t in completed if t["outcome"] == "WIN"]
        losses = [t for t in completed if t["outcome"] == "LOSS"]
        pnls = [t.get("net_pnl") or t.get("pnl") or 0 for t in completed]
        win_pnls = [t.get("net_pnl") or t.get("pnl") or 0 for t in wins]
        loss_pnls = [abs(t.get("net_pnl") or t.get("pnl") or 0) for t in losses]

        total_pnl = sum(pnls)
        avg_win = _safe_div(sum(win_pnls), len(win_pnls))
        avg_loss = _safe_div(sum(loss_pnls), len(loss_pnls))
        win_rate = _safe_div(len(wins), len(completed))

        gross_win = sum(win_pnls)
        gross_loss = sum(loss_pnls)
        profit_factor = _safe_div(gross_win, gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0)
        expectancy = win_rate * avg_win - (1 - win_rate) * avg_loss

        # Streaks
        streaks = self._compute_streaks(completed)

        # Per-strategy
        strategy_stats = self._strategy_breakdown(completed)

        # Per-asset
        asset_stats = self._asset_breakdown(completed)

        # Risk-adjusted metrics
        risk_metrics = self._compute_risk_metrics(pnls)

        return {
            "overall": {
                "total_trades": len(completed),
                "wins": len(wins),
                "losses": len(losses),
                "breakeven": len(completed) - len(wins) - len(losses),
                "win_rate": round(win_rate * 100, 1),
                "total_pnl": round(total_pnl, 6),
                "avg_pnl": round(_safe_div(total_pnl, len(completed)), 6),
                "avg_win": round(avg_win, 6),
                "avg_loss": round(avg_loss, 6),
                "largest_win": round(max(win_pnls), 6) if win_pnls else 0,
                "largest_loss": round(max(loss_pnls), 6) if loss_pnls else 0,
                "profit_factor": round(profit_factor, 2) if isinstance(profit_factor, float) and not math.isinf(profit_factor) else "inf",
                "expectancy": round(expectancy, 6),
                "total_fees": round(sum(t.get("fees", 0) for t in completed), 6),
                "avg_hold_seconds": round(
                    _safe_div(
                        sum(t.get("hold_duration_s") or 0 for t in completed),
                        len(completed)
                    ), 1
                ),
            },
            "streaks": streaks,
            "per_strategy": strategy_stats,
            "per_asset": asset_stats,
            "risk_adjusted": risk_metrics,
        }

    def _asset_breakdown(self, trades: list[dict]) -> dict:
        by_asset: Dict[str, list[dict]] = defaultdict(list)
        for t in trades:
            by_asset[t.get("ticker", "UNKNOWN")].append(t)

        result = {}
        for asset, atrades in by_asset.items():
            pnls = [t.get("net_pnl") or t.get("pnl") or 0 for t in atrades]
            w = sum(1 for t in atrades if t.get("outcome") == "WIN")
            result[asset] = {
                "trades": len(atrades),
                "wins": w,
                "losses": len(atrades) - w,
                "win_rate": round(_safe_div(w, len(atrades)) * 100, 1),
                "total_pnl": round(sum(pnls), 6),
                "avg_pnl": round(_safe_div(sum(pnls), len(atrades)), 6),
            }
        return result

    @staticmethod
    def _compute_streaks(trades: list[dict]) -> dict:
        if not trades:
            return {"longest_win": 0, "longest_loss": 0, "current_streak": 0, "current_type": "NONE"}

        max_win_streak = 0
        max_loss_streak = 0
        current_streak = 0
        current_type = "NONE"

        for t in trades:
            outcome = t.get("outcome")
            if outcome == "WIN":
                if current_type == "WIN":
                    current_streak += 1
                else:
                    current_type = "WIN"
                    current_streak = 1
                max_win_streak = max(max_win_streak, current_streak)
            elif outcome == "LOSS":
                if current_type == "LOSS":
                    current_streak += 1
                else:
                    current_type = "LOSS"
                    current_streak = 1
                max_loss_streak = max(max_loss_streak, current_streak)
            else:
                current_type = "BREAKEVEN"
                current_streak = 1

        return {
            "longest_win": max_win_streak,
            "longest_loss": max_loss_streak,
            "current_streak": current_streak,
            "current_type": current_type,
        }

    @staticmethod
    def _compute_risk_metrics(pnls: list[float]) -> dict:
        """Sharpe, Sortino, Calmar from trade returns."""
        if len(pnls) < 2:
            return {"sharpe": 0, "sortino": 0, "calmar": 0}

        avg_return = sum(pnls) / len(pnls)
        std_dev = math.sqrt(sum((p - avg_return) ** 2 for p in pnls) / (len(pnls) - 1))

        # Sharpe (annualised assuming ~250 trades/year scale)
        sharpe = _safe_div(avg_return, std_dev) * math.sqrt(min(len(pnls), 250))

        # Sortino (downside deviation)
        neg_returns = [p for p in pnls if p < 0]
        if neg_returns:
            downside_dev = math.sqrt(sum(p ** 2 for p in neg_returns) / len(neg_returns))
            sortino = _safe_div(avg_return, downside_dev) * math.sqrt(min(len(pnls), 250))
        else:
            sortino = float("inf") if avg_return > 0 else 0

        # Calmar (return / max drawdown)
        equity = []
        cumulative = 0.0
        for p in pnls:
            cumulative += p
            equity.append(cumulative)
        peak = 0.0
        max_dd = 0.0
        for eq in equity:
            if eq > peak:
                peak = eq
            dd = peak - eq
            if dd > max_dd:
                max_dd = dd
        total_return = equity[-1] if equity else 0
        calmar = _safe_div(total_return, max_dd) if max_dd > 0 else (float("inf") if total_return > 0 else 0)

        def _fmt(v: float) -> Any:
            if isinstance(v, float) and math.isinf(v):
                return "inf"
            return round(v, 3)

        return {
            "sharpe": _fmt(sharpe),
            "sortino": _fmt(sortino),
            "calmar": _fmt(calmar),
            "std_dev": round(std_dev, 6),
            "avg_return": round(avg_return, 6),
            "num_trades": len(pnls),
        }

    @staticmethod
    def _empty_stats() -> dict:
        return {
            "overall": {
                "total_trades": 0, "wins": 0, "losses": 0, "breakeven": 0,
                "win_rate": 0, "total_pnl": 0, "avg_pnl": 0, "avg_win": 0,
                "avg_loss": 0, "largest_win": 0, "largest_loss": 0,
                "profit_factor": 0, "expectancy": 0, "total_fees": 0,
                "avg_hold_seconds": 0,
            },
            "streaks": {"longest_win": 0, "longest_loss": 0, "current_streak": 0, "current_type": "NONE"},
            "per_strategy": {},
            "per_asset": {},
            "risk_adjusted": {"sharpe": 0, "sortino": 0, "calmar": 0},
        }

    # ------------------------------------------------------------------
    # Pattern Analysis
    # ------------------------------------------------------------------

    def get_pattern_analysis(self) -> dict:
        """Detect recurring patterns in losing trades."""
        with self._lock:
            return self._analyze_patterns_unlocked()

    def _analyze_patterns_unlocked(self) -> dict:
        losses = [t for t in self._trades if t.get("outcome") == "LOSS"]
        if not losses:
            return {"total_losses": 0, "patterns": {}, "strategy_regime_matrix": {},
                    "time_clustering": {}, "correlations": []}

        # Aggregate loss patterns
        pattern_counts: Dict[str, int] = defaultdict(int)
        pattern_total_loss: Dict[str, float] = defaultdict(float)
        for t in losses:
            for p in (t.get("loss_patterns") or []):
                pattern_counts[p] += 1
                pattern_total_loss[p] += abs(t.get("net_pnl") or t.get("pnl") or 0)

        patterns = {}
        for p_name, count in sorted(pattern_counts.items(), key=lambda x: -x[1]):
            patterns[p_name] = {
                "count": count,
                "frequency": round(count / len(losses) * 100, 1),
                "total_loss": round(pattern_total_loss[p_name], 6),
                "avg_loss": round(_safe_div(pattern_total_loss[p_name], count), 6),
            }

        # Strategy-regime loss matrix
        strat_regime: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for t in losses:
            s = t.get("strategy", "UNKNOWN")
            r = t.get("regime") or "UNKNOWN"
            strat_regime[s][r] += 1

        strategy_regime_matrix = {
            s: dict(regimes) for s, regimes in strat_regime.items()
        }

        # Time clustering: do losses cluster at certain hours?
        hour_losses: Dict[int, int] = defaultdict(int)
        hour_total: Dict[int, int] = defaultdict(int)
        all_completed = [t for t in self._trades if t.get("outcome")]
        for t in all_completed:
            entry_ms = t.get("entry_time")
            if entry_ms is None:
                continue
            hour = int((entry_ms / 1000) % 86400) // 3600
            hour_total[hour] += 1
            if t.get("outcome") == "LOSS":
                hour_losses[hour] += 1

        time_clustering = {}
        avg_loss_rate = _safe_div(len(losses), len(all_completed))
        for hour in range(24):
            total = hour_total.get(hour, 0)
            loss_count = hour_losses.get(hour, 0)
            if total >= 3:
                loss_rate = _safe_div(loss_count, total)
                # Flag hours with loss rate significantly above average
                is_danger = loss_rate > avg_loss_rate * 1.3 and total >= 5
                time_clustering[f"{hour:02d}:00"] = {
                    "trades": total,
                    "losses": loss_count,
                    "loss_rate": round(loss_rate * 100, 1),
                    "danger_hour": is_danger,
                }

        # Correlations: co-occurring patterns
        correlations = []
        pattern_names = list(pattern_counts.keys())
        for i, p1 in enumerate(pattern_names):
            for p2 in pattern_names[i + 1:]:
                co_occur = sum(
                    1 for t in losses
                    if p1 in (t.get("loss_patterns") or []) and p2 in (t.get("loss_patterns") or [])
                )
                if co_occur >= 3:
                    correlations.append({
                        "patterns": [p1, p2],
                        "co_occurrences": co_occur,
                        "rate": round(co_occur / len(losses) * 100, 1),
                    })

        return {
            "total_losses": len(losses),
            "patterns": patterns,
            "strategy_regime_matrix": strategy_regime_matrix,
            "time_clustering": time_clustering,
            "correlations": sorted(correlations, key=lambda c: -c["co_occurrences"]),
        }

    # ------------------------------------------------------------------
    # Recommendations Engine
    # ------------------------------------------------------------------

    def get_recommendations(self) -> list[str]:
        """Generate actionable recommendations based on trade data analysis."""
        with self._lock:
            completed = [t for t in self._trades if t.get("outcome")]
            return self._build_recommendations_unlocked(completed)

    def _build_recommendations_unlocked(self, trades: list[dict]) -> list[str]:
        if len(trades) < 10:
            return ["Insufficient trade data (need at least 10 trades for analysis)."]

        recs: list[str] = []

        # 1. Strategy-regime specific recommendations
        strat_regime_stats = self._get_strategy_regime_stats(trades)
        for (strat, regime), stats in strat_regime_stats.items():
            if stats["trades"] >= 5 and stats["win_rate"] < 30:
                recs.append(
                    f"Stop trading {strat} during {regime} regime "
                    f"({stats['win_rate']:.0f}% win rate over {stats['trades']} trades)."
                )
            elif stats["trades"] >= 5 and stats["win_rate"] > 70:
                recs.append(
                    f"Increase allocation to {strat} during {regime} regime "
                    f"({stats['win_rate']:.0f}% win rate over {stats['trades']} trades)."
                )

        # 2. Best/worst hours
        hour_stats = self._get_hour_stats(trades)
        profitable_hours = [(h, s) for h, s in hour_stats.items() if s["trades"] >= 5 and s["avg_pnl"] > 0]
        losing_hours = [(h, s) for h, s in hour_stats.items() if s["trades"] >= 5 and s["avg_pnl"] < 0]

        if profitable_hours:
            best_hour = max(profitable_hours, key=lambda x: x[1]["avg_pnl"])
            recs.append(
                f"Your best hour is {best_hour[0]:02d}:00-{(best_hour[0]+1) % 24:02d}:00 UTC "
                f"(avg PnL: {best_hour[1]['avg_pnl']:.4f} over {best_hour[1]['trades']} trades)."
            )
        if losing_hours:
            worst_hour = min(losing_hours, key=lambda x: x[1]["avg_pnl"])
            recs.append(
                f"Consider avoiding {worst_hour[0]:02d}:00-{(worst_hour[0]+1) % 24:02d}:00 UTC "
                f"(avg PnL: {worst_hour[1]['avg_pnl']:.4f} over {worst_hour[1]['trades']} trades)."
            )

        # 3. Low confidence trade analysis
        low_conf = [t for t in trades if (t.get("confidence") or 100) < 40]
        if len(low_conf) >= 5:
            low_conf_pnl = sum(t.get("net_pnl") or t.get("pnl") or 0 for t in low_conf)
            low_conf_wr = sum(1 for t in low_conf if t.get("outcome") == "WIN") / len(low_conf) * 100
            if low_conf_pnl < 0:
                recs.append(
                    f"Low-confidence trades (<40) are net negative "
                    f"(PnL: {low_conf_pnl:.4f}, WR: {low_conf_wr:.0f}%). "
                    f"Consider raising minimum confidence threshold."
                )

        # 4. Oversize detection via large-loss trades
        large_losses = [t for t in trades if t.get("outcome") == "LOSS" and
                        (t.get("pnl_percent") or 0) < -1.5]
        if len(large_losses) >= 3:
            total_large_loss = sum(abs(t.get("net_pnl") or t.get("pnl") or 0) for t in large_losses)
            total_loss = sum(abs(t.get("net_pnl") or t.get("pnl") or 0)
                            for t in trades if t.get("outcome") == "LOSS")
            pct_of_losses = _safe_div(total_large_loss, total_loss) * 100
            if pct_of_losses > 50:
                recs.append(
                    f"Large losses (>1.5%) account for {pct_of_losses:.0f}% of total losses. "
                    f"Reduce position size when volatility is high."
                )

        # 5. Streak-based advice
        streaks = self._compute_streaks(trades)
        if streaks["longest_loss"] >= 5:
            recs.append(
                f"Longest loss streak was {streaks['longest_loss']} trades. "
                f"Consider pausing after 4 consecutive losses."
            )
        if streaks["current_type"] == "LOSS" and streaks["current_streak"] >= 3:
            recs.append(
                f"Currently on a {streaks['current_streak']}-trade losing streak. "
                f"Consider reducing position size or pausing."
            )

        # 6. Quick-exit losses
        quick_losses = [t for t in trades if t.get("outcome") == "LOSS" and
                        (t.get("hold_duration_s") or float("inf")) < 120]
        if len(quick_losses) >= 5:
            pct = len(quick_losses) / max(1, sum(1 for t in trades if t.get("outcome") == "LOSS")) * 100
            recs.append(
                f"{pct:.0f}% of losses exit within 2 minutes. "
                f"Entry timing may be too aggressive; consider waiting for confirmation."
            )

        # 7. Slow-exit losses
        slow_losses = [t for t in trades if t.get("outcome") == "LOSS" and
                       (t.get("hold_duration_s") or 0) > 3600]
        if len(slow_losses) >= 3:
            avg_slow_loss = _safe_div(
                sum(abs(t.get("net_pnl") or t.get("pnl") or 0) for t in slow_losses),
                len(slow_losses)
            )
            recs.append(
                f"{len(slow_losses)} trades held > 1 hour ended in loss "
                f"(avg loss: {avg_slow_loss:.4f}). "
                f"Consider tighter time-based exits."
            )

        # 8. Asset-specific advice
        asset_stats = self._asset_breakdown(trades)
        for asset, stats in asset_stats.items():
            if stats["trades"] >= 10 and stats["win_rate"] < 35:
                recs.append(
                    f"Poor performance on {asset} ({stats['win_rate']}% WR, "
                    f"PnL: {stats['total_pnl']:.4f}). Consider removing from watchlist."
                )

        if not recs:
            recs.append("No specific issues detected. Keep following your strategy.")

        return recs

    @staticmethod
    def _get_strategy_regime_stats(trades: list[dict]) -> dict:
        buckets: Dict[tuple, list] = defaultdict(list)
        for t in trades:
            key = (t.get("strategy", "UNKNOWN"), t.get("regime") or "UNKNOWN")
            buckets[key].append(t)

        result = {}
        for key, bucket_trades in buckets.items():
            w = sum(1 for t in bucket_trades if t.get("outcome") == "WIN")
            result[key] = {
                "trades": len(bucket_trades),
                "wins": w,
                "win_rate": _safe_div(w, len(bucket_trades)) * 100,
                "pnl": sum(t.get("net_pnl") or t.get("pnl") or 0 for t in bucket_trades),
            }
        return result

    @staticmethod
    def _get_hour_stats(trades: list[dict]) -> dict:
        by_hour: Dict[int, list[float]] = defaultdict(list)
        for t in trades:
            entry_ms = t.get("entry_time")
            if entry_ms is None:
                continue
            hour = int((entry_ms / 1000) % 86400) // 3600
            net = t.get("net_pnl") or t.get("pnl") or 0.0
            by_hour[hour].append(net)

        result = {}
        for hour, pnls in by_hour.items():
            result[hour] = {
                "trades": len(pnls),
                "total_pnl": sum(pnls),
                "avg_pnl": _safe_div(sum(pnls), len(pnls)),
            }
        return result

    # ------------------------------------------------------------------
    # Time Analysis
    # ------------------------------------------------------------------

    def get_time_analysis(self) -> dict:
        """Hour-of-day performance analysis."""
        with self._lock:
            completed = [t for t in self._trades if t.get("outcome")]
            heatmap = self._time_heatmap(completed)

            # Find best / worst hours
            hours_with_data = {k: v for k, v in heatmap.items() if v["trades"] >= 3}
            best_hour = max(hours_with_data.items(), key=lambda x: x[1]["avg_pnl"]) if hours_with_data else None
            worst_hour = min(hours_with_data.items(), key=lambda x: x[1]["avg_pnl"]) if hours_with_data else None

            return {
                "heatmap": heatmap,
                "best_hour": {"hour": best_hour[0], **best_hour[1]} if best_hour else None,
                "worst_hour": {"hour": worst_hour[0], **worst_hour[1]} if worst_hour else None,
                "total_hours_active": sum(1 for v in heatmap.values() if v["trades"] > 0),
            }

    # ------------------------------------------------------------------
    # Recent Entries
    # ------------------------------------------------------------------

    def get_recent_entries(self, n: int = 10) -> list[dict]:
        """Return the N most recent journal entries."""
        with self._lock:
            return list(self._journal_entries[-n:])

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        """Return summary status of the trade journal."""
        with self._lock:
            completed = [t for t in self._trades if t.get("outcome")]
            wins = sum(1 for t in completed if t["outcome"] == "WIN")
            losses = sum(1 for t in completed if t["outcome"] == "LOSS")
            total_pnl = sum(t.get("net_pnl") or t.get("pnl") or 0 for t in completed)

            return {
                "initialized": self._initialized,
                "total_trades": len(self._trades),
                "completed_trades": len(completed),
                "wins": wins,
                "losses": losses,
                "win_rate": round(_safe_div(wins, len(completed)) * 100, 1) if completed else 0,
                "total_pnl": round(total_pnl, 6),
                "journal_entries": len(self._journal_entries),
                "current_session": self._current_session_id,
                "session_trade_counter": self._session_trade_counter,
                "peak_equity": round(self._peak_equity, 6),
                "current_equity": round(self._equity_curve[-1], 6) if self._equity_curve else 0,
                "db_connected": self._db is not None,
            }


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_instance: Optional[TradeJournal] = None
_instance_lock = threading.Lock()


def get_trade_journal() -> TradeJournal:
    """Return (and lazily create) the singleton TradeJournal."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = TradeJournal()
                try:
                    _instance.initialize()
                except Exception as e:
                    logger.warning("TradeJournal auto-init failed (DB not ready?): %s", e)
    return _instance
