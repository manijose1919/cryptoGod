/**
 * Circuit Breaker + Kelly Position Sizing Service
 *
 * Auto-pauses trading after:
 *   - 4 consecutive losses
 *   - 8% daily drawdown
 *   - 8 losses in 1 hour
 *
 * Kelly Criterion:
 *   Calculates optimal position size from historical win rate & avg win/loss.
 *   Uses Half-Kelly for safety (full Kelly is too aggressive).
 */

// ============================================
// STATE
// ============================================

const tradeHistory = [];      // { time, pnl, strategy, ticker }
let consecutiveLosses = 0;
let consecutiveWins = 0;
let dailyPnl = 0;
let dailyStartBalance = 0;
let dailyDate = new Date().toDateString();
let pausedUntil = 0;
let pauseReason = '';

const CIRCUIT_BREAKER_CONFIG = {
  MAX_CONSECUTIVE_LOSSES: 3,            // Tighter: 3 consecutive losses triggers pause
  MAX_DAILY_DRAWDOWN_PERCENT: 8,        // Was 15%: protect capital more aggressively
  MAX_HOURLY_LOSSES: 8,                 // Was 20: 8 losses/hour is already excessive
  PAUSE_DURATION_MS: 10 * 60 * 1000,    // Was 5min: longer cooldown to prevent overtrading
  ESCALATING_PAUSE: true,               // Repeated trips = longer cooldowns
};

let pauseCount = 0;  // For escalating pauses
let peakBalance = 0;  // Track peak balance for drawdown-adaptive Kelly
let currentBalance = 0;  // Current portfolio value
let currentRegime = 'SIDEWAYS'; // Updated by setCurrentRegime(), used for adaptive thresholds

// Regime-aware consecutive loss thresholds: bearish markets get tighter limits
const REGIME_LOSS_THRESHOLDS = {
  STRONG_UP: 4,   // Bull market: more forgiving (4 losses)
  UP: 3,          // Normal: default threshold
  SIDEWAYS: 3,    // Choppy: default threshold
  DOWN: 2,        // Bear: tighter (2 losses triggers pause)
  STRONG_DOWN: 2, // Deep bear: tightest
};

// ============================================
// CIRCUIT BREAKER
// ============================================

/**
 * Record a completed trade result
 */
export function recordTradeResult(pnl, strategy = 'UNKNOWN', ticker = '') {
  const now = Date.now();

  // Reset daily tracking if new day
  const today = new Date().toDateString();
  if (today !== dailyDate) {
    dailyPnl = 0;
    dailyDate = today;
    pauseCount = 0; // Reset escalation on new day
  }

  tradeHistory.push({ time: now, pnl, strategy, ticker });
  dailyPnl += pnl;

  // Keep last 500 trades - use efficient in-place splice
  if (tradeHistory.length > 600) {
    tradeHistory.splice(0, tradeHistory.length - 500);
  }

  if (pnl < 0) {
    consecutiveLosses++;
    consecutiveWins = 0;
  } else if (pnl > 0) {
    consecutiveWins++;
    consecutiveLosses = 0;
  }

  // Check circuit breaker triggers
  checkTriggers();
}

/**
 * Set the daily start balance (call on bot start or login)
 */
export function setDailyBalance(balance) {
  dailyStartBalance = balance;
}

function checkTriggers() {
  // Trigger 1: Consecutive losses (regime-aware threshold)
  const regimeThreshold = REGIME_LOSS_THRESHOLDS[currentRegime] ?? CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_LOSSES;
  if (consecutiveLosses >= regimeThreshold) {
    triggerPause(`${consecutiveLosses} consecutive losses (${currentRegime} regime, threshold=${regimeThreshold})`);
    return;
  }

  // Trigger 2: Daily drawdown
  if (dailyStartBalance > 0) {
    const drawdownPercent = (-dailyPnl / dailyStartBalance) * 100;
    if (drawdownPercent >= CIRCUIT_BREAKER_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT) {
      triggerPause(`Daily drawdown ${drawdownPercent.toFixed(1)}% exceeds ${CIRCUIT_BREAKER_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT}%`);
      return;
    }
  }

  // Trigger 3: Hourly loss rate
  const oneHourAgo = Date.now() - 3600000;
  const hourlyLosses = tradeHistory.filter(t => t.time > oneHourAgo && t.pnl < 0).length;
  if (hourlyLosses >= CIRCUIT_BREAKER_CONFIG.MAX_HOURLY_LOSSES) {
    triggerPause(`${hourlyLosses} losses in last hour`);
    return;
  }

  // Trigger 4: PREDICTIVE — trajectory-based pause
  // If the loss rate over last 30 min extrapolates to breaching daily limit within 1 hour, pause early
  if (dailyStartBalance > 0) {
    const thirtyMinAgo = Date.now() - 1800000;
    const recentTrades = tradeHistory.filter(t => t.time > thirtyMinAgo);
    if (recentTrades.length >= 3) { // Need at least 3 trades for trajectory
      const recentPnl = recentTrades.reduce((s, t) => s + t.pnl, 0);
      const recentLosses = recentTrades.filter(t => t.pnl < 0).length;
      const lossRate = recentLosses / recentTrades.length;

      // Extrapolate: if losing at >60% rate AND projected 1h PnL would breach 80% of daily limit
      if (lossRate > 0.6 && recentPnl < 0) {
        const projectedHourlyLoss = recentPnl * 2; // extrapolate 30min → 60min
        const projectedDrawdown = (-(dailyPnl + projectedHourlyLoss) / dailyStartBalance) * 100;
        const limit = CIRCUIT_BREAKER_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT;

        if (projectedDrawdown >= limit * 0.8) {
          triggerPause(
            `PREDICTIVE: ${lossRate * 100 | 0}% loss rate, projected ${projectedDrawdown.toFixed(1)}% drawdown in 1h (limit: ${limit}%)`
          );
        }
      }
    }
  }
}

