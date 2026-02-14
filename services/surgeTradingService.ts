/**
 * Surge Trading Service
 *
 * Detects rapid price movements, candlestick patterns, dip-buying opportunities,
 * and trend surges to capitalize on sudden market moves.
 *
 * Designed for maximum trade frequency and fast reaction to price action.
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface CandlestickPattern {
  name: string;
  type: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;     // 0-100
  description: string;
}

export interface SurgeSignal {
  detected: boolean;
  type: 'SURGE_UP' | 'SURGE_DOWN' | 'DIP_BUY' | 'SPIKE_SELL' | 'TREND_RIDE' | 'NONE';
  strength: number;           // 0-100
  priceChangePercent: number; // How much price moved
  volumeRatio: number;        // Current vs average volume
  reason: string;
  confidence: number;         // 0-100
  urgency: 'IMMEDIATE' | 'SOON' | 'WATCH';
}

export interface TrendAnalysis {
  direction: 'STRONG_UP' | 'UP' | 'SIDEWAYS' | 'DOWN' | 'STRONG_DOWN';
  strength: number;        // 0-100
  momentum: number;        // -100 to +100
  acceleration: number;    // Rate of momentum change
  trendAge: number;        // How many candles in this trend
  isBreakout: boolean;     // Just broke out of range
  nearSupport: boolean;    // Price near support (dip buy zone)
  nearResistance: boolean; // Price near resistance
}

export interface DipBuySignal {
  isDip: boolean;
  dipPercent: number;       // How far price dropped
  recoveryStarted: boolean; // Price starting to bounce
  volumeConfirmed: boolean; // High volume on recovery
  strength: number;         // 0-100
  entryScore: number;       // Overall dip-buy quality
}

// ============================================
// CANDLESTICK PATTERN DETECTION
// ============================================

/**
 * Detect all candlestick patterns on the most recent candles
 */
