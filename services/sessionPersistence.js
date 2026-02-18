/**
 * Session Persistence Service
 * Full state save/restore for 24/7 VPS operation with auto-resume after restart.
 */

import {
  setSetting, getSetting,
  insertEquitySnapshot, getEquitySnapshots,
  insertSessionTrade, getSessionTrades, getSessionTradeStats,
} from './database.js';

let startTime = Date.now();
let totalTradeCount = 0;
let totalPnl = 0;
let autoSaveInterval = null;
let activeSessionId = null;
let tradingMode = 'SIMULATION'; // 'SIMULATION' | 'REAL'

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
      tradeLog: (portfolio.tradeLog || []).slice(-500),
    }));

    // Bot state
    setSetting('session_bot', JSON.stringify({
      isActive: botState.isActive,
      settings: botState.settings,
      sessionId: botState.sessionId,
      tradingMode: botState.tradingMode,
      sessionStartTime: botState.sessionStartTime,
    }));

    // Sub-system states
    if (cbExportState) setSetting('session_circuit_breaker', JSON.stringify(cbExportState()));
    if (awExportState) setSetting('session_adaptive_weights', JSON.stringify(awExportState()));
    if (beastExportState) setSetting('session_beast_mode', JSON.stringify(beastExportState()));
    if (pmExportState) setSetting('session_profit_methods', JSON.stringify(pmExportState()));
    if (context.optExportState) setSetting('session_optimizer', JSON.stringify(context.optExportState()));

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
    const optRaw = getSetting('session_optimizer');
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
    const optimizer = optRaw ? JSON.parse(optRaw) : null;
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
      optimizer,
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
 * Set active session ID and trading mode.
 */
export function setActiveSession(sessionId, mode = 'SIMULATION') {
  activeSessionId = sessionId;
  tradingMode = mode;
  startTime = Date.now();
  totalTradeCount = 0;
  totalPnl = 0;
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function getTradingMode() {
  return tradingMode;
}

/**
 * Record an equity snapshot for the current session.
 */
export function recordEquitySnapshot(portfolio) {
  if (!activeSessionId) return;
  try {
    const holdingsValue = Object.values(portfolio?.positions || {}).reduce(
      (sum, pos) => sum + ((pos.quantity || 0) * (pos.currentPrice || pos.openPrice || 0)),
      0
    );
    const totalValue = (portfolio?.cash || 0) + holdingsValue;
    const pnlPercent = portfolio?.initialBudget > 0
      ? ((totalValue - portfolio.initialBudget) / portfolio.initialBudget) * 100
      : 0;

    insertEquitySnapshot({
      session_id: activeSessionId,
      time: Date.now(),
      total_value: totalValue,
      cash: portfolio?.cash || 0,
      holdings_value: holdingsValue,
      open_positions: Object.keys(portfolio?.positions || {}).length,
      pnl_percent: pnlPercent,
    });
  } catch (e) {
    // Don't let snapshot errors affect trading
  }
}

/**
 * Record a trade in the session_trades table.
 */
export function recordSessionTradeDetail(trade) {
  if (!activeSessionId) return;
  try {
    insertSessionTrade({
      session_id: activeSessionId,
      time: Date.now(),
      type: trade.type, // 'BUY' or 'SELL'
      ticker: trade.ticker,
      price: trade.price,
      quantity: trade.quantity,
      notional: trade.notional || 0,
      strategy: trade.strategy || '',
      reason: trade.reason || '',
      pnl: trade.pnl || 0,
      fee: trade.fee || 0,
      balance_after: trade.balance_after || 0,
    });
  } catch (e) {
    // Don't let DB errors affect trading
  }
}

/**
 * Get equity curve data for the active session.
 */
export function getEquityCurve(sessionId) {
  const sid = sessionId || activeSessionId;
  if (!sid) return [];
  try {
    return getEquitySnapshots(sid, 1000).map(s => ({
      time: s.time,
      value: s.total_value,
      cash: s.cash,
      holdings: s.holdings_value,
      positions: s.open_positions,
      pnlPercent: s.pnl_percent,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Get trade history for the active session.
 */
export function getTradeHistory(sessionId, limit = 500) {
  const sid = sessionId || activeSessionId;
  if (!sid) return [];
  try {
    return getSessionTrades(sid, limit);
  } catch (e) {
    return [];
  }
}

/**
 * Get trade statistics for the active session.
 */
export function getTradeStats(sessionId) {
  const sid = sessionId || activeSessionId;
  if (!sid) return null;
  try {
    return getSessionTradeStats(sid);
  } catch (e) {
    return null;
  }
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
  setActiveSession, getActiveSessionId, getTradingMode,
  recordEquitySnapshot, recordSessionTradeDetail,
  getEquityCurve, getTradeHistory, getTradeStats,
};
