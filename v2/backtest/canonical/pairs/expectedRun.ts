// Focused FIL/ICP backtest using the EXACT live engine PAIRS_CONFIG params.
// Three windows (30d/60d/90d), shown side-by-side with taker (matches paper
// mode) and maker (matches Phase B live target) fee profiles.
//
// Goal: give the operator concrete expectations for what to see during the
// 30-day Phase A paper run.
//
// Run: npx tsx v2/backtest/canonical/pairs/expectedRun.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllCandles } from '../../candleCache.ts';
// @ts-expect-error JS module without types
import { initializeDatabase } from '../../../../services/database.js';
import { runPairsBacktest, type PairsRunResult } from './pairsRunner.ts';
import { testCointegration } from './stats.ts';
import { PAIRS_CONFIG } from '../../../engine/config.ts';

const WINDOWS_DAYS = [30, 60, 90];
const INTERVAL = '1h';

// Build PairsParams from the live engine config so backtest = live.
const LIVE_PARAMS = {
  entryZ: PAIRS_CONFIG.ENTRY_Z,
  exitZ: PAIRS_CONFIG.EXIT_Z,
  stopZ: PAIRS_CONFIG.STOP_Z,
  maxHoldBars: PAIRS_CONFIG.MAX_HOLD_BARS,
  reestimateBars: PAIRS_CONFIG.REESTIMATE_BETA_EVERY_BARS,
  rollingWindow: PAIRS_CONFIG.ROLLING_WINDOW_BARS,
  allowShortSpread: PAIRS_CONFIG.ALLOW_SHORT_SPREAD,
};

interface Cell {
  windowDays: number;
  feeMode: 'taker' | 'maker';
  result: PairsRunResult;
}

