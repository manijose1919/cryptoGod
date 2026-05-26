// Pairs trading sweep orchestrator. Separate from the main sweep because the
// data model differs (two tickers per "row") and because pair finding is a
// distinct phase that runs once.
//
// Pipeline:
//   1. Load candles for the universe (reuses the main sweep's data).
//   2. Find cointegrated pairs (Engle-Granger + halflife filter).
//   3. Run backtests across each pair × param grid × window.
//   4. Walk-forward validate the top cells.
//   5. Append a "## 9. Pairs Trading" section to the main report.
//
// Used as a library by sweep.ts.

import type { Candle } from '../../../pipeline/types.ts';
import { findCointegratedPairs, type PairProfile } from './pairFinder.ts';
import { runPairsBacktest, type PairsRunResult } from './pairsRunner.ts';
import { type PairsParams, PAIRS_DEFAULTS } from './pairsStrategy.ts';

const PAIRS_BUDGET = 1000;
const PAIRS_POSITION_PCT = 0.5;
const PAIRS_FEE_PER_LEG_TAKER = 0.0026;  // 0.26% per side; round-trip per leg = 0.52% but we charge once per round-trip-per-leg
const PAIRS_FEE_PER_LEG_MAKER = -0.0005; // -0.05% per side (rebate)
const PAIRS_SLIPPAGE = 0.0005;

export interface PairsParamVariant {
  label: string;
  params: PairsParams;
}

export const PAIRS_PARAM_GRID: PairsParamVariant[] = [
  { label: 'default(2σ/0.5σ)', params: PAIRS_DEFAULTS },
  { label: 'tight(1.5σ/0.3σ)', params: { ...PAIRS_DEFAULTS, entryZ: 1.5, exitZ: 0.3 } },
  { label: 'wide(2.5σ/0.5σ)',  params: { ...PAIRS_DEFAULTS, entryZ: 2.5 } },
  { label: 'long-only',         params: { ...PAIRS_DEFAULTS, allowShortSpread: false } },
];

export interface PairsSweepCell {
  pair: PairProfile;
  paramLabel: string;
  windowDays: number;
  mode: 'taker' | 'maker';
  result: PairsRunResult;
}

export interface PairsSweepOutput {
  pairs: PairProfile[];
  cells: PairsSweepCell[];
  walkForward: PairsWalkForwardResult[];
}

export interface PairsWalkForwardResult {
  symA: string;
  symB: string;
  windowDays: number;
  bestParamLabel: string;
  bestMode: 'taker' | 'maker';
  isResult: PairsRunResult;
  oosResult: PairsRunResult;
  fragility: number;
}

export function runPairsSweep(
  candleMap: Map<string, Candle[]>,
  windows: number[],
  endDate: Date,
  options: { topPairs?: number; isFraction?: number } = {},
): PairsSweepOutput {
  const topPairs = options.topPairs ?? 8;
  const isFraction = options.isFraction ?? 0.6;

  console.log('\nScanning for cointegrated pairs...');
  const allPairs = findCointegratedPairs(candleMap, { minCorrelation: 0.7, requireAdf5pct: true });
  console.log(`  Found ${allPairs.length} cointegrated pairs (ADF 5% + |r|>0.7)`);
  const topProfiles = allPairs.slice(0, topPairs);
  for (const p of topProfiles) {
    console.log(`  ${p.symA}/${p.symB} score=${p.pairScore.toFixed(2)} ${p.reason}`);
  }

  const cells: PairsSweepCell[] = [];
  const walkForward: PairsWalkForwardResult[] = [];

  console.log('\nRunning pairs backtests...');
  for (const pair of topProfiles) {
    const cA = candleMap.get(pair.symA);
    const cB = candleMap.get(pair.symB);
    if (!cA || !cB) continue;
    // Align by timestamp.
    const aligned = alignByTime(cA, cB);
    if (aligned.a.length < 500) continue;

    for (const days of windows) {
      const windowStartMs = endDate.getTime() - days * 86_400_000;
      let startBar = 0;
      for (let k = 0; k < aligned.a.length; k++) {
        if (aligned.a[k].time >= windowStartMs) { startBar = k; break; }
      }
      const endBar = aligned.a.length;
      const warmupBars = PAIRS_DEFAULTS.rollingWindow + 10;
      if (startBar < warmupBars) {
        // Window too tight; allow runner to use earlier bars for warmup.
      }
      for (const variant of PAIRS_PARAM_GRID) {
        for (const mode of ['taker', 'maker'] as const) {
          const fee = mode === 'maker' ? PAIRS_FEE_PER_LEG_MAKER : PAIRS_FEE_PER_LEG_TAKER;
          const result = runPairsBacktest({
            symA: pair.symA, symB: pair.symB,
            candlesA: aligned.a, candlesB: aligned.b,
            startBar, endBar,
            warmupBars,
            budget: PAIRS_BUDGET,
            positionPercent: PAIRS_POSITION_PCT,
            feeRoundTripPerLeg: fee,
            slippagePerSide: PAIRS_SLIPPAGE,
            params: variant.params,
          });
          result.windowDays = days;
          cells.push({ pair, paramLabel: variant.label, windowDays: days, mode, result });
        }
      }
    }
  }
  console.log(`  Completed ${cells.length} pair backtests`);

  // Walk-forward on top pairs.
  console.log('\nWalk-forward validation on pairs (60/40)...');
  for (const pair of topProfiles) {
    const cA = candleMap.get(pair.symA);
    const cB = candleMap.get(pair.symB);
    if (!cA || !cB) continue;
    const aligned = alignByTime(cA, cB);
    if (aligned.a.length < 800) continue;
    for (const days of windows) {
      const wf = runPairsWalkForward(pair, aligned.a, aligned.b, days, isFraction);
      if (wf) walkForward.push(wf);
    }
  }
  console.log(`  Walk-forward complete: ${walkForward.length} results\n`);

  return { pairs: allPairs, cells, walkForward };
}

