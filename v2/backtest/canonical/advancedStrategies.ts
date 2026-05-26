// Phase 2 strategy variants — divergence detection, pullback entries.
// Kept separate from strategies.ts so the original blueprints stay clean and
// these advanced variants don't get folded into the canonical baseline.

import type { CanonicalStrategy, EntryDecision, StrategyContext } from './types.ts';
import { atr, macd, donchianHigh } from './indicators.ts';

const NO_ENTRY: EntryDecision = { enter: false, stop: 0, target: 0, reason: '' };

// ---------------------------------------------------------------------------
// MACD Bullish Divergence (Blueprint #8 — the real signal).
//
// Pattern: price makes a Lower Low (LL) but MACD histogram makes a Higher Low
// (HL). Indicates downward momentum exhaustion.
//
// Swing detection: 2-bar fractal — a swing low at bar `k` requires
//   low[k] < low[k-2], low[k-1], low[k+1], low[k+2]
// This means the most recent confirmed swing is at i-2 (we need 2 bars
// AFTER the swing to confirm). Signals fire 2 bars late but are stable.
//
// Compare the 2 most recent confirmed swings:
//   - price[swing2].low < price[swing1].low   (Lower Low in price)
//   - hist[swing2]      > hist[swing1]        (Higher Low in histogram)
// Both true → bullish divergence → enter.
// ---------------------------------------------------------------------------
export interface MacdDivergenceParams {
  fast: number;        // 12
  slow: number;        // 26
  signal: number;      // 9
  swingLookback: number; // 50 — search radius for finding 2 swings
  fractalWidth: number;  // 2 — bars on each side for swing confirmation
  minSwingGap: number;   // 5 — min bars between the two swings
  atrStopMult: number;   // 1.5
  atrTargetMult: number; // 3.0
  requireHistNegative: boolean;  // true — both swings should be in negative-hist territory
}
export const MACD_DIV_DEFAULTS: MacdDivergenceParams = {
  fast: 12, slow: 26, signal: 9,
  swingLookback: 50, fractalWidth: 2, minSwingGap: 5,
  atrStopMult: 1.5, atrTargetMult: 3.0,
  requireHistNegative: true,
};

// Returns confirmed swing-low bar indices in ascending order, restricted to
// [i - lookback, i - fractalWidth].
function findSwingLows(
  lows: number[], from: number, to: number, fractalWidth: number,
): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k++) {
    if (k - fractalWidth < 0 || k + fractalWidth >= lows.length) continue;
    let isSwing = true;
    for (let d = 1; d <= fractalWidth; d++) {
      if (lows[k] >= lows[k - d] || lows[k] >= lows[k + d]) { isSwing = false; break; }
    }
    if (isSwing) out.push(k);
  }
  return out;
}

