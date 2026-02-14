/**
 * Adaptive Thresholds Service - Phase 5: Machine Learning
 *
 * Replaces static trading constants with ML-learned optimal values that adapt over time.
 * Analyzes trade outcomes to dynamically adjust entry/exit thresholds, position sizing, and risk parameters.
 */

import { getSetting, setSetting } from './database.js';

const DEFAULTS = {
  // Entry thresholds
  entryConfidence: 40,           // minimum AI confidence to enter
  trendBullishEntry: 50,         // TC indicator threshold
  breakoutSqueezeEntry: 40,
  whaleBuyingEntry: 48,
  momentumBullishEntry: 50,
  adaptiveBullishEntry: 45,
  confluenceMinSignals: 2,

  // Exit thresholds
  profitTargetPercent: 0.75,     // take profit %
  stopLossPercent: 0.50,         // stop loss %
  trailingStopPercent: 0.30,     // trailing stop activation
  timeExitMinutes: 15,           // max hold time

  // Position sizing
  maxPositionPercent: 20,        // max % of capital per trade
  minPositionPercent: 5,         // min position size

  // Risk
  maxConsecutiveLosses: 6,       // circuit breaker trigger
  maxDailyDrawdownPercent: 15,   // daily loss limit
  cooldownMinutes: 3,            // pause after circuit breaker

  // ML specific
  mlConfidenceThreshold: 60,     // ML must be this confident to override
  anomalyPositionReduction: 0.5, // reduce position by 50% on anomaly
};

// State
let currentThresholds = { ...DEFAULTS };
let tradeHistory = [];  // last 500 trades for analysis
let adjustmentHistory = []; // track all adjustments made
let lastOptimized = null;
let initialized = false;

const DB_KEY = 'adaptive_thresholds';
const MAX_TRADE_HISTORY = 500;
const OPTIMIZATION_INTERVAL = 50; // optimize every N trades

/**
 * Initialize thresholds from database or defaults
 */
export async function initializeThresholds() {
  try {
    const saved = await getSetting(DB_KEY);

    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults in case new fields were added
      currentThresholds = { ...DEFAULTS, ...parsed.thresholds };
      lastOptimized = parsed.lastOptimized || null;
      adjustmentHistory = parsed.adjustmentHistory || [];
      console.log('[AdaptiveThresholds] Loaded from database:', Object.keys(currentThresholds).length, 'thresholds');
    } else {
      console.log('[AdaptiveThresholds] No saved thresholds, using defaults');
      currentThresholds = { ...DEFAULTS };
    }

    initialized = true;
    return currentThresholds;
  } catch (err) {
    console.error('[AdaptiveThresholds] Failed to initialize:', err);
    currentThresholds = { ...DEFAULTS };
    initialized = true;
    return currentThresholds;
  }
}

/**
 * Get a specific threshold value
 */
export function getThreshold(key) {
  if (!initialized) {
    console.warn('[AdaptiveThresholds] Not initialized, returning default for', key);
    return DEFAULTS[key];
  }
  return currentThresholds[key] !== undefined ? currentThresholds[key] : DEFAULTS[key];
}

/**
 * Get all current thresholds
 */
export function getAllThresholds() {
  return { ...currentThresholds };
}

/**
 * Get thresholds with comparison to defaults
 */
export function getThresholdsWithDefaults() {
  const changes = [];

  for (const key of Object.keys(DEFAULTS)) {
    const current = currentThresholds[key];
    const defaultVal = DEFAULTS[key];

    if (current !== defaultVal) {
      const changePercent = ((current - defaultVal) / defaultVal * 100).toFixed(1);
      changes.push({ key, current, default: defaultVal, changePercent });
    }
  }

  return {
    current: { ...currentThresholds },
    defaults: { ...DEFAULTS },
    changes
  };
}

/**
 * Record a trade for adaptation
 */
