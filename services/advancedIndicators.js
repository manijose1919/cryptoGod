/**
 * Advanced Technical Indicators Service
 *
 * Implements 7 technical indicators for multi-timeframe analysis:
 * Bollinger Bands, VWAP, ADX, Ichimoku Cloud, Keltner Channels, CCI, Williams %R
 *
 * All functions receive candle arrays with shorthand keys:
 *   { c: close, o: open, h: high, l: low, v: volume, t: timestamp }
 */

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Simple Moving Average over the last `period` values
 * @param {number[]} values - Array of numeric values
 * @param {number} period - Lookback period
 * @returns {number|null}
 */
function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Exponential Moving Average over the last `period` values
 * Returns the final EMA value computed across the full values array.
 * Uses SMA of the first `period` values as the seed.
 * @param {number[]} values - Array of numeric values
 * @param {number} period - Lookback period
 * @returns {number|null}
 */
function ema(values, period) {
  if (!values || values.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let emaCurrent = 0;
  for (let i = 0; i < period; i++) {
    emaCurrent += values[i];
  }
  emaCurrent /= period;

  // Apply EMA formula for the remaining values
  for (let i = period; i < values.length; i++) {
    emaCurrent = values[i] * k + emaCurrent * (1 - k);
  }

  return emaCurrent;
}

/**
 * Standard Deviation of the last `period` values
 * @param {number[]} values - Array of numeric values
 * @param {number} period - Lookback period
 * @returns {number|null}
 */
function stdDev(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, v) => sum + v, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

/**
 * True Range for a single candle (requires previous candle for gaps)
 * @param {{ h: number, l: number, c: number }} current
 * @param {{ c: number }|null} previous
 * @returns {number}
 */
function trueRange(current, previous) {
  const highLow = current.h - current.l;
  if (!previous) return highLow;

  const highPrevClose = Math.abs(current.h - previous.c);
  const lowPrevClose = Math.abs(current.l - previous.c);

  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Average True Range using Wilder's smoothing
 * @param {Array} candles - Candle array with shorthand keys
 * @param {number} period - ATR period
 * @returns {number|null}
 */
function atr(candles, period) {
  if (!candles || candles.length < period + 1) return null;

  // Calculate all true ranges
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    trValues.push(trueRange(candles[i], candles[i - 1]));
  }

  if (trValues.length < period) return null;

  // Seed with SMA of first `period` true ranges
  let atrValue = 0;
  for (let i = 0; i < period; i++) {
    atrValue += trValues[i];
  }
  atrValue /= period;

  // Wilder's smoothing for the rest
  for (let i = period; i < trValues.length; i++) {
    atrValue = (atrValue * (period - 1) + trValues[i]) / period;
  }

  return atrValue;
}

/**
 * Highest value in an array slice
 */
function highest(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return Math.max(...slice);
}

/**
 * Lowest value in an array slice
 */
function lowest(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return Math.min(...slice);
}

/**
 * Mean Deviation (average absolute deviation from mean)
 * @param {number[]} values
 * @param {number} period
 * @returns {number|null}
 */
function meanDeviation(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, v) => sum + v, 0) / period;
  return slice.reduce((sum, v) => sum + Math.abs(v - mean), 0) / period;
}


// ============================================
// INDICATOR FUNCTIONS
// ============================================

/**
 * Bollinger Bands
 *
 * Middle band = SMA(close, period)
 * Upper band = middle + stdMultiplier * stdDev(close, period)
 * Lower band = middle - stdMultiplier * stdDev(close, period)
 * Bandwidth = (upper - lower) / middle
 * %B = (close - lower) / (upper - lower)
 *
 * @param {Array} candles - Candle array
 * @param {number} [period=20] - SMA/StdDev period
 * @param {number} [stdMultiplier=2] - Standard deviation multiplier
 * @returns {{ upper: number, middle: number, lower: number, bandwidth: number, percentB: number }|null}
 */
