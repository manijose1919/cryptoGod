// ============================================
// Multi-Timeframe Candle Manager
// Staggered fetching: fast TFs every loop, slow TFs on TTL
// ============================================

import type { Candle } from '../pipeline/types.ts';

// Normalize Kraken adapter candles to V2 format
function normalizeCandles(raw: any[]): Candle[] {
  return raw.map((c: any) => ({
    time: c.t ?? c.time,
    open: c.o ?? c.open,
    high: c.h ?? c.high,
    low: c.l ?? c.low,
    close: c.c ?? c.close,
    volume: c.v ?? c.volume,
  }));
}

interface CachedCandles {
  candles: Candle[];
  fetchedAt: number;
}

// Stagger intervals: how often each timeframe refreshes
const STAGGER_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 60_000,
  '15m': 300_000,
  '30m': 300_000,
  '1h': 900_000,
  '4h': 900_000,
};

// ticker:timeframe → cached candles
const cache = new Map<string, CachedCandles>();

let _adapter: any = null;

async function getAdapter(): Promise<any> {
  if (!_adapter) {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    _adapter = mod.krakenAdapter;
  }
  return _adapter;
}

function cacheKey(ticker: string, tf: string): string {
  return `${ticker}:${tf}`;
}

/**
 * Fetch candles for a specific ticker+timeframe, respecting stagger TTL.
 * Returns cached data if within TTL, else fetches fresh.
 */
export async function fetchTimeframeCandles(
  ticker: string,
  timeframe: string,
  limit: number = 200,
): Promise<Candle[] | null> {
  const key = cacheKey(ticker, timeframe);
  const cached = cache.get(key);
  const ttl = STAGGER_MS[timeframe] ?? 900_000;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.candles;
  }

  try {
    const adapter = await getAdapter();
    const raw = await adapter.getCandles(ticker, timeframe, limit);
    if (raw && raw.length > 0) {
      const candles = normalizeCandles(raw);
      cache.set(key, { candles, fetchedAt: Date.now() });
      return candles;
    }
  } catch {
    // Return stale cache if available
    if (cached) return cached.candles;
  }

  return null;
}

/**
 * Fetch candles for all tickers across specified timeframes.
 * Respects per-timeframe stagger. Returns nested map: ticker → timeframe → candles.
 */
export async function fetchAllCandles(
  tickers: string[],
  timeframes: string[],
): Promise<Map<string, Map<string, Candle[]>>> {
  const result = new Map<string, Map<string, Candle[]>>();

  // Batch all fetches in parallel
  const fetches: { ticker: string; tf: string; promise: Promise<Candle[] | null> }[] = [];

  for (const ticker of tickers) {
    for (const tf of timeframes) {
      fetches.push({
        ticker,
        tf,
        promise: fetchTimeframeCandles(ticker, tf),
      });
    }
  }

  const results = await Promise.allSettled(fetches.map(f => f.promise));

  for (let i = 0; i < fetches.length; i++) {
    const { ticker, tf } = fetches[i];
    const res = results[i];
    if (res.status === 'fulfilled' && res.value && res.value.length > 0) {
      if (!result.has(ticker)) result.set(ticker, new Map());
      result.get(ticker)!.set(tf, res.value);
    }
  }

  return result;
}

/**
 * Get the unique set of timeframes needed across all strategies.
 */
export function getRequiredTimeframes(strategyTimeframes: Record<string, string[]>): string[] {
  const tfs = new Set<string>();
  for (const tfList of Object.values(strategyTimeframes)) {
    for (const tf of tfList) tfs.add(tf);
  }
  return Array.from(tfs);
}
