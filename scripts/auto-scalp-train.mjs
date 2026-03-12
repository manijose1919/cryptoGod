#!/usr/bin/env node
/**
 * auto-scalp-train.mjs — Autonomous scalping strategy trainer
 *
 * Runs on VPS independently. Downloads 5m/15m data, then iterates:
 * 1. TREND-only training on 15m (best short-term performer)
 * 2. TREND-only training on 5m
 * 3. Distill winning patterns
 * 4. Walk-forward validation
 * 5. Repeat with progressively tighter exit params
 *
 * Usage: node scripts/auto-scalp-train.mjs
 */

const BASE_URL = 'http://localhost:3033/api';

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTraining(label, pollMs = 5000) {
  let status;
  do {
    await sleep(pollMs);
    status = await api('/training/status');
    if (status.progress) {
      const pct = status.progress.pct?.toFixed(1) || '?';
      const trades = status.stats?.totalTrades || 0;
      const wr = status.stats?.winRate?.toFixed(1) || '0';
      process.stdout.write(`\r  [${label}] ${pct}% | ${trades} trades | WR ${wr}%    `);
    }
  } while (status.active);
  console.log('');
  return status;
}

// Scalp exit parameter sets to sweep
const EXIT_CONFIGS = [
  // Config A: Tight scalp (0.8% SL, 1.5% TP, 4h max)
  {
    name: 'tight-scalp',
    exitParams: { stopLoss: -0.008, takeProfit: 0.015, maxHold: 4, trailingStart: 0.008, trailingGiveBack: 0.35 },
    regimeExitOverrides: {
      STRONG_UP: { takeProfit: 0.025, trailingStart: 0.015, trailingGiveBack: 0.25, maxHold: 6 },
      UP: { takeProfit: 0.018, trailingStart: 0.01, trailingGiveBack: 0.30, maxHold: 5 },
      SIDEWAYS: { takeProfit: 0.012, maxHold: 3 },
    }
  },
  // Config B: Medium scalp (1.2% SL, 2.5% TP, 8h max)
  {
    name: 'medium-scalp',
    exitParams: { stopLoss: -0.012, takeProfit: 0.025, maxHold: 8, trailingStart: 0.012, trailingGiveBack: 0.30 },
    regimeExitOverrides: {
      STRONG_UP: { takeProfit: 0.04, trailingStart: 0.02, trailingGiveBack: 0.20, maxHold: 12 },
      UP: { takeProfit: 0.03, trailingStart: 0.015, trailingGiveBack: 0.25, maxHold: 10 },
      SIDEWAYS: { takeProfit: 0.018, maxHold: 6 },
    }
  },
  // Config C: Wide scalp (2% SL, 4% TP, 24h max)
  {
    name: 'wide-scalp',
    exitParams: { stopLoss: -0.02, takeProfit: 0.04, maxHold: 24, trailingStart: 0.02, trailingGiveBack: 0.30 },
    regimeExitOverrides: {
      STRONG_UP: { takeProfit: 0.08, trailingStart: 0.04, trailingGiveBack: 0.15, maxHold: 48 },
      UP: { takeProfit: 0.05, trailingStart: 0.025, trailingGiveBack: 0.20, maxHold: 36 },
      SIDEWAYS: { takeProfit: 0.025, maxHold: 12 },
    }
  },
];

