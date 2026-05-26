// The 5 base strategies, now parameterized. Each is a factory that takes a
// params object and returns a CanonicalStrategy. This lets the sweep engine
// iterate parameter combinations without copy-pasting strategy code.
//
// Defaults are chosen to match the original canonical implementation so the
// pre-sweep baseline is recoverable.

import type { CanonicalStrategy, EntryDecision, StrategyContext } from './types.ts';
import { ema, rsi, sma, stdev, atr, macd, donchianHigh, volumeZ } from './indicators.ts';

const NO_ENTRY: EntryDecision = { enter: false, stop: 0, target: 0, reason: '' };

// ---------------------------------------------------------------------------
// 1. MA Crossover
// ---------------------------------------------------------------------------
export interface MACrossParams {
  fastPeriod: number;       // default 12
  slowPeriod: number;       // default 26
  minGapPct: number;        // default 0.003 (0.3%)
  atrStopMult: number;      // default 1.5
  atrPeriod: number;        // default 14
  trailWithSlow: boolean;   // default true
}

export const MA_CROSS_DEFAULTS: MACrossParams = {
  fastPeriod: 12, slowPeriod: 26, minGapPct: 0.003,
  atrStopMult: 1.5, atrPeriod: 14, trailWithSlow: true,
};

export function makeMaCrossover(p: MACrossParams = MA_CROSS_DEFAULTS): CanonicalStrategy {
  return {
    name: 'MA_CROSS',
    warmupBars: p.slowPeriod + 5,
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.slowPeriod + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const ef = ema(closes, p.fastPeriod);
      const es = ema(closes, p.slowPeriod);
      const a = atr(candles.slice(0, i + 1), p.atrPeriod);
      const price = candles[i].close;
      const crossedUp = ef[i - 1] <= es[i - 1] && ef[i] > es[i];
      const gapPct = Math.abs(ef[i] - es[i]) / price;
      if (!crossedUp || gapPct < p.minGapPct) return NO_ENTRY;
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      return {
        enter: true,
        stop: price - p.atrStopMult * atrAbs,
        target: 0,
        reason: `cross gap=${(gapPct * 100).toFixed(2)}%`,
      };
    },
    updateStop: p.trailWithSlow
      ? (ctx, _entry, currentStop) => {
          const closes = ctx.candles.slice(0, ctx.i + 1).map(c => c.close);
          const es = ema(closes, p.slowPeriod);
          const candidate = es[ctx.i];
          return Number.isFinite(candidate) && candidate > currentStop ? candidate : currentStop;
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// 2. RSI Reversal
// ---------------------------------------------------------------------------
export interface RsiReversalParams {
  rsiPeriod: number;         // 14
  oversoldThreshold: number; // 30
  smaTargetPeriod: number;   // 50 — used as both range-proxy MA and TP target
  maxDistPctFromMa: number;  // 0.05 — within 5% of MA50 = "in range"
  minAtrPctForEntry: number; // 0.005 — 0.5% ATR%; below this, no edge
  swingLowLookback: number;  // 5
  swingLowAtrPad: number;    // 0.5
}

export const RSI_REVERSAL_DEFAULTS: RsiReversalParams = {
  rsiPeriod: 14, oversoldThreshold: 30, smaTargetPeriod: 50,
  maxDistPctFromMa: 0.05, minAtrPctForEntry: 0.005,
  swingLowLookback: 5, swingLowAtrPad: 0.5,
};

export function makeRsiReversal(p: RsiReversalParams = RSI_REVERSAL_DEFAULTS): CanonicalStrategy {
  return {
    name: 'RSI_REVERSAL',
    warmupBars: p.smaTargetPeriod + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.smaTargetPeriod + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const r = rsi(closes, p.rsiPeriod);
      const s50 = sma(closes, p.smaTargetPeriod);
      const a = atr(candles.slice(0, i + 1), 14);
      const price = candles[i].close;
      const crossedUp = r[i - 1] <= p.oversoldThreshold && r[i] > p.oversoldThreshold;
      if (!crossedUp) return NO_ENTRY;
      const distToMean = Math.abs(price - s50[i]) / s50[i];
      const atrPct = a[i] / price;
      if (distToMean > p.maxDistPctFromMa) return NO_ENTRY;
      if (atrPct < p.minAtrPctForEntry) return NO_ENTRY;
      let swingLow = Infinity;
      for (let k = i - p.swingLowLookback + 1; k <= i; k++) {
        if (candles[k].low < swingLow) swingLow = candles[k].low;
      }
      const stop = swingLow - p.swingLowAtrPad * a[i];
      const target = s50[i];
      if (target <= price) return NO_ENTRY;
      return { enter: true, stop, target, reason: `rsi=${r[i].toFixed(1)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Bollinger MR
// ---------------------------------------------------------------------------
export interface BollingerMRParams {
  smaPeriod: number;    // 20
  stdevMult: number;    // 2
  squeezeLookback: number;     // 50
  squeezePercentile: number;   // 0.2 — skip if bandwidth in bottom 20%
  stopSdPad: number;    // 1 (extra σ below lower band)
}

export const BOLLINGER_MR_DEFAULTS: BollingerMRParams = {
  smaPeriod: 20, stdevMult: 2, squeezeLookback: 50,
  squeezePercentile: 0.2, stopSdPad: 1,
};

export function makeBollingerMR(p: BollingerMRParams = BOLLINGER_MR_DEFAULTS): CanonicalStrategy {
  return {
    name: 'BOLLINGER_MR',
    warmupBars: p.smaPeriod + p.squeezeLookback + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.smaPeriod + p.squeezeLookback + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const mid = sma(closes, p.smaPeriod);
      const sd = stdev(closes, p.smaPeriod);
      const upper = mid.map((m, k) => m + p.stdevMult * sd[k]);
      const lower = mid.map((m, k) => m - p.stdevMult * sd[k]);
      const bw: number[] = [];
      for (let k = i - p.squeezeLookback + 1; k <= i; k++) {
        if (k >= 0 && Number.isFinite(mid[k]) && mid[k] > 0) {
          bw.push((upper[k] - lower[k]) / mid[k]);
        }
      }
      if (bw.length < p.squeezeLookback * 0.6) return NO_ENTRY;
      const sorted = [...bw].sort((a, b) => a - b);
      const cutoff = sorted[Math.floor(p.squeezePercentile * sorted.length)];
      const bwNow = (upper[i] - lower[i]) / mid[i];
      if (bwNow < cutoff) return NO_ENTRY;
      const closeWasBelow = candles[i - 1].close < lower[i - 1];
      const turnedUp = candles[i].close > candles[i - 1].close;
      if (!closeWasBelow || !turnedUp) return NO_ENTRY;
      const stop = lower[i] - p.stopSdPad * sd[i];
      const target = mid[i];
      if (target <= candles[i].close) return NO_ENTRY;
      return { enter: true, stop, target, reason: `bb_recover sd=${sd[i].toFixed(2)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 4. MACD
// ---------------------------------------------------------------------------
export interface MacdParams {
  fastPeriod: number;        // 12
  slowPeriod: number;        // 26
  signalPeriod: number;      // 9
  requireMacdAboveZero: boolean; // default false — extra filter
  atrStopMult: number;       // 1.5
  histDecayPct: number;      // 0.5 — exit when hist < 50% of peak
}

export const MACD_DEFAULTS: MacdParams = {
  fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
  requireMacdAboveZero: false, atrStopMult: 1.5, histDecayPct: 0.5,
};

export function makeMacd(p: MacdParams = MACD_DEFAULTS): CanonicalStrategy {
  return {
    name: 'MACD',
    warmupBars: p.slowPeriod + p.signalPeriod + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.slowPeriod + p.signalPeriod + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const m = macd(closes, p.fastPeriod, p.slowPeriod, p.signalPeriod);
      const a = atr(candles.slice(0, i + 1), 14);
      const histPrev = m.hist[i - 1], histNow = m.hist[i];
      const crossedZero = histPrev <= 0 && histNow > 0;
      const accel = histNow - histPrev > 0;
      const macdAboveSignal = m.macd[i] > m.signal[i];
      const macdGate = p.requireMacdAboveZero ? m.macd[i] > 0 : true;
      if (!crossedZero || !accel || !macdAboveSignal || !macdGate) return NO_ENTRY;
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const price = candles[i].close;
      return {
        enter: true,
        stop: price - p.atrStopMult * atrAbs,
        target: 0,
        reason: `macd_cross hist=${histNow.toFixed(3)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Donchian Breakout
// ---------------------------------------------------------------------------
export interface DonchianParams {
  lookback: number;        // 20
  volZThreshold: number;   // 1.0
  stopAtrPad: number;      // 0.25
  trailAtrMult: number;    // 2.0
}

export const DONCHIAN_DEFAULTS: DonchianParams = {
  lookback: 20, volZThreshold: 1.0, stopAtrPad: 0.25, trailAtrMult: 2.0,
};

export function makeDonchianBreakout(p: DonchianParams = DONCHIAN_DEFAULTS): CanonicalStrategy {
  return {
    name: 'DONCHIAN_BREAKOUT',
    warmupBars: p.lookback + 10,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.lookback + 5) return NO_ENTRY;
      const high = donchianHigh(candles, i, p.lookback);
      if (!Number.isFinite(high)) return NO_ENTRY;
      const close = candles[i].close;
      if (close <= high) return NO_ENTRY;
      const vz = volumeZ(candles, i, p.lookback);
      if (vz < p.volZThreshold) return NO_ENTRY;
      const a = atr(candles.slice(0, i + 1), 14);
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const stop = candles[i].low - p.stopAtrPad * atrAbs;
      return { enter: true, stop, target: 0, reason: `donchian vz=${vz.toFixed(2)}` };
    },
    updateStop(ctx, _entry, currentStop, peak) {
      const a = atr(ctx.candles.slice(0, ctx.i + 1), 14);
      const atrAbs = a[ctx.i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return currentStop;
      const candidate = peak - p.trailAtrMult * atrAbs;
      return candidate > currentStop ? candidate : currentStop;
    },
  };
}

// Default-built strategies for the no-sweep run.
export const ALL_DEFAULT_STRATEGIES: CanonicalStrategy[] = [
  makeMaCrossover(),
  makeRsiReversal(),
  makeBollingerMR(),
  makeMacd(),
  makeDonchianBreakout(),
];
