/**
 * Surge Trading Backend Service
 *
 * Ported from surgeTradingService.ts for backend use.
 * Detects rapid price movements, candlestick patterns, dip-buying opportunities,
 * and trend surges to capitalize on sudden market moves.
 *
 * All functions receive candle arrays with shorthand keys:
 *   { c: close, o: open, h: high, l: low, v: volume, t: timestamp }
 */

// ============================================
// HELPER: Simple EMA calculation
// ============================================
function simpleEMA(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ============================================
// CANDLESTICK PATTERN DETECTION (12 patterns)
// ============================================

/**
 * Detect all candlestick patterns on the most recent candles
 * @param {Array} candles - Array of {o, h, l, c, v, t}
 * @returns {Array} Array of { name, type, strength, description }
 */
export function detectCandlestickPatterns(candles) {
  if (candles.length < 5) return [];

  const patterns = [];
  const len = candles.length;
  const cur = candles[len - 1];
  const prev = candles[len - 2];
  const pp = candles[len - 3];

  const bodySize = Math.abs(cur.c - cur.o);
  const totalRange = cur.h - cur.l;
  const upperWick = cur.h - Math.max(cur.o, cur.c);
  const lowerWick = Math.min(cur.o, cur.c) - cur.l;
  const isBullish = cur.c > cur.o;
  const isBearish = cur.c < cur.o;

  const pBodySize = Math.abs(prev.c - prev.o);
  const pIsBullish = prev.c > prev.o;
  const pIsBearish = prev.c < prev.o;

  // Average body size for comparison
  const recentBodies = candles.slice(-10).map(x => Math.abs(x.c - x.o));
  const avgBody = recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length;

  // 1. HAMMER (bullish reversal)
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && totalRange > 0) {
    patterns.push({
      name: 'HAMMER',
      type: 'BULLISH',
      strength: Math.min(100, (lowerWick / totalRange) * 100),
      description: 'Long lower wick, potential reversal up'
    });
  }

  // 2. INVERTED HAMMER
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && pIsBearish) {
    patterns.push({
      name: 'INVERTED_HAMMER',
      type: 'BULLISH',
      strength: Math.min(85, (upperWick / totalRange) * 80),
      description: 'Inverted hammer after decline'
    });
  }

  // 3. BULLISH ENGULFING
  if (isBullish && pIsBearish && cur.c > prev.o && cur.o < prev.c && bodySize > pBodySize) {
    const engulfRatio = bodySize / Math.max(pBodySize, 0.001);
    patterns.push({
      name: 'BULLISH_ENGULFING',
      type: 'BULLISH',
      strength: Math.min(95, engulfRatio * 40),
      description: 'Bullish candle engulfs bearish'
    });
  }

  // 4. BEARISH ENGULFING
  if (isBearish && pIsBullish && cur.o > prev.c && cur.c < prev.o && bodySize > pBodySize) {
    const engulfRatio = bodySize / Math.max(pBodySize, 0.001);
    patterns.push({
      name: 'BEARISH_ENGULFING',
      type: 'BEARISH',
      strength: Math.min(95, engulfRatio * 40),
      description: 'Bearish candle engulfs bullish'
    });
  }

  // 5. DOJI
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
    const ppIsBearish = pp.c < pp.o;
    const pIsSmall = pBodySize < avgBody * 0.3;
    if (ppIsBearish && pIsSmall && isBullish && cur.c > (pp.o + pp.c) / 2) {
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
    const ppIsBullish = pp.c > pp.o;
    const pIsSmall = pBodySize < avgBody * 0.3;
    if (ppIsBullish && pIsSmall && isBearish && cur.c < (pp.o + pp.c) / 2) {
      patterns.push({
        name: 'EVENING_STAR',
        type: 'BEARISH',
        strength: 90,
        description: 'Three-candle bearish reversal'
      });
    }
  }

  // 8. THREE WHITE SOLDIERS
  if (len >= 3) {
    const all3Bullish = candles.slice(-3).every(x => x.c > x.o);
    const increasing = cur.c > prev.c && prev.c > pp.c;
    if (all3Bullish && increasing) {
      patterns.push({
        name: 'THREE_WHITE_SOLDIERS',
        type: 'BULLISH',
        strength: 85,
        description: 'Three consecutive bullish candles'
      });
    }
  }

  // 9. THREE BLACK CROWS
  if (len >= 3) {
    const all3Bearish = candles.slice(-3).every(x => x.c < x.o);
    const decreasing = cur.c < prev.c && prev.c < pp.c;
    if (all3Bearish && decreasing) {
      patterns.push({
        name: 'THREE_BLACK_CROWS',
        type: 'BEARISH',
        strength: 85,
        description: 'Three consecutive bearish candles'
      });
    }
  }

  // 10. MARUBOZU
  if (bodySize > avgBody * 1.5 && upperWick < bodySize * 0.1 && lowerWick < bodySize * 0.1) {
    patterns.push({
      name: 'MARUBOZU',
      type: isBullish ? 'BULLISH' : 'BEARISH',
      strength: 80,
      description: `Strong ${isBullish ? 'bullish' : 'bearish'} conviction`
    });
  }

  // 11. PIERCING LINE
  if (isBullish && pIsBearish && cur.o < prev.l && cur.c > (prev.o + prev.c) / 2) {
    patterns.push({
      name: 'PIERCING_LINE',
      type: 'BULLISH',
      strength: 75,
      description: 'Opens low, closes above prior midpoint'
    });
  }

  // 12. SHOOTING STAR (bearish reversal at top)
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.3 && pIsBullish) {
    patterns.push({
      name: 'SHOOTING_STAR',
      type: 'BEARISH',
      strength: Math.min(85, (upperWick / totalRange) * 80),
      description: 'Shooting star at top of move'
    });
  }

  return patterns;
}

