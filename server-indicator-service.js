
// Helper: Exponential Moving Average
const ema = (data, period) => {
    const result = new Array(data.length);
    if (data.length === 0) return result;
    const k = 2 / (period + 1);
    result[0] = data[0];
    for (let i = 1; i < data.length; i++) {
        result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
};

// Helper: Simple Moving Average (Optimized with sliding window)
const sma = (data, period) => {
    const result = new Array(data.length).fill(NaN);
    if (data.length < period) {
        return result;
    }
    let sum = 0;
    // Calculate sum of first period
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }
    result[period - 1] = sum / period;
    // Use sliding window for the rest
    for (let i = period; i < data.length; i++) {
        sum = sum - data[i - period] + data[i];
        result[i] = sum / period;
    }
    return result;
};

// Helper: Wilder's Moving Average
const rma = (data, period) => {
  const result = new Array(data.length).fill(NaN);
  const alpha = 1 / period;
  if (data.length < period) return result;
  let sum = 0;
  for (let i=0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    result[i] = alpha * data[i] + (1 - alpha) * (result[i - 1] || 0);
  }
  return result;
};

const calculateRsi = (data, period) => {
    const changes = data.map((d, i) => i > 0 ? d - data[i - 1] : 0);
    const gains = changes.map(c => Math.max(c, 0));
    const losses = changes.map(c => Math.max(-c, 0));
    const avgGain = rma(gains, period);
    const avgLoss = rma(losses, period);
    return avgGain.map((ag, i) => {
        const al = avgLoss[i];
        if (isNaN(ag) || isNaN(al)) return 50;
        if (al === 0) return 100;
        const rs = ag / al;
        return 100 - (100 / (1 + rs));
    });
};

const movingSum = (data, period) => {
  const result = [];
  let currentSum = 0;
  for (let i = 0; i < data.length; i++) {
    currentSum += data[i];
    if (i >= period) currentSum -= data[i - period];
    result.push(i < period - 1 ? NaN : currentSum);
  }
  return result;
};

export function calculateTCSeries(candles) {
    if (candles.length < 21) return new Array(candles.length).fill(50);
    
    const trendstrength = candles.map(c => (c.h === c.l) ? 0 : (2 * c.c - c.l - c.h) / (c.h - c.l));
    
    const ohlc4 = candles.map(c => (c.o + c.h + c.l + c.c) / 4);
    const ohlc4Change = ohlc4.map((d, i) => i > 0 ? d - ohlc4[i-1] : 0);
    const toptrend = movingSum(candles.map((c, i) => (ohlc4Change[i] > 0 ? ohlc4[i] * c.v : 0)), 8);
    const lowertrend = movingSum(candles.map((c, i) => (ohlc4Change[i] < 0 ? Math.abs(ohlc4[i] * c.v) : 0)), 8);
    const trendline = toptrend.map((t, i) => {
        const l = lowertrend[i];
        if (l === 0) return 100;
        if (t === 0) return 0;
        return 100 - (100 / (1 + (t / l)));
    });

    const closePrices = candles.map(c => c.c);
    const closeChange = closePrices.map((d, i) => i > 0 ? d - closePrices[i-1] : 0);
    const toptrend2 = movingSum(candles.map((c, i) => (closeChange[i] > 0 ? c.c * c.v : 0)), 20);
    const lowertrend2 = movingSum(candles.map((c, i) => (closeChange[i] < 0 ? Math.abs(c.c * c.v) : 0)), 20);
    const trendline2 = toptrend2.map((t, i) => {
        const l = lowertrend2[i];
        if (l === 0) return 100;
        if (t === 0) return 0;
        return 100 - (100 / (1 + (t / l)));
    });
    
    const tcSeries = candles.map((_, i) => {
        const tl = trendline[i]; 
        const ts = trendstrength[i]; 
        const tl2 = trendline2[i];
        
        if (isNaN(tl) || isNaN(ts) || isNaN(tl2)) return NaN;

        // STABLE FORMULA: Average the two trend lines and add the strength component as a small nudge.
        const raw_tc = (tl + tl2) / 2 + ts;

        return Math.max(0, Math.min(100, raw_tc));
    });

    const firstValidIndex = tcSeries.findIndex(v => !isNaN(v));
    if (firstValidIndex > 0) tcSeries.fill(tcSeries[firstValidIndex], 0, firstValidIndex);
    
    if (tcSeries.every(isNaN)) return new Array(candles.length).fill(50);
    
    return tcSeries;
}

