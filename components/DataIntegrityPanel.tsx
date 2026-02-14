import React, { useState, useEffect, useCallback } from 'react';

interface PairQuality {
  pair: string;
  qualityScore: number;
  gaps: number;
  staleMinutes: number;
  ohlcValid: boolean;
  lastUpdate: number;
  issues: string[];
}

interface DataIntegrityData {
  overallScore: number;
  pairs: PairQuality[];
  totalGaps: number;
  staleCount: number;
  ohlcErrors: number;
  timestamp: number;
}

type StatusLevel = 'good' | 'warning' | 'error';

function getStatusIcon(level: StatusLevel): string {
  switch (level) {
    case 'good': return '\u2714';
    case 'warning': return '\u26A0';
    case 'error': return '\u2716';
  }
}

function getStatusColor(level: StatusLevel): string {
  switch (level) {
    case 'good': return 'text-green-400';
    case 'warning': return 'text-yellow-400';
    case 'error': return 'text-red-400';
  }
}

function getStatusBg(level: StatusLevel): string {
  switch (level) {
    case 'good': return 'bg-green-900/30';
    case 'warning': return 'bg-yellow-900/30';
    case 'error': return 'bg-red-900/30';
  }
}

function getQualityLevel(score: number): StatusLevel {
  if (score >= 80) return 'good';
  if (score >= 50) return 'warning';
  return 'error';
}

function QualityBar({ score }: { score: number }) {
  const level = getQualityLevel(score);
  const barColor = level === 'good' ? 'bg-green-500' : level === 'warning' ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="w-full bg-gray-700/50 rounded-full h-1.5">
      <div
        className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: `${Math.min(score, 100)}%` }}
      />
    </div>
  );
}

