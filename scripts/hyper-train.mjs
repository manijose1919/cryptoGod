/**
 * HYPER-TRAINING SCRIPT — 4 Novel Techniques Combined
 *
 * Phase 1: GENETIC SEED CROSSOVER
 *   Breed top 3 profit-focused seeds → consensus child
 *
 * Phase 2: TEMPORAL CONSENSUS FORGING (Novel)
 *   Train on each quarter independently, breed the results.
 *   Only patterns profitable across 3/4+ time periods survive.
 *   This eliminates time-specific overfit patterns.
 *
 * Phase 3: SURGICAL LOSS AUTOPSY (Novel)
 *   Progressive loss elimination — each pass raises the bar.
 *   Round 1: remove patterns with WR < 50% (weakest)
 *   Round 2: remove patterns with WR < 55% (mediocre)
 *   Round 3: remove patterns with WR < 60% (only keep strong)
 *   Each round poisons the bad patterns more aggressively.
 *
 * Phase 4: EXIT PARAMETER EVOLUTION (Novel)
 *   Try 6 different exit configurations on the hardened seed.
 *   Including asymmetric R:R ratios, tight scalping, and wide runners.
 *   Pick the one that produces the best risk-adjusted returns.
 *
 * Phase 5: FINAL EVALUATION
 *   Pure eval at $100, $1K, $10K + walk-forward OOS
 */

const BASE_URL = 'http://localhost:3033/api/training';
const BUDGET = 1000000;
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];

// Best seeds from profit-focused distillation (Session 3)
const PARENT_SEEDS = [
  'distill_1772139216066_abae4461',  // Round 9:  102 trades, 59.8% WR, +$98K
  'distill_1772139224609_c75c128b',  // Round 11: 89 trades, 60.7% WR, +$94K
  'distill_1772139228857_2577797b',  // Round 12: 76 trades, 61.8% WR, +$105K (BEST)
];

// Quarterly time boundaries (data: Feb 26 2025 → Feb 26 2026)
const QUARTERS = [
  { name: 'Q1 (Mar-May 2025)', start: new Date('2025-03-01T00:00:00Z').getTime(), end: new Date('2025-06-01T00:00:00Z').getTime() },
  { name: 'Q2 (Jun-Aug 2025)', start: new Date('2025-06-01T00:00:00Z').getTime(), end: new Date('2025-09-01T00:00:00Z').getTime() },
  { name: 'Q3 (Sep-Nov 2025)', start: new Date('2025-09-01T00:00:00Z').getTime(), end: new Date('2025-12-01T00:00:00Z').getTime() },
  { name: 'Q4 (Dec-Feb 2026)', start: new Date('2025-12-01T00:00:00Z').getTime(), end: new Date('2026-02-26T00:00:00Z').getTime() },
];

// Exit parameter configurations to sweep
const EXIT_CONFIGS = [
  { name: 'Tight Scalp',    exitParams: { stopLoss: -0.025, takeProfit: 0.03,  maxHold: 48,  trailingStart: 0.05, trailingGiveBack: 0.4  } },
  { name: 'Quick 2:1 R:R',  exitParams: { stopLoss: -0.03,  takeProfit: 0.06,  maxHold: 96,  trailingStart: 0.08, trailingGiveBack: 0.3  } },
  { name: 'Default 1:1',    exitParams: { stopLoss: -0.05,  takeProfit: 0.05,  maxHold: 120, trailingStart: 0.10, trailingGiveBack: 0.35 } },
  { name: 'Wide Runner',    exitParams: { stopLoss: -0.04,  takeProfit: 0.10,  maxHold: 168, trailingStart: 0.12, trailingGiveBack: 0.25 } },
  { name: 'Asymmetric 3:1', exitParams: { stopLoss: -0.03,  takeProfit: 0.09,  maxHold: 144, trailingStart: 0.10, trailingGiveBack: 0.3  } },
  { name: 'Tight Trail',    exitParams: { stopLoss: -0.04,  takeProfit: 0.08,  maxHold: 120, trailingStart: 0.06, trailingGiveBack: 0.2  } },
];

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

async function waitForTraining(maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await get('/status');
    if (!status.active) return status;
  }
  throw new Error('Training timeout');
}

async function waitForWalkForward(maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await get('/walk-forward/status');
    if (!status.running) return status;
  }
  throw new Error('Walk-forward timeout');
}

