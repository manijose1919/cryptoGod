/**
 * Monte Carlo Backtesting Simulation Service
 * Runs bootstrap resampling on historical trade data to produce
 * confidence intervals for key performance metrics (equity, Sharpe,
 * max drawdown, annual return).
 */

import { getFlag } from './systemConfig.js';
import { getDb } from './database.js';

// ─── Constants ───────────────────────────────────────────────────────
const MIN_TRADES = 20;
const TRADING_DAYS_PER_YEAR = 365; // crypto markets trade 24/7

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Return the value at a given percentile from a **sorted** numeric array.
 * Uses linear interpolation between adjacent ranks.
 * @param {number[]} sortedArray - ascending-sorted numbers
 * @param {number}   pct         - percentile in [0, 100]
 * @returns {number}
 */
export function getPercentile(sortedArray, pct) {
  if (!sortedArray || sortedArray.length === 0) return 0;
  if (sortedArray.length === 1) return sortedArray[0];

  const idx = (pct / 100) * (sortedArray.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sortedArray[lo];

  const frac = idx - lo;
  return sortedArray[lo] * (1 - frac) + sortedArray[hi] * frac;
}

// ─── Core Simulation ─────────────────────────────────────────────────

/**
 * Run a Monte Carlo bootstrap simulation over completed trade history.
 *
 * @param {Array<{pnl: number, pnlPercent: number, holdDuration: number}>} tradeHistory
 * @param {number} [nSims=1000]          - number of simulations
 * @param {number} [initialCapital=1000] - starting equity per sim
 * @returns {{
 *   percentile5: number,
 *   percentile50: number,
 *   percentile95: number,
 *   sharpeCI:       {p5: number, p50: number, p95: number},
 *   maxDrawdownCI:  {p5: number, p50: number, p95: number},
 *   annualReturnCI: {p5: number, p50: number, p95: number},
 *   simulations: number
 * } | null}
 */
export function runMonteCarloSimulation(tradeHistory, nSims = 1000, initialCapital = 1000) {
  try {
    // ── Gate check ──────────────────────────────────────────────────
    const enabled = getFlag('MONTE_CARLO_ENABLED');
    if (enabled === false) return null;

    if (!Array.isArray(tradeHistory) || tradeHistory.length < MIN_TRADES) {
      return null;
    }

    console.log(`[MonteCarlo] Running ${nSims} simulations on ${tradeHistory.length} trades...`);

    const n = tradeHistory.length;

    // Pre-extract pnlPercent values for fast random access
    const pnlPcts = tradeHistory.map(t => t.pnlPercent ?? 0);
    const holdDurations = tradeHistory.map(t => t.holdDuration ?? 0);

    // Average hold duration in days (ms → days, default to hours if small)
    const avgHoldDays = holdDurations.reduce((s, d) => s + d, 0) / n;
    // Estimate trades per year from average hold duration
    const tradesPerYear = avgHoldDays > 0
      ? TRADING_DAYS_PER_YEAR / avgHoldDays
      : TRADING_DAYS_PER_YEAR; // fallback: ~1 trade/day

    // Collect per-simulation results
    const finalEquities = new Array(nSims);
    const sharpes       = new Array(nSims);
    const maxDrawdowns  = new Array(nSims);
    const annualReturns = new Array(nSims);

    for (let s = 0; s < nSims; s++) {
      // ── Bootstrap resample ──────────────────────────────────────
      let equity = initialCapital;
      let peak   = equity;
      let maxDD  = 0;
      const returns = new Array(n); // per-trade returns for Sharpe

      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * n);
        const r   = pnlPcts[idx] / 100; // convert percent → decimal

        returns[i] = r;
        equity *= (1 + r);
        if (equity > peak) peak = equity;

        const dd = peak > 0 ? (peak - equity) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }

      // ── Sharpe ratio (annualized) ──────────────────────────────
      const meanR = returns.reduce((s, r) => s + r, 0) / n;
      const variance = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / n;
      const stdR = Math.sqrt(variance);
      const annualizationFactor = Math.sqrt(tradesPerYear);
      const sharpe = stdR > 0 ? (meanR / stdR) * annualizationFactor : 0;

      // ── Annual return (compound) ───────────────────────────────
      const totalReturn = equity / initialCapital;
      const periodsInYear = tradesPerYear / n; // how many "sets of n trades" per year
      const annualReturn = periodsInYear > 0
        ? (Math.pow(totalReturn, periodsInYear) - 1) * 100
        : 0;

      finalEquities[s] = equity;
      sharpes[s]       = sharpe;
      maxDrawdowns[s]  = maxDD * 100; // store as percentage
      annualReturns[s] = annualReturn;
    }

    // ── Sort arrays for percentile extraction ────────────────────
    finalEquities.sort((a, b) => a - b);
    sharpes.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);
    annualReturns.sort((a, b) => a - b);

    const results = {
      percentile5:  getPercentile(finalEquities, 5),
      percentile50: getPercentile(finalEquities, 50),
      percentile95: getPercentile(finalEquities, 95),
      sharpeCI: {
        p5:  getPercentile(sharpes, 5),
        p50: getPercentile(sharpes, 50),
        p95: getPercentile(sharpes, 95),
      },
      maxDrawdownCI: {
        p5:  getPercentile(maxDrawdowns, 5),
        p50: getPercentile(maxDrawdowns, 50),
        p95: getPercentile(maxDrawdowns, 95),
      },
      annualReturnCI: {
        p5:  getPercentile(annualReturns, 5),
        p50: getPercentile(annualReturns, 50),
        p95: getPercentile(annualReturns, 95),
      },
      simulations: nSims,
    };

    console.log(
      `[MonteCarlo] Complete — Equity P5/P50/P95: ` +
      `$${results.percentile5.toFixed(2)} / $${results.percentile50.toFixed(2)} / $${results.percentile95.toFixed(2)}`
    );

    return results;
  } catch (err) {
    console.error('[MonteCarlo] Simulation error:', err.message);
    return null;
  }
}

