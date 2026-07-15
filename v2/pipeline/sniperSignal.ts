// ============================================
// SNIPER Signal Generator (new-coin sniper, 2026-05-06)
// ============================================
// Entry detector for new Kraken USD listings during their early volatility
// window. Reuses `services/newCoinDetector.js` for rug-pull screening.
//
// Entry rules (ALL must pass):
//   * Listing age in [MIN_LISTING_AGE_MS, MAX_LISTING_AGE_MS]
//   * Rug-pull score < MAX_RUG_PULL_SCORE (set by detector)
//   * Bar volume >= MIN_BAR_VOLUME_USD (avoid dead listings)
//   * RSI <= RSI_MAX (not yet overbought)
//   * Volume ratio >= VOLUME_MULTIPLIER (current bar vol vs 12-bar avg)
//   * 3+ of last 5 bars closed higher than the previous bar
// ============================================

import type { Candle, SignalResult } from './types.ts';
import { computeSignals } from '../indicators/indicators.ts';
import { SNIPER_CONFIG } from '../engine/config.ts';
import { checkTimeGate } from './timeGate.ts';

// Detector is JS — accessed via dynamic import in the engine and passed in.
export interface NewCoinDetector {
  isNewListing(ticker: string): boolean;
  getActiveNewListings(): Array<{
    ticker: string;
    firstSeen: number;
    rugPullScore: number;
    isOnCooldown: boolean;
  }>;
}

export function detectSniperEntry(
  candles: Candle[],
  ticker: string,
  detector: NewCoinDetector,
): SignalResult | null {
  if (candles.length < SNIPER_CONFIG.MIN_CANDLES) return null;

  // --- TimeGate (hour-of-day + day-of-week filter) ---
  // Extended to SNIPER 2026-07-15 (see CHANGELOG). Hard-block only,
  // no scoreBoost — same as MOMENTUM.
  const tg = checkTimeGate(candles[candles.length - 1]?.time);
  if (!tg.allow) return null;

  // --- Listing age + rug-pull screen ---
  const listings = detector.getActiveNewListings();
  const listing = listings.find(l => l.ticker === ticker);
  if (!listing) return null;

  const ageMs = Date.now() - listing.firstSeen;
  if (ageMs < SNIPER_CONFIG.MIN_LISTING_AGE_MS) return null;
  if (ageMs > SNIPER_CONFIG.MAX_LISTING_AGE_MS) return null;
  if (listing.isOnCooldown) return null;
  if (listing.rugPullScore >= SNIPER_CONFIG.MAX_RUG_PULL_SCORE) return null;

  // --- Indicators ---
  const { signals } = computeSignals(candles);
  const rsi = signals.rsi as number;
  const volRatio = signals.volume_ratio as number;
  const price = signals.close_price as number;
  const last = candles[candles.length - 1];
  const barVolUsd = (last.volume ?? 0) * price;

  if (price <= 0) return null;
  if (barVolUsd < SNIPER_CONFIG.MIN_BAR_VOLUME_USD) return null;
  if (rsi > SNIPER_CONFIG.RSI_MAX) return null;
  if (volRatio < SNIPER_CONFIG.VOLUME_MULTIPLIER) return null;

  // --- Higher-highs confirmation ---
  const last6 = candles.slice(-6);
  let upBars = 0;
  for (let i = 1; i < last6.length; i++) {
    if (last6[i].close > last6[i - 1].close) upBars++;
  }
  if (upBars < SNIPER_CONFIG.MIN_UP_BARS) return null;

  // --- Confidence: scale with vol surge + cleanliness ---
  const volBonus = Math.min(0.20, (volRatio - SNIPER_CONFIG.VOLUME_MULTIPLIER) * 0.10);
  const upBonus = Math.min(0.15, (upBars - SNIPER_CONFIG.MIN_UP_BARS) * 0.05);
  const cleanBonus = SNIPER_CONFIG.MAX_RUG_PULL_SCORE > 0
    ? Math.max(0, (SNIPER_CONFIG.MAX_RUG_PULL_SCORE - listing.rugPullScore) * 0.05)
    : 0;
  const confidence = Math.max(0.4, Math.min(0.85,
    0.50 + volBonus + upBonus + cleanBonus,
  ));

  const ageHours = ageMs / (60 * 60 * 1000);

  return {
    ticker,
    passed: true,
    compositeScore: confidence * 100,
    confidence,
    signals: {
      ...signals,
      sniper_age_hours: ageHours,
      sniper_rug_score: listing.rugPullScore,
      sniper_up_bars: upBars,
    },
    regime: 'NEW_LISTING' as never,
    reason: `SNIPER age=${ageHours.toFixed(1)}h, RSI=${rsi.toFixed(0)}, vol=${volRatio.toFixed(1)}x, up=${upBars}/5, rug=${listing.rugPullScore}`,
  };
}
