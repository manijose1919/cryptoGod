#!/usr/bin/env node
/**
 * Generates `data/reports/pairs-status.md` — a snapshot the operator can
 * read at any time to see how paper-mode is going.
 *
 * Designed to be cheap (single sqlite open, no API calls) so VPS-Claude
 * can run it every monitoring cycle. Idempotent.
 *
 * Run: node scripts/generate-pairs-report.mjs
 * Or:  npm run pairs:report  (if added to package.json)
 */

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.PAIRS_DB_PATH || 'data/trading.db';
const OUT_PATH = process.env.PAIRS_REPORT_PATH || 'data/reports/pairs-status.md';

// Phase A start. Update on each deployment so "days remaining" is accurate.
const PHASE_A_START_MS = Date.parse(process.env.PHASE_A_START || '2026-05-26T18:00:00Z');
const PHASE_A_DAYS = 30;

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

const db = new Database(DB_PATH, { readonly: true });

// --- Latest state snapshot ---
const latestState = db.prepare(`
  SELECT * FROM v2_pairs_state ORDER BY loop_at DESC LIMIT 1
`).get();

// --- Open trade (if any) ---
const openTrade = db.prepare(`
  SELECT * FROM v2_pairs_trades WHERE status='open' ORDER BY entry_time DESC LIMIT 1
`).get();

// --- Phase A trades (since Phase A start, mode='paper') ---
const phaseATrades = db.prepare(`
  SELECT * FROM v2_pairs_trades
  WHERE mode='paper' AND entry_time >= ?
  ORDER BY entry_time DESC
`).all(PHASE_A_START_MS);

const closedPhaseA = phaseATrades.filter(t => t.status === 'closed');
const wins = closedPhaseA.filter(t => (t.pnl_net ?? 0) > 0);
const losses = closedPhaseA.filter(t => (t.pnl_net ?? 0) <= 0);
const totalPnl = closedPhaseA.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
const winRate = closedPhaseA.length > 0 ? wins.length / closedPhaseA.length : null;
const avgHold = closedPhaseA.length > 0
  ? closedPhaseA.reduce((s, t) => s + (t.hold_bars ?? 0), 0) / closedPhaseA.length
  : null;

// --- Recent alerts ---
const recentAlerts = db.prepare(`
  SELECT * FROM v2_pairs_alerts ORDER BY created_at DESC LIMIT 15
`).all();

// --- ADF health over Phase A ---
const adfHistory = db.prepare(`
  SELECT adf_t_stat FROM v2_pairs_state
  WHERE loop_at >= ? AND adf_t_stat IS NOT NULL
  ORDER BY loop_at ASC
`).all(PHASE_A_START_MS);
const adfMin = adfHistory.length > 0 ? Math.min(...adfHistory.map(r => r.adf_t_stat)) : null;
const adfMax = adfHistory.length > 0 ? Math.max(...adfHistory.map(r => r.adf_t_stat)) : null;
const adfBreaches = adfHistory.filter(r => r.adf_t_stat > -2.86).length;

// --- Phase A success criteria ---
const daysElapsed = (Date.now() - PHASE_A_START_MS) / 86400000;
const daysRemaining = Math.max(0, PHASE_A_DAYS - daysElapsed);
const sigGate = closedPhaseA.length + (openTrade ? 1 : 0) >= 3;
const pnlGate = totalPnl >= 10;  // ≥ +1% of $1000
const holdGate = avgHold === null || avgHold <= 100;

// --- Compose report ---
const lines = [];
lines.push('# Pairs Trading — Status Report');
lines.push(`**Generated:** ${fmtTime(Date.now())}`);
lines.push(`**Phase A:** day ${daysElapsed.toFixed(1)} of ${PHASE_A_DAYS} (${daysRemaining.toFixed(1)} days remaining)`);
lines.push('');

// --- Engine state ---
lines.push('## Engine');
if (latestState) {
  const ageMs = Date.now() - latestState.loop_at;
  const ageSec = (ageMs / 1000).toFixed(0);
  const stale = ageMs > 5 * 60 * 1000;
  lines.push(`- Last loop: ${fmtTime(latestState.loop_at)} (${ageSec}s ago)${stale ? ' ⚠️ STALE' : ''}`);
  lines.push(`- Mode: ${latestState.mode}`);
  lines.push(`- Pair: ${latestState.sym_a} / ${latestState.sym_b}`);
  lines.push(`- In position: ${latestState.in_position ? 'YES' : 'no'}`);
} else {
  lines.push('- ⚠️ No state snapshots found. Engine may not be running.');
}
lines.push('');

