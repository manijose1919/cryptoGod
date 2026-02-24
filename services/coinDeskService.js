import fetch from 'node-fetch';

const BPI_BASE = 'https://api.coindesk.com/v1';
const DATA_BASE = 'https://data-api.coindesk.com';
const API_KEY = process.env.COINDESK_API_KEY || '';

// Cache with TTL
const cache = new Map();
const CACHE_TTL = {
  BPI: 60 * 1000,            // 1 minute
  HISTORICAL: 60 * 60 * 1000, // 1 hour
  NEWS: 5 * 60 * 1000         // 5 minutes
};

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < entry.ttl) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl });
}

// Rate limiter: max 1 req/sec
let lastRequestTime = 0;
async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
  return fetch(url, { timeout: 10000, ...options });
}

// Ticker to keyword mapping
const TICKER_KEYWORDS = {
  BTCUSD: ['bitcoin', 'btc'],
  ETHUSD: ['ethereum', 'eth'],
  XRPUSD: ['ripple', 'xrp'],
  BNBUSD: ['binance', 'bnb'],
  SOLUSD: ['solana', 'sol'],
  ADAUSD: ['cardano', 'ada'],
  DOGEUSD: ['dogecoin', 'doge'],
  LINKUSD: ['chainlink', 'link'],
  DOTUSD: ['polkadot', 'dot'],
  AVAXUSD: ['avalanche', 'avax']
};

// Sentiment keyword lists
const BULLISH_WORDS = [
  'surge', 'rally', 'soar', 'bullish', 'breakout', 'gains', 'pump', 'moon',
  'record', 'high', 'boost', 'upgrade', 'adoption', 'approval', 'etf',
  'institutional', 'buy', 'growth', 'optimism', 'positive', 'up', 'rise',
  'rising', 'recover', 'recovery', 'demand', 'accumulate', 'outperform'
];
const BEARISH_WORDS = [
  'crash', 'drop', 'plunge', 'bearish', 'dump', 'sell', 'decline', 'fall',
  'fear', 'panic', 'hack', 'ban', 'fraud', 'scam', 'collapse', 'risk',
  'warning', 'downturn', 'loss', 'negative', 'down', 'falling', 'reject',
  'regulation', 'crackdown', 'lawsuit', 'sec', 'investigation', 'concern'
];

function analyzeTextSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of BULLISH_WORDS) { if (lower.includes(w)) score += 1; }
  for (const w of BEARISH_WORDS) { if (lower.includes(w)) score -= 1; }
  const maxPossible = Math.max(1, BULLISH_WORDS.length);
  return Math.max(-1, Math.min(1, score / Math.sqrt(maxPossible)));
}

export async function getBitcoinPriceIndex() {
  try {
    const cached = getCached('bpi');
    if (cached) return cached;
    const res = await rateLimitedFetch(`${BPI_BASE}/bpi/currentprice.json`);
    if (!res.ok) throw new Error(`BPI HTTP ${res.status}`);
    const data = await res.json();
    const result = {
      usd: data.bpi.USD.rate_float,
      eur: data.bpi.EUR.rate_float,
      gbp: data.bpi.GBP.rate_float,
      timestamp: data.time.updatedISO
    };
    setCache('bpi', result, CACHE_TTL.BPI);
    console.log(`[CoinDesk] BPI fetched: $${result.usd.toLocaleString()}`);
    return result;
  } catch (err) {
    console.log(`[CoinDesk] getBitcoinPriceIndex error: ${err.message}`);
    return null;
  }
}

export async function getHistoricalBPI(start, end) {
  try {
    const key = `hist_${start}_${end}`;
    const cached = getCached(key);
    if (cached) return cached;
    const url = `${BPI_BASE}/bpi/historical/close.json?start=${start}&end=${end}`;
    const res = await rateLimitedFetch(url);
    if (!res.ok) throw new Error(`Historical BPI HTTP ${res.status}`);
    const data = await res.json();
    const result = data.bpi || {};
    setCache(key, result, CACHE_TTL.HISTORICAL);
    console.log(`[CoinDesk] Historical BPI: ${Object.keys(result).length} days`);
    return result;
  } catch (err) {
    console.log(`[CoinDesk] getHistoricalBPI error: ${err.message}`);
    return null;
  }
}

export async function getLatestNews(limit = 10) {
  try {
    if (!API_KEY) {
      console.log('[CoinDesk] No API key — news endpoints disabled');
      return null;
    }
    const key = `news_${limit}`;
    const cached = getCached(key);
    if (cached) return cached;
    const url = `${DATA_BASE}/news/v1/article/list?limit=${limit}&lang=EN`;
    const res = await rateLimitedFetch(url, {
      headers: { 'x-api-key': API_KEY }
    });
    if (!res.ok) throw new Error(`News HTTP ${res.status}`);
    const data = await res.json();
    const articles = (data.Data || data.data || []).map(a => ({
      title: a.TITLE || a.title || '',
      description: a.BODY || a.body || a.SUBTITLE || a.subtitle || '',
      publishedAt: a.PUBLISHED_ON || a.published_on || a.publishedAt || '',
      url: a.URL || a.url || a.GUID || '',
      categories: a.CATEGORIES || a.categories || '',
      sentiment: analyzeTextSentiment((a.TITLE || a.title || '') + ' ' + (a.SUBTITLE || a.subtitle || ''))
    }));
    setCache(key, articles, CACHE_TTL.NEWS);
    console.log(`[CoinDesk] Fetched ${articles.length} news articles`);
    return articles;
  } catch (err) {
    console.log(`[CoinDesk] getLatestNews error: ${err.message}`);
    return null;
  }
}

export async function getNewsSentiment(ticker) {
  try {
    const key = `sentiment_${ticker}`;
    const cached = getCached(key);
    if (cached) return cached;
    const articles = await getLatestNews(25);
    if (!articles) return null;
    const keywords = TICKER_KEYWORDS[ticker.toUpperCase()] || [];
    if (!keywords.length) {
      console.log(`[CoinDesk] Unknown ticker: ${ticker}`);
      return null;
    }
    const matched = articles.filter(a => {
      const text = (a.title + ' ' + a.description).toLowerCase();
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
    const avgSentiment = matched.length > 0
      ? matched.reduce((sum, a) => sum + a.sentiment, 0) / matched.length
      : 0;
    const signal = avgSentiment > 0.1 ? 'BULLISH' : avgSentiment < -0.1 ? 'BEARISH' : 'NEUTRAL';
    const result = {
      ticker: ticker.toUpperCase(),
      articleCount: matched.length,
      avgSentiment: Math.round(avgSentiment * 1000) / 1000,
      signal,
      articles: matched.slice(0, 5)
    };
    setCache(key, result, CACHE_TTL.NEWS);
    console.log(`[CoinDesk] Sentiment for ${ticker}: ${signal} (${matched.length} articles)`);
    return result;
  } catch (err) {
    console.log(`[CoinDesk] getNewsSentiment error: ${err.message}`);
    return null;
  }
}

export function getStatus() {
  return {
    enabled: true,
    hasKey: !!API_KEY,
    cacheSize: cache.size
  };
}

export default {
  getBitcoinPriceIndex,
  getHistoricalBPI,
  getLatestNews,
  getNewsSentiment,
  getStatus
};
