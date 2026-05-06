// ============================================
// SNIPER Engine v2 (new-coin sniper, 2026-05-06)
// ============================================
// Side-project engine: snipes new Kraken USD listings during their early
// volatility window. Independent budget ($500), independent loop, trades
// tagged strategy='SNIPER' so reports never mix with TREND/MOMENTUM stats.
//
// Lifecycle:
//   * Engine ENABLED gate lives in SNIPER_CONFIG.ENABLED — v2/index.ts boots
//     only when enabled.
//   * Loop:
//       1. Refresh Kraken pair list every 30 min via newCoinDetector.detectNewListings
//       2. For each active new listing: refresh its candles, update rug-pull signals
//       3. Check exits on open SNIPER trades
//       4. Evaluate entry signals on candidate listings
// ============================================

import type { Candle, V2Trade } from '../pipeline/types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import type { NewCoinDetector } from '../pipeline/sniperSignal.ts';
import { detectSniperEntry } from '../pipeline/sniperSignal.ts';
import { checkSniperExits } from '../pipeline/sniperExitManager.ts';
import {
  insertTrade,
  closeTrade,
  getOpenTradesByStrategy,
} from '../attribution/attributionStore.ts';
import { loadPortfolio } from './positionManager.ts';
import { SNIPER_CONFIG, getExchangeFees } from './config.ts';
import { randomUUID } from 'node:crypto';

const STRATEGY = SNIPER_CONFIG.STRATEGY_TAG;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let pairRefreshTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let loopInProgress = false;
let exchange: ExchangeAdapter | null = null;
let detector: NewCoinDetector | null = null;
let detectorModule: Record<string, unknown> | null = null;
let lastPairRefresh = 0;

const stats = {
  loopCount: 0,
  pairRefreshCount: 0,
  newListingsDetected: 0,
  tradesOpened: 0,
  tradesClosed: 0,
  totalPnl: 0,
};

const candleCache = new Map<string, Candle[]>();

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  try {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    // 15m candles, 80 bars = ~20h of history (enough for the 20-bar minimum
    // plus headroom for indicators). Newcoin listings often have <24h of data.
    const raw = await mod.krakenAdapter.getCandles(ticker, SNIPER_CONFIG.CANDLE_INTERVAL, 80);
    if (!raw || raw.length === 0) return null;
    const candles: Candle[] = raw.map((c: Record<string, number>) => ({
      open: c.o ?? c.open,
      high: c.h ?? c.high,
      low: c.l ?? c.low,
      close: c.c ?? c.close,
      volume: c.v ?? c.volume ?? 0,
      time: c.t ?? c.time ?? 0,
    }));
    candleCache.set(ticker, candles);
    return candles;
  } catch {
    return null;
  }
}

// Threshold: more than this many "new" listings in one pass is implausible —
// it means the cache was empty and we're catching up. Treat as warmup.
const WARMUP_THRESHOLD = 20;

async function refreshKrakenPairList(): Promise<void> {
  if (!detectorModule) return;
  try {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const result = await mod.krakenAdapter.getInstruments();
    const tickers = (result?.data ?? []).map((i: { instrument_name: string }) => i.instrument_name);

    // First refresh: do a warmup acknowledge before letting detectNewListings
    // run. Otherwise an empty in-memory cache would mis-flag every existing
    // pair as "new" and the sniper would try to enter on BTCUSD, ETHUSD, etc.
    if (lastPairRefresh === 0) {
      const ackFn = detectorModule.acknowledgeKnownTickers as ((t: string[]) => number) | undefined;
      if (ackFn) {
        const ackedCount = ackFn(tickers);
        console.log(`[SNIPER] Warmup: acknowledged ${ackedCount}/${tickers.length} pair(s) — sniper now tracks only genuinely new listings`);
      }
    }

    const detectFn = detectorModule.detectNewListings as (t: string[]) => string[];
    const newlyDetected = detectFn ? detectFn(tickers) : [];

    // Defense-in-depth: if a refresh ever returns >WARMUP_THRESHOLD "new"
    // tickers, that's a cache-empty signature, not a real listing event.
    // Acknowledge them silently rather than letting them become tradeable.
    if (newlyDetected.length > WARMUP_THRESHOLD) {
      console.warn(`[SNIPER] Implausible new-listing burst (${newlyDetected.length}) — likely cache-empty event, treating as warmup`);
      const ackFn = detectorModule.acknowledgeKnownTickers as ((t: string[]) => number) | undefined;
      if (ackFn) ackFn(newlyDetected);
      // Still increment pairRefreshCount so we don't get stuck in a warmup loop.
      stats.pairRefreshCount++;
      lastPairRefresh = Date.now();
      return;
    }

    stats.pairRefreshCount++;
    stats.newListingsDetected += newlyDetected.length;
    lastPairRefresh = Date.now();
    if (newlyDetected.length > 0) {
      console.log(`[SNIPER] Pair refresh: ${newlyDetected.length} new listing(s) detected — ${newlyDetected.join(', ')}`);
    }
  } catch (err: unknown) {
    console.warn(`[SNIPER] Pair refresh failed: ${(err as Error).message}`);
  }
}

