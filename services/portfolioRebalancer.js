/**
 * Portfolio Rebalancer
 * Maintains target allocations by buying underweight and selling overweight assets.
 * Uses feature flag PORTFOLIO_REBALANCER_ENABLED (default: false).
 */

import { getDb } from './database.js';

let adapter = null;
let portfolio = null;
let rebalanceTimer = null;
let enabled = false;

// Default targets — overridable via API
let targetAllocations = {}; // e.g., { BTC: 50, ETH: 30, SOL: 20 }
const DRIFT_THRESHOLD = 5; // Rebalance when any asset drifts >5% from target

export function initRebalancer(exchangeAdapter, portfolioRef) {
  adapter = exchangeAdapter;
  portfolio = portfolioRef;

  // Load saved targets from DB
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'rebalance_targets'").get();
    if (row?.value) {
      targetAllocations = JSON.parse(row.value);
    }
  } catch { /* ignore */ }

  console.log('[Rebalancer] Initialized', Object.keys(targetAllocations).length > 0 ? `with ${Object.keys(targetAllocations).length} targets` : '(no targets set)');
}

/**
 * Set target allocations.
 * @param {Object} targets - e.g., { BTC: 50, ETH: 30, SOL: 20 }
 */
export function setTargets(targets) {
  // Validate percentages sum to 100
  const sum = Object.values(targets).reduce((s, v) => s + Number(v), 0);
  if (Math.abs(sum - 100) > 0.1) {
    throw new Error(`Target allocations must sum to 100% (got ${sum}%)`);
  }
  targetAllocations = targets;

  // Persist to DB
  try {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rebalance_targets', ?)").run(JSON.stringify(targets));
  } catch { /* ignore */ }
}

/**
 * Get current allocation vs target.
 */
export function getRebalanceStatus() {
  if (!portfolio) return { enabled, targets: targetAllocations, allocations: {}, drifts: {} };

  const positions = portfolio.positions || {};
  const cash = portfolio.cash || 0;

  // Calculate total portfolio value
  let totalValue = cash;
  const values = {};
  for (const [ticker, pos] of Object.entries(positions)) {
    const val = pos.quantity * (pos.currentPrice || pos.openPrice);
    values[ticker] = val;
    totalValue += val;
  }

  if (totalValue === 0) return { enabled, targets: targetAllocations, allocations: {}, drifts: {} };

  // Current allocations (%)
  const allocations = {};
  const drifts = {};
  for (const [asset, targetPct] of Object.entries(targetAllocations)) {
    const ticker = asset.endsWith('USD') ? asset : `${asset}USD`;
    const currentValue = values[ticker] || 0;
    const currentPct = (currentValue / totalValue) * 100;
    allocations[asset] = { current: currentPct, target: targetPct, value: currentValue };
    drifts[asset] = currentPct - targetPct;
  }

  // Cash allocation
  allocations.CASH = { current: (cash / totalValue) * 100, value: cash };

  const needsRebalance = Object.values(drifts).some(d => Math.abs(d) > DRIFT_THRESHOLD);

  return { enabled, targets: targetAllocations, allocations, drifts, totalValue, needsRebalance };
}

/**
 * Execute rebalancing trades.
 */
export async function executeRebalance(sessionId) {
  if (!adapter || !portfolio) throw new Error('Rebalancer not initialized');
  if (Object.keys(targetAllocations).length === 0) throw new Error('No target allocations set');

  const status = getRebalanceStatus();
  if (!status.needsRebalance) return { executed: false, reason: 'No drift exceeds threshold' };

  const trades = [];

  // First: sell overweight assets
  for (const [asset, drift] of Object.entries(status.drifts)) {
    if (drift <= DRIFT_THRESHOLD) continue; // Not overweight

    const ticker = asset.endsWith('USD') ? asset : `${asset}USD`;
    const excessPct = drift / 100;
    const excessValue = excessPct * status.totalValue;
    const pos = portfolio.positions[ticker];
    if (!pos) continue;

    const sellQty = Math.min(excessValue / (pos.currentPrice || pos.openPrice), pos.quantity * 0.95); // Never sell 100%

    try {
      await adapter.placeSellOrder(ticker, sellQty, sessionId);
      trades.push({ type: 'SELL', ticker, quantity: sellQty, value: excessValue, reason: `Overweight by ${drift.toFixed(1)}%` });
    } catch (e) {
      trades.push({ type: 'SELL_FAILED', ticker, error: e.message });
    }
  }

  // Then: buy underweight assets
  for (const [asset, drift] of Object.entries(status.drifts)) {
    if (drift >= -DRIFT_THRESHOLD) continue; // Not underweight

    const ticker = asset.endsWith('USD') ? asset : `${asset}USD`;
    const deficitPct = Math.abs(drift) / 100;
    const deficitValue = deficitPct * status.totalValue;
    const buyAmount = Math.min(deficitValue, portfolio.cash * 0.9); // Keep 10% cash reserve

    if (buyAmount < 5) continue; // Skip tiny orders

    try {
      await adapter.placeBuyOrder(ticker, buyAmount, sessionId);
      trades.push({ type: 'BUY', ticker, value: buyAmount, reason: `Underweight by ${Math.abs(drift).toFixed(1)}%` });
    } catch (e) {
      trades.push({ type: 'BUY_FAILED', ticker, error: e.message });
    }
  }

  return { executed: true, trades, timestamp: new Date().toISOString() };
}

/**
 * Schedule daily rebalancing.
 */
export function startScheduledRebalance(hour = 12, sessionId = null) {
  if (rebalanceTimer) clearInterval(rebalanceTimer);

  // Check every hour if it's time
  rebalanceTimer = setInterval(async () => {
    if (!enabled) return;
    const now = new Date();
    if (now.getUTCHours() === hour && now.getUTCMinutes() < 5) {
      try {
        const result = await executeRebalance(sessionId);
        console.log('[Rebalancer] Scheduled rebalance:', JSON.stringify(result));
      } catch (e) {
        console.error('[Rebalancer] Scheduled rebalance failed:', e.message);
      }
    }
  }, 60_000 * 5); // Check every 5 min
}

export function setEnabled(flag) { enabled = !!flag; }
export function isEnabled() { return enabled; }

export function stopScheduledRebalance() {
  if (rebalanceTimer) { clearInterval(rebalanceTimer); rebalanceTimer = null; }
}

export default {
  initRebalancer, setTargets, getRebalanceStatus, executeRebalance,
  startScheduledRebalance, stopScheduledRebalance, setEnabled, isEnabled,
};
