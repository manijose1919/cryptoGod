// ============================================
// Phoenix V2 Backtest Candle Cache
// Primary: CryptoCompare (full history, free)
// Fallback: Kraken REST (last 720 candles only)
// Cache: SQLite for instant re-runs
// ============================================

import type { Candle } from '../pipeline/types.ts';
import { getDb } from '../../services/database.js';

// --- Interval Mapping ---

const INTERVAL_TO_MINUTES: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

// CryptoCompare endpoint per interval family
const CC_ENDPOINTS: Record<string, string> = {
  '1m': 'histominute',
  '5m': 'histominute',   // fetch 1m, aggregate to 5m
  '15m': 'histominute',  // fetch 1m, aggregate to 15m
  '30m': 'histominute',  // fetch 1m, aggregate to 30m
  '1h': 'histohour',
  '4h': 'histohour',     // fetch 1h, aggregate to 4h
  '1d': 'histoday',
};

// --- Ticker Symbol Mapping ---

function toBaseSymbol(ticker: string): string {
  // BTCUSD → BTC, ETHUSD → ETH
  return ticker.replace(/USD$/, '');
}

// --- Schema ---

export function initCacheTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS backtest_candles (
      ticker TEXT NOT NULL,
      interval TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (ticker, interval, time)
    );
    CREATE INDEX IF NOT EXISTS idx_bt_candles_lookup
      ON backtest_candles(ticker, interval, time);
  `);
}

// --- Rate Limiter ---

let _lastRequestTime = 0;
const MIN_REQUEST_GAP_MS = 1500; // CryptoCompare free tier: ~10 req/min, be safe

async function rateLimitedFetchJSON(url: string): Promise<unknown> {
  const now = Date.now();
  const gap = now - _lastRequestTime;
  if (gap < MIN_REQUEST_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS - gap));
  }
  _lastRequestTime = Date.now();

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// --- CryptoCompare Fetch ---

interface CCDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumefrom: number;
}

async function fetchCryptoCompare(
  fsym: string,
  endpoint: string,
  limit: number,
  toTs: number,
): Promise<Candle[]> {
  const url = `https://min-api.cryptocompare.com/data/v2/${endpoint}?fsym=${fsym}&tsym=USD&limit=${limit}&toTs=${toTs}`;
  const json = await rateLimitedFetchJSON(url) as {
    Response: string;
    Message: string;
    Data: { Data: CCDataPoint[] };
  };

  if (json.Response !== 'Success') {
    throw new Error(`CryptoCompare error: ${json.Message}`);
  }

  return json.Data.Data.map((d) => ({
    time: d.time * 1000, // CC returns seconds, we use ms
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    volume: d.volumefrom,
  }));
}

/**
 * Aggregate smaller candles into larger ones.
 * E.g., 15 × 1m candles → 1 × 15m candle
 */