export function bollingerBands(candles, period = 20, stdMultiplier = 2) {
  if (!candles || candles.length < period + 1) return null;

  const closes = candles.map(c => c.c);
  const middle = sma(closes, period);
  const sd = stdDev(closes, period);

  if (middle === null || sd === null) return null;

  const upper = middle + stdMultiplier * sd;
  const lower = middle - stdMultiplier * sd;
  const bandwidth = middle !== 0 ? (upper - lower) / middle : 0;
  const range = upper - lower;
  const currentClose = closes[closes.length - 1];
  const percentB = range !== 0 ? (currentClose - lower) / range : 0.5;

  return { upper, middle, lower, bandwidth, percentB };
}

/**
 * Volume-Weighted Average Price (VWAP)
 *
 * VWAP = cumSum(typicalPrice * volume) / cumSum(volume)
 * Typical Price = (high + low + close) / 3
 * Bands = VWAP +/- 1 stdDev of (TP - VWAP) weighted by volume
 *
 * @param {Array} candles - Candle array
 * @returns {{ vwap: number, upperBand: number, lowerBand: number }|null}
 */
export function vwap(candles) {
  if (!candles || candles.length < 1) return null;

  let cumTPV = 0;   // cumulative (typical price * volume)
  let cumVol = 0;   // cumulative volume
  let cumVarSum = 0; // cumulative variance sum for bands

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.h + c.l + c.c) / 3;
    const vol = c.v || 0;

    cumTPV += tp * vol;
    cumVol += vol;

    if (cumVol > 0) {
      const currentVwap = cumTPV / cumVol;
      // Weighted variance: volume * (tp - vwap)^2
      cumVarSum += vol * (tp - currentVwap) ** 2;
    }
  }

  if (cumVol === 0) return null;

  const vwapValue = cumTPV / cumVol;
  const variance = cumVarSum / cumVol;
  const sd = Math.sqrt(variance);

  return {
    vwap: vwapValue,
    upperBand: vwapValue + sd,
    lowerBand: vwapValue - sd
  };
}

/**
 * Average Directional Index (ADX)
 *
 * Measures trend strength regardless of direction.
 * Uses Wilder's smoothing for +DM, -DM, TR, and DX.
 *
 * @param {Array} candles - Candle array
 * @param {number} [period=14] - ADX period
 * @returns {{ adx: number, plusDI: number, minusDI: number, trend: string }|null}
 */
export function adx(candles, period = 14) {
  // Need at least 2*period candles to compute a stable ADX
  if (!candles || candles.length < 2 * period) return null;

  // Step 1: Calculate +DM, -DM, and TR for each bar
  const plusDM = [];
  const minusDM = [];
  const trValues = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.h - prev.h;
    const downMove = prev.l - curr.l;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trValues.push(trueRange(curr, prev));
  }

  if (trValues.length < period) return null;

  // Step 2: Wilder's smoothed sums for first `period` values
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;
  let smoothedTR = 0;

  for (let i = 0; i < period; i++) {
    smoothedPlusDM += plusDM[i];
    smoothedMinusDM += minusDM[i];
    smoothedTR += trValues[i];
  }

  // Step 3: Calculate DI and DX series using Wilder's smoothing
  const dxValues = [];

  for (let i = period; i < trValues.length; i++) {
    // On first iteration (i === period), use the initial sums
    if (i > period) {
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];
      smoothedTR = smoothedTR - (smoothedTR / period) + trValues[i];
    }

    const pDI = smoothedTR !== 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
    const mDI = smoothedTR !== 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
    const diSum = pDI + mDI;
    const dx = diSum !== 0 ? (Math.abs(pDI - mDI) / diSum) * 100 : 0;

    dxValues.push({ dx, pDI, mDI });
  }

  if (dxValues.length < period) return null;

  // Step 4: ADX = Wilder's smoothed average of DX
  let adxValue = 0;
  for (let i = 0; i < period; i++) {
    adxValue += dxValues[i].dx;
  }
  adxValue /= period;

  for (let i = period; i < dxValues.length; i++) {
    adxValue = (adxValue * (period - 1) + dxValues[i].dx) / period;
  }

  const lastDI = dxValues[dxValues.length - 1];

  // Classify trend strength
  let trend;
  if (adxValue >= 25) trend = 'STRONG';
  else if (adxValue >= 20) trend = 'MODERATE';
  else if (adxValue >= 15) trend = 'WEAK';
  else trend = 'NONE';

  return {
    adx: adxValue,
    plusDI: lastDI.pDI,
    minusDI: lastDI.mDI,
    trend
  };
}

