/**
 * AI Learning Service - Local Statistical Engine
 *
 * This service provides:
 * 1. Trade analysis and learning from outcomes
 * 2. Dynamic parameter adjustment based on what's working
 * 3. Market sentiment analysis
 * 4. Pattern recognition and reinforcement
 *
 * Uses local statistical analysis - no external API needed.
 */

import type { Trade, TradingStrategy, Candle } from '../types';
import {
  saveTradeMemory,
  loadTradeMemory,
  toTradeMemoryFormat,
  saveLearnedPattern,
  loadLearnedPatterns,
  toLearnedPatternFormat,
  saveParameterAdjustments,
  loadLatestParameters,
} from './persistenceService';

// ============================================
// TYPES
// ============================================
export interface TradeMemory {
  id: number;
  ticker: string;
  strategy: TradingStrategy;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPercent: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  holdDuration: number; // minutes
  marketConditions: {
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    trend: 'UP' | 'DOWN' | 'SIDEWAYS';
    volume: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  indicators: {
    tcValue: number;
    momentumValue: number;
    whaleValue: number;
    confluenceScore: number;
  };
  aiAnalysis?: string;
}

export interface LearningState {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPercent: number;
  avgLossPercent: number;
  profitFactor: number;
  bestStrategy: TradingStrategy | null;
  worstStrategy: TradingStrategy | null;
  strategyStats: Record<TradingStrategy, {
    trades: number;
    wins: number;
    winRate: number;
    avgPnl: number;
    totalPnl: number;
  }>;
  learnedPatterns: LearnedPattern[];
  parameterAdjustments: ParameterAdjustments;
  lastAIAnalysis: string | null;
  lastAnalysisTime: number;
}

export interface LearnedPattern {
  id: string;
  description: string;
  conditions: {
    tcRange: [number, number];
    momentumRange: [number, number];
    volatility: string;
    trend: string;
  };
  successRate: number;
  sampleSize: number;
  recommendation: 'STRONG_BUY' | 'BUY' | 'AVOID' | 'STRONG_AVOID';
}

export interface ParameterAdjustments {
  // Entry thresholds (lower = more aggressive)
  tcEntryThreshold: number;
  momentumEntryThreshold: number;
  whaleEntryThreshold: number;
  confluenceEntryThreshold: number;

  // Exit thresholds
  profitTargetPercent: number;
  stopLossPercent: number;

  // Risk
  maxPositionPercent: number;
  confidenceThreshold: number;

  // Strategy weights (higher = preferred)
  strategyWeights: Record<TradingStrategy, number>;

  // Aggressiveness (0-100)
  aggressiveness: number;
}

// ============================================
// DEFAULT VALUES
// ============================================
const DEFAULT_PARAMETERS: ParameterAdjustments = {
  // ULTRA-AGGRESSIVE defaults - maximize trades!
  tcEntryThreshold: 50,           // Very lenient - almost any TC value triggers
  momentumEntryThreshold: 5,      // Very low momentum threshold
  whaleEntryThreshold: 48,        // Low whale threshold
  confluenceEntryThreshold: 2,    // Only need 2 indicators aligned

  profitTargetPercent: 0.5,       // Take profits quickly
  stopLossPercent: 1.0,           // Tight stop loss

  maxPositionPercent: 25,         // Allow larger positions
  confidenceThreshold: 15,        // Very low - let surge detection handle quality

  strategyWeights: {
    TREND: 1.3,      // Trend gets highest priority
    BREAKOUT: 1.2,   // Breakout also high priority
    WHALE: 1.0,
    CONFLUENCE: 1.0,
    MOMENTUM: 1.2,   // Momentum important for surges
    DIVERGENCE: 0.9,
    ADAPTIVE: 1.1,
  },

  aggressiveness: 85,  // Start very aggressive to generate trades
};

// ============================================
// TRADE MEMORY STORAGE
// ============================================
let tradeMemory: TradeMemory[] = [];
let learningState: LearningState = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  avgWinPercent: 0,
  avgLossPercent: 0,
  profitFactor: 0,
  bestStrategy: null,
  worstStrategy: null,
  strategyStats: {
    TREND: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    BREAKOUT: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    WHALE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    CONFLUENCE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    MOMENTUM: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    DIVERGENCE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    ADAPTIVE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
  },
  learnedPatterns: [],
  parameterAdjustments: { ...DEFAULT_PARAMETERS },
  lastAIAnalysis: null,
  lastAnalysisTime: 0,
};

