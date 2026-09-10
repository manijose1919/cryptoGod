import { describe, it, expect } from 'vitest';
import { resolveTradingDataDir } from '../services/database.js';

describe('resolveTradingDataDir', () => {
  it('uses TRADING_DATA_DIR when set', () => {
    expect(resolveTradingDataDir('/tmp/paper-3137', '/workspace/data')).toBe('/tmp/paper-3137');
  });

  it('falls back when the override is empty', () => {
    expect(resolveTradingDataDir('  ', '/workspace/data')).toBe('/workspace/data');
    expect(resolveTradingDataDir(undefined, '/workspace/data')).toBe('/workspace/data');
  });
});
