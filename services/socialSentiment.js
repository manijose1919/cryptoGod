/**
 * Social Sentiment Service (Backend JS Module)
 *
 * Fetches social sentiment data from free public APIs:
 * - Alternative.me Fear & Greed Index
 * - CryptoPanic news feed
 * - CoinGecko trending coins
 *
 * Aggregates into a unified sentiment score for trade decisions.
 * All endpoints are free and require no API keys.
 */

import fetch from 'node-fetch';

// ============================================
// CACHE LAYER
// ============================================

const cache = new Map();

/**
 * Get a cached value if it exists and hasn't expired.
 * @param {string} key - Cache key
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {any|null} Cached value or null if expired/missing
 */
function getCached(key, maxAgeMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > maxAgeMs) return null;
  return entry.data;
}

/**
 * Store a value in the cache.
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ============================================
// RATE LIMITER
// ============================================

const lastCallTimestamps = new Map();
const RATE_LIMIT_MS = 60_000; // 1 call per minute per endpoint

/**
 * Check whether a call to the given endpoint is allowed under rate limits.
 * If not allowed, returns false. If allowed, records the timestamp and returns true.
 * @param {string} endpointKey - Unique identifier for the endpoint
 * @returns {boolean}
 */
function isRateLimitAllowed(endpointKey) {
  const lastCall = lastCallTimestamps.get(endpointKey);
  if (lastCall && Date.now() - lastCall < RATE_LIMIT_MS) {
    return false;
  }
  lastCallTimestamps.set(endpointKey, Date.now());
  return true;
}

// ============================================
// DEFAULT / FALLBACK VALUES
// ============================================

const DEFAULT_FEAR_GREED = {
  value: 50,
  classification: 'Neutral',
  timestamp: Date.now(),
};

const DEFAULT_NEWS = [];

const DEFAULT_TRENDING = [];

// ============================================
// 1. FEAR & GREED INDEX
// ============================================

const FEAR_GREED_CACHE_KEY = 'fearGreed';
const FEAR_GREED_CACHE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch the Crypto Fear & Greed Index from alternative.me.
 * Cached for 30 minutes (the index only updates once daily).
 *
 * @returns {Promise<{ value: number, classification: string, timestamp: number }>}
 */
