import type { Candle, V2Trade } from '../pipeline/types.ts';
import { MR_CONFIG } from './config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { detectMeanReversionEntry } from '../pipeline/meanReversionSignal.ts';
import type { MRSignalResult } from '../pipeline/meanReversionSignal.ts';
import { checkMeanReversionExits } from '../pipeline/meanReversionExitManager.ts';
import {
  insertTrade,
  closeTrade,
  getOpenTradesByStrategy,
} from '../attribution/attributionStore.ts';
import { loadPortfolio } from './positionManager.ts';
import { analyzeClosedTrade } from '../attribution/postTradeAnalyzer.ts';
import { randomUUID } from 'node:crypto';

let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let loopInProgress = false;
let exchange: ExchangeAdapter | null = null;
let budget = 0;

const stats = {
  loopCount: 0,
  tradesOpened: 0,
  tradesClosed: 0,
  totalPnl: 0,
};
// Per-candle entry guard — see breakoutEngine.ts for context (dup-row bug 2026-05-25).
const lastTradedCandleTime = new Map<string, number>();

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  try {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const adapter = mod.krakenAdapter;
    const raw = await adapter.getCandles(ticker, MR_CONFIG.CANDLE_INTERVAL, 100);
    if (!raw || raw.length === 0) return null;
    return raw.map((c: any) => ({
      open: c.o ?? c.open,
      high: c.h ?? c.high,
      low: c.l ?? c.low,
      close: c.c ?? c.close,
      volume: c.v ?? c.volume ?? 0,
      time: c.t ?? c.time ?? 0,
    }));
  } catch { return null; }
}

