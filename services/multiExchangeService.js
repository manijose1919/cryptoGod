// Multi-Exchange Data Collection Service
// Central coordinator for all external data sources with scheduled intervals

import { getDb } from './database.js';

// Dynamic imports with resilience
let binanceService, okxService, coinGeckoService, defiLlamaService, cryptoPanicService, redditService;

// Collection state
let isRunning = false;
let activeTicker = 'BTCUSD';
let intervals = {};
let lastFetchTimes = {};
let errorCounts = {};
let totalSnapshots = 0;

// In-memory cache for fast access
const cache = {
  exchangeData: {},      // ticker -> { binance: {...}, okx: {...} }
  derivatives: {},       // ticker -> { oi, funding, ... }
  defi: null,           // latest DeFi snapshot
  news: [],             // recent news items
  social: {},           // ticker -> { reddit, coingecko }
  fearGreed: null       // latest F&G index
};

// Tickers to collect data for
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD', 'BNBUSD'];

// Initialize error counts
TICKERS.forEach(ticker => {
  errorCounts[ticker] = { binance: 0, okx: 0, coingecko: 0, defi: 0, news: 0, reddit: 0 };
});

/**
 * Load all services dynamically with fallback
 */
async function loadServices() {
  const services = [];

  // Binance: DISABLED — geo-blocked from VPS location, generates constant 451 errors
  // To re-enable, uncomment below:
  // try {
  //   binanceService = await import('./binanceDataService.js');
  //   services.push('Binance');
  // } catch (err) {
  //   console.warn('[MultiExchange] Binance service not available:', err.message);
  // }

  try {
    okxService = await import('./okxDataService.js');
    services.push('OKX');
  } catch (err) {
    console.warn('[MultiExchange] OKX service not available:', err.message);
  }

  try {
    coinGeckoService = await import('./coinGeckoService.js');
    services.push('CoinGecko');
  } catch (err) {
    console.warn('[MultiExchange] CoinGecko service not available:', err.message);
  }

  try {
    defiLlamaService = await import('./defiLlamaService.js');
    services.push('DeFiLlama');
  } catch (err) {
    console.warn('[MultiExchange] DeFiLlama service not available:', err.message);
  }

  try {
    cryptoPanicService = await import('./cryptoPanicService.js');
    services.push('CryptoPanic');
  } catch (err) {
    console.warn('[MultiExchange] CryptoPanic service not available:', err.message);
  }

  try {
    redditService = await import('./redditSentimentService.js');
    services.push('Reddit');
  } catch (err) {
    console.warn('[MultiExchange] Reddit service not available:', err.message);
  }

  console.log(`[MultiExchange] Loaded services: ${services.join(', ')}`);
}

/**
 * Fetch Binance order book for active ticker (every 10s)
 */
async function fetchBinanceOrderBook() {
  if (!binanceService) return;

  try {
    const ticker = activeTicker;
    const data = await binanceService.getOrderBook(ticker);

    if (data) {
      // Update cache
      if (!cache.exchangeData[ticker]) cache.exchangeData[ticker] = {};
      cache.exchangeData[ticker].binance = data;

      // Store to DB (only every 30s to avoid spam)
      const now = Date.now();
      const lastDb = lastFetchTimes[`binance_db_${ticker}`] || 0;
      if (now - lastDb >= 30000) {
        saveExchangeSnapshot(ticker, 'binance', data);
        lastFetchTimes[`binance_db_${ticker}`] = now;
      }

      lastFetchTimes[`binance_${ticker}`] = now;
      errorCounts[ticker].binance = 0;
      totalSnapshots++;
    }
  } catch (err) {
    console.error(`[MultiExchange] Binance order book error:`, err.message);
    errorCounts[activeTicker].binance++;
  }
}

/**
 * Fetch Binance candles for all tickers (every 30s)
 */
async function fetchBinanceCandles() {
  if (!binanceService) return;

  for (const ticker of TICKERS) {
    try {
      const data = await binanceService.getCandles(ticker, '1m', 100);

      if (data && data.length > 0) {
        if (!cache.exchangeData[ticker]) cache.exchangeData[ticker] = {};
        cache.exchangeData[ticker].candles = data;

        lastFetchTimes[`binance_candles_${ticker}`] = Date.now();
        errorCounts[ticker].binance = 0;
      }
    } catch (err) {
      console.error(`[MultiExchange] Binance candles error for ${ticker}:`, err.message);
      errorCounts[ticker].binance++;
    }
  }
}

/**
 * Fetch OKX open interest for all tickers (every 60s)
 */
