// ============================================
// Dual Exchange Engine — Kraken vs Crypto.com Paper Trading Competition
//
// Runs two independent V2 pipeline instances side-by-side,
// each with its own portfolio, trade history, and exchange adapter.
// Both use the same TC + S/R + Dashboard signals from the PineScript port.
// Compare performance to find which exchange is better for your setup.
// ============================================

import type { Candle, V2Trade, SignalResult, RiskResult } from '../pipeline/types.ts';
import { V2_CONFIG, DUAL_ENGINE_CONFIG, EXCHANGE_FEES } from './config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';

// Pipeline imports
import { scanMarket, getPassedTickers } from '../pipeline/marketScanner.ts';
import { generateSignals, getPassedSignals } from '../pipeline/signalGenerator.ts';
import { evaluateRisk, getApproved } from '../pipeline/riskGate.ts';
import { checkExits } from '../pipeline/exitManager.ts';

// Attribution (shared DB, but trades tagged by exchange)
import { initV2Tables } from '../attribution/attributionStore.ts';

// --- Types ---

interface EngineInstance {
  name: string;
  adapter: ExchangeAdapter;
  budget: number;
  fees: { TAKER_PERCENT: number; MAKER_PERCENT: number; ROUND_TRIP_TAKER: number; ROUND_TRIP_MAKER: number };
  openTrades: Map<string, V2Trade>;
  closedTrades: V2Trade[];
  stats: {
    loopCount: number;
    totalPnl: number;
    winCount: number;
    lossCount: number;
    totalTrades: number;
    rejectedByScan: number;
    rejectedBySignal: number;
    rejectedByRisk: number;
  };
}

export interface DualEngineStatus {
  isRunning: boolean;
  loopCount: number;
  engines: {
    name: string;
    budget: number;
    currentCash: number;
    totalPnl: number;
    openPositions: number;
    totalTrades: number;
    winCount: number;
    lossCount: number;
    winRate: string;
    feesType: string;
  }[];
  comparison: {
    leader: string;
    pnlDifference: number;
    winRateDifference: string;
  };
}

// --- State ---

let engines: EngineInstance[] = [];
let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let globalLoopCount = 0;

// --- Candle Fetching (exchange-specific) ---

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

async function fetchCandlesForExchange(
  ticker: string,
  exchangeName: string,
): Promise<Candle[] | null> {
  const interval = V2_CONFIG.CANDLE_INTERVAL;

  try {
    if (exchangeName === 'kraken') {
      // Try WebSocket first for 1m
      if (interval === '1m') {
        try {
          const wsModule = await import('../../services/krakenWebsocketService.js');
          const candles = wsModule.getRealtimeCandles(ticker);
          if (candles && candles.length >= V2_CONFIG.MIN_CANDLES) {
            return normalizeCandles(candles);
          }
        } catch { /* WS not available */ }
      }
      // REST fallback
      const adapterModule = await import('../../services/exchangeAdapters/krakenAdapter.js');
      const adapter = adapterModule.krakenAdapter;
      const candles = await adapter.getCandles(ticker, interval, 200);
      if (candles && candles.length > 0) return normalizeCandles(candles);
    } else if (exchangeName === 'crypto.com') {
      // Try WebSocket first for 1m
      if (interval === '1m') {
        try {
          const wsModule = await import('../../services/websocketService.js');
          const candles = wsModule.getRealtimeCandles(ticker);
          if (candles && candles.length >= V2_CONFIG.MIN_CANDLES) {
            return normalizeCandles(candles);
          }
        } catch { /* WS not available */ }
      }
      // REST fallback
      const adapterModule = await import('../../services/exchangeAdapters/cryptocomAdapter.js');
      const adapter = adapterModule.cryptoComAdapter;
      // Crypto.com uses different timeframe format
      const tfMap: Record<string, string> = {
        '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1D',
      };
      const candles = await adapter.getCandles(ticker, tfMap[interval] || interval, 200);
      if (candles && candles.length > 0) return normalizeCandles(candles);
    }
  } catch (e) {
    // Silently fail — other exchange may still work
  }

  return null;
}

