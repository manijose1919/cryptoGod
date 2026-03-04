/**
 * Derivatives Intelligence — Funding Rates, Open Interest, Liquidation Data.
 *
 * Polls CoinGlass-compatible free APIs for derivatives market data that
 * predicts 1-4h price direction. These are the highest-alpha alternative
 * data signals available for crypto.
 *
 * Features generated (5 new ML features):
 * - fundingRateNormalized: Annualized funding rate / 100 (sign = direction)
 * - oiChangePercent: 24h open interest change (positive = growing positions)
 * - oiPriceDivergence: OI rising + price falling = divergence signal
 * - longShortRatio: Long/Short ratio (>1 = more longs, <1 = more shorts)
 * - liquidationImbalance: Net long liquidations - net short liquidations
 */

import fetch from 'node-fetch';

// ─── Configuration ───────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000; // Poll every 5 minutes
const CACHE_TTL_MS = 4 * 60 * 1000;     // Cache valid for 4 minutes

// CoinGlass free API (no key required for basic endpoints)
const COINGLASS_BASE = 'https://open-api-v3.coinglass.com/api';
// Alternative free sources
const ALTERNATIVE_BASE = 'https://fapi.binance.com';

// Supported tickers for derivatives data
const DERIVATIVES_TICKERS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'DOT', 'AVAX', 'BNB'];

// ─── State ───────────────────────────────────────────────────

const cache = new Map(); // ticker → { data, timestamp }
let pollInterval = null;
let lastPollTime = 0;

// ─── Data Types ──────────────────────────────────────────────

/**
 * @typedef {Object} DerivativesData
 * @property {number} fundingRate - Current funding rate (decimal, e.g., 0.0001 = 0.01%)
 * @property {number} fundingRateAnnualized - Annualized funding (%, e.g., 10.95%)
 * @property {number} openInterest - Total OI in USD
 * @property {number} oiChangePercent24h - OI change in last 24h (%)
 * @property {number} longShortRatio - Long/short account ratio
 * @property {number} longLiquidations24h - Long liquidations in USD (24h)
 * @property {number} shortLiquidations24h - Short liquidations in USD (24h)
 * @property {number} liquidationImbalance - (longLiq - shortLiq) / totalLiq
 * @property {number} lastPrice - Last price at time of data
 * @property {number} timestamp - Data timestamp
 */

// ─── Fetch Functions ─────────────────────────────────────────

/**
 * Fetch funding rate from Binance Futures (free, no key).
 * Binance has the most liquid perp markets — funding rates are representative.
 */
