/**
 * On-Chain Analytics Backend Service
 *
 * Ported from onChainAnalyticsService.ts for backend use.
 * Provides on-chain metrics proxy using market data:
 * - Whale activity detection
 * - Exchange flow proxies
 * - Network health indicators
 * - Holder behavior analysis
 *
 * All functions receive candle arrays with shorthand keys:
 *   { c: close, o: open, h: high, l: low, v: volume, t: timestamp }
 */

// ============================================
// CONSTANTS
// ============================================
const WHALE_VOLUME_THRESHOLD = 2.5;

// ============================================
// WHALE ACTIVITY DETECTION
// ============================================

/**
 * Detect whale activity from volume and price patterns
 * @param {Array} candles
 * @returns {{ detected, type, intensity, recentLargeTxCount, avgTxSize, implication }}
 */
export function analyzeWhaleActivity(candles) {
  if (candles.length < 30) {
    return {
      detected: false, type: 'NONE', intensity: 0,
      recentLargeTxCount: 0, avgTxSize: 1,
      implication: 'Insufficient data'
    };
  }

  const recent = candles.slice(-30);
  const veryRecent = candles.slice(-10);

  const avgVolume = recent.reduce((sum, c) => sum + c.v, 0) / recent.length;
  const largeVolumes = veryRecent.filter(c => c.v > avgVolume * WHALE_VOLUME_THRESHOLD);
  const recentLargeTxCount = largeVolumes.length;

  const recentAvgVolume = veryRecent.reduce((sum, c) => sum + c.v, 0) / veryRecent.length;
  const avgTxSize = avgVolume > 0 ? recentAvgVolume / avgVolume : 1;

  if (recentLargeTxCount === 0) {
    return {
      detected: false, type: 'NONE', intensity: 0,
      recentLargeTxCount: 0, avgTxSize,
      implication: 'No significant whale activity detected'
    };
  }

  let bullishLargeCandles = 0;
  let bearishLargeCandles = 0;

  for (const candle of largeVolumes) {
    if (candle.c > candle.o) bullishLargeCandles++;
    else bearishLargeCandles++;
  }

  let type, implication;

  if (bullishLargeCandles > bearishLargeCandles * 1.5) {
    type = 'ACCUMULATION';
    implication = 'Whales appear to be accumulating - bullish';
  } else if (bearishLargeCandles > bullishLargeCandles * 1.5) {
    type = 'DISTRIBUTION';
    implication = 'Whales appear to be distributing - caution on longs';
  } else {
    type = 'MIXED';
    implication = 'Mixed whale activity - watch for direction';
  }

  const intensity = Math.min(100, recentLargeTxCount * 20 + (avgTxSize - 1) * 30);

  return { detected: true, type, intensity, recentLargeTxCount, avgTxSize, implication };
}

// ============================================
// EXCHANGE FLOW PROXY
// ============================================

/**
 * Estimate exchange inflow/outflow from price-volume patterns
 * @param {Array} candles
 * @returns {{ netFlow, flowIntensity, sellPressureRisk, accumulationSignal, implication }}
 */
export function analyzeExchangeFlow(candles) {
  if (candles.length < 20) {
    return {
      netFlow: 'BALANCED', flowIntensity: 0,
      sellPressureRisk: 50, accumulationSignal: 50,
      implication: 'Insufficient data'
    };
  }

  const recent = candles.slice(-20);
  let inflowScore = 0;
  let outflowScore = 0;

  for (const candle of recent) {
    const typicalPrice = (candle.h + candle.l + candle.c) / 3;
    const moneyFlow = typicalPrice * candle.v;

    if (candle.c < candle.o) {
      inflowScore += moneyFlow;
    } else {
      outflowScore += moneyFlow;
    }
  }

  const totalFlow = inflowScore + outflowScore;
  const netFlowRatio = totalFlow > 0 ? (outflowScore - inflowScore) / totalFlow : 0;

  let netFlow, implication;

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

  return { netFlow, flowIntensity, sellPressureRisk, accumulationSignal, implication };
}

// ============================================
// NETWORK HEALTH PROXY
// ============================================

/**
 * Estimate network activity from trading volume patterns
 * @param {Array} candles
 * @returns {{ activityLevel, activityScore, trendVsPrice, implication }}
 */