export function calculateBreakoutDetectorSeries(candles, volatilityLength = 8, rsiLength = 8) {
    if (candles.length < volatilityLength + 1) return new Array(candles.length).fill(50);
    const logHighLowSq = candles.map(c => c.h === c.l ? 0 : Math.pow(Math.log(c.h / c.l), 2));
    const sumLogHighLowSq = movingSum(logHighLowSq, volatilityLength);
    const hlc3 = candles.map(c => (c.h + c.l + c.c) / 3);
    const priceVolatility = sumLogHighLowSq.map((s, i) => Math.sqrt((hlc3[i] / ((volatilityLength * 4) * Math.log(2))) * s));
    const breakoutRsi = calculateRsi(priceVolatility, rsiLength);
    const firstValidIndex = breakoutRsi.findIndex(v => !isNaN(v));
    if (firstValidIndex > 0) breakoutRsi.fill(breakoutRsi[firstValidIndex], 0, firstValidIndex);
    return breakoutRsi;
}


export function calculateWhaleMoneyFlowSeries(candles, wmfLength = 10, mfiLength = 14) {
    if (candles.length < mfiLength) return new Array(candles.length).fill(50);
    const adjustment = candles.map(c => (c.h === c.l) ? 0 : ((2 * c.c - c.l - c.h) / (c.h - c.l)) * c.v);
    const sumAdjustment = movingSum(adjustment, wmfLength);
    const sumVolume = movingSum(candles.map(c => c.v), wmfLength);
    const whaleMoneyFlow = sumAdjustment.map((sa, i) => (sumVolume[i] > 0 ? sa / sumVolume[i] : 0));
    const closeChanges = candles.map((c, i) => i > 0 ? c.c - candles[i-1].c : 0);
    const upper = movingSum(candles.map((c,i) => (closeChanges[i] > 0 ? c.c * c.v : 0)), mfiLength);
    const lower = movingSum(candles.map((c,i) => (closeChanges[i] < 0 ? c.c * c.v : 0)), mfiLength);
    const moneyStrength = upper.map((u, i) => {
        const l = Math.abs(lower[i]);
        if (l === 0) return 100; if (u === 0) return 0;
        return 100 - (100 / (1 + u / l));
    });
    const finalSeries = moneyStrength.map((ms, i) => Math.max(0, Math.min(100, ms + whaleMoneyFlow[i])));
    const firstValidIndex = finalSeries.findIndex(v => !isNaN(v));
    if (firstValidIndex > 0) finalSeries.fill(finalSeries[firstValidIndex], 0, firstValidIndex);
    return finalSeries;
}

export function calculateTrendDashboard(candles) {
    if (candles.length < 200) return { rsi: false, stoch: false, macd: false, ma50: false, ma100: false, ma200: false, score: 0 };

    const closePrices = candles.map(c => c.c);
    const highPrices = candles.map(c => c.h);
    const lowPrices = candles.map(c => c.l);
    const lastClose = closePrices[closePrices.length - 1];

    const rsi = calculateRsi(closePrices, 14).pop() ?? 50;

    const stochPeriod = 14;
    const low14 = Math.min(...lowPrices.slice(-stochPeriod));
    const high14 = Math.max(...highPrices.slice(-stochPeriod));
    const k = 100 * (lastClose - low14) / (high14 - low14);

    const ema12 = ema(closePrices, 12);
    const ema26 = ema(closePrices, 26);
    const macdLine = ema12.map((e, i) => e - ema26[i]);
    const signalLine = ema(macdLine, 9);

    const ma50Values = sma(closePrices, 50);
    const ma100Values = sma(closePrices, 100);
    const ma200Values = sma(closePrices, 200);

    const bullish = {
        rsi: rsi > 50,
        stoch: k > 50,
        macd: macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1],
        ma50: lastClose > (ma50Values[ma50Values.length-1] ?? 0),
        ma100: lastClose > (ma100Values[ma100Values.length-1] ?? 0),
        ma200: lastClose > (ma200Values[ma200Values.length-1] ?? 0),
    };

    const score = Object.values(bullish).filter(v => v).length;

    return { ...bullish, score };
}

