/**
 * Historical Data Service — Downloads & caches historical data for ML training.
 *
 * Sources:
 *   - Binance Public API (primary): OHLCV candles, all timeframes, years of history
 *   - Alternative.me: Fear & Greed Index (Feb 2018+ daily)
 *   - DeFiLlama: Total DeFi TVL (2020+ daily)
 *
 * Supported timeframes: 5m, 15m, 1h, 4h, 1d, 1w
 * 9 pairs: BTC, ETH, XRP, SOL, ADA, DOGE, LINK, DOT, AVAX
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

// Binance symbol mapping: our ticker -> Binance USDT pair
const BINANCE_SYMBOLS = {
  'BTCUSD': 'BTCUSDT',
  'ETHUSD': 'ETHUSDT',
  'XRPUSD': 'XRPUSDT',
  'SOLUSD': 'SOLUSDT',
  'ADAUSD': 'ADAUSDT',
  'DOGEUSD': 'DOGEUSDT',
  'LINKUSD': 'LINKUSDT',
  'DOTUSD': 'DOTUSDT',
  'AVAXUSD': 'AVAXUSDT',
};

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';
const BINANCE_RATE_LIMIT_MS = 350; // ~3 req/sec (conservative, 2400 weight/min limit)
const BINANCE_MAX_CANDLES = 1000;

// Supported timeframes for download
const SUPPORTED_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'];

// Approximate ms per candle for each timeframe (for ETA estimation)
const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

// Download state — tracks active downloads for API status
let downloadState = {
  active: false,
  aborted: false,
  pairs: {},
  timeframes: {},
  fearGreed: { status: 'pending', count: 0 },
  defiTvl: { status: 'pending', count: 0 },
  startTime: null,
  currentTicker: null,
  currentTimeframe: null,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch OHLCV candles from Binance public klines API.
 * Returns up to 1000 candles per request.
 *
 * @param {string} symbol - Binance symbol (e.g., 'BTCUSDT')
 * @param {string} interval - Binance interval (e.g., '1h', '5m', '1d')
 * @param {number} startTime - Start time in ms
 * @param {number} endTime - End time in ms
 */
async function fetchBinanceCandles(symbol, interval, startTime, endTime) {
  const url = `${BINANCE_API_BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${BINANCE_MAX_CANDLES}`;
  const res = await fetch(url);

  if (res.status === 429) {
    // Rate limited — back off and retry
    console.warn('[HistoricalData] Binance rate limit hit, backing off 10s...');
    await sleep(10000);
    const retryRes = await fetch(url);
    if (!retryRes.ok) throw new Error(`Binance HTTP ${retryRes.status} after retry`);
    const retryData = await retryRes.json();
    return parseBinanceKlines(retryData);
  }

  if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  return parseBinanceKlines(data);
}

/**
 * Parse Binance kline array format.
 * Format: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, buyBaseVol, buyQuoteVol, ignore]
 */
function parseBinanceKlines(data) {
  if (!Array.isArray(data)) return [];
  return data.map(k => ({
    time: Number(k[0]),            // Open time in ms
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: Number(k[6]),
  }));
}

/**
 * Download all historical candles for a single pair and timeframe from Binance.
 * Paginates forward through time using startTime/endTime.
 */
