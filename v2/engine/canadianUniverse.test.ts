import { describe, it, expect } from 'vitest';
import {
  CANADIAN_DAYTRADE_BASES,
  CANADIAN_DAYTRADE_TICKERS,
  isCanadianUsdPair,
  assertCanadianUniverse,
} from './canadianUniverse.ts';
import { V2_CONFIG, MOMENTUM_CONFIG, MR_CONFIG, SNIPER_CONFIG, STRATEGY_TIMEFRAMES } from './config.ts';

describe('Canadian daytrade universe', () => {
  it('is USD-quoted, never USDT/USDC, and matches the CIRO base list minus BNB', () => {
    expect(CANADIAN_DAYTRADE_BASES).not.toContain('BNB');
    expect(CANADIAN_DAYTRADE_TICKERS).toEqual([
      'BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD',
    ]);
    for (const ticker of CANADIAN_DAYTRADE_TICKERS) {
      expect(isCanadianUsdPair(ticker)).toBe(true);
    }
  });

  it('rejects USDT, USDC, CAD, and unknown bases', () => {
    expect(isCanadianUsdPair('BTCUSDT')).toBe(false);
    expect(isCanadianUsdPair('ETHUSDC')).toBe(false);
    expect(isCanadianUsdPair('BTCCAD')).toBe(false);
    expect(isCanadianUsdPair('AKTUSD')).toBe(false);
    expect(isCanadianUsdPair('BNBUSD')).toBe(false);
    expect(isCanadianUsdPair('')).toBe(false);
  });

  it('throws on a non-Canadian ticker in the scan list', () => {
    expect(() => assertCanadianUniverse(['BTCUSD', 'PENGUUSD'])).toThrow(/PENGUUSD/);
    expect(() => assertCanadianUniverse(CANADIAN_DAYTRADE_TICKERS)).not.toThrow();
  });
});

describe('daytrading config invariants', () => {
  it('defaults to paper, 1h, STRONG_UP-only, sniper off', () => {
    expect(V2_CONFIG.MODE).toBe('paper');
    expect(V2_CONFIG.CANDLE_INTERVAL).toBe('1h');
    expect([...V2_CONFIG.ALLOWED_REGIMES]).toEqual(['STRONG_UP']);
    expect(SNIPER_CONFIG.ENABLED).toBe(false);
    expect(STRATEGY_TIMEFRAMES.TREND).toEqual(['1h']);
    expect(STRATEGY_TIMEFRAMES.MOMENTUM).toEqual(['1h']);
    expect(STRATEGY_TIMEFRAMES.BREAKOUT).toEqual([]);
  });

  it('uses the same Canadian book for TREND, MOMENTUM, and mean reversion', () => {
    assertCanadianUniverse(V2_CONFIG.SCAN_TICKERS);
    assertCanadianUniverse(MOMENTUM_CONFIG.SCAN_TICKERS);
    assertCanadianUniverse(MR_CONFIG.SCAN_TICKERS);
  });

  it('keeps expected return above Kraken real round-trip (0.42%)', () => {
    expect(V2_CONFIG.MIN_EXPECTED_RETURN).toBeGreaterThan(0.0042);
    expect(V2_CONFIG.MIN_ATR_PERCENT).toBeGreaterThanOrEqual(1.0);
    expect(V2_CONFIG.REENTRY_COOLDOWN_MS).toBeGreaterThan(0);
    expect(V2_CONFIG.MAX_OPEN_POSITIONS).toBeLessThanOrEqual(2);
  });
});
