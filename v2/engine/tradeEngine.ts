// ============================================
// Phoenix V2 Trade Engine Orchestrator
// Runs the full pipeline loop: scan → signal → risk → execute → exit
// ============================================

import type { Candle, V2Trade } from '../pipeline/types.ts';
import { V2_CONFIG } from './config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';

// Pipeline imports
import { scanMarket, getPassedTickers } from '../pipeline/marketScanner.ts';
import { generateSignals, getPassedSignals } from '../pipeline/signalGenerator.ts';
import { evaluateRisk, getApproved } from '../pipeline/riskGate.ts';
import { executeTrade } from '../pipeline/executor.ts';
import { checkExits } from '../pipeline/exitManager.ts';

// Attribution imports
import {
  initV2Tables,
  insertTrade,
  closeTrade,
  getOpenTrades,
  getClosedTrades,
} from '../attribution/attributionStore.ts';
import { analyzeClosedTrade } from '../attribution/postTradeAnalyzer.ts';

// Position management
import { loadPortfolio, getCircuitBreakerState } from './positionManager.ts';

// --- State ---

let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let exchange: ExchangeAdapter | null = null;
let budget = 0;

const stats = {
  lastLoopTime: 0,
  loopCount: 0,
  rejectedByScan: 0,
  rejectedBySignal: 0,
  rejectedByRisk: 0,
  lastScanReasons: [] as { ticker: string; reason: string }[],
  candleCounts: {} as Record<string, number>,
};

// --- Status Interface ---

export interface V2EngineStatus {
  mode: string;
  isRunning: boolean;
  lastLoopTime: number;
  lastScanReasons?: { ticker: string; reason: string }[];
  candleCounts?: Record<string, number>;
  loopCount: number;
  rejectedByScan: number;
  rejectedBySignal: number;
  rejectedByRisk: number;
  openPositions: number;
  totalTrades: number;
  portfolioCash: number;
  totalPnlNet: number;
}

// --- Telegram Helper ---

async function sendTelegram(message: string): Promise<void> {
  try {
    const tg = await import('../../services/telegramService.js');
    if (tg.isEnabled()) {
      tg.alertTradeExecution({
        type: 'INFO',
        ticker: '',
        price: 0,
        strategy: message,
      });
    }
  } catch {
    // Telegram not available — silent fail
  }
}

async function sendEntryAlert(trade: V2Trade): Promise<void> {
  try {
    const tg = await import('../../services/telegramService.js');
    if (tg.isEnabled()) {
      tg.alertTradeExecution({
        type: 'BUY',
        ticker: trade.ticker,
        price: trade.entryPrice,
        strategy: `${V2_CONFIG.TELEGRAM_TAG} ${trade.entryRegime} conf=${trade.entryConfidence.toFixed(2)}`,
      });
    }
  } catch {
    // Telegram not available
  }
}

async function sendExitAlert(trade: V2Trade, exitPrice: number, exitReason: string, pnlNet: number): Promise<void> {
  try {
    const tg = await import('../../services/telegramService.js');
    if (tg.isEnabled()) {
      tg.alertTradeExecution({
        type: 'SELL',
        ticker: trade.ticker,
        price: exitPrice,
        strategy: `${V2_CONFIG.TELEGRAM_TAG} ${exitReason}`,
        pnl: pnlNet,
      });
    }
  } catch {
    // Telegram not available
  }
}

// --- Candle Fetching ---

/** Normalize short-form {t,o,h,l,c,v} candles to V2's {time,open,high,low,close,volume} */
function normalizeCandles(raw: any[]): Candle[] {
  return raw.map((c: any) => ({
    time: c.time ?? c.t ?? 0,
    open: c.open ?? c.o ?? 0,
    high: c.high ?? c.h ?? 0,
    low: c.low ?? c.l ?? 0,
    close: c.close ?? c.c ?? 0,
    volume: c.volume ?? c.v ?? 0,
  }));
}

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  // Try WebSocket realtime candles first
  try {
    const wsModule = await import('../../services/krakenWebsocketService.js');
    const candles = wsModule.getRealtimeCandles(ticker);
    if (candles && candles.length >= V2_CONFIG.MIN_CANDLES) {
      return normalizeCandles(candles);
    }
  } catch {
    // WS not available
  }

  // Fallback: REST via Kraken adapter
  try {
    const adapterModule = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const adapter = adapterModule.krakenAdapter;
    const candles = await adapter.getCandles(ticker, '1', 200);
    if (candles && candles.length > 0) {
      return normalizeCandles(candles);
    }
  } catch {
    // REST failed
  }

  return null;
}

