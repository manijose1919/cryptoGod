import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeAdapter, OrderResult } from '../exchange/types.ts';
import type { SignalResult, SignalSnapshot } from './types.ts';

const order: OrderResult = {
  orderId: 'order-1',
  ticker: 'BTCUSD',
  side: 'buy',
  price: 100,
  quantity: 1,
  status: 'filled',
  fee: 0,
  orderType: 'maker',
};

function makeExchange(): ExchangeAdapter {
  return {
    getName: () => 'kraken',
    getLatestPrice: vi.fn().mockResolvedValue(100),
    placeMakerBuy: vi.fn().mockResolvedValue(order),
    placeMakerSell: vi.fn().mockResolvedValue(order),
    placeMarketSell: vi.fn().mockResolvedValue(order),
    placeStopLoss: vi.fn().mockResolvedValue(order),
    cancelOrder: vi.fn().mockResolvedValue(true),
    getOrderStatus: vi.fn().mockResolvedValue(order),
    getBestBid: vi.fn().mockResolvedValue(99),
    getBestAsk: vi.fn().mockResolvedValue(101),
  };
}

function makeSignal(): SignalResult {
  return {
    ticker: 'BTCUSD',
    passed: true,
    compositeScore: 80,
    confidence: 0.8,
    regime: 'UP',
    signals: {
      atr: 2,
      atr_percent: 2,
      close_price: 100,
    } as SignalSnapshot,
  };
}

async function loadExecutor(mode: 'paper' | 'shadow') {
  vi.resetModules();
  vi.stubEnv('V2_MODE', mode);
  return import('./executor.ts');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('executeTrade simulation modes', () => {
  it('keeps shadow mode signal-only', async () => {
    const { executeTrade } = await loadExecutor('shadow');
    const exchange = makeExchange();

    const result = await executeTrade(
      makeSignal(),
      { ticker: 'BTCUSD', passed: true, positionSizeUsd: 99, quantity: 0.99, stopLoss: 97, takeProfit: 105, expectedReturn: 0.02 },
      exchange,
      [],
    );

    expect(result.trade).toBeNull();
    expect(result.decision.reason).toContain('Shadow signal');
    expect(exchange.getBestBid).not.toHaveBeenCalled();
  });

  it('uses the best bid and maker fee for a paper long entry', async () => {
    const { executeTrade } = await loadExecutor('paper');
    const exchange = makeExchange();

    const result = await executeTrade(
      makeSignal(),
      { ticker: 'BTCUSD', passed: true, positionSizeUsd: 99, quantity: 0.99, stopLoss: 97, takeProfit: 105, expectedReturn: 0.02 },
      exchange,
      [],
    );

    expect(result.trade).toMatchObject({
      entryPrice: 99,
      quantity: 1,
      positionSizeUsd: 99,
      entryOrderType: 'maker',
    });
    expect(result.trade?.feesPaid).toBeCloseTo(0.1584);
    expect(exchange.getBestBid).toHaveBeenCalledWith('BTCUSD');
  });
});
