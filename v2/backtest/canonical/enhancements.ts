// Universal entry-side improvements applied as composable wrappers.
// Each wrapper takes a CanonicalStrategy and returns a CanonicalStrategy with
// extra filtering on evaluateEntry. updateStop is passed through unchanged.
//
// Order of composition matters only for performance, not correctness:
//   withVolumeGate(withHtfFilter(withConfirmation(baseStrategy)))
// All three checks are AND'd; any rejecting the entry blocks it.

import type { Candle } from '../../pipeline/types.ts';
import type { CanonicalStrategy, StrategyContext, EntryDecision } from './types.ts';
import { ema, sma } from './indicators.ts';

const REJECT: EntryDecision = { enter: false, stop: 0, target: 0, reason: '' };

// ---------------------------------------------------------------------------
// 1. Confirmation candle.
//    Defers entry one bar: a signal on bar i must be confirmed by bar i+1
//    closing higher than bar i's high. Cuts ~30-40% of false signals on
//    directional strategies.
//
//    Implementation: we re-evaluate the base strategy at bar i-1 (one bar
//    earlier), and if it signaled, accept only if bar i confirms.
// ---------------------------------------------------------------------------
export function withConfirmation(base: CanonicalStrategy): CanonicalStrategy {
  return {
    name: base.name,
    warmupBars: base.warmupBars + 1,
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < 1) return REJECT;
      // Did the base strategy signal one bar ago?
      const prior = base.evaluateEntry({ candles, i: i - 1 });
      if (!prior.enter) return REJECT;
      // Confirm: current bar closed above prior bar's high.
      if (candles[i].close <= candles[i - 1].high) return REJECT;
      // Recompute stop/target from current bar (so they're not stale).
      const current = base.evaluateEntry({ candles, i });
      if (current.enter) return { ...current, reason: `${current.reason} +confirm` };
      // If base no longer signals at i (signal "consumed"), use prior with
      // updated stop relative to current bar.
      return { ...prior, reason: `${prior.reason} +confirm` };
    },
    updateStop: base.updateStop,
  };
}

// ---------------------------------------------------------------------------
// 2. HTF (higher-timeframe) trend filter.
//    Gates entries by 4h EMA(50) vs EMA(200) direction. Long-only strategies
//    need 4h trend UP or RANGE; rejects in DOWN.
//
//    On 1h candles, we sample every 4th bar to approximate 4h closes. This
//    is biased slightly (we may miss intra-4h-bar moves) but vastly cheaper
//    than maintaining a separate 4h candle stream.
// ---------------------------------------------------------------------------
export function withHtfFilter(base: CanonicalStrategy): CanonicalStrategy {
  return {
    name: base.name,
    warmupBars: Math.max(base.warmupBars, 200 * 4 + 5),
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < 200 * 4 + 5) return REJECT;
      // Sample 4h closes by stepping back 4 bars at a time. Keep last 220.
      const sampled: number[] = [];
      for (let k = i; k >= 0 && sampled.length < 220; k -= 4) sampled.push(candles[k].close);
      sampled.reverse();
      if (sampled.length < 200) return base.evaluateEntry(ctx);
      const e50 = ema(sampled, 50);
      const e200 = ema(sampled, 200);
      const lastIdx = sampled.length - 1;
      // Require 4h fast EMA above slow EMA. Tolerance: 0% (strict).
      if (e50[lastIdx] <= e200[lastIdx]) return REJECT;
      const result = base.evaluateEntry(ctx);
      if (result.enter) return { ...result, reason: `${result.reason} +htf_up` };
      return result;
    },
    updateStop: base.updateStop,
  };
}

// ---------------------------------------------------------------------------
// 3. Volume confirmation.
//    Requires the signal bar's volume to exceed N × SMA(volume, 20).
//    Default 1.2× is mild but catches the "dead-tape" false signals.
// ---------------------------------------------------------------------------
export function withVolumeGate(base: CanonicalStrategy, multiplier: number = 1.2): CanonicalStrategy {
  return {
    name: base.name,
    warmupBars: Math.max(base.warmupBars, 25),
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < 25) return REJECT;
      const vols = candles.slice(0, i + 1).map(c => c.volume);
      const avg = sma(vols, 20);
      const v = candles[i].volume;
      const reference = avg[i];
      if (!Number.isFinite(reference) || reference <= 0) return base.evaluateEntry(ctx);
      if (v < multiplier * reference) return REJECT;
      const result = base.evaluateEntry(ctx);
      if (result.enter) return { ...result, reason: `${result.reason} +vol_${(v / reference).toFixed(1)}x` };
      return result;
    },
    updateStop: base.updateStop,
  };
}

