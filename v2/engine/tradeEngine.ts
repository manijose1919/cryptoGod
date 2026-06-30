// ============================================
// Phoenix V2 Trade Engine Orchestrator
// Runs the full pipeline loop: scan → signal → risk → execute → exit
// ============================================

import type { Candle, V2Trade } from '../pipeline/types.ts';
import { V2_CONFIG, MOMENTUM_CONFIG, STRATEGY_TIMEFRAMES, getExchangeFees } from './config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';

// Pipeline imports
import { scanMarket, getPassedTickers, setHTFRegime } from '../pipeline/marketScanner.ts';
import { detectRegime } from '../indicators/indicators.ts';
import { generateSignals, generateShortSignals, getPassedSignals } from '../pipeline/signalGenerator.ts';
import { detectMomentumEntry } from '../pipeline/momentumSignal.ts';
import { evaluateRisk, getApproved } from '../pipeline/riskGate.ts';
import { executeTrade } from '../pipeline/executor.ts';
import { checkExits } from '../pipeline/exitManager.ts';
import { fetchAllCandles, getRequiredTimeframes } from './candleManager.ts';
import { runAllStrategies } from './strategyRunner.ts';
import type { StrategySignal } from './strategyRunner.ts';

// Attribution imports
import {
  initV2Tables,
  insertTrade,
  closeTrade,
  resolveGatekeeperByEntry,
  getOpenTrades,
  getOpenTradesByStrategy,
  getClosedTrades,
  getClosedTradesByStrategy,
  appendTradeDecision,
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

// 2026-05-12: decision_log heartbeat dedup.
// checkOpenExits is called up to 3x per loop iteration. Without dedup we'd
// persist 3 identical heartbeat records each tick. Map keys are trade IDs;
// values are the last loopCount we persisted a decision for. State changes
// (stop moved / trail activated / exit) bypass this and persist unconditionally.
const _lastDecisionPersistLoop = new Map<string, number>();
const DECISION_HEARTBEAT_LOOPS = 30; // ~30 min on 60s BOT_LOOP_INTERVAL_MS

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
  // ISOLATION: filter to TREND only. This is the TREND engine's status — must
  // not include MOMENTUM, SNIPER_KRAKEN, or SNIPER_CRYPTOCOM trade counts /
  // P&L. Reports for those go through their own /momentum/status and
  // /sniper/* endpoints respectively.
  const openTrades = getOpenTradesByStrategy('TREND');
  const closedTrades = getClosedTradesByStrategy('TREND', 1000);
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
    // Stage 0: Fetch candles (multi-timeframe)
    // ==============================
    const requiredTfs = getRequiredTimeframes(STRATEGY_TIMEFRAMES);
    const allCandles = await fetchAllCandles(V2_CONFIG.SCAN_TICKERS as unknown as string[], requiredTfs);

    if (allCandles.size === 0) {
      console.log('[V2] No candle data available, skipping loop');
      stats.lastLoopTime = Date.now() - loopStart;
      await checkOpenExits();
      return;
    }

    // Track candle counts for diagnostics (use primary TF)
    stats.candleCounts = {};
    for (const [ticker, tfMap] of allCandles) {
      const primaryCandles = tfMap.get(V2_CONFIG.CANDLE_INTERVAL) ?? tfMap.values().next().value;
      if (primaryCandles) stats.candleCounts[ticker] = primaryCandles.length;
    }

    // Build primary-TF tickerCandles for scan reasons (backward compat with status API)
    const tickerCandles = new Map<string, Candle[]>();
    for (const [ticker, tfMap] of allCandles) {
      const candles = tfMap.get(V2_CONFIG.CANDLE_INTERVAL);
      if (candles) tickerCandles.set(ticker, candles);
    }

    // Market scan on primary timeframe for diagnostics/logging
    const scanResults = scanMarket(tickerCandles);
    stats.lastScanReasons = scanResults.map(r => ({ ticker: r.ticker, reason: r.reason || (r.passed ? 'PASS' : 'UNKNOWN') }));
    if (stats.loopCount % 10 === 1) {
      for (const r of scanResults) {
        if (!r.passed) console.log(`[V2] REJECT ${r.ticker}: ${r.reason}`);
      }
    }

    // ==============================
    // Stage 1+2: Multi-Strategy Signal Generation
    // ==============================
    // Runs TREND, MOMENTUM, BREAKOUT, MEAN_REVERSION, SCALP on their optimal TFs
    const allSignals = runAllStrategies(allCandles, V2_CONFIG.SCAN_TICKERS as unknown as string[]);
    const passedSignals = allSignals.filter(s => s.passed);

    if (passedSignals.length === 0) {
      if (stats.loopCount % 5 === 1) {
        console.log(`[V2] Loop #${stats.loopCount}: no signals from any strategy across ${requiredTfs.length} timeframes`);
      }
      stats.lastLoopTime = Date.now() - loopStart;
      await checkOpenExits();
      return;
    }

    if (stats.loopCount % 5 === 1) {
      const sigSummary = passedSignals.map(s => `${s.ticker}/${(s as StrategySignal)._strategy}/${(s as StrategySignal)._timeframe}=${s.confidence.toFixed(2)}`).join(', ');
      console.log(`[V2] Loop #${stats.loopCount}: ${passedSignals.length} signals: [${sigSummary}]`);
    }

    // ==============================
    // Stage 3: Risk Gate
    // ==============================
    // Load ALL open positions (not just TREND) so riskGate sees MOMENTUM/BREAKOUT/SCALP too
    const portfolio = loadPortfolio(budget);
    const cbState = getCircuitBreakerState(portfolio);
    const riskResults = evaluateRisk(passedSignals, portfolio, cbState, exchange?.getName() ?? 'kraken', tickerCandles);
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
            // Match side too — a long and a short on the same ticker can both
            // survive strategyRunner's ticker:side dedup; ticker-only find()
            // could pair a short risk result with the long signal's prices.
            const signal = passedSignals.find((s) => s.ticker === risk.ticker && (s.side ?? 'long') === (risk.side ?? 'long'));
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
                // Re-apply the risk cap AFTER the multiplier. The gatekeeper
                // can scale up to 1.5x, which silently breached
                // MAX_RISK_PER_TRADE_PERCENT (riskGate clamps BEFORE this).
                const closePrice = (signal.signals.close_price as number) || 1;
                const stopDistPercent = risk.stopLoss > 0 ? Math.abs(closePrice - risk.stopLoss) / closePrice : 0;
                if (stopDistPercent > 0) {
                  const maxRiskUsd = Math.min(
                    portfolio.totalEquity * V2_CONFIG.MAX_RISK_PER_TRADE_PERCENT,
                    V2_CONFIG.MAX_RISK_PER_TRADE_USD,
                  );
                  risk.positionSizeUsd = Math.min(risk.positionSizeUsd, maxRiskUsd / stopDistPercent);
                }
                // Downward multipliers (0.5x) can also drop below Kraken's $10 min
                if (!isFinite(risk.positionSizeUsd) || risk.positionSizeUsd < 10) {
                  stats.rejectedByRisk++;
                  console.log(`[V2] ML SIZE REJECT ${risk.ticker}: $${risk.positionSizeUsd.toFixed(2)} below $10 min after ${gate.sizeMultiplier}x multiplier`);
                  continue;
                }
                risk.quantity = risk.positionSizeUsd / closePrice;
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
      const bestSignal = passedSignals.find((s) => s.ticker === bestRisk.ticker && (s.side ?? 'long') === (bestRisk.side ?? 'long'));

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
                // Cancel the native SL FIRST — otherwise it survives the
                // rollback sell and fires later against a position we no
                // longer hold (selling a future re-entry's coins).
                if (trade.stopOrderId) {
                  try {
                    await exchange!.cancelOrder(trade.stopOrderId);
                  } catch (cancelErr) {
                    console.error(`[V2] WARNING: could not cancel native SL ${trade.stopOrderId} during rollback: ${(cancelErr as Error).message}. Cancel it manually on Kraken.`);
                  }
                }
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
      console.log(`[V2] Loop #${stats.loopCount}: risk rejected all ${riskResults.length} signals (${scanResults.filter(r => r.passed).length} scanned, ${passedSignals.length} signaled)`);
    }

    // Shorts are now handled by strategyRunner (Stage 1+2) — no separate pipeline needed

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

  // Get ALL open trades (TREND + MOMENTUM + shorts) — one exit manager handles all
  const openTrades = getOpenTrades();
  if (openTrades.length === 0) return;

  try {
    const exitResults = await checkExits(openTrades, exchange);

    for (const result of exitResults) {
      // Persist the decision when it's worth seeing later:
      //  - shouldExit (always persist the final decision)
      //  - state change (stop moved, trailing just activated)
      //  - periodic heartbeat (every DECISION_HEARTBEAT_LOOPS, dedup'd per trade)
      //
      // Without this, a silently-broken exit loop (like the krakenAdapter
      // NaN bug in commit 70bcafa) leaves no trace — decision_log only had
      // the entry record. Now post-entry behavior is observable.
      const tradeId = result.trade.id;
      const stopChanged = result.newStop !== result.trade.currentStop;
      const isStateChange = stopChanged || result.trailingJustActivated || result.shouldExit;
      const heartbeatDue =
        stats.loopCount % DECISION_HEARTBEAT_LOOPS === 0 &&
        _lastDecisionPersistLoop.get(tradeId) !== stats.loopCount;

      if (isStateChange || heartbeatDue) {
        try {
          appendTradeDecision(tradeId, result.decision);
          _lastDecisionPersistLoop.set(tradeId, stats.loopCount);
        } catch (e) {
          // Non-fatal — observability failure should never break exit logic.
          console.warn(`[V2] decision_log append failed for ${result.trade.ticker}: ${(e as Error).message}`);
        }
      }

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

      // In live mode, actually sell. C2: cancel the native SL FIRST so it
      // doesn't fire later on the next re-entry's price dip and accidentally
      // close the fresh position. Cancel is best-effort — if it fails (already
      // filled, or just rejected), proceed with the market-sell anyway and
      // let the exchange reject one of the two if it ever races. Logging
      // captures both cases for diagnosis.
      if (V2_CONFIG.MODE === 'live') {
        if (trade.stopOrderId) {
          try {
            await exchange.cancelOrder(trade.stopOrderId);
          } catch (e) {
            console.warn(`[V2] cancelOrder(SL ${trade.stopOrderId}) for ${trade.ticker} failed: ${(e as Error).message} — proceeding with market sell`);
          }
        }
        try {
          await exchange.placeMarketSell(trade.ticker, trade.quantity);
        } catch (e) {
          console.error(`[V2] Failed to place market sell for ${trade.ticker}: ${(e as Error).message}`);
          continue;
        }
      }

      // Close in DB
      closeTrade(trade.id, result.exitPrice, result.exitReason, totalFees);
      _lastDecisionPersistLoop.delete(trade.id); // Trade closed; clear heartbeat tracker

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

      // Wire the ML gatekeeper feedback loop: record whether its entry decision
      // panned out (was NULL on every row before this — accuracy was unmeasurable).
      // Use a sign-correct realized PnL (closedTrade.pnlNet above omits the short-side
      // multiplier, so it would misclassify short wins as losses).
      try {
        const realizedPnl = (result.exitPrice - trade.entryPrice) * trade.quantity
          * (trade.side === 'long' ? 1 : -1) - totalFees;
        resolveGatekeeperByEntry(trade.ticker, trade.entryTime, realizedPnl > 0 ? 'WIN' : 'LOSS');
      } catch (e) {
        console.warn(`[V2] gatekeeper resolve failed for ${trade.ticker}: ${(e as Error).message}`);
      }

      const pnlNet = closedTrade.pnlNet;
      console.log(`[V2] Trade closed: ${trade.ticker} @ $${result.exitPrice.toFixed(2)} reason=${result.exitReason} PnL=$${pnlNet.toFixed(2)}`);
      await sendExitAlert(trade, result.exitPrice, result.exitReason, pnlNet);
    }
  } catch (e) {
    console.error(`[V2] Exit check error: ${(e as Error).message}`);
  }
}
