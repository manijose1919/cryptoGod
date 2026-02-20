/**
 * Historical Data Service — Downloads & caches historical data for ML training.
 *
 * Sources:
 *   - Kraken REST API: 1h OHLCV candles (5+ years, 9 pairs)
 *   - Alternative.me: Fear & Greed Index (Feb 2018+ daily)
 *   - DeFiLlama: Total DeFi TVL (2020+ daily)
 */

import fetch from 'node-fetch';
import {
  insertHistoricalCandlesBatch,
  getHistoricalCandleCount,
  getHistoricalCandleRange,
  insertFearGreedBatch,
  getFearGreedCount,
  insertDefiTvlBatch,
  getDefiTvlCount,
  upsertDownloadProgress,
  getDownloadProgress,
} from './database.js';

// Kraken pair mapping: our ticker -> Kraken API pair name
const KRAKEN_PAIRS = {
  'BTCUSD': 'XBTUSD',
  'ETHUSD': 'ETHUSD',
  'XRPUSD': 'XRPUSD',
  'SOLUSD': 'SOLUSD',
  'ADAUSD': 'ADAUSD',
  'DOGEUSD': 'DOGEUSD',
  'LINKUSD': 'LINKUSD',
  'DOTUSD': 'DOTUSD',
  'AVAXUSD': 'AVAXUSD',
};

const KRAKEN_API_BASE = 'https://api.kraken.com/0/public';
const RATE_LIMIT_MS = 1100; // 1 req/sec with margin

// Download state — tracks active downloads for API status
let downloadState = {
  active: false,
  aborted: false,
  pairs: {},
  fearGreed: { status: 'pending', count: 0 },
  defiTvl: { status: 'pending', count: 0 },
  startTime: null,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch OHLCV candles from Kraken REST API.
 * Kraken returns max 720 candles per request. We paginate using `since` param.
 * @param {string} krakenPair - Kraken pair name (e.g., 'XBTUSD')
 * @param {number} interval - Interval in minutes (60 for 1h)
 * @param {number} since - Unix timestamp (seconds) to start from
 */
async function fetchKrakenCandles(krakenPair, interval = 60, since = 0) {
  const url = `${KRAKEN_API_BASE}/OHLC?pair=${krakenPair}&interval=${interval}&since=${since}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken API error: ${data.error.join(', ')}`);
  }

  // Kraken returns data under the pair key (may differ from input)
  const pairKeys = Object.keys(data.result).filter(k => k !== 'last');
  const pairKey = pairKeys[0];
  if (!pairKey) return { candles: [], last: 0 };

  const rawCandles = data.result[pairKey];
  const last = data.result.last || 0;

  // Kraken OHLC format: [time, open, high, low, close, vwap, volume, count]
  const candles = rawCandles.map(c => ({
    time: Number(c[0]) * 1000, // Convert to ms
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[6]),
  }));

  return { candles, last };
}

/**
 * Download all historical candles for a single pair from Kraken.
 * Paginates through the full history, storing in batches.
 */
