/**
 * Advanced Volatility Methods Service
 *
 * Implements 6 different volatility calculation methods for cross-validation
 * and regime detection. Each method answers different questions about market behavior.
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================
export interface VolatilityResult {
  method: VolatilityMethod;
  value: number;           // Raw volatility value
  normalized: number;      // Percentage (0-100 scale for comparison)
  level: 'EXTREME' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';
  confidence: number;      // How reliable is this reading (0-100)
}

export interface EnsembleVolatility {
  consensus: 'EXTREME' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';
  consensusScore: number;  // Agreement level (0-100)
  average: number;         // Average normalized volatility
  methods: VolatilityResult[];
  recommendation: string;  // Trading recommendation based on ensemble
  bestMethodForRegime: VolatilityMethod;
}

export type VolatilityMethod =
  | 'ATR'              // Average True Range
  | 'STD_LOG_RETURNS'  // Standard Deviation of Log Returns
  | 'PERCENT_RANGE'    // Simple Percentage Range
  | 'PARKINSON'        // Parkinson's Volatility
  | 'GARMAN_KLASS'     // Garman-Klass Volatility
  | 'ROGERS_SATCHELL'; // Rogers-Satchell Volatility

// ============================================
// VOLATILITY THRESHOLDS (calibrated for crypto)
// ============================================
const VOLATILITY_THRESHOLDS = {
  ATR_PERCENT: { EXTREME: 5, HIGH: 3, MEDIUM: 1.5, LOW: 0.75 },
  STD_LOG: { EXTREME: 0.08, HIGH: 0.05, MEDIUM: 0.03, LOW: 0.015 },
  PERCENT_RANGE: { EXTREME: 6, HIGH: 4, MEDIUM: 2, LOW: 1 },
  PARKINSON: { EXTREME: 0.06, HIGH: 0.04, MEDIUM: 0.025, LOW: 0.012 },
  GARMAN_KLASS: { EXTREME: 0.07, HIGH: 0.045, MEDIUM: 0.028, LOW: 0.014 },
  ROGERS_SATCHELL: { EXTREME: 0.065, HIGH: 0.042, MEDIUM: 0.026, LOW: 0.013 }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate True Range for a single candle
 */
function trueRange(current: Candle, previous: Candle | null): number {
  const highLow = current.high - current.low;

  if (!previous) return highLow;

  const highPrevClose = Math.abs(current.high - previous.close);
  const lowPrevClose = Math.abs(current.low - previous.close);

  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Classify volatility level based on value and thresholds
 */
function classifyVolatility(
  value: number,
  thresholds: { EXTREME: number; HIGH: number; MEDIUM: number; LOW: number }
): 'EXTREME' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW' {
  if (value >= thresholds.EXTREME) return 'EXTREME';
  if (value >= thresholds.HIGH) return 'HIGH';
  if (value >= thresholds.MEDIUM) return 'MEDIUM';
  if (value >= thresholds.LOW) return 'LOW';
  return 'VERY_LOW';
}

/**
 * Normalize value to 0-100 scale
 */
function normalizeToPercent(value: number, max: number): number {
  return Math.min(100, Math.max(0, (value / max) * 100));
}

// ============================================
// VOLATILITY CALCULATION METHODS
// ============================================

/**
 * 1. AVERAGE TRUE RANGE (ATR)
 *
 * Captures "true" movement beyond simple ranges by accounting for gaps.
 * Best for: Trend detection, sustained swings, stop-loss placement
 *
 * @param candles Price data
 * @param period Lookback period (default 14)
 * @returns Volatility result
 */
