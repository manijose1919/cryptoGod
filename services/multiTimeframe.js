/**
 * Multi-Timeframe Confirmation Service
 *
 * Before entering on 1m, checks 5m and 15m trend alignment.
 * Reduces false signals by requiring higher timeframes to agree.
 *
 * Scoring: each timeframe contributes to a composite alignment score.
 *   1m = 30% weight, 5m = 35% weight, 15m = 35% weight
 *   Score > 60 = aligned bullish, < 40 = aligned bearish
 */

// ============================================
// HELPERS
// ============================================

function ema(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ============================================
// SINGLE TIMEFRAME ANALYSIS
// ============================================

/**
 * Analyze a single timeframe and return a trend score 0-100
 * (0 = strongly bearish, 50 = neutral, 100 = strongly bullish)
 */
function analyzeSingleTimeframe(candles) {
  if (!candles || candles.length < 20) {
    return { score: 50, trend: 'NEUTRAL', details: 'Insufficient data' };
  }

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  let score = 50; // Start neutral

  // 1. EMA alignment (±15 points)
  const ema10 = ema(closes, 10);
  const ema20 = ema(closes, 20);
  const ema10Now = ema10[ema10.length - 1];
  const ema20Now = ema20[ema20.length - 1];

  if (price > ema10Now && ema10Now > ema20Now) score += 15;       // Bullish stack
  else if (price > ema10Now || price > ema20Now) score += 7;      // Partially bullish
  else if (price < ema10Now && ema10Now < ema20Now) score -= 15;  // Bearish stack
  else if (price < ema10Now || price < ema20Now) score -= 7;      // Partially bearish

  // 2. EMA slope (±10 points)
  const emaSlope = (ema10Now - ema10[Math.max(0, ema10.length - 6)]) / ema10Now * 100;
  if (emaSlope > 0.1) score += 10;
  else if (emaSlope > 0) score += 5;
  else if (emaSlope < -0.1) score -= 10;
  else if (emaSlope < 0) score -= 5;

  // 3. RSI (±10 points)
  const rsiVal = rsi(closes);
  if (rsiVal > 60 && rsiVal < 80) score += 10;       // Strong but not overbought
  else if (rsiVal > 50) score += 5;
  else if (rsiVal < 40 && rsiVal > 20) score -= 10;  // Weak but not oversold
  else if (rsiVal < 50) score -= 5;

  // 4. Recent momentum (±10 points)
  const change5 = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  if (change5 > 0.5) score += 10;
  else if (change5 > 0) score += 5;
  else if (change5 < -0.5) score -= 10;
  else if (change5 < 0) score -= 5;

  // 5. Volume trend (±5 points)
  const vols = candles.map(c => c.v);
  const avgVol = vols.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const recentVol = vols.slice(-5).reduce((s, v) => s + v, 0) / 5;
  if (recentVol > avgVol * 1.2 && change5 > 0) score += 5;
  else if (recentVol > avgVol * 1.2 && change5 < 0) score -= 5;

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let trend = 'NEUTRAL';
  if (score >= 70) trend = 'STRONG_BULL';
  else if (score >= 55) trend = 'BULL';
  else if (score <= 30) trend = 'STRONG_BEAR';
  else if (score <= 45) trend = 'BEAR';

  return {
    score,
    trend,
    details: `EMA=${price > ema10Now ? 'above' : 'below'} RSI=${rsiVal.toFixed(0)} Mom=${change5.toFixed(2)}%`,
  };
}

// ============================================
// MULTI-TIMEFRAME COMPOSITE
// ============================================

/**
 * Analyze multiple timeframes and return composite alignment.
 *
 * @param {Object} candlesByTF - { '1m': candles[], '5m': candles[], '15m': candles[] }
 * @returns {Object} Multi-timeframe analysis result
 */
export function analyzeMultiTimeframe(candlesByTF) {
  const tf1m = analyzeSingleTimeframe(candlesByTF['1m']);
  const tf5m = analyzeSingleTimeframe(candlesByTF['5m']);
  const tf15m = analyzeSingleTimeframe(candlesByTF['15m']);

  // Weighted composite: 1m=30%, 5m=35%, 15m=35%
  const composite = tf1m.score * 0.30 + tf5m.score * 0.35 + tf15m.score * 0.35;

  // Alignment: all timeframes agree
  const allBullish = tf1m.score > 55 && tf5m.score > 55 && tf15m.score > 55;
  const allBearish = tf1m.score < 45 && tf5m.score < 45 && tf15m.score < 45;
  const aligned = allBullish || allBearish;

  // Conflict detection
  const conflict = (tf1m.score > 60 && tf15m.score < 40) || (tf1m.score < 40 && tf15m.score > 60);

  let recommendation;
  if (composite >= 70 && aligned) recommendation = 'STRONG_BUY';
  else if (composite >= 55) recommendation = 'BUY';
  else if (composite <= 30 && aligned) recommendation = 'STRONG_SELL';
  else if (composite <= 45) recommendation = 'SELL';
  else recommendation = 'NEUTRAL';

  return {
    composite,
    aligned,
    conflict,
    recommendation,
    timeframes: { '1m': tf1m, '5m': tf5m, '15m': tf15m },
  };
}

/**
 * Quick check: should we proceed with a LONG entry?
 * Returns { proceed, confidence, reason }
 */
export function shouldEnterLong(candlesByTF) {
  const analysis = analyzeMultiTimeframe(candlesByTF);

  if (analysis.conflict) {
    return {
      proceed: false,
      confidence: 0,
      modifier: 0.5,
      reason: `MTF conflict: 1m=${analysis.timeframes['1m'].trend}, 15m=${analysis.timeframes['15m'].trend}`,
    };
  }

  if (analysis.composite < 45) {
    return {
      proceed: false,
      confidence: 0,
      modifier: 0.6,
      reason: `MTF bearish: composite=${analysis.composite.toFixed(0)}`,
    };
  }

  // Aligned bullish = full confidence, partially = reduced
  const confidence = analysis.aligned ? 100 : Math.max(30, (analysis.composite - 45) * 3.6);
  const modifier = analysis.aligned ? 1.2 : analysis.composite > 55 ? 1.0 : 0.8;

  return {
    proceed: true,
    confidence,
    modifier,
    reason: `MTF ${analysis.recommendation}: composite=${analysis.composite.toFixed(0)} [1m=${analysis.timeframes['1m'].score.toFixed(0)} 5m=${analysis.timeframes['5m'].score.toFixed(0)} 15m=${analysis.timeframes['15m'].score.toFixed(0)}]`,
  };
}

/**
 * Get full multi-timeframe status for display
 */
export function getMultiTimeframeStatus(allCandlesByTicker) {
  const status = {};
  for (const [ticker, tfCandles] of Object.entries(allCandlesByTicker)) {
    status[ticker] = analyzeMultiTimeframe(tfCandles);
  }
  return status;
}
