import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  runBacktest,
  getAvailableData,
  runParameterSweep,
  runWalkForward,
  type BacktestResult,
  type AvailableData,
} from '../services/backtestService';

const NAV_LINKS = [
  { to: '/', label: 'Crypto' },
  { to: '/stocks', label: 'Stocks' },
  { to: '/performance', label: 'Performance' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/replay', label: 'Replay' },
];

const STRATEGIES = ['TREND', 'BREAKOUT', 'MOMENTUM', 'SWING', 'WHALE', 'CONFLUENCE', 'DIVERGENCE', 'ADAPTIVE', 'MA_CROSSOVER', 'MEAN_REVERSION', 'REVERSAL', 'RANGE'];

export const BacktestDashboard: React.FC = () => {
  const [available, setAvailable] = useState<AvailableData[]>([]);
  const [ticker, setTicker] = useState('BTCUSD');
  const [strategy, setStrategy] = useState('TREND');
  const [timeframe, setTimeframe] = useState('5m');
  const [riskPercent, setRiskPercent] = useState(5);
  const [initialCash, setInitialCash] = useState(1000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [compareResults, setCompareResults] = useState<BacktestResult[]>([]);
  const [sweepResult, setSweepResult] = useState<any>(null);
  const [wfResult, setWfResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'backtest' | 'compare' | 'sweep' | 'walkforward'>('backtest');

  useEffect(() => {
    getAvailableData().then(setAvailable).catch(() => {});
  }, []);

  const selectedData = available.find(d => d.ticker === ticker && d.timeframe === timeframe);
  const tickers = [...new Set(available.map(d => d.ticker))];
  const timeframes = [...new Set(available.filter(d => d.ticker === ticker).map(d => d.timeframe))];

  const handleRun = async () => {
    if (!selectedData) return;
    setLoading(true);
    try {
      const res = await runBacktest({
        ticker, strategy, timeframe, initialCash, riskPercent,
        startTime: selectedData.startTime, endTime: selectedData.endTime,
      });
      setResult(res);
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  const handleCompare = async () => {
    if (!selectedData) return;
    setLoading(true);
    const results: BacktestResult[] = [];
    for (const strat of STRATEGIES) {
      try {
        const res = await runBacktest({
          ticker, strategy: strat, timeframe, initialCash, riskPercent,
          startTime: selectedData.startTime, endTime: selectedData.endTime,
        });
        results.push(res);
      } catch (e) { /* skip */ }
    }
    setCompareResults(results.filter(r => r.totalTrades > 0));
    setLoading(false);
  };

  const handleSweep = async () => {
    if (!selectedData) return;
    setLoading(true);
    try {
      const res = await runParameterSweep({
        ticker, strategy, timeframe, initialCash,
        startTime: selectedData.startTime, endTime: selectedData.endTime,
      });
      setSweepResult(res);
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  const handleWalkForward = async () => {
    if (!selectedData) return;
    setLoading(true);
    try {
      const res = await runWalkForward({
        ticker, strategy, timeframe, initialCash, riskPercent,
        startTime: selectedData.startTime, endTime: selectedData.endTime,
        windows: 5,
      });
      setWfResult(res);
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans">
      <nav className="flex items-center gap-4 p-4 border-b border-gray-700/50">
        {NAV_LINKS.map(link => (
          <Link key={link.to} to={link.to}
            className={`text-sm px-3 py-1 rounded ${link.to === '/backtest' ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}>
            {link.label}
          </Link>
        ))}
      </nav>

      <main className="p-4 max-w-7xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-cyan-300">Backtesting Engine</h1>

        {/* Controls */}
        <div className="glass-card p-4">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div>
              <label className="text-xs text-gray-400">Ticker</label>
              <select value={ticker} onChange={e => setTicker(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {tickers.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400">Strategy</label>
              <select value={strategy} onChange={e => setStrategy(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400">Timeframe</label>
              <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {timeframes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400">Initial Cash</label>
              <input type="number" value={initialCash} onChange={e => setInitialCash(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white" />
            </div>
            <div>
              <label className="text-xs text-gray-400">Risk %</label>
              <input type="number" value={riskPercent} step={0.5} onChange={e => setRiskPercent(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white" />
            </div>
            <div className="flex items-end">
              <button onClick={handleRun} disabled={loading || !selectedData} className="w-full bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded px-3 py-1.5 text-xs font-bold">
                {loading ? 'Running...' : 'Run Backtest'}
              </button>
            </div>
          </div>
          {selectedData && (
            <div className="text-[10px] text-gray-500 mt-2">
              {selectedData.candleCount} candles | {new Date(selectedData.startTime).toLocaleDateString()} - {new Date(selectedData.endTime).toLocaleDateString()}
            </div>
          )}
          {!selectedData && available.length > 0 && (
            <div className="text-[10px] text-yellow-400 mt-2">No data for {ticker}/{timeframe}. Select a different combination.</div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          {(['backtest', 'compare', 'sweep', 'walkforward'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); if (t === 'compare') handleCompare(); if (t === 'sweep') handleSweep(); if (t === 'walkforward') handleWalkForward(); }}
              className={`text-xs px-3 py-1.5 rounded ${tab === t ? 'bg-cyan-800 text-cyan-300' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {t === 'walkforward' ? 'Walk-Forward' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Single Backtest Result */}
        {tab === 'backtest' && result && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Return', value: `${result.totalReturn}%`, color: result.totalReturn >= 0 ? 'text-green-400' : 'text-red-400' },
                { label: 'Win Rate', value: `${result.winRate}%`, color: result.winRate >= 50 ? 'text-green-400' : 'text-yellow-400' },
                { label: 'Sharpe', value: result.sharpeRatio.toFixed(2), color: result.sharpeRatio > 0 ? 'text-green-400' : 'text-red-400' },
                { label: 'Max DD', value: `${result.maxDrawdownPercent}%`, color: 'text-red-400' },
                { label: 'Buy&Hold', value: `${result.buyAndHoldReturn}%`, color: result.buyAndHoldReturn >= 0 ? 'text-blue-400' : 'text-red-400' },
              ].map(m => (
                <div key={m.label} className="glass-card p-3 text-center">
                  <div className="text-[10px] text-gray-400">{m.label}</div>
                  <div className={`text-lg font-bold ${m.color}`}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Equity curve */}
            {result.trades.length > 0 && (
              <div className="glass-card p-4">
                <h3 className="text-xs text-cyan-300 font-semibold mb-2">Trade List ({result.totalTrades} trades)</h3>
                <div className="max-h-60 overflow-y-auto custom-scrollbar">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left pb-1">Type</th>
                        <th className="text-right pb-1">Price</th>
                        <th className="text-right pb-1">Qty</th>
                        <th className="text-right pb-1">P&L</th>
                        <th className="text-right pb-1">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.slice(-50).map((t, i) => (
                        <tr key={i} className="border-t border-gray-800">
                          <td className={t.type === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.type}</td>
                          <td className="text-right text-gray-300">${t.price.toFixed(2)}</td>
                          <td className="text-right text-gray-400">{t.quantity.toFixed(4)}</td>
                          <td className={`text-right ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>${t.pnl.toFixed(2)}</td>
                          <td className="text-right text-gray-500">{new Date(t.time).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Strategy Comparison */}
        {tab === 'compare' && compareResults.length > 0 && (
          <div className="glass-card p-4">
            <h3 className="text-xs text-cyan-300 font-semibold mb-2">Strategy Comparison ({ticker})</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-700">
                    <th className="text-left py-2">Strategy</th>
                    <th className="text-right py-2">Return</th>
                    <th className="text-right py-2">Win Rate</th>
                    <th className="text-right py-2">Sharpe</th>
                    <th className="text-right py-2">Max DD</th>
                    <th className="text-right py-2">PF</th>
                    <th className="text-right py-2">Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {compareResults.sort((a, b) => b.sharpeRatio - a.sharpeRatio).map(r => (
                    <tr key={r.strategy} className="border-t border-gray-800">
                      <td className="text-cyan-400 py-1">{r.strategy}</td>
                      <td className={`text-right ${r.totalReturn >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.totalReturn}%</td>
                      <td className="text-right text-gray-300">{r.winRate}%</td>
                      <td className={`text-right ${r.sharpeRatio > 0 ? 'text-green-400' : 'text-red-400'}`}>{r.sharpeRatio}</td>
                      <td className="text-right text-red-400">{r.maxDrawdownPercent}%</td>
                      <td className="text-right text-gray-300">{r.profitFactor === Infinity ? '∞' : r.profitFactor}</td>
                      <td className="text-right text-gray-400">{r.totalTrades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Parameter Sweep */}
        {tab === 'sweep' && sweepResult && (
          <div className="glass-card p-4">
            <h3 className="text-xs text-cyan-300 font-semibold mb-2">Parameter Sweep ({strategy})</h3>
            {sweepResult.bestParams && (
              <div className="mb-3 text-xs text-green-400">
                Best: Risk {sweepResult.bestParams.riskPercent}% | Sharpe: {sweepResult.bestParams.sharpe} | Return: {sweepResult.bestParams.return}%
              </div>
            )}
            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
              {sweepResult.results?.filter((r: any) => !r.error).map((r: any) => (
                <div key={r.riskPercent}
                  className={`p-2 rounded text-center text-[10px] ${r.totalReturn >= 0 ? 'bg-green-900/30' : 'bg-red-900/30'} ${r.riskPercent === sweepResult.bestParams?.riskPercent ? 'ring-1 ring-cyan-400' : ''}`}>
                  <div className="text-gray-400">{r.riskPercent}%</div>
                  <div className={r.totalReturn >= 0 ? 'text-green-400' : 'text-red-400'}>{r.totalReturn}%</div>
                  <div className="text-gray-500">S:{r.sharpeRatio}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Walk-Forward */}
        {tab === 'walkforward' && wfResult && (
          <div className="glass-card p-4">
            <h3 className="text-xs text-cyan-300 font-semibold mb-2">Walk-Forward Analysis ({strategy})</h3>
            {wfResult.summary && (
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div className="text-center"><div className="text-[10px] text-gray-400">Avg Test Return</div><div className="text-sm font-bold text-white">{wfResult.summary.avgTestReturn?.toFixed(2)}%</div></div>
                <div className="text-center"><div className="text-[10px] text-gray-400">Avg Win Rate</div><div className="text-sm font-bold text-white">{wfResult.summary.avgTestWinRate?.toFixed(1)}%</div></div>
                <div className="text-center"><div className="text-[10px] text-gray-400">Consistency</div><div className="text-sm font-bold text-white">{(wfResult.summary.consistency * 100)?.toFixed(0)}%</div></div>
                <div className="text-center"><div className="text-[10px] text-gray-400">Avg Sharpe</div><div className="text-sm font-bold text-white">{wfResult.summary.avgTestSharpe?.toFixed(2)}</div></div>
              </div>
            )}
            <div className="space-y-1">
              {wfResult.windows?.filter((w: any) => !w.error).map((w: any) => (
                <div key={w.window} className="flex items-center gap-2 text-[10px]">
                  <span className="text-gray-400 w-12">W{w.window}</span>
                  <div className="flex-1 flex gap-1">
                    <div className={`flex-1 h-5 rounded flex items-center justify-center ${w.trainReturn >= 0 ? 'bg-blue-900/40 text-blue-400' : 'bg-red-900/40 text-red-400'}`}>
                      Train: {w.trainReturn?.toFixed(1)}%
                    </div>
                    <div className={`flex-1 h-5 rounded flex items-center justify-center ${w.testReturn >= 0 ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                      Test: {w.testReturn?.toFixed(1)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && <div className="text-center text-gray-400 text-xs py-8">Running backtest...</div>}
      </main>
    </div>
  );
};

export default BacktestDashboard;
