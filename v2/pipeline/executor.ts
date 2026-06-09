// ============================================
// Phoenix V2 Trade Executor
// Maker-only entries, no chasing, paper/shadow support
// ============================================

import { randomUUID } from 'crypto';
import type {
  SignalResult,
  RiskResult,
  V2Trade,
  DecisionRecord,
} from './types.ts';
import {
  TRADE_STATUS,
  DECISION,
  PIPELINE_STAGE,
} from './types.ts';
import { V2_CONFIG, STRATEGY_EXIT_CONFIGS, getExchangeFees } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';

// --- Helpers ---

function makeReject(tradeId: string, reason: string): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.execute,
    timestamp: Date.now(),
    decision: DECISION.reject,
    reason,
    signals: {},
    thresholds: {},
    confidence: 0,
  };
}

function makeExecuteDecision(
  tradeId: string,
  reason: string,
  confidence: number,
  signals: Record<string, number>,
  slAtrMult: number = V2_CONFIG.STOP_LOSS_ATR_MULT,
  tpAtrMult: number = V2_CONFIG.TAKE_PROFIT_ATR_MULT,
): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.execute,
    timestamp: Date.now(),
    decision: DECISION.execute,
    reason,
    signals,
    thresholds: {
      makerFillTimeoutMs: V2_CONFIG.MAKER_FILL_TIMEOUT_MS,
      slAtrMult,
      tpAtrMult,
    },
    confidence,
  };
}

/**
 * Poll order status until filled or timeout.
 */
