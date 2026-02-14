
import React from 'react';
import type { TrendDashboardData, AdaptiveData } from '../types';

interface SignalDisplayProps {
  trendDashboard?: TrendDashboardData;
  adaptiveData?: AdaptiveData | null;
}

export const SignalDisplay: React.FC<SignalDisplayProps> = ({ trendDashboard, adaptiveData }) => {
    const score = trendDashboard?.score ?? 0;
    const rsiValue = trendDashboard?.rsiValue ?? 50;

    let trendText = 'Neutral';
    let trendColor = 'text-yellow-400';
    if (score >= 5) { trendText = 'Strong Bullish'; trendColor = 'text-green-400 font-bold'; }
    else if (score >= 4) { trendText = 'Bullish'; trendColor = 'text-green-400'; }
    else if (score <= 1) { trendText = 'Strong Bearish'; trendColor = 'text-red-400 font-bold'; }
    else if (score <= 2) { trendText = 'Bearish'; trendColor = 'text-red-400'; }

    const adaptiveDirection = adaptiveData?.direction ?? 'NEUTRAL';
    const adaptiveColor = adaptiveDirection === 'PUMP' ? 'text-green-400' : adaptiveDirection === 'DROP' ? 'text-red-400' : 'text-yellow-400';

    return (
        <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-xl border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Signal Display</h3>
            <div className="space-y-3">
                <div className="text-center">
                    <p className="text-xs text-gray-500 uppercase">Trend Confluence</p>
                    <p className={`text-xl font-semibold ${trendColor}`}>{trendText} ({score}/6)</p>
                    <p className="text-xs text-gray-500">RSI: {rsiValue?.toFixed(1) ?? 'N/A'}</p>
                </div>
                <div className="text-center border-t border-gray-700 pt-3">
                    <p className="text-xs text-gray-500 uppercase">Adaptive Signal</p>
                    {adaptiveData ? (
                        <>
                            <p className={`text-xl font-semibold ${adaptiveColor}`}>{adaptiveData.probabilityText}</p>
                            <p className="text-xs text-gray-500">
                                {adaptiveData.assetParams?.description ?? ''} | Conf: {adaptiveData.confidence?.toFixed(0) ?? 0}%
                            </p>
                        </>
                    ) : (
                        <p className="text-lg text-gray-500">Awaiting data...</p>
                    )}
                </div>
            </div>
        </div>
    );
};
