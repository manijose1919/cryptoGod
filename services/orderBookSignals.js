/**
 * Order Book Imbalance Signal Service
 * Reads exchange snapshots to detect order book imbalance trends, wall proximity, and directional bias.
 */

import { getExchangeSnapshots } from './database.js';

/**
 * Get order book signal for a ticker.
 * Reads last 5 exchange snapshots to compute rolling imbalance trend.
 * @param {string} ticker
 * @returns {{ direction: string, confidence: number, nearestBuyWall: number|null, nearestSellWall: number|null, imbalanceTrend: string, details: Object }}
 */
export function getOrderBookSignal(ticker) {
  try {
    const snapshots = getExchangeSnapshots(ticker, 5);

    if (!snapshots || snapshots.length === 0) {
      return { direction: 'NEUTRAL', confidence: 0, nearestBuyWall: null, nearestSellWall: null, imbalanceTrend: 'FLAT', details: {} };
    }

    // Compute rolling imbalance from snapshots
    const imbalances = snapshots.map(s => s.imbalance || 0);
    const avgImbalance = imbalances.reduce((a, b) => a + b, 0) / imbalances.length;

    // Imbalance trend: is it getting more bullish or bearish?
    let imbalanceTrend = 'FLAT';
    if (imbalances.length >= 3) {
      const recent = imbalances.slice(-2).reduce((a, b) => a + b, 0) / 2;
      const older = imbalances.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
      if (recent - older > 0.05) imbalanceTrend = 'INCREASING_BUY';
      else if (older - recent > 0.05) imbalanceTrend = 'INCREASING_SELL';
    }

    // Direction and confidence from average imbalance
    let direction = 'NEUTRAL';
    let confidence = 0;

    if (avgImbalance > 0.15) {
      direction = 'BUY';
      confidence = Math.min(100, Math.round(avgImbalance * 200));
    } else if (avgImbalance < -0.15) {
      direction = 'SELL';
      confidence = Math.min(100, Math.round(Math.abs(avgImbalance) * 200));
    }

    // Wall detection from latest snapshot
    const latest = snapshots[snapshots.length - 1];
    let nearestBuyWall = null;
    let nearestSellWall = null;

    if (latest.buy_wall_price) nearestBuyWall = latest.buy_wall_price;
    if (latest.sell_wall_price) nearestSellWall = latest.sell_wall_price;

    return {
      direction,
      confidence,
      nearestBuyWall,
      nearestSellWall,
      imbalanceTrend,
      avgImbalance,
      details: {
        snapshotCount: snapshots.length,
        latestImbalance: imbalances[imbalances.length - 1],
        spread: latest.spread_pct || 0,
      }
    };
  } catch (e) {
    return { direction: 'NEUTRAL', confidence: 0, nearestBuyWall: null, nearestSellWall: null, imbalanceTrend: 'FLAT', error: e.message };
  }
}

/**
 * Get confidence adjustment based on OB signal and proposed trade direction.
 * @param {{ direction: string, confidence: number }} signal
 * @param {string} tradeDirection - 'BUY' or 'SELL'
 * @returns {{ adjustment: number, reason: string }}
 */
export function getOrderBookConfidenceAdjustment(signal, tradeDirection = 'BUY') {
  if (signal.direction === 'NEUTRAL' || signal.confidence < 20) {
    return { adjustment: 0, reason: 'OB neutral' };
  }

  const maxAdj = 15;
  const factor = signal.confidence / 100;

  if (signal.direction === tradeDirection) {
    const boost = Math.round(factor * maxAdj);
    return { adjustment: boost, reason: `OB confirms ${tradeDirection} (+${boost})` };
  }

  const penalty = -Math.round(factor * maxAdj);
  return { adjustment: penalty, reason: `OB opposes ${tradeDirection} (${penalty})` };
}

export default { getOrderBookSignal, getOrderBookConfidenceAdjustment };