export function detectCandlestickPatterns(candles: Candle[]): CandlestickPattern[] {
  if (candles.length < 5) return [];

  const patterns: CandlestickPattern[] = [];
  const len = candles.length;
  const c = candles[len - 1]; // Current candle
  const p = candles[len - 2]; // Previous candle
  const pp = candles[len - 3]; // Two candles ago

  const bodySize = Math.abs(c.close - c.open);
  const totalRange = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isBullish = c.close > c.open;
  const isBearish = c.close < c.open;

  const pBodySize = Math.abs(p.close - p.open);
  const pIsBullish = p.close > p.open;
  const pIsBearish = p.close < p.open;

  // Average body size for comparison
  const recentBodies = candles.slice(-10).map(x => Math.abs(x.close - x.open));
  const avgBody = recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length;

  // 1. HAMMER (bullish reversal) - small body at top, long lower wick
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && totalRange > 0) {
    const strength = Math.min(100, (lowerWick / totalRange) * 100);
    patterns.push({
      name: 'HAMMER',
      type: 'BULLISH',
      strength,
      description: 'Long lower wick, potential reversal up'
    });
  }

  // 2. INVERTED HAMMER (bullish after downtrend)
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && pIsBearish) {
    patterns.push({
      name: 'INVERTED_HAMMER',
      type: 'BULLISH',
      strength: Math.min(85, (upperWick / totalRange) * 80),
      description: 'Inverted hammer after decline'
    });
  }

  // 3. BULLISH ENGULFING - current candle body engulfs previous
  if (isBullish && pIsBearish && c.close > p.open && c.open < p.close && bodySize > pBodySize) {
    const engulfRatio = bodySize / Math.max(pBodySize, 0.001);
    patterns.push({
      name: 'BULLISH_ENGULFING',
      type: 'BULLISH',
      strength: Math.min(95, engulfRatio * 40),
      description: 'Bullish candle engulfs bearish'
    });
  }

  // 4. BEARISH ENGULFING
  if (isBearish && pIsBullish && c.open > p.close && c.close < p.open && bodySize > pBodySize) {
    const engulfRatio = bodySize / Math.max(pBodySize, 0.001);
    patterns.push({
      name: 'BEARISH_ENGULFING',
      type: 'BEARISH',
      strength: Math.min(95, engulfRatio * 40),
      description: 'Bearish candle engulfs bullish'
    });
  }

  // 5. DOJI - very small body (indecision, potential reversal)
  if (bodySize < avgBody * 0.1 && totalRange > avgBody * 0.5) {
    patterns.push({
      name: 'DOJI',
      type: 'NEUTRAL',
      strength: 50,
      description: 'Indecision - potential reversal'
    });
  }

  // 6. MORNING STAR (3-candle bullish reversal)
  if (len >= 3) {
    const ppIsBearish = pp.close < pp.open;
    const pIsSmall = pBodySize < avgBody * 0.3;
    if (ppIsBearish && pIsSmall && isBullish && c.close > (pp.open + pp.close) / 2) {
      patterns.push({
        name: 'MORNING_STAR',
        type: 'BULLISH',
        strength: 90,
        description: 'Three-candle bullish reversal'
      });
    }
  }

  // 7. EVENING STAR (3-candle bearish reversal)
  if (len >= 3) {
    const ppIsBullish = pp.close > pp.open;
    const pIsSmall = pBodySize < avgBody * 0.3;
    if (ppIsBullish && pIsSmall && isBearish && c.close < (pp.open + pp.close) / 2) {
      patterns.push({
        name: 'EVENING_STAR',
        type: 'BEARISH',
        strength: 90,
        description: 'Three-candle bearish reversal'
      });
    }
  }

  // 8. THREE WHITE SOLDIERS (strong bullish continuation)
  if (len >= 3) {
    const all3Bullish = candles.slice(-3).every(x => x.close > x.open);
    const increasing = c.close > p.close && p.close > pp.close;
    if (all3Bullish && increasing) {
      patterns.push({
        name: 'THREE_WHITE_SOLDIERS',
        type: 'BULLISH',
        strength: 85,
        description: 'Three consecutive bullish candles'
      });
    }
  }

  // 9. THREE BLACK CROWS (strong bearish continuation)
  if (len >= 3) {
    const all3Bearish = candles.slice(-3).every(x => x.close < x.open);
    const decreasing = c.close < p.close && p.close < pp.close;
    if (all3Bearish && decreasing) {
      patterns.push({
        name: 'THREE_BLACK_CROWS',
        type: 'BEARISH',
        strength: 85,
        description: 'Three consecutive bearish candles'
      });
    }
  }

  // 10. MARUBOZU (strong conviction candle - no/tiny wicks)
  if (bodySize > avgBody * 1.5 && upperWick < bodySize * 0.1 && lowerWick < bodySize * 0.1) {
    patterns.push({
      name: 'MARUBOZU',
      type: isBullish ? 'BULLISH' : 'BEARISH',
      strength: 80,
      description: `Strong ${isBullish ? 'bullish' : 'bearish'} conviction`
    });
  }

  // 11. PIERCING LINE (bullish) - opens below prev low, closes above prev midpoint
  if (isBullish && pIsBearish && c.open < p.low && c.close > (p.open + p.close) / 2) {
    patterns.push({
      name: 'PIERCING_LINE',
      type: 'BULLISH',
      strength: 75,
      description: 'Opens low, closes above prior midpoint'
    });
  }

  // 12. SPINNING TOP - small body with long wicks both sides
  if (bodySize < avgBody * 0.3 && upperWick > bodySize && lowerWick > bodySize) {
    patterns.push({
      name: 'SPINNING_TOP',
      type: 'NEUTRAL',
      strength: 40,
      description: 'Indecision with long wicks'
    });
  }

  return patterns;
}

// ============================================
// SURGE / SPIKE DETECTION
// ============================================

/**
 * Detect rapid price surges and sudden moves
 */