// --- Paper Trade Execution (simulated) ---

function generateTradeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function simulateEntry(
  engine: EngineInstance,
  signal: SignalResult,
  risk: RiskResult,
): V2Trade | null {
  const price = signal.signals.close_price as number;
  if (!price || price <= 0) return null;

  const entryFee = price * risk.quantity * engine.fees.MAKER_PERCENT;

  const trade: V2Trade = {
    id: generateTradeId(),
    ticker: signal.ticker,
    side: 'long',
    status: 'open',
    entryPrice: price,
    entryTime: Date.now(),
    entryOrderType: 'maker',
    quantity: risk.quantity,
    positionSizeUsd: risk.positionSizeUsd,
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    pnlGross: null,
    pnlNet: null,
    feesPaid: entryFee,
    holdDurationMs: null,
    initialStop: risk.stopLoss,
    currentStop: risk.stopLoss,
    takeProfitTarget: risk.takeProfit,
    trailingActivated: false,
    entrySignals: signal.signals,
    entryRegime: signal.regime,
    entryConfidence: signal.confidence,
    atrPercent: signal.signals.atr_percent as number,
    decisionLog: [],
    createdAt: Date.now(),
  };

  engine.openTrades.set(trade.id, trade);
  // H6: do NOT deduct entryFee from budget here. The entry fee is accounted
  // for in pnlNet on close (totalFees = entryFee + exitFee). The previous
  // code subtracted it here AND included it in totalFees on close, so equity
  // (= budget + totalPnl) double-counted entry fees. Now: budget is unchanged
  // at entry; close-time pnlNet captures both legs of the fee.
  engine.stats.totalTrades++;

  return trade;
}

// --- Portfolio Loading for Risk Gate ---

function buildPortfolioForEngine(engine: EngineInstance) {
  return {
    openPositions: engine.openTrades,
    totalEquity: engine.budget + engine.stats.totalPnl,
    availableCapital: engine.budget + engine.stats.totalPnl - Array.from(engine.openTrades.values()).reduce((sum, t) => sum + t.positionSizeUsd, 0),
    dailyPnl: engine.stats.totalPnl,
    dailyTradeCount: engine.stats.totalTrades,
    circuitBreakerActive: false,
    circuitBreakerUntil: null,
  };
}

// --- Init / Start / Stop ---

/**
 * Initialize dual engine with both exchange adapters.
 */
export function initDualEngine(
  krakenAdapter: ExchangeAdapter,
  cryptoComAdapter: ExchangeAdapter,
): void {
  initV2Tables();

  engines = [
    {
      name: 'kraken',
      adapter: krakenAdapter,
      budget: DUAL_ENGINE_CONFIG.BUDGET_PER_ENGINE,
      fees: EXCHANGE_FEES.kraken,
      openTrades: new Map(),
      closedTrades: [],
      stats: { loopCount: 0, totalPnl: 0, winCount: 0, lossCount: 0, totalTrades: 0, rejectedByScan: 0, rejectedBySignal: 0, rejectedByRisk: 0 },
    },
    {
      name: 'crypto.com',
      adapter: cryptoComAdapter,
      budget: DUAL_ENGINE_CONFIG.BUDGET_PER_ENGINE,
      fees: EXCHANGE_FEES['crypto.com'],
      openTrades: new Map(),
      closedTrades: [],
      stats: { loopCount: 0, totalPnl: 0, winCount: 0, lossCount: 0, totalTrades: 0, rejectedByScan: 0, rejectedBySignal: 0, rejectedByRisk: 0 },
    },
  ];

  console.log(`[DUAL] Initialized: $${DUAL_ENGINE_CONFIG.BUDGET_PER_ENGINE} per engine, paper mode`);
}

/**
 * Start both engines running in parallel.
 */
export function startDualEngine(): void {
  if (isRunning) {
    console.log('[DUAL] Already running');
    return;
  }
  if (engines.length === 0) {
    throw new Error('[DUAL] Not initialized — call initDualEngine() first');
  }

  isRunning = true;
  console.log('[DUAL] Starting Kraken vs Crypto.com competition...');

  // Run immediately then on interval
  runDualLoop();
  loopTimer = setInterval(() => runDualLoop(), V2_CONFIG.BOT_LOOP_INTERVAL_MS);
}

