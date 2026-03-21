// ============================================
// Phoenix V2 Indicators — Pure Functions
// No caching, no side effects, no global state
// ============================================

import type { Candle, Regime, SignalSnapshot } from '../pipeline/types.ts';
import { REGIME } from '../pipeline/types.ts';
import { computeTC, computeMultiTimeframeTC } from './tcIndicator.ts';
import { computeSupportResistance } from './supportResistance.ts';
import { computeTrendDashboard } from './trendDashboard.ts';

// --- Local Result Types ---

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export interface BollingerBands {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
  percentB: number[];
}

export interface RegimeResult {
  regime: Regime;
  trendStrength: number;
  atrPercent: number;
}

// --- Core Indicators ---

/**
 * Exponential Moving Average — O(n) single pass
 * k = 2 / (period + 1)
 */
export function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const result: number[] = new Array(data.length);
  const k = 2 / (period + 1);
  result[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Simple Moving Average — O(n) sliding window
 * Returns NaN for indices with insufficient data
 */
export function sma(data: number[], period: number): number[] {
  if (data.length < period) return new Array(data.length).fill(NaN);

  const result: number[] = new Array(data.length);
  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += data[i];
    result[i] = NaN;
  }
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    sum = sum - data[i - period] + data[i];
    result[i] = sum / period;
  }
  return result;
}

/**
 * Wilder's Moving Average (RMA) — used in RSI and ATR
 * alpha = 1 / period
 */
function rma(data: number[], period: number): number[] {
  if (data.length < period) return new Array(data.length).fill(NaN);

  const result: number[] = new Array(data.length).fill(NaN);
  const alpha = 1 / period;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    result[i] = alpha * data[i] + (1 - alpha) * result[i - 1];
  }
  return result;
}

/**
 * Standard Deviation — O(n) sliding window
 */
function stdDev(data: number[], period: number): number[] {
  if (data.length < period) return new Array(data.length).fill(NaN);

  const result: number[] = new Array(data.length).fill(NaN);
  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < period; i++) {
    sum += data[i];
    sumSquares += data[i] * data[i];
  }

  const mean0 = sum / period;
  const variance0 = sumSquares / period - mean0 * mean0;
  result[period - 1] = Math.sqrt(Math.max(0, variance0));

  for (let i = period; i < data.length; i++) {
    const oldVal = data[i - period];
    const newVal = data[i];
    sum = sum - oldVal + newVal;
    sumSquares = sumSquares - oldVal * oldVal + newVal * newVal;
    const mean = sum / period;
    const variance = sumSquares / period - mean * mean;
    result[i] = Math.sqrt(Math.max(0, variance));
  }
  return result;
}

// --- Exported Indicators ---

/**
 * Wilder's RSI with proper gain/loss smoothing
 * Returns array of RSI values (0-100). NaN-fill indices default to 50.
 */
export function rsi(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);

  const changes: number[] = new Array(closes.length);
  changes[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    changes[i] = closes[i] - closes[i - 1];
  }

  const gains = changes.map((c) => Math.max(c, 0));
  const losses = changes.map((c) => Math.max(-c, 0));

  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);

  return avgGain.map((ag, i) => {
    const al = avgLoss[i];
    if (isNaN(ag) || isNaN(al)) return 50;
    if (al === 0) return 100;
    if (ag === 0) return 0;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  });
}

/**
 * MACD — Moving Average Convergence Divergence
 * Returns macd line, signal line, and histogram arrays
 */
export function macd(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  sig: number = 9,
): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    macdLine[i] = emaFast[i] - emaSlow[i];
  }

  const signalLine = ema(macdLine, sig);

  const histogram: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    histogram[i] = macdLine[i] - signalLine[i];
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Average True Range — True Range with Wilder's smoothing (RMA)
 */
export function atr(candles: Candle[], period: number = 14): number[] {
  if (candles.length < period + 1) return new Array(candles.length).fill(0);

  const trueRanges: number[] = [candles[0].high - candles[0].low];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(tr);
  }

  return rma(trueRanges, period);
}

