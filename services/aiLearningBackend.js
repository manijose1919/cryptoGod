/**
 * AI Learning Backend Service
 *
 * Ported from aiLearningService.ts for backend use.
 * Uses direct SQLite calls via database.js (no HTTP).
 *
 * Provides:
 * 1. Trade recording and learning from outcomes
 * 2. Dynamic parameter adjustment based on performance
 * 3. Pattern matching against trade memory
 * 4. Aggressive mode control
 */

import {
  insertTradeMemory,
  getTradeMemories,
  upsertLearnedPattern,
  getLearnedPatterns,
  insertParameterSnapshot,
  getLatestParameters,
} from './database.js';

// ML Prediction Service (lazy-loaded)
let mlPrediction = null;
let selfTeaching = null;
try {
  mlPrediction = await import('./mlPredictionService.js');
} catch (e) {
  console.warn('[AI-LEARN] ML prediction service not available:', e.message);
}
try {
  selfTeaching = await import('./selfTeachingLoop.js');
} catch (e) {
  console.warn('[AI-LEARN] Self-teaching loop not available:', e.message);
}

// ============================================
// DEFAULT VALUES
// ============================================
const DEFAULT_PARAMETERS = {
  tcEntryThreshold: 50,
  momentumEntryThreshold: 5,
  whaleEntryThreshold: 48,
  confluenceEntryThreshold: 2,
  profitTargetPercent: 0.5,
  stopLossPercent: 1.0,
  maxPositionPercent: 25,
  confidenceThreshold: 15,
  strategyWeights: {
    TREND: 1.3,
    BREAKOUT: 1.2,
    WHALE: 1.0,
    CONFLUENCE: 1.0,
    MOMENTUM: 1.2,
    DIVERGENCE: 0.9,
    ADAPTIVE: 1.1,
  },
  aggressiveness: 85,
};

const STRATEGIES = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];

// ============================================
// IN-MEMORY STATE
// ============================================
let tradeMemory = [];
let learningState = createFreshState();

function createFreshState() {
  const strategyStats = {};
  for (const s of STRATEGIES) {
    strategyStats[s] = { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 };
  }
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgWinPercent: 0,
    avgLossPercent: 0,
    profitFactor: 0,
    bestStrategy: null,
    worstStrategy: null,
    strategyStats,
    learnedPatterns: [],
    parameterAdjustments: { ...DEFAULT_PARAMETERS, strategyWeights: { ...DEFAULT_PARAMETERS.strategyWeights } },
    lastAnalysisTime: 0,
  };
}

// ============================================
// INITIALIZATION - Restore from SQLite
// ============================================

/**
 * Restore learning state from SQLite database on startup
 */
export function restoreFromDatabase() {
  let tradesLoaded = 0;
  let patternsLoaded = 0;
  let paramsRestored = false;

  try {
    const memories = getTradeMemories(500);
    if (memories && memories.length > 0) {
      tradeMemory = memories.map(m => ({
        id: m.id,
        ticker: m.ticker,
        strategy: m.strategy,
        entryPrice: m.entry_price,
        exitPrice: m.exit_price,
        entryTime: m.entry_time,
        exitTime: m.exit_time,
        pnl: m.pnl,
        pnlPercent: m.pnl_percent,
        outcome: m.outcome,
        holdDuration: m.hold_duration,
        marketConditions: {
          volatility: m.market_volatility || 'MEDIUM',
          trend: m.market_trend || 'SIDEWAYS',
          volume: m.market_volume || 'MEDIUM',
        },
        indicators: {
          tcValue: m.tc_value || 50,
          momentumValue: m.momentum_value || 50,
          whaleValue: m.whale_value || 50,
          confluenceScore: m.confluence_score || 3,
        },
      }));
      tradesLoaded = tradeMemory.length;
      updateLearningState();
    }
  } catch (e) {
    console.warn('[AI-LEARN] Could not restore trade memory:', e.message);
  }

  try {
    const patterns = getLearnedPatterns();
    if (patterns && patterns.length > 0) {
      learningState.learnedPatterns = patterns.map(p => ({
        id: p.id,
        description: p.description,
        conditions: {
          tcRange: [p.tc_range_low, p.tc_range_high],
          momentumRange: [p.momentum_range_low, p.momentum_range_high],
          volatility: p.volatility,
          trend: p.trend,
        },
        successRate: p.success_rate,
        sampleSize: p.sample_size,
        recommendation: p.recommendation,
      }));
      patternsLoaded = learningState.learnedPatterns.length;
    }
  } catch (e) {
    console.warn('[AI-LEARN] Could not restore patterns:', e.message);
  }

  try {
    const latest = getLatestParameters();
    if (latest && latest.params_json) {
      const savedParams = JSON.parse(latest.params_json);
      learningState.parameterAdjustments = {
        ...DEFAULT_PARAMETERS,
        strategyWeights: { ...DEFAULT_PARAMETERS.strategyWeights },
        ...savedParams,
      };
      paramsRestored = true;
    }
  } catch (e) {
    console.warn('[AI-LEARN] Could not restore parameters:', e.message);
  }

  // Initialize aggressive mode
  setAggressiveMode(85);

  console.log(`[AI-LEARN] Restored: ${tradesLoaded} trades, ${patternsLoaded} patterns, params=${paramsRestored}`);
  return { tradesLoaded, patternsLoaded, paramsRestored };
}