export function detectSurge(candles: Candle[]): SurgeSignal {
  const noSignal: SurgeSignal = {
    detected: false,
    type: 'NONE',
    strength: 0,
    priceChangePercent: 0,
    volumeRatio: 1,
    reason: 'No surge detected',
    confidence: 0,
    urgency: 'WATCH'
  };

  if (candles.length < 10) return noSignal;

  const len = candles.length;
  const current = candles[len - 1];
  const prev = candles[len - 2];
  const price = current.close;

  // Calculate various price changes
  const change1 = ((price - prev.close) / prev.close) * 100;
  const change3 = ((price - candles[len - 4].close) / candles[len - 4].close) * 100;
  const change5 = ((price - candles[len - 6].close) / candles[len - 6].close) * 100;
  const change10 = len > 10 ? ((price - candles[len - 11].close) / candles[len - 11].close) * 100 : 0;

  // Volume analysis
  const recentVolumes = candles.slice(-20).map(c => c.volume);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const currentVolume = current.volume;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // Price velocity (rate of change acceleration)
  const velocity1 = change1;
  const velocity3 = change3 / 3;
  const acceleration = velocity1 - velocity3;

  // --- FLASH CRASH DIP BUY: Rapid drop with recovery sign (HIGHEST PRIORITY) ---
  if (change3 < -1.0 && volumeRatio > 1.2) {
    const recoverySign = change1 > 0 || (change1 > change3 / 3);
    if (recoverySign) {
      const strength = Math.min(100, Math.abs(change3) * 25 + volumeRatio * 15);
      return {
        detected: true,
        type: 'DIP_BUY',
        strength,
        priceChangePercent: change3,
        volumeRatio,
        reason: `Flash crash dip: ${change3.toFixed(2)}% in 3 candles, recovery starting`,
        confidence: Math.min(95, strength * 0.8),
        urgency: 'IMMEDIATE'
      };
    }
  }

  // --- MODERATE DIP BUY: -0.5%+ drop with bounce ---
  if (change3 < -0.5 && change1 > 0 && volumeRatio > 1.0) {
    const strength = Math.min(100, Math.abs(change3) * 20 + volumeRatio * 10);
    return {
      detected: true,
      type: 'DIP_BUY',
      strength,
      priceChangePercent: change3,
      volumeRatio,
      reason: `Dip bounce: ${change3.toFixed(2)}% drop, now recovering +${change1.toFixed(2)}%`,
      confidence: Math.min(85, strength * 0.7),
      urgency: 'SOON'
    };
  }

  // --- DIP BUY: Price dropped then recovering (V-shape) ---
  // Look for V-shape: price dropped, now bouncing
  const recentLow = Math.min(...candles.slice(-5).map(c => c.low));
  const recentHigh = Math.max(...candles.slice(-10, -3).map(c => c.high));
  const dipPercent = ((recentHigh - recentLow) / recentHigh) * 100;
  const recoveryPercent = ((price - recentLow) / recentLow) * 100;
  const isDipping = dipPercent > 0.5 && recoveryPercent > dipPercent * 0.3;

  if (isDipping && change1 > 0 && price > prev.close) {
    const strength = Math.min(100, dipPercent * 15 + recoveryPercent * 20 + (volumeRatio > 1.2 ? 20 : 0));
    return {
      detected: true,
      type: 'DIP_BUY',
      strength,
      priceChangePercent: recoveryPercent,
      volumeRatio,
      reason: `Dip buy: dropped ${dipPercent.toFixed(2)}%, recovering +${recoveryPercent.toFixed(2)}%`,
      confidence: Math.min(90, strength * 0.75),
      urgency: recoveryPercent > dipPercent * 0.5 ? 'IMMEDIATE' : 'SOON'
    };
  }

  // --- TREND RIDE: Consistent upward movement (with overbought filter) ---
  const upCandles14 = candles.slice(-14).filter(c => c.close > c.open).length;
  const isOverboughtSurge = upCandles14 >= 10;

  if (change5 > 0.3 && change3 > 0.15 && change1 > 0 && !isOverboughtSurge) {
    const consistency = (change1 > 0 ? 1 : 0) + (change3 > 0 ? 1 : 0) + (change5 > 0 ? 1 : 0);
    if (consistency >= 3) {
      const strength = Math.min(100, change5 * 15 + consistency * 15 + (volumeRatio > 1 ? 15 : 0));
      return {
        detected: true,
        type: 'TREND_RIDE',
        strength,
        priceChangePercent: change5,
        volumeRatio,
        reason: `Trend ride: +${change5.toFixed(2)}% over 5 candles, consistent upward`,
        confidence: Math.min(85, strength * 0.7),
        urgency: 'SOON'
      };
    }
  }

  // --- SURGE DOWN: Rapid drop (potential short or avoid) ---
  if (change1 < -0.5 && volumeRatio > 1.5) {
    const strength = Math.min(100, Math.abs(change1) * 25 + volumeRatio * 15);
    return {
      detected: true,
      type: 'SURGE_DOWN',
      strength,
      priceChangePercent: change1,
      volumeRatio,
      reason: `Sharp drop: ${change1.toFixed(2)}% with ${volumeRatio.toFixed(1)}x volume`,
      confidence: Math.min(90, strength * 0.7),
      urgency: 'IMMEDIATE'
    };
  }

  return noSignal;
}

