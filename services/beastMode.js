/**
 * Beast Mode - Maximum Performance Trading Engine
 *
 * Central aggressive trading optimizer that:
 *   1. Detects market regime per ticker (UPTREND/SIDEWAYS/DOWNTREND)
 *   2. Routes to matching strategy pools per regime
 *   3. Adjusts position sizes based on ATR volatility
 *   4. Compounds on winning streaks, scales back on losses
 *   5. Sets dynamic take-profit/stop-loss per ticker volatility
 *   6. Tracks hot/cold streaks to drive aggression level
 */

// ============================================
// STATE
// ============================================

const streakState = {
  consecutiveWins: 0,
  consecutiveLosses: 0,
  totalWins: 0,
  totalLosses: 0,
  totalPnl: 0,
  bestStreak: 0,
  worstStreak: 0,
  recentTrades: [],        // last 50 trades { pnl, time, ticker, strategy }
  sessionStartBalance: 0,
  currentBalance: 0,
  peakBalance: 0,
};

// Dynamic round-trip fee (percentage, e.g. 0.15 for Crypto.com, 0.52 for Kraken)
let roundTripFeePercent = 0.15;

/** Set the round-trip fee for the active exchange (called on exchange switch) */
export function setRoundTripFee(fee) {
  roundTripFeePercent = fee;
}

// Per-ticker regime cache
const regimeCache = new Map(); // ticker -> { regime, timestamp, ema10, ema30, rsi }
const REGIME_CACHE_TTL = 30000; // 30s cache

// ============================================
// EMA HELPER
// ============================================

function calcEMA(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) {
    // Fallback: use average high-low range
    const ranges = candles.map(c => c.h - c.l);
    return ranges.reduce((s, r) => s + r, 0) / ranges.length;
  }
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    trs.push(tr);
  }
  // Simple moving average of TR for the last `period` values
  const recentTRs = trs.slice(-period);
  return recentTRs.reduce((s, v) => s + v, 0) / recentTRs.length;
}

// ============================================
// 1. REGIME DETECTION
// ============================================

/**
 * Detect market regime for a ticker based on EMA crossover + RSI zone
 * @param {Array} candles - OHLCV candle data
 * @param {string} ticker - optional ticker for caching
 * @returns {'UPTREND' | 'SIDEWAYS' | 'DOWNTREND'}
 */
export function getMarketRegime(candles, ticker = '') {
  // Check cache
  if (ticker) {
    const cached = regimeCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < REGIME_CACHE_TTL) {
      return cached.regime;
    }
  }

  if (candles.length < 35) return 'SIDEWAYS';

  const closes = candles.map(c => c.c);
  const ema10 = calcEMA(closes, 10);
  const ema30 = calcEMA(closes, 30);
  const rsi = calcRSI(closes, 14);

  const ema10Now = ema10[ema10.length - 1];
  const ema30Now = ema30[ema30.length - 1];
  const ema10Prev = ema10[ema10.length - 6]; // 5 candles ago
  const ema30Prev = ema30[ema30.length - 6];

  // EMA slope: is ema10 rising/falling relative to ema30?
  const ema10Slope = (ema10Now - ema10Prev) / ema10Prev * 100;
  const spread = (ema10Now - ema30Now) / ema30Now * 100;

  let regime;
  if (spread > 0.1 && ema10Slope > 0 && rsi > 45) {
    regime = 'UPTREND';
  } else if (spread < -0.1 && ema10Slope < 0 && rsi < 55) {
    regime = 'DOWNTREND';
  } else {
    regime = 'SIDEWAYS';
  }

  // Cache it
  if (ticker) {
    regimeCache.set(ticker, {
      regime,
      timestamp: Date.now(),
      ema10: ema10Now,
      ema30: ema30Now,
      rsi,
      spread: spread.toFixed(3),
      slope: ema10Slope.toFixed(3),
    });
  }

  return regime;
}

// ============================================
// 2. STRATEGY POOL BY REGIME
// ============================================

/**
 * Get the pool of strategies suitable for the current regime
 * @param {'UPTREND' | 'SIDEWAYS' | 'DOWNTREND'} regime
 * @returns {string[]} strategy names
 */
