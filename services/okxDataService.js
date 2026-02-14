import fetch from 'node-fetch';

// Rate limiting: OKX allows 20 req/2s per endpoint
const RATE_LIMIT = {
  maxRequests: 20,
  windowMs: 2000,
  queues: {}
};

// Cache with 30s TTL
const cache = {
  openInterest: {},
  fundingRate: {},
  futuresSpot: {},
  snapshot: {}
};
const CACHE_TTL = 30000; // 30 seconds

// Previous values for divergence detection
const previousValues = {
  openInterest: {},
  prices: {}
};

/**
 * Convert dashboard ticker to OKX instrument format
 * @param {string} ticker - e.g., "BTCUSD", "ETHUSD"
 * @param {string} type - "spot" or "swap"
 * @returns {string} - e.g., "BTC-USDT" or "BTC-USDT-SWAP"
 */
function toOKXInstrument(ticker, type = 'spot') {
  // Extract base currency (BTC, ETH, etc.)
  const base = ticker.replace(/USD[TC]?$/, '');

  if (type === 'swap') {
    return `${base}-USDT-SWAP`;
  }
  return `${base}-USDT`;
}

/**
 * Rate-limited fetch wrapper
 * @param {string} endpoint - API endpoint identifier
 * @param {string} url - Full URL to fetch
 * @returns {Promise<Object|null>}
 */
async function rateLimitedFetch(endpoint, url) {
  if (!RATE_LIMIT.queues[endpoint]) {
    RATE_LIMIT.queues[endpoint] = {
      requests: [],
      processing: false
    };
  }

  const queue = RATE_LIMIT.queues[endpoint];

  return new Promise((resolve) => {
    queue.requests.push({ url, resolve });
    processQueue(endpoint);
  });
}

/**
 * Process rate-limited request queue
 * @param {string} endpoint - API endpoint identifier
 */
