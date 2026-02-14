/**
 * Multi-Timeframe Confluence Service
 * Computes alignment scores across 1m, 5m, 15m (and optionally 1h) timeframes.
 * Aligned trends across timeframes = higher conviction entries.
 */

/**
 * Simple EMA calculation
 */
function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * RSI calculation
 */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Analyze a single timeframe: EMA trend direction + RSI zone
 * Returns { trend: 'UP'|'DOWN'|'NEUTRAL', rsiZone: 'OVERBOUGHT'|'OVERSOLD'|'NEUTRAL', score: 0-100 }
 */
function analyzeTimeframe(candles) {
  if (!candles || candles.length < 21) {
    return { trend: 'NEUTRAL', rsiZone: 'NEUTRAL', score: 50 };
  }

  const closes = candles.map(c => c.c);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const lastEma9 = ema9[ema9.length - 1];
  const lastEma21 = ema21[ema21.length - 1];
  const rsiVal = rsi(closes, 14);

  // Trend from EMA crossover
  const emaDiff = (lastEma9 - lastEma21) / lastEma21 * 100;
  let trend = 'NEUTRAL';
  if (emaDiff > 0.05) trend = 'UP';
  else if (emaDiff < -0.05) trend = 'DOWN';

  // RSI zone
  let rsiZone = 'NEUTRAL';
  if (rsiVal > 70) rsiZone = 'OVERBOUGHT';
  else if (rsiVal < 30) rsiZone = 'OVERSOLD';

  // Score: 100 = strong bullish, 0 = strong bearish, 50 = neutral
  let score = 50;
  if (trend === 'UP') score += 25;
  else if (trend === 'DOWN') score -= 25;

  if (rsiVal > 50) score += Math.min(25, (rsiVal - 50) * 0.5);
  else score -= Math.min(25, (50 - rsiVal) * 0.5);

  score = Math.max(0, Math.min(100, score));

  return { trend, rsiZone, rsiVal, emaDiff, score };
}

/**
 * Compute MTF alignment score from candles at multiple timeframes.
 * @param {Object} candlesByTimeframe - { '1m': [...], '5m': [...], '15m': [...] }
 * @returns {{ alignmentScore: number, details: Object, direction: string }}
 *   alignmentScore: 0-100 where 100 = perfect bullish alignment, 0 = perfect bearish
 */
export function getMTFAlignmentScore(candlesByTimeframe) {
  const timeframes = ['1m', '5m', '15m'];
  const weights = { '1m': 0.2, '5m': 0.35, '15m': 0.45 }; // Higher TFs weighted more

  const details = {};
  let weightedScore = 0;
  let totalWeight = 0;

  for (const tf of timeframes) {
    const candles = candlesByTimeframe[tf];
    const analysis = analyzeTimeframe(candles);
    details[tf] = analysis;
    const w = weights[tf] || 0.33;
    weightedScore += analysis.score * w;
    totalWeight += w;
  }

  const alignmentScore = totalWeight > 0 ? weightedScore / totalWeight : 50;

  // Determine if all timeframes agree on direction
  const trends = Object.values(details).map(d => d.trend);
  const allUp = trends.every(t => t === 'UP');
  const allDown = trends.every(t => t === 'DOWN');
  const direction = allUp ? 'BULLISH' : allDown ? 'BEARISH' : 'MIXED';

  return { alignmentScore, details, direction };
}

/**
 * Convert alignment score to confidence adjustment multiplier.
 * @param {number} alignmentScore - 0 to 100
 * @returns {number} multiplier between 0.5 (misaligned) and 1.3 (fully aligned)
 */
export function getMTFConfidenceAdjustment(alignmentScore) {
  if (alignmentScore >= 80) return 1.3;   // Strong bullish alignment
  if (alignmentScore >= 65) return 1.15;  // Moderate bullish alignment
  if (alignmentScore >= 45) return 1.0;   // Neutral / no adjustment
  if (alignmentScore >= 30) return 0.75;  // Moderate bearish misalignment
  return 0.5;                              // Strong bearish misalignment
}

/**
 * Get confidence points adjustment (additive, for bot loop integration)
 * @param {number} alignmentScore
 * @returns {number} -15 to +15 confidence points
 */
export function getMTFConfidencePoints(alignmentScore) {
  if (alignmentScore >= 80) return 15;
  if (alignmentScore >= 65) return 8;
  if (alignmentScore >= 45) return 0;
  if (alignmentScore >= 30) return -8;
  return -15;
}

export default { getMTFAlignmentScore, getMTFConfidenceAdjustment, getMTFConfidencePoints };
