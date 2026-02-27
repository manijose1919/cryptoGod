/**
 * MEGA-TRAINING SCRIPT — Everything Combined
 *
 * PART A: Push TREND even further
 *   A1: Re-distill current champion (10 rounds)
 *   A2: Fine-tune exit params within Wide Runner sweet spot
 *
 * PART B: Multi-Strategy Training (all 7 strategies)
 *   B1: Fresh training with ALL strategies enabled ($1M, max trades)
 *   B2: Profit-focused distillation (15 rounds)
 *   B3: Hyper-training (breed sweet spots + surgical loss autopsy)
 *   B4: Exit parameter evolution (6 configs)
 *
 * PART C: Grand Combination
 *   C1: Breed best TREND + best multi-strategy seeds
 *   C2: Final evaluation at $100, $1K, $10K
 *   C3: Walk-forward OOS + per-ticker breakdown
 */

const BASE_URL = 'http://localhost:3033/api/training';
const BUDGET = 1000000;
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];
const ALL_STRATEGIES = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];

// Current TREND champion from hyper-training
const TREND_CHAMPION = 'mod_1772140204357_36785c3c';

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

async function train(seedId, config = {}) {
  const trainConfig = {
    tickers: TICKERS,
    initialCash: config.initialCash || BUDGET,
    selectivity: 'normal',
    ...config,
  };
  if (seedId) trainConfig.seedRunId = seedId;
  const startRes = await post('/start', trainConfig);
  if (!startRes.success) return null;
  const result = await waitForTraining();
  return { runId: startRes.runId, stats: result.stats };
}

function log(msg) { console.log(msg); }
function header(title) {
  log('\n' + '━'.repeat(60));
  log(title);
  log('━'.repeat(60));
}

