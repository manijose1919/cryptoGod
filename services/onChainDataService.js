/**
 * On-Chain Data Integration Service
 *
 * Free APIs: Blockchain.com (whale txns, exchange flows), mempool.space (BTC hash rate),
 * Glassnode free endpoints (MVRV, active addresses).
 * All functions fail-safe (return 0 on error). 5min cache TTL. 1 req/s per domain.
 */

import { getFlag } from './systemConfig.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const LOG = '[OnChainData]';
const SATS_PER_BTC = 100_000_000;

const TICKER_MAP = {
  BTCUSD: 'BTC', ETHUSD: 'ETH', XRPUSD: 'XRP', BNBUSD: 'BNB', SOLUSD: 'SOL',
  ADAUSD: 'ADA', DOGEUSD: 'DOGE', LINKUSD: 'LINK', DOTUSD: 'DOT', AVAXUSD: 'AVAX',
};

function toSymbol(ticker) {
  const n = ticker.toUpperCase().replace(/[-_\/]/g, '');
  return TICKER_MAP[n] || n.replace(/USD$/, '');
}

// --- Cache ---
const cache = new Map();
function getCached(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return e.v;
}
function setCache(key, value) { cache.set(key, { v: value, ts: Date.now() }); }

// --- Rate limiting (per domain) ---
const lastReqTime = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function enforceRateLimit(domain) {
  const elapsed = Date.now() - (lastReqTime.get(domain) || 0);
  if (elapsed < 1000) await sleep(1000 - elapsed);
  lastReqTime.set(domain, Date.now());
}

// --- Fetch with retry + exponential backoff on 429 ---
async function fetchJSON(url, domain) {
  await enforceRateLimit(domain);
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'CryptoGod/1.0' } });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = Math.pow(2, i + 1) * 1000;
        console.warn(`${LOG} 429 from ${domain}, backoff ${wait}ms (${i + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        lastReqTime.set(domain, Date.now());
        continue;
      }
      if (!res.ok) { console.warn(`${LOG} HTTP ${res.status} from ${domain}`); return null; }
      return await res.json();
    } catch (err) {
      console.warn(`${LOG} ${err.name === 'AbortError' ? 'Timeout' : err.message} from ${domain} (${i + 1}/${MAX_RETRIES})`);
      if (i < MAX_RETRIES - 1) await sleep(Math.pow(2, i + 1) * 1000);
    }
  }
  return null;
}

function isEnabled() {
  try { return getFlag('ONCHAIN_DATA_ENABLED') !== false; } catch { return false; }
}

/** Helper: check flag + cache, return cached value or undefined to continue */
function preflight(cacheKey) {
  if (!isEnabled()) return { skip: true, val: 0 };
  const c = getCached(cacheKey);
  if (c !== undefined) return { skip: true, val: c };
  return { skip: false };
}

// ============================================
// METRIC FUNCTIONS — all async, return number, 0 on failure
// ============================================

/** Net flow of coins to/from exchanges. Positive = inflow = bearish. BTC only. */
export async function getExchangeNetFlow(ticker) {
  const sym = toSymbol(ticker);
  const pf = preflight(`netflow_${sym}`);
  if (pf.skip) return pf.val;
  try {
    if (sym !== 'BTC') return 0;
    const data = await fetchJSON('https://api.blockchain.info/stats', 'blockchain.info');
    if (!data) return 0;
    const tradeVol = data.trade_volume_usd || 0;
    const txVol = data.estimated_transaction_volume_usd || 0;
    const result = txVol > 0 ? Math.round(((tradeVol - txVol) / txVol) * 10000) / 10000 : 0;
    setCache(`netflow_${sym}`, result);
    return result;
  } catch (e) { console.warn(`${LOG} getExchangeNetFlow: ${e.message}`); return 0; }
}

/** MVRV ratio for BTC. >3.5 overvalued, <1 undervalued. */
export async function getMVRV() {
  const pf = preflight('mvrv');
  if (pf.skip) return pf.val;
  try {
    const data = await fetchJSON('https://api.glassnode.com/v1/metrics/market/mvrv?a=BTC&i=24h&f=JSON', 'api.glassnode.com');
    if (!Array.isArray(data) || !data.length) return 0;
    const v = data[data.length - 1].v;
    const result = typeof v === 'number' ? Math.round(v * 1000) / 1000 : 0;
    setCache('mvrv', result);
    return result;
  } catch (e) { console.warn(`${LOG} getMVRV: ${e.message}`); return 0; }
}

/** 24h active address count change %. BTC/ETH only. */
export async function getActiveAddresses(ticker) {
  const sym = toSymbol(ticker);
  const pf = preflight(`active_addr_${sym}`);
  if (pf.skip) return pf.val;
  try {
    if (sym !== 'BTC' && sym !== 'ETH') return 0;
    const data = await fetchJSON(
      `https://api.glassnode.com/v1/metrics/addresses/active_count?a=${sym}&i=24h&f=JSON`, 'api.glassnode.com'
    );
    if (!Array.isArray(data) || data.length < 2) return 0;
    const cur = data[data.length - 1].v || 0;
    const prev = data[data.length - 2].v || 0;
    const result = prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : 0;
    setCache(`active_addr_${sym}`, result);
    return result;
  } catch (e) { console.warn(`${LOG} getActiveAddresses: ${e.message}`); return 0; }
}

