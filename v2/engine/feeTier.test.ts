import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  KRAKEN_FEE_TIERS,
  feesForTier,
  resolveKrakenTier,
  setKrakenVolume30d,
  getKrakenFeeState,
} from './feeTier.ts';

describe('Kraken fee tiers (2026-07-09 schedule)', () => {
  const savedTier = process.env.KRAKEN_FEE_TIER;
  const savedAop = process.env.KRAKEN_AOP_USD;

  beforeEach(() => {
    delete process.env.KRAKEN_FEE_TIER;
    delete process.env.KRAKEN_AOP_USD;
    setKrakenVolume30d(0);
  });
  afterEach(() => {
    if (savedTier === undefined) delete process.env.KRAKEN_FEE_TIER; else process.env.KRAKEN_FEE_TIER = savedTier;
    if (savedAop === undefined) delete process.env.KRAKEN_AOP_USD; else process.env.KRAKEN_AOP_USD = savedAop;
    setKrakenVolume30d(0);
  });

  it('a fresh account is Tier 1 at 0.40% maker / 0.80% taker', () => {
    expect(resolveKrakenTier(0, 0)).toBe(1);
    const f = feesForTier(1);
    expect(f.MAKER_PERCENT).toBeCloseTo(0.0040);
    expect(f.TAKER_PERCENT).toBeCloseTo(0.0080);
    expect(f.ROUND_TRIP_REAL).toBeCloseTo(0.0120);
    expect(f.ROUND_TRIP_TAKER).toBeCloseTo(0.0160);
  });

  it('volume thresholds are inclusive and monotonic', () => {
    expect(resolveKrakenTier(2_499, 0)).toBe(1);
    expect(resolveKrakenTier(2_500, 0)).toBe(2);
    expect(resolveKrakenTier(10_000, 0)).toBe(3);
    expect(resolveKrakenTier(24_999, 0)).toBe(3);
    expect(resolveKrakenTier(50_000, 0)).toBe(5);
    expect(resolveKrakenTier(10_000_000, 0)).toBe(12);
    for (let i = 1; i < KRAKEN_FEE_TIERS.length; i++) {
      expect(KRAKEN_FEE_TIERS[i].maker).toBeLessThanOrEqual(KRAKEN_FEE_TIERS[i - 1].maker);
      expect(KRAKEN_FEE_TIERS[i].taker).toBeLessThan(KRAKEN_FEE_TIERS[i - 1].taker);
    }
  });

  it('assets on platform unlock Tier 3+ with zero volume; no AoP path to Tier 2', () => {
    expect(resolveKrakenTier(0, 19_999)).toBe(1);
    expect(resolveKrakenTier(0, 20_000)).toBe(3);
    expect(resolveKrakenTier(0, 100_000)).toBe(5);
  });

  it('best-of: whichever measure qualifies for the higher tier wins', () => {
    expect(resolveKrakenTier(2_500, 20_000)).toBe(3);
    expect(resolveKrakenTier(50_000, 20_000)).toBe(5);
  });

  it('setKrakenVolume30d moves the live table and reports the tier change', () => {
    expect(getKrakenFeeState().tier).toBe(1);
    const s = setKrakenVolume30d(12_000);
    expect(s.tier).toBe(3);
    expect(s.source).toBe('computed');
    expect(getKrakenFeeState().fees.TAKER_PERCENT).toBeCloseTo(0.0038);
    expect(getKrakenFeeState().fees.ROUND_TRIP_REAL).toBeCloseTo(0.0060);
  });

  it('garbage volume is treated as zero', () => {
    expect(setKrakenVolume30d(NaN).tier).toBe(1);
    expect(setKrakenVolume30d(-500).tier).toBe(1);
  });

  it('KRAKEN_AOP_USD is read on every recompute', () => {
    process.env.KRAKEN_AOP_USD = '20000';
    expect(setKrakenVolume30d(0).tier).toBe(3);
    expect(getKrakenFeeState().aopUsd).toBe(20_000);
  });

  it('KRAKEN_FEE_TIER pins the tier and is reported as such', () => {
    process.env.KRAKEN_FEE_TIER = '5';
    const s = setKrakenVolume30d(0);
    expect(s.tier).toBe(5);
    expect(s.source).toBe('env-tier');
    expect(s.fees.MAKER_PERCENT).toBeCloseTo(0.0015);
  });

  it('an out-of-range KRAKEN_FEE_TIER is ignored', () => {
    process.env.KRAKEN_FEE_TIER = '99';
    expect(setKrakenVolume30d(0).source).toBe('computed');
  });
});