export function getStrategyPool(regime) {
  switch (regime) {
    case 'UPTREND':
      return ['TREND', 'BREAKOUT', 'WHALE', 'MOMENTUM', 'SWING', 'ADAPTIVE'];
    case 'SIDEWAYS':
      return ['GRID', 'PAIR_LONG', 'ARB', 'MM', 'DCA', 'CONFLUENCE', 'DIVERGENCE'];
    case 'DOWNTREND':
      return ['DCA', 'GRID', 'DIVERGENCE', 'ADAPTIVE'];
    default:
      return ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];
  }
}

/**
 * Check if a strategy is appropriate for the current regime
 */
export function isStrategyAllowedForRegime(strategy, regime) {
  return getStrategyPool(regime).includes(strategy);
}

// ============================================
// 3. VOLATILITY-ADJUSTED POSITION SIZING
// ============================================

/**
 * Adjust position size based on ATR volatility
 * High vol → smaller positions, Low vol → larger positions
 *
 * @param {number} baseAmount - base investment amount
 * @param {Array} candles - OHLCV data
 * @returns {{ amount: number, multiplier: number, atrPercent: number }}
 */
export function adjustForVolatility(baseAmount, candles) {
  if (candles.length < 10) {
    return { amount: baseAmount, multiplier: 1.0, atrPercent: 0 };
  }

  const atr = calcATR(candles, 14);
  const price = candles[candles.length - 1].c;
  const atrPercent = (atr / price) * 100;

  let multiplier;
  if (atrPercent > 2.0) {
    // High volatility - reduce size
    multiplier = 0.6;
  } else if (atrPercent > 1.0) {
    // Above average volatility
    multiplier = 0.8;
  } else if (atrPercent > 0.5) {
    // Normal volatility
    multiplier = 1.0;
  } else if (atrPercent > 0.2) {
    // Low volatility - increase size
    multiplier = 1.2;
  } else {
    // Very low volatility - max size
    multiplier = 1.4;
  }

  return {
    amount: baseAmount * multiplier,
    multiplier,
    atrPercent,
  };
}

// ============================================
// 4. COMPOUNDING ACCELERATOR
// ============================================

/**
 * Get compounding multiplier based on streak and account growth
 * @returns {{ multiplier: number, reason: string }}
 */
export function getCompoundMultiplier() {
  let multiplier = 1.0;
  let reason = 'Neutral';

  // Win streak bonuses
  if (streakState.consecutiveWins >= 5) {
    multiplier = 1.5;
    reason = `Hot streak: ${streakState.consecutiveWins} wins -> 1.5x`;
  } else if (streakState.consecutiveWins >= 3) {
    multiplier = 1.25;
    reason = `Win streak: ${streakState.consecutiveWins} wins -> 1.25x`;
  }

  // Loss streak penalties
  if (streakState.consecutiveLosses >= 5) {
    multiplier = 0.5;
    reason = `Cold streak: ${streakState.consecutiveLosses} losses -> 0.5x`;
  } else if (streakState.consecutiveLosses >= 3) {
    multiplier = 0.7;
    reason = `Losing: ${streakState.consecutiveLosses} losses -> 0.7x`;
  }

  // Account growth bonus
  if (streakState.sessionStartBalance > 0 && streakState.currentBalance > 0) {
    const growth = (streakState.currentBalance - streakState.sessionStartBalance) / streakState.sessionStartBalance * 100;
    if (growth >= 30) {
      multiplier *= 1.3;
      reason += ` | Account +${growth.toFixed(0)}% -> 1.3x bonus`;
    } else if (growth >= 15) {
      multiplier *= 1.15;
      reason += ` | Account +${growth.toFixed(0)}% -> 1.15x bonus`;
    } else if (growth < -10) {
      multiplier *= 0.8;
      reason += ` | Account ${growth.toFixed(0)}% -> 0.8x safety`;
    }
  }

  // Cap between 0.4x and 2.0x
  multiplier = Math.max(0.4, Math.min(2.0, multiplier));

  return { multiplier, reason };
}

// ============================================
// 5. DYNAMIC PROFIT TARGETS
// ============================================

/**
 * Calculate dynamic take-profit and stop-loss based on current volatility
 * @param {Array} candles - OHLCV data
 * @returns {{ takeProfitPct: number, stopLossPct: number, regime: string }}
 */
