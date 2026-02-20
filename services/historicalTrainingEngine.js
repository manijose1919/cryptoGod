/**
 * Historical Training Engine — "Time Machine"
 *
 * Replays bot logic on historical candle data at maximum speed.
 * Uses the SAME indicator/strategy functions as the live bot.
 * Produces thousands of simulated trades → ML training data.
 *
 * State isolation: training uses its own copies of adaptive weights,
 * beast mode, circuit breaker, and parameter optimizer.
 */

import crypto from 'node:crypto';
import {
  calculateTCSeries,
  calculateBreakoutDetectorSeries,
  calculateWhaleMoneyFlowSeries,
  calculateTrendDashboard,
  calculateMomentumSeries,
  calculateDivergence,
  calculateAdaptiveTCSeries,
  detectMarketRegime,
  calculateOpportunityScore,
  calculateATR,
} from '../server-indicator-service.js';

import {
  getHistoricalCandles,
  getHistoricalCandleRange,
  getFearGreedForDate,
  getDefiTvlForDate,
  insertTrainingRun,
  updateTrainingRun,
  getTrainingRun,
  insertTrainingTrade,
  insertTrainingTradesBatch,
  insertTrainingEquity,
  insertTrainingEquityBatch,
  insertTrainingMLSample,
  insertTrainingMLSamplesBatch,
  getTrainingTradeStats,
  getTrainingEquity as getTrainingEquityFromDb,
} from './database.js';

// Fee constants (same as live system)
const TRADING_FEE_PER_SIDE = 0.00075; // 0.075%
const TRADING_FEE_ROUND_TRIP = 0.0015; // 0.15%

// Config thresholds (same as server.js CONFIG.THRESHOLDS)
const THRESHOLDS = {
  TREND_BULLISH_ENTRY: 40,
  TREND_BEARISH_EXIT: 75,
  BREAKOUT_SQUEEZE_ENTRY: 40,
  BREAKOUT_EXPANSION_EXIT: 60,
  WHALE_BUYING_ENTRY: 48,
  WHALE_SELLING_EXIT: 35,
  CONFLUENCE_BULLISH_ENTRY: 2,
  CONFLUENCE_BEARISH_EXIT: 1,
  MOMENTUM_BULLISH_ENTRY: 50,
  MOMENTUM_BEARISH_EXIT: 25,
  DIVERGENCE_MIN_CONFIDENCE: 35,
  ADAPTIVE_BULLISH_ENTRY: 45,
  ADAPTIVE_BEARISH_EXIT: 75,
};

const MIN_CANDLES_REQUIRED = 21;
const MIN_OPP_SCORE = 20;       // Lower for training — want MORE trades for ML data
const MAX_CONCURRENT_POSITIONS = 3;
const MAX_POSITION_PCT = 0.25;   // 25% per position
const CANDLE_WINDOW = 200;       // Max candles to look back

// Training-specific: how often we try to enter (every N steps if no position)
const ENTRY_COOLDOWN_STEPS = 4;  // Check entry every 4 hours minimum gap

// Chunk size for yielding to event loop
const CHUNK_SIZE = 200;

// Active training state
let activeTraining = null;

/**
 * Create isolated copies of stateful sub-systems.
 * These mirror the live system but don't share any state.
 */
function createIsolatedState() {
  return {
    // Adaptive weights per strategy
    adaptiveWeights: {
      TREND: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      MOMENTUM: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      BREAKOUT: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      ADAPTIVE: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      WHALE: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      CONFLUENCE: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
      DIVERGENCE: { wins: 0, losses: 0, totalPnl: 0, weight: 1.0 },
    },
    // Circuit breaker
    circuitBreaker: {
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      consecutiveLosses: 0,
      maxConsecutiveLosses: 0,
      dailyPnl: 0,
      dailyTrades: 0,
      totalPnl: 0,
      pausedUntil: 0,
    },
    // Beast mode
    beastMode: {
      streak: 0,
      maxStreak: 0,
      coldStreak: 0,
      maxColdStreak: 0,
      recentPnls: [],
      compoundMultiplier: 1.0,
    },
    // Optimizer
    optimizer: {
      tradeLog: [],
      optimizedParams: { ...THRESHOLDS },
      lastOptimizeAt: 0,
    },
  };
}

/**
 * Record a trade result into isolated state.
 *
 * @param {number} currentTime — simulated timestamp (NOT Date.now()!)
 */