// ============================================
// CORE: Record trade for learning
// ============================================

/**
 * Record a completed trade and update learning state
 * @param {object} trade - { ticker, strategy, entryPrice, exitPrice, entryTime, exitTime, quantity, indicators, marketConditions }
 */
export function recordTradeForLearning(trade) {
  const pnl = (trade.exitPrice - trade.entryPrice) * trade.quantity;
  const pnlPercent = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
  const holdDuration = (trade.exitTime - trade.entryTime) / 60000;

  const outcome = pnlPercent > 0.05 ? 'WIN' : pnlPercent < -0.05 ? 'LOSS' : 'BREAKEVEN';

  const memory = {
    id: Date.now(),
    ticker: trade.ticker,
    strategy: trade.strategy,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    pnl,
    pnlPercent,
    outcome,
    holdDuration,
    marketConditions: trade.marketConditions || { volatility: 'MEDIUM', trend: 'SIDEWAYS', volume: 'MEDIUM' },
    indicators: trade.indicators || { tcValue: 50, momentumValue: 50, whaleValue: 50, confluenceScore: 3 },
  };

  tradeMemory.push(memory);
  if (tradeMemory.length > 500) {
    tradeMemory = tradeMemory.slice(-500);
  }

  // Persist to SQLite
  try {
    insertTradeMemory({
      ticker: memory.ticker,
      strategy: memory.strategy,
      entryPrice: memory.entryPrice,
      exitPrice: memory.exitPrice,
      entryTime: memory.entryTime,
      exitTime: memory.exitTime,
      pnl: memory.pnl,
      pnlPercent: memory.pnlPercent,
      outcome: memory.outcome,
      holdDuration: memory.holdDuration,
      marketVolatility: memory.marketConditions.volatility,
      marketTrend: memory.marketConditions.trend,
      marketVolume: memory.marketConditions.volume,
      tcValue: memory.indicators.tcValue,
      momentumValue: memory.indicators.momentumValue,
      whaleValue: memory.indicators.whaleValue,
      confluenceScore: memory.indicators.confluenceScore,
      aiAnalysis: null,
    });
  } catch (e) {
    console.warn('[AI-LEARN] Failed to persist trade memory:', e.message);
  }

  updateLearningState();

  // Feed trade to self-teaching loop (Phase 5)
  if (selfTeaching) {
    try {
      selfTeaching.onTradeComplete({
        ticker: memory.ticker,
        strategy: memory.strategy,
        entryTime: memory.entryTime,
        exitTime: memory.exitTime,
        entryPrice: memory.entryPrice,
        exitPrice: memory.exitPrice,
        pnl: memory.pnl,
        pnlPercent: memory.pnlPercent,
        outcome: memory.outcome,
      });
    } catch (e) {
      // Self-teaching failure should never block trade recording
    }
  }

  return memory;
}

// ============================================
// Update learning state from trade history
// ============================================

function updateLearningState() {
  if (tradeMemory.length === 0) return;

  const wins = tradeMemory.filter(t => t.outcome === 'WIN');
  const losses = tradeMemory.filter(t => t.outcome === 'LOSS');

  learningState.totalTrades = tradeMemory.length;
  learningState.wins = wins.length;
  learningState.losses = losses.length;
  learningState.winRate = tradeMemory.length > 0 ? (wins.length / tradeMemory.length) * 100 : 0;

  learningState.avgWinPercent = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.pnlPercent, 0) / wins.length : 0;
  learningState.avgLossPercent = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + t.pnlPercent, 0) / losses.length) : 0;

  const totalWinAmount = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  learningState.profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? 999 : 0;

  let bestWinRate = 0;
  let worstWinRate = 100;

  for (const strat of STRATEGIES) {
    const stratTrades = tradeMemory.filter(t => t.strategy === strat);
    const stratWins = stratTrades.filter(t => t.outcome === 'WIN');
    const totalPnl = stratTrades.reduce((sum, t) => sum + t.pnl, 0);

    learningState.strategyStats[strat] = {
      trades: stratTrades.length,
      wins: stratWins.length,
      winRate: stratTrades.length > 0 ? (stratWins.length / stratTrades.length) * 100 : 0,
      avgPnl: stratTrades.length > 0 ? totalPnl / stratTrades.length : 0,
      totalPnl,
    };

    if (stratTrades.length >= 5) {
      if (learningState.strategyStats[strat].winRate > bestWinRate) {
        bestWinRate = learningState.strategyStats[strat].winRate;
        learningState.bestStrategy = strat;
      }
      if (learningState.strategyStats[strat].winRate < worstWinRate) {
        worstWinRate = learningState.strategyStats[strat].winRate;
        learningState.worstStrategy = strat;
      }
    }
  }

  adjustParametersFromLearning();
}

