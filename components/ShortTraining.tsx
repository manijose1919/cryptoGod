import React, { useState, useEffect, useRef } from 'react';
import type { ShortTrainingStatus, ShortTrainingResults } from '../types';
import * as api from '../services/historicalTrainingService';

export const ShortTraining: React.FC = () => {
  const [status, setStatus] = useState<ShortTrainingStatus | null>(null);
  const [results, setResults] = useState<ShortTrainingResults | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getShortTrainingStatus();
        setStatus(s);
        if (!s.running) {
          setRunning(false);
          const r = await api.getShortTrainingResults();
          setResults(r);
        }
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [running]);

  const handleStart = async () => {
    setError(null);
    setResults(null);
    try {
      await api.startShortTraining();
      setRunning(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopShortTraining(); } catch {}
    setRunning(false);
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-rose-300">Short Selling Training</h3>
        {!running ? (
          <button onClick={handleStart} className="text-xs px-3 py-1 bg-rose-600 hover:bg-rose-700 rounded transition-colors">
            Start Short Sweep
          </button>
        ) : (
          <button onClick={handleStop} className="text-xs px-3 py-1 bg-red-600 hover:bg-red-700 rounded transition-colors">
            Stop
          </button>
        )}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {running && status && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-400">
            <span>
              SL={status.currentCombo?.sl ? (status.currentCombo.sl * 100).toFixed(0) : '?'}%
              TP={status.currentCombo?.tp ? (status.currentCombo.tp * 100).toFixed(0) : '?'}%
              Conf={status.currentCombo?.confidence ?? '?'}
            </span>
            <span>{status.completedCombos}/{status.totalCombos} ({status.pct}%)</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-rose-500 h-2 rounded-full transition-all" style={{ width: `${status.pct}%` }} />
          </div>
        </div>
      )}

      {results && (
        <>
          {/* Best combo highlight */}
          {results.bestCombo && (
            <div className="bg-green-900/20 border border-green-500/50 rounded p-3">
              <div className="text-xs text-green-300 font-semibold mb-1">Best Combination</div>
              <div className="grid grid-cols-5 gap-2 text-xs">
                <div><span className="text-gray-400">SL:</span> <span className="text-white">{results.bestCombo.sl}%</span></div>
                <div><span className="text-gray-400">TP:</span> <span className="text-white">{results.bestCombo.tp}%</span></div>
                <div><span className="text-gray-400">Conf:</span> <span className="text-white">{results.bestCombo.confidence}</span></div>
                <div><span className="text-gray-400">P&L:</span> <span className={results.bestCombo.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>{results.bestCombo.totalPnl}%</span></div>
                <div><span className="text-gray-400">WR:</span> <span className="text-white">{results.bestCombo.winRate}%</span></div>
              </div>
            </div>
          )}

          {/* Top 10 results table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-1 px-2">#</th>
                  <th className="text-center py-1 px-2">SL%</th>
                  <th className="text-center py-1 px-2">TP%</th>
                  <th className="text-center py-1 px-2">Conf</th>
                  <th className="text-center py-1 px-2">P&L%</th>
                  <th className="text-center py-1 px-2">Trades</th>
                  <th className="text-center py-1 px-2">WR%</th>
                  <th className="text-center py-1 px-2">Avg P&L</th>
                </tr>
              </thead>
              <tbody>
                {results.combos.slice(0, 15).map((c, i) => (
                  <tr key={i} className={i === 0 ? 'bg-green-900/10' : ''}>
                    <td className="py-1 px-2 text-gray-500">{i + 1}</td>
                    <td className="text-center py-1 px-2">{c.sl}</td>
                    <td className="text-center py-1 px-2">{c.tp}</td>
                    <td className="text-center py-1 px-2">{c.confidence}</td>
                    <td className={`text-center py-1 px-2 font-mono ${c.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{c.totalPnl}</td>
                    <td className="text-center py-1 px-2">{c.totalTrades}</td>
                    <td className="text-center py-1 px-2">{c.winRate}</td>
                    <td className={`text-center py-1 px-2 font-mono ${c.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{c.avgPnl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-gray-500">Showing top 15 of {results.totalCombos} combinations. Tickers: {results.tickers.join(', ')}</div>
        </>
      )}
    </div>
  );
};