async function downloadPairCandles(ticker, startTimeSec, onProgress) {
  const krakenPair = KRAKEN_PAIRS[ticker];
  if (!krakenPair) throw new Error(`Unknown ticker: ${ticker}`);

  // Check if we have existing data to resume from
  const existingRange = getHistoricalCandleRange(ticker, '1h');
  let since = startTimeSec;
  if (existingRange?.latest) {
    // Resume from last downloaded candle
    since = Math.max(since, Math.floor(existingRange.latest / 1000));
  }

  let totalDownloaded = getHistoricalCandleCount(ticker, '1h');
  let pageCount = 0;

  while (!downloadState.aborted) {
    const { candles, last } = await fetchKrakenCandles(krakenPair, 60, since);

    if (candles.length === 0) break;

    // Store in DB
    const dbCandles = candles.map(c => ({
      ticker,
      timeframe: '1h',
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    insertHistoricalCandlesBatch(dbCandles);
    totalDownloaded = getHistoricalCandleCount(ticker, '1h');
    pageCount++;

    // Update progress
    upsertDownloadProgress('kraken', ticker, 'downloading', 0, totalDownloaded, candles[candles.length - 1].time);

    if (downloadState.pairs[ticker]) {
      downloadState.pairs[ticker].downloaded = totalDownloaded;
      downloadState.pairs[ticker].lastTime = candles[candles.length - 1].time;
    }

    if (onProgress) onProgress(ticker, totalDownloaded, pageCount);

    // If we got fewer than 720 candles, we've reached the end
    if (candles.length < 720) break;

    // Advance `since` to last candle's timestamp
    since = Math.floor(candles[candles.length - 1].time / 1000);

    // Rate limit
    await sleep(RATE_LIMIT_MS);
  }

  upsertDownloadProgress('kraken', ticker, downloadState.aborted ? 'aborted' : 'complete', 0, totalDownloaded, 0);
  if (downloadState.pairs[ticker]) {
    downloadState.pairs[ticker].status = downloadState.aborted ? 'aborted' : 'complete';
  }

  return totalDownloaded;
}

/**
 * Download Fear & Greed Index history from Alternative.me.
 * Single request returns all available history.
 */
async function downloadFearGreed() {
  downloadState.fearGreed = { status: 'downloading', count: 0 };
  upsertDownloadProgress('fear_greed', null, 'downloading', 0, 0, 0);

  try {
    const url = 'https://api.alternative.me/fng/?limit=0&format=json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fear & Greed HTTP ${res.status}`);

    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid Fear & Greed response');
    }

    // Convert to DB format
    const entries = data.data.map(d => {
      const ts = parseInt(d.timestamp) * 1000;
      const date = new Date(ts).toISOString().split('T')[0]; // YYYY-MM-DD
      return {
        date,
        value: parseInt(d.value),
        classification: d.value_classification || '',
      };
    });

    // Insert in batches of 500
    for (let i = 0; i < entries.length; i += 500) {
      insertFearGreedBatch(entries.slice(i, i + 500));
    }

    const count = getFearGreedCount();
    downloadState.fearGreed = { status: 'complete', count };
    upsertDownloadProgress('fear_greed', null, 'complete', entries.length, count, 0);

    return count;
  } catch (e) {
    downloadState.fearGreed = { status: 'error', count: 0, error: e.message };
    upsertDownloadProgress('fear_greed', null, 'error', 0, 0, 0, e.message);
    throw e;
  }
}

/**
 * Download historical DeFi TVL from DeFiLlama.
 * Single request returns all available history.
 */
async function downloadDefiTvl() {
  downloadState.defiTvl = { status: 'downloading', count: 0 };
  upsertDownloadProgress('defi_tvl', null, 'downloading', 0, 0, 0);

  try {
    const url = 'https://api.llama.fi/v2/historicalChainTvl';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('Invalid DeFiLlama response');
    }

    const entries = data.map(d => ({
      date: new Date(d.date * 1000).toISOString().split('T')[0],
      tvl: d.tvl || 0,
    }));

    // Insert in batches of 500
    for (let i = 0; i < entries.length; i += 500) {
      insertDefiTvlBatch(entries.slice(i, i + 500));
    }

    const count = getDefiTvlCount();
    downloadState.defiTvl = { status: 'complete', count };
    upsertDownloadProgress('defi_tvl', null, 'complete', entries.length, count, 0);

    return count;
  } catch (e) {
    downloadState.defiTvl = { status: 'error', count: 0, error: e.message };
    upsertDownloadProgress('defi_tvl', null, 'error', 0, 0, 0, e.message);
    throw e;
  }
}

/**
 * Start a full historical data download for selected pairs.
 * @param {string[]} tickers - Array of tickers (e.g., ['BTCUSD', 'ETHUSD'])
 * @param {number} yearsBack - How many years of history to fetch (default 5)
 */
export async function startDownload(tickers = Object.keys(KRAKEN_PAIRS), yearsBack = 5) {
  if (downloadState.active) {
    throw new Error('Download already in progress');
  }

  downloadState = {
    active: true,
    aborted: false,
    pairs: {},
    fearGreed: { status: 'pending', count: 0 },
    defiTvl: { status: 'pending', count: 0 },
    startTime: Date.now(),
  };

  // Initialize pair tracking
  for (const ticker of tickers) {
    if (!KRAKEN_PAIRS[ticker]) continue;
    downloadState.pairs[ticker] = {
      status: 'pending',
      downloaded: getHistoricalCandleCount(ticker, '1h'),
      lastTime: 0,
    };
  }

  const startTimeSec = Math.floor(Date.now() / 1000) - (yearsBack * 365.25 * 24 * 3600);

  // Run download in background (non-blocking)
  (async () => {
    try {
      // Download candles for each pair sequentially (rate limiting)
      for (const ticker of tickers) {
        if (downloadState.aborted) break;
        if (!KRAKEN_PAIRS[ticker]) continue;

        downloadState.pairs[ticker].status = 'downloading';
        console.log(`[HistoricalData] Downloading ${ticker}...`);

        try {
          const count = await downloadPairCandles(ticker, startTimeSec, (t, n, p) => {
            console.log(`[HistoricalData] ${t}: ${n} candles (page ${p})`);
          });
          console.log(`[HistoricalData] ${ticker}: complete (${count} candles)`);
        } catch (e) {
          console.error(`[HistoricalData] ${ticker} error: ${e.message}`);
          downloadState.pairs[ticker].status = 'error';
          downloadState.pairs[ticker].error = e.message;
          upsertDownloadProgress('kraken', ticker, 'error', 0, 0, 0, e.message);
        }
      }

      // Download Fear & Greed + DeFi TVL in parallel
      if (!downloadState.aborted) {
        console.log('[HistoricalData] Downloading Fear & Greed + DeFi TVL...');
        await Promise.allSettled([
          downloadFearGreed().catch(e => console.error('[HistoricalData] Fear & Greed error:', e.message)),
          downloadDefiTvl().catch(e => console.error('[HistoricalData] DeFi TVL error:', e.message)),
        ]);
      }

      console.log('[HistoricalData] Download complete');
    } catch (e) {
      console.error('[HistoricalData] Download failed:', e.message);
    } finally {
      downloadState.active = false;
    }
  })();

  return { started: true, tickers, yearsBack };
}

/**
 * Abort an active download.
 */
export function abortDownload() {
  downloadState.aborted = true;
  return { aborted: true };
}

/**
 * Get current download status.
 */
export function getDownloadStatus() {
  const dbProgress = getDownloadProgress();
  return {
    active: downloadState.active,
    startTime: downloadState.startTime,
    elapsed: downloadState.startTime ? Date.now() - downloadState.startTime : 0,
    pairs: downloadState.pairs,
    fearGreed: downloadState.fearGreed,
    defiTvl: downloadState.defiTvl,
    dbProgress,
  };
}

/**
 * Get summary of all downloaded data.
 */
export function getDataSummary() {
  const summary = { pairs: {}, fearGreed: 0, defiTvl: 0 };

  for (const ticker of Object.keys(KRAKEN_PAIRS)) {
    const count = getHistoricalCandleCount(ticker, '1h');
    const range = getHistoricalCandleRange(ticker, '1h');
    summary.pairs[ticker] = {
      count,
      earliest: range?.earliest ? new Date(range.earliest).toISOString() : null,
      latest: range?.latest ? new Date(range.latest).toISOString() : null,
    };
  }

  summary.fearGreed = getFearGreedCount();
  summary.defiTvl = getDefiTvlCount();

  return summary;
}

export const AVAILABLE_PAIRS = Object.keys(KRAKEN_PAIRS);