async function fetchOKXOpenInterest() {
  if (!okxService) return;

  for (const ticker of TICKERS) {
    try {
      const data = await okxService.getOpenInterest(ticker);

      if (data) {
        cache.derivatives[ticker] = { ...cache.derivatives[ticker], ...data };
        saveDerivativesData(ticker, data);

        lastFetchTimes[`okx_oi_${ticker}`] = Date.now();
        errorCounts[ticker].okx = 0;
        totalSnapshots++;
      }
    } catch (err) {
      console.error(`[MultiExchange] OKX OI error for ${ticker}:`, err.message);
      errorCounts[ticker].okx++;
    }
  }
}

/**
 * Fetch OKX funding rates for all tickers (every 5min)
 */
async function fetchOKXFundingRates() {
  if (!okxService) return;

  for (const ticker of TICKERS) {
    try {
      const data = await okxService.getFundingRate(ticker);

      if (data) {
        cache.derivatives[ticker] = { ...cache.derivatives[ticker], ...data };
        saveDerivativesData(ticker, data);

        lastFetchTimes[`okx_funding_${ticker}`] = Date.now();
        errorCounts[ticker].okx = 0;
        totalSnapshots++;
      }
    } catch (err) {
      console.error(`[MultiExchange] OKX funding error for ${ticker}:`, err.message);
      errorCounts[ticker].okx++;
    }
  }
}

/**
 * Fetch CoinGecko market overview (every 10min)
 */
async function fetchCoinGeckoMarket() {
  if (!coinGeckoService) return;

  try {
    const data = await coinGeckoService.getMarketOverview();

    if (data) {
      // Store in social cache for each ticker
      TICKERS.forEach(ticker => {
        if (!cache.social[ticker]) cache.social[ticker] = {};
        cache.social[ticker].coingecko = data[ticker] || {};
      });

      lastFetchTimes['coingecko_market'] = Date.now();
      TICKERS.forEach(ticker => errorCounts[ticker].coingecko = 0);
      totalSnapshots++;
    }
  } catch (err) {
    console.error('[MultiExchange] CoinGecko market error:', err.message);
    TICKERS.forEach(ticker => errorCounts[ticker].coingecko++);
  }
}

/**
 * Fetch CoinGecko social data (every 10min)
 */
async function fetchCoinGeckoSocial() {
  if (!coinGeckoService) return;

  for (const ticker of TICKERS) {
    try {
      const data = await coinGeckoService.getCoinSocialData(ticker);

      if (data) {
        if (!cache.social[ticker]) cache.social[ticker] = {};
        cache.social[ticker].coingecko = { ...cache.social[ticker].coingecko, ...data };

        lastFetchTimes[`coingecko_social_${ticker}`] = Date.now();
        errorCounts[ticker].coingecko = 0;
      }
    } catch (err) {
      console.error(`[MultiExchange] CoinGecko social error for ${ticker}:`, err.message);
      errorCounts[ticker].coingecko++;
    }
    // Space out requests to avoid burst-triggering CoinGecko 429s
    await new Promise(r => setTimeout(r, 12000));
  }
}

/**
 * Fetch Fear & Greed Index (every 30min)
 */
async function fetchFearGreed() {
  if (!cryptoPanicService) return;

  try {
    const data = await cryptoPanicService.getFearGreedIndex();

    if (data) {
      cache.fearGreed = data;
      lastFetchTimes['fear_greed'] = Date.now();
      totalSnapshots++;
    }
  } catch (err) {
    console.error('[MultiExchange] Fear & Greed error:', err.message);
  }
}

/**
 * Fetch DeFiLlama data (every 15min)
 */
async function fetchDeFiLlama() {
  if (!defiLlamaService) return;

  try {
    const data = await defiLlamaService.getDeFiSnapshot();

    if (data) {
      cache.defi = data;
      saveDeFiSnapshot(data);

      lastFetchTimes['defillama'] = Date.now();
      TICKERS.forEach(ticker => errorCounts[ticker].defi = 0);
      totalSnapshots++;
    }
  } catch (err) {
    console.error('[MultiExchange] DeFiLlama error:', err.message);
    TICKERS.forEach(ticker => errorCounts[ticker].defi++);
  }
}

/**
 * Fetch CryptoPanic news (every 5min)
 */
async function fetchCryptoPanicNews() {
  if (!cryptoPanicService) return;

  try {
    const data = await cryptoPanicService.getLatestNews(null, 30);

    if (data && data.length > 0) {
      cache.news = data;

      // Save each news item to DB
      data.forEach(item => saveNewsItem(item));

      lastFetchTimes['cryptopanic'] = Date.now();
      TICKERS.forEach(ticker => errorCounts[ticker].news = 0);
      totalSnapshots++;
    }
  } catch (err) {
    console.error('[MultiExchange] CryptoPanic error:', err.message);
    TICKERS.forEach(ticker => errorCounts[ticker].news++);
  }
}

