import fetch from 'node-fetch';

const API_KEY = process.env.MESSARI_API_KEY;
const BASE_URL = 'https://data.messari.io/api';
const HEADERS = API_KEY ? { 'x-messari-api-key': API_KEY } : {};

// Dead flag: suppress after repeated 401 errors for 30 min
let _deadUntil = 0;
const DEAD_TTL = 30 * 60 * 1000;
function isDead() { return Date.now() < _deadUntil; }
function markDead(status) {
  if (!_deadUntil) console.warn(`[Messari] Suppressing for 30min after HTTP ${status}`);
  _deadUntil = Date.now() + DEAD_TTL;
}

if (!API_KEY) {
  console.log('[Messari] No MESSARI_API_KEY found — all requests will return null');
}

const SLUG_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', XRP: 'xrp', SOL: 'solana',
  ADA: 'cardano', DOGE: 'dogecoin', LINK: 'chainlink', DOT: 'polkadot',
  AVAX: 'avalanche-2', BNB: 'binance-coin'
};

// --- Cache ---
const cache = new Map(); // key -> { data, expires }

function cacheGet(key) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// --- Rate limiter: 1 req/sec ---
let lastRequestTime = 0;

async function rateLimitedFetch(url) {
  if (!API_KEY || isDead()) return null;
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) markDead(res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    return null;
  }
}

function resolveSlug(slug) {
  return SLUG_MAP[slug?.toUpperCase()] || slug?.toLowerCase();
}

// --- 1. Asset Profile (1h TTL) ---
export async function getAssetProfile(slug) {
  const resolved = resolveSlug(slug);
  const cacheKey = `profile:${resolved}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const json = await rateLimitedFetch(`${BASE_URL}/v2/assets/${resolved}/profile`);
  if (!json?.data) return null;

  const d = json.data;
  const general = d.profile?.general || d.general || {};
  const result = {
    name: d.name || general.overview?.project_name || null,
    symbol: d.symbol || null,
    sector: d.profile?.economics?.consensus_and_emission?.general_emission_type || general.sector || null,
    category: general.category || d.profile?.general?.overview?.category || null,
    description: general.overview?.project_details || null,
    tagline: general.overview?.tagline || null
  };
  cacheSet(cacheKey, result, 3600000);
  return result;
}

// --- 2. Asset Metrics (5min TTL) ---
export async function getAssetMetrics(slug) {
  const resolved = resolveSlug(slug);
  const cacheKey = `metrics:${resolved}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const json = await rateLimitedFetch(`${BASE_URL}/v1/assets/${resolved}/metrics`);
  if (!json?.data) return null;

  const md = json.data.market_data || {};
  const mc = json.data.marketcap || {};
  const roi = json.data.roi_data || {};
  const risk = json.data.risk_metrics?.sharpe_ratios || {};
  const ath = json.data.all_time_high || {};

  const result = {
    marketCap: mc.current_marketcap_usd || null,
    price: md.price_usd || null,
    volume24h: md.volume_last_24_hours || null,
    percentChange24h: md.percent_change_usd_last_24_hours || null,
    percentChange7d: md.percent_change_usd_last_7_days || null,
    volatility: risk.last_30_days || null,
    sharpeRatio: risk.last_30_days || null,
    allTimeHigh: ath.price || null,
    athDate: ath.at || null,
    dominance: mc.marketcap_dominance_percent || null
  };
  cacheSet(cacheKey, result, 300000);
  return result;
}

// --- 3. Market Overview (5min TTL) ---
export async function getMarketOverview() {
  const cacheKey = 'market-overview';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const fields = [
    'id', 'slug', 'symbol',
    'metrics/market_data/price_usd',
    'metrics/market_data/percent_change_usd_last_24_hours',
    'metrics/market_data/volume_last_24_hours',
    'metrics/marketcap/current_marketcap_usd'
  ].join(',');

  const json = await rateLimitedFetch(`${BASE_URL}/v1/assets?limit=20&fields=${fields}`);
  if (!json?.data) return null;

  const result = json.data.map(a => ({
    symbol: a.symbol || null,
    slug: a.slug || null,
    price: a.metrics?.market_data?.price_usd || null,
    changePct24h: a.metrics?.market_data?.percent_change_usd_last_24_hours || null,
    volume24h: a.metrics?.market_data?.volume_last_24_hours || null,
    marketCap: a.metrics?.marketcap?.current_marketcap_usd || null
  }));
  cacheSet(cacheKey, result, 300000);
  return result;
}

// --- 4. Asset Timeseries (15min TTL) ---
export async function getAssetTimeseries(slug, metric = 'price', start, end) {
  const resolved = resolveSlug(slug);
  const cacheKey = `ts:${resolved}:${metric}:${start}:${end}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let url = `${BASE_URL}/v1/assets/${resolved}/metrics/${metric}/time-series?interval=1d`;
  if (start) url += `&start=${start}`;
  if (end) url += `&end=${end}`;

  const json = await rateLimitedFetch(url);
  if (!json?.data?.values) return null;

  const result = json.data.values.map(v => ({
    timestamp: v[0],
    value: v[1]
  }));
  cacheSet(cacheKey, result, 900000);
  return result;
}

// --- 5. Status ---
export function getStatus() {
  return {
    enabled: !!API_KEY,
    hasKey: !!API_KEY,
    cacheSize: cache.size
  };
}

export default {
  getAssetProfile,
  getAssetMetrics,
  getMarketOverview,
  getAssetTimeseries,
  getStatus
};
