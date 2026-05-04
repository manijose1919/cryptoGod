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
    // H5: per-trade try/catch. Without this, one bad price fetch (Kraken WS
    // hiccup, REST 429, transient delisting) on ticker N would unwind the
    // for-loop and skip exit checks for every remaining trade — they'd wait
    // up to BOT_LOOP_INTERVAL_MS for the next pass. Now: log and continue.
    try {
    const currentPrice = await exchange.getLatestPrice(trade.ticker);
    const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;

    // --- 1. Stop Loss / Trailing Exit ---
    // Both fire on `currentPrice <= currentStop`, but classify the exit
    // reason based on whether the stop was raised above its initial level.
    // A raised stop means BE-stop or trailing took effect — log as `trailing`
    // so analytics distinguish protected exits from real losses.
    if (currentPrice <= trade.currentStop) {
      const stopWasRaised = trade.trailingActivated || trade.currentStop > trade.initialStop;
      const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
      const reasonLabel = stopWasRaised ? 'Trailing/BE stop hit' : 'Stop loss hit';
      results.push({
        trade,
        shouldExit: true,
        exitReason,
        exitPrice: currentPrice,
        newStop: trade.currentStop,
        trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute', `${reasonLabel}: ${currentPrice.toFixed(2)} <= ${trade.currentStop.toFixed(2)}`, {
          currentPrice,
          currentStop: trade.currentStop,
          initialStop: trade.initialStop,
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

    let newStop = trade.currentStop;

    // --- 2b. Break-Even Stop ---
    // Once price moves +0.8% (covers round-trip fees), raise SL to entry+0.1%.
    // Acts as a floor — capital preservation for trades that haven't yet
    // reached the trailing activation threshold. Below trailing, this is
    // the only protection; above trailing, it's harmless because trailing
    // computes a tighter (higher) stop and the `> trade.currentStop` guard
    // means stops only ever tighten. Decoupled from TRAILING_ACTIVATE_PERCENT
    // so config tweaks to trailing don't accidentally squeeze the BE window.
    const rawPnlPercent = pnlPercent; // pnlPercent is already raw (no fee adjustment)
    if (rawPnlPercent >= 0.008) {
      const breakEvenStop = trade.entryPrice * 1.001; // Slightly above entry to cover slippage
      if (breakEvenStop > trade.currentStop) {
        newStop = breakEvenStop;
        updateTradeStop(trade.id, newStop);
      }
    }

    // --- 2c. Quick-Kill for Dud Trades ---
    // If trade is >45 min old and has never been profitable (+0.3%), tighten SL.
    // "If it was going to work, it would have shown signs by now."
    const peakPnlPercent = (trade.currentStop > trade.initialStop)
      ? (trade.currentStop - trade.entryPrice) / trade.entryPrice
      : pnlPercent;  // approximate: if stop never moved, peak ≈ current
    if (
      holdMs > V2_CONFIG.QUICK_KILL_AFTER_MS &&
      peakPnlPercent < V2_CONFIG.QUICK_KILL_MIN_GAIN &&
      pnlPercent < V2_CONFIG.QUICK_KILL_MIN_GAIN &&
      trade.atrPercent != null && trade.atrPercent > 0
    ) {
      const tighterStop = trade.entryPrice - (trade.entryPrice * trade.atrPercent / 100) * V2_CONFIG.QUICK_KILL_SL_ATR_MULT;
      if (tighterStop > trade.currentStop) {
        newStop = tighterStop;
        updateTradeStop(trade.id, newStop);
      }
    }

    // --- 3. Trailing Stop ---
    let trailingJustActivated = false;

    if (pnlPercent >= V2_CONFIG.TRAILING_ACTIVATE_PERCENT) {
      // Activate trailing if not yet active
      if (!trade.trailingActivated) {
        markTrailingActivated(trade.id);
        trailingJustActivated = true;
      }

      // ATR-aware giveback: use trade's ATR% to scale trail width.
      // High volatility = wider trail (avoid noise stops), low vol = tighter trail (lock profit).
      let givebackFraction = V2_CONFIG.TRAILING_GIVEBACK_PERCENT;
      if (trade.atrPercent) {
        if (trade.atrPercent > 2.0) givebackFraction *= 1.3;      // High vol: widen 30%
        else if (trade.atrPercent > 1.0) givebackFraction *= 1.1;  // Med vol: widen 10%
        else if (trade.atrPercent < 0.3) givebackFraction *= 0.7;  // Low vol: tighten 30%
      }

      // Profit-tier tightening: bigger winners get tighter trails
      const tpTarget = trade.takeProfitTarget
        ? (trade.takeProfitTarget - trade.entryPrice) / trade.entryPrice
        : V2_CONFIG.TAKE_PROFIT_ATR_MULT * (trade.atrPercent || 0.01);
      const profitMultiple = tpTarget > 0 ? pnlPercent / tpTarget : 1;
      if (profitMultiple >= 2.0) givebackFraction *= 0.6;
      else if (profitMultiple >= 1.5) givebackFraction *= 0.8;

      const peakGain = currentPrice - trade.entryPrice;
      const trailingStop = currentPrice - peakGain * givebackFraction;

      // Stops can only tighten (go up for longs) — use the higher of computed vs existing
      if (trailingStop > trade.currentStop) {
        newStop = trailingStop;
        updateTradeStop(trade.id, newStop);
      } else {
        // DB stop may be higher than what we just computed (market whipped down)
        newStop = Math.max(newStop, trade.currentStop);
      }

      // Check if trailing stop was hit (price fell through effective stop)
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
    } catch (e) {
      // H5: never let one trade's failure abort the whole exit-check pass.
      console.warn(`[V2 ExitMgr] skipped ${trade.ticker}: ${(e as Error).message}`);
    }
  }

  return results;
}
