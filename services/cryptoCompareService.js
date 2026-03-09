/**
 * CryptoCompare Service - Social stats, top movers, order book snapshots.
 * Auth via process.env.CRYPTOCOMPARE_API_KEY. Rate limit: 1 req/sec.
 * Map-based cache with per-endpoint TTL. Fails open (returns null on error).
 */
import fetch from 'node-fetch';

const BASE_URL = 'https://min-api.cryptocompare.com';
const API_KEY = process.env.CRYPTOCOMPARE_API_KEY || '';

const COIN_IDS = {
  BTC: 1182, ETH: 7605, XRP: 5031, SOL: 934847, ADA: 321992,
  DOGE: 4432, LINK: 236131, DOT: 891658, AVAX: 910776, BNB: 204788
};

const TTL = {
  SOCIAL: 10 * 60 * 1000,
  TOP_MOVERS: 5 * 60 * 1000,
  HISTORICAL: 30 * 60 * 1000,
  ORDER_BOOK: 30 * 1000
};

const cache = new Map();
let lastRequestTime = 0;

if (!API_KEY) {
  console.log('[CryptoCompare] No API key found (CRYPTOCOMPARE_API_KEY). All functions will return null.');
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data;
  return null;
}

function setCache(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

async function apiFetch(path) {
  if (!API_KEY) return null;
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE_URL}${path}${sep}api_key=${API_KEY}`;
  console.log(`[CryptoCompare] Fetching: ${BASE_URL}${path}`);

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 10000
  });
  if (!response.ok) {
    console.error(`[CryptoCompare] HTTP ${response.status} for ${path}`);
    return null;
  }
  return response.json();
}

const _unknownCoins = new Set();
function resolveCoinId(coin) {
  const id = COIN_IDS[coin?.toUpperCase()];
  if (!id && !_unknownCoins.has(coin)) {
    _unknownCoins.add(coin);
    console.log(`[CryptoCompare] Unknown coin: ${coin} (logged once)`);
  }
  return id || null;
}

export async function getSocialStats(coin) {
  try {
    if (!API_KEY) return null;
    const coinId = resolveCoinId(coin);
    if (!coinId) return null;

    const cacheKey = `social_${coin}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await apiFetch(`/data/social/coin/latest?coinId=${coinId}`);
    if (!data?.Data) return null;

    const d = data.Data;
    const result = {
      followers: d.General?.Points || 0,
      posts: d.General?.Posts || 0,
      comments: d.General?.Comments || 0,
      points: d.General?.Points || 0,
      redditSubscribers: d.Reddit?.subscribers || 0,
      twitterFollowers: d.Twitter?.followers || 0
    };
    setCache(cacheKey, result, TTL.SOCIAL);
    return result;
  } catch (error) {
    console.error(`[CryptoCompare] Error in getSocialStats(${coin}):`, error.message);
    return null;
  }
}

export async function getTopMoversByVolume(limit = 10) {
  try {
    if (!API_KEY) return null;
    const cacheKey = `top_movers_${limit}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await apiFetch(`/data/top/totalvolfull?limit=${limit}&tsym=USD`);
    if (!data?.Data) return null;

    const result = data.Data.map(item => {
      const raw = item.RAW?.USD || {};
      return {
        symbol: item.CoinInfo?.Name || 'UNKNOWN',
        price: raw.PRICE || 0,
        changePct24h: raw.CHANGEPCT24HOUR || 0,
        volume24h: raw.TOTALVOLUME24HTO || 0,
        marketCap: raw.MKTCAP || 0
      };
    });
    setCache(cacheKey, result, TTL.TOP_MOVERS);
    return result;
  } catch (error) {
    console.error(`[CryptoCompare] Error in getTopMoversByVolume:`, error.message);
    return null;
  }
}

export async function getHistoricalSocial(coin, days = 7) {
  try {
    if (!API_KEY) return null;
    const coinId = resolveCoinId(coin);
    if (!coinId) return null;

    const cacheKey = `hist_social_${coin}_${days}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await apiFetch(`/data/social/coin/histo/day?coinId=${coinId}&limit=${days}`);
    if (!data?.Data) return null;

    const result = data.Data.map(d => ({
      time: d.time,
      posts: d.posts || 0,
      comments: d.comments || 0,
      followers: d.followers || 0
    }));
    setCache(cacheKey, result, TTL.HISTORICAL);
    return result;
  } catch (error) {
    console.error(`[CryptoCompare] Error in getHistoricalSocial(${coin}):`, error.message);
    return null;
  }
}

export async function getOrderBookSnapshot(pair) {
  try {
    if (!API_KEY) return null;
    const base = pair?.replace(/[_\/]?USD$/i, '').toUpperCase();
    if (!base) return null;

    const cacheKey = `ob_${base}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await apiFetch(`/data/ob/l2/snapshot?fsym=${base}&tsym=USD`);
    if (!data?.Data) return null;

    const result = {
      bids: data.Data.BID || [],
      asks: data.Data.ASK || [],
      timestamp: Date.now()
    };
    setCache(cacheKey, result, TTL.ORDER_BOOK);
    return result;
  } catch (error) {
    console.error(`[CryptoCompare] Error in getOrderBookSnapshot(${pair}):`, error.message);
    return null;
  }
}

export function getStatus() {
  return { enabled: !!API_KEY, hasKey: !!API_KEY, cacheSize: cache.size };
}

export default {
  getSocialStats,
  getTopMoversByVolume,
  getHistoricalSocial,
  getOrderBookSnapshot,
  getStatus
};
