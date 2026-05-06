// ============================================
// MOMENTUM Signal Generator (v2 — rebuilt 2026-05-06)
// ============================================
// Mirrors the rebuilt logic that hit PF 1.70-2.32 across 30/60/90-day windows
// in v2/backtest/multiStrategy/entryDetectors.ts:detectMomentum.
//
// Original (broken) logic compared |macdHist| (price-acceleration units) to
// avgAbsMove (price units) — different scales, near-random output, 0% WR.
//
// v2 logic:
//   * Real spike: macdHist z-score > N std-devs vs 20-bar rolling stats
//   * Higher highs: 3+ of last 5 closes higher than previous bar
//   * Current bar high > prior 3 bars' highs (breakout confirmation)
//   * RSI 50-70 (momentum but not exhausted)
//   * Volume ≥ 1.3× 20-bar avg
//   * Stop: below 3-bar swing low (returned in signal metadata)
// ============================================

import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime, macd } from '../indicators/indicators.ts';
import { MOMENTUM_CONFIG } from '../engine/config.ts';
import { checkTimeGate } from './timeGate.ts';

// --- helpers ---

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function highOf(candles: Candle[]): number {
  let m = -Infinity;
  for (const c of candles) if (c.high > m) m = c.high;
  return m;
}

function lowOf(candles: Candle[]): number {
  let m = Infinity;
  for (const c of candles) if (c.low < m) m = c.low;
  return m;
}

export function detectMomentumEntry(
  candles: Candle[],
  ticker: string,
): SignalResult | null {
  if (candles.length < MOMENTUM_CONFIG.MIN_CANDLES) return null;

  // --- TimeGate (hour-of-day + day-of-week filter) ---
  // Same data-discovered overlay applied to TREND. For backtest, candle time;
  // for live, current wall clock. MOMENTUM does NOT use scoreBoost (no
  // composite-score threshold to lower); only honors hard-block hours/days.
  const lastCandleTime = candles[candles.length - 1]?.time;
  const tg = checkTimeGate(lastCandleTime);
  if (!tg.allow) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  // --- regime gate ---
  if (!MOMENTUM_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi = signals.rsi as number;
  const macdHist = signals.macd_histogram as number;
  const volRatio = signals.volume_ratio as number;
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;

  // Basic feasibility
  if (atrPct <= 0 || macdHist <= 0 || price <= 0) return null;

  // --- RSI bracket (momentum but not overbought) ---
  if (rsi < MOMENTUM_CONFIG.RSI_MIN || rsi > MOMENTUM_CONFIG.RSI_MAX) return null;

  // --- Real volume confirmation ---
  if (volRatio < MOMENTUM_CONFIG.VOLUME_MULTIPLIER) return null;

  // --- z-score spike detection (the real fix) ---
  // Recompute MACD histogram series locally so we can do statistics on a
  // proper time series. The signals.macd_histogram is just the latest value.
  const closes = candles.map(c => c.close);
  const macdResult = macd(closes, 12, 26, 9);
  const histSeries = macdResult.histogram;
  if (histSeries.length < 21) return null;

  // Use last 20 bars EXCLUDING the current bar for the rolling stats — we
  // want to know "how unusual is *this* histogram vs recent history."
  const recentHist = histSeries.slice(-21, -1);
  const histStd = stdev(recentHist);
  if (histStd <= 0) return null;
  const histMean = recentHist.reduce((s, x) => s + x, 0) / recentHist.length;
  const zScore = (macdHist - histMean) / histStd;
  if (zScore < MOMENTUM_CONFIG.HISTOGRAM_SPIKE_Z) return null;

  // --- Higher-highs confirmation ---
  // 3+ of last 5 closes must be higher than the bar before them (real upward
  // pressure, not chop with a single spike).
  const last6 = candles.slice(-6);
  let upBars = 0;
  for (let i = 1; i < last6.length; i++) {
    if (last6[i].close > last6[i - 1].close) upBars++;
  }
  if (upBars < MOMENTUM_CONFIG.MIN_UP_BARS) return null;

  // --- Current bar's high must exceed prior 3 bars' highs (real breakout) ---
  const last = candles[candles.length - 1];
  const last3prior = candles.slice(-4, -1);
  if (last.high <= highOf(last3prior)) return null;

  // --- Confidence scoring ---
  const spikeBonus = Math.min(0.20, (zScore - MOMENTUM_CONFIG.HISTOGRAM_SPIKE_Z) * 0.05);
  const upBonus = Math.min(0.15, (upBars - MOMENTUM_CONFIG.MIN_UP_BARS) * 0.05);
  const volBonus = Math.min(0.15, (volRatio - MOMENTUM_CONFIG.VOLUME_MULTIPLIER) * 0.10);
  const confidence = Math.max(0.4, Math.min(0.90,
    0.45 + spikeBonus + upBonus + volBonus,
  ));

  // Compute swing-low stop (used by engine when constructing the trade).
  // Stash in signals metadata (typed as Record<string, ...>) so the engine
  // doesn't have to recompute. Engine still does its own ATR-mult fallback.
  const swingLow = lowOf(candles.slice(-4));

  return {
    ticker,
    passed: true,
    compositeScore: confidence * 100,
    confidence,
    signals: {
      ...signals,
      // expose intermediate values so engine and analytics can read them
      mom_z_score: zScore,
      mom_up_bars: upBars,
      mom_swing_low: swingLow,
    },
    regime: regimeResult.regime,
    reason: `MOM v2 z=${zScore.toFixed(1)}, RSI=${rsi.toFixed(0)}, up=${upBars}/5, vol=${volRatio.toFixed(1)}x`,
  };
}
