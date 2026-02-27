/**
 * REGIME EXIT FIX — Re-run with correct regime names
 * Regime values: STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN
 */

const BASE_URL = 'http://localhost:3033/api/training';
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];
const CHAMPION = 'mod_1772140204357_36785c3c';
const BEST_EXIT = { stopLoss: -0.035, takeProfit: 0.12, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 };
const BEST_THRESHOLD = 25; // From experiment 1

async function post(p, b) { return (await fetch(BASE_URL+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json(); }
async function get(p) { return (await fetch(BASE_URL+p)).json(); }
async function wait(ms=180000) { const s=Date.now(); while(Date.now()-s<ms){await new Promise(r=>setTimeout(r,2000));const st=await get('/status');if(!st.active)return st;} throw new Error('timeout'); }
async function waitWF(ms=600000) { const s=Date.now(); while(Date.now()-s<ms){await new Promise(r=>setTimeout(r,5000));const st=await get('/walk-forward/status');if(!st.running)return st;} throw new Error('wf timeout'); }

async function train(seedId, cfg={}) {
  const c = { tickers:TICKERS, initialCash:cfg.initialCash||1000000, strategyFilter:['TREND'], selectivity:'normal', ...cfg };
  if(seedId) c.seedRunId=seedId;
  const s=await post('/start',c); if(!s.success)return null;
  const r=await wait(); return {runId:s.runId,stats:r.stats};
}

function log(m){console.log(m);}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  REGIME EXIT FIX + COMBINED OPTIMIZATION                ║');
  log('╚══════════════════════════════════════════════════════════╝\n');

  // ============================================================
  // REGIME-SPECIFIC EXITS (with correct keys!)
  // Regimes: STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN
  // ============================================================
  log('━━━ REGIME-SPECIFIC EXIT PARAMS (FIXED KEYS) ━━━\n');

  const regimeConfigs = [
    {
      name: 'UP wide / SIDEWAYS tight / DOWN defensive',
      overrides: {
        STRONG_UP: { takeProfit: 0.18, stopLoss: -0.05, maxHold: 240, trailingStart: 0.14, trailingGiveBack: 0.15 },
        UP: { takeProfit: 0.15, stopLoss: -0.04, maxHold: 200, trailingStart: 0.12, trailingGiveBack: 0.18 },
        SIDEWAYS: { takeProfit: 0.06, stopLoss: -0.025, maxHold: 96, trailingStart: 0.05, trailingGiveBack: 0.30 },
        DOWN: { takeProfit: 0.05, stopLoss: -0.02, maxHold: 72, trailingStart: 0.04, trailingGiveBack: 0.35 },
        STRONG_DOWN: { takeProfit: 0.04, stopLoss: -0.015, maxHold: 48, trailingStart: 0.03, trailingGiveBack: 0.40 },
      },
    },
    {
      name: 'Ultra-wide UP / Block STRONG_DOWN',
      overrides: {
        STRONG_UP: { takeProfit: 0.25, stopLoss: -0.06, maxHold: 336, trailingStart: 0.18, trailingGiveBack: 0.12 },
        UP: { takeProfit: 0.20, stopLoss: -0.05, maxHold: 240, trailingStart: 0.15, trailingGiveBack: 0.15 },
        SIDEWAYS: { takeProfit: 0.08, stopLoss: -0.03, maxHold: 120, trailingStart: 0.07, trailingGiveBack: 0.25 },
        DOWN: { takeProfit: 0.06, stopLoss: -0.025, maxHold: 72, trailingStart: 0.05, trailingGiveBack: 0.30 },
        STRONG_DOWN: { takeProfit: 0.03, stopLoss: -0.01, maxHold: 24, trailingStart: 0.02, trailingGiveBack: 0.50 },
      },
    },
    {
      name: 'Asymmetric: big runners UP / quick exits DOWN',
      overrides: {
        STRONG_UP: { takeProfit: 0.30, stopLoss: -0.04, maxHold: 336, trailingStart: 0.20, trailingGiveBack: 0.10 },
        UP: { takeProfit: 0.18, stopLoss: -0.035, maxHold: 200, trailingStart: 0.12, trailingGiveBack: 0.15 },
        SIDEWAYS: { takeProfit: 0.10, stopLoss: -0.03, maxHold: 120, trailingStart: 0.08, trailingGiveBack: 0.22 },
        DOWN: { takeProfit: 0.04, stopLoss: -0.02, maxHold: 48, trailingStart: 0.035, trailingGiveBack: 0.40 },
        STRONG_DOWN: { takeProfit: 0.03, stopLoss: -0.015, maxHold: 24, trailingStart: 0.025, trailingGiveBack: 0.50 },
      },
    },
    {
      name: 'Conservative: tight everywhere + wide in STRONG_UP only',
      overrides: {
        STRONG_UP: { takeProfit: 0.20, stopLoss: -0.04, maxHold: 200, trailingStart: 0.15, trailingGiveBack: 0.15 },
        UP: { takeProfit: 0.10, stopLoss: -0.03, maxHold: 144, trailingStart: 0.08, trailingGiveBack: 0.20 },
        SIDEWAYS: { takeProfit: 0.05, stopLoss: -0.02, maxHold: 72, trailingStart: 0.04, trailingGiveBack: 0.30 },
        DOWN: { takeProfit: 0.04, stopLoss: -0.015, maxHold: 48, trailingStart: 0.03, trailingGiveBack: 0.35 },
        STRONG_DOWN: { takeProfit: 0.03, stopLoss: -0.01, maxHold: 24, trailingStart: 0.02, trailingGiveBack: 0.50 },
      },
    },
    {
      name: 'Let winners run: high trailing + wide targets',
      overrides: {
        STRONG_UP: { takeProfit: 0.35, stopLoss: -0.05, maxHold: 500, trailingStart: 0.25, trailingGiveBack: 0.08 },
        UP: { takeProfit: 0.20, stopLoss: -0.04, maxHold: 300, trailingStart: 0.15, trailingGiveBack: 0.12 },
        SIDEWAYS: { takeProfit: 0.12, stopLoss: -0.035, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 },
        DOWN: { takeProfit: 0.08, stopLoss: -0.03, maxHold: 96, trailingStart: 0.06, trailingGiveBack: 0.25 },
        STRONG_DOWN: { takeProfit: 0.05, stopLoss: -0.02, maxHold: 48, trailingStart: 0.04, trailingGiveBack: 0.35 },
      },
    },
    {
      name: 'Scalp DOWN / Marathon UP',
      overrides: {
        STRONG_UP: { takeProfit: 0.25, stopLoss: -0.06, maxHold: 400, trailingStart: 0.20, trailingGiveBack: 0.10 },
        UP: { takeProfit: 0.15, stopLoss: -0.04, maxHold: 200, trailingStart: 0.10, trailingGiveBack: 0.15 },
        SIDEWAYS: { takeProfit: 0.08, stopLoss: -0.03, maxHold: 96, trailingStart: 0.06, trailingGiveBack: 0.22 },
        DOWN: { takeProfit: 0.035, stopLoss: -0.015, maxHold: 36, trailingStart: 0.03, trailingGiveBack: 0.45 },
        STRONG_DOWN: { takeProfit: 0.02, stopLoss: -0.01, maxHold: 12, trailingStart: 0.015, trailingGiveBack: 0.60 },
      },
    },
  ];

  const regimeResults = [];
  for (const cfg of regimeConfigs) {
    const mod = await post('/modify-seed', {
      seedId: CHAMPION,
      exitParams: BEST_EXIT,
      regimeExitOverrides: cfg.overrides,
    });
    if (!mod.success) { log(`  ${cfg.name}: FAILED - ${mod.error}`); continue; }
    const r = await train(mod.runId, { initialCash: 1000 });
    if (!r) continue;
    const ret = (r.stats.totalPnl / 1000 * 100);
    regimeResults.push({ name: cfg.name, seedId: mod.runId, overrides: cfg.overrides, trades: r.stats.totalTrades, wr: r.stats.winRate, ret });
    log(`  ${cfg.name}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
  }

  // Baseline (no regime overrides, same exit)
  const baseMod = await post('/modify-seed', { seedId: CHAMPION, exitParams: BEST_EXIT });
  if (baseMod.success) {
    const baseR = await train(baseMod.runId, { initialCash: 1000 });
    if (baseR) {
      const baseRet = (baseR.stats.totalPnl / 1000 * 100);
      log(`  Baseline (no overrides): ${baseR.stats.totalTrades} trades, ${baseR.stats.winRate?.toFixed(1)}% WR, ${baseRet>=0?'+':''}${baseRet.toFixed(2)}% return`);
    }
  }

  regimeResults.sort((a,b) => b.ret - a.ret);
  log('\n  Rankings:');
  for (const r of regimeResults) log(`    ${r.name}: ${r.trades}t, ${r.wr?.toFixed(1)}%WR, ${r.ret>=0?'+':''}${r.ret.toFixed(2)}%`);
  const bestRegime = regimeResults[0];
  log(`\n  >>> BEST: ${bestRegime?.name} (${bestRegime?.ret?.toFixed(2)}%)`);

  // Also test regime exits WITH the optimized threshold (25)
  if (bestRegime) {
    log('\n━━━ BEST REGIME + BEST THRESHOLD (25) COMBO ━━━\n');
    const comboMod = await post('/modify-seed', {
      seedId: CHAMPION,
      exitParams: BEST_EXIT,
      regimeExitOverrides: bestRegime.overrides,
      optimizedParams: { TREND_BULLISH_ENTRY: BEST_THRESHOLD },
    });
    if (comboMod.success) {
      // Eval at multiple budgets
      for (const budget of [100, 1000, 10000]) {
        const r = await train(comboMod.runId, { initialCash: budget });
        if (r) {
          const ret = (r.stats.totalPnl / budget * 100);
          log(`  $${budget.toLocaleString().padStart(6)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
        }
      }

      // Walk-forward OOS
      log('\n  Walk-Forward OOS ($1K):');
      const wf = await post('/walk-forward/start', {
        trainMonths:3, testMonths:1, stepMonths:1,
        tickers:TICKERS, initialCash:1000,
        seedRunId:comboMod.runId, selectivity:'normal', strategyFilter:['TREND'],
      });
      if (wf.success) {
        const r = await waitWF();
        const a = r.aggregateOOS;
        const wins = r.folds?.filter(f=>f.testPnl>0).length || 0;
        const active = r.folds?.filter(f=>f.testTrades>0).length || 0;
        log(`    OOS: ${a?.totalTrades} trades, ${a?.winRate?.toFixed(1)}% WR, $${a?.totalPnl?.toFixed(2)} (${(a?.totalPnl/1000*100).toFixed(2)}% return) — ${wins}/${active} folds profitable`);
        for (const f of (r.folds||[])) {
          const s = f.testTrades===0?'SKIP':f.testPnl>=0?'WIN ':'LOSS';
          log(`      F${f.foldNumber}: ${f.testTrades}t, ${f.testWinRate?.toFixed(0)}%WR, $${f.testPnl?.toFixed(2)} [${s}]`);
        }
      }

      log(`\n  ULTIMATE SEED: ${comboMod.runId}`);
    }
  }

  // ============================================================
  // BONUS: Test regime-only (no threshold change) with WF
  // ============================================================
  if (bestRegime && bestRegime.ret > 35.87) {
    log('\n━━━ REGIME-ONLY WALK-FORWARD ━━━\n');
    const wf2 = await post('/walk-forward/start', {
      trainMonths:3, testMonths:1, stepMonths:1,
      tickers:TICKERS, initialCash:1000,
      seedRunId: bestRegime.seedId, selectivity:'normal', strategyFilter:['TREND'],
    });
    if (wf2.success) {
      const r2 = await waitWF();
      const a2 = r2.aggregateOOS;
      log(`  Regime-only OOS: ${a2?.totalTrades} trades, ${a2?.winRate?.toFixed(1)}% WR, $${a2?.totalPnl?.toFixed(2)} (${(a2?.totalPnl/1000*100).toFixed(2)}%)`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
