import { describe, expect, it } from 'vitest';
import { BEARISH_CONFIG } from './bearishServices.ts';

describe('bearish side-service safety', () => {
  it('keeps unvalidated and potentially real side services disabled', () => {
    expect(BEARISH_CONFIG.SHORT_ENABLED).toBe(false);
    expect(BEARISH_CONFIG.STAKING_ENABLED).toBe(false);
    expect(BEARISH_CONFIG.ARB_ENABLED).toBe(false);
    expect(BEARISH_CONFIG.DCA_SIM_ONLY).toBe(true);
  });
});
