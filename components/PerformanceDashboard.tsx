import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  computeEquityCurve,
  computeStrategyBreakdown,
  computeMonthlyPnL,
  computeRollingMetrics,
  type Trade,
} from '../services/performanceService';

const NAV_LINKS = [
  { to: '/', label: 'Crypto' },
  { to: '/stocks', label: 'Stocks' },
  { to: '/performance', label: 'Performance' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/replay', label: 'Replay' },
  { to: '/training', label: 'Training' },
];

export const PerformanceDashboard: React.FC = () => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [initialBudget, setInitialBudget] = useState(1000);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          const data = await res.json();
          setInitialBudget(data.portfolio?.initialBudget || 1000);
          // Combine logs into trade format
          const tradeData = (data.logs || [])
            .filter((l: any) => l.type === 'BUY' || l.type === 'SELL')
            .map((l: any) => ({
              type: l.type,
              ticker: l.ticker || '',
              price: l.price || 0,
              quantity: l.quantity || 0,
              strategy: l.strategy || '',
              timestamp: l.timestamp || Date.now(),
              pnl: l.pnl,
            }));
          setTrades(tradeData);
        }
      } catch (e) { /* ignore */ }
    };
    load();
  }, []);

  // Also try loading from persistence DB
  useEffect(() => {
    const loadDB = async () => {
      try {
        const res = await fetch('/api/db/trades?limit=1000');
        if (res.ok) {
          const data = await res.json();
          if (data.trades && data.trades.length > 0) {
            setTrades(data.trades.map((t: any) => ({
              type: t.type,
              ticker: t.ticker,
              price: t.price,
              quantity: t.quantity,
              strategy: t.strategy,
              timestamp: t.created_at || t.timestamp,
              pnl: t.pnl,
            })));
          }
        }
      } catch (e) { /* ignore */ }
    };
    loadDB();
  }, []);

  const equityCurve = useMemo(() => computeEquityCurve(trades, initialBudget), [trades, initialBudget]);
  const strategyBreakdown = useMemo(() => computeStrategyBreakdown(trades), [trades]);
  const monthlyPnl = useMemo(() => computeMonthlyPnL(trades), [trades]);
  const rollingMetrics = useMemo(() => computeRollingMetrics(trades, 30), [trades]);

  const totalPnl = trades.filter(t => t.type === 'SELL' && t.pnl != null).reduce((s, t) => s + t.pnl!, 0);
  const totalTrades = trades.filter(t => t.type === 'SELL').length;
  const wins = trades.filter(t => t.type === 'SELL' && (t.pnl || 0) > 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;

  // Simple equity chart using CSS
  const maxEquity = Math.max(...equityCurve.map(p => p.equity), initialBudget);
  const minEquity = Math.min(...equityCurve.map(p => p.equity), initialBudget);
  const equityRange = maxEquity - minEquity || 1;

  return (
    <div className="min-h-screen bg-gray-900 font-sans" style={{ color: 'var(--text-primary)' }}>
      {/* Nav */}
      <nav className="flex items-center gap-4 p-4 border-b border-gray-700/50">
        {NAV_LINKS.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className={`text-sm px-3 py-1 rounded ${link.to === '/performance' ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <main className="p-4 space-y-4 max-w-7xl mx-auto">
        <h1 className="text-xl font-bold text-cyan-300">Performance Dashboard</h1>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="glass-card p-4 text-center">
            <div className="text-xs text-gray-400">Total P&L</div>
            <div className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="glass-card p-4 text-center">
            <div className="text-xs text-gray-400">Total Trades</div>
            <div className="text-2xl font-bold text-white">{totalTrades}</div>
          </div>
          <div className="glass-card p-4 text-center">
            <div className="text-xs text-gray-400">Win Rate</div>
            <div className={`text-2xl font-bold ${winRate >= 50 ? 'text-green-400' : 'text-yellow-400'}`}>
              {winRate.toFixed(1)}%
            </div>
          </div>
          <div className="glass-card p-4 text-center">
            <div className="text-xs text-gray-400">Max Drawdown</div>
            <div className="text-2xl font-bold text-red-400">
              {equityCurve.length > 0 ? Math.max(...equityCurve.map(p => p.drawdown)).toFixed(1) : '0.0'}%
            </div>
          </div>
        </div>

        {/* Equity Curve */}
        <div className="glass-card p-4">
          <h2 className="text-sm font-semibold text-cyan-300 mb-3">Equity Curve</h2>
          {equityCurve.length < 2 ? (
            <div className="text-xs text-gray-400 h-40 flex items-center justify-center">No trade data yet</div>
          ) : (
            <div className="h-40 flex items-end gap-px">
              {equityCurve.map((point, i) => {
                const height = ((point.equity - minEquity) / equityRange) * 100;
                const isGreen = point.equity >= initialBudget;
                return (
                  <div
                    key={i}
                    className={`flex-1 min-w-[2px] rounded-t ${isGreen ? 'bg-green-500/70' : 'bg-red-500/70'}`}
                    style={{ height: `${Math.max(2, height)}%` }}
                    title={`$${point.equity.toFixed(2)} (Trade #${point.tradeIndex})`}
                  />
                );
              })}
            </div>
          )}
          <div className="flex justify-between text-[10px] text-gray-500 mt-1">
            <span>${minEquity.toFixed(0)}</span>
            <span>${maxEquity.toFixed(0)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Strategy Breakdown */}
          <div className="glass-card p-4">
            <h2 className="text-sm font-semibold text-cyan-300 mb-3">Strategy Breakdown</h2>
            {strategyBreakdown.length === 0 ? (
              <div className="text-xs text-gray-400">No data</div>
            ) : (
              <div className="space-y-2">
                {strategyBreakdown.map(stat => (
                  <div key={stat.strategy} className="bg-gray-800/50 rounded p-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-cyan-400 font-medium">{stat.strategy}</span>
                      <span className={`text-xs font-bold ${stat.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${stat.totalPnl.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${stat.winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(100, stat.winRate)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-400">
                        {stat.winRate.toFixed(0)}% | {stat.trades}t | PF: {stat.profitFactor === Infinity ? '∞' : stat.profitFactor.toFixed(1)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Monthly P&L */}
          <div className="glass-card p-4">
            <h2 className="text-sm font-semibold text-cyan-300 mb-3">Monthly P&L</h2>
            {monthlyPnl.length === 0 ? (
              <div className="text-xs text-gray-400">No data</div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {monthlyPnl.map(m => (
                  <div
                    key={m.month}
                    className={`p-2 rounded text-center text-xs ${m.pnl >= 0 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}
                  >
                    <div className="text-[10px] text-gray-400">{m.month}</div>
                    <div className="font-bold">${m.pnl.toFixed(2)}</div>
                    <div className="text-[9px]">{m.trades}t | {m.winRate.toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Rolling Metrics */}
        {rollingMetrics.length > 0 && (
          <div className="glass-card p-4">
            <h2 className="text-sm font-semibold text-cyan-300 mb-3">Rolling 30-Trade Metrics</h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-gray-400">Current Sharpe</div>
                <div className="text-lg font-bold text-white">
                  {rollingMetrics[rollingMetrics.length - 1]?.sharpe.toFixed(2) || '0'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400">Rolling Win Rate</div>
                <div className="text-lg font-bold text-white">
                  {rollingMetrics[rollingMetrics.length - 1]?.winRate.toFixed(1) || '0'}%
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400">Avg P&L</div>
                <div className={`text-lg font-bold ${(rollingMetrics[rollingMetrics.length - 1]?.avgPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${rollingMetrics[rollingMetrics.length - 1]?.avgPnl.toFixed(2) || '0'}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default PerformanceDashboard;
