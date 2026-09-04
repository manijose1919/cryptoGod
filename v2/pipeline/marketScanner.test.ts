import { describe, it, expect } from 'vitest';
import { scanMarket } from './marketScanner.ts';
import { V2_CONFIG } from '../engine/config.ts';
import type { Candle } from './types.ts';

// A clean 1%/bar uptrend with ±1.5% wicks: STRONG_UP regime, ATR% ≈ 3 (inside
// the 2–8% band), so the scan reaches the 24h-volume gate.
function uptrend(n: number, volumePerBar: number): Candle[] {
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const prev = close;
    close = prev * 1.01;
    out.push({
      time: i * 3_600_000,
      open: prev,
      high: close * 1.015,
      low: prev * 0.985,
      close,
      volume: volumePerBar,
    });
  }
  return out;
}

function volumeFromReason(reason: string | undefined): number {
  const m = /vol24h=\$(\d+)|24h volume \$(\d+)/.exec(reason ?? '');
  if (!m) throw new Error(`no volume in reason: ${reason}`);
  return Number(m[1] ?? m[2]);
}

describe('scanMarket 24h volume estimate', () => {
  it('scales by the timeframe of the candles it is given, not CANDLE_INTERVAL', () => {
    const candles = uptrend(80, 1_000);
    const on4h = scanMarket(new Map([['XUSD', candles]]), 'long', '4h');
    const on1h = scanMarket(new Map([['XUSD', candles]]), 'long', '1h');
    const v4 = volumeFromReason(on4h[0].reason);
    const v1 = volumeFromReason(on1h[0].reason);
    // Same per-bar volume: 24 one-hour bars per day vs 6 four-hour bars.
    expect(v1 / v4).toBeCloseTo(4, 1);
  });

  it('defaults to CANDLE_INTERVAL when no timeframe is passed (legacy call sites)', () => {
    const candles = uptrend(80, 1_000);
    const dflt = scanMarket(new Map([['XUSD', candles]]));
    const explicit = scanMarket(new Map([['XUSD', candles]]), 'long', V2_CONFIG.CANDLE_INTERVAL);
    expect(volumeFromReason(dflt[0].reason)).toBe(volumeFromReason(explicit[0].reason));
  });

  it('a ticker that clears MIN_VOLUME_24H_USD on 4h is no longer rejected on 1h for the same bars', () => {
    // Per-bar notional chosen so the 4h estimate sits just above the floor:
    // 4h → vol × price × 6 per day. price ≈ 100·1.01^80 ≈ 221.
    const bars = uptrend(80, 1_000);
    const lastPrice = bars[bars.length - 1].close;
    const perBarUsd = V2_CONFIG.MIN_VOLUME_24H_USD / 6 * 1.05; // 5% above floor on 4h
    const candles = uptrend(80, perBarUsd / lastPrice);
    const on4h = scanMarket(new Map([['XUSD', candles]]), 'long', '4h')[0];
    const on1h = scanMarket(new Map([['XUSD', candles]]), 'long', '1h')[0];
    expect(on4h.passed).toBe(true);
    expect(on1h.passed).toBe(true);
    // Before the fix the 1h scan assumed 6 bars/day and under-counted 4×:
    expect(volumeFromReason(on1h.reason)).toBeGreaterThan(volumeFromReason(on4h.reason));
  });
});