/**
 * Ichimoku Cloud (Ichimoku Kinko Hyo)
 *
 * Tenkan-sen = (highest high + lowest low) / 2 over tenkan period
 * Kijun-sen = (highest high + lowest low) / 2 over kijun period
 * Senkou Span A = (tenkan + kijun) / 2
 * Senkou Span B = (highest high + lowest low) / 2 over senkou period
 *
 * Signal determination based on price vs cloud and TK cross.
 *
 * @param {Array} candles - Candle array
 * @param {number} [tenkan=9] - Tenkan-sen period
 * @param {number} [kijun=26] - Kijun-sen period
 * @param {number} [senkou=52] - Senkou Span B period
 * @returns {{ tenkanSen: number, kijunSen: number, senkouA: number, senkouB: number, signal: string }|null}
 */
export function ichimoku(candles, tenkan = 9, kijun = 26, senkou = 52) {
  if (!candles || candles.length < senkou + 1) return null;

  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const currentClose = candles[candles.length - 1].c;

  // Tenkan-sen: (highest high + lowest low) / 2 over tenkan period
  const tenkanHigh = highest(highs, tenkan);
  const tenkanLow = lowest(lows, tenkan);
  if (tenkanHigh === null || tenkanLow === null) return null;
  const tenkanSen = (tenkanHigh + tenkanLow) / 2;

  // Kijun-sen: (highest high + lowest low) / 2 over kijun period
  const kijunHigh = highest(highs, kijun);
  const kijunLow = lowest(lows, kijun);
  if (kijunHigh === null || kijunLow === null) return null;
  const kijunSen = (kijunHigh + kijunLow) / 2;

  // Senkou Span A: (tenkan + kijun) / 2
  const senkouA = (tenkanSen + kijunSen) / 2;

  // Senkou Span B: (highest high + lowest low) / 2 over senkou period
  const senkouHigh = highest(highs, senkou);
  const senkouLow = lowest(lows, senkou);
  if (senkouHigh === null || senkouLow === null) return null;
  const senkouB = (senkouHigh + senkouLow) / 2;

  // Determine signal
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const tkCrossBullish = tenkanSen > kijunSen;
  const priceAboveCloud = currentClose > cloudTop;
  const priceBelowCloud = currentClose < cloudBottom;

  let signal;
  if (priceAboveCloud && tkCrossBullish) {
    signal = 'STRONG_BULL';
  } else if (priceAboveCloud || tkCrossBullish) {
    signal = 'BULL';
  } else if (priceBelowCloud && !tkCrossBullish) {
    signal = 'STRONG_BEAR';
  } else if (priceBelowCloud || !tkCrossBullish) {
    signal = 'BEAR';
  } else {
    signal = 'NEUTRAL';
  }

  return { tenkanSen, kijunSen, senkouA, senkouB, signal };
}

/**
 * Keltner Channels
 *
 * Middle = EMA(close, emaPeriod)
 * Upper = middle + multiplier * ATR(atrPeriod)
 * Lower = middle - multiplier * ATR(atrPeriod)
 * Squeeze = Bollinger Bands (20,2) fit inside Keltner Channels
 *
 * @param {Array} candles - Candle array
 * @param {number} [emaPeriod=20] - EMA period for middle line
 * @param {number} [atrPeriod=10] - ATR period for channel width
 * @param {number} [multiplier=1.5] - ATR multiplier
 * @returns {{ upper: number, middle: number, lower: number, squeeze: boolean }|null}
 */
