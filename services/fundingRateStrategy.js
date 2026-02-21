/**
 * Funding Rate Arbitrage Strategy
 * Reads derivatives data to detect funding rate extremes and generate directional bias.
 * Extreme positive funding = crowded longs (SHORT bias), extreme negative = crowded shorts (LONG bias).
 */

import { getLatestDerivatives } from './database.js';

const FUNDING_THRESHOLDS = {
  EXTREME_POSITIVE: 0.05,   // 0.05% = crowded longs → short bias
  EXTREME_NEGATIVE: -0.05,  // -0.05% = crowded shorts → long bias
  VERY_EXTREME: 0.1,        // 0.1% = very crowded → stronger signal
};

/**
 * Get funding rate signal for a ticker.
 * @param {string} ticker - e.g. 'BTCUSD'
 * @returns {{ direction: 'LONG'|'SHORT'|'NEUTRAL', strength: number, fundingRate: number, message: string }}
 */
export function getFundingRateSignal(ticker) {
  try {
    const data = getLatestDerivatives(ticker);
    if (!data || data.funding_rate == null) {
      return { direction: 'NEUTRAL', strength: 0, fundingRate: 0, message: 'No funding data available' };
    }

    const rate = data.funding_rate;
    let direction = 'NEUTRAL';
    let strength = 0;

    if (rate >= FUNDING_THRESHOLDS.VERY_EXTREME) {
      direction = 'SHORT';
      strength = 80;
    } else if (rate >= FUNDING_THRESHOLDS.EXTREME_POSITIVE) {
      direction = 'SHORT';
      strength = 50;
    } else if (rate <= -FUNDING_THRESHOLDS.VERY_EXTREME) {
      direction = 'LONG';
      strength = 80;
    } else if (rate <= FUNDING_THRESHOLDS.EXTREME_NEGATIVE) {
      direction = 'LONG';
      strength = 50;
    }

    const message = direction === 'NEUTRAL'
      ? `Funding rate ${(rate * 100).toFixed(4)}% within normal range`
      : `Funding rate ${(rate * 100).toFixed(4)}% extreme → ${direction} bias (strength: ${strength})`;

    return { direction, strength, fundingRate: rate, message, oiChange: data.oi_change_pct || 0 };
  } catch (e) {
    return { direction: 'NEUTRAL', strength: 0, fundingRate: 0, message: `Error: ${e.message}` };
  }
}

/**
 * Get confidence adjustment based on funding rate vs proposed trade direction.
 * @param {{ direction: string, strength: number }} signal - from getFundingRateSignal
 * @param {string} tradeDirection - 'LONG' or 'SHORT'
 * @returns {{ adjustment: number, reason: string }}
 */
export function getFundingConfidenceAdjustment(signal, tradeDirection = 'LONG') {
  if (signal.direction === 'NEUTRAL') {
    return { adjustment: 0, reason: 'Funding rate neutral' };
  }

  // Funding agrees with our trade → boost confidence
  if (signal.direction === tradeDirection) {
    const boost = Math.round(signal.strength * 0.15); // up to +12 points
    return { adjustment: boost, reason: `Funding rate confirms ${tradeDirection} (boost +${boost})` };
  }

  // Funding disagrees → reduce confidence
  const penalty = -Math.round(signal.strength * 0.12); // up to -10 points
  return { adjustment: penalty, reason: `Funding rate opposes ${tradeDirection} (${penalty})` };
}

/**
 * Should we block an entry based on extreme funding rate?
 * Extreme funding in the same direction as the trade = crowded, high reversion risk.
 * @param {string} ticker - e.g. 'BTCUSD'
 * @param {string} tradeDirection - 'LONG' or 'SHORT'
 * @returns {{ blocked: boolean, reason: string }}
 */
export function shouldBlockEntryOnFunding(ticker, tradeDirection = 'LONG') {
  try {
    const data = getLatestDerivatives(ticker);
    if (!data || data.funding_rate == null) {
      return { blocked: false, reason: 'No funding data' };
    }

    const rate = data.funding_rate;

    // Block LONG entries when funding is very extreme positive (crowded longs)
    if (rate >= FUNDING_THRESHOLDS.VERY_EXTREME && tradeDirection === 'LONG') {
      return { blocked: true, reason: `Funding rate ${(rate * 100).toFixed(4)}% too extreme for LONG — crowded longs, high reversion risk` };
    }

    // Block SHORT entries when funding is very extreme negative (crowded shorts)
    if (rate <= -FUNDING_THRESHOLDS.VERY_EXTREME && tradeDirection === 'SHORT') {
      return { blocked: true, reason: `Funding rate ${(rate * 100).toFixed(4)}% too extreme for SHORT — crowded shorts, high reversion risk` };
    }

    return { blocked: false, reason: 'Funding rate within acceptable range' };
  } catch (e) {
    return { blocked: false, reason: `Error checking funding: ${e.message}` };
  }
}

/**
 * Is funding rate contrarian to the current crowd?
 * Extreme funding rates are one of the most reliable mean-reversion signals.
 * @param {string} ticker
 * @returns {{ signal: 'LONG_BIAS'|'SHORT_BIAS'|null, strength: number }}
 */
export function isFundingContrarian(ticker) {
  try {
    const data = getLatestDerivatives(ticker);
    if (!data || data.funding_rate == null) {
      return { signal: null, strength: 0 };
    }

    const rate = data.funding_rate;

    if (rate >= FUNDING_THRESHOLDS.VERY_EXTREME) {
      return { signal: 'SHORT_BIAS', strength: 80 };
    } else if (rate >= FUNDING_THRESHOLDS.EXTREME_POSITIVE) {
      return { signal: 'SHORT_BIAS', strength: 50 };
    } else if (rate <= -FUNDING_THRESHOLDS.VERY_EXTREME) {
      return { signal: 'LONG_BIAS', strength: 80 };
    } else if (rate <= FUNDING_THRESHOLDS.EXTREME_NEGATIVE) {
      return { signal: 'LONG_BIAS', strength: 50 };
    }

    return { signal: null, strength: 0 };
  } catch (e) {
    return { signal: null, strength: 0 };
  }
}

export default { getFundingRateSignal, getFundingConfidenceAdjustment, shouldBlockEntryOnFunding, isFundingContrarian };
