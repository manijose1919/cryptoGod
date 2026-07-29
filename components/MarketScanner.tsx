
import React from 'react';
import type { ScannerInsights } from '../types';

interface MarketScannerProps {
    insights: ScannerInsights | null;
    activeTicker: string;
    onSelectTicker?: (ticker: string) => void;
}

const StrategyColumn: React.FC<{
    title: string;
    insights: any[];
    activeTicker: string;
    onSelectTicker?: (ticker: string) => void;
}> = ({ title, insights, activeTicker, onSelectTicker }) => {
    return (
        <div className="bg-gray-900/50 p-3 rounded-lg">
            <h3 className="text-sm font-semibold text-center text-cyan-400 mb-2 uppercase tracking-wider">{title}</h3>
            {insights && insights.length > 0 ? (
                <ol className="space-y-2">
                    {insights.map((item, index) => {
                        const isActive = item.ticker === activeTicker;
                        const numValue = typeof item.value === 'number' ? item.value : 0;
                        const valueColor = numValue < 50 ? 'text-green-400' : 'text-red-400';
                        return (
                           <li key={item.ticker} onClick={() => onSelectTicker?.(item.ticker)} className={`flex justify-between items-center text-xs p-2 rounded-md transition-all cursor-pointer hover:bg-gray-800 ${isActive ? 'bg-cyan-600/20 border border-cyan-500' : ''}`}>
                               <div className="flex items-center">
                                   <span className="font-mono text-gray-500 mr-2">{index + 1}.</span>
                                   <span className={`font-bold ${isActive ? 'text-white' : 'text-gray-300'}`}>{item.ticker.replace('USDC', '')}</span>
                               </div>
                               <span className={`font-mono font-semibold ${valueColor}`}>{typeof item.value === 'number' ? item.value.toFixed(1) : 'N/A'}</span>
                           </li>
                        )
                    })}
                </ol>
            ) : (
                <p className="text-center text-xs text-gray-600 italic mt-4">No signals</p>
            )}
        </div>
    );
};

export const MarketScanner: React.FC<MarketScannerProps> = ({ insights, activeTicker, onSelectTicker }) => {
    return (
        <div className="glass-card p-6 animate-fade-up">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold gradient-header">Market Scanner</h2>
                {insights && (
                    <div className="flex items-center space-x-2">
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                        <span className="text-sm text-gray-400 italic">Live</span>
                    </div>
                )}
            </div>
            {insights ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StrategyColumn title="Trend" insights={insights.TREND ?? []} activeTicker={activeTicker} onSelectTicker={onSelectTicker} />
                    <StrategyColumn title="Breakout" insights={insights.BREAKOUT ?? []} activeTicker={activeTicker} onSelectTicker={onSelectTicker} />
                    <StrategyColumn title="Whale Flow" insights={insights.WHALE ?? []} activeTicker={activeTicker} onSelectTicker={onSelectTicker} />
                    <StrategyColumn title="Confluence" insights={insights.CONFLUENCE ?? []} activeTicker={activeTicker} onSelectTicker={onSelectTicker} />
                </div>
            ) : (
                <div className="text-center py-8">
                    <p className="text-gray-500">Scanner is idle. Activate trading to begin.</p>
                </div>
            )}
        </div>
    );
};