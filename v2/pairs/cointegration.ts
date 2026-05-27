// Live cointegration state manager.
//
// Wraps the backtest stats module (which is pure functions) with stateful
// maintenance: rolling log-price arrays, periodic β re-estimation, and
// invariant checking before each evaluation.
//
// Why re-export instead of re-implement: the backtest stats module is the
// reference implementation used to validate the strategy. Keeping the live
// engine identical to backtest math is critical for backtest fidelity. The
// rule from CLAUDE.md applies: every strategy needs a backtest harness that
// matches the live code path.

import {
  testCointegration,
  reestimateRecent,
} from './statsImpl.ts';
import type { CointegrationStats } from './statsImpl.ts';

export interface PairsLiveState {
  // Hedge ratio and intercept from most recent OLS.
  alpha: number;
  beta: number;
  // Spread mean and std over the rolling window.
  spreadMean: number;
  spreadStd: number;
  // ADF t-stat — useful for gating new entries when cointegration weakens.
  adfTStat: number;
  // OU halflife of mean reversion (bars). Infinity = non-mean-reverting.
  halflife: number;
  // Bar index of the most recent re-estimate.
  lastReestimateBar: number;
  // R² of the OLS fit at last re-estimate.
  rSquared: number;
}

// Build initial live state from log-price history. Should be called once
// after warmup data has been loaded.
export function buildInitialState(
  logA: number[],
  logB: number[],
  windowEnd: number,
  windowSize: number,
): PairsLiveState {
  const stats = testCointegration(
    logA.slice(Math.max(0, windowEnd - windowSize + 1), windowEnd + 1),
    logB.slice(Math.max(0, windowEnd - windowSize + 1), windowEnd + 1),
  );
  return {
    alpha: stats.alpha,
    beta: stats.beta,
    spreadMean: stats.spreadMean,
    spreadStd: stats.spreadStd,
    adfTStat: stats.adfTStat,
    halflife: stats.halflife,
    lastReestimateBar: windowEnd,
    rSquared: stats.rSquared,
  };
}

// Decide whether re-estimation is due, and refresh state if so.
// Caller passes the most recent bar index.
export function maybeReestimate(
  state: PairsLiveState,
  logA: number[],
  logB: number[],
  currentBar: number,
  reestimateEveryBars: number,
  windowSize: number,
): PairsLiveState {
  const since = currentBar - state.lastReestimateBar;
  if (since < reestimateEveryBars) return state;
  return buildInitialState(logA, logB, currentBar, windowSize);
}

// Compute current spread + z-score using state. Cheap; safe to call every loop.
export function computeCurrentSpread(
  state: PairsLiveState,
  logA_now: number,
  logB_now: number,
): { spread: number; zScore: number } {
  const spread = logA_now - state.alpha - state.beta * logB_now;
  const zScore = state.spreadStd > 0 ? (spread - state.spreadMean) / state.spreadStd : 0;
  return { spread, zScore };
}

// Cheap rolling re-estimate (β + spread stats only, no ADF).
// Use for between-loop incremental updates; full re-estimate runs at the
// reestimate cadence.
export function rollingBetaUpdate(
  logA: number[],
  logB: number[],
  windowEnd: number,
  windowSize: number,
): { alpha: number; beta: number; spreadMean: number; spreadStd: number } {
  return reestimateRecent(logA, logB, windowEnd, windowSize);
}

export type { CointegrationStats };
export { testCointegration } from './statsImpl.ts';
