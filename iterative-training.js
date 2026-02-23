#!/usr/bin/env node
/**
 * Iterative Walk-Forward Training Script
 *
 * Runs N sequential walk-forward validations, each seeded from the best fold
 * of the previous run. Targets 80-90% OOS win rate.
 *
 * Usage: node iterative-training.js [--iterations 10] [--port 3033] [--target-wr 80] [--selectivity high]
 */

const BASE_URL = `http://localhost:${parseArg('--port', 3033)}`;
const MAX_ITERATIONS = parseInt(parseArg('--iterations', 10));
const TARGET_WIN_RATE = parseFloat(parseArg('--target-wr', 80));
const SELECTIVITY = parseArg('--selectivity', 'normal'); // 'normal' or 'high'
const POLL_INTERVAL_MS = 30000; // 30s between status checks

const TICKERS = [
  'BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD',
  'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD',
];

const WF_CONFIG = {
  trainMonths: 12,
  testMonths: 3,
  stepMonths: 3,
  tickers: TICKERS,
  initialCash: 10000,
  skipMTF: true, // Skip 5m/15m — only 8 days of data
  selectivity: SELECTIVITY,
};

function parseArg(flag, defaultVal) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return defaultVal;
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Start a walk-forward run, optionally seeded from a previous training run.
 */
async function startWalkForward(seedRunId = null) {
  const body = { ...WF_CONFIG };
  if (seedRunId) {
    body.seedRunId = seedRunId;
  }

  const result = await fetchJSON(`${BASE_URL}/api/training/walk-forward/start`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!result.success) {
    throw new Error(`Failed to start walk-forward: ${JSON.stringify(result)}`);
  }

  return result;
}

/**
 * Poll walk-forward status until completion.
 */
async function waitForCompletion() {
  const startTime = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const status = await fetchJSON(`${BASE_URL}/api/training/walk-forward/status`);

    if (status.running) {
      const elapsed = formatDuration(Date.now() - startTime);
      const foldInfo = status.completedFolds != null
        ? `fold ${status.completedFolds}/${status.totalFolds}`
        : '';
      const phase = status.currentPhase || '';
      const progress = status.currentTrainingProgress
        ? ` (${(status.currentTrainingProgress * 100).toFixed(0)}%)`
        : '';
      log(`  ... ${elapsed} elapsed — ${foldInfo} ${phase}${progress}`);
      continue;
    }

    // Not running anymore
    if (status.status === 'completed') {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(`Walk-forward failed: ${status.error || 'unknown error'}`);
    }

    if (status.status === 'stopped') {
      throw new Error('Walk-forward was stopped externally');
    }

    // If not running and no status, check if there's a result via the runId
    if (status.runId) {
      const results = await fetchJSON(`${BASE_URL}/api/training/walk-forward/results/${status.runId}`);
      if (results.status === 'completed') {
        return { ...status, ...results };
      }
    }

    throw new Error(`Unexpected walk-forward status: ${JSON.stringify(status)}`);
  }
}

/**
 * Get full results for a completed walk-forward run.
 */
async function getResults(runId) {
  return fetchJSON(`${BASE_URL}/api/training/walk-forward/results/${runId}`);
}

/**
 * Extract the best fold's training run ID from WF results.
 * "Best" = highest OOS (test) win rate, with tie-breaking on PnL.
 */