// ============================================
// PERSISTENCE INTEGRATION
// ============================================
let persistenceInitialized = false;

/**
 * Restore learning state from SQLite database.
 * Call this once on app startup to recover from previous sessions.
 */
export async function restoreFromDatabase(): Promise<{ tradesLoaded: number; patternsLoaded: number; paramsRestored: boolean }> {
  let tradesLoaded = 0;
  let patternsLoaded = 0;
  let paramsRestored = false;

  try {
    // Restore trade memory
    const { memories } = await loadTradeMemory(500);
    if (memories && memories.length > 0) {
      tradeMemory = memories.map(toTradeMemoryFormat);
      tradesLoaded = tradeMemory.length;
      // Rebuild learning state from restored trades
      updateLearningState();
    }
  } catch (e) {
    console.warn('[AI Learning] Could not restore trade memory from DB:', e);
  }

  try {
    // Restore learned patterns
    const { patterns } = await loadLearnedPatterns();
    if (patterns && patterns.length > 0) {
      learningState.learnedPatterns = patterns.map(toLearnedPatternFormat);
      patternsLoaded = learningState.learnedPatterns.length;
    }
  } catch (e) {
    console.warn('[AI Learning] Could not restore patterns from DB:', e);
  }

  try {
    // Restore latest parameter adjustments
    const { latest } = await loadLatestParameters();
    if (latest && latest.params_json) {
      const savedParams = JSON.parse(latest.params_json);
      // Merge saved params with defaults (in case new fields were added)
      learningState.parameterAdjustments = { ...DEFAULT_PARAMETERS, ...savedParams };
      paramsRestored = true;
    }
  } catch (e) {
    console.warn('[AI Learning] Could not restore parameters from DB:', e);
  }

  persistenceInitialized = true;
  console.log(`[AI Learning] Restored: ${tradesLoaded} trades, ${patternsLoaded} patterns, params=${paramsRestored}`);
  return { tradesLoaded, patternsLoaded, paramsRestored };
}

/**
 * Persist a trade memory to the database (fire-and-forget)
 */
function persistTradeMemory(memory: TradeMemory): void {
  saveTradeMemory({
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
    marketConditions: memory.marketConditions,
    indicators: memory.indicators,
    aiAnalysis: memory.aiAnalysis,
  }).catch(e => console.warn('[AI Learning] Failed to persist trade memory:', e));
}

/**
 * Persist current parameter adjustments to the database (fire-and-forget)
 */
function persistParameters(reason: string): void {
  saveParameterAdjustments({
    params: learningState.parameterAdjustments,
    winRate: learningState.winRate,
    profitFactor: learningState.profitFactor,
    totalTrades: learningState.totalTrades,
    reason,
  }).catch(e => console.warn('[AI Learning] Failed to persist parameters:', e));
}

/**
 * Persist learned patterns to the database (fire-and-forget)
 */
function persistLearnedPatterns(): void {
  for (const pattern of learningState.learnedPatterns) {
    saveLearnedPattern(pattern).catch(e =>
      console.warn('[AI Learning] Failed to persist pattern:', e)
    );
  }
}

// ============================================
// LOCAL STATISTICAL ANALYSIS ENGINE
// ============================================

/**
 * Analyze trade performance locally using statistics.
 * No external API needed - instant, free, unlimited.
 */
