import { describe, expect, it } from 'vitest';
import { CANADIAN_USD_TICKERS, PAIRS_CONFIG, V2_CONFIG, isCanadianUsdTicker } from './config.ts';

describe('Canadian paper-trading configuration', () => {
  it('limits the primary scan universe to approved USD tickers', () => {
    expect(V2_CONFIG.SCAN_TICKERS).toEqual(CANADIAN_USD_TICKERS);
    expect(V2_CONFIG.SCAN_TICKERS.every(isCanadianUsdTicker)).toBe(true);
    expect(V2_CONFIG.SCAN_TICKERS.every(ticker => ticker.endsWith('USD'))).toBe(true);
  });

  it('identifies the current pairs configuration as outside the approved universe', () => {
    expect(isCanadianUsdTicker(PAIRS_CONFIG.SYMBOL_A)).toBe(false);
    expect(isCanadianUsdTicker(PAIRS_CONFIG.SYMBOL_B)).toBe(false);
  });
});
