
import { EventEmitter } from 'events';

// 10 Trading Methods Configuration & Logic
export const STRATEGIES = {
    MOMENTUM: { name: 'Momentum', type: 'FAST' },
    SCALPING: { name: 'Scalping', type: 'FAST' },
    BREAKOUT: { name: 'Breakout', type: 'FAST' },
    GAP: { name: 'Gap', type: 'FAST' },
    TREND: { name: 'Trend Following', type: 'HYBRID' },
    RANGE: { name: 'Range Trading', type: 'SLOW' },
    PRICE_ACTION: { name: 'Price Action', type: 'ALL' },
    PULLBACK: { name: 'Pullback', type: 'SLOW' },
    PIVOT: { name: 'Pivot Points', type: 'SLOW' },
    VWAP: { name: 'VWAP', type: 'ALL' },
};

/**
 * Strategy Engine
 * Evaluates market data against the 10 defined strategies.
 */
export class StrategyEngine extends EventEmitter {
    constructor() {
        super();
        this.results = new Map(); // ticker -> { strategy: 'BUY'/'SELL' }
    }

    /**
     * Run all strategies on a given set of candles
     * @param {string} ticker
     * @param {Array} candles - OHLCV data ({o, h, l, c, v} or {open, high, low, close, volume})
     * @param {Object} context - Optional extras (sentiment, level 2 data, vwap, dailyCandles)
     */
    evaluate(ticker, candles, context = {}) {
        if (!candles || candles.length < 50) return [];

        const signals = [];
        const c = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const currentPrice = c.c ?? c.close;
        const previousClose = prev.c ?? prev.close;

        const indicators = this.calculateIndicators(candles);

        // 1. Momentum Trading
        if (indicators.adx > 25) {
            if (indicators.rsi > 50 && indicators.rsi < 70 && currentPrice > indicators.ema20) {
                signals.push({ strategy: 'MOMENTUM', action: 'BUY', confidence: 0.8, reason: 'Strong ADX + EMA Trend' });
            }
            if (indicators.rsi < 50 && indicators.rsi > 30 && currentPrice < indicators.ema20) {
                signals.push({ strategy: 'MOMENTUM', action: 'SELL', confidence: 0.75, reason: 'Strong ADX + Bearish Momentum' });
            }
        }

        // 2. Scalping (High Volatility)
        if (indicators.atrPercent > 1.5) {
             if (currentPrice < indicators.bbLower) {
                 signals.push({ strategy: 'SCALPING', action: 'BUY', confidence: 0.6, reason: 'BB Lower Bounce (High Vol)' });
             }
             if (currentPrice > indicators.bbUpper) {
                 signals.push({ strategy: 'SCALPING', action: 'SELL', confidence: 0.6, reason: 'BB Upper Rejection (High Vol)' });
             }
        }

        // 3. Breakout Trading
        const lastVol = (c.v ?? c.volume);
        if (currentPrice > indicators.resistance20 && lastVol > indicators.avgVolume * 1.5) {
            signals.push({ strategy: 'BREAKOUT', action: 'BUY', confidence: 0.9, reason: '20-period High Breakout + Volume' });
        }
        if (currentPrice < indicators.support20 && lastVol > indicators.avgVolume * 1.5) {
            signals.push({ strategy: 'BREAKOUT', action: 'SELL', confidence: 0.85, reason: '20-period Low Breakdown + Volume' });
        }

        // 4. Trend Following
        if (currentPrice > indicators.ema50 && indicators.ema20 > indicators.ema50) {
             signals.push({ strategy: 'TREND', action: 'BUY', confidence: 0.7, reason: 'Golden Cross / Uptrend' });
        }
        if (currentPrice < indicators.ema50 && indicators.ema20 < indicators.ema50) {
             signals.push({ strategy: 'TREND', action: 'SELL', confidence: 0.7, reason: 'Death Cross / Downtrend' });
        }

        // 5. Range Trading
        if (indicators.adx < 20) {
            if (currentPrice <= indicators.support20 * 1.01) {
                signals.push({ strategy: 'RANGE', action: 'BUY', confidence: 0.7, reason: 'Range Support Bounce' });
            }
            if (currentPrice >= indicators.resistance20 * 0.99) {
                signals.push({ strategy: 'RANGE', action: 'SELL', confidence: 0.7, reason: 'Range Resistance Rejection' });
            }
        }

        // 6. Pullback/Fade
        if (indicators.trend === 'UP' && currentPrice < indicators.ema20 && currentPrice > indicators.ema50) {
             signals.push({ strategy: 'PULLBACK', action: 'BUY', confidence: 0.75, reason: 'Uptrend Pullback to EMA zone' });
        }
        if (indicators.trend === 'DOWN' && currentPrice > indicators.ema20 && currentPrice < indicators.ema50) {
             signals.push({ strategy: 'PULLBACK', action: 'SELL', confidence: 0.7, reason: 'Downtrend Rally to EMA zone' });
        }

        // 7. Pivot Points
        const pivots = this.calculatePivots(candles);
        if (pivots) {
            if (currentPrice <= pivots.s1 * 1.005 && currentPrice >= pivots.s1 * 0.995) {
                signals.push({ strategy: 'PIVOT', action: 'BUY', confidence: 0.65, reason: `Near Pivot S1 (${pivots.s1.toFixed(2)})` });
            }
            if (currentPrice <= pivots.s2 * 1.005 && currentPrice >= pivots.s2 * 0.995) {
                signals.push({ strategy: 'PIVOT', action: 'BUY', confidence: 0.75, reason: `Near Pivot S2 (${pivots.s2.toFixed(2)})` });
            }
            if (currentPrice >= pivots.r1 * 0.995 && currentPrice <= pivots.r1 * 1.005) {
                signals.push({ strategy: 'PIVOT', action: 'SELL', confidence: 0.65, reason: `Near Pivot R1 (${pivots.r1.toFixed(2)})` });
            }
            if (currentPrice >= pivots.r2 * 0.995 && currentPrice <= pivots.r2 * 1.005) {
                signals.push({ strategy: 'PIVOT', action: 'SELL', confidence: 0.75, reason: `Near Pivot R2 (${pivots.r2.toFixed(2)})` });
            }
        }

        // 8. VWAP Trading
        if (context.vwap) {
            if (currentPrice > context.vwap && previousClose < context.vwap) {
                 signals.push({ strategy: 'VWAP', action: 'BUY', confidence: 0.65, reason: 'VWAP Crossover Up' });
            }
            if (currentPrice < context.vwap && previousClose > context.vwap) {
                 signals.push({ strategy: 'VWAP', action: 'SELL', confidence: 0.65, reason: 'VWAP Crossover Down' });
            }
        }

        // 9. Price Action (Candlestick Patterns)
        const lastCandle = candles[candles.length - 1];
        const isHammer = this.detectHammer(lastCandle);
        if (isHammer && indicators.trend === 'DOWN') {
             signals.push({ strategy: 'PRICE_ACTION', action: 'BUY', confidence: 0.6, reason: 'Bullish Hammer' });
        }
        const isBearishEngulfing = this.detectBearishEngulfing(candles[candles.length - 2], lastCandle);
        if (isBearishEngulfing && indicators.trend === 'UP') {
             signals.push({ strategy: 'PRICE_ACTION', action: 'SELL', confidence: 0.65, reason: 'Bearish Engulfing' });
        }
        const isBullishEngulfing = this.detectBullishEngulfing(candles[candles.length - 2], lastCandle);
        if (isBullishEngulfing && indicators.trend === 'DOWN') {
             signals.push({ strategy: 'PRICE_ACTION', action: 'BUY', confidence: 0.65, reason: 'Bullish Engulfing' });
        }

        // 10. Gap Trading
        const gapData = this.detectGap(candles, context.dailyCandles);
        if (gapData) {
            if (gapData.type === 'GAP_UP' && gapData.gapPercent > 0.5) {
                // Gap-and-go: if price holds above gap, ride it
                if (currentPrice > gapData.gapOpen) {
                    signals.push({ strategy: 'GAP', action: 'BUY', confidence: 0.7, reason: `Gap Up ${gapData.gapPercent.toFixed(1)}% - Gap & Go` });
                }
                // Gap fill trade: short if price starts filling
                if (currentPrice < gapData.gapOpen && currentPrice > gapData.prevClose) {
                    signals.push({ strategy: 'GAP', action: 'SELL', confidence: 0.6, reason: `Gap Up ${gapData.gapPercent.toFixed(1)}% - Gap Fill` });
                }
            }
            if (gapData.type === 'GAP_DOWN' && gapData.gapPercent > 0.5) {
                if (currentPrice < gapData.gapOpen) {
                    signals.push({ strategy: 'GAP', action: 'SELL', confidence: 0.7, reason: `Gap Down ${gapData.gapPercent.toFixed(1)}% - Gap & Go` });
                }
                if (currentPrice > gapData.gapOpen && currentPrice < gapData.prevClose) {
                    signals.push({ strategy: 'GAP', action: 'BUY', confidence: 0.6, reason: `Gap Down ${gapData.gapPercent.toFixed(1)}% - Gap Fill` });
                }
            }
        }

        return signals;
    }

