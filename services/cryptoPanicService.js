// services/cryptoPanicService.js
// Backend Node.js service for fetching crypto news from CryptoPanic and Alternative.me Fear & Greed Index

import fetch from 'node-fetch';

// API key (free tier — register at https://cryptopanic.com/developers/api/)
const API_KEY = process.env.CRYPTOPANIC_API_KEY || '';

// Cache configuration
const CACHE_TTL_NEWS = 5 * 60 * 1000; // 5 minutes
const CACHE_TTL_FEAR_GREED = 30 * 60 * 1000; // 30 minutes

// Error suppression: after first failure, exponentially back off (max 30 min)
let _newsErrorBackoff = 0;
let _newsLastError = 0;
const _NEWS_MAX_BACKOFF = 30 * 60 * 1000;

// Cache storage
let newsCache = {
  data: null,
  timestamp: 0,
  ticker: null
};

let fearGreedCache = {
  data: null,
  timestamp: 0
};

// Seen news IDs for deduplication
const seenNewsIds = new Set();

/**
 * Convert trading ticker to CryptoPanic currency code
 * @param {string} ticker - Trading ticker (e.g., 'BTCUSD', 'ETHUSD')
 * @returns {string} - Currency code (e.g., 'BTC', 'ETH')
 */
function tickerToCurrency(ticker) {
  if (!ticker) return null;
  // Strip USD suffix
  return ticker.replace(/USD$/, '').toUpperCase();
}

/**
 * Check if cache is valid
 * @param {Object} cache - Cache object
 * @param {number} ttl - Time to live in milliseconds
 * @returns {boolean}
 */
function isCacheValid(cache, ttl) {
  return cache.data && (Date.now() - cache.timestamp < ttl);
}

/**
 * Fetch latest crypto news from CryptoPanic
 * @param {string|null} ticker - Optional ticker to filter by (e.g., 'BTCUSD')
 * @param {number} limit - Maximum number of results (default 20)
 * @returns {Promise<Array|null>} - Array of news items or null on error
 */
export async function getLatestNews(ticker = null, limit = 20) {
  try {
    // Skip if no API key configured (free endpoint was deprecated)
    if (!API_KEY) {
      return newsCache.data || null;
    }

    const currency = tickerToCurrency(ticker);

    // Check cache
    if (isCacheValid(newsCache, CACHE_TTL_NEWS) && newsCache.ticker === ticker) {
      return newsCache.data;
    }

    // Backoff: skip fetch if recent error (exponential backoff)
    if (_newsErrorBackoff > 0 && (Date.now() - _newsLastError) < _newsErrorBackoff) {
      return null;
    }

    // Build URL with auth token
    let url = `https://cryptopanic.com/api/v1/posts/?auth_token=${API_KEY}&public=true`;
    if (currency) {
      url += `&currencies=${currency}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TradingDashboard/1.0'
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      _newsLastError = Date.now();
      _newsErrorBackoff = Math.min(_NEWS_MAX_BACKOFF, Math.max(_NEWS_MAX_BACKOFF, _newsErrorBackoff * 2 || _NEWS_MAX_BACKOFF));
      return null;
    }
    // Success: reset backoff
    _newsErrorBackoff = 0;

    const data = await response.json();

    if (!data.results || !Array.isArray(data.results)) {
      console.error('[CryptoPanic] Invalid response format');
      return null;
    }

    // Transform and deduplicate results
    const news = data.results.slice(0, limit).map(item => {
      // Add to seen IDs
      if (item.id) {
        seenNewsIds.add(item.id);
      }

      return {
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source?.title || 'Unknown',
        currencies: item.currencies?.map(c => c.code) || [],
        publishedAt: item.published_at,
        kind: item.kind || 'news'
      };
    });

    // Update cache
    newsCache = {
      data: news,
      timestamp: Date.now(),
      ticker
    };

    // Log only occasionally to reduce noise
    if (Math.random() < 0.1) console.log(`[CryptoPanic] Fetched ${news.length} news items`);
    return news;

  } catch (error) {
    console.error('[CryptoPanic] Error fetching news:', error.message);
    return null;
  }
}

/**
 * Fetch Fear & Greed Index from Alternative.me
 * @returns {Promise<Object|null>} - Fear & Greed data or null on error
 */
export async function getFearGreedIndex() {
  try {
    // Check cache
    if (isCacheValid(fearGreedCache, CACHE_TTL_FEAR_GREED)) {
      console.log('[CryptoPanic] Returning cached Fear & Greed');
      return fearGreedCache.data;
    }

    console.log('[CryptoPanic] Fetching Fear & Greed Index');

    const response = await fetch('https://api.alternative.me/fng/?limit=10', {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`[CryptoPanic] Fear & Greed HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      console.error('[CryptoPanic] Invalid Fear & Greed response');
      return null;
    }

    const latest = data.data[0];
    const result = {
      value: parseInt(latest.value, 10),
      classification: latest.value_classification,
      timestamp: parseInt(latest.timestamp, 10),
      history: data.data.map(item => ({
        value: parseInt(item.value, 10),
        classification: item.value_classification,
        timestamp: parseInt(item.timestamp, 10)
      }))
    };

    // Update cache
    fearGreedCache = {
      data: result,
      timestamp: Date.now()
    };

    console.log(`[CryptoPanic] Fear & Greed: ${result.value} (${result.classification})`);
    return result;

  } catch (error) {
    console.error('[CryptoPanic] Error fetching Fear & Greed:', error.message);
    return null;
  }
}

