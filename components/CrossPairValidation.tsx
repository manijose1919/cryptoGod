import React, { useState, useEffect, useRef } from 'react';
import type { CrossPairStatus } from '../types';
import * as api from '../services/historicalTrainingService';

const ALL_PAIRS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];

export const CrossPairValidation: React.FC = () => {
  const [trainPairs, setTrainPairs] = useState<string[]>(['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD']);
  const [testPairs, setTestPairs] = useState<string[]>(['DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD']);
  const [status, setStatus] = useState<CrossPairStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getCrossPairStatus();
        setStatus(s);
        if (!s.running) setRunning(false);
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [running]);

  const togglePair = (pair: string, group: 'train' | 'test') => {
    if (group === 'train') {
      if (trainPairs.includes(pair)) {
        setTrainPairs(trainPairs.filter(p => p !== pair));
        setTestPairs([...testPairs, pair]);
      }
    } else {
      if (testPairs.includes(pair)) {
        setTestPairs(testPairs.filter(p => p !== pair));
        setTrainPairs([...trainPairs, pair]);
      }
    }
  };

  const handleStart = async () => {
    if (trainPairs.length < 1 || testPairs.length < 1) {
      setError('Need at least 1 pair in each group');
      return;
    }
    setError(null);
    try {
      await api.startCrossPairValidation({ trainPairs, testPairs });
      setRunning(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    try { await api.stopCrossPairValidation(); } catch {}
    setRunning(false);
  };

  const verdictColor = (v: string) => {
    if (v === 'GOOD') return 'text-green-400';
    if (v === 'MODERATE') return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-semibold text-cyan-300">Cross-Pair Validation</h3>

      {/* Pair selection */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-gray-400 mb-1">Train Pairs ({trainPairs.length})</div>
          <div className="flex flex-wrap gap-1">
            {ALL_PAIRS.map(pair => {
              const inTrain = trainPairs.includes(pair);
              if (!inTrain) return null;
              return (
                <button
                  key={pair}
                  onClick={() => togglePair(pair, 'train')}
                  className="text-[10px] px-2 py-0.5 bg-cyan-600/30 border border-cyan-500/50 rounded hover:bg-red-600/30 transition-colors"
                  disabled={running}
                >
                  {pair.replace('USD', '')}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Test Pairs ({testPairs.length})</div>
          <div className="flex flex-wrap gap-1">
            {ALL_PAIRS.map(pair => {
              const inTest = testPairs.includes(pair);
              if (!inTest) return null;
              return (
                <button
                  key={pair}
                  onClick={() => togglePair(pair, 'test')}
                  className="text-[10px] px-2 py-0.5 bg-orange-600/30 border border-orange-500/50 rounded hover:bg-cyan-600/30 transition-colors"
                  disabled={running}
                >
                  {pair.replace('USD', '')}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="text-[10px] text-gray-500">Click a pair to move it to the other group</div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        {!running ? (
          <button onClick={handleStart} className="text-xs px-3 py-1 bg-cyan-600 hover:bg-cyan-700 rounded transition-colors">
            Start Cross-Pair
          </button>
        ) : (
          <button onClick={handleStop} className="text-xs px-3 py-1 bg-red-600 hover:bg-red-700 rounded transition-colors">
            Stop
          </button>
        )}
      </div>

      {/* Progress */}
      {running && status && (
        <div className="text-xs text-gray-400">
          Phase: <span className="text-white font-semibold">{status.phase}</span>
          {status.trainPnl !== null && <span className="ml-3">Train P&L: <span className={status.trainPnl >= 0 ? 'text-green-400' : 'text-red-400'}>${status.trainPnl.toFixed(2)}</span></span>}
        </div>
      )}

      {/* Results */}
      {!running && status && !status.running && status.generalizationRatio !== null && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-900/50 rounded p-3">
            <div className="text-[10px] text-gray-500 mb-1">Train ({status.trainPairs.join(', ')})</div>
            <div className={`text-lg font-mono ${(status.trainPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${(status.trainPnl ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="bg-gray-900/50 rounded p-3">
            <div className="text-[10px] text-gray-500 mb-1">Test ({status.testPairs.join(', ')})</div>
            <div className={`text-lg font-mono ${(status.testPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${(status.testPnl ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="col-span-2 bg-gray-900/50 rounded p-3 text-center">
            <div className="text-[10px] text-gray-500">Generalization Ratio</div>
            <div className={`text-xl font-mono ${verdictColor(status.generalizationRatio > 0.5 ? 'GOOD' : status.generalizationRatio > 0.3 ? 'MODERATE' : 'OVERFITTING')}`}>
              {status.generalizationRatio.toFixed(3)}
            </div>
            <div className={`text-xs ${verdictColor(status.generalizationRatio > 0.5 ? 'GOOD' : status.generalizationRatio > 0.3 ? 'MODERATE' : 'OVERFITTING')}`}>
              {status.generalizationRatio > 0.5 ? 'GOOD - Generalizes well' : status.generalizationRatio > 0.3 ? 'MODERATE - Some overfitting' : 'OVERFITTING - Strategy too pair-specific'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
