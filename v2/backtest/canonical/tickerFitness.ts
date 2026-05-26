// Per-ticker characteristic profiling + per-strategy fitness scoring.
//
// The key non-circular idea: instead of picking tickers by backtest results
// (which overfits to history), we measure each ticker's *structural*
// properties and match to what each strategy theoretically needs.
//
//   Hurst H > 0.55 → trending behavior, persistent moves
//   Hurst H < 0.45 → mean-reverting, range-bound
//   Hurst H ≈ 0.5  → random walk
//
//   ATR%        → typical per-bar volatility (need enough to beat fees)
//   drift       → period return / period; magnitude indicates directional flow
//   volStdRatio → std(volume) / mean(volume) — proxy for volume spikiness
//                  (high = good for breakout/VP; low = good for grid/DCA)
//   rangeBound  → 1 - |drift| × scaling — high when price hasn't drifted far
//
// These are all closed-form computations on candles. NOT backtest results.

import type { Candle } from '../../pipeline/types.ts';
import { atr } from './indicators.ts';

export interface TickerProfile {
  ticker: string;
  bars: number;
  hurst: number;          // 0–1, ~0.5 = random walk
  realizedVolPct: number; // annualized log-return std, %
  avgAtrPct: number;      // mean ATR(14)/price over window, %
  driftPct: number;       // (last - first) / first, %
  absDriftPct: number;    // |driftPct|
  volStdRatio: number;    // stdev(volume) / mean(volume)
  rangeBoundScore: number;// [0, 1] — high = price stayed near start
  trendScore: number;     // [0, 1] — high = directional persistence
  liquidity: number;      // mean dollar-volume per bar
}

// Hurst exponent via rescaled range (R/S) analysis on log returns.
// Returns 0.5 for random walk, > 0.5 for trending, < 0.5 for mean-reverting.
// We sample multiple window sizes and fit log(R/S) ~ H × log(N).
export function hurstExponent(closes: number[]): number {
  if (closes.length < 100) return 0.5;
  const logRet: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logRet.push(Math.log(closes[i] / closes[i - 1]));
  }
  const windows = [10, 20, 40, 80, 160].filter(w => w <= logRet.length / 2);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of windows) {
    let rsSum = 0;
    let chunks = 0;
    for (let start = 0; start + n <= logRet.length; start += n) {
      const seg = logRet.slice(start, start + n);
      const mean = seg.reduce((s, x) => s + x, 0) / n;
      const centered = seg.map(x => x - mean);
      // cumulative sum of centered
      let cum = 0;
      let mn = Infinity, mx = -Infinity;
      for (const c of centered) {
        cum += c;
        if (cum < mn) mn = cum;
        if (cum > mx) mx = cum;
      }
      const range = mx - mn;
      // std of segment
      const variance = centered.reduce((s, c) => s + c * c, 0) / n;
      const sd = Math.sqrt(variance);
      if (sd > 0 && range > 0) {
        rsSum += range / sd;
        chunks++;
      }
    }
    if (chunks > 0) {
      xs.push(Math.log(n));
      ys.push(Math.log(rsSum / chunks));
    }
  }
  if (xs.length < 2) return 0.5;
  // Simple linear regression slope.
  const xMean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return 0.5;
  return Math.max(0, Math.min(1, num / den));
}

export function profileTicker(ticker: string, candles: Candle[]): TickerProfile {
  const closes = candles.map(c => c.close);
  const logRet: number[] = [];
  for (let i = 1; i < closes.length; i++) logRet.push(Math.log(closes[i] / closes[i - 1]));
  const mean = logRet.reduce((s, x) => s + x, 0) / Math.max(1, logRet.length);
  const variance = logRet.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, logRet.length);
  // Annualize a 1h-bar return std: sqrt(24 × 365) ≈ 92.7
  const annualizedVol = Math.sqrt(variance) * Math.sqrt(24 * 365);

  const atrSeries = atr(candles, 14);
  const atrPctVals: number[] = [];
  for (let i = 14; i < candles.length; i++) {
    if (Number.isFinite(atrSeries[i]) && candles[i].close > 0) {
      atrPctVals.push((atrSeries[i] / candles[i].close) * 100);
    }
  }
  const avgAtrPct = atrPctVals.length > 0
    ? atrPctVals.reduce((s, x) => s + x, 0) / atrPctVals.length
    : 0;

  const driftPct = candles.length > 1
    ? ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100
    : 0;
  const absDriftPct = Math.abs(driftPct);

  const volumes = candles.map(c => c.volume);
  const volMean = volumes.reduce((s, v) => s + v, 0) / Math.max(1, volumes.length);
  const volVariance = volumes.reduce((s, v) => s + (v - volMean) ** 2, 0) / Math.max(1, volumes.length);
  const volStdRatio = volMean > 0 ? Math.sqrt(volVariance) / volMean : 0;

  const liquidity = candles
    .map(c => c.close * c.volume)
    .reduce((s, v) => s + v, 0) / Math.max(1, candles.length);

  const hurst = hurstExponent(closes);

  // Range-bound score: high when drift small relative to vol.
  // A truly range-bound market drifts ≤ vol; a trending market drifts >> vol.
  const rangeBoundScore = annualizedVol > 0
    ? Math.max(0, Math.min(1, 1 - absDriftPct / (annualizedVol * 0.6)))
    : 0;

  // Trend score: combines hurst > 0.5 with magnitude of move.
  // Penalizes choppy-but-flat (hurst > 0.5 but tiny drift) — useful trend
  // requires both direction AND persistence.
  const trendScore = Math.max(0, hurst - 0.5) * 2 * Math.min(1, absDriftPct / 30);

  return {
    ticker,
    bars: candles.length,
    hurst,
    realizedVolPct: annualizedVol * 100,
    avgAtrPct,
    driftPct,
    absDriftPct,
    volStdRatio,
    rangeBoundScore,
    trendScore,
    liquidity,
  };
}

