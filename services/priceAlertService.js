/**
 * Price Alert Service
 * Monitors price conditions and triggers notifications via Telegram/Discord.
 */

import { getDb } from './database.js';
import tradingBus from '../core/eventBus.ts';

const ALERT_CHECK_INTERVAL = 10_000; // 10s
let checkTimer = null;
let priceProvider = null; // function(ticker) => number | null

// Initialize the price_alerts table
export function initPriceAlerts() {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        condition TEXT NOT NULL,
        target_price REAL NOT NULL,
        direction TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        triggered_at TEXT,
        active INTEGER DEFAULT 1
      )
    `);
    console.log('[PriceAlerts] Table initialized');
  } catch (e) {
    console.warn('[PriceAlerts] Init failed:', e.message);
  }
}

/**
 * Register a price provider function.
 * @param {Function} fn - (ticker) => number | null
 */
export function setPriceProvider(fn) {
  priceProvider = fn;
}

/**
 * Create a new price alert.
 */
export function createAlert(ticker, condition, targetPrice) {
  const db = getDb();
  const valid = ['CROSSES_ABOVE', 'CROSSES_BELOW', 'DROPS_PCT', 'RISES_PCT'];
  if (!valid.includes(condition)) {
    throw new Error(`Invalid condition. Must be one of: ${valid.join(', ')}`);
  }
  const result = db.prepare(
    'INSERT INTO price_alerts (ticker, condition, target_price, direction) VALUES (?, ?, ?, ?)'
  ).run(ticker, condition, targetPrice, condition.includes('ABOVE') || condition.includes('RISES') ? 'UP' : 'DOWN');
  return { id: result.lastInsertRowid, ticker, condition, targetPrice };
}

/**
 * List all active alerts.
 */
export function listAlerts() {
  const db = getDb();
  return db.prepare('SELECT * FROM price_alerts WHERE active = 1 ORDER BY created_at DESC').all();
}

/**
 * Delete an alert by ID.
 */
export function deleteAlert(id) {
  const db = getDb();
  db.prepare('UPDATE price_alerts SET active = 0 WHERE id = ?').run(id);
}

/**
 * Check all active alerts against current prices.
 */
export function checkAlerts() {
  if (!priceProvider) return;
  const db = getDb();
  const alerts = db.prepare('SELECT * FROM price_alerts WHERE active = 1').all();

  for (const alert of alerts) {
    const currentPrice = priceProvider(alert.ticker);
    if (currentPrice == null) continue;

    let triggered = false;

    switch (alert.condition) {
      case 'CROSSES_ABOVE':
        triggered = currentPrice >= alert.target_price;
        break;
      case 'CROSSES_BELOW':
        triggered = currentPrice <= alert.target_price;
        break;
      case 'DROPS_PCT':
        // target_price is the percentage (e.g., 5 means 5% drop from when alert was created)
        // For simplicity, we compare raw price level
        triggered = currentPrice <= alert.target_price;
        break;
      case 'RISES_PCT':
        triggered = currentPrice >= alert.target_price;
        break;
    }

    if (triggered) {
      db.prepare('UPDATE price_alerts SET active = 0, triggered_at = datetime(\'now\') WHERE id = ?').run(alert.id);

      tradingBus.emit('alert:triggered', {
        type: 'price_alert',
        ticker: alert.ticker,
        condition: alert.condition,
        targetPrice: alert.target_price,
        currentPrice,
        timestamp: Date.now(),
      });

      console.log(`[PriceAlerts] TRIGGERED: ${alert.ticker} ${alert.condition} $${alert.target_price} (current: $${currentPrice})`);
    }
  }
}

/**
 * Start the alert checking loop.
 */
export function startAlertChecker() {
  if (checkTimer) return;
  checkTimer = setInterval(checkAlerts, ALERT_CHECK_INTERVAL);
  console.log('[PriceAlerts] Checker started (10s interval)');
}

/**
 * Stop the alert checker.
 */
export function stopAlertChecker() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

export default {
  initPriceAlerts, setPriceProvider, createAlert, listAlerts, deleteAlert,
  checkAlerts, startAlertChecker, stopAlertChecker,
};
