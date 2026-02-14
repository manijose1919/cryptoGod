/**
 * Market Making (Spread Capture) Service
 *
 * Simulates market making by placing virtual bid/ask orders
 * around the current price and profiting from the spread.
 *
 * Strategy:
 * - Place buy order slightly below current price (bid)
 * - Place sell order slightly above current price (ask)
 * - When both fill, profit = ask - bid (the spread)
 * - Manages inventory to stay market-neutral
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface MMOrder {
  price: number;
  quantity: number;
  side: 'BID' | 'ASK';
  placed: number;
  filled: boolean;
  fillTime: number | null;
}

export interface MMState {
  ticker: string;
  isActive: boolean;
  currentBid: MMOrder | null;
  currentAsk: MMOrder | null;
  inventory: number;           // Net position (positive = long, negative = short)
  inventoryValue: number;
  totalSpreadsCaptured: number;
  totalProfit: number;
  avgSpread: number;
  tradesCompleted: number;
  lastUpdate: number;
}

export interface MMSignal {
  shouldAct: boolean;
  action: 'PLACE_ORDERS' | 'BID_FILLED' | 'ASK_FILLED' | 'BOTH_FILLED' | 'NONE';
  bidPrice: number;
  askPrice: number;
  spreadPercent: number;
  quantity: number;
  profit: number;
  reason: string;
}

export interface SpreadAnalysis {
  currentSpread: number;      // Current bid-ask spread estimate
  avgSpread: number;          // Average spread
  volatility: number;         // Recent price volatility
  optimalSpread: number;      // Recommended spread to quote
  optimalQuantity: number;    // Recommended order size
  isFavorable: boolean;       // Whether conditions suit market making
}

// ============================================
// STATE
// ============================================

const mmStates: Map<string, MMState> = new Map();

/**
 * Estimate bid-ask spread from candle data
 * Uses high-low range as proxy since we don't have order book data
 */
function estimateSpread(candles: Candle[]): SpreadAnalysis {
  if (candles.length < 10) {
    return {
      currentSpread: 0.1,
      avgSpread: 0.1,
      volatility: 1,
      optimalSpread: 0.1,
      optimalQuantity: 0,
      isFavorable: false
    };
  }

  const price = candles[candles.length - 1].close;

  // Estimate spread from high-low range (smaller range = tighter spread)
  const recentSpreads = candles.slice(-20).map(c => ((c.high - c.low) / c.close) * 100);
  const avgSpread = recentSpreads.reduce((s, v) => s + v, 0) / recentSpreads.length;
  const currentSpread = recentSpreads[recentSpreads.length - 1];

  // Calculate volatility
  const returns = [];
  for (let i = 1; i < Math.min(20, candles.length); i++) {
    returns.push(Math.abs((candles[candles.length - i].close - candles[candles.length - i - 1].close) / candles[candles.length - i - 1].close) * 100);
  }
  const volatility = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Optimal spread: wider in volatile markets, narrower in calm
  // Target capturing at least 60% of the natural spread
  const optimalSpread = Math.max(0.02, avgSpread * 0.6);

  // Favorable when volatility is low-medium (spread is reliable)
  const isFavorable = volatility < avgSpread * 2 && avgSpread > 0.02;

  return {
    currentSpread,
    avgSpread,
    volatility,
    optimalSpread,
    optimalQuantity: 0, // Set by caller
    isFavorable
  };
}

/**
 * Initialize or get market making state for a ticker
 */
function getOrCreateMMState(ticker: string): MMState {
  let state = mmStates.get(ticker);
  if (!state) {
    state = {
      ticker,
      isActive: true,
      currentBid: null,
      currentAsk: null,
      inventory: 0,
      inventoryValue: 0,
      totalSpreadsCaptured: 0,
      totalProfit: 0,
      avgSpread: 0,
      tradesCompleted: 0,
      lastUpdate: Date.now()
    };
    mmStates.set(ticker, state);
  }
  return state;
}

/**
 * Process market making for a ticker
 * Simulates bid/ask order placement and fill detection
 */
