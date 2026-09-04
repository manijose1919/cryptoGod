import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { V2_CONFIG } from '../engine/config.ts';
import { applyPaperSlippage, paperStopFillPrice, paperSlippageFraction } from './paperFills.ts';

// V2_CONFIG is `as const` for typing only; the object is mutable at runtime.
const cfg = V2_CONFIG as unknown as { PAPER_SLIPPAGE_BPS: number };

describe('paper fills', () => {
  const saved = cfg.PAPER_SLIPPAGE_BPS;
  beforeEach(() => { cfg.PAPER_SLIPPAGE_BPS = 10; }); // 0.10% per side for round numbers
  afterEach(() => { cfg.PAPER_SLIPPAGE_BPS = saved; });

  it('slippage fraction comes from PAPER_SLIPPAGE_BPS; non-positive disables it', () => {
    expect(paperSlippageFraction()).toBeCloseTo(0.001);
    cfg.PAPER_SLIPPAGE_BPS = 0;
    expect(paperSlippageFraction()).toBe(0);
    expect(applyPaperSlippage(100, 'long', 'entry')).toBe(100);
    cfg.PAPER_SLIPPAGE_BPS = NaN;
    expect(paperSlippageFraction()).toBe(0);
  });

  it('every leg moves against the trader', () => {
    expect(applyPaperSlippage(100, 'long', 'entry')).toBeCloseTo(100.1);   // buy higher
    expect(applyPaperSlippage(100, 'long', 'exit')).toBeCloseTo(99.9);     // sell lower
    expect(applyPaperSlippage(100, 'short', 'entry')).toBeCloseTo(99.9);   // sell lower
    expect(applyPaperSlippage(100, 'short', 'exit')).toBeCloseTo(100.1);   // buy back higher
  });

  it('a long round trip with no price move loses exactly 2× slippage', () => {
    const entry = applyPaperSlippage(100, 'long', 'entry');
    const exit = applyPaperSlippage(100, 'long', 'exit');
    expect((exit - entry) / entry).toBeCloseTo(-0.002, 5);
  });

  it('invalid prices pass through untouched', () => {
    expect(applyPaperSlippage(0, 'long', 'entry')).toBe(0);
    expect(applyPaperSlippage(NaN, 'long', 'entry')).toBeNaN();
  });

  describe('stop-market fill', () => {
    it('long: books the stop when price is still at it, slipped down', () => {
      expect(paperStopFillPrice(95, 95, 'long')).toBeCloseTo(94.905);
    });
    it('long: books the gap-through price when the market is already below the stop', () => {
      expect(paperStopFillPrice(95, 92, 'long')).toBeCloseTo(92 * 0.999);
    });
    it('long: never books better than the stop even if price bounced back above it', () => {
      // stop triggered at 95, loop observes 96 — a stop-market would have filled ≤ 95
      expect(paperStopFillPrice(95, 96, 'long')).toBeCloseTo(95 * 0.999);
    });
    it('short: mirrors — worse is higher', () => {
      expect(paperStopFillPrice(105, 108, 'short')).toBeCloseTo(108 * 1.001);
      expect(paperStopFillPrice(105, 104, 'short')).toBeCloseTo(105 * 1.001);
    });
  });
});
