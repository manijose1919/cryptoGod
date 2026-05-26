// Pairs trading strategy.
//
// Position structure:
//   LONG_SPREAD  = long A, short B   (when spread is below mean)
//   SHORT_SPREAD = short A, long B   (when spread is above mean)
//
// Notation: spread_t = log(price_A_t) - β · log(price_B_t) - α
// β re-estimated periodically (default every reestimateBars).
//
// Entry: |z| > entryZ, in the appropriate direction.
// Exit:  |z| < exitZ (mean-revert hit) OR halflife × halflifeMultiple bars
//        elapsed (time stop) OR β instability detected.
//
// Critical assumption: short-leg is feasible. On spot-only Kraken this is
// not true; you'd need margin (Kraken margin pairs) or futures. The backtest
// simulates the short as if it were available — this measures whether the
// SIGNAL has edge, not whether the implementation is venue-deployable.

export type PairsAction = 'enter_long_spread' | 'enter_short_spread' | 'exit' | 'hold';

export interface PairsParams {
  entryZ: number;          // 2.0 — enter when |z| > this
  exitZ: number;           // 0.5 — exit when |z| < this
  stopZ: number;           // 4.0 — hard stop if |z| > this (spread runs further)
  maxHoldBars: number;     // 200 — time stop if not closed by then
  reestimateBars: number;  // 120 — re-OLS every N bars (β can drift)
  rollingWindow: number;   // 720 — window used for spread mean/std and re-OLS
  // Allow both directions or only one. Many crypto pairs trend; long-spread-only
  // (i.e., only buy A when undervalued vs B) sometimes works better than two-way.
  allowShortSpread: boolean;
}

export const PAIRS_DEFAULTS: PairsParams = {
  entryZ: 2.0, exitZ: 0.5, stopZ: 4.0,
  maxHoldBars: 200, reestimateBars: 120, rollingWindow: 720,
  allowShortSpread: true,
};

export interface PairsState {
  alpha: number;
  beta: number;
  spreadMean: number;
  spreadStd: number;
  lastReestimateBar: number;
}

export interface PairsSignal {
  action: PairsAction;
  zScore: number;
  state: PairsState;
  reason: string;
}

// Re-estimate hedge ratio and spread distribution from a rolling window.
export function reestimate(
  logA: number[], logB: number[], windowEnd: number, windowSize: number,
): PairsState {
  const start = Math.max(0, windowEnd - windowSize + 1);
  const yA = logA.slice(start, windowEnd + 1);
  const xB = logB.slice(start, windowEnd + 1);
  // OLS A on B (re-using stats logic inline to avoid circular import)
  const n = yA.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xB[i]; sy += yA[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (xB[i] - mx) * (yA[i] - my);
    vx += (xB[i] - mx) ** 2;
  }
  const beta = vx > 0 ? cov / vx : 1;
  const alpha = my - beta * mx;
  // Spread = yA - β·xB - α
  const spreads: number[] = new Array(n);
  let smean = 0;
  for (let i = 0; i < n; i++) {
    spreads[i] = yA[i] - alpha - beta * xB[i];
    smean += spreads[i];
  }
  smean /= n;
  let svar = 0;
  for (let i = 0; i < n; i++) svar += (spreads[i] - smean) ** 2;
  svar /= n;
  return {
    alpha, beta,
    spreadMean: smean,
    spreadStd: Math.sqrt(svar),
    lastReestimateBar: windowEnd,
  };
}

export interface PairsEvalCtx {
  logA: number[];
  logB: number[];
  i: number;
  prior: PairsState;     // last known state
  inPosition: 'long_spread' | 'short_spread' | null;
  barsHeld: number;
  params: PairsParams;
}

// One-call evaluator: returns either an enter action with fresh state, or an
// exit/hold action. Caller updates the state when entering.
export function evaluatePairs(ctx: PairsEvalCtx): PairsSignal {
  const { i, prior, params, inPosition, barsHeld } = ctx;
  // Periodic re-estimate.
  let state = prior;
  const since = i - prior.lastReestimateBar;
  if (since >= params.reestimateBars) {
    state = reestimate(ctx.logA, ctx.logB, i, params.rollingWindow);
  }

  if (state.spreadStd <= 0) {
    return { action: 'hold', zScore: 0, state, reason: 'std=0' };
  }
  const currentSpread = ctx.logA[i] - state.alpha - state.beta * ctx.logB[i];
  const z = (currentSpread - state.spreadMean) / state.spreadStd;

  // Manage existing position first.
  if (inPosition) {
    if (barsHeld >= params.maxHoldBars) {
      return { action: 'exit', zScore: z, state, reason: 'time_stop' };
    }
    if (Math.abs(z) > params.stopZ) {
      return { action: 'exit', zScore: z, state, reason: `stop_z=${z.toFixed(2)}` };
    }
    if (Math.abs(z) < params.exitZ) {
      return { action: 'exit', zScore: z, state, reason: `mean_revert z=${z.toFixed(2)}` };
    }
    return { action: 'hold', zScore: z, state, reason: '' };
  }

  // No position: look for entry.
  if (z < -params.entryZ) {
    // Spread is below mean → A is "cheap" relative to B → LONG_SPREAD (long A, short B).
    return { action: 'enter_long_spread', zScore: z, state, reason: `z=${z.toFixed(2)}` };
  }
  if (params.allowShortSpread && z > params.entryZ) {
    return { action: 'enter_short_spread', zScore: z, state, reason: `z=${z.toFixed(2)}` };
  }
  return { action: 'hold', zScore: z, state, reason: '' };
}