    // --- Helpers ---

    calculateIndicators(candles) {
        const closes = candles.map(c => c.c ?? c.close);
        const highs = candles.map(c => c.h ?? c.high);
        const lows = candles.map(c => c.l ?? c.low);
        const volumes = candles.map(c => c.v ?? c.volume);

        const len = closes.length;
        const ema20 = this.ema(closes, 20);
        const ema50 = this.ema(closes, 50);
        const sma20 = this.sma(closes, 20);

        // Bollinger Bands
        const stdDev = this.stdDev(closes.slice(-20));
        const bbUpper = sma20 + (stdDev * 2);
        const bbLower = sma20 - (stdDev * 2);

        // Support/Resistance (Simple 20-period Donchian)
        const resistance20 = Math.max(...highs.slice(-20));
        const support20 = Math.min(...lows.slice(-20));

        // ATR (Simplified)
        const trs = [];
        for(let i=1; i<Math.min(20, len); i++) {
            const idx = len - i;
            trs.push(Math.max(highs[idx] - lows[idx], Math.abs(highs[idx] - closes[idx-1]), Math.abs(lows[idx] - closes[idx-1])));
        }
        const atr = trs.length > 0 ? trs.reduce((a,b)=>a+b,0) / trs.length : 0;

        // RSI
        const rsi = this.rsi(closes, 14);

        // Real ADX calculation
        const adx = this.calculateADX(highs, lows, closes, 14);

        return {
            ema20, ema50, sma20, bbUpper, bbLower,
            resistance20, support20,
            atr, atrPercent: closes[len-1] > 0 ? (atr / closes[len-1]) * 100 : 0,
            rsi, adx,
            avgVolume: volumes.slice(-20).reduce((a,b)=>a+b,0)/20,
            trend: ema20 > ema50 ? 'UP' : 'DOWN'
        };
    }

