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
import { V2_CONFIG, STRATEGY_EXIT_CONFIGS, timeframeToMs } from '../engine/config.ts';
import type { StrategyExitConfig } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop, markTrailingActivated, updateTradePeakPrice } from '../attribution/attributionStore.ts';

// H3: ExitMutators allow callers to swap the persistence backend. The default
// (DB-backed) writes through attributionStore. Dual-engine paper trades live
// in an in-memory Map and aren't in v2_trades, so they pass in-memory mutators
// that update the trade object directly — without this, updateTradeStop's
// `Trade not found` throw used to abort the entire exit-check loop.
export interface ExitMutators {
  setStop(tradeId: string, newStop: number, trade: V2Trade): void;
  setTrailingActivated(tradeId: string, trade: V2Trade): void;
}

const DEFAULT_DB_MUTATORS: ExitMutators = {
  setStop: (tradeId, newStop) => updateTradeStop(tradeId, newStop),
  setTrailingActivated: (tradeId) => markTrailingActivated(tradeId),
};

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
  mutators: ExitMutators = DEFAULT_DB_MUTATORS,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    // H5: per-trade try/catch. Without this, one bad price fetch (Kraken WS
    // hiccup, REST 429, transient delisting) on ticker N would unwind the
    // for-loop and skip exit checks for every remaining trade — they'd wait
    // up to BOT_LOOP_INTERVAL_MS for the next pass. Now: log and continue.
    try {
    const currentPrice = await exchange.getLatestPrice(trade.ticker);
    const isShort = trade.side === 'short';

    // Per-strategy exit config (falls back to TREND defaults)
    const exitCfg: StrategyExitConfig = STRATEGY_EXIT_CONFIGS[trade.strategy ?? 'TREND'] ?? STRATEGY_EXIT_CONFIGS.TREND;
    // Use strategy-specific params, falling back to V2_CONFIG for backward compat
    const cfgTrailActivate = exitCfg.trailActivatePercent;
    const cfgTrailGiveback = exitCfg.trailGivebackPercent;
    const cfgUseTrailing = exitCfg.useTrailing;

    // Update peak price (highest for longs, lowest for shorts)
    updateTradePeakPrice(trade.id, currentPrice, trade.side ?? 'long');

    const pnlPercent = isShort
      ? (trade.entryPrice - currentPrice) / trade.entryPrice
      : (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;

    // --- 1. Stop Loss / Trailing Exit ---
    // For longs: currentPrice <= stop. For shorts: currentPrice >= stop.
    const slTriggered = isShort
      ? currentPrice >= trade.currentStop
      : currentPrice <= trade.currentStop;
    if (slTriggered) {
      const stopWasRaised = trade.trailingActivated || (isShort ? trade.currentStop < trade.initialStop : trade.currentStop > trade.initialStop);
      const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
      const reasonLabel = stopWasRaised ? 'Trailing/BE stop hit' : 'Stop loss hit';
      // Paper mode: use stop price to avoid gap-through losses
      const exitPrice = V2_CONFIG.MODE !== 'live' ? trade.currentStop : currentPrice;
      results.push({
        trade,
        shouldExit: true,
        exitReason,
        exitPrice,
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
    const tpTriggered = isShort
      ? currentPrice <= trade.takeProfitTarget
      : currentPrice >= trade.takeProfitTarget;
    if (tpTriggered) {
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
    // Once price moves +0.8%, raise SL to entry+0.7%.
    //
    // 2026-05-12: BE offset raised from +0.1% to +0.7%. The old +0.1%
    // claimed to cover slippage but actually fell short of Kraken's
    // round-trip fees (0.16% maker entry + 0.26% taker exit = 0.42%) plus
    // typical slippage (~0.2% on thin orderbooks). When the BE stop got
    // hit, the trade lost ~0.4% net. New +0.7% offset leaves ~+0.1% net
    // after fees+slippage when the stop fires — turns "lose small" into
    // "win small." Confirmed casualty: AKTUSD #2 on 2026-05-12 lost $1.88
    // hitting the old BE stop after only 12 min held.
    //
    // Break-even stop — ATR-aware, tied to trailing activation.
    // Trigger: 60% of trailing activation (gives the trade room to develop).
    // Offset: entry ± 0.5× ATR (enough cushion for noise, above fees).
    // Old fixed +0.8%/+0.7% was too tight on high-vol assets — created
    // masses of +0.1% "wins" that exited before trailing could activate.
    const beTrigger = cfgTrailActivate * 0.6;
    const atrForBE = (trade.atrPercent ?? 1.0) / 100;
    const beOffset = atrForBE * 0.5; // stop 0.5× ATR from entry (covers fees + noise)
    if (pnlPercent >= beTrigger) {
      const breakEvenStop = isShort
        ? trade.entryPrice * (1 - beOffset)
        : trade.entryPrice * (1 + beOffset);
      const beShouldUpdate = isShort
        ? breakEvenStop < trade.currentStop
        : breakEvenStop > trade.currentStop;
      if (beShouldUpdate) {
        newStop = breakEvenStop;
        mutators.setStop(trade.id, newStop, trade);
      }
    }

    // --- 2c. Quick-Kill for Dud Trades ---
    // If trade is >45 min old and has never been profitable (+0.3%), tighten SL.
    // "If it was going to work, it would have shown signs by now."
    const stopMovedFavorably = isShort
      ? trade.currentStop < trade.initialStop
      : trade.currentStop > trade.initialStop;
    const peakPnlPercent = stopMovedFavorably
      ? Math.abs(trade.currentStop - trade.entryPrice) / trade.entryPrice
      : pnlPercent;
    if (
      holdMs > V2_CONFIG.QUICK_KILL_AFTER_MS &&
      peakPnlPercent < V2_CONFIG.QUICK_KILL_MIN_GAIN &&
      pnlPercent < V2_CONFIG.QUICK_KILL_MIN_GAIN &&
      trade.atrPercent != null && trade.atrPercent > 0
    ) {
      const atrPct = trade.atrPercent!;
      const qkMult = atrPct > 1.5 ? V2_CONFIG.QUICK_KILL_SL_ATR_MULT * 0.5
                    : atrPct > 1.0 ? V2_CONFIG.QUICK_KILL_SL_ATR_MULT * 0.75
                    : V2_CONFIG.QUICK_KILL_SL_ATR_MULT;
      // For longs: tighten up. For shorts: tighten down.
      const tighterStop = isShort
        ? trade.entryPrice + (trade.entryPrice * atrPct / 100) * qkMult
        : trade.entryPrice - (trade.entryPrice * atrPct / 100) * qkMult;
      const qkShouldUpdate = isShort
        ? tighterStop < trade.currentStop
        : tighterStop > trade.currentStop;
      if (qkShouldUpdate) {
        newStop = tighterStop;
        mutators.setStop(trade.id, newStop, trade);
      }
    }

    // --- 3. Trailing Stop ---
    let trailingJustActivated = false;

    if (cfgUseTrailing && pnlPercent >= cfgTrailActivate) {
      // Activate trailing if not yet active
      if (!trade.trailingActivated) {
        mutators.setTrailingActivated(trade.id, trade);
        trailingJustActivated = true;
      }

      // ATR-aware giveback: use trade's ATR% to scale trail width.
      // High volatility = wider trail (avoid noise stops), low vol = tighter trail (lock profit).
      let givebackFraction = cfgTrailGiveback;
      if (trade.atrPercent) {
        if (trade.atrPercent > 2.0) givebackFraction *= 1.3;      // High vol: widen 30%
        else if (trade.atrPercent > 1.0) givebackFraction *= 1.1;  // Med vol: widen 10%
        else if (trade.atrPercent < 0.3) givebackFraction *= 0.7;  // Low vol: tighten 30%
      }

      // Loose-early / tight-late trailing profile:
      // When profit is just above activation (1.0-1.5x threshold), widen trail
      // to let the trade breathe through initial pullbacks. As profit grows, tighten.
      const profitVsActivation = pnlPercent / cfgTrailActivate;
      if (profitVsActivation < 1.5) {
        givebackFraction *= 1.5;
      } else if (profitVsActivation < 2.0) {
        const t = (profitVsActivation - 1.5) / 0.5;
        givebackFraction *= 1.5 - t * 0.5;
      }

      // Profit-tier tightening: bigger winners get tighter trails
      const tpTarget = trade.takeProfitTarget
        ? Math.abs(trade.takeProfitTarget - trade.entryPrice) / trade.entryPrice
        : V2_CONFIG.TAKE_PROFIT_ATR_MULT * (trade.atrPercent || 0.01);
      const profitMultiple = tpTarget > 0 ? pnlPercent / tpTarget : 1;
      if (profitMultiple >= 2.0) givebackFraction *= 0.6;
      else if (profitMultiple >= 1.5) givebackFraction *= 0.8;

      // For longs: trail up from peak. For shorts: trail down from trough.
      // peakPrice stores the best price (highest for longs, lowest for shorts).
      const peakGain = isShort
        ? trade.entryPrice - trade.peakPrice!  // peakPrice = trough for shorts
        : trade.peakPrice! - trade.entryPrice;
      const trailingStop = isShort
        ? trade.peakPrice! + peakGain * givebackFraction  // stop above trough for shorts
        : trade.peakPrice! - peakGain * givebackFraction;

      // Stops can only tighten: up for longs, down for shorts
      const trailShouldUpdate = isShort
        ? trailingStop < trade.currentStop
        : trailingStop > trade.currentStop;
      if (trailShouldUpdate) {
        newStop = trailingStop;
        mutators.setStop(trade.id, newStop, trade);
      } else {
        newStop = trade.currentStop;
      }

      // Check if trailing stop was hit
      const trailHit = isShort
        ? currentPrice >= newStop
        : currentPrice <= newStop;
      if (trailHit) {
        const trailExitPrice = V2_CONFIG.MODE !== 'live' ? newStop : currentPrice;
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.trailing,
          exitPrice: trailExitPrice,
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