// ─── Persistence ─────────────────────────────────────────────────────

/**
 * Ensure the `monte_carlo_results` table exists.
 * Called lazily before any DB operation.
 */
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS monte_carlo_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      percentile5 REAL,
      percentile50 REAL,
      percentile95 REAL,
      sharpe_p5 REAL,
      sharpe_p50 REAL,
      sharpe_p95 REAL,
      max_dd_p5 REAL,
      max_dd_p50 REAL,
      max_dd_p95 REAL,
      annual_return_p5 REAL,
      annual_return_p50 REAL,
      annual_return_p95 REAL,
      simulations INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );
  `);
}

/**
 * Save Monte Carlo results to the database.
 * @param {string} sessionId
 * @param {object} results  - output of runMonteCarloSimulation
 */
export function saveMonteCarloResults(sessionId, results) {
  try {
    if (!results) return;
    ensureTable();
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO monte_carlo_results
        (session_id, percentile5, percentile50, percentile95,
         sharpe_p5, sharpe_p50, sharpe_p95,
         max_dd_p5, max_dd_p50, max_dd_p95,
         annual_return_p5, annual_return_p50, annual_return_p95,
         simulations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      results.percentile5,
      results.percentile50,
      results.percentile95,
      results.sharpeCI.p5,
      results.sharpeCI.p50,
      results.sharpeCI.p95,
      results.maxDrawdownCI.p5,
      results.maxDrawdownCI.p50,
      results.maxDrawdownCI.p95,
      results.annualReturnCI.p5,
      results.annualReturnCI.p50,
      results.annualReturnCI.p95,
      results.simulations
    );

    console.log(`[MonteCarlo] Results saved for session ${sessionId}`);
  } catch (err) {
    console.error('[MonteCarlo] Failed to save results:', err.message);
  }
}

/**
 * Retrieve the most recent Monte Carlo result from the database.
 * @returns {object | null}
 */
export function getLatestMonteCarloResults() {
  try {
    ensureTable();
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM monte_carlo_results ORDER BY created_at DESC LIMIT 1'
    ).get();

    if (!row) return null;

    return {
      sessionId:   row.session_id,
      percentile5:  row.percentile5,
      percentile50: row.percentile50,
      percentile95: row.percentile95,
      sharpeCI: {
        p5:  row.sharpe_p5,
        p50: row.sharpe_p50,
        p95: row.sharpe_p95,
      },
      maxDrawdownCI: {
        p5:  row.max_dd_p5,
        p50: row.max_dd_p50,
        p95: row.max_dd_p95,
      },
      annualReturnCI: {
        p5:  row.annual_return_p5,
        p50: row.annual_return_p50,
        p95: row.annual_return_p95,
      },
      simulations: row.simulations,
      createdAt:   row.created_at,
    };
  } catch (err) {
    console.error('[MonteCarlo] Failed to load results:', err.message);
    return null;
  }
}
