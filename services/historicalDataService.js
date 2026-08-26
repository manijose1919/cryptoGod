/**
 * Historical Data Service — Downloads & caches historical data for ML training.
 *
 * Sources:
 *   - CryptoCompare (primary): OHLCV candles, all timeframes, years of history, no geoblock
 *   - Alternative.me: Fear & Greed Index (Feb 2018+ daily)
 *   - DeFiLlama: Total DeFi TVL (2020+ daily)
 *
 * Download strategy:
 *   - 1h candles: CryptoCompare histohour (2000/request, ~22 pages per pair for 5yr)
 *   - 1d candles: CryptoCompare histoday (2000/request, 1 page for 5yr)
 *   - 4h candles: Aggregated from 1h data (no extra download)
 *   - 1w candles: Aggregated from 1d data (no extra download)
 *   - 5m/15m candles: CryptoCompare histominute + aggregation (optional, slow)
 *
 * 9 pairs: BTC, ETH, XRP, SOL, ADA, DOGE, LINK, DOT, AVAX
 */

import fetch from 'node-fetch';
import {
  insertHistoricalCandlesBatch,
  getHistoricalCandleCount,
  getHistoricalCandleRange,
  getHistoricalCandles,
  insertFearGreedBatch,
  getFearGreedCount,
  insertDefiTvlBatch,
  getDefiTvlCount,
  upsertDownloadProgress,
  getDownloadProgress,
} from './database.js';

// CryptoCompare symbol mapping: our ticker → {fsym, tsym}
const CC_SYMBOLS = {
  'BTCUSD': { fsym: 'BTC', tsym: 'USD' },
  'ETHUSD': { fsym: 'ETH', tsym: 'USD' },
  'XRPUSD': { fsym: 'XRP', tsym: 'USD' },
  'SOLUSD': { fsym: 'SOL', tsym: 'USD' },
  'ADAUSD': { fsym: 'ADA', tsym: 'USD' },
  'DOGEUSD': { fsym: 'DOGE', tsym: 'USD' },
  'LINKUSD': { fsym: 'LINK', tsym: 'USD' },
  'DOTUSD': { fsym: 'DOT', tsym: 'USD' },
  'AVAXUSD': { fsym: 'AVAX', tsym: 'USD' },
};

const CC_API_BASE = 'https://min-api.cryptocompare.com/data/v2';
const CC_RATE_LIMIT_MS = 1500;  // ~0.7 req/sec — CryptoCompare free tier is strict
const CC_MAX_CANDLES = 2000;

// Supported timeframes for download
const SUPPORTED_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'];

// Which timeframes need direct download vs aggregation
const DOWNLOAD_TIMEFRAMES = {
  '1h': { endpoint: 'histohour', limit: CC_MAX_CANDLES },
  '1d': { endpoint: 'histoday', limit: CC_MAX_CANDLES },
};
const AGGREGATED_TIMEFRAMES = {
  '4h': { source: '1h', factor: 4 },
  '1w': { source: '1d', factor: 7 },
};
const MINUTE_TIMEFRAMES = {
  '5m': { factor: 5 },
  '15m': { factor: 15 },
};

// Approximate ms per candle
const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

// Download state
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
  selectedTimeframes: SUPPORTED_TIMEFRAMES,
  totalRequestsEstimate: 0,
  completedRequests: 0,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch OHLCV from CryptoCompare.
 * Paginates backwards in time using `toTs`.
 *
 * @param {string} endpoint - 'histohour', 'histoday', or 'histominute'
 * @param {string} fsym - From symbol (e.g., 'BTC')
 * @param {string} tsym - To symbol (e.g., 'USD')
 * @param {number} limit - Max candles (up to 2000)
 * @param {number} toTs - End timestamp in seconds (pagination anchor)
 */
const CC_MAX_RETRIES = 5;
const CC_BASE_BACKOFF_MS = 5000;  // Start with 5s backoff on rate limit

