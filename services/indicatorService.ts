import type { Candle, TrendDashboardData, SRLevels, DivergenceData, MomentumData, VolumeProfileData, SignalScore, IndicatorData, AdaptiveData, HeatMapEntry, CorrelationData, MultiAssetAnalysis, MarketRegime, GapData, OpportunityScore, DynamicTradingParams, SessionAnalytics, TradingStrategy, SlowMarketResult } from '../types';
import { INDICATOR_PARAMS, SIGNAL_THRESHOLDS, ADAPTIVE_ASSET_PARAMS, PROBABILITY_THRESHOLDS } from '../constants';

// ============================================
// MEMOIZATION CACHE FOR INDICATOR CALCULATIONS
// ============================================

interface CachedIndicators {
    tcSeries: number[];
    breakoutSeries: number[];
    whaleSeries: number[];
    momentumSeries: number[];
    trendDashboard: TrendDashboardData;
    divergence: DivergenceData;
    timestamp: number;
}

// Cache key is based on last candle time + candle count for quick invalidation
const indicatorCache = new Map<string, CachedIndicators>();
const CACHE_MAX_SIZE = 50; // Max entries to prevent memory bloat
const CACHE_TTL_MS = 5000; // 5 second TTL

function getCacheKey(candles: Candle[]): string {
    if (candles.length === 0) return 'empty';
    const lastCandle = candles[candles.length - 1];
    return `${lastCandle.time}_${candles.length}_${lastCandle.close}`;
}

function cleanCache(): void {
    const now = Date.now();
    // Remove expired entries
    for (const [key, value] of indicatorCache.entries()) {
        if (now - value.timestamp > CACHE_TTL_MS) {
            indicatorCache.delete(key);
        }
    }
    // If still too large, remove oldest entries
    if (indicatorCache.size > CACHE_MAX_SIZE) {
        const entries = Array.from(indicatorCache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, entries.length - CACHE_MAX_SIZE);
        for (const [key] of toRemove) {
            indicatorCache.delete(key);
        }
    }
}

/**
 * Get cached indicators or calculate and cache them
 * This prevents redundant calculations when multiple functions need the same data
 */
function getCachedIndicators(candles: Candle[]): CachedIndicators {
    const key = getCacheKey(candles);
    const cached = indicatorCache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        return cached;
    }

    // Calculate all indicators once
    const result: CachedIndicators = {
        tcSeries: calculateTCSeriesInternal(candles),
        breakoutSeries: calculateBreakoutDetectorSeriesInternal(candles),
        whaleSeries: calculateWhaleMoneyFlowSeriesInternal(candles),
        momentumSeries: calculateMomentumSeriesInternal(candles),
        trendDashboard: calculateTrendDashboardInternal(candles),
        divergence: calculateDivergenceInternal(candles),
        timestamp: now
    };

    // Clean and store
    cleanCache();
    indicatorCache.set(key, result);

    return result;
}

/** Clear the indicator cache - useful when switching tickers */
export function clearIndicatorCache(): void {
    indicatorCache.clear();
}

// ============================================
// HELPER FUNCTIONS (Optimized)
// ============================================

/**
 * Exponential Moving Average - O(n) single pass
 */
export const ema = (data: number[], period: number): number[] => {
    if (data.length === 0) return [];
    const result: number[] = new Array(data.length);
    const k = 2 / (period + 1);
    result[0] = data[0];
    for (let i = 1; i < data.length; i++) {
        result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
};

/**
 * Simple Moving Average - O(n) sliding window
 */
export const sma = (data: number[], period: number): number[] => {
    if (data.length < period) return new Array(data.length).fill(NaN);

    const result: number[] = new Array(data.length);
    let sum = 0;

    // Calculate sum of first period
    for (let i = 0; i < period; i++) {
        sum += data[i];
        result[i] = NaN;
    }
    result[period - 1] = sum / period;

    // Sliding window for the rest
    for (let i = period; i < data.length; i++) {
        sum = sum - data[i - period] + data[i];
        result[i] = sum / period;
    }
    return result;
};

/**
 * Wilder's Moving Average (RMA) - used in RSI
 */
export const rma = (data: number[], period: number): number[] => {
    if (data.length < period) return new Array(data.length).fill(NaN);

    const result: number[] = new Array(data.length).fill(NaN);
    const alpha = 1 / period;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    result[period - 1] = sum / period;

    for (let i = period; i < data.length; i++) {
        result[i] = alpha * data[i] + (1 - alpha) * result[i - 1];
    }
    return result;
};

/**
 * Moving Sum - O(n) sliding window
 */
export const movingSum = (data: number[], period: number): number[] => {
    const result: number[] = new Array(data.length);
    let currentSum = 0;

    for (let i = 0; i < data.length; i++) {
        currentSum += data[i];
        if (i >= period) currentSum -= data[i - period];
        result[i] = i < period - 1 ? NaN : currentSum;
    }
    return result;
};

/**
 * RSI Calculation with proper smoothing
 */
export const calculateRsi = (data: number[], period: number = INDICATOR_PARAMS.RSI_PERIOD): number[] => {
    if (data.length < period + 1) return new Array(data.length).fill(50);

    const changes: number[] = new Array(data.length);
    changes[0] = 0;
    for (let i = 1; i < data.length; i++) {
        changes[i] = data[i] - data[i - 1];
    }

    const gains = changes.map(c => Math.max(c, 0));
    const losses = changes.map(c => Math.max(-c, 0));

    const avgGain = rma(gains, period);
    const avgLoss = rma(losses, period);

    return avgGain.map((ag, i) => {
        const al = avgLoss[i];
        if (isNaN(ag) || isNaN(al)) return 50;
        if (al === 0) return 100;
        if (ag === 0) return 0;
        const rs = ag / al;
        return 100 - (100 / (1 + rs));
    });
};

/**
 * Standard Deviation - O(n) sliding window using Welford's method
 * Uses the identity: Var(X) = E[X²] - E[X]²
 * Maintains running sum and sumSquares for O(1) updates
 */
export const stdDev = (data: number[], period: number): number[] => {
    if (data.length < period) return new Array(data.length).fill(NaN);

    const result: number[] = new Array(data.length).fill(NaN);
    let sum = 0;
    let sumSquares = 0;

    // Initialize first window
    for (let i = 0; i < period; i++) {
        sum += data[i];
        sumSquares += data[i] * data[i];
    }

    // Calculate first stdDev
    const mean0 = sum / period;
    const variance0 = (sumSquares / period) - (mean0 * mean0);
    result[period - 1] = Math.sqrt(Math.max(0, variance0)); // max(0,...) for numerical stability

    // Slide window through rest of data - O(1) per element
    for (let i = period; i < data.length; i++) {
        const oldValue = data[i - period];
        const newValue = data[i];

        // Update running sums
        sum = sum - oldValue + newValue;
        sumSquares = sumSquares - (oldValue * oldValue) + (newValue * newValue);

        // Calculate stdDev using variance formula
        const mean = sum / period;
        const variance = (sumSquares / period) - (mean * mean);
        result[i] = Math.sqrt(Math.max(0, variance)); // max(0,...) handles floating point errors
    }

    return result;
};

/**
 * Fill NaN values at start with first valid value
 */
const fillNaN = (data: number[], defaultValue: number = 50): number[] => {
    const firstValidIndex = data.findIndex(v => !isNaN(v));
    if (firstValidIndex === -1) return new Array(data.length).fill(defaultValue);
    if (firstValidIndex > 0) {
        for (let i = 0; i < firstValidIndex; i++) {
            data[i] = data[firstValidIndex];
        }
    }
    return data;
};

// ============================================
// CORE INDICATORS
// ============================================

/**
 * TC Score (Trend Confluence) - Original indicator optimized
 * Combines volume-weighted trend analysis with price action
 */
function calculateTCSeriesInternal(candles: Candle[]): number[] {
    if (candles.length < INDICATOR_PARAMS.MIN_CANDLES_REQUIRED) {
        return new Array(candles.length).fill(50);
    }

    // Pre-calculate arrays once
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);

    // Trend strength: normalized close position within bar (-1 to 1)
    const trendstrength = candles.map(c =>
        c.high === c.low ? 0 : (2 * c.close - c.low - c.high) / (c.high - c.low)
    );

    // Trendline 1: Volume-weighted directional flow (period 8)
    const ohlc4Change = ohlc4.map((d, i) => i > 0 ? d - ohlc4[i - 1] : 0);
    const toptrend = movingSum(
        candles.map((c, i) => ohlc4Change[i] > 0 ? ohlc4[i] * volumes[i] : 0),
        INDICATOR_PARAMS.TC_TRENDLINE_PERIOD
    );
    const lowertrend = movingSum(
        candles.map((c, i) => ohlc4Change[i] < 0 ? Math.abs(ohlc4[i] * volumes[i]) : 0),
        INDICATOR_PARAMS.TC_TRENDLINE_PERIOD
    );

    const trendline = toptrend.map((t, i) => {
        const l = lowertrend[i];
        if (isNaN(t) || isNaN(l)) return NaN;
        if (l === 0) return 100;
        if (t === 0) return 0;
        return 100 - (100 / (1 + (t / l)));
    });

    // Trendline 2: Close-based directional flow (period 20)
    const closeChange = closes.map((d, i) => i > 0 ? d - closes[i - 1] : 0);
    const toptrend2 = movingSum(
        candles.map((c, i) => closeChange[i] > 0 ? closes[i] * volumes[i] : 0),
        INDICATOR_PARAMS.TC_TRENDLINE2_PERIOD
    );
    const lowertrend2 = movingSum(
        candles.map((c, i) => closeChange[i] < 0 ? Math.abs(closes[i] * volumes[i]) : 0),
        INDICATOR_PARAMS.TC_TRENDLINE2_PERIOD
    );

    const trendline2 = toptrend2.map((t, i) => {
        const l = lowertrend2[i];
        if (isNaN(t) || isNaN(l)) return NaN;
        if (l === 0) return 100;
        if (t === 0) return 0;
        return 100 - (100 / (1 + (t / l)));
    });

    // Combine: Average trendlines + strength nudge
    const tcSeries = candles.map((_, i) => {
        const tl = trendline[i];
        const ts = trendstrength[i];
        const tl2 = trendline2[i];

        if (isNaN(tl) || isNaN(ts) || isNaN(tl2)) return NaN;

        const raw_tc = (tl + tl2) / 2 + ts;
        return Math.max(0, Math.min(100, raw_tc));
    });

    return fillNaN(tcSeries, 50);
}

