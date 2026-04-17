import type { MSReport, StrategyResult } from './types.ts';
import { writeFileSync } from 'node:fs';

export function printReport(report: MSReport): void {
  console.log('\n' + '═'.repeat(95));
  console.log('  MULTI-STRATEGY BACKTEST COMPARISON');
  console.log('═'.repeat(95));

  const hdr = 'Strategy'.padEnd(18) + 'TF'.padEnd(5) + 'Trades'.padEnd(8) +
    'Win%'.padEnd(8) + 'PnL'.padEnd(12) + 'PnL%'.padEnd(8) +
    'PF'.padEnd(7) + 'AvgWin'.padEnd(10) + 'AvgLoss'.padEnd(10) + 'MaxDD';
  console.log(hdr);
  console.log('─'.repeat(95));

  const sorted = [...report.comparison].sort((a, b) =>
    parseFloat(b.pnlPercent) - parseFloat(a.pnlPercent)
  );

  for (const row of sorted) {
    const line = row.strategy.padEnd(18) + row.timeframe.padEnd(5) +
      String(row.trades).padEnd(8) + row.winRate.padEnd(8) +
      row.pnl.padEnd(12) + row.pnlPercent.padEnd(8) +
      row.profitFactor.padEnd(7) + row.avgWin.padEnd(10) +
      row.avgLoss.padEnd(10) + row.maxDD;
    console.log(line);
  }

  console.log('═'.repeat(95));

  for (const result of report.results) {
    if (result.trades.length === 0) continue;
    printStrategyDetail(result);
  }
}

function printStrategyDetail(result: StrategyResult): void {
  const s = result.summary;
  console.log(`\n── ${result.strategy} @ ${result.timeframe} ──────────────────────────────`);
  console.log(`  ${s.totalTrades} trades | ${s.winningTrades}W / ${s.losingTrades}L | WR: ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`  PnL: $${s.totalPnlNet.toFixed(2)} (${s.totalPnlPercent.toFixed(1)}%) | PF: ${s.profitFactor.toFixed(2)} | MaxDD: ${s.maxDrawdownPercent.toFixed(1)}%`);
  console.log(`  Avg Win: +$${s.avgWinPnl.toFixed(2)} | Avg Loss: -$${Math.abs(s.avgLossPnl).toFixed(2)} | Avg Hold: ${s.avgHoldBars.toFixed(1)} bars`);

  if (result.exitBreakdown.length > 0) {
    console.log('  Exit Reasons:');
    for (const e of result.exitBreakdown) {
      console.log(`    ${e.reason.padEnd(18)} ${String(e.count).padEnd(5)} $${e.totalPnl.toFixed(2).padStart(8)}  avg $${e.avgPnl.toFixed(2)}`);
    }
  }

  if (result.tickerBreakdown.length > 0) {
    console.log('  Tickers:');
    for (const t of result.tickerBreakdown) {
      console.log(`    ${t.ticker.padEnd(10)} ${String(t.trades).padEnd(5)} ${(t.winRate * 100).toFixed(0).padStart(3)}% WR  $${t.totalPnl.toFixed(2).padStart(8)}`);
    }
  }
}

export function exportJSON(report: MSReport, path: string): void {
  const data = {
    ...report,
    results: report.results.map(r => ({
      ...r,
      trades: r.trades.map(t => ({ ...t })),
    })),
  };
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`\nExported to ${path}`);
}
