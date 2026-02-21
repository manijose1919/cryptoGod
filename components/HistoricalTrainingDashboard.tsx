import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import type {
  TrainingDownloadStatus,
  TrainingDataSummary,
  TrainingStatus,
  TrainingRun,
  TrainingResults,
  TrainingEquityPoint,
  WalkForwardStatus,
  WalkForwardFold,
} from '../types';
import * as api from '../services/historicalTrainingService';
import { TrainingComparison } from './TrainingComparison';

const NAV_LINKS = [
  { to: '/', label: 'Crypto' },
  { to: '/stocks', label: 'Stocks' },
  { to: '/performance', label: 'Performance' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/training', label: 'Training' },
];

const ALL_PAIRS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
const ALL_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'];

export const HistoricalTrainingDashboard: React.FC = () => {
  // Download state
  const [downloadStatus, setDownloadStatus] = useState<TrainingDownloadStatus | null>(null);
  const [dataSummary, setDataSummary] = useState<TrainingDataSummary | null>(null);
  const [selectedPairs, setSelectedPairs] = useState<string[]>([...ALL_PAIRS]);
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(['1h', '4h', '1d']);
  const [yearsBack, setYearsBack] = useState(5);
  const [downloading, setDownloading] = useState(false);
  const [downloadEstimate, setDownloadEstimate] = useState<string | null>(null);

  // Training state
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [initialCash, setInitialCash] = useState(10000);
  const [training, setTraining] = useState(false);
  const [seedRunId, setSeedRunId] = useState<string>('');
  const [trainingError, setTrainingError] = useState<string | null>(null);

  // Results state
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [results, setResults] = useState<TrainingResults | null>(null);
  const [equityCurve, setEquityCurve] = useState<TrainingEquityPoint[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  // Walk-forward state
  const [wfStatus, setWfStatus] = useState<WalkForwardStatus | null>(null);
  const [wfRunning, setWfRunning] = useState(false);
  const [wfTrainMonths, setWfTrainMonths] = useState(12);
  const [wfTestMonths, setWfTestMonths] = useState(3);
  const [wfStepMonths, setWfStepMonths] = useState(3);
  const [wfRuns, setWfRuns] = useState<any[]>([]);
  const [wfError, setWfError] = useState<string | null>(null);
  const [wfRetrainResult, setWfRetrainResult] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial data
  useEffect(() => {
    loadDataSummary();
    loadRuns();
    loadWfRuns();
    // Check if training is already running
    api.getTrainingStatus().then(status => {
      if (status.active) {
        setTraining(true);
        setTrainingStatus(status);
      }
    }).catch(() => {});
    // Check if walk-forward is running
    api.getWalkForwardStatus().then(status => {
      if (status.running) {
        setWfRunning(true);
        setWfStatus(status);
      }
    }).catch(() => {});
  }, []);

  // Poll training/download/walk-forward status
  useEffect(() => {
    if (training || downloading || wfRunning) {
      pollRef.current = setInterval(async () => {
        try {
          if (training) {
            const status = await api.getTrainingStatus();
            setTrainingStatus(status);
            if (!status.active && status.status !== 'running') {
              setTraining(false);
              if (status.status === 'error') {
                setTrainingError((status as any).error || 'Training failed');
              }
              loadRuns();
            }
          }
          if (downloading) {
            const status = await api.getDownloadStatus();
            setDownloadStatus(status);
            if (!status.active) {
              setDownloading(false);
              loadDataSummary();
            }
          }
          if (wfRunning) {
            const status = await api.getWalkForwardStatus();
            setWfStatus(status);
            if (!status.running) {
              setWfRunning(false);
              loadWfRuns();
            }
          }
        } catch (e) { /* ignore polling errors */ }
      }, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [training, downloading, wfRunning]);

  const loadDataSummary = useCallback(async () => {
    try {
      const summary = await api.getDataSummary();
      setDataSummary(summary);
    } catch (e) { /* ignore */ }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const r = await api.getTrainingRuns();
      setRuns(r);
    } catch (e) { /* ignore */ }
  }, []);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      setDownloadEstimate(null);
      const result = await api.startDownload(selectedPairs, yearsBack, selectedTimeframes);
      if (result.estimate) {
        setDownloadEstimate(`~${result.estimate.estimatedMinutes} min (${result.estimate.totalRequests} requests)`);
      }
    } catch (e: any) {
      alert(e.message);
      setDownloading(false);
    }
  };

  const handleAbortDownload = async () => {
    try {
      await api.abortDownload();
      setDownloading(false);
    } catch (e) { /* ignore */ }
  };

  const handleStartTraining = async () => {
    try {
      setTraining(true);
      setTrainingStatus(null);
      setTrainingError(null);
      await api.startTraining({
        tickers: selectedPairs,
        initialCash,
        seedRunId: seedRunId || undefined,
      });
    } catch (e: any) {
      setTrainingError(e.message);
      setTraining(false);
    }
  };

  const handleStopTraining = async () => {
    try {
      await api.stopTraining();
      setTraining(false);
      loadRuns();
    } catch (e) { /* ignore */ }
  };

  const handleSelectRun = async (runId: string) => {
    setSelectedRun(runId);
    try {
      const [res, eq] = await Promise.all([
        api.getTrainingResults(runId),
        api.getTrainingEquity(runId),
      ]);
      setResults(res);
      setEquityCurve(eq);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleApply = async () => {
    if (!selectedRun) return;
    if (!confirm('Apply trained state to live system? This will update adaptive weights, circuit breaker, and optimizer parameters.')) return;

    setApplying(true);
    setApplyResult(null);
    try {
      const result = await api.applyTrainedState(selectedRun);
      setApplyResult(`Applied: ${result.applied.join(', ')}`);
    } catch (e: any) {
      setApplyResult(`Error: ${e.message}`);
    } finally {
      setApplying(false);
    }
  };

  const loadWfRuns = useCallback(async () => {
    try {
      const r = await api.getWalkForwardRuns();
      setWfRuns(r);
    } catch (e) { /* ignore */ }
  }, []);

  const handleStartWF = async () => {
    try {
      setWfRunning(true);
      setWfStatus(null);
      setWfError(null);
      await api.startWalkForward({
        trainMonths: wfTrainMonths,
        testMonths: wfTestMonths,
        stepMonths: wfStepMonths,
        tickers: selectedPairs,
        initialCash,
      });
    } catch (e: any) {
      setWfError(e.message);
      setWfRunning(false);
    }
  };

  const handleStopWF = async () => {
    try {
      await api.stopWalkForward();
      setWfRunning(false);
      loadWfRuns();
    } catch (e) { /* ignore */ }
  };

  const handleWFRetrain = async (id: string) => {
    try {
      setWfRetrainResult(null);
      const result = await api.triggerWalkForwardRetrain(id);
      setWfRetrainResult(result.success ? `Copied ${result.samplesCopied} OOS samples for retraining` : `Rejected: ${result.reason}`);
    } catch (e: any) {
      setWfRetrainResult(`Error: ${e.message}`);
    }
  };

  const togglePair = (pair: string) => {
    setSelectedPairs(prev =>
      prev.includes(pair)
        ? prev.filter(p => p !== pair)
        : [...prev, pair]
    );
  };

  const toggleTimeframe = (tf: string) => {
    setSelectedTimeframes(prev =>
      prev.includes(tf)
        ? prev.filter(t => t !== tf)
        : [...prev, tf]
    );
  };

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  const hasData = dataSummary && Object.values(dataSummary.pairs || {}).some(p => (p as any).count > 0 || (p as any).totalCount > 0);
  const completedRuns = runs.filter(r => r.status === 'completed');

  // Mini equity chart using CSS bars
  const renderEquityChart = (data: TrainingEquityPoint[]) => {
    if (!data || data.length === 0) return <div className="text-gray-500 text-xs">No equity data</div>;
    const sampled = data.length > 200 ? data.filter((_, i) => i % Math.ceil(data.length / 200) === 0) : data;
    const values = sampled.map(d => d.total_value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    return (
      <div className="flex items-end gap-px h-32 w-full">
        {sampled.map((d, i) => {
          const pct = ((d.total_value - min) / range) * 100;
          const isGain = d.total_value >= (data[0]?.total_value ?? 0);
          return (
            <div
              key={i}
              className={`flex-1 min-w-[1px] rounded-t-sm ${isGain ? 'bg-green-500/60' : 'bg-red-500/60'}`}
              style={{ height: `${Math.max(2, pct)}%` }}
              title={`$${d.total_value.toFixed(2)} - ${new Date(d.time).toLocaleDateString()}`}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans">
      {/* Nav */}
      <nav className="flex items-center gap-4 p-4 border-b border-gray-700/50">
        {NAV_LINKS.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className={`text-sm px-3 py-1 rounded ${link.to === '/training' ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <main className="p-4 space-y-6 max-w-7xl mx-auto">
        <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
          Historical ML Training — Time Machine
        </h1>

        {/* Section 1: Data Download */}
        <section className="glass-card p-5 space-y-4">
          <h2 className="text-lg font-semibold text-cyan-300 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${downloading ? 'bg-blue-500 animate-pulse' : 'bg-blue-500'}`} />
            Data Download
          </h2>

          {/* Pair selection */}
          <div>
            <div className="text-xs text-gray-400 mb-2">Select pairs (Binance public API — no auth needed)</div>
            <div className="flex flex-wrap gap-2">
              {ALL_PAIRS.map(pair => (
                <button
                  key={pair}
                  onClick={() => togglePair(pair)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                    selectedPairs.includes(pair)
                      ? 'border-cyan-500 bg-cyan-500/20 text-cyan-300'
                      : 'border-gray-600 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  {pair}
                </button>
              ))}
              <button
                onClick={() => setSelectedPairs(selectedPairs.length === ALL_PAIRS.length ? [] : [...ALL_PAIRS])}
                className="text-xs px-3 py-1 rounded-full border border-gray-600 text-gray-400 hover:text-white"
              >
                {selectedPairs.length === ALL_PAIRS.length ? 'None' : 'All'}
              </button>
            </div>
          </div>

          {/* Timeframe selection */}
          <div>
            <div className="text-xs text-gray-400 mb-2">Select timeframes to download</div>
            <div className="flex flex-wrap gap-2">
              {ALL_TIMEFRAMES.map(tf => (
                <button
                  key={tf}
                  onClick={() => toggleTimeframe(tf)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                    selectedTimeframes.includes(tf)
                      ? 'border-purple-500 bg-purple-500/20 text-purple-300'
                      : 'border-gray-600 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  {tf}
                </button>
              ))}
              <button
                onClick={() => setSelectedTimeframes(selectedTimeframes.length === ALL_TIMEFRAMES.length ? ['1h'] : [...ALL_TIMEFRAMES])}
                className="text-xs px-3 py-1 rounded-full border border-gray-600 text-gray-400 hover:text-white"
              >
                {selectedTimeframes.length === ALL_TIMEFRAMES.length ? 'Just 1h' : 'All TFs'}
              </button>
            </div>
          </div>

          {/* Years back + download button */}
          <div className="flex items-center gap-4">
            <div>
              <label className="text-xs text-gray-400">Years back</label>
              <select
                value={yearsBack}
                onChange={e => setYearsBack(Number(e.target.value))}
                className="ml-2 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600"
              >
                {[1, 2, 3, 5, 7].map(y => (
                  <option key={y} value={y}>{y} year{y !== 1 ? 's' : ''}</option>
                ))}
              </select>
            </div>
            <button
              onClick={downloading ? handleAbortDownload : handleDownload}
              disabled={selectedPairs.length === 0 || selectedTimeframes.length === 0}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                downloading
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500'
              }`}
            >
              {downloading ? 'Abort Download' : 'Download Data'}
            </button>
            {downloadEstimate && !downloading && (
              <span className="text-xs text-gray-400">Estimate: {downloadEstimate}</span>
            )}
          </div>

          {/* Download progress */}
          {downloading && downloadStatus && (
            <div className="space-y-3">
              {/* Overall progress bar */}
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>Overall: {(downloadStatus as any).progress?.toFixed(1) || 0}%</span>
                  <span>
                    {downloadStatus.currentTicker && downloadStatus.currentTimeframe
                      ? `Downloading ${downloadStatus.currentTicker} ${downloadStatus.currentTimeframe}`
                      : 'Starting...'}
                  </span>
                  <span>Elapsed: {formatDuration(downloadStatus.elapsed)}</span>
                </div>
                <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all"
                    style={{ width: `${(downloadStatus as any).progress || 0}%` }}
                  />
                </div>
                <div className="text-[10px] text-gray-500 mt-1">
                  {(downloadStatus as any).completedRequests || 0} / {(downloadStatus as any).totalRequestsEstimate || '?'} API requests
                </div>
              </div>

              {/* Timeframe progress */}
              {downloadStatus.timeframes && Object.entries(downloadStatus.timeframes).map(([tf, info]: [string, any]) => (
                <div key={tf} className="flex items-center gap-3">
                  <span className="text-xs font-mono w-10 text-purple-300">{tf}</span>
                  <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        info.status === 'complete' ? 'bg-green-500' :
                        info.status === 'downloading' ? 'bg-blue-500 animate-pulse' : 'bg-gray-600'
                      }`}
                      style={{ width: info.status === 'complete' ? '100%' : info.status === 'downloading' ? '50%' : '0%' }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 w-24 text-right">
                    {info.totalCandles?.toLocaleString() || 0} candles
                  </span>
                  {info.status === 'complete' && <span className="text-green-400 text-xs">Done</span>}
                </div>
              ))}

              {/* Auxiliary data */}
              <div className="flex gap-4 text-xs">
                <span className={downloadStatus.fearGreed?.status === 'complete' ? 'text-green-400' : 'text-gray-400'}>
                  Fear & Greed: {downloadStatus.fearGreed?.count || 0} days
                </span>
                <span className={downloadStatus.defiTvl?.status === 'complete' ? 'text-green-400' : 'text-gray-400'}>
                  DeFi TVL: {downloadStatus.defiTvl?.count || 0} days
                </span>
              </div>
            </div>
          )}

          {/* Data summary */}
          {dataSummary && !downloading && (
            <div className="space-y-3">
              <div className="text-xs text-gray-400 font-semibold">
                Downloaded Data {(dataSummary as any).totalCandles > 0 && (
                  <span className="text-cyan-300 ml-2">({((dataSummary as any).totalCandles || 0).toLocaleString()} total candles)</span>
                )}
              </div>

              {/* Timeframe summary */}
              {(dataSummary as any).timeframeSummary && (
                <div className="flex gap-3 flex-wrap">
                  {Object.entries((dataSummary as any).timeframeSummary || {}).map(([tf, info]: [string, any]) => (
                    <div key={tf} className="glass-card px-3 py-1.5 text-center">
                      <div className="text-[10px] text-purple-300 font-mono">{tf}</div>
                      <div className="text-xs font-bold">{(info.totalCandles || 0).toLocaleString()}</div>
                      <div className="text-[10px] text-gray-500">{info.pairsWithData || 0} pairs</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Per-pair grid (1h candles for simplicity) */}
              <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                {Object.entries(dataSummary.pairs).map(([pair, info]: [string, any]) => (
                  <div key={pair} className="glass-card p-2 text-center">
                    <div className="text-xs font-mono text-cyan-300">{pair}</div>
                    <div className="text-sm font-bold">{(info.totalCount || info.count || 0).toLocaleString()}</div>
                    <div className="text-[10px] text-gray-500">
                      {info.earliest ? new Date(info.earliest).toLocaleDateString() : 'N/A'}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-4 text-xs text-gray-400">
                <span>Fear & Greed: {dataSummary.fearGreed} days</span>
                <span>DeFi TVL: {dataSummary.defiTvl} days</span>
              </div>
            </div>
          )}
        </section>

        {/* Section 2: Training */}
        <section className="glass-card p-5 space-y-4">
          <h2 className="text-lg font-semibold text-cyan-300 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${training ? 'bg-green-500 animate-pulse' : 'bg-purple-500'}`} />
            Training Engine
          </h2>

          {/* Training Presets */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { name: 'Conservative', cash: 10000, pairs: ['BTCUSD', 'ETHUSD'], tfs: ['1h', '4h', '1d'], color: 'blue', desc: 'Low risk, major pairs only' },
              { name: 'Balanced', cash: 10000, pairs: [...ALL_PAIRS].slice(0, 6), tfs: ['15m', '1h', '4h'], color: 'purple', desc: 'Mixed timeframes, 6 pairs' },
              { name: 'Aggressive', cash: 10000, pairs: [...ALL_PAIRS], tfs: ['5m', '15m', '1h'], color: 'red', desc: 'All pairs, fast timeframes' },
            ].map(preset => (
              <button
                key={preset.name}
                onClick={() => {
                  setInitialCash(preset.cash);
                  setSelectedPairs(preset.pairs);
                  setSelectedTimeframes(preset.tfs);
                }}
                className={`p-3 rounded-lg border border-${preset.color}-500/30 bg-${preset.color}-900/10 hover:bg-${preset.color}-900/30 text-left transition-colors`}
              >
                <div className={`text-sm font-semibold text-${preset.color}-300`}>{preset.name}</div>
                <div className="text-[10px] text-gray-400 mt-1">{preset.desc}</div>
                <div className="text-[10px] text-gray-500 mt-1">{preset.pairs.length} pairs | {preset.tfs.join(', ')}</div>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Initial Cash ($)</label>
              <input
                type="number"
                value={initialCash}
                onChange={e => setInitialCash(Number(e.target.value))}
                className="bg-gray-800 text-white text-sm px-2 py-1.5 rounded border border-gray-600 w-24"
              />
            </div>

            {/* Seed Run (Iterative Training) */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">Seed from run (iterative)</label>
              <select
                value={seedRunId}
                onChange={e => setSeedRunId(e.target.value)}
                className="bg-gray-800 text-white text-sm px-2 py-1.5 rounded border border-gray-600 w-56"
              >
                <option value="">Fresh start (no seed)</option>
                {completedRuns.map(run => (
                  <option key={run.run_id} value={run.run_id}>
                    {run.run_id.slice(6, 20)}... ({run.total_trades} trades, {run.win_rate?.toFixed(0)}% WR)
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={training ? handleStopTraining : handleStartTraining}
              disabled={!hasData && !training}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                training
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500'
              }`}
            >
              {training ? 'Stop Training' : 'Start Training'}
            </button>
          </div>

          {/* Error display */}
          {trainingError && (
            <div className="bg-red-900/30 border border-red-500/50 rounded p-3 text-sm text-red-300">
              Training error: {trainingError}
            </div>
          )}

          {/* No data warning */}
          {!hasData && !training && (
            <div className="bg-yellow-900/20 border border-yellow-500/30 rounded p-3 text-sm text-yellow-300">
              No historical data downloaded yet. Use the Data Download section above first.
            </div>
          )}

          {/* Epoch indicator */}
          {trainingStatus?.active && (trainingStatus as any).epoch > 0 && (
            <div className="text-xs text-purple-300">
              Epoch {(trainingStatus as any).epoch} — Seeded from: {(trainingStatus as any).seedRunId?.slice(0, 20)}...
            </div>
          )}

          {/* Live training progress */}
          {trainingStatus && trainingStatus.active && trainingStatus.progress && (
            <div className="space-y-3">
              {/* Progress bar */}
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>Progress: {trainingStatus.progress.pct.toFixed(1)}%</span>
                  <span>Date: {trainingStatus.progress.currentDate}</span>
                  <span>Elapsed: {formatDuration(trainingStatus.elapsed || 0)}</span>
                </div>
                <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 rounded-full transition-all"
                    style={{ width: `${trainingStatus.progress.pct}%` }}
                  />
                </div>
                <div className="text-[10px] text-gray-500 mt-1">
                  Step {trainingStatus.progress.currentStep.toLocaleString()} / {trainingStatus.progress.totalSteps.toLocaleString()}
                </div>
              </div>

              {/* Live stats */}
              {trainingStatus.stats && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">Trades</div>
                    <div className="text-lg font-bold">{trainingStatus.stats.totalTrades}</div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">Win Rate</div>
                    <div className={`text-lg font-bold ${(trainingStatus.stats.winRate || 0) >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                      {(trainingStatus.stats.winRate || 0).toFixed(1)}%
                    </div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">P&L</div>
                    <div className={`text-lg font-bold ${(trainingStatus.stats.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${(trainingStatus.stats.totalPnl || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">Max Drawdown</div>
                    <div className="text-lg font-bold text-yellow-400">
                      {((trainingStatus.stats.maxDrawdown || 0) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">Equity</div>
                    <div className="text-lg font-bold text-cyan-300">
                      ${(trainingStatus.equity?.current || 0).toFixed(0)}
                    </div>
                  </div>
                </div>
              )}

              {/* Strategy breakdown */}
              {trainingStatus.strategyBreakdown && Object.keys(trainingStatus.strategyBreakdown).length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 mb-2">Strategy Breakdown</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {Object.entries(trainingStatus.strategyBreakdown).map(([strat, data]) => {
                      const total = data.wins + data.losses;
                      const wr = total > 0 ? (data.wins / total * 100) : 0;
                      return (
                        <div key={strat} className="glass-card p-2">
                          <div className="text-xs font-mono text-cyan-300">{strat}</div>
                          <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                            <span>{data.wins}W / {data.losses}L</span>
                            <span className={wr >= 50 ? 'text-green-400' : 'text-red-400'}>{wr.toFixed(0)}%</span>
                          </div>
                          <div className={`text-xs font-bold ${data.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ${data.pnl.toFixed(2)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Recent trades */}
              {trainingStatus.recentTrades && trainingStatus.recentTrades.length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 mb-2">Recent Trades</div>
                  <div className="max-h-40 overflow-y-auto space-y-1 custom-scrollbar">
                    {trainingStatus.recentTrades.filter((t: any) => t.type === 'SELL').slice(0, 10).map((trade: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className={`font-mono ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}
                        </span>
                        <span className="text-gray-400">{trade.ticker}</span>
                        <span className="text-gray-500">{trade.strategy}</span>
                        <span className="text-gray-600">{new Date(trade.time).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Training Comparison */}
        <TrainingComparison />

        {/* Section 3: Results & Apply */}
        <section className="glass-card p-5 space-y-4">
          <h2 className="text-lg font-semibold text-cyan-300 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Results & Apply
          </h2>

          {/* Past training runs */}
          {runs.length > 0 && (
            <div>
              <div className="text-xs text-gray-400 mb-2">Training History</div>
              <div className="max-h-48 overflow-y-auto space-y-1 custom-scrollbar">
                {runs.map(run => {
                  const configJson = (run as any).config_json;
                  let epoch = 0;
                  try { epoch = configJson ? JSON.parse(configJson).epoch || 0 : 0; } catch {}
                  return (
                    <button
                      key={run.run_id}
                      onClick={() => handleSelectRun(run.run_id)}
                      className={`w-full flex items-center justify-between p-2 rounded text-xs transition-colors ${
                        selectedRun === run.run_id
                          ? 'bg-cyan-800/30 border border-cyan-500/50'
                          : 'hover:bg-gray-800 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          run.status === 'completed' ? 'bg-green-500' :
                          run.status === 'running' ? 'bg-blue-500 animate-pulse' :
                          run.status === 'error' ? 'bg-red-500' : 'bg-gray-500'
                        }`} />
                        <span className="text-gray-300 font-mono">{run.run_id.slice(6, 20)}...</span>
                        {epoch > 0 && <span className="text-purple-400 text-[10px]">Epoch {epoch}</span>}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-400">{run.total_trades} trades</span>
                        <span className={run.win_rate >= 50 ? 'text-green-400' : 'text-red-400'}>
                          {run.win_rate?.toFixed(1)}% WR
                        </span>
                        <span className={run.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          ${run.total_pnl?.toFixed(2)}
                        </span>
                        {run.status === 'error' && (
                          <span className="text-red-400" title={(run as any).error}>ERR</span>
                        )}
                        <span className="text-gray-500">{new Date(run.start_time).toLocaleDateString()}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Selected run results */}
          {results && (
            <div className="space-y-4 border-t border-gray-700/50 pt-4">
              {/* Final stats */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Total Trades</div>
                  <div className="text-lg font-bold">{results.stats?.total_trades || 0}</div>
                </div>
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Win Rate</div>
                  <div className={`text-lg font-bold ${(results.run.win_rate || 0) >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                    {(results.run.win_rate || 0).toFixed(1)}%
                  </div>
                </div>
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Total P&L</div>
                  <div className={`text-lg font-bold ${(results.run.total_pnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${(results.run.total_pnl || 0).toFixed(2)}
                  </div>
                </div>
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Max Drawdown</div>
                  <div className="text-lg font-bold text-yellow-400">
                    {(results.run.max_drawdown || 0).toFixed(1)}%
                  </div>
                </div>
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Sharpe</div>
                  <div className="text-lg font-bold text-cyan-300">
                    {(results.run.sharpe_ratio || 0).toFixed(2)}
                  </div>
                </div>
                <div className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">Final Equity</div>
                  <div className="text-lg font-bold text-purple-300">
                    ${(results.run.final_equity || 0).toFixed(0)}
                  </div>
                </div>
              </div>

              {/* Equity curve */}
              {equityCurve.length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 mb-2">Equity Curve</div>
                  <div className="glass-card p-3">
                    {renderEquityChart(equityCurve)}
                    <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                      <span>{new Date(equityCurve[0].time).toLocaleDateString()}</span>
                      <span>{new Date(equityCurve[equityCurve.length - 1].time).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Strategy weight comparison */}
              {results.learnedState?.adaptiveWeights && (
                <div>
                  <div className="text-xs text-gray-400 mb-2">Learned Strategy Weights</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {Object.entries(results.learnedState.adaptiveWeights).map(([strat, data]: [string, any]) => {
                      const total = data.wins + data.losses;
                      const wr = total > 0 ? (data.wins / total * 100) : 0;
                      return (
                        <div key={strat} className="glass-card p-3">
                          <div className="text-xs font-mono text-cyan-300">{strat}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-sm font-bold">{data.weight.toFixed(2)}x</span>
                            <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 rounded-full"
                                style={{ width: `${Math.min(100, data.weight * 50)}%` }}
                              />
                            </div>
                          </div>
                          <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                            <span>{data.wins}W / {data.losses}L ({wr.toFixed(0)}%)</span>
                            <span className={data.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                              ${data.totalPnl.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Apply button */}
              <div className="flex items-center gap-4 pt-2">
                <button
                  onClick={handleApply}
                  disabled={applying || results.run.status !== 'completed'}
                  className="px-6 py-2 rounded text-sm font-medium bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
                >
                  {applying ? 'Applying...' : 'Apply to Live System'}
                </button>
                {applyResult && (
                  <span className={`text-sm ${applyResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {applyResult}
                  </span>
                )}
              </div>
            </div>
          )}

          {runs.length === 0 && !training && (
            <div className="text-gray-500 text-sm text-center py-8">
              No training runs yet. Download data and start training above.
            </div>
          )}
        </section>

        {/* Section 4: Walk-Forward Validation */}
        <section className="glass-card p-5 space-y-4">
          <h2 className="text-lg font-semibold text-cyan-300 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${wfRunning ? 'bg-yellow-500 animate-pulse' : 'bg-yellow-500'}`} />
            Walk-Forward Validation
          </h2>
          <p className="text-xs text-gray-400">
            Train on rolling windows and test out-of-sample to prevent overfitting. Each fold trains on N months, then tests on unseen data.
          </p>

          {/* Config inputs */}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Train (months)</label>
              <input
                type="number" min={2} max={36} value={wfTrainMonths}
                onChange={e => setWfTrainMonths(Number(e.target.value))}
                className="bg-gray-800 text-white text-sm px-2 py-1.5 rounded border border-gray-600 w-20"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Test (months)</label>
              <input
                type="number" min={1} max={12} value={wfTestMonths}
                onChange={e => setWfTestMonths(Number(e.target.value))}
                className="bg-gray-800 text-white text-sm px-2 py-1.5 rounded border border-gray-600 w-20"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Step (months)</label>
              <input
                type="number" min={1} max={12} value={wfStepMonths}
                onChange={e => setWfStepMonths(Number(e.target.value))}
                className="bg-gray-800 text-white text-sm px-2 py-1.5 rounded border border-gray-600 w-20"
              />
            </div>
            <button
              onClick={wfRunning ? handleStopWF : handleStartWF}
              disabled={!hasData && !wfRunning}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                wfRunning
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 disabled:text-gray-500'
              }`}
            >
              {wfRunning ? 'Stop Walk-Forward' : 'Start Walk-Forward'}
            </button>
          </div>

          {wfError && (
            <div className="bg-red-900/30 border border-red-500/50 rounded p-3 text-sm text-red-300">
              Walk-forward error: {wfError}
            </div>
          )}

          {/* Live WF progress */}
          {wfStatus && wfStatus.running && (
            <div className="space-y-3">
              {/* Progress bar */}
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>
                    Fold {(wfStatus.currentFold ?? 0) + 1} / {wfStatus.totalFolds}
                    {wfStatus.currentPhase && ` — ${wfStatus.currentPhase}`}
                  </span>
                  <span>Elapsed: {formatDuration((wfStatus as any).elapsed || 0)}</span>
                </div>
                <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-yellow-500 to-orange-500 rounded-full transition-all"
                    style={{ width: `${wfStatus.totalFolds ? ((wfStatus.completedFolds || 0) / wfStatus.totalFolds) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* Aggregate OOS stats */}
              {wfStatus.aggregateOOS && wfStatus.aggregateOOS.totalTrades > 0 && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">OOS Trades</div>
                    <div className="text-lg font-bold">{wfStatus.aggregateOOS.totalTrades}</div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">OOS Win Rate</div>
                    <div className={`text-lg font-bold ${wfStatus.aggregateOOS.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                      {wfStatus.aggregateOOS.winRate.toFixed(1)}%
                    </div>
                  </div>
                  <div className="glass-card p-3 text-center">
                    <div className="text-[10px] text-gray-400">OOS P&L</div>
                    <div className={`text-lg font-bold ${wfStatus.aggregateOOS.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${wfStatus.aggregateOOS.totalPnl.toFixed(2)}
                    </div>
                  </div>
                </div>
              )}

              {/* Fold table */}
              {wfStatus.folds && wfStatus.folds.length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 mb-2">Fold Results</div>
                  <div className="max-h-64 overflow-y-auto custom-scrollbar">
                    <table className="w-full text-xs">
                      <thead className="text-gray-400 border-b border-gray-700">
                        <tr>
                          <th className="text-left py-1 px-2">#</th>
                          <th className="text-left py-1 px-2">Train Period</th>
                          <th className="text-right py-1 px-2">Train P&L</th>
                          <th className="text-right py-1 px-2">Test P&L</th>
                          <th className="text-right py-1 px-2">OOS Ratio</th>
                          <th className="text-center py-1 px-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wfStatus.folds.map((fold: WalkForwardFold, i: number) => (
                          <tr key={i} className="border-b border-gray-800/50">
                            <td className="py-1 px-2 text-gray-300">{fold.foldNumber + 1}</td>
                            <td className="py-1 px-2 text-gray-400 font-mono text-[10px]">
                              {new Date(fold.trainStart).toLocaleDateString()} → {new Date(fold.testEnd).toLocaleDateString()}
                            </td>
                            <td className={`py-1 px-2 text-right ${fold.trainPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {fold.trainPnl ? `$${fold.trainPnl.toFixed(0)}` : '-'}
                            </td>
                            <td className={`py-1 px-2 text-right ${fold.testPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {fold.testPnl ? `$${fold.testPnl.toFixed(0)}` : '-'}
                            </td>
                            <td className={`py-1 px-2 text-right ${
                              fold.overfittingRatio >= 0.5 ? 'text-green-400' :
                              fold.overfittingRatio >= 0.3 ? 'text-yellow-400' : 'text-red-400'
                            }`}>
                              {fold.overfittingRatio ? fold.overfittingRatio.toFixed(2) : '-'}
                            </td>
                            <td className="py-1 px-2 text-center">
                              <span className={`inline-block w-2 h-2 rounded-full ${
                                fold.status === 'completed' ? 'bg-green-500' :
                                fold.status === 'training' ? 'bg-blue-500 animate-pulse' :
                                fold.status === 'testing' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-600'
                              }`} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Past WF runs */}
          {wfRuns.length > 0 && !wfRunning && (
            <div>
              <div className="text-xs text-gray-400 mb-2">Past Walk-Forward Runs</div>
              <div className="space-y-2">
                {wfRuns.map((run: any) => (
                  <div key={run.id} className="glass-card p-3 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono text-gray-300">{run.id.slice(3, 18)}...</span>
                      <span className={`ml-2 text-xs ${
                        run.status === 'completed' ? 'text-green-400' :
                        run.status === 'failed' ? 'text-red-400' : 'text-gray-400'
                      }`}>{run.status}</span>
                      <span className="ml-2 text-[10px] text-gray-500">
                        {run.completedFolds}/{run.totalFolds} folds
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {run.aggregateOOS && (
                        <>
                          <span className="text-xs text-gray-400">{run.aggregateOOS.totalTrades || 0} OOS trades</span>
                          <span className={`text-xs ${(run.aggregateOOS.winRate || 0) >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                            {(run.aggregateOOS.winRate || 0).toFixed(1)}% WR
                          </span>
                          <span className={`text-xs ${(run.aggregateOOS.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ${(run.aggregateOOS.totalPnl || 0).toFixed(0)}
                          </span>
                        </>
                      )}
                      {run.status === 'completed' && (
                        <button
                          onClick={() => handleWFRetrain(run.id)}
                          className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded transition-colors"
                        >
                          Retrain ML
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {wfRetrainResult && (
            <div className={`text-sm p-3 rounded ${
              wfRetrainResult.startsWith('Error') || wfRetrainResult.startsWith('Rejected')
                ? 'bg-red-900/30 border border-red-500/50 text-red-300'
                : 'bg-green-900/30 border border-green-500/50 text-green-300'
            }`}>
              {wfRetrainResult}
            </div>
          )}

          {!wfRunning && wfRuns.length === 0 && (
            <div className="text-gray-500 text-sm text-center py-4">
              No walk-forward runs yet. Configure windows and start above.
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default HistoricalTrainingDashboard;
