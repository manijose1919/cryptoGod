import React, { useState, useEffect, useRef } from 'react';

interface MLThought {
  id: number;
  time: number;
  type: string;
  ticker: string;
  action: string;
  confidence: number;
  reason: string;
  indicators: Record<string, number>;
  feature_importance: Record<string, number>;
  regime: string;
  market_speed: string;
}

interface ThoughtStats {
  total: number;
  buys: number;
  sells: number;
  skips: number;
  scans: number;
  avgConfidence: string;
  topSkipReasons: Array<{ reason: string; count: number }>;
}

interface MLFocus {
  ticker: string;
  type: string;
  confidence: number;
  regime: string;
  time: number;
}

interface Props {
  pollInterval?: number;
}

const typeColors: Record<string, string> = {
  BUY: 'text-green-400',
  SELL: 'text-red-400',
  SKIP: 'text-gray-500',
  REGIME: 'text-purple-400',
  ENTRY_EVAL: 'text-cyan-400',
  SCAN: 'text-blue-400',
  EXIT: 'text-orange-400',
};

const typeBg: Record<string, string> = {
  BUY: 'bg-green-900/30 border-green-700/30',
  SELL: 'bg-red-900/30 border-red-700/30',
  SKIP: 'bg-gray-900/30 border-gray-700/30',
  REGIME: 'bg-purple-900/30 border-purple-700/30',
  ENTRY_EVAL: 'bg-cyan-900/30 border-cyan-700/30',
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

const MLThoughtProcess: React.FC<Props> = ({ pollInterval = 2000 }) => {
  const [thoughts, setThoughts] = useState<MLThought[]>([]);
  const [stats, setStats] = useState<ThoughtStats | null>(null);
  const [focus, setFocus] = useState<MLFocus | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchThoughts = async () => {
      try {
        const res = await fetch('/api/ml/thoughts?limit=50');
        const data = await res.json();
        setThoughts(data.thoughts || []);
        setStats(data.stats || null);
        setFocus(data.focus || null);
      } catch (e) {
        // Silently fail
      }
    };

    fetchThoughts();
    const interval = setInterval(fetchThoughts, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval]);

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          ML Thought Process
          {focus && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-cyan-900/40 border border-cyan-700/30 text-cyan-400">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              {focus.ticker}
            </span>
          )}
        </h3>
      </div>

      {/* Current Focus */}
      {focus && (
        <div className="bg-gray-800/50 rounded-lg p-3 mb-3 border border-cyan-800/30">
          <div className="text-xs text-gray-400 mb-1">Currently Evaluating</div>
          <div className="flex items-center justify-between">
            <span className="text-white font-mono font-bold">{focus.ticker}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400">
                Regime: <span className="text-purple-400">{focus.regime || 'N/A'}</span>
              </span>
              <span className="text-xs text-gray-400">
                Confidence: <span className="text-cyan-400">{focus.confidence || 0}</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Stats Summary */}
      {stats && (
        <div className="grid grid-cols-5 gap-2 mb-3">
          <div className="bg-gray-800/30 rounded p-2 text-center">
            <div className="text-xs text-gray-400">Scans</div>
            <div className="text-sm font-bold text-blue-400">{stats.scans}</div>
          </div>
          <div className="bg-gray-800/30 rounded p-2 text-center">
            <div className="text-xs text-gray-400">Buys</div>
            <div className="text-sm font-bold text-green-400">{stats.buys}</div>
          </div>
          <div className="bg-gray-800/30 rounded p-2 text-center">
            <div className="text-xs text-gray-400">Sells</div>
            <div className="text-sm font-bold text-red-400">{stats.sells}</div>
          </div>
          <div className="bg-gray-800/30 rounded p-2 text-center">
            <div className="text-xs text-gray-400">Skips</div>
            <div className="text-sm font-bold text-gray-400">{stats.skips}</div>
          </div>
          <div className="bg-gray-800/30 rounded p-2 text-center">
            <div className="text-xs text-gray-400">Avg Conf</div>
            <div className="text-sm font-bold text-cyan-400">{stats.avgConfidence}</div>
          </div>
        </div>
      )}

      {/* Top Skip Reasons */}
      {stats && stats.topSkipReasons.length > 0 && (
        <div className="bg-gray-800/30 rounded-lg p-3 mb-3">
          <div className="text-xs text-gray-400 mb-2">Top Skip Reasons</div>
          {stats.topSkipReasons.slice(0, 3).map((r, i) => (
            <div key={i} className="flex justify-between text-xs py-0.5">
              <span className="text-gray-300 truncate mr-2">{r.reason}</span>
              <span className="text-gray-500">{r.count}x</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Decisions */}
      <div className="text-xs text-gray-400 mb-2">Recent Decisions</div>
      <div ref={scrollRef} className="max-h-64 overflow-y-auto custom-scrollbar space-y-1">
        {thoughts.length === 0 ? (
          <div className="text-center text-gray-500 py-4 text-sm">
            No thoughts yet. Start a session to see ML decisions.
          </div>
        ) : (
          thoughts.map((t, i) => (
            <div
              key={t.id || i}
              className={`rounded border px-3 py-2 cursor-pointer transition-all ${
                typeBg[t.type] || 'bg-gray-900/30 border-gray-700/30'
              } ${expanded === i ? 'ring-1 ring-cyan-500/30' : ''}`}
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold ${typeColors[t.type] || 'text-gray-400'}`}>
                    {t.type}
                  </span>
                  {t.ticker && (
                    <span className="text-xs text-white font-mono">{t.ticker}</span>
                  )}
                </div>
                <span className="text-xs text-gray-500">{timeAgo(t.time)}</span>
              </div>
              <div className="text-xs text-gray-300 mt-1 truncate">{t.reason}</div>

              {/* Expanded details */}
              {expanded === i && (
                <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1">
                  {t.confidence > 0 && (
                    <div className="text-xs">
                      <span className="text-gray-400">Confidence: </span>
                      <span className="text-cyan-400">{t.confidence}</span>
                    </div>
                  )}
                  {t.regime && (
                    <div className="text-xs">
                      <span className="text-gray-400">Regime: </span>
                      <span className="text-purple-400">{t.regime}</span>
                    </div>
                  )}
                  {t.indicators && typeof t.indicators === 'object' && Object.keys(t.indicators).length > 0 && (
                    <div className="text-xs">
                      <span className="text-gray-400">Indicators: </span>
                      <span className="text-gray-300 font-mono text-[10px]">
                        {Object.entries(t.indicators).map(([k, v]) =>
                          `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`
                        ).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default MLThoughtProcess;
