/**
 * Cross-Pair Validation Engine
 *
 * Trains on a subset of pairs, then tests on held-out pairs
 * to measure generalization. A generalization ratio >0.5 is good,
 * <0.3 suggests overfitting to specific pair dynamics.
 */

import {
  startTraining,
  stopTraining,
  getTrainingStatus,
  getLearnedState,
} from './historicalTrainingEngine.js';
import { getDb } from './database.js';

let state = {
  running: false,
  phase: null, // 'training' | 'testing'
  trainPairs: [],
  testPairs: [],
  trainRunId: null,
  testRunId: null,
  trainPnl: null,
  testPnl: null,
  generalizationRatio: null,
  results: null,
  error: null,
  aborted: false,
};

function waitForTrainingComplete(maxWaitMs = 7200000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const s = getTrainingStatus();
      if (!s.active) return resolve(s);
      if (Date.now() - start > maxWaitMs) return reject(new Error('Training timed out'));
      if (state.aborted) return reject(new Error('Aborted'));
      setTimeout(check, 2000);
    };
    check();
  });
}

export async function startCrossPairValidation({
  trainPairs,
  testPairs,
  seedRunId,
  initialCash = 10000,
  strategyFilter,
  selectivity,
}) {
  if (state.running) throw new Error('Cross-pair validation already running');
  if (!trainPairs || trainPairs.length < 1) throw new Error('Need at least 1 training pair');
  if (!testPairs || testPairs.length < 1) throw new Error('Need at least 1 test pair');

  // Ensure no overlap
  const overlap = trainPairs.filter(p => testPairs.includes(p));
  if (overlap.length > 0) throw new Error(`Overlapping pairs: ${overlap.join(', ')}`);

  state = {
    running: true,
    phase: 'training',
    trainPairs,
    testPairs,
    trainRunId: null,
    testRunId: null,
    trainPnl: null,
    testPnl: null,
    generalizationRatio: null,
    results: null,
    error: null,
    aborted: false,
  };

  runValidation({ trainPairs, testPairs, seedRunId, initialCash, strategyFilter, selectivity })
    .catch(err => {
      state.error = err.message;
      state.running = false;
    });

  return { trainPairs, testPairs };
}

async function runValidation({ trainPairs, testPairs, seedRunId, initialCash, strategyFilter, selectivity }) {
  // Phase 1: Train on training pairs
  state.phase = 'training';
  const trainResult = await startTraining({
    tickers: trainPairs,
    initialCash,
    seedRunId,
    strategyFilter,
    selectivity,
    _isSubRun: true,
  });
  state.trainRunId = trainResult.runId;

  const trainStatus = await waitForTrainingComplete();
  if (state.aborted) { state.running = false; return; }

  state.trainPnl = trainStatus?.stats?.totalPnl ?? 0;

  // Get learned state from training phase
  const learnedState = getLearnedState(state.trainRunId);
  if (!learnedState) {
    state.error = 'Failed to get learned state from training phase';
    state.running = false;
    return;
  }

  // Phase 2: Evaluate on test pairs with frozen state
  state.phase = 'testing';
  const testResult = await startTraining({
    tickers: testPairs,
    initialCash,
    evaluationOnly: true,
    frozenState: learnedState,
    strategyFilter,
    selectivity,
    _isSubRun: true,
  });
  state.testRunId = testResult.runId;

  const testStatus = await waitForTrainingComplete();
  if (state.aborted) { state.running = false; return; }

  state.testPnl = testStatus?.stats?.totalPnl ?? 0;

  // Calculate generalization ratio
  const genRatio = state.trainPnl !== 0
    ? state.testPnl / Math.abs(state.trainPnl)
    : (state.testPnl > 0 ? 1.0 : 0.0);

  state.generalizationRatio = genRatio;

  const results = {
    trainPairs,
    testPairs,
    trainRunId: state.trainRunId,
    testRunId: state.testRunId,
    trainPnl: state.trainPnl,
    testPnl: state.testPnl,
    trainTrades: trainStatus?.stats?.totalTrades ?? 0,
    testTrades: testStatus?.stats?.totalTrades ?? 0,
    trainWinRate: trainStatus?.stats?.winRate ?? 0,
    testWinRate: testStatus?.stats?.winRate ?? 0,
    generalizationRatio: genRatio,
    verdict: genRatio > 0.5 ? 'GOOD' : genRatio > 0.3 ? 'MODERATE' : 'OVERFITTING',
  };

  // Save to DB
  try {
    getDb().prepare(`
      INSERT INTO cross_pair_results
      (train_pairs, test_pairs, train_run_id, test_run_id, train_pnl, test_pnl, generalization_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      JSON.stringify(trainPairs), JSON.stringify(testPairs),
      state.trainRunId, state.testRunId,
      state.trainPnl, state.testPnl, genRatio
    );
  } catch (e) {
    console.warn('[CrossPair] DB save warning:', e.message);
  }

  state.results = results;
  state.running = false;
  console.log(`[CrossPair] Completed: train=$${state.trainPnl.toFixed(2)}, test=$${state.testPnl.toFixed(2)}, gen=${genRatio.toFixed(3)} (${results.verdict})`);
}

export function stopCrossPairValidation() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  try { stopTraining(); } catch { /* may not be running */ }
  return { stopped: true };
}

export function getCrossPairStatus() {
  return {
    running: state.running,
    phase: state.phase,
    trainPairs: state.trainPairs,
    testPairs: state.testPairs,
    trainRunId: state.trainRunId,
    testRunId: state.testRunId,
    trainPnl: state.trainPnl,
    testPnl: state.testPnl,
    generalizationRatio: state.generalizationRatio,
    error: state.error,
  };
}

export function getCrossPairResults(runId) {
  if (state.results && (state.results.trainRunId === runId || state.results.testRunId === runId)) {
    return state.results;
  }
  try {
    const row = getDb().prepare(
      'SELECT * FROM cross_pair_results WHERE train_run_id = ? OR test_run_id = ? ORDER BY result_id DESC LIMIT 1'
    ).get(runId, runId);
    if (row) {
      return {
        trainPairs: JSON.parse(row.train_pairs),
        testPairs: JSON.parse(row.test_pairs),
        trainRunId: row.train_run_id,
        testRunId: row.test_run_id,
        trainPnl: row.train_pnl,
        testPnl: row.test_pnl,
        generalizationRatio: row.generalization_ratio,
        verdict: row.generalization_ratio > 0.5 ? 'GOOD' : row.generalization_ratio > 0.3 ? 'MODERATE' : 'OVERFITTING',
      };
    }
  } catch { /* table may not exist */ }
  return null;
}
