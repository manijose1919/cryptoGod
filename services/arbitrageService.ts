/**
 * Cross-Pair Arbitrage Service
 *
 * Detects price inefficiencies between trading pairs.
 * Looks for:
 * 1. Cross-pair arbitrage: price discrepancies between correlated assets
 * 2. Ratio arbitrage: when asset ratios deviate from historical norms
 * 3. Statistical arbitrage: mean reversion on price spreads
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface ArbitrageOpportunity {
  type: 'CROSS_PAIR' | 'RATIO_ARB' | 'STAT_ARB';
  buyTicker: string;
  sellTicker: string;
  spreadPercent: number;     // Current spread as %
  historicalSpread: number;  // Average historical spread
  deviation: number;         // Standard deviations from mean
  confidence: number;        // 0-100
  expectedProfit: number;    // Expected % profit
  reason: string;
  urgency: 'IMMEDIATE' | 'SOON' | 'WATCH';
}

export interface PairRatio {
  ticker1: string;
  ticker2: string;
  currentRatio: number;
  avgRatio: number;
  stdDev: number;
  zScore: number;
  history: number[];
}

export interface ArbitrageSignal {
  hasOpportunity: boolean;
  opportunities: ArbitrageOpportunity[];
  bestOpportunity: ArbitrageOpportunity | null;
}

// ============================================
// PAIR RATIO TRACKING
// ============================================

const pairRatios: Map<string, PairRatio> = new Map();

// Known correlated pairs for crypto
const CORRELATED_PAIRS: [string, string][] = [
  ['BTCUSD', 'ETHUSD'],
  ['ETHUSD', 'SOLUSD'],
  ['BTCUSD', 'SOLUSD'],
  ['DOGEUSD', 'ADAUSD'],
  ['BTCUSD', 'XRPUSD'],
  ['ETHUSD', 'LINKUSD'],
  ['SOLUSD', 'AVAXUSD'],
  ['BTCUSD', 'ADAUSD'],
  ['ETHUSD', 'DOTUSD'],
];

/**
 * Update pair ratio with new prices
 */
function updatePairRatio(
  ticker1: string,
  ticker2: string,
  price1: number,
  price2: number
): PairRatio {
  const key = `${ticker1}/${ticker2}`;
  const ratio = price1 / price2;

  const existing = pairRatios.get(key);
  if (existing) {
    existing.history.push(ratio);
    // Keep last 200 ratios
    if (existing.history.length > 200) {
      existing.history = existing.history.slice(-200);
    }

    existing.currentRatio = ratio;
    existing.avgRatio = existing.history.reduce((s, r) => s + r, 0) / existing.history.length;

    // Calculate standard deviation
    const variance = existing.history.reduce((sum, r) => sum + Math.pow(r - existing.avgRatio, 2), 0) / existing.history.length;
    existing.stdDev = Math.sqrt(variance);
    existing.zScore = existing.stdDev > 0 ? (ratio - existing.avgRatio) / existing.stdDev : 0;

    return existing;
  } else {
    const newRatio: PairRatio = {
      ticker1,
      ticker2,
      currentRatio: ratio,
      avgRatio: ratio,
      stdDev: 0,
      zScore: 0,
      history: [ratio]
    };
    pairRatios.set(key, newRatio);
    return newRatio;
  }
}

/**
 * Calculate price spread between two assets as percentage
 */
function calculateSpread(
  candles1: Candle[],
  candles2: Candle[],
  lookback: number = 50
): { currentSpread: number; avgSpread: number; stdDev: number; zScore: number } {
  const len = Math.min(candles1.length, candles2.length, lookback);
  if (len < 10) return { currentSpread: 0, avgSpread: 0, stdDev: 0, zScore: 0 };

  // Normalize both price series to % change from start
  const base1 = candles1[candles1.length - len].close;
  const base2 = candles2[candles2.length - len].close;

  const spreads: number[] = [];
  for (let i = 0; i < len; i++) {
    const idx1 = candles1.length - len + i;
    const idx2 = candles2.length - len + i;
    const norm1 = (candles1[idx1].close / base1 - 1) * 100;
    const norm2 = (candles2[idx2].close / base2 - 1) * 100;
    spreads.push(norm1 - norm2);
  }

  const currentSpread = spreads[spreads.length - 1];
  const avgSpread = spreads.reduce((s, v) => s + v, 0) / spreads.length;
  const variance = spreads.reduce((s, v) => s + Math.pow(v - avgSpread, 2), 0) / spreads.length;
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? (currentSpread - avgSpread) / stdDev : 0;

  return { currentSpread, avgSpread, stdDev, zScore };
}

/**
 * Detect arbitrage opportunities across all available pairs
 */