function localAnalyze(): string {
  if (tradeMemory.length < 5) {
    return JSON.stringify({ patterns: 'Insufficient data', parameterChanges: {}, strategyAdvice: {}, riskAdvice: 'Collect more trades' });
  }

  const recent = tradeMemory.slice(-20);
  const wins = recent.filter(t => t.outcome === 'WIN');
  const losses = recent.filter(t => t.outcome === 'LOSS');
  const winRate = recent.length > 0 ? (wins.length / recent.length) * 100 : 50;

  // Identify best/worst strategies
  const stratPerf: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of recent) {
    const s = t.strategy || 'ADAPTIVE';
    if (!stratPerf[s]) stratPerf[s] = { wins: 0, losses: 0, pnl: 0 };
    if (t.outcome === 'WIN') stratPerf[s].wins++;
    else if (t.outcome === 'LOSS') stratPerf[s].losses++;
    stratPerf[s].pnl += t.pnl;
  }

  const bestStrat = Object.entries(stratPerf)
    .sort((a, b) => b[1].pnl - a[1].pnl)[0];
  const worstStrat = Object.entries(stratPerf)
    .sort((a, b) => a[1].pnl - b[1].pnl)[0];

  // Identify market condition patterns
  const winConditions = wins.map(t => t.marketConditions?.volatility).filter(Boolean);
  const lossConditions = losses.map(t => t.marketConditions?.volatility).filter(Boolean);
  const bestVolatility = mostCommon(winConditions) || 'MEDIUM';
  const worstVolatility = mostCommon(lossConditions) || 'HIGH';

  // Parameter recommendations
  const parameterChanges: Record<string, number> = {};
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) : 0;

  if (avgLossPct > avgWinPct * 1.5) {
    parameterChanges.stopLossPercent = Math.max(0.5, avgWinPct * 0.8);
  }
  if (winRate < 40) {
    parameterChanges.confidenceThreshold = 45;
  } else if (winRate > 65) {
    parameterChanges.confidenceThreshold = 30;
  }

  // Strategy advice
  const boost: string[] = [];
  const reduce: string[] = [];
  for (const [strat, perf] of Object.entries(stratPerf)) {
    const wr = (perf.wins + perf.losses) > 0 ? perf.wins / (perf.wins + perf.losses) : 0.5;
    if (wr > 0.6 && perf.pnl > 0) boost.push(strat);
    else if (wr < 0.35 && perf.pnl < 0) reduce.push(strat);
  }

  const result = {
    patterns: `Win rate: ${winRate.toFixed(1)}%. Best in ${bestVolatility} volatility. Worst in ${worstVolatility}. ${bestStrat ? `Top strategy: ${bestStrat[0]}` : ''}`,
    parameterChanges,
    strategyAdvice: { boost, reduce },
    riskAdvice: avgLossPct > 1.5 ? 'Tighten stop losses - avg loss too high' : winRate > 55 ? 'Performance solid - maintain current risk' : 'Consider reducing position sizes'
  };

  return JSON.stringify(result);
}

