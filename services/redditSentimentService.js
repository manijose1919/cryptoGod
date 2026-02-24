// Reddit Sentiment Service - Backend Node.js Module
// Uses Reddit RSS feeds (publicly accessible, no API key or OAuth needed)
// Parses Atom XML for post titles + content, runs keyword sentiment analysis

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

// Sentiment keywords
const BULLISH_KEYWORDS = ['buy', 'bullish', 'moon', 'rally', 'surge', 'pump', 'breakout', 'green',
  'rocket', 'profit', 'gain', 'uptrend', 'ath', 'soaring', 'hodl', 'accumulate', 'undervalued'];
const BEARISH_KEYWORDS = ['sell', 'bearish', 'crash', 'dump', 'collapse', 'plunge', 'red', 'scam',
  'rug', 'fraud', 'loss', 'fear', 'panic', 'drop', 'falling', 'bottom', 'overvalued', 'bubble'];
const NEGATION_WORDS = ['not', "don't", "won't", "isn't", "aren't", 'never', 'no', 'without'];

// Cache: 5-minute TTL
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

// Rate limiting
const MIN_REQUEST_DELAY_MS = 2000;
const RATE_LIMIT_BACKOFF_MS = 600000;
let lastRequestTime = 0;
let isBackingOff = false;
let backoffUntil = 0;
let consecutiveErrors = 0;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Rate-limited delay
 */
async function rateLimit() {
  if (isBackingOff) {
    const now = Date.now();
    if (now < backoffUntil) {
      return false; // Signal caller to skip
    }
    isBackingOff = false;
  }
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return true;
}

/**
 * Simple XML tag extractor — avoids needing an XML parser dependency.
 * Extracts all occurrences of <tagName>...</tagName> from xml string.
 */
function extractTag(xml, tagName) {
  const results = [];
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let idx = 0;
  while (true) {
    const start = xml.indexOf(openTag, idx);
    if (start === -1) break;
    const contentStart = xml.indexOf('>', start) + 1;
    const end = xml.indexOf(closeTag, contentStart);
    if (end === -1) break;
    results.push(xml.slice(contentStart, end));
    idx = end + closeTag.length;
  }
  return results;
}

/**
 * Extract attribute value from an XML tag string
 */
function extractAttr(tag, attrName) {
  const regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = tag.match(regex);
  return match ? match[1] : null;
}

/**
 * Decode HTML entities
 */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Strip HTML tags from a string
 */
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse Reddit Atom RSS feed XML into post objects
 */
function parseAtomFeed(xml) {
  const entries = [];
  // Split by <entry> tags
  const entryBlocks = xml.split('<entry>').slice(1); // skip preamble

  for (const block of entryBlocks) {
    const entryXml = block.split('</entry>')[0] || '';

    const titles = extractTag(entryXml, 'title');
    const title = titles.length > 0 ? decodeEntities(titles[0]) : '';

    const contents = extractTag(entryXml, 'content');
    const rawContent = contents.length > 0 ? decodeEntities(contents[0]) : '';
    const content = stripHtml(rawContent).slice(0, 1000);

    const updatedArr = extractTag(entryXml, 'updated');
    const createdAt = updatedArr.length > 0 ? updatedArr[0] : new Date().toISOString();

    // Extract link href
    const linkMatch = entryXml.match(/<link\s+href="([^"]*)"/);
    const url = linkMatch ? decodeEntities(linkMatch[1]) : '';

    const authors = extractTag(entryXml, 'name');
    const author = authors.length > 0 ? authors[0] : 'unknown';

    // Extract subreddit from category
    const categoryMatch = entryXml.match(/<category[^>]*label="([^"]*)"/);
    const subreddit = categoryMatch ? categoryMatch[1].replace('/r/', '') : '';

    if (title) {
      entries.push({
        title,
        selftext: content,
        score: 0,  // RSS doesn't include scores
        comments: 0,
        upvoteRatio: 0.5,
        createdAt,
        subreddit,
        author,
        url
      });
    }
  }

  return entries;
}

/**
 * Fetch RSS feed from Reddit
 */
async function fetchRSS(url) {
  const canProceed = await rateLimit();
  if (!canProceed) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status === 429) {
      consecutiveErrors++;
      const backoffMs = RATE_LIMIT_BACKOFF_MS * Math.min(consecutiveErrors, 6);
      console.log(`[Reddit] Rate limited (429) on RSS — backing off ${Math.round(backoffMs / 60000)}min`);
      isBackingOff = true;
      backoffUntil = Date.now() + backoffMs;
      return null;
    }

    if (!response.ok) {
      consecutiveErrors++;
      if (consecutiveErrors <= 3) {
        console.log(`[Reddit] RSS HTTP ${response.status} for ${url}`);
      } else if (consecutiveErrors === 4) {
        console.log(`[Reddit] RSS errors continue (suppressing further logs until success)`);
      }
      // Back off after 5 consecutive errors
      if (consecutiveErrors >= 5) {
        isBackingOff = true;
        backoffUntil = Date.now() + 300000; // 5 min backoff
      }
      return null;
    }

    consecutiveErrors = 0;
    const xml = await response.text();
    return parseAtomFeed(xml);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.log(`[Reddit] RSS fetch error: ${error.message}`);
    }
    return null;
  }
}