/** BTC hash rate change % (24h). */
export async function getHashRate() {
  const pf = preflight('hashrate');
  if (pf.skip) return pf.val;
  try {
    const data = await fetchJSON('https://mempool.space/api/v1/mining/hashrate/1m', 'mempool.space');
    if (!data?.hashrates?.length || data.hashrates.length < 2) return 0;
    const rates = data.hashrates;
    const cur = rates[rates.length - 1].avgHashrate || 0;
    const prev = rates[rates.length - 2].avgHashrate || 0;
    const result = prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : 0;
    setCache('hashrate', result);
    return result;
  } catch (e) { console.warn(`${LOG} getHashRate: ${e.message}`); return 0; }
}

/** Count of whale transactions (>10 BTC / ~$1M) in recent mempool. BTC only. */
export async function getWhaleTransactions(ticker) {
  const sym = toSymbol(ticker);
  const pf = preflight(`whale_count_${sym}`);
  if (pf.skip) return pf.val;
  try {
    if (sym !== 'BTC') return 0;
    const data = await fetchJSON('https://blockchain.info/unconfirmed-transactions?format=json', 'blockchain.info');
    if (!data?.txs) return 0;
    const THRESHOLD = 1_000_000_000; // ~10 BTC in sats
    let count = 0;
    for (const tx of data.txs) {
      const total = (tx.out || []).reduce((s, o) => s + (o.value || 0), 0);
      if (total >= THRESHOLD) count++;
    }
    setCache(`whale_count_${sym}`, count);
    return count;
  } catch (e) { console.warn(`${LOG} getWhaleTransactions: ${e.message}`); return 0; }
}

/** Total USD volume of whale transactions (>$1M) in recent mempool. BTC only. */
export async function getWhaleVolume(ticker) {
  const sym = toSymbol(ticker);
  const pf = preflight(`whale_vol_${sym}`);
  if (pf.skip) return pf.val;
  try {
    if (sym !== 'BTC') return 0;
    const priceData = await fetchJSON('https://blockchain.info/ticker', 'blockchain.info');
    const btcPrice = priceData?.USD?.last || 0;
    if (!btcPrice) return 0;
    const data = await fetchJSON('https://blockchain.info/unconfirmed-transactions?format=json', 'blockchain.info');
    if (!data?.txs) return 0;
    let volume = 0;
    for (const tx of data.txs) {
      const sats = (tx.out || []).reduce((s, o) => s + (o.value || 0), 0);
      const usd = (sats / SATS_PER_BTC) * btcPrice;
      if (usd >= 1_000_000) volume += usd;
    }
    const result = Math.round(volume);
    setCache(`whale_vol_${sym}`, result);
    return result;
  } catch (e) { console.warn(`${LOG} getWhaleVolume: ${e.message}`); return 0; }
}

/** Change in exchange reserves %. Uses BTC tx count as proxy. BTC only. */
export async function getExchangeReserveChange(ticker) {
  const sym = toSymbol(ticker);
  const pf = preflight(`reserve_chg_${sym}`);
  if (pf.skip) return pf.val;
  try {
    if (sym !== 'BTC') return 0;
    const data = await fetchJSON('https://api.blockchain.info/stats', 'blockchain.info');
    if (!data || !data.difficulty) return 0;
    const txCount = data.n_tx || 0;
    const typicalDaily = 400000;
    const result = Math.round((txCount / typicalDaily - 1) * 10000) / 100;
    setCache(`reserve_chg_${sym}`, result);
    return result;
  } catch (e) { console.warn(`${LOG} getExchangeReserveChange: ${e.message}`); return 0; }
}

/** BTC miner outflow change %. Uses mempool.space mining pool concentration as proxy. */
export async function getMinerOutflow() {
  const pf = preflight('miner_outflow');
  if (pf.skip) return pf.val;
  try {
    const data = await fetchJSON('https://mempool.space/api/v1/mining/pools/1w', 'mempool.space');
    if (!data?.pools?.length) return 0;
    const total = data.pools.reduce((s, p) => s + (p.blockCount || 0), 0);
    if (!total) return 0;
    const top3 = data.pools.slice(0, 3).reduce((s, p) => s + (p.blockCount || 0), 0);
    const share = top3 / total;
    // Deviation from typical 55% top-3 share; inverted (less concentrated = more selling)
    const result = Math.round(-((share - 0.55) / 0.55) * 10000) / 100;
    setCache('miner_outflow', result);
    return result;
  } catch (e) { console.warn(`${LOG} getMinerOutflow: ${e.message}`); return 0; }
}

// ============================================
// AGGREGATED FETCH
// ============================================

const ZERO_RESULT = (ticker, enabled) => ({
  exchangeNetFlow: 0, mvrv: 0, activeAddresses: 0, hashRate: 0,
  whaleTransactions: 0, whaleVolume: 0, exchangeReserveChange: 0, minerOutflow: 0,
  ticker, timestamp: Date.now(), enabled,
});

/** Fetch all on-chain metrics in parallel. Returns object with all fields; zeros on failure. */
export async function getAllOnChainData(ticker) {
  if (!isEnabled()) return ZERO_RESULT(ticker, false);
  try {
    const [exchangeNetFlow, mvrv, activeAddresses, hashRate,
           whaleTransactions, whaleVolume, exchangeReserveChange, minerOutflow] =
      await Promise.all([
        getExchangeNetFlow(ticker), getMVRV(), getActiveAddresses(ticker), getHashRate(),
        getWhaleTransactions(ticker), getWhaleVolume(ticker), getExchangeReserveChange(ticker), getMinerOutflow(),
      ]);
    return { exchangeNetFlow, mvrv, activeAddresses, hashRate,
             whaleTransactions, whaleVolume, exchangeReserveChange, minerOutflow,
             ticker, timestamp: Date.now(), enabled: true };
  } catch (e) {
    console.warn(`${LOG} getAllOnChainData: ${e.message}`);
    return ZERO_RESULT(ticker, true);
  }
}
