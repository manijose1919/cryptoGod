/**
 * Smart DCA (Dollar Cost Averaging) Bot Service
 *
 * Automated periodic buying with intelligence:
 * - Schedule-based buys (every N minutes/hours)
 * - Smart sizing: buys MORE on dips, LESS on pumps
 * - Uses existing dip detection from surgeTradingService
 * - Tracks average entry price and unrealized PnL
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface DCAConfig {
  intervalMs: number;        // Time between buys
  baseAmount: number;        // Base USD amount per buy
  maxMultiplier: number;     // Max multiplier on dips (e.g., 3x)
  minMultiplier: number;     // Min multiplier on pumps (e.g., 0.3x)
  dipThresholdPercent: number;  // % drop to trigger extra buying
  pumpThresholdPercent: number; // % rise to reduce buying
  enabled: boolean;
}

export interface DCAPosition {
  ticker: string;
  totalInvested: number;
  totalQuantity: number;
  avgEntryPrice: number;
  buys: number;
  lastBuyTime: number;
  lastBuyPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface DCASignal {
  shouldBuy: boolean;
  ticker: string;
  amount: number;
  multiplier: number;
  reason: string;
  dipPercent: number;
  avgPrice: number;
}

// ============================================
// DCA STATE
// ============================================

const dcaPositions: Map<string, DCAPosition> = new Map();
const dcaConfigs: Map<string, DCAConfig> = new Map();
let lastDCACheck = 0;

const DEFAULT_DCA_CONFIG: DCAConfig = {
  intervalMs: 5 * 60 * 1000,     // Every 5 minutes
  baseAmount: 0,                  // Set based on portfolio
  maxMultiplier: 3.0,            // Buy 3x on big dips
  minMultiplier: 0.3,            // Buy 0.3x on pumps
  dipThresholdPercent: 1.0,      // 1% dip triggers extra
  pumpThresholdPercent: 1.0,     // 1% pump reduces buying
  enabled: true
};

/**
 * Initialize DCA for a ticker
 */
export function initDCA(ticker: string, config?: Partial<DCAConfig>): void {
  dcaConfigs.set(ticker, { ...DEFAULT_DCA_CONFIG, ...config });
}

/**
 * Calculate smart DCA multiplier based on price action
 * Buys MORE when price is low relative to recent average
 * Buys LESS when price is high relative to recent average
 */
function calculateSmartMultiplier(
  candles: Candle[],
  config: DCAConfig,
  position: DCAPosition | undefined
): { multiplier: number; dipPercent: number; reason: string } {
  if (candles.length < 10) {
    return { multiplier: 1, dipPercent: 0, reason: 'Insufficient data, using base amount' };
  }

  const currentPrice = candles[candles.length - 1].close;

  // Compare to recent averages
  const prices20 = candles.slice(-20).map(c => c.close);
  const avg20 = prices20.reduce((s, p) => s + p, 0) / prices20.length;

  const prices50 = candles.slice(-Math.min(50, candles.length)).map(c => c.close);
  const avg50 = prices50.reduce((s, p) => s + p, 0) / prices50.length;

  // Recent high for dip calculation
  const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
  const dipFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;

  // Recent low for bounce calculation
  const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
  const bounceFromLow = ((currentPrice - recentLow) / recentLow) * 100;

  // Below average price = buy more
  const priceVsAvg = ((currentPrice - avg20) / avg20) * 100;

  let multiplier = 1;
  let reason = '';

  if (dipFromHigh > config.dipThresholdPercent * 3) {
    // Major dip: 3x or more below recent high
    multiplier = config.maxMultiplier;
    reason = `Major dip: ${dipFromHigh.toFixed(1)}% from high → ${multiplier}x buy`;
  } else if (dipFromHigh > config.dipThresholdPercent * 2) {
    // Moderate dip
    multiplier = 2.0;
    reason = `Moderate dip: ${dipFromHigh.toFixed(1)}% from high → ${multiplier}x buy`;
  } else if (dipFromHigh > config.dipThresholdPercent) {
    // Small dip
    multiplier = 1.5;
    reason = `Small dip: ${dipFromHigh.toFixed(1)}% from high → ${multiplier}x buy`;
  } else if (priceVsAvg < -config.dipThresholdPercent) {
    // Below average
    multiplier = 1.3;
    reason = `Below avg: ${priceVsAvg.toFixed(1)}% vs MA20 → ${multiplier}x buy`;
  } else if (priceVsAvg > config.pumpThresholdPercent * 2) {
    // Well above average - buy less
    multiplier = config.minMultiplier;
    reason = `Above avg: +${priceVsAvg.toFixed(1)}% vs MA20 → ${multiplier}x buy (reduced)`;
  } else if (priceVsAvg > config.pumpThresholdPercent) {
    // Slightly above average
    multiplier = 0.7;
    reason = `Slightly above avg → ${multiplier}x buy`;
  } else {
    reason = `Normal range → 1x buy`;
  }

  // If we have a position, buy more if price is below our average
  if (position && currentPrice < position.avgEntryPrice * 0.98) {
    const belowAvg = ((position.avgEntryPrice - currentPrice) / position.avgEntryPrice) * 100;
    multiplier = Math.min(config.maxMultiplier, multiplier * 1.3);
    reason += ` | Below avg entry by ${belowAvg.toFixed(1)}%`;
  }

  return {
    multiplier: Math.max(config.minMultiplier, Math.min(config.maxMultiplier, multiplier)),
    dipPercent: dipFromHigh,
    reason
  };
}