/** Public wrapper - uses cache for repeated calls */
export function calculateTCSeries(candles: Candle[]): number[] {
    return getCachedIndicators(candles).tcSeries;
}

/** Direct calculation without cache - for when you need fresh data */
export function calculateTCSeriesDirect(candles: Candle[]): number[] {
    return calculateTCSeriesInternal(candles);
}

/**
 * Breakout Detector - Volatility squeeze indicator
 * Low values indicate compression (potential breakout setup)
 */
function calculateBreakoutDetectorSeriesInternal(
    candles: Candle[],
    volatilityLength = INDICATOR_PARAMS.BREAKOUT_VOLATILITY_LENGTH,
    rsiLength = INDICATOR_PARAMS.BREAKOUT_RSI_LENGTH
): number[] {
    if (candles.length < volatilityLength + rsiLength) {
        return new Array(candles.length).fill(50);
    }

    // Garman-Klass volatility estimator
    const logHighLowSq = candles.map(c =>
        c.high === c.low ? 0 : Math.pow(Math.log(c.high / c.low), 2)
    );
    const sumLogHighLowSq = movingSum(logHighLowSq, volatilityLength);

    const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3);
    const priceVolatility = sumLogHighLowSq.map((s, i) =>
        Math.sqrt((hlc3[i] / ((volatilityLength * 4) * Math.log(2))) * s)
    );

    const breakoutRsi = calculateRsi(priceVolatility, rsiLength);
    return fillNaN(breakoutRsi, 50);
}

/** Public wrapper - uses cache for repeated calls */
export function calculateBreakoutDetectorSeries(
    candles: Candle[],
    volatilityLength = INDICATOR_PARAMS.BREAKOUT_VOLATILITY_LENGTH,
    rsiLength = INDICATOR_PARAMS.BREAKOUT_RSI_LENGTH
): number[] {
    // Use cache only with default params, otherwise calculate directly
    if (volatilityLength === INDICATOR_PARAMS.BREAKOUT_VOLATILITY_LENGTH &&
        rsiLength === INDICATOR_PARAMS.BREAKOUT_RSI_LENGTH) {
        return getCachedIndicators(candles).breakoutSeries;
    }
    return calculateBreakoutDetectorSeriesInternal(candles, volatilityLength, rsiLength);
}

/**
 * Whale Money Flow - Tracks institutional volume patterns
 * High values = whale buying, Low values = whale selling
 */
