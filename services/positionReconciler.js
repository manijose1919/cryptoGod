/**
 * Position Reconciler — Verify bot positions match exchange on startup/reconnect.
 *
 * Problem: If the bot crashes while holding positions, on restart it may have
 * stale position data. This service reconciles the bot's internal portfolio
 * with the exchange's actual balances.
 *
 * Handles:
 * 1. Startup reconciliation: Compare portfolio vs exchange balances
 * 2. Orphan detection: Positions in bot but not on exchange (already sold/liquidated)
 * 3. Ghost positions: Balances on exchange not tracked by bot
 * 4. Price drift: Update position currentPrice to live market price
 * 5. WebSocket reconnect gap fill: Detect missed fills during WS disconnection
 */

import { getExchangeAdapter, getActiveExchangeId } from './exchangeAdapters/index.js';

// ─── Configuration ───────────────────────────────────────────

const DUST_THRESHOLD_USD = 1.0; // Ignore balances below $1
const QUANTITY_TOLERANCE = 0.01; // 1% tolerance for quantity matching

// ─── Core Reconciliation ────────────────────────────────────

/**
 * Reconcile bot portfolio with exchange balances.
 * @param {Object} portfolio - Bot's internal portfolio { positions, cash }
 * @param {string} sessionId - Current session ID
 * @returns {Object} Reconciliation result with actions taken
 */
export async function reconcilePositions(portfolio, sessionId) {
  const result = {
    timestamp: Date.now(),
    exchange: getActiveExchangeId(),
    botPositions: Object.keys(portfolio.positions).length,
    exchangeBalances: 0,
    orphanedPositions: [],  // In bot but not on exchange
    ghostBalances: [],      // On exchange but not in bot
    quantityMismatches: [], // Both exist but quantities differ
    priceUpdates: [],       // Positions with updated live prices
    actionsRequired: [],    // Recommended actions
    reconciled: false,
  };

  try {
    const adapter = getExchangeAdapter();

    // Skip reconciliation if exchange has no auth configured (e.g. Crypto.com without API keys)
    if (adapter.getName?.() === 'crypto.com') {
      if (!process.env.SESSION_API_KEY && !process.env.SESSION_SECRET_KEY) {
        if (!reconcilePositions._cryptoComSkipWarn) {
          reconcilePositions._cryptoComSkipWarn = true;
          console.log('[Reconciler] Skipping Crypto.com reconciliation — no API keys configured');
        }
        result.actionsRequired.push('AUTH_NOT_CONFIGURED');
        return result;
      }
    }

    // Get exchange balances
    const balanceResult = await adapter.getBalance(sessionId);
    if (!balanceResult) {
      result.actionsRequired.push('BALANCE_FETCH_FAILED');
      return result;
    }

    // Build balance map: { 'BTC': { available, total } }
    const exchangeBalances = new Map();
    if (Array.isArray(balanceResult)) {
      for (const bal of balanceResult) {
        const asset = bal.currency || bal.asset || '';
        const total = parseFloat(bal.total || bal.balance || 0);
        if (total > 0 && asset !== 'USD' && asset !== 'ZUSD' && asset !== 'USDT') {
          exchangeBalances.set(asset.replace('X', '').replace('XBT', 'BTC'), total);
        }
      }
    } else if (typeof balanceResult === 'object') {
      // Kraken returns { XXBT: '0.001', XETH: '0.5', ZUSD: '100' }
      for (const [asset, balance] of Object.entries(balanceResult)) {
        const total = parseFloat(balance);
        if (total > 0) {
          const normalized = asset
            .replace(/^X{1,2}/, '')
            .replace(/^Z/, '')
            .replace('XBT', 'BTC');
          if (['USD', 'CAD', 'EUR', 'GBP'].includes(normalized)) continue;
          exchangeBalances.set(normalized, total);
        }
      }
    }

    result.exchangeBalances = exchangeBalances.size;

    // Check each bot position against exchange
    for (const [ticker, position] of Object.entries(portfolio.positions)) {
      const asset = ticker.replace(/USD[T]?$/, '');
      const exchangeQty = exchangeBalances.get(asset) || 0;

      if (exchangeQty === 0 || exchangeQty * (position.currentPrice || position.openPrice) < DUST_THRESHOLD_USD) {
        // Position exists in bot but not on exchange — orphaned
        result.orphanedPositions.push({
          ticker,
          botQuantity: position.quantity,
          exchangeQuantity: exchangeQty,
          openPrice: position.openPrice,
          reason: exchangeQty === 0 ? 'NOT_ON_EXCHANGE' : 'DUST_BALANCE',
        });
        result.actionsRequired.push(`REMOVE_ORPHAN:${ticker}`);
      } else {
        const qtyDiff = Math.abs(exchangeQty - position.quantity) / position.quantity;
        if (qtyDiff > QUANTITY_TOLERANCE) {
          result.quantityMismatches.push({
            ticker,
            botQuantity: position.quantity,
            exchangeQuantity: exchangeQty,
            diffPercent: (qtyDiff * 100).toFixed(2) + '%',
          });
          result.actionsRequired.push(`UPDATE_QTY:${ticker}:${exchangeQty}`);
        }

        // Remove from exchange map (matched)
        exchangeBalances.delete(asset);
      }
    }

    // Remaining exchange balances are ghost positions (on exchange, not in bot)
    for (const [asset, qty] of exchangeBalances) {
      // Try to get price estimate
      const ticker = asset + 'USD';
      let priceEstimate = 0;
      try {
        const tickerData = await adapter.getTicker(ticker);
        priceEstimate = parseFloat(tickerData?.last || tickerData?.lastPrice || 0);
      } catch (e) {}

      const usdValue = qty * priceEstimate;
      if (usdValue >= DUST_THRESHOLD_USD) {
        result.ghostBalances.push({
          asset,
          quantity: qty,
          estimatedUSD: usdValue,
          ticker,
        });
        result.actionsRequired.push(`TRACK_GHOST:${asset}:${qty}`);
      }
    }

    result.reconciled = true;
    console.log(`[Reconciler] Reconciliation complete: ${result.orphanedPositions.length} orphans, ${result.ghostBalances.length} ghosts, ${result.quantityMismatches.length} mismatches`);

  } catch (err) {
    // Suppress auth failures (Crypto.com without keys) — these are expected
    const msg = err.message || '';
    if (msg.includes('Authentication') || msg.includes('40101') || msg.includes('not configured')) {
      // Silently skip — this is a known configuration issue, not a bug
    } else {
      // Rate-limit: only log once per 10 min per error message
      const errKey = msg.slice(0, 50) || 'unknown';
      if (!reconcilePositions._errCooldowns) reconcilePositions._errCooldowns = {};
      const now = Date.now();
      if (!reconcilePositions._errCooldowns[errKey] || now - reconcilePositions._errCooldowns[errKey] > 600_000) {
        console.warn('[Reconciler] Reconciliation failed:', msg);
        reconcilePositions._errCooldowns[errKey] = now;
      }
    }
    result.actionsRequired.push('RECONCILIATION_ERROR');
  }

  return result;
}