/**
 * Get posts from a subreddit via RSS
 */
export async function getSubredditPosts(subreddit, sort = 'hot', limit = 25) {
  const cacheKey = `subreddit:${subreddit}:${sort}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const url = `https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=${limit}`;
  const posts = await fetchRSS(url);

  if (!posts || posts.length === 0) return null;

  const trimmed = posts.slice(0, limit);
  cache.set(cacheKey, { data: trimmed, timestamp: Date.now() });
  return trimmed;
}

/**
 * Search Reddit via RSS
 */
export async function searchReddit(query, timeFilter = 'day', limit = 25) {
  const cacheKey = `search:${query}:${timeFilter}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.reddit.com/search.rss?q=${encodedQuery}&sort=new&limit=${limit}&t=${timeFilter}`;
  const posts = await fetchRSS(url);

  if (!posts || posts.length === 0) return null;

  const trimmed = posts.slice(0, limit);
  cache.set(cacheKey, { data: trimmed, timestamp: Date.now() });
  return trimmed;
}

/**
 * Get mentions and sentiment for a specific ticker.
 * Uses per-subreddit RSS feeds instead of search to reduce request count.
 */
export async function getTickerMentions(ticker) {
  const cacheKey = `ticker:${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const searchTerms = TICKER_SEARCH_MAP[ticker];
  if (!searchTerms) return null;

  // Fetch hot posts from each subreddit and filter for ticker mentions
  // This uses far fewer requests than searching per term per subreddit
  const allPosts = [];
  for (const subreddit of CRYPTO_SUBREDDITS) {
    const posts = await getSubredditPosts(subreddit, 'hot', 50);
    if (posts) {
      for (const post of posts) {
        const text = (post.title + ' ' + post.selftext).toLowerCase();
        for (const term of searchTerms) {
          if (text.includes(term.toLowerCase())) {
            allPosts.push(post);
            break;
          }
        }
      }
    }
  }

  // Also try a single search query for the primary term
  const searchPosts = await searchReddit(searchTerms[0], 'day', 25);
  if (searchPosts) {
    const existingUrls = new Set(allPosts.map(p => p.url));
    for (const post of searchPosts) {
      if (!existingUrls.has(post.url)) allPosts.push(post);
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

  // Compute sentiment from post titles + content
  const sentimentScores = allPosts.map(p => analyzeTextSentiment(p.title + ' ' + p.selftext));
  const avgSentiment = sentimentScores.reduce((s, v) => s + v, 0) / sentimentScores.length;

  const topPosts = allPosts
    .slice(0, 5)
    .map(post => ({
      title: post.title,
      score: post.score,
      comments: post.comments,
      subreddit: post.subreddit,
      url: post.url
    }));

  let sentiment = 'NEUTRAL';
  if (avgSentiment > 0.2) sentiment = 'BULLISH';
  else if (avgSentiment < -0.2) sentiment = 'BEARISH';

  const result = {
    ticker,
    mentionCount: allPosts.length,
    avgScore: 0,
    avgComments: 0,
    avgUpvoteRatio: 0.5,
    avgSentiment: Math.round(avgSentiment * 100) / 100,
    topPosts,
    sentiment
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Get overall crypto subreddit activity
 */
export async function getCryptoSubredditActivity() {
  const cacheKey = 'crypto_activity';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const allPosts = [];
  const coinMentions = {};

  for (const subreddit of CRYPTO_SUBREDDITS) {
    const posts = await getSubredditPosts(subreddit, 'hot', 25);
    if (posts) {
      allPosts.push(...posts);
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

  if (allPosts.length === 0) return null;

  const sentimentScores = allPosts.map(p => analyzeTextSentiment(p.title));
  const avgSentiment = sentimentScores.reduce((s, v) => s + v, 0) / sentimentScores.length;

  const topCoinsDiscussed = Object.entries(coinMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ticker, count]) => ({ ticker, mentions: count }));

  let overallSentiment = 'NEUTRAL';
  if (avgSentiment > 0.15) overallSentiment = 'BULLISH';
  else if (avgSentiment < -0.15) overallSentiment = 'BEARISH';

  const result = {
    totalPosts: allPosts.length,
    avgScore: 0,
    avgUpvoteRatio: 0.5,
    avgSentiment: Math.round(avgSentiment * 100) / 100,
    topCoinsDiscussed,
    overallSentiment,
    timestamp: new Date().toISOString()
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Get complete Reddit snapshot for a ticker
 */
export async function getRedditSnapshot(ticker) {
  const cacheKey = `snapshot:${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const [tickerData, activityData] = await Promise.all([
    getTickerMentions(ticker),
    getCryptoSubredditActivity()
  ]);

  if (!tickerData && !activityData) return null;

  const result = {
    ticker: tickerData || { ticker, mentionCount: 0, sentiment: 'NEUTRAL' },
    overall: activityData || { totalPosts: 0, overallSentiment: 'NEUTRAL' },
    timestamp: new Date().toISOString()
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Analyze text sentiment using keyword matching with negation awareness.
 */
export function analyzeTextSentiment(text) {
  if (!text) return 0;
  const words = text.toLowerCase().split(/\s+/);
  let score = 0;
  let wordCount = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^a-z]/g, '');
    const isNegated = i > 0 && NEGATION_WORDS.includes(words[i - 1].replace(/[^a-z']/g, ''));

    if (BULLISH_KEYWORDS.includes(word)) {
      score += isNegated ? -0.5 : 1;
      wordCount++;
    } else if (BEARISH_KEYWORDS.includes(word)) {
      score += isNegated ? 0.5 : -1;
      wordCount++;
    }
  }

  return wordCount > 0 ? Math.max(-1, Math.min(1, score / wordCount)) : 0;
}

/**
 * Fetch top comments from a Reddit post via RSS
 */
export async function getPostComments(permalink) {
  const cacheKey = `comments:${permalink}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  try {
    // Reddit comment RSS feeds use the same .rss suffix
    const url = `https://www.reddit.com${permalink}.rss`;
    const posts = await fetchRSS(url);
    if (!posts || posts.length === 0) return [];

    // In comment RSS feeds, entries are comments (skip first which is the post itself)
    const comments = posts.slice(1, 11).map(entry => ({
      body: entry.selftext || entry.title || '',
      score: 0,
      sentiment: analyzeTextSentiment(entry.selftext || entry.title || ''),
    }));

    cache.set(cacheKey, { data: comments, timestamp: Date.now() });
    return comments;
  } catch (e) {
    return [];
  }
}

/**
 * Enhanced ticker analysis with comment-level sentiment
 */
export async function getEnhancedTickerSentiment(ticker) {
  const cacheKey = `enhanced:${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const mentions = await getTickerMentions(ticker);
  if (!mentions || mentions.mentionCount === 0) {
    const result = {
      ticker,
      postSentiment: 0,
      commentSentiment: 0,
      combinedSentiment: 0,
      postVolume: 0,
      postVolumeChange: 0,
      signal: 'NEUTRAL',
    };
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  const postSentiments = (mentions.topPosts || []).map(p => analyzeTextSentiment(p.title));
  const avgPostSentiment = postSentiments.length > 0
    ? postSentiments.reduce((s, v) => s + v, 0) / postSentiments.length
    : 0;

  // Fetch comments from top 2 posts (reduced to save requests)
  let commentSentiments = [];
  for (const post of (mentions.topPosts || []).slice(0, 2)) {
    if (post.url) {
      const permalink = post.url.replace('https://www.reddit.com', '');
      const comments = await getPostComments(permalink);
      commentSentiments.push(...comments.map(c => c.sentiment));
    }
  }

  const avgCommentSentiment = commentSentiments.length > 0
    ? commentSentiments.reduce((s, v) => s + v, 0) / commentSentiments.length
    : 0;

  const combined = avgPostSentiment * 0.6 + avgCommentSentiment * 0.4;

  let signal = 'NEUTRAL';
  if (combined > 0.6) signal = 'VERY_BULLISH';
  else if (combined > 0.3) signal = 'BULLISH';
  else if (combined < -0.6) signal = 'VERY_BEARISH';
  else if (combined < -0.3) signal = 'BEARISH';

  const result = {
    ticker,
    postSentiment: Math.round(avgPostSentiment * 100) / 100,
    commentSentiment: Math.round(avgCommentSentiment * 100) / 100,
    combinedSentiment: Math.round(combined * 100) / 100,
    postVolume: mentions.mentionCount,
    postVolumeChange: 0,
    commentCount: commentSentiments.length,
    signal,
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Check if Reddit service is currently in rate limit backoff
 */
export function isInBackoff() {
  return isBackingOff && Date.now() < backoffUntil;
}

export default {
  getSubredditPosts,
  searchReddit,
  getTickerMentions,
  getCryptoSubredditActivity,
  getRedditSnapshot,
  analyzeTextSentiment,
  getPostComments,
  getEnhancedTickerSentiment,
  isInBackoff,
};
