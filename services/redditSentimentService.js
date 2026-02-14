// Reddit Sentiment Service - Backend Node.js Module
// Scrapes real Reddit data from public JSON endpoints (no API key needed)

import fetch from 'node-fetch';

// Ticker to search term mapping
const TICKER_SEARCH_MAP = {
  BTCUSD: ["bitcoin", "BTC"],
  ETHUSD: ["ethereum", "ETH"],
  XRPUSD: ["XRP", "ripple"],
  SOLUSD: ["solana", "SOL"],
  ADAUSD: ["cardano", "ADA"],
  DOGEUSD: ["dogecoin", "DOGE"],
  LINKUSD: ["chainlink", "LINK"],
  DOTUSD: ["polkadot", "DOT"],
  AVAXUSD: ["avalanche", "AVAX"],
  BNBUSD: ["BNB", "binance coin"]
};

// Subreddits to monitor
const CRYPTO_SUBREDDITS = [
  'CryptoCurrency',
  'Bitcoin',
  'ethereum',
  'CryptoMarkets',
  'SatoshiStreetBets'
];

// Cache configuration
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

// Rate limiting configuration
const MIN_REQUEST_DELAY_MS = 2000; // 2 seconds between requests
const RATE_LIMIT_BACKOFF_MS = 60000; // 60 seconds on 429
let lastRequestTime = 0;
let isBackingOff = false;
let backoffUntil = 0;

// User-Agent for Reddit requests
const USER_AGENT = 'TradingDashboard/1.0 (educational crypto analysis)';

/**
 * Rate-limited delay before making a request
 */
async function rateLimit() {
  // Check if we're in backoff mode
  if (isBackingOff) {
    const now = Date.now();
    if (now < backoffUntil) {
      const waitTime = backoffUntil - now;
      console.log(`[Reddit] Rate limit backoff - waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      isBackingOff = false;
    } else {
      isBackingOff = false;
    }
  }

  // Enforce minimum delay between requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_DELAY_MS) {
    const waitTime = MIN_REQUEST_DELAY_MS - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastRequestTime = Date.now();
}

/**
 * Fetch from Reddit with rate limiting and error handling
 */
async function fetchReddit(url) {
  await rateLimit();

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT
      },
      timeout: 10000
    });

    // Handle rate limiting
    if (response.status === 429) {
      console.log(`[Reddit] Rate limited (429) - backing off for 60s`);
      isBackingOff = true;
      backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      return null;
    }

    if (!response.ok) {
      console.log(`[Reddit] HTTP ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.log(`[Reddit] Fetch error: ${error.message}`);
    return null;
  }
}

/**
 * Get posts from a subreddit
 * @param {string} subreddit - Subreddit name (without r/)
 * @param {string} sort - Sort type: 'hot', 'new', 'top', 'rising'
 * @param {number} limit - Number of posts (max 100)
 * @returns {Promise<Array|null>} Array of post objects or null on error
 */
export async function getSubredditPosts(subreddit, sort = 'hot', limit = 25) {
  const cacheKey = `subreddit:${subreddit}:${sort}:${limit}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
  const response = await fetchReddit(url);

  if (!response || !response.data || !response.data.children) {
    return null;
  }

  const posts = response.data.children.map(child => {
    const post = child.data;
    return {
      title: post.title,
      selftext: post.selftext,
      score: post.score,
      comments: post.num_comments,
      upvoteRatio: post.ups / (post.ups + post.downs) || post.upvote_ratio || 0.5,
      createdAt: new Date(post.created_utc * 1000).toISOString(),
      subreddit: post.subreddit,
      author: post.author,
      url: `https://www.reddit.com${post.permalink}`
    };
  });

  // Cache result
  cache.set(cacheKey, { data: posts, timestamp: Date.now() });
  return posts;
}

/**
 * Search Reddit for a term
 * @param {string} query - Search query
 * @param {string} timeFilter - Time filter: 'hour', 'day', 'week', 'month', 'year', 'all'
 * @param {number} limit - Number of results
 * @returns {Promise<Array|null>} Array of post objects or null on error
 */
export async function searchReddit(query, timeFilter = 'day', limit = 25) {
  const cacheKey = `search:${query}:${timeFilter}:${limit}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.reddit.com/search.json?q=${encodedQuery}&sort=new&limit=${limit}&t=${timeFilter}`;
  const response = await fetchReddit(url);

  if (!response || !response.data || !response.data.children) {
    return null;
  }

  const posts = response.data.children.map(child => {
    const post = child.data;
    return {
      title: post.title,
      selftext: post.selftext,
      score: post.score,
      comments: post.num_comments,
      upvoteRatio: post.ups / (post.ups + post.downs) || post.upvote_ratio || 0.5,
      createdAt: new Date(post.created_utc * 1000).toISOString(),
      subreddit: post.subreddit,
      author: post.author,
      url: `https://www.reddit.com${post.permalink}`
    };
  });

  // Cache result
  cache.set(cacheKey, { data: posts, timestamp: Date.now() });
  return posts;
}

/**
 * Get mentions and sentiment for a specific ticker
 * @param {string} ticker - Trading pair (e.g., 'BTCUSD')
 * @returns {Promise<Object|null>} Mention data with sentiment or null on error
 */
