import type { Candle, V2Trade } from '../pipeline/types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { detectBreakoutEntry } from '../pipeline/breakoutSignal.ts';
import { checkBreakoutExits } from '../pipeline/breakoutExitManager.ts';
import { insertTrade, closeTrade, getOpenTradesByStrategy } from '../attribution/attributionStore.ts';
import { loadPortfolio } from './positionManager.ts';
import { randomUUID } from 'node:crypto';

const BO_CONFIG = {
  SCAN_TICKERS: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'],
  CANDLE_INTERVAL: '1h',
  MAX_OPEN_POSITIONS: 2,
  POSITION_SIZE_PERCENT: 0.20,
  MAX_POSITION_PERCENT: 0.30,
  FEE_ROUND_TRIP: 0.0032,
  SL_ATR_MULT: 0, // SL at breakout level (set in entry)
  TP_ATR_MULT: 3.0,
  LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 45_000,
};

const STRATEGY = 'BREAKOUT';
let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let loopInProgress = false;
let exchange: ExchangeAdapter | null = null;
let budget = 0;
const stats = { loopCount: 0, tradesOpened: 0, tradesClosed: 0, totalPnl: 0 };

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  try {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const raw = await mod.krakenAdapter.getCandles(ticker, BO_CONFIG.CANDLE_INTERVAL, 100);
    if (!raw || raw.length === 0) return null;
    return raw.map((c: any) => ({ open: c.o ?? c.open, high: c.h ?? c.high, low: c.l ?? c.low, close: c.c ?? c.close, volume: c.v ?? c.volume ?? 0, time: c.t ?? c.time ?? 0 }));
  } catch { return null; }
}

async function runLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    const openBO = getOpenTradesByStrategy(STRATEGY);
    if (openBO.length > 0 && exchange) {
      const exitResults = await checkBreakoutExits(openBO, exchange);
      for (const r of exitResults) {
        if (!r.shouldExit) continue;
        const t = r.trade;
        const pnlGross = (r.exitPrice - t.entryPrice) * t.quantity;
        const fees = t.positionSizeUsd * BO_CONFIG.FEE_ROUND_TRIP;
        const pnlNet = pnlGross - fees;
        closeTrade(t.id, r.exitPrice, r.exitReason as any ?? 'unknown', fees);
        stats.tradesClosed++;
        stats.totalPnl += pnlNet;
        console.log(`[BO] Trade closed: ${t.ticker} @ $${r.exitPrice.toFixed(2)} reason=${r.exitReason} PnL=$${pnlNet.toFixed(4)}`);
      }
    }

    const currentBO = getOpenTradesByStrategy(STRATEGY);
    if (currentBO.length >= BO_CONFIG.MAX_OPEN_POSITIONS) {
      if (stats.loopCount % 10 === 0) console.log(`[BO] Loop #${stats.loopCount}: max positions (${currentBO.length}/${BO_CONFIG.MAX_OPEN_POSITIONS})`);
      return;
    }

    const portfolio = loadPortfolio(budget, 'BREAKOUT');

    for (const ticker of BO_CONFIG.SCAN_TICKERS) {
      if (currentBO.some(t => t.ticker === ticker)) continue;
      const candles = await fetchCandles(ticker);
      if (!candles || candles.length < 50) continue;

      const signal = detectBreakoutEntry(candles, ticker);
      if (!signal) continue;

      const equity = portfolio.totalEquity;
      let posSize = equity * BO_CONFIG.POSITION_SIZE_PERCENT * signal.confidence;
      if (posSize > equity * BO_CONFIG.MAX_POSITION_PERCENT) posSize = equity * BO_CONFIG.MAX_POSITION_PERCENT;
      if (posSize > portfolio.availableCapital) posSize = portfolio.availableCapital;
      if (posSize < 5) continue;

      const price = signal.signals.close_price as number;
      const atrPct = signal.signals.atr_percent as number;
      const atrDollar = price * atrPct / 100;
      const lookbackCandles = candles.slice(-31, -1);
      const nBarHigh = Math.max(...lookbackCandles.map(c => c.high));
      const sl = nBarHigh - atrDollar * 0.5;
      const tp = price + atrDollar * BO_CONFIG.TP_ATR_MULT;
      const qty = posSize / price;

      const trade: V2Trade = {
        id: randomUUID(), ticker, side: 'long', status: 'open' as any,
        entryPrice: price, entryTime: Date.now(), entryOrderType: 'maker',
        quantity: qty, positionSizeUsd: posSize,
        exitPrice: null, exitTime: null, exitReason: null,
        pnlGross: null, pnlNet: null, feesPaid: posSize * BO_CONFIG.FEE_ROUND_TRIP / 2,
        holdDurationMs: null, initialStop: sl, currentStop: sl,
        takeProfitTarget: tp, trailingActivated: false,
        entrySignals: signal.signals, entryRegime: signal.regime as any,
        entryConfidence: signal.confidence, atrPercent: atrPct,
        peakPrice: price, strategy: STRATEGY, decisionLog: [], createdAt: Date.now(),
      };

      insertTrade(trade);
      stats.tradesOpened++;
      console.log(`[BO] Trade opened: ${ticker} @ $${price.toFixed(2)} SL=$${sl.toFixed(2)} TP=$${tp.toFixed(2)} conf=${signal.confidence.toFixed(2)}`);
      break;
    }

    if (stats.loopCount % 10 === 0) console.log(`[BO] Loop #${stats.loopCount}: ${currentBO.length} open, PnL=$${stats.totalPnl.toFixed(2)}`);
  } catch (err: any) {
    console.error(`[BO] Loop error: ${err.message}`);
  } finally {
    loopInProgress = false;
  }
}

export function initBreakoutEngine(adapter: ExchangeAdapter, initialBudget: number): void {
  exchange = adapter; budget = initialBudget;
  console.log(`[BO] Breakout engine initialized: budget=$${initialBudget}, interval=${BO_CONFIG.CANDLE_INTERVAL}`);
}

export function startBreakoutEngine(): void {
  if (isRunning) return;
  isRunning = true;
  setTimeout(() => { runLoop(); loopTimer = setInterval(runLoop, BO_CONFIG.LOOP_INTERVAL_MS); }, BO_CONFIG.LOOP_OFFSET_MS);
  console.log('[BO] Breakout engine started (45s offset)');
}

export function stopBreakoutEngine(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null; isRunning = false;
  console.log('[BO] Breakout engine stopped');
}

export function getBreakoutStatus() {
  return { running: isRunning, ...stats, openPositions: getOpenTradesByStrategy(STRATEGY).length };
}
