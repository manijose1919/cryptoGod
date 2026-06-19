import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import { MR_CONFIG, timeframeToMs } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop, updateTradePeakPrice } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';

// Dynamic bar duration from configured candle interval (was hardcoded to 15m)
const BAR_MS = timeframeToMs(MR_CONFIG.CANDLE_INTERVAL);

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
    const isShort = trade.side === 'short';
    const currentPrice = await exchange.getLatestPrice(trade.ticker);

    // Track peak in the profitable direction: low for shorts, high for longs
    const prevPeak = trade.peakPrice ?? trade.entryPrice;
    const newPeak = isShort
      ? Math.min(currentPrice, prevPeak)
      : Math.max(currentPrice, prevPeak);
    if (newPeak !== prevPeak) {
      trade.peakPrice = newPeak;
      updateTradePeakPrice(trade.id, newPeak);
    }

    // pnlPercent: positive = profitable in our direction
    const pnlPercent = isShort
      ? (trade.entryPrice - currentPrice) / trade.entryPrice
      : (currentPrice - trade.entryPrice) / trade.entryPrice;

    const holdMs = Date.now() - trade.entryTime;
    const holdBars = Math.floor(holdMs / BAR_MS);
    let newStop = trade.currentStop;

    // --- 1. Stop Loss / Trailing Exit ---
    // For longs:  SL fires when price falls to stop (currentPrice <= stop)
    // For shorts: SL fires when price rises to stop (currentPrice >= stop)
    const slTriggered = isShort
      ? currentPrice >= trade.currentStop
      : currentPrice <= trade.currentStop;

    if (slTriggered) {
      // stopWasRaised: protection moved stop toward entry after initial placement
      // Longs: stop moved up (currentStop > initialStop)
      // Shorts: stop moved down (currentStop < initialStop — both above entry, but closer)
      const stopWasRaised = isShort
        ? trade.currentStop < trade.initialStop
        : trade.currentStop > trade.initialStop;
      const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
      const label = stopWasRaised ? 'MR trail/quick-kill stop hit' : 'MR stop loss';
      results.push({
        trade, shouldExit: true, exitReason,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `${label} (${isShort ? 'short' : 'long'}): price=${currentPrice.toFixed(4)} stop=${trade.currentStop.toFixed(4)}`,
          { currentPrice, currentStop: trade.currentStop, initialStop: trade.initialStop, pnlPercent }),
      });
      continue;
    }

    // --- 2. Take Profit (price reverts to EMA midline) ---
    // For longs:  TP fires when price rises to target (currentPrice >= tp)
    // For shorts: TP fires when price falls to target (currentPrice <= tp)
    const tpTriggered = isShort
      ? currentPrice <= trade.takeProfitTarget
      : currentPrice >= trade.takeProfitTarget;

    if (tpTriggered) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.take_profit,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR take profit (${isShort ? 'short' : 'long'} mean reached): price=${currentPrice.toFixed(4)} tp=${trade.takeProfitTarget.toFixed(4)}`,
          { currentPrice, takeProfitTarget: trade.takeProfitTarget, pnlPercent }),
      });
      continue;
    }

    // --- 3. Quick Kill (tighten SL on stalled trades) ---
    if (holdBars >= MR_CONFIG.QUICK_KILL_AFTER_BARS && pnlPercent < MR_CONFIG.QUICK_KILL_MIN_GAIN) {
      const atrDollar = trade.atrPercent != null && trade.atrPercent > 0
        ? trade.entryPrice * trade.atrPercent / 100 : 0;
      if (atrDollar > 0) {
        // Tighten: for longs move stop UP (closer to entry from below);
        //          for shorts move stop DOWN (closer to entry from above)
        const tighter = isShort
          ? trade.entryPrice + atrDollar * MR_CONFIG.QUICK_KILL_SL_ATR_MULT
          : trade.entryPrice - atrDollar * MR_CONFIG.QUICK_KILL_SL_ATR_MULT;
        const improved = isShort
          ? tighter < trade.currentStop   // short: lower = closer to entry = tighter
          : tighter > trade.currentStop;  // long:  higher = closer to entry = tighter
        if (improved) {
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
          `MR time kill (${isShort ? 'short' : 'long'}): held ${(holdMs / 60000).toFixed(0)}min, move ${(pnlPercent * 100).toFixed(2)}%`,
          { currentPrice, holdMs, pnlPercent }),
      });
      continue;
    }

    // --- 5. Check tightened stop (quick-kill fired and stop already breached this loop) ---
    const tightStopHit = isShort
      ? currentPrice >= newStop && newStop < trade.currentStop
      : currentPrice <= newStop && newStop > trade.currentStop;
    if (tightStopHit) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.trailing,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR quick-kill stop hit (${isShort ? 'short' : 'long'}): price=${currentPrice.toFixed(4)} newStop=${newStop.toFixed(4)}`,
          { currentPrice, newStop, initialStop: trade.initialStop, pnlPercent }),
      });
      continue;
    }

    // --- No exit ---
    results.push({
      trade, shouldExit: false, exitReason: null,
      exitPrice: currentPrice, newStop, trailingJustActivated: false,
      decision: makeDecision(trade.id, 'pass',
        `MR holding (${isShort ? 'short' : 'long'}): PnL ${(pnlPercent * 100).toFixed(2)}%, bars=${holdBars}`,
        { currentPrice, pnlPercent, holdBars }),
    });
  }

  return results;
}
