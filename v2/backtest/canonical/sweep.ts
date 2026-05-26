// Full sweep orchestrator. Pipeline:
//   1. Load candles for the candidate universe.
//   2. Profile each ticker (Hurst, vol, drift, etc.).
//   3. For each strategy, pick the top-N tickers by fitness score.
//   4. For each (strategy × top-ticker × param-variant × window × gating)
//      run a backtest.
//   5. Write JSON + markdown report with:
//      a) Ticker fitness tables (so the selection is auditable)
//      b) Best (strategy, ticker, params, gating) cells
//      c) Per-strategy roll-ups
//
// Run: npx tsx v2/backtest/canonical/sweep.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllCandles } from '../candleCache.ts';
// @ts-expect-error JS module without types
import { initializeDatabase } from '../../../services/database.js';
import { runBacktest } from './runner.ts';
import { CANDIDATE_UNIVERSE } from './universe.ts';
import {
  profileTicker, rankTickers,
  type StrategyFitnessKey, type TickerProfile,
} from './tickerFitness.ts';
import { PARAM_GRID } from './sweepParams.ts';
import { gateStrategy, DEFAULT_ALLOWED_REGIMES, regimeDistribution } from './regimeGate.ts';
import type { RunResult } from './types.ts';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const INTERVAL = '1h';
const WINDOWS_DAYS = [30, 60, 90];
const TOP_N_PER_STRATEGY = 4;
const BUDGET = 1000;
const POSITION_PCT = 0.5;
const FEE_ROUND_TRIP = 0.0052;     // Kraken taker
const SLIPPAGE_PER_SIDE = 0.0005;
const MIN_BARS_FOR_TICKER = 1500;  // drop tickers with too little data

const ALL_STRATEGY_KEYS: StrategyFitnessKey[] = [
  'MA_CROSS', 'RSI_REVERSAL', 'BOLLINGER_MR', 'MACD', 'DONCHIAN_BREAKOUT',
  'DCA', 'GRID', 'VWAP', 'VOLUME_PROFILE', 'CANDLESTICK',
];

interface SweepRow {
  strategy: StrategyFitnessKey;
  ticker: string;
  paramLabel: string;
  windowDays: number;
  gating: 'raw' | 'gated';
  result: RunResult;
}

