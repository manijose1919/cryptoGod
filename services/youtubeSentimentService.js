// YouTube Sentiment Service - Backend Node.js Module
// Analyzes YouTube video titles/descriptions for crypto sentiment using YouTube Data API v3
// Free tier: 10,000 quota units/day (search = 100 units each)

import fetch from 'node-fetch';

// ── Ticker to coin name mapping (top 15 cryptos) ──────────────────────────────

const TICKER_TO_NAME = {
  BTCUSD: 'Bitcoin',
  ETHUSD: 'Ethereum',
  XRPUSD: 'XRP',
  SOLUSD: 'Solana',
  ADAUSD: 'Cardano',
  DOGEUSD: 'Dogecoin',
  LINKUSD: 'Chainlink',
  DOTUSD: 'Polkadot',
  AVAXUSD: 'Avalanche',
  BNBUSD: 'BNB',
  MATICUSD: 'Polygon',
  SHIBUSD: 'Shiba Inu',
  LTCUSD: 'Litecoin',
  UNIUSD: 'Uniswap',
  ATOMUSD: 'Cosmos'
};

// ── Sentiment keyword dictionaries ─────────────────────────────────────────────

const BULLISH_KEYWORDS = [
  'buy', 'bullish', 'moon', 'rally', 'surge', 'pump', 'breakout',
  'green', 'rocket', '100x', 'profit', 'gain', 'uptrend',
  'all-time high', 'ath', 'soaring', 'skyrocket', 'long',
  'accumulate', 'undervalued', 'massive', 'explode', 'parabolic'
];

const BEARISH_KEYWORDS = [
  'sell', 'bearish', 'crash', 'dump', 'collapse', 'plunge', 'red',
  'scam', 'rug', 'fraud', 'loss', 'fear', 'panic', 'drop',
  'falling', 'bottom', 'bear market', 'short', 'overvalued',
  'warning', 'bubble', 'dead', 'avoid', 'danger'
];

const NEGATION_WORDS = [
  'not', "don't", "won't", "doesn't", "isn't", "aren't",
  "can't", "cannot", 'never', 'no', 'neither', 'nor', "wouldn't"
];

// ── Cache and tracking ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();
let requestsUsed = 0;

// ── YouTube API base URL ───────────────────────────────────────────────────────

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Sentiment Analysis ─────────────────────────────────────────────────────────

/**
 * Analyze text for bullish/bearish sentiment using keyword matching.
 * Accounts for negation words that flip sentiment.
 * @param {string} text - Text to analyze (title, description, etc.)
 * @returns {number} Sentiment score from -1 (very bearish) to +1 (very bullish)
 */
export function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') return 0;

  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  let bullishHits = 0;
  let bearishHits = 0;
  let totalKeywords = 0;

  // Check each keyword against the text
  for (const keyword of BULLISH_KEYWORDS) {
    const keywordLower = keyword.toLowerCase();
    // Find all occurrences of this keyword in the text
    let searchStart = 0;
    while (true) {
      const idx = lower.indexOf(keywordLower, searchStart);
      if (idx === -1) break;

      // Check for negation in the 3 words preceding this keyword
      const precedingText = lower.substring(Math.max(0, idx - 30), idx);
      const precedingWords = precedingText.trim().split(/\s+/).slice(-3);
      const negated = precedingWords.some(w => NEGATION_WORDS.includes(w));

      if (negated) {
        bearishHits += 1; // Negated bullish = bearish
      } else {
        bullishHits += 1;
      }
      totalKeywords += 1;
      searchStart = idx + keywordLower.length;
    }
  }

  for (const keyword of BEARISH_KEYWORDS) {
    const keywordLower = keyword.toLowerCase();
    let searchStart = 0;
    while (true) {
      const idx = lower.indexOf(keywordLower, searchStart);
      if (idx === -1) break;

      const precedingText = lower.substring(Math.max(0, idx - 30), idx);
      const precedingWords = precedingText.trim().split(/\s+/).slice(-3);
      const negated = precedingWords.some(w => NEGATION_WORDS.includes(w));

      if (negated) {
        bullishHits += 1; // Negated bearish = bullish
      } else {
        bearishHits += 1;
      }
      totalKeywords += 1;
      searchStart = idx + keywordLower.length;
    }
  }

  if (totalKeywords === 0) return 0;

  // Score: ratio of (bullish - bearish) / total, clamped to [-1, 1]
  const rawScore = (bullishHits - bearishHits) / totalKeywords;
  return Math.max(-1, Math.min(1, rawScore));
}

// ── YouTube Sentiment Fetching ─────────────────────────────────────────────────

