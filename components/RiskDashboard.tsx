import React, { useState, useEffect, useCallback } from 'react';

interface VaRData {
  var95: number;
  var99: number;
  cvar95: number;
  cvar99: number;
  method: string;
  confidence: number;
  timestamp: number;
}

interface KellyData {
  full: number;
  half: number;
  quarter: number;
  recommended: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
}

interface DrawdownData {
  current: number;
  max: number;
  duration: number;
  peakValue: number;
  troughValue: number;
}

interface MonteCarloData {
  simulations: number;
  ruinProbability: number;
  medianReturn: number;
  p5Return: number;
  p95Return: number;
  p25Return: number;
  p75Return: number;
  maxDrawdownMedian: number;
  confidenceIntervals: {
    ci90: [number, number];
    ci95: [number, number];
    ci99: [number, number];
  };
}

interface PositionSizing {
  asset: string;
  ticker?: string;
  recommended: number;
  maxAllowed: number;
  reason: string;
}

interface RiskBudget {
  total: number;
  used: number;
  remaining: number;
  byStrategy: Record<string, number>;
}

interface PortfolioHeat {
  totalHeat: number;
  maxHeat: number;
}

interface RiskDashboardData {
  var: VaRData | null;
  kelly: KellyData | null;
  drawdown: DrawdownData | null;
  monteCarlo: MonteCarloData | null;
  riskBudget: RiskBudget | null;
  portfolioHeat: PortfolioHeat | null;
  positionSizing: PositionSizing[];
}

