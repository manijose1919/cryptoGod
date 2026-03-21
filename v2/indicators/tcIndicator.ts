// ============================================
// TC (Trend Composite) Indicator — Ported from PineScript
// Volume-weighted momentum oscillator (0-100)
// Below 20 = BUY zone (accumulation)
// Above 80 = SELL zone (distribution)
// ============================================

import type { Candle } from '../pipeline/types.ts';

// --- Types ---

export interface TCResult {
  /** TC value at each bar (0-100 oscillator) */
  values: number[];
  /** TC value at the last bar */
  current: number;
  /** True if TC crossed below 20 (buy signal) */
  pumpCross: boolean;
  /** True if TC crossed above 80 (sell signal) */
  dropCross: boolean;
  /** Current zone: 'buy' (<20), 'sell' (>80), 'neutral' */
  zone: 'buy' | 'sell' | 'neutral';
}

export interface MultiTimeframeTCResult {
  /** TC result for each timeframe */
  timeframes: Record<string, TCResult>;
  /** Consensus score: average of all TF current values, inverted to 0-100 buy scale */
  consensus: number;
  /** Number of timeframes in buy zone */
  buyCount: number;
  /** Number of timeframes in sell zone */
  sellCount: number;
  /** Overall signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell' */
  signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
}

// --- Core TC Computation ---

/**
 * Close Location Value: where within the bar range the close sits.
 * Returns -1 (close=low) to +1 (close=high), 0 if bar has no range.
 */
function closLocationValue(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  if (candle.close === candle.high && candle.close === candle.low) return 0;
  return (2 * candle.close - candle.low - candle.high) / range;
}

/**
 * Rolling sum over the last `period` values.
 * Returns NaN for indices with insufficient data.
 */
function rollingSum(data: number[], period: number): number[] {
  const result = new Array<number>(data.length).fill(NaN);
  if (data.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum;

  for (let i = period; i < data.length; i++) {
    sum = sum - data[i - period] + data[i];
    result[i] = sum;
  }
  return result;
}

/**
 * Volume-Weighted RSI formula.
 * topSum = sum of (volume * price) when price is rising
 * bottomSum = sum of (volume * price) when price is falling
 * Result = 100 - 100 / (1 + topSum / bottomSum)  → 0-100 scale
 */
function volumeWeightedRSI(
  prices: number[],
  volumes: number[],
  period: number,
): number[] {
  if (prices.length < period + 1) return new Array(prices.length).fill(50);

  // Compute per-bar buying / selling volume-weighted values
  const buyPressure = new Array<number>(prices.length).fill(0);
  const sellPressure = new Array<number>(prices.length).fill(0);

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      buyPressure[i] = volumes[i] * prices[i];
    } else if (change < 0) {
      sellPressure[i] = volumes[i] * prices[i];
    }
    // If change === 0, both remain 0 for this bar
  }

  // Rolling sums
  const topSum = rollingSum(buyPressure, period);
  const bottomSum = rollingSum(sellPressure, period);

  // RSI formula
  return topSum.map((top, i) => {
    const bottom = bottomSum[i];
    if (isNaN(top) || isNaN(bottom)) return 50;
    if (bottom === 0) return 100;
    if (top === 0) return 0;
    return 100 - 100 / (1 + top / bottom);
  });
}

/**
 * Compute TC (Trend Composite) indicator for a set of candles.
 *
 * TC = vwRSI_8(ohlc4) + CLV + CLV/vwRSI_20(close)
 *
 * Where:
 *   vwRSI_8(ohlc4) = Volume-weighted RSI of OHLC4 over 8 periods
 *   vwRSI_20(close) = Volume-weighted RSI of close over 20 periods
 *   CLV = Close Location Value (-1 to +1)
 */