export function detectArbitrage(
  marketData: Record<string, { candles: Candle[] }>
): ArbitrageSignal {
  const opportunities: ArbitrageOpportunity[] = [];
  const tickers = Object.keys(marketData);

  // Check each correlated pair
  for (const [t1, t2] of CORRELATED_PAIRS) {
    if (!marketData[t1] || !marketData[t2]) continue;

    const candles1 = marketData[t1].candles;
    const candles2 = marketData[t2].candles;

    if (candles1.length < 20 || candles2.length < 20) continue;

    const price1 = candles1[candles1.length - 1].close;
    const price2 = candles2[candles2.length - 1].close;

    // Update pair ratio
    const ratio = updatePairRatio(t1, t2, price1, price2);

    // Need enough history for meaningful stats
    if (ratio.history.length < 30) continue;

    // Calculate normalized spread
    const spread = calculateSpread(candles1, candles2);

    // STAT ARB: Z-score based mean reversion
    if (Math.abs(spread.zScore) > 1.5) {
      const isBuyFirst = spread.zScore < -1.5; // First asset is relatively cheap
      const confidence = Math.min(95, Math.abs(spread.zScore) * 25);
      const expectedProfit = Math.abs(spread.currentSpread - spread.avgSpread) * 0.6;

      opportunities.push({
        type: 'STAT_ARB',
        buyTicker: isBuyFirst ? t1 : t2,
        sellTicker: isBuyFirst ? t2 : t1,
        spreadPercent: spread.currentSpread,
        historicalSpread: spread.avgSpread,
        deviation: spread.zScore,
        confidence,
        expectedProfit,
        reason: `${isBuyFirst ? t1 : t2} undervalued vs ${isBuyFirst ? t2 : t1}: z-score=${spread.zScore.toFixed(2)}, spread=${spread.currentSpread.toFixed(2)}%`,
        urgency: Math.abs(spread.zScore) > 2.5 ? 'IMMEDIATE' : Math.abs(spread.zScore) > 2 ? 'SOON' : 'WATCH'
      });
    }

    // RATIO ARB: Pair ratio deviated from historical norm
    if (Math.abs(ratio.zScore) > 2 && ratio.history.length >= 50) {
      const isBuyFirst = ratio.zScore < -2;
      const confidence = Math.min(90, Math.abs(ratio.zScore) * 20);
      const expectedProfit = Math.abs(ratio.currentRatio - ratio.avgRatio) / ratio.avgRatio * 100 * 0.5;

      opportunities.push({
        type: 'RATIO_ARB',
        buyTicker: isBuyFirst ? t1 : t2,
        sellTicker: isBuyFirst ? t2 : t1,
        spreadPercent: (ratio.currentRatio / ratio.avgRatio - 1) * 100,
        historicalSpread: 0,
        deviation: ratio.zScore,
        confidence,
        expectedProfit,
        reason: `Ratio arb: ${t1}/${t2} ratio=${ratio.currentRatio.toFixed(4)} vs avg=${ratio.avgRatio.toFixed(4)} (z=${ratio.zScore.toFixed(2)})`,
        urgency: Math.abs(ratio.zScore) > 3 ? 'IMMEDIATE' : 'SOON'
      });
    }
  }

  // CROSS-PAIR: Check for sudden divergence between highly correlated assets
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i];
      const t2 = tickers[j];
      const candles1 = marketData[t1].candles;
      const candles2 = marketData[t2].candles;

      if (candles1.length < 10 || candles2.length < 10) continue;

      // Quick 1-candle change comparison
      const change1 = ((candles1[candles1.length - 1].close - candles1[candles1.length - 2].close) / candles1[candles1.length - 2].close) * 100;
      const change2 = ((candles2[candles2.length - 1].close - candles2[candles2.length - 2].close) / candles2[candles2.length - 2].close) * 100;
      const divergence = Math.abs(change1 - change2);

      // If one moved significantly and the other didn't, it's an opportunity
      if (divergence > 1.0) {
        const laggard = change1 < change2 ? t1 : t2;
        const leader = change1 < change2 ? t2 : t1;
        const leaderChange = Math.max(change1, change2);

        opportunities.push({
          type: 'CROSS_PAIR',
          buyTicker: laggard,
          sellTicker: leader,
          spreadPercent: divergence,
          historicalSpread: 0,
          deviation: divergence,
          confidence: Math.min(80, divergence * 20),
          expectedProfit: divergence * 0.4,
          reason: `Cross-pair divergence: ${leader} moved ${leaderChange.toFixed(2)}%, ${laggard} lagging by ${divergence.toFixed(2)}%`,
          urgency: divergence > 2 ? 'IMMEDIATE' : 'SOON'
        });
      }
    }
  }

  // Sort by expected profit * confidence
  opportunities.sort((a, b) => (b.expectedProfit * b.confidence) - (a.expectedProfit * a.confidence));

  return {
    hasOpportunity: opportunities.length > 0,
    opportunities: opportunities.slice(0, 5), // Top 5
    bestOpportunity: opportunities[0] || null
  };
}

/**
 * Get pair ratio data for display
 */
export function getPairRatios(): Map<string, PairRatio> {
  return pairRatios;
}

/**
 * Reset all arbitrage tracking
 */
export function resetArbitrage(): void {
  pairRatios.clear();
}