function alignByTime(a: Candle[], b: Candle[]): { a: Candle[]; b: Candle[] } {
  const mapB = new Map(b.map(c => [c.time, c]));
  const outA: Candle[] = [], outB: Candle[] = [];
  for (const ca of a) {
    const cb = mapB.get(ca.time);
    if (cb) { outA.push(ca); outB.push(cb); }
  }
  return { a: outA, b: outB };
}

function runPairsWalkForward(
  pair: PairProfile,
  candlesA: Candle[],
  candlesB: Candle[],
  windowDays: number,
  isFraction: number,
): PairsWalkForwardResult | null {
  const totalBars = windowDays * 24;
  const windowStart = Math.max(0, candlesA.length - totalBars);
  const split = windowStart + Math.floor(totalBars * isFraction);
  const warmupBars = PAIRS_DEFAULTS.rollingWindow + 10;
  if (split - windowStart < 100 || candlesA.length - split < 50) return null;

  // Try all (variant × mode) on IS; pick best.
  let best: { variant: PairsParamVariant; mode: 'taker' | 'maker'; res: PairsRunResult } | null = null;
  for (const variant of PAIRS_PARAM_GRID) {
    for (const mode of ['taker', 'maker'] as const) {
      const fee = mode === 'maker' ? PAIRS_FEE_PER_LEG_MAKER : PAIRS_FEE_PER_LEG_TAKER;
      const res = runPairsBacktest({
        symA: pair.symA, symB: pair.symB,
        candlesA, candlesB,
        startBar: windowStart, endBar: split,
        warmupBars,
        budget: PAIRS_BUDGET, positionPercent: PAIRS_POSITION_PCT,
        feeRoundTripPerLeg: fee, slippagePerSide: PAIRS_SLIPPAGE,
        params: variant.params,
      });
      if (res.totalTrades < 2) continue;
      if (!best || res.totalPnlPercent > best.res.totalPnlPercent) {
        best = { variant, mode, res };
      }
    }
  }
  if (!best) return null;

  const fee = best.mode === 'maker' ? PAIRS_FEE_PER_LEG_MAKER : PAIRS_FEE_PER_LEG_TAKER;
  const oos = runPairsBacktest({
    symA: pair.symA, symB: pair.symB,
    candlesA, candlesB,
    startBar: split, endBar: candlesA.length,
    warmupBars,
    budget: PAIRS_BUDGET, positionPercent: PAIRS_POSITION_PCT,
    feeRoundTripPerLeg: fee, slippagePerSide: PAIRS_SLIPPAGE,
    params: best.variant.params,
  });

  const isPnl = best.res.totalPnlPercent;
  const oosPnl = oos.totalPnlPercent;
  let fragility: number;
  if (Math.abs(isPnl) < 0.5) fragility = 0;
  else if (isPnl > 0 && oosPnl < 0) fragility = -1;
  else fragility = oosPnl / isPnl;

  return {
    symA: pair.symA, symB: pair.symB,
    windowDays,
    bestParamLabel: best.variant.label,
    bestMode: best.mode,
    isResult: best.res,
    oosResult: oos,
    fragility,
  };
}

