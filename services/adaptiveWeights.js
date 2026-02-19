/**
 * Adaptive Strategy Weights Service
 *
 * Tracks per-strategy performance and dynamically adjusts allocations.
 * Winning strategies get more capital, losing strategies get throttled.
 *
 * Uses exponential decay so recent performance matters more than old.
 */

// ============================================
// STATE
// ============================================

const STRATEGIES = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE',
                     'SWING', 'DCA', 'GRID', 'ARB', 'PAIR_LONG', 'MM'];

const BASE_WEIGHT = 1.0 / STRATEGIES.length; // Equal starting weight

// Per-strategy tracking
const strategyStats = new Map();

function getOrCreateStats(strategy) {
  if (!strategyStats.has(strategy)) {
    strategyStats.set(strategy, {
      strategy,
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      recentPnls: [],        // Last 50 PnLs for recency weighting
      weight: BASE_WEIGHT,
      emaWinRate: 0.5,        // EMA of win rate (0-1)
      emaPnl: 0,              // EMA of per-trade PnL
      lastUpdate: Date.now(),
    });
  }
  return strategyStats.get(strategy);
}

// Initialize all strategies
for (const s of STRATEGIES) getOrCreateStats(s);

// ============================================
// RECORDING
// ============================================

const EMA_ALPHA = 0.1; // Smoothing factor (higher = more recent weight)

/**
 * Record a trade result for a strategy
 */
export function recordStrategyResult(strategy, pnl) {
  const stats = getOrCreateStats(strategy);
  stats.trades++;
  stats.totalPnl += pnl;

  if (pnl > 0) stats.wins++;
  else if (pnl < 0) stats.losses++;

  // Track recent PnLs
  stats.recentPnls.push(pnl);
  if (stats.recentPnls.length > 50) stats.recentPnls.shift();

  // Update EMA metrics
  const winResult = pnl > 0 ? 1 : 0;
  stats.emaWinRate = stats.emaWinRate * (1 - EMA_ALPHA) + winResult * EMA_ALPHA;
  stats.emaPnl = stats.emaPnl * (1 - EMA_ALPHA) + pnl * EMA_ALPHA;
  stats.lastUpdate = Date.now();

  // Recalculate all weights
  recalculateWeights();
}

// ============================================
// WEIGHT CALCULATION
// ============================================

function recalculateWeights() {
  const allStats = [...strategyStats.values()];

  // Calculate score for each strategy
  const scores = [];
  for (const stats of allStats) {
    if (stats.trades < 3) {
      // Not enough data - use neutral score
      scores.push({ strategy: stats.strategy, score: 1.0 });
      continue;
    }

    // Score components:
    // 1. EMA win rate (0-1) weighted at 40%
    // 2. Normalized EMA PnL weighted at 40%
    // 3. Recent streak bonus/penalty 20%
    const winRateScore = stats.emaWinRate;

    // Normalize PnL relative to other strategies
    const allPnls = allStats.filter(s => s.trades >= 3).map(s => s.emaPnl);
    const maxPnl = Math.max(...allPnls, 0.001);
    const minPnl = Math.min(...allPnls, -0.001);
    const pnlRange = maxPnl - minPnl || 1;
    const pnlScore = (stats.emaPnl - minPnl) / pnlRange;

    // Recent streak: last 5 trades
    const recent5 = stats.recentPnls.slice(-5);
    const recentWins = recent5.filter(p => p > 0).length;
    const streakScore = recent5.length > 0 ? recentWins / recent5.length : 0.5;

    const score = winRateScore * 0.4 + pnlScore * 0.4 + streakScore * 0.2;
    scores.push({ strategy: stats.strategy, score: Math.max(0.05, score) }); // Floor at 5%
  }

  // Normalize scores to weights that sum to 1.0
  const totalScore = scores.reduce((s, item) => s + item.score, 0);
  for (const item of scores) {
    const stats = strategyStats.get(item.strategy);
    if (stats) {
      // Beast Mode: 50/50 blend (was 70/30) - more equal opportunity
      const adaptiveWeight = item.score / totalScore;
      stats.weight = adaptiveWeight * 0.5 + BASE_WEIGHT * 0.5;
    }
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Get the adaptive weight for a strategy (0 to 1)
 * Higher weight = allocate more capital
 */
export function getStrategyWeight(strategy) {
  const stats = strategyStats.get(strategy);
  return stats ? stats.weight : BASE_WEIGHT;
}

/**
 * Get all strategy weights as an object
 */
export function getAllWeights() {
  const weights = {};
  for (const [key, stats] of strategyStats) {
    weights[key] = {
      weight: parseFloat(stats.weight.toFixed(4)),
      trades: stats.trades,
      winRate: stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) + '%' : 'N/A',
      emaWinRate: (stats.emaWinRate * 100).toFixed(1) + '%',
      totalPnl: stats.totalPnl.toFixed(4),
      emaPnl: stats.emaPnl.toFixed(6),
    };
  }
  return weights;
}

/**
 * Apply adaptive weight to a position size
 * Returns adjusted investment amount
 */
export function adjustPositionSize(strategy, baseAmount, portfolioValue) {
  const weight = getStrategyWeight(strategy);
  const normalizedWeight = weight / BASE_WEIGHT; // 1.0 = normal, >1 = boost, <1 = reduce

  // Clamp between 0.3x and 2.5x of base amount
  const multiplier = Math.max(0.3, Math.min(2.5, normalizedWeight));
  const adjusted = baseAmount * multiplier;

  // Never exceed 25% of portfolio on a single trade
  return Math.min(adjusted, portfolioValue * 0.25);
}

/**
 * Get strategy ranking (best to worst)
 */
export function getStrategyRanking() {
  return [...strategyStats.values()]
    .filter(s => s.trades >= 3)
    .sort((a, b) => b.weight - a.weight)
    .map((s, i) => ({
      rank: i + 1,
      strategy: s.strategy,
      weight: (s.weight * 100).toFixed(1) + '%',
      trades: s.trades,
      winRate: s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) + '%' : 'N/A',
      pnl: s.totalPnl.toFixed(4),
    }));
}

