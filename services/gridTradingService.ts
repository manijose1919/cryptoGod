/**
 * Grid Trading Service
 *
 * Places virtual buy/sell orders at preset price intervals within a detected range.
 * Profits from every oscillation in sideways/choppy markets.
 * Auto-detects optimal range from recent price action.
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface GridLevel {
  price: number;
  type: 'BUY' | 'SELL';
  filled: boolean;
  fillPrice: number | null;
  fillTime: number | null;
  pnl: number;
}

export interface GridConfig {
  upperBound: number;
  lowerBound: number;
  gridCount: number;
  gridSpacing: number;
  investmentPerGrid: number;
}

export interface GridState {
  config: GridConfig;
  levels: GridLevel[];
  totalPnl: number;
  filledBuys: number;
  filledSells: number;
  isActive: boolean;
  lastUpdate: number;
}

export interface GridSignal {
  shouldAct: boolean;
  action: 'BUY' | 'SELL';
  price: number;
  gridLevel: number;
  reason: string;
  investmentAmount: number;
  expectedProfit: number;
}

// ============================================
// GRID STATE MANAGEMENT
// ============================================

const gridStates: Map<string, GridState> = new Map();

/**
 * Auto-detect optimal grid range from recent price action
 */
export function detectGridRange(candles: Candle[], gridCount: number = 10): GridConfig {
  const prices = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Use recent 50 candles for range detection
  const recent = Math.min(50, candles.length);
  const recentHighs = highs.slice(-recent);
  const recentLows = lows.slice(-recent);

  // Find range using percentiles to exclude outlier wicks
  const sortedPrices = [...prices.slice(-recent)].sort((a, b) => a - b);
  const p10 = sortedPrices[Math.floor(sortedPrices.length * 0.05)];
  const p90 = sortedPrices[Math.floor(sortedPrices.length * 0.95)];

  // Add 0.5% buffer on each side
  const upperBound = p90 * 1.005;
  const lowerBound = p10 * 0.995;
  const gridSpacing = (upperBound - lowerBound) / gridCount;

  return {
    upperBound,
    lowerBound,
    gridCount,
    gridSpacing,
    investmentPerGrid: 0 // Set by caller based on portfolio
  };
}

/**
 * Initialize or update grid for a ticker
 */
export function initializeGrid(
  ticker: string,
  candles: Candle[],
  totalBudget: number,
  gridCount: number = 10
): GridState {
  const config = detectGridRange(candles, gridCount);
  config.investmentPerGrid = totalBudget / gridCount;

  const levels: GridLevel[] = [];
  const currentPrice = candles[candles.length - 1].close;

  for (let i = 0; i <= gridCount; i++) {
    const levelPrice = config.lowerBound + (i * config.gridSpacing);
    levels.push({
      price: levelPrice,
      type: levelPrice < currentPrice ? 'BUY' : 'SELL',
      filled: false,
      fillPrice: null,
      fillTime: null,
      pnl: 0
    });
  }

  const state: GridState = {
    config,
    levels,
    totalPnl: 0,
    filledBuys: 0,
    filledSells: 0,
    isActive: true,
    lastUpdate: Date.now()
  };

  gridStates.set(ticker, state);
  return state;
}

/**
 * Check if grid needs to be recalculated (price moved out of range)
 */
export function needsGridReset(ticker: string, currentPrice: number): boolean {
  const state = gridStates.get(ticker);
  if (!state) return true;

  const { upperBound, lowerBound } = state.config;
  const buffer = (upperBound - lowerBound) * 0.1;

  return currentPrice > upperBound + buffer || currentPrice < lowerBound - buffer;
}

/**
 * Process grid trading logic - check if price crossed any grid levels
 */
export function processGrid(
  ticker: string,
  candles: Candle[],
  cashAvailable: number
): GridSignal | null {
  if (candles.length < 10) return null;

  const currentPrice = candles[candles.length - 1].close;
  const prevPrice = candles[candles.length - 2].close;

  // Initialize grid if needed
  if (needsGridReset(ticker, currentPrice)) {
    const budget = cashAvailable * 0.15; // Use 15% of cash for grid trading
    initializeGrid(ticker, candles, budget);
  }

  const state = gridStates.get(ticker);
  if (!state || !state.isActive) return null;

  // Check which grid levels price crossed
  for (let i = 0; i < state.levels.length; i++) {
    const level = state.levels[i];
    if (level.filled) continue;

    // Price crossed DOWN through a BUY level
    if (level.type === 'BUY' && prevPrice > level.price && currentPrice <= level.price) {
      level.filled = true;
      level.fillPrice = currentPrice;
      level.fillTime = Date.now();
      state.filledBuys++;
      state.lastUpdate = Date.now();

      // Set the level above as a SELL target
      if (i + 1 < state.levels.length) {
        state.levels[i + 1].type = 'SELL';
        state.levels[i + 1].filled = false;
      }

      return {
        shouldAct: true,
        action: 'BUY',
        price: currentPrice,
        gridLevel: i,
        reason: `Grid BUY: Price crossed level ${i} (${level.price.toFixed(2)})`,
        investmentAmount: state.config.investmentPerGrid,
        expectedProfit: state.config.gridSpacing / currentPrice * 100
      };
    }

    // Price crossed UP through a SELL level
    if (level.type === 'SELL' && prevPrice < level.price && currentPrice >= level.price) {
      // Find the corresponding buy level below
      const buyLevel = state.levels.slice(0, i).reverse().find(l => l.filled && l.type === 'BUY');
      const buyPrice = buyLevel?.fillPrice || level.price - state.config.gridSpacing;
      const pnl = ((currentPrice - buyPrice) / buyPrice) * 100;

      level.filled = true;
      level.fillPrice = currentPrice;
      level.fillTime = Date.now();
      level.pnl = pnl;
      state.filledSells++;
      state.totalPnl += pnl;
      state.lastUpdate = Date.now();

      // Reset the level below as a BUY
      if (i - 1 >= 0) {
        state.levels[i - 1].type = 'BUY';
        state.levels[i - 1].filled = false;
      }

      return {
        shouldAct: true,
        action: 'SELL',
        price: currentPrice,
        gridLevel: i,
        reason: `Grid SELL: Price crossed level ${i} (+${pnl.toFixed(2)}% profit)`,
        investmentAmount: state.config.investmentPerGrid,
        expectedProfit: pnl
      };
    }
  }

  return null;
}

/**
 * Get grid state for display
 */
export function getGridState(ticker: string): GridState | null {
  return gridStates.get(ticker) || null;
}

/**
 * Get all active grids
 */
export function getAllGridStates(): Map<string, GridState> {
  return gridStates;
}

/**
 * Reset grid for ticker
 */
export function resetGrid(ticker: string): void {
  gridStates.delete(ticker);
}
