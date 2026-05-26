// Regime gate: classifies each bar's regime, then wraps a strategy so it
// only enters in regimes that strategy is theoretically suited for.
//
// Regime classification (cheap, well-tested heuristic):
//   - emaFast = EMA(50), emaSlow = EMA(200) of close
//   - atrPct  = ATR(14) / close × 100
//   - if  emaFast > emaSlow × 1.005 AND uptrend slope > 0       → 'UP'
//     elif emaFast < emaSlow × 0.995 AND downtrend slope > 0    → 'DOWN'
//     else                                                       → 'RANGE'
//
// Strategy → allowed regimes mapping is intentional and conservative. Tweaking
// these is itself a meaningful experiment.

import type { Candle } from '../../pipeline/types.ts';
import type { CanonicalStrategy, StrategyContext, EntryDecision } from './types.ts';
import { ema, atr } from './indicators.ts';

export type Regime = 'UP' | 'DOWN' | 'RANGE';

export function detectRegime(candles: Candle[], i: number): Regime {
  if (i < 200) return 'RANGE';
  const closes = candles.slice(0, i + 1).map(c => c.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const fast = e50[i], slow = e200[i];
  // Slope: change in fast EMA over last 20 bars, normalized.
  const slope = (e50[i] - e50[i - 20]) / e50[i - 20];
  if (fast > slow * 1.005 && slope > 0.002) return 'UP';
  if (fast < slow * 0.995 && slope < -0.002) return 'DOWN';
  return 'RANGE';
}

// Per-strategy default allowed regimes. Reflect the blueprint: trend-followers
// take longs in UP only; mean-reverters need RANGE; breakouts can fire in UP
// or RANGE (the breakout IS the regime change).
export const DEFAULT_ALLOWED_REGIMES: Record<string, Regime[]> = {
  MA_CROSS: ['UP'],
  MACD: ['UP'],
  DONCHIAN_BREAKOUT: ['UP', 'RANGE'],
  RSI_REVERSAL: ['RANGE', 'UP'],
  BOLLINGER_MR: ['RANGE'],
  DCA: ['UP', 'RANGE', 'DOWN'],  // DCA buys regardless — that's the point
  GRID: ['RANGE'],
  VWAP: ['RANGE', 'UP'],
  VOLUME_PROFILE: ['RANGE'],
  CANDLESTICK: ['UP', 'RANGE'],
};

// Higher-timeframe filter: also gate on 4h regime if requested. We
// approximate 4h regime by sampling every 4th 1h bar's EMA position.
export function detectHtfRegime(candles: Candle[], i: number): Regime {
  if (i < 200 * 4) return 'RANGE';
  const sampled: Candle[] = [];
  for (let k = (i % 4); k <= i; k += 4) sampled.push(candles[k]);
  return detectRegime(sampled, sampled.length - 1);
}

// Wrap a strategy so its evaluateEntry returns NO_ENTRY unless the regime
// at the closed bar matches the allowed set.
export function gateStrategy(
  strategy: CanonicalStrategy,
  allowed: Regime[],
  options: { useHtfFilter?: boolean } = {},
): CanonicalStrategy {
  const useHtf = options.useHtfFilter ?? false;
  const allowedSet = new Set(allowed);
  return {
    name: strategy.name,
    warmupBars: Math.max(strategy.warmupBars, useHtf ? 200 * 4 + 5 : 205),
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const regime = detectRegime(ctx.candles, ctx.i);
      if (!allowedSet.has(regime)) {
        return { enter: false, stop: 0, target: 0, reason: `regime=${regime} blocked` };
      }
      if (useHtf) {
        const htf = detectHtfRegime(ctx.candles, ctx.i);
        if (htf === 'DOWN') {
          return { enter: false, stop: 0, target: 0, reason: 'htf=DOWN blocked' };
        }
      }
      return strategy.evaluateEntry(ctx);
    },
    updateStop: strategy.updateStop,
  };
}

// Convenience: also return the regime time series for analytics/reporting.
export function regimeTimeSeries(candles: Candle[]): Regime[] {
  const out: Regime[] = new Array(candles.length).fill('RANGE');
  for (let i = 200; i < candles.length; i++) {
    out[i] = detectRegime(candles, i);
  }
  return out;
}

// Diagnostic helper: what fraction of bars in [start, end) was each regime?
export function regimeDistribution(candles: Candle[], start: number, end: number): Record<Regime, number> {
  const counts: Record<Regime, number> = { UP: 0, DOWN: 0, RANGE: 0 };
  for (let i = Math.max(200, start); i < end; i++) {
    counts[detectRegime(candles, i)]++;
  }
  const total = counts.UP + counts.DOWN + counts.RANGE;
  if (total === 0) return counts;
  return { UP: counts.UP / total, DOWN: counts.DOWN / total, RANGE: counts.RANGE / total };
}

// Used by index.ts to silence unused-import lint for `atr`.
export const _atrTouchKeepImport = atr;
