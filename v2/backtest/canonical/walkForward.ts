// Walk-forward validation.
//
// Splits each window into in-sample (IS) and out-of-sample (OOS) segments.
// For each (strategy × ticker × window):
//   1. Run all param variants on IS bars only.
//   2. Pick the variant with the best IS Net % (≥ 3 trades).
//   3. Re-run THAT variant on OOS bars.
//   4. Report IS Net % side-by-side with OOS Net %.
//
// Honest result: large gap (IS >> OOS) = overfitting. Tight gap = robust edge.
// We compute a per-strategy "fragility ratio" = mean OOS / mean IS.

import type { Candle } from '../../pipeline/types.ts';
import { runBacktest } from './runner.ts';
import { PARAM_GRID } from './sweepParams.ts';
import { gateStrategy, DEFAULT_ALLOWED_REGIMES } from './regimeGate.ts';
import { withProfile, PROFILES, withFullEnhancement } from './enhancements.ts';
import type { StrategyFitnessKey } from './tickerFitness.ts';
import type { CanonicalStrategy, RunResult } from './types.ts';
import { DEFAULT_EXIT_PROFILE, ENHANCED_EXIT_PROFILE, FEE_ROUND_TRIP } from './types.ts';

export interface WalkForwardResult {
  strategy: StrategyFitnessKey;
  ticker: string;
  windowDays: number;
  isStartBar: number;
  isEndBar: number;
  oosStartBar: number;
  oosEndBar: number;
  bestParamLabel: string;
  bestMode: 'raw' | 'gated' | 'enhanced' | 'enhanced-maker';
  isResult: RunResult;
  oosResult: RunResult;
  fragility: number;  // oosNetPct / isNetPct (signed); 1.0 = same; near 0 = collapse
}

export interface WalkForwardConfig {
  strategy: StrategyFitnessKey;
  ticker: string;
  candles: Candle[];
  windowEndBar: number;          // exclusive
  windowDays: number;
  budget: number;
  positionPercent: number;
  slippagePerSide: number;
  isFraction: number;            // e.g., 0.6 = first 60% of window is IS
  modes?: ('raw' | 'gated' | 'enhanced' | 'enhanced-maker')[];
  minTradesInSample: number;     // skip params with < this many IS trades
}

function buildStrategyFor(
  base: CanonicalStrategy,
  allowedRegimes: import('./regimeGate.ts').Regime[],
  mode: 'raw' | 'gated' | 'enhanced' | 'enhanced-maker',
  strategyKey: string,
): CanonicalStrategy {
  switch (mode) {
    case 'raw': return base;
    case 'gated': return gateStrategy(base, allowedRegimes);
    case 'enhanced':
    case 'enhanced-maker': {
      const profile = PROFILES[strategyKey];
      const gated = gateStrategy(base, allowedRegimes);
      return profile ? withProfile(gated, profile) : withFullEnhancement(gated);
    }
  }
}

export function runWalkForward(cfg: WalkForwardConfig): WalkForwardResult | null {
  const variants = PARAM_GRID[cfg.strategy] ?? [];
  if (variants.length === 0) return null;

  const allowedRegimes = DEFAULT_ALLOWED_REGIMES[cfg.strategy] ?? ['UP', 'RANGE', 'DOWN'];
  const modes = cfg.modes ?? ['raw', 'gated', 'enhanced', 'enhanced-maker'];

  // Compute window bar range.
  const totalBars = cfg.windowDays * 24;  // 1h candles
  const windowStartBar = Math.max(0, cfg.windowEndBar - totalBars);
  const splitBar = windowStartBar + Math.floor((cfg.windowEndBar - windowStartBar) * cfg.isFraction);

  // 1+2. Try all (variant × mode) in-sample; pick best.
  let bestCombo: { variant: typeof variants[0]; mode: typeof modes[0]; result: RunResult } | null = null;
  for (const variant of variants) {
    for (const mode of modes) {
      const baseStrategy = variant.build();
      const strategy = buildStrategyFor(baseStrategy, allowedRegimes, mode, cfg.strategy);
      const useEnhancedExit = (mode === 'enhanced' || mode === 'enhanced-maker');
      const feeRT = mode === 'enhanced-maker' ? FEE_ROUND_TRIP.maker : FEE_ROUND_TRIP.taker;
      const result = runBacktest({
        strategy, ticker: cfg.ticker, candles: cfg.candles,
        startBar: windowStartBar, endBar: splitBar,
        budget: cfg.budget, positionPercent: cfg.positionPercent,
        feeRoundTrip: feeRT, slippagePerSide: cfg.slippagePerSide,
        exitProfile: useEnhancedExit ? ENHANCED_EXIT_PROFILE : DEFAULT_EXIT_PROFILE,
      });
      if (result.totalTrades < cfg.minTradesInSample) continue;
      if (!bestCombo || result.totalPnlPercent > bestCombo.result.totalPnlPercent) {
        bestCombo = { variant, mode, result };
      }
    }
  }

  if (!bestCombo) return null;

  // 3. Re-run that combo on OOS.
  const baseStrategy = bestCombo.variant.build();
  const oosStrategy = buildStrategyFor(baseStrategy, allowedRegimes, bestCombo.mode, cfg.strategy);
  const useEnhancedExit = (bestCombo.mode === 'enhanced' || bestCombo.mode === 'enhanced-maker');
  const feeRT = bestCombo.mode === 'enhanced-maker' ? FEE_ROUND_TRIP.maker : FEE_ROUND_TRIP.taker;
  const oosResult = runBacktest({
    strategy: oosStrategy, ticker: cfg.ticker, candles: cfg.candles,
    startBar: splitBar, endBar: cfg.windowEndBar,
    budget: cfg.budget, positionPercent: cfg.positionPercent,
    feeRoundTrip: feeRT, slippagePerSide: cfg.slippagePerSide,
    exitProfile: useEnhancedExit ? ENHANCED_EXIT_PROFILE : DEFAULT_EXIT_PROFILE,
  });

  // Fragility ratio. Special-case sign agreement:
  //   - Both positive: oos/is is informative
  //   - IS positive, OOS negative: catastrophic overfit (return negative ratio)
  //   - IS negative: doesn't matter much, no edge to begin with
  const isPnl = bestCombo.result.totalPnlPercent;
  const oosPnl = oosResult.totalPnlPercent;
  let fragility: number;
  if (Math.abs(isPnl) < 0.5) fragility = 0;            // IS too thin to compare
  else if (isPnl > 0 && oosPnl < 0) fragility = -1;    // sign flip = total collapse
  else fragility = oosPnl / isPnl;

  return {
    strategy: cfg.strategy,
    ticker: cfg.ticker,
    windowDays: cfg.windowDays,
    isStartBar: windowStartBar,
    isEndBar: splitBar,
    oosStartBar: splitBar,
    oosEndBar: cfg.windowEndBar,
    bestParamLabel: bestCombo.variant.label,
    bestMode: bestCombo.mode,
    isResult: bestCombo.result,
    oosResult,
    fragility,
  };
}
