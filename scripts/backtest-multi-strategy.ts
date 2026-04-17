#!/usr/bin/env node
// ============================================
// Multi-Strategy Backtester
// Tests TREND, BREAKOUT, MEAN_REVERSION, MOMENTUM, SCALP
// each with strategy-specific entry/exit logic.
//
// Usage: node --experimental-strip-types scripts/backtest-multi-strategy.ts [options]
//
// Options:
//   --days=90               Lookback period (default: 90)
//   --budget=5000           Total budget in USD (default: 5000)
//   --timeframes=15m,1h,4h  Timeframes to test (default: 15m,1h,4h)
//   --strategies=ALL        Strategies: ALL, TREND, BREAKOUT, MEAN_REVERSION, MOMENTUM, SCALP
//   --tickers=BTC,ETH,SOL   Tickers (default: BTC,ETH,SOL,XRP,DOGE)
//   --json                  Export results to JSON
// ============================================

import { initializeDatabase } from '../services/database.js';
import { runMultiStrategyBacktest } from '../v2/backtest/multiStrategy/multiStrategyEngine.ts';
import { printReport, exportJSON } from '../v2/backtest/multiStrategy/multiStrategyReport.ts';
import { getEnabledStrategies } from '../v2/backtest/multiStrategy/strategyRegistry.ts';
import type { StrategyType } from '../v2/backtest/multiStrategy/types.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    days: 90,
    budget: 5000,
    timeframes: ['15m', '1h', '4h'],
    strategies: null as StrategyType[] | null,
    tickers: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'],
    fees: 'taker' as 'taker' | 'maker',
    json: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--days=')) parsed.days = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--budget=')) parsed.budget = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--timeframes=')) parsed.timeframes = arg.split('=')[1].split(',');
    else if (arg.startsWith('--strategies=')) {
      const val = arg.split('=')[1].toUpperCase();
      if (val !== 'ALL') parsed.strategies = val.split(',') as StrategyType[];
    }
    else if (arg.startsWith('--tickers=')) {
      parsed.tickers = arg.split('=')[1].split(',').map(t => {
        const u = t.trim().toUpperCase();
        return u.endsWith('USD') ? u : u + 'USD';
      });
    }
    else if (arg === '--fees=maker') parsed.fees = 'maker';
    else if (arg === '--fees=taker') parsed.fees = 'taker';
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Multi-Strategy Backtester — Compare TREND, BREAKOUT, MEAN_REVERSION, MOMENTUM, SCALP

Usage: node --experimental-strip-types scripts/backtest-multi-strategy.ts [options]

Options:
  --days=N                 Lookback period (default: 90)
  --budget=N               Total budget USD (default: 5000)
  --timeframes=15m,1h,4h   Timeframes to test (default: all three)
  --strategies=ALL         Strategies: ALL, TREND, BREAKOUT, MEAN_REVERSION, MOMENTUM, SCALP
  --tickers=BTC,ETH,SOL    Tickers (default: BTC,ETH,SOL,XRP,DOGE)
  --json                   Export results to JSON
`);
      process.exit(0);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs();

  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║     Multi-Strategy Backtester                 ║');
  console.log('╚═══════════════════════════════════════════════╝');

  initializeDatabase();

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);

  const strategies = getEnabledStrategies(args.strategies ?? undefined);

  console.log(`\nConfig:`);
  console.log(`  Period:     ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]} (${args.days} days)`);
  console.log(`  Budget:     $${args.budget}`);
  console.log(`  Tickers:    ${args.tickers.join(', ')}`);
  console.log(`  Timeframes: ${args.timeframes.join(', ')}`);
  console.log(`  Strategies: ${strategies.map(s => s.name).join(', ')}`);
  const feeRoundTrip = args.fees === 'maker' ? 0.0032 : 0.0052;
  console.log(`  Fees:       ${(feeRoundTrip * 100).toFixed(2)}% round-trip (Kraken ${args.fees})`);

  const startTime = Date.now();

  const report = await runMultiStrategyBacktest({
    tickers: args.tickers,
    startDate,
    endDate,
    budget: args.budget,
    timeframes: args.timeframes,
    strategies,
    feeRoundTrip,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nBacktest completed in ${elapsed}s`);

  printReport(report);

  if (args.json) {
    const path = `data/ms-backtest-${Date.now()}.json`;
    exportJSON(report, path);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