async function trainAndReport(seedId, config = {}, label = '') {
  const trainConfig = {
    tickers: TICKERS,
    initialCash: config.initialCash || BUDGET,
    strategyFilter: ['TREND'],
    selectivity: 'normal',
    seedRunId: seedId,
    ...config,
  };
  const startRes = await post('/start', trainConfig);
  if (!startRes.success) {
    console.error(`  ERROR: ${startRes.error}`);
    return null;
  }
  const result = await waitForTraining();
  const s = result.stats;
  if (label) {
    console.log(`  ${label}: ${s.totalTrades} trades, ${s.winRate?.toFixed(1)}% WR, $${s.totalPnl?.toFixed(2)} PnL`);
  }
  return { runId: startRes.runId, stats: s };
}

// ============================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           HYPER-TRAINING — 4 NOVEL TECHNIQUES          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // ============================================================
  // PHASE 1: GENETIC SEED CROSSOVER
  // ============================================================
  console.log('━'.repeat(60));
  console.log('PHASE 1: GENETIC SEED CROSSOVER');
  console.log('Breeding top 3 profit-focused seeds into consensus child...');
  console.log('━'.repeat(60));

  const breedRes = await post('/breed', {
    seedIds: PARENT_SEEDS,
    consensusThreshold: 0.6,
  });
  if (!breedRes.success) {
    console.error('BREED FAILED:', breedRes.error);
    return;
  }
  console.log(`  Bred seed: ${breedRes.runId}`);
  console.log(`  Regime combos: ${breedRes.stats.regimeCombos.kept} kept / ${breedRes.stats.regimeCombos.blocked} blocked`);
  console.log(`  Indicator bins: ${breedRes.stats.indicatorBins.kept} kept / ${breedRes.stats.indicatorBins.blocked} blocked`);

  // Verify bred seed works
  const bredTest = await trainAndReport(breedRes.runId, { initialCash: BUDGET }, 'Bred seed full-year');
  if (!bredTest) return;

  // ============================================================
  // PHASE 2: TEMPORAL CONSENSUS FORGING
  // ============================================================
  console.log('\n' + '━'.repeat(60));
  console.log('PHASE 2: TEMPORAL CONSENSUS FORGING');
  console.log('Training bred seed on each quarter independently...');
  console.log('Only patterns profitable across 3/4+ quarters survive.');
  console.log('━'.repeat(60));

  const quarterRunIds = [];
  for (const q of QUARTERS) {
    console.log(`\n  Training on ${q.name}...`);
    const qResult = await trainAndReport(breedRes.runId, {
      initialCash: BUDGET,
      startTime: q.start,
      endTime: q.end,
    }, `  ${q.name}`);
    if (qResult) {
      quarterRunIds.push(qResult.runId);
    }
  }

  if (quarterRunIds.length < 3) {
    console.error('  Not enough quarter results to breed. Falling back to bred seed.');
  }

  // Breed the quarter results — only universally profitable patterns survive
  let temporalSeedId;
  if (quarterRunIds.length >= 3) {
    console.log(`\n  Breeding ${quarterRunIds.length} quarter results...`);
    const temporalRes = await post('/breed', {
      seedIds: quarterRunIds,
      consensusThreshold: 0.6, // 3/4 must agree
    });
    if (temporalRes.success) {
      temporalSeedId = temporalRes.runId;
      console.log(`  Temporal seed: ${temporalSeedId}`);
      console.log(`  Combos: ${temporalRes.stats.regimeCombos.kept} kept / ${temporalRes.stats.regimeCombos.blocked} blocked`);
      console.log(`  Bins: ${temporalRes.stats.indicatorBins.kept} kept / ${temporalRes.stats.indicatorBins.blocked} blocked`);
    } else {
      console.log(`  Temporal breed failed: ${temporalRes.error}. Using bred seed.`);
      temporalSeedId = breedRes.runId;
    }
  } else {
    temporalSeedId = breedRes.runId;
  }

  // Verify temporal seed
  const temporalTest = await trainAndReport(temporalSeedId, { initialCash: BUDGET }, 'Temporal seed full-year');

  // ============================================================
  // PHASE 3: SURGICAL LOSS AUTOPSY
  // ============================================================
  console.log('\n' + '━'.repeat(60));
  console.log('PHASE 3: SURGICAL LOSS AUTOPSY');
  console.log('Progressive loss elimination — escalating WR thresholds.');
  console.log('Each pass removes the weakest remaining patterns.');
  console.log('━'.repeat(60));

  // 3 rounds with escalating aggressiveness:
  // Round 1: distill at WR >= 0.50 (remove clearly bad patterns)
  // Round 2: distill at WR >= 0.55 (remove mediocre patterns)
  // Round 3: distill at WR >= 0.58 (only keep strong patterns)
  let surgerySeed = temporalSeedId;
  const surgeryRounds = [
    { threshold: 0.50, label: 'Remove clearly bad (WR < 50%)' },
    { threshold: 0.55, label: 'Remove mediocre (WR < 55%)' },
    { threshold: 0.58, label: 'Keep only strong (WR < 58%)' },
  ];

  for (let i = 0; i < surgeryRounds.length; i++) {
    const { threshold, label } = surgeryRounds[i];
    console.log(`\n  Surgery Round ${i + 1}: ${label}`);

    // Train with current seed
    const trainRes = await trainAndReport(surgerySeed, { initialCash: BUDGET }, `  Pre-surgery`);
    if (!trainRes) break;

    // Distill with profit-focused (relative ranking, keeps top 60%)
    const distillRes = await post('/distill', {
      runId: trainRes.runId,
      amplifyBigWins: true,
      profitFocused: true,
    });
    if (distillRes.success) {
      surgerySeed = distillRes.runId;
      console.log(`  Distilled → ${surgerySeed}`);
      console.log(`  Combos: kept=${distillRes.stats.regimeCombos.kept}, removed=${distillRes.stats.regimeCombos.removed}`);
      console.log(`  Bins: kept=${distillRes.stats.indicatorBins.kept}, removed=${distillRes.stats.indicatorBins.removed}`);
    }
  }

  // Verify surgery result
  const surgeryTest = await trainAndReport(surgerySeed, { initialCash: BUDGET }, 'Post-surgery full-year');

  // ============================================================
  // PHASE 4: EXIT PARAMETER EVOLUTION
  // ============================================================
  console.log('\n' + '━'.repeat(60));
  console.log('PHASE 4: EXIT PARAMETER EVOLUTION');
  console.log('Sweeping 6 exit configurations on the hardened seed.');
  console.log('━'.repeat(60));

  const exitResults = [];
  for (const config of EXIT_CONFIGS) {
    console.log(`\n  Testing: ${config.name}`);
    console.log(`    SL=${(config.exitParams.stopLoss * 100).toFixed(1)}%, TP=${(config.exitParams.takeProfit * 100).toFixed(1)}%, MaxHold=${config.exitParams.maxHold}h`);

    // Create modified seed with these exit params
    const modRes = await post('/modify-seed', {
      seedId: surgerySeed,
      exitParams: config.exitParams,
    });
    if (!modRes.success) {
      console.log(`    SKIP: ${modRes.error}`);
      continue;
    }

    // Eval at $1K (our target budget)
    const evalRes = await trainAndReport(modRes.runId, { initialCash: 1000 }, `  $1K eval`);
    if (evalRes) {
      exitResults.push({
        name: config.name,
        exitParams: config.exitParams,
        seedId: modRes.runId,
        trades: evalRes.stats.totalTrades,
        winRate: evalRes.stats.winRate,
        pnl: evalRes.stats.totalPnl,
        returnPct: (evalRes.stats.totalPnl / 1000 * 100),
      });
    }
  }

  // Sort by return
  exitResults.sort((a, b) => b.returnPct - a.returnPct);

  console.log('\n  EXIT SWEEP RESULTS (sorted by return):');
  console.log('  ' + '-'.repeat(70));
  for (const r of exitResults) {
    const bar = r.returnPct >= 0 ? '+' : '';
    console.log(`  ${r.name.padEnd(18)} | ${r.trades} trades | ${r.winRate?.toFixed(1)}% WR | ${bar}${r.returnPct?.toFixed(2)}% return`);
  }

  const bestExit = exitResults[0];
  if (!bestExit) {
    console.error('No exit results. Aborting.');
    return;
  }
  console.log(`\n  BEST EXIT: ${bestExit.name} (${bestExit.returnPct?.toFixed(2)}% return)`);

  // ============================================================
  // PHASE 5: FINAL EVALUATION
  // ============================================================
  console.log('\n' + '━'.repeat(60));
  console.log('PHASE 5: FINAL EVALUATION');
  console.log(`Using best exit config: ${bestExit.name}`);
  console.log('━'.repeat(60));

  const finalSeedId = bestExit.seedId;

  // Pure eval at multiple budgets
  console.log('\n  Pure Evaluation (frozen seed, full year):');
  const evalBudgets = [100, 1000, 10000];
  const evalResults = [];
  for (const budget of evalBudgets) {
    const evalRes = await trainAndReport(finalSeedId, { initialCash: budget }, `  $${budget.toLocaleString()}`);
    if (evalRes) {
      evalResults.push({
        budget,
        trades: evalRes.stats.totalTrades,
        winRate: evalRes.stats.winRate,
        pnl: evalRes.stats.totalPnl,
        returnPct: (evalRes.stats.totalPnl / budget * 100),
      });
    }
  }

  // Walk-forward OOS at $1K
  console.log('\n  Walk-Forward OOS ($1K):');
  const wfRes = await post('/walk-forward/start', {
    trainMonths: 3,
    testMonths: 1,
    stepMonths: 1,
    tickers: TICKERS,
    initialCash: 1000,
    seedRunId: finalSeedId,
    selectivity: 'normal',
    strategyFilter: ['TREND'],
  });
  if (wfRes.success) {
    console.log(`  Walk-forward started: ${wfRes.id}`);
    const wfResult = await waitForWalkForward();
    const agg = wfResult.aggregateOOS;
    console.log(`  OOS: ${agg.totalTrades} trades, ${agg.winRate?.toFixed(1)}% WR, $${agg.totalPnl?.toFixed(2)} (${(agg.totalPnl / 1000 * 100).toFixed(2)}% return)`);

    console.log('\n  Per-fold OOS:');
    for (const fold of wfResult.folds) {
      const status = fold.testTrades === 0 ? 'No trades' : fold.testPnl >= 0 ? 'WIN' : 'LOSS';
      console.log(`    Fold ${fold.foldNumber}: ${fold.testTrades} trades, ${fold.testWinRate?.toFixed(0)}% WR, $${fold.testPnl?.toFixed(2)} [${status}]`);
    }
  }

  // Walk-forward OOS at $100
  console.log('\n  Walk-Forward OOS ($100):');
  const wf100Res = await post('/walk-forward/start', {
    trainMonths: 3,
    testMonths: 1,
    stepMonths: 1,
    tickers: TICKERS,
    initialCash: 100,
    seedRunId: finalSeedId,
    selectivity: 'normal',
    strategyFilter: ['TREND'],
  });
  if (wf100Res.success) {
    const wf100Result = await waitForWalkForward();
    const agg100 = wf100Result.aggregateOOS;
    console.log(`  OOS: ${agg100.totalTrades} trades, ${agg100.winRate?.toFixed(1)}% WR, $${agg100.totalPnl?.toFixed(2)} (${(agg100.totalPnl / 100 * 100).toFixed(2)}% return)`);
  }

  // ============================================================
  // GRAND SUMMARY
  // ============================================================
  console.log('\n' + '╔' + '═'.repeat(58) + '╗');
  console.log('║' + '         HYPER-TRAINING GRAND SUMMARY'.padEnd(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');

  console.log('\n  Phase Progression:');
  if (bredTest) console.log(`    Phase 1 (Genetic Crossover):   ${bredTest.stats.totalTrades} trades, ${bredTest.stats.winRate?.toFixed(1)}% WR, $${bredTest.stats.totalPnl?.toFixed(2)}`);
  if (temporalTest) console.log(`    Phase 2 (Temporal Consensus):  ${temporalTest.stats.totalTrades} trades, ${temporalTest.stats.winRate?.toFixed(1)}% WR, $${temporalTest.stats.totalPnl?.toFixed(2)}`);
  if (surgeryTest) console.log(`    Phase 3 (Loss Autopsy):        ${surgeryTest.stats.totalTrades} trades, ${surgeryTest.stats.winRate?.toFixed(1)}% WR, $${surgeryTest.stats.totalPnl?.toFixed(2)}`);
  console.log(`    Phase 4 (Best Exit — ${bestExit.name}): ${bestExit.trades} trades, ${bestExit.winRate?.toFixed(1)}% WR, +${bestExit.returnPct?.toFixed(2)}% at $1K`);

  console.log('\n  Final Seed Pure Evaluation:');
  for (const r of evalResults) {
    console.log(`    $${r.budget.toLocaleString().padStart(6)}: ${r.trades} trades, ${r.winRate?.toFixed(1)}% WR, $${r.pnl?.toFixed(2)} (${r.returnPct?.toFixed(2)}% return)`);
  }

  console.log(`\n  Final Seed ID: ${finalSeedId}`);
  console.log(`  Best Exit Config: ${bestExit.name} — SL=${(bestExit.exitParams.stopLoss * 100).toFixed(1)}%, TP=${(bestExit.exitParams.takeProfit * 100).toFixed(1)}%, MaxHold=${bestExit.exitParams.maxHold}h`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
