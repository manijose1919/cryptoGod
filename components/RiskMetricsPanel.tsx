import React, { useState } from 'react';
import type { RiskMetrics, KellyResult, MonteCarloResult } from '../services/riskMetricsService';

interface RiskMetricsPanelProps {
  metrics: RiskMetrics | null;
  kelly: KellyResult | null;
  monteCarlo: MonteCarloResult | null;
  onRunMonteCarlo?: () => void;
  isRunning?: boolean;
}

export const RiskMetricsPanel: React.FC<RiskMetricsPanelProps> = ({
  metrics,
  kelly,
  monteCarlo,
  onRunMonteCarlo,
  isRunning: isRunningMonteCarlo = false
}) => {
  const [expandedSection, setExpandedSection] = useState<'metrics' | 'kelly' | 'monte' | null>(null);

  const formatPercent = (value: number) => {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  const formatMoney = (value: number) => {
    return `$${value.toFixed(2)}`;
  };

  return (
    <div className="glass-card p-4 animate-fade-up">
      <h3 className="text-lg font-semibold gradient-header mb-3">Risk Analytics</h3>

      {metrics ? (
        <div className="space-y-3">
          {/* Quick Stats Row */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-gray-900/50 p-2 rounded">
              <div className="text-xs text-gray-400">Drawdown</div>
              <div className={`text-sm font-medium ${metrics.currentDrawdown > 10 ? 'text-red-400' : 'text-green-400'}`}>
                -{metrics.currentDrawdown.toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded">
              <div className="text-xs text-gray-400">Win Rate</div>
              <div className={`text-sm font-medium ${metrics.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                {metrics.winRate.toFixed(0)}%
              </div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded">
              <div className="text-xs text-gray-400">Streak</div>
              <div className={`text-sm font-medium ${metrics.currentStreak >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {metrics.currentStreak >= 0 ? `+${metrics.currentStreak}W` : `${Math.abs(metrics.currentStreak)}L`}
              </div>
            </div>
          </div>

          {/* Risk Level Banner */}
          <div className={`p-2 rounded text-center text-sm font-medium ${
            metrics.streakRisk === 'CRITICAL' ? 'bg-red-900/50 text-red-300' :
            metrics.streakRisk === 'HIGH' ? 'bg-orange-900/50 text-orange-300' :
            metrics.streakRisk === 'MEDIUM' ? 'bg-yellow-900/50 text-yellow-300' :
            'bg-green-900/50 text-green-300'
          }`}>
            Streak Risk: {metrics.streakRisk}
          </div>

          {/* Expandable Metrics Section */}
          <div className="bg-gray-900/50 rounded overflow-hidden">
            <button
              className="w-full p-2 text-left text-sm text-gray-300 flex justify-between items-center hover:bg-gray-800/50"
              onClick={() => setExpandedSection(expandedSection === 'metrics' ? null : 'metrics')}
            >
              <span>Performance Metrics</span>
              <span>{expandedSection === 'metrics' ? '▼' : '▶'}</span>
            </button>
            {expandedSection === 'metrics' && (
              <div className="p-2 border-t border-gray-700 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Return:</span>
                  <span className={metrics.totalReturn >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {formatPercent(metrics.totalReturn)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Drawdown:</span>
                  <span className="text-red-400">-{metrics.maxDrawdown.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Sharpe Ratio:</span>
                  <span className={metrics.sharpeRatio >= 1 ? 'text-green-400' : 'text-yellow-400'}>
                    {metrics.sharpeRatio.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Sortino Ratio:</span>
                  <span className={metrics.sortinoRatio >= 1.5 ? 'text-green-400' : 'text-yellow-400'}>
                    {metrics.sortinoRatio.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Profit Factor:</span>
                  <span className={metrics.profitFactor >= 1.5 ? 'text-green-400' : 'text-yellow-400'}>
                    {metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Expectancy:</span>
                  <span className={metrics.expectancy >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {formatMoney(metrics.expectancy)}/trade
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Risk of Ruin:</span>
                  <span className={metrics.riskOfRuin < 5 ? 'text-green-400' : 'text-red-400'}>
                    {metrics.riskOfRuin.toFixed(1)}%
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Kelly Criterion Section */}
          {kelly && (
            <div className="bg-gray-900/50 rounded overflow-hidden">
              <button
                className="w-full p-2 text-left text-sm text-gray-300 flex justify-between items-center hover:bg-gray-800/50"
                onClick={() => setExpandedSection(expandedSection === 'kelly' ? null : 'kelly')}
              >
                <span>Kelly Criterion</span>
                <span>{expandedSection === 'kelly' ? '▼' : '▶'}</span>
              </button>
              {expandedSection === 'kelly' && (
                <div className="p-2 border-t border-gray-700 space-y-2 text-xs">
                  <div className="grid grid-cols-3 gap-1 text-center">
                    <div>
                      <div className="text-gray-500">Full</div>
                      <div className="text-orange-400">{(kelly.fullKelly * 100).toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Half</div>
                      <div className="text-yellow-400">{(kelly.halfKelly * 100).toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Quarter</div>
                      <div className="text-green-400">{(kelly.quarterKelly * 100).toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pt-1 border-t border-gray-700">
                    <span className="text-gray-400">Recommended:</span>
                    <span className="text-cyan-400 font-medium">
                      {(kelly.recommendedFraction * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Implied Edge:</span>
                    <span className={kelly.impliedEdge > 0 ? 'text-green-400' : 'text-red-400'}>
                      {(kelly.impliedEdge * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Confidence:</span>
                    <span className="text-gray-300">{kelly.confidence.toFixed(0)}%</span>
                  </div>
                  {kelly.warning && (
                    <div className="text-yellow-400 text-xs p-1 bg-yellow-900/20 rounded">
                      {kelly.warning}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Monte Carlo Section */}
          <div className="bg-gray-900/50 rounded overflow-hidden">
            <button
              className="w-full p-2 text-left text-sm text-gray-300 flex justify-between items-center hover:bg-gray-800/50"
              onClick={() => setExpandedSection(expandedSection === 'monte' ? null : 'monte')}
            >
              <span>Monte Carlo Sim</span>
              <span>{expandedSection === 'monte' ? '▼' : '▶'}</span>
            </button>
            {expandedSection === 'monte' && (
              <div className="p-2 border-t border-gray-700 space-y-2 text-xs">
                {monteCarlo && monteCarlo.simulations > 0 ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Median Outcome:</span>
                      <span className="text-white">{formatMoney(monteCarlo.medianOutcome)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Worst 5%:</span>
                      <span className="text-red-400">{formatMoney(monteCarlo.worstCase5Pct)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Best 5%:</span>
                      <span className="text-green-400">{formatMoney(monteCarlo.bestCase95Pct)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Ruin Probability:</span>
                      <span className={monteCarlo.ruinProbability < 5 ? 'text-green-400' : 'text-red-400'}>
                        {monteCarlo.ruinProbability.toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Max DD:</span>
                      <span className="text-orange-400">{monteCarlo.avgMaxDrawdown.toFixed(1)}%</span>
                    </div>
                    <div className="text-gray-500 text-center mt-1">
                      {monteCarlo.simulations.toLocaleString()} simulations
                    </div>
                  </>
                ) : (
                  <div className="text-center py-2">
                    {onRunMonteCarlo && (
                      <button
                        onClick={onRunMonteCarlo}
                        disabled={isRunningMonteCarlo}
                        className="px-3 py-1 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white text-xs rounded"
                      >
                        {isRunningMonteCarlo ? 'Running...' : 'Run Simulation'}
                      </button>
                    )}
                    <div className="text-gray-500 mt-1">
                      Simulates 1000 paths to estimate risk
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-gray-500 text-sm text-center py-4">
          Waiting for risk data...
        </p>
      )}
    </div>
  );
};
