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

// Target overrides from Parameter Optimizer (Group B TP/SL values)
let targetOverrides = null; // { HIGH_VOL: {tp, sl}, NORMAL: {tp, sl}, LOW_VOL: {tp, sl} }

/** Set TP/SL overrides from the parameter optimizer */
export function setTargetOverrides(overrides) {
    targetOverrides = overrides;
}

/** Set the round-trip fee for the active exchange (called on exchange switch) */
export function setRoundTripFee(fee) {
  roundTripFeePercent = fee;
}

// Per-ticker regime cache
const regimeCache = new Map(); // ticker -> { regime, timestamp, ema10, ema30, rsi, prevRegime, ... }
const REGIME_CACHE_TTL = 60000; // 60s cache - prevents regime ping-ponging

// Regime transition history — stores last 5 regimes per ticker for transition detection
const regimeHistory = new Map(); // ticker -> [{ regime, timestamp, ema10Slope }]
const MAX_REGIME_HISTORY = 5;

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
  const ema10Slope = ema10Prev !== 0 ? (ema10Now - ema10Prev) / ema10Prev * 100 : 0;
  const spread = ema30Now !== 0 ? (ema10Now - ema30Now) / ema30Now * 100 : 0;

  let regime;
  if (spread > 0.2 && ema10Slope > 0.05 && rsi > 50) {
    regime = 'UPTREND';
  } else if (spread < -0.2 && ema10Slope < -0.05 && rsi < 50) {
    regime = 'DOWNTREND';
  } else {
    regime = 'SIDEWAYS';
  }

  // Cache it + track transition history
  if (ticker) {
    const prev = regimeCache.get(ticker);
    const prevRegime = prev?.regime || regime;
    const prevSlope = parseFloat(prev?.slope || 0);
    const slopeAccel = ema10Slope - prevSlope; // acceleration of EMA10 slope

    regimeCache.set(ticker, {
      regime,
      prevRegime,
      timestamp: Date.now(),
      ema10: ema10Now,
      ema30: ema30Now,
      rsi,
      spread: spread.toFixed(3),
      slope: ema10Slope.toFixed(3),
      slopeAccel: slopeAccel.toFixed(4),
    });

    // Maintain regime history for transition detection
    const history = regimeHistory.get(ticker) || [];
    if (history.length === 0 || history[history.length - 1].regime !== regime) {
      history.push({ regime, timestamp: Date.now(), ema10Slope });
      if (history.length > MAX_REGIME_HISTORY) history.shift();
      regimeHistory.set(ticker, history);
    }
  }

  return regime;
}

// ============================================
// 1B. REGIME TRANSITION DETECTION
// ============================================

/**
 * Detect regime transitions and compute confidence/direction.
 * Returns { transition, from, to, confidence, slopeAccel, recommendation }
 *
 * Transitions:
 *   SIDEWAYS → UPTREND   = "BREAKOUT"  (high alpha — +15 confidence boost)
 *   DOWNTREND → SIDEWAYS  = "RECOVERY"  (moderate alpha — +8 confidence boost)
 *   UPTREND → SIDEWAYS    = "FADING"    (exit signal — tighten stops)
 *   UPTREND → DOWNTREND   = "REVERSAL"  (strong exit — force tighten)
 *   SIDEWAYS → DOWNTREND  = "BREAKDOWN" (avoid entry, tighten)
 */
