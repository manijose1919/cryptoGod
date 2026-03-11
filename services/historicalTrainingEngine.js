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

import { buildFeatureVector as sharedBuildFeatureVector, FEATURE_COUNT as SHARED_FEATURE_COUNT } from './featureEngineering.js';

// All timeframes for multi-TF training
const ALL_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'];

// Fee constants — Kraken rates (primary exchange)
const TRADING_FEE_PER_SIDE_TAKER = 0.0026;  // 0.26% taker
const TRADING_FEE_PER_SIDE_MAKER = 0.0016;  // 0.16% maker
const TRADING_FEE_ROUND_TRIP_TAKER = 0.0052; // 0.52% taker round-trip
const TRADING_FEE_ROUND_TRIP_MAKER = 0.0032; // 0.32% maker round-trip
// Default to taker fees (conservative) — override via config.useMakerFees
let TRADING_FEE_PER_SIDE = TRADING_FEE_PER_SIDE_TAKER;
let TRADING_FEE_ROUND_TRIP = TRADING_FEE_ROUND_TRIP_TAKER;

// Slippage model: realistic spread cost per side
const SLIPPAGE_PER_SIDE = 0.0005;  // 0.05% spread cost per side

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

// Selectivity presets — controls how picky the entry filters are
const SELECTIVITY_PRESETS = {
  normal: {
    minOppScore: MIN_OPP_SCORE,           // 20
    minRegimeStrategyWR: 0.38,            // REGIME_STRATEGY_MIN_WINRATE
    minBinWR: 0.35,
    regimeGate: null,                     // no regime restriction
    minStrategiesAgreeing: 1,
    qualityConfidenceFloor: 0,            // all pass
    minMemoryTradesForGate: 100,
    entryCooldownSteps: 1,                // every candle
  },
  high: {
    minOppScore: 55,
    minRegimeStrategyWR: 0.55,
    minBinWR: 0.50,
    regimeGate: ['STRONG_UP', 'UP'],      // only bullish regimes
    minStrategiesAgreeing: 2,
    qualityConfidenceFloor: 0.55,
    minMemoryTradesForGate: 50,
    entryCooldownSteps: 4,                // every 4th candle
  },
};

// Active training state
let activeTraining = null;

/**
 * Create isolated copies of stateful sub-systems.
 * These mirror the live system but don't share any state.
 */
export function createIsolatedState() {
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
    // Optimizer — now includes REAL optimization
    optimizer: {
      tradeLog: [],
      optimizedParams: { ...THRESHOLDS },
      lastOptimizeAt: 0,
    },
    // Trade memory — the key learning mechanism
    tradeMemory: {
      // Win rate per regime+strategy combo: "SIDEWAYS_TREND" → {wins, losses, totalPnl}
      regimeStrategy: {},
      // Win rate per strategy+indicator bin: "TREND_tc_20" → {wins, losses}
      indicatorBins: {},
      // PnL distribution for exit optimization
      winPnls: [],      // winning trade PnL percentages
      lossPnls: [],     // losing trade PnL percentages
      winHoldHours: [],  // hours held for winning trades
      lossHoldHours: [], // hours held for losing trades
      // Learned exit parameters
      exitParams: {
        stopLoss: -0.05,       // 5% stop — wide to avoid crypto noise false stop-outs
        takeProfit: 0.05,      // 5% TP — 1:1 R:R
        maxHold: 120,          // 5 days max hold
        trailingStart: 0.10,   // Trail only on big moves (10%+)
        trailingGiveBack: 0.35, // Give back 35% of peak
      },
      // How many trades since last optimization
      tradesSinceOptimize: 0,
    },
  };
}

// Optimization interval
const OPTIMIZE_EVERY_N_TRADES = 300;
const MIN_REGIME_STRATEGY_SAMPLES = 15;
const REGIME_STRATEGY_MIN_WINRATE = 0.38;

/**
 * Bin an indicator value (0-100) into buckets of 10.
 */
function indicatorBin(value) {
  return Math.floor(Math.min(99, Math.max(0, value)) / 10) * 10;
}

/**
 * Record a completed trade into trade memory for learning.
 */
function recordToTradeMemory(memory, strategy, regime, indicatorValues, pnl, pnlPct, holdHours) {
  const isWin = pnl > 0;

  // 1. Regime+Strategy tracking
  const rsKey = `${regime}_${strategy}`;
  if (!memory.regimeStrategy[rsKey]) {
    memory.regimeStrategy[rsKey] = { wins: 0, losses: 0, totalPnl: 0 };
  }
  const rs = memory.regimeStrategy[rsKey];
  if (isWin) rs.wins++;
  else rs.losses++;
  rs.totalPnl += pnl;

  // 2. Indicator bin tracking (for the primary indicator of this strategy)
  if (indicatorValues) {
    for (const [indName, value] of Object.entries(indicatorValues)) {
      if (typeof value !== 'number') continue;
      const bin = indicatorBin(value);
      const binKey = `${strategy}_${indName}_${bin}`;
      if (!memory.indicatorBins[binKey]) {
        memory.indicatorBins[binKey] = { wins: 0, losses: 0 };
      }
      if (isWin) memory.indicatorBins[binKey].wins++;
      else memory.indicatorBins[binKey].losses++;
    }
  }

  // 3. PnL distribution
  if (isWin) {
    memory.winPnls.push(pnlPct);
    memory.winHoldHours.push(holdHours);
    // Keep last 2000 for memory efficiency
    if (memory.winPnls.length > 2000) memory.winPnls.shift();
    if (memory.winHoldHours.length > 2000) memory.winHoldHours.shift();
  } else {
    memory.lossPnls.push(pnlPct);
    memory.lossHoldHours.push(holdHours);
    if (memory.lossPnls.length > 2000) memory.lossPnls.shift();
    if (memory.lossHoldHours.length > 2000) memory.lossHoldHours.shift();
  }

  memory.tradesSinceOptimize++;
}

/**
 * Quality filter: should we enter this trade based on past outcomes?
 * Returns { allow: boolean, reason: string, confidence: number }
 */
function evaluateTradeQuality(memory, strategy, regime, indicatorValues, selParams = null) {
  const minMemory = selParams?.minMemoryTradesForGate ?? 100;
  const minRSWR = selParams?.minRegimeStrategyWR ?? REGIME_STRATEGY_MIN_WINRATE;
  const minBWR = selParams?.minBinWR ?? 0.35;

  const totalMemoryTrades = Object.values(memory.regimeStrategy)
    .reduce((s, rs) => s + rs.wins + rs.losses, 0);

  // Need minimum history before filtering
  if (totalMemoryTrades < minMemory) {
    return { allow: true, reason: 'insufficient_data', confidence: 0.5 };
  }

  // 1. Check regime+strategy combo — filter by BOTH win rate AND expected PnL
  const rsKey = `${regime}_${strategy}`;
  const rs = memory.regimeStrategy[rsKey];
  if (rs) {
    const total = rs.wins + rs.losses;
    if (total >= MIN_REGIME_STRATEGY_SAMPLES) {
      const winRate = rs.wins / total;
      const avgPnl = rs.totalPnl / total;

      // Block if win rate is below threshold
      // Note: avgPnl check removed — it's budget-sensitive ($1M positions = huge dollar PnL).
      // WR is the reliable, budget-independent metric for quality filtering.
      if (winRate < minRSWR) {
        return {
          allow: false,
          reason: `${rsKey} WR=${(winRate * 100).toFixed(0)}% avgPnL=$${avgPnl.toFixed(2)} (${total} samples)`,
          confidence: winRate,
        };
      }
    }
  }

  // 2. Check indicator bins — reject if all relevant bins show poor win rate
  if (indicatorValues) {
    let binChecks = 0;
    let binBad = 0;
    for (const [indName, value] of Object.entries(indicatorValues)) {
      if (typeof value !== 'number') continue;
      const bin = indicatorBin(value);
      const binKey = `${strategy}_${indName}_${bin}`;
      const binData = memory.indicatorBins[binKey];
      if (binData && binData.wins + binData.losses >= 10) {
        binChecks++;
        const binWR = binData.wins / (binData.wins + binData.losses);
        if (binWR < minBWR) binBad++;
      }
    }
    // If majority of checked bins are bad, skip
    if (binChecks >= 2 && binBad > binChecks * 0.6) {
      return {
        allow: false,
        reason: `${binBad}/${binChecks} indicator bins below ${(minBWR * 100).toFixed(0)}% WR`,
        confidence: 0.3,
      };
    }
  }

  // 3. Boost: check if this regime+strategy is above average
  let confidence = 0.5;
  if (rs) {
    const total = rs.wins + rs.losses;
    if (total >= 10) {
      confidence = rs.wins / total;
    }
  }

  return { allow: true, reason: 'passed', confidence };
}

/**
 * Optimize parameters based on accumulated trade memory.
 * Called every OPTIMIZE_EVERY_N_TRADES trades.
 */
