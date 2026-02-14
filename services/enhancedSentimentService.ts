/**
 * Enhanced Sentiment Analysis Service
 *
 * Unified sentiment engine with multiple integration patterns:
 * - Filter/veto trades based on sentiment
 * - Confirmation/weighting for signals
 * - Trigger-based micro-trade bursts
 * - Regime shift detection
 */

import type { TradingStrategy } from '../types';

// ============================================
// TYPES
// ============================================
export interface SentimentSignal {
  asset: string;
  polarity: 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';
  score: number;              // -100 to +100
  intensity: number;          // 0-100 (emotionality/strength)
  socialVolume: number;       // Relative volume (0-100)
  trendDirection: 'RISING' | 'FALLING' | 'STABLE';
  deltaShort: number;         // Change in last 15-30 min
  deltaMedium: number;        // Change in last 1-2 hours
  fearGreedProxy: number;     // 0 (extreme fear) to 100 (extreme greed)
  lastUpdated: number;
}

export interface SentimentBurst {
  detected: boolean;
  asset: string;
  burstType: 'HYPE_SPIKE' | 'PANIC_SPIKE' | 'VOLUME_SURGE' | 'SENTIMENT_FLIP';
  magnitude: number;          // How significant (0-100)
  correlatedAssets: string[]; // Other assets likely affected
  recommendedAction: 'MICRO_TRADE_LONG' | 'MICRO_TRADE_SHORT' | 'AVOID' | 'WATCH';
}

export interface SentimentRegime {
  marketWide: 'EUPHORIA' | 'GREED' | 'NEUTRAL' | 'FEAR' | 'CAPITULATION';
  riskRecommendation: 25 | 50 | 75 | 100; // Suggested allocation %
  divergenceFromPrice: 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'ALIGNED';
  regimeShiftProbability: number; // 0-100
}

export type SentimentIntegrationMode =
  | 'FILTER_VETO'      // Skip trades if sentiment bad
  | 'CONFIRMATION'     // Boost confidence when aligned
  | 'FULL_FEATURE'     // Use as ML input
  | 'TRIGGER_BASED';   // Activate micro-trades on bursts

// ============================================
// SENTIMENT HISTORY (for delta calculations)
// ============================================
interface SentimentHistory {
  timestamps: number[];
  scores: number[];
  volumes: number[];
}

const sentimentHistory: Record<string, SentimentHistory> = {};
const MAX_HISTORY_POINTS = 120; // 2 hours at 1-min intervals

// ============================================
// SENTIMENT CALCULATION
// ============================================

/**
 * Calculate sentiment from price action and volume (proxy when no API)
 * This uses market microstructure as a sentiment proxy
 */
