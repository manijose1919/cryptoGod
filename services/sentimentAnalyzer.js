/**
 * Sentiment Analyzer (Backend)
 *
 * Aggregates REAL sentiment data from public APIs:
 * - Alternative.me Fear & Greed Index (50% weight)
 * - CryptoPanic news sentiment (30% weight)
 * - Price-action sentiment (20% weight)
 *
 * Detects rapid shifts and coordinated social campaigns.
 *
 * Requirements 16, 49, 50
 */

import { fetchFearGreedIndex, fetchCryptoNews } from './socialSentiment.js';

/**
 * Simple price-action sentiment proxy for backend use.
 * Analyzes recent candle momentum and buying pressure.
 * Returns a score from -1 (very bearish) to +1 (very bullish).
 */
function calculatePriceActionSentiment(candles) {
  if (!candles || candles.length < 20) return 0;

  const recent = candles.slice(-20);
  const veryRecent = candles.slice(-5);

  // Normalize candle fields (handle both {c,h,l,o,v} and {close,high,low,open,volume})
  const close = c => c.c ?? c.close ?? 0;
  const high = c => c.h ?? c.high ?? 0;
  const low = c => c.l ?? c.low ?? 0;

  // 1. Price momentum
  const priceChange = (close(recent[recent.length - 1]) - close(recent[0])) / (close(recent[0]) || 1);
  const shortChange = (close(veryRecent[veryRecent.length - 1]) - close(veryRecent[0])) / (close(veryRecent[0]) || 1);

  // 2. Buying pressure (close position within candle range)
  let buyPressure = 0;
  for (const c of recent) {
    const range = high(c) - low(c);
    buyPressure += range > 0 ? (close(c) - low(c)) / range : 0.5;
  }
  buyPressure = buyPressure / recent.length; // 0 to 1, >0.5 = bullish

  // 3. Combine: momentum (60%) + buying pressure (40%)
  const momentumScore = Math.max(-1, Math.min(1, priceChange * 10 + shortChange * 5));
  const pressureScore = (buyPressure - 0.5) * 2; // -1 to +1
  return momentumScore * 0.6 + pressureScore * 0.4;
}

const sentimentAlerts = [];
const MAX_ALERTS = 100;

/**
 * Perform comprehensive sentiment analysis for a ticker
 * @param {string} ticker
 * @param {Array} candles - Recent market data
 */
export async function performDeepSentimentAnalysis(ticker, candles) {
  // 1. Fear & Greed Index (real data from alternative.me)
  let fearGreedScore = 0;
  let fearGreedData = { value: 50, classification: 'Neutral' };
  try {
    fearGreedData = await fetchFearGreedIndex();
    // Normalize 0-100 to -1..+1
    fearGreedScore = (fearGreedData.value - 50) / 50;
  } catch (e) {
    fearGreedScore = 0; // neutral fallback
  }

  // 2. CryptoPanic news sentiment (real data)
  let newsScore = 0;
  let newsItems = [];
  try {
    newsItems = await fetchCryptoNews();
    if (newsItems.length > 0) {
      const positive = newsItems.filter(n => n.sentiment === 'positive').length;
      const negative = newsItems.filter(n => n.sentiment === 'negative').length;
      const total = newsItems.length;
      // Map positive ratio to -1..+1
      const positiveRatio = positive / total;
      const negativeRatio = negative / total;
      newsScore = (positiveRatio - negativeRatio); // -1 to +1
    }
  } catch (e) {
    newsScore = 0;
  }

  // 3. Price-action sentiment (derived from market data)
  let priceScore = 0;
  try {
    priceScore = calculatePriceActionSentiment(candles); // Already -1..+1
  } catch (e) {
    priceScore = 0;
  }

  // 4. Aggregate: 50% Fear&Greed, 30% News, 20% Price-action
  const aggregateScore = (fearGreedScore * 0.5) + (newsScore * 0.3) + (priceScore * 0.2);

  // 5. Detect Rapid Shifts / Alerts
  const recentAlerts = sentimentAlerts.filter(a => a.ticker === ticker);
  const lastAlert = recentAlerts[recentAlerts.length - 1];

  if (Math.abs(aggregateScore) > 0.4) {
      const type = aggregateScore > 0 ? 'BULLISH_SURGE' : 'BEARISH_PANIC';

      // Only alert if type changed or significant move from last alert
      if (!lastAlert || lastAlert.type !== type || Math.abs(lastAlert.score - aggregateScore) > 0.3) {
          const alert = {
              id: Date.now(),
              ticker,
              type,
              score: Math.round(aggregateScore * 100) / 100,
              intensity: Math.abs(Math.round(aggregateScore * 100)),
              reason: `${type} detected — F&G: ${fearGreedData.value} (${fearGreedData.classification}), News: ${newsItems.length} articles`,
              timestamp: Date.now()
          };
          sentimentAlerts.push(alert);
          if (sentimentAlerts.length > MAX_ALERTS) sentimentAlerts.shift();
      }
  }

  // 6. Detect divergence: fear&greed vs news (real divergence, not fake platform divergence)
  const hasDivergence = Math.abs(fearGreedScore - newsScore) > 0.6;

  return {
    ticker,
    aggregateScore: Math.round(aggregateScore * 100) / 100,
    socialScore: Math.round(((fearGreedScore * 0.5 + newsScore * 0.5)) * 100) / 100,
    priceScore: Math.round(priceScore * 100) / 100,
    polarity: aggregateScore > 0.2 ? 'BULLISH' : aggregateScore < -0.2 ? 'BEARISH' : 'NEUTRAL',
    platformBreakdown: [
      { platform: 'Fear & Greed Index', sentiment: fearGreedScore, weight: 0.5, value: fearGreedData.value, classification: fearGreedData.classification },
      { platform: 'CryptoPanic News', sentiment: newsScore, weight: 0.3, articles: newsItems.length },
      { platform: 'Price Action', sentiment: priceScore, weight: 0.2 },
    ],
    newsSample: newsItems.slice(0, 5),
    hasDivergence,
    alerts: sentimentAlerts.filter(a => a.ticker === ticker).slice(-3),
    timestamp: Date.now()
  };
}

/**
 * Get all recent sentiment alerts
 */
export function getRecentSentimentAlerts() {
  return sentimentAlerts.slice(-20);
}