function runOptimization(state) {
  const memory = state.tradeMemory;
  const params = state.optimizer.optimizedParams;

  console.log(`[Training Optimizer] Running optimization after ${memory.tradesSinceOptimize} trades...`);

  // --- 1. Optimize entry thresholds based on indicator bin win rates ---
  // For each strategy, find which indicator level ranges have the best win rates
  // and adjust thresholds to prefer those ranges

  // TREND: lower TC values should be more bullish. Find the TC bin with best edge.
  const trendBins = Object.entries(memory.indicatorBins)
    .filter(([k]) => k.startsWith('TREND_tc_'))
    .map(([k, v]) => ({ bin: parseInt(k.split('_')[2]), ...v, total: v.wins + v.losses }))
    .filter(b => b.total >= 8)
    .sort((a, b) => (b.wins / b.total) - (a.wins / a.total));

  if (trendBins.length >= 3) {
    // Set entry threshold to include the top winning bins
    const bestBin = trendBins[0];
    const bestWR = bestBin.wins / bestBin.total;
    if (bestWR > 0.5) {
      // Good bin found — set threshold just above it
      params.TREND_BULLISH_ENTRY = Math.min(55, bestBin.bin + 15);
    } else {
      // No great bin — tighten the threshold
      params.TREND_BULLISH_ENTRY = Math.max(25, bestBin.bin + 5);
    }
  }

  // MOMENTUM: higher momentum should be bullish
  const momBins = Object.entries(memory.indicatorBins)
    .filter(([k]) => k.startsWith('MOMENTUM_momentum_'))
    .map(([k, v]) => ({ bin: parseInt(k.split('_')[2]), ...v, total: v.wins + v.losses }))
    .filter(b => b.total >= 8)
    .sort((a, b) => (b.wins / b.total) - (a.wins / a.total));

  if (momBins.length >= 3) {
    const bestBin = momBins[0];
    const bestWR = bestBin.wins / bestBin.total;
    if (bestWR > 0.5) {
      params.MOMENTUM_BULLISH_ENTRY = Math.max(30, bestBin.bin - 5);
    } else {
      params.MOMENTUM_BULLISH_ENTRY = Math.min(70, bestBin.bin + 5);
    }
  }

  // BREAKOUT: higher breakout score = expansion
  const bkoutBins = Object.entries(memory.indicatorBins)
    .filter(([k]) => k.startsWith('BREAKOUT_breakout_'))
    .map(([k, v]) => ({ bin: parseInt(k.split('_')[2]), ...v, total: v.wins + v.losses }))
    .filter(b => b.total >= 8)
    .sort((a, b) => (b.wins / b.total) - (a.wins / a.total));

  if (bkoutBins.length >= 3) {
    const bestBin = bkoutBins[0];
    const bestWR = bestBin.wins / bestBin.total;
    if (bestWR > 0.5) {
      params.BREAKOUT_SQUEEZE_ENTRY = Math.max(25, bestBin.bin - 5);
    } else {
      params.BREAKOUT_SQUEEZE_ENTRY = Math.min(70, bestBin.bin + 5);
    }
  }

  // --- 2. Exit params: keep fixed defaults ---
  // NOTE: Exit param optimization disabled — the PnL simulation doesn't account for
  // trailing stops, so it picks impractical TP/SL combos (e.g., TP=10%/SL=-2%).
  // Fixed defaults: SL=-4%, TP=4%, trailing starts at 6%.
  // The indicator threshold optimizer (above) and quality filter still learn and improve.
  console.log(`[Training Optimizer] Exit params (fixed): SL=${(memory.exitParams.stopLoss * 100).toFixed(1)}% TP=${(memory.exitParams.takeProfit * 100).toFixed(1)}% MaxHold=${memory.exitParams.maxHold}h`);

  // Optimize max hold: use median hold time of PROFITABLE trades
  if (memory.winHoldHours.length >= 30) {
    const sortedHold = [...memory.winHoldHours].sort((a, b) => a - b);
    const p75Hold = sortedHold[Math.floor(sortedHold.length * 0.75)];
    memory.exitParams.maxHold = Math.max(12, Math.min(120, Math.ceil(p75Hold * 1.5)));
  }

  // --- 3. Log optimization results ---
  const rsStats = Object.entries(memory.regimeStrategy)
    .map(([k, v]) => ({ key: k, wr: v.wins / (v.wins + v.losses || 1), total: v.wins + v.losses }))
    .filter(r => r.total >= 10)
    .sort((a, b) => b.wr - a.wr);

  if (rsStats.length > 0) {
    const best = rsStats[0];
    const worst = rsStats[rsStats.length - 1];
    console.log(`[Training Optimizer] Best regime+strategy: ${best.key} ${(best.wr * 100).toFixed(1)}% WR (${best.total} trades)`);
    console.log(`[Training Optimizer] Worst regime+strategy: ${worst.key} ${(worst.wr * 100).toFixed(1)}% WR (${worst.total} trades)`);
  }

  console.log(`[Training Optimizer] Thresholds: TREND=${params.TREND_BULLISH_ENTRY} MOM=${params.MOMENTUM_BULLISH_ENTRY} BKOUT=${params.BREAKOUT_SQUEEZE_ENTRY}`);

  memory.tradesSinceOptimize = 0;
  state.optimizer.lastOptimizeAt = Date.now();
}

/**
 * Record a trade result into isolated state.
 *
 * @param {number} currentTime — simulated timestamp (NOT Date.now()!)
 */
/**
 * @param {object} tradeContext - {regime, indicatorValues, pnlPct, holdHours} for learning
 */
