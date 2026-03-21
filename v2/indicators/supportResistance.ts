// ============================================
// Support/Resistance Levels — Ported from PineScript
// Pivot-based S/R with dynamic classification
// ============================================

import type { Candle } from '../pipeline/types.ts';

// --- Types ---

export interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  /** How many times price has touched this level (±tolerance) */
  touches: number;
  /** Bar index where this level was established */
  barIndex: number;
  /** Strength score 0-100 */
  strength: number;
}

export interface SRResult {
  /** All detected S/R levels, sorted by strength */
  levels: SRLevel[];
  /** Nearest support below current price */
  nearestSupport: number | null;
  /** Nearest resistance above current price */
  nearestResistance: number | null;
  /** Distance to nearest support as % of price */
  supportDistance: number;
  /** Distance to nearest resistance as % of price */
  resistanceDistance: number;
  /** Price position within S/R channel (0 = at support, 1 = at resistance) */
  channelPosition: number;
}

// --- Core Computation ---

/**
 * Detect pivot highs: bars where high[i] is higher than `len` bars on each side.
 */
function pivotHighs(candles: Candle[], len: number): { index: number; price: number }[] {
  const pivots: { index: number; price: number }[] = [];

  for (let i = len; i < candles.length - len; i++) {
    let isPivot = true;
    for (let j = 1; j <= len; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      pivots.push({ index: i, price: candles[i].high });
    }
  }

  return pivots;
}

/**
 * Detect pivot lows: bars where low[i] is lower than `len` bars on each side.
 */
function pivotLows(candles: Candle[], len: number): { index: number; price: number }[] {
  const pivots: { index: number; price: number }[] = [];

  for (let i = len; i < candles.length - len; i++) {
    let isPivot = true;
    for (let j = 1; j <= len; j++) {
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      pivots.push({ index: i, price: candles[i].low });
    }
  }

  return pivots;
}

/**
 * Merge nearby levels within a tolerance band.
 */
function mergeLevels(levels: SRLevel[], tolerancePercent: number): SRLevel[] {
  if (levels.length === 0) return [];

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged: SRLevel[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const priceDiff = Math.abs(sorted[i].price - current.price) / current.price;
    if (priceDiff < tolerancePercent) {
      // Merge: average price, sum touches, keep best strength
      current.price = (current.price + sorted[i].price) / 2;
      current.touches += sorted[i].touches;
      current.strength = Math.max(current.strength, sorted[i].strength);
    } else {
      merged.push(current);
      current = { ...sorted[i] };
    }
  }
  merged.push(current);

  return merged;
}

/**
 * Compute Support/Resistance levels from candle data.
 * Uses pivot detection (PineScript len=12 default) and merges nearby levels.
 *
 * @param candles - OHLCV candle array
 * @param pivotLen - Pivot lookback/forward length (default 12)
 * @param tolerancePercent - Merge tolerance (default 0.3%)
 */
export function computeSupportResistance(
  candles: Candle[],
  pivotLen: number = 12,
  tolerancePercent: number = 0.003,
): SRResult {
  const defaultResult: SRResult = {
    levels: [],
    nearestSupport: null,
    nearestResistance: null,
    supportDistance: 0,
    resistanceDistance: 0,
    channelPosition: 0.5,
  };

  if (candles.length < pivotLen * 2 + 1) return defaultResult;

  const currentPrice = candles[candles.length - 1].close;
  const totalBars = candles.length;

  // Detect pivots
  const highs = pivotHighs(candles, pivotLen);
  const lows = pivotLows(candles, pivotLen);

  // Convert to SRLevel format
  const rawLevels: SRLevel[] = [];

  for (const pivot of highs) {
    // Recency weighting: more recent = stronger
    const recency = pivot.index / totalBars; // 0 (oldest) to ~1 (newest)
    const strength = 40 + recency * 40; // 40-80 base

    rawLevels.push({
      price: pivot.price,
      type: pivot.price >= currentPrice ? 'resistance' : 'support',
      touches: 1,
      barIndex: pivot.index,
      strength,
    });
  }

  for (const pivot of lows) {
    const recency = pivot.index / totalBars;
    const strength = 40 + recency * 40;

    rawLevels.push({
      price: pivot.price,
      type: pivot.price <= currentPrice ? 'support' : 'resistance',
      touches: 1,
      barIndex: pivot.index,
      strength,
    });
  }

  // Merge nearby levels and count touches
  const merged = mergeLevels(rawLevels, tolerancePercent);

  // Count how many candles touched each level (within tolerance)
  for (const level of merged) {
    let touchCount = 0;
    for (const candle of candles) {
      const tolerance = level.price * tolerancePercent;
      if (candle.low <= level.price + tolerance && candle.high >= level.price - tolerance) {
        touchCount++;
      }
    }
    level.touches = touchCount;
    // More touches = stronger level (up to +20 bonus)
    level.strength = Math.min(100, level.strength + Math.min(20, touchCount * 3));
  }

  // Re-classify based on current price
  for (const level of merged) {
    level.type = level.price >= currentPrice ? 'resistance' : 'support';
  }

  // Sort by strength descending
  merged.sort((a, b) => b.strength - a.strength);

  // Find nearest support and resistance
  const supports = merged.filter((l) => l.type === 'support').sort((a, b) => b.price - a.price);
  const resistances = merged.filter((l) => l.type === 'resistance').sort((a, b) => a.price - b.price);

  const nearestSupport = supports.length > 0 ? supports[0].price : null;
  const nearestResistance = resistances.length > 0 ? resistances[0].price : null;

  const supportDistance = nearestSupport !== null
    ? (currentPrice - nearestSupport) / currentPrice
    : 0;

  const resistanceDistance = nearestResistance !== null
    ? (nearestResistance - currentPrice) / currentPrice
    : 0;

  // Channel position: 0 = at support, 1 = at resistance
  let channelPosition = 0.5;
  if (nearestSupport !== null && nearestResistance !== null && nearestResistance > nearestSupport) {
    channelPosition = (currentPrice - nearestSupport) / (nearestResistance - nearestSupport);
    channelPosition = Math.max(0, Math.min(1, channelPosition));
  }

  return {
    levels: merged.slice(0, 10), // Top 10 levels
    nearestSupport,
    nearestResistance,
    supportDistance,
    resistanceDistance,
    channelPosition,
  };
}