// ============================================
// DIP BUYING ANALYSIS
// ============================================

/**
 * Analyze if current price is a good dip-buying opportunity
 */
export function analyzeDipBuy(candles: Candle[]): DipBuySignal {
  const noDip: DipBuySignal = {
    isDip: false,
    dipPercent: 0,
    recoveryStarted: false,
    volumeConfirmed: false,
    strength: 0,
    entryScore: 0
  };

  if (candles.length < 20) return noDip;

  const len = candles.length;
  const price = candles[len - 1].close;
  const prevPrice = candles[len - 2].close;

  // Find recent high (last 20 candles)
  const recentHighPrice = Math.max(...candles.slice(-20).map(c => c.high));
  const dipFromHigh = ((recentHighPrice - price) / recentHighPrice) * 100;

  // Find recent low (last 5 candles)
  const recentLowPrice = Math.min(...candles.slice(-5).map(c => c.low));
  const bounceFromLow = ((price - recentLowPrice) / recentLowPrice) * 100;

  // Volume analysis
  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const recentVolume = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const volumeConfirmed = recentVolume > avgVolume * 1.2;

  // Recovery started = price bouncing from low
  const recoveryStarted = price > prevPrice && price > recentLowPrice * 1.001;

  // RSI proxy: count how many of last 14 candles were down
  const downCandles = candles.slice(-14).filter(c => c.close < c.open).length;
  const oversold = downCandles >= 9; // 9+ of 14 candles bearish = oversold

  // Score the dip opportunity
  let entryScore = 0;
  if (dipFromHigh > 1) entryScore += Math.min(30, dipFromHigh * 8);  // Deeper dip = better
  if (recoveryStarted) entryScore += 25;
  if (volumeConfirmed) entryScore += 20;
  if (oversold) entryScore += 15;
  if (bounceFromLow > 0.1) entryScore += 10;

  const isDip = dipFromHigh > 0.5 && entryScore > 30;

  return {
    isDip,
    dipPercent: dipFromHigh,
    recoveryStarted,
    volumeConfirmed,
    strength: Math.min(100, entryScore),
    entryScore: Math.min(100, entryScore)
  };
}

// ============================================
// TREND ANALYSIS (FAST)
// ============================================

/**
 * Fast trend analysis for quick decisions
 * Uses simple moving averages and price action
 */
export function analyzeTrend(candles: Candle[]): TrendAnalysis {
  const defaultTrend: TrendAnalysis = {
    direction: 'SIDEWAYS',
    strength: 0,
    momentum: 0,
    acceleration: 0,
    trendAge: 0,
    isBreakout: false,
    nearSupport: false,
    nearResistance: false
  };

  if (candles.length < 20) return defaultTrend;

  const len = candles.length;
  const closes = candles.map(c => c.close);
  const price = closes[len - 1];

  // Fast EMA (5-period) vs Slow EMA (20-period)
  const ema5 = simpleEMA(closes, 5);
  const ema20 = simpleEMA(closes, 20);
  const ema5Current = ema5[ema5.length - 1];
  const ema20Current = ema20[ema20.length - 1];
  const ema5Prev = ema5[ema5.length - 3] || ema5Current;
  const ema20Prev = ema20[ema20.length - 3] || ema20Current;

  // Momentum: rate of price change
  const momentum3 = ((price - closes[len - 4]) / closes[len - 4]) * 100;
  const momentum5 = ((price - closes[len - 6]) / closes[len - 6]) * 100;
  const momentum10 = len > 10 ? ((price - closes[len - 11]) / closes[len - 11]) * 100 : 0;

  // Acceleration: change in momentum
  const prevMomentum3 = ((closes[len - 2] - closes[len - 5]) / closes[len - 5]) * 100;
  const acceleration = momentum3 - prevMomentum3;

  // Trend direction
  const aboveEma5 = price > ema5Current;
  const aboveEma20 = price > ema20Current;
  const ema5Rising = ema5Current > ema5Prev;
  const ema20Rising = ema20Current > ema20Prev;
  const emaCrossUp = ema5Current > ema20Current && ema5Prev <= ema20Prev;

  let direction: TrendAnalysis['direction'];
  let strength = 0;

  if (aboveEma5 && aboveEma20 && ema5Rising && ema20Rising && momentum5 > 0.5) {
    direction = 'STRONG_UP';
    strength = Math.min(100, 60 + Math.abs(momentum5) * 10);
  } else if (aboveEma5 && ema5Rising && momentum3 > 0) {
    direction = 'UP';
    strength = Math.min(80, 40 + Math.abs(momentum3) * 15);
  } else if (!aboveEma5 && !aboveEma20 && !ema5Rising && !ema20Rising && momentum5 < -0.5) {
    direction = 'STRONG_DOWN';
    strength = Math.min(100, 60 + Math.abs(momentum5) * 10);
  } else if (!aboveEma5 && !ema5Rising && momentum3 < 0) {
    direction = 'DOWN';
    strength = Math.min(80, 40 + Math.abs(momentum3) * 15);
  } else {
    direction = 'SIDEWAYS';
    strength = 20;
  }

  // Trend age: how many consecutive candles in this direction
  let trendAge = 0;
  const isUp = direction === 'UP' || direction === 'STRONG_UP';
  for (let i = len - 1; i > Math.max(0, len - 30); i--) {
    if (isUp ? closes[i] >= closes[i - 1] : closes[i] <= closes[i - 1]) {
      trendAge++;
    } else {
      break;
    }
  }

  // Breakout detection: price just crossed above recent range
  const rangeHigh = Math.max(...candles.slice(-20, -1).map(c => c.high));
  const rangeLow = Math.min(...candles.slice(-20, -1).map(c => c.low));
  const isBreakout = price > rangeHigh || emaCrossUp;

  // Support/resistance proximity
  const nearSupport = (price - rangeLow) / rangeLow < 0.01; // Within 1% of support
  const nearResistance = (rangeHigh - price) / rangeHigh < 0.01;

  // Momentum as -100 to +100
  const normalizedMomentum = Math.max(-100, Math.min(100, momentum5 * 20));

  return {
    direction,
    strength,
    momentum: normalizedMomentum,
    acceleration,
    trendAge,
    isBreakout,
    nearSupport,
    nearResistance
  };
}

