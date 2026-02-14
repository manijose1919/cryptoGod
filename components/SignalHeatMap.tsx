
import React, { useMemo } from 'react';
import type { WatchlistData } from '../types';
import { HEAT_MAP_COLORS } from '../constants';

interface SignalHeatMapProps {
    watchlistData: WatchlistData;
}

const getHeatMapColor = (score: number): string => {
    if (score >= 50) return HEAT_MAP_COLORS.EXTREME_BULLISH;
    if (score >= 30) return HEAT_MAP_COLORS.STRONG_BULLISH;
    if (score >= 10) return HEAT_MAP_COLORS.MODERATE_BULLISH;
    if (score >= -10) return HEAT_MAP_COLORS.NEUTRAL;
    if (score >= -30) return HEAT_MAP_COLORS.MODERATE_BEARISH;
    if (score >= -50) return HEAT_MAP_COLORS.STRONG_BEARISH;
    return HEAT_MAP_COLORS.EXTREME_BEARISH;
};

export const SignalHeatMap: React.FC<SignalHeatMapProps> = ({ watchlistData }) => {
    const entries = useMemo(() => {
        if (!watchlistData) return [];
        return Object.entries(watchlistData).map(([ticker, data]) => {
            const lastIndicator = data.indicatorData?.[data.indicatorData.length - 1]?.value ?? 50;
            const lastMomentum = data.momentumData?.[data.momentumData.length - 1]?.value ?? 50;
            const lastWhale = data.whaleData?.[data.whaleData.length - 1]?.value ?? 50;
            // Derive a simple score: momentum above 50 = bullish, indicator below 50 = bullish
            const score = ((lastMomentum - 50) + (50 - lastIndicator) + (lastWhale - 50)) / 3 * 2;
            return { ticker, score: Math.max(-100, Math.min(100, score)), momentum: lastMomentum };
        }).sort((a, b) => b.score - a.score);
    }, [watchlistData]);

    if (entries.length === 0) {
        return (
            <div className="glass-card p-4 animate-fade-up">
                <h3 className="text-lg font-semibold gradient-header mb-3">Signal Heat Map</h3>
                <p className="text-gray-400 text-center py-4">Loading market data...</p>
            </div>
        );
    }

    return (
        <div className="glass-card p-4 animate-fade-up">
            <h3 className="text-lg font-semibold gradient-header mb-3">
                Signal Heat Map
                <span className="text-sm font-normal text-gray-400 ml-2">
                    ({entries.length} assets)
                </span>
            </h3>

            <div className="flex items-center justify-center gap-2 mb-4 text-xs">
                <span className="text-gray-400">Bearish</span>
                <div className="flex gap-0.5">
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.EXTREME_BEARISH }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.STRONG_BEARISH }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.MODERATE_BEARISH }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.NEUTRAL }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.MODERATE_BULLISH }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.STRONG_BULLISH }}></div>
                    <div className="w-4 h-3 rounded" style={{ backgroundColor: HEAT_MAP_COLORS.EXTREME_BULLISH }}></div>
                </div>
                <span className="text-gray-400">Bullish</span>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
                {entries.map((entry) => (
                    <div
                        key={entry.ticker}
                        className="relative p-2 rounded-lg transition-all"
                        style={{
                            backgroundColor: getHeatMapColor(entry.score),
                            opacity: 0.85
                        }}
                    >
                        <div className="text-xs font-bold text-black truncate">
                            {entry.ticker.replace('USDC', '').replace('USD', '')}
                        </div>
                        <div className="text-xs text-black/70">
                            {entry.score.toFixed(0)}
                        </div>
                    </div>
                ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
                <div className="bg-green-900/30 rounded-lg p-3">
                    <h4 className="text-sm font-semibold text-green-400 mb-2">Top Bullish</h4>
                    <div className="space-y-1">
                        {entries.slice(0, 3).map((entry) => (
                            <div key={entry.ticker} className="flex justify-between items-center text-xs p-1 rounded">
                                <span className="text-white font-medium">{entry.ticker.replace('USD', '')}</span>
                                <span className="text-green-400">{entry.score.toFixed(0)}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="bg-red-900/30 rounded-lg p-3">
                    <h4 className="text-sm font-semibold text-red-400 mb-2">Top Bearish</h4>
                    <div className="space-y-1">
                        {[...entries].reverse().slice(0, 3).map((entry) => (
                            <div key={entry.ticker} className="flex justify-between items-center text-xs p-1 rounded">
                                <span className="text-white font-medium">{entry.ticker.replace('USD', '')}</span>
                                <span className="text-red-400">{entry.score.toFixed(0)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
