// ============================================
// Phoenix V2 Exit Manager
// ATR stops, trailing TP, time kills
// Stops can only tighten, never loosen
// ============================================

import type {
  V2Trade,
  DecisionRecord,
  ExitReason,
} from './types.ts';
import {
  EXIT_REASON,
  PIPELINE_STAGE,
  DECISION,
} from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop, markTrailingActivated } from '../attribution/attributionStore.ts';

// --- Result Interface ---

export interface ExitResult {
  trade: V2Trade;
  shouldExit: boolean;
  exitReason: ExitReason | null;
  exitPrice: number;
  newStop: number;
  trailingJustActivated: boolean;
  decision: DecisionRecord;
}

// --- Helpers ---

function makeDecision(
  tradeId: string,
  decision: 'pass' | 'reject' | 'execute',
  reason: string,
  signals: Record<string, number>,
): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.exit,
    timestamp: Date.now(),
    decision: DECISION[decision],
    reason,
    signals,
    thresholds: {
      trailingActivatePercent: V2_CONFIG.TRAILING_ACTIVATE_PERCENT,
      trailingGivebackPercent: V2_CONFIG.TRAILING_GIVEBACK_PERCENT,
      timeKillMs: V2_CONFIG.TIME_KILL_MS,
      timeKillMinMove: V2_CONFIG.TIME_KILL_MIN_MOVE,
    },
    confidence: 0,
  };
}

// --- Exit Evaluation ---

/**
 * Check all open trades for exit conditions.
 * Priority: stop loss > take profit > trailing stop > time kill.
 */
export async function checkExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    const currentPrice = await exchange.getLatestPrice(trade.ticker);
    const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;

    // --- 1. Stop Loss ---
    if (currentPrice <= trade.currentStop) {
      results.push({
        trade,
        shouldExit: true,
        exitReason: EXIT_REASON.stop_loss,
        exitPrice: currentPrice,
        newStop: trade.currentStop,
        trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute', `Stop loss hit: ${currentPrice.toFixed(2)} <= ${trade.currentStop.toFixed(2)}`, {
          currentPrice,
          currentStop: trade.currentStop,
          pnlPercent,
        }),
      });
      continue;
    }

    // --- 2. Take Profit ---
    if (currentPrice >= trade.takeProfitTarget) {
      results.push({
        trade,
        shouldExit: true,
        exitReason: EXIT_REASON.take_profit,
        exitPrice: currentPrice,
        newStop: trade.currentStop,
        trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute', `Take profit hit: ${currentPrice.toFixed(2)} >= ${trade.takeProfitTarget.toFixed(2)}`, {
          currentPrice,
          takeProfitTarget: trade.takeProfitTarget,
          pnlPercent,
        }),
      });
      continue;
    }

    // --- 3. Trailing Stop ---
    let trailingJustActivated = false;
    let newStop = trade.currentStop;

    if (pnlPercent >= V2_CONFIG.TRAILING_ACTIVATE_PERCENT) {
      // Activate trailing if not yet active
      if (!trade.trailingActivated) {
        markTrailingActivated(trade.id);
        trailingJustActivated = true;
      }

      // Calculate trailing stop: give back a fraction of current gains
      const trailingStop = currentPrice * (1 - V2_CONFIG.TRAILING_GIVEBACK_PERCENT * pnlPercent);

      // Stops can only tighten (go up for longs)
      if (trailingStop > trade.currentStop) {
        newStop = trailingStop;
        updateTradeStop(trade.id, newStop);
      }

      // Check if trailing stop was hit (price fell through new stop)
      if (currentPrice <= newStop) {
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.trailing,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated,
          decision: makeDecision(trade.id, 'execute', `Trailing stop hit: ${currentPrice.toFixed(2)} <= ${newStop.toFixed(2)}`, {
            currentPrice,
            trailingStop: newStop,
            pnlPercent,
          }),
        });
        continue;
      }
    }

    // --- 4. Time Kill ---
    if (holdMs > V2_CONFIG.TIME_KILL_MS && Math.abs(pnlPercent) < V2_CONFIG.TIME_KILL_MIN_MOVE) {
      results.push({
        trade,
        shouldExit: true,
        exitReason: EXIT_REASON.time_kill,
        exitPrice: currentPrice,
        newStop,
        trailingJustActivated,
        decision: makeDecision(trade.id, 'execute', `Time kill: held ${(holdMs / 3600000).toFixed(1)}h, move ${(pnlPercent * 100).toFixed(2)}% < ${(V2_CONFIG.TIME_KILL_MIN_MOVE * 100).toFixed(1)}%`, {
          currentPrice,
          holdMs,
          pnlPercent,
          timeKillMs: V2_CONFIG.TIME_KILL_MS,
        }),
      });
      continue;
    }

    // --- No exit ---
    results.push({
      trade,
      shouldExit: false,
      exitReason: null,
      exitPrice: currentPrice,
      newStop,
      trailingJustActivated,
      decision: makeDecision(trade.id, 'pass', `Holding: PnL ${(pnlPercent * 100).toFixed(2)}%, stop ${newStop.toFixed(2)}`, {
        currentPrice,
        currentStop: newStop,
        pnlPercent,
        holdMs,
      }),
    });
  }

  return results;
}
