import type { Candle } from '../../pipeline/types.ts';
import type { StrategyExitParams, MSTrade } from './types.ts';

export interface ExitCheckResult {
  shouldExit: boolean;
  exitPrice: number;
  exitReason: string | null;
  newStop: number;
  trailingActivated: boolean;
  peakHistogram: number;
}

export function checkStrategyExit(
  trade: MSTrade,
  bar: Candle,
  holdBars: number,
  intervalMinutes: number,
  exitParams: StrategyExitParams,
  currentHistogram?: number,
): ExitCheckResult {
  const holdMs = holdBars * intervalMinutes * 60 * 1000;
  let currentStop = trade.currentStop;
  let trailingActivated = trade.trailingActivated;
  let peakHistogram = trade.peakHistogram;

  if (bar.high > trade.peakPrice) {
    trade.peakPrice = bar.high;
  }

  // --- 1. Stop Loss ---
  if (bar.low <= currentStop) {
    return { shouldExit: true, exitPrice: currentStop, exitReason: 'stop_loss', newStop: currentStop, trailingActivated, peakHistogram };
  }

  // --- 2. Take Profit ---
  if (exitParams.takeProfitMethod !== 'none' && trade.takeProfit > 0 && bar.high >= trade.takeProfit) {
    return { shouldExit: true, exitPrice: trade.takeProfit, exitReason: 'take_profit', newStop: currentStop, trailingActivated, peakHistogram };
  }

  const pnlPctHigh = (bar.high - trade.entryPrice) / trade.entryPrice;
  const pnlPctClose = (bar.close - trade.entryPrice) / trade.entryPrice;

  // --- 3. Break-Even ---
  if (exitParams.breakEvenEnabled && pnlPctHigh >= exitParams.breakEvenTriggerPercent) {
    const beStop = trade.entryPrice * (1 + exitParams.breakEvenOffsetPercent);
    if (beStop > currentStop) currentStop = beStop;
  }

  // --- 4. Quick-Kill ---
  if (exitParams.quickKillEnabled && holdBars >= exitParams.quickKillAfterBars) {
    const peakPnl = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;
    if (peakPnl < exitParams.quickKillMinGain && pnlPctClose < exitParams.quickKillMinGain) {
      const atr = trade.atrPercent > 0 ? trade.entryPrice * trade.atrPercent / 100 : 0;
      if (atr > 0) {
        const tighter = trade.entryPrice - atr * exitParams.quickKillSlTighten;
        if (tighter > currentStop) currentStop = tighter;
      }
    }
  }

  // --- 5. Trailing ---
  if (exitParams.trailingMethod === 'percent_giveback') {
    if (pnlPctClose >= exitParams.trailingActivatePercent) {
      trailingActivated = true;
      let giveback = exitParams.trailingParam;
      if (trade.atrPercent > 2.0) giveback *= 1.3;
      else if (trade.atrPercent > 1.0) giveback *= 1.1;
      else if (trade.atrPercent < 0.3) giveback *= 0.7;

      const peakGain = trade.peakPrice - trade.entryPrice;
      const trail = trade.peakPrice - peakGain * giveback;
      if (trail > currentStop) currentStop = trail;

      if (bar.low <= currentStop) {
        return { shouldExit: true, exitPrice: currentStop, exitReason: 'trailing', newStop: currentStop, trailingActivated, peakHistogram };
      }
    }
  } else if (exitParams.trailingMethod === 'chandelier') {
    const atr = trade.atrPercent > 0 ? trade.entryPrice * trade.atrPercent / 100 : 0;
    if (atr > 0 && holdBars >= 1) {
      const chanStop = trade.peakPrice - exitParams.trailingParam * atr;
      if (chanStop > currentStop) {
        currentStop = chanStop;
        trailingActivated = true;
      }
      if (bar.low <= currentStop && currentStop > trade.entryPrice) {
        return { shouldExit: true, exitPrice: currentStop, exitReason: 'trailing', newStop: currentStop, trailingActivated, peakHistogram };
      }
    }
  } else if (exitParams.trailingMethod === 'histogram_decay' && currentHistogram !== undefined) {
    if (currentHistogram > peakHistogram) peakHistogram = currentHistogram;
    if (peakHistogram > 0 && currentHistogram < peakHistogram * (1 - exitParams.trailingParam)) {
      return { shouldExit: true, exitPrice: bar.close, exitReason: 'histogram_decay', newStop: currentStop, trailingActivated, peakHistogram };
    }
  }

  // Check if tightened stop was hit
  if (bar.low <= currentStop && currentStop > trade.currentStop) {
    const isTrail = currentStop > trade.entryPrice;
    return { shouldExit: true, exitPrice: currentStop, exitReason: isTrail ? 'trailing' : 'stop_loss', newStop: currentStop, trailingActivated, peakHistogram };
  }

  // --- 6. Time Kill ---
  if (exitParams.timeKillBars > 0 && holdBars >= exitParams.timeKillBars && Math.abs(pnlPctClose) < exitParams.timeKillMinMove) {
    return { shouldExit: true, exitPrice: bar.close, exitReason: 'time_kill', newStop: currentStop, trailingActivated, peakHistogram };
  }

  return { shouldExit: false, exitPrice: bar.close, exitReason: null, newStop: currentStop, trailingActivated, peakHistogram };
}
