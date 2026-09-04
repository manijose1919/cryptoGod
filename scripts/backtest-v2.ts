#!/usr/bin/env node
// ============================================
// Phoenix V2 Backtester — CLI Entry Point
// Usage: node --experimental-strip-types scripts/backtest-v2.ts [options]
//
// Options:
//   --days=90        Lookback period (default: 90)
//   --budget=1000    Budget per ticker in USD (default: 1000)
//   --interval=15m   Candle timeframe (default: 15m)
//   --tickers=BTC,ETH  Comma-separated ticker list (default: all 10)
//   --bar-sequence=pessimistic|optimistic  Intra-bar ordering (default: pessimistic)
//   --seed           Seed v2_signal_scores with results
//   --json           Export results to JSON file
// ============================================

import { initializeDatabase } from '../services/database.js';
import { runBacktest } from '../v2/backtest/backtestEngine.ts';
import { printReport, exportJSON, seedSignalScores } from '../v2/backtest/backtestReport.ts';
import { initV2Tables } from '../v2/attribution/attributionStore.ts';
import { V2_CONFIG } from '../v2/engine/config.ts';
import type { BacktestConfig } from '../v2/backtest/types.ts';

// --- Parse CLI Arguments ---

function parseArgs(): {
  days: number;
  budget: number;
  interval: string;
  tickers: string[];
  seed: boolean;
  json: boolean;
  endDate: string | null;
  barSequence: 'pessimistic' | 'optimistic';
} {
  const args = process.argv.slice(2);
  const parsed = {
    days: 90,
    budget: 1000,
    interval: '15m',
    tickers: [...V2_CONFIG.SCAN_TICKERS],
    seed: false,
    json: false,
    endDate: null as string | null,
    barSequence: 'pessimistic' as 'pessimistic' | 'optimistic',
  };

  for (const arg of args) {
    if (arg.startsWith('--days=')) {
      parsed.days = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--budget=')) {
      parsed.budget = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--interval=')) {
      parsed.interval = arg.split('=')[1];
    } else if (arg.startsWith('--tickers=')) {
      const raw = arg.split('=')[1];
      parsed.tickers = raw.split(',').map((t) => {
        const upper = t.trim().toUpperCase();
        return upper.endsWith('USD') ? upper : `${upper}USD`;
      });
    } else if (arg.startsWith('--end=')) {
      parsed.endDate = arg.split('=')[1];
    } else if (arg.startsWith('--bar-sequence=')) {
      const value = arg.split('=')[1];
      if (value !== 'pessimistic' && value !== 'optimistic') {
        throw new Error(`Invalid --bar-sequence '${value}'. Must be 'pessimistic' or 'optimistic'.`);
      }
      parsed.barSequence = value;
    } else if (arg === '--seed') {
      parsed.seed = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
V2 Backtester — Replay historical candles through the Phoenix V2 pipeline

Usage: node --experimental-strip-types scripts/backtest-v2.ts [options]

Options:
  --days=N          Lookback period in days (default: 90)
  --budget=N        Budget per ticker in USD (default: 1000)
  --interval=INTV   Candle timeframe: 1m, 5m, 15m, 30m, 1h, 4h (default: 15m)
  --tickers=A,B,C   Comma-separated tickers (default: all 10)
  --bar-sequence=S  Intra-bar ordering: pessimistic (adverse extreme first, default)
                    or optimistic (legacy favorable-first, for comparison runs)
  --seed            Write signal scores to v2_signal_scores table
  --json            Export full results to data/backtest-results-*.json
  --help            Show this help

Examples:
  node --experimental-strip-types scripts/backtest-v2.ts
  node --experimental-strip-types scripts/backtest-v2.ts --days=30 --tickers=BTC,ETH,SOL
  node --experimental-strip-types scripts/backtest-v2.ts --days=90 --seed --json
`);
      process.exit(0);
    }
  }

  return parsed;
}

// --- Interval to Minutes ---

const INTERVAL_MINUTES: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240,
};

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║        Phoenix V2 Backtester                  ║');
  console.log('╚═══════════════════════════════════════════════╝');

  // Initialize database + V2 tables
  initializeDatabase();
  initV2Tables();

  const endDate = args.endDate ? new Date(args.endDate + 'T00:00:00Z') : new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const intervalMinutes = INTERVAL_MINUTES[args.interval];
  if (intervalMinutes === undefined) {
    throw new Error(
      `Unknown interval '${args.interval}'. Supported: ${Object.keys(INTERVAL_MINUTES).join(', ')}. ` +
      `Refusing to default — a wrong intervalMinutes silently corrupts all time-based exit logic.`,
    );
  }

  const config: BacktestConfig = {
    startDate,
    endDate,
    tickers: args.tickers,
    budgetPerTicker: args.budget,
    interval: args.interval,
    intervalMinutes,
    maxOpenPositions: V2_CONFIG.MAX_OPEN_POSITIONS,
    feeRoundTrip: V2_CONFIG.FEE_ROUND_TRIP_TAKER, // Conservative: use taker fees
    slippagePerSide: V2_CONFIG.PAPER_SLIPPAGE_PER_SIDE,
    barSequence: args.barSequence,
    seed: args.seed,
  };

  console.log(`\nConfig:`);
  console.log(`  Period:    ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]} (${args.days} days)`);
  console.log(`  Tickers:   ${args.tickers.join(', ')}`);
  console.log(`  Timeframe: ${args.interval} (${intervalMinutes}min)`);
  console.log(`  Budget:    $${args.budget}/ticker ($${args.budget * args.tickers.length} total)`);
  console.log(`  Fees:      ${(config.feeRoundTrip * 100).toFixed(2)}% round-trip (Kraken taker)`);
  console.log(`  Slippage:  ${(config.slippagePerSide * 100).toFixed(2)}% per side`);
  console.log(`  Bar seq:   ${args.barSequence}${args.barSequence === 'optimistic' ? ' (legacy favorable-first — results inflated)' : ''}`);
  console.log(`  Seed:      ${args.seed ? 'YES' : 'no'}`);

  const startTime = Date.now();

  // Run backtest
  const result = await runBacktest(config);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Backtest completed in ${elapsed}s`);

  // Print report
  printReport(result);

  // Export JSON
  if (args.json) {
    const timestamp = Date.now();
    const filepath = `data/backtest-results-${timestamp}.json`;
    exportJSON(result, filepath);
  }

  // Seed signal scores
  if (args.seed) {
    console.log('\nSeeding signal scores to database...');
    seedSignalScores(result);
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
