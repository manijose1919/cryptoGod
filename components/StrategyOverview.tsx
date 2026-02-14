
import React from 'react';
import type { WatchlistData, TradingStrategy } from '../types';
import { STRATEGY_INFO } from '../constants';

interface StrategyOverviewProps {
    data: WatchlistData[string] | null;
}

type Signal = {
    strategy: TradingStrategy;
    signal: 'Bullish' | 'Bearish' | 'Neutral';
    reason: string;
    confidence: number; // 0-100
};

const StrategyOverview: React.FC<StrategyOverviewProps> = ({ data }) => {
    if (!data || data.candles.length < 50) {
        return (
            <div className="bg-gray-800 p-4 rounded-lg">
                <h3 className="text-lg font-bold text-gray-300 mb-2">Strategy Overview</h3>
                <p className="text-sm text-gray-400">Insufficient data for strategy analysis.</p>
            </div>
        );
    }

    const signals: Signal[] = [];
    const currentPrice = data.candles[data.candles.length - 1].close;

    // 1. MA Crossover
    const ma50 = data.ma50[data.ma50.length - 1].value;
    const prevMa50 = data.ma50[data.ma50.length - 2].value;
    const ma200 = data.ma200[data.ma200.length - 1].value;
    const prevMa200 = data.ma200[data.ma200.length - 2].value;
    if (prevMa50 <= prevMa200 && ma50 > ma200) {
        signals.push({ strategy: 'MA_CROSSOVER', signal: 'Bullish', reason: 'Golden Cross (50/200)', confidence: 75 });
    } else if (prevMa50 >= prevMa200 && ma50 < ma200) {
        signals.push({ strategy: 'MA_CROSSOVER', signal: 'Bearish', reason: 'Death Cross (50/200)', confidence: 75 });
    } else {
        signals.push({ strategy: 'MA_CROSSOVER', signal: 'Neutral', reason: `Price ${currentPrice > ma200 ? '>' : '<'} MA200`, confidence: 50 });
    }

    // 2. Mean Reversion (Bollinger Bands)
    const upperBand = data.bollingerBands.upper[data.bollingerBands.upper.length - 1]?.value ?? 0;
    const lowerBand = data.bollingerBands.lower[data.bollingerBands.lower.length - 1]?.value ?? 0;
    if (currentPrice <= lowerBand) {
        signals.push({ strategy: 'MEAN_REVERSION', signal: 'Bullish', reason: 'Price at Lower Band', confidence: 70 });
    } else if (currentPrice >= upperBand) {
        signals.push({ strategy: 'MEAN_REVERSION', signal: 'Bearish', reason: 'Price at Upper Band', confidence: 70 });
    } else {
         signals.push({ strategy: 'MEAN_REVERSION', signal: 'Neutral', reason: 'Price within Bands', confidence: 50 });
    }
    
    // 3. VWAP
    const vwap = data.vwap[data.vwap.length - 1]?.value ?? 0;
    if (currentPrice > vwap) {
        signals.push({ strategy: 'VWAP', signal: 'Bullish', reason: `Price > VWAP (${Number(vwap).toFixed(2)})`, confidence: 60 });
    } else {
        signals.push({ strategy: 'VWAP', signal: 'Bearish', reason: `Price < VWAP (${Number(vwap).toFixed(2)})`, confidence: 60 });
    }

    // 4. Reversal (using Divergence)
    const divergence = data.divergenceData;
    if (divergence.type === 'bullish' && divergence.confidence > 50) {
        signals.push({ strategy: 'REVERSAL', signal: 'Bullish', reason: `Bullish Divergence (${Number(divergence.confidence).toFixed(0)}% conf)`, confidence: divergence.confidence });
    } else if (divergence.type === 'bearish' && divergence.confidence > 50) {
        signals.push({ strategy: 'REVERSAL', signal: 'Bearish', reason: `Bearish Divergence (${Number(divergence.confidence).toFixed(0)}% conf)`, confidence: divergence.confidence });
    } else {
        signals.push({ strategy: 'REVERSAL', signal: 'Neutral', reason: 'No divergence', confidence: 50 });
    }
    
    // 5. Range Trading (Support/Resistance)
    const { support, resistance } = data.srLevels;
    if (support && resistance) {
        const range = resistance - support;
        if (range > 0) {
            const proximityToSupport = Math.abs(currentPrice - support) / range;
            if (proximityToSupport < 0.1) { // Within 10% of support
                signals.push({ strategy: 'RANGE', signal: 'Bullish', reason: 'Near Support', confidence: 65 });
            } else {
                signals.push({ strategy: 'RANGE', signal: 'Neutral', reason: 'Mid-range', confidence: 50 });
            }
        } else {
             signals.push({ strategy: 'RANGE', signal: 'Neutral', reason: 'No clear range', confidence: 50 });
        }
    } else {
        signals.push({ strategy: 'RANGE', signal: 'Neutral', reason: 'No S/R levels', confidence: 50 });
    }


    const getSignalColor = (signal: 'Bullish' | 'Bearish' | 'Neutral') => {
        switch (signal) {
            case 'Bullish': return 'text-green-400';
            case 'Bearish': return 'text-red-400';
            default: return 'text-gray-400';
        }
    };

    return (
        <div className="bg-gray-800 p-4 rounded-lg">
            <h3 className="text-lg font-bold text-gray-300 mb-3">Strategy Overview</h3>
            <div className="space-y-2">
                {signals.map(s => (
                    <div key={s.strategy} className="grid grid-cols-3 items-center text-sm">
                        <span className="font-semibold text-gray-300 col-span-1">{STRATEGY_INFO[s.strategy]?.name || s.strategy}</span>
                        <span className={`font-bold text-center col-span-1 ${getSignalColor(s.signal)}`}>{s.signal}</span>
                         <span className="text-xs text-right text-gray-400 col-span-1">{s.reason}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default StrategyOverview;