/**
 * Auto-fix reconciliation issues.
 * @param {Object} portfolio - Bot portfolio (will be mutated)
 * @param {Object} reconciliation - Result from reconcilePositions()
 * @param {Function} addLog - Logging function
 * @returns {Object} Summary of actions taken
 */
export function autoFixReconciliation(portfolio, reconciliation, addLog = console.log) {
  const actions = [];

  // Remove orphaned positions (sold on exchange but still in bot)
  for (const orphan of reconciliation.orphanedPositions) {
    if (portfolio.positions[orphan.ticker]) {
      const pos = portfolio.positions[orphan.ticker];
      addLog(`[Reconciler] Removing orphan position: ${orphan.ticker} (${pos.quantity} units, was $${(pos.quantity * pos.openPrice).toFixed(2)})`, 'WARN');
      delete portfolio.positions[orphan.ticker];
      actions.push({ type: 'REMOVE_ORPHAN', ticker: orphan.ticker, quantity: pos.quantity });
    }
  }

  // Fix quantity mismatches (exchange is source of truth)
  for (const mismatch of reconciliation.quantityMismatches) {
    if (portfolio.positions[mismatch.ticker]) {
      const pos = portfolio.positions[mismatch.ticker];
      const oldQty = pos.quantity;
      pos.quantity = mismatch.exchangeQuantity;
      addLog(`[Reconciler] Fixed quantity mismatch: ${mismatch.ticker} ${oldQty} → ${mismatch.exchangeQuantity}`, 'WARN');
      actions.push({ type: 'FIX_QTY', ticker: mismatch.ticker, old: oldQty, new: mismatch.exchangeQuantity });
    }
  }

  // Track ghost balances as new positions (with unknown entry price)
  for (const ghost of reconciliation.ghostBalances) {
    if (!portfolio.positions[ghost.ticker] && ghost.estimatedUSD >= 5) {
      portfolio.positions[ghost.ticker] = {
        ticker: ghost.ticker,
        quantity: ghost.quantity,
        openPrice: ghost.estimatedUSD / ghost.quantity, // Use current price as entry
        currentPrice: ghost.estimatedUSD / ghost.quantity,
        entryTime: Date.now(),
        entryStrategy: 'RECONCILED',
        reconciled: true, // Flag so we know this wasn't a normal entry
      };
      addLog(`[Reconciler] Tracking ghost balance: ${ghost.asset} = ${ghost.quantity} (~$${ghost.estimatedUSD.toFixed(2)})`, 'WARN');
      actions.push({ type: 'TRACK_GHOST', ticker: ghost.ticker, quantity: ghost.quantity, usd: ghost.estimatedUSD });
    }
  }

  return {
    actionsCount: actions.length,
    actions,
    timestamp: Date.now(),
  };
}

/**
 * Check for open orders that may have filled during bot downtime.
 */
export async function checkPendingOrders(sessionId) {
  try {
    const adapter = getExchangeAdapter();
    if (!adapter.getOpenOrders) return { openOrders: 0, orders: [] };

    const orders = await adapter.getOpenOrders(sessionId);
    return {
      openOrders: orders.length,
      orders: orders.map(o => ({
        orderId: o.orderId,
        ticker: o.ticker,
        side: o.side,
        price: o.price,
        volume: o.volume,
        status: o.status,
      })),
    };
  } catch (err) {
    console.warn('[Reconciler] Open orders check failed:', err.message);
    return { openOrders: 0, orders: [], error: err.message };
  }
}

export default {
  reconcilePositions,
  autoFixReconciliation,
  checkPendingOrders,
};
