// Orchestrator. Run with:
//   npx tsx v2/backtest/canonical/index.ts
//
// Sweeps 5 canonical strategies × 5 liquid tickers × 3 time windows (30/60/90d)
// on 1h candles. Writes JSON + markdown report to v2/backtest/canonical/results/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllCandles } from '../candleCache.ts';
// @ts-expect-error  - JS module without types
import { initializeDatabase } from '../../../services/database.js';
import { ALL_STRATEGIES } from './strategies.ts';
import { runBacktest } from './runner.ts';
import type { RunResult } from './types.ts';

const TICKERS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const WINDOWS_DAYS = [30, 60, 90];
const INTERVAL = '1h';
const BUDGET = 1000;
const POSITION_PCT = 0.5;             // 50% of equity per trade (single-position long-only)
const FEE_ROUND_TRIP = 0.0052;         // Kraken taker round-trip
const SLIPPAGE_PER_SIDE = 0.0005;      // 5 bps

async function main(): Promise<void> {
  initializeDatabase();
  const maxWindow = Math.max(...WINDOWS_DAYS);
  const endDate = new Date();
  // Pad start by 60 days so warmup periods (up to 80 bars on 1h ≈ 3.3d) are
  // well-covered without eating into the test window.
  const startDate = new Date(endDate.getTime() - (maxWindow + 60) * 86_400_000);

  console.log(`\n=== Canonical Strategy Backtest ===`);
  console.log(`Strategies : ${ALL_STRATEGIES.map(s => s.name).join(', ')}`);
  console.log(`Tickers    : ${TICKERS.join(', ')}`);
  console.log(`Windows    : ${WINDOWS_DAYS.join('d, ')}d`);
  console.log(`Interval   : ${INTERVAL}`);
  console.log(`Budget     : $${BUDGET} per (strategy × ticker × window)`);
  console.log(`Fees       : ${(FEE_ROUND_TRIP * 100).toFixed(2)}% round-trip`);
  console.log(`Slippage   : ${(SLIPPAGE_PER_SIDE * 100).toFixed(2)}% per side\n`);

  const candleMap = await loadAllCandles(TICKERS, startDate, endDate, INTERVAL);

  const results: RunResult[] = [];

  for (const days of WINDOWS_DAYS) {
    for (const ticker of TICKERS) {
      const candles = candleMap.get(ticker);
      if (!candles || candles.length === 0) {
        console.log(`SKIP ${ticker}/${days}d — no candles`);
        continue;
      }
      const windowStartMs = endDate.getTime() - days * 86_400_000;
      // Find first bar inside the window. Strategies need warmup, so include
      // pre-window candles for indicator warm-up; runner's startBar gates trades.
      let startBar = 0;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].time >= windowStartMs) { startBar = i; break; }
      }
      const endBar = candles.length;

      for (const strategy of ALL_STRATEGIES) {
        const result = runBacktest({
          strategy,
          ticker,
          candles,
          startBar,
          endBar,
          budget: BUDGET,
          positionPercent: POSITION_PCT,
          feeRoundTrip: FEE_ROUND_TRIP,
          slippagePerSide: SLIPPAGE_PER_SIDE,
        });
        result.windowDays = days; // override to nominal window
        results.push(result);
        console.log(
          `${days}d ${ticker.padEnd(8)} ${strategy.name.padEnd(18)} ` +
          `trades=${String(result.totalTrades).padStart(3)} ` +
          `WR=${(result.winRate * 100).toFixed(1).padStart(5)}% ` +
          `PF=${result.profitFactor.toFixed(2).padStart(5)} ` +
          `net=${result.totalPnlPercent.toFixed(2).padStart(7)}% ` +
          `DD=${result.maxDrawdownPercent.toFixed(1).padStart(5)}%`,
        );
      }
    }
  }

  const outDir = join('v2', 'backtest', 'canonical', 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(join(outDir, `results-${stamp}.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, `report-${stamp}.md`), renderMarkdown(results));
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, 'latest.md'), renderMarkdown(results));

  console.log(`\n✓ Results: v2/backtest/canonical/results/report-${stamp}.md`);
}

function renderMarkdown(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push(`# Canonical Strategy Backtest`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- Interval: 1h candles`);
  lines.push(`- Budget: $${BUDGET} per run`);
  lines.push(`- Fees: ${(FEE_ROUND_TRIP * 100).toFixed(2)}% round-trip (Kraken taker)`);
  lines.push(`- Slippage: ${(SLIPPAGE_PER_SIDE * 100).toFixed(2)}% per side`);
  lines.push(`- Universe: ${TICKERS.join(', ')}`);
  lines.push('');

  for (const days of WINDOWS_DAYS) {
    lines.push(`## ${days}-day window`);
    lines.push('');
    lines.push('| Strategy | Ticker | Trades | Win% | PF | Net % | Max DD % | Avg Hold |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
    for (const ticker of TICKERS) {
      for (const strategy of ALL_STRATEGIES) {
        const r = results.find(x => x.windowDays === days && x.ticker === ticker && x.strategy === strategy.name);
        if (!r) continue;
        lines.push(
          `| ${r.strategy} | ${r.ticker} | ${r.totalTrades} | ` +
          `${(r.winRate * 100).toFixed(1)} | ${formatPF(r.profitFactor)} | ` +
          `${r.totalPnlPercent.toFixed(2)} | ${r.maxDrawdownPercent.toFixed(1)} | ` +
          `${r.avgHoldBars.toFixed(1)} |`,
        );
      }
    }
    lines.push('');

    lines.push(`### ${days}-day strategy roll-up`);
    lines.push('');
    lines.push('| Strategy | Total Trades | Win% | PF | Sum Net % | Avg Net % | Worst DD % |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const strategy of ALL_STRATEGIES) {
      const rs = results.filter(x => x.windowDays === days && x.strategy === strategy.name);
      const totalTrades = rs.reduce((s, r) => s + r.totalTrades, 0);
      const totalWins = rs.reduce((s, r) => s + r.wins, 0);
      const wr = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
      const grossWins = rs.flatMap(r => r.trades).filter(t => t.pnlNet > 0).reduce((s, t) => s + t.pnlNet, 0);
      const grossLossesAbs = Math.abs(rs.flatMap(r => r.trades).filter(t => t.pnlNet <= 0).reduce((s, t) => s + t.pnlNet, 0));
      const pf = grossLossesAbs > 0 ? grossWins / grossLossesAbs : (grossWins > 0 ? Infinity : 0);
      const sumPct = rs.reduce((s, r) => s + r.totalPnlPercent, 0);
      const avgPct = rs.length > 0 ? sumPct / rs.length : 0;
      const worstDD = rs.reduce((mx, r) => Math.max(mx, r.maxDrawdownPercent), 0);
      lines.push(
        `| ${strategy.name} | ${totalTrades} | ${wr.toFixed(1)} | ${formatPF(pf)} | ` +
        `${sumPct.toFixed(2)} | ${avgPct.toFixed(2)} | ${worstDD.toFixed(1)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatPF(pf: number): string {
  if (!Number.isFinite(pf)) return 'inf';
  return pf.toFixed(2);
}

main().catch((e) => {
  console.error('Backtest failed:', e);
  process.exit(1);
});