export async function getTickerMentions(ticker) {
  const cacheKey = `ticker:${ticker}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const searchTerms = TICKER_SEARCH_MAP[ticker];
  if (!searchTerms) {
    console.log(`[Reddit] No search terms mapped for ticker: ${ticker}`);
    return null;
  }

  // Search for each term across crypto subreddits
  const allPosts = [];
  for (const term of searchTerms) {
    for (const subreddit of CRYPTO_SUBREDDITS) {
      const query = `${term} subreddit:${subreddit}`;
      const posts = await searchReddit(query, 'day', 10);
      if (posts) {
        allPosts.push(...posts);
      }
    }
  }

  if (allPosts.length === 0) {
    const result = {
      ticker,
      mentionCount: 0,
      avgScore: 0,
      avgComments: 0,
      avgUpvoteRatio: 0,
      topPosts: [],
      sentiment: 'NEUTRAL'
    };
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  // Calculate averages
  const totalScore = allPosts.reduce((sum, post) => sum + post.score, 0);
  const totalComments = allPosts.reduce((sum, post) => sum + post.comments, 0);
  const totalUpvoteRatio = allPosts.reduce((sum, post) => sum + post.upvoteRatio, 0);

  const avgScore = totalScore / allPosts.length;
  const avgComments = totalComments / allPosts.length;
  const avgUpvoteRatio = totalUpvoteRatio / allPosts.length;

  // Get top 5 posts by score
  const topPosts = allPosts
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(post => ({
      title: post.title,
      score: post.score,
      comments: post.comments,
      subreddit: post.subreddit,
      url: post.url
    }));

  // Calculate sentiment
  let sentiment = 'NEUTRAL';
  if (avgUpvoteRatio > 0.7 && avgScore > 50) {
    sentiment = 'BULLISH';
  } else if (avgUpvoteRatio < 0.4) {
    sentiment = 'BEARISH';
  }

  const result = {
    ticker,
    mentionCount: allPosts.length,
    avgScore: Math.round(avgScore),
    avgComments: Math.round(avgComments),
    avgUpvoteRatio: Math.round(avgUpvoteRatio * 100) / 100,
    topPosts,
    sentiment
  };

  // Cache result
  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Get overall crypto subreddit activity
 * @returns {Promise<Object|null>} Overall activity data or null on error
 */
export async function getCryptoSubredditActivity() {
  const cacheKey = 'crypto_activity';

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const allPosts = [];
  const coinMentions = {};

  // Fetch hot posts from all crypto subreddits
  for (const subreddit of CRYPTO_SUBREDDITS) {
    const posts = await getSubredditPosts(subreddit, 'hot', 25);
    if (posts) {
      allPosts.push(...posts);

      // Count coin mentions in titles
      posts.forEach(post => {
        const titleLower = post.title.toLowerCase();
        for (const [ticker, terms] of Object.entries(TICKER_SEARCH_MAP)) {
          for (const term of terms) {
            if (titleLower.includes(term.toLowerCase())) {
              coinMentions[ticker] = (coinMentions[ticker] || 0) + 1;
            }
          }
        }
      });
    }
  }

  if (allPosts.length === 0) {
    return null;
  }

  // Calculate averages
  const totalScore = allPosts.reduce((sum, post) => sum + post.score, 0);
  const totalUpvoteRatio = allPosts.reduce((sum, post) => sum + post.upvoteRatio, 0);
  const avgScore = totalScore / allPosts.length;
  const avgUpvoteRatio = totalUpvoteRatio / allPosts.length;

  // Get top coins discussed
  const topCoinsDiscussed = Object.entries(coinMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ticker, count]) => ({ ticker, mentions: count }));

  // Overall sentiment
  let overallSentiment = 'NEUTRAL';
  if (avgUpvoteRatio > 0.65 && avgScore > 100) {
    overallSentiment = 'BULLISH';
  } else if (avgUpvoteRatio < 0.45 || avgScore < 50) {
    overallSentiment = 'BEARISH';
  }

  const result = {
    totalPosts: allPosts.length,
    avgScore: Math.round(avgScore),
    avgUpvoteRatio: Math.round(avgUpvoteRatio * 100) / 100,
    topCoinsDiscussed,
    overallSentiment,
    timestamp: new Date().toISOString()
  };

  // Cache result
  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Get complete Reddit snapshot for a ticker
 * @param {string} ticker - Trading pair (e.g., 'BTCUSD')
 * @returns {Promise<Object|null>} Combined ticker mentions + overall activity or null on error
 */
export async function getRedditSnapshot(ticker) {
  const cacheKey = `snapshot:${ticker}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Fetch both in parallel (but rate limiting will serialize them)
  const [tickerData, activityData] = await Promise.all([
    getTickerMentions(ticker),
    getCryptoSubredditActivity()
  ]);

  if (!tickerData && !activityData) {
    return null;
  }

  const result = {
    ticker: tickerData || { ticker, mentionCount: 0, sentiment: 'NEUTRAL' },
    overall: activityData || { totalPosts: 0, overallSentiment: 'NEUTRAL' },
    timestamp: new Date().toISOString()
  };

  // Cache result
  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

// Export all functions
export default {
  getSubredditPosts,
  searchReddit,
  getTickerMentions,
  getCryptoSubredditActivity,
  getRedditSnapshot
};
