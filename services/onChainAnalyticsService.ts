/**
 * On-Chain Analytics Service
 *
 * Provides on-chain metrics proxy using market data:
 * - Whale activity detection (large transactions)
 * - Exchange flow proxies (inflow/outflow signals)
 * - Network health indicators
 * - Supply distribution signals
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================
export interface OnChainSignals {
  asset: string;
  whaleActivity: WhaleActivitySignal;
  exchangeFlow: ExchangeFlowSignal;
  networkHealth: NetworkHealthSignal;
  holderBehavior: HolderBehaviorSignal;
  overallSignal: 'STRONG_ACCUMULATION' | 'ACCUMULATION' | 'NEUTRAL' | 'DISTRIBUTION' | 'STRONG_DISTRIBUTION';
  confidence: number;
  lastUpdated: number;
}

export interface WhaleActivitySignal {
  detected: boolean;
  type: 'ACCUMULATION' | 'DISTRIBUTION' | 'MIXED' | 'NONE';
  intensity: number;           // 0-100
  recentLargeTxCount: number;  // Proxy from volume spikes
  avgTxSize: number;           // Relative to normal
  implication: string;
}

export interface ExchangeFlowSignal {
  netFlow: 'INFLOW' | 'OUTFLOW' | 'BALANCED';
  flowIntensity: number;       // 0-100
  sellPressureRisk: number;    // 0-100 (high inflow = high sell risk)
  accumulationSignal: number;  // 0-100 (high outflow = accumulation)
  implication: string;
}

export interface NetworkHealthSignal {
  activityLevel: 'VERY_HIGH' | 'HIGH' | 'NORMAL' | 'LOW' | 'VERY_LOW';
  activityScore: number;       // 0-100
  trendVsPrice: 'DIVERGING_BULLISH' | 'DIVERGING_BEARISH' | 'CONFIRMING' | 'NEUTRAL';
  implication: string;
}

export interface HolderBehaviorSignal {
  shortTermHolderPnL: 'PROFIT' | 'LOSS' | 'BREAKEVEN';
  pnlExtreme: boolean;         // Extreme profit (FOMO) or loss (capitulation)
  distributionRisk: number;    // 0-100
  capitulationSignal: boolean;
  implication: string;
}

// ============================================
// CONSTANTS
// ============================================
const WHALE_VOLUME_THRESHOLD = 2.5;  // 2.5x average = potential whale
const LARGE_CANDLE_THRESHOLD = 2.0;  // 2x average range = large move

// ============================================
// WHALE ACTIVITY DETECTION
// ============================================

/**
 * Detect whale activity from volume and price patterns
 */
export function detectWhaleActivity(candles: Candle[]): WhaleActivitySignal {
  if (candles.length < 30) {
    return {
      detected: false,
      type: 'NONE',
      intensity: 0,
      recentLargeTxCount: 0,
      avgTxSize: 1,
      implication: 'Insufficient data'
    };
  }

  const recent = candles.slice(-30);
  const veryRecent = candles.slice(-10);

  // Calculate average volume
  const avgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;

  // Count "large transactions" (volume spikes)
  const largeVolumes = veryRecent.filter(c => c.volume > avgVolume * WHALE_VOLUME_THRESHOLD);
  const recentLargeTxCount = largeVolumes.length;

  // Calculate average "transaction size"
  const recentAvgVolume = veryRecent.reduce((sum, c) => sum + c.volume, 0) / veryRecent.length;
  const avgTxSize = avgVolume > 0 ? recentAvgVolume / avgVolume : 1;

  if (recentLargeTxCount === 0) {
    return {
      detected: false,
      type: 'NONE',
      intensity: 0,
      recentLargeTxCount: 0,
      avgTxSize,
      implication: 'No significant whale activity detected'
    };
  }

  // Determine whale type from price action during large volumes
  let bullishLargeCandles = 0;
  let bearishLargeCandles = 0;

  for (const candle of largeVolumes) {
    if (candle.close > candle.open) {
      bullishLargeCandles++;
    } else {
      bearishLargeCandles++;
    }
  }

  let type: WhaleActivitySignal['type'];
  let implication: string;

  if (bullishLargeCandles > bearishLargeCandles * 1.5) {
    type = 'ACCUMULATION';
    implication = 'Whales appear to be accumulating - bullish for momentum/breakout';
  } else if (bearishLargeCandles > bullishLargeCandles * 1.5) {
    type = 'DISTRIBUTION';
    implication = 'Whales appear to be distributing - caution on long entries';
  } else {
    type = 'MIXED';
    implication = 'Mixed whale activity - watch for direction confirmation';
  }

  const intensity = Math.min(100, recentLargeTxCount * 20 + (avgTxSize - 1) * 30);

  return {
    detected: true,
    type,
    intensity,
    recentLargeTxCount,
    avgTxSize,
    implication
  };
}

