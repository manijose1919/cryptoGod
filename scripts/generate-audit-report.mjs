#!/usr/bin/env node
/**
 * Generates `data/reports/audit-batch-progress.md` — the 2026-06-09 audit-batch
 * cohort comparison Joseph expects on demand (spec: docs/VPS-AGENT.md §5c).
 *
 * Deterministic and cheap (single readonly sqlite open, no API calls) so it can
 * run from cron every hour. The data sections are machine-owned; VPS Claude's
 * narrative lives in `data/reports/audit-batch-notes.md` and is included
 * verbatim at the bottom if present. Idempotent.
 *
 * Run: node scripts/generate-audit-report.mjs
 */

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.AUDIT_DB_PATH || 'data/trading.db';
const OUT_PATH = process.env.AUDIT_REPORT_PATH || 'data/reports/audit-batch-progress.md';
const NOTES_PATH = process.env.AUDIT_NOTES_PATH || 'data/reports/audit-batch-notes.md';

// Pre-fix cohort window start (2026-05-26 dedup baseline, per VPS-AGENT.md §5c)
const PRE_COHORT_START_MS = 1779802737790;
// Fallback only — the live baseline is read from the settings table.
const FALLBACK_BASELINE_MS = 1781038623818;

// Red-flag threshold from CHANGELOG 2026-06-09: avg trailing WIN below the
// ~$1.90 fee floor (on a ~$360 position) after 10+ trailing exits means the
// 1% trailing activation is too tight. Candidate revert: config line in 449ddf3.
const TRAILING_WIN_FEE_FLOOR = 1.9;
const TRAILING_MIN_SAMPLE = 10;

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

const db = new Database(DB_PATH, { readonly: true });

const baselineRow = db.prepare(`SELECT value FROM settings WHERE key='stats_baseline_time'`).get();
const BASELINE_MS = baselineRow ? Number(baselineRow.value) : FALLBACK_BASELINE_MS;

function cohortStats(whereClause, params) {
  const rows = db.prepare(`
    SELECT exit_reason, pnl_net, pnl_gross, fees_paid, strategy
    FROM v2_trades
    WHERE status='closed' AND ${whereClause}
  `).all(...params);
  const wins = rows.filter(t => (t.pnl_net ?? 0) > 0);
  const sum = (arr, k) => arr.reduce((s, t) => s + (t[k] ?? 0), 0);
  const byExit = {};
  for (const t of rows) {
    const k = t.exit_reason ?? 'unknown';
    (byExit[k] ??= []).push(t);
  }
  return {
    rows, wins, byExit,
    n: rows.length,
    net: sum(rows, 'pnl_net'),
    gross: sum(rows, 'pnl_gross'),
    fees: sum(rows, 'fees_paid'),
  };
}

const post = cohortStats('entry_time >= ?', [BASELINE_MS]);
const pre = cohortStats('entry_time >= ? AND entry_time < ?', [PRE_COHORT_START_MS, BASELINE_MS]);

const postDetail = db.prepare(`
  SELECT ticker, strategy, side, timeframe, exit_reason, pnl_gross, fees_paid, pnl_net,
         position_size_usd, atr_percent, exit_time
  FROM v2_trades
  WHERE status='closed' AND entry_time >= ?
  ORDER BY exit_time DESC LIMIT 25
`).all(BASELINE_MS);

const openPositions = db.prepare(`
  SELECT ticker, strategy, side, timeframe, position_size_usd, entry_price, entry_time
  FROM v2_trades WHERE status='open' ORDER BY entry_time DESC
`).all();

const momentumTrades = db.prepare(`
  SELECT ticker, side, timeframe, exit_reason, pnl_net, hold_duration_ms, exit_time
  FROM v2_trades
  WHERE status='closed' AND entry_time >= ? AND strategy='MOMENTUM'
  ORDER BY exit_time ASC LIMIT 10
`).all(BASELINE_MS);

