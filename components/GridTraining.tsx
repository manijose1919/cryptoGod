import React, { useState, useEffect, useRef } from 'react';
import type { GridTrainingStatus, GridTrainingResults } from '../types';
import * as api from '../services/historicalTrainingService';

export const GridTraining: React.FC = () => {
  const [status, setStatus] = useState<GridTrainingStatus | null>(null);
  const [results, setResults] = useState<GridTrainingResults | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getGridTrainingStatus();
        setStatus(s);
        if (!s.running) {
          setRunning(false);
          const r = await api.getGridTrainingResults();
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
      await api.startGridTraining();
      setRunning(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopGridTraining(); } catch {}
    setRunning(false);
  };

  // Build heatmap from results
  const gridCounts = results ? [...new Set(results.combos.map(c => c.gridCount))].sort((a, b) => a - b) : [];
  const gridWidths = results ? [...new Set(results.combos.map(c => c.gridWidth))].sort((a, b) => a - b) : [];
  const comboMap = new Map<string, typeof results.combos[0]>();
  results?.combos.forEach(c => comboMap.set(`${c.gridCount}-${c.gridWidth}`, c));

  const maxPnl = results ? Math.max(...results.combos.map(c => Math.abs(c.totalPnl)), 1) : 1;

  function heatColor(pnl: number): string {
    const intensity = Math.min(Math.abs(pnl) / maxPnl, 1);
    if (pnl > 0) return `rgba(34, 197, 94, ${0.2 + intensity * 0.6})`;
    if (pnl < 0) return `rgba(239, 68, 68, ${0.2 + intensity * 0.6})`;
    return 'rgba(107, 114, 128, 0.3)';
  }

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-emerald-300">Grid Trading Training</h3>
        {!running ? (
          <button onClick={handleStart} className="text-xs px-3 py-1 bg-emerald-600 hover:bg-emerald-700 rounded transition-colors">
            Start Grid Sweep
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
              Grid: {status.currentCombo?.gridCount ?? '?'} levels x {status.currentCombo?.gridWidth ?? '?'}% width
            </span>
            <span>{status.completedCombos}/{status.totalCombos} ({status.pct}%)</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-emerald-500 h-2 rounded-full transition-all" style={{ width: `${status.pct}%` }} />
          </div>
        </div>
      )}

      {results && (
        <>
          {results.bestCombo && (
            <div className="bg-green-900/20 border border-green-500/50 rounded p-3">
              <div className="text-xs text-green-300 font-semibold mb-1">Best Grid Configuration</div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div><span className="text-gray-400">Grids:</span> <span className="text-white">{results.bestCombo.gridCount}</span></div>
                <div><span className="text-gray-400">Width:</span> <span className="text-white">{results.bestCombo.gridWidth}%</span></div>
                <div><span className="text-gray-400">P&L:</span> <span className={results.bestCombo.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>{results.bestCombo.totalPnl}%</span></div>
                <div><span className="text-gray-400">Fills:</span> <span className="text-white">{results.bestCombo.totalFills}</span></div>
              </div>
            </div>
          )}

          {/* Heatmap */}
          <div>
            <div className="text-xs text-gray-400 mb-1">P&L Heatmap (Grid Count vs Width)</div>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="py-1 px-2 text-gray-500">Count\Width</th>
                    {gridWidths.map(w => (
                      <th key={w} className="py-1 px-2 text-gray-400">{w}%</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gridCounts.map(count => (
                    <tr key={count}>
                      <td className="py-1 px-2 text-gray-400 font-mono">{count}</td>
                      {gridWidths.map(width => {
                        const combo = comboMap.get(`${count}-${width}`);
                        if (!combo) return <td key={width} className="py-1 px-2 text-gray-600">-</td>;
                        return (
                          <td
                            key={width}
                            className="py-1 px-2 text-center font-mono rounded"
                            style={{ backgroundColor: heatColor(combo.totalPnl) }}
                            title={`${combo.totalFills} fills, ${combo.avgPnlPerFill}% avg/fill`}
                          >
                            {combo.totalPnl > 0 ? '+' : ''}{combo.totalPnl}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
