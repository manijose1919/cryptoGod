import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';

const BO_EXIT = {
  TIME_KILL_BARS: 8,
  TIME_KILL_MIN_MOVE: 0.01,
  CHANDELIER_ATR_MULT: 2.0,
  CHANDELIER_MIN_BARS: 1,
};
const BAR_MS = 60 * 60 * 1000; // 1h bars

function makeDecision(tradeId: string, decision: string, reason: string, signals: Record<string, number>): DecisionRecord {
  return { tradeId, stage: PIPELINE_STAGE.exit, timestamp: Date.now(), decision: DECISION[decision as keyof typeof DECISION] ?? decision, reason, signals, thresholds: {}, confidence: 0 };
}

export async function checkBreakoutExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    const currentPrice = await exchange.getLatestPrice(trade.ticker);
    if (currentPrice > (trade.peakPrice ?? trade.entryPrice)) trade.peakPrice = currentPrice;
    const pnlPercent = (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;
    const holdBars = Math.floor(holdMs / BAR_MS);
    let newStop = trade.currentStop;

    // --- 1. Stop Loss ---
    if (currentPrice <= trade.currentStop) {
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.stop_loss, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `BO stop: ${currentPrice.toFixed(2)} <= ${trade.currentStop.toFixed(2)}`, { currentPrice, pnlPercent }) });
      continue;
    }

    // --- 2. Take Profit ---
    if (currentPrice >= trade.takeProfitTarget) {
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.take_profit, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `BO take profit: ${currentPrice.toFixed(2)} >= ${trade.takeProfitTarget.toFixed(2)}`, { currentPrice, pnlPercent }) });
      continue;
    }

    // --- 3. Chandelier Trail ---
    const atrDollar = trade.atrPercent != null && trade.atrPercent > 0 ? trade.entryPrice * trade.atrPercent / 100 : 0;
    if (atrDollar > 0 && holdBars >= BO_EXIT.CHANDELIER_MIN_BARS) {
      const chanStop = (trade.peakPrice ?? trade.entryPrice) - BO_EXIT.CHANDELIER_ATR_MULT * atrDollar;
      if (chanStop > newStop) {
        newStop = chanStop;
        updateTradeStop(trade.id, newStop);
      }
      if (currentPrice <= newStop && newStop > trade.entryPrice) {
        results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.trailing, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `BO chandelier trail: ${currentPrice.toFixed(2)} <= ${newStop.toFixed(2)}`, { currentPrice, pnlPercent }) });
        continue;
      }
    }

    // --- 4. Time Kill ---
    if (holdBars >= BO_EXIT.TIME_KILL_BARS && Math.abs(pnlPercent) < BO_EXIT.TIME_KILL_MIN_MOVE) {
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.time_kill, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `BO time kill: ${holdBars} bars, ${(pnlPercent * 100).toFixed(2)}%`, { currentPrice, holdBars, pnlPercent }) });
      continue;
    }

    results.push({ trade, shouldExit: false, exitReason: null, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'pass', `BO holding: ${(pnlPercent * 100).toFixed(2)}%`, { currentPrice, pnlPercent }) });
  }

  return results;
}