// ============================================
// COMBINED SURGE TRADING DECISION
// ============================================

export interface SurgeTradingDecision {
  shouldTrade: boolean;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;   // 0-100
  reason: string;
  strategy: 'SURGE' | 'DIP_BUY' | 'TREND_RIDE' | 'PATTERN' | 'BREAKOUT_SURGE';
  positionSizeMultiplier: number;  // 0.5-2.0
  urgency: 'IMMEDIATE' | 'SOON' | 'WATCH';
  patterns: CandlestickPattern[];
  surge: SurgeSignal;
  trend: TrendAnalysis;
  dip: DipBuySignal;
}

/**
 * Master decision function - combines all surge trading signals
 * Prioritizes: 1) Active surges 2) Dip buys 3) Trend rides 4) Pattern signals
 */
export function getSurgeTradingDecision(candles: Candle[]): SurgeTradingDecision {
  const patterns = detectCandlestickPatterns(candles);
  const surge = detectSurge(candles);
  const trend = analyzeTrend(candles);
  const dip = analyzeDipBuy(candles);

  const noTrade: SurgeTradingDecision = {
    shouldTrade: false,
    action: 'HOLD',
    confidence: 0,
    reason: 'No surge opportunity',
    strategy: 'SURGE',
    positionSizeMultiplier: 1,
    urgency: 'WATCH',
    patterns,
    surge,
    trend,
    dip
  };

  if (candles.length < 10) return noTrade;

  const bullishPatterns = patterns.filter(p => p.type === 'BULLISH');
  const bearishPatterns = patterns.filter(p => p.type === 'BEARISH');
  const patternScore = bullishPatterns.reduce((s, p) => s + p.strength, 0) -
                       bearishPatterns.reduce((s, p) => s + p.strength, 0);

  // Priority 1: DIP BUY - from surge detection or dip analysis
  if (surge.detected && surge.type === 'DIP_BUY' && surge.confidence > 40) {
    const trendBoost = trend.direction !== 'STRONG_DOWN' ? 10 : -20;
    const patternBoost = bullishPatterns.length > 0 ? 15 : 0;
    const confidence = Math.min(95, surge.confidence + trendBoost + patternBoost);

    return {
      shouldTrade: true,
      action: 'BUY',
      confidence,
      reason: `${surge.reason} | Trend: ${trend.direction} | Patterns: ${bullishPatterns.map(p => p.name).join(',')}`,
      strategy: 'DIP_BUY',
      positionSizeMultiplier: Math.min(1.8, 1 + Math.abs(surge.priceChangePercent) / 5),
      urgency: surge.urgency,
      patterns,
      surge,
      trend,
      dip
    };
  }

  // Priority 1b: DIP BUY from dip analysis
  if (dip.isDip && dip.entryScore > 40 && dip.recoveryStarted) {
    const trendBoost = trend.direction !== 'STRONG_DOWN' ? 10 : -20;
    const patternBoost = bullishPatterns.length > 0 ? 15 : 0;
    const confidence = Math.min(95, dip.entryScore + trendBoost + patternBoost);

    if (confidence > 35) {
      return {
        shouldTrade: true,
        action: 'BUY',
        confidence,
        reason: `Dip buy: ${dip.dipPercent.toFixed(2)}% drop, recovery started | Vol: ${dip.volumeConfirmed ? 'confirmed' : 'low'} | Patterns: ${bullishPatterns.map(p => p.name).join(',')}`,
        strategy: 'DIP_BUY',
        positionSizeMultiplier: Math.min(1.8, 1 + dip.dipPercent / 5),
        urgency: dip.volumeConfirmed ? 'IMMEDIATE' : 'SOON',
        patterns,
        surge,
        trend,
        dip
      };
    }
  }

  // Priority 2: TREND RIDE - consistent upward movement (with overbought filter)
  const upCandles14Decision = candles.slice(-14).filter(c => c.close > c.open).length;
  const isOverboughtDecision = upCandles14Decision >= 10;

  if ((trend.direction === 'STRONG_UP' || trend.direction === 'UP') && trend.strength > 40 && !isOverboughtDecision) {
    const surgeBoost = surge.type === 'TREND_RIDE' ? 15 : 0;
    const patternBoost = patternScore > 0 ? Math.min(10, patternScore / 5) : 0;
    const breakoutBoost = trend.isBreakout ? 20 : 0;
    const confidence = Math.min(95, trend.strength * 0.7 + surgeBoost + patternBoost + breakoutBoost);

    if (confidence > 35) {
      return {
        shouldTrade: true,
        action: 'BUY',
        confidence,
        reason: `Trend ride: ${trend.direction} (str=${trend.strength}) ${trend.isBreakout ? '+ BREAKOUT' : ''} | Mom: ${trend.momentum.toFixed(1)}`,
        strategy: trend.isBreakout ? 'BREAKOUT_SURGE' : 'TREND_RIDE',
        positionSizeMultiplier: trend.direction === 'STRONG_UP' ? 1.5 : 1.2,
        urgency: trend.isBreakout ? 'IMMEDIATE' : 'SOON',
        patterns,
        surge,
        trend,
        dip
      };
    }
  }

  // Priority 4: STRONG PATTERN SIGNALS alone
  if (bullishPatterns.length >= 2 && patternScore > 100) {
    const confidence = Math.min(80, patternScore / 3 + (trend.direction !== 'STRONG_DOWN' ? 15 : 0));
    if (confidence > 35) {
      return {
        shouldTrade: true,
        action: 'BUY',
        confidence,
        reason: `Pattern signal: ${bullishPatterns.map(p => p.name).join(' + ')} (score=${patternScore})`,
        strategy: 'PATTERN',
        positionSizeMultiplier: 1.1,
        urgency: 'SOON',
        patterns,
        surge,
        trend,
        dip
      };
    }
  }

  // Priority 5: Single strong bullish pattern with trend support
  if (bullishPatterns.length === 1 && bullishPatterns[0].strength >= 75 &&
      (trend.direction === 'UP' || trend.direction === 'STRONG_UP' || trend.direction === 'SIDEWAYS')) {
    const confidence = Math.min(75, bullishPatterns[0].strength * 0.6 + trend.strength * 0.2);
    if (confidence > 35) {
      return {
        shouldTrade: true,
        action: 'BUY',
        confidence,
        reason: `${bullishPatterns[0].name} pattern (${bullishPatterns[0].strength}) + ${trend.direction} trend`,
        strategy: 'PATTERN',
        positionSizeMultiplier: 1,
        urgency: 'SOON',
        patterns,
        surge,
        trend,
        dip
      };
    }
  }

  return noTrade;
}

// ============================================
// HELPER: Simple EMA calculation
// ============================================
function simpleEMA(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}