// ============================================
// Auto-adjust parameters from learning
// ============================================

function adjustParametersFromLearning() {
  const params = learningState.parameterAdjustments;

  if (learningState.winRate > 55 && learningState.totalTrades >= 10) {
    params.aggressiveness = Math.min(90, params.aggressiveness + 5);
    params.confidenceThreshold = Math.max(20, params.confidenceThreshold - 2);
  }

  if (learningState.winRate < 40 && learningState.totalTrades >= 10) {
    params.aggressiveness = Math.max(30, params.aggressiveness - 5);
    params.confidenceThreshold = Math.min(50, params.confidenceThreshold + 2);
  }

  for (const strat of STRATEGIES) {
    const stats = learningState.strategyStats[strat];
    if (stats.trades >= 5) {
      if (stats.winRate > 60) {
        params.strategyWeights[strat] = Math.min(2.0, (params.strategyWeights[strat] || 1) + 0.1);
      } else if (stats.winRate < 35) {
        params.strategyWeights[strat] = Math.max(0.3, (params.strategyWeights[strat] || 1) - 0.1);
      }
    }
  }

  if (learningState.avgWinPercent > 0 && learningState.avgLossPercent > 0) {
    if (learningState.avgWinPercent < 0.5 && learningState.winRate > 55) {
      params.profitTargetPercent = Math.max(0.2, learningState.avgWinPercent * 0.8);
    }
    if (learningState.avgLossPercent > 1.5) {
      params.stopLossPercent = Math.max(0.5, params.stopLossPercent - 0.1);
    }
  }

  // Persist snapshot every 10 trades
  if (learningState.totalTrades > 0 && learningState.totalTrades % 10 === 0) {
    persistParameters(`auto-adjust after ${learningState.totalTrades} trades`);
  }
}

function persistParameters(reason) {
  try {
    insertParameterSnapshot({
      paramsJson: JSON.stringify(learningState.parameterAdjustments),
      winRate: learningState.winRate,
      profitFactor: learningState.profitFactor,
      totalTrades: learningState.totalTrades,
      reason,
    });
  } catch (e) {
    console.warn('[AI-LEARN] Failed to persist parameters:', e.message);
  }
}

// ============================================
// CORE: Should take trade? (Pattern matching)
// ============================================

/**
 * Decide if a trade should be taken based on learning
 * @param {string} ticker
 * @param {string} strategy
 * @param {object} indicators - { tcValue, momentumValue, whaleValue, confluenceScore, confidence }
 * @param {object} marketConditions - { volatility, trend }
 * @returns {{ take, reason, adjustedConfidence }}
 */