function recordTradeToState(state, pnl, strategy, currentTime) {
  const isWin = pnl > 0;

  // Adaptive weights
  const sw = state.adaptiveWeights[strategy];
  if (sw) {
    if (isWin) sw.wins++;
    else sw.losses++;
    sw.totalPnl += pnl;
    const total = sw.wins + sw.losses;
    if (total >= 5) {
      sw.weight = 0.5 + (sw.wins / total); // 0.5 to 1.5 range
    }
  }

  // Circuit breaker
  const cb = state.circuitBreaker;
  cb.totalTrades++;
  cb.totalPnl += pnl;
  cb.dailyPnl += pnl;
  cb.dailyTrades++;
  if (isWin) {
    cb.totalWins++;
    cb.consecutiveLosses = 0;
  } else {
    cb.totalLosses++;
    cb.consecutiveLosses++;
    cb.maxConsecutiveLosses = Math.max(cb.maxConsecutiveLosses, cb.consecutiveLosses);
  }

  // Pause after 8 consecutive losses — uses SIMULATED time, not Date.now()
  // Shorter pause in training (6 hours simulated) to keep trades flowing
  if (cb.consecutiveLosses >= 8) {
    cb.pausedUntil = currentTime + 6 * 3600000; // 6 simulated hours
    cb.consecutiveLosses = 0; // Reset so it doesn't keep pausing
  }

  // Beast mode
  const bm = state.beastMode;
  bm.recentPnls.push(pnl);
  if (bm.recentPnls.length > 20) bm.recentPnls.shift();

  if (isWin) {
    bm.streak++;
    bm.coldStreak = 0;
    bm.maxStreak = Math.max(bm.maxStreak, bm.streak);
  } else {
    bm.coldStreak++;
    bm.streak = 0;
    bm.maxColdStreak = Math.max(bm.maxColdStreak, bm.coldStreak);
  }

  // Compound multiplier: hot streak = up to 1.5x, cold streak = down to 0.7x
  // Less punishing in training to maintain position sizes
  if (bm.streak >= 3) bm.compoundMultiplier = Math.min(1.5, 1.0 + bm.streak * 0.1);
  else if (bm.coldStreak >= 5) bm.compoundMultiplier = Math.max(0.7, 1.0 - bm.coldStreak * 0.05);
  else bm.compoundMultiplier = 1.0;
}

/**
 * Build a feature vector for an ML training sample.
 */
function buildFeatureVector(candles, ticker, strategy, regime, score, fearGreed, defiTvl) {
  const lastCandle = candles[candles.length - 1];
  const tc = calculateTCSeries(candles);
  const mom = calculateMomentumSeries(candles);
  const bkout = calculateBreakoutDetectorSeries(candles);

  // Price-derived features
  const closes = candles.slice(-20).map(c => c.close);
  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);
  const volumes = candles.slice(-20).map(c => c.volume);
  const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const priceChange = closes.length >= 2 ? (closes[closes.length - 1] - closes[0]) / closes[0] : 0;
  const volatility = closes.length >= 2 ? Math.sqrt(closes.reduce((s, c, i) => {
    if (i === 0) return 0;
    const ret = Math.log(c / closes[i - 1]);
    return s + ret * ret;
  }, 0) / (closes.length - 1)) : 0;

  return {
    // Indicator values
    tc_value: tc[tc.length - 1] ?? 50,
    momentum_value: mom[mom.length - 1] ?? 50,
    breakout_value: bkout[bkout.length - 1] ?? 50,
    composite_score: score?.compositeScore ?? 0,
    // Price features
    price: lastCandle.close,
    price_change_20: priceChange,
    volatility_20: volatility,
    volume_ratio: avgVol > 0 ? lastCandle.volume / avgVol : 1,
    high_low_range: lastCandle.high - lastCandle.low,
    // Market context
    regime: regime || 'UNKNOWN',
    strategy: strategy || 'ADAPTIVE',
    fear_greed: fearGreed || 50,
    defi_tvl: defiTvl || 0,
    // Time features
    hour: new Date(lastCandle.time).getUTCHours(),
    day_of_week: new Date(lastCandle.time).getUTCDay(),
  };
}

/**
 * Evaluate all strategies for entry and return the best one.
 */
