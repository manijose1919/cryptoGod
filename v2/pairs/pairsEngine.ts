// Live pairs trading engine. Paper-mode only this session — live executor
// is deferred to next session (two-leg order placement is high-stakes).
//
// Loop:
//   1. Fetch candles for both legs (Kraken REST).
//   2. Align timestamps; build log-price arrays.
//   3. Maybe re-estimate cointegration state.
//   4. Compute current spread + z-score.
//   5. Persist state snapshot for monitoring.
//   6. If open: check exit (mean revert, stop-z, time stop).
//      Else: check entry (long_spread or short_spread).
//   7. Execute via paper fills (next-bar's open simulated).
//
// Engine is gated by PAIRS_CONFIG.MODE — 'off' = doesn't run, 'paper' = this
// session's behavior, 'live' = future session.

import { randomUUID } from 'node:crypto';
import { PAIRS_CONFIG } from '../engine/config.ts';
import {
  initPairsTables,
  insertPairsTrade,
  closePairsTrade,
  getOpenPairsTrade,
  recordPairsState,
  type PairsTradeRow,
} from './schema.ts';
import {
  buildInitialState,
  maybeReestimate,
  computeCurrentSpread,
  type PairsLiveState,
} from './cointegration.ts';
import {
  alertEntry, alertExit, alertDrawdownKill, alertPause, alertAdfDegrade,
} from './pairsAlerts.ts';
import { setAlertHandler, startMonitor, stopMonitor } from './pairsMonitor.ts';
import { alertMarginLow, alertStateDrift, alertExecutorPartialFill } from './pairsAlerts.ts';
import {
  executePairEntry, executePairExit, preflightCheck,
  type LegSpec,
} from './pairsExecutor.ts';

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

interface OpenTradeState {
  id: string;
  side: 'long_spread' | 'short_spread';
  entryBar: number;
  entryTime: number;
  entryPriceA: number;
  entryPriceB: number;
  qtyA: number;
  qtyB: number;
  entryZ: number;
  beta: number;
}