export function processMarketMaking(
  ticker: string,
  candles: Candle[],
  cashAvailable: number
): MMSignal {
  const noSignal: MMSignal = {
    shouldAct: false,
    action: 'NONE',
    bidPrice: 0,
    askPrice: 0,
    spreadPercent: 0,
    quantity: 0,
    profit: 0,
    reason: 'No market making opportunity'
  };

  if (candles.length < 15) return noSignal;

  const price = candles[candles.length - 1].close;
  const prevPrice = candles[candles.length - 2].close;
  const spreadAnalysis = estimateSpread(candles);

  if (!spreadAnalysis.isFavorable) return noSignal;

  const state = getOrCreateMMState(ticker);

  // Calculate order prices
  const halfSpread = (spreadAnalysis.optimalSpread / 100) * price / 2;
  const bidPrice = price - halfSpread;
  const askPrice = price + halfSpread;

  // Position size: use 5% of available cash per side
  const orderValue = cashAvailable * 0.05;
  const quantity = orderValue / price;

  // Check if existing orders were filled
  if (state.currentBid && !state.currentBid.filled) {
    // Bid fills if price dipped below our bid
    if (candles[candles.length - 1].low <= state.currentBid.price) {
      state.currentBid.filled = true;
      state.currentBid.fillTime = Date.now();
      state.inventory += state.currentBid.quantity;
      state.inventoryValue += state.currentBid.price * state.currentBid.quantity;
    }
  }

  if (state.currentAsk && !state.currentAsk.filled) {
    // Ask fills if price rose above our ask
    if (candles[candles.length - 1].high >= state.currentAsk.price) {
      state.currentAsk.filled = true;
      state.currentAsk.fillTime = Date.now();
      state.inventory -= state.currentAsk.quantity;
    }
  }

  // Check for completed round trip (both bid and ask filled)
  if (state.currentBid?.filled && state.currentAsk?.filled) {
    const spreadCapture = state.currentAsk.price - state.currentBid.price;
    const profit = spreadCapture * Math.min(state.currentBid.quantity, state.currentAsk.quantity);
    const spreadPercent = (spreadCapture / state.currentBid.price) * 100;

    state.totalProfit += profit;
    state.totalSpreadsCaptured += spreadPercent;
    state.tradesCompleted++;
    state.avgSpread = state.totalSpreadsCaptured / state.tradesCompleted;

    // Reset orders
    const result: MMSignal = {
      shouldAct: true,
      action: 'BOTH_FILLED',
      bidPrice: state.currentBid.price,
      askPrice: state.currentAsk.price,
      spreadPercent,
      quantity: Math.min(state.currentBid.quantity, state.currentAsk.quantity),
      profit,
      reason: `MM spread captured: ${spreadPercent.toFixed(3)}% = $${profit.toFixed(4)} profit (total: $${state.totalProfit.toFixed(2)})`
    };

    state.currentBid = null;
    state.currentAsk = null;
    state.lastUpdate = Date.now();

    return result;
  }

  // Check for single-side fill
  if (state.currentBid?.filled && !state.currentAsk?.filled) {
    return {
      shouldAct: true,
      action: 'BID_FILLED',
      bidPrice: state.currentBid.price,
      askPrice: state.currentAsk?.price || askPrice,
      spreadPercent: spreadAnalysis.optimalSpread,
      quantity: state.currentBid.quantity,
      profit: 0,
      reason: `MM bid filled at ${Number(state.currentBid.price).toFixed(2)}, waiting for ask fill`
    };
  }

  if (state.currentAsk?.filled && !state.currentBid?.filled) {
    return {
      shouldAct: true,
      action: 'ASK_FILLED',
      bidPrice: state.currentBid?.price || bidPrice,
      askPrice: state.currentAsk.price,
      spreadPercent: spreadAnalysis.optimalSpread,
      quantity: state.currentAsk.quantity,
      profit: 0,
      reason: `MM ask filled at ${Number(state.currentAsk.price).toFixed(2)}, waiting for bid fill`
    };
  }

  // Place new orders if none active (or orders expired - older than 5 minutes)
  const orderExpiry = 5 * 60 * 1000;
  const bidExpired = state.currentBid && !state.currentBid.filled &&
    (Date.now() - state.currentBid.placed) > orderExpiry;
  const askExpired = state.currentAsk && !state.currentAsk.filled &&
    (Date.now() - state.currentAsk.placed) > orderExpiry;

  if (!state.currentBid || bidExpired || !state.currentAsk || askExpired) {
    // Inventory management: skew orders based on current inventory
    let bidAdj = 0, askAdj = 0;
    if (state.inventory > 0) {
      // Long inventory: lower ask to sell faster
      askAdj = -halfSpread * 0.2;
    } else if (state.inventory < 0) {
      // Short inventory: raise bid to buy faster
      bidAdj = halfSpread * 0.2;
    }

    const newBidPrice = bidPrice + bidAdj;
    const newAskPrice = askPrice + askAdj;

    state.currentBid = {
      price: newBidPrice,
      quantity,
      side: 'BID',
      placed: Date.now(),
      filled: false,
      fillTime: null
    };

    state.currentAsk = {
      price: newAskPrice,
      quantity,
      side: 'ASK',
      placed: Date.now(),
      filled: false,
      fillTime: null
    };

    state.lastUpdate = Date.now();

    return {
      shouldAct: true,
      action: 'PLACE_ORDERS',
      bidPrice: newBidPrice,
      askPrice: newAskPrice,
      spreadPercent: ((newAskPrice - newBidPrice) / newBidPrice) * 100,
      quantity,
      profit: 0,
      reason: `MM orders placed: bid=${newBidPrice.toFixed(2)} ask=${newAskPrice.toFixed(2)} spread=${spreadAnalysis.optimalSpread.toFixed(3)}%`
    };
  }

  return noSignal;
}

/**
 * Get market making state for a ticker
 */
export function getMMState(ticker: string): MMState | null {
  return mmStates.get(ticker) || null;
}

/**
 * Get all market making states
 */
export function getAllMMStates(): Map<string, MMState> {
  return mmStates;
}

/**
 * Get total profit from market making
 */
export function getMMTotalProfit(): number {
  let total = 0;
  for (const state of mmStates.values()) {
    total += state.totalProfit;
  }
  return total;
}

/**
 * Get market making summary
 */
export function getMMSummary(): {
  totalProfit: number;
  totalTrades: number;
  activePairs: number;
  avgSpread: number;
} {
  let totalProfit = 0;
  let totalTrades = 0;
  let totalSpread = 0;
  let activePairs = 0;

  for (const state of mmStates.values()) {
    totalProfit += state.totalProfit;
    totalTrades += state.tradesCompleted;
    if (state.tradesCompleted > 0) {
      totalSpread += state.avgSpread;
      activePairs++;
    }
  }

  return {
    totalProfit,
    totalTrades,
    activePairs,
    avgSpread: activePairs > 0 ? totalSpread / activePairs : 0
  };
}

/**
 * Reset market making state
 */
export function resetMM(ticker?: string): void {
  if (ticker) {
    mmStates.delete(ticker);
  } else {
    mmStates.clear();
  }
}