function calculateWhaleMoneyFlowSeriesInternal(
    candles: Candle[],
    wmfLength = INDICATOR_PARAMS.WHALE_WMF_LENGTH,
    mfiLength = INDICATOR_PARAMS.WHALE_MFI_LENGTH
): number[] {
    if (candles.length < Math.max(wmfLength, mfiLength)) {
        return new Array(candles.length).fill(50);
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // Chaikin-style money flow adjustment
    const adjustment = candles.map(c =>
        c.high === c.low ? 0 : ((2 * c.close - c.low - c.high) / (c.high - c.low)) * c.volume
    );

    const sumAdjustment = movingSum(adjustment, wmfLength);
    const sumVolume = movingSum(volumes, wmfLength);

    const whaleMoneyFlow = sumAdjustment.map((sa, i) =>
        sumVolume[i] > 0 ? sa / sumVolume[i] : 0
    );

    // Money strength calculation
    const closeChanges = closes.map((c, i) => i > 0 ? c - closes[i - 1] : 0);
    const upper = movingSum(
        candles.map((c, i) => closeChanges[i] > 0 ? closes[i] * volumes[i] : 0),
        mfiLength
    );
    const lower = movingSum(
        candles.map((c, i) => closeChanges[i] < 0 ? Math.abs(closes[i] * volumes[i]) : 0),
        mfiLength
    );

    const moneyStrength = upper.map((u, i) => {
        const l = Math.abs(lower[i]);
        if (isNaN(u) || isNaN(l)) return 50;
        if (l === 0) return 100;
        if (u === 0) return 0;
        return 100 - (100 / (1 + u / l));
    });

    const finalSeries = moneyStrength.map((ms, i) =>
        Math.max(0, Math.min(100, ms + whaleMoneyFlow[i]))
    );

    return fillNaN(finalSeries, 50);
}

/** Public wrapper - uses cache for repeated calls */
export function calculateWhaleMoneyFlowSeries(
    candles: Candle[],
    wmfLength = INDICATOR_PARAMS.WHALE_WMF_LENGTH,
    mfiLength = INDICATOR_PARAMS.WHALE_MFI_LENGTH
): number[] {
    // Use cache only with default params, otherwise calculate directly
    if (wmfLength === INDICATOR_PARAMS.WHALE_WMF_LENGTH &&
        mfiLength === INDICATOR_PARAMS.WHALE_MFI_LENGTH) {
        return getCachedIndicators(candles).whaleSeries;
    }
    return calculateWhaleMoneyFlowSeriesInternal(candles, wmfLength, mfiLength);
}

// ============================================
// NEW INDICATORS FOR PHASE 1
// ============================================

/**
 * Calculate Bollinger Bands
 */
export function calculateBollingerBands(candles: Candle[], period: number = 20, stdDevMultiplier: number = 2): { upper: number[], middle: number[], lower: number[] } {
    if (candles.length < period) {
        return { upper: [], middle: [], lower: [] };
    }
    const closes = candles.map(c => c.close);
    const middle = sma(closes, period);
    const std = stdDev(closes, period);

    const upper = middle.map((m, i) => m + (std[i] * stdDevMultiplier));
    const lower = middle.map((m, i) => m - (std[i] * stdDevMultiplier));

    return { upper, middle, lower };
}

/**
 * Calculate VWAP (Volume Weighted Average Price)
 */
export function calculateVWAP(candles: Candle[]): number[] {
    if (candles.length === 0) return [];
    
    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;
    const vwap = [];

    for (const candle of candles) {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativeTypicalPriceVolume += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
        vwap.push(cumulativeVolume > 0 ? cumulativeTypicalPriceVolume / cumulativeVolume : typicalPrice);
    }
    return vwap;
}


// ============================================
// EXISTING INDICATORS
// ============================================


/**
 * Momentum Oscillator - NEW
 * Measures the rate of price change with smoothing
 * Positive = bullish momentum, Negative = bearish momentum
 */
function calculateMomentumSeriesInternal(candles: Candle[]): number[] {
    if (candles.length < INDICATOR_PARAMS.MOMENTUM_SLOW_PERIOD + INDICATOR_PARAMS.MOMENTUM_SIGNAL_PERIOD) {
        return new Array(candles.length).fill(50);
    }

    const closes = candles.map(c => c.close);

    // Rate of Change calculation
    const roc = closes.map((c, i) => {
        if (i < INDICATOR_PARAMS.MOMENTUM_FAST_PERIOD) return 0;
        const prevPrice = closes[i - INDICATOR_PARAMS.MOMENTUM_FAST_PERIOD];
        return prevPrice !== 0 ? ((c - prevPrice) / prevPrice) * 100 : 0;
    });

    // Smooth the ROC with EMA
    const smoothedRoc = ema(roc, INDICATOR_PARAMS.MOMENTUM_SIGNAL_PERIOD);

    // Also calculate longer-term momentum for confirmation
    const longRoc = closes.map((c, i) => {
        if (i < INDICATOR_PARAMS.MOMENTUM_SLOW_PERIOD) return 0;
        const prevPrice = closes[i - INDICATOR_PARAMS.MOMENTUM_SLOW_PERIOD];
        return prevPrice !== 0 ? ((c - prevPrice) / prevPrice) * 100 : 0;
    });
    const smoothedLongRoc = ema(longRoc, INDICATOR_PARAMS.MOMENTUM_SIGNAL_PERIOD);

    // Combine short and long momentum, normalize to 0-100
    const momentum = smoothedRoc.map((sr, i) => {
        const lr = smoothedLongRoc[i];
        // Weight short-term more but consider long-term trend
        const combined = sr * 0.6 + lr * 0.4;
        // Normalize: typical ROC range is -10 to +10, map to 0-100
        return Math.max(0, Math.min(100, 50 + combined * 5));
    });

    return fillNaN(momentum, 50);
}

/** Public wrapper - uses cache for repeated calls */
export function calculateMomentumSeries(candles: Candle[]): number[] {
    return getCachedIndicators(candles).momentumSeries;
}

/**
 * RSI Divergence Detection - Optimized
 * Detects when price and RSI move in opposite directions
 * Uses efficient single-pass peak detection with early termination
 */
function calculateDivergenceInternal(candles: Candle[]): DivergenceData {
    const defaultResult: DivergenceData = {
        type: 'none',
        strength: 0,
        priceDirection: 'flat',
        rsiDirection: 'flat',
        confidence: 0
    };

    const lookback = INDICATOR_PARAMS.DIVERGENCE_LOOKBACK;
    const minRequired = lookback + INDICATOR_PARAMS.RSI_PERIOD;

    if (candles.length < minRequired) {
        return defaultResult;
    }

    // Work with indices into original array to avoid slice allocations
    const startIdx = candles.length - lookback;
    const endIdx = candles.length;

    // Calculate RSI only once (already optimized with RMA)
    const closes = candles.map(c => c.close);
    const rsiValues = calculateRsi(closes, INDICATOR_PARAMS.RSI_PERIOD);

    // Optimized single-pass peak detection
    // Only keep last 2 highs and lows (all we need for divergence)
    let lastHigh: { index: number; value: number } | null = null;
    let prevHigh: { index: number; value: number } | null = null;
    let lastLow: { index: number; value: number } | null = null;
    let prevLow: { index: number; value: number } | null = null;

    // Single pass through lookback window
    for (let i = startIdx + 2; i < endIdx - 2; i++) {
        const price = candles[i].close;
        const p1 = candles[i - 1].close;
        const p2 = candles[i - 2].close;
        const n1 = candles[i + 1].close;
        const n2 = candles[i + 2].close;

        // Check for local high
        if (price > p1 && price > p2 && price > n1 && price > n2) {
            prevHigh = lastHigh;
            lastHigh = { index: i, value: price };
        }
        // Check for local low
        if (price < p1 && price < p2 && price < n1 && price < n2) {
            prevLow = lastLow;
            lastLow = { index: i, value: price };
        }
    }

    // Calculate directions
    const firstClose = candles[startIdx].close;
    const lastClose = candles[endIdx - 1].close;
    const firstRsi = rsiValues[startIdx];
    const lastRsi = rsiValues[endIdx - 1];

    const priceChange = (lastClose - firstClose) / firstClose;
    const rsiChange = lastRsi - firstRsi;

    const priceDirection: DivergenceData['priceDirection'] =
        priceChange > 0.01 ? 'up' : priceChange < -0.01 ? 'down' : 'flat';
    const rsiDirection: DivergenceData['rsiDirection'] =
        rsiChange > 3 ? 'up' : rsiChange < -3 ? 'down' : 'flat';

    let divergenceType: DivergenceData['type'] = 'none';
    let strength = 0;
    let confidence = 0;

    // Bullish divergence: price lower lows, RSI higher lows
    if (prevLow && lastLow && lastLow.value < prevLow.value) {
        const rsiAtPrevLow = rsiValues[prevLow.index];
        const rsiAtLastLow = rsiValues[lastLow.index];
        if (rsiAtLastLow > rsiAtPrevLow) {
            divergenceType = 'bullish';
            strength = Math.abs(rsiAtLastLow - rsiAtPrevLow);
            confidence = Math.min(100, strength * 3 + (lastRsi < 40 ? 20 : 0));
        }
    }

    // Bearish divergence: price higher highs, RSI lower highs
    if (divergenceType === 'none' && prevHigh && lastHigh && lastHigh.value > prevHigh.value) {
        const rsiAtPrevHigh = rsiValues[prevHigh.index];
        const rsiAtLastHigh = rsiValues[lastHigh.index];
        if (rsiAtLastHigh < rsiAtPrevHigh) {
            divergenceType = 'bearish';
            strength = Math.abs(rsiAtPrevHigh - rsiAtLastHigh);
            confidence = Math.min(100, strength * 3 + (lastRsi > 60 ? 20 : 0));
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

/** Public wrapper - uses cache for repeated calls */
export function calculateDivergence(candles: Candle[]): DivergenceData {
    return getCachedIndicators(candles).divergence;
}

/**
 * Volume Profile Analysis - NEW
 * Identifies value areas and volume-based support/resistance
 */
export function calculateVolumeProfile(candles: Candle[]): VolumeProfileData {
    const defaultResult: VolumeProfileData = {
        poc: 0,
        valueAreaHigh: 0,
        valueAreaLow: 0,
        volumeStrength: 50,
        buyPressure: 50
    };

    if (candles.length < INDICATOR_PARAMS.VOLUME_PROFILE_BARS) {
        if (candles.length > 0) {
            const lastCandle = candles.at(-1)!;
            defaultResult.poc = lastCandle.close;
            defaultResult.valueAreaHigh = lastCandle.high;
            defaultResult.valueAreaLow = lastCandle.low;
        }
        return defaultResult;
    }

    const recentCandles = candles.slice(-INDICATOR_PARAMS.VOLUME_PROFILE_BARS);

    // Create price levels and aggregate volume
    const minPrice = Math.min(...recentCandles.map(c => c.low));
    const maxPrice = Math.max(...recentCandles.map(c => c.high));
    const priceRange = maxPrice - minPrice;

    if (priceRange === 0) {
        return { ...defaultResult, poc: minPrice, valueAreaHigh: maxPrice, valueAreaLow: minPrice };
    }

    const numLevels = 50;
    const levelSize = priceRange / numLevels;
    const volumeAtLevel: number[] = new Array(numLevels).fill(0);

    // Distribute volume across price levels
    for (const candle of recentCandles) {
        const candleRange = candle.high - candle.low;
        const volumePerLevel = candleRange > 0 ? candle.volume / Math.ceil(candleRange / levelSize) : candle.volume;

        const lowLevel = Math.floor((candle.low - minPrice) / levelSize);
        const highLevel = Math.min(numLevels - 1, Math.floor((candle.high - minPrice) / levelSize));

        for (let level = lowLevel; level <= highLevel; level++) {
            if (level >= 0 && level < numLevels) {
                volumeAtLevel[level] += volumePerLevel;
            }
        }
    }

    // Find Point of Control (highest volume level)
    let maxVolume = 0;
    let pocLevel = 0;
    for (let i = 0; i < numLevels; i++) {
        if (volumeAtLevel[i] > maxVolume) {
            maxVolume = volumeAtLevel[i];
            pocLevel = i;
        }
    }

    const poc = minPrice + (pocLevel + 0.5) * levelSize;

    // Calculate Value Area (70% of volume)
    const totalVolume = volumeAtLevel.reduce((a, b) => a + b, 0);
    const targetVolume = totalVolume * (INDICATOR_PARAMS.VALUE_AREA_PERCENT / 100);

    let currentVolume = volumeAtLevel[pocLevel];
    let lowIndex = pocLevel;
    let highIndex = pocLevel;

    while (currentVolume < targetVolume && (lowIndex > 0 || highIndex < numLevels - 1)) {
        const volumeBelow = lowIndex > 0 ? volumeAtLevel[lowIndex - 1] : 0;
        const volumeAbove = highIndex < numLevels - 1 ? volumeAtLevel[highIndex + 1] : 0;

        if (volumeBelow >= volumeAbove && lowIndex > 0) {
            lowIndex--;
            currentVolume += volumeAtLevel[lowIndex];
        } else if (highIndex < numLevels - 1) {
            highIndex++;
            currentVolume += volumeAtLevel[highIndex];
        } else if (lowIndex > 0) {
            lowIndex--;
            currentVolume += volumeAtLevel[lowIndex];
        }
    }

    const valueAreaLow = minPrice + lowIndex * levelSize;
    const valueAreaHigh = minPrice + (highIndex + 1) * levelSize;

    // Calculate volume strength (current vs average)
    const avgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
    const recentAvg = recentCandles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
    const volumeStrength = avgVolume > 0 ? Math.min(100, (recentAvg / avgVolume) * 50) : 50;

    // Calculate buy pressure
    const buyVolume = recentCandles.reduce((sum, c) => {
        return sum + (c.close >= c.open ? c.volume : 0);
    }, 0);
    const buyPressure = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;

    return {
        poc,
        valueAreaHigh,
        valueAreaLow,
        volumeStrength,
        buyPressure
    };
}

/**
 * Calculate Momentum Data object - NEW
 */
export function calculateMomentumData(candles: Candle[]): MomentumData {
    const momentumSeries = calculateMomentumSeries(candles);
    const lastValue = momentumSeries.at(-1) ?? 50;
    const prevValue = momentumSeries.at(-2) ?? 50;
    const prev2Value = momentumSeries.at(-3) ?? 50;

    // Determine trend
    let trend: MomentumData['trend'] = 'neutral';
    if (lastValue > prevValue && prevValue > prev2Value) {
        trend = 'accelerating';
    } else if (lastValue < prevValue && prevValue < prev2Value) {
        trend = 'decelerating';
    }

    // Determine crossover
    let crossover: MomentumData['crossover'] = 'none';
    if (prevValue < 50 && lastValue >= 50) {
        crossover = 'bullish';
    } else if (prevValue > 50 && lastValue <= 50) {
        crossover = 'bearish';
    }

    return {
        value: (lastValue - 50) * 2, // Convert to -100 to 100 range
        trend,
        strength: Math.abs(lastValue - 50) * 2,
        crossover
    };
}

// ============================================
// TREND DASHBOARD (Enhanced)
// ============================================

/**
 * Multi-indicator confluence dashboard - Enhanced with more data
 */
function calculateTrendDashboardInternal(candles: Candle[]): TrendDashboardData {
    const defaultResult: TrendDashboardData = {
        rsi: false, stoch: false, macd: false,
        ma50: false, ma100: false, ma200: false,
        score: 0
    };

    if (candles.length < INDICATOR_PARAMS.MIN_CANDLES_FOR_MA200) {
        return defaultResult;
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const lastClose = closes.at(-1)!;

    // RSI
    const rsiValues = calculateRsi(closes, INDICATOR_PARAMS.RSI_PERIOD);
    const rsiValue = rsiValues.at(-1) ?? 50;

    // Stochastic %K with safety check
    const stochPeriod = INDICATOR_PARAMS.STOCH_PERIOD;
    const low14 = Math.min(...lows.slice(-stochPeriod));
    const high14 = Math.max(...highs.slice(-stochPeriod));
    const stochValue = high14 === low14 ? 50 : 100 * (lastClose - low14) / (high14 - low14);

    // MACD
    const ema12 = ema(closes, INDICATOR_PARAMS.EMA_FAST);
    const ema26 = ema(closes, INDICATOR_PARAMS.EMA_SLOW);
    const macdLine = ema12.map((e, i) => e - ema26[i]);
    const signalLine = ema(macdLine, INDICATOR_PARAMS.EMA_SIGNAL);
    const macdHistogram = (macdLine.at(-1) ?? 0) - (signalLine.at(-1) ?? 0);

    // Moving Averages
    const ma50Values = sma(closes, INDICATOR_PARAMS.SMA_50);
    const ma100Values = sma(closes, INDICATOR_PARAMS.SMA_100);
    const ma200Values = sma(closes, INDICATOR_PARAMS.SMA_200);

    const bullish = {
        rsi: rsiValue > 50,
        stoch: stochValue > 50,
        macd: (macdLine.at(-1) ?? 0) > (signalLine.at(-1) ?? 0),
        ma50: lastClose > (ma50Values.at(-1) ?? 0),
        ma100: lastClose > (ma100Values.at(-1) ?? 0),
        ma200: lastClose > (ma200Values.at(-1) ?? 0),
    };

    const score = Object.values(bullish).filter(v => v).length;

    return {
        ...bullish,
        score,
        ma50Values,
        ma100Values,
        ma200Values,
        rsiValue,
        stochValue,
        macdHistogram
    };
}

/** Public wrapper - uses cache for repeated calls */
export function calculateTrendDashboard(candles: Candle[]): TrendDashboardData {
    return getCachedIndicators(candles).trendDashboard;
}

// ============================================
// SUPPORT & RESISTANCE
// ============================================

/**
 * Calculate Support and Resistance using pivot points
 */
export function calculateSRLevels(candles: Candle[], len = INDICATOR_PARAMS.SR_PIVOT_LENGTH): SRLevels {
    if (candles.length < len * 2 + 1) {
        return { support: null, resistance: null };
    }

    let resistance: number | null = null;
    let support: number | null = null;

    // Find latest pivot high (resistance)
    for (let i = candles.length - len - 1; i >= len; i--) {
        const centerHigh = candles[i].high;
        let isPivotHigh = true;

        for (let j = i - len; j <= i + len; j++) {
            if (j !== i && candles[j].high >= centerHigh) {
                isPivotHigh = false;
                break;
            }
        }

        if (isPivotHigh) {
            resistance = centerHigh;
            break;
        }
    }

    // Find latest pivot low (support)
    for (let i = candles.length - len - 1; i >= len; i--) {
        const centerLow = candles[i].low;
        let isPivotLow = true;

        for (let j = i - len; j <= i + len; j++) {
            if (j !== i && candles[j].low <= centerLow) {
                isPivotLow = false;
                break;
            }
        }

        if (isPivotLow) {
            support = centerLow;
            break;
        }
    }

    return { support, resistance };
}

// ============================================
// COMBINED SIGNAL SCORE
// ============================================

/**
 * Calculate overall signal score combining all indicators - Optimized
 * Returns a score from -100 (extreme bearish) to +100 (extreme bullish)
 * Uses single cache lookup for all indicators
 */
export function calculateSignalScore(candles: Candle[]): SignalScore {
    const defaultScore: SignalScore = {
        overall: 0,
        confidence: 0,
        signals: {
            trend: 0,
            breakout: 0,
            whale: 0,
            confluence: 0,
            momentum: 0,
            divergence: 0
        }
    };

    if (candles.length < INDICATOR_PARAMS.MIN_CANDLES_REQUIRED) {
        return defaultScore;
    }

    // Single cache lookup gets all pre-calculated indicators
    const cached = getCachedIndicators(candles);

    // Extract last values from cached series
    const tcValue = cached.tcSeries.at(-1) ?? 50;
    const breakoutValue = cached.breakoutSeries.at(-1) ?? 50;
    const whaleValue = cached.whaleSeries.at(-1) ?? 50;
    const momentumValue = cached.momentumSeries.at(-1) ?? 50;
    const trendDashboard = cached.trendDashboard;
    const divergence = cached.divergence;

    // Convert each indicator to -100 to +100 scale
    // TC Score: < 30 is bullish, > 70 is bearish
    const trendSignal = (50 - tcValue) * 2;

    // Breakout: Low values mean squeeze (potential bullish)
    const breakoutSignal = breakoutValue < 25 ? 30 : breakoutValue > 75 ? -30 : 0;

    // Whale: > 60 is bullish, < 40 is bearish
    const whaleSignal = (whaleValue - 50) * 2;

    // Confluence: Score 0-6, center at 3
    const confluenceSignal = (trendDashboard.score - 3) * 33;

    // Momentum: Already in our desired range after conversion
    const momentumSignal = (momentumValue - 50) * 2;

    // Divergence
    let divergenceSignal = 0;
    if (divergence.type === 'bullish') {
        divergenceSignal = divergence.confidence * 0.5;
    } else if (divergence.type === 'bearish') {
        divergenceSignal = -divergence.confidence * 0.5;
    }

    // Weight the signals
    const weights = {
        trend: 0.25,
        whale: 0.20,
        confluence: 0.20,
        momentum: 0.15,
        breakout: 0.10,
        divergence: 0.10
    };

    const overall =
        trendSignal * weights.trend +
        whaleSignal * weights.whale +
        confluenceSignal * weights.confluence +
        momentumSignal * weights.momentum +
        breakoutSignal * weights.breakout +
        divergenceSignal * weights.divergence;

    // Calculate confidence based on signal agreement
    const signals = [trendSignal, whaleSignal, confluenceSignal, momentumSignal];
    const signalSigns = signals.map(s => Math.sign(s));
    const agreementCount = signalSigns.filter(s => s === Math.sign(overall)).length;
    const confidence = (agreementCount / signals.length) * 100;

    return {
        overall: Math.max(-100, Math.min(100, overall)),
        confidence,
        signals: {
            trend: trendSignal,
            breakout: breakoutSignal,
            whale: whaleSignal,
            confluence: confluenceSignal,
            momentum: momentumSignal,
            divergence: divergenceSignal
        }
    };
}

// ============================================
// ADAPTIVE TC CALCULATION (from TC Adaptive Trades in Favor)
// ============================================

/**
 * Get asset parameters based on ticker symbol
 */
export function getAssetParams(ticker: string): typeof ADAPTIVE_ASSET_PARAMS['DEFAULT'] {
    const assetKey = Object.keys(ADAPTIVE_ASSET_PARAMS).find(key =>
        key !== 'DEFAULT' && ticker.toUpperCase().includes(key)
    );
    return ADAPTIVE_ASSET_PARAMS[assetKey || 'DEFAULT'];
}

/**
 * Calculate Adaptive TC Series with asset-specific parameters
 * Based on TC Adaptive Trades in Favor (Multi-Asset) PineScript indicator
 */
export function calculateAdaptiveTCSeries(candles: Candle[], ticker: string): number[] {
    const params = getAssetParams(ticker);
    const lookback = params.lookback;
    const noiseFilter = params.noiseFilter;

    if (candles.length < lookback + 5) {
        return new Array(candles.length).fill(50);
    }

    const volumes = candles.map(c => c.volume);
    const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);

    // Core calculation from PineScript: calc_tc function
    const calc = candles.map((c, i) => {
        if (c.high === c.low) return 0;
        return ((2 * ohlc4[i] - c.low - c.high) / (c.high - c.low)) * volumes[i];
    });

    // Calculate top (bullish volume) and lower (bearish volume)
    const ohlc4Change = ohlc4.map((d, i) => i > 0 ? d - ohlc4[i - 1] : 0);

    const topSum = movingSum(
        candles.map((c, i) => ohlc4Change[i] <= 0 ? 0 : ohlc4[i] * volumes[i]),
        lookback
    );

    const lowerSum = movingSum(
        candles.map((c, i) => ohlc4Change[i] >= 0 ? 0 : ohlc4[i] * volumes[i]),
        lookback
    );

    // Calculate ratio with noise filter
    const tcSeries = topSum.map((top, i) => {
        const lower = Math.abs(lowerSum[i]);
        if (isNaN(top) || isNaN(lower)) return 50;
        if (lower === 0) return 100;
        if (top === 0) return 0;

        let ratio = 100 - (100 / (1 + top / lower));

        // Apply noise filter (dampens extreme values for volatile assets)
        if (noiseFilter !== 1.0) {
            const deviation = ratio - 50;
            ratio = 50 + (deviation / noiseFilter);
        }

        return Math.max(0, Math.min(100, ratio));
    });

    return fillNaN(tcSeries, 50);
}

/**
 * Get probability text based on TC value (from PineScript indicator)
 */
export function getProbabilityText(tcValue: number, ticker: string): { text: string; percent: number; direction: 'PUMP' | 'DROP' | 'NEUTRAL' } {
    const isBTC = ticker.toUpperCase().includes('BTC');
    const isSOL = ticker.toUpperCase().includes('SOL');

    if (tcValue >= PROBABILITY_THRESHOLDS.EXTREME_BEARISH) {
        return {
            text: isBTC ? '99% BTC Exhaustion' : '99% Drop/Squeeze',
            percent: 99,
            direction: 'DROP'
        };
    } else if (tcValue <= PROBABILITY_THRESHOLDS.EXTREME_BULLISH) {
        return {
            text: isSOL ? '99% SOL Momentum' : '99% Pump/Squeeze',
            percent: 99,
            direction: 'PUMP'
        };
    } else if (tcValue > 50) {
        return {
            text: `${Math.round(tcValue)}% Chance of Drop`,
            percent: Math.round(tcValue),
            direction: 'DROP'
        };
    } else {
        return {
            text: `${Math.round(100 - tcValue)}% Chance of Pump`,
            percent: Math.round(100 - tcValue),
            direction: 'PUMP'
        };
    }
}

/**
 * Calculate full Adaptive Data for a ticker
 */
export function calculateAdaptiveData(candles: Candle[], ticker: string): AdaptiveData {
    const params = getAssetParams(ticker);
    const adaptiveSeries = calculateAdaptiveTCSeries(candles, ticker);
    const tcValue = adaptiveSeries.at(-1) ?? 50;
    const probability = getProbabilityText(tcValue, ticker);

    // Calculate confidence based on signal strength and volume
    const recentValues = adaptiveSeries.slice(-5);
    const avgValue = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const consistency = 100 - Math.abs(tcValue - avgValue) * 2;
    const extremity = Math.abs(tcValue - 50) * 2;
    const confidence = Math.min(100, (consistency + extremity) / 2);

    return {
        tcValue,
        probabilityText: probability.text,
        probabilityPercent: probability.percent,
        direction: probability.direction,
        assetParams: params,
        confidence
    };
}

/**
 * Calculate Heat Map entry for a single asset
 */
export function calculateHeatMapEntry(candles: Candle[], ticker: string): HeatMapEntry {
    const adaptiveData = calculateAdaptiveData(candles, ticker);
    const tcSeries = calculateTCSeries(candles);
    const momentumSeries = calculateMomentumSeries(candles);
    const whaleSeries = calculateWhaleMoneyFlowSeries(candles);
    const trendDashboard = calculateTrendDashboard(candles);
    const signalScore = calculateSignalScore(candles);

    return {
        ticker,
        tcValue: tcSeries.at(-1) ?? 50,
        adaptiveValue: adaptiveData.tcValue,
        probabilityText: adaptiveData.probabilityText,
        direction: adaptiveData.direction,
        momentum: momentumSeries.at(-1) ?? 50,
        whaleFlow: whaleSeries.at(-1) ?? 50,
        confluenceScore: trendDashboard.score,
        overallScore: signalScore.overall
    };
}

/**
 * Calculate correlation between two price series
 */
export function calculateCorrelation(series1: number[], series2: number[]): number {
    const n = Math.min(series1.length, series2.length);
    if (n < 10) return 0;

    const data1 = series1.slice(-n);
    const data2 = series2.slice(-n);

    const mean1 = data1.reduce((a, b) => a + b, 0) / n;
    const mean2 = data2.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denom1 = 0;
    let denom2 = 0;

    for (let i = 0; i < n; i++) {
        const diff1 = data1[i] - mean1;
        const diff2 = data2[i] - mean2;
        numerator += diff1 * diff2;
        denom1 += diff1 * diff1;
        denom2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(denom1 * denom2);
    return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Get correlation strength label
 */
export function getCorrelationStrength(correlation: number): CorrelationData['strength'] {
    if (correlation >= 0.7) return 'STRONG_POSITIVE';
    if (correlation >= 0.4) return 'MODERATE_POSITIVE';
    if (correlation > -0.4) return 'WEAK';
    if (correlation > -0.7) return 'MODERATE_NEGATIVE';
    return 'STRONG_NEGATIVE';
}

/**
 * Calculate Multi-Asset Analysis
 */
export function calculateMultiAssetAnalysis(
    watchlistData: Record<string, { candles: Candle[] }>
): MultiAssetAnalysis {
    const tickers = Object.keys(watchlistData);
    const heatMap: HeatMapEntry[] = [];
    const correlations: CorrelationData[] = [];

    // Calculate heat map entries
    for (const ticker of tickers) {
        const data = watchlistData[ticker];
        if (data && data.candles.length > 20) {
            heatMap.push(calculateHeatMapEntry(data.candles, ticker));
        }
    }

    // Calculate correlations between top assets
    const topTickers = tickers.slice(0, 10);
    for (let i = 0; i < topTickers.length; i++) {
        for (let j = i + 1; j < topTickers.length; j++) {
            const data1 = watchlistData[topTickers[i]];
            const data2 = watchlistData[topTickers[j]];
            if (data1?.candles.length > 20 && data2?.candles.length > 20) {
                const closes1 = data1.candles.map(c => c.close);
                const closes2 = data2.candles.map(c => c.close);
                const corr = calculateCorrelation(closes1, closes2);
                correlations.push({
                    asset1: topTickers[i],
                    asset2: topTickers[j],
                    correlation: corr,
                    strength: getCorrelationStrength(corr)
                });
            }
        }
    }

    // Sort heat map by overall score
    const sortedBullish = [...heatMap].sort((a, b) => b.overallScore - a.overallScore);
    const sortedBearish = [...heatMap].sort((a, b) => a.overallScore - b.overallScore);

    // Calculate market sentiment
    const avgScore = heatMap.length > 0
        ? heatMap.reduce((sum, h) => sum + h.overallScore, 0) / heatMap.length
        : 0;

    return {
        heatMap,
        correlations,
        topBullish: sortedBullish.slice(0, 5),
        topBearish: sortedBearish.slice(0, 5),
        marketSentiment: avgScore
    };
}

// ============================================
// UTILITY: Convert series to IndicatorData
// ============================================

export function toIndicatorData(series: number[], candles: Candle[]): IndicatorData[] {
    return series.map((value, idx) => ({
        time: candles[idx]?.time ?? 0,
        value,
        close: candles[idx]?.close ?? 0
    }));
}

// ============================================
// SMART TRADING FEATURES
// ============================================

/**
 * Calculate Average True Range (ATR) - measures volatility
 */
export function calculateATR(candles: Candle[], period: number = 14): number[] {
    if (candles.length < period + 1) return new Array(candles.length).fill(0);

    const trueRanges: number[] = [candles[0].high - candles[0].low];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
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
 * Detect Market Regime - trending vs ranging, volatility level
 * This helps the bot adapt its strategy to current conditions
 */
/**
 * Detect slow/ranging market conditions
 * Returns true when most recent candles show minimal price movement
 */
export function detectSlowMarket(candles: Candle[]): SlowMarketResult {
    const defaultResult: SlowMarketResult = { isSlow: false, avgRange: 0, consecutiveSmallCandles: 0 };
    if (candles.length < 10) return defaultResult;

    const recent = candles.slice(-10);
    let smallCount = 0;
    let totalRange = 0;

    for (const c of recent) {
        const range = ((c.high - c.low) / c.low) * 100;
        totalRange += range;
        if (range < 0.10) smallCount++;
    }

    const avgRange = totalRange / recent.length;

    // Also check 20-candle ATR as % of price
    let atrSlow = false;
    if (candles.length >= 20) {
        let atrSum = 0;
        for (let i = candles.length - 20; i < candles.length; i++) {
            const prev = candles[i - 1] || candles[i];
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - prev.close),
                Math.abs(candles[i].low - prev.close)
            );
            atrSum += tr;
        }
        const atr = atrSum / 20;
        const lastPrice = candles[candles.length - 1].close;
        const atrPercent = (atr / lastPrice) * 100;
        atrSlow = atrPercent < 0.15;
    }

    const isSlow = smallCount >= 7 || (smallCount >= 5 && atrSlow);

    return { isSlow, avgRange, consecutiveSmallCandles: smallCount };
}

export function detectMarketRegime(candles: Candle[]): MarketRegime {
    const defaultRegime: MarketRegime = {
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

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];

    // Calculate ATR as % of price
    const atrValues = calculateATR(candles, 14);
    const currentATR = atrValues[atrValues.length - 1] || 0;
    const atrPercent = currentPrice > 0 ? (currentATR / currentPrice) * 100 : 2;

    // Calculate historical ATR percentile (where current volatility ranks)
    const historicalATRs = atrValues.slice(-100).filter(v => !isNaN(v) && v > 0);
    const sortedATRs = [...historicalATRs].sort((a, b) => a - b);
    const currentATRIndex = sortedATRs.findIndex(v => v >= currentATR);
    const volatilityPercentile = historicalATRs.length > 0
        ? (currentATRIndex / historicalATRs.length) * 100
        : 50;

    // Determine volatility level
    let volatility: MarketRegime['volatility'];
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

    // Trend direction based on price vs MAs and MA slopes
    const aboveMA20 = currentPrice > currentMA20;
    const aboveMA50 = currentPrice > currentMA50;
    const ma20Rising = currentMA20 > prevMA20;
    const ma50Rising = currentMA50 > prevMA50;

    // Calculate trend strength using ADX-like logic
    const priceChange20 = (currentPrice - closes[closes.length - 20]) / closes[closes.length - 20];
    const trendStrength = Math.min(100, Math.abs(priceChange20) * 500); // Scale to 0-100

    // Determine trend
    let trend: MarketRegime['trend'];
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

    // Determine momentum using RSI and MACD
    const rsiValues = calculateRsi(closes, 14);
    const lastRSI = rsiValues[rsiValues.length - 1] || 50;
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];
    const prevMacdLine = ema12[ema12.length - 2] - ema26[ema26.length - 2];

    let momentum: MarketRegime['momentum'];
    if (lastRSI > 55 && macdLine > prevMacdLine) {
        momentum = 'BULLISH';
    } else if (lastRSI < 45 && macdLine < prevMacdLine) {
        momentum = 'BEARISH';
    } else {
        momentum = 'NEUTRAL';
    }

    // Recommend strategy based on regime
    let recommendedStrategy: TradingStrategy;
    let tradingCondition: MarketRegime['tradingCondition'];

    if (volatility === 'EXTREME') {
        recommendedStrategy = 'BREAKOUT';
        tradingCondition = 'POOR'; // High risk
    } else if (trend === 'STRONG_UP' || trend === 'STRONG_DOWN') {
        recommendedStrategy = 'TREND';
        tradingCondition = 'EXCELLENT';
    } else if (trend === 'UP' || trend === 'DOWN') {
        recommendedStrategy = momentum === 'NEUTRAL' ? 'CONFLUENCE' : 'MOMENTUM';
        tradingCondition = 'GOOD';
    } else if (volatility === 'LOW') {
        recommendedStrategy = 'BREAKOUT'; // Wait for breakout from consolidation
        tradingCondition = 'FAIR';
    } else {
        recommendedStrategy = 'WHALE'; // Follow smart money in choppy markets
        tradingCondition = 'FAIR';
    }

    // Extreme conditions: reduce risk but don't block trading entirely
    // Surge detection can still find opportunities in volatile conditions
    if (volatility === 'EXTREME' && trend === 'SIDEWAYS') {
        tradingCondition = 'POOR';
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
 * Detect Price Gaps - quick opportunity spotting
 * Gaps often present immediate trading opportunities
 */
export function detectGap(candles: Candle[]): GapData {
    const noGap: GapData = {
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

    // Gap up: current open > previous high
    // Gap down: current open < previous low
    const gapUpSize = lastCandle.open - prevCandle.high;
    const gapDownSize = prevCandle.low - lastCandle.open;

    const gapUpPercent = (gapUpSize / prevCandle.close) * 100;
    const gapDownPercent = (gapDownSize / prevCandle.close) * 100;

    // Minimum gap threshold (0.5% to filter noise)
    const minGapPercent = 0.5;

    let hasGap = false;
    let gapType: GapData['gapType'] = 'NONE';
    let gapPercent = 0;
    let gapPrice = 0;

    if (gapUpPercent >= minGapPercent) {
        hasGap = true;
        gapType = 'GAP_UP';
        gapPercent = gapUpPercent;
        gapPrice = prevCandle.high;
    } else if (gapDownPercent >= minGapPercent) {
        hasGap = true;
        gapType = 'GAP_DOWN';
        gapPercent = gapDownPercent;
        gapPrice = prevCandle.low;
    }

    if (!hasGap) return noGap;

    // Check if gap has been filled
    let gapFilled = false;
    if (gapType === 'GAP_UP') {
        gapFilled = lastCandle.low <= prevCandle.high;
    } else if (gapType === 'GAP_DOWN') {
        gapFilled = lastCandle.high >= prevCandle.low;
    }

    // Check if breakaway gap (high volume = continuation signal)
    const avgVolume = candles.slice(-20, -1).reduce((sum, c) => sum + c.volume, 0) / 19;
    const isBreakawayGap = lastCandle.volume > avgVolume * 1.5;

    // Calculate fill probability
    // Larger gaps and breakaway gaps less likely to fill quickly
    let fillProbability = 70; // Base probability
    fillProbability -= gapPercent * 5; // Larger gaps less likely to fill
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
 * Calculate Opportunity Score - prioritize best trades
 * Combines all factors into a single score for ranking opportunities
 */
export function calculateOpportunityScore(
    candles: Candle[],
    ticker: string,
    srLevels: SRLevels
): OpportunityScore {
    const defaultScore: OpportunityScore = {
        ticker,
        compositeScore: 0,
        urgency: 'WAIT',
        confidence: 0,
        expectedReturn: 0,
        riskRewardRatio: 0,
        timeDecay: 50,
        factors: {
            trendAlignment: 0,
            momentumStrength: 0,
            volumeConfirmation: 0,
            priceLocation: 0,
            gapOpportunity: 0,
            multiTimeframeAlignment: 0
        }
    };

    if (candles.length < 50) return defaultScore;

    const currentPrice = candles[candles.length - 1].close;

    // Get cached indicators
    const cached = getCachedIndicators(candles);
    const tcValue = cached.tcSeries[cached.tcSeries.length - 1] || 50;
    const momentumValue = cached.momentumSeries[cached.momentumSeries.length - 1] || 50;
    const whaleValue = cached.whaleSeries[cached.whaleSeries.length - 1] || 50;
    const trendDashboard = cached.trendDashboard;
    const divergence = cached.divergence;

    // Detect market regime and gaps
    const regime = detectMarketRegime(candles);
    const gap = detectGap(candles);

    // Factor 1: Trend Alignment (0-100)
    // Lower TC = more bullish
    const trendAlignment = Math.max(0, 100 - tcValue);

    // Factor 2: Momentum Strength (0-100)
    const momentumStrength = momentumValue;

    // Factor 3: Volume Confirmation (0-100)
    const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
    const currentVolume = candles[candles.length - 1].volume;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    const volumeConfirmation = Math.min(100, volumeRatio * 50);

    // Factor 4: Price Location (0-100) - near support is better for longs
    let priceLocation = 50;
    if (srLevels.support && srLevels.resistance) {
        const range = srLevels.resistance - srLevels.support;
        if (range > 0) {
            const positionInRange = (currentPrice - srLevels.support) / range;
            // Lower position = better for longs (closer to support)
            priceLocation = Math.max(0, Math.min(100, (1 - positionInRange) * 100));
        }
    }

    // Factor 5: Gap Opportunity (0-100)
    let gapOpportunity = 0;
    if (gap.hasGap && !gap.gapFilled) {
        if (gap.gapType === 'GAP_UP' && gap.isBreakawayGap) {
            gapOpportunity = 80; // Bullish continuation
        } else if (gap.gapType === 'GAP_DOWN' && gap.fillProbability > 60) {
            gapOpportunity = 70; // Potential reversal/fill
        }
    }

    // Factor 6: Multi-indicator alignment (0-100)
    const multiTimeframeAlignment = (trendDashboard.score / 6) * 100;

    // Combine factors with weights
    const weights = {
        trendAlignment: 0.25,
        momentumStrength: 0.20,
        volumeConfirmation: 0.15,
        priceLocation: 0.15,
        gapOpportunity: 0.10,
        multiTimeframeAlignment: 0.15
    };

    const compositeScore =
        trendAlignment * weights.trendAlignment +
        momentumStrength * weights.momentumStrength +
        volumeConfirmation * weights.volumeConfirmation +
        priceLocation * weights.priceLocation +
        gapOpportunity * weights.gapOpportunity +
        multiTimeframeAlignment * weights.multiTimeframeAlignment;

    // Calculate confidence based on factor agreement
    const factors = [trendAlignment, momentumStrength, volumeConfirmation, multiTimeframeAlignment];
    const avgFactor = factors.reduce((a, b) => a + b, 0) / factors.length;
    const variance = factors.reduce((sum, f) => sum + Math.pow(f - avgFactor, 2), 0) / factors.length;
    const confidence = Math.max(0, 100 - Math.sqrt(variance));

    // Determine urgency
    let urgency: OpportunityScore['urgency'];
    if (compositeScore >= 75 && confidence >= 60) {
        urgency = 'IMMEDIATE';
    } else if (compositeScore >= 60 && confidence >= 50) {
        urgency = 'SOON';
    } else if (compositeScore >= 40) {
        urgency = 'WATCH';
    } else {
        urgency = 'WAIT';
    }

    // Estimate expected return based on ATR
    const atrValues = calculateATR(candles, 14);
    const currentATR = atrValues[atrValues.length - 1] || 0;
    const expectedReturn = currentPrice > 0 ? (currentATR / currentPrice) * 100 * 1.5 : 2;

    // Risk/Reward ratio
    const riskRewardRatio = srLevels.support && srLevels.resistance
        ? (srLevels.resistance - currentPrice) / (currentPrice - srLevels.support)
        : 1.5;

    // Time decay - how quickly opportunity diminishes
    // High momentum + low volatility = slower decay
    const timeDecay = Math.max(10, 100 - momentumStrength * 0.5 - (100 - regime.volatilityPercentile) * 0.3);

    return {
        ticker,
        compositeScore,
        urgency,
        confidence,
        expectedReturn,
        riskRewardRatio: Math.max(0.5, Math.min(5, riskRewardRatio)),
        timeDecay,
        factors: {
            trendAlignment,
            momentumStrength,
            volumeConfirmation,
            priceLocation,
            gapOpportunity,
            multiTimeframeAlignment
        }
    };
}

/**
 * Calculate Dynamic Trading Parameters
 * Adjusts trading parameters based on market conditions and session performance
 */
export function calculateDynamicParams(
    candles: Candle[],
    sessionAnalytics: SessionAnalytics,
    baseMaxTrades: number,
    baseRiskAmount: number,
    baseStopLoss: number
): DynamicTradingParams {
    const regime = detectMarketRegime(candles);

    let adjustedMaxTrades = baseMaxTrades;
    let adjustedRiskAmount = baseRiskAmount;
    let adjustedStopLoss = baseStopLoss;
    let aggressivenessLevel: DynamicTradingParams['aggressivenessLevel'] = 'MODERATE';
    const reasons: string[] = [];

    // Adjust based on market regime
    if (regime.tradingCondition === 'EXCELLENT') {
        adjustedMaxTrades = Math.min(baseMaxTrades + 2, 10);
        adjustedRiskAmount = Math.min(baseRiskAmount * 1.2, 1.0);
        reasons.push('Excellent conditions: increased exposure');
    } else if (regime.tradingCondition === 'GOOD') {
        adjustedMaxTrades = baseMaxTrades;
        reasons.push('Good conditions: normal trading');
    } else if (regime.tradingCondition === 'FAIR') {
        adjustedMaxTrades = Math.max(baseMaxTrades - 1, 2);
        adjustedRiskAmount = baseRiskAmount * 0.8;
        reasons.push('Fair conditions: reduced exposure');
    } else if (regime.tradingCondition === 'POOR' || regime.tradingCondition === 'AVOID') {
        adjustedMaxTrades = Math.max(baseMaxTrades - 2, 1);
        adjustedRiskAmount = baseRiskAmount * 0.5;
        adjustedStopLoss = baseStopLoss * 0.75; // Tighter stops
        reasons.push('Poor conditions: minimal exposure');
    }

    // Adjust based on volatility
    if (regime.volatility === 'HIGH' || regime.volatility === 'EXTREME') {
        adjustedStopLoss = baseStopLoss * 1.5; // Wider stops for volatility
        reasons.push('High volatility: wider stops');
    } else if (regime.volatility === 'LOW') {
        adjustedStopLoss = baseStopLoss * 0.75; // Tighter stops in calm markets
        reasons.push('Low volatility: tighter stops');
    }

    // Adjust based on session performance
    if (sessionAnalytics.winRate > 70 && sessionAnalytics.consecutiveWins >= 3) {
        adjustedMaxTrades = Math.min(adjustedMaxTrades + 1, 10);
        adjustedRiskAmount = Math.min(adjustedRiskAmount * 1.1, 1.0);
        aggressivenessLevel = 'AGGRESSIVE';
        reasons.push('Hot streak: increased aggressiveness');
    } else if (sessionAnalytics.consecutiveLosses >= 3) {
        adjustedMaxTrades = Math.max(adjustedMaxTrades - 1, 1);
        adjustedRiskAmount = adjustedRiskAmount * 0.7;
        aggressivenessLevel = 'CONSERVATIVE';
        reasons.push('Cold streak: reduced risk');
    }

    // Adjust based on session goal progress
    if (sessionAnalytics.isOnTrack === false && sessionAnalytics.recommendedAction === 'INCREASE_TRADES') {
        // Behind on goal, but only increase if conditions are favorable
        if (regime.tradingCondition === 'EXCELLENT' || regime.tradingCondition === 'GOOD') {
            adjustedMaxTrades = Math.min(adjustedMaxTrades + 1, 10);
            reasons.push('Behind goal: seeking more opportunities');
        }
    } else if (sessionAnalytics.recommendedAction === 'REDUCE_RISK') {
        adjustedRiskAmount = adjustedRiskAmount * 0.8;
        reasons.push('Protecting profits: reduced risk');
    }

    // Calculate market condition score (0-100)
    let marketConditionScore = 50;
    if (regime.tradingCondition === 'EXCELLENT') marketConditionScore = 90;
    else if (regime.tradingCondition === 'GOOD') marketConditionScore = 70;
    else if (regime.tradingCondition === 'FAIR') marketConditionScore = 50;
    else if (regime.tradingCondition === 'POOR') marketConditionScore = 30;
    else marketConditionScore = 10;

    // Determine overall aggressiveness
    if (adjustedRiskAmount >= baseRiskAmount * 1.1) {
        aggressivenessLevel = sessionAnalytics.consecutiveWins >= 5 ? 'ULTRA_AGGRESSIVE' : 'AGGRESSIVE';
    } else if (adjustedRiskAmount <= baseRiskAmount * 0.7) {
        aggressivenessLevel = 'CONSERVATIVE';
    }

    return {
        adjustedMaxTrades: Math.round(adjustedMaxTrades),
        adjustedRiskAmount: Math.round(adjustedRiskAmount * 100) / 100,
        adjustedStopLoss: Math.round(adjustedStopLoss * 10) / 10,
        aggressivenessLevel,
        reasonForAdjustment: reasons.join('; '),
        marketConditionScore
    };
}

/**
 * Calculate Session Analytics
 * Tracks session performance and recommends actions
 */
export function calculateSessionAnalytics(
    trades: Array<{ pnl?: number; time: number; type: string }>,
    sessionStartTime: number,
    sessionProfitGoal: number,
    currentPortfolioValue: number,
    initialBudget: number
): SessionAnalytics {
    const now = Date.now();
    const sessionDuration = now - sessionStartTime;
    const sessionHours = sessionDuration / (1000 * 60 * 60);

    // Calculate win/loss stats
    const sellTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);
    const wins = sellTrades.filter(t => (t.pnl || 0) > 0);
    const losses = sellTrades.filter(t => (t.pnl || 0) <= 0);
    const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;

    // Calculate consecutive wins/losses
    let consecutiveWins = 0;
    let consecutiveLosses = 0;
    for (let i = sellTrades.length - 1; i >= 0; i--) {
        if ((sellTrades[i].pnl || 0) > 0) {
            if (consecutiveLosses === 0) consecutiveWins++;
            else break;
        } else {
            if (consecutiveWins === 0) consecutiveLosses++;
            else break;
        }
    }

    // Calculate profit velocity
    const currentProfit = currentPortfolioValue - initialBudget;
    const profitVelocity = sessionHours > 0 ? currentProfit / sessionHours : 0;

    // Calculate required velocity to hit goal
    const profitRemaining = sessionProfitGoal - currentProfit;
    const estimatedHoursRemaining = 4; // Assume 4 hours for planning
    const requiredVelocity = profitRemaining > 0 ? profitRemaining / estimatedHoursRemaining : 0;

    // Estimate session length based on trading patterns
    let estimatedSessionLength: SessionAnalytics['estimatedSessionLength'] = 'MEDIUM';
    if (sessionDuration < 2 * 60 * 60 * 1000) {
        estimatedSessionLength = 'SHORT';
    } else if (sessionDuration > 6 * 60 * 60 * 1000) {
        estimatedSessionLength = 'LONG';
    }

    // Calculate avg trade time and trades per hour
    const avgTradeTime = sellTrades.length > 1
        ? (sellTrades[sellTrades.length - 1].time - sellTrades[0].time) / sellTrades.length
        : 0;
    const tradesPerHour = sessionHours > 0 ? sellTrades.length / sessionHours : 0;

    // Determine if on track
    const isOnTrack = profitVelocity >= requiredVelocity * 0.8;

    // Recommend action
    let recommendedAction: SessionAnalytics['recommendedAction'] = 'MAINTAIN';
    if (currentProfit >= sessionProfitGoal * 0.9) {
        recommendedAction = 'REDUCE_RISK'; // Protect profits near goal
    } else if (profitVelocity < requiredVelocity * 0.5 && winRate > 50) {
        recommendedAction = 'INCREASE_TRADES'; // Need more trades to catch up
    } else if (consecutiveLosses >= 4 || winRate < 40) {
        recommendedAction = 'STOP_TRADING'; // Cut losses
    }

    return {
        sessionStartTime,
        sessionDuration,
        estimatedSessionLength,
        profitVelocity,
        requiredVelocity,
        winRate,
        consecutiveWins,
        consecutiveLosses,
        avgTradeTime,
        tradesPerHour,
        isOnTrack,
        recommendedAction
    };
}

/**
 * Get best opportunities from watchlist
 * Returns tickers sorted by opportunity score
 */
export function rankOpportunities(
    watchlistData: Record<string, { candles: Candle[]; srLevels: SRLevels }>
): OpportunityScore[] {
    const opportunities: OpportunityScore[] = [];

    for (const [ticker, data] of Object.entries(watchlistData)) {
        if (data.candles.length > 50) {
            const score = calculateOpportunityScore(data.candles, ticker, data.srLevels);
            if (score.compositeScore > 30) { // Only include decent opportunities
                opportunities.push(score);
            }
        }
    }

    // Sort by composite score descending
    return opportunities.sort((a, b) => b.compositeScore - a.compositeScore);
}