export function calculateSentimentFromMarketData(
  candles: { open: number; high: number; low: number; close: number; volume: number; time: number }[],
  asset: string
): SentimentSignal {
  if (candles.length < 20) {
    return getDefaultSentiment(asset);
  }

  // Initialize history if needed
  if (!sentimentHistory[asset]) {
    sentimentHistory[asset] = { timestamps: [], scores: [], volumes: [] };
  }

  const recent = candles.slice(-20);
  const veryRecent = candles.slice(-5);

  // 1. Price momentum sentiment
  const priceChange = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close) * 100;
  const shortPriceChange = ((veryRecent[veryRecent.length - 1].close - veryRecent[0].close) / veryRecent[0].close) * 100;

  // 2. Volume analysis (high volume = high interest/sentiment)
  const avgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
  const recentVolume = veryRecent.reduce((sum, c) => sum + c.volume, 0) / veryRecent.length;
  const volumeRatio = avgVolume > 0 ? (recentVolume / avgVolume) * 100 : 50;

  // 3. Buying vs selling pressure (close position in range)
  const buyingPressure = recent.map(c => {
    const range = c.high - c.low;
    if (range === 0) return 0.5;
    return (c.close - c.low) / range;
  });
  const avgBuyingPressure = buyingPressure.reduce((a, b) => a + b, 0) / buyingPressure.length;

  // 4. Candle body analysis (bullish vs bearish candles)
  const bullishCandles = recent.filter(c => c.close > c.open).length;
  const bullishRatio = bullishCandles / recent.length;

  // Combine into sentiment score (-100 to +100)
  let score = 0;
  score += priceChange * 5;  // Weight price momentum
  score += (avgBuyingPressure - 0.5) * 60;  // Weight buying pressure
  score += (bullishRatio - 0.5) * 40;  // Weight candle direction
  score += (volumeRatio > 120 ? 10 : volumeRatio < 80 ? -10 : 0);  // Volume confirmation

  score = Math.max(-100, Math.min(100, score));

  // Calculate intensity (how strong is the conviction)
  const intensity = Math.min(100, Math.abs(score) + (volumeRatio > 100 ? 20 : 0));

  // Social volume proxy (based on actual trading volume)
  const socialVolume = Math.min(100, volumeRatio);

  // Determine polarity
  let polarity: SentimentSignal['polarity'];
  if (score >= 50) polarity = 'VERY_BULLISH';
  else if (score >= 20) polarity = 'BULLISH';
  else if (score <= -50) polarity = 'VERY_BEARISH';
  else if (score <= -20) polarity = 'BEARISH';
  else polarity = 'NEUTRAL';

  // Calculate deltas from history
  const history = sentimentHistory[asset];
  const now = Date.now();

  // Add current reading to history
  history.timestamps.push(now);
  history.scores.push(score);
  history.volumes.push(socialVolume);

  // Trim old history
  while (history.timestamps.length > MAX_HISTORY_POINTS) {
    history.timestamps.shift();
    history.scores.shift();
    history.volumes.shift();
  }

  // Calculate deltas
  let deltaShort = 0;
  let deltaMedium = 0;

  const thirtyMinAgo = now - 30 * 60 * 1000;
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  const shortIdx = history.timestamps.findIndex(t => t >= thirtyMinAgo);
  const mediumIdx = history.timestamps.findIndex(t => t >= twoHoursAgo);

  if (shortIdx >= 0 && history.scores[shortIdx] !== undefined) {
    deltaShort = score - history.scores[shortIdx];
  }
  if (mediumIdx >= 0 && history.scores[mediumIdx] !== undefined) {
    deltaMedium = score - history.scores[mediumIdx];
  }

  // Trend direction
  let trendDirection: SentimentSignal['trendDirection'];
  if (deltaShort > 10) trendDirection = 'RISING';
  else if (deltaShort < -10) trendDirection = 'FALLING';
  else trendDirection = 'STABLE';

  // Fear/Greed proxy (0-100)
  const fearGreedProxy = Math.round((score + 100) / 2);

  return {
    asset,
    polarity,
    score: Math.round(score),
    intensity: Math.round(intensity),
    socialVolume: Math.round(socialVolume),
    trendDirection,
    deltaShort: Math.round(deltaShort),
    deltaMedium: Math.round(deltaMedium),
    fearGreedProxy,
    lastUpdated: now
  };
}

/**
 * Default sentiment when insufficient data
 */
function getDefaultSentiment(asset: string): SentimentSignal {
  return {
    asset,
    polarity: 'NEUTRAL',
    score: 0,
    intensity: 0,
    socialVolume: 50,
    trendDirection: 'STABLE',
    deltaShort: 0,
    deltaMedium: 0,
    fearGreedProxy: 50,
    lastUpdated: Date.now()
  };
}

// ============================================
// SENTIMENT BURST DETECTION
// ============================================

/**
 * Detect sentiment bursts that might trigger micro-trade clusters
 */
