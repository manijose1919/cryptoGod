/**
 * Pair / Spread Trading Service
 *
 * Market-neutral strategy: go long one asset and short another
 * when their historical correlation breaks down.
 * Profits from the spread reverting to the mean regardless of market direction.
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface PairPosition {
  longTicker: string;
  shortTicker: string;
  longQuantity: number;
  shortQuantity: number;
  longEntryPrice: number;
  shortEntryPrice: number;
  entrySpread: number;
  entryZScore: number;
  entryTime: number;
  currentSpread: number;
  currentZScore: number;
  unrealizedPnl: number;
}

export interface PairCorrelation {
  ticker1: string;
  ticker2: string;
  correlation: number;      // -1 to +1
  cointegrated: boolean;    // True if pair is mean-reverting
  halfLife: number;         // How many candles for spread to revert
  currentZScore: number;
  spreadHistory: number[];
}

export interface PairTradeSignal {
  shouldTrade: boolean;
  action: 'OPEN_PAIR' | 'CLOSE_PAIR' | 'NONE';
  longTicker: string;
  shortTicker: string;
  zScore: number;
  confidence: number;
  expectedProfit: number;
  reason: string;
}

// ============================================
// STATE
// ============================================

const pairCorrelations: Map<string, PairCorrelation> = new Map();
const openPairPositions: Map<string, PairPosition> = new Map();

/**
 * Calculate Pearson correlation between two price series
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);

  const xMean = xSlice.reduce((s, v) => s + v, 0) / n;
  const yMean = ySlice.reduce((s, v) => s + v, 0) / n;

  let cov = 0, xVar = 0, yVar = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean;
    const dy = ySlice[i] - yMean;
    cov += dx * dy;
    xVar += dx * dx;
    yVar += dy * dy;
  }

  const denom = Math.sqrt(xVar * yVar);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Calculate the spread between two normalized price series
 */
function calculateNormalizedSpread(prices1: number[], prices2: number[]): number[] {
  const n = Math.min(prices1.length, prices2.length);
  if (n < 2) return [];

  // Normalize to percentage returns from first value
  const base1 = prices1[prices1.length - n];
  const base2 = prices2[prices2.length - n];

  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx1 = prices1.length - n + i;
    const idx2 = prices2.length - n + i;
    const norm1 = prices1[idx1] / base1;
    const norm2 = prices2[idx2] / base2;
    spreads.push(norm1 - norm2);
  }

  return spreads;
}

/**
 * Estimate half-life of mean reversion using OLS regression on spread changes
 */
function estimateHalfLife(spreads: number[]): number {
  if (spreads.length < 20) return 100;

  // Simple mean reversion speed: regress spread[t] - spread[t-1] on spread[t-1]
  const y: number[] = [];
  const x: number[] = [];
  for (let i = 1; i < spreads.length; i++) {
    y.push(spreads[i] - spreads[i - 1]);
    x.push(spreads[i - 1]);
  }

  // OLS: beta = sum(x*y) / sum(x*x)
  const xMean = x.reduce((s, v) => s + v, 0) / x.length;
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;

  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - xMean) * (y[i] - yMean);
    den += (x[i] - xMean) * (x[i] - xMean);
  }

  const beta = den > 0 ? num / den : 0;

  // Half-life = -ln(2) / ln(1 + beta)
  if (beta >= 0) return 100; // Not mean-reverting
  const hl = -Math.log(2) / Math.log(1 + beta);
  return Math.max(1, Math.min(100, hl));
}

/**
 * Analyze a pair of assets for trading potential
 */
export function analyzePair(
  ticker1: string,
  ticker2: string,
  candles1: Candle[],
  candles2: Candle[]
): PairCorrelation {
  const key = `${ticker1}:${ticker2}`;
  const prices1 = candles1.map(c => c.close);
  const prices2 = candles2.map(c => c.close);

  // Calculate correlation
  const correlation = pearsonCorrelation(prices1, prices2);

  // Calculate spread
  const spreadHistory = calculateNormalizedSpread(prices1, prices2);
  const avgSpread = spreadHistory.length > 0
    ? spreadHistory.reduce((s, v) => s + v, 0) / spreadHistory.length : 0;
  const variance = spreadHistory.length > 0
    ? spreadHistory.reduce((s, v) => s + Math.pow(v - avgSpread, 2), 0) / spreadHistory.length : 1;
  const stdDev = Math.sqrt(variance);
  const currentSpread = spreadHistory.length > 0 ? spreadHistory[spreadHistory.length - 1] : 0;
  const currentZScore = stdDev > 0 ? (currentSpread - avgSpread) / stdDev : 0;

  // Estimate half-life
  const halfLife = estimateHalfLife(spreadHistory);

  // Cointegrated if correlation > 0.6 and half-life < 30
  const cointegrated = Math.abs(correlation) > 0.6 && halfLife < 30;

  const pairData: PairCorrelation = {
    ticker1,
    ticker2,
    correlation,
    cointegrated,
    halfLife,
    currentZScore,
    spreadHistory: spreadHistory.slice(-100) // Keep last 100
  };

  pairCorrelations.set(key, pairData);
  return pairData;
}