export function keltnerChannels(candles, emaPeriod = 20, atrPeriod = 10, multiplier = 1.5) {
  const minCandles = Math.max(emaPeriod, atrPeriod + 1);
  if (!candles || candles.length < minCandles) return null;

  const closes = candles.map(c => c.c);
  const middle = ema(closes, emaPeriod);
  const atrValue = atr(candles, atrPeriod);

  if (middle === null || atrValue === null) return null;

  const upper = middle + multiplier * atrValue;
  const lower = middle - multiplier * atrValue;

  // Squeeze detection: Bollinger Bands inside Keltner Channels
  const bb = bollingerBands(candles, 20, 2);
  let squeeze = false;
  if (bb) {
    squeeze = bb.upper < upper && bb.lower > lower;
  }

  return { upper, middle, lower, squeeze };
}

/**
 * Commodity Channel Index (CCI)
 *
 * CCI = (TP - SMA(TP, period)) / (0.015 * Mean Deviation)
 * Typical Price = (high + low + close) / 3
 *
 * @param {Array} candles - Candle array
 * @param {number} [period=20] - CCI period
 * @returns {{ value: number, signal: string }|null}
 */
export function cci(candles, period = 20) {
  if (!candles || candles.length < period) return null;

  // Calculate typical prices
  const tps = candles.map(c => (c.h + c.l + c.c) / 3);

  const tpSma = sma(tps, period);
  const md = meanDeviation(tps, period);

  if (tpSma === null || md === null) return null;

  const currentTP = tps[tps.length - 1];

  // Avoid division by zero
  const cciValue = md !== 0 ? (currentTP - tpSma) / (0.015 * md) : 0;

  let signal;
  if (cciValue > 100) signal = 'OVERBOUGHT';
  else if (cciValue < -100) signal = 'OVERSOLD';
  else signal = 'NEUTRAL';

  return { value: cciValue, signal };
}

/**
 * Williams %R
 *
 * %R = ((Highest High - Close) / (Highest High - Lowest Low)) * -100
 *
 * Range: -100 to 0
 * Overbought: > -20 (near 0)
 * Oversold: < -80 (near -100)
 *
 * @param {Array} candles - Candle array
 * @param {number} [period=14] - Lookback period
 * @returns {{ value: number, signal: string }|null}
 */
export function williamsR(candles, period = 14) {
  if (!candles || candles.length < period) return null;

  const recentCandles = candles.slice(-period);
  const highestHigh = Math.max(...recentCandles.map(c => c.h));
  const lowestLow = Math.min(...recentCandles.map(c => c.l));
  const currentClose = candles[candles.length - 1].c;

  const range = highestHigh - lowestLow;

  // Avoid division by zero
  const wr = range !== 0
    ? ((highestHigh - currentClose) / range) * -100
    : -50; // Midpoint default when range is zero

  let signal;
  if (wr > -20) signal = 'OVERBOUGHT';
  else if (wr < -80) signal = 'OVERSOLD';
  else signal = 'NEUTRAL';

  return { value: wr, signal };
}

/**
 * Calculate All Indicators
 *
 * Convenience function that runs all 7 indicators and returns results.
 * Any indicator that fails due to insufficient data returns null.
 *
 * @param {Array} candles - Candle array
 * @returns {{ bollingerBands: object|null, vwap: object|null, adx: object|null, ichimoku: object|null, keltnerChannels: object|null, cci: object|null, williamsR: object|null }}
 */
export function calculateAllIndicators(candles) {
  let bbResult = null;
  let vwapResult = null;
  let adxResult = null;
  let ichimokuResult = null;
  let keltnerResult = null;
  let cciResult = null;
  let wrResult = null;

  try { bbResult = bollingerBands(candles); } catch (e) { /* insufficient data */ }
  try { vwapResult = vwap(candles); } catch (e) { /* insufficient data */ }
  try { adxResult = adx(candles); } catch (e) { /* insufficient data */ }
  try { ichimokuResult = ichimoku(candles); } catch (e) { /* insufficient data */ }
  try { keltnerResult = keltnerChannels(candles); } catch (e) { /* insufficient data */ }
  try { cciResult = cci(candles); } catch (e) { /* insufficient data */ }
  try { wrResult = williamsR(candles); } catch (e) { /* insufficient data */ }

  return {
    bollingerBands: bbResult,
    vwap: vwapResult,
    adx: adxResult,
    ichimoku: ichimokuResult,
    keltnerChannels: keltnerResult,
    cci: cciResult,
    williamsR: wrResult
  };
}
