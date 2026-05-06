// ============================================
// MOMENTUM Engine v2 (rebuilt 2026-05-06)
// ============================================
// Backtest-validated config (PF 1.70-2.32 across 30/60/90d) on 7 specific
// tickers (ZEC, RUNE, FLOW, ENA, KAS, ICP, WIF). Uses the v2 entry logic in
// momentumSignal.ts and v2 exit logic in momentumExitManager.ts.
//
// Lifecycle:
//   * Engine ENABLED gate lives in MOMENTUM_CONFIG.ENABLED — v2/index.ts
//     boots only when enabled.
//   * Loop: every 60s, refresh candles → check exits → look for entries.
// ============================================

import type { Candle, V2Trade } from '../pipeline/types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { detectMomentumEntry } from '../pipeline/momentumSignal.ts';
import { checkMomentumExits } from '../pipeline/momentumExitManager.ts';
import { insertTrade, closeTrade, getOpenTradesByStrategy } from '../attribution/attributionStore.ts';
import { loadPortfolio } from './positionManager.ts';
import { MOMENTUM_CONFIG, MOM_EXIT_CONFIG, getExchangeFees } from './config.ts';
import { randomUUID } from 'node:crypto';

const STRATEGY = 'MOMENTUM';
let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let loopInProgress = false;
let exchange: ExchangeAdapter | null = null;
let budget = 0;
const stats = { loopCount: 0, tradesOpened: 0, tradesClosed: 0, totalPnl: 0 };
const candleCache = new Map<string, Candle[]>();

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  try {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    // 4h candles, 100 bars = ~16 days of history (enough for the 50-bar minimum
    // plus headroom for the macd histogram series we recompute in the signal).
    const raw = await mod.krakenAdapter.getCandles(ticker, MOMENTUM_CONFIG.CANDLE_INTERVAL, 100);
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

async function runLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    // Refresh candle cache for entry detection + exit-time peak tracking
    for (const ticker of MOMENTUM_CONFIG.SCAN_TICKERS) {
      await fetchCandles(ticker);
    }

    // ----- exits first -----
    const openMOM = getOpenTradesByStrategy(STRATEGY);
    if (openMOM.length > 0 && exchange) {
      const exitResults = await checkMomentumExits(openMOM, exchange);
      const fees = getExchangeFees(exchange.getName());
      for (const r of exitResults) {
        if (!r.shouldExit) continue;
        const t = r.trade;
        const pnlGross = (r.exitPrice - t.entryPrice) * t.quantity;
        // Use exchange-aware ROUND_TRIP_REAL (maker entry + taker exit) — same
        // pattern as TREND's tradeEngine.ts post-Wave-2 fix (commit 8c58d3d).
        const totalFees = t.positionSizeUsd * fees.ROUND_TRIP_REAL;
        const pnlNet = pnlGross - totalFees;
        closeTrade(t.id, r.exitPrice, r.exitReason as never ?? 'unknown', totalFees);
        stats.tradesClosed++;
        stats.totalPnl += pnlNet;
        console.log(`[MOM] Trade closed: ${t.ticker} @ $${r.exitPrice.toFixed(4)} reason=${r.exitReason} PnL=$${pnlNet.toFixed(4)}`);
      }
    }

    // ----- entry search -----
    const currentMOM = getOpenTradesByStrategy(STRATEGY);
    if (currentMOM.length >= MOMENTUM_CONFIG.MAX_OPEN_POSITIONS) {
      if (stats.loopCount % 10 === 0) {
        console.log(`[MOM] Loop #${stats.loopCount}: max positions (${currentMOM.length})`);
      }
      return;
    }

    const portfolio = loadPortfolio(budget, 'MOMENTUM');

    for (const ticker of MOMENTUM_CONFIG.SCAN_TICKERS) {
      // Skip if we're already holding this ticker
      if (currentMOM.some(t => t.ticker === ticker)) continue;

      const candles = candleCache.get(ticker);
      if (!candles || candles.length < MOMENTUM_CONFIG.MIN_CANDLES) continue;

      const signal = detectMomentumEntry(candles, ticker);
      if (!signal) continue;

      const equity = portfolio.totalEquity;
      let posSize = equity * MOMENTUM_CONFIG.POSITION_SIZE_PERCENT * signal.confidence;
      if (posSize > equity * MOMENTUM_CONFIG.MAX_POSITION_PERCENT) {
        posSize = equity * MOMENTUM_CONFIG.MAX_POSITION_PERCENT;
      }
      if (posSize > portfolio.availableCapital) posSize = portfolio.availableCapital;
      if (posSize < 5) continue;

      const price = signal.signals.close_price as number;
      const atrPct = signal.signals.atr_percent as number;
      const atrDollar = price * atrPct / 100;

      // Stop: prefer swing-low (computed in signal). Fall back to ATR-based
      // if signal didn't expose it (defensive — shouldn't happen with v2 signal).
      const swingLow = signal.signals.mom_swing_low as number | undefined;
      let sl: number;
      if (swingLow != null && swingLow > 0 && swingLow < price) {
        // Signal returns the bare swing-low; pull it ~0.2 ATR below for safety,
        // matching the v2 backtest detector's `swingLow - atr * 0.2`.
        sl = Math.min(swingLow - atrDollar * 0.2, price - atrDollar * 1.5);
      } else {
        sl = price - atrDollar * MOM_EXIT_CONFIG.SL_ATR_MULT;
      }
      if (sl >= price) continue; // sanity

      // Take-profit: 3× ATR target (per MOM_EXIT.TP_ATR_MULT)
      const tp = price + atrDollar * MOM_EXIT_CONFIG.TP_ATR_MULT;

      const macdHist = signal.signals.macd_histogram as number;
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
        atrPercent: atrPct,
        peakPrice: price,
        peakHistogram: macdHist,
        strategy: STRATEGY,
        decisionLog: [],
        createdAt: Date.now(),
      };

      insertTrade(trade);
      stats.tradesOpened++;
      console.log(`[MOM] Trade opened: ${ticker} @ $${price.toFixed(4)} SL=$${sl.toFixed(4)} TP=$${tp.toFixed(4)} z=${(signal.signals.mom_z_score as number ?? 0).toFixed(1)} conf=${signal.confidence.toFixed(2)}`);
      break; // only one new entry per loop
    }

    if (stats.loopCount % 10 === 0) {
      console.log(`[MOM] Loop #${stats.loopCount}: ${currentMOM.length} open, opened=${stats.tradesOpened}, closed=${stats.tradesClosed}, PnL=$${stats.totalPnl.toFixed(2)}`);
    }
  } catch (err: unknown) {
    console.error(`[MOM] Loop error: ${(err as Error).message}`);
  } finally {
    loopInProgress = false;
  }
}

