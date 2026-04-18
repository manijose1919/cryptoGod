// ============================================
// Phoenix V2 Position Manager
// Track open positions and circuit breaker state
// ============================================

import type { V2Trade, V2PortfolioState } from '../pipeline/types.ts';
import type { CircuitBreakerState } from '../pipeline/riskGate.ts';
import { getOpenTrades, getClosedTrades, getOpenTradesByStrategy, getClosedTradesByStrategy } from '../attribution/attributionStore.ts';

// --- Load Portfolio ---

/**
 * Load open trades into a portfolio state.
 * When strategy is provided, only counts that strategy's trades — each strategy
 * gets its own independent budget and position tracking.
 * Cash = initialBudget + totalClosedPnlNet - lockedCapital (sum of open position sizes).
 */
export function loadPortfolio(initialBudget: number, strategy?: string): V2PortfolioState {
  const openTrades = strategy ? getOpenTradesByStrategy(strategy) : getOpenTrades();
  const closedTrades = strategy ? getClosedTradesByStrategy(strategy, 1000) : getClosedTrades(1000);

  const openPositions = new Map<string, V2Trade>();
  let lockedCapital = 0;
  for (const trade of openTrades) {
    openPositions.set(trade.ticker, trade);
    lockedCapital += trade.positionSizeUsd;
  }

  const totalClosedPnlNet = closedTrades.reduce(
    (sum, t) => sum + (t.pnlNet ?? 0),
    0,
  );

  const availableCapital = initialBudget + totalClosedPnlNet - lockedCapital;

  // Daily P&L: sum of closed trades in last 24h
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const todayTrades = closedTrades.filter(
    (t) => t.exitTime != null && t.exitTime > dayAgo,
  );
  const dailyPnl = todayTrades.reduce((sum, t) => sum + (t.pnlNet ?? 0), 0);

  return {
    openPositions,
    totalEquity: initialBudget + totalClosedPnlNet,
    availableCapital: Math.max(0, availableCapital),
    dailyPnl,
    dailyTradeCount: todayTrades.length,
    circuitBreakerActive: false,
    circuitBreakerUntil: null,
  };
}

// --- Circuit Breaker State ---

/**
 * Compute circuit breaker state from last 100 closed trades.
 * Returns daily P&L percent and most recent loss time.
 */
export function getCircuitBreakerState(
  portfolio: V2PortfolioState,
): CircuitBreakerState {
  const closedTrades = getClosedTrades(100);

  // Daily P&L as percent of total equity
  const dailyPnlPercent =
    portfolio.totalEquity > 0
      ? (portfolio.dailyPnl / portfolio.totalEquity) * 100
      : 0;

  // Find most recent loss time
  let lastLossTime = 0;
  for (const trade of closedTrades) {
    if (trade.pnlNet != null && trade.pnlNet < 0 && trade.exitTime != null) {
      if (trade.exitTime > lastLossTime) {
        lastLossTime = trade.exitTime;
      }
    }
  }

  return {
    dailyPnlPercent,
    lastLossTime,
  };
}
