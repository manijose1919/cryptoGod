import React from 'react';
import type { LearningState } from '../services/aiLearningService';

interface AILearningPanelProps {
  learningState: LearningState | null;
}

export const AILearningPanel: React.FC<AILearningPanelProps> = ({
  learningState,
}) => {
  if (!learningState) {
    return (
      <div className="glass-card p-4 glow-purple animate-fade-up">
        <h3 className="text-lg font-semibold text-purple-300 flex items-center gap-2 mb-3">
          AI Learning
        </h3>
        <p className="text-gray-400 text-sm">Waiting for trades to learn from...</p>
      </div>
    );
  }

  const winRateColor = learningState.winRate >= 55 ? 'text-green-400' : learningState.winRate >= 45 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="glass-card p-4 glow-purple animate-fade-up">
      <h3 className="text-lg font-semibold gradient-header flex items-center gap-2 mb-3">
        ML Intelligence
      </h3>

      {/* Key Stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="bg-black/30 rounded-lg p-2 text-center">
          <div className="text-xs text-gray-500">Trades</div>
          <div className="text-lg font-bold text-white">{learningState.totalTrades}</div>
        </div>
        <div className="bg-black/30 rounded-lg p-2 text-center">
          <div className="text-xs text-gray-500">Win Rate</div>
          <div className={`text-lg font-bold ${winRateColor}`}>{(learningState.winRate || 0).toFixed(1)}%</div>
        </div>
        <div className="bg-black/30 rounded-lg p-2 text-center">
          <div className="text-xs text-gray-500">Avg Win</div>
          <div className="text-lg font-bold text-green-400">+{(learningState.avgWinPercent || 0).toFixed(2)}%</div>
        </div>
        <div className="bg-black/30 rounded-lg p-2 text-center">
          <div className="text-xs text-gray-500">Avg Loss</div>
          <div className="text-lg font-bold text-red-400">-{(learningState.avgLossPercent || 0).toFixed(2)}%</div>
        </div>
      </div>

      {/* Strategy Performance */}
      <div className="mb-4">
        <div className="text-xs text-gray-400 mb-2">Strategy Performance:</div>
        <div className="grid grid-cols-2 gap-1 text-xs">
          {Object.entries(learningState.strategyStats)
            .filter(([_, stats]) => stats.trades > 0)
            .sort((a, b) => b[1].winRate - a[1].winRate)
            .slice(0, 4)
            .map(([strat, stats]) => (
              <div key={strat} className="flex justify-between bg-black/20 rounded px-2 py-1">
                <span className="text-gray-400">{strat}</span>
                <span className={stats.winRate >= 50 ? 'text-green-400' : 'text-red-400'}>
                  {(stats.winRate || 0).toFixed(0)}% ({stats.trades})
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Best/Worst Strategy */}
      <div className="flex justify-between text-xs mb-4">
        {learningState.bestStrategy && (
          <div className="text-green-400">
            Best: {learningState.bestStrategy} ({(learningState.strategyStats[learningState.bestStrategy]?.winRate || 0).toFixed(0)}%)
          </div>
        )}
        {learningState.worstStrategy && (
          <div className="text-red-400">
            Worst: {learningState.worstStrategy} ({(learningState.strategyStats[learningState.worstStrategy]?.winRate || 0).toFixed(0)}%)
          </div>
        )}
      </div>

      {/* Learning Status */}
      <div className="mt-3 text-xs text-gray-500 text-center">
        Profit Factor: {(learningState.profitFactor || 0).toFixed(2)} |
        Learned from {learningState.totalTrades} trades
      </div>
    </div>
  );
};
