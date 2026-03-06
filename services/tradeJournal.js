/**
 * Trade Journal / Post-Mortem Service
 * Auto-generates journal entries with per-strategy analysis, best/worst trades, and recommendations.
 */

import { getDb } from './database.js';

let tradeBuffer = [];
let lastJournalAt = 0;
const AUTO_JOURNAL_THRESHOLD = 20; // Generate after every 20 trades

/**
 * Initialize journal_entries table if not exists.
 */
export function initJournalTable() {
  const db = getDb();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      period_start INTEGER,
      period_end INTEGER,
      total_trades INTEGER,
      total_pnl REAL,
      win_rate REAL,
      strategy_breakdown TEXT,
      best_trades TEXT,
      worst_trades TEXT,
      max_drawdown REAL,
      recommendations TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );
  `);
}

/**
 * Record a trade for journal tracking.
 */
export function recordTradeForJournal(trade) {
  tradeBuffer.push({
    ...trade,
    timestamp: trade.timestamp || Date.now(),
  });
}

/**
 * Generate a journal entry from recent trades.
 * @param {Object[]} trades - Array of trade objects with { ticker, strategy, pnl, timestamp, price, quantity, type }
 * @param {string} sessionId
 * @returns {Object} journal entry
 */
export function generateJournalEntry(trades, sessionId = 'default') {
  if (!trades || trades.length === 0) {
    return { error: 'No trades to journal' };
  }

  // Per-strategy breakdown
  const strategyMap = {};
  for (const trade of trades) {
    const strat = trade.strategy || trade.entryStrategy || 'UNKNOWN';
    if (!strategyMap[strat]) {
      strategyMap[strat] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, pnls: [] };
    }
    strategyMap[strat].trades++;
    strategyMap[strat].totalPnl += trade.pnl || 0;
    strategyMap[strat].pnls.push(trade.pnl || 0);
    if ((trade.pnl || 0) > 0) strategyMap[strat].wins++;
    else strategyMap[strat].losses++;
  }

  const strategyBreakdown = {};
  for (const [strat, data] of Object.entries(strategyMap)) {
    strategyBreakdown[strat] = {
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0',
      totalPnl: data.totalPnl.toFixed(2),
      avgPnl: data.trades > 0 ? (data.totalPnl / data.trades).toFixed(2) : '0',
    };
  }

  // Best and worst trades
  const sortedByPnl = [...trades].filter(t => t.pnl != null).sort((a, b) => b.pnl - a.pnl);
  const bestTrades = sortedByPnl.slice(0, 3).map(t => ({
    ticker: t.ticker, strategy: t.strategy || t.entryStrategy, pnl: t.pnl?.toFixed(2), timestamp: t.timestamp,
  }));
  const worstTrades = sortedByPnl.slice(-3).reverse().map(t => ({
    ticker: t.ticker, strategy: t.strategy || t.entryStrategy, pnl: t.pnl?.toFixed(2), timestamp: t.timestamp,
  }));

  // Drawdown calculation
  let peak = 0;
  let maxDrawdown = 0;
  let running = 0;
  for (const trade of trades) {
    running += trade.pnl || 0;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Total stats
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100) : 0;

  // Recommendations
  const recommendations = [];
  for (const [strat, data] of Object.entries(strategyMap)) {
    const wr = data.trades > 0 ? data.wins / data.trades : 0;
    if (wr < 0.35 && data.trades >= 5) {
      recommendations.push(`Consider reducing ${strat} allocation (${(wr * 100).toFixed(0)}% win rate over ${data.trades} trades)`);
    }
    if (wr > 0.65 && data.trades >= 5) {
      recommendations.push(`${strat} performing well (${(wr * 100).toFixed(0)}% win rate) - consider increasing allocation`);
    }
  }
  if (maxDrawdown > totalPnl * 0.5 && totalPnl > 0) {
    recommendations.push('Drawdown exceeded 50% of profits - tighten stop losses');
  }
  if (trades.length > 50 && winRate < 45) {
    recommendations.push('Overall win rate below 45% - review entry criteria');
  }

  const entry = {
    sessionId,
    periodStart: trades[0]?.timestamp || Date.now(),
    periodEnd: trades[trades.length - 1]?.timestamp || Date.now(),
    totalTrades: trades.length,
    totalPnl,
    winRate,
    strategyBreakdown,
    bestTrades,
    worstTrades,
    maxDrawdown,
    recommendations,
  };

  // Persist to DB
  try {
    const db = getDb();
    if (db) {
      db.prepare(`
        INSERT INTO journal_entries (session_id, period_start, period_end, total_trades, total_pnl, win_rate, strategy_breakdown, best_trades, worst_trades, max_drawdown, recommendations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.sessionId,
        entry.periodStart,
        entry.periodEnd,
        entry.totalTrades,
        entry.totalPnl,
        entry.winRate,
        JSON.stringify(entry.strategyBreakdown),
        JSON.stringify(entry.bestTrades),
        JSON.stringify(entry.worstTrades),
        entry.maxDrawdown,
        JSON.stringify(entry.recommendations),
      );
    }
  } catch (e) {
    console.error('[Journal] Failed to persist:', e.message);
  }

  return entry;
}