async function main(): Promise<void> {
  initializeDatabase();

  const endDate = new Date();
  const maxWindow = Math.max(...WINDOWS_DAYS);
  // Pad +90d so 200-period EMA on 4h sampling has full warmup.
  const startDate = new Date(endDate.getTime() - (maxWindow + 90) * 86_400_000);

  console.log('\n=== Full Strategy Sweep ===');
  console.log(`Universe   : ${CANDIDATE_UNIVERSE.length} tickers`);
  console.log(`Strategies : ${ALL_STRATEGY_KEYS.length}`);
  console.log(`Windows    : ${WINDOWS_DAYS.join('d, ')}d`);
  console.log(`Interval   : ${INTERVAL}\n`);

  const candleMap = await loadAllCandles(CANDIDATE_UNIVERSE, startDate, endDate, INTERVAL);

  // --- Profile tickers (use the 90d window for stable estimates) ---
  console.log('\nProfiling tickers...');
  const profileWindowMs = endDate.getTime() - 90 * 86_400_000;
  const profiles: TickerProfile[] = [];
  for (const ticker of CANDIDATE_UNIVERSE) {
    const all = candleMap.get(ticker);
    if (!all || all.length < MIN_BARS_FOR_TICKER) {
      console.log(`  ✗ ${ticker}: insufficient data (${all?.length ?? 0} bars)`);
      continue;
    }
    const sliced = all.filter(c => c.time >= profileWindowMs);
    if (sliced.length < 200) {
      console.log(`  ✗ ${ticker}: < 200 bars in window`);
      continue;
    }
    profiles.push(profileTicker(ticker, sliced));
  }
  console.log(`  Profiled ${profiles.length} tickers\n`);

  const rankings = rankTickers(profiles, ALL_STRATEGY_KEYS, TOP_N_PER_STRATEGY);

  console.log('\nTop tickers per strategy:');
  for (const key of ALL_STRATEGY_KEYS) {
    const r = rankings[key];
    const tickerList = r.ranked.map(x => `${x.ticker}(${x.score.toFixed(3)})`).join(', ');
    console.log(`  ${key.padEnd(20)} → ${tickerList}`);
  }

  // --- Run sweep ---
  console.log('\nRunning sweep...');
  const rows: SweepRow[] = [];
  let totalRuns = 0;

  for (const key of ALL_STRATEGY_KEYS) {
    const ranking = rankings[key];
    const variants = PARAM_GRID[key] ?? [];
    const allowedRegimes = DEFAULT_ALLOWED_REGIMES[key] ?? ['UP', 'RANGE', 'DOWN'];

    for (const { ticker } of ranking.ranked) {
      const candles = candleMap.get(ticker);
      if (!candles) continue;

      for (const days of WINDOWS_DAYS) {
        const windowStartMs = endDate.getTime() - days * 86_400_000;
        let startBar = 0;
        for (let i = 0; i < candles.length; i++) {
          if (candles[i].time >= windowStartMs) { startBar = i; break; }
        }
        const endBar = candles.length;

        for (const variant of variants) {
          for (const gating of ['raw', 'gated'] as const) {
            const baseStrategy = variant.build();
            const strategy = gating === 'gated'
              ? gateStrategy(baseStrategy, allowedRegimes)
              : baseStrategy;
            const result = runBacktest({
              strategy, ticker, candles,
              startBar, endBar,
              budget: BUDGET, positionPercent: POSITION_PCT,
              feeRoundTrip: FEE_ROUND_TRIP, slippagePerSide: SLIPPAGE_PER_SIDE,
            });
            result.windowDays = days;
            rows.push({
              strategy: key, ticker, paramLabel: variant.label,
              windowDays: days, gating, result,
            });
            totalRuns++;
          }
        }
      }
    }
  }
  console.log(`  Completed ${totalRuns} backtests\n`);

  // --- Write outputs ---
  const outDir = join('v2', 'backtest', 'canonical', 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const jsonPayload = {
    config: {
      universe: CANDIDATE_UNIVERSE,
      windows: WINDOWS_DAYS,
      interval: INTERVAL,
      budget: BUDGET,
      positionPct: POSITION_PCT,
      feeRoundTrip: FEE_ROUND_TRIP,
      slippagePerSide: SLIPPAGE_PER_SIDE,
      topNPerStrategy: TOP_N_PER_STRATEGY,
    },
    profiles,
    rankings,
    rows: rows.map(r => ({
      strategy: r.strategy, ticker: r.ticker, paramLabel: r.paramLabel,
      windowDays: r.windowDays, gating: r.gating,
      totalTrades: r.result.totalTrades,
      winRate: r.result.winRate,
      pnlNet: r.result.totalPnlNet,
      pnlPct: r.result.totalPnlPercent,
      profitFactor: Number.isFinite(r.result.profitFactor) ? r.result.profitFactor : null,
      maxDD: r.result.maxDrawdownPercent,
      avgHoldBars: r.result.avgHoldBars,
    })),
  };
  writeFileSync(join(outDir, `sweep-${stamp}.json`), JSON.stringify(jsonPayload, null, 2));
  writeFileSync(join(outDir, 'sweep-latest.json'), JSON.stringify(jsonPayload, null, 2));

  const md = renderReport(profiles, rankings, rows, candleMap, endDate);
  writeFileSync(join(outDir, `sweep-${stamp}.md`), md);
  writeFileSync(join(outDir, 'sweep-latest.md'), md);

  console.log(`✓ Report: v2/backtest/canonical/results/sweep-${stamp}.md`);
}

function renderReport(
  profiles: TickerProfile[],
  rankings: Record<StrategyFitnessKey, { ranked: { ticker: string; score: number; profile: TickerProfile }[] }>,
  rows: SweepRow[],
  candleMap: Map<string, import('../../pipeline/types.ts').Candle[]>,
  endDate: Date,
): string {
  const out: string[] = [];
  out.push('# Full Strategy Sweep — Results');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push(`- Universe: ${CANDIDATE_UNIVERSE.length} tickers`);
  out.push(`- Strategies: ${ALL_STRATEGY_KEYS.length} (DCA, Grid, VWAP, Vol Profile, Candlestick added; Pairs and Chart Patterns deferred)`);
  out.push(`- Per-strategy top-N tickers: ${TOP_N_PER_STRATEGY}`);
  out.push(`- Windows: ${WINDOWS_DAYS.join('d, ')}d`);
  out.push(`- Interval: ${INTERVAL}`);
  out.push(`- Fees: ${(FEE_ROUND_TRIP * 100).toFixed(2)}% round-trip; slippage ${(SLIPPAGE_PER_SIDE * 100).toFixed(2)}%/side`);
  out.push('');

  // --- Section 1: ticker profile ---
  out.push('## 1. Ticker characteristics (90d)');
  out.push('');
  out.push('| Ticker | Bars | Hurst | RealVol % | ATR % | Drift % | VolStdRatio | RangeBound | TrendScore |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of [...profiles].sort((a, b) => b.realizedVolPct - a.realizedVolPct)) {
    out.push(
      `| ${p.ticker} | ${p.bars} | ${p.hurst.toFixed(3)} | ${p.realizedVolPct.toFixed(1)} | ` +
      `${p.avgAtrPct.toFixed(2)} | ${p.driftPct.toFixed(1)} | ${p.volStdRatio.toFixed(2)} | ` +
      `${p.rangeBoundScore.toFixed(2)} | ${p.trendScore.toFixed(3)} |`,
    );
  }
  out.push('');

  // --- Section 2: optimal tickers per strategy ---
  out.push('## 2. Optimal tickers per strategy (by fitness — closed-form, NOT backtest)');
  out.push('');
  out.push('Tickers selected by matching their structural properties (Hurst, vol, drift) to each strategy\'s theoretical requirements.');
  out.push('This avoids overfitting that would result from picking by backtest results.');
  out.push('');
  for (const key of ALL_STRATEGY_KEYS) {
    out.push(`### ${key}`);
    const ranked = rankings[key].ranked;
    out.push('| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |');
    out.push('|---:|---|---:|---:|---:|---:|---:|---:|');
    ranked.forEach((r, idx) => {
      out.push(
        `| ${idx + 1} | ${r.ticker} | ${r.score.toFixed(3)} | ${r.profile.hurst.toFixed(3)} | ` +
        `${r.profile.avgAtrPct.toFixed(2)} | ${r.profile.driftPct.toFixed(1)} | ` +
        `${r.profile.rangeBoundScore.toFixed(2)} | ${formatMoney(r.profile.liquidity)} |`,
      );
    });
    out.push('');
  }

  // --- Section 3: regime distribution per window ---
  out.push('## 3. Regime distribution (sanity check on the test windows)');
  out.push('');
  out.push('Each window\'s regime mix on BTCUSD — gives context for why gated/raw results differ.');
  out.push('');
  const btcCandles = candleMap.get('BTCUSD');
  if (btcCandles) {
    out.push('| Window | % UP | % DOWN | % RANGE |');
    out.push('|---|---:|---:|---:|');
    for (const days of WINDOWS_DAYS) {
      const startMs = endDate.getTime() - days * 86_400_000;
      let startBar = 0;
      for (let i = 0; i < btcCandles.length; i++) if (btcCandles[i].time >= startMs) { startBar = i; break; }
      const dist = regimeDistribution(btcCandles, startBar, btcCandles.length);
      out.push(`| ${days}d | ${(dist.UP * 100).toFixed(0)} | ${(dist.DOWN * 100).toFixed(0)} | ${(dist.RANGE * 100).toFixed(0)} |`);
    }
    out.push('');
  }

  // --- Section 4: top profitable cells ---
  out.push('## 4. Top profitable backtest cells (any window)');
  out.push('');
  out.push('Filtered to runs with ≥ 5 trades. Sorted by Net %.');
  out.push('');
  const profitable = rows
    .filter(r => r.result.totalTrades >= 5 && r.result.totalPnlPercent > 0)
    .sort((a, b) => b.result.totalPnlPercent - a.result.totalPnlPercent)
    .slice(0, 30);
  if (profitable.length === 0) {
    out.push('_None — no run produced positive P&L with ≥5 trades._');
  } else {
    out.push('| Strategy | Ticker | Params | Window | Gating | Trades | WR % | PF | Net % | DD % |');
    out.push('|---|---|---|---:|---|---:|---:|---:|---:|---:|');
    for (const r of profitable) {
      out.push(
        `| ${r.strategy} | ${r.ticker} | ${r.paramLabel} | ${r.windowDays}d | ${r.gating} | ` +
        `${r.result.totalTrades} | ${(r.result.winRate * 100).toFixed(1)} | ${formatPF(r.result.profitFactor)} | ` +
        `${r.result.totalPnlPercent.toFixed(2)} | ${r.result.maxDrawdownPercent.toFixed(1)} |`,
      );
    }
  }
  out.push('');

  // --- Section 5: gated vs raw delta per strategy ---
  out.push('## 5. Gated vs Raw — does the regime filter help?');
  out.push('');
  out.push('Per-strategy comparison: average Net % across all (ticker × params × window) cells with gating on vs off. Positive delta = gate helps.');
  out.push('');
  out.push('| Strategy | Raw avg Net % | Gated avg Net % | Δ (gain from gate) | Raw avg trades | Gated avg trades |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const key of ALL_STRATEGY_KEYS) {
    const ofStrat = rows.filter(r => r.strategy === key);
    const raw = ofStrat.filter(r => r.gating === 'raw');
    const gated = ofStrat.filter(r => r.gating === 'gated');
    const rawAvg = raw.length > 0 ? raw.reduce((s, r) => s + r.result.totalPnlPercent, 0) / raw.length : 0;
    const gatedAvg = gated.length > 0 ? gated.reduce((s, r) => s + r.result.totalPnlPercent, 0) / gated.length : 0;
    const rawTrades = raw.length > 0 ? raw.reduce((s, r) => s + r.result.totalTrades, 0) / raw.length : 0;
    const gatedTrades = gated.length > 0 ? gated.reduce((s, r) => s + r.result.totalTrades, 0) / gated.length : 0;
    out.push(
      `| ${key} | ${rawAvg.toFixed(2)} | ${gatedAvg.toFixed(2)} | ${(gatedAvg - rawAvg).toFixed(2)} | ` +
      `${rawTrades.toFixed(1)} | ${gatedTrades.toFixed(1)} |`,
    );
  }
  out.push('');

  // --- Section 6: per-strategy roll-up (best-cell summary) ---
  out.push('## 6. Per-strategy best & roll-up');
  out.push('');
  out.push('Best cell = best Net % across (ticker × params × window × gating) with ≥ 5 trades.');
  out.push('');
  out.push('| Strategy | Best Cell | Net % | PF | Trades | WR % | Total runs | Profitable runs (%) |');
  out.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const key of ALL_STRATEGY_KEYS) {
    const ofStrat = rows.filter(r => r.strategy === key && r.result.totalTrades >= 5);
    if (ofStrat.length === 0) {
      out.push(`| ${key} | — | — | — | — | — | 0 | 0 |`);
      continue;
    }
    const best = [...ofStrat].sort((a, b) => b.result.totalPnlPercent - a.result.totalPnlPercent)[0];
    const positive = ofStrat.filter(r => r.result.totalPnlPercent > 0).length;
    const totalRuns = rows.filter(r => r.strategy === key).length;
    out.push(
      `| ${key} | ${best.ticker}/${best.paramLabel}/${best.windowDays}d/${best.gating} | ` +
      `${best.result.totalPnlPercent.toFixed(2)} | ${formatPF(best.result.profitFactor)} | ` +
      `${best.result.totalTrades} | ${(best.result.winRate * 100).toFixed(1)} | ` +
      `${totalRuns} | ${((positive / totalRuns) * 100).toFixed(0)}% |`,
    );
  }
  out.push('');

  // --- Section 7: methodology notes ---
  out.push('## 7. Methodology notes');
  out.push('');
  out.push('- **Ticker selection is closed-form, not backtest-driven.** Picking optimal tickers from backtest results would be circular (overfitting to history). Instead, each ticker is scored by structural properties (Hurst exponent, ATR%, drift, vol-of-volume, range-bound score) against each strategy\'s theoretical requirements.');
  out.push('- **Single-position long-only.** The runner holds at most one position at a time per (strategy × ticker × params). Live deployment would parallelize.');
  out.push('- **Next-bar fill, no lookahead.** Signal closes on bar `i`, fill on bar `i+1` open. Mirrors live execution.');
  out.push('- **Fees and slippage applied per side.** Kraken taker round-trip (0.52%) plus 5 bps slippage per side. Maker-rebate scenarios would shift many strategies positive.');
  out.push('- **Stop-first intrabar resolution.** When both stop and target are touched within the same bar, the stop is assumed first (conservative).');
  out.push('- **Skipped:** Pairs Trading (#11 — needs cointegration logic), Chart Patterns (#20 — needs swing detection). These have meaningfully different structure and deserve their own sessions.');
  out.push('');

  return out.join('\n');
}

function formatPF(pf: number): string {
  if (!Number.isFinite(pf)) return 'inf';
  return pf.toFixed(2);
}
function formatMoney(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

main().catch(e => {
  console.error('Sweep failed:', e);
  process.exit(1);
});