export function analyzeNetworkHealth(candles) {
  if (candles.length < 50) {
    return {
      activityLevel: 'NORMAL', activityScore: 50,
      trendVsPrice: 'NEUTRAL', implication: 'Insufficient data'
    };
  }

  const longTerm = candles.slice(-50);
  const shortTerm = candles.slice(-10);

  const longTermAvgVolume = longTerm.reduce((sum, c) => sum + c.v, 0) / longTerm.length;
  const shortTermAvgVolume = shortTerm.reduce((sum, c) => sum + c.v, 0) / shortTerm.length;
  const activityRatio = longTermAvgVolume > 0 ? shortTermAvgVolume / longTermAvgVolume : 1;

  let activityLevel, activityScore;

  if (activityRatio > 2) { activityLevel = 'VERY_HIGH'; activityScore = 90; }
  else if (activityRatio > 1.3) { activityLevel = 'HIGH'; activityScore = 70; }
  else if (activityRatio > 0.7) { activityLevel = 'NORMAL'; activityScore = 50; }
  else if (activityRatio > 0.4) { activityLevel = 'LOW'; activityScore = 30; }
  else { activityLevel = 'VERY_LOW'; activityScore = 10; }

  const priceChange = (shortTerm[shortTerm.length - 1].c - longTerm[0].c) / longTerm[0].c;
  const volumeChange = activityRatio - 1;

  let trendVsPrice, implication;

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

  return { activityLevel, activityScore, trendVsPrice, implication };
}

// ============================================
// HOLDER BEHAVIOR ANALYSIS
// ============================================

/**
 * Estimate short-term holder P&L from recent price action
 * @param {Array} candles
 * @returns {{ shortTermHolderPnL, pnlExtreme, distributionRisk, capitulationSignal, implication }}
 */
export function analyzeHolderBehavior(candles) {
  if (candles.length < 30) {
    return {
      shortTermHolderPnL: 'BREAKEVEN', pnlExtreme: false,
      distributionRisk: 50, capitulationSignal: false,
      implication: 'Insufficient data'
    };
  }

  const shortTermEntry = candles.slice(-20, -10);
  const avgEntryPrice = shortTermEntry.reduce((sum, c) => sum + c.c, 0) / shortTermEntry.length;
  const currentPrice = candles[candles.length - 1].c;
  const pnlPercent = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;

  let shortTermHolderPnL, pnlExtreme = false, implication;

  if (pnlPercent > 3) {
    shortTermHolderPnL = 'PROFIT';
    if (pnlPercent > 10) {
      pnlExtreme = true;
      implication = 'Extreme profit - FOMO but also distribution risk';
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
    implication = 'Short-term holders near breakeven';
  }

  const distributionRisk = shortTermHolderPnL === 'PROFIT'
    ? Math.min(100, 40 + pnlPercent * 3)
    : Math.max(0, 40 - Math.abs(pnlPercent) * 2);

  const capitulationSignal = shortTermHolderPnL === 'LOSS' && pnlExtreme;

  return { shortTermHolderPnL, pnlExtreme, distributionRisk, capitulationSignal, implication };
}

// ============================================
// COMBINED ON-CHAIN SIGNALS
// ============================================

/**
 * Calculate all on-chain signals for an asset
 * @param {Array} candles
 * @param {string} ticker
 * @returns {{ asset, whaleActivity, exchangeFlow, networkHealth, holderBehavior, overallSignal, confidence, lastUpdated }}
 */
export function getOnChainSignals(candles, ticker) {
  const whaleActivity = analyzeWhaleActivity(candles);
  const exchangeFlow = analyzeExchangeFlow(candles);
  const networkHealth = analyzeNetworkHealth(candles);
  const holderBehavior = analyzeHolderBehavior(candles);

  let score = 0;

  if (whaleActivity.type === 'ACCUMULATION') score += 25;
  else if (whaleActivity.type === 'DISTRIBUTION') score -= 25;

  if (exchangeFlow.netFlow === 'OUTFLOW') score += 20;
  else if (exchangeFlow.netFlow === 'INFLOW') score -= 20;

  if (networkHealth.trendVsPrice === 'DIVERGING_BULLISH') score += 15;
  else if (networkHealth.trendVsPrice === 'DIVERGING_BEARISH') score -= 15;
  else if (networkHealth.trendVsPrice === 'CONFIRMING' && networkHealth.activityScore > 60) score += 10;

  if (holderBehavior.capitulationSignal) score += 20;
  else if (holderBehavior.distributionRisk > 70) score -= 15;

  let overallSignal;
  if (score >= 40) overallSignal = 'STRONG_ACCUMULATION';
  else if (score >= 15) overallSignal = 'ACCUMULATION';
  else if (score <= -40) overallSignal = 'STRONG_DISTRIBUTION';
  else if (score <= -15) overallSignal = 'DISTRIBUTION';
  else overallSignal = 'NEUTRAL';

  const confidence = Math.min(100, 50 + Math.abs(score));

  return {
    asset: ticker,
    whaleActivity,
    exchangeFlow,
    networkHealth,
    holderBehavior,
    overallSignal,
    confidence,
    lastUpdated: Date.now()
  };
}