export function getDynamicTargets(candles) {
  if (candles.length < 10) {
    return { takeProfitPct: 0.8, stopLossPct: 0.5, regime: 'NORMAL' };
  }

  const atr = calcATR(candles, 14);
  const price = candles[candles.length - 1].c;
  const atrPercent = (atr / price) * 100;

  // Fee-aware minimum: target must exceed round-trip fee + margin
  const feeFloor = roundTripFeePercent + 0.30;

  if (atrPercent > 1.5) {
    // High volatility: wider targets
    return { takeProfitPct: Math.max(2.0, feeFloor), stopLossPct: 1.5, regime: 'HIGH_VOL' };
  } else if (atrPercent > 0.5) {
    // Normal volatility
    return { takeProfitPct: Math.max(1.2, feeFloor), stopLossPct: 1.0, regime: 'NORMAL' };
  } else {
    // Low volatility: must still exceed fees
    return { takeProfitPct: Math.max(0.75, feeFloor), stopLossPct: 1.0, regime: 'LOW_VOL' };
  }
}

/**
 * Check if a position should exit based on dynamic TP/SL
 * @param {Object} position - { openPrice, ticker, entryTime }
 * @param {number} currentPrice
 * @param {Array} candles
 * @returns {{ shouldExit: boolean, reason: string, pnlPercent: number }}
 */
export function checkDynamicExit(position, currentPrice, candles) {
  const pnlPercent = ((currentPrice - position.openPrice) / position.openPrice) * 100;
  const feeAdjustedPnl = pnlPercent - roundTripFeePercent; // Subtract round-trip fee (dynamic per exchange)
  const targets = getDynamicTargets(candles);
  const holdTimeMs = Date.now() - position.entryTime;
  const holdMinutes = holdTimeMs / 60000;

  // Take profit (fee-adjusted)
  if (feeAdjustedPnl >= targets.takeProfitPct) {
    return {
      shouldExit: true,
      reason: `[BEAST-TP] +${feeAdjustedPnl.toFixed(2)}% after fees >= ${targets.takeProfitPct}% target (${targets.regime})`,
      pnlPercent,
    };
  }

  // Stop loss (raw - stop loss is from entry, not fee-adjusted)
  if (pnlPercent <= -targets.stopLossPct) {
    return {
      shouldExit: true,
      reason: `[BEAST-SL] ${pnlPercent.toFixed(2)}% <= -${targets.stopLossPct}% stop (${targets.regime})`,
      pnlPercent,
    };
  }

  // Time-based exit: 15min (was 30) with fee-adjusted check
  if (holdMinutes > 15 && feeAdjustedPnl < 0) {
    return {
      shouldExit: true,
      reason: `[BEAST-TIME] Stale position: ${feeAdjustedPnl.toFixed(2)}% after fees, ${holdMinutes.toFixed(0)}min`,
      pnlPercent,
    };
  }

  return { shouldExit: false, reason: '', pnlPercent };
}

/**
 * Get Kraken-optimized dynamic targets with maker/taker awareness.
 * @param {Array} candles - OHLCV data
 * @param {boolean} isLimitOrder - Whether using limit order (maker fee)
 * @returns {{ takeProfitPct: number, stopLossPct: number, regime: string, orderType: string }}
 */
export function getKrakenOptimizedTargets(candles, isLimitOrder = false) {
  const baseTargets = getDynamicTargets(candles);

  // Kraken-specific: use maker fee floor for limit orders
  const makerRoundTrip = 0.32; // 0.16% * 2
  const effectiveFee = isLimitOrder ? makerRoundTrip : roundTripFeePercent;
  const feeFloor = effectiveFee + 0.30; // min profit above fees

  return {
    takeProfitPct: Math.max(baseTargets.takeProfitPct, feeFloor),
    stopLossPct: baseTargets.stopLossPct,
    regime: baseTargets.regime,
    orderType: isLimitOrder ? 'LIMIT' : 'MARKET',
    effectiveFee,
    savingsVsTaker: isLimitOrder ? (roundTripFeePercent - makerRoundTrip).toFixed(3) : '0',
  };
}

// ============================================
// 6. STREAK TRACKER
// ============================================

/**
 * Record a trade result and update streak state
 * @param {number} pnl - profit/loss in USD
 * @param {string} ticker
 * @param {string} strategy
 */
