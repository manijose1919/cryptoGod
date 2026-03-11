/**
 * Liquidation Sweep Entry Detector — Enter after cascading liquidations.
 *
 * When large liquidation cascades occur (detected via derivativesIntelligence),
 * price often overshoots and then mean-reverts. This detector identifies
 * post-liquidation entry points for contrarian trades.
 *
 * Signal: Heavy liquidation event → wait for price to stabilize → enter
 * in the opposite direction of the liquidation cascade.
 *
 * Long liquidation cascade → price drops → enter LONG (reversal)
 * Short liquidation cascade → price pumps → enter SHORT (if enabled)
 */

import { getDerivativesSignal } from './derivativesIntelligence.js';

// ─── Configuration ───────────────────────────────────────────

const MIN_LIQUIDATION_USD = 500000;  // $500K+ in 24h liquidations to trigger
const IMBALANCE_THRESHOLD = 0.6;     // 60%+ of liquidations on one side
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hour cooldown between sweep signals per ticker
const PRICE_STABILIZATION_CANDLES = 3; // Wait 3 candles after sweep before entering

// ─── State ───────────────────────────────────────────────────

const sweepEvents = new Map();  // ticker → { direction, timestamp, magnitude, ... }
const lastSignalTime = new Map(); // ticker → timestamp (cooldown tracking)

// ─── Core Detection ─────────────────────────────────────────

/**
 * Detect if a liquidation sweep just occurred for a ticker.
 * @param {string} ticker - e.g., 'BTCUSD'
 * @param {Array} recentCandles - Last 10+ candles for price stabilization check
 * @returns {{ sweep: boolean, direction: 'LONG'|'SHORT'|null, confidence: number, reason: string }}
 */
export function detectLiquidationSweep(ticker, recentCandles = []) {
  const symbol = ticker.replace(/USD[T]?$/, '');
  const signal = getDerivativesSignal(symbol);

  if (!signal) {
    return { sweep: false, direction: null, confidence: 0, reason: 'No derivatives data' };
  }

  const totalLiq = signal.longLiquidations24h + signal.shortLiquidations24h;
  if (totalLiq < MIN_LIQUIDATION_USD) {
    return { sweep: false, direction: null, confidence: 0, reason: `Liquidations too low: $${(totalLiq / 1e6).toFixed(1)}M` };
  }

  // Check cooldown
  const lastTime = lastSignalTime.get(ticker) || 0;
  if (Date.now() - lastTime < COOLDOWN_MS) {
    return { sweep: false, direction: null, confidence: 0, reason: 'Cooldown active' };
  }

  const imbalance = signal.liquidationImbalance; // (longLiq - shortLiq) / totalLiq

  // Long liquidation cascade: imbalance > threshold (longs getting wiped)
  // → Price dropped hard → enter LONG (reversal)
  if (imbalance > IMBALANCE_THRESHOLD) {
    // Check price stabilization: last N candles should show decreasing volatility
    const stabilized = checkPriceStabilization(recentCandles);

    const confidence = Math.min(95, Math.round(
      (Math.abs(imbalance) * 40) +         // Imbalance strength
      (Math.min(totalLiq, 5e6) / 5e6 * 30) + // Magnitude (capped at $5M)
      (stabilized ? 25 : 0)                  // Stabilization bonus
    ));

    const event = {
      direction: 'LONG',
      timestamp: Date.now(),
      magnitude: totalLiq,
      imbalance,
      longLiq: signal.longLiquidations24h,
      shortLiq: signal.shortLiquidations24h,
      priceStabilized: stabilized,
      confidence,
    };

    sweepEvents.set(ticker, event);
    if (stabilized) lastSignalTime.set(ticker, Date.now());

    return {
      sweep: stabilized,
      direction: 'LONG',
      confidence,
      reason: `Long liq cascade: $${(signal.longLiquidations24h / 1e6).toFixed(1)}M longs wiped (${(imbalance * 100).toFixed(0)}% imbalance)${stabilized ? ' — price stabilized' : ' — awaiting stabilization'}`,
    };
  }

  // Short liquidation cascade: imbalance < -threshold (shorts getting wiped)
  // → Price pumped hard → enter SHORT (if allowed)
  if (imbalance < -IMBALANCE_THRESHOLD) {
    const stabilized = checkPriceStabilization(recentCandles);

    const confidence = Math.min(95, Math.round(
      (Math.abs(imbalance) * 40) +
      (Math.min(totalLiq, 5e6) / 5e6 * 30) +
      (stabilized ? 25 : 0)
    ));

    const event = {
      direction: 'SHORT',
      timestamp: Date.now(),
      magnitude: totalLiq,
      imbalance,
      longLiq: signal.longLiquidations24h,
      shortLiq: signal.shortLiquidations24h,
      priceStabilized: stabilized,
      confidence,
    };

    sweepEvents.set(ticker, event);
    if (stabilized) lastSignalTime.set(ticker, Date.now());

    return {
      sweep: stabilized,
      direction: 'SHORT',
      confidence,
      reason: `Short squeeze: $${(signal.shortLiquidations24h / 1e6).toFixed(1)}M shorts wiped (${(Math.abs(imbalance) * 100).toFixed(0)}% imbalance)${stabilized ? ' — price stabilized' : ' — awaiting stabilization'}`,
    };
  }

  return { sweep: false, direction: null, confidence: 0, reason: 'No significant imbalance' };
}

/**
 * Check if price has stabilized after a liquidation event.
 * Looks for decreasing candle range (high-low) over last N candles.
 */
function checkPriceStabilization(candles) {
  if (!candles || candles.length < PRICE_STABILIZATION_CANDLES + 2) return false;

  const recent = candles.slice(-(PRICE_STABILIZATION_CANDLES + 2));
  const ranges = recent.map(c => c.c > 0 ? (c.h - c.l) / c.c : 0);

  // Check if volatility is decreasing (last 3 ranges smaller than first 2)
  const earlyAvg = (ranges[0] + ranges[1]) / 2;
  const lateAvg = ranges.slice(-PRICE_STABILIZATION_CANDLES).reduce((a, b) => a + b, 0) / PRICE_STABILIZATION_CANDLES;

  return lateAvg < earlyAvg * 0.7; // Volatility dropped by at least 30%
}

/**
 * Get recent sweep events for dashboard.
 */
export function getSweepEvents() {
  // Prune events older than 72h to prevent unbounded Map growth
  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  for (const [ticker, event] of sweepEvents) {
    if (event.timestamp < cutoff) {
      sweepEvents.delete(ticker);
      lastSignalTime.delete(ticker);
    }
  }
  const events = [];
  for (const [ticker, event] of sweepEvents) {
    events.push({ ticker, ...event });
  }
  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
}

/**
 * Get sweep status for API.
 */
export function getSweepStatus() {
  return {
    activeEvents: sweepEvents.size,
    events: getSweepEvents(),
    config: {
      minLiquidationUSD: MIN_LIQUIDATION_USD,
      imbalanceThreshold: IMBALANCE_THRESHOLD,
      cooldownMs: COOLDOWN_MS,
    },
  };
}

export default {
  detectLiquidationSweep,
  getSweepEvents,
  getSweepStatus,
};
