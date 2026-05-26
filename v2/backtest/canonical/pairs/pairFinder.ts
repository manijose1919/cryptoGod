// Scan a universe of tickers for cointegrated pairs.
//
// Pipeline:
//   1. For all C(n,2) pairs, compute Pearson correlation on log prices.
//   2. Drop pairs with |r| < 0.7 (no point testing cointegration on
//      uncorrelated series — they'll almost certainly fail).
//   3. For surviving pairs, run Engle-Granger 2-step (regress + ADF on resid).
//   4. Compute OU halflife.
//   5. Rank by composite score: prefer low ADF t-stat (more stationary),
//      reasonable halflife (10-200 bars on 1h), and high R².
//
// The output is NOT a list of "tradable pairs" — it's a list of candidates
// for the backtest to evaluate. Cointegration can break; pairs need
// out-of-sample validation (which the sweep provides via walk-forward).

import type { Candle } from '../../../pipeline/types.ts';
import { testCointegration, type CointegrationTest } from './stats.ts';

export interface PairProfile {
  symA: string;   // "y" in the regression
  symB: string;   // "x"
  test: CointegrationTest;
  pairScore: number;  // higher = more attractive to trade
  reason: string;
}

function scorePair(t: CointegrationTest): number {
  // Components:
  //   - ADF t-stat: lower (more negative) = more stationary; reward.
  //   - R²: higher = better fit. Range [0, 1].
  //   - halflife: prefer 10-200 bars. Penalize <5 (too fast, noisy) and >500 (too slow).
  //   - correlation: |r| > 0.7 already filtered; reward stronger.
  const adfComponent = Math.max(0, -t.adfTStat - 1.5);  // 0 at t=-1.5, ~3 at t=-4.5
  const rSqComponent = Math.max(0, t.rSquared - 0.3) * 3;
  let halflifeComponent: number;
  if (!Number.isFinite(t.halflife) || t.halflife < 5) halflifeComponent = 0;
  else if (t.halflife <= 200) halflifeComponent = 2 - Math.abs(Math.log2(t.halflife / 40)) * 0.5;
  else halflifeComponent = Math.max(0, 1 - (t.halflife - 200) / 500);
  const corrComponent = Math.max(0, Math.abs(t.correlation) - 0.7) * 5;
  return adfComponent + rSqComponent + halflifeComponent + corrComponent;
}

export interface FinderOptions {
  minCorrelation: number;     // default 0.7
  minOverlap: number;         // require this many overlapping bars between A and B
  requireAdf5pct: boolean;    // if true, only keep pairs that pass ADF 5%
}

export function findCointegratedPairs(
  candles: Map<string, Candle[]>,
  options: Partial<FinderOptions> = {},
): PairProfile[] {
  const opts: FinderOptions = {
    minCorrelation: options.minCorrelation ?? 0.7,
    minOverlap: options.minOverlap ?? 500,
    requireAdf5pct: options.requireAdf5pct ?? true,
  };

  const tickers = [...candles.keys()];
  const profiles: PairProfile[] = [];

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i], b = tickers[j];
      const ca = candles.get(a);
      const cb = candles.get(b);
      if (!ca || !cb) continue;
      // Align by timestamp — only use bars present in both series.
      const tsToB = new Map(cb.map(c => [c.time, c.close]));
      const aligned_a: number[] = [];
      const aligned_b: number[] = [];
      for (const candle of ca) {
        const bClose = tsToB.get(candle.time);
        if (bClose !== undefined) {
          aligned_a.push(Math.log(candle.close));
          aligned_b.push(Math.log(bClose));
        }
      }
      if (aligned_a.length < opts.minOverlap) continue;
      // Use the most recent N bars to keep tests recency-weighted.
      const N = Math.min(2000, aligned_a.length);
      const ya = aligned_a.slice(-N);
      const xb = aligned_b.slice(-N);

      // Cheap pre-filter.
      const corr = ((): number => {
        let sa = 0, sb = 0;
        for (let k = 0; k < N; k++) { sa += ya[k]; sb += xb[k]; }
        const ma = sa / N, mb = sb / N;
        let cov = 0, va = 0, vb = 0;
        for (let k = 0; k < N; k++) {
          cov += (ya[k] - ma) * (xb[k] - mb);
          va += (ya[k] - ma) ** 2; vb += (xb[k] - mb) ** 2;
        }
        return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
      })();
      if (Math.abs(corr) < opts.minCorrelation) continue;

      // Both directions: regress A on B, and B on A. Pick the one with lower
      // ADF (more stationary residuals). This matters because OLS β depends on
      // which is dependent vs independent.
      const t1 = testCointegration(ya, xb);
      const t2 = testCointegration(xb, ya);
      const better = t1.adfTStat <= t2.adfTStat ? t1 : t2;
      const flipped = t1.adfTStat > t2.adfTStat;
      const symA = flipped ? b : a;
      const symB = flipped ? a : b;

      if (opts.requireAdf5pct && !better.isStationary5pct) continue;

      const score = scorePair(better);
      profiles.push({
        symA, symB,
        test: better,
        pairScore: score,
        reason: `adf=${better.adfTStat.toFixed(2)} hl=${better.halflife.toFixed(0)} r²=${better.rSquared.toFixed(2)}`,
      });
    }
  }

  profiles.sort((a, b) => b.pairScore - a.pairScore);
  return profiles;
}