async function fetchCryptoCompare(endpoint, fsym, tsym, limit, toTs) {
  let url = `${CC_API_BASE}/${endpoint}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
  if (toTs) url += `&toTs=${toTs}`;

  for (let attempt = 0; attempt <= CC_MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();

    // Handle rate limit errors with exponential backoff
    if (data.Response === 'Error') {
      const msg = data.Message || '';
      if (msg.toLowerCase().includes('rate limit') && attempt < CC_MAX_RETRIES) {
        const backoff = CC_BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`[HistoricalData] Rate limited, backing off ${backoff / 1000}s (attempt ${attempt + 1}/${CC_MAX_RETRIES})...`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`CryptoCompare API error: ${msg}`);
    }

    const candles = (data.Data?.Data || []).map(c => ({
      time: c.time * 1000,  // Convert to ms
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumefrom || 0,
    }));

    return candles;
  }

  throw new Error('CryptoCompare: max retries exhausted');
}

/**
 * Download all historical candles for a single pair/timeframe from CryptoCompare.
 * Paginates backwards by setting toTs to the earliest candle of the previous page.
 */
async function downloadDirect(ticker, timeframe, startTimeMs, endTimeMs, onProgress) {
  const sym = CC_SYMBOLS[ticker];
  if (!sym) throw new Error(`Unknown ticker: ${ticker}`);

  const config = DOWNLOAD_TIMEFRAMES[timeframe];
  if (!config) throw new Error(`No direct download for timeframe: ${timeframe}`);

  // Check existing data to avoid re-downloading
  const existingRange = getHistoricalCandleRange(ticker, timeframe);
  const startTimeSec = Math.floor(startTimeMs / 1000);

  // If we already have data going back far enough, skip
  if (existingRange?.earliest && existingRange.earliest <= startTimeMs) {
    const existing = getHistoricalCandleCount(ticker, timeframe);
    if (onProgress) onProgress(ticker, timeframe, existing, 0);
    return { total: existing, newCandles: 0 };
  }

  let toTs = Math.floor(endTimeMs / 1000);
  let totalNew = 0;
  let pageCount = 0;
  let totalInDb = getHistoricalCandleCount(ticker, timeframe);

  while (!downloadState.aborted) {
    const candles = await fetchCryptoCompare(config.endpoint, sym.fsym, sym.tsym, config.limit, toTs);

    if (candles.length === 0) break;

    // Filter: only keep candles within our target range
    const filtered = candles.filter(c => c.time >= startTimeMs && c.time <= endTimeMs);

    if (filtered.length > 0) {
      const dbCandles = filtered.map(c => ({
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
      totalNew += filtered.length;
    }

    totalInDb = getHistoricalCandleCount(ticker, timeframe);
    pageCount++;

    if (onProgress) onProgress(ticker, timeframe, totalInDb, pageCount);

    // Check if we've gone far enough back
    const earliestInPage = candles[0]?.time || 0;
    if (earliestInPage <= startTimeMs) break;

    // If page is small, we've reached the beginning of the pair's history
    if (candles.length < config.limit) break;

    // Move backwards: set toTs to just before the earliest candle
    toTs = Math.floor(earliestInPage / 1000) - 1;

    await sleep(CC_RATE_LIMIT_MS);
  }

  return { total: totalInDb, newCandles: totalNew };
}

/**
 * Aggregate higher-timeframe candles from lower-timeframe data.
 * E.g., aggregate 1h → 4h, or 1d → 1w.
 */
function aggregateCandles(ticker, targetTimeframe) {
  const config = AGGREGATED_TIMEFRAMES[targetTimeframe];
  if (!config) return 0;

  const sourceTf = config.source;
  const factor = config.factor;
  const tfMs = TIMEFRAME_MS[sourceTf];

  // Load all source candles
  const range = getHistoricalCandleRange(ticker, sourceTf);
  if (!range?.earliest) return 0;

  const sourceCandles = getHistoricalCandles(ticker, sourceTf, range.earliest, range.latest, 500000);
  if (sourceCandles.length < factor) return 0;

  // Group into blocks of `factor` candles
  const aggregated = [];
  for (let i = 0; i <= sourceCandles.length - factor; i += factor) {
    const block = sourceCandles.slice(i, i + factor);
    aggregated.push({
      ticker,
      timeframe: targetTimeframe,
      time: block[0].time,
      open: block[0].open,
      high: Math.max(...block.map(c => c.high)),
      low: Math.min(...block.map(c => c.low)),
      close: block[block.length - 1].close,
      volume: block.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  if (aggregated.length > 0) {
    // Insert in batches
    for (let i = 0; i < aggregated.length; i += 500) {
      insertHistoricalCandlesBatch(aggregated.slice(i, i + 500));
    }
  }

  return getHistoricalCandleCount(ticker, targetTimeframe);
}

/**
 * Download 1-minute data and aggregate to 5m/15m.
 * This is slow — ~1300 pages per pair for 5 years.
 */
async function downloadMinuteAndAggregate(ticker, targetTimeframe, startTimeMs, endTimeMs, onProgress) {
  const sym = CC_SYMBOLS[ticker];
  if (!sym) throw new Error(`Unknown ticker: ${ticker}`);

  const minuteConfig = MINUTE_TIMEFRAMES[targetTimeframe];
  if (!minuteConfig) throw new Error(`Not a minute-based timeframe: ${targetTimeframe}`);

  const factor = minuteConfig.factor;
  let toTs = Math.floor(endTimeMs / 1000);
  let totalNew = 0;
  let pageCount = 0;
  const buffer = [];

  while (!downloadState.aborted) {
    const candles = await fetchCryptoCompare('histominute', sym.fsym, sym.tsym, CC_MAX_CANDLES, toTs);

    if (candles.length === 0) break;

    const filtered = candles.filter(c => c.time >= startTimeMs && c.time <= endTimeMs);
    buffer.push(...filtered);

    // Aggregate buffer into target timeframe candles
    while (buffer.length >= factor) {
      const block = buffer.splice(0, factor);
      const aggCandle = {
        ticker,
        timeframe: targetTimeframe,
        time: block[0].time,
        open: block[0].open,
        high: Math.max(...block.map(c => c.high)),
        low: Math.min(...block.map(c => c.low)),
        close: block[block.length - 1].close,
        volume: block.reduce((sum, c) => sum + c.volume, 0),
      };
      insertHistoricalCandlesBatch([aggCandle]);
      totalNew++;
    }

    pageCount++;
    const totalInDb = getHistoricalCandleCount(ticker, targetTimeframe);
    if (onProgress) onProgress(ticker, targetTimeframe, totalInDb, pageCount);

    const earliestInPage = candles[0]?.time || 0;
    if (earliestInPage <= startTimeMs) break;
    if (candles.length < CC_MAX_CANDLES) break;

    toTs = Math.floor(earliestInPage / 1000) - 1;

    await sleep(CC_RATE_LIMIT_MS);
  }

  return { total: getHistoricalCandleCount(ticker, targetTimeframe), newCandles: totalNew };
}

/**
 * Download Fear & Greed Index history from Alternative.me.
 */
async function downloadFearGreed() {
  downloadState.fearGreed = { status: 'downloading', count: 0 };

  try {
    const url = 'https://api.alternative.me/fng/?limit=0&format=json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fear & Greed HTTP ${res.status}`);

    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) throw new Error('Invalid Fear & Greed response');

    const entries = data.data.map(d => ({
      date: new Date(parseInt(d.timestamp) * 1000).toISOString().split('T')[0],
      value: parseInt(d.value),
      classification: d.value_classification || '',
    }));

    for (let i = 0; i < entries.length; i += 500) {
      insertFearGreedBatch(entries.slice(i, i + 500));
    }

    const count = getFearGreedCount();
    downloadState.fearGreed = { status: 'complete', count };
    return count;
  } catch (e) {
    downloadState.fearGreed = { status: 'error', count: 0, error: e.message };
    throw e;
  }
}