/**
 * Momentum Series Calculation
 * Measures the rate of price change with smoothing
 * Returns values from 0-100 (50 is neutral)
 */
export function calculateMomentumSeries(candles, fastPeriod = 10, slowPeriod = 20, signalPeriod = 9) {
    if (candles.length < slowPeriod + signalPeriod) {
        return new Array(candles.length).fill(50);
    }

    const closes = candles.map(c => c.c);

    // Rate of Change calculation (fast)
    const roc = closes.map((c, i) => {
        if (i < fastPeriod) return 0;
        const prevPrice = closes[i - fastPeriod];
        return prevPrice !== 0 ? ((c - prevPrice) / prevPrice) * 100 : 0;
    });

    // Smooth the ROC with EMA
    const smoothedRoc = ema(roc, signalPeriod);

    // Long-term momentum for confirmation
    const longRoc = closes.map((c, i) => {
        if (i < slowPeriod) return 0;
        const prevPrice = closes[i - slowPeriod];
        return prevPrice !== 0 ? ((c - prevPrice) / prevPrice) * 100 : 0;
    });
    const smoothedLongRoc = ema(longRoc, signalPeriod);

    // Combine short and long momentum, normalize to 0-100
    const momentum = smoothedRoc.map((sr, i) => {
        const lr = smoothedLongRoc[i];
        // Weight short-term more but consider long-term trend
        const combined = sr * 0.6 + lr * 0.4;
        // Normalize: typical ROC range is -10 to +10, map to 0-100
        return Math.max(0, Math.min(100, 50 + combined * 5));
    });

    // Fill NaN values at start
    const firstValidIndex = momentum.findIndex(v => !isNaN(v) && v !== 50);
    if (firstValidIndex > 0) {
        momentum.fill(momentum[firstValidIndex] || 50, 0, firstValidIndex);
    }

    return momentum;
}

/**
 * RSI Divergence Detection
 * Detects when price and RSI move in opposite directions
 */