// --- Init / Start / Stop ---

/**
 * Initialize the V2 engine with an exchange adapter and initial budget.
 */
export function initV2Engine(adapter: ExchangeAdapter, initialBudget: number): void {
  exchange = adapter;
  budget = initialBudget;
  initV2Tables();
  console.log(`[V2] Engine initialized: mode=${V2_CONFIG.MODE}, budget=$${initialBudget}, exchange=${adapter.getName()}`);
}

/**
 * Start the bot loop. Runs immediately then on interval.
 */
export function startV2Engine(): void {
  if (isRunning) {
    console.log('[V2] Engine already running');
    return;
  }
  if (!exchange) {
    throw new Error('[V2] Engine not initialized — call initV2Engine() first');
  }

  isRunning = true;
  console.log(`[V2] Engine started, loop interval=${V2_CONFIG.BOT_LOOP_INTERVAL_MS}ms`);

  // Run immediately
  runLoop();

  // Then on interval
  loopTimer = setInterval(() => {
    runLoop();
  }, V2_CONFIG.BOT_LOOP_INTERVAL_MS);
}

/**
 * Stop the bot loop.
 */
export function stopV2Engine(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  isRunning = false;
  console.log('[V2] Engine stopped');
}

/**
 * Get current engine status snapshot.
 */
export function getV2Status(): V2EngineStatus {
  const openTrades = getOpenTrades();
  const closedTrades = getClosedTrades(1000);
  const totalPnlNet = closedTrades.reduce((sum, t) => sum + (t.pnlNet ?? 0), 0);

  return {
    mode: V2_CONFIG.MODE,
    isRunning,
    lastLoopTime: stats.lastLoopTime,
    loopCount: stats.loopCount,
    rejectedByScan: stats.rejectedByScan,
    rejectedBySignal: stats.rejectedBySignal,
    rejectedByRisk: stats.rejectedByRisk,
    openPositions: openTrades.length,
    totalTrades: closedTrades.length + openTrades.length,
    portfolioCash: budget + totalPnlNet,
    totalPnlNet,
    lastScanReasons: stats.lastScanReasons,
    candleCounts: stats.candleCounts,
  };
}

// --- Main Loop ---

async function runLoop(): Promise<void> {
  if (!exchange) return;

  const loopStart = Date.now();
  stats.loopCount++;

  try {
    // ==============================
    // Stage 0: Fetch candles
    // ==============================
    const tickerCandles = new Map<string, Candle[]>();

    // Fetch candles in parallel for all tickers (much faster than sequential)
    const fetchResults = await Promise.allSettled(
      V2_CONFIG.SCAN_TICKERS.map(async (ticker) => {
        const candles = await fetchCandles(ticker);
        return { ticker, candles };
      }),
    );

    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value.candles) {
        tickerCandles.set(result.value.ticker, result.value.candles);
      }
    }

    if (tickerCandles.size === 0) {
      console.log('[V2] No candle data available, skipping loop');
      stats.lastLoopTime = Date.now() - loopStart;
      return;
    }

    // Track candle counts for diagnostics
    stats.candleCounts = {};
    for (const [ticker, candles] of tickerCandles) {
      stats.candleCounts[ticker] = candles.length;
    }

    // ==============================
    // Stage 1: Market Scan
    // ==============================
    const scanResults = scanMarket(tickerCandles);
    const passedScan = getPassedTickers(scanResults);
    const scanRejections = scanResults.length - passedScan.length;
    stats.rejectedByScan += scanRejections;
    stats.lastScanReasons = scanResults.map(r => ({ ticker: r.ticker, reason: r.reason || (r.passed ? 'PASS' : 'UNKNOWN') }));

    if (passedScan.length === 0) {
      // Log rejection reasons every 10 loops for diagnostics
      if (stats.loopCount % 10 === 1) {
        for (const r of scanResults) {
          console.log(`[V2] REJECT ${r.ticker}: ${r.reason}`);
        }
      }
      console.log(`[V2] Loop #${stats.loopCount}: scan rejected all ${scanResults.length} tickers`);
      stats.lastLoopTime = Date.now() - loopStart;
      // Still check exits
      await checkOpenExits();
      return;
    }

    // ==============================
    // Stage 2: Signal Generation
    // ==============================
    const signalResults = generateSignals(passedScan, tickerCandles);
    const passedSignals = getPassedSignals(signalResults);
    const signalRejections = signalResults.length - passedSignals.length;
    stats.rejectedBySignal += signalRejections;

    if (passedSignals.length === 0) {
      console.log(`[V2] Loop #${stats.loopCount}: signal rejected all ${signalResults.length} candidates`);
      stats.lastLoopTime = Date.now() - loopStart;
      await checkOpenExits();
      return;
    }

    // ==============================
    // Stage 3: Risk Gate
    // ==============================
    const portfolio = loadPortfolio(budget);
    const cbState = getCircuitBreakerState(portfolio);
    const riskResults = evaluateRisk(passedSignals, portfolio, cbState);
    const approved = getApproved(riskResults);
    const riskRejections = riskResults.length - approved.length;
    stats.rejectedByRisk += riskRejections;

    // ==============================
    // Stage 4: Execute best approved trade
    // ==============================
    if (approved.length > 0) {
      // Take the best (first, since signals are sorted by score)
      const bestRisk = approved[0];
      const bestSignal = passedSignals.find((s) => s.ticker === bestRisk.ticker);

      if (bestSignal) {
        console.log(`[V2] Loop #${stats.loopCount}: executing ${bestSignal.ticker} score=${bestSignal.compositeScore.toFixed(1)} size=$${bestRisk.positionSizeUsd.toFixed(2)}`);

        const { trade, decision } = await executeTrade(
          bestSignal,
          bestRisk,
          exchange,
          [], // previous decisions
        );

        if (trade) {
          insertTrade(trade);
          console.log(`[V2] Trade opened: ${trade.ticker} @ $${trade.entryPrice.toFixed(2)} qty=${trade.quantity.toFixed(6)}`);
          await sendEntryAlert(trade);
        } else {
          console.log(`[V2] Trade execution failed: ${decision.reason}`);
        }
      }
    } else {
      console.log(`[V2] Loop #${stats.loopCount}: risk rejected all ${riskResults.length} signals (${passedScan.length} scanned, ${passedSignals.length} signaled)`);
    }

    // ==============================
    // Stage 5: Check exits
    // ==============================
    await checkOpenExits();

    stats.lastLoopTime = Date.now() - loopStart;
    console.log(`[V2] Loop #${stats.loopCount} completed in ${stats.lastLoopTime}ms`);
  } catch (e) {
    console.error(`[V2] Loop error: ${(e as Error).message}`);
    stats.lastLoopTime = Date.now() - loopStart;
  }
}