/**
 * Download historical DeFi TVL from DeFiLlama.
 */
async function downloadDefiTvl() {
  downloadState.defiTvl = { status: 'downloading', count: 0 };

  try {
    const url = 'https://api.llama.fi/v2/historicalChainTvl';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid DeFiLlama response');

    const entries = data.map(d => ({
      date: new Date(d.date * 1000).toISOString().split('T')[0],
      tvl: d.tvl || 0,
    }));

    for (let i = 0; i < entries.length; i += 500) {
      insertDefiTvlBatch(entries.slice(i, i + 500));
    }

    const count = getDefiTvlCount();
    downloadState.defiTvl = { status: 'complete', count };
    return count;
  } catch (e) {
    downloadState.defiTvl = { status: 'error', count: 0, error: e.message };
    throw e;
  }
}

/**
 * Estimate total API requests needed.
 */
function estimateDownloadSize(tickers, timeframes, yearsBack) {
  const msBack = yearsBack * 365.25 * 24 * 3600 * 1000;
  let totalRequests = 0;

  for (const ticker of tickers) {
    for (const tf of timeframes) {
      if (DOWNLOAD_TIMEFRAMES[tf]) {
        const tfMs = TIMEFRAME_MS[tf];
        const totalCandles = Math.floor(msBack / tfMs);
        totalRequests += Math.ceil(totalCandles / CC_MAX_CANDLES);
      } else if (AGGREGATED_TIMEFRAMES[tf]) {
        // No extra requests needed — derived from existing data
      } else if (MINUTE_TIMEFRAMES[tf]) {
        // 1-minute data: very many requests
        const totalMinutes = Math.floor(msBack / 60000);
        totalRequests += Math.ceil(totalMinutes / CC_MAX_CANDLES);
      }
    }
  }

  const estimatedSeconds = totalRequests * (CC_RATE_LIMIT_MS / 1000) * 1.2;  // +20% buffer for retries
  return {
    totalRequests,
    estimatedMinutes: Math.ceil(estimatedSeconds / 60),
    estimatedHours: (estimatedSeconds / 3600).toFixed(1),
  };
}

