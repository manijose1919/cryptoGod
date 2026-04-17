import type { Candle, V2Trade } from '../pipeline/types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { detectMomentumEntry } from '../pipeline/momentumSignal.ts';
import { checkMomentumExits } from '../pipeline/momentumExitManager.ts';
import { insertTrade, closeTrade, getOpenTradesByStrategy } from '../attribution/attributionStore.ts';
import { loadPortfolio } from './positionManager.ts';
import { randomUUID } from 'node:crypto';

const MOM_CONFIG = {
  SCAN_TICKERS: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'],
  CANDLE_INTERVAL: '1h',
  MAX_OPEN_POSITIONS: 2,
  POSITION_SIZE_PERCENT: 0.20,
  MAX_POSITION_PERCENT: 0.30,
  FEE_ROUND_TRIP: 0.0032,
  SL_ATR_MULT: 2.0,
  LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 15_000,
};

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
    const raw = await mod.krakenAdapter.getCandles(ticker, MOM_CONFIG.CANDLE_INTERVAL, 100);
    if (!raw || raw.length === 0) return null;
    const candles = raw.map((c: any) => ({ open: c.o ?? c.open, high: c.h ?? c.high, low: c.l ?? c.low, close: c.c ?? c.close, volume: c.v ?? c.volume ?? 0, time: c.t ?? c.time ?? 0 }));
    candleCache.set(ticker, candles);
    return candles;
  } catch { return null; }
}

async function runLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    // Refresh candle cache for exit histogram checks
    for (const ticker of MOM_CONFIG.SCAN_TICKERS) {
      await fetchCandles(ticker);
    }

    const openMOM = getOpenTradesByStrategy(STRATEGY);
    if (openMOM.length > 0 && exchange) {
      const exitResults = await checkMomentumExits(openMOM, exchange, candleCache);
      for (const r of exitResults) {
        if (!r.shouldExit) continue;
        const t = r.trade;
        const pnlGross = (r.exitPrice - t.entryPrice) * t.quantity;
        const fees = t.positionSizeUsd * MOM_CONFIG.FEE_ROUND_TRIP;
        const pnlNet = pnlGross - fees;
        closeTrade(t.id, r.exitPrice, r.exitReason as any ?? 'unknown', fees);
        stats.tradesClosed++;
        stats.totalPnl += pnlNet;
        console.log(`[MOM] Trade closed: ${t.ticker} @ $${r.exitPrice.toFixed(2)} reason=${r.exitReason} PnL=$${pnlNet.toFixed(4)}`);
      }
    }

    const currentMOM = getOpenTradesByStrategy(STRATEGY);
    if (currentMOM.length >= MOM_CONFIG.MAX_OPEN_POSITIONS) {
      if (stats.loopCount % 10 === 0) console.log(`[MOM] Loop #${stats.loopCount}: max positions`);
      return;
    }

    const portfolio = loadPortfolio(budget);

    for (const ticker of MOM_CONFIG.SCAN_TICKERS) {
      if (currentMOM.some(t => t.ticker === ticker)) continue;
      const candles = candleCache.get(ticker);
      if (!candles || candles.length < 50) continue;

      const signal = detectMomentumEntry(candles, ticker);
      if (!signal) continue;

      const equity = portfolio.totalEquity;
      let posSize = equity * MOM_CONFIG.POSITION_SIZE_PERCENT * signal.confidence;
      if (posSize > equity * MOM_CONFIG.MAX_POSITION_PERCENT) posSize = equity * MOM_CONFIG.MAX_POSITION_PERCENT;
      if (posSize > portfolio.availableCapital) posSize = portfolio.availableCapital;
      if (posSize < 5) continue;

      const price = signal.signals.close_price as number;
      const atrPct = signal.signals.atr_percent as number;
      const atrDollar = price * atrPct / 100;
      const sl = price - atrDollar * MOM_CONFIG.SL_ATR_MULT;
      const macdHist = signal.signals.macd_histogram as number;
      const qty = posSize / price;

      const trade: V2Trade = {
        id: randomUUID(), ticker, side: 'long', status: 'open' as any,
        entryPrice: price, entryTime: Date.now(), entryOrderType: 'maker',
        quantity: qty, positionSizeUsd: posSize,
        exitPrice: null, exitTime: null, exitReason: null,
        pnlGross: null, pnlNet: null, feesPaid: posSize * MOM_CONFIG.FEE_ROUND_TRIP / 2,
        holdDurationMs: null, initialStop: sl, currentStop: sl,
        takeProfitTarget: 0, trailingActivated: false,
        entrySignals: signal.signals, entryRegime: signal.regime as any,
        entryConfidence: signal.confidence, atrPercent: atrPct,
        peakPrice: price, peakHistogram: macdHist,
        strategy: STRATEGY, decisionLog: [], createdAt: Date.now(),
      };

      insertTrade(trade);
      stats.tradesOpened++;
      console.log(`[MOM] Trade opened: ${ticker} @ $${price.toFixed(2)} SL=$${sl.toFixed(2)} hist=${macdHist.toFixed(6)} conf=${signal.confidence.toFixed(2)}`);
      break;
    }

    if (stats.loopCount % 10 === 0) console.log(`[MOM] Loop #${stats.loopCount}: ${currentMOM.length} open, PnL=$${stats.totalPnl.toFixed(2)}`);
  } catch (err: any) {
    console.error(`[MOM] Loop error: ${err.message}`);
  } finally {
    loopInProgress = false;
  }
}

export function initMomentumEngine(adapter: ExchangeAdapter, initialBudget: number): void {
  exchange = adapter; budget = initialBudget;
  console.log(`[MOM] Momentum engine initialized: budget=$${initialBudget}, interval=${MOM_CONFIG.CANDLE_INTERVAL}`);
}

export function startMomentumEngine(): void {
  if (isRunning) return;
  isRunning = true;
  setTimeout(() => { runLoop(); loopTimer = setInterval(runLoop, MOM_CONFIG.LOOP_INTERVAL_MS); }, MOM_CONFIG.LOOP_OFFSET_MS);
  console.log('[MOM] Momentum engine started (15s offset)');
}

export function stopMomentumEngine(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null; isRunning = false;
  console.log('[MOM] Momentum engine stopped');
}

export function getMomentumStatus() {
  return { running: isRunning, ...stats, openPositions: getOpenTradesByStrategy(STRATEGY).length };
}