async function updateListingSignals(): Promise<void> {
  if (!detectorModule || !detector) return;
  const updateFn = detectorModule.updateNewCoinSignals as
    | ((t: string, p: number, v: number, s: number) => unknown)
    | undefined;
  if (!updateFn) return;

  for (const listing of detector.getActiveNewListings()) {
    const candles = candleCache.get(listing.ticker);
    if (!candles || candles.length === 0) continue;
    const last = candles[candles.length - 1];
    // Spread is unknown without ticker depth; pass 0 (won't trigger SPREAD_WIDENING flag).
    updateFn(listing.ticker, last.close, last.volume * last.close, 0);
  }
}

async function runLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    if (!detector) {
      // Detector failed to load — sit idle but keep loop alive.
      return;
    }

    // ----- candle refresh for all currently-tracked listings -----
    const activeListings = detector.getActiveNewListings();
    for (const listing of activeListings) {
      await fetchCandles(listing.ticker);
    }

    // ----- update rug-pull signals using fresh candle data -----
    await updateListingSignals();

    // ----- exits first -----
    const openSniper = getOpenTradesByStrategy(STRATEGY);
    if (openSniper.length > 0 && exchange) {
      const exitResults = await checkSniperExits(openSniper, exchange, detector);
      const fees = getExchangeFees(exchange.getName());
      for (const r of exitResults) {
        if (!r.shouldExit) continue;
        const t = r.trade;
        const pnlGross = (r.exitPrice - t.entryPrice) * t.quantity;
        const totalFees = t.positionSizeUsd * fees.ROUND_TRIP_REAL;
        const pnlNet = pnlGross - totalFees;
        closeTrade(t.id, r.exitPrice, r.exitReason as never ?? 'unknown', totalFees);
        stats.tradesClosed++;
        stats.totalPnl += pnlNet;
        console.log(`[SNIPER] Trade closed: ${t.ticker} @ $${r.exitPrice.toFixed(6)} reason=${r.exitReason} PnL=$${pnlNet.toFixed(4)}`);
      }
    }

    // ----- entry search -----
    const currentSniper = getOpenTradesByStrategy(STRATEGY);
    if (currentSniper.length >= SNIPER_CONFIG.MAX_OPEN_POSITIONS) {
      if (stats.loopCount % 10 === 0) {
        console.log(`[SNIPER] Loop #${stats.loopCount}: max positions (${currentSniper.length}/${SNIPER_CONFIG.MAX_OPEN_POSITIONS})`);
      }
      return;
    }

    const portfolio = loadPortfolio(SNIPER_CONFIG.BUDGET_USD, STRATEGY);

    for (const listing of activeListings) {
      const ticker = listing.ticker;

      // Skip if already holding
      if (currentSniper.some(t => t.ticker === ticker)) continue;

      const candles = candleCache.get(ticker);
      if (!candles || candles.length < SNIPER_CONFIG.MIN_CANDLES) continue;

      const signal = detectSniperEntry(candles, ticker, detector);
      if (!signal) continue;

      const equity = portfolio.totalEquity;
      let posSize = equity * SNIPER_CONFIG.POSITION_SIZE_PERCENT * signal.confidence;
      if (posSize > equity * SNIPER_CONFIG.MAX_POSITION_PERCENT) {
        posSize = equity * SNIPER_CONFIG.MAX_POSITION_PERCENT;
      }
      if (posSize > portfolio.availableCapital) posSize = portfolio.availableCapital;
      if (posSize < 5) continue;  // dust filter

      const price = signal.signals.close_price as number;
      const sl = price * (1 - SNIPER_CONFIG.STOP_LOSS_PERCENT);
      // No fixed TP — trail does the work. Set TP far above for the schema's NOT NULL.
      const tp = price * 2;

      const qty = posSize / price;
      const fees = getExchangeFees(exchange?.getName() ?? 'kraken');
      const entryFeeEstimate = posSize * fees.MAKER_PERCENT;

      const trade: V2Trade = {
        id: randomUUID(),
        ticker,
        side: 'long',
        status: 'open' as never,
        entryPrice: price,
        entryTime: Date.now(),
        entryOrderType: 'maker',
        quantity: qty,
        positionSizeUsd: posSize,
        exitPrice: null,
        exitTime: null,
        exitReason: null,
        pnlGross: null,
        pnlNet: null,
        feesPaid: entryFeeEstimate,
        holdDurationMs: null,
        initialStop: sl,
        currentStop: sl,
        takeProfitTarget: tp,
        trailingActivated: false,
        entrySignals: signal.signals,
        entryRegime: signal.regime as never,
        entryConfidence: signal.confidence,
        atrPercent: signal.signals.atr_percent as number,
        peakPrice: price,
        peakHistogram: 0,
        strategy: STRATEGY,
        decisionLog: [],
        createdAt: Date.now(),
      };

      insertTrade(trade);
      stats.tradesOpened++;
      console.log(
        `[SNIPER] Trade opened: ${ticker} @ $${price.toFixed(6)} `
        + `SL=$${sl.toFixed(6)} size=$${posSize.toFixed(2)} `
        + `age=${(signal.signals.sniper_age_hours as number).toFixed(1)}h `
        + `rug=${signal.signals.sniper_rug_score} `
        + `conf=${signal.confidence.toFixed(2)}`,
      );
      break;  // one new entry per loop
    }

    if (stats.loopCount % 10 === 0) {
      console.log(
        `[SNIPER] Loop #${stats.loopCount}: ${activeListings.length} listings tracked, `
        + `${currentSniper.length} open, opened=${stats.tradesOpened}, `
        + `closed=${stats.tradesClosed}, PnL=$${stats.totalPnl.toFixed(2)}`,
      );
    }
  } catch (err: unknown) {
    console.error(`[SNIPER] Loop error: ${(err as Error).message}`);
  } finally {
    loopInProgress = false;
  }
}

