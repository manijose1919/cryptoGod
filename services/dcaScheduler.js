/**
 * DCA Scheduler — Time-based Dollar Cost Averaging
 * Separate from the disabled signal-based DCA in profitMethods.js.
 * "Buy $X of COIN every Y hours/days"
 */

import { getDb } from './database.js';

let adapter = null;
let checkTimer = null;

export function initDCAScheduler() {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS dca_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        interval_hours REAL NOT NULL,
        next_run TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        total_invested REAL DEFAULT 0,
        buy_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        last_buy_at TEXT
      )
    `);
    console.log('[DCA] Scheduler initialized');
  } catch (e) {
    console.warn('[DCA] Init failed:', e.message);
  }
}

/**
 * Register exchange adapter for order placement.
 */
export function setDCAAdapter(exchangeAdapter) {
  adapter = exchangeAdapter;
}

/**
 * Create a new DCA schedule.
 */
export function createSchedule(ticker, amountUsd, intervalHours) {
  const db = getDb();
  const nextRun = new Date(Date.now() + intervalHours * 3600000).toISOString();
  const result = db.prepare(
    'INSERT INTO dca_schedules (ticker, amount_usd, interval_hours, next_run) VALUES (?, ?, ?, ?)'
  ).run(ticker, amountUsd, intervalHours, nextRun);
  return { id: result.lastInsertRowid, ticker, amountUsd, intervalHours, nextRun };
}

/**
 * List all schedules.
 */
export function listSchedules() {
  const db = getDb();
  return db.prepare('SELECT * FROM dca_schedules ORDER BY created_at DESC').all();
}

/**
 * Delete/deactivate a schedule.
 */
export function deleteSchedule(id) {
  const db = getDb();
  db.prepare('UPDATE dca_schedules SET active = 0 WHERE id = ?').run(id);
}

/**
 * Pause a schedule.
 */
export function pauseSchedule(id) {
  deleteSchedule(id); // Same as deactivate
}

/**
 * Resume a schedule.
 */
export function resumeSchedule(id) {
  const db = getDb();
  const nextRun = new Date().toISOString();
  db.prepare('UPDATE dca_schedules SET active = 1, next_run = ? WHERE id = ?').run(nextRun, id);
}

/**
 * Check and execute due DCA buys.
 */
export async function checkAndExecute() {
  if (!adapter) return;

  const db = getDb();
  const now = new Date().toISOString();
  const due = db.prepare(
    'SELECT * FROM dca_schedules WHERE active = 1 AND next_run <= ?'
  ).all(now);

  for (const schedule of due) {
    try {
      // Place a post-only buy order if available, otherwise limit
      const placeFn = adapter.placePostOnlyBuy || adapter.placeLimitBuyOrder || adapter.placeBuyOrder;
      if (!placeFn) {
        console.warn('[DCA] No buy method available on adapter');
        continue;
      }

      // Get current price to calculate quantity
      const ticker = await adapter.getTicker(schedule.ticker);
      if (!ticker?.last) continue;

      const qty = schedule.amount_usd / ticker.last;

      console.log(`[DCA] Executing: ${schedule.ticker} $${schedule.amount_usd} (${qty.toFixed(6)} @ $${ticker.last})`);

      // Attempt buy (in sim mode for safety if needed)
      await placeFn.call(adapter, schedule.ticker, qty);

      // Update schedule
      const nextRun = new Date(Date.now() + schedule.interval_hours * 3600000).toISOString();
      db.prepare(`
        UPDATE dca_schedules SET
          next_run = ?,
          total_invested = total_invested + ?,
          buy_count = buy_count + 1,
          last_buy_at = datetime('now')
        WHERE id = ?
      `).run(nextRun, schedule.amount_usd, schedule.id);

      console.log(`[DCA] Success: ${schedule.ticker} $${schedule.amount_usd}. Next run: ${nextRun}`);
    } catch (e) {
      console.error(`[DCA] Buy failed for ${schedule.ticker}:`, e.message);
      // Reschedule anyway to avoid stuck loop
      const nextRun = new Date(Date.now() + schedule.interval_hours * 3600000).toISOString();
      db.prepare('UPDATE dca_schedules SET next_run = ? WHERE id = ?').run(nextRun, schedule.id);
    }
  }
}

/**
 * Start the DCA check loop (every 60s).
 */
export function startDCAChecker() {
  if (checkTimer) return;
  checkTimer = setInterval(checkAndExecute, 60_000);
  console.log('[DCA] Checker started (60s interval)');
}

export function stopDCAChecker() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

export default {
  initDCAScheduler, setDCAAdapter, createSchedule, listSchedules,
  deleteSchedule, pauseSchedule, resumeSchedule,
  checkAndExecute, startDCAChecker, stopDCAChecker,
};