/**
 * Bollinger Bands — SMA ± mult * stdDev
 * Returns upper, middle, lower, width, and percentB arrays
 */
export function bollingerBands(
  closes: number[],
  period: number = 20,
  mult: number = 2,
): BollingerBands {
  const middle = sma(closes, period);
  const sd = stdDev(closes, period);

  const upper: number[] = new Array(closes.length);
  const lower: number[] = new Array(closes.length);
  const width: number[] = new Array(closes.length);
  const percentB: number[] = new Array(closes.length);

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i]) || isNaN(sd[i])) {
      upper[i] = NaN;
      lower[i] = NaN;
      width[i] = NaN;
      percentB[i] = NaN;
    } else {
      upper[i] = middle[i] + sd[i] * mult;
      lower[i] = middle[i] - sd[i] * mult;
      const bandWidth = upper[i] - lower[i];
      width[i] = middle[i] !== 0 ? bandWidth / middle[i] : 0;
      percentB[i] = bandWidth !== 0 ? (closes[i] - lower[i]) / bandWidth : 0.5;
    }
  }

  return { upper, middle, lower, width, percentB };
}

// --- Regime Detection ---

/**
 * Detect market regime using EMA20/50, RSI, and ATR
 * Returns STRONG_UP, UP, SIDEWAYS, DOWN, or STRONG_DOWN
 */
export function detectRegime(candles: Candle[]): RegimeResult {
  const defaultResult: RegimeResult = {
    regime: REGIME.SIDEWAYS,
    trendStrength: 0,
    atrPercent: 0,
  };

  if (candles.length < 50) return defaultResult;

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiValues = rsi(closes, 14);
  const atrValues = atr(candles, 14);

  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const lastRsi = rsiValues[rsiValues.length - 1];
  const lastAtr = atrValues[atrValues.length - 1];

  const atrPercent = currentPrice !== 0 ? (lastAtr / currentPrice) * 100 : 0;

  // Trend strength: distance between EMA20 and EMA50 as % of price
  const emaDiff = lastEma50 !== 0
    ? ((lastEma20 - lastEma50) / lastEma50) * 100
    : 0;

  // Price position relative to EMAs
  const priceAboveEma20 = currentPrice > lastEma20;
  const priceAboveEma50 = currentPrice > lastEma50;
  const ema20AboveEma50 = lastEma20 > lastEma50;

  // Classify regime
  let regime: Regime;
  let trendStrength: number;

  if (priceAboveEma20 && priceAboveEma50 && ema20AboveEma50 && lastRsi > 60 && emaDiff > 1.0) {
    regime = REGIME.STRONG_UP;
    trendStrength = Math.min(100, emaDiff * 20 + (lastRsi - 50));
  } else if (priceAboveEma50 && ema20AboveEma50 && lastRsi > 50) {
    regime = REGIME.UP;
    trendStrength = Math.min(80, emaDiff * 15 + (lastRsi - 45));
  } else if (!priceAboveEma20 && !priceAboveEma50 && !ema20AboveEma50 && lastRsi < 40 && emaDiff < -1.0) {
    regime = REGIME.STRONG_DOWN;
    trendStrength = Math.min(100, Math.abs(emaDiff) * 20 + (50 - lastRsi));
  } else if (!priceAboveEma50 && !ema20AboveEma50 && lastRsi < 50) {
    regime = REGIME.DOWN;
    trendStrength = Math.min(80, Math.abs(emaDiff) * 15 + (55 - lastRsi));
  } else {
    regime = REGIME.SIDEWAYS;
    trendStrength = Math.max(0, 30 - Math.abs(emaDiff) * 10);
  }

  trendStrength = Math.max(0, Math.min(100, trendStrength));

  return { regime, trendStrength, atrPercent };
}

// --- Full Signal Computation ---

