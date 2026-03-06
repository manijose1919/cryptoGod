import React, { useState, useEffect, useRef } from 'react';
import type { MonteCarloResults as MCResults, MonteCarloStatus } from '../types';
import * as api from '../services/historicalTrainingService';

interface Props {
  runId: string | null;
}

export const MonteCarloResults: React.FC<Props> = ({ runId }) => {
  const [status, setStatus] = useState<MonteCarloStatus | null>(null);
  const [results, setResults] = useState<MCResults | null>(null);
  const [running, setRunning] = useState(false);
  const [iterations, setIterations] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll status while running
  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getMonteCarloStatus();
        setStatus(s);
        if (!s.running && s.pct >= 100) {
          setRunning(false);
          if (runId) {
            const r = await api.getMonteCarloResults(runId);
            setResults(r);
          }
        }
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [running, runId]);

  // Load existing results when runId changes
  useEffect(() => {
    if (!runId) { setResults(null); return; }
    api.getMonteCarloResults(runId).then(setResults).catch(() => setResults(null));
  }, [runId]);

  const handleStart = async () => {
    if (!runId) return;
    setError(null);
    try {
      await api.startMonteCarlo(runId, iterations);
      setRunning(true);
      setResults(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopMonteCarlo(); } catch {}
    setRunning(false);
  };

  if (!runId) return null;

  const maxHist = results ? Math.max(...results.histogram, 1) : 1;

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-blue-300">Monte Carlo Stress Test</h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={iterations}
            onChange={e => setIterations(Math.max(100, parseInt(e.target.value) || 1000))}
            className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
            disabled={running}
          />
          <span className="text-xs text-gray-400">iterations</span>
          {!running ? (
            <button onClick={handleStart} className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded transition-colors">
              Run MC
            </button>
          ) : (
            <button onClick={handleStop} className="text-xs px-3 py-1 bg-red-600 hover:bg-red-700 rounded transition-colors">
              Stop
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {running && status && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Simulating...</span>
            <span>{status.completed}/{status.iterations} ({status.pct}%)</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${status.pct}%` }} />
          </div>
        </div>
      )}

      {results && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-2">
            <StatCard label="Median P&L" value={`$${results.medianPnl.toFixed(2)}`} color={results.medianPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
            <StatCard label="Mean P&L" value={`$${results.meanPnl.toFixed(2)}`} color={results.meanPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
            <StatCard label="P5 / P95" value={`$${results.p5Pnl.toFixed(0)} / $${results.p95Pnl.toFixed(0)}`} color="text-yellow-400" />
            <StatCard
              label="Prob. of Profit"
              value={`${(results.probabilityOfProfit * 100).toFixed(1)}%`}
              color={results.probabilityOfProfit >= 0.5 ? 'text-green-400' : 'text-red-400'}
            />
          </div>

          {/* Histogram */}
          <div className="mt-2">
            <div className="text-xs text-gray-400 mb-1">P&L Distribution ({results.iterations} simulations)</div>
            <div className="flex items-end gap-px h-24 bg-gray-900/50 rounded p-1">
              {results.histogram.map((count, i) => {
                const pnlAtBucket = results.histogramMin + i * results.bucketWidth;
                const isProfit = pnlAtBucket >= 0;
                return (
                  <div
                    key={i}
                    className={`flex-1 rounded-t ${isProfit ? 'bg-green-500/70' : 'bg-red-500/70'}`}
                    style={{ height: `${(count / maxHist) * 100}%`, minHeight: count > 0 ? '2px' : '0' }}
                    title={`$${pnlAtBucket.toFixed(0)}: ${count} sims`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
              <span>${results.histogramMin.toFixed(0)}</span>
              <span>$0</span>
              <span>${results.histogramMax.toFixed(0)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-900/50 rounded p-2 text-center">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-mono ${color}`}>{value}</div>
    </div>
  );
}