export function makeMacdDivergence(p: MacdDivergenceParams = MACD_DIV_DEFAULTS): CanonicalStrategy {
  return {
    name: 'MACD',  // share the MACD name so reporting groups them
    warmupBars: p.slow + p.signal + p.swingLookback + 5,
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.slow + p.signal + p.swingLookback + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const lows = candles.slice(0, i + 1).map(c => c.low);
      const m = macd(closes, p.fast, p.slow, p.signal);
      const a = atr(candles.slice(0, i + 1), 14);

      // Look for swings in range [i - lookback, i - fractalWidth].
      const swings = findSwingLows(
        lows,
        Math.max(p.fractalWidth, i - p.swingLookback),
        i - p.fractalWidth,
        p.fractalWidth,
      );
      if (swings.length < 2) return NO_ENTRY;
      const s1 = swings[swings.length - 2];
      const s2 = swings[swings.length - 1];
      if (s2 - s1 < p.minSwingGap) return NO_ENTRY;

      const priceLL = lows[s2] < lows[s1];
      const histHL = m.hist[s2] > m.hist[s1];
      if (!priceLL || !histHL) return NO_ENTRY;

      // Optional: both swings should be in negative histogram territory.
      // This filters out divergences in already-strong uptrends (which usually
      // don't reverse productively).
      if (p.requireHistNegative && (m.hist[s1] >= 0 || m.hist[s2] >= 0)) return NO_ENTRY;

      // Confirmation: current bar must close above the swing high between
      // s2 and i. This ensures the divergence has actually started to play out.
      let highBetween = -Infinity;
      for (let k = s2; k <= i; k++) if (candles[k].high > highBetween) highBetween = candles[k].high;
      if (candles[i].close < lows[s2] + 0.5 * (highBetween - lows[s2])) return NO_ENTRY;

      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const price = candles[i].close;
      return {
        enter: true,
        stop: lows[s2] - 0.5 * atrAbs,           // stop below the divergence low
        target: price + p.atrTargetMult * atrAbs,
        reason: `div s1=${s1}/h=${m.hist[s1].toFixed(3)} s2=${s2}/h=${m.hist[s2].toFixed(3)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Donchian Breakout — Pullback Entry mode.
//
// Standard breakout enters on the break bar's close. Often that's the worst
// fill price (everyone sees the same level). Pullback variant:
//   1. Detect breakout: close[i] > prior-N high.
//   2. Wait up to maxWaitBars for price to retest the broken level.
//   3. Enter on a green bar where low touches the level and close rebounds.
//   4. If maxWaitBars passes without retest, give up on this signal.
//
// This is a stateful pattern; we encode the wait by carrying state in a
// module-scope Map keyed by ticker. The runner is single-position so
// concurrent tickers don't interfere here.
// ---------------------------------------------------------------------------
export interface DonchianPullbackParams {
  lookback: number;        // 20
  volZThreshold: number;   // 1.0
  maxWaitBars: number;     // 8 — give up if no retest
  retestProximityPct: number; // 0.005 — within 0.5% of broken level
  stopAtrPad: number;      // 0.25
  trailAtrMult: number;    // 2.0
}
export const DONCHIAN_PB_DEFAULTS: DonchianPullbackParams = {
  lookback: 20, volZThreshold: 1.0, maxWaitBars: 8,
  retestProximityPct: 0.005, stopAtrPad: 0.25, trailAtrMult: 2.0,
};

// Pending-signal state per strategy instance. Each makeDonchianPullback()
// closure gets its own Map so multiple param variants don't collide.
export function makeDonchianPullback(p: DonchianPullbackParams = DONCHIAN_PB_DEFAULTS): CanonicalStrategy {
  // Pending breakout: { breakBar, level, expiresAtBar }. One per "instance".
  // Backtest is single-position single-ticker per run so a single state slot
  // is fine.
  let pending: { breakBar: number; level: number; expiresAtBar: number } | null = null;
  let lastSeenBar = -1;

  return {
    name: 'DONCHIAN_BREAKOUT',
    warmupBars: p.lookback + 10,
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.lookback + 5) return NO_ENTRY;

      // Reset pending if the runner moved backwards (shouldn't happen in
      // normal sweep, but defensive).
      if (i < lastSeenBar) pending = null;
      lastSeenBar = i;

      // Expire stale pending.
      if (pending && i > pending.expiresAtBar) pending = null;

      // If we have a pending signal, check for retest first.
      if (pending) {
        const cur = candles[i];
        const proximity = Math.abs(cur.low - pending.level) / pending.level;
        const closedAbove = cur.close > cur.open && cur.close > pending.level;
        if (proximity <= p.retestProximityPct && closedAbove) {
          const a = atr(candles.slice(0, i + 1), 14);
          const atrAbs = a[i];
          if (!Number.isFinite(atrAbs) || atrAbs <= 0) { pending = null; return NO_ENTRY; }
          const stop = cur.low - p.stopAtrPad * atrAbs;
          const reason = `pullback level=${pending.level.toFixed(4)} from bar ${pending.breakBar}`;
          pending = null;  // consume
          return { enter: true, stop, target: 0, reason };
        }
        // Still waiting; don't also create a new pending this bar.
        return NO_ENTRY;
      }

      // No pending — look for fresh breakout.
      const level = donchianHigh(candles, i, p.lookback);
      if (!Number.isFinite(level)) return NO_ENTRY;
      if (candles[i].close <= level) return NO_ENTRY;
      // volZ inline (matches base strategy's threshold).
      let volSum = 0;
      for (let k = i - p.lookback; k < i; k++) volSum += candles[k].volume;
      const volMean = volSum / p.lookback;
      let varSum = 0;
      for (let k = i - p.lookback; k < i; k++) varSum += (candles[k].volume - volMean) ** 2;
      const volSd = Math.sqrt(varSum / p.lookback);
      const vz = volSd > 0 ? (candles[i].volume - volMean) / volSd : 0;
      if (vz < p.volZThreshold) return NO_ENTRY;

      // Register the breakout, wait for retest. Don't enter yet.
      pending = { breakBar: i, level, expiresAtBar: i + p.maxWaitBars };
      return NO_ENTRY;
    },
    updateStop(ctx, _entry, currentStop, peak) {
      const a = atr(ctx.candles.slice(0, ctx.i + 1), 14);
      const atrAbs = a[ctx.i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return currentStop;
      const candidate = peak - p.trailAtrMult * atrAbs;
      return candidate > currentStop ? candidate : currentStop;
    },
  };
}
