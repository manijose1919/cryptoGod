
import React from 'react';
import type { AdaptiveData, CorrelationData } from '../types';

interface AdaptiveDashboardProps {
    adaptiveData: AdaptiveData;
    ticker: string;
    correlations?: CorrelationData[];
    marketSentiment?: number;
}

const getDirectionColor = (direction: 'PUMP' | 'DROP' | 'NEUTRAL'): string => {
    switch (direction) {
        case 'PUMP': return 'text-green-400';
        case 'DROP': return 'text-red-400';
        default: return 'text-yellow-400';
    }
};

const getDirectionBg = (direction: 'PUMP' | 'DROP' | 'NEUTRAL'): string => {
    switch (direction) {
        case 'PUMP': return 'bg-green-500/20 border-green-500/50';
        case 'DROP': return 'bg-red-500/20 border-red-500/50';
        default: return 'bg-yellow-500/20 border-yellow-500/50';
    }
};

const getVolatilityColor = (volatility: 'LOW' | 'MEDIUM' | 'HIGH'): string => {
    switch (volatility) {
        case 'LOW': return 'text-blue-400';
        case 'MEDIUM': return 'text-yellow-400';
        case 'HIGH': return 'text-orange-400';
    }
};

const getCorrelationColor = (strength: CorrelationData['strength']): string => {
    switch (strength) {
        case 'STRONG_POSITIVE': return 'text-green-400';
        case 'MODERATE_POSITIVE': return 'text-green-300';
        case 'WEAK': return 'text-gray-400';
        case 'MODERATE_NEGATIVE': return 'text-red-300';
        case 'STRONG_NEGATIVE': return 'text-red-400';
    }
};

export const AdaptiveDashboard: React.FC<AdaptiveDashboardProps> = ({
    adaptiveData,
    ticker,
    correlations = [],
    marketSentiment = 0
}) => {
    const assetName = ticker.replace('USDC', '').replace('USD', '');

    // Find correlations involving this ticker
    const relevantCorrelations = correlations
        .filter(c => c.asset1 === ticker || c.asset2 === ticker)
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
        .slice(0, 5);

    return (
        <div className="glass-card p-4 animate-fade-up">
            <h3 className="text-lg font-semibold gradient-header mb-4">
                Adaptive TC Analysis
                <span className="text-cyan-400 ml-2">{assetName}</span>
            </h3>

            {/* Main Probability Display */}
            <div className={`rounded-xl p-4 border ${getDirectionBg(adaptiveData.direction)} mb-4`}>
                <div className="text-center">
                    <div className={`text-3xl font-bold ${getDirectionColor(adaptiveData.direction)}`}>
                        {adaptiveData.probabilityText}
                    </div>
                    <div className="text-sm text-gray-400 mt-1">
                        TC Value: {Number(adaptiveData.tcValue).toFixed(1)} | Confidence: {Number(adaptiveData.confidence).toFixed(0)}%
                    </div>
                </div>

                {/* Probability Bar */}
                <div className="mt-4">
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Bullish (0)</span>
                        <span>Neutral (50)</span>
                        <span>Bearish (100)</span>
                    </div>
                    <div className="h-3 bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 rounded-full relative">
                        <div
                            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full border-2 border-gray-900 shadow-lg"
                            style={{ left: `calc(${adaptiveData.tcValue}% - 8px)` }}
                        />
                    </div>
                </div>
            </div>

            {/* Asset Parameters */}
            <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-gray-700/50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">Asset Profile</div>
                    <div className="text-sm font-medium text-white">
                        {adaptiveData.assetParams.description}
                    </div>
                    <div className={`text-xs ${getVolatilityColor(adaptiveData.assetParams.volatility)}`}>
                        {adaptiveData.assetParams.volatility} Volatility
                    </div>
                </div>
                <div className="bg-gray-700/50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">Adaptive Parameters</div>
                    <div className="text-sm text-white">
                        Lookback: <span className="text-cyan-400">{adaptiveData.assetParams.lookback}</span>
                    </div>
                    <div className="text-sm text-white">
                        Noise Filter: <span className="text-cyan-400">{adaptiveData.assetParams.noiseFilter}x</span>
                    </div>
                </div>
            </div>

            {/* Market Sentiment */}
            <div className="bg-gray-700/50 rounded-lg p-3 mb-4">
                <div className="flex justify-between items-center">
                    <div className="text-xs text-gray-400">Overall Market Sentiment</div>
                    <div className={`text-sm font-medium ${
                        marketSentiment > 20 ? 'text-green-400' :
                        marketSentiment < -20 ? 'text-red-400' : 'text-yellow-400'
                    }`}>
                        {marketSentiment > 20 ? 'Bullish' :
                         marketSentiment < -20 ? 'Bearish' : 'Neutral'}
                        ({marketSentiment.toFixed(1)})
                    </div>
                </div>
                <div className="mt-2 h-2 bg-gray-600 rounded-full overflow-hidden">
                    <div
                        className={`h-full transition-all ${
                            marketSentiment > 0 ? 'bg-green-500' : 'bg-red-500'
                        }`}
                        style={{
                            width: `${Math.abs(marketSentiment)}%`,
                            marginLeft: marketSentiment > 0 ? '50%' : `${50 - Math.abs(marketSentiment)}%`
                        }}
                    />
                </div>
            </div>

            {/* Correlations */}
            {relevantCorrelations.length > 0 && (
                <div className="bg-gray-700/50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-2">Correlated Assets</div>
                    <div className="space-y-1">
                        {relevantCorrelations.map((corr, idx) => {
                            const otherAsset = corr.asset1 === ticker ? corr.asset2 : corr.asset1;
                            return (
                                <div key={idx} className="flex justify-between items-center text-sm">
                                    <span className="text-white">
                                        {otherAsset.replace('USDC', '').replace('USD', '')}
                                    </span>
                                    <span className={getCorrelationColor(corr.strength)}>
                                        {(corr.correlation * 100).toFixed(0)}% {corr.strength.replace('_', ' ').toLowerCase()}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Signal Interpretation */}
            <div className="mt-4 p-3 bg-gray-900/50 rounded-lg">
                <div className="text-xs text-gray-400 mb-1">Signal Interpretation</div>
                <p className="text-sm text-gray-300">
                    {adaptiveData.direction === 'PUMP' && adaptiveData.probabilityPercent >= 70 && (
                        <>Strong bullish signal. Consider long positions with appropriate risk management.</>
                    )}
                    {adaptiveData.direction === 'PUMP' && adaptiveData.probabilityPercent < 70 && (
                        <>Moderate bullish bias. Look for confirmation from other indicators before entry.</>
                    )}
                    {adaptiveData.direction === 'DROP' && adaptiveData.probabilityPercent >= 70 && (
                        <>Strong bearish signal. Consider reducing exposure or waiting for reversal.</>
                    )}
                    {adaptiveData.direction === 'DROP' && adaptiveData.probabilityPercent < 70 && (
                        <>Moderate bearish bias. Monitor for potential trend reversal.</>
                    )}
                    {adaptiveData.direction === 'NEUTRAL' && (
                        <>Market indecision. Wait for clearer directional signal before taking positions.</>
                    )}
                </p>
            </div>
        </div>
    );
};
