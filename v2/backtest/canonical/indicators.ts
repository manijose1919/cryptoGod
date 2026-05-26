// Self-contained indicator math for canonical strategies.
// Kept separate from v2/indicators/indicators.ts so the canonical backtest
// is reproducible from a single subdir and unaffected by changes to live code.

import type { Candle } from '../../pipeline/types.ts';

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function stdev(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  const means = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - means[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

// Wilder's RSI (the convention used by most charting libs).
export function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ATR (Wilder smoothing).
export function atr(candles: Candle[], period: number): number[] {
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let acc = 0;
  for (let i = 1; i <= period; i++) acc += tr[i];
  out[period] = acc / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

export interface MACDResult {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MACDResult {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const m = ef.map((v, i) => v - es[i]);
  const s = ema(m, sig);
  const h = m.map((v, i) => v - s[i]);
  return { macd: m, signal: s, hist: h };
}

// Donchian channel high/low at bar i looking back N bars (excluding bar i).
export function donchianHigh(candles: Candle[], i: number, n: number): number {
  let h = -Infinity;
  for (let k = i - n; k < i; k++) if (k >= 0 && candles[k].high > h) h = candles[k].high;
  return h;
}
export function donchianLow(candles: Candle[], i: number, n: number): number {
  let l = Infinity;
  for (let k = i - n; k < i; k++) if (k >= 0 && candles[k].low < l) l = candles[k].low;
  return l;
}

// Volume z-score: how many σ above mean is current bar's volume vs prior N.
export function volumeZ(candles: Candle[], i: number, n: number): number {
  if (i < n) return 0;
  let sum = 0;
  for (let k = i - n; k < i; k++) sum += candles[k].volume;
  const mean = sum / n;
  let varSum = 0;
  for (let k = i - n; k < i; k++) varSum += (candles[k].volume - mean) ** 2;
  const sd = Math.sqrt(varSum / n);
  return sd > 0 ? (candles[i].volume - mean) / sd : 0;
}
