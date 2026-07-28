// ============================================
// MOMENTUM Exit Manager (v2 — rebuilt 2026-05-06)
// ============================================
// Rebuilt alongside the v2 entry logic. Replaces the original `histogram_decay`
// trail (too sensitive — exits at first momentum stall) with a proper
// percent-giveback trail, mirroring the TREND/MR exit pattern.
//
// Exit hierarchy (priority):
//   1. Stop-loss / trailing exit  (price <= currentStop)
//   2. Take-profit (price >= 3× ATR target)
//   3. Break-even stop activation at +1.5% PnL
//   4. Trailing stop (activates at +2.5%, gives back 5% of peak gain)
//   5. Quick-kill if no progress after 4 bars
//   6. Time-kill at 16 bars (16 × 4h = 2.7d)
// ============================================

import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop, updateTradePeakPrice } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';
import { MOM_EXIT_CONFIG as MOM_EXIT, MOMENTUM_CONFIG } from '../engine/config.ts';

// MOMENTUM runs on 4h candles (per MOMENTUM_CONFIG.CANDLE_INTERVAL).
// Convert to bar-ms so all the *_BARS thresholds work uniformly.
const BAR_MS_4H = 4 * 60 * 60 * 1000;

function makeDecision(
  tradeId: string,
  decision: string,
  reason: string,
  signals: Record<string, number>,
): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.exit,
    timestamp: Date.now(),
    decision: DECISION[decision as keyof typeof DECISION] ?? decision,
    reason,
    signals,
    thresholds: {},
    confidence: 0,
  };
}

