import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import { MR_CONFIG } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';

const BAR_MS = 15 * 60 * 1000; // 15m bars

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
      timeKillBars: MR_CONFIG.TIME_KILL_BARS,
      timeKillMinMove: MR_CONFIG.TIME_KILL_MIN_MOVE,
      quickKillBars: MR_CONFIG.QUICK_KILL_AFTER_BARS,
    },
    confidence: 0,
  };
}

export async function checkMeanReversionExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    const currentPrice = await exchange.getLatestPrice(trade.ticker);
    if (currentPrice > (trade.peakPrice ?? trade.entryPrice)) {
      trade.peakPrice = currentPrice;
    }
    const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;
    const holdBars = Math.floor(holdMs / BAR_MS);

    let newStop = trade.currentStop;

    // --- 1. Stop Loss ---
    if (currentPrice <= trade.currentStop) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.stop_loss,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR stop loss: ${currentPrice.toFixed(4)} <= ${trade.currentStop.toFixed(4)}`,
          { currentPrice, currentStop: trade.currentStop, pnlPercent }),
      });
      continue;
    }

    // --- 2. Take Profit (at mean target) ---
    if (currentPrice >= trade.takeProfitTarget) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.take_profit,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR take profit (mean reached): ${currentPrice.toFixed(4)} >= ${trade.takeProfitTarget.toFixed(4)}`,
          { currentPrice, takeProfitTarget: trade.takeProfitTarget, pnlPercent }),
      });
      continue;
    }

    // --- 3. Quick Kill (tighten SL on duds) ---
    if (holdBars >= MR_CONFIG.QUICK_KILL_AFTER_BARS && pnlPercent < MR_CONFIG.QUICK_KILL_MIN_GAIN) {
      const atrDollar = trade.atrPercent != null && trade.atrPercent > 0
        ? trade.entryPrice * trade.atrPercent / 100 : 0;
      if (atrDollar > 0) {
        const tighter = trade.entryPrice - atrDollar * MR_CONFIG.QUICK_KILL_SL_ATR_MULT;
        if (tighter > trade.currentStop) {
          newStop = tighter;
          updateTradeStop(trade.id, newStop);
        }
      }
    }

    // --- 4. Time Kill ---
    const timeKillMs = MR_CONFIG.TIME_KILL_BARS * BAR_MS;
    if (holdMs > timeKillMs && Math.abs(pnlPercent) < MR_CONFIG.TIME_KILL_MIN_MOVE) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.time_kill,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR time kill: held ${(holdMs / 60000).toFixed(0)}min, move ${(pnlPercent * 100).toFixed(2)}%`,
          { currentPrice, holdMs, pnlPercent }),
      });
      continue;
    }

    // --- 5. Check tightened stop ---
    if (currentPrice <= newStop && newStop > trade.currentStop) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.stop_loss,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR tightened stop hit: ${currentPrice.toFixed(4)} <= ${newStop.toFixed(4)}`,
          { currentPrice, newStop, pnlPercent }),
      });
      continue;
    }

    // --- No exit ---
    results.push({
      trade, shouldExit: false, exitReason: null,
      exitPrice: currentPrice, newStop, trailingJustActivated: false,
      decision: makeDecision(trade.id, 'pass',
        `MR holding: PnL ${(pnlPercent * 100).toFixed(2)}%, bars=${holdBars}`,
        { currentPrice, pnlPercent, holdBars }),
    });
  }

  return results;
}