export function detectRegimeTransition(ticker) {
  const cached = regimeCache.get(ticker);
  if (!cached) return { transition: null, confidence: 0 };

  const { regime, prevRegime, slopeAccel } = cached;
  const accel = parseFloat(slopeAccel || 0);

  if (regime === prevRegime) {
    return { transition: null, from: regime, to: regime, confidence: 0, slopeAccel: accel, recommendation: 'HOLD' };
  }

  let transition, confidenceBoost, recommendation;

  if (prevRegime === 'SIDEWAYS' && regime === 'UPTREND') {
    transition = 'BREAKOUT';
    confidenceBoost = 15;
    recommendation = 'BOOST_ENTRY'; // Best alpha: catch the breakout
  } else if (prevRegime === 'DOWNTREND' && regime === 'SIDEWAYS') {
    transition = 'RECOVERY';
    confidenceBoost = 8;
    recommendation = 'BOOST_ENTRY';
  } else if (prevRegime === 'DOWNTREND' && regime === 'UPTREND') {
    transition = 'V_REVERSAL';
    confidenceBoost = 12;
    recommendation = 'BOOST_ENTRY';
  } else if (prevRegime === 'UPTREND' && regime === 'SIDEWAYS') {
    transition = 'FADING';
    confidenceBoost = -5;
    recommendation = 'TIGHTEN_EXITS';
  } else if (prevRegime === 'UPTREND' && regime === 'DOWNTREND') {
    transition = 'REVERSAL';
    confidenceBoost = -15;
    recommendation = 'FORCE_TIGHTEN';
  } else if (prevRegime === 'SIDEWAYS' && regime === 'DOWNTREND') {
    transition = 'BREAKDOWN';
    confidenceBoost = -10;
    recommendation = 'TIGHTEN_EXITS';
  } else {
    transition = 'UNKNOWN';
    confidenceBoost = 0;
    recommendation = 'HOLD';
  }

  // Amplify confidence by slope acceleration (accelerating momentum = stronger signal)
  if (accel > 0.02) confidenceBoost += 3;
  if (accel < -0.02) confidenceBoost -= 3;

  return { transition, from: prevRegime, to: regime, confidence: confidenceBoost, slopeAccel: accel, recommendation };
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
      return ['DIVERGENCE', 'ADAPTIVE', 'MEAN_REVERSION'];
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

  // Time Machine training (5yr backtest) learned: SL=-2%, TP=+10% (5:1 R:R) is optimal.
  // Wider stops let trades develop; tight stops cause death by a thousand cuts.
  // Minimum R:R of 2:1 enforced across all regimes.
  let regime, baseTp, baseSl;
  if (atrPercent > 1.5) {
    regime = 'HIGH_VOL'; baseTp = 6.0; baseSl = 3.0;    // R:R 2:1, wide for vol
  } else if (atrPercent > 0.5) {
    regime = 'NORMAL'; baseTp = 4.0; baseSl = 2.0;      // R:R 2:1, trained optimum
  } else {
    regime = 'LOW_VOL'; baseTp = 3.0; baseSl = 2.0;     // R:R 1.5:1, min 2% SL
  }

  let tp = baseTp;
  let sl = baseSl;
  let optimized = false;

  // Apply optimizer overrides only if they differ from the base defaults
  if (targetOverrides && targetOverrides[regime]) {
    const oTp = targetOverrides[regime].tp;
    const oSl = targetOverrides[regime].sl;
    if (Math.abs(oTp - baseTp) > 0.01 || Math.abs(oSl - baseSl) > 0.01) {
      tp = oTp;
      sl = oSl;
      optimized = true;
    }
  }

  // Defense-in-depth: SL must never be tighter than fees + 0.8% breathing room
  const minSL = roundTripFeePercent + 0.8;
  return { takeProfitPct: Math.max(tp, feeFloor), stopLossPct: Math.max(sl, minSL), regime, optimized };
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

  // --- PEAK TRACKING (used by trailing stop + scalp exit) ---
  const highestPrice = position.highestPrice || position.openPrice;
  const highPnl = ((highestPrice - position.openPrice) / position.openPrice) * 100;
  const highFeeAdj = highPnl - roundTripFeePercent;

  // Bear-market micro-profit: In extreme fear, take ANY profit above fees after 5min.
  // Bounces in capitulation markets are brief — grab what you can.
  if (holdMinutes >= 5 && feeAdjustedPnl >= 0.08 && position.fearGreedAtEntry != null && position.fearGreedAtEntry < 15) {
    const peakRetracement = highPnl > 0 ? (highPnl - pnlPercent) / highPnl : 0;
    if (peakRetracement > 0.2 || holdMinutes >= 30) {
      return {
        shouldExit: true,
        reason: `[BEAST-FEAR-SCALP] +${feeAdjustedPnl.toFixed(2)}% in Extreme Fear (F&G=${position.fearGreedAtEntry}), hold=${holdMinutes.toFixed(0)}min`,
        pnlPercent,
      };
    }
  }

  // Quick-profit scalping: if profitable above fees after 15-120 min with fading momentum,
  // take the profit rather than risk reversal in choppy markets
  if (holdMinutes >= 15 && holdMinutes <= 120 && feeAdjustedPnl >= 0.5) {
    // Check if price is retreating from peak (losing more than 40% of peak gain)
    const peakRetracement = highPnl > 0 ? (highPnl - pnlPercent) / highPnl : 0;
    if (peakRetracement > 0.4 && feeAdjustedPnl < targets.takeProfitPct * 0.6) {
      return {
        shouldExit: true,
        reason: `[BEAST-SCALP] +${feeAdjustedPnl.toFixed(2)}% (retreating ${(peakRetracement*100).toFixed(0)}% from peak +${highPnl.toFixed(2)}%, hold=${holdMinutes.toFixed(0)}min)`,
        pnlPercent,
      };
    }
  }

  // --- TRAILING STOP ---
  // Best seed uses activation at ~8% with 20% giveback from peak
  // Scale activation based on TP target: activate at 60% of TP (e.g., TP=8% → activate at 4.8%)
  const trailActivation = Math.max(1.5, targets.takeProfitPct * 0.6);

  if (highFeeAdj >= trailActivation) {
    // Trail giveback = 20% of peak gain (best seed), minimum 0.8%
    // Time-weighted tightening: as hold time increases, reduce giveback to lock in more profit
    // 0-30min: 20% giveback, 30-120min: 15%, 2-8h: 12%, 8h+: 8%
    let givebackPct;
    if (holdMinutes < 30) givebackPct = 0.20;
    else if (holdMinutes < 120) givebackPct = 0.15;
    else if (holdMinutes < 480) givebackPct = 0.12;
    else givebackPct = 0.08;

    const trailPct = Math.max(0.6, highPnl * givebackPct);
    const trailLevel = highestPrice * (1 - trailPct / 100);
    if (currentPrice <= trailLevel) {
      return {
        shouldExit: true,
        reason: `[BEAST-TRAIL] price ${currentPrice.toFixed(4)} <= trail ${trailLevel.toFixed(4)} (peak ${highestPrice.toFixed(4)}, locked +${feeAdjustedPnl.toFixed(2)}%, hold=${holdMinutes.toFixed(0)}min, giveback=${(givebackPct*100).toFixed(0)}%)`,
        pnlPercent,
      };
    }
  }

  // Stop loss (raw - stop loss is from entry, not fee-adjusted)
  // Stop loss is also fee-adjusted: actual loss = price move + fees
  const feeAdjustedSL = targets.stopLossPct + roundTripFeePercent;
  if (pnlPercent <= -feeAdjustedSL) {
    return {
      shouldExit: true,
      reason: `[BEAST-SL] ${pnlPercent.toFixed(2)}% <= -${feeAdjustedSL.toFixed(2)}% stop (${targets.regime}, includes ${roundTripFeePercent}% fees)`,
      pnlPercent,
    };
  }

  // SIDEWAYS regime: tighter time-based exits since positions mean-revert
  // In ranging markets, if profit hasn't materialized in 2h, it likely won't
  if (targets.regime === 'LOW_VOL' || targets.regime === 'NORMAL') {
    // Quick stale exit: cut losers after 90 min in sideways conditions
    if (holdMinutes > 90 && feeAdjustedPnl < -0.3) {
      return {
        shouldExit: true,
        reason: `[BEAST-SIDEWAYS-CUT] ${feeAdjustedPnl.toFixed(2)}% after fees, ${holdMinutes.toFixed(0)}min (SIDEWAYS time limit)`,
        pnlPercent,
      };
    }
    // Breakeven timeout: if position hasn't moved after 3h, free the slot
    if (holdMinutes > 180 && Math.abs(feeAdjustedPnl) < 0.5) {
      return {
        shouldExit: true,
        reason: `[BEAST-SIDEWAYS-FLAT] ${feeAdjustedPnl.toFixed(2)}% after ${holdMinutes.toFixed(0)}min — freeing slot`,
        pnlPercent,
      };
    }
    // Lower scalp threshold in SIDEWAYS: take any profit above fees + 0.2%
    if (holdMinutes >= 10 && feeAdjustedPnl >= 0.2) {
      const peakRetracement = highPnl > 0 ? (highPnl - pnlPercent) / highPnl : 0;
      if (peakRetracement > 0.3) {
        return {
          shouldExit: true,
          reason: `[BEAST-MICRO-SCALP] +${feeAdjustedPnl.toFixed(2)}% (retreating ${(peakRetracement*100).toFixed(0)}% from peak, hold=${holdMinutes.toFixed(0)}min)`,
          pnlPercent,
        };
      }
    }
  }

  // Time-based exit: stale positions - exit if losing after 24h OR breakeven after 48h
  // Best seed uses 168h (7d) max hold — allow trades time to develop
  if ((holdMinutes > 1440 && pnlPercent < -0.5) || (holdMinutes > 2880 && feeAdjustedPnl < 0.1)) {
    return {
      shouldExit: true,
      reason: `[BEAST-TIME] Stale position: ${pnlPercent.toFixed(2)}% raw (${feeAdjustedPnl.toFixed(2)}% after fees), ${holdMinutes.toFixed(0)}min`,
      pnlPercent,
    };
  }

  return { shouldExit: false, reason: '', pnlPercent };
}

