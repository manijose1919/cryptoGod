/**
 * Sentiment Analyzer (Backend)
 *
 * Aggregates social media sentiment and price-based sentiment.
 * Detects rapid shifts and coordinated social campaigns.
 *
 * Requirements 16, 49, 50
 */

import { scrapeSocialPlatforms, calculateWeightedSentiment, analyzeNewsSources } from './socialMediaScraper.js';
import { calculateSentimentFromMarketData } from './enhancedSentimentService.js';
import { fetchCryptoNews } from './socialSentiment.js';

const sentimentAlerts = [];
const MAX_ALERTS = 100;

/**
 * Perform comprehensive sentiment analysis for a ticker
 * @param {string} ticker
 * @param {Array} candles - Recent market data
 */
export async function performDeepSentimentAnalysis(ticker, candles) {
  // 1. Get Social Sentiment (Mock + Real News)
  const socialData = await scrapeSocialPlatforms(ticker);
  const socialScore = calculateWeightedSentiment(socialData);
  
  // 1b. Get News Sources Analysis
  const newsItems = await fetchCryptoNews();
  const trendingPlatforms = analyzeNewsSources(newsItems);

  // 2. Get Price-based Sentiment (Proxy)
  const priceSentiment = calculateSentimentFromMarketData(candles, ticker);
  const priceScore = priceSentiment.score / 100; // Normalize to -1..1

  // 3. Aggregate (60% social, 40% price)
  const aggregateScore = (socialScore * 0.6) + (priceScore * 0.4);

  // 4. Detect Rapid Shifts / Alerts
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
              reason: `${type} detected across ${socialData.length} platforms.`,
              timestamp: Date.now()
          };
          sentimentAlerts.push(alert);
          if (sentimentAlerts.length > MAX_ALERTS) sentimentAlerts.shift();
      }
  }

  // 5. Detect Coordinated Campaigns (Divergence between platforms)
  const hasDivergence = socialData.length > 1 && 
      Math.max(...socialData.map(d => d.sentiment)) - Math.min(...socialData.map(d => d.sentiment)) > 0.6;

  return {
    ticker,
    aggregateScore: Math.round(aggregateScore * 100) / 100,
    socialScore: Math.round(socialScore * 100) / 100,
    priceScore: Math.round(priceScore * 100) / 100,
    polarity: aggregateScore > 0.2 ? 'BULLISH' : aggregateScore < -0.2 ? 'BEARISH' : 'NEUTRAL',
    platformBreakdown: socialData,
    trendingPlatforms,
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
