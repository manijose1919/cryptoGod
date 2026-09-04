import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeAdapter, OrderResult } from '../exchange/types.ts';
import type { SignalSnapshot, V2Trade } from './types.ts';

const order: OrderResult = {
  orderId: 'order-1',
  ticker: 'BTCUSD',
  side: 'sell',
  price: 94,
  quantity: 1,
  status: 'filled',
  fee: 0,
  orderType: 'taker',
};

function makeTrade(): V2Trade {
  return {
    id: 'trade-1',
    ticker: 'BTCUSD',
    side: 'long',
    status: 'open',
    entryPrice: 100,
    entryTime: Date.now(),
    entryOrderType: 'maker',
    quantity: 1,
    positionSizeUsd: 100,
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    pnlGross: null,
    pnlNet: null,
    feesPaid: 0.16,
    holdDurationMs: null,
    initialStop: 95,
    currentStop: 95,
    takeProfitTarget: 110,
    trailingActivated: false,
    entrySignals: {} as SignalSnapshot,
    entryRegime: 'UP',
    entryConfidence: 0.8,
    peakPrice: 100,
    strategy: 'TREND',
    timeframe: '4h',
    decisionLog: [],
    createdAt: Date.now(),
  };
}

function makeExchange(): ExchangeAdapter {
  return {
    getName: () => 'kraken',
    getLatestPrice: vi.fn().mockResolvedValue(96),
    placeMakerBuy: vi.fn().mockResolvedValue(order),
    placeMakerSell: vi.fn().mockResolvedValue(order),
    placeMarketSell: vi.fn().mockResolvedValue(order),
    placeStopLoss: vi.fn().mockResolvedValue(order),
    cancelOrder: vi.fn().mockResolvedValue(true),
    getOrderStatus: vi.fn().mockResolvedValue(order),
    getBestBid: vi.fn().mockResolvedValue(94),
    getBestAsk: vi.fn().mockResolvedValue(97),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkExits paper fills', () => {
  it('uses an executable bid for a long stop exit', async () => {
    vi.resetModules();
    vi.stubEnv('V2_MODE', 'paper');
    const { checkExits } = await import('./exitManager.ts');

    const results = await checkExits([makeTrade()], makeExchange(), {
      setStop: () => {},
      setTrailingActivated: () => {},
      setPeakPrice: () => {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      shouldExit: true,
      exitReason: 'stop_loss',
      exitPrice: 94,
    });
  });
});