/**
 * Process DCA logic for a ticker - returns buy signal if it's time
 */
export function processDCA(
  ticker: string,
  candles: Candle[],
  cashAvailable: number,
  portfolioBudget: number
): DCASignal | null {
  if (candles.length < 5) return null;

  // Get or create config
  let config = dcaConfigs.get(ticker);
  if (!config) {
    config = { ...DEFAULT_DCA_CONFIG };
    config.baseAmount = portfolioBudget * 0.02; // 2% of portfolio per DCA buy
    dcaConfigs.set(ticker, config);
  }

  if (!config.enabled) return null;

  // Set base amount if not set
  if (config.baseAmount <= 0) {
    config.baseAmount = portfolioBudget * 0.02;
  }

  // Check timing - is it time for a DCA buy?
  const now = Date.now();
  const position = dcaPositions.get(ticker);
  const lastBuy = position?.lastBuyTime || 0;

  if (now - lastBuy < config.intervalMs) {
    return null; // Not time yet
  }

  const currentPrice = candles[candles.length - 1].close;

  // Calculate smart multiplier
  const { multiplier, dipPercent, reason } = calculateSmartMultiplier(candles, config, position);
  const buyAmount = Math.min(config.baseAmount * multiplier, cashAvailable * 0.1);

  if (buyAmount < 1) return null; // Too small

  return {
    shouldBuy: true,
    ticker,
    amount: buyAmount,
    multiplier,
    reason: `DCA: ${reason}`,
    dipPercent,
    avgPrice: position?.avgEntryPrice || currentPrice
  };
}

/**
 * Record a DCA buy
 */
export function recordDCABuy(ticker: string, price: number, quantity: number, amount: number): void {
  const existing = dcaPositions.get(ticker);

  if (existing) {
    const totalQty = existing.totalQuantity + quantity;
    const totalInvested = existing.totalInvested + amount;
    dcaPositions.set(ticker, {
      ...existing,
      totalInvested,
      totalQuantity: totalQty,
      avgEntryPrice: totalInvested / totalQty,
      buys: existing.buys + 1,
      lastBuyTime: Date.now(),
      lastBuyPrice: price,
      unrealizedPnl: (price - totalInvested / totalQty) * totalQty,
      unrealizedPnlPercent: ((price - totalInvested / totalQty) / (totalInvested / totalQty)) * 100
    });
  } else {
    dcaPositions.set(ticker, {
      ticker,
      totalInvested: amount,
      totalQuantity: quantity,
      avgEntryPrice: price,
      buys: 1,
      lastBuyTime: Date.now(),
      lastBuyPrice: price,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0
    });
  }
}

/**
 * Update unrealized PnL for all DCA positions
 */
export function updateDCAPnL(prices: Record<string, number>): void {
  for (const [ticker, position] of dcaPositions) {
    const currentPrice = prices[ticker];
    if (currentPrice) {
      position.unrealizedPnl = (currentPrice - position.avgEntryPrice) * position.totalQuantity;
      position.unrealizedPnlPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
    }
  }
}

/**
 * Check if DCA position should take profit
 */
export function checkDCATakeProfit(
  ticker: string,
  currentPrice: number,
  targetPercent: number = 5
): { shouldSell: boolean; pnlPercent: number; reason: string } {
  const position = dcaPositions.get(ticker);
  if (!position) return { shouldSell: false, pnlPercent: 0, reason: 'No position' };

  const pnlPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;

  if (pnlPercent >= targetPercent) {
    return {
      shouldSell: true,
      pnlPercent,
      reason: `DCA take profit: +${pnlPercent.toFixed(2)}% (avg entry: ${position.avgEntryPrice.toFixed(2)})`
    };
  }

  return { shouldSell: false, pnlPercent, reason: `DCA PnL: ${pnlPercent.toFixed(2)}%` };
}

/**
 * Get all DCA positions
 */
export function getDCAPositions(): Map<string, DCAPosition> {
  return dcaPositions;
}

/**
 * Clear DCA position after selling
 */
export function clearDCAPosition(ticker: string): void {
  dcaPositions.delete(ticker);
}

/**
 * Get DCA summary stats
 */
export function getDCASummary(): {
  totalInvested: number;
  totalPositions: number;
  totalUnrealizedPnl: number;
  avgReturn: number;
} {
  let totalInvested = 0;
  let totalPnl = 0;

  for (const position of dcaPositions.values()) {
    totalInvested += position.totalInvested;
    totalPnl += position.unrealizedPnl;
  }

  return {
    totalInvested,
    totalPositions: dcaPositions.size,
    totalUnrealizedPnl: totalPnl,
    avgReturn: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
  };
}