export async function initSniperEngine(adapter: ExchangeAdapter): Promise<void> {
  exchange = adapter;
  // Load the detector module dynamically. JS module → cast.
  try {
    detectorModule = (await import('../../services/newCoinDetector.js')) as unknown as Record<string, unknown>;
    const init = detectorModule.initialize as (() => void) | undefined;
    if (init) init();
    detector = {
      isNewListing: detectorModule.isNewListing as (t: string) => boolean,
      getActiveNewListings: detectorModule.getActiveNewListings as () => Array<{
        ticker: string;
        firstSeen: number;
        rugPullScore: number;
        isOnCooldown: boolean;
      }>,
    };
  } catch (err: unknown) {
    console.warn(`[SNIPER] Detector load failed — engine will idle: ${(err as Error).message}`);
    detector = null;
  }

  console.log(
    `[SNIPER] Sniper engine initialized: budget=$${SNIPER_CONFIG.BUDGET_USD}, `
    + `interval=${SNIPER_CONFIG.CANDLE_INTERVAL}, `
    + `age-window=${SNIPER_CONFIG.MIN_LISTING_AGE_MS / 60000}m-${SNIPER_CONFIG.MAX_LISTING_AGE_MS / 86400000}d, `
    + `max-positions=${SNIPER_CONFIG.MAX_OPEN_POSITIONS}, `
    + `detector=${detector ? 'loaded' : 'unavailable'}`,
  );
}

export function startSniperEngine(): void {
  if (isRunning) return;
  isRunning = true;

  // Kick off an initial pair refresh + loop after the offset, then schedule both intervals.
  setTimeout(async () => {
    await refreshKrakenPairList();
    await runLoop();
    loopTimer = setInterval(runLoop, SNIPER_CONFIG.LOOP_INTERVAL_MS);
    pairRefreshTimer = setInterval(refreshKrakenPairList, SNIPER_CONFIG.PAIR_REFRESH_INTERVAL_MS);
  }, SNIPER_CONFIG.LOOP_OFFSET_MS);

  console.log(
    `[SNIPER] Sniper engine started `
    + `(${SNIPER_CONFIG.LOOP_OFFSET_MS}ms offset, `
    + `${SNIPER_CONFIG.LOOP_INTERVAL_MS}ms loop, `
    + `${SNIPER_CONFIG.PAIR_REFRESH_INTERVAL_MS}ms pair-refresh)`,
  );
}

export function stopSniperEngine(): void {
  if (loopTimer) clearInterval(loopTimer);
  if (pairRefreshTimer) clearInterval(pairRefreshTimer);
  loopTimer = null;
  pairRefreshTimer = null;
  isRunning = false;
  console.log('[SNIPER] Sniper engine stopped');
}

export function getSniperStatus() {
  const listings = detector?.getActiveNewListings() ?? [];
  return {
    running: isRunning,
    enabled: SNIPER_CONFIG.ENABLED,
    detectorLoaded: detector != null,
    lastPairRefresh,
    activeListings: listings.length,
    listingsSample: listings.slice(0, 5).map(l => ({
      ticker: l.ticker,
      ageHours: ((Date.now() - l.firstSeen) / 3600000).toFixed(1),
      rugScore: l.rugPullScore,
      onCooldown: l.isOnCooldown,
    })),
    ...stats,
    openPositions: getOpenTradesByStrategy(STRATEGY).length,
    budget: SNIPER_CONFIG.BUDGET_USD,
  };
}
