/**
 * Walk-Forward Validation Engine
 *
 * Prevents overfitting by training on rolling windows and testing out-of-sample.
 * Each fold: train on N months → test on M months → step forward M months.
 *
 * Default: 12-month train, 3-month test, 3-month step → ~16 folds over 5 years.
 */

import crypto from 'node:crypto';
import {
  startTraining,
  getTrainingStatus,
  getLearnedState,
  createIsolatedState,
  seedStateFromRun,
} from './historicalTrainingEngine.js';
import {
  insertWalkForwardRun,
  updateWalkForwardRun,
  getWalkForwardRun,
  getWalkForwardRuns as getWalkForwardRunsFromDb,
  insertWalkForwardFold,
  updateWalkForwardFold,
  getWalkForwardFolds,
  getTrainingRun,
  getTrainingMLSamples,
  insertMLFeatures,
  getHistoricalCandleRange,
} from './database.js';

// Active walk-forward state
let activeWF = null;

/**
 * Generate fold windows for walk-forward validation.
 */
function generateFolds(dataStartTime, dataEndTime, trainMonths, testMonths, stepMonths) {
  const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000; // avg month in ms
  const trainMs = trainMonths * MS_PER_MONTH;
  const testMs = testMonths * MS_PER_MONTH;
  const stepMs = stepMonths * MS_PER_MONTH;

  const folds = [];
  let trainStart = dataStartTime;
  let foldNum = 0;

  while (true) {
    const trainEnd = trainStart + trainMs;
    const testStart = trainEnd;
    const testEnd = testStart + testMs;

    // Stop if test window exceeds data
    if (testEnd > dataEndTime + MS_PER_MONTH * 0.5) break;

    folds.push({
      foldNumber: foldNum++,
      trainStart: Math.floor(trainStart),
      trainEnd: Math.floor(trainEnd),
      testStart: Math.floor(testStart),
      testEnd: Math.floor(Math.min(testEnd, dataEndTime)),
    });

    trainStart += stepMs;
  }

  return folds;
}

/**
 * Wait for a training run to complete (polls status).
 */
function waitForTrainingComplete(runId, maxWaitMs = 3600000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      // Check if WF was stopped
      if (!activeWF || activeWF.status !== 'running') {
        reject(new Error('Walk-forward stopped'));
        return;
      }

      const status = getTrainingStatus();
      if (!status.active && status.status !== 'running') {
        // Training finished
        if (status.status === 'completed' || status.status === 'stopped') {
          resolve(status);
        } else {
          reject(new Error(`Training failed: ${status.error || status.status}`));
        }
        return;
      }

      if (Date.now() - startTime > maxWaitMs) {
        reject(new Error('Training timeout'));
        return;
      }

      // Update WF progress
      if (activeWF && status.progress) {
        activeWF.currentTrainingProgress = status.progress;
      }

      setTimeout(check, 5000); // Poll every 5s
    };
    // First check after a short delay to let training start
    setTimeout(check, 2000);
  });
}

/**
 * Start a walk-forward validation run.
 *
 * @param {Object} config
 * @param {number} config.trainMonths - Training window in months (default 12)
 * @param {number} config.testMonths - Test window in months (default 3)
 * @param {number} config.stepMonths - Step forward in months (default 3)
 * @param {string[]} config.tickers - Tickers to use
 * @param {number} config.initialCash - Starting cash per fold (default 10000)
 */