// ============================================
// SURGE / SPIKE DETECTION
// ============================================

/**
 * Detect rapid price surges and sudden moves
 * @param {Array} candles
 * @returns {{ detected, type, strength, priceChangePercent, volumeRatio, reason, confidence, urgency }}
 */
export function detectSurge(candles) {
  const noSignal = {
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
  const price = current.c;

  // Calculate various price changes
  const change1 = ((price - prev.c) / prev.c) * 100;
  const change3 = ((price - candles[len - 4].c) / candles[len - 4].c) * 100;
  const change5 = ((price - candles[len - 6].c) / candles[len - 6].c) * 100;

  // Volume analysis
  const recentVolumes = candles.slice(-20).map(c => c.v);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const currentVolume = current.v;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // Price velocity
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

  // --- DIP BUY: V-shape recovery ---
  const recentLow = Math.min(...candles.slice(-5).map(c => c.l));
  const recentHigh = Math.max(...candles.slice(-10, -3).map(c => c.h));
  const dipPercent = ((recentHigh - recentLow) / recentHigh) * 100;
  const recoveryPercent = ((price - recentLow) / recentLow) * 100;
  const isDipping = dipPercent > 0.5 && recoveryPercent > dipPercent * 0.3;

  if (isDipping && change1 > 0 && price > prev.c) {
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
  const upCandles14 = candles.slice(-14).filter(c => c.c > c.o).length;
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

  // --- SURGE DOWN: Rapid drop ---
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
 * @param {Array} candles
 * @returns {{ isDip, dipPercent, recoveryStarted, volumeConfirmed, strength, entryScore }}
 */
export function analyzeDipBuy(candles) {
  const noDip = { isDip: false, dipPercent: 0, recoveryStarted: false, volumeConfirmed: false, strength: 0, entryScore: 0 };
  if (candles.length < 20) return noDip;

  const len = candles.length;
  const price = candles[len - 1].c;
  const prevPrice = candles[len - 2].c;

  const recentHighPrice = Math.max(...candles.slice(-20).map(c => c.h));
  const dipFromHigh = ((recentHighPrice - price) / recentHighPrice) * 100;

  const recentLowPrice = Math.min(...candles.slice(-5).map(c => c.l));
  const bounceFromLow = ((price - recentLowPrice) / recentLowPrice) * 100;

  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.v, 0) / 20;
  const recentVolume = candles.slice(-3).reduce((s, c) => s + c.v, 0) / 3;
  const volumeConfirmed = recentVolume > avgVolume * 1.2;

  const recoveryStarted = price > prevPrice && price > recentLowPrice * 1.001;

  const downCandles = candles.slice(-14).filter(c => c.c < c.o).length;
  const oversold = downCandles >= 9;

  let entryScore = 0;
  if (dipFromHigh > 1) entryScore += Math.min(30, dipFromHigh * 8);
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
 * @param {Array} candles
 * @returns {{ direction, strength, momentum, acceleration, trendAge, isBreakout, nearSupport, nearResistance }}
 */
export function analyzeTrend(candles) {
  const defaultTrend = {
    direction: 'SIDEWAYS', strength: 0, momentum: 0, acceleration: 0,
    trendAge: 0, isBreakout: false, nearSupport: false, nearResistance: false
  };

  if (candles.length < 20) return defaultTrend;

  const len = candles.length;
  const closes = candles.map(c => c.c);
  const price = closes[len - 1];

  // Fast EMA (5-period) vs Slow EMA (20-period)
  const ema5 = simpleEMA(closes, 5);
  const ema20 = simpleEMA(closes, 20);
  const ema5Current = ema5[ema5.length - 1];
  const ema20Current = ema20[ema20.length - 1];
  const ema5Prev = ema5[ema5.length - 3] || ema5Current;
  const ema20Prev = ema20[ema20.length - 3] || ema20Current;

  // Momentum
  const momentum3 = ((price - closes[len - 4]) / closes[len - 4]) * 100;
  const momentum5 = ((price - closes[len - 6]) / closes[len - 6]) * 100;

  // Acceleration
  const prevMomentum3 = ((closes[len - 2] - closes[len - 5]) / closes[len - 5]) * 100;
  const acceleration = momentum3 - prevMomentum3;

  // Trend direction
  const aboveEma5 = price > ema5Current;
  const aboveEma20 = price > ema20Current;
  const ema5Rising = ema5Current > ema5Prev;
  const ema20Rising = ema20Current > ema20Prev;
  const emaCrossUp = ema5Current > ema20Current && ema5Prev <= ema20Prev;

  let direction;
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

  // Trend age
  let trendAge = 0;
  const isUp = direction === 'UP' || direction === 'STRONG_UP';
  for (let i = len - 1; i > Math.max(0, len - 30); i--) {
    if (isUp ? closes[i] >= closes[i - 1] : closes[i] <= closes[i - 1]) {
      trendAge++;
    } else {
      break;
    }
  }

  // Breakout detection
  const rangeHigh = Math.max(...candles.slice(-20, -1).map(c => c.h));
  const rangeLow = Math.min(...candles.slice(-20, -1).map(c => c.l));
  const isBreakout = price > rangeHigh || emaCrossUp;

  // Support/resistance proximity
  const nearSupport = (price - rangeLow) / rangeLow < 0.01;
  const nearResistance = (rangeHigh - price) / rangeHigh < 0.01;

  const normalizedMomentum = Math.max(-100, Math.min(100, momentum5 * 20));

  return {
    direction, strength, momentum: normalizedMomentum, acceleration,
    trendAge, isBreakout, nearSupport, nearResistance
  };
}

// ============================================
// COMBINED SURGE TRADING DECISION
// ============================================

/**
 * Master decision function - combines all surge trading signals
 * Priority: 1) Active surges 2) Dip buys 3) Trend rides 4) Pattern signals
 * @param {Array} candles
 * @param {string} ticker
 * @returns {{ shouldTrade, action, confidence, reason, strategy, positionSizeMultiplier, urgency, patterns, surge, trend, dip }}
 */
export function getMasterSurgeDecision(candles, ticker) {
  const patterns = detectCandlestickPatterns(candles);
  const surge = detectSurge(candles);
  const trend = analyzeTrend(candles);
  const dip = analyzeDipBuy(candles);

  const noTrade = {
    shouldTrade: false, action: 'HOLD', confidence: 0,
    reason: 'No surge opportunity', strategy: 'SURGE',
    positionSizeMultiplier: 1, urgency: 'WATCH',
    patterns, surge, trend, dip
  };

  if (candles.length < 10) return noTrade;

  const bullishPatterns = patterns.filter(p => p.type === 'BULLISH');
  const bearishPatterns = patterns.filter(p => p.type === 'BEARISH');
  const patternScore = bullishPatterns.reduce((s, p) => s + p.strength, 0) -
                       bearishPatterns.reduce((s, p) => s + p.strength, 0);

  // Priority 1: DIP BUY from surge detection
  if (surge.detected && surge.type === 'DIP_BUY' && surge.confidence > 40) {
    const trendBoost = trend.direction !== 'STRONG_DOWN' ? 10 : -20;
    const patternBoost = bullishPatterns.length > 0 ? 15 : 0;
    const confidence = Math.min(95, surge.confidence + trendBoost + patternBoost);

    return {
      shouldTrade: true, action: 'BUY', confidence,
      reason: `[SURGE] ${surge.reason} | Trend: ${trend.direction} | Patterns: ${bullishPatterns.map(p => p.name).join(',')}`,
      strategy: 'DIP_BUY',
      positionSizeMultiplier: Math.min(1.8, 1 + Math.abs(surge.priceChangePercent) / 5),
      urgency: surge.urgency,
      patterns, surge, trend, dip
    };
  }

  // Priority 1b: DIP BUY from analysis
  if (dip.isDip && dip.entryScore > 40 && dip.recoveryStarted) {
    const trendBoost = trend.direction !== 'STRONG_DOWN' ? 10 : -20;
    const patternBoost = bullishPatterns.length > 0 ? 15 : 0;
    const confidence = Math.min(95, dip.entryScore + trendBoost + patternBoost);

    if (confidence > 35) {
      return {
        shouldTrade: true, action: 'BUY', confidence,
        reason: `[SURGE] Dip buy: ${dip.dipPercent.toFixed(2)}% drop, recovery started | Vol: ${dip.volumeConfirmed ? 'confirmed' : 'low'}`,
        strategy: 'DIP_BUY',
        positionSizeMultiplier: Math.min(1.8, 1 + dip.dipPercent / 5),
        urgency: dip.volumeConfirmed ? 'IMMEDIATE' : 'SOON',
        patterns, surge, trend, dip
      };
    }
  }

  // Priority 2: TREND RIDE (with overbought filter)
  const upCandles14Decision = candles.slice(-14).filter(c => c.c > c.o).length;
  const isOverboughtDecision = upCandles14Decision >= 10;

  if ((trend.direction === 'STRONG_UP' || trend.direction === 'UP') && trend.strength > 40 && !isOverboughtDecision) {
    const surgeBoost = surge.type === 'TREND_RIDE' ? 15 : 0;
    const patternBoost = patternScore > 0 ? Math.min(10, patternScore / 5) : 0;
    const breakoutBoost = trend.isBreakout ? 20 : 0;
    const confidence = Math.min(95, trend.strength * 0.7 + surgeBoost + patternBoost + breakoutBoost);

    if (confidence > 35) {
      return {
        shouldTrade: true, action: 'BUY', confidence,
        reason: `[SURGE] Trend ride: ${trend.direction} (str=${trend.strength}) ${trend.isBreakout ? '+ BREAKOUT' : ''} | Mom: ${trend.momentum.toFixed(1)}`,
        strategy: trend.isBreakout ? 'BREAKOUT_SURGE' : 'TREND_RIDE',
        positionSizeMultiplier: trend.direction === 'STRONG_UP' ? 1.5 : 1.2,
        urgency: trend.isBreakout ? 'IMMEDIATE' : 'SOON',
        patterns, surge, trend, dip
      };
    }
  }

  // Priority 4: STRONG PATTERN SIGNALS
  if (bullishPatterns.length >= 2 && patternScore > 100) {
    const confidence = Math.min(80, patternScore / 3 + (trend.direction !== 'STRONG_DOWN' ? 15 : 0));
    if (confidence > 35) {
      return {
        shouldTrade: true, action: 'BUY', confidence,
        reason: `[SURGE] Pattern signal: ${bullishPatterns.map(p => p.name).join(' + ')} (score=${patternScore})`,
        strategy: 'PATTERN',
        positionSizeMultiplier: 1.1,
        urgency: 'SOON',
        patterns, surge, trend, dip
      };
    }
  }

  // Priority 5: Single strong bullish pattern with trend support
  if (bullishPatterns.length === 1 && bullishPatterns[0].strength >= 75 &&
      (trend.direction === 'UP' || trend.direction === 'STRONG_UP' || trend.direction === 'SIDEWAYS')) {
    const confidence = Math.min(75, bullishPatterns[0].strength * 0.6 + trend.strength * 0.2);
    if (confidence > 35) {
      return {
        shouldTrade: true, action: 'BUY', confidence,
        reason: `[SURGE] ${bullishPatterns[0].name} pattern (${bullishPatterns[0].strength}) + ${trend.direction} trend`,
        strategy: 'PATTERN',
        positionSizeMultiplier: 1,
        urgency: 'SOON',
        patterns, surge, trend, dip
      };
    }
  }

  return noTrade;
}