export function recordTradeForAdaptation(trade) {
  // Add to history
  tradeHistory.push({
    strategy: trade.strategy,
    outcome: trade.outcome, // 'WIN' | 'LOSS' | 'BREAKEVEN'
    pnl: trade.pnl,
    pnlPercent: trade.pnlPercent,
    holdDuration: trade.holdDuration, // in minutes
    entryConfidence: trade.entryConfidence,
    indicators: trade.indicators, // { tc, breakout, whale, etc }
    timestamp: Date.now()
  });

  // Keep only last N trades
  if (tradeHistory.length > MAX_TRADE_HISTORY) {
    tradeHistory = tradeHistory.slice(-MAX_TRADE_HISTORY);
  }

  // Check if time to optimize
  if (tradeHistory.length >= OPTIMIZATION_INTERVAL &&
      tradeHistory.length % OPTIMIZATION_INTERVAL === 0) {
    console.log('[AdaptiveThresholds] Optimization triggered after', tradeHistory.length, 'trades');
    optimizeThresholds();
  }
}

/**
 * Optimize thresholds based on trade history
 */
export function optimizeThresholds() {
  if (tradeHistory.length < 20) {
    console.log('[AdaptiveThresholds] Not enough trades for optimization (need 20, have', tradeHistory.length + ')');
    return;
  }

  console.log('[AdaptiveThresholds] Starting optimization with', tradeHistory.length, 'trades');
  const changes = [];

  // 1. Entry confidence optimization
  const confidenceChange = optimizeEntryConfidence();
  if (confidenceChange) changes.push(confidenceChange);

  // 2. Profit target optimization
  const profitChange = optimizeProfitTarget();
  if (profitChange) changes.push(profitChange);

  // 3. Stop loss optimization
  const stopLossChange = optimizeStopLoss();
  if (stopLossChange) changes.push(stopLossChange);

  // 4. Time exit optimization
  const timeExitChange = optimizeTimeExit();
  if (timeExitChange) changes.push(timeExitChange);

  // 5. Position size optimization
  const positionChange = optimizePositionSize();
  if (positionChange) changes.push(positionChange);

  // 6. Strategy-specific thresholds
  const strategyChanges = optimizeStrategyThresholds();
  changes.push(...strategyChanges);

  // Record adjustment
  if (changes.length > 0) {
    adjustmentHistory.push({
      timestamp: Date.now(),
      tradeCount: tradeHistory.length,
      changes
    });

    // Keep last 100 adjustments
    if (adjustmentHistory.length > 100) {
      adjustmentHistory = adjustmentHistory.slice(-100);
    }

    console.log('[AdaptiveThresholds] Applied', changes.length, 'changes:',
      changes.map(c => `${c.key}: ${c.from.toFixed(2)} -> ${c.to.toFixed(2)}`).join(', '));
  }

  lastOptimized = Date.now();
  saveThresholds();
}

/**
 * Optimize entry confidence threshold
 */