/**
 * Stop both engines.
 */
export function stopDualEngine(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  isRunning = false;
  console.log('[DUAL] Competition paused');
}

/**
 * Get comparison status of both engines.
 */
export function getDualStatus(): DualEngineStatus {
  const engineStats = engines.map((e) => {
    const totalTrades = e.closedTrades.length;
    const winRate = totalTrades > 0
      ? ((e.stats.winCount / totalTrades) * 100).toFixed(1) + '%'
      : 'N/A';
    const openValue = Array.from(e.openTrades.values()).reduce((sum, t) => sum + t.positionSizeUsd, 0);

    return {
      name: e.name,
      budget: DUAL_ENGINE_CONFIG.BUDGET_PER_ENGINE,
      currentCash: e.budget + e.stats.totalPnl - openValue,
      totalPnl: e.stats.totalPnl,
      openPositions: e.openTrades.size,
      totalTrades: e.closedTrades.length,
      winCount: e.stats.winCount,
      lossCount: e.stats.lossCount,
      winRate,
      feesType: `maker=${(e.fees.MAKER_PERCENT * 100).toFixed(3)}% taker=${(e.fees.TAKER_PERCENT * 100).toFixed(3)}%`,
    };
  });

  const krakenPnl = engines[0]?.stats.totalPnl ?? 0;
  const cryptoPnl = engines[1]?.stats.totalPnl ?? 0;
  const leader = krakenPnl > cryptoPnl ? 'Kraken' : cryptoPnl > krakenPnl ? 'Crypto.com' : 'Tied';
  const krakenWR = engines[0] ? (engines[0].closedTrades.length > 0 ? engines[0].stats.winCount / engines[0].closedTrades.length : 0) : 0;
  const cryptoWR = engines[1] ? (engines[1].closedTrades.length > 0 ? engines[1].stats.winCount / engines[1].closedTrades.length : 0) : 0;

  return {
    isRunning,
    loopCount: globalLoopCount,
    engines: engineStats,
    comparison: {
      leader,
      pnlDifference: Math.abs(krakenPnl - cryptoPnl),
      winRateDifference: `${((krakenWR - cryptoWR) * 100).toFixed(1)}%`,
    },
  };
}

/**
 * Get all trades for a specific engine.
 */
export function getDualTrades(exchangeName: string): { open: V2Trade[]; closed: V2Trade[] } {
  const engine = engines.find((e) => e.name === exchangeName);
  if (!engine) return { open: [], closed: [] };
  return {
    open: Array.from(engine.openTrades.values()),
    closed: engine.closedTrades,
  };
}

// --- Main Loop ---

async function runDualLoop(): Promise<void> {
  globalLoopCount++;

  // Run both engines in parallel (they share candle data to be fair)
  await Promise.allSettled(engines.map((engine) => runEngineLoop(engine)));

  // Log comparison every 20 loops
  if (globalLoopCount % 20 === 0) {
    const status = getDualStatus();
    console.log(`[DUAL] Loop #${globalLoopCount} | Kraken: $${status.engines[0]?.totalPnl.toFixed(2)} (${status.engines[0]?.totalTrades} trades) | Crypto.com: $${status.engines[1]?.totalPnl.toFixed(2)} (${status.engines[1]?.totalTrades} trades) | Leader: ${status.comparison.leader}`);
  }
}