export function calculateATR(candles: Candle[], period: number = 14): VolatilityResult {
  if (candles.length < period + 1) {
    return {
      method: 'ATR',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  // Calculate True Range for each candle
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(trueRange(candles[i], candles[i - 1]));
  }

  // Calculate ATR using Wilder's smoothing (EMA-like)
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  // Convert to percentage of current price
  const currentPrice = candles[candles.length - 1].close;
  const atrPercent = (atr / currentPrice) * 100;

  const level = classifyVolatility(atrPercent, VOLATILITY_THRESHOLDS.ATR_PERCENT);
  const normalized = normalizeToPercent(atrPercent, VOLATILITY_THRESHOLDS.ATR_PERCENT.EXTREME * 1.5);

  return {
    method: 'ATR',
    value: atrPercent,
    normalized,
    level,
    confidence: Math.min(100, (candles.length / (period * 2)) * 100)
  };
}

/**
 * 2. STANDARD DEVIATION OF LOG RETURNS
 *
 * Statistical view of price deviation - sensitive to clustering of moves.
 * Best for: Risk quantification, momentum setups, RSI integration
 *
 * @param candles Price data
 * @param period Lookback period (default 20)
 * @returns Volatility result
 */
export function calculateStdLogReturns(candles: Candle[], period: number = 20): VolatilityResult {
  if (candles.length < period + 1) {
    return {
      method: 'STD_LOG_RETURNS',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  // Calculate log returns
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) {
      logReturns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }

  // Get recent log returns for the period
  const recentReturns = logReturns.slice(-period);

  if (recentReturns.length < 2) {
    return {
      method: 'STD_LOG_RETURNS',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  // Calculate mean
  const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;

  // Calculate standard deviation
  const squaredDiffs = recentReturns.map(r => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (recentReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  const level = classifyVolatility(stdDev, VOLATILITY_THRESHOLDS.STD_LOG);
  const normalized = normalizeToPercent(stdDev, VOLATILITY_THRESHOLDS.STD_LOG.EXTREME * 1.5);

  return {
    method: 'STD_LOG_RETURNS',
    value: stdDev,
    normalized,
    level,
    confidence: Math.min(100, (recentReturns.length / period) * 100)
  };
}

/**
 * 3. PERCENTAGE RANGE
 *
 * Simple proxy for "how much did it move" - direct tradable range measurement.
 * Best for: Breakout detection, quick volatility assessment, whipsaw learning
 *
 * @param candles Price data
 * @param period Lookback period for averaging (default 10)
 * @returns Volatility result
 */
export function calculatePercentRange(candles: Candle[], period: number = 10): VolatilityResult {
  if (candles.length < period) {
    return {
      method: 'PERCENT_RANGE',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  // Calculate percentage range for each candle: ((high - low) / low) * 100
  const percentRanges: number[] = candles.slice(-period).map(c => {
    if (c.low > 0) {
      return ((c.high - c.low) / c.low) * 100;
    }
    return 0;
  });

  // Average the ranges
  const avgRange = percentRanges.reduce((a, b) => a + b, 0) / percentRanges.length;

  const level = classifyVolatility(avgRange, VOLATILITY_THRESHOLDS.PERCENT_RANGE);
  const normalized = normalizeToPercent(avgRange, VOLATILITY_THRESHOLDS.PERCENT_RANGE.EXTREME * 1.5);

  return {
    method: 'PERCENT_RANGE',
    value: avgRange,
    normalized,
    level,
    confidence: Math.min(100, (candles.length / (period * 2)) * 100)
  };
}

/**
 * 4. PARKINSON'S VOLATILITY
 *
 * Estimates volatility using only highs and lows - reduces noise from drift.
 * Best for: Clean volatility signal, regime switching, ranging vs trending detection
 *
 * Formula: sqrt( (1/(4*n*ln(2))) * sum( ln(high/low)^2 ) )
 *
 * @param candles Price data
 * @param period Lookback period (default 20)
 * @returns Volatility result
 */
export function calculateParkinson(candles: Candle[], period: number = 20): VolatilityResult {
  if (candles.length < period) {
    return {
      method: 'PARKINSON',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  const recentCandles = candles.slice(-period);

  // Calculate sum of ln(high/low)^2
  let sumSquaredLogHL = 0;
  for (const candle of recentCandles) {
    if (candle.low > 0 && candle.high > 0) {
      const logHL = Math.log(candle.high / candle.low);
      sumSquaredLogHL += logHL * logHL;
    }
  }

  // Parkinson's formula: sqrt( sum / (4 * n * ln(2)) )
  const parkinson = Math.sqrt(sumSquaredLogHL / (4 * period * Math.LN2));

  const level = classifyVolatility(parkinson, VOLATILITY_THRESHOLDS.PARKINSON);
  const normalized = normalizeToPercent(parkinson, VOLATILITY_THRESHOLDS.PARKINSON.EXTREME * 1.5);

  return {
    method: 'PARKINSON',
    value: parkinson,
    normalized,
    level,
    confidence: Math.min(100, (candles.length / (period * 2)) * 100)
  };
}

/**
 * 5. GARMAN-KLASS VOLATILITY
 *
 * Blends high-low efficiency with open-close drift for precision.
 * Best for: True variance estimation, filtering real pumps from fake ones, noisy markets
 *
 * Formula: sqrt( (1/(2n)) * sum(ln(H/L)^2) - ((2ln2-1)/n) * sum(ln(C/O)^2) )
 *
 * @param candles Price data
 * @param period Lookback period (default 20)
 * @returns Volatility result
 */
export function calculateGarmanKlass(candles: Candle[], period: number = 20): VolatilityResult {
  if (candles.length < period) {
    return {
      method: 'GARMAN_KLASS',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  const recentCandles = candles.slice(-period);

  let sumLogHL2 = 0;  // sum of ln(H/L)^2
  let sumLogCO2 = 0;  // sum of ln(C/O)^2

  for (const candle of recentCandles) {
    if (candle.low > 0 && candle.high > 0 && candle.open > 0) {
      const logHL = Math.log(candle.high / candle.low);
      sumLogHL2 += logHL * logHL;

      const logCO = Math.log(candle.close / candle.open);
      sumLogCO2 += logCO * logCO;
    }
  }

  // Garman-Klass formula
  const term1 = sumLogHL2 / (2 * period);
  const term2 = ((2 * Math.LN2 - 1) / period) * sumLogCO2;

  // Ensure non-negative under the sqrt
  const gk = Math.sqrt(Math.max(0, term1 - term2));

  const level = classifyVolatility(gk, VOLATILITY_THRESHOLDS.GARMAN_KLASS);
  const normalized = normalizeToPercent(gk, VOLATILITY_THRESHOLDS.GARMAN_KLASS.EXTREME * 1.5);

  return {
    method: 'GARMAN_KLASS',
    value: gk,
    normalized,
    level,
    confidence: Math.min(100, (candles.length / (period * 2)) * 100)
  };
}

/**
 * 6. ROGERS-SATCHELL VOLATILITY
 *
 * Handles trends better by accounting for drift (mean returns not zero).
 * Best for: Trending assets, directional moves, sustained momentum
 *
 * Formula: sqrt( (1/n) * sum( ln(H/C)*ln(H/O) + ln(L/C)*ln(L/O) ) )
 *
 * @param candles Price data
 * @param period Lookback period (default 20)
 * @returns Volatility result
 */
export function calculateRogersSatchell(candles: Candle[], period: number = 20): VolatilityResult {
  if (candles.length < period) {
    return {
      method: 'ROGERS_SATCHELL',
      value: 0,
      normalized: 0,
      level: 'VERY_LOW',
      confidence: 0
    };
  }

  const recentCandles = candles.slice(-period);

  let sum = 0;
  for (const candle of recentCandles) {
    if (candle.open > 0 && candle.close > 0 && candle.high > 0 && candle.low > 0) {
      const logHC = Math.log(candle.high / candle.close);
      const logHO = Math.log(candle.high / candle.open);
      const logLC = Math.log(candle.low / candle.close);
      const logLO = Math.log(candle.low / candle.open);

      sum += (logHC * logHO) + (logLC * logLO);
    }
  }

  // Rogers-Satchell formula
  const rs = Math.sqrt(Math.max(0, sum / period));

  const level = classifyVolatility(rs, VOLATILITY_THRESHOLDS.ROGERS_SATCHELL);
  const normalized = normalizeToPercent(rs, VOLATILITY_THRESHOLDS.ROGERS_SATCHELL.EXTREME * 1.5);

  return {
    method: 'ROGERS_SATCHELL',
    value: rs,
    normalized,
    level,
    confidence: Math.min(100, (candles.length / (period * 2)) * 100)
  };
}

// ============================================
// ENSEMBLE VOLATILITY ANALYSIS
// ============================================

/**
 * Calculate all volatility methods and provide consensus
 *
 * @param candles Price data
 * @param period Lookback period
 * @returns Ensemble volatility analysis
 */
export function calculateEnsembleVolatility(candles: Candle[], period: number = 20): EnsembleVolatility {
  const methods: VolatilityResult[] = [
    calculateATR(candles, period),
    calculateStdLogReturns(candles, period),
    calculatePercentRange(candles, Math.max(5, Math.floor(period / 2))),
    calculateParkinson(candles, period),
    calculateGarmanKlass(candles, period),
    calculateRogersSatchell(candles, period)
  ];

  // Calculate average normalized volatility
  const validMethods = methods.filter(m => m.confidence > 30);
  const average = validMethods.length > 0
    ? validMethods.reduce((sum, m) => sum + m.normalized, 0) / validMethods.length
    : 0;

  // Count votes for each level
  const levelVotes: Record<string, number> = {
    'EXTREME': 0, 'HIGH': 0, 'MEDIUM': 0, 'LOW': 0, 'VERY_LOW': 0
  };

  for (const method of validMethods) {
    levelVotes[method.level] += method.confidence / 100; // Weight by confidence
  }

  // Find consensus (highest weighted votes)
  let consensus: EnsembleVolatility['consensus'] = 'MEDIUM';
  let maxVotes = 0;
  for (const [level, votes] of Object.entries(levelVotes)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      consensus = level as EnsembleVolatility['consensus'];
    }
  }

  // Calculate consensus score (agreement level)
  const totalVotes = Object.values(levelVotes).reduce((a, b) => a + b, 0);
  const consensusScore = totalVotes > 0 ? (maxVotes / totalVotes) * 100 : 0;

  // Determine best method for current regime
  let bestMethodForRegime: VolatilityMethod = 'ATR';

  // Check if trending (Rogers-Satchell excels) vs ranging (Parkinson excels)
  const rsResult = methods.find(m => m.method === 'ROGERS_SATCHELL')!;
  const parkResult = methods.find(m => m.method === 'PARKINSON')!;

  if (rsResult.normalized > parkResult.normalized + 10) {
    // Trending market - Rogers-Satchell is more accurate
    bestMethodForRegime = 'ROGERS_SATCHELL';
  } else if (parkResult.normalized > rsResult.normalized + 10) {
    // Ranging market - Parkinson is cleaner
    bestMethodForRegime = 'PARKINSON';
  } else {
    // Mixed/uncertain - use Garman-Klass for balance
    bestMethodForRegime = 'GARMAN_KLASS';
  }

  // Generate trading recommendation
  let recommendation: string;
  if (consensus === 'EXTREME') {
    recommendation = 'High risk environment. Use smaller positions, wider stops. Consider WHALE or ADAPTIVE strategies.';
  } else if (consensus === 'HIGH') {
    recommendation = 'Elevated volatility. Good for BREAKOUT and MOMENTUM. Use ATR-based stops.';
  } else if (consensus === 'MEDIUM') {
    recommendation = 'Normal conditions. All strategies viable. TREND and CONFLUENCE recommended.';
  } else if (consensus === 'LOW') {
    recommendation = 'Low volatility. Watch for breakout setups. Micro-trading may be beneficial.';
  } else {
    recommendation = 'Very low volatility. Consider waiting or using very tight targets for scalping.';
  }

  return {
    consensus,
    consensusScore,
    average,
    methods,
    recommendation,
    bestMethodForRegime
  };
}

// ============================================
// STRATEGY-SPECIFIC VOLATILITY SELECTION
// ============================================

/**
 * Get the best volatility method for a specific trading strategy
 */
export function getBestVolatilityMethodForStrategy(
  strategy: 'TREND' | 'BREAKOUT' | 'WHALE' | 'CONFLUENCE' | 'MOMENTUM' | 'DIVERGENCE' | 'ADAPTIVE'
): { primary: VolatilityMethod; secondary: VolatilityMethod; reason: string } {
  switch (strategy) {
    case 'TREND':
      return {
        primary: 'ROGERS_SATCHELL',
        secondary: 'ATR',
        reason: 'Rogers-Satchell handles drift in sustained trends; ATR for stop placement'
      };
    case 'BREAKOUT':
      return {
        primary: 'PERCENT_RANGE',
        secondary: 'GARMAN_KLASS',
        reason: 'Percent Range detects tradable moves; Garman-Klass filters false breakouts'
      };
    case 'WHALE':
      return {
        primary: 'ATR',
        secondary: 'STD_LOG_RETURNS',
        reason: 'ATR captures true range for large moves; Std Dev for risk assessment'
      };
    case 'CONFLUENCE':
      return {
        primary: 'GARMAN_KLASS',
        secondary: 'PARKINSON',
        reason: 'Garman-Klass balances multiple factors; Parkinson for clean signals'
      };
    case 'MOMENTUM':
      return {
        primary: 'STD_LOG_RETURNS',
        secondary: 'ROGERS_SATCHELL',
        reason: 'Std Dev captures acceleration clusters; Rogers-Satchell for direction'
      };
    case 'DIVERGENCE':
      return {
        primary: 'STD_LOG_RETURNS',
        secondary: 'PERCENT_RANGE',
        reason: 'Std Dev for overbought/oversold extremes; Percent Range for entry timing'
      };
    case 'ADAPTIVE':
      return {
        primary: 'GARMAN_KLASS',
        secondary: 'ROGERS_SATCHELL',
        reason: 'Garman-Klass for regime detection; Rogers-Satchell for trend confirmation'
      };
    default:
      return {
        primary: 'ATR',
        secondary: 'GARMAN_KLASS',
        reason: 'Default: ATR is most versatile; Garman-Klass for validation'
      };
  }
}

/**
 * Calculate volatility-adjusted trading parameters
 */
export function getVolatilityAdjustedParams(
  candles: Candle[],
  baseStopLoss: number,
  baseProfitTarget: number,
  basePositionSize: number
): {
  stopLoss: number;
  profitTarget: number;
  positionSize: number;
  holdTimeMultiplier: number;
  volatilityLevel: EnsembleVolatility['consensus'];
  reasoning: string;
} {
  const ensemble = calculateEnsembleVolatility(candles);
  const atr = calculateATR(candles);

  let stopMultiplier = 1;
  let profitMultiplier = 1;
  let sizeMultiplier = 1;
  let holdMultiplier = 1;
  let reasoning = '';

  switch (ensemble.consensus) {
    case 'EXTREME':
      stopMultiplier = 2.0;    // Much wider stops
      profitMultiplier = 1.8;  // Higher targets (volatility = opportunity)
      sizeMultiplier = 0.4;    // Much smaller positions
      holdMultiplier = 0.5;    // Shorter holds
      reasoning = 'Extreme volatility: Wide stops, small positions, quick exits';
      break;
    case 'HIGH':
      stopMultiplier = 1.5;
      profitMultiplier = 1.4;
      sizeMultiplier = 0.6;
      holdMultiplier = 0.7;
      reasoning = 'High volatility: Adjusted stops, reduced size, shorter holds';
      break;
    case 'MEDIUM':
      stopMultiplier = 1.0;
      profitMultiplier = 1.0;
      sizeMultiplier = 1.0;
      holdMultiplier = 1.0;
      reasoning = 'Normal volatility: Standard parameters';
      break;
    case 'LOW':
      stopMultiplier = 0.75;
      profitMultiplier = 0.7;
      sizeMultiplier = 1.2;
      holdMultiplier = 1.5;
      reasoning = 'Low volatility: Tighter stops, smaller targets, longer holds';
      break;
    case 'VERY_LOW':
      stopMultiplier = 0.5;
      profitMultiplier = 0.5;
      sizeMultiplier = 1.5;
      holdMultiplier = 2.0;
      reasoning = 'Very low volatility: Micro targets, larger positions, patient holds';
      break;
  }

  return {
    stopLoss: baseStopLoss * stopMultiplier,
    profitTarget: baseProfitTarget * profitMultiplier,
    positionSize: basePositionSize * sizeMultiplier,
    holdTimeMultiplier: holdMultiplier,
    volatilityLevel: ensemble.consensus,
    reasoning
  };
}

/**
 * Detect if volatility is expanding or contracting (for breakout setups)
 */
export function detectVolatilityExpansion(candles: Candle[], shortPeriod: number = 5, longPeriod: number = 20): {
  isExpanding: boolean;
  expansionRate: number;  // Positive = expanding, negative = contracting
  signal: 'BREAKOUT_LIKELY' | 'CONTINUATION' | 'REVERSAL_LIKELY' | 'NEUTRAL';
} {
  const shortATR = calculateATR(candles, shortPeriod);
  const longATR = calculateATR(candles, longPeriod);

  if (longATR.value === 0) {
    return { isExpanding: false, expansionRate: 0, signal: 'NEUTRAL' };
  }

  const expansionRate = ((shortATR.value - longATR.value) / longATR.value) * 100;
  const isExpanding = expansionRate > 10;

  let signal: 'BREAKOUT_LIKELY' | 'CONTINUATION' | 'REVERSAL_LIKELY' | 'NEUTRAL';

  if (expansionRate > 50) {
    signal = 'BREAKOUT_LIKELY';
  } else if (expansionRate > 20) {
    signal = 'CONTINUATION';
  } else if (expansionRate < -30) {
    signal = 'REVERSAL_LIKELY';  // Volatility compression often precedes reversal
  } else {
    signal = 'NEUTRAL';
  }

  return { isExpanding, expansionRate, signal };
}
