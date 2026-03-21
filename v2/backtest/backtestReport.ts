// ============================================
// Phoenix V2 Backtest Report
// Console output + JSON export + DB seeding
// ============================================

import { writeFileSync } from 'node:fs';
import type { BacktestResult, BacktestTrade } from './types.ts';
import { upsertSignalScore } from '../attribution/attributionStore.ts';

// --- Formatting Helpers ---

function pad(str: string, len: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return str.padStart(len);
  return str.padEnd(len);
}

function pct(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function usd(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function dur(ms: number): string {
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)}min`;
  return `${hours.toFixed(1)}h`;
}

function tradeSummary(trade: BacktestTrade | null): string {
  if (!trade || trade.pnlNet == null) return 'N/A';
  const pnlPct = trade.positionSizeUsd > 0 ? trade.pnlNet / trade.positionSizeUsd : 0;
  return `${trade.ticker} ${pct(pnlPct)} (${usd(trade.pnlNet)}) | score=${trade.compositeScore.toFixed(0)}, regime=${trade.entryRegime}`;
}

// --- Console Report ---

export function printReport(result: BacktestResult): void {
  const { config, summary, signalScores, regimeBreakdown, tickerBreakdown } = result;
  const startStr = config.startDate.toISOString().split('T')[0];
  const endStr = config.endDate.toISOString().split('T')[0];
  const days = Math.round((config.endDate.getTime() - config.startDate.getTime()) / 86400000);
  const totalBudget = config.budgetPerTicker * config.tickers.length;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  V2 BACKTEST REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Period:     ${startStr} → ${endStr} (${days} days)`);
  console.log(`  Tickers:    ${config.tickers.length} | Timeframe: ${config.interval}`);
  console.log(`  Budget:     $${config.budgetPerTicker}/ticker ($${totalBudget} total)`);
  console.log(`  Fees:       ${pct(config.feeRoundTrip)} round-trip`);
  console.log('');

  // --- Performance ---
  console.log('── PERFORMANCE ─────────────────────────────────────────────');
  console.log(`  Total trades:    ${pad(String(summary.totalTrades), 6, 'right')}        Win rate:    ${pct(summary.winRate)}`);
  console.log(`  Winners:         ${pad(String(summary.winningTrades), 6, 'right')}        Losers:      ${summary.losingTrades}`);
  console.log(`  Total PnL:     ${pad(usd(summary.totalPnlNet), 10, 'right')}      Return:      ${pct(summary.totalPnlPercent)}`);
  console.log(`  Avg win:       ${pad(usd(summary.avgWinPnl), 10, 'right')}      Avg loss:    ${usd(summary.avgLossPnl)}`);
  console.log(`  Profit factor:  ${pad(summary.profitFactor === Infinity ? '∞' : summary.profitFactor.toFixed(2), 6, 'right')}        Max DD:      ${usd(-summary.maxDrawdownUsd)} (${pct(summary.maxDrawdownPercent)})`);
  console.log(`  Avg hold:        ${pad(dur(summary.avgHoldDurationMs), 6, 'right')}        Avg bars:    ${summary.avgHoldBars.toFixed(1)}`);
  console.log('');

  // --- Signal Scorecard ---
  console.log('── SIGNAL SCORECARD ────────────────────────────────────────');
  console.log(`  ${pad('Signal', 22)} ${pad('Trades', 7, 'right')} ${pad('Win%', 6, 'right')} ${pad('AvgPnL', 8, 'right')} ${pad('Edge', 8, 'right')}  Verdict`);
  console.log(`  ${'-'.repeat(68)}`);

  for (const score of signalScores) {
    const verdictIcon = score.verdict === 'proven' ? '✓ PROVEN'
      : score.verdict === 'negative' ? '✗ NEGATIVE'
      : '? INCONCLUSIVE';
    console.log(`  ${pad(score.signalName, 22)} ${pad(String(score.totalTrades), 7, 'right')} ${pad(pct(score.winRate), 6, 'right')} ${pad(pct(score.avgPnlWhenActive), 8, 'right')} ${pad(pct(score.edge, 2), 8, 'right')}  ${verdictIcon}`);
  }
  console.log('');

  // --- Regime Breakdown ---
  console.log('── REGIME BREAKDOWN ────────────────────────────────────────');
  for (const r of regimeBreakdown) {
    console.log(`  ${pad(r.regime, 14)} ${pad(String(r.trades), 4, 'right')} trades, ${pad(pct(r.winRate), 6, 'right')} WR, ${usd(r.totalPnl)}`);
  }
  console.log('');

  // --- Ticker Breakdown ---
  console.log('── TICKER BREAKDOWN ────────────────────────────────────────');
  for (const t of tickerBreakdown) {
    console.log(`  ${pad(t.ticker, 10)} ${pad(String(t.trades), 4, 'right')} trades, ${pad(pct(t.winRate), 6, 'right')} WR, ${usd(t.totalPnl)}`);
  }
  console.log('');

  // --- Best/Worst ---
  console.log('── TOP/BOTTOM TRADES ───────────────────────────────────────');
  console.log(`  Best:  ${tradeSummary(summary.bestTrade)}`);
  console.log(`  Worst: ${tradeSummary(summary.worstTrade)}`);
  console.log('');

  // --- Exit Reason Breakdown ---
  const exitReasons = new Map<string, { count: number; pnl: number }>();
  for (const t of result.trades) {
    if (!t.exitReason || t.pnlNet == null) continue;
    const entry = exitReasons.get(t.exitReason) ?? { count: 0, pnl: 0 };
    entry.count++;
    entry.pnl += t.pnlNet;
    exitReasons.set(t.exitReason, entry);
  }
  console.log('── EXIT REASONS ────────────────────────────────────────────');
  for (const [reason, data] of [...exitReasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${pad(reason, 14)} ${pad(String(data.count), 4, 'right')} trades, ${usd(data.pnl)}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

// --- JSON Export ---

export function exportJSON(result: BacktestResult, filepath: string): void {
  const serializable = {
    ...result,
    config: {
      ...result.config,
      startDate: result.config.startDate.toISOString(),
      endDate: result.config.endDate.toISOString(),
    },
    // Exclude full signal snapshots from trades to keep file manageable
    trades: result.trades.map((t) => ({
      ...t,
      entrySignals: undefined,
    })),
  };

  writeFileSync(filepath, JSON.stringify(serializable, null, 2));
  console.log(`Results exported to ${filepath}`);
}

// --- DB Seeding ---

export function seedSignalScores(result: BacktestResult): void {
  const MIN_TRADES_TO_SEED = 50;

  if (result.summary.totalTrades < MIN_TRADES_TO_SEED) {
    console.log(`Skipping seed: only ${result.summary.totalTrades} trades (need ${MIN_TRADES_TO_SEED}+)`);
    return;
  }

  let seeded = 0;
  for (const score of result.signalScores) {
    upsertSignalScore({
      signalName: score.signalName,
      totalTrades: score.totalTrades,
      winningTrades: score.winningTrades,
      winRate: score.winRate,
      avgPnlWhenActive: score.avgPnlWhenActive,
      avgPnlWhenInactive: score.avgPnlWhenInactive,
      edge: score.edge,
      lastUpdated: Date.now(),
    });
    seeded++;
  }

  console.log(`Seeded ${seeded} signal scores into v2_signal_scores`);
  console.log('Adaptive weights will now use backtest-derived verdicts in live trading.');
}