export function detectSentimentBurst(
  currentSentiment: SentimentSignal,
  correlatedAssets: string[] = []
): SentimentBurst {
  const { deltaShort, deltaMedium, socialVolume, score, asset } = currentSentiment;

  // Check for various burst types
  let burstType: SentimentBurst['burstType'] | null = null;
  let magnitude = 0;

  // Hype spike: Rapid positive sentiment increase with volume
  if (deltaShort > 20 && socialVolume > 70 && score > 30) {
    burstType = 'HYPE_SPIKE';
    magnitude = Math.min(100, deltaShort + socialVolume / 2);
  }
  // Panic spike: Rapid negative sentiment drop with volume
  else if (deltaShort < -20 && socialVolume > 70 && score < -30) {
    burstType = 'PANIC_SPIKE';
    magnitude = Math.min(100, Math.abs(deltaShort) + socialVolume / 2);
  }
  // Volume surge: Sudden volume increase (potential breakout)
  else if (socialVolume > 150) {
    burstType = 'VOLUME_SURGE';
    magnitude = Math.min(100, socialVolume - 50);
  }
  // Sentiment flip: Direction change
  else if (Math.abs(deltaMedium) > 40 && Math.sign(deltaShort) !== Math.sign(deltaMedium - deltaShort)) {
    burstType = 'SENTIMENT_FLIP';
    magnitude = Math.min(100, Math.abs(deltaMedium));
  }

  if (!burstType) {
    return {
      detected: false,
      asset,
      burstType: 'HYPE_SPIKE',
      magnitude: 0,
      correlatedAssets: [],
      recommendedAction: 'WATCH'
    };
  }

  // Determine recommended action
  let recommendedAction: SentimentBurst['recommendedAction'];
  if (burstType === 'HYPE_SPIKE' && magnitude > 50) {
    recommendedAction = 'MICRO_TRADE_LONG';
  } else if (burstType === 'PANIC_SPIKE' && magnitude > 50) {
    recommendedAction = 'MICRO_TRADE_SHORT';
  } else if (burstType === 'SENTIMENT_FLIP') {
    recommendedAction = 'WATCH';
  } else if (magnitude < 30) {
    recommendedAction = 'WATCH';
  } else {
    recommendedAction = score > 0 ? 'MICRO_TRADE_LONG' : 'AVOID';
  }

  return {
    detected: true,
    asset,
    burstType,
    magnitude,
    correlatedAssets,
    recommendedAction
  };
}

// ============================================
// SENTIMENT REGIME DETECTION
// ============================================

/**
 * Detect market-wide sentiment regime
 */
export function detectSentimentRegime(
  sentimentSignals: SentimentSignal[],
  priceChange24h: number = 0
): SentimentRegime {
  if (sentimentSignals.length === 0) {
    return {
      marketWide: 'NEUTRAL',
      riskRecommendation: 50,
      divergenceFromPrice: 'ALIGNED',
      regimeShiftProbability: 0
    };
  }

  // Calculate market-wide sentiment
  const avgScore = sentimentSignals.reduce((sum, s) => sum + s.score, 0) / sentimentSignals.length;
  const avgFearGreed = sentimentSignals.reduce((sum, s) => sum + s.fearGreedProxy, 0) / sentimentSignals.length;

  // Determine regime
  let marketWide: SentimentRegime['marketWide'];
  let riskRecommendation: SentimentRegime['riskRecommendation'];

  if (avgFearGreed >= 80) {
    marketWide = 'EUPHORIA';
    riskRecommendation = 25;  // Cap risk during euphoria (likely top)
  } else if (avgFearGreed >= 60) {
    marketWide = 'GREED';
    riskRecommendation = 50;
  } else if (avgFearGreed >= 40) {
    marketWide = 'NEUTRAL';
    riskRecommendation = 75;
  } else if (avgFearGreed >= 20) {
    marketWide = 'FEAR';
    riskRecommendation = 75;  // Fear = opportunity
  } else {
    marketWide = 'CAPITULATION';
    riskRecommendation = 100;  // Extreme fear = max opportunity
  }

  // Check for divergence
  let divergenceFromPrice: SentimentRegime['divergenceFromPrice'];
  if (priceChange24h < -5 && avgScore > 20) {
    divergenceFromPrice = 'BULLISH_DIVERGENCE';  // Price down but sentiment up
  } else if (priceChange24h > 5 && avgScore < -20) {
    divergenceFromPrice = 'BEARISH_DIVERGENCE';  // Price up but sentiment down
  } else {
    divergenceFromPrice = 'ALIGNED';
  }

  // Regime shift probability
  const avgDeltaShort = sentimentSignals.reduce((sum, s) => sum + Math.abs(s.deltaShort), 0) / sentimentSignals.length;
  const regimeShiftProbability = Math.min(100, avgDeltaShort * 2);

  return {
    marketWide,
    riskRecommendation,
    divergenceFromPrice,
    regimeShiftProbability
  };
}

// ============================================
// SENTIMENT INTEGRATION FUNCTIONS
// ============================================

