/**
 * FINAL COMBO — Best threshold (25) + Best regime exits (Let winners run) + WF OOS
 */
const BASE_URL = 'http://localhost:3033/api/training';
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];
const CHAMPION = 'mod_1772140204357_36785c3c';
const BEST_EXIT = { stopLoss: -0.035, takeProfit: 0.12, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 };
const BEST_THRESHOLD = 25;
const BEST_REGIME = {
  STRONG_UP: { takeProfit: 0.35, stopLoss: -0.05, maxHold: 500, trailingStart: 0.25, trailingGiveBack: 0.08 },
  UP: { takeProfit: 0.20, stopLoss: -0.04, maxHold: 300, trailingStart: 0.15, trailingGiveBack: 0.12 },
  SIDEWAYS: { takeProfit: 0.12, stopLoss: -0.035, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 },
  DOWN: { takeProfit: 0.08, stopLoss: -0.03, maxHold: 96, trailingStart: 0.06, trailingGiveBack: 0.25 },
  STRONG_DOWN: { takeProfit: 0.05, stopLoss: -0.02, maxHold: 48, trailingStart: 0.04, trailingGiveBack: 0.35 },
};

async function post(p, b) { return (await fetch(BASE_URL+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json(); }
async function get(p) { return (await fetch(BASE_URL+p)).json(); }
async function wait(ms=300000) { const s=Date.now(); while(Date.now()-s<ms){await new Promise(r=>setTimeout(r,2000));const st=await get('/status');if(!st.active)return st;} throw new Error('timeout'); }
async function waitWF(ms=900000) { const s=Date.now(); while(Date.now()-s<ms){await new Promise(r=>setTimeout(r,5000));const st=await get('/walk-forward/status');if(!st.running)return st;} throw new Error('wf timeout'); }

async function train(seedId, cfg={}) {
  const c = { tickers:TICKERS, initialCash:cfg.initialCash||1000000, strategyFilter:['TREND'], selectivity:'normal', ...cfg };
  if(seedId) c.seedRunId=seedId;
  const s=await post('/start',c); if(!s.success){ console.log('START FAILED:', s.error); return null; }
  const r=await wait(); return {runId:s.runId,stats:r.stats};
}

function log(m){console.log(m);}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  FINAL COMBO: Threshold 25 + Let Winners Run Regime     ║');
  log('╚══════════════════════════════════════════════════════════╝\n');

  // Create the ultimate seed
  const mod = await post('/modify-seed', {
    seedId: CHAMPION,
    exitParams: BEST_EXIT,
    regimeExitOverrides: BEST_REGIME,
    optimizedParams: { TREND_BULLISH_ENTRY: BEST_THRESHOLD },
  });
  if (!mod.success) { log('FAILED: ' + mod.error); return; }
  log(`  Ultimate seed: ${mod.runId}\n`);

  // In-sample evaluation at multiple budgets
  log('━━━ IN-SAMPLE EVALUATION ━━━\n');
  for (const budget of [20, 100, 1000, 10000]) {
    const r = await train(mod.runId, { initialCash: budget });
    if (r) {
      const ret = (r.stats.totalPnl / budget * 100);
      log(`  $${String(budget).padStart(6)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return ($${(budget+r.stats.totalPnl).toFixed(2)} final)`);
    }
  }

  // Also test regime-only (no threshold change) for comparison
  log('\n━━━ COMPARISON: Regime-only vs Threshold-only vs Combined ━━━\n');

  // Regime-only
  const regimeMod = await post('/modify-seed', {
    seedId: CHAMPION,
    exitParams: BEST_EXIT,
    regimeExitOverrides: BEST_REGIME,
  });
  if (regimeMod.success) {
    const r = await train(regimeMod.runId, { initialCash: 1000 });
    if (r) {
      const ret = (r.stats.totalPnl / 1000 * 100);
      log(`  Regime-only:    ${r.stats.totalTrades}t, ${r.stats.winRate?.toFixed(1)}%WR, ${ret>=0?'+':''}${ret.toFixed(2)}%`);
    }
  }

  // Threshold-only
  const threshMod = await post('/modify-seed', {
    seedId: CHAMPION,
    exitParams: BEST_EXIT,
    optimizedParams: { TREND_BULLISH_ENTRY: BEST_THRESHOLD },
  });
  if (threshMod.success) {
    const r = await train(threshMod.runId, { initialCash: 1000 });
    if (r) {
      const ret = (r.stats.totalPnl / 1000 * 100);
      log(`  Threshold-only: ${r.stats.totalTrades}t, ${r.stats.winRate?.toFixed(1)}%WR, ${ret>=0?'+':''}${ret.toFixed(2)}%`);
    }
  }

  // Combined (already tested above, but again at $1K for clean comparison)
  const comboR = await train(mod.runId, { initialCash: 1000 });
  if (comboR) {
    const ret = (comboR.stats.totalPnl / 1000 * 100);
    log(`  Combined:       ${comboR.stats.totalTrades}t, ${comboR.stats.winRate?.toFixed(1)}%WR, ${ret>=0?'+':''}${ret.toFixed(2)}%`);
  }

  // Baseline
  const baseMod = await post('/modify-seed', { seedId: CHAMPION, exitParams: BEST_EXIT });
  if (baseMod.success) {
    const r = await train(baseMod.runId, { initialCash: 1000 });
    if (r) {
      const ret = (r.stats.totalPnl / 1000 * 100);
      log(`  Baseline:       ${r.stats.totalTrades}t, ${r.stats.winRate?.toFixed(1)}%WR, ${ret>=0?'+':''}${ret.toFixed(2)}%`);
    }
  }

  // Walk-forward OOS
  log('\n━━━ WALK-FORWARD OOS ($1K) ━━━\n');
  const wf = await post('/walk-forward/start', {
    trainMonths:3, testMonths:1, stepMonths:1,
    tickers:TICKERS, initialCash:1000,
    seedRunId:mod.runId, selectivity:'normal', strategyFilter:['TREND'],
  });
  if (wf.success) {
    const r = await waitWF();
    const a = r.aggregateOOS;
    const wins = r.folds?.filter(f=>f.testPnl>0).length || 0;
    const active = r.folds?.filter(f=>f.testTrades>0).length || 0;
    log(`  OOS: ${a?.totalTrades} trades, ${a?.winRate?.toFixed(1)}% WR, $${a?.totalPnl?.toFixed(2)} (${(a?.totalPnl/1000*100).toFixed(2)}% return) — ${wins}/${active} folds profitable`);
    for (const f of (r.folds||[])) {
      const s = f.testTrades===0?'SKIP':f.testPnl>=0?'WIN ':'LOSS';
      log(`    F${f.foldNumber}: ${f.testTrades}t, ${f.testWinRate?.toFixed(0)}%WR, $${f.testPnl?.toFixed(2)} [${s}]`);
    }
  }

  // Walk-forward at $100 and $20
  for (const budget of [100, 20]) {
    log(`\n  Walk-Forward OOS ($${budget}):`);
    const wfSmall = await post('/walk-forward/start', {
      trainMonths:3, testMonths:1, stepMonths:1,
      tickers:TICKERS, initialCash:budget,
      seedRunId:mod.runId, selectivity:'normal', strategyFilter:['TREND'],
    });
    if (wfSmall.success) {
      const rSmall = await waitWF();
      const aSmall = rSmall.aggregateOOS;
      const winsSmall = rSmall.folds?.filter(f=>f.testPnl>0).length || 0;
      const activeSmall = rSmall.folds?.filter(f=>f.testTrades>0).length || 0;
      log(`    OOS: ${aSmall?.totalTrades}t, ${aSmall?.winRate?.toFixed(1)}%WR, $${aSmall?.totalPnl?.toFixed(2)} (${(aSmall?.totalPnl/budget*100).toFixed(2)}%) — ${winsSmall}/${activeSmall} folds profitable`);
    }
  }

  log(`\n  ULTIMATE SEED ID: ${mod.runId}`);
  log('  Config: TREND_BULLISH_ENTRY=25, SL=-3.5%, TP=+12%, MaxHold=168h, Trail 8%/20%');
  log('  Regime overrides: STRONG_UP=TP35%/Trail25%/8%, UP=TP20%/Trail15%/12%, SIDEWAYS=default, DOWN=TP8%/Trail6%/25%, STRONG_DOWN=TP5%/Trail4%/35%');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
