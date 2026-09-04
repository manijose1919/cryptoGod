import { describe, it, expect } from 'vitest';
import { checkTimeGate, shouldSessionFlatten, TIME_GATE_CONFIG, SESSION_FLATTEN_CONFIG } from './timeGate.ts';

function utc(y: number, m: number, d: number, h: number): number {
  return Date.UTC(y, m - 1, d, h, 0, 0);
}

describe('checkTimeGate', () => {
  it('blocks Friday regardless of hour', () => {
    // 2026-09-04 is a Friday
    const r = checkTimeGate(utc(2026, 9, 4, 14));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/Fri/);
  });

  it('blocks the overnight window and post-session hours on a weekday', () => {
    // 2026-09-03 is a Thursday
    expect(checkTimeGate(utc(2026, 9, 3, 3)).allow).toBe(false);
    expect(checkTimeGate(utc(2026, 9, 3, 20)).allow).toBe(false);
    expect(checkTimeGate(utc(2026, 9, 3, 21)).allow).toBe(false);
    expect(checkTimeGate(utc(2026, 9, 3, 23)).allow).toBe(false);
  });

  it('boosts NY-session hours and allows the rest of the London/NY window', () => {
    const boosted = checkTimeGate(utc(2026, 9, 3, 12));
    expect(boosted.allow).toBe(true);
    expect(boosted.scoreBoost).toBe(TIME_GATE_CONFIG.BOOST_AMOUNT);

    const noon = checkTimeGate(utc(2026, 9, 3, 15));
    expect(noon.allow).toBe(true);
    expect(noon.scoreBoost).toBe(0);
  });
});

describe('shouldSessionFlatten', () => {
  it('holds through the session and flattens at 20:00 UTC on a weekday', () => {
    expect(shouldSessionFlatten(utc(2026, 9, 3, 19)).flatten).toBe(false);
    const close = shouldSessionFlatten(utc(2026, 9, 3, 20));
    expect(close.flatten).toBe(true);
    expect(close.reason).toMatch(/session flatten/);
  });

  it('flattens Friday from 16:00 UTC to avoid the weekend gap', () => {
    expect(shouldSessionFlatten(utc(2026, 9, 4, 15)).flatten).toBe(false);
    const friday = shouldSessionFlatten(utc(2026, 9, 4, 16));
    expect(friday.flatten).toBe(true);
    expect(friday.reason).toMatch(/Friday/);
    expect(SESSION_FLATTEN_CONFIG.FRIDAY_FLATTEN_HOUR_UTC).toBeLessThan(
      SESSION_FLATTEN_CONFIG.FLATTEN_HOUR_UTC,
    );
  });
});
