import { describe, expect, it } from 'vitest';
import type { Candle } from '../pipeline/types.ts';
import { getNextBarEntryPrice } from './backtestExecution.ts';

const candles: Candle[] = [
  { time: 1, open: 100, high: 102, low: 99, close: 101, volume: 10 },
  { time: 2, open: 110, high: 112, low: 108, close: 111, volume: 10 },
];

describe('V2 backtest entry timing', () => {
  it('fills after the signal at the next bar open with adverse slippage', () => {
    expect(getNextBarEntryPrice(candles, 0, 'long', 0.001)).toBeCloseTo(110.11);
    expect(getNextBarEntryPrice(candles, 0, 'short', 0.001)).toBeCloseTo(109.89);
  });

  it('does not invent a fill after the final candle', () => {
    expect(getNextBarEntryPrice(candles, 1, 'long', 0.001)).toBeNull();
  });
});