/**
 * Analyze Fear & Greed trend
 * @returns {Promise<string|null>} - 'IMPROVING' | 'WORSENING' | 'STABLE' or null
 */
export async function getFearGreedTrend() {
  try {
    const fgData = await getFearGreedIndex();
    if (!fgData || !fgData.history || fgData.history.length < 3) {
      return null;
    }

    // Get last 3 values
    const values = fgData.history.slice(0, 3).map(h => h.value);
    const [current, prev1, prev2] = values;

    // Calculate trend
    const change1 = current - prev1;
    const change2 = prev1 - prev2;
    const avgChange = (change1 + change2) / 2;

    if (avgChange > 5) {
      return 'IMPROVING'; // Moving toward greed
    } else if (avgChange < -5) {
      return 'WORSENING'; // Moving toward fear
    } else {
      return 'STABLE';
    }

  } catch (error) {
    console.error('[CryptoPanic] Error calculating trend:', error.message);
    return null;
  }
}

/**
 * Get comprehensive news snapshot for a ticker
 * @param {string} ticker - Trading ticker (e.g., 'BTCUSD')
 * @returns {Promise<Object|null>} - News snapshot or null on error
 */
export async function getNewsSnapshot(ticker) {
  try {
    console.log(`[CryptoPanic] Getting news snapshot for ${ticker}`);

    // Fetch news and fear & greed in parallel
    const [news, fearGreed, trend] = await Promise.all([
      getLatestNews(ticker, 20),
      getFearGreedIndex(),
      getFearGreedTrend()
    ]);

    if (!news && !fearGreed) {
      console.error('[CryptoPanic] Failed to fetch both news and Fear & Greed');
      return null;
    }

    return {
      headlines: news || [],
      newsCount: news ? news.length : 0,
      fearGreed: fearGreed ? fearGreed.value : null,
      fearGreedClassification: fearGreed ? fearGreed.classification : null,
      fearGreedTrend: trend,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[CryptoPanic] Error getting news snapshot:', error.message);
    return null;
  }
}

/**
 * Clear news cache (useful for testing)
 */
export function clearCache() {
  newsCache = { data: null, timestamp: 0, ticker: null };
  fearGreedCache = { data: null, timestamp: 0 };
  seenNewsIds.clear();
  console.log('[CryptoPanic] Cache cleared');
}

/**
 * Get cache stats
 */
export function getCacheStats() {
  return {
    news: {
      cached: newsCache.data !== null,
      age: newsCache.data ? Date.now() - newsCache.timestamp : 0,
      ticker: newsCache.ticker,
      count: newsCache.data ? newsCache.data.length : 0
    },
    fearGreed: {
      cached: fearGreedCache.data !== null,
      age: fearGreedCache.data ? Date.now() - fearGreedCache.timestamp : 0
    },
    seenNewsCount: seenNewsIds.size
  };
}

export default {
  getLatestNews,
  getFearGreedIndex,
  getFearGreedTrend,
  getNewsSnapshot,
  clearCache,
  getCacheStats
};
