import React, { useState, useEffect, useCallback } from 'react';

interface SectorBreakdown {
  name: string;
  heat: number;
  positions: number;
  exposure: number;
}

interface ConcentrationWarning {
  type: 'high_concentration' | 'sector_overweight' | 'correlated_risk' | 'single_asset';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  asset?: string;
}

interface ReductionRecommendation {
  asset: string;
  currentWeight: number;
  recommendedWeight: number;
  reason: string;
}

interface PortfolioHeatData {
  totalHeat: number;
  maxHeat: number;
  sectors: SectorBreakdown[];
  warnings: ConcentrationWarning[];
  recommendations: ReductionRecommendation[];
  timestamp: number;
}

function HeatGauge({ heat, maxHeat }: { heat: number; maxHeat: number }) {
  const percentage = Math.min((heat / maxHeat) * 100, 100);

  const getGradientStops = () => {
    return (
      <>
        <stop offset="0%" stopColor="#22c55e" />
        <stop offset="33%" stopColor="#22c55e" />
        <stop offset="50%" stopColor="#eab308" />
        <stop offset="66%" stopColor="#f97316" />
        <stop offset="100%" stopColor="#ef4444" />
      </>
    );
  };

  const getHeatLabel = (h: number) => {
    if (h <= 10) return { text: 'Cool', color: 'text-green-400' };
    if (h <= 20) return { text: 'Warm', color: 'text-yellow-400' };
    if (h <= 25) return { text: 'Hot', color: 'text-orange-400' };
    return { text: 'Overheated', color: 'text-red-400' };
  };

  const { text, color } = getHeatLabel(heat);

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-end">
        <div>
          <span className="text-xs text-gray-500 uppercase tracking-wider">Portfolio Heat</span>
          <div className={`text-2xl font-bold ${color}`}>
            {heat.toFixed(1)}<span className="text-sm text-gray-500">/{maxHeat}</span>
          </div>
        </div>
        <span className={`text-sm font-semibold ${color}`}>{text}</span>
      </div>

      {/* Heat bar with gradient */}
      <div className="relative">
        <svg width="100%" height="12" className="rounded-full overflow-hidden">
          <defs>
            <linearGradient id="heatGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              {getGradientStops()}
            </linearGradient>
          </defs>
          <rect width="100%" height="12" fill="#374151" rx="6" />
          <rect
            width={`${percentage}%`}
            height="12"
            fill="url(#heatGradient)"
            rx="6"
            style={{ transition: 'width 0.8s ease' }}
          />
        </svg>
        {/* Needle indicator */}
        <div
          className="absolute top-0 w-0.5 h-4 -mt-1 bg-white shadow-lg shadow-white/50 rounded-full transition-all duration-500"
          style={{ left: `${percentage}%` }}
        />
      </div>

      {/* Scale labels */}
      <div className="flex justify-between text-[10px] text-gray-600">
        <span>0</span>
        <span>10</span>
        <span>20</span>
        <span>30</span>
      </div>
    </div>
  );
}

function SectorBar({ sector }: { sector: SectorBreakdown }) {
  const heatPct = Math.min((sector.heat / 30) * 100, 100);

  const getColor = (h: number) => {
    if (h <= 8) return 'bg-green-500';
    if (h <= 15) return 'bg-yellow-500';
    if (h <= 22) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center text-xs">
        <span className="text-gray-300 font-medium">{sector.name}</span>
        <div className="flex items-center gap-3">
          <span className="text-gray-500">{sector.positions} pos</span>
          <span className="text-gray-400 font-mono">{sector.heat.toFixed(1)}</span>
        </div>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${getColor(sector.heat)}`}
          style={{ width: `${heatPct}%` }}
        />
      </div>
    </div>
  );
}

function WarningItem({ warning }: { warning: ConcentrationWarning }) {
  const getStyle = (severity: string) => {
    switch (severity) {
      case 'critical': return { icon: '\u2716', bg: 'bg-red-900/30', text: 'text-red-400', border: 'border-red-500/30' };
      case 'warning': return { icon: '\u26A0', bg: 'bg-yellow-900/30', text: 'text-yellow-400', border: 'border-yellow-500/30' };
      default: return { icon: '\u2139', bg: 'bg-cyan-900/30', text: 'text-cyan-400', border: 'border-cyan-500/30' };
    }
  };

  const style = getStyle(warning.severity);

  return (
    <div className={`flex items-start gap-2 p-2 rounded border ${style.bg} ${style.border}`}>
      <span className={`${style.text} text-sm mt-0.5`}>{style.icon}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-xs ${style.text}`}>{warning.message}</p>
        {warning.asset && <p className="text-[10px] text-gray-500 mt-0.5">Asset: {warning.asset}</p>}
      </div>
    </div>
  );
}