interface EngineStats {
  loopCount: number;
  signalsFired: number;
  paperEntriesOpened: number;
  paperEntriesClosed: number;
  paperPnlTotalUsd: number;
  consecutiveLosses: number;
  pausedUntilTs: number;
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let loopInProgress = false;
let isRunning = false;
let cointState: PairsLiveState | null = null;
let openTrade: OpenTradeState | null = null;
const candleCache = { a: [] as Candle[], b: [] as Candle[] };
const stats: EngineStats = {
  loopCount: 0,
  signalsFired: 0,
  paperEntriesOpened: 0,
  paperEntriesClosed: 0,
  paperPnlTotalUsd: 0,
  consecutiveLosses: 0,
  pausedUntilTs: 0,
};

async function fetchCandles(ticker: string): Promise<Candle[] | null> {
  try {
    // @ts-expect-error JS module without types
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const raw = await mod.krakenAdapter.getCandles(
      ticker,
      PAIRS_CONFIG.CANDLE_INTERVAL,
      PAIRS_CONFIG.WARMUP_BARS,
    );
    if (!raw || raw.length === 0) return null;
    return raw.map((c: Record<string, number>) => ({
      open: c.o ?? c.open,
      high: c.h ?? c.high,
      low: c.l ?? c.low,
      close: c.c ?? c.close,
      volume: c.v ?? c.volume ?? 0,
      time: c.t ?? c.time ?? 0,
    })) as Candle[];
  } catch (err) {
    console.error(`[PAIRS] fetchCandles ${ticker} failed: ${(err as Error).message}`);
    return null;
  }
}

// Align two candle series by timestamp. Returns the common-time subset.
function alignByTime(a: Candle[], b: Candle[]): { a: Candle[]; b: Candle[] } {
  const mapB = new Map(b.map(c => [c.time, c]));
  const outA: Candle[] = [], outB: Candle[] = [];
  for (const ca of a) {
    const cb = mapB.get(ca.time);
    if (cb) { outA.push(ca); outB.push(cb); }
  }
  return { a: outA, b: outB };
}

function isPaused(): boolean {
  if (stats.pausedUntilTs === 0) return false;
  if (Date.now() >= stats.pausedUntilTs) {
    stats.pausedUntilTs = 0;
    stats.consecutiveLosses = 0;
    console.log('[PAIRS] resuming from auto-pause');
    return false;
  }
  return true;
}

// Restore from DB on startup. If there's an open paper trade for our pair,
// adopt it as the in-memory open trade so the engine continues managing it.
function adoptOpenTrade(): void {
  const row = getOpenPairsTrade(PAIRS_CONFIG.SYMBOL_A, PAIRS_CONFIG.SYMBOL_B);
  if (!row) return;
  if (row.mode !== PAIRS_CONFIG.MODE) {
    console.warn(`[PAIRS] open trade ${row.id} in mode='${row.mode}' but engine mode='${PAIRS_CONFIG.MODE}'. Refusing to adopt.`);
    return;
  }
  openTrade = {
    id: row.id,
    side: row.side,
    entryBar: 0,  // unknown post-restart; OK — we use entry_time for time-stop
    entryTime: row.entry_time,
    entryPriceA: row.entry_price_a,
    entryPriceB: row.entry_price_b,
    qtyA: row.qty_a,
    qtyB: row.qty_b,
    entryZ: row.entry_z,
    beta: row.beta,
  };
  console.log(`[PAIRS] adopted open trade ${row.id} (${row.side}) entered ${new Date(row.entry_time).toISOString()}`);
}

// Margin leverage to use for live trades. FIL/ICP both support 2x minimum;
// we use 2x (lowest available) since the goal is shorting capability, not
// leveraging the position.
const MARGIN_LEVERAGE = 2;

// Live entry path. Calls the real executor; only writes to DB on success.
// If executor fails (no fill, or partial-fill emergency-close), DB is not
// updated and we remain flat. Telegram alert fires for partial fills.
async function liveExecuteEntry(
  side: 'long_spread' | 'short_spread',
  zScore: number,
  state: PairsLiveState,
  bidA: number, bidB: number,
  nextTime: number,
  currentBar: number,
  adfTStat: number,
  halflife: number,
): Promise<void> {
  // Preflight check before any order goes out.
  const preflightError = await preflightCheck(
    PAIRS_CONFIG.SYMBOL_A, PAIRS_CONFIG.SYMBOL_B, PAIRS_CONFIG.TOTAL_NOTIONAL_USD,
  );
  if (preflightError) {
    console.error(`[PAIRS] LIVE entry blocked by preflight: ${preflightError}`);
    return;
  }
  const isLong = side === 'long_spread';
  const qtyA = PAIRS_CONFIG.LEG_NOTIONAL_USD / bidA;
  const qtyB = PAIRS_CONFIG.LEG_NOTIONAL_USD / bidB;
  const legA: LegSpec = {
    ticker: PAIRS_CONFIG.SYMBOL_A,
    side: isLong ? 'buy' : 'sell',
    quantity: qtyA, leverage: MARGIN_LEVERAGE,
  };
  const legB: LegSpec = {
    ticker: PAIRS_CONFIG.SYMBOL_B,
    side: isLong ? 'sell' : 'buy',
    quantity: qtyB, leverage: MARGIN_LEVERAGE,
  };
  console.log(`[PAIRS] LIVE ENTRY ATTEMPT ${side} z=${zScore.toFixed(2)} β=${state.beta.toFixed(3)}`);
  const result = await executePairEntry(legA, legB);
  if (!result.success) {
    if (result.abortReason === 'partial_fill_emergency_close') {
      alertExecutorPartialFill(PAIRS_CONFIG.SYMBOL_A, PAIRS_CONFIG.SYMBOL_B, result.legAFilled);
    }
    console.error(`[PAIRS] LIVE entry FAILED: ${result.abortReason} (elapsed=${result.elapsedMs}ms)`);
    return;
  }
  // Success — persist trade with actual fill prices.
  const id = randomUUID();
  const fillA = result.legAFillPrice ?? bidA;
  const fillB = result.legBFillPrice ?? bidB;
  const actualQtyA = result.legAFillQty ?? qtyA;
  const actualQtyB = result.legBFillQty ?? qtyB;
  insertPairsTrade({
    id, mode: 'live',
    sym_a: PAIRS_CONFIG.SYMBOL_A, sym_b: PAIRS_CONFIG.SYMBOL_B,
    side, status: 'open',
    entry_time: nextTime,
    entry_price_a: fillA, entry_price_b: fillB,
    qty_a: actualQtyA, qty_b: actualQtyB,
    beta: state.beta, alpha: state.alpha,
    entry_z: zScore,
    spread_mean: state.spreadMean, spread_std: state.spreadStd,
    adf_t_stat: adfTStat,
    halflife: Number.isFinite(halflife) ? halflife : null,
    total_notional_usd: PAIRS_CONFIG.LEG_NOTIONAL_USD * 2,
  });
  openTrade = {
    id, side,
    entryBar: currentBar, entryTime: nextTime,
    entryPriceA: fillA, entryPriceB: fillB,
    qtyA: actualQtyA, qtyB: actualQtyB,
    entryZ: zScore, beta: state.beta,
  };
  stats.paperEntriesOpened++;  // shared counter; mode reported separately on each trade
  stats.signalsFired++;
  console.log(
    `[PAIRS] LIVE ENTRY ${side} z=${zScore.toFixed(2)} ` +
    `A=$${fillA.toFixed(4)} qty=${actualQtyA.toFixed(4)} ` +
    `B=$${fillB.toFixed(4)} qty=${actualQtyB.toFixed(4)} (${result.elapsedMs}ms)`,
  );
  alertEntry(side, zScore, state.beta, 'live');
}

async function liveExecuteExit(
  reason: string,
  exitZ: number,
  currentBar: number,
): Promise<void> {
  if (!openTrade) return;
  const isLong = openTrade.side === 'long_spread';
  const legA: LegSpec = {
    ticker: PAIRS_CONFIG.SYMBOL_A,
    side: isLong ? 'buy' : 'sell',  // original entry side; executor inverts
    quantity: openTrade.qtyA, leverage: MARGIN_LEVERAGE,
  };
  const legB: LegSpec = {
    ticker: PAIRS_CONFIG.SYMBOL_B,
    side: isLong ? 'sell' : 'buy',
    quantity: openTrade.qtyB, leverage: MARGIN_LEVERAGE,
  };
  console.log(`[PAIRS] LIVE EXIT ATTEMPT ${openTrade.side} reason=${reason}`);
  const result = await executePairExit(legA, legB);
  if (!result.success) {
    console.error(
      `[PAIRS] LIVE EXIT FAILED: ${result.abortReason}. ` +
      `Trade ${openTrade.id} remains marked 'open' in DB. MANUAL INTERVENTION REQUIRED.`,
    );
    return;
  }
  // Fill prices not easily available from market-close result; use last
  // known candle close as approximation. Realized PnL gets reconciled when
  // Kraken's TradesHistory query happens (separate process).
  const lastA = candleCache.a[candleCache.a.length - 1];
  const lastB = candleCache.b[candleCache.b.length - 1];
  const exitPriceA = lastA?.close ?? openTrade.entryPriceA;
  const exitPriceB = lastB?.close ?? openTrade.entryPriceB;
  let pnlA: number, pnlB: number;
  if (isLong) {
    pnlA = (exitPriceA - openTrade.entryPriceA) * openTrade.qtyA;
    pnlB = (openTrade.entryPriceB - exitPriceB) * openTrade.qtyB;
  } else {
    pnlA = (openTrade.entryPriceA - exitPriceA) * openTrade.qtyA;
    pnlB = (exitPriceB - openTrade.entryPriceB) * openTrade.qtyB;
  }
  const pnlGross = pnlA + pnlB;
  const fees = (openTrade.qtyA * openTrade.entryPriceA + openTrade.qtyB * openTrade.entryPriceB) * PAIRS_CONFIG.FEE_PER_LEG_TAKER;
  const pnlNet = pnlGross - fees;
  const holdBars = openTrade.entryBar > 0 ? currentBar - openTrade.entryBar : 0;
  closePairsTrade(openTrade.id, {
    exit_time: Date.now(),
    exit_price_a: exitPriceA, exit_price_b: exitPriceB,
    exit_z: exitZ,
    exit_reason: reason,
    pnl_leg_a: pnlA, pnl_leg_b: pnlB,
    pnl_gross: pnlGross, pnl_net: pnlNet,
    fees_paid: fees,
    hold_bars: holdBars,
  });
  stats.paperEntriesClosed++;
  stats.paperPnlTotalUsd += pnlNet;
  if (pnlNet < 0) {
    stats.consecutiveLosses++;
    if (stats.consecutiveLosses >= PAIRS_CONFIG.CONSECUTIVE_LOSS_PAUSE_THRESHOLD) {
      stats.pausedUntilTs = Date.now() + PAIRS_CONFIG.PAUSE_DURATION_HOURS * 3600 * 1000;
      alertPause(stats.consecutiveLosses, stats.pausedUntilTs);
    }
  } else {
    stats.consecutiveLosses = 0;
  }
  console.log(`[PAIRS] LIVE EXIT ${openTrade.side} reason=${reason} pnl_net=$${pnlNet.toFixed(2)}`);
  alertExit(openTrade.side, reason, pnlNet, holdBars, 'live');
  openTrade = null;
}

function paperExecuteEntry(
  side: 'long_spread' | 'short_spread',
  zScore: number,
  state: PairsLiveState,
  nextOpenA: number,
  nextOpenB: number,
  nextTime: number,
  currentBar: number,
  adfTStat: number,
  halflife: number,
): void {
  // Slippage applied as if we're a price-taker on entry.
  const isLong = side === 'long_spread';
  const entryPriceA = nextOpenA * (isLong ? 1 + PAIRS_CONFIG.SLIPPAGE_PER_SIDE : 1 - PAIRS_CONFIG.SLIPPAGE_PER_SIDE);
  const entryPriceB = nextOpenB * (isLong ? 1 - PAIRS_CONFIG.SLIPPAGE_PER_SIDE : 1 + PAIRS_CONFIG.SLIPPAGE_PER_SIDE);
  const legNotional = PAIRS_CONFIG.LEG_NOTIONAL_USD;
  if (legNotional < PAIRS_CONFIG.MIN_LEG_NOTIONAL_USD) {
    console.warn(`[PAIRS] leg notional $${legNotional} below minimum; refusing entry`);
    return;
  }
  const qtyA = legNotional / entryPriceA;
  const qtyB = legNotional / entryPriceB;
  const id = randomUUID();
  const row: PairsTradeRow = {
    id, mode: 'paper',
    sym_a: PAIRS_CONFIG.SYMBOL_A, sym_b: PAIRS_CONFIG.SYMBOL_B,
    side, status: 'open',
    entry_time: nextTime,
    entry_price_a: entryPriceA, entry_price_b: entryPriceB,
    qty_a: qtyA, qty_b: qtyB,
    beta: state.beta, alpha: state.alpha,
    entry_z: zScore,
    spread_mean: state.spreadMean, spread_std: state.spreadStd,
    adf_t_stat: adfTStat, halflife: Number.isFinite(halflife) ? halflife : null,
    total_notional_usd: legNotional * 2,
  };
  insertPairsTrade(row);
  openTrade = {
    id, side,
    entryBar: currentBar, entryTime: nextTime,
    entryPriceA, entryPriceB, qtyA, qtyB,
    entryZ: zScore, beta: state.beta,
  };
  stats.paperEntriesOpened++;
  stats.signalsFired++;
  console.log(
    `[PAIRS] PAPER ENTRY ${side} z=${zScore.toFixed(2)} β=${state.beta.toFixed(3)} ` +
    `A=$${entryPriceA.toFixed(4)} qty=${qtyA.toFixed(4)} B=$${entryPriceB.toFixed(4)} qty=${qtyB.toFixed(4)}`,
  );
  alertEntry(side, zScore, state.beta, 'paper');
}

function paperExecuteExit(
  reason: string,
  exitZ: number,
  nextCloseA: number,
  nextCloseB: number,
  nextTime: number,
  currentBar: number,
): void {
  if (!openTrade) return;
  const isLong = openTrade.side === 'long_spread';
  // Slippage on exit: taker assumption.
  const exitPriceA = nextCloseA * (isLong ? 1 - PAIRS_CONFIG.SLIPPAGE_PER_SIDE : 1 + PAIRS_CONFIG.SLIPPAGE_PER_SIDE);
  const exitPriceB = nextCloseB * (isLong ? 1 + PAIRS_CONFIG.SLIPPAGE_PER_SIDE : 1 - PAIRS_CONFIG.SLIPPAGE_PER_SIDE);
  // PnL: long leg gets the upside; short leg gets the downside (inverted).
  let pnlA: number, pnlB: number;
  if (isLong) {
    pnlA = (exitPriceA - openTrade.entryPriceA) * openTrade.qtyA;
    pnlB = (openTrade.entryPriceB - exitPriceB) * openTrade.qtyB;
  } else {
    pnlA = (openTrade.entryPriceA - exitPriceA) * openTrade.qtyA;
    pnlB = (exitPriceB - openTrade.entryPriceB) * openTrade.qtyB;
  }
  const pnlGross = pnlA + pnlB;
  const notionalA = openTrade.qtyA * openTrade.entryPriceA;
  const notionalB = openTrade.qtyB * openTrade.entryPriceB;
  // Fees: per leg, per side. In paper-mode we assume taker round-trip
  // since we can't model maker-rebate certainty without an actual order book.
  const fees = (notionalA + notionalB) * PAIRS_CONFIG.FEE_PER_LEG_TAKER;
  const pnlNet = pnlGross - fees;
  const holdBars = openTrade.entryBar > 0 ? currentBar - openTrade.entryBar : 0;
  closePairsTrade(openTrade.id, {
    exit_time: nextTime,
    exit_price_a: exitPriceA, exit_price_b: exitPriceB,
    exit_z: exitZ,
    exit_reason: reason,
    pnl_leg_a: pnlA, pnl_leg_b: pnlB,
    pnl_gross: pnlGross, pnl_net: pnlNet,
    fees_paid: fees,
    hold_bars: holdBars,
  });
  stats.paperEntriesClosed++;
  stats.paperPnlTotalUsd += pnlNet;
  // Kill-switch tracking.
  if (pnlNet < 0) {
    stats.consecutiveLosses++;
    if (stats.consecutiveLosses >= PAIRS_CONFIG.CONSECUTIVE_LOSS_PAUSE_THRESHOLD) {
      stats.pausedUntilTs = Date.now() + PAIRS_CONFIG.PAUSE_DURATION_HOURS * 3600 * 1000;
      console.warn(
        `[PAIRS] auto-pause: ${stats.consecutiveLosses} consecutive losses. ` +
        `Resuming at ${new Date(stats.pausedUntilTs).toISOString()}`,
      );
      alertPause(stats.consecutiveLosses, stats.pausedUntilTs);
    }
  } else {
    stats.consecutiveLosses = 0;
  }
  console.log(
    `[PAIRS] PAPER EXIT ${openTrade.side} reason=${reason} z=${exitZ.toFixed(2)} ` +
    `pnl_net=$${pnlNet.toFixed(2)} (gross=$${pnlGross.toFixed(2)}, fees=$${fees.toFixed(2)}) ` +
    `hold=${holdBars}bars total=$${stats.paperPnlTotalUsd.toFixed(2)}`,
  );
  alertExit(openTrade.side, reason, pnlNet, holdBars, 'paper');
  openTrade = null;
}

async function runLoop(): Promise<void> {
  if (loopInProgress) return;
  loopInProgress = true;
  stats.loopCount++;

  try {
    if (isPaused()) {
      console.log(`[PAIRS] paused until ${new Date(stats.pausedUntilTs).toISOString()}`);
      return;
    }

    // Refresh candles.
    const [rawA, rawB] = await Promise.all([
      fetchCandles(PAIRS_CONFIG.SYMBOL_A),
      fetchCandles(PAIRS_CONFIG.SYMBOL_B),
    ]);
    if (!rawA || !rawB) {
      console.warn('[PAIRS] candle fetch failed; skipping loop');
      return;
    }
    const aligned = alignByTime(rawA, rawB);
    if (aligned.a.length < PAIRS_CONFIG.WARMUP_BARS) {
      console.warn(`[PAIRS] only ${aligned.a.length} aligned bars; need ${PAIRS_CONFIG.WARMUP_BARS}`);
      return;
    }
    candleCache.a = aligned.a;
    candleCache.b = aligned.b;

    const logA = aligned.a.map(c => Math.log(c.close));
    const logB = aligned.b.map(c => Math.log(c.close));
    const lastBar = logA.length - 1;

    // Initialize state on first loop after restart.
    if (!cointState) {
      cointState = buildInitialState(logA, logB, lastBar, PAIRS_CONFIG.ROLLING_WINDOW_BARS);
      console.log(
        `[PAIRS] cointegration initialized β=${cointState.beta.toFixed(3)} ` +
        `α=${cointState.alpha.toFixed(3)} adf=${cointState.adfTStat.toFixed(2)} ` +
        `halflife=${Number.isFinite(cointState.halflife) ? cointState.halflife.toFixed(0) : '∞'} ` +
        `r²=${cointState.rSquared.toFixed(2)}`,
      );
    } else {
      cointState = maybeReestimate(
        cointState, logA, logB, lastBar,
        PAIRS_CONFIG.REESTIMATE_BETA_EVERY_BARS,
        PAIRS_CONFIG.ROLLING_WINDOW_BARS,
      );
    }

    const { spread, zScore } = computeCurrentSpread(cointState, logA[lastBar], logB[lastBar]);

    // Record state snapshot for monitoring.
    recordPairsState({
      loop_at: Date.now(),
      sym_a: PAIRS_CONFIG.SYMBOL_A,
      sym_b: PAIRS_CONFIG.SYMBOL_B,
      beta: cointState.beta,
      alpha: cointState.alpha,
      spread_mean: cointState.spreadMean,
      spread_std: cointState.spreadStd,
      current_spread: spread,
      z_score: zScore,
      adf_t_stat: cointState.adfTStat,
      halflife: Number.isFinite(cointState.halflife) ? cointState.halflife : null,
      in_position: openTrade !== null,
      mode: 'paper',
    });

    // ------- Position management -------
    if (openTrade) {
      const barsSinceEntry = lastBar - openTrade.entryBar;
      const lastA = aligned.a[lastBar];
      const lastB = aligned.b[lastBar];

      const doExit = async (reason: string): Promise<void> => {
        if (_effectiveMode === 'live') {
          await liveExecuteExit(reason, zScore, lastBar);
        } else {
          paperExecuteExit(reason, zScore, lastA.close, lastB.close, lastA.time, lastBar);
        }
      };

      // Mean-revert exit.
      if (Math.abs(zScore) < PAIRS_CONFIG.EXIT_Z) {
        await doExit(`mean_revert z=${zScore.toFixed(2)}`);
        return;
      }
      // Stop z (spread ran further than expected).
      if (Math.abs(zScore) > PAIRS_CONFIG.STOP_Z) {
        await doExit(`stop_z z=${zScore.toFixed(2)}`);
        return;
      }
      // Time stop.
      if (barsSinceEntry >= PAIRS_CONFIG.MAX_HOLD_BARS && openTrade.entryBar > 0) {
        await doExit('time_stop');
        return;
      }
      // Drawdown kill-switch — mark-to-market unrealized PnL.
      const isLong = openTrade.side === 'long_spread';
      const unrealizedA = isLong
        ? (lastA.close - openTrade.entryPriceA) * openTrade.qtyA
        : (openTrade.entryPriceA - lastA.close) * openTrade.qtyA;
      const unrealizedB = isLong
        ? (openTrade.entryPriceB - lastB.close) * openTrade.qtyB
        : (lastB.close - openTrade.entryPriceB) * openTrade.qtyB;
      const unrealizedPct = (unrealizedA + unrealizedB) / PAIRS_CONFIG.TOTAL_NOTIONAL_USD;
      if (unrealizedPct < -PAIRS_CONFIG.MAX_DRAWDOWN_PCT_PER_TRADE) {
        alertDrawdownKill(unrealizedPct, _effectiveMode === 'live' ? 'live' : 'paper');
        await doExit(`drawdown_kill (${(unrealizedPct * 100).toFixed(2)}%)`);
        return;
      }
      console.log(
        `[PAIRS] HOLD ${openTrade.side} z=${zScore.toFixed(2)} ` +
        `unrealized=$${(unrealizedA + unrealizedB).toFixed(2)} bars_held=${barsSinceEntry}`,
      );
      return;
    }

    // ------- Entry evaluation -------
    // Cointegration gate.
    if (cointState.adfTStat > PAIRS_CONFIG.REQUIRE_ADF_T_BELOW) {
      console.log(`[PAIRS] no entry — ADF t=${cointState.adfTStat.toFixed(2)} above threshold ${PAIRS_CONFIG.REQUIRE_ADF_T_BELOW}`);
      // Throttle adf alerts to once per ~6h equivalent (every 360 loops at 60s).
      if (stats.loopCount % 360 === 1) alertAdfDegrade(cointState.adfTStat);
      return;
    }

    const tryEntry = async (side: 'long_spread' | 'short_spread'): Promise<void> => {
      const lastA = aligned.a[lastBar];
      const lastB = aligned.b[lastBar];
      if (_effectiveMode === 'live') {
        await liveExecuteEntry(
          side, zScore, cointState!,
          lastA.close, lastB.close, lastA.time, lastBar,
          cointState!.adfTStat, cointState!.halflife,
        );
      } else {
        // For paper-mode: fill at the LAST candle's close. Live uses live bid/ask.
        paperExecuteEntry(
          side, zScore, cointState!,
          lastA.close, lastB.close, lastA.time, lastBar,
          cointState!.adfTStat, cointState!.halflife,
        );
      }
    };

    if (zScore < -PAIRS_CONFIG.ENTRY_Z) {
      await tryEntry('long_spread');
    } else if (PAIRS_CONFIG.ALLOW_SHORT_SPREAD && zScore > PAIRS_CONFIG.ENTRY_Z) {
      await tryEntry('short_spread');
    } else if (stats.loopCount % 10 === 1) {
      console.log(
        `[PAIRS] no entry — z=${zScore.toFixed(2)} within ±${PAIRS_CONFIG.ENTRY_Z} ` +
        `(adf=${cointState.adfTStat.toFixed(2)})`,
      );
    }
  } catch (err) {
    console.error(`[PAIRS] loop error: ${(err as Error).message}`);
    console.error((err as Error).stack);
  } finally {
    loopInProgress = false;
  }
}

// Safety interlock: live mode requires BOTH:
//   1. PAIRS_MODE=live
//   2. PAIRS_LIVE_CONFIRMED=yes
// Without #2, live is downgraded to paper to prevent accidental real trading.
let _effectiveMode: 'off' | 'paper' | 'live' = 'off';

function resolveEffectiveMode(): 'off' | 'paper' | 'live' {
  if (PAIRS_CONFIG.MODE === 'off') return 'off';
  if (PAIRS_CONFIG.MODE === 'paper') return 'paper';
  if (PAIRS_CONFIG.MODE === 'live') {
    if (process.env.PAIRS_LIVE_CONFIRMED === 'yes') return 'live';
    console.warn('[PAIRS] PAIRS_MODE=live but PAIRS_LIVE_CONFIRMED is not "yes". Downgrading to paper.');
    return 'paper';
  }
  return 'off';
}

export function initPairsEngine(): void {
  _effectiveMode = resolveEffectiveMode();
  if (_effectiveMode === 'off') {
    console.log('[PAIRS] engine disabled (PAIRS_MODE=off)');
    return;
  }
  initPairsTables();
  adoptOpenTrade();
  console.log(`[PAIRS] engine initialized (mode=${_effectiveMode}, pair=${PAIRS_CONFIG.SYMBOL_A}/${PAIRS_CONFIG.SYMBOL_B})`);
  if (_effectiveMode === 'live') {
    console.warn('[PAIRS] LIVE MODE ACTIVE — preflight check will run on first signal');
  }
}

export function startPairsEngine(): void {
  if (_effectiveMode === 'off') return;
  if (isRunning) {
    console.warn('[PAIRS] already running');
    return;
  }
  isRunning = true;
  loopTimer = setInterval(() => {
    runLoop().catch(err => console.error('[PAIRS] unhandled loop error:', err));
  }, PAIRS_CONFIG.LOOP_INTERVAL_MS);
  // Fire first loop immediately so initial state shows up in logs.
  runLoop().catch(err => console.error('[PAIRS] unhandled first-loop error:', err));

  // Background monitor (margin level, ADF drift, position-state drift).
  // Hooks dispatch through pairsAlerts so Telegram lights up automatically.
  setAlertHandler((e) => {
    if (e.kind === 'margin_critical') alertMarginLow((e.data?.marginLevel as number) ?? 0, true);
    else if (e.kind === 'margin_low') alertMarginLow((e.data?.marginLevel as number) ?? 0, false);
    else if (e.kind === 'state_drift') alertStateDrift(e.message);
    else if (e.kind === 'adf_degraded') alertAdfDegrade((e.data?.adfTStat as number) ?? 0);
  });
  startMonitor(
    () => cointState,
    () => {
      const a = candleCache.a.map(c => Math.log(c.close));
      const b = candleCache.b.map(c => Math.log(c.close));
      return { a, b };
    },
  );

  console.log(`[PAIRS] engine started (interval=${PAIRS_CONFIG.LOOP_INTERVAL_MS}ms)`);
}

/**
 * Force-close the currently open trade, if any. Dispatches to live or paper
 * exit based on _effectiveMode. Safe to call when no trade is open (no-op).
 * Returns an outcome object so the dashboard can show success/failure.
 */
export async function forceClosePairsTrade(reason: string = 'manual_force_close'): Promise<{
  closed: boolean;
  tradeId: string | null;
  message: string;
}> {
  if (!openTrade) {
    return { closed: false, tradeId: null, message: 'no open trade' };
  }
  const tradeId = openTrade.id;
  const lastA = candleCache.a[candleCache.a.length - 1];
  const lastB = candleCache.b[candleCache.b.length - 1];
  const currentZ = cointState && lastA && lastB
    ? ((Math.log(lastA.close) - cointState.alpha - cointState.beta * Math.log(lastB.close)) - cointState.spreadMean) / cointState.spreadStd
    : 0;
  const lastBar = candleCache.a.length - 1;
  try {
    if (_effectiveMode === 'live') {
      await liveExecuteExit(reason, currentZ, lastBar);
    } else {
      if (!lastA || !lastB) {
        return { closed: false, tradeId, message: 'no candle data to compute paper exit' };
      }
      paperExecuteExit(reason, currentZ, lastA.close, lastB.close, lastA.time, lastBar);
    }
    return { closed: openTrade === null, tradeId, message: openTrade === null ? 'closed' : 'exit submitted but trade still tracked (live exit reconciliation pending)' };
  } catch (err) {
    return { closed: false, tradeId, message: `force-close error: ${(err as Error).message}` };
  }
}

export function stopPairsEngine(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  stopMonitor();
  isRunning = false;
  console.log('[PAIRS] engine stopped');
}

// Compute mark-to-market unrealized PnL on the open trade using last-known
// close prices in the candle cache. Mirrors the exit-side math in
// paperExecuteExit / liveExecuteExit minus the slippage haircut (since we
// haven't actually crossed the spread to exit).
function computeMarkAndUnrealized(): {
  markA: number | null;
  markB: number | null;
  unrealizedPnlGross: number | null;
  unrealizedPnlNet: number | null;
  unrealizedPctOfNotional: number | null;
} {
  const lastA = candleCache.a[candleCache.a.length - 1];
  const lastB = candleCache.b[candleCache.b.length - 1];
  const markA = lastA?.close ?? null;
  const markB = lastB?.close ?? null;
  if (!openTrade || markA === null || markB === null) {
    return { markA, markB, unrealizedPnlGross: null, unrealizedPnlNet: null, unrealizedPctOfNotional: null };
  }
  const isLong = openTrade.side === 'long_spread';
  const pnlA = isLong
    ? (markA - openTrade.entryPriceA) * openTrade.qtyA
    : (openTrade.entryPriceA - markA) * openTrade.qtyA;
  const pnlB = isLong
    ? (openTrade.entryPriceB - markB) * openTrade.qtyB
    : (markB - openTrade.entryPriceB) * openTrade.qtyB;
  const gross = pnlA + pnlB;
  // Estimate round-trip fees assuming we'd exit at mark prices. Both legs.
  const notionalA = openTrade.qtyA * openTrade.entryPriceA;
  const notionalB = openTrade.qtyB * openTrade.entryPriceB;
  const fees = (notionalA + notionalB) * PAIRS_CONFIG.FEE_PER_LEG_TAKER;
  const net = gross - fees;
  const totalNotional = notionalA + notionalB;
  return {
    markA, markB,
    unrealizedPnlGross: gross,
    unrealizedPnlNet: net,
    unrealizedPctOfNotional: totalNotional > 0 ? net / totalNotional : null,
  };
}

export function getPairsStatus(): {
  mode: string;
  isRunning: boolean;
  loopCount: number;
  inPosition: boolean;
  paperEntriesOpened: number;
  paperEntriesClosed: number;
  paperPnlTotalUsd: number;
  consecutiveLosses: number;
  pausedUntilTs: number;
  cointegration: PairsLiveState | null;
  symbolA: string;
  symbolB: string;
  markA: number | null;
  markB: number | null;
  unrealizedPnlGross: number | null;
  unrealizedPnlNet: number | null;
  unrealizedPctOfNotional: number | null;
  openTradeId: string | null;
  openTradeSide: 'long_spread' | 'short_spread' | null;
} {
  const mark = computeMarkAndUnrealized();
  return {
    mode: PAIRS_CONFIG.MODE,
    isRunning,
    loopCount: stats.loopCount,
    inPosition: openTrade !== null,
    paperEntriesOpened: stats.paperEntriesOpened,
    paperEntriesClosed: stats.paperEntriesClosed,
    paperPnlTotalUsd: stats.paperPnlTotalUsd,
    consecutiveLosses: stats.consecutiveLosses,
    pausedUntilTs: stats.pausedUntilTs,
    cointegration: cointState,
    symbolA: PAIRS_CONFIG.SYMBOL_A,
    symbolB: PAIRS_CONFIG.SYMBOL_B,
    markA: mark.markA,
    markB: mark.markB,
    unrealizedPnlGross: mark.unrealizedPnlGross,
    unrealizedPnlNet: mark.unrealizedPnlNet,
    unrealizedPctOfNotional: mark.unrealizedPctOfNotional,
    openTradeId: openTrade?.id ?? null,
    openTradeSide: openTrade?.side ?? null,
  };
}
