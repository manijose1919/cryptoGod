/**
 * Order Book Microstructure — Real-time bid-ask imbalance, VPIN, spread analysis.
 *
 * Unlike orderBookSignals.js (which reads DB snapshots), this service works
 * with live order book data from exchange adapters. It computes:
 *
 * 1. Bid-Ask Imbalance: (bidVol - askVol) / (bidVol + askVol) at top N levels
 * 2. VPIN (Volume-Synchronized Probability of Informed Trading):
 *    Measures toxicity of order flow — high VPIN predicts volatility events
 * 3. Spread Analysis: Relative spread as % of mid-price
 * 4. Depth Ratio: Volume within X% of mid vs total depth
 *
 * ML Features generated (4 new features):
 * - bidAskImbalance: -1 to 1 (positive = buy pressure)
 * - vpin: 0 to 1 (high = toxic flow, expect volatility)
 * - relativeSpread: 0 to 1 (normalized spread)
 * - depthRatio: 0 to 1 (how much liquidity is near mid-price)
 */

// ─── State ───────────────────────────────────────────────────

const tickerState = new Map(); // ticker → { tradeVolumes, vpinBuckets, lastUpdate }
const VPIN_BUCKET_COUNT = 50;  // Number of volume buckets for VPIN calculation
const VPIN_BUCKET_SIZE = 0.01; // Each bucket = 1% of average daily volume (auto-calibrated)

// ─── Core Calculations ──────────────────────────────────────

/**
 * Calculate bid-ask imbalance from order book snapshot.
 * @param {Object} orderBook - { bids: [[price, qty, ...], ...], asks: [[price, qty, ...], ...] }
 * @param {number} levels - Number of top levels to consider (default 5)
 * @returns {number} -1 to 1 (positive = buy pressure)
 */
export function calcBidAskImbalance(orderBook, levels = 5) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) return 0;

  const topBids = orderBook.bids.slice(0, levels);
  const topAsks = orderBook.asks.slice(0, levels);

  const bidVol = topBids.reduce((sum, b) => sum + parseFloat(b[1] || 0), 0);
  const askVol = topAsks.reduce((sum, a) => sum + parseFloat(a[1] || 0), 0);
  const totalVol = bidVol + askVol;

  if (totalVol === 0) return 0;
  return (bidVol - askVol) / totalVol;
}

/**
 * Calculate weighted bid-ask imbalance (price-weighted by proximity to mid).
 * Closer levels have more weight.
 */
export function calcWeightedImbalance(orderBook, levels = 10) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) return 0;

  const bestBid = parseFloat(orderBook.bids[0]?.[0] || 0);
  const bestAsk = parseFloat(orderBook.asks[0]?.[0] || 0);
  if (bestBid === 0 || bestAsk === 0) return 0;
  const mid = (bestBid + bestAsk) / 2;

  let weightedBid = 0, weightedAsk = 0;

  for (let i = 0; i < Math.min(levels, orderBook.bids.length); i++) {
    const price = parseFloat(orderBook.bids[i][0]);
    const vol = parseFloat(orderBook.bids[i][1]);
    const distance = Math.abs(price - mid) / mid;
    const weight = 1 / (1 + distance * 100); // Exponential decay by distance
    weightedBid += vol * weight;
  }

  for (let i = 0; i < Math.min(levels, orderBook.asks.length); i++) {
    const price = parseFloat(orderBook.asks[i][0]);
    const vol = parseFloat(orderBook.asks[i][1]);
    const distance = Math.abs(price - mid) / mid;
    const weight = 1 / (1 + distance * 100);
    weightedAsk += vol * weight;
  }

  const total = weightedBid + weightedAsk;
  if (total === 0) return 0;
  return (weightedBid - weightedAsk) / total;
}

/**
 * Calculate relative spread as percentage of mid-price.
 */