/**
 * Get YouTube sentiment for a crypto ticker.
 * Searches for recent videos, analyzes titles/descriptions for sentiment.
 * Results are cached for 10 minutes per ticker.
 *
 * @param {string} ticker - Trading pair (e.g., 'BTCUSD')
 * @returns {Promise<Object>} Sentiment data with scores and top videos
 */
export async function getYouTubeSentiment(ticker) {
  const defaultResult = {
    sentiment: 0,
    videoCount: 0,
    bullishCount: 0,
    bearishCount: 0,
    topVideos: [],
    cached: false,
    source: 'youtube',
    ticker
  };

  // Check if API key is configured
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return defaultResult;
  }

  // Check cache
  const cacheKey = `yt:${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  // Resolve coin name from ticker
  const coinName = TICKER_TO_NAME[ticker];
  if (!coinName) {
    // Try to extract from ticker format (e.g., BTCUSD -> BTC)
    const base = ticker.replace(/USD$/, '');
    if (!base || base === ticker) {
      return defaultResult;
    }
    // Use the base symbol as search term
    return await fetchAndAnalyze(base + ' crypto trading', ticker, apiKey, cacheKey, defaultResult);
  }

  const searchQuery = `${coinName} crypto trading`;
  return await fetchAndAnalyze(searchQuery, ticker, apiKey, cacheKey, defaultResult);
}

/**
 * Fetch YouTube search results and analyze sentiment.
 * @param {string} query - Search query string
 * @param {string} ticker - Original ticker for result tagging
 * @param {string} apiKey - YouTube Data API v3 key
 * @param {string} cacheKey - Cache key for storing results
 * @param {Object} defaultResult - Default result to return on failure
 * @returns {Promise<Object>} Sentiment analysis result
 */
async function fetchAndAnalyze(query, ticker, apiKey, cacheKey, defaultResult) {
  try {
    // Calculate 24 hours ago in ISO format
    const publishedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order: 'relevance',
      maxResults: '10',
      publishedAfter: publishedAfter,
      relevanceLanguage: 'en',
      key: apiKey
    });

    const url = `${YOUTUBE_API_BASE}/search?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    requestsUsed += 1; // Each search costs 100 quota units

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.log(`[YouTube] API error ${response.status}: ${errorText}`);
      return defaultResult;
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      // No videos found - cache the empty result too
      const emptyResult = { ...defaultResult, cached: false };
      cache.set(cacheKey, { data: emptyResult, timestamp: Date.now() });
      return emptyResult;
    }

    // Analyze each video
    let bullishCount = 0;
    let bearishCount = 0;
    let totalSentiment = 0;

    const topVideos = data.items.map(item => {
      const snippet = item.snippet;
      const title = snippet.title || '';
      const description = snippet.description || '';
      const combinedText = `${title} ${description}`;

      const videoSentiment = analyzeSentiment(combinedText);
      totalSentiment += videoSentiment;

      if (videoSentiment > 0.1) {
        bullishCount += 1;
      } else if (videoSentiment < -0.1) {
        bearishCount += 1;
      }

      return {
        title: title,
        channelTitle: snippet.channelTitle || 'Unknown',
        publishedAt: snippet.publishedAt || null,
        sentiment: Math.round(videoSentiment * 1000) / 1000
      };
    });

    const videoCount = data.items.length;
    const avgSentiment = videoCount > 0 ? totalSentiment / videoCount : 0;

    // Clamp final sentiment to [-1, 1]
    const sentiment = Math.max(-1, Math.min(1, Math.round(avgSentiment * 1000) / 1000));

    const result = {
      sentiment,
      videoCount,
      bullishCount,
      bearishCount,
      topVideos,
      cached: false,
      source: 'youtube',
      ticker
    };

    // Cache the result
    cache.set(cacheKey, { data: result, timestamp: Date.now() });

    console.log(`[YouTube] ${ticker}: sentiment=${sentiment}, videos=${videoCount}, bull=${bullishCount}, bear=${bearishCount}`);

    return result;
  } catch (error) {
    console.log(`[YouTube] Fetch error for ${ticker}: ${error.message}`);
    return defaultResult;
  }
}

// ── Status ─────────────────────────────────────────────────────────────────────

/**
 * Get YouTube sentiment service status.
 * @returns {Object} Service status information
 */
export function getYouTubeStatus() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  return {
    enabled: !!apiKey,
    apiKeySet: !!apiKey,
    requestsUsed,
    cacheEntries: cache.size
  };
}

// ── Default export ─────────────────────────────────────────────────────────────

export default {
  getYouTubeSentiment,
  analyzeSentiment,
  getYouTubeStatus
};
