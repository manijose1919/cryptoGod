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
    }
  } else {
    stats.consecutiveLosses = 0;
  }
  console.log(
    `[PAIRS] PAPER EXIT ${openTrade.side} reason=${reason} z=${exitZ.toFixed(2)} ` +
    `pnl_net=$${pnlNet.toFixed(2)} (gross=$${pnlGross.toFixed(2)}, fees=$${fees.toFixed(2)}) ` +
    `hold=${holdBars}bars total=$${stats.paperPnlTotalUsd.toFixed(2)}`,
  );
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

      // Mean-revert exit.
      if (Math.abs(zScore) < PAIRS_CONFIG.EXIT_Z) {
        paperExecuteExit(`mean_revert z=${zScore.toFixed(2)}`, zScore, lastA.close, lastB.close, lastA.time, lastBar);
        return;
      }
      // Stop z (spread ran further than expected).
      if (Math.abs(zScore) > PAIRS_CONFIG.STOP_Z) {
        paperExecuteExit(`stop_z z=${zScore.toFixed(2)}`, zScore, lastA.close, lastB.close, lastA.time, lastBar);
        return;
      }
      // Time stop.
      if (barsSinceEntry >= PAIRS_CONFIG.MAX_HOLD_BARS && openTrade.entryBar > 0) {
        paperExecuteExit('time_stop', zScore, lastA.close, lastB.close, lastA.time, lastBar);
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
        paperExecuteExit(`drawdown_kill (${(unrealizedPct * 100).toFixed(2)}%)`, zScore, lastA.close, lastB.close, lastA.time, lastBar);
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
      return;
    }

    if (zScore < -PAIRS_CONFIG.ENTRY_Z) {
      const lastA = aligned.a[lastBar];
      const lastB = aligned.b[lastBar];
      // For paper-mode: fill at the LAST candle's close (we don't have a "next bar"
      // in live since the most recent bar is the most recent). This deviates from
      // the backtest's next-bar-open convention — see deployment plan section 6.
      paperExecuteEntry('long_spread', zScore, cointState, lastA.close, lastB.close, lastA.time, lastBar, cointState.adfTStat, cointState.halflife);
    } else if (PAIRS_CONFIG.ALLOW_SHORT_SPREAD && zScore > PAIRS_CONFIG.ENTRY_Z) {
      const lastA = aligned.a[lastBar];
      const lastB = aligned.b[lastBar];
      paperExecuteEntry('short_spread', zScore, cointState, lastA.close, lastB.close, lastA.time, lastBar, cointState.adfTStat, cointState.halflife);
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

export function initPairsEngine(): void {
  if (PAIRS_CONFIG.MODE === 'off') {
    console.log('[PAIRS] engine disabled (PAIRS_MODE=off)');
    return;
  }
  if (PAIRS_CONFIG.MODE === 'live') {
    // Hard refusal — live executor not yet implemented.
    console.error('[PAIRS] live mode requested but live executor NOT implemented. Refusing to start.');
    console.error('[PAIRS] Set PAIRS_MODE=paper or wait for next session.');
    return;
  }
  initPairsTables();
  adoptOpenTrade();
  console.log(`[PAIRS] engine initialized (mode=${PAIRS_CONFIG.MODE}, pair=${PAIRS_CONFIG.SYMBOL_A}/${PAIRS_CONFIG.SYMBOL_B})`);
}

export function startPairsEngine(): void {
  if (PAIRS_CONFIG.MODE === 'off') return;
  if (PAIRS_CONFIG.MODE === 'live') return;  // refused in initPairsEngine
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
  console.log(`[PAIRS] engine started (interval=${PAIRS_CONFIG.LOOP_INTERVAL_MS}ms)`);
}

export function stopPairsEngine(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  isRunning = false;
  console.log('[PAIRS] engine stopped');
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
} {
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
  };
}
