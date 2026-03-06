/**
 * Monte Carlo Stress Test Engine
 *
 * Shuffles a completed run's trade P&L order N times to build
 * confidence intervals around equity outcomes. Uses Fisher-Yates
 * shuffle and yields to the event loop every 100 iterations.
 */

import { getDb } from './database.js';

let state = {
  running: false,
  runId: null,
  iterations: 0,
  completed: 0,
  results: null,
  error: null,
  aborted: false,
};

function yield100() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Fisher-Yates shuffle (in-place)
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Start a Monte Carlo simulation on a completed training run.
 */
export async function startMonteCarlo({ runId, iterations = 1000 }) {
  if (state.running) throw new Error('Monte Carlo already running');
  if (!runId) throw new Error('runId required');

  // Load SELL trades for this run
  const trades = getDb().prepare(
    `SELECT pnl, pnl_percent FROM training_trades
     WHERE run_id = ? AND type = 'SELL' ORDER BY time ASC`
  ).all(runId);

  if (trades.length < 5) throw new Error(`Not enough trades (${trades.length}) for Monte Carlo`);

  state = {
    running: true,
    runId,
    iterations,
    completed: 0,
    results: null,
    error: null,
    aborted: false,
  };

  // Run async
  runSimulation(trades, iterations).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { runId, iterations, trades: trades.length };
}

async function runSimulation(trades, iterations) {
  const pnls = trades.map(t => t.pnl);
  const initialEquity = 10000; // Normalized starting equity
  const finalEquities = [];

  for (let i = 0; i < iterations; i++) {
    if (state.aborted) {
      state.running = false;
      return;
    }

    // Shuffle a copy
    const shuffled = [...pnls];
    shuffle(shuffled);

    // Replay equity curve
    let equity = initialEquity;
    for (const pnl of shuffled) {
      equity += pnl;
    }
    finalEquities.push(equity - initialEquity); // Net P&L

    state.completed = i + 1;

    // Yield every 100 iterations
    if ((i + 1) % 100 === 0) await yield100();
  }

  // Sort for percentile calculations
  finalEquities.sort((a, b) => a - b);

  const n = finalEquities.length;
  const p5 = finalEquities[Math.floor(n * 0.05)];
  const p25 = finalEquities[Math.floor(n * 0.25)];
  const p50 = finalEquities[Math.floor(n * 0.50)];
  const p75 = finalEquities[Math.floor(n * 0.75)];
  const p95 = finalEquities[Math.floor(n * 0.95)];
  const mean = finalEquities.reduce((s, v) => s + v, 0) / n;
  const profitCount = finalEquities.filter(v => v > 0).length;
  const probabilityOfProfit = profitCount / n;

  // Build 50-bucket histogram
  const min = finalEquities[0];
  const max = finalEquities[n - 1];
  const bucketWidth = (max - min) / 50 || 1;
  const histogram = Array(50).fill(0);
  for (const v of finalEquities) {
    const idx = Math.min(Math.floor((v - min) / bucketWidth), 49);
    histogram[idx]++;
  }

  const results = {
    runId: state.runId,
    iterations,
    tradeCount: pnls.length,
    medianPnl: p50,
    meanPnl: mean,
    p5Pnl: p5,
    p25Pnl: p25,
    p75Pnl: p75,
    p95Pnl: p95,
    probabilityOfProfit,
    histogram,
    histogramMin: min,
    histogramMax: max,
    bucketWidth,
  };

  // Save to DB
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO monte_carlo_results
      (run_id, iterations, median_pnl, p5_pnl, p95_pnl, probability_of_profit, histogram_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(state.runId, iterations, p50, p5, p95, probabilityOfProfit, JSON.stringify(results));
  } catch (e) {
    console.warn('[MonteCarlo] DB save warning:', e.message);
  }

  state.results = results;
  state.running = false;
  console.log(`[MonteCarlo] Completed ${iterations} iterations for ${state.runId}: median=$${p50.toFixed(2)}, PoP=${(probabilityOfProfit * 100).toFixed(1)}%`);
}

export function stopMonteCarlo() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  return { stopped: true, runId: state.runId };
}

export function getMonteCarloStatus() {
  return {
    running: state.running,
    runId: state.runId,
    iterations: state.iterations,
    completed: state.completed,
    pct: state.iterations > 0 ? Math.round((state.completed / state.iterations) * 100) : 0,
    error: state.error,
  };
}

export function getMonteCarloResults(runId) {
  if (state.results && state.results.runId === runId) return state.results;
  // Try DB
  try {
    const row = getDb().prepare(
      'SELECT * FROM monte_carlo_results WHERE run_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(runId);
    if (row) return JSON.parse(row.histogram_json);
  } catch { /* table may not exist */ }
  return null;
}
