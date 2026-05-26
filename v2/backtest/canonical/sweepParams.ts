// Param sweep grids. Kept small (3-4 combos per strategy) so total run is
// bounded — full sweep is 10 strategies × ~5 tickers × ~4 param combos ×
// 3 windows × 2 gating modes ≈ 1200 runs, ~10 min on commodity hardware.

import type { CanonicalStrategy } from './types.ts';
import {
  makeMaCrossover, makeRsiReversal, makeBollingerMR, makeMacd, makeDonchianBreakout,
  MA_CROSS_DEFAULTS, RSI_REVERSAL_DEFAULTS, BOLLINGER_MR_DEFAULTS, MACD_DEFAULTS, DONCHIAN_DEFAULTS,
} from './strategies.ts';
import {
  makeDca, makeGrid, makeVwap, makeVolumeProfile, makeCandlestick,
  DCA_DEFAULTS, GRID_DEFAULTS, VWAP_DEFAULTS, VP_DEFAULTS, CANDLESTICK_DEFAULTS,
} from './moreStrategies.ts';
import {
  makeMacdDivergence, makeDonchianPullback,
  MACD_DIV_DEFAULTS, DONCHIAN_PB_DEFAULTS,
} from './advancedStrategies.ts';
import type { StrategyFitnessKey } from './tickerFitness.ts';

export interface ParamVariant {
  label: string;
  build: () => CanonicalStrategy;
}

// Each entry: a small grid of meaningful variants for that strategy.
// Default config is always included as a baseline.
export const PARAM_GRID: Record<StrategyFitnessKey, ParamVariant[]> = {
  MA_CROSS: [
    { label: 'default(12/26)', build: () => makeMaCrossover(MA_CROSS_DEFAULTS) },
    { label: 'fast(8/21)', build: () => makeMaCrossover({ ...MA_CROSS_DEFAULTS, fastPeriod: 8, slowPeriod: 21 }) },
    { label: 'slow(20/50)', build: () => makeMaCrossover({ ...MA_CROSS_DEFAULTS, fastPeriod: 20, slowPeriod: 50, minGapPct: 0.005 }) },
    { label: 'looseGap', build: () => makeMaCrossover({ ...MA_CROSS_DEFAULTS, minGapPct: 0.001 }) },
  ],

  RSI_REVERSAL: [
    { label: 'default(30)', build: () => makeRsiReversal(RSI_REVERSAL_DEFAULTS) },
    { label: 'tight(25)', build: () => makeRsiReversal({ ...RSI_REVERSAL_DEFAULTS, oversoldThreshold: 25 }) },
    { label: 'loose(35)', build: () => makeRsiReversal({ ...RSI_REVERSAL_DEFAULTS, oversoldThreshold: 35 }) },
    { label: 'fastRsi(7)', build: () => makeRsiReversal({ ...RSI_REVERSAL_DEFAULTS, rsiPeriod: 7 }) },
  ],

  BOLLINGER_MR: [
    { label: 'default(20,2)', build: () => makeBollingerMR(BOLLINGER_MR_DEFAULTS) },
    { label: 'wider(20,2.5)', build: () => makeBollingerMR({ ...BOLLINGER_MR_DEFAULTS, stdevMult: 2.5 }) },
    { label: 'longer(50,2)', build: () => makeBollingerMR({ ...BOLLINGER_MR_DEFAULTS, smaPeriod: 50 }) },
    { label: 'noSqueeze', build: () => makeBollingerMR({ ...BOLLINGER_MR_DEFAULTS, squeezePercentile: 0.0 }) },
  ],

  MACD: [
    { label: 'default(12/26/9)', build: () => makeMacd(MACD_DEFAULTS) },
    { label: 'macdAboveZero', build: () => makeMacd({ ...MACD_DEFAULTS, requireMacdAboveZero: true }) },
    { label: 'wideStop(2.5atr)', build: () => makeMacd({ ...MACD_DEFAULTS, atrStopMult: 2.5 }) },
    // Phase 2: real divergence detection (replaces zero-cross only)
    { label: 'divergence', build: () => makeMacdDivergence(MACD_DIV_DEFAULTS) },
    { label: 'divergence-loose', build: () => makeMacdDivergence({ ...MACD_DIV_DEFAULTS, requireHistNegative: false }) },
  ],

  DONCHIAN_BREAKOUT: [
    { label: 'default(20)', build: () => makeDonchianBreakout(DONCHIAN_DEFAULTS) },
    { label: 'long(30)', build: () => makeDonchianBreakout({ ...DONCHIAN_DEFAULTS, lookback: 30 }) },
    { label: 'highVol(z2)', build: () => makeDonchianBreakout({ ...DONCHIAN_DEFAULTS, volZThreshold: 2.0 }) },
    // Phase 2: pullback entry variants
    { label: 'pullback(20)', build: () => makeDonchianPullback(DONCHIAN_PB_DEFAULTS) },
    { label: 'pullback(30)', build: () => makeDonchianPullback({ ...DONCHIAN_PB_DEFAULTS, lookback: 30, maxWaitBars: 12 }) },
  ],

  DCA: [
    { label: 'daily', build: () => makeDca(DCA_DEFAULTS) },
    { label: 'weekly', build: () => makeDca({ ...DCA_DEFAULTS, cycleBars: 168, targetPct: 0.20 }) },
    { label: 'tightTP(5%)', build: () => makeDca({ ...DCA_DEFAULTS, targetPct: 0.05 }) },
  ],

  GRID: [
    { label: 'default(1.5%)', build: () => makeGrid(GRID_DEFAULTS) },
    { label: 'wide(3%)', build: () => makeGrid({ ...GRID_DEFAULTS, gridStepPct: 0.03 }) },
    { label: 'narrow(1%)', build: () => makeGrid({ ...GRID_DEFAULTS, gridStepPct: 0.01 }) },
  ],

  VWAP: [
    { label: 'default(-1.5σ)', build: () => makeVwap(VWAP_DEFAULTS) },
    { label: 'tight(-2σ)', build: () => makeVwap({ ...VWAP_DEFAULTS, zEntryThreshold: -2.0 }) },
    { label: 'loose(-1σ)', build: () => makeVwap({ ...VWAP_DEFAULTS, zEntryThreshold: -1.0 }) },
  ],

  VOLUME_PROFILE: [
    { label: 'default(48,30)', build: () => makeVolumeProfile(VP_DEFAULTS) },
    { label: 'long(96,40)', build: () => makeVolumeProfile({ ...VP_DEFAULTS, sessionBars: 96, bins: 40 }) },
    { label: 'tight(48,30,80%)', build: () => makeVolumeProfile({ ...VP_DEFAULTS, vaPercent: 0.8 }) },
  ],

  CANDLESTICK: [
    { label: 'default', build: () => makeCandlestick(CANDLESTICK_DEFAULTS) },
    { label: 'tighter(1%)', build: () => makeCandlestick({ ...CANDLESTICK_DEFAULTS, supportProximityPct: 0.01 }) },
    { label: 'biggerBody(2x)', build: () => makeCandlestick({ ...CANDLESTICK_DEFAULTS, minBodyRatio: 2.0 }) },
  ],
};