function optimizeEntryConfidence() {
  // Group trades by confidence buckets
  const buckets = {
    '0-20': [],
    '20-40': [],
    '40-60': [],
    '60-80': [],
    '80-100': []
  };

  for (const trade of tradeHistory) {
    const conf = trade.entryConfidence || 0;
    if (conf < 20) buckets['0-20'].push(trade);
    else if (conf < 40) buckets['20-40'].push(trade);
    else if (conf < 60) buckets['40-60'].push(trade);
    else if (conf < 80) buckets['60-80'].push(trade);
    else buckets['80-100'].push(trade);
  }

  // Find bucket where win rate crosses 50%
  let optimalConfidence = null;
  for (const [range, trades] of Object.entries(buckets)) {
    if (trades.length < 5) continue; // need at least 5 trades

    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const winRate = wins / trades.length;

    if (winRate >= 0.5) {
      // Use lower bound of this bucket
      const lower = parseInt(range.split('-')[0]);
      optimalConfidence = lower;
      break;
    }
  }

  if (optimalConfidence === null) {
    // No bucket has 50% win rate, use highest bucket with data
    for (const [range, trades] of Object.entries(buckets).reverse()) {
      if (trades.length >= 5) {
        optimalConfidence = parseInt(range.split('-')[0]);
        break;
      }
    }
  }

  if (optimalConfidence !== null) {
    // Apply constraints
    optimalConfidence = Math.max(25, Math.min(80, optimalConfidence));

    // Gradual adjustment (30% of difference)
    const oldValue = currentThresholds.entryConfidence;
    const diff = optimalConfidence - oldValue;
    const newValue = oldValue + (diff * 0.3);

    // Apply drift limit (50% from default)
    const maxDrift = DEFAULTS.entryConfidence * 0.5;
    const constrainedValue = Math.max(
      DEFAULTS.entryConfidence - maxDrift,
      Math.min(DEFAULTS.entryConfidence + maxDrift, newValue)
    );

    if (Math.abs(constrainedValue - oldValue) > 0.5) {
      currentThresholds.entryConfidence = Math.round(constrainedValue);
      return {
        key: 'entryConfidence',
        from: oldValue,
        to: currentThresholds.entryConfidence,
        reason: 'Win rate analysis'
      };
    }
  }

  return null;
}

/**
 * Optimize profit target
 */
function optimizeProfitTarget() {
  const winningTrades = tradeHistory.filter(t => t.outcome === 'WIN');

  if (winningTrades.length < 10) return null;

  // Get median winning PnL%
  const pnls = winningTrades.map(t => Math.abs(t.pnlPercent)).sort((a, b) => a - b);
  const median = pnls[Math.floor(pnls.length / 2)];

  // Apply constraints (must exceed fees, never below 0.3%)
  const optimalTarget = Math.max(0.30, median);

  // Gradual adjustment
  const oldValue = currentThresholds.profitTargetPercent;
  const diff = optimalTarget - oldValue;
  const newValue = oldValue + (diff * 0.3);

  // Apply drift limit
  const maxDrift = DEFAULTS.profitTargetPercent * 0.5;
  const constrainedValue = Math.max(
    DEFAULTS.profitTargetPercent - maxDrift,
    Math.min(DEFAULTS.profitTargetPercent + maxDrift, newValue)
  );

  if (Math.abs(constrainedValue - oldValue) > 0.01) {
    currentThresholds.profitTargetPercent = Math.round(constrainedValue * 100) / 100;
    return {
      key: 'profitTargetPercent',
      from: oldValue,
      to: currentThresholds.profitTargetPercent,
      reason: 'Median winning trade PnL'
    };
  }

  return null;
}

/**
 * Optimize stop loss
 */
function optimizeStopLoss() {
  const losingTrades = tradeHistory.filter(t => t.outcome === 'LOSS');

  if (losingTrades.length < 10) return null;

  // Get 75th percentile of loss magnitude
  const losses = losingTrades.map(t => Math.abs(t.pnlPercent)).sort((a, b) => a - b);
  const p75Index = Math.floor(losses.length * 0.75);
  const p75 = losses[p75Index];

  // Apply constraints (never below 0.20% or above 2.0%)
  const optimalStopLoss = Math.max(0.20, Math.min(2.0, p75));

  // Gradual adjustment
  const oldValue = currentThresholds.stopLossPercent;
  const diff = optimalStopLoss - oldValue;
  const newValue = oldValue + (diff * 0.3);

  // Apply drift limit
  const maxDrift = DEFAULTS.stopLossPercent * 0.5;
  const constrainedValue = Math.max(
    DEFAULTS.stopLossPercent - maxDrift,
    Math.min(DEFAULTS.stopLossPercent + maxDrift, newValue)
  );

  if (Math.abs(constrainedValue - oldValue) > 0.01) {
    currentThresholds.stopLossPercent = Math.round(constrainedValue * 100) / 100;
    return {
      key: 'stopLossPercent',
      from: oldValue,
      to: currentThresholds.stopLossPercent,
      reason: '75th percentile of losses'
    };
  }

  return null;
}

