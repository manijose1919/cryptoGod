// The 5 canonical strategies, implemented pure-textbook per the strategy
// blueprint. No regime gates, composite scoring, or portfolio-level guards —
// these are deliberately stripped down so each strategy's raw edge is
// measured. Live trading would layer on additional filters.
//
// Convention: each evaluateEntry inspects the *closed* bar at index i and
// emits an entry decision (with stop/target) to be executed at the OPEN of
// bar i+1. The runner handles the next-bar fill to avoid lookahead.

import type { CanonicalStrategy, EntryDecision, StrategyContext } from './types.ts';
import { ema, rsi, sma, stdev, atr, macd, donchianHigh, donchianLow, volumeZ } from './indicators.ts';

const NO_ENTRY: EntryDecision = { enter: false, stop: 0, target: 0, reason: '' };

// ---------------------------------------------------------------------------
// 1. MA Crossover (Blueprint #4): EMA(12) crosses above EMA(26) on close.
//    Filter: |fast - slow| / price > 0.3% to avoid pinwheel whipsaws.
//    Stop:   entry - 1.5 × ATR(14). No fixed TP — trail with EMA(26).
// ---------------------------------------------------------------------------
export const maCrossover: CanonicalStrategy = {
  name: 'MA_CROSS',
  warmupBars: 30,
  evaluateEntry(ctx: StrategyContext): EntryDecision {
    const { candles, i } = ctx;
    if (i < 30) return NO_ENTRY;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const ef = ema(closes, 12);
    const es = ema(closes, 26);
    const a = atr(candles.slice(0, i + 1), 14);
    const price = candles[i].close;
    const crossedUp = ef[i - 1] <= es[i - 1] && ef[i] > es[i];
    const gapPct = Math.abs(ef[i] - es[i]) / price;
    if (!crossedUp || gapPct < 0.003) return NO_ENTRY;
    const atrAbs = a[i];
    if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
    return {
      enter: true,
      stop: price - 1.5 * atrAbs,
      target: 0,
      reason: `cross_up gap=${(gapPct * 100).toFixed(2)}%`,
    };
  },
  updateStop(ctx, _entryPrice, currentStop, _peak) {
    // Trail with EMA(26) below; ratchet up only.
    const closes = ctx.candles.slice(0, ctx.i + 1).map(c => c.close);
    const es = ema(closes, 26);
    const candidate = es[ctx.i];
    return Number.isFinite(candidate) && candidate > currentStop ? candidate : currentStop;
  },
};

// ---------------------------------------------------------------------------
// 2. RSI Reversal (Blueprint #6) — RANGE-regime variant only.
//    Entry: RSI(14) crosses UP through 30 AND price is within range.
//    Range proxy: |close - SMA(50)| / SMA(50) < 5% AND ATR%(14) > 0.5%.
//    Stop:  swing low of last 5 bars - 0.5 × ATR. Target: SMA(50).
// ---------------------------------------------------------------------------
export const rsiReversal: CanonicalStrategy = {
  name: 'RSI_REVERSAL',
  warmupBars: 55,
  evaluateEntry(ctx): EntryDecision {
    const { candles, i } = ctx;
    if (i < 55) return NO_ENTRY;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const r = rsi(closes, 14);
    const s50 = sma(closes, 50);
    const a = atr(candles.slice(0, i + 1), 14);
    const price = candles[i].close;
    const crossedUp = r[i - 1] <= 30 && r[i] > 30;
    if (!crossedUp) return NO_ENTRY;
    const distToMean = Math.abs(price - s50[i]) / s50[i];
    const atrPct = a[i] / price;
    if (distToMean > 0.05) return NO_ENTRY;     // not in range
    if (atrPct < 0.005) return NO_ENTRY;        // too quiet, no edge
    let swingLow = Infinity;
    for (let k = i - 4; k <= i; k++) if (candles[k].low < swingLow) swingLow = candles[k].low;
    const stop = swingLow - 0.5 * a[i];
    const target = s50[i];
    if (target <= price) return NO_ENTRY;       // require room to target
    return {
      enter: true,
      stop,
      target,
      reason: `rsi_up r=${r[i].toFixed(1)} distMA=${(distToMean * 100).toFixed(1)}%`,
    };
  },
  // No trailing — mean-reversion exits at target or stop.
};