const pairsState = db.prepare(`SELECT * FROM v2_pairs_state ORDER BY loop_at DESC LIMIT 1`).get();
const pairsPauseKeys = db.prepare(`
  SELECT key, value FROM settings WHERE key IN ('pairs_consecutive_losses','pairs_paused_until')
`).all();

// --- Trailing red-flag check (CHANGELOG 2026-06-09 watch item #1) ---
const postTrailing = post.byExit['trailing'] ?? [];
const postTrailingWins = postTrailing.filter(t => (t.pnl_net ?? 0) > 0);
const avgTrailingWin = postTrailingWins.length
  ? postTrailingWins.reduce((s, t) => s + t.pnl_net, 0) / postTrailingWins.length
  : null;
const trailingFlagTripped =
  postTrailing.length >= TRAILING_MIN_SAMPLE &&
  avgTrailingWin !== null && avgTrailingWin < TRAILING_WIN_FEE_FLOOR;

function exitMixTable(stats) {
  const lines = ['| Exit | Trades | Wins | Net | Avg |', '|---|---:|---:|---:|---:|'];
  for (const [reason, rows] of Object.entries(stats.byExit).sort((a, b) => b[1].length - a[1].length)) {
    const net = rows.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
    const w = rows.filter(t => (t.pnl_net ?? 0) > 0).length;
    lines.push(`| ${reason} | ${rows.length} | ${w} | ${fmtMoney(net)} | ${fmtMoney(net / rows.length)} |`);
  }
  if (Object.keys(stats.byExit).length === 0) lines.push('| _none_ | 0 | — | — | — |');
  return lines;
}

const lines = [];
lines.push('# Audit Batch Progress Report (2026-06-09 fix batch)');
lines.push(`**Generated:** ${fmtTime(Date.now())} | **Baseline:** ${BASELINE_MS} (${fmtTime(BASELINE_MS)})`);
lines.push('');

// Self-triggering reminder for VPS Claude: from 15 post-baseline closed trades,
// nag until the notes file contains the dismissal marker for the CURRENT baseline:
//   <!-- sprint-review-done baseline=<BASELINE_MS> -->
// Append the marker only when the review reaches a decision — a "wait for more
// data" verdict leaves the banner up on purpose. The old 15-30 window let the
// 2026-07-05 n=15 "wait" verdict expire silently; marker-based dismissal fixes
// that. A baseline reset re-arms the banner automatically. (2026-07-14)
const reviewDone = existsSync(NOTES_PATH) &&
  readFileSync(NOTES_PATH, 'utf8').includes(`<!-- sprint-review-done baseline=${BASELINE_MS} -->`);
if (post.n >= 15 && !reviewDone) {
  lines.push('> ## ⚠️ ACTION FOR VPS CLAUDE — run the 2026-06-30 sprint review');
  lines.push(`> The post-baseline cohort has **${post.n} closed trades** — enough to check the`);
  lines.push('> R:R + edge sprint against its backtests. Compare live vs expected and write the');
  lines.push('> findings to `audit-batch-notes.md`, append `<!-- sprint-review-done baseline=' + BASELINE_MS + ' -->`');
  lines.push('> once decided (leave it off to keep this banner for a follow-up), then ping Joseph. Check:');
  lines.push('> 1. **$12 risk cap:** no single closed trade should lose more than ~$15 net. Query the worst loss.');
  lines.push('> 2. **Per-trade expectancy:** should run well above the +$0.25 pre-sprint baseline (backtest implied ~+$0.5–0.6 with the time gate + regime gates). Compare avg pnl_net/trade.');
  lines.push('> 3. **Regime gates:** confirm no new MOMENTUM outside STRONG_UP and no shorts outside STRONG_DOWN.');
  lines.push('> 4. **Time gate:** confirm no new entries in 0–7 UTC (or 13/20 UTC).');
  lines.push('> 5. **Gatekeeper A/B:** if ≥30 PROCEED_AB samples exist, run:');
  lines.push(">    `SELECT decision, COUNT(*), ROUND(100.0*AVG(was_correct),0) win_pct FROM ml_gatekeeper_log WHERE actual_outcome IS NOT NULL AND decision LIKE 'PROCEED%' GROUP BY decision;`");
  lines.push('>    If PROCEED_AB (would-block) win% ≥ PROCEED (approved), recommend removing the gatekeeper.');
  lines.push('> See CHANGELOG.md 2026-06-30 entries for full context and rollback steps.');
  lines.push('');
}