function evaluateStrategies(candles, regime, state) {
  if (candles.length < MIN_CANDLES_REQUIRED) return null;

  const tcValue = calculateTCSeries(candles).pop() ?? 50;
  const params = state.optimizer.optimizedParams;
  const candidates = [];

  // TREND: TC below threshold = bullish setup
  if (tcValue < params.TREND_BULLISH_ENTRY) {
    const strength = (params.TREND_BULLISH_ENTRY - tcValue) / params.TREND_BULLISH_ENTRY;
    const w = state.adaptiveWeights.TREND?.weight ?? 1;
    candidates.push({ strategy: 'TREND', value: tcValue, strength: strength * w });
  }

  // MOMENTUM: high momentum = bullish
  const momValue = calculateMomentumSeries(candles).pop() ?? 50;
  if (momValue > params.MOMENTUM_BULLISH_ENTRY) {
    const strength = (momValue - params.MOMENTUM_BULLISH_ENTRY) / (100 - params.MOMENTUM_BULLISH_ENTRY);
    const w = state.adaptiveWeights.MOMENTUM?.weight ?? 1;
    candidates.push({ strategy: 'MOMENTUM', value: momValue, strength: strength * w });
  }

  // BREAKOUT: high breakout score = expansion
  const bkout = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
  if (bkout > params.BREAKOUT_SQUEEZE_ENTRY) {
    const strength = (bkout - params.BREAKOUT_SQUEEZE_ENTRY) / (100 - params.BREAKOUT_SQUEEZE_ENTRY);
    const w = state.adaptiveWeights.BREAKOUT?.weight ?? 1;
    candidates.push({ strategy: 'BREAKOUT', value: bkout, strength: strength * w });
  }

  // ADAPTIVE: low adaptive TC = bullish
  const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
  if (adpValue < params.ADAPTIVE_BULLISH_ENTRY) {
    const strength = (params.ADAPTIVE_BULLISH_ENTRY - adpValue) / params.ADAPTIVE_BULLISH_ENTRY;
    const w = state.adaptiveWeights.ADAPTIVE?.weight ?? 1;
    candidates.push({ strategy: 'ADAPTIVE', value: adpValue, strength: strength * w });
  }

  // WHALE: whale money flow above threshold
  try {
    const whaleValue = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50;
    if (whaleValue > params.WHALE_BUYING_ENTRY) {
      const strength = (whaleValue - params.WHALE_BUYING_ENTRY) / (100 - params.WHALE_BUYING_ENTRY);
      const w = state.adaptiveWeights.WHALE?.weight ?? 1;
      candidates.push({ strategy: 'WHALE', value: whaleValue, strength: strength * w });
    }
  } catch (e) {}

  // DIVERGENCE: check for bullish divergence
  try {
    const div = calculateDivergence(candles);
    if (div && div.confidence > params.DIVERGENCE_MIN_CONFIDENCE && div.type === 'bullish') {
      const strength = div.confidence / 100;
      const w = state.adaptiveWeights.DIVERGENCE?.weight ?? 1;
      candidates.push({ strategy: 'DIVERGENCE', value: div.confidence, strength: strength * w });
    }
  } catch (e) {}

  // CONFLUENCE: count how many indicators agree on bullish
  const bullishCount = (tcValue < 45 ? 1 : 0) + (momValue > 55 ? 1 : 0) + (bkout > 50 ? 1 : 0);
  if (bullishCount >= params.CONFLUENCE_BULLISH_ENTRY) {
    const strength = bullishCount / 4;
    const w = state.adaptiveWeights.CONFLUENCE?.weight ?? 1;
    candidates.push({ strategy: 'CONFLUENCE', value: bullishCount, strength: strength * w });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.strength - a.strength);
  return candidates[0];
}

/**
 * Check exit conditions for an open position (mirrors server.js exit logic).
 */
function checkExitConditions(position, candles) {
  if (candles.length < MIN_CANDLES_REQUIRED) return null;

  const currentPrice = candles[candles.length - 1].close;
  const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
  const holdHours = (candles[candles.length - 1].time - position.entryTime) / 3600000;

  // Stop loss: -5% (wider for hourly crypto volatility)
  if (pnlPct <= -0.05) return 'Stop loss: -5%';

  // Take profit: +4% (realistic target that triggers more often)
  if (pnlPct >= 0.04) return 'Take profit: +4%';

  // Time exit: 48 hours max hold (faster turnover = more trades for ML)
  if (holdHours >= 48) return 'Time exit: 48h max hold';

  // Trailing stop: if position was up >3% and now gives back more than 60%
  if (position.highestPnlPct >= 0.03 && pnlPct < position.highestPnlPct * 0.4) {
    return `Trailing stop: gave back ${((position.highestPnlPct - pnlPct) * 100).toFixed(1)}%`;
  }

  // Strategy-specific exits
  const params = THRESHOLDS;
  switch (position.strategy) {
    case 'TREND': {
      const tcValue = calculateTCSeries(candles).pop() ?? 50;
      if (tcValue > params.TREND_BEARISH_EXIT) return 'Trend: bearish exit';
      break;
    }
    case 'MOMENTUM': {
      const momValue = calculateMomentumSeries(candles).pop() ?? 50;
      if (momValue < params.MOMENTUM_BEARISH_EXIT) return 'Momentum: bearish';
      break;
    }
    case 'BREAKOUT': {
      const bkout = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
      if (bkout < params.BREAKOUT_EXPANSION_EXIT) return 'Breakout: expansion faded';
      break;
    }
    case 'ADAPTIVE': {
      const adp = calculateAdaptiveTCSeries(candles).pop() ?? 50;
      if (adp > params.ADAPTIVE_BEARISH_EXIT) return 'Adaptive: bearish exit';
      break;
    }
    case 'WHALE': {
      const whale = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50;
      if (whale < params.WHALE_SELLING_EXIT) return 'Whale: selling pressure';
      break;
    }
    case 'CONFLUENCE': {
      const dash = calculateTrendDashboard(candles);
      const bullishCount = dash ? Object.values(dash).filter(v => v === true || v === 'BULLISH' || v === 'UP').length : 0;
      if (bullishCount <= params.CONFLUENCE_BEARISH_EXIT) return 'Confluence: bearish alignment';
      break;
    }
    case 'DIVERGENCE': {
      const div = calculateDivergence(candles);
      if (div && div.type === 'bearish' && div.confidence >= params.DIVERGENCE_MIN_CONFIDENCE) return 'Divergence: bearish';
      break;
    }
  }

  return null;
}

