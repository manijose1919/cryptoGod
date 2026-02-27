/**
 * Iterative Distillation Training Script — PROFIT-FOCUSED MODE
 *
 * Runs N rounds of: train (max trades) → distill (keep biggest profits) → seed next round
 * No targetWinRate filter — let all trades through, distillation cleans up losses.
 */

const BASE_URL = 'http://localhost:3033/api/training';
const BUDGET = 1000000;
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];
const ROUNDS = 25;

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

async function waitForTraining(maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await get('/status');
    if (!status.active) return status;
  }
  throw new Error('Training timeout');
}

async function waitForWalkForward(maxWaitMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await get('/walk-forward/status');
    if (!status.running) return status;
  }
  throw new Error('Walk-forward timeout');
}

async function main() {
  console.log('=== PROFIT-FOCUSED ITERATIVE DISTILLATION ===');
  console.log(`Budget: $${BUDGET.toLocaleString()}, Rounds: ${ROUNDS}`);
  console.log('Mode: MAX PROFIT — no targetWinRate, profitFocused distillation');
  console.log('');

  // Fresh start — no seed, no WR filtering
  let currentSeedId = null;
  const results = [];
  const seedIds = {}; // Track seed IDs by round for sweet-spot eval

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`ROUND ${round}/${ROUNDS}`);
    console.log(`${'='.repeat(60)}`);

    // --- Step 1: Train with maximum trades (no WR filter) ---
    const trainConfig = {
      tickers: TICKERS,
      initialCash: BUDGET,
      strategyFilter: ['TREND'],
      selectivity: 'normal',
      // NO targetWinRate — let all trades through
    };
    if (currentSeedId) {
      trainConfig.seedRunId = currentSeedId;
    }

    console.log(`\n[Round ${round}] Starting training (no WR filter, max trades)...`);
    console.log(`  Seed: ${currentSeedId || 'none (cold start)'}`);
    const startRes = await post('/start', trainConfig);
    if (!startRes.success) {
      console.error(`  ERROR: ${startRes.error}`);
      break;
    }
    console.log(`  RunId: ${startRes.runId}`);

    const trainResult = await waitForTraining();
    const s = trainResult.stats;
    console.log(`  Result: ${s.totalTrades} trades, ${s.winRate?.toFixed(1)}% WR, $${s.totalPnl?.toFixed(2)} PnL`);

    // --- Step 2: Distill with PROFIT-FOCUSED mode ---
    console.log(`\n[Round ${round}] Distilling (profit-focused)...`);
    const distillRes = await post('/distill', {
      runId: startRes.runId,
      amplifyBigWins: true,
      profitFocused: true,  // Use avgPnl, not WR, to keep/block combos
    });
    if (!distillRes.success) {
      console.error(`  ERROR: ${distillRes.error}`);
      break;
    }
    const ds = distillRes.stats;
    console.log(`  Distilled → ${distillRes.runId}`);
    console.log(`  Regime combos: kept=${ds.regimeCombos.kept}, removed=${ds.regimeCombos.removed}, amplified=${ds.regimeCombos.amplified}`);
    console.log(`  Indicator bins: kept=${ds.indicatorBins.kept}, removed=${ds.indicatorBins.removed}`);

    currentSeedId = distillRes.runId;
    seedIds[round] = distillRes.runId;

    results.push({
      round,
      trainRunId: startRes.runId,
      distillRunId: distillRes.runId,
      trades: s.totalTrades,
      winRate: s.winRate,
      pnl: s.totalPnl,
      keptCombos: ds.regimeCombos.kept,
      removedCombos: ds.regimeCombos.removed,
      keptBins: ds.indicatorBins.kept,
      removedBins: ds.indicatorBins.removed,
    });
  }

  // --- Summary Table ---
  console.log(`\n${'='.repeat(60)}`);
  console.log('ITERATION SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log('Round | Trades | WR     | PnL           | Kept/Removed Combos');
  console.log('-'.repeat(70));
  for (const r of results) {
    console.log(`  ${String(r.round).padStart(2)}   | ${String(r.trades).padStart(6)} | ${r.winRate?.toFixed(1).padStart(5)}% | $${r.pnl?.toFixed(2).padStart(12)} | ${r.keptCombos}/${r.removedCombos} combos, ${r.keptBins}/${r.removedBins} bins`);
  }

  // --- Sweet-Spot Evaluation ---
  // Find rounds where PnL was highest and trades were still meaningful (>10)
  const goodRounds = results
    .filter(r => r.trades >= 10)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 6); // Top 6 by PnL

  console.log(`\n${'='.repeat(60)}`);
  console.log('SWEET-SPOT PURE EVALUATION (frozen seed, $1K and $100)');
  console.log(`${'='.repeat(60)}`);
  console.log('Evaluating top rounds by PnL magnitude...\n');

  for (const r of goodRounds) {
    const seedId = seedIds[r.round];
    if (!seedId) continue;

    // Evaluate at $1K
    const eval1k = await post('/start', {
      tickers: TICKERS,
      initialCash: 1000,
      strategyFilter: ['TREND'],
      selectivity: 'normal',
      seedRunId: seedId,
    });
    if (eval1k.success) {
      const res1k = await waitForTraining();
      const s1k = res1k.stats;

      // Evaluate at $100
      const eval100 = await post('/start', {
        tickers: TICKERS,
        initialCash: 100,
        strategyFilter: ['TREND'],
        selectivity: 'normal',
        seedRunId: seedId,
      });
      if (eval100.success) {
        const res100 = await waitForTraining();
        const s100 = res100.stats;

        console.log(`  Round ${r.round} seed (${seedId}):`);
        console.log(`    $1M train: ${r.trades} trades, ${r.winRate?.toFixed(1)}% WR, $${r.pnl?.toFixed(2)} PnL`);
        console.log(`    $1K eval:  ${s1k.totalTrades} trades, ${s1k.winRate?.toFixed(1)}% WR, $${s1k.totalPnl?.toFixed(2)} (${(s1k.totalPnl / 1000 * 100).toFixed(2)}% return)`);
        console.log(`    $100 eval: ${s100.totalTrades} trades, ${s100.winRate?.toFixed(1)}% WR, $${s100.totalPnl?.toFixed(2)} (${(s100.totalPnl / 100 * 100).toFixed(2)}% return)`);
        console.log('');
      }
    }
  }

  // --- Final Walk-Forward on best seed ---
  const bestRound = goodRounds[0];
  const bestSeedId = bestRound ? seedIds[bestRound.round] : currentSeedId;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`WALK-FORWARD VALIDATION (best seed: Round ${bestRound?.round || 'final'})`);
  console.log(`${'='.repeat(60)}`);

  // WF at $1K
  const wf1kRes = await post('/walk-forward/start', {
    trainMonths: 3,
    testMonths: 1,
    stepMonths: 1,
    tickers: TICKERS,
    initialCash: 1000,
    seedRunId: bestSeedId,
    selectivity: 'normal',
    strategyFilter: ['TREND'],
  });
  console.log(`Walk-forward $1K started: ${wf1kRes.id}`);

  const wf1kResult = await waitForWalkForward();
  const agg1k = wf1kResult.aggregateOOS;
  console.log(`\nOOS $1K: ${agg1k.totalTrades} trades, ${agg1k.winRate?.toFixed(1)}% WR, $${agg1k.totalPnl?.toFixed(2)} (${(agg1k.totalPnl / 1000 * 100).toFixed(2)}% return)`);

  console.log('\nPer-fold OOS:');
  for (const fold of wf1kResult.folds) {
    const status = fold.testTrades === 0 ? 'No trades' : fold.testPnl >= 0 ? 'WIN' : 'LOSS';
    console.log(`  Fold ${fold.foldNumber}: ${fold.testTrades} trades, ${fold.testWinRate?.toFixed(0)}% WR, $${fold.testPnl?.toFixed(2)} [${status}]`);
  }

  // WF at $100
  const wf100Res = await post('/walk-forward/start', {
    trainMonths: 3,
    testMonths: 1,
    stepMonths: 1,
    tickers: TICKERS,
    initialCash: 100,
    seedRunId: bestSeedId,
    selectivity: 'normal',
    strategyFilter: ['TREND'],
  });
  console.log(`\nWalk-forward $100 started: ${wf100Res.id}`);

  const wf100Result = await waitForWalkForward();
  const agg100 = wf100Result.aggregateOOS;
  console.log(`OOS $100: ${agg100.totalTrades} trades, ${agg100.winRate?.toFixed(1)}% WR, $${agg100.totalPnl?.toFixed(2)} (${(agg100.totalPnl / 100 * 100).toFixed(2)}% return)`);

  // --- Final Summary ---
  console.log(`\n${'='.repeat(60)}`);
  console.log('FINAL RESULTS');
  console.log(`${'='.repeat(60)}`);
  console.log(`Best seed: Round ${bestRound?.round || 'final'} (${bestSeedId})`);
  console.log(`Best $1M in-sample: ${bestRound?.trades} trades, ${bestRound?.winRate?.toFixed(1)}% WR, $${bestRound?.pnl?.toFixed(2)}`);
  console.log(`WF OOS $1K: ${agg1k.totalTrades} trades, ${agg1k.winRate?.toFixed(1)}% WR, $${agg1k.totalPnl?.toFixed(2)}`);
  console.log(`WF OOS $100: ${agg100.totalTrades} trades, ${agg100.winRate?.toFixed(1)}% WR, $${agg100.totalPnl?.toFixed(2)}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
