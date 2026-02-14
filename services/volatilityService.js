/**
 * Advanced Volatility Methods Service (JS Version)
 *
 * Implements 6 different volatility calculation methods for cross-validation
 * and regime detection.
 */

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
function trueRange(current, previous) {
  const highLow = current.h - current.l;

  if (!previous) return highLow;

  const highPrevClose = Math.abs(current.h - previous.c);
  const lowPrevClose = Math.abs(current.l - previous.c);

  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Classify volatility level based on value and thresholds
 */
function classifyVolatility(value, thresholds) {
  if (value >= thresholds.EXTREME) return 'EXTREME';
  if (value >= thresholds.HIGH) return 'HIGH';
  if (value >= thresholds.MEDIUM) return 'MEDIUM';
  if (value >= thresholds.LOW) return 'LOW';
  return 'VERY_LOW';
}

/**
 * Normalize value to 0-100 scale
 */
function normalizeToPercent(value, max) {
  return Math.min(100, Math.max(0, (value / max) * 100));
}

// ============================================
// VOLATILITY CALCULATION METHODS
// ============================================

/**
 * 1. AVERAGE TRUE RANGE (ATR)
 */
export function calculateATR(candles, period = 14) {
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
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(trueRange(candles[i], candles[i - 1]));
  }

  // Calculate ATR using Wilder's smoothing (EMA-like)
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  // Convert to percentage of current price
  const currentPrice = candles[candles.length - 1].c;
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
 */
export function calculateStdLogReturns(candles, period = 20) {
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
  const logReturns = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].c > 0) {
      logReturns.push(Math.log(candles[i].c / candles[i - 1].c));
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
 */
export function calculatePercentRange(candles, period = 10) {
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
  const percentRanges = candles.slice(-period).map(c => {
    if (c.l > 0) {
      return ((c.h - c.l) / c.l) * 100;
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
 */
export function calculateParkinson(candles, period = 20) {
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
    if (candle.l > 0 && candle.h > 0) {
      const logHL = Math.log(candle.h / candle.l);
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
 */
export function calculateGarmanKlass(candles, period = 20) {
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
    if (candle.l > 0 && candle.h > 0 && candle.o > 0) {
      const logHL = Math.log(candle.h / candle.l);
      sumLogHL2 += logHL * logHL;

      const logCO = Math.log(candle.c / candle.o);
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
 */
export function calculateRogersSatchell(candles, period = 20) {
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
    if (candle.o > 0 && candle.c > 0 && candle.h > 0 && candle.l > 0) {
      const logHC = Math.log(candle.h / candle.c);
      const logHO = Math.log(candle.h / candle.o);
      const logLC = Math.log(candle.l / candle.c);
      const logLO = Math.log(candle.l / candle.o);

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
 */
export function calculateEnsembleVolatility(candles, period = 20) {
  const methods = [
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
  const levelVotes = {
    'EXTREME': 0, 'HIGH': 0, 'MEDIUM': 0, 'LOW': 0, 'VERY_LOW': 0
  };

  for (const method of validMethods) {
    levelVotes[method.level] += method.confidence / 100; // Weight by confidence
  }

  // Find consensus (highest weighted votes)
  let consensus = 'MEDIUM';
  let maxVotes = 0;
  for (const [level, votes] of Object.entries(levelVotes)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      consensus = level;
    }
  }

  // Calculate consensus score (agreement level)
  const totalVotes = Object.values(levelVotes).reduce((a, b) => a + b, 0);
  const consensusScore = totalVotes > 0 ? (maxVotes / totalVotes) * 100 : 0;

  // Determine best method for current regime
  let bestMethodForRegime = 'ATR';

  // Check if trending (Rogers-Satchell excels) vs ranging (Parkinson excels)
  const rsResult = methods.find(m => m.method === 'ROGERS_SATCHELL');
  const parkResult = methods.find(m => m.method === 'PARKINSON');

  if (rsResult && parkResult) {
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
  }

  // Generate trading recommendation
  let recommendation;
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

/**
 * Detect if volatility is expanding or contracting
 */
export function detectVolatilityExpansion(candles, shortPeriod = 5, longPeriod = 20) {
  const shortATR = calculateATR(candles, shortPeriod);
  const longATR = calculateATR(candles, longPeriod);

  if (longATR.value === 0) {
    return { isExpanding: false, expansionRate: 0, signal: 'NEUTRAL' };
  }

  const expansionRate = ((shortATR.value - longATR.value) / longATR.value) * 100;
  const isExpanding = expansionRate > 10;

  let signal;

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
