import React, { useState, useEffect, useRef } from 'react';
import type { SensitivityStatus, SensitivityResults } from '../types';
import * as api from '../services/historicalTrainingService';

interface Props {
  runId: string | null;
}

export const SensitivityHeatmap: React.FC<Props> = ({ runId }) => {
  const [status, setStatus] = useState<SensitivityStatus | null>(null);
  const [results, setResults] = useState<SensitivityResults | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getSensitivityStatus();
        setStatus(s);
        if (!s.running) {
          setRunning(false);
          if (runId) {
            const r = await api.getSensitivityResults(runId);
            setResults(r);
          }
        }
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [running, runId]);

  useEffect(() => {
    if (!runId) { setResults(null); return; }
    api.getSensitivityResults(runId).then(setResults).catch(() => setResults(null));
  }, [runId]);

  const handleStart = async () => {
    if (!runId) return;
    setError(null);
    try {
      await api.startSensitivityAnalysis(runId);
      setRunning(true);
      setResults(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopSensitivityAnalysis(); } catch {}
    setRunning(false);
  };

  if (!runId) return null;

  const columns = ['-20%', '-10%', 'Base', '10%', '20%'];

  function cellColor(pnlDelta: number): string {
    if (pnlDelta > 20) return 'bg-green-600/60';
    if (pnlDelta > 5) return 'bg-green-800/40';
    if (pnlDelta > -5) return 'bg-gray-700/40';
    if (pnlDelta > -20) return 'bg-red-800/40';
    return 'bg-red-600/60';
  }

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-purple-300">Sensitivity Analysis</h3>
        {!running ? (
          <button onClick={handleStart} className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded transition-colors">
            Run Sensitivity
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
            <span>Testing {status.currentParam} @ {status.currentVariation}</span>
            <span>{status.completedEvals}/{status.totalEvals} ({status.pct}%)</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-purple-500 h-2 rounded-full transition-all" style={{ width: `${status.pct}%` }} />
          </div>
        </div>
      )}

      {results && (
        <>
          {results.fragileParams.length > 0 && (
            <div className="text-xs bg-yellow-900/30 border border-yellow-500/50 text-yellow-300 rounded p-2">
              Fragile params ({'>'} 30% P&amp;L swing at +/-10%): {results.fragileParams.join(', ')}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left py-1 px-2">Parameter</th>
                  {columns.map(c => <th key={c} className="text-center py-1 px-2">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.entries(results?.paramResults || {}).map(([key, data]) => {
                  const isFragile = (results?.fragileParams || []).includes(key);
                  return (
                    <tr key={key} className={isFragile ? 'bg-yellow-900/10' : ''}>
                      <td className={`py-1 px-2 font-mono ${isFragile ? 'text-yellow-300' : 'text-gray-300'}`}>
                        {key}
                      </td>
                      {columns.map(col => {
                        if (col === 'Base') {
                          return (
                            <td key={col} className="text-center py-1 px-2">
                              <span className="bg-gray-600/50 rounded px-2 py-0.5 text-gray-300">
                                ${results.baselinePnl.toFixed(0)}
                              </span>
                            </td>
                          );
                        }
                        const variation = data.variations[col];
                        if (!variation) return <td key={col} className="text-center py-1 px-2 text-gray-600">-</td>;
                        return (
                          <td key={col} className="text-center py-1 px-2">
                            <span className={`rounded px-2 py-0.5 ${cellColor(variation.pnlDelta)}`}>
                              {variation.pnlDelta >= 0 ? '+' : ''}{variation.pnlDelta.toFixed(1)}%
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