// ============================================================
async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║        MEGA-TRAINING — ALL STRATEGIES UNLEASHED        ║');
  log('╚══════════════════════════════════════════════════════════╝\n');

  // ============================================================
  // PART A: PUSH TREND FURTHER
  // ============================================================
  log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  log('  PART A: PUSH TREND CHAMPION FURTHER');
  log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');

  // --- A1: Re-distill champion 10 rounds ---
  header('A1: RE-DISTILL TREND CHAMPION (10 rounds)');
  let trendSeed = TREND_CHAMPION;
  const trendRounds = [];

  for (let i = 1; i <= 10; i++) {
    const r = await train(trendSeed, { strategyFilter: ['TREND'] });
    if (!r) break;

    const d = await post('/distill', { runId: r.runId, amplifyBigWins: true, profitFocused: true });
    if (!d.success) break;
    trendSeed = d.runId;

    trendRounds.push({ round: i, trades: r.stats.totalTrades, winRate: r.stats.winRate, pnl: r.stats.totalPnl });
    log(`  Round ${i}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, $${r.stats.totalPnl?.toFixed(0)} PnL → ${d.runId}`);
  }

  // --- A2: Exit fine-tune within Wide Runner range ---
  header('A2: EXIT FINE-TUNING (Wide Runner variants)');
  const exitGrid = [
    { sl: -0.035, tp: 0.09,  label: 'SL3.5/TP9' },
    { sl: -0.035, tp: 0.10,  label: 'SL3.5/TP10' },
    { sl: -0.035, tp: 0.12,  label: 'SL3.5/TP12' },
    { sl: -0.04,  tp: 0.09,  label: 'SL4/TP9' },
    { sl: -0.04,  tp: 0.11,  label: 'SL4/TP11' },
    { sl: -0.04,  tp: 0.12,  label: 'SL4/TP12' },
    { sl: -0.045, tp: 0.10,  label: 'SL4.5/TP10' },
    { sl: -0.045, tp: 0.12,  label: 'SL4.5/TP12' },
  ];

  const exitResults = [];
  for (const ep of exitGrid) {
    const mod = await post('/modify-seed', {
      seedId: trendSeed,
      exitParams: {
        stopLoss: ep.sl, takeProfit: ep.tp,
        maxHold: 168, trailingStart: 0.12, trailingGiveBack: 0.25,
      },
    });
    if (!mod.success) continue;
    const r = await train(mod.runId, { initialCash: 1000, strategyFilter: ['TREND'] });
    if (!r) continue;
    exitResults.push({
      label: ep.label, seedId: mod.runId, sl: ep.sl, tp: ep.tp,
      trades: r.stats.totalTrades, winRate: r.stats.winRate,
      pnl: r.stats.totalPnl, ret: (r.stats.totalPnl / 1000 * 100),
    });
    log(`  ${ep.label}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${(r.stats.totalPnl / 1000 * 100).toFixed(2)}% return`);
  }

  // Also test trailing variations on best SL/TP
  exitResults.sort((a, b) => b.ret - a.ret);
  const bestSlTp = exitResults[0];
  log(`\n  Best SL/TP: ${bestSlTp?.label} (${bestSlTp?.ret?.toFixed(2)}% return)`);

  if (bestSlTp) {
    const trailVariants = [
      { start: 0.08, give: 0.20, label: 'Trail8/20' },
      { start: 0.10, give: 0.22, label: 'Trail10/22' },
      { start: 0.15, give: 0.25, label: 'Trail15/25' },
      { start: 0.12, give: 0.30, label: 'Trail12/30' },
    ];
    log('\n  Trailing refinement on best SL/TP:');
    for (const tv of trailVariants) {
      const mod = await post('/modify-seed', {
        seedId: trendSeed,
        exitParams: {
          stopLoss: bestSlTp.sl, takeProfit: bestSlTp.tp,
          maxHold: 168, trailingStart: tv.start, trailingGiveBack: tv.give,
        },
      });
      if (!mod.success) continue;
      const r = await train(mod.runId, { initialCash: 1000, strategyFilter: ['TREND'] });
      if (!r) continue;
      const ret = (r.stats.totalPnl / 1000 * 100);
      exitResults.push({
        label: `${bestSlTp.label}+${tv.label}`, seedId: mod.runId,
        sl: bestSlTp.sl, tp: bestSlTp.tp,
        trades: r.stats.totalTrades, winRate: r.stats.winRate,
        pnl: r.stats.totalPnl, ret,
      });
      log(`    ${tv.label}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret.toFixed(2)}% return`);
    }
  }

  exitResults.sort((a, b) => b.ret - a.ret);
  const bestTrend = exitResults[0];
  log(`\n  >>> BEST TREND CONFIG: ${bestTrend?.label} — ${bestTrend?.ret?.toFixed(2)}% return, ${bestTrend?.trades} trades, ${bestTrend?.winRate?.toFixed(1)}% WR`);

  // ============================================================
  // PART B: MULTI-STRATEGY TRAINING
  // ============================================================
  log('\n' + '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  log('  PART B: MULTI-STRATEGY TRAINING (ALL 7 STRATEGIES)');
  log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');

  // --- B1: Fresh multi-strategy training ---
  header('B1: FRESH MULTI-STRATEGY TRAINING ($1M, all strategies)');
  const multiBase = await train(null, {
    strategyFilter: ALL_STRATEGIES,
    initialCash: BUDGET,
  });
  if (multiBase) {
    log(`  Baseline: ${multiBase.stats.totalTrades} trades, ${multiBase.stats.winRate?.toFixed(1)}% WR, $${multiBase.stats.totalPnl?.toFixed(0)}`);
  }

  // --- B2: Profit-focused distillation (15 rounds) ---
  header('B2: MULTI-STRATEGY DISTILLATION (15 rounds)');
  let multiSeed = null;
  const multiResults = [];
  const multiSeedIds = {};

  if (multiBase) {
    let currentSeed = null;
    // First distill from the base run
    const d0 = await post('/distill', { runId: multiBase.runId, amplifyBigWins: true, profitFocused: true });
    if (d0.success) currentSeed = d0.runId;

    for (let i = 1; i <= 15; i++) {
      if (!currentSeed) break;
      const r = await train(currentSeed, { strategyFilter: ALL_STRATEGIES });
      if (!r) break;

      const d = await post('/distill', { runId: r.runId, amplifyBigWins: true, profitFocused: true });
      if (!d.success) break;
      currentSeed = d.runId;
      multiSeedIds[i] = d.runId;

      multiResults.push({ round: i, trades: r.stats.totalTrades, winRate: r.stats.winRate, pnl: r.stats.totalPnl });
      log(`  Round ${i}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, $${r.stats.totalPnl?.toFixed(0)}`);
    }
    multiSeed = currentSeed;
  }

  // --- B3: Hyper-train the multi-strategy seed ---
  header('B3: MULTI-STRATEGY HYPER-TRAINING');

  // Find sweet-spot rounds (top 3 by PnL with >= 10 trades)
  const multiGood = multiResults
    .filter(r => r.trades >= 10)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 3);

  let hyperMultiSeed = multiSeed;

  if (multiGood.length >= 2) {
    const breedIds = multiGood.map(r => multiSeedIds[r.round]).filter(Boolean);
    if (breedIds.length >= 2) {
      log(`  Breeding top ${breedIds.length} multi-strategy seeds...`);
      const bred = await post('/breed', { seedIds: breedIds, consensusThreshold: 0.5 });
      if (bred.success) {
        hyperMultiSeed = bred.runId;
        log(`  Bred → ${bred.runId}: ${bred.stats.regimeCombos.kept} combos, ${bred.stats.indicatorBins.kept} bins`);
      }
    }
  }

  // Surgical loss autopsy (3 rounds)
  if (hyperMultiSeed) {
    log('\n  Surgical loss autopsy on multi-strategy seed...');
    for (let i = 0; i < 3; i++) {
      const r = await train(hyperMultiSeed, { strategyFilter: ALL_STRATEGIES });
      if (!r) break;
      const d = await post('/distill', { runId: r.runId, amplifyBigWins: true, profitFocused: true });
      if (d.success) {
        hyperMultiSeed = d.runId;
        log(`    Surgery ${i + 1}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR → ${d.runId}`);
      }
    }
  }

  // Verify hyper-trained multi-strategy
  const multiTest = hyperMultiSeed ? await train(hyperMultiSeed, { strategyFilter: ALL_STRATEGIES }) : null;
  if (multiTest) {
    log(`  Multi-strategy hyper-trained: ${multiTest.stats.totalTrades} trades, ${multiTest.stats.winRate?.toFixed(1)}% WR, $${multiTest.stats.totalPnl?.toFixed(0)}`);
  }

  // --- B4: Exit evolution for multi-strategy ---
  header('B4: MULTI-STRATEGY EXIT EVOLUTION');
  const multiExitConfigs = [
    { name: 'Default 1:1',    ep: { stopLoss: -0.05, takeProfit: 0.05,  maxHold: 120, trailingStart: 0.10, trailingGiveBack: 0.35 } },
    { name: 'Wide Runner',    ep: { stopLoss: -0.04, takeProfit: 0.10,  maxHold: 168, trailingStart: 0.12, trailingGiveBack: 0.25 } },
    { name: 'Asymmetric 3:1', ep: { stopLoss: -0.03, takeProfit: 0.09,  maxHold: 144, trailingStart: 0.10, trailingGiveBack: 0.30 } },
    { name: 'Tight Trail',    ep: { stopLoss: -0.04, takeProfit: 0.08,  maxHold: 120, trailingStart: 0.06, trailingGiveBack: 0.20 } },
    { name: 'Ultra Wide',     ep: { stopLoss: -0.05, takeProfit: 0.15,  maxHold: 240, trailingStart: 0.15, trailingGiveBack: 0.20 } },
    { name: 'Quick Scalp',    ep: { stopLoss: -0.025,takeProfit: 0.04,  maxHold: 72,  trailingStart: 0.05, trailingGiveBack: 0.40 } },
  ];

  const multiExitResults = [];
  for (const cfg of multiExitConfigs) {
    if (!hyperMultiSeed) break;
    const mod = await post('/modify-seed', { seedId: hyperMultiSeed, exitParams: cfg.ep });
    if (!mod.success) continue;
    const r = await train(mod.runId, { initialCash: 1000, strategyFilter: ALL_STRATEGIES });
    if (!r) continue;
    const ret = (r.stats.totalPnl / 1000 * 100);
    multiExitResults.push({ name: cfg.name, seedId: mod.runId, ...r.stats, ret });
    log(`  ${cfg.name}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret.toFixed(2)}% return`);
  }

  multiExitResults.sort((a, b) => b.ret - a.ret);
  const bestMulti = multiExitResults[0];
  log(`\n  >>> BEST MULTI-STRATEGY: ${bestMulti?.name} — ${bestMulti?.ret?.toFixed(2)}% return, ${bestMulti?.totalTrades} trades`);

  // ============================================================
  // PART B5: INDIVIDUAL STRATEGY TRAINING
  // ============================================================
  header('B5: INDIVIDUAL STRATEGY TRAINING');
  log('Training each strategy in isolation to find hidden gems...');

  const strategyResults = [];
  for (const strat of ALL_STRATEGIES) {
    const r = await train(null, { strategyFilter: [strat], initialCash: BUDGET });
    if (!r) continue;

    // Quick distill (3 rounds) to see potential
    let seed = null;
    const d0 = await post('/distill', { runId: r.runId, amplifyBigWins: true, profitFocused: true });
    if (d0.success) seed = d0.runId;

    for (let i = 0; i < 3 && seed; i++) {
      const r2 = await train(seed, { strategyFilter: [strat] });
      if (!r2) break;
      const d2 = await post('/distill', { runId: r2.runId, amplifyBigWins: true, profitFocused: true });
      if (d2.success) seed = d2.runId;
    }

    // Eval at $1K with Wide Runner exits
    if (seed) {
      const mod = await post('/modify-seed', {
        seedId: seed,
        exitParams: { stopLoss: -0.04, takeProfit: 0.10, maxHold: 168, trailingStart: 0.12, trailingGiveBack: 0.25 },
      });
      if (mod.success) {
        const evalR = await train(mod.runId, { initialCash: 1000, strategyFilter: [strat] });
        if (evalR) {
          const ret = (evalR.stats.totalPnl / 1000 * 100);
          strategyResults.push({
            strategy: strat, seedId: mod.runId,
            trades: evalR.stats.totalTrades, winRate: evalR.stats.winRate,
            pnl: evalR.stats.totalPnl, ret,
          });
          const bar = ret >= 0 ? '+' : '';
          log(`  ${strat.padEnd(12)}: ${evalR.stats.totalTrades} trades, ${evalR.stats.winRate?.toFixed(1)}% WR, ${bar}${ret.toFixed(2)}% return`);
        }
      }
    }
  }

  strategyResults.sort((a, b) => b.ret - a.ret);
  log('\n  Individual Strategy Rankings:');
  for (const r of strategyResults) {
    const bar = r.ret >= 0 ? '+' : '';
    log(`    ${r.strategy.padEnd(12)} | ${r.trades} trades | ${r.winRate?.toFixed(1)}% WR | ${bar}${r.ret.toFixed(2)}% return`);
  }

  // ============================================================
  // PART C: GRAND COMBINATION
  // ============================================================
  log('\n' + '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  log('  PART C: GRAND COMBINATION');
  log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');

  // --- C1: Breed best TREND + best multi-strategy + top individual strategies ---
  header('C1: BREEDING CHAMPIONS');

  const breedCandidates = [];
  if (bestTrend?.seedId) breedCandidates.push(bestTrend.seedId);
  if (bestMulti?.seedId) breedCandidates.push(bestMulti.seedId);

  // Add top 2 individual strategy seeds (if profitable)
  const profitableStrats = strategyResults.filter(r => r.ret > 5);
  for (const ps of profitableStrats.slice(0, 2)) {
    if (ps.seedId && !breedCandidates.includes(ps.seedId)) {
      breedCandidates.push(ps.seedId);
    }
  }

  let grandSeed = bestTrend?.seedId;
  if (breedCandidates.length >= 2) {
    log(`  Breeding ${breedCandidates.length} champion seeds...`);
    const grandBred = await post('/breed', {
      seedIds: breedCandidates,
      consensusThreshold: 0.5,
    });
    if (grandBred.success) {
      grandSeed = grandBred.runId;
      log(`  Grand bred seed: ${grandBred.runId}`);
      log(`    Combos: ${grandBred.stats.regimeCombos.kept} kept / ${grandBred.stats.regimeCombos.blocked} blocked`);
      log(`    Bins: ${grandBred.stats.indicatorBins.kept} kept / ${grandBred.stats.indicatorBins.blocked} blocked`);
    }
  } else {
    log(`  Only ${breedCandidates.length} candidates, using best TREND seed directly`);
  }

  // Apply best exit config to grand seed
  if (grandSeed && bestTrend) {
    const mod = await post('/modify-seed', {
      seedId: grandSeed,
      exitParams: {
        stopLoss: bestTrend.sl || -0.04,
        takeProfit: bestTrend.tp || 0.10,
        maxHold: 168,
        trailingStart: 0.12,
        trailingGiveBack: 0.25,
      },
    });
    if (mod.success) grandSeed = mod.runId;
  }

  // --- C2: Final evaluation at multiple budgets ---
  header('C2: FINAL EVALUATION');

  // TREND-only eval
  log('\n  TREND-only evaluation:');
  for (const budget of [100, 1000, 10000]) {
    const r = await train(grandSeed, { initialCash: budget, strategyFilter: ['TREND'] });
    if (r) {
      log(`    $${budget.toLocaleString().padStart(6)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, $${r.stats.totalPnl?.toFixed(2)} (${(r.stats.totalPnl / budget * 100).toFixed(2)}% return)`);
    }
  }

  // All-strategy eval
  log('\n  All-strategy evaluation:');
  for (const budget of [100, 1000, 10000]) {
    const r = await train(grandSeed, { initialCash: budget, strategyFilter: ALL_STRATEGIES });
    if (r) {
      log(`    $${budget.toLocaleString().padStart(6)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, $${r.stats.totalPnl?.toFixed(2)} (${(r.stats.totalPnl / budget * 100).toFixed(2)}% return)`);
    }
  }

  // Per-ticker breakdown at $1K
  log('\n  Per-ticker breakdown ($1K, TREND):');
  for (const ticker of TICKERS) {
    const r = await train(grandSeed, { initialCash: 1000, strategyFilter: ['TREND'], tickers: [ticker] });
    if (r) {
      log(`    ${ticker.padEnd(7)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, $${r.stats.totalPnl?.toFixed(2)} (${(r.stats.totalPnl / 1000 * 100).toFixed(2)}% return)`);
    }
  }

  // --- C3: Walk-forward OOS ---
  header('C3: WALK-FORWARD OUT-OF-SAMPLE');

  // WF TREND-only $1K
  log('\n  Walk-Forward TREND-only ($1K):');
  const wfTrend = await post('/walk-forward/start', {
    trainMonths: 3, testMonths: 1, stepMonths: 1,
    tickers: TICKERS, initialCash: 1000,
    seedRunId: grandSeed, selectivity: 'normal',
    strategyFilter: ['TREND'],
  });
  if (wfTrend.success) {
    const wfResult = await waitForWalkForward();
    const agg = wfResult.aggregateOOS;
    log(`    OOS: ${agg.totalTrades} trades, ${agg.winRate?.toFixed(1)}% WR, $${agg.totalPnl?.toFixed(2)} (${(agg.totalPnl / 1000 * 100).toFixed(2)}% return)`);
    const wins = wfResult.folds.filter(f => f.testPnl > 0).length;
    const total = wfResult.folds.filter(f => f.testTrades > 0).length;
    log(`    Profitable folds: ${wins}/${total}`);
  }

  // WF All-strategy $1K
  log('\n  Walk-Forward ALL STRATEGIES ($1K):');
  const wfAll = await post('/walk-forward/start', {
    trainMonths: 3, testMonths: 1, stepMonths: 1,
    tickers: TICKERS, initialCash: 1000,
    seedRunId: grandSeed, selectivity: 'normal',
    strategyFilter: ALL_STRATEGIES,
  });
  if (wfAll.success) {
    const wfResult = await waitForWalkForward();
    const agg = wfResult.aggregateOOS;
    log(`    OOS: ${agg.totalTrades} trades, ${agg.winRate?.toFixed(1)}% WR, $${agg.totalPnl?.toFixed(2)} (${(agg.totalPnl / 1000 * 100).toFixed(2)}% return)`);
    const wins = wfResult.folds.filter(f => f.testPnl > 0).length;
    const total = wfResult.folds.filter(f => f.testTrades > 0).length;
    log(`    Profitable folds: ${wins}/${total}`);
  }

  // ============================================================
  // GRAND SUMMARY
  // ============================================================
  log('\n' + '╔' + '═'.repeat(58) + '╗');
  log('║' + '          MEGA-TRAINING GRAND SUMMARY'.padEnd(58) + '║');
  log('╚' + '═'.repeat(58) + '╝');

  log('\n  TREND Re-Distillation Progression:');
  for (const r of trendRounds) {
    log(`    Round ${String(r.round).padStart(2)}: ${String(r.trades).padStart(4)} trades, ${r.winRate?.toFixed(1)}% WR, $${r.pnl?.toFixed(0)}`);
  }

  log('\n  Multi-Strategy Distillation Progression:');
  for (const r of multiResults) {
    log(`    Round ${String(r.round).padStart(2)}: ${String(r.trades).padStart(4)} trades, ${r.winRate?.toFixed(1)}% WR, $${r.pnl?.toFixed(0)}`);
  }

  log('\n  Exit Fine-Tuning Top 5:');
  for (const r of exitResults.slice(0, 5)) {
    log(`    ${r.label.padEnd(22)} | ${r.trades} trades | ${r.winRate?.toFixed(1)}% WR | ${r.ret?.toFixed(2)}% return`);
  }

  log('\n  Individual Strategy Rankings:');
  for (const r of strategyResults) {
    const bar = r.ret >= 0 ? '+' : '';
    log(`    ${r.strategy.padEnd(12)} | ${r.trades} trades | ${r.winRate?.toFixed(1)}% WR | ${bar}${r.ret.toFixed(2)}% return`);
  }

  log(`\n  Grand Seed: ${grandSeed}`);
  log(`  Best TREND exit: ${bestTrend?.label} (${bestTrend?.ret?.toFixed(2)}% return)`);
  log(`  Best Multi exit: ${bestMulti?.name} (${bestMulti?.ret?.toFixed(2)}% return)`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