export async function checkMomentumExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];
  const barMs = MOMENTUM_CONFIG.CANDLE_INTERVAL === '4h' ? BAR_MS_4H : 60 * 60 * 1000;

  for (const trade of openTrades) {
    try {
      const currentPrice = await exchange.getLatestPrice(trade.ticker);

      // Track peak for trailing stop math.
      if (currentPrice > (trade.peakPrice ?? trade.entryPrice)) {
        trade.peakPrice = currentPrice;
        updateTradePeakPrice(trade.id, currentPrice);
      }

      const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
      const holdMs = Date.now() - trade.entryTime;
      const holdBars = Math.floor(holdMs / barMs);
      let newStop = trade.currentStop;

      // --- 1. Stop-loss / trailing exit ---
      // If a raised stop just got hit, label as `trailing` (analytics distinguishes
      // capital-protected exits from initial stop hits — same pattern as TREND/MR).
      if (currentPrice <= trade.currentStop) {
        const stopWasRaised = trade.trailingActivated || trade.currentStop > trade.initialStop;
        const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
        const reasonLabel = stopWasRaised ? 'MOM trail/BE stop hit' : 'MOM stop loss';
        results.push({
          trade,
          shouldExit: true,
          exitReason,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated: false,
          decision: makeDecision(
            trade.id,
            'execute',
            `${reasonLabel}: ${currentPrice.toFixed(4)} <= ${trade.currentStop.toFixed(4)}`,
            { currentPrice, currentStop: trade.currentStop, initialStop: trade.initialStop, pnlPercent },
          ),
        });
        continue;
      }

      // --- 2. Take-profit (3× ATR target — fixed in V2Trade.takeProfitTarget) ---
      if (trade.takeProfitTarget > 0 && currentPrice >= trade.takeProfitTarget) {
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.take_profit,
          exitPrice: trade.takeProfitTarget,
          newStop,
          trailingJustActivated: false,
          decision: makeDecision(
            trade.id,
            'execute',
            `MOM TP hit: ${currentPrice.toFixed(4)} >= ${trade.takeProfitTarget.toFixed(4)}`,
            { currentPrice, takeProfit: trade.takeProfitTarget, pnlPercent },
          ),
        });
        continue;
      }

      // --- 3. Break-even stop ---
      if (pnlPercent >= MOM_EXIT.BREAKEVEN_TRIGGER) {
        const beStop = trade.entryPrice * (1 + MOM_EXIT.BREAKEVEN_OFFSET);
        if (beStop > newStop) {
          newStop = beStop;
          updateTradeStop(trade.id, newStop);
        }
      }

      // --- 4. Trailing stop (percent_giveback) ---
      // Activates at +2.5% PnL, gives back only 5% of peak gain. Mirrors the
      // TREND/MR pattern: late activation + tight giveback = let winners run,
      // then lock most of the gain when they pull back.
      let trailingJustActivated = false;
      if (pnlPercent >= MOM_EXIT.TRAIL_ACTIVATE) {
        if (!trade.trailingActivated) {
          trailingJustActivated = true;
        }
        // peakPrice is set above (line 58-60) whenever currentPrice exceeds entryPrice,
        // which is guaranteed here since pnlPercent >= TRAIL_ACTIVATE (> 0) implies
        // currentPrice > entryPrice. TS can't see through the earlier conditional
        // assignment across the intervening await/calls, so guard explicitly rather
        // than asserting non-null — if it's ever genuinely absent, skip the trail
        // update instead of computing against a substituted number.
        if (trade.peakPrice != null) {
          const peakGain = trade.peakPrice - trade.entryPrice;
          const trailStop = trade.peakPrice - peakGain * MOM_EXIT.TRAIL_GIVEBACK;
          if (trailStop > newStop) {
            newStop = trailStop;
            updateTradeStop(trade.id, newStop);
          }
        }
      }

      // --- 5. Quick-kill: no progress after N bars ---
      // If we haven't made meaningful gain after QUICK_KILL_BARS, tighten the
      // stop closer to entry so we exit at smaller loss instead of letting it
      // grind down to the initial swing-low stop.
      if (
        MOM_EXIT.QUICK_KILL_ENABLED
        && holdBars >= MOM_EXIT.QUICK_KILL_BARS
        && pnlPercent < MOM_EXIT.QUICK_KILL_MIN_GAIN
        && trade.atrPercent != null
        && trade.atrPercent > 0
      ) {
        const atrDollar = trade.entryPrice * trade.atrPercent / 100;
        const tighter = trade.entryPrice - atrDollar * MOM_EXIT.QUICK_KILL_SL_TIGHTEN;
        if (tighter > newStop) {
          newStop = tighter;
          updateTradeStop(trade.id, newStop);
        }
      }

      // --- 6. Check tightened stop (BE / quick-kill / trailing all just raised newStop) ---
      if (currentPrice <= newStop && newStop > trade.currentStop) {
        // newStop > entryPrice => trailing/BE; newStop <= entryPrice => quick-kill loss
        const isTrail = newStop > trade.entryPrice;
        const exitReason = isTrail ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
        const reasonLabel = isTrail ? 'MOM trail/BE just hit' : 'MOM quick-kill stop hit';
        results.push({
          trade,
          shouldExit: true,
          exitReason,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated,
          decision: makeDecision(
            trade.id,
            'execute',
            `${reasonLabel}: ${currentPrice.toFixed(4)} <= ${newStop.toFixed(4)}`,
            { currentPrice, newStop, initialStop: trade.initialStop, pnlPercent },
          ),
        });
        continue;
      }

      // --- 7. Time-kill ---
      if (
        holdBars >= MOM_EXIT.TIME_KILL_BARS
        && Math.abs(pnlPercent) < MOM_EXIT.TIME_KILL_MIN_MOVE
      ) {
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.time_kill,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated,
          decision: makeDecision(
            trade.id,
            'execute',
            `MOM time kill: ${holdBars} bars, move ${(pnlPercent * 100).toFixed(2)}%`,
            { currentPrice, holdBars, pnlPercent },
          ),
        });
        continue;
      }

      // --- holding ---
      results.push({
        trade,
        shouldExit: false,
        exitReason: null,
        exitPrice: currentPrice,
        newStop,
        trailingJustActivated,
        decision: makeDecision(
          trade.id,
          'pass',
          `MOM holding: ${(pnlPercent * 100).toFixed(2)}%, stop=${newStop.toFixed(4)}`,
          { currentPrice, pnlPercent, currentStop: newStop },
        ),
      });
    } catch (e) {
      // Per-trade isolation (mirror of H5 fix in main exitManager) — a single
      // ticker's price-fetch failure shouldn't unwind the whole exit pass.
      console.warn(`[MOM ExitMgr] skipped ${trade.ticker}: ${(e as Error).message}`);
    }
  }

  return results;
}
