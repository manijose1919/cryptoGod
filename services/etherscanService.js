/**
 * Etherscan Service - On-chain ETH data: gas, price, whale txns, ERC-20 transfers.
 * Free tier: 5 req/sec. Map-based cache with per-endpoint TTL.
 */
import fetch from 'node-fetch';

const API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BASE_URL = 'https://api.etherscan.io/api';

const WHALE_WALLETS = [
  { label: 'Binance', address: '0x28C6c06298d514Db089934071355E5743bf21d60' },
  { label: 'Coinbase', address: '0x71660c4005BA85c37ccec55d0C4493E66Fe775d3' }
];

const cache = new Map(); // key -> { data, expiry }
const CACHE_TTL = {
  GAS: 60 * 1000,          // 1 min
  PRICE: 60 * 1000,        // 1 min
  WHALE: 5 * 60 * 1000,    // 5 min
  TOKEN: 5 * 60 * 1000,    // 5 min
  STATS: 2 * 60 * 1000     // 2 min
};

const requestTimestamps = []; // sliding window rate limiter
const MAX_REQ_PER_SEC = 5;

// Dead flag: set permanently after deprecation errors (only resets on restart)
let _dead = false;
function isDead() { return _dead; }
function markDead(reason) {
  if (!_dead) console.warn(`[Etherscan] Permanently disabled this session: ${reason}`);
  _dead = true;
}

if (!API_KEY) {
  console.log('[Etherscan] No ETHERSCAN_API_KEY set. All functions will return null.');
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

async function rateLimitedFetch(url) {
  const now = Date.now();
  while (requestTimestamps.length && requestTimestamps[0] < now - 1000) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= MAX_REQ_PER_SEC) {
    const waitMs = 1000 - (now - requestTimestamps[0]) + 10;
    await new Promise(r => setTimeout(r, waitMs));
  }
  requestTimestamps.push(Date.now());

  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === '0' && json.message === 'NOTOK') {
    const msg = json.result || 'Etherscan API error';
    if (msg.includes('deprecated')) { markDead(msg); return null; }
    throw new Error(msg);
  }
  return json;
}

function weiToEth(wei) {
  return parseFloat(wei) / 1e18;
}

async function getGasPrice() {
  if (!API_KEY || isDead()) return null;
  const cacheKey = 'gas';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const json = await rateLimitedFetch(
      `${BASE_URL}?module=gastracker&action=gasoracle&apikey=${API_KEY}`
    );
    const r = json?.result;
    if (!r || typeof r !== 'object') return null; // API returned null/error
    const data = {
      low: parseFloat(r.SafeGasPrice),
      average: parseFloat(r.ProposeGasPrice),
      high: parseFloat(r.FastGasPrice),
      baseFee: parseFloat(r.suggestBaseFee) || null
    };
    setCache(cacheKey, data, CACHE_TTL.GAS);
    return data;
  } catch (err) {
    // Suppress recurring errors (v1 API deprecation, rate limits)
    if (!getGasPrice._lastErr || Date.now() - getGasPrice._lastErr > 300000) {
      getGasPrice._lastErr = Date.now();
      console.log(`[Etherscan] getGasPrice error: ${err.message}`);
    }
    return null;
  }
}

async function getEthPrice() {
  if (!API_KEY || isDead()) return null;
  const cacheKey = 'ethprice';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const json = await rateLimitedFetch(
      `${BASE_URL}?module=stats&action=ethprice&apikey=${API_KEY}`
    );
    const r = json.result;
    const data = {
      ethUsd: parseFloat(r.ethusd),
      ethBtc: parseFloat(r.ethbtc),
      timestamp: parseInt(r.ethusd_timestamp, 10)
    };
    setCache(cacheKey, data, CACHE_TTL.PRICE);
    return data;
  } catch (err) {
    console.log(`[Etherscan] getEthPrice error: ${err.message}`);
    return null;
  }
}

async function getTopWhaleTransactions(limit = 10) {
  if (!API_KEY || isDead()) return null;
  const cacheKey = `whale_${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const perWallet = Math.max(5, Math.ceil(limit / WHALE_WALLETS.length));
    const allTxns = [];

    for (const wallet of WHALE_WALLETS) {
      try {
        const json = await rateLimitedFetch(
          `${BASE_URL}?module=account&action=txlist&address=${wallet.address}` +
          `&page=1&offset=${perWallet}&sort=desc&apikey=${API_KEY}`
        );
        if (Array.isArray(json.result)) {
          for (const tx of json.result) {
            allTxns.push({
              from: tx.from,
              to: tx.to,
              value: weiToEth(tx.value),
              timestamp: parseInt(tx.timeStamp, 10),
              hash: tx.hash
            });
          }
        }
      } catch (err) {
        console.log(`[Etherscan] Whale fetch error (${wallet.label}): ${err.message}`);
      }
    }

    allTxns.sort((a, b) => b.timestamp - a.timestamp);
    const data = allTxns.slice(0, limit);
    setCache(cacheKey, data, CACHE_TTL.WHALE);
    return data;
  } catch (err) {
    console.log(`[Etherscan] getTopWhaleTransactions error: ${err.message}`);
    return null;
  }
}

async function getERC20TopTransfers(contractAddress, limit = 5) {
  if (!API_KEY || isDead()) return null;
  if (!contractAddress) {
    console.log('[Etherscan] getERC20TopTransfers: contractAddress required');
    return null;
  }
  const cacheKey = `erc20_${contractAddress}_${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const json = await rateLimitedFetch(
      `${BASE_URL}?module=account&action=tokentx&contractaddress=${contractAddress}` +
      `&page=1&offset=${limit}&sort=desc&apikey=${API_KEY}`
    );
    if (!Array.isArray(json.result)) return null;

    const data = json.result.map(tx => ({
      from: tx.from,
      to: tx.to,
      value: parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal, 10) || 18),
      tokenSymbol: tx.tokenSymbol,
      timestamp: parseInt(tx.timeStamp, 10)
    }));
    setCache(cacheKey, data, CACHE_TTL.TOKEN);
    return data;
  } catch (err) {
    console.log(`[Etherscan] getERC20TopTransfers error: ${err.message}`);
    return null;
  }
}

async function getNetworkStats() {
  if (!API_KEY || isDead()) return null;
  const cacheKey = 'netstats';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const [gasPrice, ethPrice, whaleTxns] = await Promise.all([
      getGasPrice(),
      getEthPrice(),
      getTopWhaleTransactions(20)
    ]);

    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const bigRecent = (whaleTxns || []).filter(
      tx => tx.value > 100 && tx.timestamp > oneHourAgo
    );

    const data = {
      gasPrice,
      ethPrice,
      recentWhaleActivity: bigRecent.length
    };
    setCache(cacheKey, data, CACHE_TTL.STATS);
    return data;
  } catch (err) {
    console.log(`[Etherscan] getNetworkStats error: ${err.message}`);
    return null;
  }
}

function getStatus() {
  return {
    enabled: !!API_KEY,
    hasKey: !!API_KEY,
    cacheSize: cache.size
  };
}

const etherscanService = {
  getGasPrice,
  getEthPrice,
  getTopWhaleTransactions,
  getERC20TopTransfers,
  getNetworkStats,
  getStatus
};

export {
  getGasPrice,
  getEthPrice,
  getTopWhaleTransactions,
  getERC20TopTransfers,
  getNetworkStats,
  getStatus
};

export default etherscanService;
