import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import type {
  TrainingDownloadStatus,
  TrainingDataSummary,
  TrainingStatus,
  TrainingRun,
  TrainingResults,
  TrainingEquityPoint,
} from '../types';
import * as api from '../services/historicalTrainingService';

const NAV_LINKS = [
  { to: '/', label: 'Crypto' },
  { to: '/stocks', label: 'Stocks' },
  { to: '/performance', label: 'Performance' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/training', label: 'Training' },
];

const ALL_PAIRS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];

export const HistoricalTrainingDashboard: React.FC = () => {
  // Download state
  const [downloadStatus, setDownloadStatus] = useState<TrainingDownloadStatus | null>(null);
  const [dataSummary, setDataSummary] = useState<TrainingDataSummary | null>(null);
  const [selectedPairs, setSelectedPairs] = useState<string[]>([...ALL_PAIRS]);
  const [yearsBack, setYearsBack] = useState(5);
  const [downloading, setDownloading] = useState(false);

  // Training state
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [initialCash, setInitialCash] = useState(10000);
  const [training, setTraining] = useState(false);

  // Results state
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [results, setResults] = useState<TrainingResults | null>(null);
  const [equityCurve, setEquityCurve] = useState<TrainingEquityPoint[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial data
  useEffect(() => {
    loadDataSummary();
    loadRuns();
  }, []);

  // Poll training status when training is active
  useEffect(() => {
    if (training || downloading) {
      pollRef.current = setInterval(async () => {
        try {
          if (training) {
            const status = await api.getTrainingStatus();
            setTrainingStatus(status);
            if (!status.active && status.status !== 'running') {
              setTraining(false);
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
        } catch (e) { /* ignore polling errors */ }
      }, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [training, downloading]);

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
      await api.startDownload(selectedPairs, yearsBack);
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
      await api.startTraining({
        tickers: selectedPairs,
        initialCash,
      });
    } catch (e: any) {
      alert(e.message);
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

  const togglePair = (pair: string) => {
    setSelectedPairs(prev =>
      prev.includes(pair)
        ? prev.filter(p => p !== pair)
        : [...prev, pair]
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
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            Data Download
          </h2>

          {/* Pair selection */}
          <div>
            <div className="text-xs text-gray-400 mb-2">Select pairs to download (Kraken 1h candles)</div>
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

          {/* Years back */}
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
              disabled={selectedPairs.length === 0}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                downloading
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500'
              }`}
            >
              {downloading ? 'Abort Download' : 'Download Data'}
            </button>
          </div>

          {/* Download progress */}
          {downloading && downloadStatus && (
            <div className="space-y-2">
              <div className="text-xs text-gray-400">
                Elapsed: {formatDuration(downloadStatus.elapsed)}
              </div>
              {Object.entries(downloadStatus.pairs).map(([pair, info]) => (
                <div key={pair} className="flex items-center gap-3">
                  <span className="text-xs font-mono w-16">{pair}</span>
                  <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        info.status === 'complete' ? 'bg-green-500' :
                        info.status === 'error' ? 'bg-red-500' :
                        info.status === 'downloading' ? 'bg-blue-500 animate-pulse' : 'bg-gray-600'
                      }`}
                      style={{ width: info.status === 'complete' ? '100%' : info.status === 'downloading' ? '60%' : '0%' }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 w-20 text-right">
                    {info.downloaded.toLocaleString()} candles
                  </span>
                  {info.status === 'complete' && <span className="text-green-400 text-xs">Done</span>}
                  {info.status === 'error' && <span className="text-red-400 text-xs" title={info.error}>Error</span>}
                </div>
              ))}
              <div className="flex gap-4 text-xs">
                <span className={downloadStatus.fearGreed.status === 'complete' ? 'text-green-400' : 'text-gray-400'}>
                  Fear & Greed: {downloadStatus.fearGreed.count} days
                </span>
                <span className={downloadStatus.defiTvl.status === 'complete' ? 'text-green-400' : 'text-gray-400'}>
                  DeFi TVL: {downloadStatus.defiTvl.count} days
                </span>
              </div>
            </div>
          )}

          {/* Data summary */}
          {dataSummary && !downloading && (
            <div className="space-y-2">
              <div className="text-xs text-gray-400 font-semibold">Downloaded Data</div>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                {Object.entries(dataSummary.pairs).map(([pair, info]) => (
                  <div key={pair} className="glass-card p-2 text-center">
                    <div className="text-xs font-mono text-cyan-300">{pair}</div>
                    <div className="text-sm font-bold">{info.count.toLocaleString()}</div>
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

          <div className="flex items-center gap-4">
            <div>
              <label className="text-xs text-gray-400">Initial Cash ($)</label>
              <input
                type="number"
                value={initialCash}
                onChange={e => setInitialCash(Number(e.target.value))}
                className="ml-2 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 w-24"
              />
            </div>
            <button
              onClick={training ? handleStopTraining : handleStartTraining}
              disabled={!dataSummary || Object.values(dataSummary?.pairs || {}).every(p => p.count === 0)}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                training
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500'
              }`}
            >
              {training ? 'Stop Training' : 'Start Training'}
            </button>
          </div>

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
                    {trainingStatus.recentTrades.filter(t => t.type === 'SELL').slice(0, 10).map((trade, i) => (
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
                {runs.map(run => (
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
                      <span className="text-gray-300 font-mono">{run.run_id.slice(0, 20)}...</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400">{run.total_trades} trades</span>
                      <span className={run.win_rate >= 50 ? 'text-green-400' : 'text-red-400'}>
                        {run.win_rate?.toFixed(1)}% WR
                      </span>
                      <span className={run.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                        ${run.total_pnl?.toFixed(2)}
                      </span>
                      <span className="text-gray-500">{new Date(run.start_time).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
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
                    {Object.entries(results.learnedState.adaptiveWeights).map(([strat, data]) => {
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
      </main>
    </div>
  );
};

export default HistoricalTrainingDashboard;
