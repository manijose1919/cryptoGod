import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';
import { computeSignals } from '../indicators/indicators.ts';
import type { Candle } from './types.ts';

const MOM_EXIT = {
  SL_ATR_MULT: 2.0,
  HISTOGRAM_DECAY_THRESHOLD: 0.50,
  BREAKEVEN_TRIGGER: 0.01,
  BREAKEVEN_OFFSET: 0.001,
  TIME_KILL_BARS: 6,
  TIME_KILL_MIN_MOVE: 0.005,
};
const BAR_MS = 60 * 60 * 1000; // 1h bars

function makeDecision(tradeId: string, decision: string, reason: string, signals: Record<string, number>): DecisionRecord {
  return { tradeId, stage: PIPELINE_STAGE.exit, timestamp: Date.now(), decision: DECISION[decision as keyof typeof DECISION] ?? decision, reason, signals, thresholds: {}, confidence: 0 };
}

export async function checkMomentumExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
  candleCache?: Map<string, Candle[]>,
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
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.stop_loss, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `MOM stop: ${currentPrice.toFixed(2)} <= ${newStop.toFixed(2)}`, { currentPrice, pnlPercent }) });
      continue;
    }

    // --- 2. Break-Even ---
    if (pnlPercent >= MOM_EXIT.BREAKEVEN_TRIGGER) {
      const beStop = trade.entryPrice * (1 + MOM_EXIT.BREAKEVEN_OFFSET);
      if (beStop > newStop) {
        newStop = beStop;
        updateTradeStop(trade.id, newStop);
      }
    }

    // --- 3. Histogram Decay Exit ---
    // Exit when MACD histogram shrinks 50% from its peak since entry
    if (candleCache) {
      const candles = candleCache.get(trade.ticker);
      if (candles && candles.length > 30) {
        const { signals } = computeSignals(candles);
        const currentHist = signals.macd_histogram as number;
        const peakHist = trade.peakHistogram ?? currentHist;

        if (currentHist > peakHist) {
          trade.peakHistogram = currentHist;
        }

        if (peakHist > 0 && currentHist < peakHist * (1 - MOM_EXIT.HISTOGRAM_DECAY_THRESHOLD)) {
          results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.trailing, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `MOM histogram decay: ${currentHist.toFixed(6)} < ${(peakHist * 0.5).toFixed(6)} (50% of peak)`, { currentPrice, currentHist, peakHist, pnlPercent }) });
          continue;
        }
      }
    }

    // --- 4. Check tightened stop ---
    if (currentPrice <= newStop && newStop > trade.currentStop) {
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.stop_loss, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `MOM tightened stop: ${currentPrice.toFixed(2)} <= ${newStop.toFixed(2)}`, { currentPrice, pnlPercent }) });
      continue;
    }

    // --- 5. Time Kill ---
    if (holdBars >= MOM_EXIT.TIME_KILL_BARS && Math.abs(pnlPercent) < MOM_EXIT.TIME_KILL_MIN_MOVE) {
      results.push({ trade, shouldExit: true, exitReason: EXIT_REASON.time_kill, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'execute', `MOM time kill: ${holdBars} bars`, { currentPrice, holdBars, pnlPercent }) });
      continue;
    }

    results.push({ trade, shouldExit: false, exitReason: null, exitPrice: currentPrice, newStop, trailingJustActivated: false, decision: makeDecision(trade.id, 'pass', `MOM holding: ${(pnlPercent * 100).toFixed(2)}%`, { currentPrice, pnlPercent }) });
  }

  return results;
}