/**
 * Start a full historical data download.
 *
 * @param {string[]} tickers - Tickers to download
 * @param {number} yearsBack - Years of history (default 5)
 * @param {string[]} timeframes - Timeframes to download (default: all)
 */
export async function startDownload(tickers = Object.keys(CC_SYMBOLS), yearsBack = 5, timeframes = null) {
  if (downloadState.active) {
    throw new Error('Download already in progress');
  }

  const selectedTimeframes = timeframes || ['1h', '4h', '1d'];
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

  // Init pair tracking
  for (const ticker of tickers) {
    if (!CC_SYMBOLS[ticker]) continue;
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

  for (const tf of selectedTimeframes) {
    downloadState.timeframes[tf] = { status: 'pending', totalCandles: 0 };
  }

  const startTimeMs = Date.now() - (yearsBack * 365.25 * 24 * 3600 * 1000);
  const endTimeMs = Date.now();

  // Run download in background
  (async () => {
    try {
      // Phase 1: Download base timeframes (1h, 1d) directly
      const directTFs = selectedTimeframes.filter(tf => DOWNLOAD_TIMEFRAMES[tf]);
      for (const tf of directTFs) {
        if (downloadState.aborted) break;

        downloadState.timeframes[tf].status = 'downloading';
        console.log(`[HistoricalData] ===== Downloading ${tf} candles =====`);

        for (const ticker of tickers) {
          if (downloadState.aborted) break;
          if (!CC_SYMBOLS[ticker]) continue;

          downloadState.currentTicker = ticker;
          downloadState.currentTimeframe = tf;
          downloadState.pairs[ticker].status = 'downloading';
          if (downloadState.pairs[ticker].timeframes[tf]) {
            downloadState.pairs[ticker].timeframes[tf].status = 'downloading';
          }

          try {
            const result = await downloadDirect(ticker, tf, startTimeMs, endTimeMs, (t, timeframe, n, p) => {
              downloadState.completedRequests++;
              if (downloadState.pairs[ticker]?.timeframes[tf]) {
                downloadState.pairs[ticker].timeframes[tf].downloaded = n;
              }
              if (p % 5 === 0 || p <= 2) {
                console.log(`[HistoricalData] ${t} ${timeframe}: ${n.toLocaleString()} candles (page ${p})`);
              }
            });

            console.log(`[HistoricalData] ${ticker} ${tf}: done (${result.total.toLocaleString()} total, ${result.newCandles} new)`);

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

        // Sum candles for this TF
        let total = 0;
        for (const ticker of tickers) total += getHistoricalCandleCount(ticker, tf);
        downloadState.timeframes[tf].status = 'complete';
        downloadState.timeframes[tf].totalCandles = total;
        console.log(`[HistoricalData] ${tf} complete: ${total.toLocaleString()} candles`);
      }

      // Phase 2: Aggregate derived timeframes (4h from 1h, 1w from 1d)
      const aggTFs = selectedTimeframes.filter(tf => AGGREGATED_TIMEFRAMES[tf]);
      for (const tf of aggTFs) {
        if (downloadState.aborted) break;

        downloadState.timeframes[tf] = { status: 'aggregating', totalCandles: 0 };
        console.log(`[HistoricalData] ===== Aggregating ${tf} from ${AGGREGATED_TIMEFRAMES[tf].source} =====`);

        for (const ticker of tickers) {
          if (!CC_SYMBOLS[ticker]) continue;

          downloadState.currentTicker = ticker;
          downloadState.currentTimeframe = tf;

          try {
            const count = aggregateCandles(ticker, tf);
            console.log(`[HistoricalData] ${ticker} ${tf}: ${count.toLocaleString()} aggregated candles`);

            if (downloadState.pairs[ticker].timeframes[tf]) {
              downloadState.pairs[ticker].timeframes[tf].status = 'complete';
              downloadState.pairs[ticker].timeframes[tf].downloaded = count;
            }
          } catch (e) {
            console.error(`[HistoricalData] ${ticker} ${tf} aggregation error: ${e.message}`);
            if (downloadState.pairs[ticker].timeframes[tf]) {
              downloadState.pairs[ticker].timeframes[tf].status = 'error';
              downloadState.pairs[ticker].timeframes[tf].error = e.message;
            }
          }
        }

        let total = 0;
        for (const ticker of tickers) total += getHistoricalCandleCount(ticker, tf);
        downloadState.timeframes[tf].status = 'complete';
        downloadState.timeframes[tf].totalCandles = total;
      }

      // Phase 3: Download minute-based timeframes if requested (5m, 15m) — SLOW
      const minuteTFs = selectedTimeframes.filter(tf => MINUTE_TIMEFRAMES[tf]);
      for (const tf of minuteTFs) {
        if (downloadState.aborted) break;

        downloadState.timeframes[tf] = { status: 'downloading', totalCandles: 0 };
        console.log(`[HistoricalData] ===== Downloading ${tf} (minute-based, slow) =====`);

        for (const ticker of tickers) {
          if (downloadState.aborted) break;
          if (!CC_SYMBOLS[ticker]) continue;

          downloadState.currentTicker = ticker;
          downloadState.currentTimeframe = tf;

          try {
            const result = await downloadMinuteAndAggregate(ticker, tf, startTimeMs, endTimeMs, (t, timeframe, n, p) => {
              downloadState.completedRequests++;
              if (downloadState.pairs[ticker]?.timeframes[tf]) {
                downloadState.pairs[ticker].timeframes[tf].downloaded = n;
              }
              if (p % 50 === 0 || p <= 2) {
                console.log(`[HistoricalData] ${t} ${timeframe}: ${n.toLocaleString()} candles (page ${p})`);
              }
            });

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

        let total = 0;
        for (const ticker of tickers) total += getHistoricalCandleCount(ticker, tf);
        downloadState.timeframes[tf].status = 'complete';
        downloadState.timeframes[tf].totalCandles = total;
      }

      // Phase 4: Update pair statuses
      for (const ticker of tickers) {
        if (downloadState.pairs[ticker]) {
          const tfStatuses = Object.values(downloadState.pairs[ticker].timeframes || {});
          const hasError = tfStatuses.some(t => t.status === 'error');
          downloadState.pairs[ticker].status = downloadState.aborted ? 'aborted' : hasError ? 'partial' : 'complete';
          let total = 0;
          for (const tf of selectedTimeframes) total += getHistoricalCandleCount(ticker, tf);
          downloadState.pairs[ticker].downloaded = total;
        }
      }

      // Phase 5: Download Fear & Greed + DeFi TVL
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
 * Get summary of all downloaded data.
 */
export function getDataSummary() {
  const summary = {
    pairs: {},
    timeframeSummary: {},
    fearGreed: 0,
    defiTvl: 0,
    totalCandles: 0,
  };

  for (const ticker of Object.keys(CC_SYMBOLS)) {
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

    // Backward compat
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

export const AVAILABLE_PAIRS = Object.keys(CC_SYMBOLS);
export { SUPPORTED_TIMEFRAMES };
