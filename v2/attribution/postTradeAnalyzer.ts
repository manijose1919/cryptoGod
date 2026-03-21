// ============================================
// Phoenix V2 Post-Trade Analyzer
// Correlates entry signals with trade outcomes
// ============================================

import type { V2Trade, SignalScore } from '../pipeline/types.ts';
import { getClosedTrades, upsertSignalScore } from './attributionStore.ts';

// --- Signal Active Thresholds ---

export const SIGNAL_ACTIVE_THRESHOLDS: Record<string, (v: number | boolean | string) => boolean> = {
  rsi: (v) => (v as number) < 45,
  macd_cross: (v) => v === true,
  macd_histogram: (v) => (v as number) > 0,
  trend_strength: (v) => (v as number) > 0.5,
  volume_ratio: (v) => (v as number) > 1.2,
  bb_percent_b: (v) => (v as number) < 0.35,
  price_vs_ema50: (v) => (v as number) > 0,
  atr_percent: (v) => (v as number) > 0.005,
  // TC + S/R + Dashboard signals
  tc_value: (v) => (v as number) < 40,
  sr_channel_position: (v) => (v as number) < 0.40,
  td_score: (v) => (v as number) >= 50,
};

// --- Analyze Closed Trade ---

/**
 * After a trade is closed with pnlNet, recompute all signal scores.
 */
export function analyzeClosedTrade(trade: V2Trade): void {
  if (trade.pnlNet == null) return;
  recomputeAllScores();
}

// --- Recompute All Scores ---

/**
 * Get last 1000 closed trades, compute per-signal win rates and edge,
 * then upsert each signal score to the DB.
 */
export function recomputeAllScores(): void {
  const trades = getClosedTrades(1000);
  if (trades.length === 0) return;

  const now = Date.now();

  for (const signalName of Object.keys(SIGNAL_ACTIVE_THRESHOLDS)) {
    const threshold = SIGNAL_ACTIVE_THRESHOLDS[signalName];

    let activeTrades = 0;
    let activeWins = 0;
    let activePnlSum = 0;
    let inactiveTrades = 0;
    let inactivePnlSum = 0;

    for (const trade of trades) {
      if (trade.pnlNet == null || trade.positionSizeUsd === 0) continue;

      const signalValue = trade.entrySignals[signalName];
      if (signalValue === undefined) continue;

      const pnlPercent = trade.pnlNet / trade.positionSizeUsd;

      if (threshold(signalValue)) {
        activeTrades++;
        activePnlSum += pnlPercent;
        if (trade.pnlNet > 0) activeWins++;
      } else {
        inactiveTrades++;
        inactivePnlSum += pnlPercent;
      }
    }

    const totalTrades = activeTrades + inactiveTrades;
    const winRate = activeTrades > 0 ? activeWins / activeTrades : 0;
    const avgPnlWhenActive = activeTrades > 0 ? activePnlSum / activeTrades : 0;
    const avgPnlWhenInactive = inactiveTrades > 0 ? inactivePnlSum / inactiveTrades : 0;
    const edge = avgPnlWhenActive - avgPnlWhenInactive;

    const score: SignalScore = {
      signalName,
      totalTrades,
      winningTrades: activeWins,
      winRate,
      avgPnlWhenActive,
      avgPnlWhenInactive,
      edge,
      lastUpdated: now,
    };

    upsertSignalScore(score);
  }
}