export function calculateDivergence(candles, lookback = 14, rsiPeriod = 14) {
    const defaultResult = {
        type: 'none',
        strength: 0,
        priceDirection: 'flat',
        rsiDirection: 'flat',
        confidence: 0
    };

    if (candles.length < lookback + rsiPeriod) {
        return defaultResult;
    }

    const closes = candles.map(c => c.c);
    const rsiValues = calculateRsi(closes, rsiPeriod);

    const recentCandles = candles.slice(-lookback);
    const recentRsi = rsiValues.slice(-lookback);

    // Find local highs and lows in price
    const priceHighs = [];
    const priceLows = [];

    for (let i = 2; i < recentCandles.length - 2; i++) {
        const price = recentCandles[i].c;
        if (price > recentCandles[i - 1].c &&
            price > recentCandles[i - 2].c &&
            price > recentCandles[i + 1].c &&
            price > recentCandles[i + 2].c) {
            priceHighs.push({ index: i, value: price });
        }
        if (price < recentCandles[i - 1].c &&
            price < recentCandles[i - 2].c &&
            price < recentCandles[i + 1].c &&
            price < recentCandles[i + 2].c) {
            priceLows.push({ index: i, value: price });
        }
    }

    // Determine overall directions
    const firstClose = recentCandles[0].c;
    const lastClose = recentCandles[recentCandles.length - 1].c;
    const firstRsi = recentRsi[0];
    const lastRsi = recentRsi[recentRsi.length - 1];

    const priceChange = (lastClose - firstClose) / firstClose;
    const rsiChange = lastRsi - firstRsi;

    const priceDirection = priceChange > 0.01 ? 'up' : priceChange < -0.01 ? 'down' : 'flat';
    const rsiDirection = rsiChange > 3 ? 'up' : rsiChange < -3 ? 'down' : 'flat';

    // Check for divergence
    let divergenceType = 'none';
    let strength = 0;
    let confidence = 0;

    // Bullish divergence: price making lower lows, RSI making higher lows
    if (priceLows.length >= 2) {
        const lastTwoLows = priceLows.slice(-2);
        if (lastTwoLows[1].value < lastTwoLows[0].value) {
            const rsiAtLows = [recentRsi[lastTwoLows[0].index], recentRsi[lastTwoLows[1].index]];
            if (rsiAtLows[1] > rsiAtLows[0]) {
                divergenceType = 'bullish';
                strength = Math.abs(rsiAtLows[1] - rsiAtLows[0]);
                confidence = Math.min(100, strength * 3 + (lastRsi < 40 ? 20 : 0));
            }
        }
    }

    // Bearish divergence: price making higher highs, RSI making lower highs
    if (divergenceType === 'none' && priceHighs.length >= 2) {
        const lastTwoHighs = priceHighs.slice(-2);
        if (lastTwoHighs[1].value > lastTwoHighs[0].value) {
            const rsiAtHighs = [recentRsi[lastTwoHighs[0].index], recentRsi[lastTwoHighs[1].index]];
            if (rsiAtHighs[1] < rsiAtHighs[0]) {
                divergenceType = 'bearish';
                strength = Math.abs(rsiAtHighs[0] - rsiAtHighs[1]);
                confidence = Math.min(100, strength * 3 + (lastRsi > 60 ? 20 : 0));
            }
        }
    }

    return {
        type: divergenceType,
        strength: Math.min(100, strength),
        priceDirection,
        rsiDirection,
        confidence
    };
}

// Adaptive Asset Parameters (from TC Adaptive Trades in Favor)
const ADAPTIVE_ASSET_PARAMS = {
    BTC: { lookback: 20, noiseFilter: 1.0 },
    ETH: { lookback: 14, noiseFilter: 1.0 },
    SOL: { lookback: 8, noiseFilter: 1.0 },
    XRP: { lookback: 12, noiseFilter: 1.5 },
    DOGE: { lookback: 8, noiseFilter: 1.2 },
    ADA: { lookback: 14, noiseFilter: 1.0 },
    DEFAULT: { lookback: 14, noiseFilter: 1.0 },
};

function getAssetParams(ticker) {
    const assetKey = Object.keys(ADAPTIVE_ASSET_PARAMS).find(key =>
        key !== 'DEFAULT' && ticker.toUpperCase().includes(key)
    );
    return ADAPTIVE_ASSET_PARAMS[assetKey || 'DEFAULT'];
}

/**
 * Calculate Adaptive TC Series with asset-specific parameters
 * Based on TC Adaptive Trades in Favor (Multi-Asset) PineScript indicator
 */
export function calculateAdaptiveTCSeries(candles, ticker = '') {
    const params = getAssetParams(ticker);
    const lookback = params.lookback;
    const noiseFilter = params.noiseFilter;

    if (candles.length < lookback + 5) {
        return new Array(candles.length).fill(50);
    }

    const ohlc4 = candles.map(c => (c.o + c.h + c.l + c.c) / 4);
    const ohlc4Change = ohlc4.map((d, i) => i > 0 ? d - ohlc4[i - 1] : 0);

    const topSum = movingSum(
        candles.map((c, i) => ohlc4Change[i] <= 0 ? 0 : ohlc4[i] * c.v),
        lookback
    );

    const lowerSum = movingSum(
        candles.map((c, i) => ohlc4Change[i] >= 0 ? 0 : ohlc4[i] * c.v),
        lookback
    );

    const tcSeries = topSum.map((top, i) => {
        const lower = Math.abs(lowerSum[i]);
        if (isNaN(top) || isNaN(lower)) return 50;
        if (lower === 0) return 100;
        if (top === 0) return 0;

        let ratio = 100 - (100 / (1 + top / lower));

        if (noiseFilter !== 1.0) {
            const deviation = ratio - 50;
            ratio = 50 + (deviation / noiseFilter);
        }

        return Math.max(0, Math.min(100, ratio));
    });

    const firstValidIndex = tcSeries.findIndex(v => !isNaN(v) && v !== 50);
    if (firstValidIndex > 0) tcSeries.fill(tcSeries[firstValidIndex] || 50, 0, firstValidIndex);

    return tcSeries;
}