/**
 * Generate pair trading signals across all available pairs
 */
export function getPairSignals(
  marketData: Record<string, { candles: Candle[] }>
): PairTradeSignal[] {
  const signals: PairTradeSignal[] = [];
  const tickers = Object.keys(marketData);

  // Analyze all possible pairs
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i];
      const t2 = tickers[j];
      const c1 = marketData[t1].candles;
      const c2 = marketData[t2].candles;

      if (c1.length < 30 || c2.length < 30) continue;

      const pairData = analyzePair(t1, t2, c1, c2);

      // Only trade cointegrated pairs
      if (!pairData.cointegrated) continue;

      const key = `${t1}:${t2}`;
      const existingPosition = openPairPositions.get(key);

      if (existingPosition) {
        // Check if spread reverted (close signal)
        if (Math.abs(pairData.currentZScore) < 0.5) {
          signals.push({
            shouldTrade: true,
            action: 'CLOSE_PAIR',
            longTicker: existingPosition.longTicker,
            shortTicker: existingPosition.shortTicker,
            zScore: pairData.currentZScore,
            confidence: 80,
            expectedProfit: Math.abs(existingPosition.entryZScore - pairData.currentZScore) * 0.5,
            reason: `Pair reversion: z-score returned to ${pairData.currentZScore.toFixed(2)} from ${existingPosition.entryZScore.toFixed(2)}`
          });
        }
      } else {
        // Check for new entry (z-score > 2 = spread diverged significantly)
        if (Math.abs(pairData.currentZScore) > 2) {
          const longTicker = pairData.currentZScore < 0 ? t1 : t2;
          const shortTicker = pairData.currentZScore < 0 ? t2 : t1;
          const confidence = Math.min(90, Math.abs(pairData.currentZScore) * 20 + pairData.correlation * 20);

          signals.push({
            shouldTrade: true,
            action: 'OPEN_PAIR',
            longTicker,
            shortTicker,
            zScore: pairData.currentZScore,
            confidence,
            expectedProfit: Math.abs(pairData.currentZScore) * 0.3,
            reason: `Pair divergence: ${t1}/${t2} z=${pairData.currentZScore.toFixed(2)}, corr=${pairData.correlation.toFixed(2)}, halfLife=${pairData.halfLife.toFixed(0)}`
          });
        }
      }
    }
  }

  return signals.sort((a, b) => (b.confidence * b.expectedProfit) - (a.confidence * a.expectedProfit));
}

/**
 * Record a pair trade opening
 */
export function openPairTrade(
  longTicker: string,
  shortTicker: string,
  longPrice: number,
  shortPrice: number,
  longQty: number,
  shortQty: number,
  spread: number,
  zScore: number
): void {
  const key = `${longTicker}:${shortTicker}`;
  openPairPositions.set(key, {
    longTicker,
    shortTicker,
    longQuantity: longQty,
    shortQuantity: shortQty,
    longEntryPrice: longPrice,
    shortEntryPrice: shortPrice,
    entrySpread: spread,
    entryZScore: zScore,
    entryTime: Date.now(),
    currentSpread: spread,
    currentZScore: zScore,
    unrealizedPnl: 0
  });
}

/**
 * Close a pair trade
 */
export function closePairTrade(key: string): PairPosition | null {
  const position = openPairPositions.get(key);
  if (position) {
    openPairPositions.delete(key);
  }
  return position || null;
}

/**
 * Get all open pair positions
 */
export function getOpenPairPositions(): Map<string, PairPosition> {
  return openPairPositions;
}

/**
 * Get all pair correlations
 */
export function getPairCorrelations(): Map<string, PairCorrelation> {
  return pairCorrelations;
}