/**
 * Compute all indicators at the current (last) bar
 * Returns a flat object of signal values + regime info
 */
export function computeSignals(candles: Candle[]): { signals: SignalSnapshot; regime: RegimeResult } {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const currentPrice = closes[closes.length - 1] ?? 0;

  // Indicators
  const rsiValues = rsi(closes, 14);
  const macdResult = macd(closes, 12, 26, 9);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const ema50 = ema(closes, 50);
  const atrValues = atr(candles, 14);
  const bb = bollingerBands(closes, 20, 2);
  const volSma = sma(volumes, 20);

  // Get last values
  const len = closes.length;
  const lastIdx = len - 1;

  const lastRsi = rsiValues[lastIdx] ?? 50;
  const lastMacdValue = macdResult.macd[lastIdx] ?? 0;
  const lastMacdSignal = macdResult.signal[lastIdx] ?? 0;
  const lastMacdHist = macdResult.histogram[lastIdx] ?? 0;
  const prevMacdHist = lastIdx > 0 ? (macdResult.histogram[lastIdx - 1] ?? 0) : 0;
  const macdCross = prevMacdHist < 0 && lastMacdHist >= 0;

  const lastEma12 = ema12[lastIdx] ?? currentPrice;
  const lastEma26 = ema26[lastIdx] ?? currentPrice;
  const lastEma50Val = ema50[lastIdx] ?? currentPrice;
  const lastAtr = atrValues[lastIdx] ?? 0;
  const atrPercent = currentPrice !== 0 ? (lastAtr / currentPrice) * 100 : 0;

  const lastBbUpper = bb.upper[lastIdx] ?? currentPrice;
  const lastBbLower = bb.lower[lastIdx] ?? currentPrice;
  const lastBbWidth = bb.width[lastIdx] ?? 0;
  const lastBbPercentB = bb.percentB[lastIdx] ?? 0.5;

  const lastVolSma = volSma[lastIdx] ?? 1;
  const currentVol = volumes[lastIdx] ?? 0;
  const volumeRatio = lastVolSma > 0 ? currentVol / lastVolSma : 1;

  // Regime
  const regimeResult = detectRegime(candles);

  // Price vs EMA50
  const priceVsEma50 = lastEma50Val !== 0
    ? (currentPrice - lastEma50Val) / lastEma50Val
    : 0;

  // TC (Trend Composite) indicator
  const tcResult = computeTC(candles);
  // Multi-timeframe TC (assumes 15m base, the V2 default)
  const mtfTc = computeMultiTimeframeTC(candles, 15);

  // Support/Resistance levels
  const srResult = computeSupportResistance(candles, 12, 0.003);

  // Trend Dashboard (6-indicator consensus)
  const dashResult = computeTrendDashboard(candles);

  const signals: SignalSnapshot = {
    rsi: lastRsi,
    macd_value: lastMacdValue,
    macd_signal: lastMacdSignal,
    macd_histogram: lastMacdHist,
    macd_cross: macdCross,
    ema_12: lastEma12,
    ema_26: lastEma26,
    ema_50: lastEma50Val,
    atr: lastAtr,
    atr_percent: atrPercent,
    bb_upper: lastBbUpper,
    bb_lower: lastBbLower,
    bb_width: lastBbWidth,
    bb_percent_b: lastBbPercentB,
    volume_ratio: volumeRatio,
    trend_strength: regimeResult.trendStrength,
    price_vs_ema50: priceVsEma50,
    close_price: currentPrice,
    // TC indicators
    tc_value: tcResult.current,
    tc_zone: tcResult.zone,
    tc_consensus: mtfTc.consensus,
    // Support/Resistance
    sr_channel_position: srResult.channelPosition,
    sr_support_distance: srResult.supportDistance,
    sr_resistance_distance: srResult.resistanceDistance,
    // Trend Dashboard
    td_score: dashResult.score,
    td_bullish_count: dashResult.bullishCount,
  };

  return { signals, regime: regimeResult };
}
