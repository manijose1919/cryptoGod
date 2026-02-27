/**
 * Blockchair API Service
 *
 * Free tier: 1,000 calls/day, no API key required.
 * Provides whale BTC transaction detection and network stats.
 * Cache TTL: 5min. Rate limit: 1 req/s. Fail-open (returns null on error).
 */

import fetch from 'node-fetch';

const LOG = '[Blockchair]';
const BASE_URL = 'https://api.blockchair.com';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;
const WHALE_THRESHOLD_SATS = 10_000_000_000; // 100 BTC in satoshis

// --- Cache ---
const cache = new Map();

function getCached(key) {
    const e = cache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return undefined; }
    return e.v;
}

function setCache(key, value) {
    cache.set(key, { v: value, ts: Date.now() });
}

// --- Rate limiting (1 req/s global) ---
let lastRequestTime = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function enforceRateLimit() {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < 1200) await sleep(1200 - elapsed); // slightly >1s to stay safe
    lastRequestTime = Date.now();
}

// --- Fetch with timeout ---
async function fetchJSON(url) {
    await enforceRateLimit();
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
            signal: ac.signal,
            headers: {
                'User-Agent': 'CryptoGod/1.0',
                'Accept': 'application/json',
            },
        });
        clearTimeout(timer);

        if (res.status === 429) {
            console.warn(`${LOG} Rate limited (429). Backing off.`);
            return null;
        }
        if (!res.ok) {
            console.warn(`${LOG} HTTP ${res.status} from ${url}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        console.warn(`${LOG} ${err.name === 'AbortError' ? 'Timeout' : err.message}`);
        return null;
    }
}

// --- Previous values for change calculation ---
let prevNetworkStats = null;

/**
 * Get whale BTC transactions (>100 BTC) from recent blocks.
 * Returns { count, totalBtc } or null on failure.
 */
export async function getWhaleTransactions() {
    const cached = getCached('whale_txns');
    if (cached !== undefined) return cached;

    try {
        const data = await fetchJSON(
            `${BASE_URL}/bitcoin/transactions?q=output_total(${WHALE_THRESHOLD_SATS}..)&s=output_total(desc)&limit=10`
        );
        if (!data?.data) return null;

        const txns = data.data;
        const count = txns.length;
        const totalSats = txns.reduce((sum, tx) => sum + (tx.output_total || 0), 0);
        const totalBtc = totalSats / 1e8;

        const result = { count, totalBtc };
        setCache('whale_txns', result);
        console.log(`${LOG} Whale txns: ${count} transactions, ${totalBtc.toFixed(2)} BTC total`);
        return result;
    } catch (err) {
        console.warn(`${LOG} getWhaleTransactions: ${err.message}`);
        return null;
    }
}

/**
 * Get BTC network stats (hashrate, difficulty, mempool, transactions).
 * Returns { hashrate, difficulty, mempoolTxns, mempoolSize, transactions24h,
 *           avgTxValue, medianTxFee, marketPrice } or null on failure.
 */
export async function getNetworkStats() {
    const cached = getCached('network_stats');
    if (cached !== undefined) return cached;

    try {
        const data = await fetchJSON(`${BASE_URL}/bitcoin/stats`);
        if (!data?.data) return null;

        const s = data.data;
        const result = {
            hashrate: s.hashrate_24h || 0,
            difficulty: s.difficulty || 0,
            mempoolTxns: s.mempool_transactions || 0,
            mempoolSize: s.mempool_size || 0,            // bytes
            transactions24h: s.transactions_24h || 0,
            avgTxValue: s.average_transaction_amount || 0, // satoshis
            medianTxFee: s.median_transaction_fee_24h || 0,
            marketPrice: s.market_price_usd || 0,
            suggestedFee: s.suggested_transaction_fee_per_byte_sat || 0,
        };

        // Calculate changes from previous snapshot
        if (prevNetworkStats) {
            result.hashrateChange = prevNetworkStats.hashrate > 0
                ? ((result.hashrate - prevNetworkStats.hashrate) / prevNetworkStats.hashrate) * 100
                : 0;
            result.txCountChange = prevNetworkStats.transactions24h > 0
                ? ((result.transactions24h - prevNetworkStats.transactions24h) / prevNetworkStats.transactions24h) * 100
                : 0;
            result.mempoolChange = prevNetworkStats.mempoolTxns > 0
                ? ((result.mempoolTxns - prevNetworkStats.mempoolTxns) / prevNetworkStats.mempoolTxns) * 100
                : 0;
        } else {
            result.hashrateChange = 0;
            result.txCountChange = 0;
            result.mempoolChange = 0;
        }

        prevNetworkStats = {
            hashrate: result.hashrate,
            transactions24h: result.transactions24h,
            mempoolTxns: result.mempoolTxns,
        };

        setCache('network_stats', result);
        console.log(`${LOG} Network: ${result.transactions24h} txns/24h, mempool ${result.mempoolTxns}, hashrate change ${result.hashrateChange.toFixed(2)}%`);
        return result;
    } catch (err) {
        console.warn(`${LOG} getNetworkStats: ${err.message}`);
        return null;
    }
}

/**
 * Aggregated fetch — returns all Blockchair data for on-chain features.
 * Shape matches what onChainDataService expects to merge in.
 */
export async function getAllBlockchairData(ticker) {
    const sym = (ticker || '').toUpperCase().replace(/[-_\/USD]/g, '');
    // Blockchair free tier only covers BTC well
    if (sym !== 'BTC' && sym !== '') {
        return { whaleCount: 0, whaleBtcVolume: 0, networkStats: null };
    }

    try {
        const [whaleData, networkData] = await Promise.all([
            getWhaleTransactions(),
            getNetworkStats(),
        ]);

        return {
            whaleCount: whaleData?.count || 0,
            whaleBtcVolume: whaleData?.totalBtc || 0,
            whaleUsdVolume: (whaleData?.totalBtc || 0) * (networkData?.marketPrice || 0),
            networkStats: networkData,
        };
    } catch (err) {
        console.warn(`${LOG} getAllBlockchairData: ${err.message}`);
        return { whaleCount: 0, whaleBtcVolume: 0, networkStats: null };
    }
}

/**
 * Service status for monitoring.
 */
export function getStatus() {
    return {
        enabled: true,
        hasKey: true, // no key needed
        cacheSize: cache.size,
    };
}
