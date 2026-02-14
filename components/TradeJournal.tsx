import React, { useState, useEffect } from 'react';

interface JournalEntry {
  id: number;
  session_id: string;
  period_start: number;
  period_end: number;
  total_trades: number;
  total_pnl: number;
  win_rate: number;
  strategyBreakdown: Record<string, { trades: number; winRate: string; totalPnl: string; avgPnl: string }>;
  bestTrades: { ticker: string; strategy: string; pnl: string; timestamp: number }[];
  worstTrades: { ticker: string; strategy: string; pnl: string; timestamp: number }[];
  max_drawdown: number;
  recommendations: string[];
  created_at: number;
}

export const TradeJournal: React.FC = () => {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadEntries = async () => {
    try {
      const res = await fetch('/api/journal');
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
      }
    } catch (e) { /* ignore */ }
  };

  useEffect(() => {
    loadEntries();
    const interval = setInterval(loadEntries, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await fetch('/api/journal/generate', { method: 'POST' });
      await loadEntries();
    } catch (e) { /* ignore */ }
    setGenerating(false);
  };

  const formatDate = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-cyan-300">Trade Journal</h3>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="text-[10px] px-2 py-1 bg-cyan-800/50 hover:bg-cyan-700/50 rounded text-cyan-300 disabled:opacity-50"
        >
          {generating ? 'Generating...' : 'Generate Now'}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-gray-400">No journal entries yet. Entries auto-generate every 20 trades.</div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto custom-scrollbar">
          {entries.map(entry => (
            <div key={entry.id} className="bg-gray-800/50 rounded p-3">
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold ${entry.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${entry.total_pnl.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {entry.total_trades} trades | {entry.win_rate.toFixed(0)}% WR
                  </span>
                </div>
                <span className="text-[10px] text-gray-500">{formatDate(entry.created_at)}</span>
              </div>

              {expanded === entry.id && (
                <div className="mt-3 space-y-3">
                  {/* Strategy Breakdown */}
                  <div>
                    <div className="text-[10px] text-gray-400 mb-1 font-semibold">Strategy Breakdown</div>
                    <div className="space-y-1">
                      {Object.entries(entry.strategyBreakdown).map(([strat, data]) => (
                        <div key={strat} className="flex items-center gap-2">
                          <span className="text-[10px] text-cyan-400 w-20">{strat}</span>
                          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${parseFloat(data.totalPnl) >= 0 ? 'bg-green-500' : 'bg-red-500'}`}
                              style={{ width: `${Math.min(100, parseFloat(data.winRate))}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-300 w-16 text-right">{data.winRate}% WR</span>
                          <span className={`text-[10px] w-16 text-right ${parseFloat(data.totalPnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ${data.totalPnl}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Best/Worst Trades */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[10px] text-green-400 mb-1 font-semibold">Best Trades</div>
                      {entry.bestTrades.map((t, i) => (
                        <div key={i} className="text-[10px] text-gray-300">
                          {t.ticker} ({t.strategy}): <span className="text-green-400">${t.pnl}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-[10px] text-red-400 mb-1 font-semibold">Worst Trades</div>
                      {entry.worstTrades.map((t, i) => (
                        <div key={i} className="text-[10px] text-gray-300">
                          {t.ticker} ({t.strategy}): <span className="text-red-400">${t.pnl}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Max Drawdown */}
                  <div className="text-[10px] text-gray-400">
                    Max Drawdown: <span className="text-yellow-400">${entry.max_drawdown.toFixed(2)}</span>
                  </div>

                  {/* Recommendations */}
                  {entry.recommendations.length > 0 && (
                    <div>
                      <div className="text-[10px] text-yellow-400 mb-1 font-semibold">Recommendations</div>
                      {entry.recommendations.map((rec, i) => (
                        <div key={i} className="text-[10px] text-gray-300">- {rec}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TradeJournal;
