/**
 * Sensitivity Analysis Engine
 *
 * Wiggles each tunable parameter ±10%/±20% and evaluates P&L impact
 * via frozen-state evaluation runs through the existing training engine.
 * Flags "fragile" params where ±10% swings P&L >30%.
 */

import {
  startTraining,
  stopTraining,
  getTrainingStatus,
  getLearnedState,
} from './historicalTrainingEngine.js';
import { getDb } from './database.js';

// 12 tunable parameters
const TUNABLE_PARAMS = [
  // Entry thresholds (from optimizer)
  { key: 'TREND_BULLISH_ENTRY', path: 'optimizer.optimizedParams', default: 40 },
  { key: 'TREND_BEARISH_EXIT', path: 'optimizer.optimizedParams', default: 75 },
  { key: 'BREAKOUT_SQUEEZE_ENTRY', path: 'optimizer.optimizedParams', default: 40 },
  { key: 'MOMENTUM_BULLISH_ENTRY', path: 'optimizer.optimizedParams', default: 30 },
  { key: 'WHALE_ACCUMULATION_ENTRY', path: 'optimizer.optimizedParams', default: 45 },
  { key: 'CONFLUENCE_ENTRY', path: 'optimizer.optimizedParams', default: 35 },
  { key: 'DIVERGENCE_ENTRY', path: 'optimizer.optimizedParams', default: 30 },
  // Exit params (from tradeMemory)
  { key: 'stopLoss', path: 'tradeMemory.exitParams', default: -0.05 },
  { key: 'takeProfit', path: 'tradeMemory.exitParams', default: 0.05 },
  { key: 'maxHold', path: 'tradeMemory.exitParams', default: 120 },
  { key: 'trailingStart', path: 'tradeMemory.exitParams', default: 0.10 },
  { key: 'trailingGiveBack', path: 'tradeMemory.exitParams', default: 0.35 },
];

let state = {
  running: false,
  runId: null,
  totalEvals: 0,
  completedEvals: 0,
  currentParam: null,
  currentVariation: null,
  results: null,
  error: null,
  aborted: false,
};

function waitForTrainingComplete(maxWaitMs = 3600000) {
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

export async function startSensitivityAnalysis({ runId, variations = [0.1, 0.2] }) {
  if (state.running) throw new Error('Sensitivity analysis already running');
  if (!runId) throw new Error('runId required');

  const baseState = getLearnedState(runId);
  if (!baseState) throw new Error('No learned state for run ' + runId);

  const variationMultipliers = [];
  for (const v of variations) {
    variationMultipliers.push(1 - v, 1 + v); // e.g., [0.9, 1.1, 0.8, 1.2]
  }
  // Plus baseline (1.0)
  const allMultipliers = [1.0, ...variationMultipliers];
  const totalEvals = TUNABLE_PARAMS.length * variationMultipliers.length + 1; // +1 for baseline

  state = {
    running: true,
    runId,
    totalEvals,
    completedEvals: 0,
    currentParam: null,
    currentVariation: null,
    results: null,
    error: null,
    aborted: false,
  };

  runAnalysis(baseState, runId, variationMultipliers).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { runId, totalEvals, params: TUNABLE_PARAMS.length };
}

function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

function setNestedValue(obj, path, key, value) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (!current[part]) current[part] = {};
    current = current[part];
  }
  current[key] = value;
}

function getNestedValue(obj, path, key) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (!current || !current[part]) return undefined;
    current = current[part];
  }
  return current[key];
}

async function runAnalysis(baseState, sourceRunId, variationMultipliers) {
  const paramResults = {};

  // First run baseline
  state.currentParam = 'BASELINE';
  state.currentVariation = '1.0x';

  let baselinePnl;
  try {
    const frozen = cloneState(baseState);
    await startTraining({
      evaluationOnly: true,
      frozenState: frozen,
      _isSubRun: true,
    });
    const result = await waitForTrainingComplete();
    baselinePnl = result?.stats?.totalPnl ?? 0;
  } catch (e) {
    if (state.aborted) { state.running = false; return; }
    baselinePnl = 0;
  }
  state.completedEvals++;

  // Now sweep each param
  for (const param of TUNABLE_PARAMS) {
    if (state.aborted) { state.running = false; return; }

    const baseValue = getNestedValue(baseState, param.path, param.key) ?? param.default;
    const evalResults = { baseValue, variations: {} };

    for (const mult of variationMultipliers) {
      if (state.aborted) { state.running = false; return; }

      const modifiedValue = baseValue * mult;
      const label = `${((mult - 1) * 100).toFixed(0)}%`;
      state.currentParam = param.key;
      state.currentVariation = label;

      try {
        const frozen = cloneState(baseState);
        setNestedValue(frozen, param.path, param.key, modifiedValue);

        await startTraining({
          evaluationOnly: true,
          frozenState: frozen,
          _isSubRun: true,
        });
        const result = await waitForTrainingComplete();
        const pnl = result?.stats?.totalPnl ?? 0;
        const pnlDelta = baselinePnl !== 0 ? ((pnl - baselinePnl) / Math.abs(baselinePnl)) * 100 : 0;

        evalResults.variations[label] = {
          value: modifiedValue,
          pnl,
          pnlDelta,
        };
      } catch (e) {
        if (state.aborted) { state.running = false; return; }
        evalResults.variations[label] = { value: modifiedValue, pnl: 0, pnlDelta: 0, error: e.message };
      }

      state.completedEvals++;
    }

    paramResults[param.key] = evalResults;
  }

  // Identify fragile params: ±10% causes >30% P&L swing
  const fragileParams = [];
  for (const [key, data] of Object.entries(paramResults)) {
    const v10 = [data.variations['-10%'], data.variations['10%']].filter(Boolean);
    for (const v of v10) {
      if (Math.abs(v.pnlDelta) > 30) {
        fragileParams.push(key);
        break;
      }
    }
  }

  const results = {
    runId: sourceRunId,
    baselinePnl,
    paramResults,
    fragileParams,
    totalEvals: state.totalEvals,
  };

  // Save to DB
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO sensitivity_results (run_id, results_json, fragile_params)
      VALUES (?, ?, ?)
    `).run(sourceRunId, JSON.stringify(results), JSON.stringify(fragileParams));
  } catch (e) {
    console.warn('[Sensitivity] DB save warning:', e.message);
  }

  state.results = results;
  state.running = false;
  console.log(`[Sensitivity] Completed for ${sourceRunId}: ${fragileParams.length} fragile params found`);
}

export function stopSensitivityAnalysis() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  try { stopTraining(); } catch { /* may not be running */ }
  return { stopped: true, runId: state.runId };
}

export function getSensitivityStatus() {
  return {
    running: state.running,
    runId: state.runId,
    totalEvals: state.totalEvals,
    completedEvals: state.completedEvals,
    pct: state.totalEvals > 0 ? Math.round((state.completedEvals / state.totalEvals) * 100) : 0,
    currentParam: state.currentParam,
    currentVariation: state.currentVariation,
    error: state.error,
  };
}

export function getSensitivityResults(runId) {
  if (state.results && state.results.runId === runId) return state.results;
  try {
    const row = getDb().prepare(
      'SELECT * FROM sensitivity_results WHERE run_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(runId);
    if (row) return JSON.parse(row.results_json);
  } catch { /* table may not exist */ }
  return null;
}
