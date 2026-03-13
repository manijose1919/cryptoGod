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
import { V2_CONFIG } from '../engine/config.ts';
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
      slAtrMult: V2_CONFIG.STOP_LOSS_ATR_MULT,
      tpAtrMult: V2_CONFIG.TAKE_PROFIT_ATR_MULT,
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
    const price = await exchange.getLatestPrice(signal.ticker);
    const quantity = risk.positionSizeUsd / price;
    const stopLoss = price - atr * V2_CONFIG.STOP_LOSS_ATR_MULT;
    const takeProfit = price + atr * V2_CONFIG.TAKE_PROFIT_ATR_MULT;
    const fee = price * quantity * V2_CONFIG.FEE_MAKER_PERCENT;

    const decision = makeExecuteDecision(
      tradeId,
      `${V2_CONFIG.MODE} entry at ${price.toFixed(2)}`,
      signal.confidence,
      { price, quantity, stopLoss, takeProfit, atr },
    );

    const trade: V2Trade = {
      id: tradeId,
      ticker: signal.ticker,
      side: 'long',
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
      decisionLog: [...previousDecisions, decision],
      createdAt: Date.now(),
    };

    return { trade, decision };
  }

  // --- Live mode: maker-only, no chasing ---
  try {
    const bestBid = await exchange.getBestBid(signal.ticker);
    const quantity = risk.positionSizeUsd / bestBid;
    const stopLoss = bestBid - atr * V2_CONFIG.STOP_LOSS_ATR_MULT;
    const takeProfit = bestBid + atr * V2_CONFIG.TAKE_PROFIT_ATR_MULT;

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
    const entryFee = finalStatus.fee > 0
      ? finalStatus.fee
      : fillPrice * fillQty * V2_CONFIG.FEE_MAKER_PERCENT;

    // Recalculate SL/TP from actual fill price
    const actualStop = fillPrice - atr * V2_CONFIG.STOP_LOSS_ATR_MULT;
    const actualTp = fillPrice + atr * V2_CONFIG.TAKE_PROFIT_ATR_MULT;

    // Place native stop loss on exchange
    try {
      await exchange.placeStopLoss(signal.ticker, fillQty, actualStop);
    } catch (e) {
      console.error(`[V2 Executor] Failed to place native SL: ${(e as Error).message}`);
    }

    const decision = makeExecuteDecision(
      tradeId,
      `Live entry filled at ${fillPrice.toFixed(2)}, native SL at ${actualStop.toFixed(2)}`,
      signal.confidence,
      { price: fillPrice, quantity: fillQty, stopLoss: actualStop, takeProfit: actualTp, atr },
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
      decisionLog: [...previousDecisions, decision],
      createdAt: Date.now(),
    };

    return { trade, decision };
  } catch (e) {
    const rejectDecision = makeReject(tradeId, `Exchange error: ${(e as Error).message}`);
    return { trade: null, decision: rejectDecision };
  }
}