// ============================================
// EXCHANGE FLOW PROXY
// ============================================

/**
 * Estimate exchange inflow/outflow from price-volume patterns
 * High volume + price drop = likely inflows (selling)
 * High volume + price rise = likely outflows (buying/accumulation)
 */
export function estimateExchangeFlow(candles: Candle[]): ExchangeFlowSignal {
  if (candles.length < 20) {
    return {
      netFlow: 'BALANCED',
      flowIntensity: 0,
      sellPressureRisk: 50,
      accumulationSignal: 50,
      implication: 'Insufficient data'
    };
  }

  const recent = candles.slice(-20);

  // Calculate money flow
  let inflowScore = 0;
  let outflowScore = 0;

  for (const candle of recent) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const moneyFlow = typicalPrice * candle.volume;

    if (candle.close < candle.open) {
      // Bearish candle = inflow proxy (selling to exchanges)
      inflowScore += moneyFlow;
    } else {
      // Bullish candle = outflow proxy (buying from exchanges)
      outflowScore += moneyFlow;
    }
  }

  const totalFlow = inflowScore + outflowScore;
  const netFlowRatio = totalFlow > 0 ? (outflowScore - inflowScore) / totalFlow : 0;

  let netFlow: ExchangeFlowSignal['netFlow'];
  let implication: string;

  if (netFlowRatio > 0.15) {
    netFlow = 'OUTFLOW';
    implication = 'Net outflows suggest accumulation - bullish';
  } else if (netFlowRatio < -0.15) {
    netFlow = 'INFLOW';
    implication = 'Net inflows suggest sell pressure - bearish short-term';
  } else {
    netFlow = 'BALANCED';
    implication = 'Balanced flows - no strong directional signal';
  }

  const flowIntensity = Math.min(100, Math.abs(netFlowRatio) * 200);
  const sellPressureRisk = netFlow === 'INFLOW' ? Math.min(100, 50 + flowIntensity / 2) : Math.max(0, 50 - flowIntensity / 2);
  const accumulationSignal = netFlow === 'OUTFLOW' ? Math.min(100, 50 + flowIntensity / 2) : Math.max(0, 50 - flowIntensity / 2);

  return {
    netFlow,
    flowIntensity,
    sellPressureRisk,
    accumulationSignal,
    implication
  };
}

// ============================================
// NETWORK HEALTH PROXY
// ============================================

/**
 * Estimate network activity from trading volume patterns
 */