/**
 * Should a strategy be throttled? (weight too low)
 */
export function isStrategyThrottled(strategy) {
  const stats = strategyStats.get(strategy);
  if (!stats || stats.trades < 15) return false;  // Beast Mode: was 5
  // Beast Mode: Throttle if weight is less than 15% of average (was 30%)
  return stats.weight < BASE_WEIGHT * 0.15;
}

// ============================================
// STATE EXPORT / IMPORT (for session persistence)
// ============================================

export function exportState() {
  const data = {};
  for (const [key, stats] of strategyStats) {
    data[key] = {
      strategy: stats.strategy,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      totalPnl: stats.totalPnl,
      recentPnls: stats.recentPnls.slice(-50),
      weight: stats.weight,
      emaWinRate: stats.emaWinRate,
      emaPnl: stats.emaPnl,
      lastUpdate: stats.lastUpdate,
    };
  }
  return data;
}

export function importState(state) {
  if (!state) return;
  for (const [key, saved] of Object.entries(state)) {
    const stats = getOrCreateStats(key);
    stats.trades = saved.trades || 0;
    stats.wins = saved.wins || 0;
    stats.losses = saved.losses || 0;
    stats.totalPnl = saved.totalPnl || 0;
    stats.recentPnls = Array.isArray(saved.recentPnls) ? saved.recentPnls : [];
    stats.weight = saved.weight || BASE_WEIGHT;
    stats.emaWinRate = saved.emaWinRate || 0.5;
    stats.emaPnl = saved.emaPnl || 0;
    stats.lastUpdate = saved.lastUpdate || Date.now();
  }
}

/**
 * Full reset: clear all strategy stats to equal weights.
 * Called on new session start.
 */
export function fullResetWeights() {
  for (const s of STRATEGIES) {
    strategyStats.set(s, {
      strategy: s,
      trades: 0, wins: 0, losses: 0, totalPnl: 0,
      recentPnls: [], weight: BASE_WEIGHT,
      emaWinRate: 0.5, emaPnl: 0, lastUpdate: Date.now(),
    });
  }
}

/**
 * Get full status for the API endpoint
 */
export function getAdaptiveWeightsStatus() {
  return {
    weights: getAllWeights(),
    ranking: getStrategyRanking(),
    baseWeight: BASE_WEIGHT.toFixed(4),
    totalStrategies: strategyStats.size,
    activeStrategies: [...strategyStats.values()].filter(s => s.trades > 0).length,
  };
}
