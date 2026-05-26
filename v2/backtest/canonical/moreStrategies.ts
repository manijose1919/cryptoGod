// Additional 5 strategies. All OHLCV-tractable, all single-position long-only
// to fit the existing runner. Pairs (cross-asset) and Chart Patterns (multi-bar
// swing detection) deferred to their own sessions.

import type { CanonicalStrategy, EntryDecision, StrategyContext } from './types.ts';
import { ema, sma, stdev, atr, volumeZ } from './indicators.ts';

const NO_ENTRY: EntryDecision = { enter: false, stop: 0, target: 0, reason: '' };

// ---------------------------------------------------------------------------
// 6. DCA / Dynamic Accumulation (Blueprint #1).
//    Buys every N bars; size boosted when price is > 1σ below SMA(200).
//    Exit: portfolio-level TP only (e.g., +15% from average cost).
//    For a single-position backtest, we approximate by treating each DCA buy
//    as a discrete trade with a +X% target and a hard time-stop.
// ---------------------------------------------------------------------------
export interface DcaParams {
  cycleBars: number;            // 24 bars (≈1 day on 1h)
  smaPeriod: number;            // 200
  zBuyBoostThreshold: number;   // -1.0 σ — bigger size when this far below mean
  targetPct: number;            // 0.10 — 10% TP from entry
  stopPct: number;              // 0.40 — wide structural stop (40% drawdown)
  timeKillBars: number;         // 720 (≈30 days on 1h)
}
export const DCA_DEFAULTS: DcaParams = {
  cycleBars: 24, smaPeriod: 200, zBuyBoostThreshold: -1.0,
  targetPct: 0.10, stopPct: 0.40, timeKillBars: 720,
};

