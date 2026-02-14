/**
 * Session Persistence Service
 * Full state save/restore for 24/7 VPS operation with auto-resume after restart.
 */

import {
  setSetting, getSetting,
} from './database.js';

let startTime = Date.now();
let totalTradeCount = 0;
let totalPnl = 0;
let autoSaveInterval = null;

/**
 * Save full trading state to database.
 * Extends basic session state with profit method positions, ML state, adaptive thresholds, etc.
 */
export function saveFullState(context) {
  try {
    const {
      portfolio, botState, cbExportState, awExportState,
      beastExportState, pmExportState, availableTickers,
    } = context;

    // Core portfolio
    setSetting('session_portfolio', JSON.stringify({
      cash: portfolio.cash,
      initialBudget: portfolio.initialBudget,
      positions: portfolio.positions,
      holdings: portfolio.holdings || {},
    }));

    // Bot state
    setSetting('session_bot', JSON.stringify({
      isActive: botState.isActive,
      settings: botState.settings,
      sessionId: botState.sessionId,
    }));

    // Sub-system states
    if (cbExportState) setSetting('session_circuit_breaker', JSON.stringify(cbExportState()));
    if (awExportState) setSetting('session_adaptive_weights', JSON.stringify(awExportState()));
    if (beastExportState) setSetting('session_beast_mode', JSON.stringify(beastExportState()));
    if (pmExportState) setSetting('session_profit_methods', JSON.stringify(pmExportState()));

    // Active tickers
    if (availableTickers) {
      setSetting('session_active_tickers', JSON.stringify(availableTickers.slice(0, 50)));
    }

    // Meta
    setSetting('session_uptime', JSON.stringify({
      startTime,
      totalTradeCount,
      totalPnl,
      lastSave: Date.now(),
    }));

    setSetting('session_timestamp', JSON.stringify(Date.now()));
  } catch (e) {
    console.error(`[SessionPersistence] Save failed: ${e.message}`);
  }
}

/**
 * Restore full state from database.
 * Returns structured object or null if no saved state.
 */
export function restoreFullState() {
  try {
    const portfolioRaw = getSetting('session_portfolio');
    const botRaw = getSetting('session_bot');
    const cbRaw = getSetting('session_circuit_breaker');
    const awRaw = getSetting('session_adaptive_weights');
    const beastRaw = getSetting('session_beast_mode');
    const pmRaw = getSetting('session_profit_methods');
    const tickersRaw = getSetting('session_active_tickers');
    const uptimeRaw = getSetting('session_uptime');
    const timestampRaw = getSetting('session_timestamp');

    if (!portfolioRaw) return null;

    const portfolio = JSON.parse(portfolioRaw);
    const botState = botRaw ? JSON.parse(botRaw) : null;
    const circuitBreaker = cbRaw ? JSON.parse(cbRaw) : null;
    const adaptiveWeights = awRaw ? JSON.parse(awRaw) : null;
    const beastMode = beastRaw ? JSON.parse(beastRaw) : null;
    const profitMethods = pmRaw ? JSON.parse(pmRaw) : null;
    const activeTickers = tickersRaw ? JSON.parse(tickersRaw) : null;
    const uptime = uptimeRaw ? JSON.parse(uptimeRaw) : null;
    const lastSaveTime = timestampRaw ? JSON.parse(timestampRaw) : null;

    // Restore meta tracking
    if (uptime) {
      totalTradeCount = uptime.totalTradeCount || 0;
      totalPnl = uptime.totalPnl || 0;
    }

    console.log(`[SessionPersistence] Restored session: $${portfolio.cash?.toFixed(2)} cash, ${Object.keys(portfolio.positions || {}).length} positions, bot was ${botState?.isActive ? 'ACTIVE' : 'INACTIVE'}`);

    return {
      portfolio,
      botState,
      circuitBreaker,
      adaptiveWeights,
      beastMode,
      profitMethods,
      activeTickers,
      uptime,
      lastSaveTime,
      wasActive: botState?.isActive || false,
    };
  } catch (e) {
    console.error(`[SessionPersistence] Restore failed: ${e.message}`);
    return null;
  }
}

/**
 * Get current session status for API.
 */
export function getSessionStatus(portfolio, botState) {
  const now = Date.now();
  const uptimeMs = now - startTime;
  const holdingsValue = Object.values(portfolio?.positions || {}).reduce(
    (sum, pos) => sum + ((pos.quantity || 0) * (pos.currentPrice || pos.openPrice || 0)),
    0
  );

  return {
    uptime: formatUptime(uptimeMs),
    uptimeMs,
    startTime,
    totalTrades: totalTradeCount,
    totalPnl: totalPnl.toFixed(2),
    cash: portfolio?.cash?.toFixed(2) || '0',
    holdingsValue: holdingsValue.toFixed(2),
    totalValue: ((portfolio?.cash || 0) + holdingsValue).toFixed(2),
    openPositions: Object.keys(portfolio?.positions || {}).length,
    botActive: botState?.isActive || false,
    lastSave: getSetting('session_timestamp') ? JSON.parse(getSetting('session_timestamp')) : null,
  };
}

/**
 * Record a completed trade for session tracking.
 */
export function recordSessionTrade(pnl) {
  totalTradeCount++;
  totalPnl += pnl;
}

/**
 * Start auto-save interval.
 */
export function startAutoSave(context, intervalMs = 60000) {
  stopAutoSave();
  autoSaveInterval = setInterval(() => {
    saveFullState(context);
  }, intervalMs);
  console.log(`[SessionPersistence] Auto-save started (every ${intervalMs / 1000}s)`);
}

/**
 * Stop auto-save interval.
 */
export function stopAutoSave() {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export default {
  saveFullState, restoreFullState, getSessionStatus, recordSessionTrade,
  startAutoSave, stopAutoSave,
};
