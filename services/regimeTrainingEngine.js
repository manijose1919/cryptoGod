/**
 * Regime-Specific Training Engine
 *
 * Runs 5 sequential training sessions, one per market regime
 * (STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN), using the existing
 * regimeGate selectivity filter. Produces a composite seed that
 * merges the best params per regime.
 */

import {
  startTraining,
  stopTraining,
  getTrainingStatus,
  getLearnedState,
  modifySeed,
} from './historicalTrainingEngine.js';
import { getDb } from './database.js';

const REGIMES = ['STRONG_UP', 'UP', 'SIDEWAYS', 'DOWN', 'STRONG_DOWN'];

let state = {
  running: false,
  currentRegime: null,
  completedRegimes: 0,
  regimeResults: {},
  compositeRunId: null,
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

export async function startRegimeTraining({
  tickers,
  initialCash = 10000,
  seedRunId,
  strategyFilter,
}) {
  if (state.running) throw new Error('Regime training already running');

  state = {
    running: true,
    currentRegime: null,
    completedRegimes: 0,
    regimeResults: {},
    compositeRunId: null,
    results: null,
    error: null,
    aborted: false,
  };

  runRegimeTraining({ tickers, initialCash, seedRunId, strategyFilter }).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { regimes: REGIMES };
}

async function runRegimeTraining({ tickers, initialCash, seedRunId, strategyFilter }) {
  for (const regime of REGIMES) {
    if (state.aborted) { state.running = false; return; }

    state.currentRegime = regime;

    try {
      const result = await startTraining({
        tickers,
        initialCash,
        seedRunId,
        strategyFilter,
        selectivity: {
          regimeGate: [regime],
          minOppScore: 15,
          minRegimeStrategyWR: 0.30,
          minBinWR: 0.30,
          minMemoryTradesForGate: 30,
          entryCooldownSteps: 1,
        },
        _isSubRun: true,
      });

      const status = await waitForTrainingComplete();
      if (state.aborted) { state.running = false; return; }

      state.regimeResults[regime] = {
        runId: result.runId,
        pnl: status?.stats?.totalPnl ?? 0,
        trades: status?.stats?.totalTrades ?? 0,
        winRate: status?.stats?.winRate ?? 0,
        status: 'completed',
      };
    } catch (e) {
      if (state.aborted) { state.running = false; return; }
      state.regimeResults[regime] = {
        runId: null,
        pnl: 0,
        trades: 0,
        winRate: 0,
        status: 'error',
        error: e.message,
      };
    }

    state.completedRegimes++;
  }

  // Save results to DB
  for (const [regime, data] of Object.entries(state.regimeResults)) {
    try {
      getDb().prepare(`
        INSERT INTO regime_training_results (regime, run_id, pnl, win_rate, trades)
        VALUES (?, ?, ?, ?, ?)
      `).run(regime, data.runId, data.pnl, data.winRate, data.trades);
    } catch (e) {
      console.warn('[RegimeTraining] DB save warning:', e.message);
    }
  }

  state.results = {
    regimeResults: state.regimeResults,
    compositeRunId: state.compositeRunId,
  };
  state.running = false;
  console.log(`[RegimeTraining] Completed all ${REGIMES.length} regimes`);
}

/**
 * Create a composite seed from completed regime training.
 * Takes the best exit params per regime and merges them.
 */
export function createComposite(baseRunId) {
  const regimeExitOverrides = {};
  let bestOverallRunId = baseRunId;

  for (const [regime, data] of Object.entries(state.regimeResults)) {
    if (!data.runId || data.status !== 'completed') continue;

    const learnedState = getLearnedState(data.runId);
    if (!learnedState?.tradeMemory?.exitParams) continue;

    const ep = learnedState.tradeMemory.exitParams;
    regimeExitOverrides[regime] = {
      stopLoss: ep.stopLoss,
      takeProfit: ep.takeProfit,
      maxHold: ep.maxHold,
      trailingStart: ep.trailingStart,
      trailingGiveBack: ep.trailingGiveBack,
    };

    // Use best-performing regime's run as the base
    if (!bestOverallRunId && data.pnl > 0) {
      bestOverallRunId = data.runId;
    }
  }

  if (!bestOverallRunId) throw new Error('No base run available for composite');

  const result = modifySeed(bestOverallRunId, { regimeExitOverrides });
  state.compositeRunId = result.runId;
  return result;
}

export function stopRegimeTraining() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  try { stopTraining(); } catch { /* may not be running */ }
  return { stopped: true };
}

export function getRegimeTrainingStatus() {
  return {
    running: state.running,
    currentRegime: state.currentRegime,
    completedRegimes: state.completedRegimes,
    totalRegimes: REGIMES.length,
    pct: Math.round((state.completedRegimes / REGIMES.length) * 100),
    regimeResults: state.regimeResults,
    compositeRunId: state.compositeRunId,
    error: state.error,
  };
}

export function getRegimeTrainingResults() {
  return state.results;
}
