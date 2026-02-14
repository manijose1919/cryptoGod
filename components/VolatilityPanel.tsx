import React from 'react';
import type { EnsembleVolatility, VolatilityMethod } from '../services/volatilityMethodsService';

interface VolatilityPanelProps {
  ensemble: EnsembleVolatility | null;
  expansion: {
    isExpanding: boolean;
    expansionRate: number;
    signal: string;
  } | null;
}

export const VolatilityPanel: React.FC<VolatilityPanelProps> = ({
  ensemble: ensembleVolatility,
  expansion: volatilityExpansion,
}) => {
  const getLevelColor = (level: string) => {
    switch (level) {
      case 'EXTREME': return 'text-red-400 bg-red-900/30';
      case 'HIGH': return 'text-orange-400 bg-orange-900/30';
      case 'MEDIUM': return 'text-yellow-400 bg-yellow-900/30';
      case 'LOW': return 'text-green-400 bg-green-900/30';
      case 'VERY_LOW': return 'text-cyan-400 bg-cyan-900/30';
      default: return 'text-gray-400 bg-gray-900/30';
    }
  };

  const getMethodShortName = (method: VolatilityMethod) => {
    switch (method) {
      case 'ATR': return 'ATR';
      case 'STD_LOG_RETURNS': return 'StdDev';
      case 'PERCENT_RANGE': return '%Range';
      case 'PARKINSON': return 'Park';
      case 'GARMAN_KLASS': return 'G-K';
      case 'ROGERS_SATCHELL': return 'R-S';
      default: return method;
    }
  };

  const getSignalColor = (signal: string) => {
    switch (signal) {
      case 'BREAKOUT_LIKELY': return 'text-green-400';
      case 'CONTINUATION': return 'text-cyan-400';
      case 'REVERSAL_LIKELY': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <div className="glass-card p-4 animate-fade-up">
      <h3 className="text-lg font-semibold gradient-header mb-3">Volatility Analysis</h3>

      {ensembleVolatility ? (
        <div className="space-y-3">
          {/* Consensus & Average */}
          <div className="flex justify-between items-center">
            <div>
              <span className="text-gray-400 text-sm">Consensus:</span>
              <span className={`ml-2 px-2 py-0.5 rounded text-sm font-medium ${getLevelColor(ensembleVolatility.consensus)}`}>
                {ensembleVolatility.consensus}
              </span>
            </div>
            <div className="text-right">
              <span className="text-gray-400 text-sm">Agreement:</span>
              <span className="ml-1 text-white text-sm">{ensembleVolatility.consensusScore.toFixed(0)}%</span>
            </div>
          </div>

          {/* Average Volatility Bar */}
          <div className="bg-gray-900/50 p-2 rounded">
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>Avg Volatility</span>
              <span>{Number(ensembleVolatility.average).toFixed(1)}%</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  ensembleVolatility.average > 70 ? 'bg-red-500' :
                  ensembleVolatility.average > 50 ? 'bg-orange-500' :
                  ensembleVolatility.average > 30 ? 'bg-yellow-500' :
                  'bg-green-500'
                }`}
                style={{ width: `${Math.min(100, ensembleVolatility.average)}%` }}
              />
            </div>
          </div>

          {/* Individual Methods */}
          <div className="grid grid-cols-3 gap-1">
            {ensembleVolatility.methods.map((method) => (
              <div
                key={method.method}
                className={`p-1.5 rounded text-center ${getLevelColor(method.level)}`}
                title={`${method.method}: ${Number(method.value || 0).toFixed(4)} (${method.level})`}
              >
                <div className="text-xs font-medium">{getMethodShortName(method.method)}</div>
                <div className="text-xs opacity-75">{method.normalized.toFixed(0)}</div>
              </div>
            ))}
          </div>

          {/* Volatility Expansion */}
          {volatilityExpansion && (
            <div className="bg-gray-900/50 p-2 rounded">
              <div className="flex justify-between items-center text-xs">
                <span className="text-gray-400">Expansion:</span>
                <span className={volatilityExpansion.isExpanding ? 'text-orange-400' : 'text-cyan-400'}>
                  {volatilityExpansion.isExpanding ? 'Expanding' : 'Contracting'}
                  {' '}({volatilityExpansion.expansionRate > 0 ? '+' : ''}{volatilityExpansion.expansionRate.toFixed(1)}%)
                </span>
              </div>
              <div className={`text-xs mt-1 ${getSignalColor(volatilityExpansion.signal)}`}>
                Signal: {volatilityExpansion.signal.replace('_', ' ')}
              </div>
            </div>
          )}

          {/* Best Method */}
          <div className="bg-gray-900/50 p-2 rounded text-xs">
            <span className="text-gray-400">Best method for regime:</span>
            <span className="ml-1 text-cyan-300">{ensembleVolatility.bestMethodForRegime}</span>
          </div>

          {/* Recommendation */}
          <div className="text-xs text-gray-300 italic border-t border-gray-700 pt-2">
            {ensembleVolatility.recommendation}
          </div>
        </div>
      ) : (
        <p className="text-gray-500 text-sm text-center py-4">
          Waiting for volatility data...
        </p>
      )}
    </div>
  );
};