function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts: Record<string, number> = {};
  arr.forEach(v => counts[v] = (counts[v] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ============================================
// CORE LEARNING FUNCTIONS
// ============================================

/**
 * Record a completed trade and update learning state
 */
export function recordTrade(trade: {
  ticker: string;
  strategy: TradingStrategy;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  quantity: number;
  indicators: {
    tcValue: number;
    momentumValue: number;
    whaleValue: number;
    confluenceScore: number;
  };
  marketConditions: {
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    trend: 'UP' | 'DOWN' | 'SIDEWAYS';
    volume: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}): TradeMemory {
  const pnl = (trade.exitPrice - trade.entryPrice) * trade.quantity;
  const pnlPercent = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
  const holdDuration = (trade.exitTime - trade.entryTime) / 60000; // minutes

  const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' =
    pnlPercent > 0.05 ? 'WIN' : pnlPercent < -0.05 ? 'LOSS' : 'BREAKEVEN';

  const memory: TradeMemory = {
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
    marketConditions: trade.marketConditions,
    indicators: trade.indicators,
  };

  tradeMemory.push(memory);

  // Keep only last 500 trades
  if (tradeMemory.length > 500) {
    tradeMemory = tradeMemory.slice(-500);
  }

  // Persist to SQLite (fire-and-forget)
  persistTradeMemory(memory);

  // Update learning state
  updateLearningState();

  return memory;
}

/**
 * Update learning state based on trade history
 */
function updateLearningState(): void {
  if (tradeMemory.length === 0) return;

  const wins = tradeMemory.filter(t => t.outcome === 'WIN');
  const losses = tradeMemory.filter(t => t.outcome === 'LOSS');

  learningState.totalTrades = tradeMemory.length;
  learningState.wins = wins.length;
  learningState.losses = losses.length;
  learningState.winRate = tradeMemory.length > 0 ? (wins.length / tradeMemory.length) * 100 : 0;

  learningState.avgWinPercent = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.pnlPercent, 0) / wins.length
    : 0;

  learningState.avgLossPercent = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + t.pnlPercent, 0) / losses.length)
    : 0;

  const totalWinAmount = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  learningState.profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? 999 : 0;

  // Update strategy stats
  const strategies: TradingStrategy[] = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];

  let bestWinRate = 0;
  let worstWinRate = 100;

  for (const strat of strategies) {
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

    if (stratTrades.length >= 5) { // Need at least 5 trades to judge
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

  // Adjust parameters based on learning
  adjustParametersFromLearning();
}

/**
 * Adjust trading parameters based on what we've learned
 */
function adjustParametersFromLearning(): void {
  const params = learningState.parameterAdjustments;

  // If win rate is good (>55%), be more aggressive
  if (learningState.winRate > 55 && learningState.totalTrades >= 10) {
    params.aggressiveness = Math.min(90, params.aggressiveness + 5);
    params.confidenceThreshold = Math.max(20, params.confidenceThreshold - 2);
  }

  // If win rate is bad (<40%), be more conservative
  if (learningState.winRate < 40 && learningState.totalTrades >= 10) {
    params.aggressiveness = Math.max(30, params.aggressiveness - 5);
    params.confidenceThreshold = Math.min(50, params.confidenceThreshold + 2);
  }

  // Adjust strategy weights based on performance
  for (const strat of Object.keys(learningState.strategyStats) as TradingStrategy[]) {
    const stats = learningState.strategyStats[strat];
    if (stats.trades >= 5) {
      // Boost successful strategies, reduce unsuccessful ones
      if (stats.winRate > 60) {
        params.strategyWeights[strat] = Math.min(2.0, params.strategyWeights[strat] + 0.1);
      } else if (stats.winRate < 35) {
        params.strategyWeights[strat] = Math.max(0.3, params.strategyWeights[strat] - 0.1);
      }
    }
  }

  // Adjust profit target and stop loss based on actual outcomes
  if (learningState.avgWinPercent > 0 && learningState.avgLossPercent > 0) {
    // If average wins are small but consistent, tighten profit target
    if (learningState.avgWinPercent < 0.5 && learningState.winRate > 55) {
      params.profitTargetPercent = Math.max(0.2, learningState.avgWinPercent * 0.8);
    }

    // If average losses are large, tighten stop loss
    if (learningState.avgLossPercent > 1.5) {
      params.stopLossPercent = Math.max(0.5, params.stopLossPercent - 0.1);
    }
  }

  // Persist parameter snapshot every 10 trades
  if (learningState.totalTrades > 0 && learningState.totalTrades % 10 === 0) {
    persistParameters(`auto-adjust after ${learningState.totalTrades} trades`);
  }
}

/**
 * Request AI analysis of recent performance
 */
export async function requestAIAnalysis(): Promise<string> {
  const recentTrades = tradeMemory.slice(-20);

  if (recentTrades.length < 5) {
    return 'Need at least 5 trades for AI analysis';
  }

  const prompt = `You are an expert crypto trading analyst. Analyze these recent trades and provide specific, actionable recommendations.

TRADING PERFORMANCE:
- Total Trades: ${learningState.totalTrades}
- Win Rate: ${learningState.winRate.toFixed(1)}%
- Average Win: ${learningState.avgWinPercent.toFixed(2)}%
- Average Loss: ${learningState.avgLossPercent.toFixed(2)}%
- Profit Factor: ${learningState.profitFactor.toFixed(2)}

STRATEGY BREAKDOWN:
${Object.entries(learningState.strategyStats)
  .filter(([_, stats]) => stats.trades > 0)
  .map(([strat, stats]) => `- ${strat}: ${stats.trades} trades, ${stats.winRate.toFixed(1)}% win rate, $${stats.totalPnl.toFixed(2)} total`)
  .join('\n')}

RECENT 10 TRADES:
${recentTrades.slice(-10).map(t =>
  `${t.outcome} | ${t.strategy} | ${t.ticker} | ${t.pnlPercent.toFixed(2)}% | TC:${t.indicators.tcValue.toFixed(0)} | ${t.marketConditions.volatility} vol`
).join('\n')}

Based on this data, provide:
1. What patterns are working? What's failing?
2. Specific parameter changes (entry thresholds, stop loss, etc.)
3. Which strategies should be prioritized or avoided?
4. Risk management adjustments

Be specific with numbers. Format as JSON with keys: patterns, parameterChanges, strategyAdvice, riskAdvice`;

  const analysis = localAnalyze();
  learningState.lastAIAnalysis = analysis;
  learningState.lastAnalysisTime = Date.now();

  // Try to parse and apply AI recommendations
  try {
    applyAIRecommendations(analysis);
    persistParameters('ai-analysis recommendation');
  } catch (e) {
    console.log('Could not parse AI recommendations, using as text analysis');
  }

  return analysis;
}

/**
 * Apply AI recommendations to parameters
 */
function applyAIRecommendations(analysis: string): void {
  try {
    // Try to extract JSON from the response
    const jsonMatch = analysis.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const recommendations = JSON.parse(jsonMatch[0]);

      if (recommendations.parameterChanges) {
        const changes = recommendations.parameterChanges;
        const params = learningState.parameterAdjustments;

        if (changes.tcEntryThreshold) params.tcEntryThreshold = changes.tcEntryThreshold;
        if (changes.stopLossPercent) params.stopLossPercent = changes.stopLossPercent;
        if (changes.profitTargetPercent) params.profitTargetPercent = changes.profitTargetPercent;
        if (changes.confidenceThreshold) params.confidenceThreshold = changes.confidenceThreshold;
      }

      if (recommendations.strategyAdvice) {
        const advice = recommendations.strategyAdvice;
        if (advice.boost) {
          for (const strat of advice.boost) {
            if (learningState.parameterAdjustments.strategyWeights[strat as TradingStrategy]) {
              learningState.parameterAdjustments.strategyWeights[strat as TradingStrategy] *= 1.3;
            }
          }
        }
        if (advice.reduce) {
          for (const strat of advice.reduce) {
            if (learningState.parameterAdjustments.strategyWeights[strat as TradingStrategy]) {
              learningState.parameterAdjustments.strategyWeights[strat as TradingStrategy] *= 0.7;
            }
          }
        }
      }
    }
  } catch (e) {
    // Silently fail - text analysis is still valuable
  }
}

