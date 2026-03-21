// ============================================
// Trend Dashboard — Ported from PineScript
// Multi-indicator consensus: RSI, Stochastic, MACD, SMA50/100/200
// Returns bullish/bearish count out of 6 indicators
// ============================================

import type { Candle } from '../pipeline/types.ts';
import { sma, rsi as computeRsi, macd as computeMacd } from './indicators.ts';

// --- Types ---

export interface DashboardSignal {
  name: string;
  bullish: boolean;
  value: string;
}

export interface TrendDashboardResult {
  /** Individual indicator signals */
  signals: DashboardSignal[];
  /** Number of bullish signals (0-6) */
  bullishCount: number;
  /** Number of bearish signals (0-6) */
  bearishCount: number;
  /** Consensus score: bullishCount / 6 → 0-100 */
  score: number;
  /** Overall verdict */
  verdict: 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';
}

// --- Stochastic Oscillator ---

/**
 * Stochastic %K and %D
 * %K = SMA( (close - lowest_low) / (highest_high - lowest_low) * 100, smoothK )
 * %D = SMA(%K, periodD)
 */
function stochastic(
  candles: Candle[],
  periodK: number = 14,
  smoothK: number = 3,
  periodD: number = 3,
): { k: number[]; d: number[] } {
  const len = candles.length;
  if (len < periodK) {
    return { k: new Array(len).fill(50), d: new Array(len).fill(50) };
  }

  // Raw stochastic
  const rawK: number[] = new Array(len).fill(NaN);
  for (let i = periodK - 1; i < len; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;
    for (let j = i - periodK + 1; j <= i; j++) {
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
    }
    const range = highestHigh - lowestLow;
    rawK[i] = range > 0 ? ((candles[i].close - lowestLow) / range) * 100 : 50;
  }

  // Smooth %K with SMA
  const k = sma(rawK.map((v) => (isNaN(v) ? 50 : v)), smoothK);
  // %D = SMA of %K
  const d = sma(k.map((v) => (isNaN(v) ? 50 : v)), periodD);

  return { k, d };
}

// --- Main Computation ---

/**
 * Compute the 6-indicator Trend Dashboard.
 * Each indicator votes bullish or bearish:
 *   1. RSI > 50
 *   2. Stochastic %K > %D
 *   3. MACD > Signal
 *   4. Price > SMA(50)
 *   5. Price > SMA(100)
 *   6. Price > SMA(200)
 */
export function computeTrendDashboard(candles: Candle[]): TrendDashboardResult {
  const defaultResult: TrendDashboardResult = {
    signals: [],
    bullishCount: 0,
    bearishCount: 0,
    score: 50,
    verdict: 'neutral',
  };

  if (candles.length < 200) {
    // Need at least 200 candles for SMA(200)
    // Fall back to what we can compute
    if (candles.length < 50) return defaultResult;
  }

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];
  const lastIdx = closes.length - 1;

  const signals: DashboardSignal[] = [];

  // 1. RSI(14) > 50
  const rsiValues = computeRsi(closes, 14);
  const lastRsi = rsiValues[lastIdx] ?? 50;
  const rsiBull = lastRsi > 50;
  signals.push({ name: 'RSI', bullish: rsiBull, value: lastRsi.toFixed(1) });

  // 2. Stochastic %K > %D
  const stoch = stochastic(candles, 14, 3, 3);
  const lastK = stoch.k[lastIdx] ?? 50;
  const lastD = stoch.d[lastIdx] ?? 50;
  const stochBull = lastK > lastD;
  signals.push({ name: 'Stoch', bullish: stochBull, value: `K=${lastK.toFixed(1)} D=${lastD.toFixed(1)}` });

  // 3. MACD > Signal (using 12/25/9 to match PineScript)
  const macdResult = computeMacd(closes, 12, 25, 9);
  const lastMacd = macdResult.macd[lastIdx] ?? 0;
  const lastSignal = macdResult.signal[lastIdx] ?? 0;
  const macdBull = lastMacd > lastSignal;
  signals.push({ name: 'MACD', bullish: macdBull, value: `${lastMacd.toFixed(4)} vs ${lastSignal.toFixed(4)}` });

  // 4. Price > SMA(50)
  const sma50 = sma(closes, 50);
  const lastSma50 = sma50[lastIdx];
  const ma50Bull = !isNaN(lastSma50) && currentPrice > lastSma50;
  signals.push({ name: 'SMA50', bullish: ma50Bull, value: isNaN(lastSma50) ? 'N/A' : lastSma50.toFixed(2) });

  // 5. Price > SMA(100)
  const sma100 = sma(closes, 100);
  const lastSma100 = sma100[lastIdx];
  const ma100Bull = !isNaN(lastSma100) && currentPrice > lastSma100;
  signals.push({ name: 'SMA100', bullish: ma100Bull, value: isNaN(lastSma100) ? 'N/A' : lastSma100.toFixed(2) });

  // 6. Price > SMA(200)
  const sma200 = sma(closes, 200);
  const lastSma200 = sma200[lastIdx];
  const ma200Bull = !isNaN(lastSma200) && currentPrice > lastSma200;
  signals.push({ name: 'SMA200', bullish: ma200Bull, value: isNaN(lastSma200) ? 'N/A' : lastSma200.toFixed(2) });

  const bullishCount = signals.filter((s) => s.bullish).length;
  const bearishCount = signals.filter((s) => !s.bullish).length;
  const score = (bullishCount / 6) * 100;

  let verdict: TrendDashboardResult['verdict'];
  if (bullishCount >= 5) verdict = 'strong_bull';
  else if (bullishCount >= 4) verdict = 'bull';
  else if (bullishCount <= 1) verdict = 'strong_bear';
  else if (bullishCount <= 2) verdict = 'bear';
  else verdict = 'neutral';

  return { signals, bullishCount, bearishCount, score, verdict };
}
