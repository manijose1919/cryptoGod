import fetch from 'node-fetch';

const API_KEY = process.env.COINMARKETCAP_API_KEY || '';
const BASE_URL = 'https://pro-api.coinmarketcap.com';
const HAS_KEY = !!API_KEY;

if (!HAS_KEY) {
  console.log('[CMC] No COINMARKETCAP_API_KEY found — only getFearGreedIndex will work');
}

// Simple TTL cache
const cache = new Map();
function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// Rate limiter: max 1 req/sec
let lastRequestTime = 0;
async function rateLimitedFetch(url, headers = {}) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
  const res = await fetch(url, { headers, timeout: 10000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function cmcFetch(path) {
  if (!HAS_KEY) return null;
  return rateLimitedFetch(`${BASE_URL}${path}`, { 'X-CMC_PRO_API_KEY': API_KEY });
}

// 1. Latest quotes
export async function getLatestQuotes(symbols = ['BTC','ETH','XRP','SOL','ADA','DOGE','LINK','DOT','AVAX','BNB']) {
  const cacheKey = `quotes_${symbols.join(',')}`;
  const cached = getCached(cacheKey, 3 * 60 * 1000);
  if (cached) return cached;

  try {
    const json = await cmcFetch(`/v1/cryptocurrency/quotes/latest?symbol=${symbols.join(',')}&convert=USD`);
    if (!json) return null;

    const result = {};
    for (const sym of symbols) {
      const coin = json.data?.[sym];
      if (!coin) continue;
      const q = coin.quote?.USD;
      if (!q) continue;
      result[sym] = {
        price: q.price,
        volume24h: q.volume_24h,
        percentChange1h: q.percent_change_1h,
        percentChange24h: q.percent_change_24h,
        percentChange7d: q.percent_change_7d,
        marketCap: q.market_cap,
        dominance: q.market_cap_dominance
      };
    }
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[CMC] getLatestQuotes error: ${err.message}`);
    return null;
  }
}

// 2. Global metrics
export async function getGlobalMetrics() {
  const cacheKey = 'global_metrics';
  const cached = getCached(cacheKey, 5 * 60 * 1000);
  if (cached) return cached;

  try {
    const json = await cmcFetch('/v1/global-metrics/quotes/latest?convert=USD');
    if (!json) return null;

    const d = json.data;
    const q = d?.quote?.USD;
    const result = {
      totalMarketCap: q?.total_market_cap,
      totalVolume24h: q?.total_volume_24h,
      btcDominance: d?.btc_dominance,
      ethDominance: d?.eth_dominance,
      activeCoins: d?.active_cryptocurrencies,
      activePairs: d?.active_market_pairs,
      defiVolume: q?.defi_volume_24h,
      defiMarketCap: q?.defi_market_cap,
      stablecoinVolume: q?.stablecoin_volume_24h
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[CMC] getGlobalMetrics error: ${err.message}`);
    return null;
  }
}

// 3. Gainers/Losers (may not be available on free tier)
export async function getGainersLosers(limit = 10) {
  const cacheKey = `gainers_losers_${limit}`;
  const cached = getCached(cacheKey, 5 * 60 * 1000);
  if (cached) return cached;

  try {
    const json = await cmcFetch(`/v1/cryptocurrency/trending/gainers-losers?limit=${limit}&convert=USD&time_period=24h`);
    if (!json) return null;

    const mapEntry = (item) => ({
      symbol: item.symbol,
      percentChange: item.quote?.USD?.percent_change_24h,
      price: item.quote?.USD?.price,
      volume: item.quote?.USD?.volume_24h
    });

    const result = {
      gainers: (json.data?.filter(c => c.quote?.USD?.percent_change_24h > 0) || []).map(mapEntry),
      losers: (json.data?.filter(c => c.quote?.USD?.percent_change_24h < 0) || []).map(mapEntry)
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[CMC] getGainersLosers error (may require paid tier): ${err.message}`);
    return null;
  }
}

// 4. Fear & Greed Index (Alternative.me — no key needed)
export async function getFearGreedIndex() {
  const cacheKey = 'fear_greed';
  const cached = getCached(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  try {
    const json = await rateLimitedFetch('https://api.alternative.me/fng/?limit=1');
    const entry = json.data?.[0];
    if (!entry) return null;

    const result = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10)
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[CMC] getFearGreedIndex error: ${err.message}`);
    return null;
  }
}

// 5. Market dominance (derived from global metrics)
export async function getMarketDominance() {
  const cacheKey = 'market_dominance';
  const cached = getCached(cacheKey, 5 * 60 * 1000);
  if (cached) return cached;

  try {
    const metrics = await getGlobalMetrics();
    if (!metrics) return null;

    const btc = metrics.btcDominance || 0;
    const eth = metrics.ethDominance || 0;
    const others = Math.max(0, 100 - btc - eth);
    let trend = 'BALANCED';
    if (btc < 40) trend = 'ALT_SEASON';
    else if (btc > 55) trend = 'BTC_DOMINANT';

    const result = { btc, eth, others, trend };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[CMC] getMarketDominance error: ${err.message}`);
    return null;
  }
}

// 6. Status
export function getStatus() {
  return { enabled: HAS_KEY, hasKey: HAS_KEY, cacheSize: cache.size };
}

export default {
  getLatestQuotes,
  getGlobalMetrics,
  getGainersLosers,
  getFearGreedIndex,
  getMarketDominance,
  getStatus
};
