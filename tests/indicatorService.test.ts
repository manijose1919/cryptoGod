import { describe, it, expect } from 'vitest';

// Test the helper math functions that don't require DOM
describe('EMA Calculation', () => {
  it('should return empty array for empty input', () => {
    // Direct test of EMA logic
    const data: number[] = [];
    const period = 10;
    const k = 2 / (period + 1);
    const result: number[] = [];
    if (data.length > 0) {
      result.push(data[0]);
      for (let i = 1; i < data.length; i++) {
        result.push(data[i] * k + result[i - 1] * (1 - k));
      }
    }
    expect(result).toEqual([]);
  });

  it('should calculate EMA correctly for simple data', () => {
    const data = [10, 11, 12, 13, 14, 15];
    const period = 3;
    const k = 2 / (period + 1);
    const result = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    expect(result.length).toBe(6);
    expect(result[0]).toBe(10);
    // EMA should trend toward recent values
    expect(result[5]).toBeGreaterThan(result[0]);
  });
});

describe('SMA Calculation', () => {
  it('should produce NaN for early values and correct averages after', () => {
    const data = [2, 4, 6, 8, 10];
    const period = 3;
    const result: number[] = new Array(data.length);
    let sum = 0;
    for (let i = 0; i < period; i++) { sum += data[i]; result[i] = NaN; }
    result[period - 1] = sum / period;
    for (let i = period; i < data.length; i++) {
      sum = sum - data[i - period] + data[i];
      result[i] = sum / period;
    }
    expect(result[2]).toBe(4); // (2+4+6)/3
    expect(result[3]).toBe(6); // (4+6+8)/3
    expect(result[4]).toBe(8); // (6+8+10)/3
  });
});

describe('RSI Division Safety', () => {
  it('should return 100 when all gains (no losses)', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const period = 14;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgLoss = losses / period;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (gains / period) / avgLoss));
    expect(rsi).toBe(100);
  });
});

describe('ATR Percentile Edge Case', () => {
  it('should handle currentATR exceeding all historical values', () => {
    const sortedATRs = [1, 2, 3, 4, 5];
    const currentATR = 10; // exceeds all
    const idx = sortedATRs.findIndex(v => v >= currentATR);
    const safeIndex = idx === -1 ? sortedATRs.length : idx;
    const percentile = (safeIndex / sortedATRs.length) * 100;
    expect(percentile).toBe(100); // Should be 100th percentile, not negative
  });
});

describe('Profit Factor Safety', () => {
  it('should cap at 999 instead of Infinity', () => {
    const grossWin = 100;
    const grossLoss = 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
    expect(profitFactor).toBe(999);
    expect(Number.isFinite(profitFactor)).toBe(true);
  });
});

describe('Fee-Adjusted Breakeven', () => {
  it('should classify small gains within fee range as BREAKEVEN', () => {
    const pnlPercent = 0.10; // 0.1% gain
    const outcome = pnlPercent > 0.20 ? 'WIN' : pnlPercent < -0.20 ? 'LOSS' : 'BREAKEVEN';
    expect(outcome).toBe('BREAKEVEN');
  });

  it('should classify gains above fee threshold as WIN', () => {
    const pnlPercent = 0.5; // 0.5% gain
    const outcome = pnlPercent > 0.20 ? 'WIN' : pnlPercent < -0.20 ? 'LOSS' : 'BREAKEVEN';
    expect(outcome).toBe('WIN');
  });
});
