/**
 * Signal Aggregator (Backend)
 *
 * Combines technical, sentiment, on-chain, and order book signals
 * into unified trading recommendations.
 *
 * Requirements 3, 35
 */

import { calculateTrendDashboard, calculateOpportunityScore } from '../server-indicator-service.js';
import * as SentimentService from './sentimentService.js';
import { getOnChainSignals } from './onChainBackend.js';
import { analyzeMultiTimeframe } from './multiTimeframe.js';

/**
 * Aggregate signals for a given ticker and set of candle data
 * @param {string} ticker
 * @param {Object} candlesByTF - { '1m': [], '5m': [], '15m': [] }
 */
export function aggregateSignals(ticker, candlesByTF) {
  const candles1m = candlesByTF['1m'];
  if (!candles1m || candles1m.length < 20) return null;

  // 1. Technical Signals (40% weight)
  const technical = calculateTrendDashboard(candles1m);
  const oppScore = calculateOpportunityScore(candles1m, ticker);
  const techScore = (technical.score / 6) * 100;

  // 2. Sentiment Signals (20% weight)
  const sentiment = SentimentService.calculateSentimentFromMarketData(candles1m, ticker);
  const sentScore = ((sentiment.score || 0) + 1) * 50; // Map -1..1 to 0..100

  // 3. On-Chain Signals (20% weight)
  const onChain = getOnChainSignals(candles1m, ticker);
  let ocScore = 50;
  if (onChain.overallSignal === 'STRONG_ACCUMULATION') ocScore = 100;
  else if (onChain.overallSignal === 'ACCUMULATION') ocScore = 75;
  else if (onChain.overallSignal === 'DISTRIBUTION') ocScore = 25;
  else if (onChain.overallSignal === 'STRONG_DISTRIBUTION') ocScore = 0;

  // 4. Multi-Timeframe Alignment (20% weight)
  const mtf = analyzeMultiTimeframe(candlesByTF);
  const mtfScore = mtf.composite;

  // Weighted Average
  const unifiedScore = (techScore * 0.4) + (sentScore * 0.2) + (ocScore * 0.2) + (mtfScore * 0.2);

  let action = 'NEUTRAL';
  let urgency = 'WATCH';
  
  if (unifiedScore > 75) {
      action = 'BUY';
      urgency = 'IMMEDIATE';
  } else if (unifiedScore > 60) {
      action = 'BUY';
      urgency = 'SOON';
  } else if (unifiedScore < 25) {
      action = 'SELL';
      urgency = 'IMMEDIATE';
  } else if (unifiedScore < 40) {
      action = 'SELL';
      urgency = 'SOON';
  }

  const confidence = Math.round(Math.abs(unifiedScore - 50) * 2);

  return {
    ticker,
    action,
    urgency,
    confidence: Math.min(100, confidence),
    unifiedScore: Math.round(unifiedScore),
    components: {
      technical: Math.round(techScore),
      sentiment: Math.round(sentScore),
      onChain: Math.round(ocScore),
      mtf: Math.round(mtfScore)
    },
    reasoning: [
      `Technical score: ${Math.round(techScore)}/100`,
      `Sentiment: ${sentiment.overallSentiment} (${Math.round(sentScore)}/100)`,
      `On-Chain: ${onChain.overallSignal}`,
      `MTF Alignment: ${mtf.aligned ? 'YES' : 'NO'} (score ${Math.round(mtfScore)})`
    ],
    timestamp: Date.now()
  };
}

/**
 * Scan all available tickers and return aggregated signals
 */
export function scanMarket(marketDataMapByTicker) {
  const results = [];
  for (const [ticker, candlesByTF] of Object.entries(marketDataMapByTicker)) {
    const signal = aggregateSignals(ticker, candlesByTF);
    if (signal) results.push(signal);
  }
  return results.sort((a, b) => b.confidence - a.confidence);
}