/**
 * Auto-generate journal when buffer reaches threshold.
 * Call after every trade exit.
 */
export function autoJournal(sessionId = 'default') {
  if (tradeBuffer.length >= AUTO_JOURNAL_THRESHOLD) {
    const entry = generateJournalEntry(tradeBuffer, sessionId);
    tradeBuffer = [];
    lastJournalAt = Date.now();
    return entry;
  }
  return null;
}

/**
 * Get all journal entries.
 */
export function getJournalEntries(limit = 50) {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    return rows.map(row => ({
      ...row,
      strategyBreakdown: JSON.parse(row.strategy_breakdown || '{}'),
      bestTrades: JSON.parse(row.best_trades || '[]'),
      worstTrades: JSON.parse(row.worst_trades || '[]'),
      recommendations: JSON.parse(row.recommendations || '[]'),
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Force generate a journal from the buffer regardless of threshold.
 */
export function forceGenerateJournal(sessionId = 'default') {
  if (tradeBuffer.length === 0) {
    return { error: 'No trades in buffer' };
  }
  const entry = generateJournalEntry(tradeBuffer, sessionId);
  tradeBuffer = [];
  lastJournalAt = Date.now();
  return entry;
}

// ============================================
// PATTERN MINING — learns from trade history
// ============================================

// In-memory pattern cache (rebuilt every 30 min or on demand)
let patternCache = {
  hourlyWinRates: {},       // hour (0-23) -> { wins, total, winRate }
  tickerStrategyWR: {},     // "BTCUSD:TREND" -> { wins, total, winRate, avgPnl }
  regimeStrategyWR: {},     // "UPTREND:TREND" -> { wins, total, winRate }
  minedBlockedHours: [],    // hours with <30% win rate (min 5 trades)
  lastMined: 0,
};

const MINE_INTERVAL_MS = 30 * 60 * 1000;
const MIN_TRADES_FOR_PATTERN = 5;
const BLOCK_HOUR_THRESHOLD = 0.30;

let _patternTableReady = false;

function ensurePatternTable() {
  if (_patternTableReady) return;
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS trade_journal_detail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        strategy TEXT,
        regime TEXT,
        entry_hour INTEGER,
        exit_hour INTEGER,
        entry_price REAL,
        exit_price REAL,
        pnl_percent REAL DEFAULT 0,
        pnl_usd REAL DEFAULT 0,
        hold_minutes REAL DEFAULT 0,
        is_win INTEGER DEFAULT 0,
        entry_time INTEGER,
        exit_time INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_jd_ticker ON trade_journal_detail(ticker, strategy);
      CREATE INDEX IF NOT EXISTS idx_jd_hour ON trade_journal_detail(entry_hour, is_win);
      CREATE INDEX IF NOT EXISTS idx_jd_regime ON trade_journal_detail(regime, strategy);
    `);
    _patternTableReady = true;
  } catch (e) {
    _patternTableReady = true;
  }
}

/**
 * Record a completed trade with full context for pattern mining.
 * @param {Object} trade - { ticker, strategy, regime, entryPrice, exitPrice, pnlPercent, pnlUsd, entryTime, exitTime }
 */
export function recordTradeDetail(trade) {
  try {
    ensurePatternTable();
    const entryDate = new Date(trade.entryTime || Date.now());
    const exitDate = new Date(trade.exitTime || Date.now());
    const holdMinutes = (exitDate.getTime() - entryDate.getTime()) / 60000;

    getDb().prepare(`
      INSERT INTO trade_journal_detail (ticker, strategy, regime, entry_hour, exit_hour,
        entry_price, exit_price, pnl_percent, pnl_usd, hold_minutes, is_win,
        entry_time, exit_time)
      VALUES (@ticker, @strategy, @regime, @entryHour, @exitHour,
        @entryPrice, @exitPrice, @pnlPercent, @pnlUsd, @holdMinutes, @isWin,
        @entryTime, @exitTime)
    `).run({
      ticker: trade.ticker,
      strategy: trade.strategy || 'UNKNOWN',
      regime: trade.regime || 'UNKNOWN',
      entryHour: entryDate.getUTCHours(),
      exitHour: exitDate.getUTCHours(),
      entryPrice: trade.entryPrice || 0,
      exitPrice: trade.exitPrice || 0,
      pnlPercent: trade.pnlPercent || 0,
      pnlUsd: trade.pnlUsd || 0,
      holdMinutes,
      isWin: (trade.pnlPercent || 0) > 0 ? 1 : 0,
      entryTime: trade.entryTime || Date.now(),
      exitTime: trade.exitTime || Date.now(),
    });
  } catch (e) {
    // Non-critical
  }
}

/**
 * Mine patterns from trade history.
 */
export function minePatterns() {
  try {
    ensurePatternTable();
    const d = getDb();

    // Hourly win rates
    const hourlyRows = d.prepare(`
      SELECT entry_hour, COUNT(*) as total, SUM(is_win) as wins,
        AVG(pnl_percent) as avgPnl
      FROM trade_journal_detail GROUP BY entry_hour
    `).all();

    const hourlyWinRates = {};
    const minedBlockedHours = [];
    for (const row of hourlyRows) {
      const wr = row.total > 0 ? row.wins / row.total : 0;
      hourlyWinRates[row.entry_hour] = {
        wins: row.wins, total: row.total,
        winRate: parseFloat((wr * 100).toFixed(1)),
        avgPnl: parseFloat((row.avgPnl || 0).toFixed(3)),
      };
      if (row.total >= MIN_TRADES_FOR_PATTERN && wr < BLOCK_HOUR_THRESHOLD) {
        minedBlockedHours.push(row.entry_hour);
      }
    }

    // Per-ticker strategy win rates
    const tickerStratRows = d.prepare(`
      SELECT ticker, strategy, COUNT(*) as total, SUM(is_win) as wins,
        AVG(pnl_percent) as avgPnl
      FROM trade_journal_detail GROUP BY ticker, strategy
    `).all();

    const tickerStrategyWR = {};
    for (const row of tickerStratRows) {
      const key = `${row.ticker}:${row.strategy}`;
      const wr = row.total > 0 ? row.wins / row.total : 0;
      tickerStrategyWR[key] = {
        wins: row.wins, total: row.total,
        winRate: parseFloat((wr * 100).toFixed(1)),
        avgPnl: parseFloat((row.avgPnl || 0).toFixed(3)),
      };
    }

    // Regime + strategy win rates
    const regimeStratRows = d.prepare(`
      SELECT regime, strategy, COUNT(*) as total, SUM(is_win) as wins,
        AVG(pnl_percent) as avgPnl
      FROM trade_journal_detail GROUP BY regime, strategy
    `).all();

    const regimeStrategyWR = {};
    for (const row of regimeStratRows) {
      const key = `${row.regime}:${row.strategy}`;
      const wr = row.total > 0 ? row.wins / row.total : 0;
      regimeStrategyWR[key] = {
        wins: row.wins, total: row.total,
        winRate: parseFloat((wr * 100).toFixed(1)),
        avgPnl: parseFloat((row.avgPnl || 0).toFixed(3)),
      };
    }

    patternCache = { hourlyWinRates, tickerStrategyWR, regimeStrategyWR, minedBlockedHours, lastMined: Date.now() };

    if (minedBlockedHours.length > 0) {
      console.log(`[TradeJournal] Mined: ${minedBlockedHours.length} blocked hours [${minedBlockedHours.join(',')}], ${Object.keys(tickerStrategyWR).length} ticker-strategy combos`);
    }
    return patternCache;
  } catch (e) {
    return patternCache;
  }
}

/** Get mined blocked hours (auto-mines if stale) */
export function getMinedBlockedHours() {
  if (Date.now() - patternCache.lastMined > MINE_INTERVAL_MS) minePatterns();
  return patternCache.minedBlockedHours;
}

/** Get ticker+strategy score. Returns null if not enough data. */
export function getTickerStrategyScore(ticker, strategy) {
  if (Date.now() - patternCache.lastMined > MINE_INTERVAL_MS) minePatterns();
  const data = patternCache.tickerStrategyWR[`${ticker}:${strategy}`];
  if (!data || data.total < MIN_TRADES_FOR_PATTERN) return null;
  return { ...data, shouldAvoid: data.winRate < 30 && data.avgPnl < 0 };
}

/** Regime+strategy confidence adjustment (-10 to +5). */
export function getRegimeStrategyAdj(regime, strategy) {
  if (Date.now() - patternCache.lastMined > MINE_INTERVAL_MS) minePatterns();
  const data = patternCache.regimeStrategyWR[`${regime}:${strategy}`];
  if (!data || data.total < MIN_TRADES_FOR_PATTERN) return 0;
  if (data.winRate < 25) return -10;
  if (data.winRate < 35) return -5;
  if (data.winRate > 60 && data.avgPnl > 0.5) return 5;
  return 0;
}

/** Get pattern cache for API */
export function getPatternStats() {
  if (Date.now() - patternCache.lastMined > MINE_INTERVAL_MS) minePatterns();
  return patternCache;
}

export default { initJournalTable, recordTradeForJournal, generateJournalEntry, autoJournal, getJournalEntries, forceGenerateJournal, recordTradeDetail, minePatterns, getMinedBlockedHours, getTickerStrategyScore, getRegimeStrategyAdj, getPatternStats };