export function renderPairsReportSection(out: string[], output: PairsSweepOutput): void {
  out.push('## 9. Pairs Trading');
  out.push('');
  out.push('Cross-asset mean reversion: long one ticker, short another, in β-hedged ratios.');
  out.push('Implementation requires margin/futures (short leg); spot-only Kraken cannot execute as-is.');
  out.push('');
  out.push('### Cointegrated pair candidates (top 12 by composite score)');
  out.push('');
  out.push('| Rank | A | B | β | r² | ADF t | Halflife | Score |');
  out.push('|---:|---|---|---:|---:|---:|---:|---:|');
  for (let i = 0; i < Math.min(12, output.pairs.length); i++) {
    const p = output.pairs[i];
    const hl = !Number.isFinite(p.test.halflife) ? '∞' : p.test.halflife.toFixed(0);
    out.push(
      `| ${i + 1} | ${p.symA} | ${p.symB} | ${p.test.beta.toFixed(3)} | ` +
      `${p.test.rSquared.toFixed(2)} | ${p.test.adfTStat.toFixed(2)} | ${hl} | ` +
      `${p.pairScore.toFixed(2)} |`,
    );
  }
  out.push('');

  out.push('### Top profitable backtest cells (≥5 trades)');
  out.push('');
  const profitable = output.cells
    .filter(c => c.result.totalTrades >= 5 && c.result.totalPnlPercent > 0)
    .sort((a, b) => b.result.totalPnlPercent - a.result.totalPnlPercent)
    .slice(0, 20);
  if (profitable.length === 0) {
    out.push('_None — no run produced positive P&L with ≥5 trades._');
  } else {
    out.push('| Pair | Window | Params | Mode | Trades | WR % | PF | Net % | LongSpread/ShortSpread |');
    out.push('|---|---:|---|---|---:|---:|---:|---:|---:|');
    for (const c of profitable) {
      out.push(
        `| ${c.pair.symA}/${c.pair.symB} | ${c.windowDays}d | ${c.paramLabel} | ${c.mode} | ` +
        `${c.result.totalTrades} | ${(c.result.winRate * 100).toFixed(1)} | ` +
        `${Number.isFinite(c.result.profitFactor) ? c.result.profitFactor.toFixed(2) : 'inf'} | ` +
        `${c.result.totalPnlPercent.toFixed(2)} | ` +
        `${c.result.longSpreadTrades}/${c.result.shortSpreadTrades} |`,
      );
    }
  }
  out.push('');

  out.push('### Walk-forward results (60% IS / 40% OOS)');
  out.push('');
  out.push('Top OOS results sorted by OOS Net % (requires ≥ 2 OOS trades):');
  out.push('');
  const wfTop = output.walkForward
    .filter(w => w.oosResult.totalTrades >= 2)
    .sort((a, b) => b.oosResult.totalPnlPercent - a.oosResult.totalPnlPercent)
    .slice(0, 15);
  if (wfTop.length === 0) {
    out.push('_No walk-forward results passed the 2-trade minimum._');
  } else {
    out.push('| Pair | Window | Params/Mode | IS Net % | OOS Net % | Fragility | IS / OOS trades |');
    out.push('|---|---:|---|---:|---:|---:|---:|');
    for (const w of wfTop) {
      const frag = w.fragility === 0 ? '—' : (w.fragility === -1 ? 'sign-flip' : w.fragility.toFixed(2));
      out.push(
        `| ${w.symA}/${w.symB} | ${w.windowDays}d | ${w.bestParamLabel}/${w.bestMode} | ` +
        `${w.isResult.totalPnlPercent.toFixed(2)} | ${w.oosResult.totalPnlPercent.toFixed(2)} | ` +
        `${frag} | ${w.isResult.totalTrades} / ${w.oosResult.totalTrades} |`,
      );
    }
  }
  out.push('');
  out.push('Notes:');
  out.push('- Cointegration is fragile in crypto due to regime changes (halvings, listings, hacks). Pairs that pass ADF 5% on the full sweep window can still fail OOS.');
  out.push('- The short leg simulation assumes shorts are feasible at the entry price. On Kraken spot this requires margin trading (some pairs only) or perpetual futures (separate venue).');
  out.push('- Fees applied per leg per side. With taker fees (0.26%/side), each round-trip pair trade costs ~1% in fees. Maker rebates make a substantial difference here.');
  out.push('');
}
