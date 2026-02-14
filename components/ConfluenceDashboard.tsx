
import React from 'react';
import type { SignalScore } from '../types';

interface ConfluenceDashboardProps {
  trendScore: number;
  breakoutValue: number;
  whaleValue: number;
  momentumValue: number;
  signalScore?: SignalScore;
}

const IndicatorBar: React.FC<{ label: string; value: number; maxValue: number; inverted?: boolean }> = ({ label, value, maxValue, inverted }) => {
    const normalizedValue = Math.min(100, Math.max(0, (value / maxValue) * 100));
    const effectiveValue = inverted ? 100 - normalizedValue : normalizedValue;
    let color = 'bg-gray-500';
    if (effectiveValue > 66) color = 'bg-green-500';
    else if (effectiveValue > 33) color = 'bg-yellow-500';
    else color = 'bg-red-500';

    return (
        <div className="space-y-1">
            <div className="flex justify-between text-xs">
                <span className="text-gray-400">{label}</span>
                <span className="text-gray-300 font-mono">{Number(value).toFixed(1)}</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
                <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${normalizedValue}%` }}></div>
            </div>
        </div>
    );
};

export const ConfluenceDashboard: React.FC<ConfluenceDashboardProps> = ({
    trendScore, breakoutValue, whaleValue, momentumValue, signalScore
}) => {
    const overall = signalScore?.overall ?? 0;
    const confidence = signalScore?.confidence ?? 0;
    const overallColor = overall > 20 ? 'text-green-400' : overall < -20 ? 'text-red-400' : 'text-yellow-400';
    const overallText = overall > 50 ? 'Strong Buy' : overall > 20 ? 'Buy' : overall < -50 ? 'Strong Sell' : overall < -20 ? 'Sell' : 'Neutral';

    return (
        <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-xl border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Confluence Dashboard</h3>
            <div className="space-y-2">
                <IndicatorBar label="Trend Score" value={trendScore} maxValue={6} />
                <IndicatorBar label="Breakout" value={breakoutValue} maxValue={100} inverted />
                <IndicatorBar label="Whale Flow" value={whaleValue} maxValue={100} />
                <IndicatorBar label="Momentum" value={momentumValue} maxValue={100} />
            </div>
            <div className="mt-3 pt-3 border-t border-gray-700 text-center">
                <span className={`text-lg font-bold ${overallColor}`}>{overallText}</span>
                <span className="text-xs text-gray-500 ml-2">(Conf: {confidence.toFixed(0)}%)</span>
            </div>
        </div>
    );
};
