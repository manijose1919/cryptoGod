import { describe, expect, it } from 'vitest';
import {
  applyPaperSlippage,
  calculateRealizedPnl,
  getGapAwareStopFill,
} from './tradeAccounting.ts';

describe('trade accounting', () => {
  it('uses adverse slippage for every paper fill direction', () => {
    expect(applyPaperSlippage(100, 'long', 'entry', 0.001)).toBeCloseTo(100.1);
    expect(applyPaperSlippage(100, 'long', 'exit', 0.001)).toBeCloseTo(99.9);
    expect(applyPaperSlippage(100, 'short', 'entry', 0.001)).toBeCloseTo(99.9);
    expect(applyPaperSlippage(100, 'short', 'exit', 0.001)).toBeCloseTo(100.1);
  });

  it('calculates sign-correct net PnL for longs and shorts', () => {
    expect(calculateRealizedPnl('long', 100, 110, 2, 1)).toEqual({
      pnlGross: 20,
      pnlNet: 19,
    });
    expect(calculateRealizedPnl('short', 100, 90, 2, 1)).toEqual({
      pnlGross: 20,
      pnlNet: 19,
    });
  });

  it('fills paper stops at the worse observed price after a gap', () => {
    expect(getGapAwareStopFill('long', 95, 90)).toBe(90);
    expect(getGapAwareStopFill('short', 105, 110)).toBe(110);
    expect(getGapAwareStopFill('long', 95, 96)).toBe(95);
    expect(getGapAwareStopFill('short', 105, 104)).toBe(105);
  });
});