/**
 * Optimize time exit
 */
function optimizeTimeExit() {
  if (tradeHistory.length < 20) return null;

  // Group trades by hold duration
  const durationBuckets = {};
  for (let i = 5; i <= 30; i += 5) {
    durationBuckets[i] = [];
  }

  for (const trade of tradeHistory) {
    const duration = trade.holdDuration || 0;
    for (let threshold = 5; threshold <= 30; threshold += 5) {
      if (duration <= threshold) {
        durationBuckets[threshold].push(trade);
        break;
      }
    }
  }

  // Find duration where win rate starts declining
  let optimalDuration = 15; // default
  let bestWinRate = 0;

  for (const [duration, trades] of Object.entries(durationBuckets)) {
    if (trades.length < 5) continue;

    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const winRate = wins / trades.length;

    if (winRate > bestWinRate) {
      bestWinRate = winRate;
      optimalDuration = parseInt(duration);
    }
  }

  // Gradual adjustment
  const oldValue = currentThresholds.timeExitMinutes;
  const diff = optimalDuration - oldValue;
  const newValue = oldValue + (diff * 0.3);

  // Apply drift limit
  const maxDrift = DEFAULTS.timeExitMinutes * 0.5;
  const constrainedValue = Math.max(
    DEFAULTS.timeExitMinutes - maxDrift,
    Math.min(DEFAULTS.timeExitMinutes + maxDrift, newValue)
  );

  if (Math.abs(constrainedValue - oldValue) > 0.5) {
    currentThresholds.timeExitMinutes = Math.round(constrainedValue);
    return {
      key: 'timeExitMinutes',
      from: oldValue,
      to: currentThresholds.timeExitMinutes,
      reason: 'Optimal win rate duration'
    };
  }

  return null;
}

/**
 * Optimize position sizing
 */
function optimizePositionSize() {
  if (tradeHistory.length < 20) return null;

  // Calculate recent win rate (last 50 trades)
  const recentTrades = tradeHistory.slice(-50);
  const wins = recentTrades.filter(t => t.outcome === 'WIN').length;
  const winRate = wins / recentTrades.length;

  // Adjust max position based on win rate
  let optimalMaxPosition;
  if (winRate > 0.6) {
    optimalMaxPosition = 25; // allow larger positions when winning
  } else if (winRate < 0.4) {
    optimalMaxPosition = 10; // reduce when losing
  } else {
    optimalMaxPosition = 15 + (winRate - 0.4) * 50; // linear scale between 40-60%
  }

  // Gradual adjustment
  const oldValue = currentThresholds.maxPositionPercent;
  const diff = optimalMaxPosition - oldValue;
  const newValue = oldValue + (diff * 0.3);

  // Apply drift limit
  const maxDrift = DEFAULTS.maxPositionPercent * 0.5;
  const constrainedValue = Math.max(
    DEFAULTS.maxPositionPercent - maxDrift,
    Math.min(DEFAULTS.maxPositionPercent + maxDrift, newValue)
  );

  if (Math.abs(constrainedValue - oldValue) > 0.5) {
    currentThresholds.maxPositionPercent = Math.round(constrainedValue);
    return {
      key: 'maxPositionPercent',
      from: oldValue,
      to: currentThresholds.maxPositionPercent,
      reason: `Win rate: ${(winRate * 100).toFixed(1)}%`
    };
  }

  return null;
}

/**
 * Optimize strategy-specific thresholds
 */