export async function fetchFearGreedIndex() {
  // Check cache first
  const cached = getCached(FEAR_GREED_CACHE_KEY, FEAR_GREED_CACHE_MS);
  if (cached) return cached;

  // Rate limit check - return cached or default if too frequent
  if (!isRateLimitAllowed('fearGreed')) {
    const stale = cache.get(FEAR_GREED_CACHE_KEY);
    return stale ? stale.data : { ...DEFAULT_FEAR_GREED, timestamp: Date.now() };
  }

  try {
    const response = await fetch('https://api.alternative.me/fng/', {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Fear & Greed API returned ${response.status}`);
    }

    const json = await response.json();
    const entry = json.data && json.data[0];

    if (!entry) {
      throw new Error('No data in Fear & Greed response');
    }

    const value = parseInt(entry.value, 10);

    const result = {
      value,
      classification: entry.value_classification || classifyFearGreed(value),
      timestamp: entry.timestamp ? parseInt(entry.timestamp, 10) * 1000 : Date.now(),
    };

    setCache(FEAR_GREED_CACHE_KEY, result);
    return result;
  } catch (err) {
    console.error('[SocialSentiment] fetchFearGreedIndex error:', err.message);
    // Return stale cache if available, otherwise default
    const stale = cache.get(FEAR_GREED_CACHE_KEY);
    return stale ? stale.data : { ...DEFAULT_FEAR_GREED, timestamp: Date.now() };
  }
}

/**
 * Classify a fear/greed value into a human-readable label.
 * @param {number} value - 0 to 100
 * @returns {string}
 */
function classifyFearGreed(value) {
  if (value <= 20) return 'Extreme Fear';
  if (value <= 40) return 'Fear';
  if (value <= 60) return 'Neutral';
  if (value <= 80) return 'Greed';
  return 'Extreme Greed';
}

// ============================================
// 2. CRYPTO NEWS (CryptoPanic)
// ============================================

const NEWS_CACHE_KEY = 'cryptoNews';
const NEWS_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch recent crypto news from CryptoPanic's free public API.
 * Cached for 5 minutes.
 *
 * @param {string} filter - Filter type: 'all', 'rising', 'hot', 'bullish', 'bearish', 'important', 'saved', 'lol'
 * @returns {Promise<Array<{ title: string, source: string, publishedAt: string, sentiment: string, url: string }>>}
 */
export async function fetchCryptoNews(filter = 'all') {
  const cacheKey = `${NEWS_CACHE_KEY}_${filter}`;

  // Check cache first
  const cached = getCached(cacheKey, NEWS_CACHE_MS);
  if (cached) return cached;

  // Rate limit check
  if (!isRateLimitAllowed('cryptoNews')) {
    const stale = cache.get(cacheKey);
    return stale ? stale.data : [...DEFAULT_NEWS];
  }

  // Backoff on repeated failures
  if (!fetchCryptoNews._backoff) fetchCryptoNews._backoff = 0;
  if (!fetchCryptoNews._lastErr) fetchCryptoNews._lastErr = 0;
  if (fetchCryptoNews._backoff > 0 && (Date.now() - fetchCryptoNews._lastErr) < fetchCryptoNews._backoff) {
    const stale = cache.get(cacheKey);
    return stale ? stale.data : [...DEFAULT_NEWS];
  }

  // CryptoPanic free API has been deprecated (returns 404 permanently).
  // Return cached/default data. News is fetched by cryptoPanicService.js if API key is configured.
  const stale = cache.get(cacheKey);
  return stale ? stale.data : [...DEFAULT_NEWS];
}

// ============================================
// 3. COINGECKO TRENDING
// ============================================

const TRENDING_CACHE_KEY = 'trendingCoins';
const TRENDING_CACHE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Fetch trending coins from CoinGecko (free, no API key).
 * Cached for 15 minutes.
 *
 * @returns {Promise<Array<{ name: string, symbol: string, marketCapRank: number, score: number }>>}
 */
export async function fetchCoinGeckoTrending() {
  // Check cache first
  const cached = getCached(TRENDING_CACHE_KEY, TRENDING_CACHE_MS);
  if (cached) return cached;

  // Rate limit check
  if (!isRateLimitAllowed('trendingCoins')) {
    const stale = cache.get(TRENDING_CACHE_KEY);
    return stale ? stale.data : [...DEFAULT_TRENDING];
  }

  try {
    const response = await fetch('https://api.coingecko.com/api/v3/search/trending', {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`CoinGecko trending API returned ${response.status}`);
    }

    const json = await response.json();
    const coins = json.coins || [];

    const trending = coins.map((entry) => {
      const item = entry.item || entry;
      return {
        name: item.name || '',
        symbol: (item.symbol || '').toUpperCase(),
        marketCapRank: item.market_cap_rank || 0,
        score: item.score != null ? item.score : 0,
      };
    });

    setCache(TRENDING_CACHE_KEY, trending);
    return trending;
  } catch (err) {
    console.error('[SocialSentiment] fetchCoinGeckoTrending error:', err.message);
    const stale = cache.get(TRENDING_CACHE_KEY);
    return stale ? stale.data : [...DEFAULT_TRENDING];
  }
}

// ============================================
// 4. AGGREGATED SOCIAL SENTIMENT SCORE
// ============================================

/**
 * Aggregate all social sentiment sources into a single unified score.
 *
 * Scoring breakdown:
 *   - Fear & Greed Index: 60% weight  -> (value - 50) * 1.2
 *   - News sentiment:     40% weight  -> (positiveRatio - 0.5) * 80
 *
 * Final score is clamped to [-100, +100].
 *
 * @returns {Promise<{
 *   score: number,
 *   fearGreed: { value: number, classification: string },
 *   newsPositiveRatio: number,
 *   trendingCoins: string[],
 *   recommendation: string,
 *   lastUpdated: number
 * }>}
 */
export async function getSocialSentimentScore() {
  // Fetch all three sources in parallel
  const [fearGreed, news, trending] = await Promise.all([
    fetchFearGreedIndex(),
    fetchCryptoNews(),
    fetchCoinGeckoTrending(),
  ]);

  // Calculate news positive ratio
  let newsPositiveRatio = 0.5; // default neutral
  if (news.length > 0) {
    const positiveCount = news.filter((n) => n.sentiment === 'positive').length;
    newsPositiveRatio = positiveCount / news.length;
  }

  // Calculate composite score
  // Fear & Greed contribution (60%): maps 0-100 to roughly -60 to +60
  const fearGreedComponent = (fearGreed.value - 50) * 1.2;

  // News contribution (40%): maps 0-1 ratio to roughly -40 to +40
  const newsComponent = (newsPositiveRatio - 0.5) * 80;

  // Combined score clamped to [-100, +100]
  const rawScore = fearGreedComponent + newsComponent;
  const score = Math.round(Math.max(-100, Math.min(100, rawScore)));

  // Determine recommendation from score thresholds
  let recommendation;
  if (score <= -60) {
    recommendation = 'STRONG_BUY'; // Extreme fear = contrarian buy
  } else if (score <= -20) {
    recommendation = 'BUY';
  } else if (score <= 20) {
    recommendation = 'NEUTRAL';
  } else if (score <= 60) {
    recommendation = 'SELL';
  } else {
    recommendation = 'STRONG_SELL'; // Extreme greed = contrarian sell
  }

  // Extract trending coin symbols
  const trendingCoins = trending.map((c) => c.symbol);

  return {
    score,
    fearGreed: {
      value: fearGreed.value,
      classification: fearGreed.classification,
    },
    newsPositiveRatio: Math.round(newsPositiveRatio * 1000) / 1000, // 3 decimal places
    trendingCoins,
    recommendation,
    lastUpdated: Date.now(),
  };
}

// ============================================
// 5. TRADE DECISION HELPER
// ============================================

/**
 * Determine whether trading should proceed based on the Fear & Greed value
 * from the aggregated sentiment score.
 *
 * Uses a contrarian approach:
 *   - Extreme Fear  (< 20):  proceed, size modifier 1.3 (buy the dip)
 *   - Fear          (20-40): proceed, size modifier 1.1
 *   - Neutral       (40-60): proceed, size modifier 1.0
 *   - Greed         (60-80): proceed, size modifier 0.8 (reduce exposure)
 *   - Extreme Greed (> 80):  do NOT proceed, modifier 0.5
 *
 * @param {{ fearGreed: { value: number } }} sentimentData - Output from getSocialSentimentScore()
 * @returns {{ proceed: boolean, reason: string, modifier: number }}
 */
export function shouldTradeBasedOnSentiment(sentimentData) {
  const fgValue = sentimentData && sentimentData.fearGreed
    ? sentimentData.fearGreed.value
    : 50;

  if (fgValue < 20) {
    return {
      proceed: true,
      reason: 'Extreme fear - contrarian buy opportunity',
      modifier: 1.3,
    };
  }

  if (fgValue < 40) {
    return {
      proceed: true,
      reason: 'Fear zone - favorable for entries',
      modifier: 1.1,
    };
  }

  if (fgValue <= 60) {
    return {
      proceed: true,
      reason: 'Neutral sentiment - standard conditions',
      modifier: 1.0,
    };
  }

  if (fgValue <= 80) {
    return {
      proceed: true,
      reason: 'Greed zone - reduce position sizes',
      modifier: 0.8,
    };
  }

  // Extreme Greed (above 80)
  return {
    proceed: false,
    reason: 'Extreme greed - high risk',
    modifier: 0.5,
  };
}

// ============================================
// 6. PER-TICKER NEWS SENTIMENT
// ============================================

/**
 * Mapping from ticker symbols to searchable names/aliases.
 * Used to match CryptoPanic headlines to specific coins.
 */
const TICKER_NAME_MAP = {
  BTCUSD: ['bitcoin', 'btc'],
  ETHUSD: ['ethereum', 'eth'],
  XRPUSD: ['xrp', 'ripple'],
  SOLUSD: ['solana', 'sol'],
  BNBUSD: ['bnb', 'binance coin'],
  ADAUSD: ['cardano', 'ada'],
  DOGEUSD: ['dogecoin', 'doge'],
  LINKUSD: ['chainlink', 'link'],
  DOTUSD: ['polkadot', 'dot'],
  AVAXUSD: ['avalanche', 'avax'],
  LTCUSD: ['litecoin', 'ltc'],
  UNIUSD: ['uniswap', 'uni'],
  ATOMUSD: ['cosmos', 'atom'],
  NEARUSD: ['near protocol', 'near'],
  APTUSD: ['aptos', 'apt'],
  ARBUSD: ['arbitrum', 'arb'],
  OPUSD: ['optimism', 'op'],
  SUIUSD: ['sui'],
  AAVEUSD: ['aave'],
  INJUSD: ['injective', 'inj'],
  RENDERUSD: ['render', 'rndr'],
  FETUSD: ['fetch.ai', 'fet'],
  GRTUSD: ['the graph', 'grt'],
};

/**
 * Extract per-ticker sentiment from a pre-fetched news array.
 *
 * Scans article titles for mentions of the coin's name or symbol.
 * Returns a sentiment score (-1 to +1) based on the ratio of
 * positive/negative headlines mentioning this coin.
 *
 * @param {string} ticker - e.g. 'BTCUSD'
 * @param {Array<{ title: string, sentiment: string }>} allNews - from fetchCryptoNews()
 * @returns {{ sentiment: number, mentionCount: number, headlines: string[] }}
 */
export function getTickerNewsSentiment(ticker, allNews) {
  if (!allNews || allNews.length === 0) {
    return { sentiment: 0, mentionCount: 0, headlines: [] };
  }

  // Get search terms for this ticker
  let searchTerms = TICKER_NAME_MAP[ticker];
  if (!searchTerms) {
    // Fallback: extract base symbol (e.g. 'BTCUSD' → 'btc')
    const base = ticker.replace(/USD$/, '').toLowerCase();
    if (base.length >= 2) {
      searchTerms = [base];
    } else {
      return { sentiment: 0, mentionCount: 0, headlines: [] };
    }
  }

  // Filter news that mentions this coin
  const matching = allNews.filter((article) => {
    const titleLower = (article.title || '').toLowerCase();
    return searchTerms.some((term) => titleLower.includes(term));
  });

  if (matching.length === 0) {
    return { sentiment: 0, mentionCount: 0, headlines: [] };
  }

  // Calculate sentiment from matching articles
  let positive = 0;
  let negative = 0;
  for (const article of matching) {
    if (article.sentiment === 'positive') positive++;
    else if (article.sentiment === 'negative') negative++;
  }

  const total = matching.length;
  // Score: (positive - negative) / total → range [-1, +1]
  const sentiment = total > 0 ? (positive - negative) / total : 0;

  return {
    sentiment: Math.round(sentiment * 1000) / 1000,
    mentionCount: total,
    headlines: matching.slice(0, 5).map((a) => a.title),
  };
}

/**
 * Check if a ticker's base symbol appears in CoinGecko trending list.
 *
 * @param {string} ticker - e.g. 'BTCUSD'
 * @param {Array<{ symbol: string }>} trendingCoins - from fetchCoinGeckoTrending()
 * @returns {boolean}
 */
export function isTrendingCoin(ticker, trendingCoins) {
  if (!trendingCoins || trendingCoins.length === 0) return false;
  const base = ticker.replace(/USD$/, '').toUpperCase();
  return trendingCoins.some((c) => (c.symbol || c).toUpperCase() === base);
}