// ---------------------------------------------------------------------------
// 3. Bollinger Mean Reversion (Blueprint #7).
//    Entry: prior close < lower band AND current close > prior close (turn-up).
//    Squeeze veto: bandwidth at 20th percentile of last 50 bars → skip.
//    Stop:  lower_band[i] - 1σ. Target: mid band (SMA-20).
// ---------------------------------------------------------------------------
export const bollingerMR: CanonicalStrategy = {
  name: 'BOLLINGER_MR',
  warmupBars: 80,
  evaluateEntry(ctx): EntryDecision {
    const { candles, i } = ctx;
    if (i < 80) return NO_ENTRY;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const mid = sma(closes, 20);
    const sd = stdev(closes, 20);
    const upper = mid.map((m, k) => m + 2 * sd[k]);
    const lower = mid.map((m, k) => m - 2 * sd[k]);
    const bw: number[] = [];
    for (let k = i - 49; k <= i; k++) {
      if (k >= 0 && Number.isFinite(mid[k]) && mid[k] > 0) {
        bw.push((upper[k] - lower[k]) / mid[k]);
      }
    }
    if (bw.length < 30) return NO_ENTRY;
    const sorted = [...bw].sort((a, b) => a - b);
    const p20 = sorted[Math.floor(0.2 * sorted.length)];
    const bwNow = (upper[i] - lower[i]) / mid[i];
    if (bwNow < p20) return NO_ENTRY;           // squeeze veto — breakout, not reversion
    const closeWasBelow = candles[i - 1].close < lower[i - 1];
    const turnedUp = candles[i].close > candles[i - 1].close;
    if (!closeWasBelow || !turnedUp) return NO_ENTRY;
    const stop = lower[i] - sd[i];
    const target = mid[i];
    if (target <= candles[i].close) return NO_ENTRY;
    return {
      enter: true,
      stop,
      target,
      reason: `bb_lower_recover sd=${sd[i].toFixed(2)}`,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. MACD Zero-Cross + Histogram Acceleration (Blueprint #8 — simplified).
//    Pure divergence detection is hard/noisy; this is the deterministic core:
//    Entry: histogram crosses 0 from below AND macd line > signal line AND
//           hist[i] - hist[i-1] > 0 (acceleration).
//    Stop:  entry - 1.5 × ATR(14). No fixed TP — trail via histogram decay
//    (exit when hist falls back below 50% of peak since entry).
// ---------------------------------------------------------------------------
export const macdStrategy: CanonicalStrategy = {
  name: 'MACD',
  warmupBars: 40,
  evaluateEntry(ctx): EntryDecision {
    const { candles, i } = ctx;
    if (i < 40) return NO_ENTRY;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const m = macd(closes, 12, 26, 9);
    const a = atr(candles.slice(0, i + 1), 14);
    const histPrev = m.hist[i - 1], histNow = m.hist[i];
    const crossedZero = histPrev <= 0 && histNow > 0;
    const accel = histNow - histPrev > 0;
    const macdAboveSignal = m.macd[i] > m.signal[i];
    if (!crossedZero || !accel || !macdAboveSignal) return NO_ENTRY;
    const atrAbs = a[i];
    if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
    const price = candles[i].close;
    return {
      enter: true,
      stop: price - 1.5 * atrAbs,
      target: 0,
      reason: `macd_zero_cross hist=${histNow.toFixed(3)}`,
    };
  },
  // MACD strategy doesn't trail via price; it relies on the runner's
  // peak-histogram tracker. We expose peak tracking via the runner instead.
};

// ---------------------------------------------------------------------------
// 5. Donchian Breakout (Blueprint #10).
//    Entry: close > prior 20-bar high AND volume z-score > 1.0.
//    Stop:  break-bar low - 0.25 × ATR. Trail: chandelier (peak − 2 × ATR).
//    No fixed TP — runs trend until trail hits.
// ---------------------------------------------------------------------------
export const donchianBreakout: CanonicalStrategy = {
  name: 'DONCHIAN_BREAKOUT',
  warmupBars: 30,
  evaluateEntry(ctx): EntryDecision {
    const { candles, i } = ctx;
    if (i < 25) return NO_ENTRY;
    const high20 = donchianHigh(candles, i, 20);
    if (!Number.isFinite(high20)) return NO_ENTRY;
    const close = candles[i].close;
    if (close <= high20) return NO_ENTRY;
    const vz = volumeZ(candles, i, 20);
    if (vz < 1.0) return NO_ENTRY;
    const a = atr(candles.slice(0, i + 1), 14);
    const atrAbs = a[i];
    if (!Number.isFinite(atrAbs) || atrAbs <= 0) return NO_ENTRY;
    const stop = candles[i].low - 0.25 * atrAbs;
    return {
      enter: true,
      stop,
      target: 0,
      reason: `donchian_break vz=${vz.toFixed(2)}`,
    };
  },
  updateStop(ctx, _entryPrice, currentStop, peak) {
    // Chandelier: peak − 2 × ATR, ratchet up only.
    const a = atr(ctx.candles.slice(0, ctx.i + 1), 14);
    const atrAbs = a[ctx.i];
    if (!Number.isFinite(atrAbs) || atrAbs <= 0) return currentStop;
    const candidate = peak - 2 * atrAbs;
    return candidate > currentStop ? candidate : currentStop;
  },
};

export const ALL_STRATEGIES: CanonicalStrategy[] = [
  maCrossover,
  rsiReversal,
  bollingerMR,
  macdStrategy,
  donchianBreakout,
];