// ============================================
// SMART TRADING FEATURES
// ============================================

/**
 * Calculate Average True Range (ATR)
 */
export function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return new Array(candles.length).fill(0);

    const trueRanges = [candles[0].h - candles[0].l];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].h;
        const low = candles[i].l;
        const prevClose = candles[i - 1].c;
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
    }

    return rma(trueRanges, period);
}

/**
 * Detect Market Regime
 */
export function detectMarketRegime(candles) {
    const defaultRegime = {
        trend: 'SIDEWAYS',
        volatility: 'MEDIUM',
        momentum: 'NEUTRAL',
        atrPercent: 2,
        trendStrength: 50,
        volatilityPercentile: 50,
        recommendedStrategy: 'CONFLUENCE',
        tradingCondition: 'FAIR'
    };

    if (candles.length < 50) return defaultRegime;

    const closes = candles.map(c => c.c);
    const currentPrice = closes[closes.length - 1];

    // Calculate ATR as % of price
    const atrValues = calculateATR(candles, 14);
    const currentATR = atrValues[atrValues.length - 1] || 0;
    const atrPercent = currentPrice > 0 ? (currentATR / currentPrice) * 100 : 2;

    // Calculate historical ATR percentile
    const historicalATRs = atrValues.slice(-100).filter(v => !isNaN(v) && v > 0);
    const sortedATRs = [...historicalATRs].sort((a, b) => a - b);
    const currentATRIndex = sortedATRs.findIndex(v => v >= currentATR);
    const volatilityPercentile = historicalATRs.length > 0
        ? (currentATRIndex / historicalATRs.length) * 100
        : 50;

    // Determine volatility level
    let volatility;
    if (volatilityPercentile < 25) volatility = 'LOW';
    else if (volatilityPercentile < 50) volatility = 'MEDIUM';
    else if (volatilityPercentile < 80) volatility = 'HIGH';
    else volatility = 'EXTREME';

    // Calculate trend using multiple MAs
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const currentMA20 = ma20[ma20.length - 1] || currentPrice;
    const currentMA50 = ma50[ma50.length - 1] || currentPrice;
    const prevMA20 = ma20[ma20.length - 10] || currentMA20;
    const prevMA50 = ma50[ma50.length - 10] || currentMA50;

    // Trend direction
    const aboveMA20 = currentPrice > currentMA20;
    const aboveMA50 = currentPrice > currentMA50;
    const ma20Rising = currentMA20 > prevMA20;
    const ma50Rising = currentMA50 > prevMA50;

    const priceChange20 = (currentPrice - closes[closes.length - 20]) / closes[closes.length - 20];
    const trendStrength = Math.min(100, Math.abs(priceChange20) * 500);

    let trend;
    if (aboveMA20 && aboveMA50 && ma20Rising && ma50Rising && trendStrength > 60) {
        trend = 'STRONG_UP';
    } else if (aboveMA20 && aboveMA50 && ma20Rising) {
        trend = 'UP';
    } else if (!aboveMA20 && !aboveMA50 && !ma20Rising && !ma50Rising && trendStrength > 60) {
        trend = 'STRONG_DOWN';
    } else if (!aboveMA20 && !aboveMA50 && !ma20Rising) {
        trend = 'DOWN';
    } else {
        trend = 'SIDEWAYS';
    }

    // Momentum
    const rsiValues = calculateRsi(closes, 14);
    const lastRSI = rsiValues[rsiValues.length - 1] || 50;
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];
    const prevMacdLine = ema12[ema12.length - 2] - ema26[ema26.length - 2];

    let momentum;
    if (lastRSI > 55 && macdLine > prevMacdLine) {
        momentum = 'BULLISH';
    } else if (lastRSI < 45 && macdLine < prevMacdLine) {
        momentum = 'BEARISH';
    } else {
        momentum = 'NEUTRAL';
    }

    // Recommendation
    let recommendedStrategy;
    let tradingCondition;

    if (volatility === 'EXTREME') {
        recommendedStrategy = 'BREAKOUT';
        tradingCondition = 'POOR';
    } else if (trend === 'STRONG_UP' || trend === 'STRONG_DOWN') {
        recommendedStrategy = 'TREND';
        tradingCondition = 'EXCELLENT';
    } else if (trend === 'UP' || trend === 'DOWN') {
        recommendedStrategy = momentum === 'NEUTRAL' ? 'CONFLUENCE' : 'MOMENTUM';
        tradingCondition = 'GOOD';
    } else if (volatility === 'LOW') {
        recommendedStrategy = 'BREAKOUT';
        tradingCondition = 'FAIR';
    } else {
        recommendedStrategy = 'WHALE';
        tradingCondition = 'FAIR';
    }

    if (volatility === 'EXTREME' && trend === 'SIDEWAYS') {
        tradingCondition = 'AVOID';
    }

    return {
        trend,
        volatility,
        momentum,
        atrPercent,
        trendStrength,
        volatilityPercentile,
        recommendedStrategy,
        tradingCondition
    };
}