export function shouldTakeTradeAI(ticker, strategy, indicators, marketConditions) {
  const params = learningState.parameterAdjustments;
  const strategyWeight = params.strategyWeights[strategy] || 1;
  const adjustedConfidence = (indicators.confidence || 50) * strategyWeight;

  // Check similar past trades
  const similarTrades = tradeMemory.filter(t =>
    t.strategy === strategy &&
    Math.abs(t.indicators.tcValue - indicators.tcValue) < 10 &&
    t.marketConditions.volatility === (marketConditions?.volatility || 'MEDIUM')
  );

  let patternBonus = 0;
  if (similarTrades.length >= 3) {
    const similarWinRate = similarTrades.filter(t => t.outcome === 'WIN').length / similarTrades.length;
    patternBonus = (similarWinRate - 0.5) * 20;
  }

  const finalConfidence = adjustedConfidence + patternBonus;

  // Aggressive mode: force trade after idle
  const timeSinceLastTrade = tradeMemory.length > 0
    ? Date.now() - tradeMemory[tradeMemory.length - 1].exitTime
    : Infinity;

  if (timeSinceLastTrade > 120000) {
    return {
      take: true,
      reason: `AGGRESSIVE: Trade after ${(timeSinceLastTrade / 60000).toFixed(1)}min idle`,
      adjustedConfidence: Math.max(finalConfidence, 50)
    };
  }

  // High confidence bypass
  if (finalConfidence >= 60) {
    return { take: true, reason: `HIGH_CONFIDENCE: ${finalConfidence.toFixed(0)}`, adjustedConfidence: finalConfidence };
  }

  // Confidence threshold check
  if (finalConfidence < params.confidenceThreshold) {
    if (tradeMemory.length === 0 && finalConfidence > 10) {
      return { take: true, reason: `COLD_START: First trade`, adjustedConfidence: finalConfidence };
    }
    return { take: false, reason: `Low confidence ${finalConfidence.toFixed(0)} < ${params.confidenceThreshold}`, adjustedConfidence: finalConfidence };
  }

  // Similar losing pattern detected
  if (similarTrades.length >= 3 && patternBonus < -5) {
    return {
      take: true,
      reason: `CAUTION: Similar losing pattern (penalty ${patternBonus.toFixed(0)})`,
      adjustedConfidence: finalConfidence,
      positionPenalty: 0.8 // Signal to reduce position by 20%
    };
  }

  // ML Prediction Override (Phase 2)
  if (mlPrediction) {
    try {
      const mlResult = mlPrediction.shouldTradeML(ticker, null, strategy, { marketRegime: marketConditions?.trend });
      if (mlResult && mlResult.mlAvailable && mlResult.confidence >= 60) {
        if (!mlResult.take) {
          return {
            take: false,
            reason: `ML_VETO: ${mlResult.reason} (${mlResult.confidence.toFixed(0)}% conf)`,
            adjustedConfidence: mlResult.confidence,
            mlPrediction: mlResult
          };
        }
        // ML agrees - boost confidence
        return {
          take: true,
          reason: `ML_CONFIRM: ${mlResult.direction} (${mlResult.confidence.toFixed(0)}% conf) + Pattern: ${similarTrades.length > 0 ? ((similarTrades.filter(t => t.outcome === 'WIN').length / similarTrades.length) * 100).toFixed(0) : 'N/A'}%`,
          adjustedConfidence: Math.min(finalConfidence + 10, 100),
          mlPrediction: mlResult
        };
      }
    } catch (e) {
      // ML failure should never block trades
    }
  }

  return {
    take: true,
    reason: `LEARNED: Pattern win rate ${similarTrades.length > 0 ? ((similarTrades.filter(t => t.outcome === 'WIN').length / similarTrades.length) * 100).toFixed(0) : 'N/A'}%`,
    adjustedConfidence: finalConfidence
  };
}

// ============================================
// Parameter adjustments getter
// ============================================

export function getParameterAdjustments() {
  return { ...learningState.parameterAdjustments };
}

// ============================================
// Aggressive mode
// ============================================

export function getAggressiveMode() {
  const params = learningState.parameterAdjustments;
  const timeSinceLastTrade = tradeMemory.length > 0
    ? Date.now() - tradeMemory[tradeMemory.length - 1].exitTime
    : Infinity;

  return {
    level: params.aggressiveness,
    idleMinutes: timeSinceLastTrade / 60000,
    forceEntry: timeSinceLastTrade > 120000,
  };
}

export function setAggressiveMode(level) {
  const params = learningState.parameterAdjustments;
  params.aggressiveness = level;
  params.confidenceThreshold = Math.max(10, 40 - level * 0.4);
  params.tcEntryThreshold = Math.min(55, 35 + level * 0.25);
  params.momentumEntryThreshold = Math.max(3, 15 - level * 0.15);
  params.whaleEntryThreshold = Math.max(45, 55 - level * 0.12);
  params.confluenceEntryThreshold = Math.max(2, 3 - Math.floor(level / 40));
}

// ============================================
// Status endpoint data
// ============================================

export function getAILearningStatus() {
  return {
    totalTrades: learningState.totalTrades,
    wins: learningState.wins,
    losses: learningState.losses,
    winRate: learningState.winRate,
    avgWinPercent: learningState.avgWinPercent,
    avgLossPercent: learningState.avgLossPercent,
    profitFactor: learningState.profitFactor,
    bestStrategy: learningState.bestStrategy,
    worstStrategy: learningState.worstStrategy,
    strategyStats: learningState.strategyStats,
    patternCount: learningState.learnedPatterns.length,
    aggressiveness: learningState.parameterAdjustments.aggressiveness,
    confidenceThreshold: learningState.parameterAdjustments.confidenceThreshold,
    memorySize: tradeMemory.length,
  };
}