lines.push('## Post-Baseline Cohort (new)');
lines.push('| Metric | Value |');
lines.push('|---|---|');
lines.push(`| Closed trades | ${post.n} |`);
lines.push(`| Win rate | ${pct(post.n ? post.wins.length / post.n : null)} (${post.wins.length}W / ${post.n - post.wins.length}L) |`);
lines.push(`| Net PnL | **${fmtMoney(post.net)}** |`);
lines.push(`| Gross / Fees | ${fmtMoney(post.gross)} / $${post.fees.toFixed(2)} |`);
lines.push(`| Fee drag | ${post.gross > 0 ? pct(post.fees / post.gross) : 'n/a (gross ≤ 0)'} |`);
lines.push('');
lines.push('### Exit mix (post-baseline)');
lines.push(...exitMixTable(post));
lines.push('');

lines.push('### Trailing-activation red flag (watch item #1)');
lines.push(`- Trailing exits: ${postTrailing.length} (${postTrailingWins.length} wins)`);
lines.push(`- Avg trailing WIN: ${avgTrailingWin === null ? 'n/a' : fmtMoney(avgTrailingWin)} vs fee floor $${TRAILING_WIN_FEE_FLOOR.toFixed(2)}`);
if (trailingFlagTripped) {
  lines.push(`- **🚩 RED FLAG TRIPPED** — ≥${TRAILING_MIN_SAMPLE} trailing exits and avg trailing win below the fee floor.`);
  lines.push('  The 1% activation is too tight. Candidate revert: the config line in `449ddf3` (see CHANGELOG 2026-06-09).');
} else if (postTrailing.length < TRAILING_MIN_SAMPLE) {
  lines.push(`- Status: insufficient sample (${postTrailing.length}/${TRAILING_MIN_SAMPLE} trailing exits) — keep watching.`);
} else {
  lines.push('- Status: ✓ healthy — avg trailing win clears the fee floor.');
}
lines.push('');

lines.push('### Trade detail (latest 25, post-baseline)');
lines.push('| Ticker | Strategy | Side | TF | Exit | Gross | Fees | Net | Size | ATR% | Exited |');
lines.push('|---|---|---|---|---|---:|---:|---:|---:|---:|---|');
for (const t of postDetail) {
  lines.push(`| ${t.ticker} | ${t.strategy} | ${t.side} | ${t.timeframe ?? '—'} | ${t.exit_reason} | ${fmtMoney(t.pnl_gross)} | $${(t.fees_paid ?? 0).toFixed(2)} | **${fmtMoney(t.pnl_net)}** | $${Math.round(t.position_size_usd ?? 0)} | ${t.atr_percent?.toFixed(2) ?? '—'} | ${fmtTime(t.exit_time)} |`);
}
if (postDetail.length === 0) lines.push('| _no closed trades yet_ | | | | | | | | | | |');
lines.push('');

lines.push('### Open positions');
if (openPositions.length === 0) {
  lines.push('_None._');
} else {
  lines.push('| Ticker | Strategy | Side | TF | Size | Entry | Entered |');
  lines.push('|---|---|---|---|---:|---:|---|');
  for (const p of openPositions) {
    lines.push(`| ${p.ticker} | ${p.strategy} | ${p.side} | ${p.timeframe ?? '—'} | $${Math.round(p.position_size_usd ?? 0)} | ${p.entry_price} | ${fmtTime(p.entry_time)} |`);
  }
}
lines.push('');