/**
 * Check if account has exceeded max drawdown from peak
 * @param {number} maxDrawdownPercent - Maximum allowed drawdown (default 15%)
 * @returns {{ shouldStop: boolean, drawdownPercent: number, reason: string }}
 */
export function checkMaxDrawdown(maxDrawdownPercent = 15) {
  if (streakState.peakBalance <= 0 || streakState.currentBalance <= 0) {
    return { shouldStop: false, drawdownPercent: 0, reason: '' };
  }
  const drawdownPercent = ((streakState.peakBalance - streakState.currentBalance) / streakState.peakBalance) * 100;
  if (drawdownPercent >= maxDrawdownPercent) {
    return {
      shouldStop: true,
      drawdownPercent,
      reason: `[BEAST-MAXDD] Drawdown ${drawdownPercent.toFixed(2)}% from peak ($${streakState.peakBalance.toFixed(2)}) exceeds ${maxDrawdownPercent}% limit`,
    };
  }
  return { shouldStop: false, drawdownPercent, reason: '' };
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

/**
 * Full reset: clear ALL streak/trade state.
 * Called on new session start so streaks aren't poisoned by old data.
 */
export function fullResetBeastMode(balance) {
  streakState.consecutiveWins = 0;
  streakState.consecutiveLosses = 0;
  streakState.totalWins = 0;
  streakState.totalLosses = 0;
  streakState.totalPnl = 0;
  streakState.bestStreak = 0;
  streakState.worstStreak = 0;
  streakState.recentTrades = [];
  streakState.sessionStartBalance = balance || 0;
  streakState.currentBalance = balance || 0;
  streakState.peakBalance = balance || 0;
  regimeCache.clear();
  regimeHistory.clear();
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