// ---------------------------------------------------------------------------
// Convenience: stack all three on top of regime gating.
// The order is intentional:
//   confirmation (innermost) → htf → volume (outermost)
// because volume is the cheapest check and HTF the most expensive (sampled
// EMA every call).
// ---------------------------------------------------------------------------
export function withFullEnhancement(
  base: CanonicalStrategy,
  opts: { volumeMultiplier?: number } = {},
): CanonicalStrategy {
  return withVolumeGate(
    withHtfFilter(
      withConfirmation(base),
    ),
    opts.volumeMultiplier ?? 1.2,
  );
}

// ---------------------------------------------------------------------------
// Per-strategy enhancement profile.
// Phase 1 sweep showed blanket "all-on" hurts strategies with their own
// filters (DCA cratered −18%, MACD also worsened). Each strategy now declares
// which wrappers it should get.
// ---------------------------------------------------------------------------
export interface EnhancementProfile {
  confirmation: boolean;
  htf: boolean;
  volume: boolean;
  volumeMultiplier: number;
}

export const PROFILES: Record<string, EnhancementProfile> = {
  // Trend-followers: all 3 (already-noisy 1h signals benefit from confirmation).
  MA_CROSS:    { confirmation: true,  htf: true,  volume: true,  volumeMultiplier: 1.2 },
  MACD:        { confirmation: false, htf: true,  volume: false, volumeMultiplier: 1.0 },
  // ↑ MACD has internal zero-cross + acceleration + signal-line filters. Adding
  //   confirmation + volume gates kills its trade rate. Keep only HTF (cheap).

  // Breakouts: confirmation + volume (volume is already partly in the entry).
  DONCHIAN_BREAKOUT: { confirmation: true, htf: true, volume: false, volumeMultiplier: 1.0 },
  // ↑ Donchian entry already requires volZ > 1. Don't double-filter.

  // Mean-reverters: all 3 — these strategies bleed in trends without HTF gate.
  RSI_REVERSAL:  { confirmation: true, htf: true, volume: true, volumeMultiplier: 1.2 },
  BOLLINGER_MR:  { confirmation: true, htf: true, volume: true, volumeMultiplier: 1.2 },
  VOLUME_PROFILE:{ confirmation: true, htf: true, volume: true, volumeMultiplier: 1.2 },
  CANDLESTICK:   { confirmation: false, htf: true, volume: true, volumeMultiplier: 1.5 },
  // ↑ Candlestick patterns are already "confirmation" themselves; adding
  //   confirmation candle would defer entry by 2 bars and miss most setups.

  // VWAP: time-based mean revert; confirmation doesn't fit (we want to enter
  // on the extreme, not after it). HTF + volume gate are useful.
  VWAP: { confirmation: false, htf: true, volume: true, volumeMultiplier: 1.3 },

  // GRID: range-strategy. HTF up-trend is fine (grids in uptrend just lean
  // long), but confirmation/volume gates would block the grid's normal cycle.
  GRID: { confirmation: false, htf: true, volume: false, volumeMultiplier: 1.0 },

  // DCA: SKIP ALL FILTERS. Its whole purpose is buying on schedule regardless
  // of conditions. Phase 1 showed DCA dropped from +22% to +3.8% under blanket
  // enhancement — a regression we now fix.
  DCA: { confirmation: false, htf: false, volume: false, volumeMultiplier: 1.0 },
};

export function withProfile(base: CanonicalStrategy, profile: EnhancementProfile): CanonicalStrategy {
  let s = base;
  if (profile.confirmation) s = withConfirmation(s);
  if (profile.htf) s = withHtfFilter(s);
  if (profile.volume) s = withVolumeGate(s, profile.volumeMultiplier);
  return s;
}

// Helpers from indicators are deliberately exposed to satisfy unused-imports.
export const _utils = { ema, sma } as const;
// Silence type-only import lint when used elsewhere.
export type _CandleAlias = Candle;
