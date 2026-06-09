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
      // Jitter the effective fetch time by up to 15% of TTL so all keys of a
      // timeframe don't expire in lockstep (lockstep expiry = 12-24 REST
      // calls bursting at once every TTL boundary, brushing Kraken's limits).
      const jitter = Math.floor(Math.random() * ttl * 0.15);
      cache.set(key, { candles, fetchedAt: Date.now() - jitter });
      return candles;
    }
  } catch {
    // Return stale cache if available
    if (cached) return cached.candles;
    fetchFailuresThisPass++;
  }

  return null;
}

// Count of fetches that failed with NO cached fallback in the current
// fetchAllCandles pass — surfaced so silent 429s don't read as "no signals".
let fetchFailuresThisPass = 0;

/**
 * Fetch candles for all tickers across specified timeframes.
 * Respects per-timeframe stagger. Returns nested map: ticker → timeframe → candles.
 */
export async function fetchAllCandles(
  tickers: string[],
  timeframes: string[],
): Promise<Map<string, Map<string, Candle[]>>> {
  const result = new Map<string, Map<string, Candle[]>>();

  // Chunked fetching: 6 tickers × 4 TFs = 24 simultaneous REST calls was near
  // Kraken's public burst limit on cold start / TTL-aligned expiry. Run 4 at a
  // time with a short gap — cache hits resolve instantly so a warm pass adds
  // no latency, and a fully cold pass adds ~1.3s to a 60s loop.
  const CHUNK_SIZE = 4;
  const CHUNK_GAP_MS = 250;

  const fetches: { ticker: string; tf: string; run: () => Promise<Candle[] | null> }[] = [];
  for (const ticker of tickers) {
    for (const tf of timeframes) {
      fetches.push({ ticker, tf, run: () => fetchTimeframeCandles(ticker, tf) });
    }
  }

  fetchFailuresThisPass = 0;
  const results: PromiseSettledResult<Candle[] | null>[] = [];
  for (let i = 0; i < fetches.length; i += CHUNK_SIZE) {
    const chunk = fetches.slice(i, i + CHUNK_SIZE);
    results.push(...await Promise.allSettled(chunk.map(f => f.run())));
    if (i + CHUNK_SIZE < fetches.length) {
      await new Promise(r => setTimeout(r, CHUNK_GAP_MS));
    }
  }
  if (fetchFailuresThisPass > 0) {
    console.warn(`[V2 Candles] ${fetchFailuresThisPass}/${fetches.length} fetches failed with no cached fallback this pass`);
  }

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