/**
 * Detect Price Gaps
 */
export function detectGap(candles) {
    const noGap = {
        hasGap: false,
        gapType: 'NONE',
        gapPercent: 0,
        gapFilled: false,
        gapPrice: 0,
        isBreakawayGap: false,
        fillProbability: 0
    };

    if (candles.length < 10) return noGap;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    const gapUpSize = lastCandle.o - prevCandle.h;
    const gapDownSize = prevCandle.l - lastCandle.o;

    const gapUpPercent = (gapUpSize / prevCandle.c) * 100;
    const gapDownPercent = (gapDownSize / prevCandle.c) * 100;

    const minGapPercent = 0.5;

    let hasGap = false;
    let gapType = 'NONE';
    let gapPercent = 0;
    let gapPrice = 0;

    if (gapUpPercent >= minGapPercent) {
        hasGap = true;
        gapType = 'GAP_UP';
        gapPercent = gapUpPercent;
        gapPrice = prevCandle.h;
    } else if (gapDownPercent >= minGapPercent) {
        hasGap = true;
        gapType = 'GAP_DOWN';
        gapPercent = gapDownPercent;
        gapPrice = prevCandle.l;
    }

    if (!hasGap) return noGap;

    let gapFilled = false;
    if (gapType === 'GAP_UP') {
        gapFilled = lastCandle.l <= prevCandle.h;
    } else if (gapType === 'GAP_DOWN') {
        gapFilled = lastCandle.h >= prevCandle.l;
    }

    const avgVolume = candles.slice(-20, -1).reduce((sum, c) => sum + c.v, 0) / 19;
    const isBreakawayGap = lastCandle.v > avgVolume * 1.5;

    let fillProbability = 70;
    fillProbability -= gapPercent * 5;
    if (isBreakawayGap) fillProbability -= 20;
    fillProbability = Math.max(10, Math.min(90, fillProbability));

    return {
        hasGap,
        gapType,
        gapPercent,
        gapFilled,
        gapPrice,
        isBreakawayGap,
        fillProbability
    };
}

/**
 * Inline candlestick pattern scorer for opportunity scoring (Phase 1D).
 * Returns a 0-100 score: bullish patterns push higher, bearish patterns push lower.
 */
