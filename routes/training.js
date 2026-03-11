/**
 * Training API Routes — Historical ML Training ("Time Machine")
 *
 * Routes for downloading historical data, running training, and applying results.
 */

import express from 'express';
import {
  startDownload,
  abortDownload,
  getDownloadStatus,
  getDataSummary,
  AVAILABLE_PAIRS,
  SUPPORTED_TIMEFRAMES,
} from '../services/historicalDataService.js';
import {
  startTraining,
  stopTraining,
  getTrainingStatus,
  getTrainingResults,
  getLearnedState,
  distillSeed,
  breedSeeds,
  modifySeed,
} from '../services/historicalTrainingEngine.js';
import {
  getTrainingRuns,
  getTrainingRun,
  getTrainingTrades,
  getTrainingEquity,
  getTrainingMLSamples,
  getTrainingMLSampleCount,
  insertMLFeatures,
  initializeTrainingTables,
} from '../services/database.js';
import {
  startWalkForward,
  stopWalkForward,
  getWalkForwardStatus,
  getWalkForwardResults,
  getWalkForwardRunsList,
  triggerMLRetrain,
} from '../services/walkForwardEngine.js';

import {
  startMonteCarlo,
  stopMonteCarlo,
  getMonteCarloStatus,
  getMonteCarloResults,
} from '../services/monteCarloEngine.js';
import {
  startSensitivityAnalysis,
  stopSensitivityAnalysis,
  getSensitivityStatus,
  getSensitivityResults,
} from '../services/sensitivityAnalysis.js';
import {
  startCrossPairValidation,
  stopCrossPairValidation,
  getCrossPairStatus,
  getCrossPairResults,
} from '../services/crossPairEngine.js';
import {
  startRegimeTraining,
  stopRegimeTraining,
  getRegimeTrainingStatus,
  getRegimeTrainingResults,
  createComposite,
} from '../services/regimeTrainingEngine.js';
import {
  startShortTraining,
  stopShortTraining,
  getShortTrainingStatus,
  getShortTrainingResults,
} from '../services/shortTrainingEngine.js';
import {
  startGridTraining,
  stopGridTraining,
  getGridTrainingStatus,
  getGridTrainingResults,
} from '../services/gridTrainingEngine.js';
import { calculateStakingYield } from '../services/stakingCalculator.js';

// Import live system state transfer functions
import { importState as awImportState, exportState as awExportState } from '../services/adaptiveWeights.js';
import { importState as beastImportState, exportState as beastExportState } from '../services/beastMode.js';
import { importState as cbImportState, exportState as cbExportState } from '../services/circuitBreaker.js';
import { importState as optImportState, exportState as optExportState } from '../services/parameterOptimizer.js';

const router = express.Router();

// Initialize training tables (deferred — DB is already initialized by server.js)
let tablesInitialized = false;
function ensureTables() {
  if (!tablesInitialized) {
    try {
      initializeTrainingTables();
      tablesInitialized = true;
    } catch (e) {
      // Tables may already exist from database.js init — suppress duplicate column warnings
      if (!e.message?.includes('already exists') && !e.message?.includes('no such column')) {
        console.warn('[Training Routes] Table init warning:', e.message);
      }
      tablesInitialized = true; // Don't retry on known schema differences
    }
  }
}

// Middleware: ensure tables exist before any route handler
router.use((req, res, next) => {
  ensureTables();
  next();
});

// ============================================
// DATA DOWNLOAD
// ============================================

/**
 * POST /api/training/download — Start historical data download
 * Body: { tickers?: string[], yearsBack?: number, timeframes?: string[] }
 */