async function main() {
  console.log('=== Auto Scalp Trainer ===');
  console.log(`Started at ${new Date().toISOString()}`);

  // Check server health
  const health = await api('/health');
  if (health.status !== 'ok') {
    console.error('Server not healthy:', health);
    process.exit(1);
  }
  console.log(`Server OK | Uptime: ${health.uptime} | Positions: ${health.positions}`);

  // Check available data
  const summary = await api('/training/data/summary');
  const btcTFs = summary.pairs?.BTCUSD?.timeframes || {};
  for (const tf of ['5m', '15m', '1h']) {
    if (btcTFs[tf]) {
      console.log(`  BTCUSD/${tf}: ${btcTFs[tf].count.toLocaleString()} candles (${btcTFs[tf].earliest?.slice(0,10)} to ${btcTFs[tf].latest?.slice(0,10)})`);
    }
  }

  const results = [];

  for (const exitConfig of EXIT_CONFIGS) {
    console.log(`\n--- Exit Config: ${exitConfig.name} ---`);

    // Create modified seed with these exit params
    const seedResult = await api('/training/modify-seed', 'POST', {
      seedId: 'distill_1773324102332_7b1598c8',
      exitParams: exitConfig.exitParams,
      optimizedParams: { TREND_BULLISH_ENTRY: 30 },
      regimeExitOverrides: exitConfig.regimeExitOverrides,
    });

    if (!seedResult.success) {
      console.error(`  Failed to create seed: ${seedResult.error}`);
      continue;
    }
    const seedId = seedResult.runId;
    console.log(`  Seed created: ${seedId}`);

    // Train on 15m (best performer)
    for (const tf of ['15m', '5m']) {
      console.log(`\n  Training ${tf} TREND-only with ${exitConfig.name}...`);

      const trainResult = await api('/training/start', 'POST', {
        seedId,
        strategyFilter: ['TREND'],
        primaryTimeframe: tf,
        selectivity: 'scalp',
        useMakerFees: true,
        useDynamicExits: true,
      });

      if (!trainResult.success) {
        console.error(`  Training failed to start: ${trainResult.error}`);
        continue;
      }
      console.log(`  Run: ${trainResult.runId} (${trainResult.totalSteps} steps)`);

      const status = await waitForTraining(`${tf}/${exitConfig.name}`);
      const s = status.stats;

      const result = {
        config: exitConfig.name,
        timeframe: tf,
        runId: status.runId,
        trades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate?.toFixed(1),
        pnl: s.totalPnl?.toFixed(0),
        fees: s.totalFees?.toFixed(0),
        maxDrawdown: (s.maxDrawdown * 100)?.toFixed(1),
        equity: status.equity?.current?.toFixed(0),
      };
      results.push(result);
      console.log(`  Result: ${s.totalTrades} trades | WR ${result.winRate}% | PnL $${result.pnl} | DD ${result.maxDrawdown}%`);

      // If profitable, distill winning patterns
      if (s.totalPnl > 0) {
        console.log(`  PROFITABLE! Distilling...`);
        const distill = await api('/training/distill', 'POST', { runId: status.runId, profitFocused: true });
        if (distill.success) console.log(`  Distilled: ${distill.runId}`);
      }
    }
  }

  // Print summary table
  console.log('\n\n=== RESULTS SUMMARY ===');
  console.log('Config         | TF  | Trades | WR%   | PnL     | Fees   | DD%   | Equity');
  console.log('---------------|-----|--------|-------|---------|--------|-------|-------');
  for (const r of results) {
    const cfg = r.config.padEnd(14);
    const tf = r.timeframe.padEnd(3);
    const trades = String(r.trades).padStart(6);
    const wr = String(r.winRate).padStart(5);
    const pnl = ('$' + r.pnl).padStart(7);
    const fees = ('$' + r.fees).padStart(6);
    const dd = (r.maxDrawdown + '%').padStart(5);
    const eq = ('$' + r.equity).padStart(7);
    console.log(`${cfg} | ${tf} | ${trades} | ${wr}% | ${pnl} | ${fees} | ${dd} | ${eq}`);
  }

  // Identify best config
  const profitable = results.filter(r => parseFloat(r.pnl) > 0);
  if (profitable.length > 0) {
    const best = profitable.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl))[0];
    console.log(`\nBest: ${best.config}/${best.timeframe} — $${best.pnl} PnL, ${best.winRate}% WR`);
    console.log(`Run ID: ${best.runId}`);
  } else {
    console.log('\nNo profitable configs found. Need more data or parameter tuning.');
  }

  console.log(`\nCompleted at ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