/**
 * Fetch Reddit sentiment (every 5min)
 */
async function fetchRedditSentiment() {
  if (!redditService) return;

  // Skip entirely if Reddit is in rate limit backoff
  if (redditService.isInBackoff && redditService.isInBackoff()) return;

  for (const ticker of TICKERS) {
    // Abort loop if we hit rate limits mid-cycle
    if (redditService.isInBackoff && redditService.isInBackoff()) break;

    try {
      const data = await redditService.getTickerMentions(ticker);

      if (data) {
        if (!cache.social[ticker]) cache.social[ticker] = {};
        cache.social[ticker].reddit = data;

        lastFetchTimes[`reddit_${ticker}`] = Date.now();
        errorCounts[ticker].reddit = 0;
      }
    } catch (err) {
      console.error(`[MultiExchange] Reddit error for ${ticker}:`, err.message);
      errorCounts[ticker].reddit++;
    }
  }
}

/**
 * Save exchange snapshot to database
 */
function saveExchangeSnapshot(ticker, exchange, data) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO exchange_snapshots
      (ticker, exchange, bid_total, ask_total, imbalance, spread, spread_pct, best_bid, best_ask, volume_24h, price, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ticker,
      exchange,
      data.bidTotal || 0,
      data.askTotal || 0,
      data.imbalance || 0,
      data.spread || 0,
      data.spreadPct || 0,
      data.bestBid || 0,
      data.bestAsk || 0,
      data.volume24h || 0,
      data.price || 0,
      Date.now()
    );
  } catch (err) {
    console.error('[MultiExchange] DB save error (exchange):', err.message);
  }
}

/**
 * Save derivatives data to database
 */
function saveDerivativesData(ticker, data) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO derivatives_data
      (ticker, open_interest, oi_usd, funding_rate, futures_price, spot_price, basis, basis_pct, oi_change_pct, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ticker,
      data.openInterest || 0,
      data.oiUsd || 0,
      data.fundingRate || 0,
      data.futuresPrice || 0,
      data.spotPrice || 0,
      data.basis || 0,
      data.basisPct || 0,
      data.oiChangePct || 0,
      Date.now()
    );
  } catch (err) {
    console.error('[MultiExchange] DB save error (derivatives):', err.message);
  }
}

/**
 * Save DeFi snapshot to database
 */
function saveDeFiSnapshot(data) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO defi_snapshots
      (total_tvl, tvl_change_24h, dex_volume_24h, stablecoin_mcap, stablecoin_change, top_chains_json, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.totalTvl || 0,
      data.tvlChange24h || 0,
      data.dexVolume24h || 0,
      data.stablecoinMcap || 0,
      data.stablecoinChange || 0,
      JSON.stringify(data.topChains || []),
      Date.now()
    );
  } catch (err) {
    console.error('[MultiExchange] DB save error (defi):', err.message);
  }
}

/**
 * Save news item to database (INSERT OR IGNORE for deduplication)
 */
function saveNewsItem(item) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO news_items
      (external_id, source, title, url, currencies, sentiment_score, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.id || item.url,
      item.source || 'cryptopanic',
      item.title || '',
      item.url || '',
      JSON.stringify(item.currencies || []),
      item.sentimentScore || 0,
      item.publishedAt || Date.now()
    );
  } catch (err) {
    console.error('[MultiExchange] DB save error (news):', err.message);
  }
}

/**
 * Start all data collection with staggered initialization
 */