async function main(): Promise<void> {
  initializeDatabase();

  const symA = PAIRS_CONFIG.SYMBOL_A;
  const symB = PAIRS_CONFIG.SYMBOL_B;
  // End 3h ago so we hit the existing candle cache (CryptoCompare rate-limit safe)
  const endDate = new Date(Date.now() - 3 * 3600 * 1000);
  // 90d window + 720-bar warmup buffer (~30d) = 120 days of data needed.
  const startDate = new Date(endDate.getTime() - 150 * 86_400_000);

  console.log(`\n=== FIL/ICP Expected-Behavior Backtest ===`);
  console.log(`Pair       : ${symA} / ${symB}`);
  console.log(`Params     : entryZ=${LIVE_PARAMS.entryZ} exitZ=${LIVE_PARAMS.exitZ} stopZ=${LIVE_PARAMS.stopZ}`);
  console.log(`             maxHold=${LIVE_PARAMS.maxHoldBars}bars reestimate=${LIVE_PARAMS.reestimateBars}bars`);
  console.log(`             rolling=${LIVE_PARAMS.rollingWindow}bars allowShort=${LIVE_PARAMS.allowShortSpread}`);
  console.log(`Notional   : $${PAIRS_CONFIG.TOTAL_NOTIONAL_USD} total ($${PAIRS_CONFIG.LEG_NOTIONAL_USD}/leg)`);
  console.log(`Windows    : ${WINDOWS_DAYS.join('d, ')}d`);
  console.log(`Fees       : taker=${(PAIRS_CONFIG.FEE_PER_LEG_TAKER * 100).toFixed(3)}%/leg/side`);
  console.log(`             maker=${(PAIRS_CONFIG.FEE_PER_LEG_MAKER * 100).toFixed(3)}%/leg/side`);
  console.log('');

  const candleMap = await loadAllCandles([symA, symB], startDate, endDate, INTERVAL);
  const ca = candleMap.get(symA);
  const cb = candleMap.get(symB);
  if (!ca || !cb) {
    throw new Error(`failed to load candles: A=${ca?.length ?? 0} B=${cb?.length ?? 0}`);
  }
  // Align by timestamp
  const mapB = new Map(cb.map(c => [c.time, c]));
  const alignedA = ca.filter(a => mapB.has(a.time));
  const alignedB = alignedA.map(a => mapB.get(a.time)!);
  console.log(`Aligned bars: ${alignedA.length}\n`);

  const cells: Cell[] = [];
  const perWindowCointegration: Record<number, ReturnType<typeof testCointegration>> = {};

  for (const days of WINDOWS_DAYS) {
    const totalBars = days * 24;
    const windowStartBar = Math.max(0, alignedA.length - totalBars);
    const endBar = alignedA.length;

    // Cointegration stats for THIS window (helps the operator interpret results)
    const logA = alignedA.slice(windowStartBar, endBar).map(c => Math.log(c.close));
    const logB = alignedB.slice(windowStartBar, endBar).map(c => Math.log(c.close));
    perWindowCointegration[days] = testCointegration(logA, logB);

    for (const feeMode of ['taker', 'maker'] as const) {
      const feeRT = feeMode === 'maker' ? PAIRS_CONFIG.FEE_PER_LEG_MAKER : PAIRS_CONFIG.FEE_PER_LEG_TAKER;
      const warmup = PAIRS_CONFIG.WARMUP_BARS;
      const result = runPairsBacktest({
        symA, symB,
        candlesA: alignedA, candlesB: alignedB,
        startBar: windowStartBar, endBar,
        warmupBars: warmup,
        budget: PAIRS_CONFIG.TOTAL_NOTIONAL_USD,
        positionPercent: 1.0,                  // use full $1000 (matches engine)
        feeRoundTripPerLeg: feeRT,
        slippagePerSide: PAIRS_CONFIG.SLIPPAGE_PER_SIDE,
        params: LIVE_PARAMS,
      });
      result.windowDays = days;
      cells.push({ windowDays: days, feeMode, result });
      console.log(
        `${days}d  ${feeMode.padEnd(5)}  ` +
        `trades=${String(result.totalTrades).padStart(3)}  ` +
        `WR=${(result.winRate * 100).toFixed(1).padStart(5)}%  ` +
        `PF=${(Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : 'inf').padStart(5)}  ` +
        `net=${result.totalPnlPercent.toFixed(2).padStart(7)}%  ` +
        `($${result.totalPnlNet.toFixed(2).padStart(7)})  ` +
        `DD=${result.maxDrawdownPercent.toFixed(2).padStart(5)}%  ` +
        `avgHold=${result.avgHoldBars.toFixed(1)}bars`,
      );
    }
  }

  // ---- Write report ----
  const outDir = join('v2', 'backtest', 'canonical', 'pairs', 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const md = renderReport(cells, perWindowCointegration);
  writeFileSync(join(outDir, `expected-${stamp}.md`), md);
  writeFileSync(join(outDir, 'expected-latest.md'), md);
  writeFileSync(join(outDir, 'expected-latest.json'), JSON.stringify({ cells, cointegration: perWindowCointegration }, null, 2));
  console.log(`\n✓ Report: v2/backtest/canonical/pairs/results/expected-${stamp}.md`);
}

function renderReport(
  cells: Cell[],
  coint: Record<number, ReturnType<typeof testCointegration>>,
): string {
  const out: string[] = [];
  out.push('# FIL/ICP Expected-Behavior Backtest');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('Parameters match the LIVE engine config verbatim. Use this report to set');
  out.push('expectations for what you should see during Phase A paper-mode.');
  out.push('');
  out.push(`- Pair: ${PAIRS_CONFIG.SYMBOL_A} / ${PAIRS_CONFIG.SYMBOL_B}`);
  out.push(`- Entry: |z| ≥ ${PAIRS_CONFIG.ENTRY_Z}`);
  out.push(`- Exit: |z| < ${PAIRS_CONFIG.EXIT_Z}`);
  out.push(`- Stop: |z| > ${PAIRS_CONFIG.STOP_Z}`);
  out.push(`- Time stop: ${PAIRS_CONFIG.MAX_HOLD_BARS} bars (≈ ${(PAIRS_CONFIG.MAX_HOLD_BARS / 24).toFixed(1)} days on 1h)`);
  out.push(`- β re-estimate: every ${PAIRS_CONFIG.REESTIMATE_BETA_EVERY_BARS} bars`);
  out.push(`- Rolling window: ${PAIRS_CONFIG.ROLLING_WINDOW_BARS} bars (≈ ${(PAIRS_CONFIG.ROLLING_WINDOW_BARS / 24).toFixed(0)} days)`);
  out.push(`- Notional: $${PAIRS_CONFIG.TOTAL_NOTIONAL_USD} total ($${PAIRS_CONFIG.LEG_NOTIONAL_USD}/leg)`);
  out.push('');

  // ---- Cointegration per window ----
  out.push('## Cointegration stats per window');
  out.push('');
  out.push('| Window | β | α | R² | ADF t-stat | Halflife (bars) | Stationary? |');
  out.push('|---|---:|---:|---:|---:|---:|:---:|');
  for (const days of [30, 60, 90]) {
    const c = coint[days];
    if (!c) continue;
    const hl = Number.isFinite(c.halflife) ? c.halflife.toFixed(1) : '∞';
    out.push(
      `| ${days}d | ${c.beta.toFixed(3)} | ${c.alpha.toFixed(3)} | ${c.rSquared.toFixed(3)} | ` +
      `${c.adfTStat.toFixed(2)} | ${hl} | ${c.isStationary5pct ? '✓ 5%' : '✗'} ` +
      `${c.isStationary1pct ? '✓ 1%' : ''} |`,
    );
  }
  out.push('');

  // ---- Performance per window x fee mode ----
  out.push('## Performance — taker vs maker, by window');
  out.push('');
  out.push('| Window | Fees | Trades | WR % | PF | Net % | Net $ | Max DD % | Avg hold (bars) | Avg hold (hrs) |');
  out.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const c of cells) {
    const r = c.result;
    const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf';
    out.push(
      `| ${c.windowDays}d | ${c.feeMode} | ${r.totalTrades} | ${(r.winRate * 100).toFixed(1)} | ${pf} | ` +
      `${r.totalPnlPercent.toFixed(2)} | $${r.totalPnlNet.toFixed(2)} | ${r.maxDrawdownPercent.toFixed(2)} | ` +
      `${r.avgHoldBars.toFixed(1)} | ${r.avgHoldBars.toFixed(1)} |`,
    );
  }
  out.push('');

  // ---- Forward-looking projections per window ----
  out.push('## What to expect during Phase A (paper mode, taker fees)');
  out.push('');
  out.push('Per-window cadence projection — what 30 days of live trading should look like under similar conditions:');
  out.push('');
  out.push('| Source window | Trades / window | Expected trades / 7d | Expected trades / 30d | Avg per-trade net | Projected 30d net |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const days of [30, 60, 90]) {
    const taker = cells.find(c => c.windowDays === days && c.feeMode === 'taker');
    if (!taker) continue;
    const r = taker.result;
    const tradesPerDay = r.totalTrades / days;
    const tradesPer7d = tradesPerDay * 7;
    const tradesPer30d = tradesPerDay * 30;
    const avgPerTrade = r.totalTrades > 0 ? r.totalPnlNet / r.totalTrades : 0;
    const projected30d = avgPerTrade * tradesPer30d;
    out.push(
      `| ${days}d | ${r.totalTrades} | ${tradesPer7d.toFixed(1)} | ${tradesPer30d.toFixed(1)} | ` +
      `$${avgPerTrade.toFixed(2)} | $${projected30d.toFixed(2)} |`,
    );
  }
  out.push('');
  out.push('**Read these projections with skepticism.** They assume the next 30 days behave like the source window. ADF stationarity does NOT guarantee future stationarity.');
  out.push('');

  // ---- Phase A success criteria check ----
  out.push('## Phase A success criteria (from deployment plan)');
  out.push('');
  out.push('Will these be plausibly met if the next 30d looks like the historical 30d?');
  out.push('');
  const t30 = cells.find(c => c.windowDays === 30 && c.feeMode === 'taker');
  if (t30) {
    const r = t30.result;
    const tradeGate = r.totalTrades >= 3;
    const pnlGate = r.totalPnlPercent >= 1.0;
    out.push('| Criterion | Threshold | 30d backtest result | Pass? |');
    out.push('|---|---|---|:---:|');
    out.push(`| ≥ 3 signals fired | ≥ 3 | ${r.totalTrades} | ${tradeGate ? '✓' : '✗'} |`);
    out.push(`| Paper net PnL ≥ +1% | ≥ +1.0% | ${r.totalPnlPercent.toFixed(2)}% | ${pnlGate ? '✓' : '✗'} |`);
    out.push(`| ADF < -2.86 throughout | t < -2.86 | (engine will alert if breached) | n/a |`);
    out.push(`| No |z| > 5 events | max |z| < 5 | (engine has stop_z at 4σ) | n/a |`);
    out.push(`| Avg hold ≤ 100 bars | ≤ 100 | ${r.avgHoldBars.toFixed(1)} | ${r.avgHoldBars <= 100 ? '✓' : '✗'} |`);
  }
  out.push('');

  // ---- Taker→maker delta ----
  out.push('## Taker → Maker uplift');
  out.push('');
  out.push('Per Phase B deployment plan, live trading targets maker rebates (-0.05%/leg/side).');
  out.push('Same trade sequence, different fee model:');
  out.push('');
  out.push('| Window | Taker net | Maker net | Maker uplift |');
  out.push('|---|---:|---:|---:|');
  for (const days of [30, 60, 90]) {
    const t = cells.find(c => c.windowDays === days && c.feeMode === 'taker');
    const m = cells.find(c => c.windowDays === days && c.feeMode === 'maker');
    if (!t || !m) continue;
    const uplift = m.result.totalPnlPercent - t.result.totalPnlPercent;
    out.push(
      `| ${days}d | ${t.result.totalPnlPercent.toFixed(2)}% | ${m.result.totalPnlPercent.toFixed(2)}% | ` +
      `+${uplift.toFixed(2)}% |`,
    );
  }
  out.push('');

  // ---- Caveats ----
  out.push('## Caveats');
  out.push('');
  out.push('- **Lookahead-free backtest.** Each bar uses only prior data for cointegration; entries fill on next bar\'s open with slippage.');
  out.push('- **Cointegration regimes are not guaranteed to persist.** A pair that mean-reverted with ADF=-5 over the last 90d can break in the next 30d. The walk-forward validation in the original study showed this pair survived OOS, but no guarantee for the future.');
  out.push('- **Margin trading required for live shorts.** Paper mode simulates the short leg; live mode needs margin trading enabled on FIL/USD and ICP/USD (verified by Kraken API; UI confirmation pending).');
  out.push('- **Per-trade economics are sensitive to fees.** Paper-mode taker fees absorb ~1% per round-trip (4 sides × 0.26%). A pair-trade needs > 1% gross edge to be net positive on taker; maker rebates flip this to ~+0.2% per round-trip.');
  out.push('');

  out.push('## How to read this report');
  out.push('');
  out.push('1. **Cointegration stats first.** If ADF is < -2.86 in all 3 windows, the pair is structurally stationary across the test period. Strong base.');
  out.push('2. **Compare 30d → 60d → 90d.** Are results stable, or does one window dominate? Stability = strategy. One window dominating = window-specific edge that may not repeat.');
  out.push('3. **Read taker rows for paper-mode expectations.** Read maker rows for Phase B targets.');
  out.push('4. **Avg hold tells you how often you\'ll see status changes** in the dashboard. < 30 bars = trade activity every couple days. 100+ bars = sparse activity, long open positions.');
  out.push('5. **The projection table is rough.** It linearly scales the source window\'s trade count and avg PnL to a forward 30d. Real outcomes will vary.');
  out.push('');

  return out.join('\n');
}

main().catch(e => {
  console.error('expectedRun failed:', e);
  process.exit(1);
});