export function computeTC(candles: Candle[]): TCResult {
  const defaultResult: TCResult = {
    values: [],
    current: 50,
    pumpCross: false,
    dropCross: false,
    zone: 'neutral',
  };

  if (candles.length < 21) return defaultResult;

  const ohlc4 = candles.map((c) => (c.open + c.high + c.low + c.close) / 4);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  // Component 1: Volume-weighted RSI on OHLC4, period 8
  const trendline = volumeWeightedRSI(ohlc4, volumes, 8);

  // Component 2: Volume-weighted RSI on Close, period 20
  const trendline2 = volumeWeightedRSI(closes, volumes, 20);

  // Component 3: Close Location Value per bar
  const clv = candles.map((c) => closLocationValue(c));

  // Combine: TC = trendline + clv/trendline2 + clv
  const values = trendline.map((tl, i) => {
    const tl2 = trendline2[i];
    const clvVal = clv[i];

    if (isNaN(tl) || isNaN(tl2)) return 50;

    // Guard division by zero
    const clvAdjustment = tl2 !== 0 ? clvVal / tl2 : 0;
    let tc = tl + clvAdjustment + clvVal;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, tc));
  });

  const lastIdx = values.length - 1;
  const current = values[lastIdx];
  const prev = lastIdx > 0 ? values[lastIdx - 1] : 50;

  // Crossover detection
  const pumpCross = prev >= 20 && current < 20;  // TC dropped below 20 = buy
  const dropCross = prev <= 80 && current > 80;  // TC rose above 80 = sell

  const zone: TCResult['zone'] =
    current < 20 ? 'buy' :
    current > 80 ? 'sell' :
    'neutral';

  return { values, current, pumpCross, dropCross, zone };
}

/**
 * Aggregate candles into a higher timeframe.
 * E.g., 200 1-minute candles → 13 15-minute candles.
 */
export function aggregateCandles(candles: Candle[], targetMinutes: number, sourceMinutes: number): Candle[] {
  if (candles.length === 0) return [];

  const ratio = Math.max(1, Math.round(targetMinutes / sourceMinutes));
  if (ratio <= 1) return candles; // Already at target or finer

  const aggregated: Candle[] = [];
  for (let i = 0; i < candles.length; i += ratio) {
    const chunk = candles.slice(i, i + ratio);
    if (chunk.length === 0) continue;

    aggregated.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return aggregated;
}

/**
 * Compute TC across multiple timeframes from a single set of base candles.
 * Aggregates base candles into 15m, 1h, 4h, 1D timeframes and computes TC on each.
 *
 * @param candles - Base timeframe candles (e.g., 15m)
 * @param baseMinutes - Base candle interval in minutes (e.g., 15)
 */
export function computeMultiTimeframeTC(
  candles: Candle[],
  baseMinutes: number,
): MultiTimeframeTCResult {
  // Define target timeframes (in minutes)
  const timeframes: Record<string, number> = {
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1D': 1440,
  };

  const results: Record<string, TCResult> = {};
  let buyCount = 0;
  let sellCount = 0;
  let tcSum = 0;
  let tfCount = 0;

  for (const [label, minutes] of Object.entries(timeframes)) {
    // Only compute for timeframes >= base
    if (minutes < baseMinutes) continue;

    const aggregated = minutes === baseMinutes
      ? candles
      : aggregateCandles(candles, minutes, baseMinutes);

    if (aggregated.length < 21) continue;

    const tc = computeTC(aggregated);
    results[label] = tc;
    tcSum += tc.current;
    tfCount++;

    if (tc.zone === 'buy') buyCount++;
    if (tc.zone === 'sell') sellCount++;
  }

  // Consensus: invert TC (low TC = buy) to a 0-100 buy score
  // TC 0 → buy score 100, TC 100 → buy score 0
  const avgTc = tfCount > 0 ? tcSum / tfCount : 50;
  const consensus = 100 - avgTc;

  // Signal based on consensus and zone counts
  let signal: MultiTimeframeTCResult['signal'];
  if (buyCount >= 3 || consensus > 80) signal = 'strong_buy';
  else if (buyCount >= 2 || consensus > 65) signal = 'buy';
  else if (sellCount >= 3 || consensus < 20) signal = 'strong_sell';
  else if (sellCount >= 2 || consensus < 35) signal = 'sell';
  else signal = 'neutral';

  return { timeframes: results, consensus, buyCount, sellCount, signal };
}