/**
 * Apply sentiment as trade filter/veto
 * Returns whether trade should proceed
 */
export function applySentimentFilter(
  sentiment: SentimentSignal,
  tradeDirection: 'LONG' | 'SHORT',
  minSentimentScore: number = -30
): { proceed: boolean; reason: string } {
  // For LONG trades, require non-negative sentiment (or at least not too bearish)
  if (tradeDirection === 'LONG') {
    if (sentiment.score < minSentimentScore) {
      return {
        proceed: false,
        reason: `Sentiment too bearish (${sentiment.score}) for LONG entry`
      };
    }
    if (sentiment.polarity === 'VERY_BEARISH') {
      return {
        proceed: false,
        reason: 'VERY_BEARISH sentiment vetoes LONG trade'
      };
    }
  }

  // For SHORT trades (if supported), require non-positive sentiment
  if (tradeDirection === 'SHORT') {
    if (sentiment.score > -minSentimentScore) {
      return {
        proceed: false,
        reason: `Sentiment too bullish (${sentiment.score}) for SHORT entry`
      };
    }
  }

  return { proceed: true, reason: 'Sentiment filter passed' };
}

/**
 * Calculate confidence boost/reduction from sentiment
 */
export function calculateSentimentConfidenceAdjustment(
  sentiment: SentimentSignal,
  strategy: TradingStrategy
): { adjustment: number; reason: string } {
  let adjustment = 0;
  const reasons: string[] = [];

  // Base adjustment from sentiment alignment
  if (sentiment.score > 30) {
    adjustment += 10;
    reasons.push(`Bullish sentiment (+10)`);
  } else if (sentiment.score < -30) {
    adjustment -= 10;
    reasons.push(`Bearish sentiment (-10)`);
  }

  // Rising sentiment bonus
  if (sentiment.trendDirection === 'RISING' && sentiment.deltaShort > 15) {
    adjustment += 8;
    reasons.push(`Rising sentiment (+8)`);
  } else if (sentiment.trendDirection === 'FALLING' && sentiment.deltaShort < -15) {
    adjustment -= 8;
    reasons.push(`Falling sentiment (-8)`);
  }

  // High volume/intensity confirmation
  if (sentiment.intensity > 70 && sentiment.socialVolume > 80) {
    adjustment += 5;
    reasons.push(`High conviction (+5)`);
  }

  // Strategy-specific adjustments
  switch (strategy) {
    case 'MOMENTUM':
    case 'BREAKOUT':
      // These strategies benefit more from sentiment
      adjustment = Math.round(adjustment * 1.3);
      break;
    case 'DIVERGENCE':
      // Divergence might trade against sentiment
      adjustment = Math.round(adjustment * 0.5);
      break;
    case 'WHALE':
      // Whale doesn't rely much on retail sentiment
      adjustment = Math.round(adjustment * 0.7);
      break;
  }

  return {
    adjustment: Math.max(-25, Math.min(25, adjustment)),
    reason: reasons.join(', ') || 'No significant sentiment impact'
  };
}

/**
 * Get correlated meme assets for burst trading
 */
export function getCorrelatedMemeAssets(asset: string): string[] {
  const memeGroups: Record<string, string[]> = {
    // Dog coins
    'DOGEUSD': ['SHIBUSD', 'FLOKIUSD', 'BONKUSD'],
    'SHIBUSD': ['DOGEUSD', 'FLOKIUSD', 'BONKUSD'],
    'FLOKIUSD': ['DOGEUSD', 'SHIBUSD', 'BONKUSD'],
    'BONKUSD': ['DOGEUSD', 'SHIBUSD', 'FLOKIUSD'],
    // Solana memes
    'SOLUSD': ['BONKUSD', 'WIFUSD'],
    'WIFUSD': ['BONKUSD', 'SOLUSD'],
    // Major correlations
    'BTCUSD': ['ETHUSD'],
    'ETHUSD': ['BTCUSD', 'SOLUSD']
  };

  return memeGroups[asset] || [];
}

/**
 * Clear sentiment history (for session reset)
 */
export function clearSentimentHistory(): void {
  Object.keys(sentimentHistory).forEach(key => delete sentimentHistory[key]);
}
