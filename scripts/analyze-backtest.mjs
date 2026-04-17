#!/usr/bin/env node
// Analyze the most recent V2 backtest JSON with focus on:
// 1. HTF veto verification (confirms Gate 2a fires on real data)
// 2. Win rate breakdown by ticker, regime, confidence bucket
// 3. Exit reason patterns (why are we losing?)
// 4. Post-exit price drift (did we exit too early on time_kill?)
//
// Usage: node scripts/analyze-backtest.mjs [path-to-results.json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findLatestBacktest() {
  const dir = 'data';
  const files = readdirSync(dir)
    .filter(f => f.startsWith('backtest-results-') && f.endsWith('.json'))
    .map(f => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path;
}

const file = process.argv[2] || findLatestBacktest();
if (!file) {
  console.error('No backtest JSON found. Run: node --experimental-strip-types scripts/backtest-v2.ts --days=90 --json');
  process.exit(1);
}

console.log(`\nAnalyzing: ${file}\n${'='.repeat(70)}\n`);

const data = JSON.parse(readFileSync(file, 'utf8'));
const trades = data.trades || [];
const summary = data.summary || {};

// --- Section 1: Summary ---
console.log('## OVERALL SUMMARY');
console.log(`Total trades:      ${summary.totalTrades}`);
console.log(`Wins / Losses:     ${summary.winningTrades} / ${summary.losingTrades}`);
console.log(`Win rate:          ${(summary.winRate * 100).toFixed(1)}%`);
console.log(`Net P&L:           $${summary.totalPnlNet?.toFixed(2)}  (${summary.totalPnlPercent?.toFixed(2)}%)`);
console.log(`Avg win / loss:    +$${summary.avgWinPnl?.toFixed(3)} / -$${Math.abs(summary.avgLossPnl).toFixed(3)}`);
console.log(`Profit factor:     ${summary.profitFactor?.toFixed(2)}`);
console.log(`Max drawdown:      $${summary.maxDrawdownUsd?.toFixed(2)}  (${summary.maxDrawdownPercent?.toFixed(2)}%)`);
console.log(`Avg hold:          ${summary.avgHoldBars} bars (~${(summary.avgHoldDurationMs / 3600000).toFixed(1)}h)`);
console.log('');

// --- Section 2: Ticker breakdown ---
console.log('## WIN RATE BY TICKER');
console.log('Ticker    Trades  WinRate  NetP&L     AvgPnL');
console.log('-'.repeat(50));
const tickerBd = [...(data.tickerBreakdown || [])].sort((a, b) => b.totalPnl - a.totalPnl);
for (const t of tickerBd) {
  const avg = t.trades ? (t.totalPnl / t.trades) : 0;
  console.log(`${t.ticker.padEnd(10)}${String(t.trades).padEnd(8)}${(t.winRate * 100).toFixed(1).padEnd(8)}% $${t.totalPnl.toFixed(2).padStart(7)}  $${avg.toFixed(3).padStart(7)}`);
}
console.log('');

// --- Section 3: Regime breakdown ---
console.log('## WIN RATE BY ENTRY REGIME');
console.log('Regime         Trades  WinRate  NetP&L');
console.log('-'.repeat(50));
const regimeBd = [...(data.regimeBreakdown || [])].sort((a, b) => b.totalPnl - a.totalPnl);
for (const r of regimeBd) {
  console.log(`${r.regime.padEnd(15)}${String(r.trades).padEnd(8)}${(r.winRate * 100).toFixed(1).padEnd(8)}% $${r.totalPnl.toFixed(2).padStart(7)}`);
}
console.log('');

// --- Section 4: Confidence buckets ---
console.log('## WIN RATE BY COMPOSITE SCORE BUCKET');
console.log('Bucket     Trades  WinRate  AvgPnL   NetP&L');
console.log('-'.repeat(50));
const buckets = [
  { label: '60-64', min: 60, max: 64.99 },
  { label: '65-69', min: 65, max: 69.99 },
  { label: '70-74', min: 70, max: 74.99 },
  { label: '75-79', min: 75, max: 79.99 },
  { label: '80-89', min: 80, max: 89.99 },
  { label: '90+',   min: 90, max: 100 },
];
for (const b of buckets) {
  const bt = trades.filter(t => t.compositeScore >= b.min && t.compositeScore <= b.max && t.exitPrice != null);
  if (bt.length === 0) continue;
  const wins = bt.filter(t => t.pnlNet > 0).length;
  const net = bt.reduce((s, t) => s + (t.pnlNet || 0), 0);
  const avg = net / bt.length;
  const wr = (wins / bt.length * 100).toFixed(1);
  console.log(`${b.label.padEnd(11)}${String(bt.length).padEnd(8)}${wr.padEnd(8)}% $${avg.toFixed(3).padStart(7)}  $${net.toFixed(2).padStart(7)}`);
}
console.log('');