export function recordTradeResult(pnl, ticker = '', strategy = '') {
  streakState.totalPnl += pnl;
  streakState.recentTrades.push({ pnl, time: Date.now(), ticker, strategy });
  if (streakState.recentTrades.length > 50) {
    streakState.recentTrades.shift();
  }

  if (pnl > 0) {
    streakState.consecutiveWins++;
    streakState.consecutiveLosses = 0;
    streakState.totalWins++;
    streakState.bestStreak = Math.max(streakState.bestStreak, streakState.consecutiveWins);
  } else if (pnl < 0) {
    streakState.consecutiveLosses++;
    streakState.consecutiveWins = 0;
    streakState.totalLosses++;
    streakState.worstStreak = Math.max(streakState.worstStreak, streakState.consecutiveLosses);
  }
}

/**
 * Update current balance for growth tracking
 */
export function updateBalance(balance) {
  streakState.currentBalance = balance;
  streakState.peakBalance = Math.max(streakState.peakBalance, balance);
  if (streakState.sessionStartBalance === 0) {
    streakState.sessionStartBalance = balance;
  }
}

/**
 * Set session start balance (call on bot start)
 */
export function setSessionBalance(balance) {
  streakState.sessionStartBalance = balance;
  streakState.currentBalance = balance;
  streakState.peakBalance = balance;
}

// ============================================
// STATUS
// ============================================

// ============================================
// STATE EXPORT / IMPORT (for session persistence)
// ============================================

export function exportState() {
  return {
    consecutiveWins: streakState.consecutiveWins,
    consecutiveLosses: streakState.consecutiveLosses,
    totalWins: streakState.totalWins,
    totalLosses: streakState.totalLosses,
    totalPnl: streakState.totalPnl,
    bestStreak: streakState.bestStreak,
    worstStreak: streakState.worstStreak,
    recentTrades: streakState.recentTrades.slice(-50),
    sessionStartBalance: streakState.sessionStartBalance,
    currentBalance: streakState.currentBalance,
    peakBalance: streakState.peakBalance,
  };
}

export function importState(state) {
  if (!state) return;
  streakState.consecutiveWins = state.consecutiveWins || 0;
  streakState.consecutiveLosses = state.consecutiveLosses || 0;
  streakState.totalWins = state.totalWins || 0;
  streakState.totalLosses = state.totalLosses || 0;
  streakState.totalPnl = state.totalPnl || 0;
  streakState.bestStreak = state.bestStreak || 0;
  streakState.worstStreak = state.worstStreak || 0;
  streakState.recentTrades = Array.isArray(state.recentTrades) ? state.recentTrades : [];
  streakState.sessionStartBalance = state.sessionStartBalance || 0;
  streakState.currentBalance = state.currentBalance || 0;
  streakState.peakBalance = state.peakBalance || 0;
}

/**
 * Get full beast mode status dump
 */
export function getBeastModeStatus() {
  const totalTrades = streakState.totalWins + streakState.totalLosses;
  const winRate = totalTrades > 0 ? (streakState.totalWins / totalTrades * 100).toFixed(1) : '0.0';
  const compound = getCompoundMultiplier();

  const regimes = {};
  for (const [ticker, data] of regimeCache) {
    regimes[ticker] = {
      regime: data.regime,
      ema10: data.ema10?.toFixed(2),
      ema30: data.ema30?.toFixed(2),
      rsi: data.rsi?.toFixed(1),
      spread: data.spread,
      slope: data.slope,
      ageSeconds: Math.round((Date.now() - data.timestamp) / 1000),
    };
  }

  return {
    enabled: true,
    streak: {
      consecutiveWins: streakState.consecutiveWins,
      consecutiveLosses: streakState.consecutiveLosses,
      totalWins: streakState.totalWins,
      totalLosses: streakState.totalLosses,
      winRate: winRate + '%',
      bestStreak: streakState.bestStreak,
      worstStreak: streakState.worstStreak,
      totalPnl: streakState.totalPnl.toFixed(4),
    },
    compounding: compound,
    balance: {
      sessionStart: streakState.sessionStartBalance.toFixed(2),
      current: streakState.currentBalance.toFixed(2),
      peak: streakState.peakBalance.toFixed(2),
      growthPercent: streakState.sessionStartBalance > 0
        ? ((streakState.currentBalance - streakState.sessionStartBalance) / streakState.sessionStartBalance * 100).toFixed(2) + '%'
        : '0.00%',
    },
    regimes,
    recentTrades: streakState.recentTrades.slice(-10).map(t => ({
      pnl: t.pnl.toFixed(4),
      ticker: t.ticker,
      strategy: t.strategy,
      ageSeconds: Math.round((Date.now() - t.time) / 1000),
    })),
  };
}