/**
 * Yield control to event loop (keeps API responsive during training).
 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Seed isolated state from a previous training run's learned state.
 * This enables iterative training — each run refines the previous run's lessons.
 */
function seedStateFromRun(seedRunId) {
  const learned = getLearnedState(seedRunId);
  if (!learned) {
    console.warn(`[Training] Seed run ${seedRunId} has no learned state, starting fresh`);
    return createIsolatedState();
  }

  const state = createIsolatedState();

  // Seed adaptive weights
  if (learned.adaptiveWeights) {
    for (const [strategy, data] of Object.entries(learned.adaptiveWeights)) {
      if (state.adaptiveWeights[strategy]) {
        state.adaptiveWeights[strategy] = {
          wins: data.wins || 0,
          losses: data.losses || 0,
          totalPnl: data.totalPnl || 0,
          weight: data.weight || 1.0,
        };
      }
    }
  }

  // Seed circuit breaker Kelly stats (win/loss ratios carry forward)
  if (learned.circuitBreaker) {
    state.circuitBreaker.totalTrades = learned.circuitBreaker.totalTrades || 0;
    state.circuitBreaker.totalWins = learned.circuitBreaker.totalWins || 0;
    state.circuitBreaker.totalLosses = learned.circuitBreaker.totalLosses || 0;
    state.circuitBreaker.maxConsecutiveLosses = learned.circuitBreaker.maxConsecutiveLosses || 0;
  }

  // Seed beast mode streak calibration
  if (learned.beastMode) {
    state.beastMode.maxStreak = learned.beastMode.maxStreak || 0;
    state.beastMode.maxColdStreak = learned.beastMode.maxColdStreak || 0;
  }

  // Seed optimizer thresholds (most impactful — changes which trades are taken)
  if (learned.optimizer?.optimizedParams) {
    state.optimizer.optimizedParams = { ...THRESHOLDS, ...learned.optimizer.optimizedParams };
  }
  if (learned.optimizer?.tradeLog) {
    state.optimizer.tradeLog = learned.optimizer.tradeLog;
  }

  console.log(`[Training] Seeded state from run ${seedRunId}: ` +
    `${state.circuitBreaker.totalTrades} prior trades, ` +
    `weights: ${Object.entries(state.adaptiveWeights).map(([s, d]) => `${s}=${d.weight.toFixed(2)}`).join(', ')}`);

  return state;
}

/**
 * Start a historical training run.
 *
 * @param {Object} config - Training configuration
 * @param {string[]} config.tickers - Tickers to train on
 * @param {number} config.initialCash - Starting cash (default 10000)
 * @param {number} [config.startTime] - Start timestamp (ms). Auto-detected if omitted.
 * @param {number} [config.endTime] - End timestamp (ms). Auto-detected if omitted.
 * @param {string} [config.seedRunId] - Previous run ID to seed state from (iterative training).
 */
