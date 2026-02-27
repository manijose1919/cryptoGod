/**
 * EXPERIMENTAL TRAINING — Wild Ideas to Push TREND Further
 *
 * 1. Entry Threshold Sweep (TREND_BULLISH_ENTRY optimization)
 * 2. Per-Ticker Specialization (separate seeds for BTC/ETH/XRP/SOL)
 * 3. Regime-Specific Exit Params (UP_TREND wide, SIDEWAYS tight)
 * 4. Time-of-Day Analysis (find & block bad hours)
 * 5. Combined: stack all winning optimizations together
 */

const BASE_URL = 'http://localhost:3033/api/training';
const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD'];
const CHAMPION = 'mod_1772140204357_36785c3c'; // Hyper-trained TREND champion

// Best exit from previous session
const BEST_EXIT = { stopLoss: -0.035, takeProfit: 0.12, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 };

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
function hdr(t){log('\n'+'━'.repeat(60));log(t);log('━'.repeat(60));}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║       EXPERIMENTAL TRAINING — WILD IDEAS                ║');
  log('╚══════════════════════════════════════════════════════════╝\n');

  // ============================================================
  // 1. ENTRY THRESHOLD SWEEP
  // ============================================================
  hdr('1. ENTRY THRESHOLD SWEEP (TREND_BULLISH_ENTRY)');
  log('Testing different entry selectivity thresholds...\n');

  const thresholds = [15, 20, 25, 30, 35, 40, 45, 50];
  const threshResults = [];

  for (const thresh of thresholds) {
    const mod = await post('/modify-seed', {
      seedId: CHAMPION,
      exitParams: BEST_EXIT,
      optimizedParams: { TREND_BULLISH_ENTRY: thresh },
    });
    if (!mod.success) continue;
    const r = await train(mod.runId, { initialCash: 1000 });
    if (!r) continue;
    const ret = (r.stats.totalPnl / 1000 * 100);
    threshResults.push({ thresh, seedId: mod.runId, trades: r.stats.totalTrades, wr: r.stats.winRate, ret });
    log(`  Entry=${thresh}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
  }
  threshResults.sort((a,b) => b.ret - a.ret);
  const bestThresh = threshResults[0];
  log(`\n  >>> BEST THRESHOLD: ${bestThresh?.thresh} (${bestThresh?.ret?.toFixed(2)}% return, ${bestThresh?.trades} trades)`);

  // ============================================================
  // 2. PER-TICKER SPECIALIZATION
  // ============================================================
  hdr('2. PER-TICKER SPECIALIZATION');
  log('Training + distilling separate seeds per ticker...\n');

  const tickerResults = [];
  for (const ticker of TICKERS) {
    // Train per-ticker from champion seed
    const r1 = await train(CHAMPION, { tickers: [ticker], initialCash: 1000000 });
    if (!r1) continue;

    // Distill 5 rounds
    let seed = null;
    const d0 = await post('/distill', { runId: r1.runId, amplifyBigWins: true, profitFocused: true });
    if (d0.success) seed = d0.runId;
    for (let i = 0; i < 4 && seed; i++) {
      const r2 = await train(seed, { tickers: [ticker] });
      if (!r2) break;
      const d2 = await post('/distill', { runId: r2.runId, amplifyBigWins: true, profitFocused: true });
      if (d2.success) seed = d2.runId;
    }

    if (seed) {
      // Apply best exit and eval at $1K
      const mod = await post('/modify-seed', { seedId: seed, exitParams: BEST_EXIT });
      if (mod.success) {
        const evalR = await train(mod.runId, { initialCash: 1000, tickers: [ticker] });
        if (evalR) {
          const ret = (evalR.stats.totalPnl / 1000 * 100);
          tickerResults.push({ ticker, seedId: mod.runId, trades: evalR.stats.totalTrades, wr: evalR.stats.winRate, ret });
          log(`  ${ticker}: ${evalR.stats.totalTrades} trades, ${evalR.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
        }
      }
    }
  }

  // Compare with generic seed per-ticker
  log('\n  Generic seed per-ticker comparison:');
  const mod0 = await post('/modify-seed', { seedId: CHAMPION, exitParams: BEST_EXIT });
  for (const ticker of TICKERS) {
    if (!mod0.success) break;
    const r = await train(mod0.runId, { initialCash: 1000, tickers: [ticker] });
    if (r) {
      const ret = (r.stats.totalPnl / 1000 * 100);
      log(`  ${ticker} (generic): ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
    }
  }

  // ============================================================
  // 3. REGIME-SPECIFIC EXITS
  // ============================================================
  hdr('3. REGIME-SPECIFIC EXIT PARAMS');
  log('Testing different exit rules for UP_TREND vs SIDEWAYS...\n');

  const regimeConfigs = [
    {
      name: 'UP wide / SIDEWAYS tight',
      overrides: {
        UP_TREND: { takeProfit: 0.15, trailingStart: 0.12, trailingGiveBack: 0.20 },
        SIDEWAYS: { takeProfit: 0.06, maxHold: 96, trailingStart: 0.05, trailingGiveBack: 0.30 },
      },
    },
    {
      name: 'UP ultra-wide / SIDEWAYS default',
      overrides: {
        UP_TREND: { takeProfit: 0.20, maxHold: 240, trailingStart: 0.15, trailingGiveBack: 0.15 },
        SIDEWAYS: { takeProfit: 0.08, maxHold: 120, trailingStart: 0.08, trailingGiveBack: 0.25 },
      },
    },
    {
      name: 'UP runner / SIDEWAYS scalp',
      overrides: {
        UP_TREND: { takeProfit: 0.18, stopLoss: -0.05, maxHold: 200, trailingStart: 0.10, trailingGiveBack: 0.20 },
        SIDEWAYS: { takeProfit: 0.04, stopLoss: -0.025, maxHold: 72, trailingStart: 0.04, trailingGiveBack: 0.35 },
      },
    },
    {
      name: 'Aggressive everywhere',
      overrides: {
        UP_TREND: { takeProfit: 0.20, stopLoss: -0.05, maxHold: 336, trailingStart: 0.15, trailingGiveBack: 0.15 },
        SIDEWAYS: { takeProfit: 0.15, stopLoss: -0.04, maxHold: 168, trailingStart: 0.12, trailingGiveBack: 0.20 },
        STRONG_DOWN: { takeProfit: 0.05, stopLoss: -0.02, maxHold: 48, trailingStart: 0.04, trailingGiveBack: 0.30 },
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
    if (!mod.success) continue;
    const r = await train(mod.runId, { initialCash: 1000 });
    if (!r) continue;
    const ret = (r.stats.totalPnl / 1000 * 100);
    regimeResults.push({ name: cfg.name, seedId: mod.runId, overrides: cfg.overrides, trades: r.stats.totalTrades, wr: r.stats.winRate, ret });
    log(`  ${cfg.name}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
  }

  // Baseline comparison (no regime overrides)
  const baseR = await train(mod0.runId, { initialCash: 1000 });
  if (baseR) {
    const baseRet = (baseR.stats.totalPnl / 1000 * 100);
    log(`  Baseline (no regime overrides): ${baseR.stats.totalTrades} trades, ${baseR.stats.winRate?.toFixed(1)}% WR, ${baseRet>=0?'+':''}${baseRet.toFixed(2)}% return`);
  }

  regimeResults.sort((a,b) => b.ret - a.ret);
  const bestRegime = regimeResults[0];
  log(`\n  >>> BEST REGIME CONFIG: ${bestRegime?.name} (${bestRegime?.ret?.toFixed(2)}% return)`);

  // ============================================================
  // 4. TIME-OF-DAY ANALYSIS
  // ============================================================
  hdr('4. TIME-OF-DAY ANALYSIS');
  log('Finding which hours are profitable/unprofitable...\n');

  // Get trades from a full-year training run
  const fullRun = await train(mod0.success ? mod0.runId : CHAMPION, { initialCash: 1000000 });
  if (fullRun) {
    const tradesRes = await get(`/trades/${fullRun.runId}?limit=2000`);
    const trades = Array.isArray(tradesRes) ? tradesRes : [];

    if (trades.length > 0) {
      // Analyze by hour
      const hourStats = {};
      for (let h = 0; h < 24; h++) hourStats[h] = { wins: 0, losses: 0, pnl: 0 };

      for (const t of trades) {
        if (t.type === 'SELL' && t.pnl !== undefined) {
          // Find the matching buy trade to get entry hour
          // Trades alternate BUY/SELL, so look backwards
        }
        if (t.type === 'BUY') {
          const hour = new Date(t.time).getUTCHours();
          // Find the next SELL for this ticker to get PnL
          const sellIdx = trades.findIndex((s, i) => i > trades.indexOf(t) && s.ticker === t.ticker && s.type === 'SELL');
          if (sellIdx >= 0) {
            const sell = trades[sellIdx];
            if (sell.pnl > 0) hourStats[hour].wins++;
            else hourStats[hour].losses++;
            hourStats[hour].pnl += sell.pnl || 0;
          }
        }
      }

      log('  Hour | Wins | Losses | WR    | PnL');
      log('  ' + '-'.repeat(50));
      const badHours = [];
      for (let h = 0; h < 24; h++) {
        const s = hourStats[h];
        const total = s.wins + s.losses;
        if (total === 0) continue;
        const wr = (s.wins / total * 100).toFixed(0);
        const tag = s.pnl < 0 && total >= 3 ? ' *** BAD' : '';
        if (s.pnl < 0 && total >= 3) badHours.push(h);
        log(`   ${String(h).padStart(2)}:00 | ${String(s.wins).padStart(4)} | ${String(s.losses).padStart(6)} | ${wr.padStart(4)}% | $${s.pnl.toFixed(0)}${tag}`);
      }

      log(`\n  Bad hours (negative PnL, 3+ trades): ${badHours.join(', ') || 'none'}`);

      // Test with bad hours blocked
      if (badHours.length > 0) {
        log(`\n  Testing with ${badHours.length} bad hours blocked...`);
        const modBlocked = await post('/modify-seed', {
          seedId: CHAMPION,
          exitParams: BEST_EXIT,
          blockedHours: badHours,
        });
        if (modBlocked.success) {
          const rBlocked = await train(modBlocked.runId, { initialCash: 1000 });
          if (rBlocked) {
            const ret = (rBlocked.stats.totalPnl / 1000 * 100);
            log(`  With blocked hours: ${rBlocked.stats.totalTrades} trades, ${rBlocked.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
            log(`  Without blocked hours: ${baseR?.stats.totalTrades} trades, ${baseR?.stats.winRate?.toFixed(1)}% WR (baseline)`);
          }
        }
      }
    }
  }

  // ============================================================
  // 5. COMBINE ALL WINNERS
  // ============================================================
  hdr('5. COMBINE ALL WINNING OPTIMIZATIONS');
  log('Stacking best threshold + best regime exits + blocked hours...\n');

  // Build the ultimate seed with all optimizations
  const mods = {
    exitParams: BEST_EXIT,
  };
  if (bestThresh) mods.optimizedParams = { TREND_BULLISH_ENTRY: bestThresh.thresh };
  if (bestRegime) mods.regimeExitOverrides = bestRegime.overrides;

  // Collect bad hours from analysis
  const fullRunTrades = fullRun ? await get(`/trades/${fullRun.runId}?limit=2000`) : [];
  const allTrades = Array.isArray(fullRunTrades) ? fullRunTrades : [];
  const hourPnl = {};
  for (let h = 0; h < 24; h++) hourPnl[h] = { count: 0, pnl: 0 };
  for (const t of allTrades) {
    if (t.type === 'BUY') {
      const hour = new Date(t.time).getUTCHours();
      const sellIdx = allTrades.findIndex((s, i) => i > allTrades.indexOf(t) && s.ticker === t.ticker && s.type === 'SELL');
      if (sellIdx >= 0) { hourPnl[hour].count++; hourPnl[hour].pnl += allTrades[sellIdx].pnl || 0; }
    }
  }
  const computedBadHours = Object.entries(hourPnl).filter(([,v]) => v.pnl < 0 && v.count >= 3).map(([h]) => parseInt(h));
  if (computedBadHours.length > 0 && computedBadHours.length <= 12) {
    mods.blockedHours = computedBadHours;
  }

  log(`  Best threshold: ${bestThresh?.thresh}`);
  log(`  Best regime config: ${bestRegime?.name}`);
  log(`  Blocked hours: ${mods.blockedHours?.join(', ') || 'none'}`);

  const ultimateMod = await post('/modify-seed', { seedId: CHAMPION, ...mods });
  if (!ultimateMod.success) { log('  FAILED: ' + ultimateMod.error); return; }

  // Evaluate the ultimate seed
  log('\n  Ultimate seed evaluation:');
  for (const budget of [100, 1000, 10000]) {
    const r = await train(ultimateMod.runId, { initialCash: budget });
    if (r) {
      const ret = (r.stats.totalPnl / budget * 100);
      log(`    $${budget.toLocaleString().padStart(6)}: ${r.stats.totalTrades} trades, ${r.stats.winRate?.toFixed(1)}% WR, ${ret>=0?'+':''}${ret.toFixed(2)}% return`);
    }
  }

  // Walk-forward OOS
  log('\n  Walk-Forward OOS ($1K):');
  const wf = await post('/walk-forward/start', {
    trainMonths:3, testMonths:1, stepMonths:1,
    tickers:TICKERS, initialCash:1000,
    seedRunId:ultimateMod.runId, selectivity:'normal', strategyFilter:['TREND'],
  });
  if (wf.success) {
    const r = await waitWF();
    const a = r.aggregateOOS;
    const wins = r.folds.filter(f=>f.testPnl>0).length;
    const active = r.folds.filter(f=>f.testTrades>0).length;
    log(`    OOS: ${a.totalTrades} trades, ${a.winRate?.toFixed(1)}% WR, $${a.totalPnl?.toFixed(2)} (${(a.totalPnl/1000*100).toFixed(2)}% return) — ${wins}/${active} folds profitable`);
    for (const f of r.folds) {
      const s = f.testTrades===0?'SKIP':f.testPnl>=0?'WIN ':'LOSS';
      log(`      F${f.foldNumber}: ${f.testTrades}t, ${f.testWinRate?.toFixed(0)}%WR, $${f.testPnl?.toFixed(2)} [${s}]`);
    }
  }

  // Walk-forward $100
  const wf100 = await post('/walk-forward/start', {
    trainMonths:3, testMonths:1, stepMonths:1,
    tickers:TICKERS, initialCash:100,
    seedRunId:ultimateMod.runId, selectivity:'normal', strategyFilter:['TREND'],
  });
  if (wf100.success) {
    const r100 = await waitWF();
    const a100 = r100.aggregateOOS;
    log(`\n    $100 OOS: ${a100.totalTrades} trades, ${a100.winRate?.toFixed(1)}% WR, $${a100.totalPnl?.toFixed(2)} (${(a100.totalPnl/100*100).toFixed(2)}% return)`);
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  log('\n' + '╔' + '═'.repeat(58) + '╗');
  log('║' + '    EXPERIMENTAL TRAINING RESULTS'.padEnd(58) + '║');
  log('╚' + '═'.repeat(58) + '╝');

  log('\n  Entry Threshold Rankings:');
  for (const r of threshResults.slice(0,5)) log(`    Entry=${r.thresh}: ${r.trades}t, ${r.wr?.toFixed(1)}%WR, ${r.ret>=0?'+':''}${r.ret.toFixed(2)}%`);

  log('\n  Per-Ticker Results (specialized vs generic):');
  for (const r of tickerResults) log(`    ${r.ticker}: ${r.trades}t, ${r.wr?.toFixed(1)}%WR, ${r.ret>=0?'+':''}${r.ret.toFixed(2)}%`);

  log('\n  Regime-Specific Exit Rankings:');
  for (const r of regimeResults) log(`    ${r.name}: ${r.trades}t, ${r.wr?.toFixed(1)}%WR, ${r.ret>=0?'+':''}${r.ret.toFixed(2)}%`);

  log(`\n  Ultimate Seed: ${ultimateMod.runId}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