async function runEngineLoop(engine: EngineInstance): Promise<void> {
  engine.stats.loopCount++;
  const tag = `[DUAL:${engine.name}]`;

  try {
    // ── Fetch candles ──
    const tickerCandles = new Map<string, Candle[]>();
    const fetchResults = await Promise.allSettled(
      V2_CONFIG.SCAN_TICKERS.map(async (ticker) => {
        const candles = await fetchCandlesForExchange(ticker, engine.name);
        return { ticker, candles };
      }),
    );
    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value.candles) {
        tickerCandles.set(result.value.ticker, result.value.candles);
      }
    }
    if (tickerCandles.size === 0) return;

    // ── Scan ──
    const scanResults = scanMarket(tickerCandles);
    const passedScan = getPassedTickers(scanResults);
    engine.stats.rejectedByScan += scanResults.length - passedScan.length;
    if (passedScan.length === 0) {
      await checkEngineExits(engine);
      return;
    }

    // ── Signal Generation (includes TC, S/R, Dashboard) ──
    const signalResults = generateSignals(passedScan, tickerCandles);
    const passedSignals = getPassedSignals(signalResults);
    engine.stats.rejectedBySignal += signalResults.length - passedSignals.length;
    if (passedSignals.length === 0) {
      await checkEngineExits(engine);
      return;
    }

    // ── Risk Gate (with engine-specific portfolio) ──
    const portfolio = buildPortfolioForEngine(engine);
    const cbState = { dailyPnlPercent: 0, lastLossTime: 0 };
    const riskResults = evaluateRisk(passedSignals, portfolio, cbState, engine.adapter?.getName() ?? 'kraken');
    const approved = getApproved(riskResults);
    engine.stats.rejectedByRisk += riskResults.length - approved.length;

    // ── Execute best trade (paper) ──
    if (approved.length > 0) {
      const bestRisk = approved[0];
      const bestSignal = passedSignals.find((s) => s.ticker === bestRisk.ticker);

      if (bestSignal) {
        const trade = simulateEntry(engine, bestSignal, bestRisk);
        if (trade) {
          console.log(`${tag} ENTRY ${trade.ticker} @ $${trade.entryPrice.toFixed(4)} qty=${trade.quantity.toFixed(6)} score=${bestSignal.compositeScore.toFixed(1)} tc=${(bestSignal.signals.tc_value as number)?.toFixed(1)}`);
        }
      }
    }

    // ── Check exits ──
    await checkEngineExits(engine);
  } catch (e) {
    // Silent fail per-engine — don't crash the other
    if (engine.stats.loopCount % 50 === 1) {
      console.error(`${tag} Error: ${(e as Error).message}`);
    }
  }
}

async function checkEngineExits(engine: EngineInstance): Promise<void> {
  if (engine.openTrades.size === 0) return;
  const tag = `[DUAL:${engine.name}]`;

  const openTrades = Array.from(engine.openTrades.values());

  try {
    const exitResults = await checkExits(openTrades, engine.adapter);

    for (const result of exitResults) {
      if (!result.shouldExit || !result.exitReason) continue;

      const trade = result.trade;

      // Calculate fees. H6: exits ALWAYS go via placeMarketSell (taker), so
      // use TAKER_PERCENT regardless of exit reason. Old code applied maker
      // for take_profit/trailing, under-counting fees by ~0.10% per planned
      // exit and inflating recorded P&L vs the real exchange charge. Mirrors
      // commit fa3e878 which fixed the same bug in main tradeEngine.ts.
      const entryFee = trade.feesPaid;
      const exitFee = result.exitPrice * trade.quantity * engine.fees.TAKER_PERCENT;
      const totalFees = entryFee + exitFee;

      const pnlGross = (result.exitPrice - trade.entryPrice) * trade.quantity;
      const pnlNet = pnlGross - totalFees;

      // Close trade
      const closedTrade: V2Trade = {
        ...trade,
        exitPrice: result.exitPrice,
        exitTime: Date.now(),
        exitReason: result.exitReason,
        pnlGross,
        pnlNet,
        feesPaid: totalFees,
        holdDurationMs: Date.now() - trade.entryTime,
        status: 'closed',
      };

      engine.openTrades.delete(trade.id);
      engine.closedTrades.push(closedTrade);
      engine.stats.totalPnl += pnlNet;
      if (pnlNet > 0) engine.stats.winCount++;
      else engine.stats.lossCount++;

      console.log(`${tag} EXIT ${trade.ticker} @ $${result.exitPrice.toFixed(4)} reason=${result.exitReason} PnL=$${pnlNet.toFixed(2)} (fees=$${totalFees.toFixed(4)})`);
    }
  } catch (e) {
    // Silent fail
  }
}