function triggerPause(reason) {
  pauseCount++;
  const duration = CIRCUIT_BREAKER_CONFIG.ESCALATING_PAUSE
    ? CIRCUIT_BREAKER_CONFIG.PAUSE_DURATION_MS * pauseCount
    : CIRCUIT_BREAKER_CONFIG.PAUSE_DURATION_MS;

  pausedUntil = Date.now() + duration;
  pauseReason = reason;
  consecutiveLosses = 0; // Reset so it doesn't re-trigger immediately

  const minutes = Math.round(duration / 60000);
  console.log(`[CIRCUIT BREAKER] Trading paused for ${minutes}min. Reason: ${reason}`);
}

/**
 * Check if trading should be paused
 */
export function shouldPauseTrading(tradingMode = 'REAL') {
  // In simulation mode, apply a short 5-minute cooldown (vs full 60min+ in real mode)
  // Prevents bleeding through entire losing streaks while still generating varied training data
  if (tradingMode === 'SIMULATION') {
    if (Date.now() < pausedUntil) {
      const SIM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
      const pauseStartedAt = pausedUntil - (CIRCUIT_BREAKER_CONFIG.PAUSE_DURATION_MS * pauseCount || 3600000);
      const simPauseEnd = pauseStartedAt + SIM_COOLDOWN_MS;
      if (Date.now() < simPauseEnd) {
        const remaining = Math.ceil((simPauseEnd - Date.now()) / 60000);
        return { paused: true, reason: `SIM cooldown: ${pauseReason}`, remainingMinutes: remaining, simBypassed: false };
      }
    }
    return { paused: false, reason: '', remainingMinutes: 0, simBypassed: true };
  }
  if (Date.now() < pausedUntil) {
    const remaining = Math.ceil((pausedUntil - Date.now()) / 60000);
    return {
      paused: true,
      reason: pauseReason,
      remainingMinutes: remaining,
    };
  }
  return { paused: false, reason: '', remainingMinutes: 0 };
}

/**
 * Manually reset the circuit breaker (pause state only, preserves history)
 */
export function resetCircuitBreaker() {
  pausedUntil = 0;
  pauseReason = '';
  consecutiveLosses = 0;
  pauseCount = 0;
}

/**
 * Full reset: clear ALL state including trade history.
 * Called on new session start so Kelly/streaks aren't poisoned by old (buggy) data.
 */
export function fullResetCircuitBreaker() {
  pausedUntil = 0;
  pauseReason = '';
  consecutiveLosses = 0;
  consecutiveWins = 0;
  pauseCount = 0;
  dailyPnl = 0;
  dailyStartBalance = 0;
  dailyDate = new Date().toDateString();
  tradeHistory.length = 0;  // Clear all old trade history
}

// ============================================
// KELLY CRITERION POSITION SIZING
// ============================================

/**
 * Set current balance for drawdown-adaptive Kelly tracking
 */
export function setCurrentBalance(balance) {
  currentBalance = balance;
  if (balance > peakBalance) {
    peakBalance = balance;
  }
}

/**
 * Update the current market regime for adaptive circuit breaker thresholds.
 * @param {string} regime - STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN
 */
export function setCurrentRegime(regime) {
  if (REGIME_LOSS_THRESHOLDS[regime] !== undefined) {
    currentRegime = regime;
  }
}

/**
 * Calculate Kelly fraction from trade history
 * Uses rolling 50-trade window + drawdown-adaptive fraction
 * Returns recommended position size as fraction of portfolio (0 to 1)
 */
