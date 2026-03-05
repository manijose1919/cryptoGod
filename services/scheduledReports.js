/**
 * Scheduled Reports Service
 * Generates and sends daily/weekly trading reports via Telegram + Discord.
 */

import { getDb } from './database.js';
import { sendDiscordAlert } from './discordWebhook.js';

let dailyTimer = null;
let weeklyTimer = null;
let telegramSend = null; // function(html) => void

export function initScheduledReports(sendFn) {
  telegramSend = sendFn;
  scheduleDailyReport();
  scheduleWeeklyReport();
  console.log('[ScheduledReports] Initialized');
}

function scheduleDailyReport() {
  // Run at midnight UTC
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const msUntil = tomorrow.getTime() - now.getTime();

  setTimeout(() => {
    generateDailyReport();
    dailyTimer = setInterval(generateDailyReport, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function scheduleWeeklyReport() {
  // Run Sunday midnight UTC
  const now = new Date();
  const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
  const nextSunday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSunday));
  const msUntil = nextSunday.getTime() - now.getTime();

  setTimeout(() => {
    generateWeeklyReport();
    weeklyTimer = setInterval(generateWeeklyReport, 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
}

export function generateDailyReport() {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const trades = db.prepare(
      `SELECT * FROM session_trades WHERE date(created_at) = ? ORDER BY created_at`
    ).all(today);

    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0 && t.type === 'SELL').length;
    const totalPnl = trades.filter(t => t.type === 'SELL').reduce((s, t) => s + (t.pnl || 0), 0);
    const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);

    const report = {
      date: today,
      totalTrades: trades.length,
      wins,
      losses,
      winRate: (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) + '%' : 'N/A',
      totalPnl: totalPnl.toFixed(2),
      totalFees: totalFees.toFixed(2),
      trades,
    };

    // Telegram
    if (telegramSend) {
      const msg = [
        `📋 <b>DAILY REPORT — ${today}</b>`,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `Trades: ${trades.length} (${wins}W/${losses}L)`,
        `Win Rate: ${report.winRate}`,
        `P&L: $${report.totalPnl}`,
        `Fees: $${report.totalFees}`,
      ].join('\n');
      telegramSend(msg);
    }

    // Discord
    sendDiscordAlert('Daily Report', `${today}`, 0x3b82f6, [
      { name: 'Trades', value: `${trades.length} (${wins}W/${losses}L)` },
      { name: 'P&L', value: `$${report.totalPnl}` },
      { name: 'Fees', value: `$${report.totalFees}` },
    ]);

    return report;
  } catch (e) {
    console.error('[ScheduledReports] Daily report error:', e.message);
    return null;
  }
}

export function generateWeeklyReport() {
  try {
    const db = getDb();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const trades = db.prepare(
      `SELECT * FROM session_trades WHERE date(created_at) >= ? ORDER BY created_at`
    ).all(weekAgo);

    const sells = trades.filter(t => t.type === 'SELL');
    const wins = sells.filter(t => t.pnl > 0).length;
    const losses = sells.filter(t => t.pnl <= 0).length;
    const totalPnl = sells.reduce((s, t) => s + (t.pnl || 0), 0);

    const report = { period: `${weekAgo} to now`, totalTrades: trades.length, wins, losses, totalPnl };

    if (telegramSend) {
      telegramSend([
        `📋 <b>WEEKLY REPORT</b>`,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `Period: ${report.period}`,
        `Trades: ${trades.length} (${wins}W/${losses}L)`,
        `P&L: $${totalPnl.toFixed(2)}`,
      ].join('\n'));
    }

    sendDiscordAlert('Weekly Report', report.period, 0x8b5cf6, [
      { name: 'Trades', value: `${trades.length}` },
      { name: 'P&L', value: `$${totalPnl.toFixed(2)}` },
    ]);

    return report;
  } catch (e) {
    console.error('[ScheduledReports] Weekly report error:', e.message);
    return null;
  }
}

export function getLatestReport() {
  return generateDailyReport();
}

export function destroy() {
  if (dailyTimer) clearInterval(dailyTimer);
  if (weeklyTimer) clearInterval(weeklyTimer);
}

export default { initScheduledReports, generateDailyReport, generateWeeklyReport, getLatestReport, destroy };
