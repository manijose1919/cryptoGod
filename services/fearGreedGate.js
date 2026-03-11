/**
 * Fear & Greed Gate — Macro sentiment position sizing filter.
 *
 * Uses the free Alternative.me Fear & Greed Index to scale position sizes.
 * Extreme Fear (<25) → increase size 1.5x (historically best buy signal)
 * Neutral (25-75) → normal sizing
 * Extreme Greed (>75) → reduce size to 0.5x (historically worst time to buy)
 *
 * Also provides a binary gate: block new entries during extreme greed + high funding.
 */

import fetch from 'node-fetch';

// ─── State ───────────────────────────────────────────────────

let currentIndex = 50;          // Default neutral
let currentClassification = 'Neutral';
let lastFetchTime = 0;
const FETCH_INTERVAL_MS = 30 * 60 * 1000; // Refresh every 30 minutes (index updates daily)
const API_URL = 'https://api.alternative.me/fng/?limit=2';

// Historical values for trend detection
let previousIndex = 50;
let indexTrend = 0; // positive = moving toward greed, negative = moving toward fear

// ─── Fetch ───────────────────────────────────────────────────

async function fetchFearGreedIndex() {
  try {
    const resp = await fetch(API_URL, { timeout: 5000 });
    if (!resp.ok) return;
    const data = await resp.json();

    if (data?.data?.[0]) {
      previousIndex = currentIndex;
      currentIndex = Math.max(0, Math.min(100, parseInt(data.data[0].value) || 50));
      currentClassification = data.data[0].value_classification;
      indexTrend = currentIndex - previousIndex;
      lastFetchTime = Date.now();

      // Get yesterday's value for trend
      if (data.data[1]) {
        const yesterday = parseInt(data.data[1].value);
        indexTrend = currentIndex - yesterday;
      }

      console.log(`[FearGreedGate] Index: ${currentIndex} (${currentClassification}), trend: ${indexTrend > 0 ? '+' : ''}${indexTrend}`);
    }
  } catch (err) {
    console.warn('[FearGreedGate] Fetch failed:', err.message);
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Initialize and start periodic polling.
 */
export function initFearGreedGate() {
  fetchFearGreedIndex(); // Initial fetch
  setInterval(fetchFearGreedIndex, FETCH_INTERVAL_MS);
  console.log('[FearGreedGate] Initialized (refreshes every 30min)');
}

/**
 * Get the position size multiplier based on Fear & Greed.
 *
 * Extreme Fear (0-10):  1.8x — maximum conviction buys
 * Fear (10-25):         1.5x — strong buy zone
 * Mild Fear (25-40):    1.2x — slightly larger positions
 * Neutral (40-60):      1.0x — normal sizing
 * Mild Greed (60-75):   0.8x — slightly smaller
 * Greed (75-90):        0.5x — half size
 * Extreme Greed (90+):  0.3x — minimal exposure
 */
export function getPositionMultiplier() {
  if (currentIndex <= 10) return 1.8;
  if (currentIndex <= 25) return 1.5;
  if (currentIndex <= 40) return 1.2;
  if (currentIndex <= 60) return 1.0;
  if (currentIndex <= 75) return 0.8;
  if (currentIndex <= 90) return 0.5;
  return 0.3;
}

/**
 * Check if the Fear & Greed gate blocks new long entries.
 * Only blocks during extreme greed (>85) + greed trending up.
 */
export function shouldBlockEntry() {
  if (currentIndex > 85 && indexTrend > 0) {
    return {
      block: true,
      reason: `Extreme Greed: ${currentIndex} (${currentClassification}), trending up +${indexTrend}`,
    };
  }
  return { block: false, reason: '' };
}

/**
 * Get the current status for API/dashboard.
 */
export function getFearGreedStatus() {
  return {
    index: currentIndex,
    classification: currentClassification,
    trend: indexTrend,
    positionMultiplier: getPositionMultiplier(),
    isBlocking: shouldBlockEntry().block,
    lastFetchTime,
    nextFetch: lastFetchTime + FETCH_INTERVAL_MS,
  };
}

/**
 * Get the raw index value.
 */
export function getFearGreedIndex() {
  return currentIndex;
}

export default {
  initFearGreedGate,
  getPositionMultiplier,
  shouldBlockEntry,
  getFearGreedStatus,
  getFearGreedIndex,
};
