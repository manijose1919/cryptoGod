// ============================================
// Phoenix V2 Trade Engine Orchestrator
// Runs the full pipeline loop: scan → signal → risk → execute → exit
// ============================================

import type { Candle, V2Trade } from '../pipeline/types.ts';
import { V2_CONFIG, getExchangeFees } from './config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';

// Pipeline imports
import { scanMarket, getPassedTickers, setHTFRegime } from '../pipeline/marketScanner.ts';
import { detectRegime } from '../indicators/indicators.ts';
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
  getOpenTradesByStrategy,
  getClosedTrades,
} from '../attribution/attributionStore.ts';
import { analyzeClosedTrade } from '../attribution/postTradeAnalyzer.ts';

// Position management
import { loadPortfolio, getCircuitBreakerState } from './positionManager.ts';

// --- State ---

let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let loopInProgress = false; // Prevents concurrent runLoop() calls
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
  htfRegimes: {} as Record<string, string>,
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
  htfRegimes?: Record<string, string>;
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
      const pullbackTag = trade.entryRegime === 'PULLBACK_UP' ? ' [PULLBACK]' : '';
      tg.alertTradeExecution({
        type: 'BUY',
        ticker: trade.ticker,
        price: trade.entryPrice,
        strategy: `${V2_CONFIG.TELEGRAM_TAG}${pullbackTag} ${trade.entryRegime} conf=${trade.entryConfidence.toFixed(2)}`,
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
  const interval = V2_CONFIG.CANDLE_INTERVAL;

  // For 1-minute candles, try WebSocket realtime first
  if (interval === '1m') {
    try {
      const wsModule = await import('../../services/krakenWebsocketService.js');
      const candles = wsModule.getRealtimeCandles(ticker);
      if (candles && candles.length >= V2_CONFIG.MIN_CANDLES) {
        return normalizeCandles(candles);
      }
    } catch {
      // WS not available
    }
  }

  // REST via Kraken adapter (supports all intervals)
  try {
    const adapterModule = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const adapter = adapterModule.krakenAdapter;
    const candles = await adapter.getCandles(ticker, interval, 200);
    if (candles && candles.length > 0) {
      return normalizeCandles(candles);
    }
  } catch {
    // REST failed
  }

  return null;
}

// --- 4h Candle Cache for MTF Regime ---

const _4hCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

async function fetch4hCandles(ticker: string): Promise<Candle[] | null> {
  // Check cache
  const cached = _4hCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < V2_CONFIG.MTF_REGIME_CACHE_TTL_MS) {
    return cached.candles;
  }

  try {
    const adapterModule = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const adapter = adapterModule.krakenAdapter;
    const candles = await adapter.getCandles(ticker, V2_CONFIG.MTF_HIGHER_TIMEFRAME, 200);
    if (candles && candles.length > 0) {
      const normalized = normalizeCandles(candles);
      _4hCache.set(ticker, { candles: normalized, fetchedAt: Date.now() });
      return normalized;
    }
  } catch {
    // 4h fetch failed — return cached if available (even if stale)
    if (cached) return cached.candles;
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
    htfRegimes: stats.htfRegimes,
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

  // Concurrency guard: skip if previous loop is still running
  if (loopInProgress) {
    console.log('[V2] Loop skipped — previous iteration still running');
    return;
  }
  loopInProgress = true;

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
    // Stage 0b: Fetch 4h candles for MTF regime (parallel)
    // ==============================
    if (V2_CONFIG.MTF_ENABLED) {
      await Promise.allSettled(
        V2_CONFIG.SCAN_TICKERS.map(async (ticker) => {
          const candles4h = await fetch4hCandles(ticker);
          if (candles4h && candles4h.length >= 50) {
            const regime4h = detectRegime(candles4h);
            setHTFRegime(ticker, regime4h.regime);
            stats.htfRegimes[ticker] = regime4h.regime;
          }
        }),
      );
      // Log HTF regimes every 10 loops
      if (stats.loopCount % 10 === 1) {
        const htfEntries = Object.entries(stats.htfRegimes);
        if (htfEntries.length > 0) {
          console.log(`[V2] HTF regimes: ${htfEntries.map(([t, r]) => `${t}=${r}`).join(', ')}`);
        }
      }
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
      // Log top 3 scores every 5 loops for diagnostics
      if (stats.loopCount % 5 === 1) {
        const top3 = signalResults.slice(0, 3);
        const scoreStr = top3.map(s => `${s.ticker}=${s.compositeScore.toFixed(1)}`).join(', ');
        console.log(`[V2] Loop #${stats.loopCount}: signal rejected all ${signalResults.length} candidates, top: [${scoreStr}] (min ${V2_CONFIG.MIN_COMPOSITE_SCORE})`);
      } else {
        console.log(`[V2] Loop #${stats.loopCount}: signal rejected all ${signalResults.length} candidates`);
      }
      stats.lastLoopTime = Date.now() - loopStart;
      await checkOpenExits();
      return;
    }

    // ==============================
    // Stage 3: Risk Gate
    // ==============================
    const portfolio = loadPortfolio(budget, 'TREND');
    const cbState = getCircuitBreakerState(portfolio, 'TREND');
    const riskResults = evaluateRisk(passedSignals, portfolio, cbState, exchange?.getName() ?? 'kraken');
    const approved = getApproved(riskResults);
    const riskRejections = riskResults.length - approved.length;
    stats.rejectedByRisk += riskRejections;

    // ==============================
    // Stage 4: ML Gatekeeper (optional)
    // ==============================
    let mlFiltered = approved;
    if (approved.length > 0) {
      try {
        const gk = await import('../../services/mlGatekeeper.js');
        if (gk.evaluateEntry) {
          const mlResults = [];
          for (const risk of approved) {
            const signal = passedSignals.find((s) => s.ticker === risk.ticker);
            if (!signal) continue;
            const candles = tickerCandles.get(risk.ticker);
            if (!candles || candles.length < 50) { mlResults.push(risk); continue; }
            // Convert V2 candles to {o,h,l,c,v} format expected by feature engineering
            const fmtCandles = candles.map(c => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
            const gate = gk.evaluateEntry(risk.ticker, fmtCandles, 'TREND', signal.confidence, {});
            if (gate.proceed) {
              // Apply ML size multiplier
              if (gate.sizeMultiplier && gate.sizeMultiplier !== 1.0) {
                risk.positionSizeUsd *= gate.sizeMultiplier;
                risk.quantity = risk.positionSizeUsd / ((signal.signals.close_price as number) || 1);
              }
              mlResults.push(risk);
            } else {
              stats.rejectedByRisk++;
              if (stats.loopCount % 5 === 1) {
                console.log(`[V2] ML REJECT ${risk.ticker}: ${gate.reason} (tier=${gate.tier}, conf=${gate.confidence?.toFixed(1)}%)`);
              }
            }
          }
          mlFiltered = mlResults;
        }
      } catch (e) {
        // ML import or evaluation failed — pass approved signals through
        // unfiltered. Log so a real bug doesn't silently disable ML gating.
        if (stats.loopCount % 30 === 1) {
          console.warn(`[V2] ML gatekeeper bypassed (${(e as Error).message}) — ${approved.length} signals passed through unfiltered`);
        }
      }
    }

    // ==============================
    // Stage 5: Execute best approved trade
    // ==============================
    if (mlFiltered.length > 0) {
      // Take the best (first, since signals are sorted by score)
      const bestRisk = mlFiltered[0];
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
          // H4: insertTrade can throw (DB locked, schema drift, disk full).
          // In live mode, by this point the maker buy has filled on-exchange
          // AND a native SL is registered. If the DB write fails, the position
          // exists on the exchange but has no in-process record — the bot loop's
          // exit manager won't see it on the next tick (BE-stop, trailing,
          // TP, time_kill all skipped). The native SL still protects against a
          // crash, but managed exits are gone. Worst case we end up with a
          // "stop-loss only" zombie position. Try to roll back via market sell;
          // if rollback also fails, log a CRITICAL alert for manual intervention.
          try {
            insertTrade(trade);
            console.log(`[V2] Trade opened: ${trade.ticker} @ $${trade.entryPrice.toFixed(2)} qty=${trade.quantity.toFixed(6)}`);
            await sendEntryAlert(trade);
          } catch (insertErr) {
            const ie = insertErr as Error;
            console.error(`[V2] insertTrade failed for ${trade.ticker}: ${ie.message}`);
            if (V2_CONFIG.MODE === 'live') {
              try {
                await exchange!.placeMarketSell(trade.ticker, trade.quantity);
                console.error(`[V2] Position rolled back via market sell after insertTrade failure`);
              } catch (rollbackErr) {
                const re = rollbackErr as Error;
                console.error(`[V2] CRITICAL: insertTrade + rollback BOTH failed for ${trade.ticker}: ${re.message}. Position is naked on exchange (native SL still in place but no managed exits). Manual intervention required.`);
              }
            }
          }
        } else {
          console.log(`[V2] Trade execution failed: ${decision.reason}`);
        }
      }
    } else if (approved.length > 0) {
      // Had risk-approved trades but ML rejected them all
      console.log(`[V2] Loop #${stats.loopCount}: ML rejected all ${approved.length} risk-approved signals`);
    } else {
      // Log risk rejection reasons every 5 loops
      if (stats.loopCount % 5 === 1) {
        for (const r of riskResults) {
          if (!r.passed) console.log(`[V2] RISK REJECT ${r.ticker}: ${r.reason}`);
        }
      }
      console.log(`[V2] Loop #${stats.loopCount}: risk rejected all ${riskResults.length} signals (${passedScan.length} scanned, ${passedSignals.length} signaled)`);
    }

    // ==============================
    // Stage 6: Check exits
    // ==============================
    await checkOpenExits();

    stats.lastLoopTime = Date.now() - loopStart;
    console.log(`[V2] Loop #${stats.loopCount} completed in ${stats.lastLoopTime}ms`);
  } catch (e) {
    const err = e as Error;
    console.error(`[V2] Loop error: ${err.message}`);
    if (err.stack) console.error(`[V2] Stack: ${err.stack.split('\n').slice(1, 4).join(' | ')}`);
    stats.lastLoopTime = Date.now() - loopStart;
  } finally {
    loopInProgress = false;
  }
}

// --- Exit Check Helper ---

async function checkOpenExits(): Promise<void> {
  if (!exchange) return;

  const openTrades = getOpenTradesByStrategy('TREND');
  if (openTrades.length === 0) return;

  try {
    const exitResults = await checkExits(openTrades, exchange);

    for (const result of exitResults) {
      if (!result.shouldExit || !result.exitReason) continue;

      const trade = result.trade;

      // Calculate fees: both entry and exit sides.
      // All exits use placeMarketSell (see V2_CONFIG.MODE === 'live' block below),
      // which is always taker. Previously we assumed maker fee for take_profit and
      // trailing exits — that under-counted by ~0.10% (taker - maker), inflating
      // recorded P&L vs the actual exchange charge. Match accounting to reality.
      const entryFee = trade.feesPaid; // already paid at entry
      // H7: use the active exchange's taker rate (Kraken 0.26%, Crypto.com 0.075%).
      // Hardcoded V2_CONFIG.FEE_TAKER_PERCENT was Kraken-only and over-stated
      // exit fees by ~3.5x when the bot ran on Crypto.com.
      const fees = getExchangeFees(exchange.getName());
      const exitFee = result.exitPrice * trade.quantity * fees.TAKER_PERCENT;
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
