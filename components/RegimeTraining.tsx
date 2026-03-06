import React, { useState, useEffect, useRef } from 'react';
import type { RegimeTrainingStatus } from '../types';
import * as api from '../services/historicalTrainingService';

const REGIME_COLORS: Record<string, string> = {
  STRONG_UP: 'border-green-500 bg-green-900/20',
  UP: 'border-emerald-500 bg-emerald-900/20',
  SIDEWAYS: 'border-yellow-500 bg-yellow-900/20',
  DOWN: 'border-orange-500 bg-orange-900/20',
  STRONG_DOWN: 'border-red-500 bg-red-900/20',
};

const REGIME_LABELS: Record<string, string> = {
  STRONG_UP: 'Strong Up',
  UP: 'Up',
  SIDEWAYS: 'Sideways',
  DOWN: 'Down',
  STRONG_DOWN: 'Strong Down',
};

export const RegimeTraining: React.FC = () => {
  const [status, setStatus] = useState<RegimeTrainingStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compositeResult, setCompositeResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getRegimeTrainingStatus();
        setStatus(s);
        if (!s.running) setRunning(false);
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [running]);

  const handleStart = async () => {
    setError(null);
    setCompositeResult(null);
    try {
      await api.startRegimeTraining();
      setRunning(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopRegimeTraining(); } catch {}
    setRunning(false);
  };

  const handleComposite = async () => {
    setCompositeResult(null);
    try {
      // Find best regime run to use as base
      const bestRegime = status?.regimeResults
        ? Object.entries(status.regimeResults).sort((a, b) => b[1].pnl - a[1].pnl)[0]
        : null;
      const baseRunId = bestRegime?.[1]?.runId;
      const result = await api.createRegimeComposite(baseRunId || undefined);
      setCompositeResult(`Created composite seed: ${result.runId}`);
    } catch (e: any) {
      setCompositeResult(`Error: ${e.message}`);
    }
  };

  const allDone = status && !status.running && status.completedRegimes === status.totalRegimes && status.completedRegimes > 0;

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-amber-300">Regime-Specific Training</h3>
        <div className="flex gap-2">
          {!running ? (
            <button onClick={handleStart} className="text-xs px-3 py-1 bg-amber-600 hover:bg-amber-700 rounded transition-colors">
              Train All Regimes
            </button>
          ) : (
            <button onClick={handleStop} className="text-xs px-3 py-1 bg-red-600 hover:bg-red-700 rounded transition-colors">
              Stop
            </button>
          )}
          {allDone && (
            <button onClick={handleComposite} className="text-xs px-3 py-1 bg-green-600 hover:bg-green-700 rounded transition-colors">
              Create Composite
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {compositeResult && (
        <div className={`text-xs p-2 rounded ${compositeResult.startsWith('Error') ? 'bg-red-900/30 text-red-300' : 'bg-green-900/30 text-green-300'}`}>
          {compositeResult}
        </div>
      )}

      {/* Progress */}
      {running && status && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Training regime: <span className="text-white">{status.currentRegime}</span></span>
            <span>{status.completedRegimes}/{status.totalRegimes} ({status.pct}%)</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-amber-500 h-2 rounded-full transition-all" style={{ width: `${status.pct}%` }} />
          </div>
        </div>
      )}

      {/* Regime cards */}
      {status && Object.keys(status.regimeResults).length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {Object.entries(REGIME_LABELS).map(([regime, label]) => {
            const data = status.regimeResults[regime];
            const isActive = running && status.currentRegime === regime;
            return (
              <div
                key={regime}
                className={`border rounded p-2 text-center ${REGIME_COLORS[regime]} ${isActive ? 'ring-2 ring-white/30' : ''}`}
              >
                <div className="text-[10px] font-semibold">{label}</div>
                {data ? (
                  <>
                    <div className={`text-sm font-mono ${data.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${data.pnl.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {data.trades} trades | {data.winRate.toFixed(0)}% WR
                    </div>
                    {data.status === 'error' && <div className="text-[10px] text-red-400">Error</div>}
                  </>
                ) : (
                  <div className="text-[10px] text-gray-600">
                    {isActive ? 'Running...' : 'Pending'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {status?.compositeRunId && (
        <div className="text-xs text-green-400">
          Composite seed: <span className="font-mono">{status.compositeRunId}</span>
        </div>
      )}
    </div>
  );
};
