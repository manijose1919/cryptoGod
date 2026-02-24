/**
 * Continuous Background Backtester (Batch 4C)
 * Runs every 30 min, replays last 7 days of candle data per strategy.
 * Tracks win rate, avg PnL, max drawdown per strategy.
 * Results stored in backtest_results DB table.
 * Strategies with <30% win rate get 25% confidence penalty.
 */

import { getDb } from './database.js';
import { getFlag } from './systemConfig.js';

const LOG = '[ContinuousBacktest]';
const BACKTEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const LOOKBACK_DAYS = 7;
const STRATEGIES = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];
const TRADING_FEE = 0.0015; // 0.15% round-trip

let interval = null;
let _tableReady = false;
let lastResults = new Map(); // strategy -> { winRate, avgPnl, maxDrawdown }

function ensureTable() {
  if (_tableReady) return;
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS backtest_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy TEXT NOT NULL,
        period_start INTEGER,
        period_end INTEGER,
        win_rate REAL DEFAULT 0,
        avg_pnl REAL DEFAULT 0,
        max_drawdown REAL DEFAULT 0,
        sample_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_results(strategy, created_at);
    `);
    _tableReady = true;
  } catch (e) {
    _tableReady = true; // May already exist
  }
}

/**
 * Simple momentum-style backtest: buy when RSI < 35, sell when RSI > 65 or stop-loss
 * Returns array of { pnl, entryPrice, exitPrice, bars }
 */
function backtestStrategy(candles, strategy) {
  if (!candles || candles.length < 50) return [];
  const closes = candles.map(c => c.c || c.close || 0);
  const trades = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryIdx = 0;

  // Strategy-specific entry/exit thresholds
  const thresholds = getStrategyThresholds(strategy);

  for (let i = 20; i < closes.length; i++) {
    const price = closes[i];
    if (price <= 0) continue;

    // Simple RSI calculation
    const rsi = quickRSI(closes, i, 14);

    if (!inPosition) {
      // Entry conditions vary by strategy
      if (shouldEnter(rsi, closes, i, thresholds)) {
        inPosition = true;
        entryPrice = price;
        entryIdx = i;
      }
    } else {
      // Exit conditions
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      const bars = i - entryIdx;

      if (shouldExit(rsi, pnlPct, bars, thresholds)) {
        const netPnl = pnlPct - (TRADING_FEE * 100); // subtract fees
        trades.push({ pnl: netPnl, entryPrice, exitPrice: price, bars });
        inPosition = false;
      }
    }
  }

  return trades;
}

function getStrategyThresholds(strategy) {
  switch (strategy) {
    case 'TREND':      return { entryRSI: 40, exitRSI: 70, stopLoss: -2, maxBars: 50 };
    case 'BREAKOUT':   return { entryRSI: 55, exitRSI: 75, stopLoss: -1.5, maxBars: 20 };
    case 'WHALE':      return { entryRSI: 35, exitRSI: 65, stopLoss: -3, maxBars: 40 };
    case 'CONFLUENCE':  return { entryRSI: 38, exitRSI: 68, stopLoss: -2, maxBars: 35 };
    case 'MOMENTUM':   return { entryRSI: 50, exitRSI: 72, stopLoss: -1.5, maxBars: 15 };
    case 'DIVERGENCE':  return { entryRSI: 30, exitRSI: 60, stopLoss: -2.5, maxBars: 30 };
    case 'ADAPTIVE':   return { entryRSI: 42, exitRSI: 65, stopLoss: -2, maxBars: 30 };
    default:           return { entryRSI: 40, exitRSI: 65, stopLoss: -2, maxBars: 30 };
  }
}

function shouldEnter(rsi, closes, i, t) {
  if (rsi > t.entryRSI) return false;
  // Require upward momentum
  const ma5 = closes.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
  return closes[i] > ma5;
}

function shouldExit(rsi, pnlPct, bars, t) {
  if (pnlPct <= t.stopLoss) return true;
  if (rsi >= t.exitRSI) return true;
  if (bars >= t.maxBars) return true;
  if (pnlPct >= 3) return true; // take profit
  return false;
}

function quickRSI(closes, endIdx, period) {
  if (endIdx < period) return 50;
  let gains = 0, losses = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / (losses || 0.001);
  return 100 - 100 / (1 + rs);
}

/**
 * Run backtest for all strategies
 */
async function runContinuousBacktest() {
  if (!getFlag('CONTINUOUS_BACKTEST_ENABLED')) return;

  try {
    ensureTable();
    const d = getDb();
    const now = Date.now();
    const lookbackMs = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const periodStart = now - lookbackMs;

    // Fetch candle history from DB
    const tickers = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'BNBUSD'];

    for (const strategy of STRATEGIES) {
      let totalTrades = 0;
      let wins = 0;
      let totalPnl = 0;
      let maxDrawdown = 0;
      let runningPnl = 0;
      let peak = 0;

      for (const ticker of tickers) {
        try {
          const candles = d.prepare(
            'SELECT * FROM candle_history WHERE ticker = ? AND time >= ? ORDER BY time ASC'
          ).all(ticker, periodStart);

          if (candles.length < 50) continue;

          const trades = backtestStrategy(candles, strategy);
          for (const trade of trades) {
            totalTrades++;
            totalPnl += trade.pnl;
            if (trade.pnl > 0) wins++;

            runningPnl += trade.pnl;
            if (runningPnl > peak) peak = runningPnl;
            const dd = peak - runningPnl;
            if (dd > maxDrawdown) maxDrawdown = dd;
          }
        } catch (e) {
          // Skip ticker
        }
      }

      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;

      // Store result
      try {
        d.prepare(`
          INSERT INTO backtest_results (strategy, period_start, period_end, win_rate, avg_pnl, max_drawdown, sample_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(strategy, periodStart, now, winRate, avgPnl, maxDrawdown, totalTrades, now);
      } catch (e) {
        // DB write failed
      }

      lastResults.set(strategy, { winRate, avgPnl, maxDrawdown, totalTrades, timestamp: now });
    }

    console.log(`${LOG} Backtest complete: ${STRATEGIES.length} strategies across ${tickers.length} tickers`);

    // Cleanup old results (keep last 7 days)
    try {
      d.prepare('DELETE FROM backtest_results WHERE created_at < ?').run(now - lookbackMs);
    } catch {}

  } catch (err) {
    console.error(`${LOG} Error:`, err.message);
  }
}