// --- Cointegration ---
lines.push('## Cointegration');
if (latestState) {
  const adfHealthy = latestState.adf_t_stat !== null && latestState.adf_t_stat < -2.86;
  lines.push(`| Metric | Value | Healthy? |`);
  lines.push(`|---|---:|:---:|`);
  lines.push(`| Z-score (current) | ${latestState.z_score?.toFixed(3) ?? '—'} | — |`);
  lines.push(`| β (hedge ratio) | ${latestState.beta?.toFixed(3) ?? '—'} | — |`);
  lines.push(`| α (intercept) | ${latestState.alpha?.toFixed(3) ?? '—'} | — |`);
  lines.push(`| Spread σ | ${latestState.spread_std?.toFixed(4) ?? '—'} | — |`);
  lines.push(`| ADF t-stat | ${latestState.adf_t_stat?.toFixed(2) ?? '—'} | ${adfHealthy ? '✓' : '✗'} |`);
  lines.push(`| Halflife | ${latestState.halflife ? latestState.halflife.toFixed(1) + ' bars' : '∞'} | — |`);
  if (adfHistory.length > 0) {
    lines.push('');
    lines.push(`**ADF history over Phase A:** min=${adfMin?.toFixed(2)}, max=${adfMax?.toFixed(2)}, breaches (>${(-2.86).toFixed(2)})=${adfBreaches}`);
  }
}
lines.push('');

// --- Open trade ---
lines.push('## Open Trade');
if (openTrade) {
  lines.push(`- Trade ID: \`${openTrade.id}\``);
  lines.push(`- Side: **${openTrade.side}**`);
  lines.push(`- Entered: ${fmtTime(openTrade.entry_time)} at z=${openTrade.entry_z?.toFixed(2)}`);
  lines.push(`- Entry prices: ${openTrade.sym_a} @ $${openTrade.entry_price_a?.toFixed(4)}, ${openTrade.sym_b} @ $${openTrade.entry_price_b?.toFixed(4)}`);
  lines.push(`- Notional: $${openTrade.total_notional_usd}`);
  lines.push(`- β at entry: ${openTrade.beta?.toFixed(3)}`);
  lines.push(`- Mode: ${openTrade.mode}`);
} else {
  lines.push('_No open trade._');
}
lines.push('');

// --- Phase A performance ---
lines.push('## Phase A Performance');
lines.push(`- Closed paper trades: **${closedPhaseA.length}**`);
lines.push(`- Open + closed: **${closedPhaseA.length + (openTrade ? 1 : 0)}**`);
if (closedPhaseA.length > 0) {
  lines.push(`- Wins / losses: ${wins.length} / ${losses.length}`);
  lines.push(`- Win rate: **${(winRate * 100).toFixed(1)}%**`);
  lines.push(`- Cumulative PnL: **${fmtMoney(totalPnl)}** (${fmtPct(totalPnl / 1000)})`);
  lines.push(`- Avg hold: ${avgHold.toFixed(1)} bars`);
}
lines.push('');

// --- Phase A criteria ---
lines.push('## Phase A Success Criteria (so far)');
lines.push(`| Criterion | Threshold | Current | Pass? |`);
lines.push(`|---|---|---|:---:|`);
lines.push(`| ≥ 3 signals fired | ≥ 3 | ${closedPhaseA.length + (openTrade ? 1 : 0)} | ${sigGate ? '✓' : '✗'} |`);
lines.push(`| Paper PnL ≥ +1% (≥ +$10) | ≥ $10 | ${fmtMoney(totalPnl)} | ${pnlGate ? '✓' : '✗'} |`);
lines.push(`| Avg hold ≤ 100 bars | ≤ 100 | ${avgHold === null ? 'n/a' : avgHold.toFixed(1)} | ${holdGate ? '✓' : '✗'} |`);
lines.push(`| ADF stayed < -2.86 | breaches = 0 | ${adfBreaches} | ${adfBreaches === 0 ? '✓' : '✗'} |`);
lines.push('');

// --- Recent alerts ---
lines.push('## Recent Alerts');
if (recentAlerts.length === 0) {
  lines.push('_No alerts yet._');
} else {
  lines.push(`| Time | Severity | Kind | Message |`);
  lines.push(`|---|---|---|---|`);
  for (const a of recentAlerts) {
    lines.push(`| ${fmtTime(a.created_at)} | ${a.severity} | ${a.kind} | ${a.message} |`);
  }
}
lines.push('');

// --- Trade history ---
lines.push('## Recent Trades');
if (closedPhaseA.length === 0 && !openTrade) {
  lines.push('_No trades yet._');
} else {
  lines.push(`| Entered | Side | Mode | Entry z | Exit z | Hold (bars) | Reason | PnL net |`);
  lines.push(`|---|---|---|---:|---:|---:|---|---:|`);
  const tradesForTable = [...(openTrade ? [openTrade] : []), ...closedPhaseA].slice(0, 20);
  for (const t of tradesForTable) {
    lines.push(`| ${fmtTime(t.entry_time)} | ${t.side === 'long_spread' ? 'L' : 'S'} | ${t.mode} | ${t.entry_z?.toFixed(2) ?? '—'} | ${t.exit_z?.toFixed(2) ?? '—'} | ${t.hold_bars ?? '—'} | ${t.exit_reason ?? (t.status === 'open' ? '(open)' : '—')} | ${t.pnl_net != null ? fmtMoney(t.pnl_net) : '—'} |`);
  }
}
lines.push('');

// --- Footer ---
lines.push('---');
lines.push('Auto-generated by `scripts/generate-pairs-report.mjs`. Refresh: re-run the script.');
lines.push('Runbook: `docs/runbooks/pairs-runbook.md`. Plan: `docs/plans/2026-05-26-pairs-deployment-plan.md`.');

const out = lines.join('\n') + '\n';
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, out);
db.close();
console.log(`Wrote ${OUT_PATH} (${out.length} bytes)`);