export const PortfolioHeatPanel: React.FC = () => {
  const [data, setData] = useState<PortfolioHeatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRecommendations, setShowRecommendations] = useState(false);

  const fetchHeatData = useCallback(async () => {
    try {
      const response = await fetch('/api/system/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      const portfolioHeat = result.portfolio_heat || result.portfolioHeat || {};

      // Normalize sectors
      const sectors: SectorBreakdown[] = portfolioHeat.sectors || portfolioHeat.sector_breakdown || [
        { name: 'Major (BTC/ETH)', heat: portfolioHeat.major_heat ?? 0, positions: portfolioHeat.major_positions ?? 0, exposure: portfolioHeat.major_exposure ?? 0 },
        { name: 'Alt L1 (SOL/ADA/AVAX)', heat: portfolioHeat.alt_heat ?? 0, positions: portfolioHeat.alt_positions ?? 0, exposure: portfolioHeat.alt_exposure ?? 0 },
        { name: 'Other (DOGE/LINK/DOT)', heat: portfolioHeat.other_heat ?? 0, positions: portfolioHeat.other_positions ?? 0, exposure: portfolioHeat.other_exposure ?? 0 },
      ];

      const warnings: ConcentrationWarning[] = portfolioHeat.warnings || portfolioHeat.concentration_warnings || [];
      const recommendations: ReductionRecommendation[] = portfolioHeat.recommendations || portfolioHeat.reduction_recommendations || [];

      setData({
        totalHeat: portfolioHeat.total_heat ?? portfolioHeat.totalHeat ?? portfolioHeat.heat ?? 0,
        maxHeat: portfolioHeat.max_heat ?? portfolioHeat.maxHeat ?? 30,
        sectors,
        warnings,
        recommendations,
        timestamp: result.timestamp ?? Date.now(),
      });
      setError(null);
    } catch (err) {
      console.error('PortfolioHeatPanel fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch portfolio heat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHeatData();
    const interval = setInterval(fetchHeatData, 5000);
    return () => clearInterval(interval);
  }, [fetchHeatData]);

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#128293;</span> Portfolio Heat
          </h3>
          <button
            onClick={fetchHeatData}
            className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Loading heat map...</span>
        </div>
      ) : error && !data ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchHeatData}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* Main Heat Gauge */}
          <HeatGauge heat={data.totalHeat} maxHeat={data.maxHeat} />

          {/* Sector Breakdown */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Sector Breakdown</h4>
            {data.sectors.map((sector, i) => (
              <SectorBar key={i} sector={sector} />
            ))}
          </div>

          {/* Concentration Warnings */}
          {data.warnings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Concentration Warnings ({data.warnings.length})
              </h4>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {data.warnings.map((warning, i) => (
                  <WarningItem key={i} warning={warning} />
                ))}
              </div>
            </div>
          )}

          {/* Reduction Recommendations */}
          {data.recommendations.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowRecommendations(!showRecommendations)}
                className="flex items-center gap-1 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-300"
              >
                <span>{showRecommendations ? '\u25BC' : '\u25B6'}</span>
                Recommendations ({data.recommendations.length})
              </button>
              {showRecommendations && (
                <div className="space-y-1.5">
                  {data.recommendations.map((rec, i) => (
                    <div key={i} className="bg-gray-900/50 p-2 rounded text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-gray-300 font-medium">{rec.asset}</span>
                        <div className="flex items-center gap-1">
                          <span className="text-red-400">{rec.currentWeight.toFixed(1)}%</span>
                          <span className="text-gray-600">&rarr;</span>
                          <span className="text-green-400">{rec.recommendedWeight.toFixed(1)}%</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">{rec.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Quick Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Sectors</div>
              <div className="text-sm font-medium text-white">{data.sectors.length}</div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Positions</div>
              <div className="text-sm font-medium text-white">
                {data.sectors.reduce((s, sec) => s + sec.positions, 0)}
              </div>
            </div>
            <div className="bg-gray-900/50 p-2 rounded text-center">
              <div className="text-[10px] text-gray-500 uppercase">Warnings</div>
              <div className={`text-sm font-medium ${data.warnings.length > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                {data.warnings.length}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default PortfolioHeatPanel;
