
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
     * @param {Array} candles - OHLCV data
     * @param {Object} context - Optional extras (sentiment, level 2 data)
     */
    evaluate(ticker, candles, context = {}) {
        if (!candles || candles.length < 50) return [];

        const signals = [];
        const currentPrice = candles[candles.length - 1].c;
        const previousClose = candles[candles.length - 2].c; // Previous day close for Gap? No, previous candle.
        // For Gap, we need daily candles or explicit previous session close.
        
        const indicators = this.calculateIndicators(candles);

        // 1. Momentum Trading
        // IF trend_strength == high THEN enter_direction
        if (indicators.adx > 25) {
            if (indicators.rsi > 50 && indicators.rsi < 70 && currentPrice > indicators.ema20) {
                signals.push({ strategy: 'MOMENTUM', action: 'BUY', confidence: 0.8, reason: 'Strong ADX + EMA Trend' });
            }
        }

        // 2. Scalping (High Volatility)
        // WHILE volatility > high DO multiple_micro_trades
        if (indicators.atrPercent > 1.5) { // High ATR relative to price
             // Logic: Simple mean reversion on Bollinger Bands for scalping
             if (currentPrice < indicators.bbLower) {
                 signals.push({ strategy: 'SCALPING', action: 'BUY', confidence: 0.6, reason: 'BB Lower Bounce (High Vol)' });
             }
        }

        // 3. Breakout Trading
        // IF price > resistance AND volume > avg THEN buy
        if (currentPrice > indicators.resistance20 && candles[candles.length - 1].v > indicators.avgVolume * 1.5) {
            signals.push({ strategy: 'BREAKOUT', action: 'BUY', confidence: 0.9, reason: '20-period High Breakout + Volume' });
        }

        // 4. Trend Following
        // Riding momentum
        if (currentPrice > indicators.ema50 && indicators.ema20 > indicators.ema50) {
             signals.push({ strategy: 'TREND', action: 'BUY', confidence: 0.7, reason: 'Golden Cross / Uptrend' });
        }

        // 5. Range Trading
        // IF price == support THEN buy
        if (indicators.adx < 20) { // Low trend = Ranging
            if (currentPrice <= indicators.support20 * 1.01) {
                signals.push({ strategy: 'RANGE', action: 'BUY', confidence: 0.7, reason: 'Range Support Bounce' });
            }
        }

        // 6. Pullback/Fade
        // Entering when stock briefly moves against trend
        if (indicators.trend === 'UP' && currentPrice < indicators.ema20 && currentPrice > indicators.ema50) {
             signals.push({ strategy: 'PULLBACK', action: 'BUY', confidence: 0.75, reason: 'Uptrend Pullback to EMA zone' });
        }

        // 7. Pivot Points (Intraday reversals)
        // Check if price is near S1/R1
        // (Simplified Pivot calc based on H/L/C of recent window)
        // Logic omitted for brevity, usually requires Daily candles passed in context

        // 8. VWAP Trading
        // Using VWAP as benchmark
        if (context.vwap) {
            if (currentPrice > context.vwap && previousClose < context.vwap) {
                 signals.push({ strategy: 'VWAP', action: 'BUY', confidence: 0.65, reason: 'VWAP Crossover' });
            }
        }

        // 9. Price Action (Candlestick Patterns)
        // e.g. Hammer, Engulfing
        const isHammer = this.detectHammer(candles[candles.length - 1]);
        if (isHammer && indicators.trend === 'DOWN') {
             signals.push({ strategy: 'PRICE_ACTION', action: 'BUY', confidence: 0.6, reason: 'Bullish Hammer' });
        }

        // 10. Gap Trading
        // IF open_price != prev_close_price
        // Needs daily context usually.
        
        return signals;
    }

    // --- Helpers ---

    calculateIndicators(candles) {
        const closes = candles.map(c => c.c);
        const highs = candles.map(c => c.h);
        const lows = candles.map(c => c.l);
        const volumes = candles.map(c => c.v);
        
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
        for(let i=1; i<20; i++) {
            const idx = len - i;
            trs.push(Math.max(highs[idx] - lows[idx], Math.abs(highs[idx] - closes[idx-1]), Math.abs(lows[idx] - closes[idx-1])));
        }
        const atr = trs.reduce((a,b)=>a+b,0) / trs.length;

        // RSI
        const rsi = this.rsi(closes, 14);

        // ADX (Simplified approximation or placeholder)
        const adx = 25; // Placeholder for full ADX calc

        return {
            ema20, ema50, bbUpper, bbLower,
            resistance20, support20,
            atr, atrPercent: (atr / closes[len-1]) * 100,
            rsi, adx,
            avgVolume: volumes.slice(-20).reduce((a,b)=>a+b,0)/20,
            trend: ema20 > ema50 ? 'UP' : 'DOWN'
        };
    }

    detectHammer(candle) {
        const body = Math.abs(candle.c - candle.o);
        const lowerWick = Math.min(candle.c, candle.o) - candle.l;
        const upperWick = candle.h - Math.max(candle.c, candle.o);
        return lowerWick > (body * 2) && upperWick < body;
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