// --- Exit Check Helper ---

async function checkOpenExits(): Promise<void> {
  if (!exchange) return;

  const openTrades = getOpenTrades();
  if (openTrades.length === 0) return;

  try {
    const exitResults = await checkExits(openTrades, exchange);

    for (const result of exitResults) {
      if (!result.shouldExit || !result.exitReason) continue;

      const trade = result.trade;

      // Calculate fees: both entry and exit sides
      const entryFee = trade.feesPaid; // already paid at entry
      let exitFee: number;
      if (result.exitReason === 'take_profit' || result.exitReason === 'trailing') {
        // Could use maker for planned exits
        exitFee = result.exitPrice * trade.quantity * V2_CONFIG.FEE_MAKER_PERCENT;
      } else {
        // Stop loss / time kill = taker
        exitFee = result.exitPrice * trade.quantity * V2_CONFIG.FEE_TAKER_PERCENT;
      }
      const totalFees = entryFee + exitFee;

      // In live mode, actually sell
      if (V2_CONFIG.MODE === 'live') {
        try {
          await exchange.placeMarketSell(trade.ticker, trade.quantity);
        } catch (e) {
          console.error(`[V2] Failed to place market sell for ${trade.ticker}: ${(e as Error).message}`);
          continue;
        }
      }

      // Close in DB
      closeTrade(trade.id, result.exitPrice, result.exitReason, totalFees);

      // Analyze for signal scoring
      const closedTrade = {
        ...trade,
        exitPrice: result.exitPrice,
        exitTime: Date.now(),
        exitReason: result.exitReason,
        pnlGross: (result.exitPrice - trade.entryPrice) * trade.quantity,
        pnlNet: (result.exitPrice - trade.entryPrice) * trade.quantity - totalFees,
        feesPaid: totalFees,
        holdDurationMs: Date.now() - trade.entryTime,
        status: 'closed' as const,
      };
      analyzeClosedTrade(closedTrade);

      const pnlNet = closedTrade.pnlNet;
      console.log(`[V2] Trade closed: ${trade.ticker} @ $${result.exitPrice.toFixed(2)} reason=${result.exitReason} PnL=$${pnlNet.toFixed(2)}`);
      await sendExitAlert(trade, result.exitPrice, result.exitReason, pnlNet);
    }
  } catch (e) {
    console.error(`[V2] Exit check error: ${(e as Error).message}`);
  }
}