function scoreCandlestickPatterns(candles) {
    if (candles.length < 5) return 50; // neutral

    const len = candles.length;
    const cur = candles[len - 1];
    const prev = candles[len - 2];
    const pp = candles[len - 3];

    const bodySize = Math.abs(cur.c - cur.o);
    const totalRange = cur.h - cur.l || 0.0001;
    const upperWick = cur.h - Math.max(cur.o, cur.c);
    const lowerWick = Math.min(cur.o, cur.c) - cur.l;
    const isBullish = cur.c > cur.o;
    const pIsBearish = prev.c < prev.o;
    const pBodySize = Math.abs(prev.c - prev.o);

    let score = 50;

    // HAMMER: long lower wick, small upper wick (bullish reversal)
    if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) score += 15;

    // BULLISH ENGULFING: current bullish candle fully engulfs previous bearish
    if (isBullish && pIsBearish && cur.c > prev.o && cur.o < prev.c && bodySize > pBodySize) score += 20;

    // MORNING STAR: bearish → small body → bullish
    if (len >= 3 && pp.c < pp.o && Math.abs(prev.c - prev.o) < bodySize * 0.3 && isBullish && cur.c > (pp.o + pp.c) / 2) score += 18;

    // THREE WHITE SOLDIERS: 3 consecutive bullish candles with higher closes
    if (len >= 3 && pp.c > pp.o && prev.c > prev.o && isBullish && cur.c > prev.c && prev.c > pp.c) score += 15;

    // PIERCING LINE: bearish prev → bullish current that closes above prev midpoint
    if (isBullish && pIsBearish && cur.o < prev.c && cur.c > (prev.o + prev.c) / 2) score += 12;

    // SHOOTING STAR: long upper wick (bearish reversal)
    if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && prev.c > prev.o) score -= 12;

    // BEARISH ENGULFING
    if (!isBullish && !pIsBearish && cur.o > prev.c && cur.c < prev.o && bodySize > pBodySize) score -= 15;

    // EVENING STAR: bullish → small body → bearish
    if (len >= 3 && pp.c > pp.o && Math.abs(prev.c - prev.o) < bodySize * 0.3 && !isBullish && cur.c < (pp.o + pp.c) / 2) score -= 15;

    return Math.max(0, Math.min(100, score));
}

/**
 * Calculate Opportunity Score
 */