function recordTradeToState(state, pnl, strategy, currentTime, tradeContext = {}) {
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

  // Trade memory — the learning engine
  if (state.tradeMemory) {
    recordToTradeMemory(
      state.tradeMemory,
      strategy,
      tradeContext.regime || 'UNKNOWN',
      tradeContext.indicatorValues || null,
      pnl,
      tradeContext.pnlPct || 0,
      tradeContext.holdHours || 0
    );

    // Run optimization periodically
    if (state.tradeMemory.tradesSinceOptimize >= OPTIMIZE_EVERY_N_TRADES) {
      runOptimization(state);
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
 * v3: Uses shared featureEngineering.js for unified 75-element numeric arrays
 * compatible with both training and live prediction.
 */
function buildFeatureVector(candles, ticker, strategy, regime, score, fearGreed, defiTvl, mtfContext = null) {
  try {
    // Convert training candle format to featureEngineering format
    // Training candles have {time, open, high, low, close, volume} + {t, o, h, l, c, v}
    // featureEngineering expects {c, h, l, o, v} — both formats are already on the candles

    const result = sharedBuildFeatureVector(ticker, candles, {
      sentimentData: {
        fearGreed: fearGreed || 50,
      },
      defiData: {
        tvlChange: defiTvl || 0,
      },
      marketRegime: regime || 'UNKNOWN',
      lastTradeTime: null,
      // MTF alignment score from mtfContext if available
      mtfAlignmentScore: mtfContext ? (mtfContext.tf_agreement || 0) * 20 : null, // 0-5 → 0-100
    });

    return result.features; // Return the 75-element numeric array
  } catch (err) {
    // Fallback: return zeros array if shared function fails
    console.warn(`[Training] buildFeatureVector fallback for ${ticker}: ${err.message}`);
    return new Array(SHARED_FEATURE_COUNT).fill(0);
  }
}

/**
 * Evaluate all strategies for entry and return the best one.
 */
function evaluateStrategies(candles, regime, state, minStrategiesRequired = 1, strategyFilter = null) {
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

  // Apply strategy filter if specified (e.g., ['TREND'] for TREND-only training)
  const filtered = strategyFilter
    ? candidates.filter(c => strategyFilter.includes(c.strategy))
    : candidates;

  // When strategy filter is active, clamp minRequired to filter size
  // (e.g., TREND-only can't require 2 strategies agreeing)
  const effectiveMin = strategyFilter
    ? Math.min(minStrategiesRequired, strategyFilter.length)
    : minStrategiesRequired;

  if (filtered.length < effectiveMin) return null;
  filtered.sort((a, b) => b.strength - a.strength);
  return filtered[0];
}

/**
 * B1: Compute dynamic exit targets based on ATR volatility regime.
 * Replicates beastMode's ATR-based exits for training engine parity.
 *
 * Volatility regimes:
 *   HIGH_VOL (ATR/price > 3%): TP=6%, SL=3% — wide to capture big moves
 *   NORMAL (1-3%):             TP=4%, SL=2% — standard crypto range
 *   LOW_VOL (<1%):             TP=3%, SL=2% — tight in quiet markets
 */
function getDynamicExitTargets(candles) {
  if (candles.length < 15) {
    return { takeProfit: 0.04, stopLoss: -0.02, regime: 'NORMAL' };
  }

  const atr = calcATRFromCandles(candles, 14);
  const price = candles[candles.length - 1].close || candles[candles.length - 1].c || 1;
  const atrPct = (atr / price) * 100; // ATR as percentage of price

  if (atrPct > 3) {
    return { takeProfit: 0.06, stopLoss: -0.03, regime: 'HIGH_VOL' };
  } else if (atrPct >= 1) {
    return { takeProfit: 0.04, stopLoss: -0.02, regime: 'NORMAL' };
  } else {
    return { takeProfit: 0.03, stopLoss: -0.02, regime: 'LOW_VOL' };
  }
}

/**
 * Check exit conditions for an open position (mirrors server.js exit logic).
 */
function checkExitConditions(position, candles, exitParams = null, config = {}) {
  if (candles.length < MIN_CANDLES_REQUIRED) return null;

  const currentPrice = candles[candles.length - 1].close;
  const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
  const holdHours = (candles[candles.length - 1].time - position.entryTime) / 3600000;

  // Use learned exit params if available, else defaults
  let ep = exitParams || { stopLoss: -0.05, takeProfit: 0.04, maxHold: 48, trailingStart: 0.03, trailingGiveBack: 0.4 };

  // B1: Override SL/TP with ATR-computed dynamic values when useDynamicExits is enabled
  if (config.useDynamicExits) {
    const dynTargets = getDynamicExitTargets(candles);
    ep = {
      ...ep,
      stopLoss: dynTargets.stopLoss,
      takeProfit: dynTargets.takeProfit,
    };
  }

  // Stop loss (learned or dynamic)
  if (pnlPct <= ep.stopLoss) return `Stop loss: ${(ep.stopLoss * 100).toFixed(1)}%`;

  // Take profit (learned or dynamic)
  if (pnlPct >= ep.takeProfit) return `Take profit: +${(ep.takeProfit * 100).toFixed(1)}%`;

  // Time exit (learned max hold hours)
  if (holdHours >= ep.maxHold) return `Time exit: ${ep.maxHold}h max hold`;

  // Trailing stop (learned) — give back N% of peak profit before exiting
  if (position.highestPnlPct >= ep.trailingStart && pnlPct < position.highestPnlPct * (1 - ep.trailingGiveBack)) {
    return `Trailing stop: gave back ${((position.highestPnlPct - pnlPct) * 100).toFixed(1)}%`;
  }

  // Strategy-specific exits — only fire when trade is below the profit floor.
  // Let trades above +2% ride to TP/trailing instead of getting cut early.
  // Below +2%, strategy exits act as early stop-loss for failing trends.
  if (pnlPct < 0.02) {
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
  } // end if (pnlPct < 0) — strategy exits only for losing trades

  return null;
}

/**
 * Yield control to event loop (keeps API responsive during training).
 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Check higher timeframe trend for confirmation.
 * Returns: 'BULLISH', 'BEARISH', or 'NEUTRAL'
 */
function getHigherTFTrend(candleData4h, ticker, currentTime) {
  const candles4h = candleData4h[ticker];
  if (!candles4h || candles4h.length < 20) return 'NEUTRAL';

  // Find candles up to current time
  let endIdx = candles4h.length - 1;
  for (let i = candles4h.length - 1; i >= 0; i--) {
    if (candles4h[i].time <= currentTime) { endIdx = i; break; }
  }

  const startIdx = Math.max(0, endIdx - 50);
  const window = candles4h.slice(startIdx, endIdx + 1);
  if (window.length < 10) return 'NEUTRAL';

  // Simple: 20-period EMA direction on 4h
  const closes = window.map(c => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema8 = calcEMA(closes, 8);

  if (ema8 === null || ema20 === null) return 'NEUTRAL';

  const currentClose = closes[closes.length - 1];
  if (ema8 > ema20 && currentClose > ema20) return 'BULLISH';
  if (ema8 < ema20 && currentClose < ema20) return 'BEARISH';
  return 'NEUTRAL';
}

function calcEMA(data, period) {
  if (data.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * mult + ema;
  }
  return ema;
}

/**
 * Calculate RSI from an array of close prices.
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate ATR from candle arrays.
 */
function calcATRFromCandles(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr += tr;
  }
  atr /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

/**
 * Binary search to find the index of the latest candle at or before `targetTime`.
 */
function binarySearchTime(times, targetTime) {
  let lo = 0, hi = times.length - 1;
  if (hi < 0 || times[0] > targetTime) return -1;
  if (times[hi] <= targetTime) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= targetTime) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Build sorted time arrays for O(log n) lookups across all timeframes.
 */
function buildCandleIndex(candlesByTF) {
  const index = {};
  for (const [tf, tickerMap] of Object.entries(candlesByTF)) {
    index[tf] = {};
    for (const [ticker, candles] of Object.entries(tickerMap)) {
      index[tf][ticker] = {
        times: candles.map(c => c.time),
        candles,
      };
    }
  }
  return index;
}

/**
 * Get a window of candles from a given timeframe at or before currentTime.
 */
function getCandleWindowForTF(candleIndex, tf, ticker, currentTime, windowSize) {
  const entry = candleIndex[tf]?.[ticker];
  if (!entry || entry.times.length === 0) return [];
  const idx = binarySearchTime(entry.times, currentTime);
  if (idx < 0) return [];
  const start = Math.max(0, idx - windowSize + 1);
  return entry.candles.slice(start, idx + 1);
}

/**
 * Get multi-timeframe context for a given ticker at a given time.
 * Returns 15 cross-timeframe features.
 */
function getMTFContext(candleIndex, ticker, currentTime) {
  const result = {
    htf_trend_4h: 0,
    htf_rsi_4h: 50,
    daily_trend: 0,
    daily_rsi: 50,
    daily_atr_pct: 0,
    weekly_trend: 0,
    weekly_momentum: 0,
    m15_rsi: 50,
    m15_vol_spike: 1,
    m5_price_accel: 0,
    m5_spread: 0,
    tf_agreement: 0,
    trend_alignment: 0,
    vol_regime_daily: 0.5,
    mtf_momentum_score: 0,
  };

  // --- 4h features ---
  const candles4h = getCandleWindowForTF(candleIndex, '4h', ticker, currentTime, 30);
  if (candles4h.length >= 20) {
    const closes4h = candles4h.map(c => c.close);
    const ema8 = calcEMA(closes4h, 8);
    const ema20 = calcEMA(closes4h, 20);
    if (ema8 !== null && ema20 !== null) {
      result.htf_trend_4h = ema8 > ema20 ? 1 : ema8 < ema20 ? -1 : 0;
    }
    result.htf_rsi_4h = calcRSI(closes4h, 14);
  }

  // --- Daily features ---
  const candles1d = getCandleWindowForTF(candleIndex, '1d', ticker, currentTime, 70);
  if (candles1d.length >= 21) {
    const closes1d = candles1d.map(c => c.close);
    const ema8d = calcEMA(closes1d, 8);
    const ema21d = calcEMA(closes1d, 21);
    if (ema8d !== null && ema21d !== null) {
      result.daily_trend = ema8d > ema21d ? 1 : ema8d < ema21d ? -1 : 0;
    }
    result.daily_rsi = calcRSI(closes1d, 14);

    // Daily ATR as percentage
    const atr = calcATRFromCandles(candles1d, 14);
    const lastClose = closes1d[closes1d.length - 1];
    result.daily_atr_pct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    // Volatility regime: ATR percentile rank over 60 day window
    if (candles1d.length >= 60) {
      const atrValues = [];
      for (let i = 14; i < candles1d.length; i++) {
        const slice = candles1d.slice(Math.max(0, i - 14), i + 1);
        atrValues.push(calcATRFromCandles(slice, Math.min(14, slice.length - 1)));
      }
      const currentATR = atrValues[atrValues.length - 1] || 0;
      const rank = atrValues.filter(a => a <= currentATR).length / atrValues.length;
      result.vol_regime_daily = rank;
    }
  }

  // --- Weekly features ---
  const candles1w = getCandleWindowForTF(candleIndex, '1w', ticker, currentTime, 20);
  if (candles1w.length >= 8) {
    const closesW = candles1w.map(c => c.close);
    const ema4w = calcEMA(closesW, 4);
    const ema8w = calcEMA(closesW, 8);
    if (ema4w !== null && ema8w !== null) {
      result.weekly_trend = ema4w > ema8w ? 1 : ema4w < ema8w ? -1 : 0;
    }

    // Weekly momentum: rate of change over last 4 weeks
    if (closesW.length >= 5) {
      const recent = closesW[closesW.length - 1];
      const past = closesW[closesW.length - 5];
      result.weekly_momentum = past > 0 ? (recent - past) / past : 0;
    }
  }

  // --- 15m features ---
  const candles15m = getCandleWindowForTF(candleIndex, '15m', ticker, currentTime, 30);
  if (candles15m.length >= 20) {
    const closes15m = candles15m.map(c => c.close);
    result.m15_rsi = calcRSI(closes15m, 14);

    // Volume spike: current vs 20-period avg
    const vols = candles15m.map(c => c.volume);
    const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const lastVol = vols[vols.length - 1];
    result.m15_vol_spike = avgVol > 0 ? lastVol / avgVol : 1;
  }

  // --- 5m features ---
  const candles5m = getCandleWindowForTF(candleIndex, '5m', ticker, currentTime, 15);
  if (candles5m.length >= 12) {
    const closes5m = candles5m.slice(-12).map(c => c.close);
    // Price acceleration: 2nd derivative
    if (closes5m.length >= 3) {
      const returns = [];
      for (let i = 1; i < closes5m.length; i++) {
        returns.push((closes5m[i] - closes5m[i - 1]) / closes5m[i - 1]);
      }
      if (returns.length >= 2) {
        const accel = returns.slice(-3).reduce((s, r, i, a) => {
          if (i === 0) return 0;
          return s + (r - a[i - 1]);
        }, 0) / Math.max(1, returns.slice(-3).length - 1);
        result.m5_price_accel = accel;
      }
    }

    // Micro-volatility: avg (high-low)/close over last 6 candles
    const last6 = candles5m.slice(-6);
    if (last6.length >= 3) {
      const spreads = last6.map(c => c.close > 0 ? (c.high - c.low) / c.close : 0);
      result.m5_spread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    }
  }

  // --- Cross-timeframe composites ---
  // TF agreement: count bullish trends (0-5 score)
  const trendSignals = [
    result.htf_trend_4h > 0 ? 1 : 0,
    result.daily_trend > 0 ? 1 : 0,
    result.weekly_trend > 0 ? 1 : 0,
    result.m15_rsi > 50 ? 1 : 0,
    result.htf_rsi_4h > 50 ? 1 : 0,
  ];
  result.tf_agreement = trendSignals.reduce((a, b) => a + b, 0);

  // Trend alignment: 1 if 1h-proxy (4h_rsi bullish), 4h, and 1d all agree
  const hourlyBullish = result.htf_rsi_4h > 50 ? 1 : -1;
  result.trend_alignment = (hourlyBullish === result.htf_trend_4h && result.htf_trend_4h === result.daily_trend && result.daily_trend !== 0) ? 1 : 0;

  // MTF momentum score: weighted avg of momentum across 15m, 1h, 4h
  const m15Mom = (result.m15_rsi - 50) / 50; // -1 to 1
  const h4Mom = (result.htf_rsi_4h - 50) / 50;
  result.mtf_momentum_score = m15Mom * 0.2 + h4Mom * 0.4 + (result.daily_trend * 0.4);

  return result;
}

/**
 * Seed isolated state from a previous training run's learned state.
 * This enables iterative training — each run refines the previous run's lessons.
 */
export function seedStateFromRun(seedRunId) {
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

  // Seed optimizer thresholds (changes which trades are taken)
  if (learned.optimizer?.optimizedParams) {
    state.optimizer.optimizedParams = { ...THRESHOLDS, ...learned.optimizer.optimizedParams };
  }
  if (learned.optimizer?.tradeLog) {
    state.optimizer.tradeLog = learned.optimizer.tradeLog;
  }

  // Seed trade memory — THIS IS THE KEY TO ITERATIVE LEARNING
  // Carries forward regime+strategy win rates, indicator bin data, and exit params
  if (learned.tradeMemory) {
    state.tradeMemory.regimeStrategy = learned.tradeMemory.regimeStrategy || {};
    state.tradeMemory.indicatorBins = learned.tradeMemory.indicatorBins || {};
    state.tradeMemory.exitParams = learned.tradeMemory.exitParams || state.tradeMemory.exitParams;
    // Transfer regime-specific exit overrides and time-of-day blocked hours
    if (learned.tradeMemory.regimeExitOverrides) {
      state.tradeMemory.regimeExitOverrides = learned.tradeMemory.regimeExitOverrides;
    }
    if (learned.tradeMemory.blockedHours) {
      state.tradeMemory.blockedHours = learned.tradeMemory.blockedHours;
    }
    // Don't carry forward raw PnL arrays (they'd be stale), but keep exit params
    state.tradeMemory.tradesSinceOptimize = 0;
  }

  const rsCount = Object.keys(state.tradeMemory.regimeStrategy).length;
  const binCount = Object.keys(state.tradeMemory.indicatorBins).length;

  console.log(`[Training] Seeded state from run ${seedRunId}: ` +
    `${state.circuitBreaker.totalTrades} prior trades, ` +
    `${rsCount} regime+strategy combos, ${binCount} indicator bins, ` +
    `exit: SL=${(state.tradeMemory.exitParams.stopLoss * 100).toFixed(1)}% TP=${(state.tradeMemory.exitParams.takeProfit * 100).toFixed(1)}%, ` +
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
 * @param {boolean} [config.evaluationOnly] - If true, state is frozen (no weight updates), only records trades
 * @param {Object} [config.frozenState] - Pre-built state to import (used with evaluationOnly)
 * @param {boolean} [config.skipMTF] - If true, skip loading 5m/15m data (saves ~350MB RAM)
 * @param {boolean} [config._isSubRun] - Internal: don't block on activeTraining check
 */
export async function startTraining(config = {}) {
  if (!config._isSubRun && activeTraining && activeTraining.status === 'running') {
    throw new Error('Training already in progress');
  }

  const tickers = config.tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
  const initialCash = config.initialCash || 10000;
  const seedRunId = config.seedRunId || null;
  const evaluationOnly = config.evaluationOnly || false;
  const frozenState = config.frozenState || null;
  const skipMTF = config.skipMTF || false;
  // Accept selectivity as string key OR object (regime training passes objects with regimeGate)
  const selectivity = typeof config.selectivity === 'object' && config.selectivity !== null
    ? { ...SELECTIVITY_PRESETS.normal, ...config.selectivity }
    : { ...(SELECTIVITY_PRESETS[config.selectivity] || SELECTIVITY_PRESETS.normal) };
  const DEFAULT_STRATEGY_FILTER = ['TREND', 'MOMENTUM'];
  const strategyFilter = config.strategyFilter || DEFAULT_STRATEGY_FILTER;
  const targetWinRate = config.targetWinRate || 0;
  const aggressiveCompounding = config.aggressiveCompounding || false;
  const useMakerFees = config.useMakerFees || false;

  // Set fee tier based on config (mutex guard for concurrent runs)
  // Note: module-level vars are used by inner functions via closure
  // Use atomic assignment to minimize race window
  const feePerSide = useMakerFees ? TRADING_FEE_PER_SIDE_MAKER : TRADING_FEE_PER_SIDE_TAKER;
  const feeRoundTrip = useMakerFees ? TRADING_FEE_ROUND_TRIP_MAKER : TRADING_FEE_ROUND_TRIP_TAKER;
  TRADING_FEE_PER_SIDE = feePerSide;
  TRADING_FEE_ROUND_TRIP = feeRoundTrip;

  // When seeded, lower the quality gate threshold so trade memory filters take effect immediately
  if (seedRunId) {
    selectivity.minMemoryTradesForGate = Math.min(selectivity.minMemoryTradesForGate, 30);
    console.log(`[Training] Seeded run: lowered minMemoryTradesForGate to ${selectivity.minMemoryTradesForGate}`);
  }
  // When targeting high win rate, raise the REGIME+STRATEGY filter only.
  // Don't raise indicator bin threshold — that over-filters UP_TREND trades.
  // The regime filter is the big lever: blocks DOWN_TREND (53% WR) while allowing UP_TREND (64%+).
  if (targetWinRate > 0.5) {
    const minWR = Math.max(selectivity.minRegimeStrategyWR, targetWinRate * 0.75);
    selectivity.minRegimeStrategyWR = minWR;
    console.log(`[Training] Target WR ${(targetWinRate*100).toFixed(0)}%: regime+strategy threshold raised to rsWR=${(minWR*100).toFixed(0)}% (binWR stays at ${(selectivity.minBinWR*100).toFixed(0)}%)`);
  }
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

  // Build isolated state — fresh, seeded, or frozen for evaluation
  let isolatedState;
  if (evaluationOnly && frozenState) {
    // Import frozen state — no mutations will happen during evaluation
    isolatedState = frozenState;
  } else if (seedRunId) {
    isolatedState = seedStateFromRun(seedRunId);
  } else {
    isolatedState = createIsolatedState();
  }

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
    evaluationOnly,
    epoch: seedRunId ? (getTrainingRun(seedRunId)?.config_json ? ((JSON.parse(getTrainingRun(seedRunId).config_json).epoch || 0) + 1) : 1) : 0,
    sessionTradeCount: 0, // Trades taken THIS session (not counting seeded prior)
    strategyBreakdown: {},
    recentTrades: [],
    equityBuffer: [],    // Buffer for batch DB inserts
    tradeBuffer: [],     // Buffer for batch DB inserts
    mlSampleBuffer: [],  // Buffer for batch DB inserts
    selectivity,
    strategyFilter,
    targetWinRate,
    aggressiveCompounding,
    startedAt: Date.now(),
  };

  // Pre-load all candle data into memory for speed — ALL timeframes
  const timeframesToLoad = skipMTF
    ? ['1h', '4h', '1d', '1w']
    : ALL_TIMEFRAMES;

  console.log(`[Training] Loading ${timeframesToLoad.length} timeframes for ${tickers.length} pairs...`);

  const candlesByTF = {}; // { '1h': { 'BTCUSD': [...], ... }, '4h': { ... }, ... }
  const candleData = {}; // 1h reference (primary stepping TF)

  for (const tf of timeframesToLoad) {
    candlesByTF[tf] = {};
    const maxCandles = tf === '5m' ? 600000 : tf === '15m' ? 200000 : 100000;
    for (const ticker of tickers) {
      const candles = getHistoricalCandles(ticker, tf, startTime, endTime, maxCandles);
      if (candles.length > 0) {
        const mapped = candles.map(c => ({
          t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
        candlesByTF[tf][ticker] = mapped;
        if (tf === '1h') candleData[ticker] = mapped;
      }
    }
    const pairCount = Object.keys(candlesByTF[tf]).length;
    const totalCandles = Object.values(candlesByTF[tf]).reduce((s, arr) => s + arr.length, 0);
    console.log(`[Training] ${tf}: ${totalCandles.toLocaleString()} candles across ${pairCount} pairs`);
  }

  // Backward compat: candleData4h reference
  const candleData4h = candlesByTF['4h'] || {};

  // Build cross-TF index for O(log n) lookups
  const candleIndex = buildCandleIndex(candlesByTF);

  // Build unified timeline (all unique hourly timestamps)
  const timestampSet = new Set();
  for (const candles of Object.values(candleData)) {
    for (const c of candles) timestampSet.add(c.time);
  }
  const timeline = Array.from(timestampSet).sort((a, b) => a - b);
  activeTraining.progress.totalSteps = timeline.length;

  const selName = config.selectivity || 'normal';
  console.log(`[Training] Starting training run ${runId}: ${timeline.length} timesteps, ${Object.keys(candleData).length} pairs, selectivity=${selName}`);

  // Run training loop asynchronously
  runTrainingLoop(runId, timeline, candleData, candleData4h, activeTraining, candleIndex).catch(err => {
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
async function runTrainingLoop(runId, timeline, candleData, candleData4h, training, candleIndex = null) {
  const portfolio = training.portfolio;
  const state = training.isolatedState;
  const tickers = Object.keys(candleData);
  const isEvalOnly = training.evaluationOnly || false;
  let lastStepTime = timeline[timeline.length - 1] || Date.now(); // Track for end-of-loop cleanup

  // Block-reason counters for debugging entry issues
  const blockCounters = {
    entryCooldown: 0, noOpenSlots: 0, noCash: 0, paused: 0,
    lowScore: 0, noCandles: 0, regimeGate: 0, noStrategy: 0,
    mtfBlock: 0, qualityFilter: 0, confidenceFloor: 0,
    positionTooSmall: 0, totalEntryAttempts: 0, totalEntries: 0,
  };
  const exitCounters = {
    stopLoss: { count: 0, totalPnl: 0 },
    takeProfit: { count: 0, totalPnl: 0 },
    timeExit: { count: 0, totalPnl: 0 },
    trailing: { count: 0, totalPnl: 0 },
    strategy: { count: 0, totalPnl: 0 },
  };

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

      const rawPrice = candles[candles.length - 1].c;
      const currentPrice = rawPrice * (1 - SLIPPAGE_PER_SIDE); // Sell slippage for PnL

      // Update highest price tracking using RAW price (not slippage-adjusted)
      if (rawPrice > (position.highestPrice || 0)) {
        position.highestPrice = rawPrice;
        const pnlPct = (rawPrice - position.entryPrice) / position.entryPrice;
        position.highestPnlPct = pnlPct;
      }

      // Regime-specific exit overrides: merge global exits with per-regime tweaks
      let exitP = state.tradeMemory?.exitParams;
      const regimeOverrides = state.tradeMemory?.regimeExitOverrides?.[position.regime];
      if (regimeOverrides) exitP = { ...exitP, ...regimeOverrides };
      const exitReason = checkExitConditions(position, candles, exitP, { useDynamicExits: config.useDynamicExits || false });
      if (exitReason) {
        // Track exit reason
        const exitType = exitReason.startsWith('Stop loss') ? 'stopLoss'
          : exitReason.startsWith('Take profit') ? 'takeProfit'
          : exitReason.startsWith('Time exit') ? 'timeExit'
          : exitReason.startsWith('Trailing') ? 'trailing' : 'strategy';
        const tradePnl = (currentPrice - position.entryPrice) * position.quantity;
        exitCounters[exitType].count++;
        exitCounters[exitType].totalPnl += tradePnl;

        // Execute simulated sell
        const sellFee = currentPrice * position.quantity * TRADING_FEE_PER_SIDE;
        const buyFee = position.entryPrice * position.quantity * TRADING_FEE_PER_SIDE;
        const pnl = (currentPrice - position.entryPrice) * position.quantity - sellFee - buyFee;
        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        portfolio.cash += (position.quantity * currentPrice) - sellFee;
        delete portfolio.positions[ticker];

        const holdHours = (currentTime - position.entryTime) / 3600000;

        // Record to state WITH learning context (skip if evaluation-only)
        if (!isEvalOnly) {
          recordTradeToState(state, pnl, position.strategy, currentTime, {
            regime: position.regime,
            indicatorValues: position.indicatorValues || null,
            pnlPct: pnlPct / 100, // convert from % to fraction for trade memory
            holdHours,
          });
        }

        // Stats (always track, even in eval mode)
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

        // Build ML feature vector with MTF context
        const mtfCtx = candleIndex ? getMTFContext(candleIndex, ticker, currentTime) : null;
        const features = buildFeatureVector(
          candles, ticker, position.strategy, position.regime,
          position.score, fearGreed, defiTvl, mtfCtx
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
    const sel = training.selectivity;

    // Entry cooldown — skip entry evaluation on non-cooldown steps
    if (sel.entryCooldownSteps > 1 && stepIdx % sel.entryCooldownSteps !== 0) {
      blockCounters.entryCooldown++;
    } else {

    const maxConcurrent = training.aggressiveCompounding ? 1 : MAX_CONCURRENT_POSITIONS;
    const openSlots = maxConcurrent - Object.keys(portfolio.positions).length;
    const isPaused = state.circuitBreaker.pausedUntil > currentTime;

    const minCashForEntry = Math.min(10, portfolio.initialBudget * 0.05);
    if (openSlots <= 0) blockCounters.noOpenSlots++;
    else if (portfolio.cash <= minCashForEntry) blockCounters.noCash++;
    else if (isPaused) blockCounters.paused++;
    if (openSlots > 0 && portfolio.cash > minCashForEntry && !isPaused) {
      // Score all tickers and find best entry
      const candidates = [];
      for (const ticker of tickers) {
        if (portfolio.positions[ticker]) continue;
        const candles = candleWindows[ticker];
        if (!candles || candles.length < MIN_CANDLES_REQUIRED) continue;

        const score = calculateOpportunityScore(candles, ticker);

        // Debug: log first few score evaluations
        if (stepIdx < 50 && stepIdx % 10 === 0 && ticker === tickers[0]) {
          console.log(`[Training DEBUG] step=${stepIdx} ${ticker} candles=${candles.length} score=${score.compositeScore.toFixed(1)} minOpp=${sel.minOppScore} sample: o=${candles[candles.length-1].o} h=${candles[candles.length-1].h} l=${candles[candles.length-1].l} c=${candles[candles.length-1].c} v=${candles[candles.length-1].v}`);
        }

        if (score.compositeScore > sel.minOppScore) {
          candidates.push({ ticker, score, candles });
        }
      }

      candidates.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

      // Debug: log candidate count at early steps
      if (stepIdx % 500 === 0) {
        console.log(`[Training DEBUG] step=${stepIdx} candidates=${candidates.length} cash=$${portfolio.cash.toFixed(2)} positions=${Object.keys(portfolio.positions).length}${candidates.length > 0 ? ' top=' + candidates[0].ticker + ' score=' + candidates[0].score.compositeScore.toFixed(1) : ''}`);
      }

      for (const candidate of candidates.slice(0, openSlots)) {
        if (portfolio.cash < minCashForEntry) break;
        if (Object.keys(portfolio.positions).length >= maxConcurrent) break;

        const { ticker, score, candles } = candidate;
        const currentPrice = candles[candles.length - 1].c * (1 + SLIPPAGE_PER_SIDE); // Buy slippage

        // Detect regime
        let regime = 'NORMAL';
        let regimeObj = null;
        try {
          regimeObj = detectMarketRegime(candles);
          regime = regimeObj?.trend || 'NORMAL';
        } catch (e) {}

        blockCounters.totalEntryAttempts++;

        // Regime gate — only allow entries in specified regimes
        if (sel.regimeGate && !sel.regimeGate.includes(regime)) {
          blockCounters.regimeGate++;
          continue;
        }

        // Evaluate strategies (require minStrategiesAgreeing)
        const entry = evaluateStrategies(candles, regime, state, sel.minStrategiesAgreeing, training.strategyFilter);
        if (!entry) {
          blockCounters.noStrategy++;
          continue;
        }

        // MULTI-TIMEFRAME CONFIRMATION — block only when BOTH 4h AND daily are bearish.
        // The regime+strategy quality filter handles regime selection more precisely.
        const mtfCtxEntry = candleIndex ? getMTFContext(candleIndex, ticker, currentTime) : null;
        if (mtfCtxEntry) {
          if (mtfCtxEntry.htf_trend_4h < 0 && mtfCtxEntry.daily_trend < 0) {
            blockCounters.mtfBlock++;
            continue;
          }
        } else {
          const htfTrend = getHigherTFTrend(candleData4h, ticker, currentTime);
          if (htfTrend === 'BEARISH') {
            blockCounters.mtfBlock++;
            continue;
          }
        }

        // TIME-OF-DAY FILTER — block entries during historically bad hours
        const blockedHours = state.tradeMemory?.blockedHours;
        if (blockedHours && blockedHours.length > 0) {
          const entryHour = new Date(currentTime).getUTCHours();
          if (blockedHours.includes(entryHour)) {
            if (!blockCounters.timeFilter) blockCounters.timeFilter = 0;
            blockCounters.timeFilter++;
            continue;
          }
        }

        // Capture indicator values for quality filtering + learning
        const tcVal = calculateTCSeries(candles).pop() ?? 50;
        const momVal = calculateMomentumSeries(candles).pop() ?? 50;
        const bkoutVal = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
        // Also capture volume ratio for learning
        const vols = candles.slice(-20).map(c => c.v || c.volume || 0);
        const avgVol = vols.reduce((a, b) => a + b, 0) / (vols.length || 1);
        const volRatio = avgVol > 0 ? ((candles[candles.length - 1].v || 0) / avgVol) * 25 : 50; // Scale to 0-100ish
        const indicatorValues = { tc: tcVal, momentum: momVal, breakout: bkoutVal, volRatio: Math.min(100, volRatio) };

        // FEE-AWARE ENTRY FILTER — only enter when expected move > fees + slippage
        // Require minimum 1% expected move to cover 0.52% taker fees + slippage
        const minExpectedMove = TRADING_FEE_ROUND_TRIP + SLIPPAGE_PER_SIDE * 2 + 0.003; // ~1%
        const atrForFilter = (() => {
          try { return calculateATR(candles, 14); } catch { return 0; }
        })();
        const expectedMove = atrForFilter > 0 ? atrForFilter / currentPrice : 0;
        if (expectedMove > 0 && expectedMove < minExpectedMove) {
          if (!blockCounters.feeFilter) blockCounters.feeFilter = 0;
          blockCounters.feeFilter++;
          continue;
        }

        // QUALITY FILTER — skip entries that historically lose
        let qualityMultiplier = 1.0;
        if (state.tradeMemory) {
          const quality = evaluateTradeQuality(state.tradeMemory, entry.strategy, regime, indicatorValues, sel);
          if (!quality.allow) {
            blockCounters.qualityFilter++;
            continue;
          }
          if (sel.qualityConfidenceFloor > 0 && quality.confidence < sel.qualityConfidenceFloor) {
            blockCounters.confidenceFloor++;
            continue;
          }
          qualityMultiplier = 0.5 + quality.confidence; // 0.5x to 1.5x
        }

        // POSITION SIZING per strategy
        const isAggressive = training.aggressiveCompounding;
        const sw = state.adaptiveWeights[entry.strategy];
        // In training mode, use a fixed fraction to ensure enough trades for learning.
        // The learned exit params, quality filters, and optimizer data carry forward
        // to live where Kelly sizing can be applied.
        let kellyFraction = isAggressive ? 0.25 : 0.15; // Fixed 15% or 25% for training

        // VOLATILITY-SCALED sizing — smaller positions in high-vol
        let volScale = 1.0;
        try {
          const atr = calculateATR(candles, 14);
          const atrPct = atr / currentPrice;
          // Target risk per trade: normalize around 2% ATR
          if (atrPct > 0) volScale = Math.max(0.4, Math.min(1.5, 0.02 / atrPct));
        } catch (e) {}

        // Position sizing
        const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
          (sum, p) => sum + (p.quantity * p.currentPrice), 0);
        let positionSize = totalValue * kellyFraction * qualityMultiplier * volScale;

        // Apply compound multiplier from beast mode (higher cap in aggressive mode)
        const compoundCap = isAggressive ? 2.0 : 1.5;
        positionSize *= Math.min(state.beastMode.compoundMultiplier, compoundCap);

        // Clamp to available cash — aggressive mode allows 50% per position, 1 concurrent
        const maxPosPct = isAggressive ? 0.50 : MAX_POSITION_PCT;
        positionSize = Math.min(positionSize, portfolio.cash * 0.95, totalValue * maxPosPct);

        // Min position size: $10 or 5% of initial budget (whichever is smaller)
        const minPositionSize = Math.min(10, portfolio.initialBudget * 0.05);
        if (positionSize < minPositionSize) {
          blockCounters.positionTooSmall++;
          continue;
        }

        blockCounters.totalEntries++;

        // Simulate buy
        const buyFee = currentPrice * (positionSize / currentPrice) * TRADING_FEE_PER_SIDE;
        const quantity = (positionSize - buyFee) / currentPrice;

        const entryFeatures = buildFeatureVector(candles, ticker, entry.strategy, regime, score, fearGreed, defiTvl, mtfCtxEntry);

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
          indicatorValues, // Store for learning at exit
          entryFeaturesJson: JSON.stringify(entryFeatures),
        };
        training.sessionTradeCount++;

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
    } // end entry cooldown else

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
  // Close all remaining positions at last available price (with sell slippage)
  for (const [ticker, position] of Object.entries(portfolio.positions)) {
    const price = (position.currentPrice || position.entryPrice) * (1 - SLIPPAGE_PER_SIDE);
    const sellFee = price * position.quantity * TRADING_FEE_PER_SIDE;
    const buyFee = position.entryPrice * position.quantity * TRADING_FEE_PER_SIDE;
    const pnl = (price - position.entryPrice) * position.quantity - sellFee - buyFee;
    portfolio.cash += (position.quantity * price) - sellFee;

    const pnlPct = (price - position.entryPrice) / position.entryPrice;
    const holdHrs = (lastStepTime - position.entryTime) / 3600000;
    if (!isEvalOnly) {
      recordTradeToState(state, pnl, position.strategy, lastStepTime, {
        regime: position.regime,
        indicatorValues: position.indicatorValues,
        pnlPct,
        holdHours: holdHrs,
      });
    }
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
    // Trade memory — carries learned patterns to next epoch
    tradeMemory: state.tradeMemory ? {
      regimeStrategy: state.tradeMemory.regimeStrategy,
      indicatorBins: state.tradeMemory.indicatorBins,
      exitParams: state.tradeMemory.exitParams,
      ...(state.tradeMemory.regimeExitOverrides ? { regimeExitOverrides: state.tradeMemory.regimeExitOverrides } : {}),
      ...(state.tradeMemory.blockedHours ? { blockedHours: state.tradeMemory.blockedHours } : {}),
    } : null,
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

  // Fee breakdown
  const avgFeePerTrade = training.stats.totalTrades > 0 ? training.stats.totalFees / training.stats.totalTrades : 0;
  const feeToProfitRatio = training.stats.totalPnl !== 0 ? Math.abs(training.stats.totalFees / training.stats.totalPnl) : 0;
  const feeMode = TRADING_FEE_PER_SIDE === TRADING_FEE_PER_SIDE_MAKER ? 'maker' : 'taker';

  console.log(`[Training] Run ${runId} COMPLETE: ${training.stats.totalTrades} trades, ${winRate.toFixed(1)}% win rate, $${training.stats.totalPnl.toFixed(2)} PnL, ${totalReturn.toFixed(1)}% return, Sharpe: ${sharpe.toFixed(2)}`);
  console.log(`[Training] FEES (${feeMode}): total=$${training.stats.totalFees.toFixed(2)} avg=$${avgFeePerTrade.toFixed(2)}/trade fee:profit=${feeToProfitRatio.toFixed(2)}x`);

  // Log block-reason summary
  console.log(`[Training] BLOCK REASONS: entries=${blockCounters.totalEntries} attempts=${blockCounters.totalEntryAttempts} | noStrategy=${blockCounters.noStrategy} mtf=${blockCounters.mtfBlock} quality=${blockCounters.qualityFilter} confidence=${blockCounters.confidenceFloor} regime=${blockCounters.regimeGate} posSize=${blockCounters.positionTooSmall} | cooldown=${blockCounters.entryCooldown} noSlots=${blockCounters.noOpenSlots} noCash=${blockCounters.noCash} paused=${blockCounters.paused}`);

  // Log exit reason breakdown
  const exitSummary = Object.entries(exitCounters)
    .filter(([, v]) => v.count > 0)
    .map(([k, v]) => `${k}=${v.count}(${v.totalPnl >= 0 ? '+' : ''}$${v.totalPnl.toFixed(2)})`)
    .join(' ');
  console.log(`[Training] EXIT REASONS: ${exitSummary}`);

  // Log learning stats
  if (state.tradeMemory) {
    const tm = state.tradeMemory;
    const rsEntries = Object.entries(tm.regimeStrategy);
    const filtered = rsEntries.filter(([_, v]) => v.wins + v.losses >= MIN_REGIME_STRATEGY_SAMPLES);
    const blocked = filtered.filter(([_, v]) => v.wins / (v.wins + v.losses) < REGIME_STRATEGY_MIN_WINRATE);
    // Log ALL regime+strategy WRs for analysis
    for (const [key, v] of filtered) {
      const total = v.wins + v.losses;
      const wr = (v.wins / total * 100).toFixed(1);
      const avgPnl = (v.totalPnl / total).toFixed(2);
      console.log(`[Training] Regime: ${key} = ${wr}% WR (${total} trades, avgPnl=$${avgPnl})`);
    }
    console.log(`[Training] Learning: ${rsEntries.length} regime+strategy combos, ${blocked.length} blocked (below ${REGIME_STRATEGY_MIN_WINRATE * 100}% WR)`);
    console.log(`[Training] Exit params: SL=${(tm.exitParams.stopLoss * 100).toFixed(1)}% TP=${(tm.exitParams.takeProfit * 100).toFixed(1)}% MaxHold=${tm.exitParams.maxHold}h`);
    console.log(`[Training] Optimized thresholds: TREND=${state.optimizer.optimizedParams.TREND_BULLISH_ENTRY} MOM=${state.optimizer.optimizedParams.MOMENTUM_BULLISH_ENTRY} BKOUT=${state.optimizer.optimizedParams.BREAKOUT_SQUEEZE_ENTRY}`);
  }
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

  // Collect learning metrics
  const learningMetrics = {};
  const tm = activeTraining.isolatedState?.tradeMemory;
  if (tm) {
    const rsEntries = Object.entries(tm.regimeStrategy);
    const filtered = rsEntries.filter(([_, v]) => v.wins + v.losses >= MIN_REGIME_STRATEGY_SAMPLES);
    const blocked = filtered.filter(([_, v]) => v.wins / (v.wins + v.losses) < REGIME_STRATEGY_MIN_WINRATE);
    learningMetrics.regimeStrategyCombos = rsEntries.length;
    learningMetrics.blockedCombos = blocked.length;
    learningMetrics.indicatorBins = Object.keys(tm.indicatorBins).length;
    learningMetrics.exitParams = tm.exitParams;
    learningMetrics.optimizedThresholds = activeTraining.isolatedState.optimizer?.optimizedParams || {};
  }

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
    learningMetrics,
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

/**
 * Distill a training run — keep only winning patterns, amplify big winners.
 * Creates a new synthetic "seed" run in the DB that future sessions can seed from.
 *
 * Process:
 * 1. Read learned state from source run
 * 2. For regimeStrategy: zero out losses for profitable combos, remove unprofitable ones
 * 3. For indicatorBins: keep only bins with >50% WR, amplify by avg PnL
 * 4. For exitParams: recalculate from winning trades only
 * 5. Save as new synthetic run
 *
 * @param {string} sourceRunId - Run to distill
 * @param {Object} options
 * @param {number} [options.minProfitPct=0] - Min PnL% to keep a trade as "winner"
 * @param {boolean} [options.amplifyBigWins=true] - Weight regime combos by avg PnL
 * @returns {{ runId, stats }} The new synthetic run ID and distillation stats
 */
export function distillSeed(sourceRunId, options = {}) {
  const { minProfitPct = 0, amplifyBigWins = true, profitFocused = false } = options;

  const learned = getLearnedState(sourceRunId);
  if (!learned) throw new Error(`No learned state for run ${sourceRunId}`);

  const sourceRun = getTrainingRun(sourceRunId);
  const distilled = JSON.parse(JSON.stringify(learned)); // deep clone

  const stats = {
    sourceRunId,
    regimeCombos: { kept: 0, removed: 0, amplified: 0 },
    indicatorBins: { kept: 0, removed: 0 },
    totalWinPnl: 0,
  };

  // --- 1. Distill regimeStrategy combos ---
  if (distilled.tradeMemory?.regimeStrategy) {
    const rs = distilled.tradeMemory.regimeStrategy;

    if (profitFocused) {
      // PROFIT-FOCUSED MODE: Relative ranking — keep top 60% by avgPnl, block bottom 40%
      // This avoids the $1M budget trap where ALL combos have negative avgPnl
      const entries = Object.entries(rs).filter(([, data]) => {
        const total = data.wins + data.losses;
        if (total < 3) return false;
        return true;
      });
      // Remove low-sample combos
      for (const [key, data] of Object.entries(rs)) {
        if (data.wins + data.losses < 3) {
          delete rs[key];
          stats.regimeCombos.removed++;
        }
      }
      // Sort by avgPnl descending (best performers first)
      entries.sort((a, b) => {
        const avgA = a[1].totalPnl / (a[1].wins + a[1].losses);
        const avgB = b[1].totalPnl / (b[1].wins + b[1].losses);
        return avgB - avgA;
      });
      // Keep top 60%, block bottom 40%
      const keepCount = Math.max(1, Math.ceil(entries.length * 0.6));
      for (let i = 0; i < entries.length; i++) {
        const [key, data] = entries[i];
        if (i < keepCount) {
          // Top performer — amplify wins, zero out losses
          const rank = keepCount - i; // higher rank = more boost
          const boost = amplifyBigWins ? Math.max(1, Math.min(5, rank)) : 1;
          rs[key] = {
            wins: data.wins * boost,
            losses: 0,
            totalPnl: Math.abs(data.totalPnl || 0.01) * boost,
          };
          stats.regimeCombos.kept++;
          stats.totalWinPnl += Math.abs(data.totalPnl || 0);
          if (boost > 1) stats.regimeCombos.amplified++;
        } else {
          // Bottom performer — amplify losses to discourage
          rs[key] = {
            wins: data.wins,
            losses: data.losses * 3,
            totalPnl: data.totalPnl,
          };
          stats.regimeCombos.removed++;
        }
      }
    } else {
      // WIN-RATE MODE (original): filter by WR >= 0.45
      for (const [key, data] of Object.entries(rs)) {
        const total = data.wins + data.losses;
        if (total < 3) {
          delete rs[key];
          stats.regimeCombos.removed++;
          continue;
        }
        const winRate = data.wins / total;
        if (winRate < 0.45) {
          rs[key] = {
            wins: data.wins,
            losses: data.losses * 2,
            totalPnl: data.totalPnl,
          };
          stats.regimeCombos.removed++;
        } else {
          const wrBoost = amplifyBigWins ? Math.max(1, Math.round((winRate - 0.45) * 20)) : 1;
          rs[key] = {
            wins: data.wins * wrBoost,
            losses: 0,
            totalPnl: Math.max(0.01, data.wins * wrBoost * 0.01),
          };
          stats.regimeCombos.kept++;
          stats.totalWinPnl += data.wins;
          if (wrBoost > 1) stats.regimeCombos.amplified++;
        }
      }
    }
  }

  // --- 2. Distill indicatorBins ---
  if (distilled.tradeMemory?.indicatorBins) {
    const bins = distilled.tradeMemory.indicatorBins;

    if (profitFocused) {
      // PROFIT-FOCUSED: Relative ranking — keep top 60% by win surplus, block bottom 40%
      const entries = Object.entries(bins).filter(([, data]) => {
        return (data.wins + data.losses) >= 5;
      });
      // Remove low-sample bins
      for (const [key, data] of Object.entries(bins)) {
        if (data.wins + data.losses < 5) {
          delete bins[key];
          stats.indicatorBins.removed++;
        }
      }
      // Sort by win surplus (wins - losses) descending
      entries.sort((a, b) => (b[1].wins - b[1].losses) - (a[1].wins - a[1].losses));
      const keepCount = Math.max(1, Math.ceil(entries.length * 0.6));
      for (let i = 0; i < entries.length; i++) {
        const [key, data] = entries[i];
        if (i < keepCount) {
          const rank = keepCount - i;
          const boost = amplifyBigWins ? Math.max(1, Math.min(3, Math.ceil(rank / 3))) : 1;
          bins[key] = { wins: data.wins * boost, losses: 0 };
          stats.indicatorBins.kept++;
        } else {
          bins[key] = { wins: data.wins, losses: data.losses * 3 };
          stats.indicatorBins.removed++;
        }
      }
    } else {
      // WIN-RATE MODE (original)
      for (const [key, data] of Object.entries(bins)) {
        const total = data.wins + data.losses;
        if (total < 5) {
          delete bins[key];
          stats.indicatorBins.removed++;
          continue;
        }
        const binWR = data.wins / total;
        if (binWR < 0.45) {
          bins[key] = { wins: data.wins, losses: data.losses * 2 };
          stats.indicatorBins.removed++;
        } else {
          bins[key] = { wins: data.wins, losses: 0 };
          stats.indicatorBins.kept++;
        }
      }
    }
  }

  // --- 3. Keep only winning PnL data + tighten entry thresholds ---
  if (distilled.tradeMemory) {
    // Keep winPnls, clear lossPnls
    distilled.tradeMemory.lossPnls = [];
    distilled.tradeMemory.lossHoldHours = [];
    // Reset optimization counter so next session optimizes fresh
    distilled.tradeMemory.tradesSinceOptimize = 0;
  }

  // Progressively tighten the TREND entry threshold each distillation round
  // Lower = more selective (only enter on very strong bullish signals)
  if (distilled.optimizer?.optimizedParams) {
    const currentEntry = distilled.optimizer.optimizedParams.TREND_BULLISH_ENTRY || 40;
    // Tighten by 2 each round, floor at 25
    distilled.optimizer.optimizedParams.TREND_BULLISH_ENTRY = Math.max(15, currentEntry - 1);
    stats.trendEntry = distilled.optimizer.optimizedParams.TREND_BULLISH_ENTRY;
  }

  // --- 4. Update circuit breaker to reflect only wins ---
  if (distilled.circuitBreaker) {
    const totalWins = Object.values(distilled.tradeMemory?.regimeStrategy || {})
      .reduce((s, d) => s + d.wins, 0);
    distilled.circuitBreaker.totalTrades = totalWins;
    distilled.circuitBreaker.totalWins = totalWins;
    distilled.circuitBreaker.totalLosses = 0;
    distilled.circuitBreaker.consecutiveLosses = 0;
    distilled.circuitBreaker.consecutiveWins = 3;
    distilled.circuitBreaker.dailyPnl = 0;
  }

  // --- 5. Save as new synthetic run ---
  const newRunId = `distill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  insertTrainingRun({
    run_id: newRunId,
    status: 'completed',
    config: {
      type: 'distilled',
      sourceRunId,
      options,
      sourceConfig: sourceRun?.config_json ? JSON.parse(sourceRun.config_json) : {},
    },
    start_time: Date.now(),
    total_steps: 0,
  });

  updateTrainingRun(newRunId, {
    status: 'completed',
    endTime: Date.now(),
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    learnedStateJson: JSON.stringify(distilled),
    strategyWeightsJson: JSON.stringify(distilled.adaptiveWeights || {}),
  });

  console.log(`[Training] Distilled ${sourceRunId} → ${newRunId}: ` +
    `kept ${stats.regimeCombos.kept} regime combos (removed ${stats.regimeCombos.removed}, amplified ${stats.regimeCombos.amplified}), ` +
    `kept ${stats.indicatorBins.kept} bins (removed ${stats.indicatorBins.removed})`);

  return { runId: newRunId, stats };
}

/**
 * GENETIC SEED CROSSOVER — Breed multiple seeds into a consensus child.
 * Only patterns that are "good" in a majority of parent seeds survive.
 * This is genetic crossover applied to trading pattern DNA.
 *
 * @param {string[]} seedIds - Array of parent seed/run IDs to breed
 * @param {object} options - { consensusThreshold: 0.6 }
 * @returns {{ runId: string, stats: object }}
 */
export function breedSeeds(seedIds, options = {}) {
  const { consensusThreshold = 0.6 } = options;

  const states = seedIds.map(id => {
    const learned = getLearnedState(id);
    if (!learned) throw new Error(`No learned state for ${id}`);
    return { id, state: learned };
  });
  if (states.length < 2) throw new Error('Need at least 2 seeds to breed');

  // Deep clone first seed as base
  const bred = JSON.parse(JSON.stringify(states[0].state));
  const minAgree = Math.ceil(states.length * consensusThreshold);

  const stats = {
    parentSeeds: seedIds,
    parentCount: states.length,
    consensusThreshold,
    minAgree,
    regimeCombos: { kept: 0, blocked: 0, total: 0 },
    indicatorBins: { kept: 0, blocked: 0, total: 0 },
  };

  // --- 1. Cross-reference regime+strategy combos ---
  if (bred.tradeMemory) {
    bred.tradeMemory.regimeStrategy = bred.tradeMemory.regimeStrategy || {};
    const rs = bred.tradeMemory.regimeStrategy;

    // Collect ALL unique keys across ALL parent seeds
    const allKeys = new Set();
    for (const s of states) {
      const parentRS = s.state.tradeMemory?.regimeStrategy;
      if (parentRS) Object.keys(parentRS).forEach(k => allKeys.add(k));
    }
    stats.regimeCombos.total = allKeys.size;

    for (const key of allKeys) {
      let goodCount = 0;
      let totalWins = 0;
      let totalLosses = 0;
      let totalPnl = 0;

      for (const s of states) {
        const combo = s.state.tradeMemory?.regimeStrategy?.[key];
        if (!combo) continue;
        const total = combo.wins + combo.losses;
        if (total < 2) continue;
        totalWins += combo.wins;
        totalLosses += combo.losses;
        totalPnl += combo.totalPnl || 0;
        // "Good" = more wins than losses in this seed
        if (combo.wins > combo.losses) goodCount++;
      }

      if (goodCount >= minAgree) {
        // CONSENSUS: pattern is good in majority of seeds → keep with amplified wins
        rs[key] = {
          wins: totalWins * goodCount,
          losses: 0,
          totalPnl: Math.abs(totalPnl || 0.01) * goodCount,
        };
        stats.regimeCombos.kept++;
      } else {
        // NO CONSENSUS: block hard
        rs[key] = {
          wins: Math.max(1, totalWins),
          losses: (totalLosses || 10) * 5,
          totalPnl: -Math.abs(totalPnl || 1),
        };
        stats.regimeCombos.blocked++;
      }
    }

    // --- 2. Cross-reference indicator bins ---
    bred.tradeMemory.indicatorBins = bred.tradeMemory.indicatorBins || {};
    const bins = bred.tradeMemory.indicatorBins;

    const allBinKeys = new Set();
    for (const s of states) {
      const parentBins = s.state.tradeMemory?.indicatorBins;
      if (parentBins) Object.keys(parentBins).forEach(k => allBinKeys.add(k));
    }
    stats.indicatorBins.total = allBinKeys.size;

    for (const key of allBinKeys) {
      let goodCount = 0;
      let totalWins = 0;
      let totalLosses = 0;

      for (const s of states) {
        const bin = s.state.tradeMemory?.indicatorBins?.[key];
        if (!bin) continue;
        const total = bin.wins + bin.losses;
        if (total < 3) continue;
        totalWins += bin.wins;
        totalLosses += bin.losses;
        if (bin.wins > bin.losses) goodCount++;
      }

      if (goodCount >= minAgree) {
        bins[key] = { wins: totalWins * goodCount, losses: 0 };
        stats.indicatorBins.kept++;
      } else {
        bins[key] = { wins: Math.max(1, totalWins), losses: (totalLosses || 10) * 5 };
        stats.indicatorBins.blocked++;
      }
    }

    // Clear loss data
    bred.tradeMemory.lossPnls = [];
    bred.tradeMemory.lossHoldHours = [];
    bred.tradeMemory.tradesSinceOptimize = 0;
  }

  // --- 3. Take best optimizer params (from seed with highest WR if available) ---
  // Keep from base seed (first), which is typically the best

  // --- 4. Update circuit breaker to reflect bred state ---
  if (bred.circuitBreaker) {
    const totalWins = Object.values(bred.tradeMemory?.regimeStrategy || {})
      .filter(d => d.losses === 0)
      .reduce((s, d) => s + d.wins, 0);
    bred.circuitBreaker.totalTrades = totalWins;
    bred.circuitBreaker.totalWins = totalWins;
    bred.circuitBreaker.totalLosses = 0;
    bred.circuitBreaker.consecutiveLosses = 0;
    bred.circuitBreaker.consecutiveWins = 3;
    bred.circuitBreaker.dailyPnl = 0;
  }

  // --- 5. Save as new synthetic run ---
  const newRunId = `breed_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  insertTrainingRun({
    run_id: newRunId,
    status: 'completed',
    config: { type: 'bred', parentSeeds: seedIds, options },
    start_time: Date.now(),
    total_steps: 0,
  });

  updateTrainingRun(newRunId, {
    status: 'completed',
    endTime: Date.now(),
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    learnedStateJson: JSON.stringify(bred),
    strategyWeightsJson: JSON.stringify(bred.adaptiveWeights || {}),
  });

  console.log(`[Training] Bred ${seedIds.length} seeds → ${newRunId}: ` +
    `kept ${stats.regimeCombos.kept}/${stats.regimeCombos.total} combos, ` +
    `kept ${stats.indicatorBins.kept}/${stats.indicatorBins.total} bins ` +
    `(consensus: ${minAgree}/${states.length} must agree)`);

  return { runId: newRunId, stats };
}

/**
 * MODIFY SEED — Create a copy of a seed with custom modifications.
 * Used for exit parameter sweeps, threshold tweaks, etc.
 *
 * @param {string} sourceRunId - The seed to copy
 * @param {object} modifications - { exitParams?, optimizedParams? }
 * @returns {{ runId: string }}
 */
export function modifySeed(sourceRunId, modifications = {}) {
  const learned = getLearnedState(sourceRunId);
  if (!learned) throw new Error(`No learned state for ${sourceRunId}`);

  const modified = JSON.parse(JSON.stringify(learned));

  // Apply exit param overrides
  if (modifications.exitParams && modified.tradeMemory) {
    modified.tradeMemory.exitParams = {
      ...(modified.tradeMemory.exitParams || {}),
      ...modifications.exitParams,
    };
  }

  // Apply optimizer param overrides
  if (modifications.optimizedParams && modified.optimizer) {
    modified.optimizer.optimizedParams = {
      ...(modified.optimizer.optimizedParams || {}),
      ...modifications.optimizedParams,
    };
  }

  // Apply regime-specific exit overrides (e.g., UP_TREND gets wider TP)
  if (modifications.regimeExitOverrides && modified.tradeMemory) {
    modified.tradeMemory.regimeExitOverrides = {
      ...(modified.tradeMemory.regimeExitOverrides || {}),
      ...modifications.regimeExitOverrides,
    };
  }

  // Apply time-of-day blocked hours (array of UTC hours 0-23)
  if (modifications.blockedHours && modified.tradeMemory) {
    modified.tradeMemory.blockedHours = modifications.blockedHours;
  }

  const newRunId = `mod_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  insertTrainingRun({
    run_id: newRunId,
    status: 'completed',
    config: { type: 'modified', sourceRunId, modifications },
    start_time: Date.now(),
    total_steps: 0,
  });

  updateTrainingRun(newRunId, {
    status: 'completed',
    endTime: Date.now(),
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    learnedStateJson: JSON.stringify(modified),
    strategyWeightsJson: JSON.stringify(modified.adaptiveWeights || {}),
  });

  console.log(`[Training] Modified ${sourceRunId} → ${newRunId}: ${Object.keys(modifications).join(', ')}`);

  return { runId: newRunId };
}