export async function startTraining(config = {}) {
  if (activeTraining && activeTraining.status === 'running') {
    throw new Error('Training already in progress');
  }

  const tickers = config.tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
  const initialCash = config.initialCash || 10000;
  const seedRunId = config.seedRunId || null;
  const runId = `train_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Determine time range from available data
  let earliestTime = Infinity;
  let latestTime = 0;
  const pairRanges = {};

  for (const ticker of tickers) {
    const range = getHistoricalCandleRange(ticker, '1h');
    if (!range || !range.earliest) continue;
    pairRanges[ticker] = range;
    if (range.earliest < earliestTime) earliestTime = range.earliest;
    if (range.latest > latestTime) latestTime = range.latest;
  }

  if (earliestTime === Infinity) {
    throw new Error('No historical data available. Download data first.');
  }

  const startTime = config.startTime || earliestTime;
  const endTime = config.endTime || latestTime;

  // Calculate total steps (1 step = 1 hour across all pairs)
  const totalHours = Math.floor((endTime - startTime) / 3600000);

  // Build isolated state — fresh or seeded from previous run
  const isolatedState = seedRunId
    ? seedStateFromRun(seedRunId)
    : createIsolatedState();

  // Save run to DB
  insertTrainingRun({
    run_id: runId,
    status: 'running',
    config: { tickers, initialCash, startTime, endTime, seedRunId },
    start_time: Date.now(),
    total_steps: totalHours,
  });

  // Initialize training state
  activeTraining = {
    runId,
    status: 'running',
    config: { tickers, initialCash, startTime, endTime, seedRunId },
    progress: {
      currentStep: 0,
      totalSteps: totalHours,
      currentDate: new Date(startTime).toISOString().split('T')[0],
      pct: 0,
    },
    portfolio: {
      cash: initialCash,
      initialBudget: initialCash,
      positions: {},
    },
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      bestTrade: 0,
      worstTrade: 0,
      totalFees: 0,
      maxDrawdown: 0,
    },
    equity: { peak: initialCash, current: initialCash },
    isolatedState,
    seedRunId,
    epoch: seedRunId ? (getTrainingRun(seedRunId)?.config_json ? ((JSON.parse(getTrainingRun(seedRunId).config_json).epoch || 0) + 1) : 1) : 0,
    strategyBreakdown: {},
    recentTrades: [],
    equityBuffer: [],    // Buffer for batch DB inserts
    tradeBuffer: [],     // Buffer for batch DB inserts
    mlSampleBuffer: [],  // Buffer for batch DB inserts
    startedAt: Date.now(),
  };

  // Pre-load all candle data into memory for speed
  console.log(`[Training] Loading candle data for ${tickers.length} pairs...`);
  const candleData = {};
  for (const ticker of tickers) {
    const candles = getHistoricalCandles(ticker, '1h', startTime, endTime, 100000);
    if (candles.length > 0) {
      // Convert to {o,h,l,c,v} format (matches live bot candle format)
      candleData[ticker] = candles.map(c => ({
        t: c.time,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      console.log(`[Training] ${ticker}: ${candles.length} candles loaded`);
    }
  }

  // Build unified timeline (all unique hourly timestamps)
  const timestampSet = new Set();
  for (const candles of Object.values(candleData)) {
    for (const c of candles) timestampSet.add(c.time);
  }
  const timeline = Array.from(timestampSet).sort((a, b) => a - b);
  activeTraining.progress.totalSteps = timeline.length;

  console.log(`[Training] Starting training run ${runId}: ${timeline.length} timesteps, ${Object.keys(candleData).length} pairs`);

  // Run training loop asynchronously
  runTrainingLoop(runId, timeline, candleData, activeTraining).catch(err => {
    console.error(`[Training] Fatal error: ${err.message}`);
    if (activeTraining && activeTraining.runId === runId) {
      activeTraining.status = 'error';
      activeTraining.error = err.message;
    }
    updateTrainingRun(runId, {
      status: 'error',
      error: err.message,
      end_time: Date.now(),
    });
  });

  return { runId, totalSteps: timeline.length, tickers: Object.keys(candleData) };
}

/**
 * Core training loop — processes timeline in chunks.
 */
async function runTrainingLoop(runId, timeline, candleData, training) {
  const portfolio = training.portfolio;
  const state = training.isolatedState;
  const tickers = Object.keys(candleData);
  let lastStepTime = timeline[timeline.length - 1] || Date.now(); // Track for end-of-loop cleanup

  // Build index maps for fast candle window lookups
  // For each ticker, create a sorted time->index map
  const candleIndexMaps = {};
  for (const [ticker, candles] of Object.entries(candleData)) {
    const map = new Map();
    candles.forEach((c, i) => map.set(c.time, i));
    candleIndexMaps[ticker] = map;
  }

  for (let stepIdx = 0; stepIdx < timeline.length; stepIdx++) {
    if (training.status !== 'running') break;

    const currentTime = timeline[stepIdx];
    lastStepTime = currentTime;
    const currentDate = new Date(currentTime).toISOString().split('T')[0];

    // Lookup auxiliary data for this date
    const fgData = getFearGreedForDate(currentDate);
    const tvlData = getDefiTvlForDate(currentDate);
    const fearGreed = fgData?.value ?? 50;
    const defiTvl = tvlData?.tvl ?? 0;

    // Build candle windows for each ticker (last CANDLE_WINDOW candles up to current time)
    const candleWindows = {};
    for (const ticker of tickers) {
      const allCandles = candleData[ticker];
      const indexMap = candleIndexMaps[ticker];
      const currentIdx = indexMap.get(currentTime);
      if (currentIdx === undefined) continue;

      const startIdx = Math.max(0, currentIdx - CANDLE_WINDOW + 1);
      candleWindows[ticker] = allCandles.slice(startIdx, currentIdx + 1);
    }

    // --- EXIT LOGIC ---
    const positionTickers = Object.keys(portfolio.positions);
    for (const ticker of positionTickers) {
      const position = portfolio.positions[ticker];
      const candles = candleWindows[ticker];
      if (!candles || candles.length < 2) continue;

      const currentPrice = candles[candles.length - 1].c;

      // Update highest price tracking
      if (currentPrice > (position.highestPrice || 0)) {
        position.highestPrice = currentPrice;
        const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
        position.highestPnlPct = pnlPct;
      }

      const exitReason = checkExitConditions(position, candles);
      if (exitReason) {
        // Execute simulated sell
        const sellFee = currentPrice * position.quantity * TRADING_FEE_PER_SIDE;
        const buyFee = position.entryPrice * position.quantity * TRADING_FEE_PER_SIDE;
        const pnl = (currentPrice - position.entryPrice) * position.quantity - sellFee - buyFee;
        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        portfolio.cash += (position.quantity * currentPrice) - sellFee;
        delete portfolio.positions[ticker];

        // Record to state
        recordTradeToState(state, pnl, position.strategy, currentTime);

        // Stats
        training.stats.totalTrades++;
        training.stats.totalPnl += pnl;
        training.stats.totalFees += sellFee + buyFee;
        if (pnl > 0) {
          training.stats.wins++;
          training.stats.bestTrade = Math.max(training.stats.bestTrade, pnl);
        } else {
          training.stats.losses++;
          training.stats.worstTrade = Math.min(training.stats.worstTrade, pnl);
        }

        // Strategy breakdown
        if (!training.strategyBreakdown[position.strategy]) {
          training.strategyBreakdown[position.strategy] = { wins: 0, losses: 0, pnl: 0 };
        }
        const sb = training.strategyBreakdown[position.strategy];
        if (pnl > 0) sb.wins++;
        else sb.losses++;
        sb.pnl += pnl;

        // Build ML feature vector
        const features = buildFeatureVector(
          candles, ticker, position.strategy, position.regime,
          position.score, fearGreed, defiTvl
        );

        const trade = {
          run_id: runId,
          time: currentTime,
          type: 'SELL',
          ticker,
          strategy: position.strategy,
          price: currentPrice,
          quantity: position.quantity,
          pnl,
          pnl_percent: pnlPct,
          fee: sellFee + buyFee,
          balance_after: portfolio.cash,
          regime: position.regime || '',
          composite_score: position.compositeScore || 0,
          exit_features_json: JSON.stringify(features),
          entry_features_json: position.entryFeaturesJson || '{}',
        };

        training.tradeBuffer.push(trade);
        training.recentTrades = [trade, ...training.recentTrades].slice(0, 20);

        // ML sample
        training.mlSampleBuffer.push({
          run_id: runId,
          ticker,
          time: currentTime,
          features_json: JSON.stringify(features),
          label: pnl > 0 ? 'WIN' : 'LOSS',
          label_value: pnlPct,
          strategy: position.strategy,
          regime: position.regime || '',
        });
      }
    }

    // --- ENTRY LOGIC ---
    const openSlots = MAX_CONCURRENT_POSITIONS - Object.keys(portfolio.positions).length;
    const isPaused = state.circuitBreaker.pausedUntil > currentTime;

    if (openSlots > 0 && portfolio.cash > 10 && !isPaused) {
      // Score all tickers and find best entry
      const candidates = [];
      for (const ticker of tickers) {
        if (portfolio.positions[ticker]) continue;
        const candles = candleWindows[ticker];
        if (!candles || candles.length < MIN_CANDLES_REQUIRED) continue;

        const score = calculateOpportunityScore(candles, ticker);
        if (score.compositeScore > MIN_OPP_SCORE) {
          candidates.push({ ticker, score, candles });
        }
      }

      candidates.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

      for (const candidate of candidates.slice(0, openSlots)) {
        if (portfolio.cash < 10) break;
        if (Object.keys(portfolio.positions).length >= MAX_CONCURRENT_POSITIONS) break;

        const { ticker, score, candles } = candidate;
        const currentPrice = candles[candles.length - 1].c;

        // Detect regime
        let regime = 'NORMAL';
        let regimeObj = null;
        try {
          regimeObj = detectMarketRegime(candles);
          regime = regimeObj?.trend || 'NORMAL';
        } catch (e) {}

        // Evaluate strategies
        const entry = evaluateStrategies(candles, regime, state);
        if (!entry) continue;

        // Position sizing
        const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
          (sum, p) => sum + (p.quantity * p.currentPrice), 0);
        let positionSize = Math.min(
          portfolio.cash * 0.90,
          totalValue * MAX_POSITION_PCT
        );

        // Apply compound multiplier from beast mode
        positionSize *= state.beastMode.compoundMultiplier;
        positionSize = Math.min(positionSize, portfolio.cash * 0.95);

        if (positionSize < 10) continue;

        // Simulate buy
        const buyFee = currentPrice * (positionSize / currentPrice) * TRADING_FEE_PER_SIDE;
        const quantity = (positionSize - buyFee) / currentPrice;

        const entryFeatures = buildFeatureVector(candles, ticker, entry.strategy, regime, score, fearGreed, defiTvl);

        portfolio.cash -= positionSize;
        portfolio.positions[ticker] = {
          ticker,
          strategy: entry.strategy,
          entryPrice: currentPrice,
          currentPrice,
          quantity,
          entryTime: currentTime,
          highestPrice: currentPrice,
          highestPnlPct: 0,
          regime,
          compositeScore: score.compositeScore,
          score,
          entryFeaturesJson: JSON.stringify(entryFeatures),
        };

        training.tradeBuffer.push({
          run_id: runId,
          time: currentTime,
          type: 'BUY',
          ticker,
          strategy: entry.strategy,
          price: currentPrice,
          quantity,
          pnl: 0,
          pnl_percent: 0,
          fee: buyFee,
          balance_after: portfolio.cash,
          regime,
          composite_score: score.compositeScore,
          entry_features_json: JSON.stringify(entryFeatures),
          exit_features_json: '{}',
        });
      }
    }

    // Update current prices for open positions
    for (const [ticker, pos] of Object.entries(portfolio.positions)) {
      const candles = candleWindows[ticker];
      if (candles && candles.length > 0) {
        pos.currentPrice = candles[candles.length - 1].c;
      }
    }

    // Calculate equity
    const holdingsValue = Object.values(portfolio.positions).reduce(
      (sum, p) => sum + (p.quantity * p.currentPrice), 0);
    const totalValue = portfolio.cash + holdingsValue;
    training.equity.current = totalValue;
    if (totalValue > training.equity.peak) training.equity.peak = totalValue;
    const drawdown = training.equity.peak > 0
      ? (training.equity.peak - totalValue) / training.equity.peak
      : 0;
    training.stats.maxDrawdown = Math.max(training.stats.maxDrawdown, drawdown);

    // Equity snapshot every 24 steps (every simulated day)
    if (stepIdx % 24 === 0) {
      training.equityBuffer.push({
        run_id: runId,
        time: currentTime,
        total_value: totalValue,
        cash: portfolio.cash,
        holdings_value: holdingsValue,
        open_positions: Object.keys(portfolio.positions).length,
        drawdown,
      });

      // Reset daily circuit breaker stats
      state.circuitBreaker.dailyPnl = 0;
      state.circuitBreaker.dailyTrades = 0;
    }

    // Update progress
    training.progress.currentStep = stepIdx + 1;
    training.progress.currentDate = currentDate;
    training.progress.pct = ((stepIdx + 1) / timeline.length) * 100;

    // Flush buffers and yield every CHUNK_SIZE steps
    if (stepIdx % CHUNK_SIZE === 0 && stepIdx > 0) {
      // Flush trade buffer
      if (training.tradeBuffer.length > 0) {
        insertTrainingTradesBatch(training.tradeBuffer);
        training.tradeBuffer = [];
      }
      // Flush equity buffer
      if (training.equityBuffer.length > 0) {
        insertTrainingEquityBatch(training.equityBuffer);
        training.equityBuffer = [];
      }
      // Flush ML sample buffer
      if (training.mlSampleBuffer.length > 0) {
        insertTrainingMLSamplesBatch(training.mlSampleBuffer);
        training.mlSampleBuffer = [];
      }

      // Save checkpoint
      updateTrainingRun(runId, {
        current_step: stepIdx + 1,
        current_date: currentDate,
        total_trades: training.stats.totalTrades,
        win_rate: training.stats.totalTrades > 0
          ? (training.stats.wins / training.stats.totalTrades) * 100 : 0,
        total_pnl: training.stats.totalPnl,
        max_drawdown: training.stats.maxDrawdown * 100,
        final_equity: totalValue,
      });

      // Yield to event loop
      await yieldToEventLoop();
    }
  }

  // --- TRAINING COMPLETE ---
  // Close all remaining positions at last available price
  for (const [ticker, position] of Object.entries(portfolio.positions)) {
    const price = position.currentPrice || position.entryPrice;
    const sellFee = price * position.quantity * TRADING_FEE_PER_SIDE;
    const buyFee = position.entryPrice * position.quantity * TRADING_FEE_PER_SIDE;
    const pnl = (price - position.entryPrice) * position.quantity - sellFee - buyFee;
    portfolio.cash += (position.quantity * price) - sellFee;

    recordTradeToState(state, pnl, position.strategy, lastStepTime);
    training.stats.totalTrades++;
    training.stats.totalPnl += pnl;
    if (pnl > 0) training.stats.wins++;
    else training.stats.losses++;
  }
  portfolio.positions = {};

  // Flush remaining buffers
  if (training.tradeBuffer.length > 0) insertTrainingTradesBatch(training.tradeBuffer);
  if (training.equityBuffer.length > 0) insertTrainingEquityBatch(training.equityBuffer);
  if (training.mlSampleBuffer.length > 0) insertTrainingMLSamplesBatch(training.mlSampleBuffer);
  training.tradeBuffer = [];
  training.equityBuffer = [];
  training.mlSampleBuffer = [];

  // Calculate final stats
  const totalValue = portfolio.cash;
  const totalReturn = ((totalValue - portfolio.initialBudget) / portfolio.initialBudget) * 100;
  const winRate = training.stats.totalTrades > 0
    ? (training.stats.wins / training.stats.totalTrades) * 100 : 0;

  // Calculate Sharpe ratio approximation
  const equityData = getTrainingEquityForSharpe(runId);
  const sharpe = calculateSharpeRatio(equityData);

  // Build learned state for transfer
  const learnedState = {
    adaptiveWeights: state.adaptiveWeights,
    circuitBreaker: {
      totalTrades: state.circuitBreaker.totalTrades,
      totalWins: state.circuitBreaker.totalWins,
      totalLosses: state.circuitBreaker.totalLosses,
      maxConsecutiveLosses: state.circuitBreaker.maxConsecutiveLosses,
    },
    beastMode: {
      maxStreak: state.beastMode.maxStreak,
      maxColdStreak: state.beastMode.maxColdStreak,
    },
    optimizer: state.optimizer,
    strategyBreakdown: training.strategyBreakdown,
  };

  training.status = 'completed';
  training.completedAt = Date.now();

  // Save final state to DB
  updateTrainingRun(runId, {
    status: 'completed',
    end_time: Date.now(),
    current_step: training.progress.totalSteps,
    total_trades: training.stats.totalTrades,
    win_rate: winRate,
    total_pnl: training.stats.totalPnl,
    max_drawdown: training.stats.maxDrawdown * 100,
    sharpe_ratio: sharpe,
    final_equity: totalValue,
    learned_state_json: JSON.stringify(learnedState),
    strategy_weights_json: JSON.stringify(training.strategyBreakdown),
  });

  console.log(`[Training] Run ${runId} COMPLETE: ${training.stats.totalTrades} trades, ${winRate.toFixed(1)}% win rate, $${training.stats.totalPnl.toFixed(2)} PnL, ${totalReturn.toFixed(1)}% return, Sharpe: ${sharpe.toFixed(2)}`);
}

function getTrainingEquityForSharpe(runId) {
  try {
    return getTrainingEquityFromDb(runId, 5000);
  } catch (e) {
    return [];
  }
}

function calculateSharpeRatio(equityData) {
  if (!equityData || equityData.length < 10) return 0;

  const returns = [];
  for (let i = 1; i < equityData.length; i++) {
    const ret = (equityData[i].total_value - equityData[i - 1].total_value) / equityData[i - 1].total_value;
    returns.push(ret);
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: daily data (24h snapshots), ~365 observations/year
  return (avgReturn / stdDev) * Math.sqrt(365);
}

/**
 * Stop the active training run.
 */
export function stopTraining() {
  if (!activeTraining || activeTraining.status !== 'running') {
    return { stopped: false, reason: 'No active training' };
  }

  activeTraining.status = 'stopped';

  // Flush any remaining buffers
  if (activeTraining.tradeBuffer.length > 0) {
    insertTrainingTradesBatch(activeTraining.tradeBuffer);
    activeTraining.tradeBuffer = [];
  }
  if (activeTraining.equityBuffer.length > 0) {
    insertTrainingEquityBatch(activeTraining.equityBuffer);
    activeTraining.equityBuffer = [];
  }
  if (activeTraining.mlSampleBuffer.length > 0) {
    insertTrainingMLSamplesBatch(activeTraining.mlSampleBuffer);
    activeTraining.mlSampleBuffer = [];
  }

  updateTrainingRun(activeTraining.runId, {
    status: 'stopped',
    end_time: Date.now(),
    current_step: activeTraining.progress.currentStep,
    total_trades: activeTraining.stats.totalTrades,
    win_rate: activeTraining.stats.totalTrades > 0
      ? (activeTraining.stats.wins / activeTraining.stats.totalTrades) * 100 : 0,
    total_pnl: activeTraining.stats.totalPnl,
    max_drawdown: activeTraining.stats.maxDrawdown * 100,
    final_equity: activeTraining.equity.current,
  });

  return { stopped: true, runId: activeTraining.runId };
}

/**
 * Get real-time training status (polled by frontend every 2s).
 */
export function getTrainingStatus() {
  if (!activeTraining) {
    return { active: false };
  }

  const winRate = activeTraining.stats.totalTrades > 0
    ? (activeTraining.stats.wins / activeTraining.stats.totalTrades) * 100 : 0;

  return {
    active: activeTraining.status === 'running',
    runId: activeTraining.runId,
    status: activeTraining.status,
    progress: activeTraining.progress,
    stats: {
      ...activeTraining.stats,
      winRate,
    },
    equity: activeTraining.equity,
    strategyBreakdown: activeTraining.strategyBreakdown,
    recentTrades: activeTraining.recentTrades,
    elapsed: activeTraining.startedAt ? Date.now() - activeTraining.startedAt : 0,
    epoch: activeTraining.epoch || 0,
    seedRunId: activeTraining.seedRunId || null,
  };
}

/**
 * Get results from a completed training run.
 */
export function getTrainingResults(runId) {
  const run = getTrainingRun(runId);
  if (!run) return null;

  const stats = getTrainingTradeStats(runId);
  let learnedState = null;
  let strategyWeights = null;

  try {
    learnedState = run.learned_state_json ? JSON.parse(run.learned_state_json) : null;
  } catch (e) {}
  try {
    strategyWeights = run.strategy_weights_json ? JSON.parse(run.strategy_weights_json) : null;
  } catch (e) {}

  return {
    run,
    stats,
    learnedState,
    strategyWeights,
  };
}

/**
 * Get the learned state from a training run (for /apply).
 */
export function getLearnedState(runId) {
  const run = getTrainingRun(runId);
  if (!run || !run.learned_state_json) return null;
  try {
    return JSON.parse(run.learned_state_json);
  } catch (e) {
    return null;
  }
}