export function initMomentumEngine(adapter: ExchangeAdapter, initialBudget: number): void {
  exchange = adapter;
  budget = initialBudget;
  console.log(
    `[MOM] Momentum engine v2 initialized: budget=$${initialBudget}, `
    + `tickers=[${MOMENTUM_CONFIG.SCAN_TICKERS.join(',')}], `
    + `interval=${MOMENTUM_CONFIG.CANDLE_INTERVAL}, `
    + `z-thresh=${MOMENTUM_CONFIG.HISTOGRAM_SPIKE_Z}`,
  );
}

export function startMomentumEngine(): void {
  if (isRunning) return;
  isRunning = true;
  setTimeout(() => {
    runLoop();
    loopTimer = setInterval(runLoop, MOMENTUM_CONFIG.LOOP_INTERVAL_MS);
  }, MOMENTUM_CONFIG.LOOP_OFFSET_MS);
  console.log(`[MOM] Momentum engine v2 started (${MOMENTUM_CONFIG.LOOP_OFFSET_MS}ms offset, ${MOMENTUM_CONFIG.LOOP_INTERVAL_MS}ms interval)`);
}

export function stopMomentumEngine(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  isRunning = false;
  console.log('[MOM] Momentum engine stopped');
}

export function getMomentumStatus() {
  return {
    running: isRunning,
    enabled: MOMENTUM_CONFIG.ENABLED,
    tickers: [...MOMENTUM_CONFIG.SCAN_TICKERS],
    ...stats,
    openPositions: getOpenTradesByStrategy(STRATEGY).length,
  };
}