// Strategy → fitness scorer.
// Each scorer returns a number; tickers with higher scores are theoretically
// better suited to that strategy. Scores are NOT comparable across strategies.
export type StrategyFitnessKey =
  | 'MA_CROSS' | 'RSI_REVERSAL' | 'BOLLINGER_MR' | 'MACD' | 'DONCHIAN_BREAKOUT'
  | 'DCA' | 'GRID' | 'VWAP' | 'VOLUME_PROFILE' | 'CANDLESTICK';

// Helper: lower-hurst-is-better score (for mean-reverters). Always positive,
// peaks at hurst=0, decays to 0 at hurst=0.8. Works even when whole market
// has hurst > 0.5 — ranks the LEAST trending tickers highest.
function meanRevertScore(hurst: number): number {
  return Math.max(0, 1 - hurst / 0.7);  // hurst 0.5 → 0.29, 0.6 → 0.14, 0.7 → 0
}
// Helper: relative range-bound score that doesn't zero out.
// Uses ratio of |drift| to realized vol; ranks lower drift higher even when
// every ticker has drift > vol.
function relativeRangeBound(p: TickerProfile): number {
  const driftPerVol = p.realizedVolPct > 0 ? p.absDriftPct / p.realizedVolPct : 10;
  return 1 / (1 + driftPerVol);  // 1 at no drift, 0.5 at drift = vol, → 0 as drift dominates
}

export const STRATEGY_FITNESS: Record<StrategyFitnessKey, (p: TickerProfile) => number> = {
  // Trend-following: persistence × move magnitude × volatility.
  MA_CROSS: p => p.trendScore * (p.avgAtrPct > 0.5 ? 1 : 0.3),
  MACD: p => p.trendScore * Math.min(1.5, p.avgAtrPct / 0.8),

  // Mean reversion: least-trending tickers with enough vol to beat fees.
  // Additive (not multiplicative) so a 0 in one factor doesn't zero everything.
  RSI_REVERSAL: p => meanRevertScore(p.hurst) * Math.min(1.5, p.avgAtrPct / 0.8) + 0.5 * relativeRangeBound(p),
  BOLLINGER_MR: p => meanRevertScore(p.hurst) * Math.min(1.5, p.avgAtrPct / 0.8) + 0.5 * relativeRangeBound(p),

  // Breakout: volume spike × vol. Always works regardless of regime.
  DONCHIAN_BREAKOUT: p => p.volStdRatio * Math.min(1, p.avgAtrPct / 1.0),

  // DCA: positive long-term drift × moderate vol. The strategy LOSES on assets
  // that drift down, so heavy penalty for negative drift.
  DCA: p => (p.driftPct > 0 ? p.driftPct / 50 : -p.absDriftPct / 100) * Math.min(1.5, p.realizedVolPct / 80),

  // Grid: HIGH vol × range-bound. Use the additive variant.
  GRID: p => Math.min(2, p.realizedVolPct / 60) * (0.3 + 0.7 * relativeRangeBound(p)),

  // VWAP: liquidity × mean-revert tendency.
  VWAP: p => Math.log(1 + p.liquidity / 1e6) * meanRevertScore(p.hurst),

  // Volume Profile: volume spikiness × mean-revert × vol.
  VOLUME_PROFILE: p => p.volStdRatio * meanRevertScore(p.hurst) * Math.min(1, p.avgAtrPct / 0.8),

  // Candlestick: liquidity, moderate vol (penalize meme-vol where wicks are noise).
  CANDLESTICK: p => Math.log(1 + p.liquidity / 1e6) * Math.max(0, 1 - p.avgAtrPct / 3),
};

export interface TickerRanking {
  strategy: StrategyFitnessKey;
  ranked: { ticker: string; score: number; profile: TickerProfile }[];
}

export function rankTickers(
  profiles: TickerProfile[],
  strategies: StrategyFitnessKey[],
  topN: number = 5,
): Record<StrategyFitnessKey, TickerRanking> {
  const out: Partial<Record<StrategyFitnessKey, TickerRanking>> = {};
  for (const strat of strategies) {
    const scorer = STRATEGY_FITNESS[strat];
    const scored = profiles
      .map(p => ({ ticker: p.ticker, score: scorer(p), profile: p }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    out[strat] = { strategy: strat, ranked: scored };
  }
  return out as Record<StrategyFitnessKey, TickerRanking>;
}