router.post('/download', async (req, res) => {
  try {
    const { tickers, yearsBack, timeframes } = req.body || {};
    const result = await startDownload(
      tickers || AVAILABLE_PAIRS,
      yearsBack || 5,
      timeframes || null
    );
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/training/download/abort — Abort active download
 */
router.post('/download/abort', (req, res) => {
  const result = abortDownload();
  res.json(result);
});

/**
 * GET /api/training/download/status — Get download progress
 */
router.get('/download/status', (req, res) => {
  res.json(getDownloadStatus());
});

/**
 * GET /api/training/data/summary — Get summary of all downloaded data
 */
router.get('/data/summary', (req, res) => {
  res.json(getDataSummary());
});

// ============================================
// TRAINING
// ============================================

/**
 * POST /api/training/start — Start a training run
 * Body: { tickers?: string[], initialCash?: number, startTime?: number, endTime?: number,
 *         seedRunId?: string, strategyFilter?: string[], targetWinRate?: number,
 *         aggressiveCompounding?: boolean, selectivity?: 'normal'|'high' }
 */
router.post('/start', async (req, res) => {
  try {
    const result = await startTraining(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/training/stop — Stop active training
 */
router.post('/stop', (req, res) => {
  const result = stopTraining();
  res.json(result);
});

/**
 * GET /api/training/status — Live training progress (polled every 2s)
 */
router.get('/status', (req, res) => {
  res.json(getTrainingStatus());
});

/**
 * GET /api/training/results/:runId — Get completed run results
 */
router.get('/results/:runId', (req, res) => {
  const results = getTrainingResults(req.params.runId);
  if (!results) {
    return res.status(404).json({ error: 'Training run not found' });
  }
  res.json(results);
});

/**
 * GET /api/training/runs — List all training runs
 */
router.get('/runs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const runs = getTrainingRuns(limit);
  res.json(runs);
});

/**
 * GET /api/training/trades/:runId — Get trades for a training run
 */
router.get('/trades/:runId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const trades = getTrainingTrades(req.params.runId, limit);
  res.json(trades);
});

/**
 * GET /api/training/equity/:runId — Get equity curve for a training run
 */
router.get('/equity/:runId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 2000, 10000);
  const equity = getTrainingEquity(req.params.runId, limit);
  res.json(equity);
});

// ============================================
// STATE TRANSFER (APPLY)
// ============================================

/**
 * GET /api/training/current-state — Get current live system state (for comparison)
 */
router.get('/current-state', (req, res) => {
  try {
    res.json({
      adaptiveWeights: awExportState(),
      beastMode: beastExportState(),
      circuitBreaker: cbExportState(),
      optimizer: optExportState(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/training/apply — Transfer learned state from training to live system
 * Body: { runId: string, components?: string[] }
 *
 * components can include: 'adaptiveWeights', 'beastMode', 'circuitBreaker', 'optimizer', 'mlSamples'
 * Defaults to all components.
 */
router.post('/apply', async (req, res) => {
  try {
    const { runId, components } = req.body || {};
    if (!runId) {
      return res.status(400).json({ error: 'runId is required' });
    }

    const run = getTrainingRun(runId);
    if (!run) {
      return res.status(404).json({ error: 'Training run not found' });
    }
    if (run.status !== 'completed') {
      return res.status(400).json({ error: `Run status is "${run.status}", must be "completed"` });
    }

    const learnedState = getLearnedState(runId);
    if (!learnedState) {
      return res.status(400).json({ error: 'No learned state found for this run' });
    }

    const applyComponents = components || ['adaptiveWeights', 'circuitBreaker', 'optimizer', 'mlSamples'];
    const applied = [];
    const beforeState = {};

    // Save before state for comparison
    try { beforeState.adaptiveWeights = awExportState(); } catch (e) {}
    try { beforeState.circuitBreaker = cbExportState(); } catch (e) {}
    try { beforeState.optimizer = optExportState(); } catch (e) {}

    // Apply adaptive weights
    if (applyComponents.includes('adaptiveWeights') && learnedState.adaptiveWeights) {
      try {
        // Build import format matching adaptiveWeights.js importState()
        const awState = {};
        for (const [strategy, data] of Object.entries(learnedState.adaptiveWeights)) {
          awState[strategy] = {
            weight: data.weight || 1.0,
            wins: data.wins || 0,
            losses: data.losses || 0,
            totalPnl: data.totalPnl || 0,
          };
        }
        awImportState(awState);
        applied.push('adaptiveWeights');
      } catch (e) {
        console.error('[Training Apply] adaptiveWeights error:', e.message);
      }
    }

    // Apply circuit breaker Kelly data
    if (applyComponents.includes('circuitBreaker') && learnedState.circuitBreaker) {
      try {
        const cbData = learnedState.circuitBreaker;
        cbImportState({
          totalTrades: cbData.totalTrades,
          totalWins: cbData.totalWins,
          totalLosses: cbData.totalLosses,
        });
        applied.push('circuitBreaker');
      } catch (e) {
        console.error('[Training Apply] circuitBreaker error:', e.message);
      }
    }

    // Apply optimizer parameters
    if (applyComponents.includes('optimizer') && learnedState.optimizer) {
      try {
        optImportState(learnedState.optimizer);
        applied.push('optimizer');
      } catch (e) {
        console.error('[Training Apply] optimizer error:', e.message);
      }
    }

    // Copy ML samples to ml_features table
    if (applyComponents.includes('mlSamples')) {
      try {
        const samples = getTrainingMLSamples(runId, 10000);
        let copied = 0;
        for (const sample of samples) {
          if (sample.label) {
            insertMLFeatures({
              ticker: sample.ticker,
              timestamp: sample.time,
              featuresJson: sample.features_json,
              label: sample.label,
              labelValue: sample.label_value,
              labeledAt: Date.now(),
            });
            copied++;
          }
        }
        applied.push(`mlSamples (${copied} samples)`);
      } catch (e) {
        console.error('[Training Apply] mlSamples error:', e.message);
      }
    }

    console.log(`[Training] Applied learned state from run ${runId}: ${applied.join(', ')}`);

    res.json({
      success: true,
      runId,
      applied,
      beforeState,
      afterState: {
        adaptiveWeights: awExportState(),
        circuitBreaker: cbExportState(),
        optimizer: optExportState(),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// WALK-FORWARD VALIDATION
// ============================================

/**
 * POST /api/training/walk-forward/start — Start walk-forward validation
 * Body: { trainMonths?: number, testMonths?: number, stepMonths?: number, tickers?: string[],
 *         initialCash?: number, seedRunId?: string, skipMTF?: boolean, selectivity?: 'normal'|'high',
 *         strategyFilter?: string[], targetWinRate?: number, aggressiveCompounding?: boolean }
 */
router.post('/walk-forward/start', async (req, res) => {
  try {
    const result = await startWalkForward(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/training/walk-forward/stop — Stop active walk-forward
 */
router.post('/walk-forward/stop', (req, res) => {
  const result = stopWalkForward();
  res.json(result);
});

/**
 * GET /api/training/walk-forward/status — Get walk-forward progress
 */
router.get('/walk-forward/status', (req, res) => {
  res.json(getWalkForwardStatus());
});

/**
 * GET /api/training/walk-forward/results/:id — Get WF run results
 */
router.get('/walk-forward/results/:id', (req, res) => {
  const results = getWalkForwardResults(req.params.id);
  if (!results) {
    return res.status(404).json({ error: 'Walk-forward run not found' });
  }
  res.json(results);
});

/**
 * GET /api/training/walk-forward/runs — List all WF runs
 */
router.get('/walk-forward/runs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  res.json(getWalkForwardRunsList(limit));
});

/**
 * POST /api/training/walk-forward/retrain/:id — Trigger ML retrain from WF results
 */
router.post('/walk-forward/retrain/:id', async (req, res) => {
  try {
    const result = await triggerMLRetrain(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/training/progress-stream — SSE endpoint for real-time training progress
 */
router.get('/progress-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    try {
      const status = getTrainingStatus();
      res.write(`data: ${JSON.stringify(status)}\n\n`);

      // Stop streaming if training is done
      if (!status.active && status.status !== 'running') {
        clearInterval(interval);
        res.end();
      }
    } catch {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ============================================
// SEED DISTILLATION
// ============================================

/**
 * POST /api/training/distill — Create a winners-only distilled seed from a training run.
 * Body: { runId: string, minProfitPct?: number, amplifyBigWins?: boolean }
 */
router.post('/distill', (req, res) => {
  try {
    const { runId, minProfitPct, amplifyBigWins, profitFocused } = req.body;
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const result = distillSeed(runId, { minProfitPct, amplifyBigWins, profitFocused });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/training/breed — Genetic crossover of multiple seeds.
 * Body: { seedIds: string[], consensusThreshold?: number }
 */
router.post('/breed', (req, res) => {
  try {
    const { seedIds, consensusThreshold } = req.body;
    if (!seedIds || seedIds.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 seedIds' });
    }
    const result = breedSeeds(seedIds, { consensusThreshold });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/training/modify-seed — Create a modified copy of a seed.
 * Body: { seedId: string, exitParams?: object, optimizedParams?: object }
 */
router.post('/modify-seed', (req, res) => {
  try {
    const { seedId, exitParams, optimizedParams, regimeExitOverrides, blockedHours } = req.body;
    if (!seedId) return res.status(400).json({ error: 'seedId required' });
    const result = modifySeed(seedId, { exitParams, optimizedParams, regimeExitOverrides, blockedHours });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// MONTE CARLO STRESS TEST
// ============================================

router.post('/monte-carlo/start', async (req, res) => {
  try {
    const result = await startMonteCarlo(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/monte-carlo/stop', (req, res) => {
  res.json(stopMonteCarlo());
});

router.get('/monte-carlo/status', (req, res) => {
  res.json(getMonteCarloStatus());
});

router.get('/monte-carlo/results/:runId', (req, res) => {
  const results = getMonteCarloResults(req.params.runId);
  if (!results) return res.status(404).json({ error: 'No Monte Carlo results found' });
  res.json(results);
});

// ============================================
// SENSITIVITY ANALYSIS
// ============================================

router.post('/sensitivity/start', async (req, res) => {
  try {
    const result = await startSensitivityAnalysis(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/sensitivity/stop', (req, res) => {
  res.json(stopSensitivityAnalysis());
});

router.get('/sensitivity/status', (req, res) => {
  res.json(getSensitivityStatus());
});

router.get('/sensitivity/results/:runId', (req, res) => {
  const results = getSensitivityResults(req.params.runId);
  if (!results) return res.status(404).json({ error: 'No sensitivity results found' });
  res.json(results);
});

// ============================================
// CROSS-PAIR VALIDATION
// ============================================

router.post('/cross-pair/start', async (req, res) => {
  try {
    const result = await startCrossPairValidation(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/cross-pair/stop', (req, res) => {
  res.json(stopCrossPairValidation());
});

router.get('/cross-pair/status', (req, res) => {
  res.json(getCrossPairStatus());
});

router.get('/cross-pair/results/:runId', (req, res) => {
  const results = getCrossPairResults(req.params.runId);
  if (!results) return res.status(404).json({ error: 'No cross-pair results found' });
  res.json(results);
});

// ============================================
// REGIME-SPECIFIC TRAINING
// ============================================

router.post('/regime/start', async (req, res) => {
  try {
    const result = await startRegimeTraining(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/regime/stop', (req, res) => {
  res.json(stopRegimeTraining());
});

router.get('/regime/status', (req, res) => {
  res.json(getRegimeTrainingStatus());
});

router.get('/regime/results', (req, res) => {
  const results = getRegimeTrainingResults();
  if (!results) return res.status(404).json({ error: 'No regime training results' });
  res.json(results);
});

router.post('/regime/composite', (req, res) => {
  try {
    const { baseRunId } = req.body || {};
    const result = createComposite(baseRunId);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// SHORT SELLING TRAINING
// ============================================

router.post('/short/start', async (req, res) => {
  try {
    const result = await startShortTraining(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/short/stop', (req, res) => {
  res.json(stopShortTraining());
});

router.get('/short/status', (req, res) => {
  res.json(getShortTrainingStatus());
});

router.get('/short/results', (req, res) => {
  const results = getShortTrainingResults();
  if (!results) return res.status(404).json({ error: 'No short training results' });
  res.json(results);
});

// ============================================
// GRID TRADING TRAINING
// ============================================

router.post('/grid/start', async (req, res) => {
  try {
    const result = await startGridTraining(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/grid/stop', (req, res) => {
  res.json(stopGridTraining());
});

router.get('/grid/status', (req, res) => {
  res.json(getGridTrainingStatus());
});

router.get('/grid/results', (req, res) => {
  const results = getGridTrainingResults();
  if (!results) return res.status(404).json({ error: 'No grid training results' });
  res.json(results);
});

// ============================================
// STAKING CALCULATOR
// ============================================

router.post('/staking/calculate', (req, res) => {
  try {
    const result = calculateStakingYield(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