export function calcRelativeSpread(orderBook) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) return 0;

  const bestBid = parseFloat(orderBook.bids[0]?.[0] || 0);
  const bestAsk = parseFloat(orderBook.asks[0]?.[0] || 0);
  if (bestBid === 0 || bestAsk === 0) return 0;

  const mid = (bestBid + bestAsk) / 2;
  return (bestAsk - bestBid) / mid;
}

/**
 * Calculate depth ratio — fraction of total depth within X% of mid-price.
 * High ratio = liquidity concentrated near mid (stable), low = thin near mid (fragile).
 */
export function calcDepthRatio(orderBook, percentRange = 0.5) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) return 0.5;

  const bestBid = parseFloat(orderBook.bids[0]?.[0] || 0);
  const bestAsk = parseFloat(orderBook.asks[0]?.[0] || 0);
  if (bestBid === 0 || bestAsk === 0) return 0.5;

  const mid = (bestBid + bestAsk) / 2;
  const range = mid * (percentRange / 100);

  let nearVol = 0, totalVol = 0;

  for (const [priceStr, volStr] of orderBook.bids) {
    const price = parseFloat(priceStr);
    const vol = parseFloat(volStr);
    totalVol += vol;
    if (mid - price <= range) nearVol += vol;
  }
  for (const [priceStr, volStr] of orderBook.asks) {
    const price = parseFloat(priceStr);
    const vol = parseFloat(volStr);
    totalVol += vol;
    if (price - mid <= range) nearVol += vol;
  }

  if (totalVol === 0) return 0.5;
  return nearVol / totalVol;
}

// ─── VPIN (Volume-Synchronized Probability of Informed Trading) ──

/**
 * Update VPIN calculation with a new trade.
 * VPIN classifies each trade's volume as buy-initiated or sell-initiated
 * using the tick rule, then measures the imbalance across volume buckets.
 *
 * @param {string} ticker
 * @param {number} price - Trade price
 * @param {number} volume - Trade volume
 * @param {'buy'|'sell'} side - Trade initiator side
 */
export function updateVPIN(ticker, price, volume, side) {
  let state = tickerState.get(ticker);
  if (!state) {
    state = {
      buckets: [],          // Array of { buyVol, sellVol }
      currentBucket: { buyVol: 0, sellVol: 0 },
      bucketVolumeTarget: 0, // Auto-calibrated
      totalVolume: 0,
      tradeCount: 0,
      vpin: 0,
      lastUpdate: Date.now(),
    };
    tickerState.set(ticker, state);

    // Cap map size to prevent unbounded growth
    if (tickerState.size > 50) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [k, v] of tickerState) {
        if (v.lastUpdate < oldestTime) { oldestTime = v.lastUpdate; oldestKey = k; }
      }
      if (oldestKey) tickerState.delete(oldestKey);
    }
  }

  // Auto-calibrate bucket size from observed volume
  state.totalVolume += volume;
  state.tradeCount++;

  // After 100 trades, calibrate bucket size (1% of observed total)
  if (state.tradeCount === 100 && state.bucketVolumeTarget === 0) {
    state.bucketVolumeTarget = state.totalVolume / VPIN_BUCKET_COUNT;
  }

  // Default bucket size if not yet calibrated
  const bucketTarget = state.bucketVolumeTarget || volume * 10;

  // Classify volume
  if (side === 'buy') {
    state.currentBucket.buyVol += volume;
  } else {
    state.currentBucket.sellVol += volume;
  }

  // Check if current bucket is full
  const bucketTotal = state.currentBucket.buyVol + state.currentBucket.sellVol;
  if (bucketTotal >= bucketTarget) {
    state.buckets.push({ ...state.currentBucket });
    state.currentBucket = { buyVol: 0, sellVol: 0 };

    // Keep only last N buckets
    if (state.buckets.length > VPIN_BUCKET_COUNT) {
      state.buckets = state.buckets.slice(-VPIN_BUCKET_COUNT);
    }

    // Recalculate VPIN
    if (state.buckets.length >= 10) {
      let sumAbsImbalance = 0;
      let sumVolume = 0;
      for (const bucket of state.buckets) {
        sumAbsImbalance += Math.abs(bucket.buyVol - bucket.sellVol);
        sumVolume += bucket.buyVol + bucket.sellVol;
      }
      state.vpin = sumVolume > 0 ? sumAbsImbalance / sumVolume : 0;
    }
  }

  state.lastUpdate = Date.now();
}