export async function startDataCollection(ticker = 'BTCUSD') {
  if (isRunning) {
    console.warn('[MultiExchange] Data collection already running');
    return;
  }

  console.log('[MultiExchange] Starting data collection...');
  activeTicker = ticker;
  isRunning = true;

  // Load all services
  await loadServices();

  // Binance: DISABLED — geo-blocked from VPS and not needed for Kraken
  // If re-enabling, uncomment the lines below
  // if (binanceService) {
  //   fetchBinanceOrderBook();
  //   intervals.binance_orderbook = setInterval(fetchBinanceOrderBook, 10000);
  //   fetchBinanceCandles();
  //   intervals.binance_candles = setInterval(fetchBinanceCandles, 30000);
  // }

  // OKX: start after 5s
  setTimeout(() => {
    if (okxService && isRunning) {
      fetchOKXOpenInterest(); // Initial fetch
      intervals.okx_oi = setInterval(fetchOKXOpenInterest, 60000);

      fetchOKXFundingRates(); // Initial fetch
      intervals.okx_funding = setInterval(fetchOKXFundingRates, 300000);
    }
  }, 5000);

  // CoinGecko: stagger startup to avoid burst 429s
  setTimeout(() => {
    if (coinGeckoService && isRunning) {
      fetchCoinGeckoMarket(); // Initial market fetch
      intervals.coingecko_market = setInterval(fetchCoinGeckoMarket, 600000);
    }
  }, 10000);

  setTimeout(() => {
    if (coinGeckoService && isRunning) {
      fetchCoinGeckoSocial(); // Initial social fetch (staggered 30s after market)
      intervals.coingecko_social = setInterval(fetchCoinGeckoSocial, 600000);
    }
  }, 40000);

  setTimeout(() => {
    if (!isRunning) return;
    fetchFearGreed(); // Initial fetch
    intervals.fear_greed = setInterval(fetchFearGreed, 1800000);
  }, 15000);

  // DeFiLlama: start after 15s
  setTimeout(() => {
    if (defiLlamaService && isRunning) {
      fetchDeFiLlama(); // Initial fetch
      intervals.defillama = setInterval(fetchDeFiLlama, 900000);
    }
  }, 15000);

  // CryptoPanic: start after 20s
  setTimeout(() => {
    if (cryptoPanicService && isRunning) {
      fetchCryptoPanicNews(); // Initial fetch
      intervals.cryptopanic = setInterval(fetchCryptoPanicNews, 300000);
    }
  }, 20000);

  // Reddit: start after 25s (every 30min to avoid rate limits — Reddit free tier is very restricted)
  setTimeout(() => {
    if (redditService && isRunning) {
      fetchRedditSentiment(); // Initial fetch
      intervals.reddit = setInterval(fetchRedditSentiment, 1800000);
    }
  }, 25000);

  console.log('[MultiExchange] Data collection started');

  // Return cleanup function
  return stopDataCollection;
}

/**
 * Stop all data collection
 */
export function stopDataCollection() {
  if (!isRunning) {
    console.warn('[MultiExchange] Data collection not running');
    return;
  }

  console.log('[MultiExchange] Stopping data collection...');

  // Clear all intervals
  Object.values(intervals).forEach(interval => clearInterval(interval));
  intervals = {};

  isRunning = false;
  console.log('[MultiExchange] Data collection stopped');
}

/**
 * Change active ticker for frequent updates
 */
export function setActiveTicker(ticker) {
  if (!TICKERS.includes(ticker)) {
    console.warn(`[MultiExchange] Invalid ticker: ${ticker}`);
    return;
  }

  console.log(`[MultiExchange] Active ticker changed: ${activeTicker} -> ${ticker}`);
  activeTicker = ticker;
}

/**
 * Get latest exchange snapshot for a ticker
 */
export function getExchangeSnapshot(ticker) {
  return cache.exchangeData[ticker] || null;
}

/**
 * Get latest derivatives snapshot for a ticker
 */
export function getDerivativesSnapshot(ticker) {
  return cache.derivatives[ticker] || null;
}

/**
 * Get latest DeFi overview
 */
export function getDeFiSnapshot() {
  return cache.defi;
}

/**
 * Get recent news items (optionally filtered by ticker)
 */
export function getNewsSnapshot(ticker = null) {
  if (!ticker) return cache.news;

  return cache.news.filter(item =>
    item.currencies && item.currencies.some(c =>
      ticker.toUpperCase().includes(c.toUpperCase())
    )
  );
}

/**
 * Get social snapshot for a ticker
 */
export function getSocialSnapshot(ticker) {
  return cache.social[ticker] || null;
}

/**
 * Get latest Fear & Greed index
 */
export function getFearGreed() {
  return cache.fearGreed;
}

/**
 * Get collection status
 */
export function getCollectionStatus() {
  return {
    isRunning,
    activeTicker,
    lastFetchTimes,
    errorCounts,
    totalSnapshots,
    cacheStats: {
      exchangeData: Object.keys(cache.exchangeData).length,
      derivatives: Object.keys(cache.derivatives).length,
      defi: cache.defi ? 'loaded' : 'empty',
      news: cache.news.length,
      social: Object.keys(cache.social).length,
      fearGreed: cache.fearGreed ? 'loaded' : 'empty'
    }
  };
}

/**
 * Get all cached data for a ticker (convenience method)
 */
export function getAllDataForTicker(ticker) {
  return {
    exchange: getExchangeSnapshot(ticker),
    derivatives: getDerivativesSnapshot(ticker),
    social: getSocialSnapshot(ticker),
    news: getNewsSnapshot(ticker),
    defi: getDeFiSnapshot(),
    fearGreed: getFearGreed()
  };
}

// Export cache for direct access if needed
export { cache };