export async function startWalkForward(config = {}) {
  if (activeWF && activeWF.status === 'running') {
    throw new Error('Walk-forward validation already in progress');
  }

  const trainMonths = config.trainMonths || 12;
  const testMonths = config.testMonths || 3;
  const stepMonths = config.stepMonths || 3;
  const tickers = config.tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
  const initialCash = config.initialCash || 10000;

  // Determine data range from 1h candles
  let earliestTime = Infinity;
  let latestTime = 0;
  for (const ticker of tickers) {
    const range = getHistoricalCandleRange(ticker, '1h');
    if (range && range.earliest && range.earliest < earliestTime) earliestTime = range.earliest;
    if (range && range.latest && range.latest > latestTime) latestTime = range.latest;
  }

  if (earliestTime === Infinity) {
    throw new Error('No historical data available. Download data first.');
  }

  // Generate fold windows
  const foldWindows = generateFolds(earliestTime, latestTime, trainMonths, testMonths, stepMonths);
  if (foldWindows.length < 2) {
    throw new Error(`Not enough data for walk-forward. Need at least ${trainMonths + testMonths * 2} months. Have ${((latestTime - earliestTime) / (30.44 * 24 * 3600000)).toFixed(1)} months.`);
  }

  const wfId = `wf_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Save to DB
  insertWalkForwardRun({
    id: wfId,
    created_at: Date.now(),
    status: 'running',
    config: { trainMonths, testMonths, stepMonths, tickers, initialCash },
    total_folds: foldWindows.length,
    completed_folds: 0,
  });

  // Create fold records
  for (const fw of foldWindows) {
    const foldId = `${wfId}_fold_${fw.foldNumber}`;
    insertWalkForwardFold({
      id: foldId,
      wf_run_id: wfId,
      fold_number: fw.foldNumber,
      train_start: fw.trainStart,
      train_end: fw.trainEnd,
      test_start: fw.testStart,
      test_end: fw.testEnd,
      status: 'pending',
    });
  }

  // Initialize active state
  activeWF = {
    id: wfId,
    status: 'running',
    config: { trainMonths, testMonths, stepMonths, tickers, initialCash },
    totalFolds: foldWindows.length,
    completedFolds: 0,
    currentFold: 0,
    currentPhase: 'training',
    folds: foldWindows.map(fw => ({
      ...fw,
      trainPnl: 0, testPnl: 0,
      trainTrades: 0, testTrades: 0,
      trainWinRate: 0, testWinRate: 0,
      overfittingRatio: 0,
      status: 'pending',
    })),
    aggregateOOS: { totalTrades: 0, winRate: 0, totalPnl: 0, sharpe: 0 },
    startedAt: Date.now(),
    currentTrainingProgress: null,
  };

  console.log(`[WalkForward] Starting run ${wfId}: ${foldWindows.length} folds, ${trainMonths}mo train / ${testMonths}mo test / ${stepMonths}mo step`);

  // Run the walk-forward loop asynchronously
  runWalkForwardLoop(wfId, foldWindows, tickers, initialCash).catch(err => {
    console.error(`[WalkForward] Fatal error: ${err.message}`);
    if (activeWF && activeWF.id === wfId) {
      activeWF.status = 'failed';
      activeWF.error = err.message;
    }
    updateWalkForwardRun(wfId, { status: 'failed' });
  });

  return {
    id: wfId,
    totalFolds: foldWindows.length,
    folds: foldWindows,
  };
}

/**
 * Core walk-forward loop — runs each fold sequentially.
 */
async function runWalkForwardLoop(wfId, foldWindows, tickers, initialCash) {
  let previousRunId = null; // Seed each fold from the previous
  let oosTradesTotal = 0;
  let oosWinsTotal = 0;
  let oosPnlTotal = 0;
  let bestFoldId = null;
  let bestTestPnl = -Infinity;

  for (let i = 0; i < foldWindows.length; i++) {
    if (!activeWF || activeWF.status !== 'running') break;

    const fw = foldWindows[i];
    const foldId = `${wfId}_fold_${fw.foldNumber}`;
    activeWF.currentFold = i;
    activeWF.folds[i].status = 'training';
    activeWF.currentPhase = 'training';

    console.log(`[WalkForward] Fold ${i + 1}/${foldWindows.length}: Train ${new Date(fw.trainStart).toISOString().slice(0, 10)} → ${new Date(fw.trainEnd).toISOString().slice(0, 10)}, Test ${new Date(fw.testStart).toISOString().slice(0, 10)} → ${new Date(fw.testEnd).toISOString().slice(0, 10)}`);

    updateWalkForwardFold(foldId, { status: 'training' });

    // ===== TRAINING PHASE =====
    // Train with state mutations ON, seeded from previous fold
    try {
      const trainResult = await startTraining({
        tickers,
        initialCash,
        startTime: fw.trainStart,
        endTime: fw.trainEnd,
        seedRunId: previousRunId || undefined,
        evaluationOnly: false,
        _isSubRun: true,
      });

      // Wait for training to complete
      await waitForTrainingComplete(trainResult.runId);
      const trainRun = getTrainingRun(trainResult.runId);

      const trainPnl = trainRun?.total_pnl || 0;
      const trainTrades = trainRun?.total_trades || 0;
      const trainWinRate = trainRun?.win_rate || 0;

      activeWF.folds[i].trainPnl = trainPnl;
      activeWF.folds[i].trainTrades = trainTrades;
      activeWF.folds[i].trainWinRate = trainWinRate;

      updateWalkForwardFold(foldId, {
        train_run_id: trainResult.runId,
        train_pnl: trainPnl,
        train_trades: trainTrades,
        train_win_rate: trainWinRate,
        status: 'testing',
      });

      // ===== TEST PHASE (EVALUATION ONLY) =====
      activeWF.folds[i].status = 'testing';
      activeWF.currentPhase = 'testing';

      // Get learned state from training phase to freeze for evaluation
      const learnedState = getLearnedState(trainResult.runId);
      let frozenState = null;
      if (learnedState) {
        frozenState = createIsolatedState();
        // Import learned weights
        if (learnedState.adaptiveWeights) {
          for (const [strat, data] of Object.entries(learnedState.adaptiveWeights)) {
            if (frozenState.adaptiveWeights[strat]) {
              frozenState.adaptiveWeights[strat] = { ...data };
            }
          }
        }
        if (learnedState.optimizer?.optimizedParams) {
          frozenState.optimizer.optimizedParams = { ...frozenState.optimizer.optimizedParams, ...learnedState.optimizer.optimizedParams };
        }
        if (learnedState.tradeMemory) {
          frozenState.tradeMemory.regimeStrategy = learnedState.tradeMemory.regimeStrategy || {};
          frozenState.tradeMemory.indicatorBins = learnedState.tradeMemory.indicatorBins || {};
          frozenState.tradeMemory.exitParams = learnedState.tradeMemory.exitParams || frozenState.tradeMemory.exitParams;
        }
      }

      const testResult = await startTraining({
        tickers,
        initialCash,
        startTime: fw.testStart,
        endTime: fw.testEnd,
        evaluationOnly: true,
        frozenState,
        _isSubRun: true,
      });

      // Wait for test to complete
      await waitForTrainingComplete(testResult.runId);
      const testRun = getTrainingRun(testResult.runId);

      const testPnl = testRun?.total_pnl || 0;
      const testTrades = testRun?.total_trades || 0;
      const testWinRate = testRun?.win_rate || 0;

      // Overfitting ratio: test_return / train_return
      const trainReturn = trainPnl / initialCash;
      const testReturn = testPnl / initialCash;
      const overfittingRatio = trainReturn > 0 ? testReturn / trainReturn : (testReturn >= 0 ? 1 : 0);

      activeWF.folds[i].testPnl = testPnl;
      activeWF.folds[i].testTrades = testTrades;
      activeWF.folds[i].testWinRate = testWinRate;
      activeWF.folds[i].overfittingRatio = overfittingRatio;
      activeWF.folds[i].status = 'completed';

      updateWalkForwardFold(foldId, {
        test_run_id: testResult.runId,
        test_pnl: testPnl,
        test_trades: testTrades,
        test_win_rate: testWinRate,
        overfitting_ratio: overfittingRatio,
        learned_state_json: JSON.stringify(learnedState),
        status: 'completed',
      });

      // Accumulate OOS stats
      oosTradesTotal += testTrades;
      if (testWinRate > 0 && testTrades > 0) {
        oosWinsTotal += Math.round(testTrades * testWinRate / 100);
      }
      oosPnlTotal += testPnl;

      // Track best fold
      if (testPnl > bestTestPnl) {
        bestTestPnl = testPnl;
        bestFoldId = foldId;
      }

      // Use this fold's training run as seed for next fold
      previousRunId = trainResult.runId;

      activeWF.completedFolds = i + 1;
      activeWF.aggregateOOS = {
        totalTrades: oosTradesTotal,
        winRate: oosTradesTotal > 0 ? (oosWinsTotal / oosTradesTotal) * 100 : 0,
        totalPnl: oosPnlTotal,
        sharpe: 0, // Calculated at end
      };

      updateWalkForwardRun(wfId, {
        completed_folds: i + 1,
        aggregate_results_json: JSON.stringify(activeWF.aggregateOOS),
        best_fold_id: bestFoldId,
      });

      console.log(`[WalkForward] Fold ${i + 1} complete: Train $${trainPnl.toFixed(2)} (${trainWinRate.toFixed(1)}% WR), Test $${testPnl.toFixed(2)} (${testWinRate.toFixed(1)}% WR), OOS Ratio: ${overfittingRatio.toFixed(2)}`);

    } catch (err) {
      console.error(`[WalkForward] Fold ${i + 1} failed: ${err.message}`);
      activeWF.folds[i].status = 'completed'; // Mark as done even if failed
      updateWalkForwardFold(foldId, { status: 'failed' });
      // Continue to next fold
    }
  }

  // ===== WALK-FORWARD COMPLETE =====
  if (activeWF && activeWF.status === 'running') {
    activeWF.status = 'completed';
    activeWF.aggregateOOS = {
      totalTrades: oosTradesTotal,
      winRate: oosTradesTotal > 0 ? (oosWinsTotal / oosTradesTotal) * 100 : 0,
      totalPnl: oosPnlTotal,
      sharpe: 0,
    };

    updateWalkForwardRun(wfId, {
      status: 'completed',
      completed_folds: activeWF.completedFolds,
      aggregate_results_json: JSON.stringify(activeWF.aggregateOOS),
      best_fold_id: bestFoldId,
    });

    console.log(`[WalkForward] Run ${wfId} COMPLETE: ${activeWF.completedFolds} folds, OOS: ${oosTradesTotal} trades, ${activeWF.aggregateOOS.winRate.toFixed(1)}% WR, $${oosPnlTotal.toFixed(2)} PnL`);
  }
}

/**
 * Stop the active walk-forward run.
 */
export function stopWalkForward() {
  if (!activeWF || activeWF.status !== 'running') {
    return { stopped: false, reason: 'No active walk-forward' };
  }

  activeWF.status = 'stopped';
  updateWalkForwardRun(activeWF.id, { status: 'stopped' });

  return { stopped: true, id: activeWF.id };
}

/**
 * Get real-time walk-forward status.
 */
export function getWalkForwardStatus() {
  if (!activeWF) {
    return { running: false, folds: [] };
  }

  return {
    running: activeWF.status === 'running',
    runId: activeWF.id,
    status: activeWF.status,
    currentFold: activeWF.currentFold,
    totalFolds: activeWF.totalFolds,
    currentPhase: activeWF.currentPhase,
    completedFolds: activeWF.completedFolds,
    folds: activeWF.folds.map(f => ({
      foldNumber: f.foldNumber,
      trainStart: f.trainStart,
      trainEnd: f.trainEnd,
      testStart: f.testStart,
      testEnd: f.testEnd,
      trainPnl: f.trainPnl,
      testPnl: f.testPnl,
      trainTrades: f.trainTrades,
      testTrades: f.testTrades,
      trainWinRate: f.trainWinRate,
      testWinRate: f.testWinRate,
      overfittingRatio: f.overfittingRatio,
      status: f.status,
    })),
    aggregateOOS: activeWF.aggregateOOS,
    elapsed: activeWF.startedAt ? Date.now() - activeWF.startedAt : 0,
    currentTrainingProgress: activeWF.currentTrainingProgress,
    error: activeWF.error,
  };
}

/**
 * Get results from a completed walk-forward run.
 */
export function getWalkForwardResults(id) {
  const run = getWalkForwardRun(id);
  if (!run) return null;

  const folds = getWalkForwardFolds(id);
  let config = {};
  try { config = JSON.parse(run.config_json || '{}'); } catch (e) {}
  let aggregateOOS = {};
  try { aggregateOOS = JSON.parse(run.aggregate_results_json || '{}'); } catch (e) {}

  return {
    id: run.id,
    status: run.status,
    totalFolds: run.total_folds,
    completedFolds: run.completed_folds,
    config,
    aggregateOOS,
    bestFoldId: run.best_fold_id,
    folds: folds.map(f => ({
      id: f.id,
      foldNumber: f.fold_number,
      trainStart: f.train_start,
      trainEnd: f.train_end,
      testStart: f.test_start,
      testEnd: f.test_end,
      trainRunId: f.train_run_id,
      testRunId: f.test_run_id,
      trainPnl: f.train_pnl,
      testPnl: f.test_pnl,
      trainTrades: f.train_trades,
      testTrades: f.test_trades,
      trainWinRate: f.train_win_rate,
      testWinRate: f.test_win_rate,
      overfittingRatio: f.overfitting_ratio,
      status: f.status,
    })),
    createdAt: run.created_at,
  };
}

/**
 * Get list of all walk-forward runs.
 */
export function getWalkForwardRunsList(limit = 20) {
  const runs = getWalkForwardRunsFromDb(limit);
  return runs.map(r => {
    let config = {};
    let aggregateOOS = {};
    try { config = JSON.parse(r.config_json || '{}'); } catch (e) {}
    try { aggregateOOS = JSON.parse(r.aggregate_results_json || '{}'); } catch (e) {}
    return {
      id: r.id,
      status: r.status,
      totalFolds: r.total_folds,
      completedFolds: r.completed_folds,
      config,
      aggregateOOS,
      bestFoldId: r.best_fold_id,
      createdAt: r.created_at,
    };
  });
}

/**
 * ML Retrain trigger with quality gates.
 * Called after walk-forward completes. Uses OOS samples for training.
 */
export async function triggerMLRetrain(wfRunId) {
  const results = getWalkForwardResults(wfRunId);
  if (!results) throw new Error('Walk-forward run not found');
  if (results.status !== 'completed') throw new Error('Walk-forward not yet completed');

  // Collect OOS (test) samples from all folds
  let oosSamples = [];
  let oosWins = 0;
  let oosTotal = 0;

  for (const fold of results.folds) {
    if (!fold.testRunId) continue;
    const samples = getTrainingMLSamples(fold.testRunId, 10000);
    oosSamples = oosSamples.concat(samples);
    for (const s of samples) {
      if (s.label) {
        oosTotal++;
        if (s.label === 'WIN') oosWins++;
      }
    }
  }

  // Quality gate 1: minimum samples
  if (oosTotal < 500) {
    return {
      success: false,
      reason: `Insufficient OOS samples: ${oosTotal} (need >= 500)`,
      sampleCount: oosTotal,
    };
  }

  // Quality gate 2: minimum win rate
  const oosWinRate = oosTotal > 0 ? (oosWins / oosTotal) * 100 : 0;
  if (oosWinRate < 40) {
    return {
      success: false,
      reason: `OOS win rate too low: ${oosWinRate.toFixed(1)}% (need >= 40%)`,
      sampleCount: oosTotal,
      winRate: oosWinRate,
    };
  }

  // Copy OOS samples to ml_features table
  let copied = 0;
  for (const sample of oosSamples) {
    if (!sample.label) continue;
    try {
      insertMLFeatures({
        ticker: sample.ticker,
        timestamp: sample.time,
        featuresJson: sample.features_json,
        label: sample.label,
        labelValue: sample.label_value,
        labeledAt: Date.now(),
      });
      copied++;
    } catch (e) {
      // Ignore duplicates
    }
  }

  console.log(`[WalkForward ML] Copied ${copied} OOS samples to ml_features table for retraining`);

  return {
    success: true,
    samplesCopied: copied,
    oosTotal,
    oosWinRate,
    message: `Copied ${copied} OOS samples. ML will retrain on next cycle.`,
  };
}