/**
 * Get current VPIN value for a ticker.
 * @returns {number} 0 to 1 (0 = balanced flow, 1 = fully informed/toxic)
 */
export function getVPIN(ticker) {
  const state = tickerState.get(ticker);
  if (!state) return 0;
  return state.vpin;
}

// ─── ML Features ─────────────────────────────────────────────

/**
 * Get microstructure ML features from a live order book snapshot.
 * Returns 4 normalized features suitable for ML input.
 */
export function getMicrostructureFeatures(orderBook, ticker) {
  const imbalance = calcWeightedImbalance(orderBook, 10);
  const spread = calcRelativeSpread(orderBook);
  const depth = calcDepthRatio(orderBook, 0.5);
  const vpin = getVPIN(ticker);

  return [
    // Feature 1: Bid-ask imbalance (-1 to 1)
    Math.max(-1, Math.min(1, imbalance)),

    // Feature 2: VPIN (0 to 1, clipped)
    Math.max(0, Math.min(1, vpin)),

    // Feature 3: Relative spread normalized (0 to 1, where 1% = 1.0)
    Math.max(0, Math.min(1, spread * 100)),

    // Feature 4: Depth ratio (0 to 1)
    Math.max(0, Math.min(1, depth)),
  ];
}

/**
 * Get full microstructure analysis for a ticker.
 * Used by dashboard and entry gating.
 */
export function analyzeMicrostructure(orderBook, ticker) {
  const imbalance = calcBidAskImbalance(orderBook, 5);
  const weightedImbalance = calcWeightedImbalance(orderBook, 10);
  const spread = calcRelativeSpread(orderBook);
  const depth = calcDepthRatio(orderBook, 0.5);
  const vpin = getVPIN(ticker);

  // Entry signal: strong imbalance + low spread + good depth
  let signal = 'NEUTRAL';
  let confidence = 0;

  if (weightedImbalance > 0.3 && spread < 0.002 && depth > 0.3) {
    signal = 'STRONG_BUY';
    confidence = Math.min(100, Math.round(weightedImbalance * 150));
  } else if (weightedImbalance > 0.15 && spread < 0.005) {
    signal = 'BUY';
    confidence = Math.min(80, Math.round(weightedImbalance * 120));
  } else if (weightedImbalance < -0.3 && spread < 0.002 && depth > 0.3) {
    signal = 'STRONG_SELL';
    confidence = Math.min(100, Math.round(Math.abs(weightedImbalance) * 150));
  } else if (weightedImbalance < -0.15 && spread < 0.005) {
    signal = 'SELL';
    confidence = Math.min(80, Math.round(Math.abs(weightedImbalance) * 120));
  }

  // VPIN warning: high VPIN means expect volatility
  const vpinWarning = vpin > 0.7;

  return {
    imbalance,
    weightedImbalance,
    spread,
    spreadBps: spread * 10000,
    depthRatio: depth,
    vpin,
    vpinWarning,
    signal,
    confidence,
    timestamp: Date.now(),
  };
}

/**
 * Get microstructure status for all tracked tickers.
 */
export function getMicrostructureStatus() {
  const result = {};
  for (const [ticker, state] of tickerState) {
    result[ticker] = {
      vpin: state.vpin,
      bucketsFilled: state.buckets.length,
      tradeCount: state.tradeCount,
      lastUpdate: state.lastUpdate,
    };
  }
  return result;
}

export default {
  calcBidAskImbalance,
  calcWeightedImbalance,
  calcRelativeSpread,
  calcDepthRatio,
  updateVPIN,
  getVPIN,
  getMicrostructureFeatures,
  analyzeMicrostructure,
  getMicrostructureStatus,
};