function PairRow({ pair }: { pair: PairQuality }) {
  const [expanded, setExpanded] = useState(false);
  const level = getQualityLevel(pair.qualityScore);
  const staleLevel: StatusLevel = pair.staleMinutes > 10 ? 'error' : pair.staleMinutes > 3 ? 'warning' : 'good';
  const ohlcLevel: StatusLevel = pair.ohlcValid ? 'good' : 'error';

  return (
    <div className="bg-gray-900/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-2 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`text-sm ${getStatusColor(level)}`}>{getStatusIcon(level)}</span>
          <span className="text-xs text-gray-300 font-medium">{pair.pair}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-mono ${getStatusColor(level)}`}>
            {pair.qualityScore.toFixed(0)}%
          </span>
          <span className="text-gray-600 text-xs">{expanded ? '\u25BC' : '\u25B6'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-2 pb-2 border-t border-white/5 space-y-2 pt-2">
          <QualityBar score={pair.qualityScore} />

          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div className={`p-1.5 rounded ${getStatusBg(pair.gaps > 5 ? 'error' : pair.gaps > 0 ? 'warning' : 'good')}`}>
              <div className="text-gray-500">Gaps</div>
              <div className={getStatusColor(pair.gaps > 5 ? 'error' : pair.gaps > 0 ? 'warning' : 'good')}>
                {pair.gaps}
              </div>
            </div>
            <div className={`p-1.5 rounded ${getStatusBg(staleLevel)}`}>
              <div className="text-gray-500">Stale</div>
              <div className={getStatusColor(staleLevel)}>
                {pair.staleMinutes > 0 ? `${pair.staleMinutes}m` : 'Fresh'}
              </div>
            </div>
            <div className={`p-1.5 rounded ${getStatusBg(ohlcLevel)}`}>
              <div className="text-gray-500">OHLC</div>
              <div className={getStatusColor(ohlcLevel)}>
                {getStatusIcon(ohlcLevel)} {pair.ohlcValid ? 'Valid' : 'Error'}
              </div>
            </div>
          </div>

          {pair.issues.length > 0 && (
            <div className="space-y-0.5">
              {pair.issues.map((issue, i) => (
                <p key={i} className="text-[10px] text-yellow-400/80 pl-2 border-l border-yellow-500/30">
                  {issue}
                </p>
              ))}
            </div>
          )}

          <div className="text-[10px] text-gray-600">
            Last update: {new Date(pair.lastUpdate).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}

export const DataIntegrityPanel: React.FC = () => {
  const [data, setData] = useState<DataIntegrityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIntegrity = useCallback(async () => {
    try {
      // Try dedicated endpoint first, fall back to system status
      let result: any;
      try {
        const response = await fetch('/api/data-integrity');
        if (response.ok) {
          result = await response.json();
        } else {
          throw new Error('Fallback to system status');
        }
      } catch {
        const response = await fetch('/api/system/status');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const sysResult = await response.json();
        result = sysResult.data_integrity || sysResult.dataIntegrity || sysResult;
      }

      // Normalize pairs data
      const rawPairs = result.pairs || result.pair_quality || result.assets || [];
      const pairs: PairQuality[] = rawPairs.map((p: any) => ({
        pair: p.pair || p.symbol || p.name || 'Unknown',
        qualityScore: p.qualityScore ?? p.quality_score ?? p.score ?? 100,
        gaps: p.gaps ?? p.gap_count ?? 0,
        staleMinutes: p.staleMinutes ?? p.stale_minutes ?? 0,
        ohlcValid: p.ohlcValid ?? p.ohlc_valid ?? true,
        lastUpdate: p.lastUpdate ?? p.last_update ?? Date.now(),
        issues: p.issues || [],
      }));

      // Sort by quality score (worst first)
      pairs.sort((a, b) => a.qualityScore - b.qualityScore);

      setData({
        overallScore: result.overallScore ?? result.overall_score ?? (pairs.length > 0
          ? pairs.reduce((s: number, p: PairQuality) => s + p.qualityScore, 0) / pairs.length
          : 100),
        pairs,
        totalGaps: result.totalGaps ?? result.total_gaps ?? pairs.reduce((s: number, p: PairQuality) => s + p.gaps, 0),
        staleCount: result.staleCount ?? result.stale_count ?? pairs.filter((p: PairQuality) => p.staleMinutes > 3).length,
        ohlcErrors: result.ohlcErrors ?? result.ohlc_errors ?? pairs.filter((p: PairQuality) => !p.ohlcValid).length,
        timestamp: result.timestamp ?? Date.now(),
      });
      setError(null);
    } catch (err) {
      console.error('DataIntegrityPanel fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data integrity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrity();
    const interval = setInterval(fetchIntegrity, 10000);
    return () => clearInterval(interval);
  }, [fetchIntegrity]);

  const overallLevel = data ? getQualityLevel(data.overallScore) : 'good';

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#128202;</span> Data Integrity
          </h3>
          <button
            onClick={fetchIntegrity}
            className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Checking data integrity...</span>
        </div>
      ) : error && !data ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchIntegrity}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* Overall Score */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-gray-500 uppercase tracking-wider">Overall Quality</span>
              <div className="flex items-center gap-2">
                <span className={`text-2xl font-bold ${getStatusColor(overallLevel)}`}>
                  {data.overallScore.toFixed(0)}%
                </span>
                <span className={`text-lg ${getStatusColor(overallLevel)}`}>
                  {getStatusIcon(overallLevel)}
                </span>
              </div>
            </div>
          </div>

          <QualityBar score={data.overallScore} />

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className={`p-2 rounded text-center ${data.totalGaps > 0 ? 'bg-yellow-900/30' : 'bg-green-900/30'}`}>
              <div className="text-[10px] text-gray-500 uppercase">Gaps</div>
              <div className={`text-sm font-medium ${data.totalGaps > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                {data.totalGaps}
              </div>
            </div>
            <div className={`p-2 rounded text-center ${data.staleCount > 0 ? 'bg-orange-900/30' : 'bg-green-900/30'}`}>
              <div className="text-[10px] text-gray-500 uppercase">Stale</div>
              <div className={`text-sm font-medium ${data.staleCount > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                {data.staleCount}
              </div>
            </div>
            <div className={`p-2 rounded text-center ${data.ohlcErrors > 0 ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
              <div className="text-[10px] text-gray-500 uppercase">OHLC Err</div>
              <div className={`text-sm font-medium ${data.ohlcErrors > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {data.ohlcErrors}
              </div>
            </div>
          </div>

          {/* Per-Pair Quality */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Per-Pair Quality ({data.pairs.length} pairs)
            </h4>
            <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {data.pairs.length > 0 ? (
                data.pairs.map((pair, i) => (
                  <PairRow key={i} pair={pair} />
                ))
              ) : (
                <p className="text-gray-500 text-xs text-center py-3">No pair data available</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DataIntegrityPanel;