/**
 * Get current learning state
 */
export function getLearningState(): LearningState {
  return { ...learningState };
}

/**
 * Get adjusted parameters for trading
 */
export function getAdjustedParameters(): ParameterAdjustments {
  return { ...learningState.parameterAdjustments };
}

/**
 * Get trade memory
 */
export function getTradeMemory(): TradeMemory[] {
  return [...tradeMemory];
}

/**
 * Should we take this trade? AI-enhanced decision
 */
export function shouldTakeTrade(
  strategy: TradingStrategy,
  indicators: {
    tcValue: number;
    momentumValue: number;
    whaleValue: number;
    confluenceScore: number;
    confidence: number;
  },
  marketConditions: {
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    trend: 'UP' | 'DOWN' | 'SIDEWAYS';
  }
): { take: boolean; reason: string; adjustedConfidence: number } {
  const params = learningState.parameterAdjustments;

  // Apply strategy weight
  const strategyWeight = params.strategyWeights[strategy];
  const adjustedConfidence = indicators.confidence * strategyWeight;

  // Check if similar past trades were profitable
  const similarTrades = tradeMemory.filter(t =>
    t.strategy === strategy &&
    Math.abs(t.indicators.tcValue - indicators.tcValue) < 10 &&
    t.marketConditions.volatility === marketConditions.volatility
  );

  let patternBonus = 0;
  if (similarTrades.length >= 3) {
    const similarWinRate = similarTrades.filter(t => t.outcome === 'WIN').length / similarTrades.length;
    patternBonus = (similarWinRate - 0.5) * 20; // +/-10 based on historical performance
  }

  const finalConfidence = adjustedConfidence + patternBonus;

  // LOSS PROTECTION: Block trades after 3 consecutive losses (5 min cooldown)
  const recentTrades = tradeMemory.slice(-3);
  if (recentTrades.length === 3 && recentTrades.every(t => t.outcome === 'LOSS')) {
    const lastExit = recentTrades[2].exitTime;
    if (Date.now() - lastExit < 300000) {
      return {
        take: false,
        reason: `LOSS_PROTECTION: 3 consecutive losses, cooling down`,
        adjustedConfidence: 0
      };
    }
  }

  // AGGRESSIVE MODE: If we haven't traded in a while, allow trades with actual confidence
  const timeSinceLastTrade = tradeMemory.length > 0
    ? Date.now() - tradeMemory[tradeMemory.length - 1].exitTime
    : Infinity;

  // Allow trade after 10 minutes idle (was 2 minutes) - but don't boost confidence
  if (timeSinceLastTrade > 600000) {
    return {
      take: true,
      reason: `AGGRESSIVE: Taking trade after ${(timeSinceLastTrade / 60000).toFixed(1)}min idle. Confidence: ${finalConfidence.toFixed(0)}`,
      adjustedConfidence: finalConfidence  // No artificial confidence boost
    };
  }

  // High confidence bypasses all threshold checks
  if (finalConfidence >= 60) {
    return {
      take: true,
      reason: `HIGH_CONFIDENCE: ${finalConfidence.toFixed(0)} >= 60. Direct entry.`,
      adjustedConfidence: finalConfidence
    };
  }

  // Decision logic - confidence threshold check (minimum 40)
  const effectiveThreshold = Math.max(40, params.confidenceThreshold);
  if (finalConfidence < effectiveThreshold) {
    // Even below threshold, if no trades happened yet, allow it
    if (tradeMemory.length === 0 && finalConfidence > 10) {
      return {
        take: true,
        reason: `COLD_START: First trade, confidence ${finalConfidence.toFixed(0)} (threshold ${effectiveThreshold})`,
        adjustedConfidence: finalConfidence
      };
    }
    return {
      take: false,
      reason: `Confidence ${finalConfidence.toFixed(0)} below threshold ${effectiveThreshold}`,
      adjustedConfidence: finalConfidence
    };
  }

  // Check strategy-specific thresholds (more lenient)
  let meetsThreshold = false;
  let thresholdReason = '';

  switch (strategy) {
    case 'TREND':
      meetsThreshold = indicators.tcValue < params.tcEntryThreshold;
      thresholdReason = `TC ${indicators.tcValue.toFixed(0)} ${meetsThreshold ? '<' : '>='} ${params.tcEntryThreshold}`;
      break;
    case 'MOMENTUM':
      meetsThreshold = indicators.momentumValue > (50 + params.momentumEntryThreshold);
      thresholdReason = `Momentum ${indicators.momentumValue.toFixed(0)} ${meetsThreshold ? '>' : '<='} ${50 + params.momentumEntryThreshold}`;
      break;
    case 'WHALE':
      meetsThreshold = indicators.whaleValue > params.whaleEntryThreshold;
      thresholdReason = `Whale ${indicators.whaleValue.toFixed(0)} ${meetsThreshold ? '>' : '<='} ${params.whaleEntryThreshold}`;
      break;
    case 'CONFLUENCE':
      meetsThreshold = indicators.confluenceScore >= params.confluenceEntryThreshold;
      thresholdReason = `Confluence ${indicators.confluenceScore} ${meetsThreshold ? '>=' : '<'} ${params.confluenceEntryThreshold}`;
      break;
    default:
      meetsThreshold = true;
      thresholdReason = 'Default pass';
  }

  // Even if threshold not met, pass if confidence is reasonable
  if (!meetsThreshold && finalConfidence >= effectiveThreshold + 10) {
    meetsThreshold = true;
    thresholdReason += ' (overridden by high confidence)';
  }

  if (!meetsThreshold) {
    return {
      take: false,
      reason: thresholdReason,
      adjustedConfidence: finalConfidence
    };
  }

  return {
    take: true,
    reason: `LEARNED: ${thresholdReason}. Pattern success: ${similarTrades.length > 0 ? ((similarTrades.filter(t => t.outcome === 'WIN').length / similarTrades.length) * 100).toFixed(0) : 'N/A'}%`,
    adjustedConfidence: finalConfidence
  };
}