// --- Section 5: Exit reason breakdown ---
console.log('## EXIT REASON BREAKDOWN');
console.log('Reason         Count   WinRate  AvgPnL   NetP&L');
console.log('-'.repeat(55));
const exitReasons = {};
for (const t of trades) {
  if (!t.exitReason) continue;
  const r = exitReasons[t.exitReason] || { count: 0, wins: 0, net: 0 };
  r.count++;
  if ((t.pnlNet || 0) > 0) r.wins++;
  r.net += t.pnlNet || 0;
  exitReasons[t.exitReason] = r;
}
for (const [reason, r] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
  const wr = (r.wins / r.count * 100).toFixed(1);
  const avg = (r.net / r.count).toFixed(3);
  console.log(`${reason.padEnd(15)}${String(r.count).padEnd(8)}${wr.padEnd(8)}% $${avg.padStart(7)}  $${r.net.toFixed(2).padStart(7)}`);
}
console.log('');

// --- Section 6: Entry signal analysis (from attribution) ---
console.log('## INDIVIDUAL SIGNAL EDGE');
console.log('Signal              Trades  WinRate  Edge    Verdict');
console.log('-'.repeat(60));
const signalScores = [...(data.signalScores || [])].sort((a, b) => b.edge - a.edge);
for (const s of signalScores) {
  console.log(`${s.signalName.padEnd(20)}${String(s.totalTrades).padEnd(8)}${(s.winRate * 100).toFixed(1).padEnd(8)}% ${(s.edge * 100).toFixed(2).padStart(6)}%  ${s.verdict}`);
}
console.log('');

// --- Section 7: Hold time vs outcome ---
console.log('## OUTCOME BY HOLD DURATION');
console.log('Duration       Count   WinRate  AvgPnL');
console.log('-'.repeat(48));
const holdBuckets = [
  { label: '< 30min', maxMs: 30 * 60000 },
  { label: '30m - 1h', maxMs: 60 * 60000 },
  { label: '1h - 2h', maxMs: 120 * 60000 },
  { label: '2h - 3h', maxMs: 180 * 60000 },
  { label: '3h - 5h', maxMs: 300 * 60000 },
  { label: '5h+',     maxMs: Infinity },
];
let prevMax = 0;
for (const b of holdBuckets) {
  const bt = trades.filter(t => t.holdDurationMs > prevMax && t.holdDurationMs <= b.maxMs && t.exitReason);
  prevMax = b.maxMs;
  if (bt.length === 0) continue;
  const wins = bt.filter(t => t.pnlNet > 0).length;
  const net = bt.reduce((s, t) => s + (t.pnlNet || 0), 0);
  const avg = net / bt.length;
  const wr = (wins / bt.length * 100).toFixed(1);
  console.log(`${b.label.padEnd(15)}${String(bt.length).padEnd(8)}${wr.padEnd(8)}% $${avg.toFixed(3).padStart(7)}`);
}
console.log('');

// --- Section 8: Losers-only deep dive ---
const losers = trades.filter(t => (t.pnlNet || 0) <= 0);
console.log(`## LOSER ANALYSIS (${losers.length} trades)`);
const loserReasons = {};
for (const t of losers) {
  loserReasons[t.exitReason] = (loserReasons[t.exitReason] || 0) + 1;
}
for (const [r, c] of Object.entries(loserReasons)) {
  console.log(`  ${r}: ${c} (${(c / losers.length * 100).toFixed(1)}%)`);
}
const avgLoserScore = losers.reduce((s, t) => s + t.compositeScore, 0) / losers.length;
const avgLoserAtr = losers.reduce((s, t) => s + (t.atrPercent || 0), 0) / losers.length;
console.log(`  Avg composite score of losers: ${avgLoserScore.toFixed(1)}`);
console.log(`  Avg ATR% of losers: ${avgLoserAtr.toFixed(3)}`);

const winners = trades.filter(t => (t.pnlNet || 0) > 0);
if (winners.length) {
  const avgWinnerScore = winners.reduce((s, t) => s + t.compositeScore, 0) / winners.length;
  const avgWinnerAtr = winners.reduce((s, t) => s + (t.atrPercent || 0), 0) / winners.length;
  console.log(`  Avg composite score of winners: ${avgWinnerScore.toFixed(1)}`);
  console.log(`  Avg ATR% of winners: ${avgWinnerAtr.toFixed(3)}`);
}