function optimizeStrategyThresholds() {
  const changes = [];

  // Group trades by strategy
  const byStrategy = {};
  for (const trade of tradeHistory) {
    if (!byStrategy[trade.strategy]) {
      byStrategy[trade.strategy] = [];
    }
    byStrategy[trade.strategy].push(trade);
  }

  // Strategy threshold mappings
  const strategyThresholds = {
    'TREND': 'trendBullishEntry',
    'BREAKOUT': 'breakoutSqueezeEntry',
    'WHALE': 'whaleBuyingEntry',
    'MOMENTUM': 'momentumBullishEntry',
    'ADAPTIVE': 'adaptiveBullishEntry'
  };

  for (const [strategy, thresholdKey] of Object.entries(strategyThresholds)) {
    const trades = byStrategy[strategy];
    if (!trades || trades.length < 10) continue;

    // Calculate win rate
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const winRate = wins / trades.length;

    // Adjust threshold based on performance
    const oldValue = currentThresholds[thresholdKey];
    let adjustment;

    if (winRate > 0.6) {
      // Strategy is winning, relax threshold (easier entry)
      adjustment = -5;
    } else if (winRate < 0.4) {
      // Strategy is losing, tighten threshold (harder entry)
      adjustment = +5;
    } else {
      continue; // no change needed
    }

    // Gradual adjustment
    const newValue = oldValue + (adjustment * 0.3);

    // Apply drift limit
    const defaultValue = DEFAULTS[thresholdKey];
    const maxDrift = defaultValue * 0.5;
    const constrainedValue = Math.max(
      defaultValue - maxDrift,
      Math.min(defaultValue + maxDrift, newValue)
    );

    if (Math.abs(constrainedValue - oldValue) > 0.5) {
      currentThresholds[thresholdKey] = Math.round(constrainedValue);
      changes.push({
        key: thresholdKey,
        from: oldValue,
        to: currentThresholds[thresholdKey],
        reason: `${strategy} win rate: ${(winRate * 100).toFixed(1)}%`
      });
    }
  }

  return changes;
}

/**
 * Save thresholds to database
 */
async function saveThresholds() {
  try {
    const data = JSON.stringify({
      thresholds: currentThresholds,
      lastOptimized,
      adjustmentHistory
    });

    await setSetting(DB_KEY, data);
    console.log('[AdaptiveThresholds] Saved to database');
  } catch (err) {
    console.error('[AdaptiveThresholds] Failed to save:', err);
  }
}

/**
 * Reset all thresholds to defaults
 */
export async function resetToDefaults() {
  currentThresholds = { ...DEFAULTS };
  tradeHistory = [];
  adjustmentHistory = [];
  lastOptimized = null;

  await saveThresholds();
  console.log('[AdaptiveThresholds] Reset to defaults');

  return currentThresholds;
}

/**
 * Get optimization report
 */
export function getOptimizationReport() {
  const recentTrades = tradeHistory.slice(-50);
  const wins = recentTrades.filter(t => t.outcome === 'WIN').length;
  const recentWinRate = recentTrades.length > 0 ? wins / recentTrades.length : 0;

  const tradesSinceLastOptimization = lastOptimized
    ? tradeHistory.filter(t => t.timestamp > lastOptimized).length
    : tradeHistory.length;

  // Get recent changes
  const recentChanges = adjustmentHistory.length > 0
    ? adjustmentHistory[adjustmentHistory.length - 1].changes
    : [];

  return {
    currentThresholds: { ...currentThresholds },
    defaults: { ...DEFAULTS },
    adjustmentCount: adjustmentHistory.length,
    lastOptimized,
    tradesSinceLastOptimization,
    recentWinRate: Math.round(recentWinRate * 100),
    changes: recentChanges,
    totalTrades: tradeHistory.length
  };
}

/**
 * Get service status
 */
export function getStatus() {
  return {
    initialized,
    tradeCount: tradeHistory.length,
    adjustmentCount: adjustmentHistory.length,
    lastOptimized,
    nextOptimization: OPTIMIZATION_INTERVAL - (tradeHistory.length % OPTIMIZATION_INTERVAL)
  };
}

// Export defaults for reference
export { DEFAULTS };