export function calculateKellyFraction(minTrades = 50) {
  // Fix #21 (Tier 3): Raised minimum from 20→50 trades for reliable Kelly estimates
  const completedTrades = tradeHistory.filter(t => t.pnl !== 0);

  // Use rolling 100-trade window for more stable Kelly (was 50)
  const recentTrades = completedTrades.slice(-100);

  if (recentTrades.length < minTrades) {
    return {
      kellyFull: 0.1,       // Default conservative 10%
      kellyHalf: 0.05,
      kellyQuarter: 0.025,
      recommended: 0.05,    // Use half-Kelly by default
      confidence: 'LOW',
      stats: { trades: recentTrades.length, minRequired: minTrades },
    };
  }

  const wins = recentTrades.filter(t => t.pnl > 0);
  const losses = recentTrades.filter(t => t.pnl < 0);

  const winRate = wins.length / recentTrades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;

  // Kelly formula: f* = (bp - q) / b
  // where b = avgWin/avgLoss, p = winRate, q = 1 - winRate
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kellyFull = Math.max(0, (b * winRate - (1 - winRate)) / b);
  const kellyHalf = kellyFull / 2;
  const kellyQuarter = kellyFull / 4;

  // Drawdown-adaptive Kelly fraction
  let kellyMultiplier = 0.5;  // Default: half-Kelly
  let drawdownPct = 0;
  if (peakBalance > 0 && currentBalance > 0) {
    drawdownPct = (peakBalance - currentBalance) / peakBalance;
    if (drawdownPct > 0.05) {
      kellyMultiplier = 0.25;  // Quarter-Kelly during >5% drawdown
    } else if (drawdownPct > 0.03) {
      kellyMultiplier = 0.33;  // Third-Kelly during >3% drawdown
    }
  }

  // Fix #21 (Tier 3): Raised confidence thresholds
  let confidence = 'LOW';
  if (recentTrades.length >= 100) confidence = 'HIGH';
  else if (recentTrades.length >= 50) confidence = 'MEDIUM';

  // Cap at 40% max position size, apply drawdown-adaptive multiplier
  const recommended = Math.min(0.40, kellyFull * kellyMultiplier);

  return {
    kellyFull: Math.min(1, kellyFull),
    kellyHalf: Math.min(0.5, kellyHalf),
    kellyQuarter: Math.min(0.25, kellyQuarter),
    recommended,
    confidence,
    drawdownPct: (drawdownPct * 100).toFixed(2),
    kellyMultiplier,
    stats: {
      trades: recentTrades.length,
      totalTrades: completedTrades.length,
      winRate: (winRate * 100).toFixed(1) + '%',
      avgWin: avgWin.toFixed(4),
      avgLoss: avgLoss.toFixed(4),
      profitFactor: avgLoss > 0 ? (avgWin * wins.length / (avgLoss * (losses.length || 1))).toFixed(2) : 'N/A',
      expectancy: ((winRate * avgWin) - ((1 - winRate) * avgLoss)).toFixed(4),
    },
  };
}

/**
 * Get recommended position size in dollars
 */
export function getKellyPositionSize(portfolioValue) {
  const kelly = calculateKellyFraction();
  return {
    amount: portfolioValue * kelly.recommended,
    fraction: kelly.recommended,
    kelly,
  };
}

/**
 * Fix #28 (Tier 3): Per-strategy Kelly with exponential decay weighting
 * Recent trades matter more than old ones. Different strategies have different
 * R:R profiles so a single global Kelly is suboptimal.
 */