export function estimateNetworkHealth(candles: Candle[]): NetworkHealthSignal {
  if (candles.length < 50) {
    return {
      activityLevel: 'NORMAL',
      activityScore: 50,
      trendVsPrice: 'NEUTRAL',
      implication: 'Insufficient data'
    };
  }

  const longTerm = candles.slice(-50);
  const shortTerm = candles.slice(-10);

  // Volume as activity proxy
  const longTermAvgVolume = longTerm.reduce((sum, c) => sum + c.volume, 0) / longTerm.length;
  const shortTermAvgVolume = shortTerm.reduce((sum, c) => sum + c.volume, 0) / shortTerm.length;

  const activityRatio = longTermAvgVolume > 0 ? shortTermAvgVolume / longTermAvgVolume : 1;

  let activityLevel: NetworkHealthSignal['activityLevel'];
  let activityScore: number;

  if (activityRatio > 2) {
    activityLevel = 'VERY_HIGH';
    activityScore = 90;
  } else if (activityRatio > 1.3) {
    activityLevel = 'HIGH';
    activityScore = 70;
  } else if (activityRatio > 0.7) {
    activityLevel = 'NORMAL';
    activityScore = 50;
  } else if (activityRatio > 0.4) {
    activityLevel = 'LOW';
    activityScore = 30;
  } else {
    activityLevel = 'VERY_LOW';
    activityScore = 10;
  }

  // Check activity vs price divergence
  const priceChange = (shortTerm[shortTerm.length - 1].close - longTerm[0].close) / longTerm[0].close;
  const volumeChange = activityRatio - 1;

  let trendVsPrice: NetworkHealthSignal['trendVsPrice'];
  let implication: string;

  if (volumeChange > 0.3 && priceChange < -0.02) {
    trendVsPrice = 'DIVERGING_BULLISH';
    implication = 'Rising activity with falling price - potential reversal';
  } else if (volumeChange < -0.3 && priceChange > 0.02) {
    trendVsPrice = 'DIVERGING_BEARISH';
    implication = 'Falling activity with rising price - weak rally';
  } else if (Math.sign(volumeChange) === Math.sign(priceChange)) {
    trendVsPrice = 'CONFIRMING';
    implication = 'Activity confirms price direction';
  } else {
    trendVsPrice = 'NEUTRAL';
    implication = 'No clear activity-price relationship';
  }

  return {
    activityLevel,
    activityScore,
    trendVsPrice,
    implication
  };
}

// ============================================
// HOLDER BEHAVIOR ANALYSIS
// ============================================

/**
 * Estimate short-term holder P&L from recent price action
 */
export function analyzeHolderBehavior(candles: Candle[]): HolderBehaviorSignal {
  if (candles.length < 30) {
    return {
      shortTermHolderPnL: 'BREAKEVEN',
      pnlExtreme: false,
      distributionRisk: 50,
      capitulationSignal: false,
      implication: 'Insufficient data'
    };
  }

  // Assume "short-term holders" bought in last 7-14 candles
  const shortTermEntry = candles.slice(-20, -10);
  const avgEntryPrice = shortTermEntry.reduce((sum, c) => sum + c.close, 0) / shortTermEntry.length;
  const currentPrice = candles[candles.length - 1].close;

  const pnlPercent = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;

  let shortTermHolderPnL: HolderBehaviorSignal['shortTermHolderPnL'];
  let pnlExtreme = false;
  let implication: string;

  if (pnlPercent > 3) {
    shortTermHolderPnL = 'PROFIT';
    if (pnlPercent > 10) {
      pnlExtreme = true;
      implication = 'Extreme profit - FOMO potential but also distribution risk';
    } else {
      implication = 'Short-term holders in profit - healthy trend';
    }
  } else if (pnlPercent < -3) {
    shortTermHolderPnL = 'LOSS';
    if (pnlPercent < -10) {
      pnlExtreme = true;
      implication = 'Extreme loss - capitulation possible (contrarian opportunity)';
    } else {
      implication = 'Short-term holders underwater - selling pressure possible';
    }
  } else {
    shortTermHolderPnL = 'BREAKEVEN';
    implication = 'Short-term holders near breakeven - low pressure either way';
  }

  const distributionRisk = shortTermHolderPnL === 'PROFIT'
    ? Math.min(100, 40 + pnlPercent * 3)
    : Math.max(0, 40 - Math.abs(pnlPercent) * 2);

  const capitulationSignal = shortTermHolderPnL === 'LOSS' && pnlExtreme;

  return {
    shortTermHolderPnL,
    pnlExtreme,
    distributionRisk,
    capitulationSignal,
    implication
  };
}

// ============================================
// COMBINED ON-CHAIN ANALYSIS
// ============================================

/**
 * Calculate all on-chain signals for an asset
 */
