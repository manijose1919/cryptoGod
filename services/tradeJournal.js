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

export default { initJournalTable, recordTradeForJournal, generateJournalEntry, autoJournal, getJournalEntries, forceGenerateJournal };