/**
 * Get confidence penalty for a strategy (0 = no penalty, 0.25 = 25% penalty)
 */
export function getStrategyPenalty(strategy) {
  const result = lastResults.get(strategy);
  if (!result || result.totalTrades < 5) return 0; // Not enough data
  if (result.winRate < 30) return 0.25; // 25% confidence penalty
  return 0;
}

/**
 * Get all backtest results
 */
export function getBacktestResults() {
  return Object.fromEntries(lastResults);
}

/**
 * Get results from DB
 */
export function getBacktestHistory(strategy, limit = 50) {
  try {
    ensureTable();
    if (strategy) {
      return getDb().prepare(
        'SELECT * FROM backtest_results WHERE strategy = ? ORDER BY created_at DESC LIMIT ?'
      ).all(strategy, limit);
    }
    return getDb().prepare(
      'SELECT * FROM backtest_results ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  } catch {
    return [];
  }
}

/**
 * Start continuous backtesting
 */
export function start() {
  if (interval) return;
  ensureTable();
  console.log(`${LOG} Started (every ${BACKTEST_INTERVAL_MS / 60000} min)`);
  // Run first one after 2 minutes to let system warm up
  setTimeout(() => {
    runContinuousBacktest();
    interval = setInterval(runContinuousBacktest, BACKTEST_INTERVAL_MS);
  }, 120000);
}

export function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

export function getStatus() {
  return {
    running: !!interval,
    strategies: STRATEGIES.length,
    lastResults: Object.fromEntries(lastResults),
  };
}