    /**
     * Real ADX calculation using +DI/-DI
     */
    calculateADX(highs, lows, closes, period = 14) {
        const len = highs.length;
        if (len < period + 1) return 25; // fallback

        const plusDM = [];
        const minusDM = [];
        const tr = [];

        for (let i = 1; i < len; i++) {
            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            tr.push(Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            ));
        }

        if (tr.length < period) return 25;

        // Wilder smoothing
        let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

        const dx = [];

        for (let i = period; i < tr.length; i++) {
            smoothTR = smoothTR - (smoothTR / period) + tr[i];
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];

            const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
            const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
            const diSum = plusDI + minusDI;
            dx.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
        }

        if (dx.length < period) return dx.length > 0 ? dx[dx.length - 1] : 25;

        // Smooth DX to get ADX
        let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < dx.length; i++) {
            adx = ((adx * (period - 1)) + dx[i]) / period;
        }

        return adx;
    }

    /**
     * Classic Pivot Points: PP = (H + L + C) / 3
     * Uses the most recent ~20 candles as the "session" for H/L/C
     */
    calculatePivots(candles) {
        if (candles.length < 20) return null;

        // Use previous 20 candles as the "session" to derive H/L/C
        const sessionCandles = candles.slice(-21, -1); // Exclude current candle
        const sessionHigh = Math.max(...sessionCandles.map(c => c.h ?? c.high));
        const sessionLow = Math.min(...sessionCandles.map(c => c.l ?? c.low));
        const sessionClose = (sessionCandles[sessionCandles.length - 1].c ?? sessionCandles[sessionCandles.length - 1].close);

        const pp = (sessionHigh + sessionLow + sessionClose) / 3;
        return {
            pp,
            r1: (2 * pp) - sessionLow,
            r2: pp + (sessionHigh - sessionLow),
            s1: (2 * pp) - sessionHigh,
            s2: pp - (sessionHigh - sessionLow),
        };
    }

    /**
     * Gap detection: compares current candle open vs previous candle close
     */
    detectGap(candles, dailyCandles) {
        // Use daily candles if available, otherwise use intraday
        const source = dailyCandles && dailyCandles.length >= 2 ? dailyCandles : candles;
        if (source.length < 2) return null;

        const current = source[source.length - 1];
        const previous = source[source.length - 2];
        const currentOpen = current.o ?? current.open;
        const prevClose = previous.c ?? previous.close;

        if (prevClose === 0) return null;
        const gapPercent = ((currentOpen - prevClose) / prevClose) * 100;

        if (Math.abs(gapPercent) < 0.3) return null; // Minimum gap threshold

        return {
            type: gapPercent > 0 ? 'GAP_UP' : 'GAP_DOWN',
            gapPercent: Math.abs(gapPercent),
            gapOpen: currentOpen,
            prevClose,
        };
    }

    detectHammer(candle) {
        const o = candle.o ?? candle.open;
        const c = candle.c ?? candle.close;
        const h = candle.h ?? candle.high;
        const l = candle.l ?? candle.low;
        const body = Math.abs(c - o);
        const lowerWick = Math.min(c, o) - l;
        const upperWick = h - Math.max(c, o);
        return lowerWick > (body * 2) && upperWick < body;
    }

    detectBearishEngulfing(prev, curr) {
        const prevO = prev.o ?? prev.open;
        const prevC = prev.c ?? prev.close;
        const currO = curr.o ?? curr.open;
        const currC = curr.c ?? curr.close;
        return prevC > prevO && currO > prevC && currC < prevO; // prev green, curr red engulfs
    }

    detectBullishEngulfing(prev, curr) {
        const prevO = prev.o ?? prev.open;
        const prevC = prev.c ?? prev.close;
        const currO = curr.o ?? curr.open;
        const currC = curr.c ?? curr.close;
        return prevO > prevC && currO < prevC && currC > prevO; // prev red, curr green engulfs
    }

    sma(data, period) {
        if (data.length < period) return data[data.length-1];
        return data.slice(-period).reduce((a,b) => a+b, 0) / period;
    }

    ema(data, period) {
        if (data.length < period) return data[data.length-1];
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    stdDev(data) {
        const mean = data.reduce((a,b)=>a+b,0) / data.length;
        const sqDiffs = data.map(v => Math.pow(v - mean, 2));
        return Math.sqrt(sqDiffs.reduce((a,b)=>a+b,0) / data.length);
    }

    rsi(data, period) {
        if (data.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = data.length - period; i < data.length; i++) {
            const change = data[i] - data[i-1];
            if (change > 0) gains += change;
            else losses -= change;
        }
        if (losses === 0) return 100;
        const rs = gains / losses;
        return 100 - (100 / (1 + rs));
    }
}
