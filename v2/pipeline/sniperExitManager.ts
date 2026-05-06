// ============================================
// SNIPER Exit Manager (new-coin sniper, 2026-05-06)
// ============================================
// Rug-pull-aware exits for new-coin sniper trades. Tighter than TREND/MOM
// because new listings can rug fast.
//
// Exit hierarchy:
//   1. Rug-pull score >= 3 → instant exit (priority over everything)
//   2. Hard stop hit (-3% from entry, never moves down)
//   3. Trailing stop hit (only when trail is activated)
//   4. Trail activation at +5%, then giveback 30% of peak gain
//   5. Time-kill at 8h
// ============================================

import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import {
  updateTradeStop,
  updateTradePeakPrice,
  markTrailingActivated,
} from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';
import { SNIPER_CONFIG } from '../engine/config.ts';
import type { NewCoinDetector } from './sniperSignal.ts';

function makeDecision(
  tradeId: string,
  reason: string,
  signals: Record<string, number>,
): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.exit,
    timestamp: Date.now(),
    decision: DECISION.execute,
    reason,
    signals,
    thresholds: {},
    confidence: 0,
  };
}

export async function checkSniperExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
  detector: NewCoinDetector,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    try {
      const currentPrice = await exchange.getLatestPrice(trade.ticker);

      // Track peak.
      if (currentPrice > (trade.peakPrice ?? trade.entryPrice)) {
        trade.peakPrice = currentPrice;
        updateTradePeakPrice(trade.id, currentPrice);
      }

      const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
      const holdMs = Date.now() - trade.entryTime;
      let newStop = trade.currentStop;
      let trailingJustActivated = false;

      // --- 1. Rug-pull instant exit (highest priority) ---
      const listing = detector.getActiveNewListings().find(l => l.ticker === trade.ticker);
      if (listing && listing.rugPullScore >= 3) {
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.stop_loss,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated: false,
          decision: makeDecision(trade.id,
            `SNIPER rug-pull score=${listing.rugPullScore}`,
            { price: currentPrice, pnl: pnlPercent, rugScore: listing.rugPullScore }),
        });
        continue;
      }

      // --- 2. Stop-loss / trailing exit ---
      if (currentPrice <= trade.currentStop) {
        const stopWasRaised = trade.trailingActivated || trade.currentStop > trade.initialStop;
        const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
        const reasonLabel = stopWasRaised ? 'SNIPER trail stop' : 'SNIPER stop loss (-3%)';
        results.push({
          trade,
          shouldExit: true,
          exitReason,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated: false,
          decision: makeDecision(trade.id, reasonLabel,
            { price: currentPrice, stop: trade.currentStop, pnl: pnlPercent }),
        });
        continue;
      }

      // --- 3. Trail activation + giveback ---
      const peak = trade.peakPrice ?? currentPrice;
      const peakGain = (peak - trade.entryPrice) / trade.entryPrice;

      if (!trade.trailingActivated && peakGain >= SNIPER_CONFIG.TRAIL_ACTIVATE_PERCENT) {
        const activatedStop = trade.entryPrice * (1 + SNIPER_CONFIG.TRAIL_ACTIVATE_PERCENT * 0.4);
        if (activatedStop > trade.currentStop) {
          trade.currentStop = activatedStop;
          newStop = activatedStop;
          updateTradeStop(trade.id, activatedStop);
        }
        trade.trailingActivated = true;
        trailingJustActivated = true;
        markTrailingActivated(trade.id);
      }

      if (trade.trailingActivated) {
        const giveback = peakGain * SNIPER_CONFIG.TRAIL_GIVEBACK_PERCENT;
        const proposed = trade.entryPrice * (1 + peakGain - giveback);
        if (proposed > trade.currentStop) {
          trade.currentStop = proposed;
          newStop = proposed;
          updateTradeStop(trade.id, proposed);
        }
      }

      // --- 4. Time-kill ---
      if (holdMs >= SNIPER_CONFIG.TIME_KILL_MS) {
        results.push({
          trade,
          shouldExit: true,
          exitReason: EXIT_REASON.time_kill,
          exitPrice: currentPrice,
          newStop,
          trailingJustActivated,
          decision: makeDecision(trade.id,
            `SNIPER time-kill (${(holdMs / 3600000).toFixed(1)}h)`,
            { price: currentPrice, holdMs, pnl: pnlPercent }),
        });
        continue;
      }

      // No exit this loop — emit hold record.
      results.push({
        trade,
        shouldExit: false,
        exitReason: null,
        exitPrice: currentPrice,
        newStop,
        trailingJustActivated,
        decision: makeDecision(trade.id,
          `SNIPER hold pnl=${(pnlPercent * 100).toFixed(2)}%`,
          { price: currentPrice, peak, pnl: pnlPercent, stop: trade.currentStop }),
      });
    } catch (err: unknown) {
      console.error(`[SNIPER] Exit check failed for ${trade.ticker}: ${(err as Error).message}`);
    }
  }

  return results;
}