export function getStrategyKelly(strategy, portfolioValue) {
  const stratTrades = tradeHistory.filter(t => t.strategy === strategy && t.pnl !== 0);
  // Raised minimum from 10→30 for more reliable per-strategy estimates
  if (stratTrades.length < 30) {
    return { amount: portfolioValue * 0.05, fraction: 0.05, confidence: 'LOW', trades: stratTrades.length };
  }

  // Use last 80 trades for the strategy
  const recentTrades = stratTrades.slice(-80);

  // Exponential decay weighting: recent trades get higher weight
  // decay factor 0.97 means trade from 30 ago has ~40% weight of latest
  const decayFactor = 0.97;
  let weightedWins = 0;
  let weightedLosses = 0;
  let weightedWinPnl = 0;
  let weightedLossPnl = 0;
  let totalWeight = 0;

  for (let i = 0; i < recentTrades.length; i++) {
    const weight = Math.pow(decayFactor, recentTrades.length - 1 - i);
    totalWeight += weight;
    if (recentTrades[i].pnl > 0) {
      weightedWins += weight;
      weightedWinPnl += recentTrades[i].pnl * weight;
    } else {
      weightedLosses += weight;
      weightedLossPnl += Math.abs(recentTrades[i].pnl) * weight;
    }
  }

  const winRate = totalWeight > 0 ? weightedWins / totalWeight : 0.5;
  const avgWin = weightedWins > 0 ? weightedWinPnl / weightedWins : 0;
  const avgLoss = weightedLosses > 0 ? weightedLossPnl / weightedLosses : 1;

  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kellyFull = Math.max(0, (b * winRate - (1 - winRate)) / b);
  // Use half-Kelly for safety (full Kelly is too aggressive)
  const kellyHalf = kellyFull / 2;
  const recommended = Math.min(0.25, kellyHalf);

  let confidence = 'LOW';
  if (recentTrades.length >= 60) confidence = 'HIGH';
  else if (recentTrades.length >= 30) confidence = 'MEDIUM';

  return {
    amount: portfolioValue * recommended,
    fraction: recommended,
    confidence,
    trades: recentTrades.length,
    winRate: (winRate * 100).toFixed(1) + '%',
    payoffRatio: b.toFixed(2),
  };
}

// ============================================
// STATUS
// ============================================

// ============================================
// STATE EXPORT / IMPORT (for session persistence)
// ============================================

export function exportState() {
  return {
    tradeHistory: tradeHistory.slice(-500),
    consecutiveLosses,
    consecutiveWins,
    dailyPnl,
    dailyStartBalance,
    dailyDate,
    pausedUntil,
    pauseReason,
    pauseCount,
  };
}

export function importState(state) {
  if (!state) return;
  tradeHistory.length = 0;
  if (Array.isArray(state.tradeHistory)) {
    tradeHistory.push(...state.tradeHistory);
  }
  consecutiveLosses = state.consecutiveLosses || 0;
  consecutiveWins = state.consecutiveWins || 0;
  dailyPnl = state.dailyPnl || 0;
  dailyStartBalance = state.dailyStartBalance || 0;
  dailyDate = state.dailyDate || new Date().toDateString();
  pausedUntil = state.pausedUntil || 0;
  pauseReason = state.pauseReason || '';
  pauseCount = state.pauseCount || 0;
}

/**
 * Check if portfolio has excessive correlation risk
 * @param {Array} openPositions - Array of { ticker, strategy, amount }
 * @param {number} maxSingleTickerPercent - Max % of portfolio in one ticker (default 25%)
 * @returns {{ safe: boolean, reason: string, tickerExposure: Object }}
 */
export function checkCorrelationRisk(openPositions = [], maxSingleTickerPercent = 25) {
  const totalAmount = openPositions.reduce((s, p) => s + (p.amount || 0), 0);
  if (totalAmount <= 0) return { safe: true, reason: '', tickerExposure: {} };

  const tickerExposure = {};
  for (const pos of openPositions) {
    const ticker = pos.ticker || 'UNKNOWN';
    tickerExposure[ticker] = (tickerExposure[ticker] || 0) + (pos.amount || 0);
  }

  for (const [ticker, amount] of Object.entries(tickerExposure)) {
    const pct = (amount / totalAmount) * 100;
    if (pct > maxSingleTickerPercent) {
      return {
        safe: false,
        reason: `${ticker} exposure ${pct.toFixed(1)}% exceeds ${maxSingleTickerPercent}% limit`,
        tickerExposure,
      };
    }
  }

  return { safe: true, reason: '', tickerExposure };
}

export function getCircuitBreakerStatus() {
  const pauseCheck = shouldPauseTrading();
  const kelly = calculateKellyFraction();

  const oneHourAgo = Date.now() - 3600000;
  const hourlyTrades = tradeHistory.filter(t => t.time > oneHourAgo);
  const hourlyWins = hourlyTrades.filter(t => t.pnl > 0).length;
  const hourlyLosses = hourlyTrades.filter(t => t.pnl < 0).length;

  return {
    paused: pauseCheck.paused,
    pauseReason: pauseCheck.reason,
    pauseRemainingMin: pauseCheck.remainingMinutes,
    consecutiveLosses,
    consecutiveWins,
    dailyPnl: dailyPnl.toFixed(4),
    dailyDrawdownPercent: dailyStartBalance > 0 ? ((-dailyPnl / dailyStartBalance) * 100).toFixed(2) : '0',
    hourly: { trades: hourlyTrades.length, wins: hourlyWins, losses: hourlyLosses },
    totalTrades: tradeHistory.length,
    pauseCount,
    kelly,
    regime: currentRegime,
    regimeLossThreshold: REGIME_LOSS_THRESHOLDS[currentRegime] ?? CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_LOSSES,
  };
}