function extractBestSeed(results) {
  if (!results.folds || results.folds.length === 0) {
    return null;
  }

  // Find fold with best OOS win rate (break ties with PnL)
  let bestFold = null;
  for (const fold of results.folds) {
    if (!fold.trainRunId) continue;
    if (fold.status !== 'completed') continue;
    if (
      !bestFold ||
      fold.testWinRate > bestFold.testWinRate ||
      (fold.testWinRate === bestFold.testWinRate && fold.testPnl > bestFold.testPnl)
    ) {
      bestFold = fold;
    }
  }

  if (!bestFold) return null;

  return {
    trainRunId: bestFold.trainRunId,
    foldNumber: bestFold.foldNumber,
    testWinRate: bestFold.testWinRate,
    testPnl: bestFold.testPnl,
    testTrades: bestFold.testTrades,
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  log('=== Iterative Walk-Forward Training ===');
  log(`Target: ${TARGET_WIN_RATE}% OOS win rate`);
  log(`Iterations: ${MAX_ITERATIONS}`);
  log(`Pairs: ${TICKERS.join(', ')}`);
  log(`Config: ${WF_CONFIG.trainMonths}mo train / ${WF_CONFIG.testMonths}mo test / ${WF_CONFIG.stepMonths}mo step`);
  log(`Selectivity: ${SELECTIVITY}`);
  log(`Server: ${BASE_URL}`);
  log('');

  const summary = [];
  let seedRunId = null;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const iterStart = Date.now();
    log(`--- Iteration ${iteration}/${MAX_ITERATIONS} ---`);
    if (seedRunId) {
      log(`  Seeded from: ${seedRunId}`);
    } else {
      log('  Starting from scratch (no seed)');
    }

    // Start walk-forward
    let startResult;
    try {
      startResult = await startWalkForward(seedRunId);
    } catch (err) {
      log(`  FAILED to start: ${err.message}`);
      summary.push({
        iteration,
        status: 'start_failed',
        error: err.message,
        seedRunId,
      });
      break; // Can't continue if we can't start
    }

    log(`  Walk-forward started: ${startResult.id} (${startResult.totalFolds} folds)`);

    // Wait for completion
    let finalStatus;
    try {
      finalStatus = await waitForCompletion();
    } catch (err) {
      log(`  FAILED during run: ${err.message}`);
      summary.push({
        iteration,
        wfRunId: startResult.id,
        status: 'run_failed',
        error: err.message,
        seedRunId,
      });
      break;
    }

    // Get full results
    const runId = finalStatus.runId || startResult.id;
    const results = await getResults(runId);
    const elapsed = formatDuration(Date.now() - iterStart);

    // Extract aggregate OOS stats
    const oos = results.aggregateOOS || {};
    const oosWR = oos.winRate || 0;
    const oosTrades = oos.totalTrades || 0;
    const oosPnl = oos.totalPnl || 0;

    // Extract best fold for seeding next iteration
    const bestSeed = extractBestSeed(results);

    const iterResult = {
      iteration,
      wfRunId: runId,
      status: 'completed',
      elapsed,
      seedRunId,
      totalFolds: results.totalFolds,
      completedFolds: results.completedFolds,
      aggregateOOS: {
        winRate: oosWR,
        totalTrades: oosTrades,
        totalPnl: oosPnl,
      },
      bestFold: bestSeed,
    };
    summary.push(iterResult);

    log(`  COMPLETED in ${elapsed}`);
    log(`  Aggregate OOS: ${oosWR.toFixed(1)}% WR, ${oosTrades} trades, $${oosPnl.toFixed(2)} PnL`);
    if (bestSeed) {
      log(`  Best fold #${bestSeed.foldNumber}: ${bestSeed.testWinRate.toFixed(1)}% WR, $${bestSeed.testPnl.toFixed(2)} PnL`);
    }

    // Check if target reached
    if (oosWR >= TARGET_WIN_RATE && oosTrades >= 10) {
      log('');
      log(`  TARGET REACHED: ${oosWR.toFixed(1)}% >= ${TARGET_WIN_RATE}%`);
      log(`  Best seed run ID for /api/training/apply: ${bestSeed?.trainRunId || 'N/A'}`);
      break;
    }

    // Seed next iteration from best fold
    if (bestSeed) {
      seedRunId = bestSeed.trainRunId;
      log(`  Next iteration will seed from: ${seedRunId} (fold #${bestSeed.foldNumber})`);
    } else {
      log('  WARNING: No valid fold found for seeding, next iteration starts fresh');
      seedRunId = null;
    }

    log('');
  }

  // ===== WRITE SUMMARY =====
  log('');
  log('=== FINAL SUMMARY ===');
  log('');

  for (const r of summary) {
    const wr = r.aggregateOOS?.winRate?.toFixed(1) || 'N/A';
    const trades = r.aggregateOOS?.totalTrades || 0;
    const pnl = r.aggregateOOS?.totalPnl?.toFixed(2) || 'N/A';
    const seed = r.seedRunId ? r.seedRunId.slice(0, 25) + '...' : 'none';
    log(`  Iter ${r.iteration}: ${r.status} | OOS WR: ${wr}% | Trades: ${trades} | PnL: $${pnl} | Seed: ${seed}`);
  }

  // Find best overall
  const completed = summary.filter(r => r.status === 'completed');
  if (completed.length > 0) {
    const best = completed.reduce((a, b) =>
      (a.aggregateOOS?.winRate || 0) > (b.aggregateOOS?.winRate || 0) ? a : b
    );
    log('');
    log(`  BEST: Iteration ${best.iteration} — ${best.aggregateOOS.winRate.toFixed(1)}% OOS WR`);
    if (best.bestFold) {
      log(`  Apply with: POST /api/training/apply { "runId": "${best.bestFold.trainRunId}" }`);
    }
  }

  // Write summary JSON
  const summaryPath = `iterative-training-summary-${Date.now()}.json`;
  const fs = await import('node:fs');
  fs.writeFileSync(summaryPath, JSON.stringify({
    startedAt: new Date().toISOString(),
    config: WF_CONFIG,
    targetWinRate: TARGET_WIN_RATE,
    maxIterations: MAX_ITERATIONS,
    iterations: summary,
    bestIteration: completed.length > 0
      ? completed.reduce((a, b) =>
          (a.aggregateOOS?.winRate || 0) > (b.aggregateOOS?.winRate || 0) ? a : b
        )
      : null,
  }, null, 2));

  log('');
  log(`Summary written to: ${summaryPath}`);
  log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
