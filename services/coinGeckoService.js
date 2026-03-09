import fetch from 'node-fetch';

// Rate limiting tracker
let requestCount = 0;
let lastResetTime = Date.now();
const MAX_REQUESTS_PER_MINUTE = 5; // CoinGecko free tier: ~10-30/min, stay well under
const RESET_INTERVAL = 60000; // 1 minute

// 429 backoff tracker
let backoffUntil = 0;
let consecutiveBackoffs = 0;

// Cache storage
const cache = new Map();

// Cache TTL constants (in milliseconds)
const CACHE_TTL = {
  TRENDING: 10 * 60 * 1000,      // 10 minutes
  SOCIAL: 10 * 60 * 1000,        // 10 minutes
  MARKET_OVERVIEW: 5 * 60 * 1000, // 5 minutes
  PRICES: 2 * 60 * 1000          // 2 minutes
};

// Ticker to CoinGecko ID mapping
const TICKER_TO_GECKO_ID = {
  BTCUSD: 'bitcoin',
  ETHUSD: 'ethereum',
  XRPUSD: 'ripple',
  BNBUSD: 'binancecoin',
  SOLUSD: 'solana',
  ADAUSD: 'cardano',
  DOGEUSD: 'dogecoin',
  LINKUSD: 'chainlink',
  DOTUSD: 'polkadot',
  AVAXUSD: 'avalanche-2'
};

/**
 * Convert trading pair ticker to CoinGecko ID
 */
function toGeckoId(ticker) {
  const normalized = ticker.toUpperCase();
  return TICKER_TO_GECKO_ID[normalized] || null;
}

/**
 * Check and enforce rate limiting (includes 429 backoff)
 */
function checkRateLimit() {
  const now = Date.now();

  // Respect 429 backoff period
  if (now < backoffUntil) {
    const waitSec = Math.ceil((backoffUntil - now) / 1000);
    if (waitSec % 30 === 0) { // Log every 30s during backoff
      console.log(`[CoinGecko] In 429 backoff, ${waitSec}s remaining`);
    }
    return false;
  }

  // Reset counter if minute has passed
  if (now - lastResetTime >= RESET_INTERVAL) {
    requestCount = 0;
    lastResetTime = now;
  }

  // Check if we've hit the limit
  if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
    const waitTime = RESET_INTERVAL - (now - lastResetTime);
    console.log(`[CoinGecko] Rate limit reached. Wait ${Math.ceil(waitTime / 1000)}s`);
    return false;
  }

  requestCount++;
  return true;
}

/**
 * Trigger exponential backoff on 429 response
 */
function trigger429Backoff() {
  consecutiveBackoffs++;
  // 2min, 4min, 8min, max 10min
  const backoffMs = Math.min(2 * 60000 * Math.pow(2, consecutiveBackoffs - 1), 10 * 60000);
  backoffUntil = Date.now() + backoffMs;
  console.warn(`[CoinGecko] 429 received — backing off for ${Math.ceil(backoffMs / 60000)}min (attempt #${consecutiveBackoffs})`);
}

/**
 * Reset backoff counter on successful request
 */
function resetBackoff() {
  if (consecutiveBackoffs > 0) {
    consecutiveBackoffs = 0;
    console.log(`[CoinGecko] Backoff cleared — requests succeeding again`);
  }
}

/**
 * Get cached data if still valid
 */
function getCached(key, ttl) {
  const cached = cache.get(key);
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > ttl) {
    cache.delete(key);
    return null;
  }

  return cached.data;
}

/**
 * Set cache data
 */
function setCache(key, data, ttl) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
}

/**
 * Return stale cache entry (ignoring TTL) as fallback
 */
function getStaleCache(key) {
  const cached = cache.get(key);
  return cached ? cached.data : null;
}

/**
 * Make API request with rate limiting, 429 backoff, and error handling
 */
async function makeRequest(url, cacheKey, ttl) {
  try {
    // Check cache first
    const cached = getCached(cacheKey, ttl);
    if (cached) {
      return cached;
    }

    // Check rate limit (includes 429 backoff)
    if (!checkRateLimit()) {
      return getStaleCache(cacheKey);
    }

    // Make request with timeout
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 429) {
      trigger429Backoff();
      return getStaleCache(cacheKey);
    }

    if (!response.ok) {
      console.error(`[CoinGecko] API error: ${response.status} ${response.statusText}`);
      return getStaleCache(cacheKey);
    }

    const data = await response.json();

    // Success — cache the result and clear backoff
    setCache(cacheKey, data, ttl);
    resetBackoff();

    return data;
  } catch (error) {
    console.error(`[CoinGecko] Request failed:`, error.message);
    return getStaleCache(cacheKey);
  }
}

/**
 * Get trending coins from CoinGecko
 * Returns array of { id, name, symbol, marketCapRank, thumb, score }
 */
export async function getTrendingCoins() {
  const url = 'https://api.coingecko.com/api/v3/search/trending';
  const data = await makeRequest(url, 'trending', CACHE_TTL.TRENDING);

  if (!data || !data.coins) {
    return [];
  }

  return data.coins.map(item => ({
    id: item.item.id,
    name: item.item.name,
    symbol: item.item.symbol,
    marketCapRank: item.item.market_cap_rank,
    thumb: item.item.thumb,
    score: item.item.score
  }));
}

