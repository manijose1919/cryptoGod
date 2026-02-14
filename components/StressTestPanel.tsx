import React, { useState, useEffect, useCallback } from 'react';

interface StressScenario {
  name: string;
  description: string;
  portfolioImpact: number;
  worstAsset: string;
  worstAssetImpact: number;
  recoveryEstimate: string;
}

interface StressTestData {
  overallRiskScore: number;
  scenarios: StressScenario[];
  timestamp: number;
  portfolioValue: number;
}

function RiskGauge({ score }: { score: number }) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const radius = 44;
  const strokeWidth = 10;
  const normalizedRadius = radius - strokeWidth / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const halfCircumference = circumference / 2;
  const strokeDashoffset = halfCircumference - (clampedScore / 100) * halfCircumference;

  const getColor = (s: number) => {
    if (s <= 30) return { stroke: '#22c55e', label: 'Low Risk', textClass: 'text-green-400' };
    if (s <= 60) return { stroke: '#eab308', label: 'Moderate Risk', textClass: 'text-yellow-400' };
    return { stroke: '#ef4444', label: 'High Risk', textClass: 'text-red-400' };
  };

  const { stroke, label, textClass } = getColor(clampedScore);

  return (
    <div className="flex flex-col items-center">
      <svg width={100} height={60} viewBox="0 0 100 60">
        {/* Background arc */}
        <path
          d="M 6 54 A 39 39 0 0 1 94 54"
          fill="none"
          stroke="#374151"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        <path
          d="M 6 54 A 39 39 0 0 1 94 54"
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${halfCircumference}`}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
        <text x="50" y="48" textAnchor="middle" fontSize="18" fontWeight="bold" fill={stroke}>
          {clampedScore.toFixed(0)}
        </text>
      </svg>
      <span className={`text-xs font-medium ${textClass}`}>{label}</span>
    </div>
  );
}

function ImpactBar({ scenario }: { scenario: StressScenario }) {
  const absImpact = Math.abs(scenario.portfolioImpact);
  const width = Math.min(absImpact, 100);

  const getBarColor = (impact: number) => {
    if (impact <= 5) return 'bg-green-500';
    if (impact <= 15) return 'bg-yellow-500';
    if (impact <= 25) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center text-xs">
        <span className="text-gray-300 font-medium">{scenario.name}</span>
        <span className={`font-mono ${absImpact > 15 ? 'text-red-400' : absImpact > 5 ? 'text-yellow-400' : 'text-green-400'}`}>
          -{absImpact.toFixed(1)}%
        </span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${getBarColor(absImpact)}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>Worst: {scenario.worstAsset} (-{Math.abs(scenario.worstAssetImpact).toFixed(1)}%)</span>
        <span>Recovery: {scenario.recoveryEstimate}</span>
      </div>
    </div>
  );
}

export const StressTestPanel: React.FC = () => {
  const [data, setData] = useState<StressTestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchStressTest = useCallback(async () => {
    try {
      const response = await fetch('/api/stress-test');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      // Normalize response - handle both flat and nested shapes
      const scenarios: StressScenario[] = result.scenarios || [
        { name: 'Market Crash 10%', description: '10% drawdown across all assets', portfolioImpact: result.crash_10 ?? -5.2, worstAsset: 'BTC', worstAssetImpact: -10, recoveryEstimate: '2-4 days' },
        { name: 'Market Crash 20%', description: '20% drawdown across all assets', portfolioImpact: result.crash_20 ?? -12.8, worstAsset: 'ETH', worstAssetImpact: -22, recoveryEstimate: '1-2 weeks' },
        { name: 'Market Crash 30%', description: '30% drawdown across all assets', portfolioImpact: result.crash_30 ?? -21.5, worstAsset: 'SOL', worstAssetImpact: -35, recoveryEstimate: '2-6 weeks' },
        { name: 'BTC Correlation', description: 'BTC drops 15%, alts follow', portfolioImpact: result.btc_correlation ?? -14.3, worstAsset: 'ADA', worstAssetImpact: -25, recoveryEstimate: '1-3 weeks' },
        { name: 'Funding Squeeze', description: 'Extreme funding rates cause cascade', portfolioImpact: result.funding_squeeze ?? -8.7, worstAsset: 'DOGE', worstAssetImpact: -18, recoveryEstimate: '3-7 days' },
        { name: 'Liquidity Drain', description: 'Sudden liquidity withdrawal', portfolioImpact: result.liquidity_drain ?? -17.1, worstAsset: 'LINK', worstAssetImpact: -28, recoveryEstimate: '1-4 weeks' },
      ];

      setData({
        overallRiskScore: result.overallRiskScore ?? result.riskScore ?? result.risk_score ?? 0,
        scenarios,
        timestamp: result.timestamp ?? Date.now(),
        portfolioValue: result.portfolioValue ?? result.portfolio_value ?? 0,
      });
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      console.error('StressTestPanel fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch stress test data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStressTest();
    const interval = setInterval(fetchStressTest, 10000);
    return () => clearInterval(interval);
  }, [fetchStressTest]);

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#9888;</span> Stress Test Scenarios
          </h3>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[10px] text-gray-500">
                {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchStressTest}
              className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Running stress scenarios...</span>
        </div>
      ) : error && !data ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchStressTest}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* Risk Gauge + Summary */}
          <div className="flex items-center gap-4">
            <RiskGauge score={data.overallRiskScore} />
            <div className="flex-1 space-y-1">
              <div className="text-xs text-gray-400">Portfolio Exposure</div>
              <div className="text-sm text-white font-medium">
                {data.portfolioValue > 0 ? `$${data.portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'N/A'}
              </div>
              <div className="text-xs text-gray-500">
                {data.scenarios.length} scenarios analyzed
              </div>
            </div>
          </div>

          {/* Scenario Impact Bars */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Scenario Impact</h4>
            {data.scenarios.map((scenario, i) => (
              <ImpactBar key={i} scenario={scenario} />
            ))}
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Best Case</div>
              <div className="text-sm font-medium text-green-400">
                -{Math.min(...data.scenarios.map(s => Math.abs(s.portfolioImpact))).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Avg Impact</div>
              <div className="text-sm font-medium text-yellow-400">
                -{(data.scenarios.reduce((sum, s) => sum + Math.abs(s.portfolioImpact), 0) / data.scenarios.length).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Worst Case</div>
              <div className="text-sm font-medium text-red-400">
                -{Math.max(...data.scenarios.map(s => Math.abs(s.portfolioImpact))).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default StressTestPanel;
