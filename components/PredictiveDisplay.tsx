import React from 'react';

interface PredictionData {
    ticker: string;
    horizons: Record<string, { direction: 'UP' | 'DOWN' | 'SIDEWAYS', confidence: number }>;
    levels: { support: number, resistance: number };
    regime: string;
    factors?: { name: string, impact: number }[];
}

interface PredictiveDisplayProps {
    data: PredictionData | null;
}

const getDirectionIcon = (direction: 'UP' | 'DOWN' | 'SIDEWAYS') => {
    switch (direction) {
        case 'UP': return '↑';
        case 'DOWN': return '↓';
        default: return '→';
    }
};

const getDirectionColor = (direction: 'UP' | 'DOWN' | 'SIDEWAYS') => {
    switch (direction) {
        case 'UP': return 'text-green-400';
        case 'DOWN': return 'text-red-400';
        default: return 'text-gray-400';
    }
};

export const PredictiveDisplay: React.FC<PredictiveDisplayProps> = ({ data: prediction }) => {
    if (!prediction) {
        return (
            <div className="bg-gray-800/80 backdrop-blur-md p-5 rounded-2xl border border-gray-700 shadow-xl">
                <h4 className="text-white font-bold text-lg mb-3">Market Expectations</h4>
                <p className="text-gray-500 text-sm text-center py-4">Waiting for prediction data...</p>
            </div>
        );
    }

    return (
        <div className="bg-gray-800/80 backdrop-blur-md p-5 rounded-2xl border border-gray-700 shadow-xl">
            <h4 className="text-white font-bold text-lg mb-5 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                Market Expectations: {prediction.ticker}
            </h4>
            
            <div className="grid grid-cols-3 gap-3 mb-6">
                {Object.entries(prediction?.horizons || {}).map(([horizon, data]) => (
                    <div key={horizon} className="text-center bg-gray-900/60 p-3 rounded-2xl border border-gray-700/50">
                        <div className="text-[10px] text-gray-500 uppercase font-black mb-1">{horizon}</div>
                        <div className={`text-2xl font-black ${getDirectionColor(data.direction)}`}>
                            {getDirectionIcon(data.direction)}
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1 font-mono">{data.confidence}%</div>
                    </div>
                ))}
            </div>

            <div className="space-y-4">
                <div className="flex justify-between items-center p-2 bg-red-500/5 rounded-lg border border-red-500/10">
                    <span className="text-xs text-gray-400">Resistance</span>
                    <span className="text-red-400 font-mono font-bold">${prediction.levels.resistance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between items-center p-2 bg-green-500/5 rounded-lg border border-green-500/10">
                    <span className="text-xs text-gray-400">Support</span>
                    <span className="text-green-400 font-mono font-bold">${prediction.levels.support.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between items-center p-2 bg-cyan-500/5 rounded-lg border border-cyan-500/10">
                    <span className="text-xs text-gray-400">Market Regime</span>
                    <span className="text-cyan-400 text-xs font-black uppercase tracking-wider">{prediction.regime.replace('_', ' ')}</span>
                </div>
            </div>

            {prediction.factors && (
                <div className="mt-6">
                    <div className="text-[10px] text-gray-500 uppercase font-black mb-3">Key Prediction Factors</div>
                    <div className="space-y-2">
                        {prediction.factors.map((f, i) => (
                            <div key={i} className="flex items-center gap-2">
                                <div className="text-[10px] text-gray-400 w-20">{f.name}</div>
                                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                    <div 
                                        className={`h-full ${f.impact > 0 ? 'bg-green-500' : 'bg-red-500'}`}
                                        style={{ 
                                            width: `${Math.abs(f.impact)}%`,
                                            marginLeft: f.impact > 0 ? '50%' : `${50 - Math.abs(f.impact)}%`
                                        }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