export function makeDca(p: DcaParams = DCA_DEFAULTS): CanonicalStrategy {
  return {
    name: 'DCA',
    warmupBars: p.smaPeriod + 5,
    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.smaPeriod + 5) return NO_ENTRY;
      // Fire on cycle boundaries; price boost gate non-mandatory.
      if (i % p.cycleBars !== 0) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const sma200 = sma(closes, p.smaPeriod);
      const sigma = stdev(closes, p.smaPeriod);
      const price = candles[i].close;
      const z = sigma[i] > 0 ? (price - sma200[i]) / sigma[i] : 0;
      const target = price * (1 + p.targetPct);
      const stop = price * (1 - p.stopPct);
      // Boost size effectively by requiring z below boost threshold for entry;
      // accumulation mode means we always fire, but if you wanted to gate cycles
      // to "only buy below avg," flip this to `if (z > p.zBuyBoostThreshold) return NO_ENTRY;`
      return { enter: true, stop, target, reason: `dca z=${z.toFixed(2)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Grid (Blueprint #2) — single-position approximation.
//    A true grid runs many simultaneous limits; the canonical runner is
//    single-position. We approximate by: buy when price drops δ below
//    last-known reference (rolling mean), sell when up δ. Doesn't capture
//    multi-level grid economics — see report caveats.
// ---------------------------------------------------------------------------
export interface GridParams {
  referencePeriod: number;  // 50 — SMA used as grid center
  gridStepPct: number;      // 0.015 — 1.5% step
  hardStopPct: number;      // 0.06 — exit if price drops 6% past entry (range broken)
  timeKillBars: number;     // 168 (≈1 week on 1h)
}
export const GRID_DEFAULTS: GridParams = {
  referencePeriod: 50, gridStepPct: 0.015, hardStopPct: 0.06, timeKillBars: 168,
};

export function makeGrid(p: GridParams = GRID_DEFAULTS): CanonicalStrategy {
  return {
    name: 'GRID',
    warmupBars: p.referencePeriod + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.referencePeriod + 5) return NO_ENTRY;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const ref = sma(closes, p.referencePeriod)[i];
      const price = candles[i].close;
      // Enter long only when price is below grid center by 1 step (buy the dip).
      const belowRef = (ref - price) / ref;
      if (belowRef < p.gridStepPct) return NO_ENTRY;
      // Target: grid center (price moves back up to mean).
      const target = ref;
      const stop = price * (1 - p.hardStopPct);
      if (target <= price) return NO_ENTRY;
      return { enter: true, stop, target, reason: `grid below=${(belowRef * 100).toFixed(2)}%` };
    },
  };
}

// ---------------------------------------------------------------------------
// 8. VWAP Reversal (Blueprint #9).
//    Anchored to UTC midnight. Buy when price is > k σ below session VWAP,
//    target = VWAP.
// ---------------------------------------------------------------------------
export interface VwapParams {
  zEntryThreshold: number; // -1.5 σ
  stopAtrPad: number;      // 0.5
  minHourInSession: number;// 4 — wait out the open
  maxHourInSession: number;// 20 — avoid the close
}
export const VWAP_DEFAULTS: VwapParams = {
  zEntryThreshold: -1.5, stopAtrPad: 0.5, minHourInSession: 4, maxHourInSession: 20,
};

export function makeVwap(p: VwapParams = VWAP_DEFAULTS): CanonicalStrategy {
  return {
    name: 'VWAP',
    warmupBars: 24 * 2 + 14,  // 2 full sessions
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < 50) return NO_ENTRY;
      // Find current UTC-midnight session start.
      const cur = candles[i];
      const curDate = new Date(cur.time);
      const sessionStartMs = Date.UTC(curDate.getUTCFullYear(), curDate.getUTCMonth(), curDate.getUTCDate());
      // Scan back to find session start bar.
      let sStart = i;
      while (sStart > 0 && candles[sStart].time >= sessionStartMs) sStart--;
      sStart++;
      const session = candles.slice(sStart, i + 1);
      if (session.length < p.minHourInSession) return NO_ENTRY;
      if (session.length > p.maxHourInSession) return NO_ENTRY;
      // Volume-weighted average.
      let cumPV = 0, cumV = 0;
      for (const c of session) {
        const typPrice = (c.high + c.low + c.close) / 3;
        cumPV += typPrice * c.volume;
        cumV += c.volume;
      }
      if (cumV === 0) return NO_ENTRY;
      const vwap = cumPV / cumV;
      // Session realized vol = std of (typPrice - vwap) / vwap.
      const devs = session.map(c => ((c.high + c.low + c.close) / 3 - vwap) / vwap);
      const meanDev = devs.reduce((s, x) => s + x, 0) / devs.length;
      const sd = Math.sqrt(devs.reduce((s, x) => s + (x - meanDev) ** 2, 0) / devs.length);
      if (sd === 0) return NO_ENTRY;
      const z = (cur.close / vwap - 1) / sd;
      if (z > p.zEntryThreshold) return NO_ENTRY;
      const a = atr(candles.slice(0, i + 1), 14);
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const stop = cur.close - p.stopAtrPad * atrAbs;
      const target = vwap;
      if (target <= cur.close) return NO_ENTRY;
      return { enter: true, stop, target, reason: `vwap z=${z.toFixed(2)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 9. Volume Profile / POC (Blueprint #12).
//    Build session volume profile (binned by price), entry when price is
//    below value-area-low, target = POC.
// ---------------------------------------------------------------------------
export interface VolumeProfileParams {
  sessionBars: number;     // 48 (≈2 days)
  bins: number;            // 30
  vaPercent: number;       // 0.70 — value area = 70% of volume
  stopAtrPad: number;      // 1.0
}
export const VP_DEFAULTS: VolumeProfileParams = {
  sessionBars: 48, bins: 30, vaPercent: 0.70, stopAtrPad: 1.0,
};

export function makeVolumeProfile(p: VolumeProfileParams = VP_DEFAULTS): CanonicalStrategy {
  return {
    name: 'VOLUME_PROFILE',
    warmupBars: p.sessionBars + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.sessionBars + 5) return NO_ENTRY;
      const window = candles.slice(i - p.sessionBars, i);
      let hi = -Infinity, lo = Infinity;
      for (const c of window) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
      if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) return NO_ENTRY;
      const binSize = (hi - lo) / p.bins;
      const volByBin: number[] = new Array(p.bins).fill(0);
      for (const c of window) {
        const typ = (c.high + c.low + c.close) / 3;
        const idx = Math.min(p.bins - 1, Math.max(0, Math.floor((typ - lo) / binSize)));
        volByBin[idx] += c.volume;
      }
      const totalVol = volByBin.reduce((s, v) => s + v, 0);
      if (totalVol === 0) return NO_ENTRY;
      let pocIdx = 0, pocVol = -1;
      for (let k = 0; k < p.bins; k++) if (volByBin[k] > pocVol) { pocVol = volByBin[k]; pocIdx = k; }
      // Expand value area outward from POC until coverage >= vaPercent.
      let included = volByBin[pocIdx], lowIdx = pocIdx, highIdx = pocIdx;
      while (included < p.vaPercent * totalVol && (lowIdx > 0 || highIdx < p.bins - 1)) {
        const left = lowIdx > 0 ? volByBin[lowIdx - 1] : -1;
        const right = highIdx < p.bins - 1 ? volByBin[highIdx + 1] : -1;
        if (left >= right) { lowIdx--; included += left > 0 ? left : 0; }
        else               { highIdx++; included += right > 0 ? right : 0; }
      }
      const vaLow = lo + lowIdx * binSize;
      const poc = lo + (pocIdx + 0.5) * binSize;
      const close = candles[i].close;
      if (close >= vaLow) return NO_ENTRY;
      if (poc <= close) return NO_ENTRY;
      const a = atr(candles.slice(0, i + 1), 14);
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const stop = close - p.stopAtrPad * atrAbs;
      return { enter: true, stop, target: poc, reason: `vp_below_va poc=${poc.toFixed(4)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 10. Candlestick patterns (Blueprint #19) — deterministic numeric defs.
//     Fires on bullish engulfing at a support level (close near 20-bar low).
// ---------------------------------------------------------------------------
export interface CandlestickParams {
  supportLookback: number;        // 20
  supportProximityPct: number;    // 0.03 — close within 3% of 20-bar low
  minBodyRatio: number;           // 1.5 — engulfing body / prior body
  atrStopMult: number;            // 1.5
  atrTargetMult: number;          // 2.0
}
export const CANDLESTICK_DEFAULTS: CandlestickParams = {
  supportLookback: 20, supportProximityPct: 0.03,
  minBodyRatio: 1.5, atrStopMult: 1.5, atrTargetMult: 2.0,
};

export function makeCandlestick(p: CandlestickParams = CANDLESTICK_DEFAULTS): CanonicalStrategy {
  return {
    name: 'CANDLESTICK',
    warmupBars: p.supportLookback + 5,
    evaluateEntry(ctx): EntryDecision {
      const { candles, i } = ctx;
      if (i < p.supportLookback + 5) return NO_ENTRY;
      const c1 = candles[i - 1];   // prior bar
      const c2 = candles[i];       // current bar
      const c1Red = c1.close < c1.open;
      const c2Green = c2.close > c2.open;
      const bodyEngulfs = c2.open <= c1.close && c2.close >= c1.open;
      const c1Body = Math.abs(c1.close - c1.open);
      const c2Body = Math.abs(c2.close - c2.open);
      if (!(c1Red && c2Green && bodyEngulfs && c2Body > p.minBodyRatio * c1Body)) return NO_ENTRY;
      // At support: close within X% of 20-bar low.
      let lowN = Infinity;
      for (let k = i - p.supportLookback + 1; k <= i; k++) if (candles[k].low < lowN) lowN = candles[k].low;
      const proximity = (c2.close - lowN) / lowN;
      if (proximity > p.supportProximityPct) return NO_ENTRY;
      const a = atr(candles.slice(0, i + 1), 14);
      const atrAbs = a[i];
      if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
      const stop = c2.low - 0.5 * atrAbs;
      const target = c2.close + p.atrTargetMult * atrAbs;
      return { enter: true, stop, target, reason: `engulfing_at_support` };
    },
  };
}

// Silence unused-imports linter — ema is exposed for future strategies.
export const _emaTouch = ema;