async function waitForFill(
  exchange: ExchangeAdapter,
  orderId: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await exchange.getOrderStatus(orderId);
    if (status.status === 'filled') return true;
    if (status.status === 'cancelled') return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// --- Main Executor ---

export async function executeTrade(
  signal: SignalResult,
  risk: RiskResult,
  exchange: ExchangeAdapter,
  previousDecisions: DecisionRecord[],
): Promise<{ trade: V2Trade | null; decision: DecisionRecord }> {
  const tradeId = randomUUID();
  const atr = signal.signals.atr as number;

  if (V2_CONFIG.MODE !== 'live') {
    // --- Shadow / Paper mode ---
    // Use close price from signal (already computed from candles) instead of extra API call
    let price = signal.signals.close_price as number;
    if (!price || price <= 0) {
      price = await exchange.getLatestPrice(signal.ticker);
    }
    if (!price || price <= 0) {
      const rejectDecision = makeReject(tradeId, `Cannot get price for ${signal.ticker}`);
      return { trade: null, decision: rejectDecision };
    }
    const quantity = risk.positionSizeUsd / price;
    const isShort = risk.side === 'short';
    // Use per-strategy exit config for SL/TP (BREAKOUT uses tighter stops than TREND)
    const strategy = (signal as any)._strategy ?? 'TREND';
    const exitCfg = STRATEGY_EXIT_CONFIGS[strategy] ?? STRATEGY_EXIT_CONFIGS.TREND;
    const slMult = isShort ? V2_CONFIG.SHORT_STOP_LOSS_ATR_MULT : exitCfg.slAtrMult;
    const tpMult = isShort ? V2_CONFIG.SHORT_TAKE_PROFIT_ATR_MULT : exitCfg.tpAtrMult;
    const stopLoss = isShort ? price + atr * slMult : price - atr * slMult;
    const takeProfit = isShort ? price - atr * tpMult : price + atr * tpMult;
    // H7: exchange-aware maker fee for paper-mode entry estimate
    const fee = price * quantity * getExchangeFees(exchange.getName()).MAKER_PERCENT;

    const decision = makeExecuteDecision(
      tradeId,
      `${V2_CONFIG.MODE} ${isShort ? 'SHORT' : ''} entry at ${price.toFixed(2)}`,
      signal.confidence,
      { price, quantity, stopLoss, takeProfit, atr },
      slMult,
      tpMult,
    );

    const trade: V2Trade = {
      id: tradeId,
      ticker: signal.ticker,
      side: isShort ? 'short' : 'long',
      status: TRADE_STATUS.open,
      entryPrice: price,
      entryTime: Date.now(),
      entryOrderType: 'maker',
      quantity,
      positionSizeUsd: risk.positionSizeUsd,
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      pnlGross: null,
      pnlNet: null,
      feesPaid: fee,
      holdDurationMs: null,
      initialStop: stopLoss,
      currentStop: stopLoss,
      takeProfitTarget: takeProfit,
      trailingActivated: false,
      entrySignals: signal.signals,
      entryRegime: signal.regime,
      entryConfidence: signal.confidence,
      atrPercent: signal.signals.atr_percent,
      peakPrice: price,
      stopOrderId: null, // C2: paper mode never places a native SL
      strategy: (signal as any)._strategy ?? 'TREND',
      timeframe: (signal as any)._timeframe ?? V2_CONFIG.CANDLE_INTERVAL,
      decisionLog: [...previousDecisions, decision],
      createdAt: Date.now(),
    };

    return { trade, decision };
  }

  // --- Live mode: maker-only, no chasing ---
  try {
    // Per-strategy exit config — Stage 5 executes whatever strategy ranked
    // best (TREND/MOMENTUM/BREAKOUT), so hardcoding TREND's 4.0x TP here gave
    // other strategies the wrong exits and mislabeled their stats.
    const liveStrategy = (signal as any)._strategy ?? 'TREND';
    const liveExitCfg = STRATEGY_EXIT_CONFIGS[liveStrategy] ?? STRATEGY_EXIT_CONFIGS.TREND;
    const bestBid = await exchange.getBestBid(signal.ticker);
    const quantity = risk.positionSizeUsd / bestBid;
    const stopLoss = bestBid - atr * liveExitCfg.slAtrMult;
    const takeProfit = bestBid + atr * liveExitCfg.tpAtrMult;

    // Place maker buy at best bid
    const orderResult = await exchange.placeMakerBuy(signal.ticker, bestBid, quantity);

    // Wait for fill
    const filled = await waitForFill(
      exchange,
      orderResult.orderId,
      V2_CONFIG.MAKER_FILL_TIMEOUT_MS,
    );

    if (!filled) {
      // Cancel unfilled order — do not chase
      await exchange.cancelOrder(orderResult.orderId);
      const rejectDecision = makeReject(tradeId, 'Maker order not filled, not chasing');
      return { trade: null, decision: rejectDecision };
    }

    // Get final fill details
    const finalStatus = await exchange.getOrderStatus(orderResult.orderId);
    const fillPrice = finalStatus.price > 0 ? finalStatus.price : bestBid;
    const fillQty = finalStatus.quantity > 0 ? finalStatus.quantity : quantity;
    // H7: exchange-aware maker fee fallback when the exchange doesn't report fee
    const entryFee = finalStatus.fee > 0
      ? finalStatus.fee
      : fillPrice * fillQty * getExchangeFees(exchange.getName()).MAKER_PERCENT;

    // Recalculate SL/TP from actual fill price
    const actualStop = fillPrice - atr * liveExitCfg.slAtrMult;
    const actualTp = fillPrice + atr * liveExitCfg.tpAtrMult;

    // Place native stop loss on exchange — retry with backoff, rollback if all fail.
    // A live position without an exchange-side SL is exposed to catastrophic loss
    // if the bot crashes (in-process exitManager wouldn't run). We try 3 times
    // with 1s/2s/4s backoff; if still failing, market-sell the position to close
    // it cleanly rather than holding it naked.
    // C2: capture the returned orderId so the exit path can cancel the SL
    // before placing its market-sell (otherwise the SL fires later on the next
    // re-entry's price dip, accidentally closing the fresh position).
    let slPlaced = false;
    let slError: Error | null = null;
    let stopOrderId: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const slResult = await exchange.placeStopLoss(signal.ticker, fillQty, actualStop);
        stopOrderId = slResult?.orderId ?? null;
        slPlaced = true;
        break;
      } catch (e) {
        slError = e as Error;
        console.warn(`[V2 Executor] SL placement attempt ${attempt}/3 failed: ${slError.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
    if (!slPlaced) {
      console.error(`[V2 Executor] SL placement failed after 3 attempts; rolling back position via market sell`);
      try {
        await exchange.placeMarketSell(signal.ticker, fillQty);
        const rejectDecision = makeReject(tradeId, `SL placement failed (${slError?.message ?? 'unknown'}), position rolled back via market sell`);
        return { trade: null, decision: rejectDecision };
      } catch (rollbackErr) {
        // Worst case: SL failed AND rollback failed. Position is NAKED on exchange.
        // Surface this loudly — operator must intervene manually.
        console.error(`[V2 Executor] CRITICAL: rollback also failed (${(rollbackErr as Error).message}). Position NAKED on exchange — manual intervention required.`);
        const rejectDecision = makeReject(tradeId, `SL failed + rollback failed — NAKED POSITION, manual intervention required`);
        return { trade: null, decision: rejectDecision };
      }
    }

    const decision = makeExecuteDecision(
      tradeId,
      `Live entry filled at ${fillPrice.toFixed(2)}, native SL at ${actualStop.toFixed(2)}`,
      signal.confidence,
      { price: fillPrice, quantity: fillQty, stopLoss: actualStop, takeProfit: actualTp, atr },
      liveExitCfg.slAtrMult,
      liveExitCfg.tpAtrMult,
    );

    const trade: V2Trade = {
      id: tradeId,
      ticker: signal.ticker,
      side: 'long',
      status: TRADE_STATUS.open,
      entryPrice: fillPrice,
      entryTime: Date.now(),
      entryOrderType: 'maker',
      quantity: fillQty,
      positionSizeUsd: fillPrice * fillQty,
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      pnlGross: null,
      pnlNet: null,
      feesPaid: entryFee,
      holdDurationMs: null,
      initialStop: actualStop,
      currentStop: actualStop,
      takeProfitTarget: actualTp,
      trailingActivated: false,
      entrySignals: signal.signals,
      entryRegime: signal.regime,
      entryConfidence: signal.confidence,
      atrPercent: signal.signals.atr_percent,
      peakPrice: fillPrice,
      stopOrderId, // C2: persist for cancellation on managed exit
      strategy: liveStrategy,  // Stage 5 executes any ranked strategy — tag the real one
      timeframe: (signal as any)._timeframe ?? V2_CONFIG.CANDLE_INTERVAL,
      decisionLog: [...previousDecisions, decision],
      createdAt: Date.now(),
    };

    return { trade, decision };
  } catch (e) {
    const rejectDecision = makeReject(tradeId, `Exchange error: ${(e as Error).message}`);
    return { trade: null, decision: rejectDecision };
  }
}