/**
 * Get social data for a specific coin
 * Returns { twitterFollowers, redditSubscribers, telegramMembers, sentimentUpPercent, sentimentDownPercent, communityScore }
 */
export async function getCoinSocialData(ticker) {
  const geckoId = toGeckoId(ticker);
  if (!geckoId) {
    console.log(`[CoinGecko] Unknown ticker: ${ticker}`);
    return null;
  }

  const url = `https://api.coingecko.com/api/v3/coins/${geckoId}?localization=false&tickers=false&community_data=true&developer_data=false`;
  const cacheKey = `social_${geckoId}`;
  const data = await makeRequest(url, cacheKey, CACHE_TTL.SOCIAL);

  if (!data) {
    return null;
  }

  const community = data.community_data || {};
  const sentiment = data.sentiment_votes_up_percentage;

  return {
    twitterFollowers: community.twitter_followers || 0,
    redditSubscribers: community.reddit_subscribers || 0,
    telegramMembers: community.telegram_channel_user_count || 0,
    sentimentUpPercent: sentiment || 0,
    sentimentDownPercent: sentiment ? (100 - sentiment) : 0,
    communityScore: data.community_score || 0
  };
}

/**
 * Get global market overview
 * Returns { totalMarketCap, totalVolume, btcDominance, ethDominance, marketCapChangePercent24h, activeCryptocurrencies }
 */
export async function getMarketOverview() {
  const url = 'https://api.coingecko.com/api/v3/global';
  const data = await makeRequest(url, 'market_overview', CACHE_TTL.MARKET_OVERVIEW);

  if (!data || !data.data) {
    return null;
  }

  const global = data.data;

  return {
    totalMarketCap: global.total_market_cap?.usd || 0,
    totalVolume: global.total_volume?.usd || 0,
    btcDominance: global.market_cap_percentage?.btc || 0,
    ethDominance: global.market_cap_percentage?.eth || 0,
    marketCapChangePercent24h: global.market_cap_change_percentage_24h_usd || 0,
    activeCryptocurrencies: global.active_cryptocurrencies || 0
  };
}

/**
 * Get simple price data for multiple tickers
 * Returns Map<ticker, { price, change24h, marketCap }>
 */
export async function getSimplePrices(tickers) {
  if (!tickers || tickers.length === 0) {
    return new Map();
  }

  // Convert tickers to gecko IDs
  const geckoIds = [];
  const tickerToId = new Map();

  for (const ticker of tickers) {
    const geckoId = toGeckoId(ticker);
    if (geckoId) {
      geckoIds.push(geckoId);
      tickerToId.set(geckoId, ticker);
    }
  }

  if (geckoIds.length === 0) {
    return new Map();
  }

  const idsParam = geckoIds.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;
  const cacheKey = `prices_${idsParam}`;
  const data = await makeRequest(url, cacheKey, CACHE_TTL.PRICES);

  if (!data) {
    return new Map();
  }

  const result = new Map();

  for (const [geckoId, priceData] of Object.entries(data)) {
    const ticker = tickerToId.get(geckoId);
    if (ticker) {
      result.set(ticker, {
        price: priceData.usd || 0,
        change24h: priceData.usd_24h_change || 0,
        marketCap: priceData.usd_market_cap || 0
      });
    }
  }

  return result;
}

/**
 * Check if a ticker is currently trending
 * Returns boolean
 */
export async function isTrending(ticker) {
  const geckoId = toGeckoId(ticker);
  if (!geckoId) {
    return false;
  }

  const trending = await getTrendingCoins();
  if (!trending) {
    return false;
  }

  return trending.some(coin => coin.id === geckoId);
}

/**
 * Get full snapshot combining social + price + trending status
 * Returns comprehensive data object
 */
export async function getFullSnapshot(ticker) {
  try {
    const [socialData, prices, trending] = await Promise.all([
      getCoinSocialData(ticker),
      getSimplePrices([ticker]),
      isTrending(ticker)
    ]);

    const priceData = prices.get(ticker) || { price: 0, change24h: 0, marketCap: 0 };

    return {
      ticker,
      trending,
      price: priceData.price,
      change24h: priceData.change24h,
      marketCap: priceData.marketCap,
      social: socialData || {
        twitterFollowers: 0,
        redditSubscribers: 0,
        telegramMembers: 0,
        sentimentUpPercent: 0,
        sentimentDownPercent: 0,
        communityScore: 0
      },
      timestamp: Date.now()
    };
  } catch (error) {
    console.error(`[CoinGecko] getFullSnapshot failed for ${ticker}:`, error.message);
    return null;
  }
}

// Export utility function for external use
export { toGeckoId };

// Log cache stats periodically (every 5 minutes)
setInterval(() => {
  console.log(`[CoinGecko] Cache entries: ${cache.size}, Requests this minute: ${requestCount}`);
}, 5 * 60 * 1000);