async function processQueue(endpoint) {
  const queue = RATE_LIMIT.queues[endpoint];

  if (queue.processing || queue.requests.length === 0) {
    return;
  }

  queue.processing = true;

  while (queue.requests.length > 0) {
    const now = Date.now();
    const recentRequests = queue.requests.filter(r => r.timestamp && now - r.timestamp < RATE_LIMIT.windowMs);

    if (recentRequests.length >= RATE_LIMIT.maxRequests) {
      // Wait until oldest request expires
      const oldestTimestamp = Math.min(...recentRequests.map(r => r.timestamp));
      const waitTime = RATE_LIMIT.windowMs - (now - oldestTimestamp) + 100;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      continue;
    }

    const request = queue.requests.shift();
    request.timestamp = Date.now();

    try {
      const response = await fetch(request.url, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();

      if (data.code === '0') {
        request.resolve(data.data);
      } else {
        console.error(`[OKXData] API error for ${request.url}:`, data.msg || data.code);
        request.resolve(null);
      }
    } catch (error) {
      console.error(`[OKXData] Fetch error for ${request.url}:`, error.message);
      request.resolve(null);
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  queue.processing = false;
}

/**
 * Check if cached data is still valid
 * @param {Object} cacheEntry - Cache entry with timestamp
 * @returns {boolean}
 */
function isCacheValid(cacheEntry) {
  if (!cacheEntry || !cacheEntry.timestamp) {
    return false;
  }
  return Date.now() - cacheEntry.timestamp < CACHE_TTL;
}

/**
 * Get open interest for a ticker
 * @param {string} ticker - e.g., "BTCUSD"
 * @returns {Promise<Object|null>} - { oi, oiUsd, timestamp, oiChange, oiChangePercent }
 */
export async function getOpenInterest(ticker) {
  const cacheKey = ticker;

  if (isCacheValid(cache.openInterest[cacheKey])) {
    return cache.openInterest[cacheKey].data;
  }

  const instrument = toOKXInstrument(ticker, 'swap');
  const url = `https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instrument}`;

  const data = await rateLimitedFetch('open-interest', url);

  if (!data || data.length === 0) {
    return null;
  }

  const result = {
    oi: parseFloat(data[0].oi),
    oiUsd: parseFloat(data[0].oiCcy), // Open interest in USD
    timestamp: parseInt(data[0].ts)
  };

  // Calculate change from previous value
  const previous = previousValues.openInterest[ticker];
  if (previous) {
    result.oiChange = result.oi - previous.oi;
    result.oiChangePercent = previous.oi > 0 ? (result.oiChange / previous.oi) * 100 : 0;
  } else {
    result.oiChange = 0;
    result.oiChangePercent = 0;
  }

  // Store current value for next comparison
  previousValues.openInterest[ticker] = { oi: result.oi, timestamp: result.timestamp };

  // Cache result
  cache.openInterest[cacheKey] = {
    data: result,
    timestamp: Date.now()
  };

  return result;
}

/**
 * Get funding rate for a ticker
 * @param {string} ticker - e.g., "BTCUSD"
 * @returns {Promise<Object|null>} - { fundingRate, nextFundingTime, timestamp }
 */
export async function getFundingRate(ticker) {
  const cacheKey = ticker;

  if (isCacheValid(cache.fundingRate[cacheKey])) {
    return cache.fundingRate[cacheKey].data;
  }

  const instrument = toOKXInstrument(ticker, 'swap');
  const url = `https://www.okx.com/api/v5/public/funding-rate?instId=${instrument}`;

  const data = await rateLimitedFetch('funding-rate', url);

  if (!data || data.length === 0) {
    return null;
  }

  const result = {
    fundingRate: parseFloat(data[0].fundingRate), // Decimal format (e.g., 0.0001 = 0.01%)
    nextFundingTime: parseInt(data[0].nextFundingTime),
    timestamp: parseInt(data[0].fundingTime)
  };

  // Cache result
  cache.fundingRate[cacheKey] = {
    data: result,
    timestamp: Date.now()
  };

  return result;
}

/**
 * Get futures-spot basis for a ticker
 * @param {string} ticker - e.g., "BTCUSD"
 * @returns {Promise<Object|null>} - { futuresPrice, spotPrice, basis, basisPercent }
 */
export async function getFuturesSpotBasis(ticker) {
  const cacheKey = ticker;

  if (isCacheValid(cache.futuresSpot[cacheKey])) {
    return cache.futuresSpot[cacheKey].data;
  }

  const swapInstrument = toOKXInstrument(ticker, 'swap');
  const spotInstrument = toOKXInstrument(ticker, 'spot');

  const swapUrl = `https://www.okx.com/api/v5/market/ticker?instId=${swapInstrument}`;
  const spotUrl = `https://www.okx.com/api/v5/market/ticker?instId=${spotInstrument}`;

  // Fetch both in parallel
  const [swapData, spotData] = await Promise.all([
    rateLimitedFetch('ticker-futures', swapUrl),
    rateLimitedFetch('ticker-spot', spotUrl)
  ]);

  if (!swapData || swapData.length === 0 || !spotData || spotData.length === 0) {
    return null;
  }

  const futuresPrice = parseFloat(swapData[0].last);
  const spotPrice = parseFloat(spotData[0].last);
  const basis = futuresPrice - spotPrice;
  const basisPercent = spotPrice > 0 ? (basis / spotPrice) * 100 : 0;

  const result = {
    futuresPrice,
    spotPrice,
    basis,
    basisPercent, // Positive = contango (longs paying shorts)
    timestamp: Date.now()
  };

  // Cache result
  cache.futuresSpot[cacheKey] = {
    data: result,
    timestamp: Date.now()
  };

  return result;
}

/**
 * Calculate OI-price divergence
 * @param {string} ticker - e.g., "BTCUSD"
 * @param {number} currentPrice - Current spot price
 * @param {number} oiChange - OI change since last fetch
 * @returns {string|null} - "bullish", "bearish", or null
 */
function calculateOIPriceDivergence(ticker, currentPrice, oiChange) {
  const previous = previousValues.prices[ticker];

  if (!previous || oiChange === 0) {
    // Store current price for next comparison
    previousValues.prices[ticker] = currentPrice;
    return null;
  }

  const priceChange = currentPrice - previous;

  // Store current price for next comparison
  previousValues.prices[ticker] = currentPrice;

  // Bearish: OI rising but price falling (shorts building)
  if (oiChange > 0 && priceChange < 0) {
    return 'bearish';
  }

  // Bullish: OI rising and price rising (longs building)
  if (oiChange > 0 && priceChange > 0) {
    return 'bullish';
  }

  // Falling OI = positions closing
  if (oiChange < 0) {
    return 'closing';
  }

  return null;
}

/**
 * Get complete derivatives snapshot
 * @param {string} ticker - e.g., "BTCUSD"
 * @returns {Promise<Object|null>} - Combined data from all endpoints
 */
export async function getDerivativesSnapshot(ticker) {
  const cacheKey = ticker;

  if (isCacheValid(cache.snapshot[cacheKey])) {
    return cache.snapshot[cacheKey].data;
  }

  // Fetch all data in parallel
  const [oiData, fundingData, basisData] = await Promise.all([
    getOpenInterest(ticker),
    getFundingRate(ticker),
    getFuturesSpotBasis(ticker)
  ]);

  if (!oiData || !fundingData || !basisData) {
    console.error(`[OKXData] Failed to fetch complete snapshot for ${ticker}`);
    return null;
  }

  // Calculate OI-price divergence
  const divergence = calculateOIPriceDivergence(ticker, basisData.spotPrice, oiData.oiChange);

  const result = {
    ticker,
    openInterest: {
      oi: oiData.oi,
      oiUsd: oiData.oiUsd,
      oiChange: oiData.oiChange,
      oiChangePercent: oiData.oiChangePercent
    },
    fundingRate: {
      rate: fundingData.fundingRate,
      ratePercent: fundingData.fundingRate * 100, // Convert to percentage
      nextFundingTime: fundingData.nextFundingTime
    },
    basis: {
      futuresPrice: basisData.futuresPrice,
      spotPrice: basisData.spotPrice,
      basis: basisData.basis,
      basisPercent: basisData.basisPercent
    },
    divergence, // "bullish", "bearish", "closing", or null
    timestamp: Date.now()
  };

  // Cache result
  cache.snapshot[cacheKey] = {
    data: result,
    timestamp: Date.now()
  };

  console.log(`[OKXData] Snapshot for ${ticker}: OI=${oiData.oi.toFixed(0)} (${oiData.oiChangePercent > 0 ? '+' : ''}${oiData.oiChangePercent.toFixed(2)}%), Funding=${(fundingData.fundingRate * 100).toFixed(4)}%, Basis=${basisData.basisPercent.toFixed(2)}%, Divergence=${divergence || 'none'}`);

  return result;
}

/**
 * Clear all caches (useful for testing or manual refresh)
 */
export function clearCache() {
  cache.openInterest = {};
  cache.fundingRate = {};
  cache.futuresSpot = {};
  cache.snapshot = {};
  console.log('[OKXData] All caches cleared');
}

/**
 * Get cache statistics
 * @returns {Object} - Cache hit/miss stats
 */
export function getCacheStats() {
  return {
    openInterest: Object.keys(cache.openInterest).length,
    fundingRate: Object.keys(cache.fundingRate).length,
    futuresSpot: Object.keys(cache.futuresSpot).length,
    snapshot: Object.keys(cache.snapshot).length
  };
}