function RiskGauge({ value, max, label, unit, thresholds }: {
  value: number;
  max: number;
  label: string;
  unit?: string;
  thresholds: { green: number; yellow: number };
}) {
  const pct = Math.min(Math.abs(value) / max * 100, 100);
  const color = Math.abs(value) <= thresholds.green ? 'text-green-400' :
    Math.abs(value) <= thresholds.yellow ? 'text-yellow-400' : 'text-red-400';
  const barColor = Math.abs(value) <= thresholds.green ? 'bg-green-500' :
    Math.abs(value) <= thresholds.yellow ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="bg-gray-900/50 p-2 rounded">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">{label}</span>
        <span className={`font-mono font-medium ${color}`}>
          {value.toFixed(2)}{unit || '%'}
        </span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatBox({ label, value, color, subtext }: {
  label: string;
  value: string;
  color: string;
  subtext?: string;
}) {
  return (
    <div className="bg-gray-900/50 p-2 rounded text-center">
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className={`text-sm font-bold font-mono ${color}`}>{value}</div>
      {subtext && <div className="text-[10px] text-gray-600">{subtext}</div>}
    </div>
  );
}

function MonteCarloChart({ mc }: { mc: MonteCarloData }) {
  const chartHeight = 80;
  const chartWidth = 240;
  const padding = { left: 40, right: 10, top: 5, bottom: 15 };
  const plotW = chartWidth - padding.left - padding.right;

  const intervals = [
    { label: '99% CI', low: mc.confidenceIntervals.ci99[0], high: mc.confidenceIntervals.ci99[1], color: '#374151' },
    { label: '95% CI', low: mc.confidenceIntervals.ci95[0], high: mc.confidenceIntervals.ci95[1], color: '#1e3a5f' },
    { label: '90% CI', low: mc.confidenceIntervals.ci90[0], high: mc.confidenceIntervals.ci90[1], color: '#164e63' },
  ];

  const allValues = intervals.flatMap(i => [i.low, i.high]).concat([mc.medianReturn]);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;

  const scaleX = (val: number) => padding.left + ((val - minVal) / range) * plotW;

  return (
    <svg width={chartWidth} height={chartHeight} className="w-full h-auto">
      {/* Background intervals */}
      {intervals.map((interval, i) => {
        const x1 = scaleX(interval.low);
        const x2 = scaleX(interval.high);
        const barHeight = 12;
        const y = padding.top + i * (barHeight + 4);
        return (
          <g key={i}>
            <rect x={x1} y={y} width={x2 - x1} height={barHeight} fill={interval.color} rx={3} />
            <text x={padding.left - 3} y={y + barHeight / 2 + 3} textAnchor="end" fontSize={7} fill="#9ca3af">
              {interval.label}
            </text>
            <text x={x1 - 2} y={y + barHeight / 2 + 3} textAnchor="end" fontSize={6} fill="#6b7280">
              {interval.low.toFixed(1)}%
            </text>
            <text x={x2 + 2} y={y + barHeight / 2 + 3} textAnchor="start" fontSize={6} fill="#6b7280">
              {interval.high.toFixed(1)}%
            </text>
          </g>
        );
      })}

      {/* Median line */}
      <line
        x1={scaleX(mc.medianReturn)}
        y1={padding.top - 2}
        x2={scaleX(mc.medianReturn)}
        y2={padding.top + 3 * 16}
        stroke="#22d3ee"
        strokeWidth={2}
        strokeDasharray="3,2"
      />
      <text
        x={scaleX(mc.medianReturn)}
        y={chartHeight - 2}
        textAnchor="middle"
        fontSize={7}
        fill="#22d3ee"
      >
        Median: {mc.medianReturn.toFixed(1)}%
      </text>
    </svg>
  );
}

export const RiskDashboard: React.FC = () => {
  const [data, setData] = useState<RiskDashboardData>({
    var: null, kelly: null, drawdown: null, monteCarlo: null,
    riskBudget: null, portfolioHeat: null, positionSizing: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'montecarlo' | 'sizing'>('overview');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchAllRiskData = useCallback(async () => {
    try {
      const [varRes, budgetRes, mcRes, stressRes] = await Promise.allSettled([
        fetch('/api/risk/var'),
        fetch('/api/risk-budget'),
        fetch('/api/monte-carlo'),
        fetch('/api/stress-test'),
      ]);

      const parse = async (res: PromiseSettledResult<Response>) => {
        if (res.status === 'fulfilled' && res.value.ok) {
          return await res.value.json();
        }
        return null;
      };

      const varData = await parse(varRes);
      const budgetData = await parse(budgetRes);
      const mcData = await parse(mcRes);
      const stressData = await parse(stressRes);

      // Normalize VaR
      const varNormalized: VaRData | null = varData ? {
        var95: varData.var95 ?? varData.var_95 ?? 0,
        var99: varData.var99 ?? varData.var_99 ?? 0,
        cvar95: varData.cvar95 ?? varData.cvar_95 ?? 0,
        cvar99: varData.cvar99 ?? varData.cvar_99 ?? 0,
        method: varData.method || 'historical',
        confidence: varData.confidence ?? 0.95,
        timestamp: varData.timestamp ?? Date.now(),
      } : null;

      // Normalize Kelly
      const kellyRaw = varData?.kelly || budgetData?.kelly;
      const kellyNormalized: KellyData | null = kellyRaw ? {
        full: kellyRaw.full ?? kellyRaw.fullKelly ?? 0,
        half: kellyRaw.half ?? kellyRaw.halfKelly ?? 0,
        quarter: kellyRaw.quarter ?? kellyRaw.quarterKelly ?? 0,
        recommended: kellyRaw.recommended ?? kellyRaw.recommendedKelly ?? 0,
        winRate: kellyRaw.winRate ?? kellyRaw.win_rate ?? 0,
        avgWin: kellyRaw.avgWin ?? kellyRaw.avg_win ?? 0,
        avgLoss: kellyRaw.avgLoss ?? kellyRaw.avg_loss ?? 0,
      } : null;

      // Normalize drawdown
      const ddRaw = varData?.drawdown || budgetData?.drawdown;
      const drawdownNormalized: DrawdownData | null = ddRaw ? {
        current: ddRaw.current ?? ddRaw.currentDrawdown ?? 0,
        max: ddRaw.max ?? ddRaw.maxDrawdown ?? 0,
        duration: ddRaw.duration ?? ddRaw.drawdownDuration ?? 0,
        peakValue: ddRaw.peakValue ?? ddRaw.peak ?? 0,
        troughValue: ddRaw.troughValue ?? ddRaw.trough ?? 0,
      } : null;

      // Normalize Monte Carlo
      const mcNormalized: MonteCarloData | null = mcData ? {
        simulations: mcData.simulations ?? mcData.paths ?? 1000,
        ruinProbability: mcData.ruinProbability ?? mcData.ruin_probability ?? 0,
        medianReturn: mcData.medianReturn ?? mcData.median_return ?? 0,
        p5Return: mcData.p5Return ?? mcData.p5 ?? 0,
        p95Return: mcData.p95Return ?? mcData.p95 ?? 0,
        p25Return: mcData.p25Return ?? mcData.p25 ?? 0,
        p75Return: mcData.p75Return ?? mcData.p75 ?? 0,
        maxDrawdownMedian: mcData.maxDrawdownMedian ?? mcData.median_max_drawdown ?? 0,
        confidenceIntervals: mcData.confidenceIntervals ?? mcData.confidence_intervals ?? {
          ci90: [mcData.p5 ?? -10, mcData.p95 ?? 10],
          ci95: [mcData.p2_5 ?? -15, mcData.p97_5 ?? 15],
          ci99: [mcData.p0_5 ?? -20, mcData.p99_5 ?? 20],
        },
      } : null;

      // Normalize risk budget
      const riskBudgetNormalized: RiskBudget | null = budgetData ? {
        total: budgetData.total ?? budgetData.totalBudget ?? 100,
        used: budgetData.used ?? budgetData.usedBudget ?? 0,
        remaining: budgetData.remaining ?? budgetData.remainingBudget ?? 100,
        byStrategy: budgetData.byStrategy ?? budgetData.by_strategy ?? {},
      } : null;

      // Portfolio heat from stress data
      const portfolioHeatNormalized: PortfolioHeat | null = stressData?.portfolioHeat ? {
        totalHeat: stressData.portfolioHeat.total ?? 0,
        maxHeat: stressData.portfolioHeat.max ?? 30,
      } : null;

      // Position sizing
      const positionSizing: PositionSizing[] = budgetData?.positionSizing || budgetData?.sizing || [];

      setData({
        var: varNormalized,
        kelly: kellyNormalized,
        drawdown: drawdownNormalized,
        monteCarlo: mcNormalized,
        riskBudget: riskBudgetNormalized,
        portfolioHeat: portfolioHeatNormalized,
        positionSizing,
      });
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      console.error('RiskDashboard fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch risk data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllRiskData();
    const interval = setInterval(fetchAllRiskData, 10000);
    return () => clearInterval(interval);
  }, [fetchAllRiskData]);

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'montecarlo' as const, label: 'Monte Carlo' },
    { id: 'sizing' as const, label: 'Position Sizing' },
  ];

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#128737;</span> Risk Dashboard
          </h3>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[10px] text-gray-500">{lastUpdated.toLocaleTimeString()}</span>
            )}
            <button
              onClick={fetchAllRiskData}
              className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 border border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && !data.var && !data.monteCarlo ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Loading risk analytics...</span>
        </div>
      ) : error && !data.var && !data.monteCarlo ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchAllRiskData}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ===== Overview Tab ===== */}
          {activeTab === 'overview' && (
            <>
              {/* VaR Section */}
              {data.var && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Value at Risk</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <RiskGauge value={data.var.var95} max={20} label="VaR (95%)" thresholds={{ green: 3, yellow: 8 }} />
                    <RiskGauge value={data.var.var99} max={30} label="VaR (99%)" thresholds={{ green: 5, yellow: 12 }} />
                    <RiskGauge value={data.var.cvar95} max={25} label="CVaR (95%)" thresholds={{ green: 5, yellow: 10 }} />
                    <RiskGauge value={data.var.cvar99} max={35} label="CVaR (99%)" thresholds={{ green: 8, yellow: 15 }} />
                  </div>
                </div>
              )}

              {/* Kelly Criterion */}
              {data.kelly && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Kelly Criterion</h4>
                  <div className="grid grid-cols-4 gap-2">
                    <StatBox label="Full Kelly" value={`${(data.kelly.full * 100).toFixed(1)}%`} color="text-red-400" subtext="Aggressive" />
                    <StatBox label="Half Kelly" value={`${(data.kelly.half * 100).toFixed(1)}%`} color="text-yellow-400" subtext="Moderate" />
                    <StatBox label="Quarter" value={`${(data.kelly.quarter * 100).toFixed(1)}%`} color="text-green-400" subtext="Safe" />
                    <StatBox
                      label="Recommended"
                      value={`${(data.kelly.recommended * 100).toFixed(1)}%`}
                      color="text-cyan-400"
                      subtext={`WR: ${(data.kelly.winRate * 100).toFixed(0)}%`}
                    />
                  </div>
                </div>
              )}

              {/* Drawdown */}
              {data.drawdown && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Drawdown Analysis</h4>
                  <div className="grid grid-cols-3 gap-2">
                    <StatBox
                      label="Current DD"
                      value={`-${data.drawdown.current.toFixed(1)}%`}
                      color={data.drawdown.current > 10 ? 'text-red-400' : data.drawdown.current > 5 ? 'text-yellow-400' : 'text-green-400'}
                    />
                    <StatBox
                      label="Max DD"
                      value={`-${data.drawdown.max.toFixed(1)}%`}
                      color="text-red-400"
                    />
                    <StatBox
                      label="Duration"
                      value={data.drawdown.duration > 0 ? `${data.drawdown.duration}d` : '--'}
                      color="text-gray-300"
                    />
                  </div>
                </div>
              )}

              {/* Risk Budget */}
              {data.riskBudget && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Risk Budget</h4>
                  <div className="bg-gray-900/50 p-2 rounded space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Used / Total</span>
                      <span className="text-white font-mono">
                        {data.riskBudget.used.toFixed(0)} / {data.riskBudget.total.toFixed(0)}
                      </span>
                    </div>
                    <div className="w-full bg-gray-700/50 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-500 ${
                          data.riskBudget.used / data.riskBudget.total > 0.8 ? 'bg-red-500' :
                          data.riskBudget.used / data.riskBudget.total > 0.5 ? 'bg-yellow-500' : 'bg-green-500'
                        }`}
                        style={{ width: `${Math.min((data.riskBudget.used / data.riskBudget.total) * 100, 100)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500">
                      Remaining: {data.riskBudget.remaining.toFixed(0)} units
                    </div>
                  </div>
                  {Object.keys(data?.riskBudget?.byStrategy || {}).length > 0 && (
                    <div className="space-y-1">
                      {Object.entries(data?.riskBudget?.byStrategy || {}).map(([strategy, budget]) => (
                        <div key={strategy} className="flex justify-between text-[10px] px-1">
                          <span className="text-gray-400">{strategy}</span>
                          <span className="text-gray-300 font-mono">{(budget as number).toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Portfolio Heat */}
              {data.portfolioHeat && (
                <div className="bg-gray-900/50 p-2 rounded">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">Portfolio Heat</span>
                    <span className={`font-mono ${
                      data.portfolioHeat.totalHeat > 20 ? 'text-red-400' :
                      data.portfolioHeat.totalHeat > 10 ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {data.portfolioHeat.totalHeat.toFixed(1)} / {data.portfolioHeat.maxHeat}
                    </span>
                  </div>
                  <div className="w-full bg-gray-700/50 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-all duration-500 ${
                        data.portfolioHeat.totalHeat > 20 ? 'bg-red-500' :
                        data.portfolioHeat.totalHeat > 10 ? 'bg-yellow-500' : 'bg-green-500'
                      }`}
                      style={{ width: `${Math.min((data.portfolioHeat.totalHeat / data.portfolioHeat.maxHeat) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {!data.var && !data.kelly && !data.drawdown && !data.riskBudget && (
                <p className="text-gray-500 text-sm text-center py-4">No risk data available. Start trading to generate metrics.</p>
              )}
            </>
          )}

          {/* ===== Monte Carlo Tab ===== */}
          {activeTab === 'montecarlo' && (
            <>
              {data.monteCarlo ? (
                <div className="space-y-4">
                  {/* Key Stats */}
                  <div className="grid grid-cols-3 gap-2">
                    <StatBox
                      label="Ruin Prob"
                      value={`${(data.monteCarlo.ruinProbability * 100).toFixed(2)}%`}
                      color={data.monteCarlo.ruinProbability > 0.05 ? 'text-red-400' : data.monteCarlo.ruinProbability > 0.01 ? 'text-yellow-400' : 'text-green-400'}
                      subtext={`${data.monteCarlo.simulations} sims`}
                    />
                    <StatBox
                      label="Median Return"
                      value={`${data.monteCarlo.medianReturn >= 0 ? '+' : ''}${data.monteCarlo.medianReturn.toFixed(1)}%`}
                      color={data.monteCarlo.medianReturn >= 0 ? 'text-green-400' : 'text-red-400'}
                    />
                    <StatBox
                      label="Med Max DD"
                      value={`-${data.monteCarlo.maxDrawdownMedian.toFixed(1)}%`}
                      color={data.monteCarlo.maxDrawdownMedian > 20 ? 'text-red-400' : 'text-yellow-400'}
                    />
                  </div>

                  {/* Confidence Intervals Chart */}
                  <div className="bg-gray-900/30 rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Confidence Intervals</h4>
                    <MonteCarloChart mc={data.monteCarlo} />
                  </div>

                  {/* Percentile Breakdown */}
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Return Distribution</h4>
                    <div className="grid grid-cols-5 gap-1">
                      <StatBox label="P5" value={`${data.monteCarlo.p5Return.toFixed(1)}%`} color="text-red-400" />
                      <StatBox label="P25" value={`${data.monteCarlo.p25Return.toFixed(1)}%`} color="text-yellow-400" />
                      <StatBox label="P50" value={`${data.monteCarlo.medianReturn.toFixed(1)}%`} color="text-cyan-400" />
                      <StatBox label="P75" value={`${data.monteCarlo.p75Return.toFixed(1)}%`} color="text-green-400" />
                      <StatBox label="P95" value={`${data.monteCarlo.p95Return.toFixed(1)}%`} color="text-green-400" />
                    </div>
                  </div>

                  {/* Risk Assessment */}
                  <div className={`p-3 rounded-lg border text-center ${
                    data.monteCarlo.ruinProbability < 0.01 ? 'bg-green-900/20 border-green-500/30' :
                    data.monteCarlo.ruinProbability < 0.05 ? 'bg-yellow-900/20 border-yellow-500/30' :
                    'bg-red-900/20 border-red-500/30'
                  }`}>
                    <p className={`text-sm font-medium ${
                      data.monteCarlo.ruinProbability < 0.01 ? 'text-green-400' :
                      data.monteCarlo.ruinProbability < 0.05 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {data.monteCarlo.ruinProbability < 0.01 ? 'Low Risk of Ruin' :
                       data.monteCarlo.ruinProbability < 0.05 ? 'Moderate Risk of Ruin' :
                       'High Risk of Ruin - Reduce Position Sizes'}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-1">
                      Based on {data.monteCarlo.simulations.toLocaleString()} Monte Carlo simulations
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-sm text-center py-8">
                  Monte Carlo simulation data not available. Requires trade history.
                </p>
              )}
            </>
          )}

          {/* ===== Position Sizing Tab ===== */}
          {activeTab === 'sizing' && (
            <>
              {data.kelly && (
                <div className="space-y-2 mb-4">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Kelly-Based Sizing</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-900/50 p-2 rounded">
                      <div className="text-[10px] text-gray-500">Win Rate</div>
                      <div className="text-sm font-medium text-white">{(data.kelly.winRate * 100).toFixed(1)}%</div>
                    </div>
                    <div className="bg-gray-900/50 p-2 rounded">
                      <div className="text-[10px] text-gray-500">Avg Win/Loss</div>
                      <div className="text-sm font-medium text-white">
                        <span className="text-green-400">+{(data.kelly.avgWin * 100).toFixed(1)}%</span>
                        {' / '}
                        <span className="text-red-400">-{(Math.abs(data.kelly.avgLoss) * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-cyan-900/20 border border-cyan-500/20 rounded-lg p-2 text-center">
                    <div className="text-[10px] text-gray-500 uppercase">Recommended Size per Trade</div>
                    <div className="text-lg font-bold text-cyan-400">{(data.kelly.recommended * 100).toFixed(1)}%</div>
                    <div className="text-[10px] text-gray-500">of portfolio</div>
                  </div>
                </div>
              )}

              {data.positionSizing.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Per-Asset Recommendations</h4>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {data.positionSizing.map((pos, i) => (
                      <div key={i} className="bg-gray-900/30 p-2 rounded flex items-center justify-between">
                        <div>
                          <span className="text-xs text-gray-300 font-medium">{pos.asset || pos.ticker || 'Unknown'}</span>
                          <p className="text-[10px] text-gray-500">{pos.reason}</p>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-cyan-400 font-mono">{pos.recommended.toFixed(1)}%</div>
                          <div className="text-[10px] text-gray-500">max: {pos.maxAllowed.toFixed(1)}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-xs text-center py-4">
                  No per-asset sizing recommendations available.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default RiskDashboard;