lines.push('### MOMENTUM revival (watch item #3 — first 10 trades individually)');
if (momentumTrades.length === 0) {
  lines.push('_No post-baseline MOMENTUM trades yet (expected while all tickers are in DOWN regime)._');
} else {
  lines.push('| Ticker | Side | TF | Exit | Net | Hold | Exited |');
  lines.push('|---|---|---|---|---:|---:|---|');
  for (const t of momentumTrades) {
    const holdH = t.hold_duration_ms ? (t.hold_duration_ms / 3600000).toFixed(1) + 'h' : '—';
    lines.push(`| ${t.ticker} | ${t.side} | ${t.timeframe ?? '—'} | ${t.exit_reason} | ${fmtMoney(t.pnl_net)} | ${holdH} | ${fmtTime(t.exit_time)} |`);
  }
}
lines.push('');

lines.push('## Pre-Baseline Cohort (May 27 → Jun 9)');
lines.push('| Metric | Value |');
lines.push('|---|---|');
lines.push(`| Closed trades | ${pre.n} |`);
lines.push(`| Win rate | ${pct(pre.n ? pre.wins.length / pre.n : null)} (${pre.wins.length}W / ${pre.n - pre.wins.length}L) |`);
lines.push(`| Net PnL | ${fmtMoney(pre.net)} |`);
lines.push(`| Gross / Fees | ${fmtMoney(pre.gross)} / $${pre.fees.toFixed(2)} |`);
lines.push(`| Fee drag | ${pre.gross > 0 ? pct(pre.fees / pre.gross) : 'n/a'} |`);
lines.push('');
lines.push('### Exit mix (pre-baseline)');
lines.push(...exitMixTable(pre));
lines.push('');

lines.push('## Pairs Engine (watch item #5)');
if (pairsState) {
  const ageMin = ((Date.now() - pairsState.loop_at) / 60000).toFixed(0);
  const adfHealthy = pairsState.adf_t_stat !== null && pairsState.adf_t_stat < -2.86;
  lines.push(`- Last loop: ${fmtTime(pairsState.loop_at)} (${ageMin} min ago)${ageMin > 5 ? ' ⚠️ STALE' : ''}`);
  lines.push(`- Mode: ${pairsState.mode} | In position: ${pairsState.in_position ? 'YES' : 'no'}`);
  lines.push(`- ADF t-stat: ${pairsState.adf_t_stat?.toFixed(2) ?? '—'} ${adfHealthy ? '(✓ < -2.86, gate open)' : '(gate closed — correctly not trading)'}`);
  lines.push(`- z-score: ${pairsState.z_score?.toFixed(2) ?? '—'}`);
} else {
  lines.push('- ⚠️ No pairs state snapshots — engine may not be running.');
}
for (const k of pairsPauseKeys) lines.push(`- settings.${k.key} = ${k.value}`);
lines.push('');

lines.push('---');
lines.push('Data sections auto-generated by `scripts/generate-audit-report.mjs` (cron, hourly).');
lines.push('Agent narrative below is maintained by VPS Claude in `data/reports/audit-batch-notes.md`.');
lines.push('');

if (existsSync(NOTES_PATH)) {
  lines.push('## Agent Narrative (VPS Claude)');
  lines.push('');
  lines.push(readFileSync(NOTES_PATH, 'utf8').trim());
  lines.push('');
} else {
  lines.push('_No agent narrative yet (`audit-batch-notes.md` not found)._');
}

const out = lines.join('\n') + '\n';
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, out);
db.close();
console.log(`Wrote ${OUT_PATH} (${out.length} bytes; baseline ${BASELINE_MS}; post=${post.n} pre=${pre.n})`);
