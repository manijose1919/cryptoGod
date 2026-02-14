/**
 * Predictive Engine (Backend)
 *
 * Forecasts market movements using technical, on-chain, and sentiment signals.
 * Provides confidence scores and time horizons.
 *
 * Requirements 34, Property 27
 */

import { calculateTCSeries, calculateTrendDashboard, calculateMomentumSeries, detectMarketRegime } from '../server-indicator-service.js';
import * as SentimentService from './sentimentService.js';
import { getOnChainSignals } from './onChainBackend.js';

/**
 * Predict market movement for a given ticker
 * @param {Array} candles - Historical candle data
 * @param {string} ticker - Asset ticker
 * @returns {Object} Prediction result
 */
export function predictMovement(candles, ticker) {
  if (!candles || candles.length < 50) {
    return { ticker, direction: 'SIDEWAYS', confidence: 0, horizons: { '1h': 'SIDEWAYS' }, reason: 'Insufficient data' };
  }

  const regime = detectMarketRegime(candles);
  const tcValue = calculateTCSeries(candles).pop() ?? 50;
  const confluence = calculateTrendDashboard(candles);
  const momentum = calculateMomentumSeries(candles).pop() ?? 50;
  const onChain = getOnChainSignals(candles, ticker);
  const sentiment = SentimentService.calculateSentimentFromMarketData(candles, ticker);

  // Simple weighted prediction model
  let score = 0; // -100 to 100

  // Regime weight (30%)
  if (regime.trend === 'STRONG_UP') score += 30;
  else if (regime.trend === 'UP') score += 15;
  else if (regime.trend === 'DOWN') score -= 15;
  else if (regime.trend === 'STRONG_DOWN') score -= 30;

  // TC Value weight (20%) - TC is 0-100, 50 neutral, < 50 bullish, > 50 bearish
  score += (50 - tcValue) * 0.4;

  // Momentum weight (20%) - 0-100, > 50 bullish
  score += (momentum - 50) * 0.4;

  // On-chain weight (15%)
  if (onChain.overallSignal === 'STRONG_ACCUMULATION') score += 15;
  else if (onChain.overallSignal === 'ACCUMULATION') score += 7;
  else if (onChain.overallSignal === 'DISTRIBUTION') score -= 7;
  else if (onChain.overallSignal === 'STRONG_DISTRIBUTION') score -= 15;

  // Sentiment weight (15%)
  score += (sentiment.score || 0) * 15;

  const confidence = Math.abs(score);
  const direction = score > 15 ? 'UP' : score < -15 ? 'DOWN' : 'SIDEWAYS';

  // Support/Resistance from key levels
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const resistance = Math.max(...highs.slice(-20));
  const support = Math.min(...lows.slice(-20));

  return {
    ticker,
    direction,
    confidence: Math.round(Math.min(100, confidence)),
    horizons: {
      '1h': { direction, confidence: Math.round(Math.min(100, confidence)) },
      '4h': { direction, confidence: Math.round(Math.min(100, confidence * 0.85)) },
      '24h': { direction, confidence: Math.round(Math.min(100, confidence * 0.7)) }
    },
    levels: { support, resistance },
    regime: regime.trend,
    factors: [
      { name: 'Regime', impact: Math.round(regime.trend === 'STRONG_UP' ? 30 : regime.trend === 'UP' ? 15 : regime.trend.includes('DOWN') ? -15 : 0) },
      { name: 'On-Chain', impact: Math.round(onChain.overallSignal.includes('ACCUMULATION') ? 15 : onChain.overallSignal.includes('DISTRIBUTION') ? -15 : 0) },
      { name: 'Sentiment', impact: Math.round((sentiment.score || 0) * 15) }
    ],
    timestamp: Date.now()
  };
}

/**
 * Get market expectations summary for all active tickers
 */
export function getMarketExpectations(marketDataMap) {
  const expectations = {};
  for (const [ticker, candles] of marketDataMap.entries()) {
    expectations[ticker] = predictMovement(candles, ticker);
  }
  return expectations;
}