export function calculateOpportunityScore(candles, ticker, options = {}) {
    const defaultScore = {
        ticker,
        compositeScore: 0,
        urgency: 'WAIT',
        confidence: 0,
        factors: {}
    };

    if (candles.length < 21) return defaultScore; // Was 50 — now matches indicator minimum (21 for ATR/EMA)

    // Get indicators
    const tcSeries = calculateTCSeries(candles);
    const tcValue = tcSeries[tcSeries.length - 1] || 50;

    const momentumSeries = calculateMomentumSeries(candles);
    const momentumValue = momentumSeries[momentumSeries.length - 1] || 50;

    const trendDashboard = calculateTrendDashboard(candles);

    const regime = detectMarketRegime(candles);
    const gap = detectGap(candles);

    // Factor 1: Trend Alignment (rescaled: tcValue 0=max bullish→100, 50=neutral→50, 100=bearish→0)
    // Use amplified scaling so bullish readings (tcValue < 40) map strongly above 60
    const trendAlignment = Math.max(0, Math.min(100, 50 + (50 - tcValue) * 1.5));

    // Factor 2: Momentum Strength
    const momentumStrength = momentumValue;

    // Factor 3: Volume Confirmation
    // Phase 4A: Surge-aware volume scoring — reduce penalty during surges
    const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.v, 0) / 20;
    const currentVolume = candles[candles.length - 1].v;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    let volumeConfirmation;
    if (options.microBurstActive) {
        // Micro burst IS the volume signal — skip ratio check, give full score
        volumeConfirmation = 85;
    } else if (options.surgeActive) {
        // During surges: reduce below-avg penalty by 50% (volume often lags price)
        volumeConfirmation = volumeRatio < 0.5 ? 30 :       // was 10
            volumeRatio < 1.0 ? Math.min(65, 30 + volumeRatio * 35) :  // was max 45
            Math.min(100, 10 + volumeRatio * 36);
    } else {
        // Standard: ratio=1.0 → 45 (below-avg penalized), ratio=1.5 → 65, ratio=2.5 → 100
        volumeConfirmation = volumeRatio < 0.5 ? 10 :
            volumeRatio < 1.0 ? Math.min(45, 10 + volumeRatio * 35) :
            Math.min(100, 10 + volumeRatio * 36);
    }

    // Factor 4: Gap Opportunity
    let gapOpportunity = 0;
    if (gap.hasGap && !gap.gapFilled) {
        if (gap.gapType === 'GAP_UP' && gap.isBreakawayGap) {
            gapOpportunity = 80;
        } else if (gap.gapType === 'GAP_DOWN' && gap.fillProbability > 60) {
            gapOpportunity = 70;
        }
    }

    // Factor 5: Multi-indicator alignment
    const multiTimeframeAlignment = (trendDashboard.score / 6) * 100;

    // Factor 6 (Phase 1D): Candlestick pattern signal
    const candlestickScore = scoreCandlestickPatterns(candles);

    // Combine factors — 6 components with candlestick taking 10% (5% from trend + 5% from momentum)
    const weights = {
        trendAlignment: 0.25,       // was 0.30
        momentumStrength: 0.20,     // was 0.25
        volumeConfirmation: 0.20,
        gapOpportunity: 0.10,
        multiTimeframeAlignment: 0.15,
        candlestickPattern: 0.10,   // new
    };

    const compositeScore =
        trendAlignment * weights.trendAlignment +
        momentumStrength * weights.momentumStrength +
        volumeConfirmation * weights.volumeConfirmation +
        gapOpportunity * weights.gapOpportunity +
        multiTimeframeAlignment * weights.multiTimeframeAlignment +
        candlestickScore * weights.candlestickPattern;

    // Determine urgency
    let urgency;
    if (compositeScore >= 75) urgency = 'IMMEDIATE';
    else if (compositeScore >= 60) urgency = 'SOON';
    else if (compositeScore >= 40) urgency = 'WATCH';
    else urgency = 'WAIT';

    return {
        ticker,
        compositeScore,
        urgency,
        confidence: regime.trendStrength,
        regime: regime.trend,
        volumeRatio,
        factors: {
            trendAlignment,
            momentumStrength,
            volumeConfirmation,
            gapOpportunity,
            multiTimeframeAlignment,
            candlestickPattern: candlestickScore
        }
    };
}

/**
 * Calculate Adaptive Data for Dashboard
 */
export function calculateAdaptiveData(candles, ticker) {
    const params = getAssetParams(ticker);
    const adaptiveSeries = calculateAdaptiveTCSeries(candles, ticker);
    const tcValue = adaptiveSeries[adaptiveSeries.length - 1] || 50;
    
    // Probability Text Logic
    let probabilityText = "";
    let direction = "NEUTRAL";
    let percent = 50;

    const isBTC = ticker.toUpperCase().includes('BTC');
    const isSOL = ticker.toUpperCase().includes('SOL');

    if (tcValue >= 70) {
        probabilityText = isBTC ? "99% BTC Exhaustion" : "99% Drop/Squeeze";
        percent = 99;
        direction = "DROP";
    } else if (tcValue <= 30) {
        probabilityText = isSOL ? "99% SOL Momentum" : "99% Pump/Squeeze";
        percent = 99;
        direction = "PUMP";
    } else if (tcValue > 50) {
        probabilityText = `${Math.round(tcValue)}% Chance of Drop`;
        percent = Math.round(tcValue);
        direction = "DROP";
    } else {
        probabilityText = `${Math.round(100 - tcValue)}% Chance of Pump`;
        percent = Math.round(100 - tcValue);
        direction = "PUMP";
    }

    const recentValues = adaptiveSeries.slice(-5);
    const avgValue = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const consistency = 100 - Math.abs(tcValue - avgValue) * 2;
    const extremity = Math.abs(tcValue - 50) * 2;
    const confidence = Math.min(100, (consistency + extremity) / 2);

    return {
        tcValue,
        probabilityText,
        probabilityPercent: percent,
        direction,
        assetParams: params,
        confidence
    };
}