function aggregateCandles(candles: Candle[], factor: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i <= candles.length - factor; i += factor) {
    const group = candles.slice(i, i + factor);
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

/**
 * Fetch historical candles from CryptoCompare with pagination.
 * Returns candles in ascending time order.
 */
async function fetchHistoricalCandles(
  ticker: string,
  startMs: number,
  endMs: number,
  interval: string,
): Promise<Candle[]> {
  const fsym = toBaseSymbol(ticker);
  const intervalMinutes = INTERVAL_TO_MINUTES[interval] || 15;

  // Determine base endpoint and aggregation factor
  let baseEndpoint: string;
  let aggregateFactor = 1;

  if (interval === '1m') {
    baseEndpoint = 'histominute';
  } else if (interval === '5m') {
    baseEndpoint = 'histominute';
    aggregateFactor = 5;
  } else if (interval === '15m') {
    baseEndpoint = 'histominute';
    aggregateFactor = 15;
  } else if (interval === '30m') {
    baseEndpoint = 'histominute';
    aggregateFactor = 30;
  } else if (interval === '1h') {
    baseEndpoint = 'histohour';
  } else if (interval === '4h') {
    baseEndpoint = 'histohour';
    aggregateFactor = 4;
  } else {
    baseEndpoint = 'histoday';
  }

  // Calculate total data points needed at base resolution
  const baseMinutes = baseEndpoint === 'histominute' ? 1
    : baseEndpoint === 'histohour' ? 60 : 1440;
  const totalBasePeriodMs = endMs - startMs;
  const totalBaseCandles = Math.ceil(totalBasePeriodMs / (baseMinutes * 60 * 1000));

  // CryptoCompare limit per request: 2000
  const BATCH_SIZE = 2000;
  const allCandles: Candle[] = [];
  let toTs = Math.floor(endMs / 1000);
  let remaining = totalBaseCandles;

  while (remaining > 0) {
    const limit = Math.min(remaining, BATCH_SIZE);
    const batch = await fetchCryptoCompare(fsym, baseEndpoint, limit, toTs);

    if (batch.length === 0) break;

    // Filter to requested range
    const inRange = batch.filter((c) => c.time >= startMs && c.time <= endMs);
    allCandles.push(...inRange);

    // Move backwards in time for next batch
    const earliestTime = batch[0].time;
    toTs = Math.floor(earliestTime / 1000) - 1;
    remaining -= batch.length;

    // If we got fewer than requested, we've reached the start of available data
    if (batch.length < limit) break;
  }

  // Sort ascending by time
  allCandles.sort((a, b) => a.time - b.time);

  // Deduplicate (overlapping batches)
  const seen = new Set<number>();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  // Aggregate if needed (e.g., 1m → 15m)
  if (aggregateFactor > 1) {
    return aggregateCandles(deduped, aggregateFactor);
  }

  return deduped;
}

// --- Kraken Public OHLC Fallback ---
// CryptoCompare's free min-api now returns 401 without an API key, which
// silently broke all fresh candle fetches. Kraken's public OHLC endpoint
// needs no auth and returns the last 720 candles of the requested interval
// (~120 days at 4h) — enough for 30-90d backtests on slow timeframes.

async function fetchKrakenOHLC(ticker: string, interval: string): Promise<Candle[]> {
  const minutes = INTERVAL_TO_MINUTES[interval] || 15;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${ticker}&interval=${minutes}`;
  const json = await rateLimitedFetchJSON(url) as {
    error: string[];
    result: Record<string, unknown>;
  };
  if (json.error && json.error.length > 0) {
    throw new Error(`Kraken error: ${json.error.join(', ')}`);
  }
  const key = Object.keys(json.result).find((k) => k !== 'last');
  if (!key) throw new Error('Kraken: empty OHLC result');
  const rows = json.result[key] as Array<[number, string, string, string, string, string, string, number]>;
  return rows.map((r) => ({
    time: r[0] * 1000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  }));
}

// --- Cache Operations ---

function getCachedCandles(
  ticker: string,
  interval: string,
  startMs: number,
  endMs: number,
): Candle[] {
  const stmt = getDb().prepare(`
    SELECT time, open, high, low, close, volume
    FROM backtest_candles
    WHERE ticker = @ticker AND interval = @interval
      AND time >= @startMs AND time <= @endMs
    ORDER BY time ASC
  `);
  const rows = stmt.all({ ticker, interval, startMs, endMs }) as Array<{
    time: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  return rows.map((r) => ({
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

function saveCandlesToCache(
  ticker: string,
  interval: string,
  candles: Candle[],
): void {
  if (candles.length === 0) return;

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO backtest_candles
      (ticker, interval, time, open, high, low, close, volume)
    VALUES (@ticker, @interval, @time, @open, @high, @low, @close, @volume)
  `);

  const insertMany = getDb().transaction((rows: Candle[]) => {
    for (const c of rows) {
      stmt.run({
        ticker,
        interval,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
  });

  insertMany(candles);
}

function getCachedRange(
  ticker: string,
  interval: string,
): { minTime: number; maxTime: number; count: number } | null {
  const row = getDb().prepare(`
    SELECT MIN(time) as minTime, MAX(time) as maxTime, COUNT(*) as cnt
    FROM backtest_candles
    WHERE ticker = @ticker AND interval = @interval
  `).get({ ticker, interval }) as { minTime: number | null; maxTime: number | null; cnt: number } | undefined;

  if (!row || row.minTime == null) return null;
  return { minTime: row.minTime, maxTime: row.maxTime!, count: row.cnt };
}

// --- Public API ---

/**
 * Load candles for a ticker over a date range.
 * Uses SQLite cache — fetches from CryptoCompare only for missing data.
 * Returns candles sorted by time ascending.
 */
export async function loadCandles(
  ticker: string,
  startDate: Date,
  endDate: Date,
  interval: string = '15m',
): Promise<Candle[]> {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const intervalMinutes = INTERVAL_TO_MINUTES[interval] || 15;
  const intervalMs = intervalMinutes * 60 * 1000;

  // Check what we already have cached
  const cached = getCachedRange(ticker, interval);
  const hasFullRange = cached
    && cached.minTime <= startMs + intervalMs  // start may be off by one interval
    && cached.maxTime >= endMs - 2 * 60 * 60 * 1000; // 2h end tolerance

  if (hasFullRange) {
    return getCachedCandles(ticker, interval, startMs, endMs);
  }

  // Fetch from CryptoCompare (supports full history); fall back to Kraken
  // public OHLC (no auth, last 720 candles) when CC fails — e.g. the free
  // min-api now 401s without an API key.
  console.log(`  Fetching ${ticker} ${interval} candles...`);

  let candles: Candle[];
  try {
    candles = await fetchHistoricalCandles(ticker, startMs, endMs, interval);
  } catch (ccErr) {
    console.log(`  CryptoCompare failed (${(ccErr as Error).message}) — trying Kraken public OHLC`);
    candles = (await fetchKrakenOHLC(ticker, interval))
      .filter((c) => c.time >= startMs && c.time <= endMs);
  }
  saveCandlesToCache(ticker, interval, candles);

  console.log(`  Cached ${candles.length} candles for ${ticker}`);

  return getCachedCandles(ticker, interval, startMs, endMs);
}

/**
 * Load candles for multiple tickers. Shows progress.
 */
export async function loadAllCandles(
  tickers: string[],
  startDate: Date,
  endDate: Date,
  interval: string = '15m',
): Promise<Map<string, Candle[]>> {
  initCacheTable();

  const result = new Map<string, Candle[]>();
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  console.log(`\nLoading candles: ${tickers.length} tickers, ${interval}, ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]} (${days}d)`);

  for (const ticker of tickers) {
    try {
      const candles = await loadCandles(ticker, startDate, endDate, interval);
      if (candles.length > 0) {
        result.set(ticker, candles);
        console.log(`  ✓ ${ticker}: ${candles.length} candles`);
      } else {
        console.log(`  ✗ ${ticker}: no data available`);
      }
    } catch (err) {
      console.log(`  ✗ ${ticker}: ${(err as Error).message}`);
    }
  }

  console.log(`Loaded ${result.size}/${tickers.length} tickers\n`);
  return result;
}