/**
 * Reset learning state (for new session)
 */
export function resetLearning(): void {
  tradeMemory = [];
  learningState = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgWinPercent: 0,
    avgLossPercent: 0,
    profitFactor: 0,
    bestStrategy: null,
    worstStrategy: null,
    strategyStats: {
      TREND: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      BREAKOUT: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      WHALE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      CONFLUENCE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      MOMENTUM: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      DIVERGENCE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      ADAPTIVE: { trades: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    },
    learnedPatterns: [],
    parameterAdjustments: { ...DEFAULT_PARAMETERS },
    lastAIAnalysis: null,
    lastAnalysisTime: 0,
  };
}

/**
 * Persist all current learning state to the database.
 * Call this on session end to ensure nothing is lost.
 */
export function persistCurrentState(): void {
  persistParameters('session-end');
  persistLearnedPatterns();
}

/**
 * Force aggressive mode - make trades happen!
 */
export function setAggressiveMode(level: number): void {
  const params = learningState.parameterAdjustments;

  // Level 1-100, higher = more aggressive
  params.aggressiveness = level;
  params.confidenceThreshold = Math.max(10, 40 - level * 0.4);  // Even lower threshold
  params.tcEntryThreshold = Math.min(55, 35 + level * 0.25);    // More lenient TC
  params.momentumEntryThreshold = Math.max(3, 15 - level * 0.15); // Lower momentum req
  params.whaleEntryThreshold = Math.max(45, 55 - level * 0.12);  // Lower whale req
  params.confluenceEntryThreshold = Math.max(2, 3 - Math.floor(level / 40)); // Lower confluence
}

// Initialize with very aggressive mode
setAggressiveMode(85);