async function runMRLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    // --- Check exits first ---
    const openMR = getOpenTradesByStrategy('MEAN_REVERSION');
    if (openMR.length > 0 && exchange) {
      const exitResults = await checkMeanReversionExits(openMR, exchange);
      for (const result of exitResults) {
        if (!result.shouldExit) continue;
        const t = result.trade;
        const holdMs = Date.now() - t.entryTime;
        const isShortTrade = t.side === 'short';
        const pnlGross = isShortTrade
          ? (t.entryPrice - result.exitPrice) * t.quantity
          : (result.exitPrice - t.entryPrice) * t.quantity;
        const fees = t.positionSizeUsd * MR_CONFIG.FEE_ROUND_TRIP;
        const pnlNet = pnlGross - fees;

        closeTrade(t.id, result.exitPrice, result.exitReason as any ?? 'unknown', fees);
        stats.tradesClosed++;
        stats.totalPnl += pnlNet;
        console.log(`[MR] Trade closed: ${t.ticker} @ $${result.exitPrice.toFixed(4)} reason=${result.exitReason} PnL=$${pnlNet.toFixed(4)}`);

        try { analyzeClosedTrade({ ...t, exitPrice: result.exitPrice, exitReason: result.exitReason, pnlNet, pnlGross, feesPaid: fees, holdDurationMs: holdMs }); } catch {}
      }
    }

    // --- Check entries ---
    const currentMR = getOpenTradesByStrategy('MEAN_REVERSION');
    if (currentMR.length >= MR_CONFIG.MAX_OPEN_POSITIONS) {
      if (stats.loopCount % 10 === 0) {
        console.log(`[MR] Loop #${stats.loopCount}: max positions (${currentMR.length}/${MR_CONFIG.MAX_OPEN_POSITIONS})`);
      }
      return;
    }

    const portfolio = loadPortfolio(budget, 'MEAN_REVERSION');
    let signalCount = 0;
    let rejectCount = 0;

    for (const ticker of MR_CONFIG.SCAN_TICKERS) {
      const candles = await fetchCandles(ticker);
      if (!candles || candles.length < MR_CONFIG.MIN_CANDLES) continue;

      const sigCandleTime = candles[candles.length - 1].time;
      if ((lastTradedCandleTime.get(ticker) ?? 0) >= sigCandleTime) continue;

      const signal = detectMeanReversionEntry(candles, ticker) as MRSignalResult | null;
      if (!signal) { rejectCount++; continue; }

      // Allow one long + one short per ticker simultaneously; block duplicates by direction
      if (currentMR.some(t => t.ticker === ticker && t.side === signal.side)) continue;
      signalCount++;

      const equity = portfolio.totalEquity;
      let posSize = equity * MR_CONFIG.POSITION_SIZE_PERCENT * signal.confidence;
      const maxPos = equity * MR_CONFIG.MAX_POSITION_PERCENT;
      if (posSize > maxPos) posSize = maxPos;
      if (posSize > portfolio.availableCapital) posSize = portfolio.availableCapital;
      if (posSize < 5) continue;

      const side = signal.side;
      const atrPct = signal.signals.atr_percent as number;
      const price0 = signal.signals.close_price as number;
      const ema0  = signal.signals.ema_12 as number;
      const atrDollar = price0 * atrPct / 100;

      // TP is EMA midline in both directions; TP% must be positive
      const tpPercent = side === 'short'
        ? (price0 - ema0) / price0   // short: ema is below price, we profit as price falls to ema
        : (ema0 - price0) / price0;  // long:  ema is above price, we profit as price rises to ema
      const expectedReturn = tpPercent - MR_CONFIG.FEE_ROUND_TRIP;
      if (expectedReturn < 0.001) continue;

      const price = price0;
      const qty = posSize / price;
      // SL: below entry for longs, above entry for shorts
      const sl = side === 'short'
        ? price + atrDollar * MR_CONFIG.STOP_LOSS_ATR_MULT
        : price - atrDollar * MR_CONFIG.STOP_LOSS_ATR_MULT;
      const tp = ema0; // EMA midline is the mean-reversion target in both directions

      const trade: V2Trade = {
        id: randomUUID(),
        ticker,
        side: side as any,
        status: 'open' as any,
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
        feesPaid: posSize * MR_CONFIG.FEE_ROUND_TRIP / 2,
        holdDurationMs: null,
        initialStop: sl,
        currentStop: sl,
        takeProfitTarget: tp,
        trailingActivated: false,
        entrySignals: signal.signals,
        entryRegime: signal.regime as any,
        entryConfidence: signal.confidence,
        atrPercent: atrPct,
        peakPrice: price,
        strategy: 'MEAN_REVERSION',
        decisionLog: [],
        createdAt: Date.now(),
      };

      insertTrade(trade);
      lastTradedCandleTime.set(ticker, sigCandleTime);
      stats.tradesOpened++;
      console.log(`[MR] Trade opened: ${ticker} ${side} @ $${price.toFixed(4)} qty=${qty.toFixed(6)} SL=$${sl.toFixed(4)} TP=$${tp.toFixed(4)} conf=${signal.confidence.toFixed(2)}`);
      break; // one entry per loop to avoid overloading
    }

    if (stats.loopCount <= 5 || stats.loopCount % 10 === 0 || signalCount > 0) {
      console.log(`[MR] Loop #${stats.loopCount}: ${signalCount} signals, ${rejectCount} rejected, ${currentMR.length} open, PnL=$${stats.totalPnl.toFixed(2)}`);
    }
  } catch (err: any) {
    console.error(`[MR] Loop error: ${err.message}`);
  } finally {
    loopInProgress = false;
  }
}

export function initMREngine(adapter: ExchangeAdapter, initialBudget: number): void {
  exchange = adapter;
  budget = initialBudget;
  console.log(`[MR] Mean Reversion engine initialized: budget=$${initialBudget}, interval=${MR_CONFIG.CANDLE_INTERVAL}, tickers=${MR_CONFIG.SCAN_TICKERS.length}`);
}

export function startMREngine(): void {
  if (isRunning) return;
  isRunning = true;
  setTimeout(() => {
    runMRLoop();
    loopTimer = setInterval(runMRLoop, MR_CONFIG.BOT_LOOP_INTERVAL_MS);
  }, MR_CONFIG.LOOP_OFFSET_MS);
  console.log('[MR] Mean Reversion engine started (30s offset from TREND loop)');
}

export function stopMREngine(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  isRunning = false;
  console.log('[MR] Mean Reversion engine stopped');
}

export function getMRStatus() {
  const openTrades = getOpenTradesByStrategy('MEAN_REVERSION');
  return {
    running: isRunning,
    loopCount: stats.loopCount,
    tradesOpened: stats.tradesOpened,
    tradesClosed: stats.tradesClosed,
    totalPnl: stats.totalPnl,
    openPositions: openTrades.length,
    config: {
      interval: MR_CONFIG.CANDLE_INTERVAL,
      tickers: MR_CONFIG.SCAN_TICKERS,
      rsiThreshold: MR_CONFIG.RSI_THRESHOLD,
      bbThreshold: MR_CONFIG.BB_PERCENT_B_THRESHOLD,
    },
  };
}