async function fetchFundingRate(symbol) {
  try {
    const url = `${ALTERNATIVE_BASE}/fapi/v1/fundingRate?symbol=${symbol}USDT&limit=1`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.length === 0) return null;

    const rate = parseFloat(data[0].fundingRate);
    return {
      fundingRate: rate,
      fundingRateAnnualized: rate * 3 * 365 * 100, // 8h periods × 365 days × 100 for %
      fundingTime: data[0].fundingTime,
    };
  } catch (err) {
    console.warn(`[DerivativesIntel] Funding rate fetch failed for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch open interest from Binance Futures.
 */
async function fetchOpenInterest(symbol) {
  try {
    const url = `${ALTERNATIVE_BASE}/fapi/v1/openInterest?symbol=${symbol}USDT`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const data = await resp.json();

    return {
      openInterest: parseFloat(data.openInterest || 0),
      symbol: data.symbol,
    };
  } catch (err) {
    console.warn(`[DerivativesIntel] OI fetch failed for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch long/short ratio from Binance.
 */
async function fetchLongShortRatio(symbol) {
  try {
    const url = `${ALTERNATIVE_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}USDT&period=1h&limit=1`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.length === 0) return null;

    return {
      longShortRatio: parseFloat(data[0].longShortRatio || 1),
      longAccount: parseFloat(data[0].longAccount || 0.5),
      shortAccount: parseFloat(data[0].shortAccount || 0.5),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Fetch recent liquidation data from Binance.
 */
async function fetchLiquidations(symbol) {
  try {
    // Binance doesn't have a direct liquidation endpoint for free,
    // but we can approximate from forceOrders
    const url = `${ALTERNATIVE_BASE}/fapi/v1/forceOrders?symbol=${symbol}USDT&limit=100`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return { longLiquidations: 0, shortLiquidations: 0 };
    const data = await resp.json();

    let longLiq = 0, shortLiq = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const order of data) {
      if (order.time < cutoff) continue;
      const usdValue = parseFloat(order.price) * parseFloat(order.origQty);
      if (order.side === 'SELL') {
        longLiq += usdValue; // Longs liquidated → forced sell
      } else {
        shortLiq += usdValue; // Shorts liquidated → forced buy
      }
    }

    return { longLiquidations: longLiq, shortLiquidations: shortLiq };
  } catch (err) {
    return { longLiquidations: 0, shortLiquidations: 0 };
  }
}

/**
 * Fetch 24h ticker for OI change calculation.
 */
async function fetch24hTicker(symbol) {
  try {
    const url = `${ALTERNATIVE_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}USDT`;
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    return null;
  }
}

// ─── Main Poll Function ──────────────────────────────────────

/**
 * Poll derivatives data for all supported tickers.
 */
async function pollDerivativesData() {
  lastPollTime = Date.now();
  const previousOI = new Map();

  // Save previous OI for change calculation
  for (const [ticker, cached] of cache) {
    if (cached.data?.openInterest) {
      previousOI.set(ticker, cached.data.openInterest);
    }
  }

  // Fetch all tickers in parallel (batched to avoid rate limits)
  const batchSize = 3;
  for (let i = 0; i < DERIVATIVES_TICKERS.length; i += batchSize) {
    const batch = DERIVATIVES_TICKERS.slice(i, i + batchSize);

    const results = await Promise.all(batch.map(async (symbol) => {
      const [funding, oi, lsRatio, liqs, ticker24h] = await Promise.all([
        fetchFundingRate(symbol),
        fetchOpenInterest(symbol),
        fetchLongShortRatio(symbol),
        fetchLiquidations(symbol),
        fetch24hTicker(symbol),
      ]);

      const prevOI = previousOI.get(symbol) || 0;
      const currentOI = oi?.openInterest || 0;
      const oiChange = prevOI > 0 ? ((currentOI - prevOI) / prevOI) * 100 : 0;
      const lastPrice = parseFloat(ticker24h?.lastPrice || 0);
      const priceChange24h = parseFloat(ticker24h?.priceChangePercent || 0);

      // OI-Price divergence: OI rising + price falling (or vice versa)
      // Positive = OI up + price down (bearish divergence)
      // Negative = OI down + price up (bullish divergence)
      const oiPriceDivergence = oiChange > 0 && priceChange24h < 0 ? oiChange
        : oiChange < 0 && priceChange24h > 0 ? -Math.abs(oiChange)
        : 0;

      const totalLiq = (liqs.longLiquidations + liqs.shortLiquidations) || 1;
      const liquidationImbalance = (liqs.longLiquidations - liqs.shortLiquidations) / totalLiq;

      return {
        symbol,
        data: {
          fundingRate: funding?.fundingRate || 0,
          fundingRateAnnualized: funding?.fundingRateAnnualized || 0,
          openInterest: currentOI,
          oiChangePercent24h: oiChange,
          longShortRatio: lsRatio?.longShortRatio || 1,
          longLiquidations24h: liqs.longLiquidations,
          shortLiquidations24h: liqs.shortLiquidations,
          liquidationImbalance,
          oiPriceDivergence,
          lastPrice,
          priceChange24h,
          timestamp: Date.now(),
        },
      };
    }));

    for (const { symbol, data } of results) {
      cache.set(symbol, { data, timestamp: Date.now() });
    }

    // Small delay between batches to respect rate limits
    if (i + batchSize < DERIVATIVES_TICKERS.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[DerivativesIntel] Polled ${DERIVATIVES_TICKERS.length} tickers`);
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Start polling derivatives data.
 */
export function startDerivativesPolling() {
  if (pollInterval) return;
  console.log('[DerivativesIntel] Starting derivatives data polling (every 5 min)');
  pollDerivativesData(); // Initial poll
  pollInterval = setInterval(pollDerivativesData, POLL_INTERVAL_MS);
}

/**
 * Stop polling.
 */
export function stopDerivativesPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Get derivatives data for a ticker.
 * @param {string} ticker - e.g., 'BTCUSD' or 'BTC'
 * @returns {DerivativesData|null}
 */
export function getDerivativesSignal(ticker) {
  const symbol = ticker.replace('USD', '').replace('USDT', '');
  const cached = cache.get(symbol);
  if (!cached || Date.now() - cached.timestamp > CACHE_TTL_MS * 2) return null;
  return cached.data;
}

/**
 * Get ML feature vector additions (5 features) for a ticker.
 * Returns normalized values suitable for ML input.
 */
export function getDerivativesMLFeatures(ticker) {
  const data = getDerivativesSignal(ticker);
  if (!data) return [0, 0, 0, 0, 0];

  return [
    // Feature 1: Normalized funding rate (-1 to 1 scale, clipped)
    Math.max(-1, Math.min(1, data.fundingRateAnnualized / 100)),

    // Feature 2: OI change percent (normalized to -1..1)
    Math.max(-1, Math.min(1, data.oiChangePercent24h / 20)),

    // Feature 3: OI-Price divergence signal (-1..1)
    Math.max(-1, Math.min(1, data.oiPriceDivergence / 10)),

    // Feature 4: Long/Short ratio deviation from 1.0 (-1..1)
    Math.max(-1, Math.min(1, (data.longShortRatio - 1) * 2)),

    // Feature 5: Liquidation imbalance (-1..1)
    Math.max(-1, Math.min(1, data.liquidationImbalance)),
  ];
}

/**
 * Check if derivatives data suggests blocking a long entry.
 * Returns { block: boolean, reason: string }
 */
export function shouldBlockLongEntry(ticker) {
  const data = getDerivativesSignal(ticker);
  if (!data) return { block: false, reason: 'No derivatives data available' };

  // Block longs when funding is extremely positive (too many longs, likely reversal)
  if (data.fundingRateAnnualized > 50) {
    return {
      block: true,
      reason: `Extreme positive funding: ${data.fundingRateAnnualized.toFixed(1)}% annualized — longs overcrowded`,
    };
  }

  // Block longs when OI is rising but price is falling (bearish divergence)
  if (data.oiPriceDivergence > 5) {
    return {
      block: true,
      reason: `OI-Price bearish divergence: OI +${data.oiChangePercent24h.toFixed(1)}% while price falling`,
    };
  }

  // Block when liquidation imbalance shows longs being wiped out
  if (data.liquidationImbalance > 0.7 && data.longLiquidations24h > 1000000) {
    return {
      block: true,
      reason: `Heavy long liquidations: $${(data.longLiquidations24h / 1e6).toFixed(1)}M — cascade risk`,
    };
  }

  return { block: false, reason: 'Derivatives data OK for longs' };
}

/**
 * Check if derivatives data favors a short entry.
 * Returns { favorable: boolean, reason: string, confidence: number }
 */
export function shouldFavorShortEntry(ticker) {
  const data = getDerivativesSignal(ticker);
  if (!data) return { favorable: false, reason: 'No data', confidence: 0 };

  let score = 0;
  const reasons = [];

  // High positive funding = shorts are getting paid, longs are overcrowded
  if (data.fundingRateAnnualized > 30) {
    score += 25;
    reasons.push(`High funding: ${data.fundingRateAnnualized.toFixed(0)}%`);
  }

  // L/S ratio heavily long
  if (data.longShortRatio > 1.5) {
    score += 20;
    reasons.push(`L/S ratio: ${data.longShortRatio.toFixed(2)} (long-heavy)`);
  }

  // OI-price divergence (OI up, price down)
  if (data.oiPriceDivergence > 3) {
    score += 25;
    reasons.push(`Bearish OI divergence: ${data.oiPriceDivergence.toFixed(1)}`);
  }

  // Long liquidation cascade starting
  if (data.liquidationImbalance > 0.5) {
    score += 15;
    reasons.push(`Long liquidations dominating`);
  }

  return {
    favorable: score >= 40,
    reason: reasons.join('; ') || 'No short signals',
    confidence: Math.min(100, score),
  };
}

/**
 * Get all derivatives data for dashboard display.
 */
export function getAllDerivativesData() {
  const result = {};
  for (const [symbol, cached] of cache) {
    result[symbol] = cached.data;
  }
  return result;
}

/**
 * Get status for API endpoint.
 */
export function getDerivativesStatus() {
  return {
    enabled: pollInterval !== null,
    tickers: DERIVATIVES_TICKERS.length,
    cachedTickers: cache.size,
    lastPollTime,
    pollIntervalMs: POLL_INTERVAL_MS,
    signals: Object.fromEntries(
      [...cache.entries()].map(([k, v]) => [k, {
        funding: v.data.fundingRateAnnualized?.toFixed(1) + '%',
        oiChange: v.data.oiChangePercent24h?.toFixed(1) + '%',
        lsRatio: v.data.longShortRatio?.toFixed(2),
        liqImbalance: v.data.liquidationImbalance?.toFixed(2),
      }])
    ),
  };
}

export default {
  startDerivativesPolling,
  stopDerivativesPolling,
  getDerivativesSignal,
  getDerivativesMLFeatures,
  shouldBlockLongEntry,
  shouldFavorShortEntry,
  getAllDerivativesData,
  getDerivativesStatus,
};
