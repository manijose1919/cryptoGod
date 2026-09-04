import { describe, expect, it } from 'vitest';
import { V2_CONFIG } from './config.ts';

describe('ML entry gate configuration', () => {
  it('keeps the leaky unvalidated model and random bypass disabled', () => {
    expect(V2_CONFIG.ML_GATEKEEPER_ENABLED).toBe(false);
    expect(V2_CONFIG.GATEKEEPER_AB_TEST).toBe(false);
  });
});