async function downloadPairTimeframe(ticker, timeframe, startTimeMs, endTimeMs, onProgress) {
  const symbol = BINANCE_SYMBOLS[ticker];
  if (!symbol) throw new Error(`Unknown ticker: ${ticker}`);

  // Check existing data to resume from
  const existingRange = getHistoricalCandleRange(ticker, timeframe);
  let currentStart = startTimeMs;
  if (existingRange?.latest) {
    // Resume from after the last downloaded candle
    currentStart = Math.max(currentStart, existingRange.latest + 1);
  }

  let totalDownloaded = getHistoricalCandleCount(ticker, timeframe);
  let pageCount = 0;
  let newCandles = 0;

  while (!downloadState.aborted && currentStart < endTimeMs) {
    const candles = await fetchBinanceCandles(symbol, timeframe, currentStart, endTimeMs);

    if (candles.length === 0) break;

    // Store in DB
    const dbCandles = candles.map(c => ({
      ticker,
      timeframe,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    insertHistoricalCandlesBatch(dbCandles);
    totalDownloaded = getHistoricalCandleCount(ticker, timeframe);
    pageCount++;
    newCandles += candles.length;

    // Update per-timeframe progress
    const progressKey = `${ticker}_${timeframe}`;
    upsertDownloadProgress('binance', progressKey, 'downloading', 0, totalDownloaded, candles[candles.length - 1].time);

    if (downloadState.pairs[ticker]) {
      if (!downloadState.pairs[ticker].timeframes) downloadState.pairs[ticker].timeframes = {};
      downloadState.pairs[ticker].timeframes[timeframe] = {
        downloaded: totalDownloaded,
        lastTime: candles[candles.length - 1].time,
      };
    }

    if (onProgress) onProgress(ticker, timeframe, totalDownloaded, pageCount);

    // If we got fewer than max, we've reached the end
    if (candles.length < BINANCE_MAX_CANDLES) break;

    // Advance start time past the last candle
    currentStart = candles[candles.length - 1].time + 1;

    // Rate limit
    await sleep(BINANCE_RATE_LIMIT_MS);
  }

  const progressKey = `${ticker}_${timeframe}`;
  upsertDownloadProgress('binance', progressKey, downloadState.aborted ? 'aborted' : 'complete', 0, totalDownloaded, 0);

  return { total: totalDownloaded, newCandles };
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

    const entries = data.data.map(d => {
      const ts = parseInt(d.timestamp) * 1000;
      const date = new Date(ts).toISOString().split('T')[0];
      return {
        date,
        value: parseInt(d.value),
        classification: d.value_classification || '',
      };
    });

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
 * Estimate total requests needed for a download configuration.
 */
function estimateDownloadSize(tickers, timeframes, yearsBack) {
  const msBack = yearsBack * 365.25 * 24 * 3600 * 1000;
  let totalRequests = 0;

  for (const ticker of tickers) {
    for (const tf of timeframes) {
      const tfMs = TIMEFRAME_MS[tf] || 3600000;
      const totalCandles = Math.floor(msBack / tfMs);
      const pages = Math.ceil(totalCandles / BINANCE_MAX_CANDLES);
      totalRequests += pages;
    }
  }

  const estimatedSeconds = totalRequests * (BINANCE_RATE_LIMIT_MS / 1000);
  return {
    totalRequests,
    estimatedMinutes: Math.ceil(estimatedSeconds / 60),
    estimatedHours: (estimatedSeconds / 3600).toFixed(1),
  };
}

/**
 * Start a full historical data download for selected pairs and timeframes.
 *
 * @param {string[]} tickers - Array of tickers (e.g., ['BTCUSD', 'ETHUSD'])
 * @param {number} yearsBack - How many years of history to fetch (default 5)
 * @param {string[]} timeframes - Timeframes to download (default: all supported)
 */
export async function startDownload(tickers = Object.keys(BINANCE_SYMBOLS), yearsBack = 5, timeframes = null) {
  if (downloadState.active) {
    throw new Error('Download already in progress');
  }

  const selectedTimeframes = timeframes || [...SUPPORTED_TIMEFRAMES];
  const estimate = estimateDownloadSize(tickers, selectedTimeframes, yearsBack);

  downloadState = {
    active: true,
    aborted: false,
    pairs: {},
    timeframes: {},
    fearGreed: { status: 'pending', count: 0 },
    defiTvl: { status: 'pending', count: 0 },
    startTime: Date.now(),
    currentTicker: null,
    currentTimeframe: null,
    selectedTimeframes,
    totalRequestsEstimate: estimate.totalRequests,
    completedRequests: 0,
  };

  // Initialize pair tracking
  for (const ticker of tickers) {
    if (!BINANCE_SYMBOLS[ticker]) continue;
    downloadState.pairs[ticker] = {
      status: 'pending',
      downloaded: 0,
      timeframes: {},
    };
    for (const tf of selectedTimeframes) {
      downloadState.pairs[ticker].timeframes[tf] = {
        downloaded: getHistoricalCandleCount(ticker, tf),
        status: 'pending',
      };
    }
  }

  // Initialize timeframe summary
  for (const tf of selectedTimeframes) {
    downloadState.timeframes[tf] = { status: 'pending', totalCandles: 0 };
  }

  const startTimeMs = Date.now() - (yearsBack * 365.25 * 24 * 3600 * 1000);
  const endTimeMs = Date.now();

  // Run download in background (non-blocking)
  (async () => {
    try {
      // Download by timeframe, then by pair (allows progress tracking per TF)
      for (const tf of selectedTimeframes) {
        if (downloadState.aborted) break;

        downloadState.timeframes[tf].status = 'downloading';
        console.log(`[HistoricalData] ===== Downloading timeframe ${tf} =====`);

        for (const ticker of tickers) {
          if (downloadState.aborted) break;
          if (!BINANCE_SYMBOLS[ticker]) continue;

          downloadState.currentTicker = ticker;
          downloadState.currentTimeframe = tf;
          downloadState.pairs[ticker].status = 'downloading';
          if (downloadState.pairs[ticker].timeframes[tf]) {
            downloadState.pairs[ticker].timeframes[tf].status = 'downloading';
          }

          console.log(`[HistoricalData] ${ticker} ${tf}: starting...`);

          try {
            const result = await downloadPairTimeframe(ticker, tf, startTimeMs, endTimeMs, (t, timeframe, n, p) => {
              downloadState.completedRequests++;
              if (p % 10 === 0 || p === 1) {
                console.log(`[HistoricalData] ${t} ${timeframe}: ${n.toLocaleString()} candles (page ${p})`);
              }
            });

            console.log(`[HistoricalData] ${ticker} ${tf}: complete (${result.total.toLocaleString()} total, ${result.newCandles.toLocaleString()} new)`);

            if (downloadState.pairs[ticker].timeframes[tf]) {
              downloadState.pairs[ticker].timeframes[tf].status = 'complete';
              downloadState.pairs[ticker].timeframes[tf].downloaded = result.total;
            }
          } catch (e) {
            console.error(`[HistoricalData] ${ticker} ${tf} error: ${e.message}`);
            if (downloadState.pairs[ticker].timeframes[tf]) {
              downloadState.pairs[ticker].timeframes[tf].status = 'error';
              downloadState.pairs[ticker].timeframes[tf].error = e.message;
            }
          }
        }

        // Mark timeframe complete
        if (!downloadState.aborted) {
          downloadState.timeframes[tf].status = 'complete';
          let totalForTf = 0;
          for (const ticker of tickers) {
            totalForTf += getHistoricalCandleCount(ticker, tf);
          }
          downloadState.timeframes[tf].totalCandles = totalForTf;
          console.log(`[HistoricalData] Timeframe ${tf} complete: ${totalForTf.toLocaleString()} total candles`);
        }
      }

      // Mark all pairs complete
      for (const ticker of tickers) {
        if (downloadState.pairs[ticker]) {
          const hasError = Object.values(downloadState.pairs[ticker].timeframes || {}).some(t => t.status === 'error');
          downloadState.pairs[ticker].status = downloadState.aborted ? 'aborted' : hasError ? 'partial' : 'complete';
          // Sum up total downloads across all timeframes
          let total = 0;
          for (const tf of selectedTimeframes) {
            total += getHistoricalCandleCount(ticker, tf);
          }
          downloadState.pairs[ticker].downloaded = total;
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

      console.log('[HistoricalData] ===== Download complete =====');
    } catch (e) {
      console.error('[HistoricalData] Download failed:', e.message);
    } finally {
      downloadState.active = false;
      downloadState.currentTicker = null;
      downloadState.currentTimeframe = null;
    }
  })();

  return { started: true, tickers, yearsBack, timeframes: selectedTimeframes, estimate };
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
  return {
    active: downloadState.active,
    startTime: downloadState.startTime,
    elapsed: downloadState.startTime ? Date.now() - downloadState.startTime : 0,
    pairs: downloadState.pairs,
    timeframes: downloadState.timeframes || {},
    fearGreed: downloadState.fearGreed,
    defiTvl: downloadState.defiTvl,
    currentTicker: downloadState.currentTicker,
    currentTimeframe: downloadState.currentTimeframe,
    selectedTimeframes: downloadState.selectedTimeframes || SUPPORTED_TIMEFRAMES,
    progress: downloadState.totalRequestsEstimate
      ? Math.min(100, (downloadState.completedRequests / downloadState.totalRequestsEstimate) * 100)
      : 0,
    completedRequests: downloadState.completedRequests || 0,
    totalRequestsEstimate: downloadState.totalRequestsEstimate || 0,
  };
}

/**
 * Get summary of all downloaded data, grouped by pair and timeframe.
 */
export function getDataSummary() {
  const summary = {
    pairs: {},
    timeframeSummary: {},
    fearGreed: 0,
    defiTvl: 0,
    totalCandles: 0,
  };

  for (const ticker of Object.keys(BINANCE_SYMBOLS)) {
    summary.pairs[ticker] = { timeframes: {}, totalCount: 0 };

    for (const tf of SUPPORTED_TIMEFRAMES) {
      const count = getHistoricalCandleCount(ticker, tf);
      const range = getHistoricalCandleRange(ticker, tf);
      summary.pairs[ticker].timeframes[tf] = {
        count,
        earliest: range?.earliest ? new Date(range.earliest).toISOString() : null,
        latest: range?.latest ? new Date(range.latest).toISOString() : null,
      };
      summary.pairs[ticker].totalCount += count;
      summary.totalCandles += count;

      if (!summary.timeframeSummary[tf]) summary.timeframeSummary[tf] = { totalCandles: 0, pairsWithData: 0 };
      summary.timeframeSummary[tf].totalCandles += count;
      if (count > 0) summary.timeframeSummary[tf].pairsWithData++;
    }

    // For backward compatibility, include top-level count (sum of 1h)
    const count1h = getHistoricalCandleCount(ticker, '1h');
    const range1h = getHistoricalCandleRange(ticker, '1h');
    summary.pairs[ticker].count = count1h;
    summary.pairs[ticker].earliest = range1h?.earliest ? new Date(range1h.earliest).toISOString() : null;
    summary.pairs[ticker].latest = range1h?.latest ? new Date(range1h.latest).toISOString() : null;
  }

  summary.fearGreed = getFearGreedCount();
  summary.defiTvl = getDefiTvlCount();

  return summary;
}

export const AVAILABLE_PAIRS = Object.keys(BINANCE_SYMBOLS);
export { SUPPORTED_TIMEFRAMES };