export function calculateOnChainSignals(candles: Candle[], asset: string): OnChainSignals {
  const whaleActivity = detectWhaleActivity(candles);
  const exchangeFlow = estimateExchangeFlow(candles);
  const networkHealth = estimateNetworkHealth(candles);
  const holderBehavior = analyzeHolderBehavior(candles);

  // Calculate overall signal
  let score = 0;

  // Whale activity contribution
  if (whaleActivity.type === 'ACCUMULATION') score += 25;
  else if (whaleActivity.type === 'DISTRIBUTION') score -= 25;

  // Exchange flow contribution
  if (exchangeFlow.netFlow === 'OUTFLOW') score += 20;
  else if (exchangeFlow.netFlow === 'INFLOW') score -= 20;

  // Network health contribution
  if (networkHealth.trendVsPrice === 'DIVERGING_BULLISH') score += 15;
  else if (networkHealth.trendVsPrice === 'DIVERGING_BEARISH') score -= 15;
  else if (networkHealth.trendVsPrice === 'CONFIRMING' && networkHealth.activityScore > 60) score += 10;

  // Holder behavior contribution
  if (holderBehavior.capitulationSignal) score += 20;  // Contrarian
  else if (holderBehavior.distributionRisk > 70) score -= 15;

  let overallSignal: OnChainSignals['overallSignal'];
  if (score >= 40) overallSignal = 'STRONG_ACCUMULATION';
  else if (score >= 15) overallSignal = 'ACCUMULATION';
  else if (score <= -40) overallSignal = 'STRONG_DISTRIBUTION';
  else if (score <= -15) overallSignal = 'DISTRIBUTION';
  else overallSignal = 'NEUTRAL';

  // Confidence based on signal clarity
  const confidence = Math.min(100, 50 + Math.abs(score));

  return {
    asset,
    whaleActivity,
    exchangeFlow,
    networkHealth,
    holderBehavior,
    overallSignal,
    confidence,
    lastUpdated: Date.now()
  };
}

/**
 * Get on-chain based trading recommendation
 */
export function getOnChainTradingAdjustment(signals: OnChainSignals): {
  confidenceBoost: number;
  positionSizeMultiplier: number;
  riskTierRecommendation: 25 | 50 | 75 | 100;
  shouldTrade: boolean;
  reason: string;
} {
  const { overallSignal, whaleActivity, exchangeFlow, holderBehavior, confidence } = signals;

  let confidenceBoost = 0;
  let positionSizeMultiplier = 1;
  let riskTierRecommendation: 25 | 50 | 75 | 100 = 50;
  let shouldTrade = true;
  const reasons: string[] = [];

  // Signal-based adjustments
  switch (overallSignal) {
    case 'STRONG_ACCUMULATION':
      confidenceBoost = 15;
      positionSizeMultiplier = 1.2;
      riskTierRecommendation = 75;
      reasons.push('Strong on-chain accumulation');
      break;
    case 'ACCUMULATION':
      confidenceBoost = 8;
      positionSizeMultiplier = 1.1;
      riskTierRecommendation = 75;
      reasons.push('On-chain accumulation signals');
      break;
    case 'DISTRIBUTION':
      confidenceBoost = -10;
      positionSizeMultiplier = 0.8;
      riskTierRecommendation = 25;
      reasons.push('Distribution signals detected');
      break;
    case 'STRONG_DISTRIBUTION':
      confidenceBoost = -20;
      positionSizeMultiplier = 0.5;
      riskTierRecommendation = 25;
      shouldTrade = false;
      reasons.push('Strong distribution - avoid longs');
      break;
  }

  // Whale activity override
  if (whaleActivity.type === 'ACCUMULATION' && whaleActivity.intensity > 70) {
    confidenceBoost += 10;
    reasons.push('High-intensity whale accumulation');
  }

  // Exchange flow warning
  if (exchangeFlow.sellPressureRisk > 80) {
    confidenceBoost -= 15;
    riskTierRecommendation = 25;
    reasons.push('High sell pressure risk from inflows');
  }

  // Capitulation opportunity
  if (holderBehavior.capitulationSignal) {
    confidenceBoost += 15;
    riskTierRecommendation = 100;
    reasons.push('Capitulation signal - contrarian opportunity');
  }

  return {
    confidenceBoost,
    positionSizeMultiplier,
    riskTierRecommendation,
    shouldTrade,
    reason: reasons.join(' | ') || 'Neutral on-chain signals'
  };
}
