/**
 * ExchangeDashboard — Per-exchange trading view.
 *
 * Displays engine status, portfolio, positions, and controls for
 * a single exchange (Kraken or Crypto.com). Used as the main content
 * for both exchange tabs.
 */

import React, { useState } from 'react';
import {
  useEngineStatus,
  useStartEngine,
  usePauseEngine,
  useResumeEngine,
  useStopEngine,
  useSwitchMode,
} from '../hooks/useEngineAPI';
import { useToast } from './ToastNotification';

interface Props {
  exchange: 'kraken' | 'crypto.com';
}

export function ExchangeDashboard({ exchange }: Props) {
  const { data: status, isLoading, error } = useEngineStatus(exchange);
  const startEngine = useStartEngine();
  const pauseEngine = usePauseEngine();
  const resumeEngine = useResumeEngine();
  const stopEngine = useStopEngine();
  const switchMode = useSwitchMode();
  const [budget, setBudget] = useState(50);
  const { addToast } = useToast();

  const displayName = exchange === 'crypto.com' ? 'Crypto.com' : 'Kraken';
  const accentColor = exchange === 'crypto.com' ? '#6366f1' : '#3b82f6';

  if (isLoading) {
    return (
      <div className="exchange-dashboard loading">
        <div className="spinner" />
        <p>Connecting to {displayName}...</p>
      </div>
    );
  }

  const engineState = status?.state || 'IDLE';
  const mode = status?.mode || 'SIMULATION';
  // Backend returns flat structure from TradingEngine.getStatus()
  const equity = status?.equity ?? 0;
  const cash = status?.cash ?? 0;
  const pnl = status?.pnlUsd ?? 0;
  const pnlPct = status?.pnlPct ?? 0;
  const posCount = status?.positions ?? 0;
  const exposurePct = equity > 0 ? ((equity - cash) / equity) * 100 : 0;
  const winRate = status?.tradeStats?.winRate ?? 0;
  const consecutiveLosses = status?.consecutiveLosses ?? 0;
  const dailyPnl = status?.dailyPnl ?? 0;
  const drawdownPct = status?.drawdownPct ?? 0;
  // positionDetails is an object keyed by ticker — convert to array
  const posObj = status?.positionDetails || {};
  const positions = Array.isArray(posObj)
    ? posObj
    : Object.entries(posObj).map(([ticker, pos]: [string, any]) => ({ ticker, ...pos }));

  return (
    <div className="exchange-dashboard" style={{ '--accent': accentColor } as React.CSSProperties}>
      {/* Header */}
      <div className="ed-header">
        <div className="ed-title">
          <span className="ed-exchange-badge" style={{ background: accentColor }}>
            {displayName}
          </span>
          <span className={`ed-state ed-state-${engineState.toLowerCase()}`}>
            {engineState}
          </span>
          <span className={`ed-mode ed-mode-${mode.toLowerCase()}`}>
            {mode}
          </span>
        </div>
        <div className="ed-controls">
          {engineState === 'IDLE' && (
            <>
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                min={10}
                max={10000}
                className="ed-budget-input"
                placeholder="Budget $"
              />
              <button
                className="ed-btn ed-btn-start"
                onClick={() => startEngine.mutate({ exchange, mode, budget }, {
                  onSuccess: () => addToast('success', `${displayName} Started`, `${mode} mode with $${budget} budget`),
                  onError: (err: Error) => addToast('error', `${displayName} Start Failed`, err.message),
                })}
                disabled={startEngine.isPending}
              >
                {startEngine.isPending ? 'Starting...' : 'Start'}
              </button>
            </>
          )}
          {engineState === 'RUNNING' && (
            <button
              className="ed-btn ed-btn-pause"
              onClick={() => pauseEngine.mutate(exchange, {
                onSuccess: () => addToast('warning', `${displayName} Paused`, 'Engine paused — no new trades'),
                onError: (err: Error) => addToast('error', 'Pause Failed', err.message),
              })}
              disabled={pauseEngine.isPending}
            >
              Pause
            </button>
          )}
          {engineState === 'PAUSED' && (
            <button
              className="ed-btn ed-btn-resume"
              onClick={() => resumeEngine.mutate(exchange, {
                onSuccess: () => addToast('success', `${displayName} Resumed`, 'Trading engine active again'),
                onError: (err: Error) => addToast('error', 'Resume Failed', err.message),
              })}
              disabled={resumeEngine.isPending}
            >
              Resume
            </button>
          )}
          {(engineState === 'RUNNING' || engineState === 'PAUSED') && (
            <button
              className="ed-btn ed-btn-stop"
              onClick={() => {
                if (window.confirm(`Stop ${exchange} engine? Open positions will no longer be managed automatically.`)) {
                  stopEngine.mutate(exchange, {
                    onSuccess: () => addToast('warning', `${displayName} Stopped`, 'Engine stopped — positions unmanaged'),
                    onError: (err: Error) => addToast('error', 'Stop Failed', err.message),
                  });
                }
              }}
              disabled={stopEngine.isPending}
            >
              Stop
            </button>
          )}
          <button
            className={`ed-btn ed-btn-mode ${mode === 'REAL' ? 'ed-btn-mode-real' : ''}`}
            onClick={() => {
              const newMode = mode === 'SIMULATION' ? 'REAL' : 'SIMULATION';
              if (newMode === 'REAL') {
                if (!window.confirm('Switch to REAL trading mode? This will execute actual trades with real money.')) return;
              }
              switchMode.mutate({ exchange, mode: newMode }, {
                onSuccess: () => addToast(newMode === 'REAL' ? 'warning' : 'info', `Mode: ${newMode}`, `${displayName} now in ${newMode} mode`),
                onError: (err: Error) => addToast('error', 'Mode Switch Failed', err.message),
              });
            }}
            disabled={switchMode.isPending || engineState === 'RUNNING'}
            title={engineState === 'RUNNING' ? 'Stop engine to switch mode' : ''}
          >
            {mode === 'SIMULATION' ? 'Switch to REAL' : 'Switch to SIM'}
          </button>
        </div>
      </div>

      {/* Portfolio Summary */}
      <div className="ed-portfolio-grid">
        <div className="ed-stat">
          <span className="ed-stat-label">Equity</span>
          <span className="ed-stat-value">${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Cash</span>
          <span className="ed-stat-value">${cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">P&L</span>
          <span className={`ed-stat-value ${pnl >= 0 ? 'positive' : 'negative'}`}>
            {pnl >= 0 ? '+' : ''}${pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            <small> ({pnlPct.toFixed(1)}%)</small>
          </span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Positions</span>
          <span className="ed-stat-value">{posCount}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Exposure</span>
          <span className="ed-stat-value">{exposurePct.toFixed(1)}%</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Win Rate</span>
          <span className="ed-stat-value">{winRate.toFixed(1)}%</span>
        </div>
      </div>

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="ed-positions">
          <table className="trade-table" style={{ width: '100%', fontSize: '12px' }}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Strategy</th>
                <th>Entry</th>
                <th>Current</th>
                <th>P&L</th>
                <th>Hold Time</th>
                <th>Regime</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos: any) => {
                const holdMs = pos.entryTime ? Date.now() - pos.entryTime : 0;
                const holdHrs = Math.floor(holdMs / 3600000);
                const holdMin = Math.floor((holdMs % 3600000) / 60000);
                const entry = pos.openPrice ?? pos.entryPrice ?? 0;
                const current = pos.currentPrice ?? pos.highestPrice ?? entry;
                const pnlP = entry > 0 ? ((current - entry) / entry) * 100 : 0;
                return (
                  <tr key={pos.ticker}>
                    <td style={{ fontWeight: 600 }}>{pos.ticker?.replace('USD', '')}</td>
                    <td><span className="badge badge-blue" style={{ fontSize: '10px' }}>{pos.entryStrategy || pos.strategy || '—'}</span></td>
                    <td>${entry.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>${current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ color: pnlP >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {pnlP >= 0 ? '+' : ''}{pnlP.toFixed(2)}%
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{holdHrs}h {holdMin}m</td>
                    <td><span className={`badge ${pos.regime?.includes('UP') ? 'badge-green' : pos.regime?.includes('DOWN') ? 'badge-red' : 'badge-blue'}`} style={{ fontSize: '10px' }}>{pos.regime || '—'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Circuit Breaker */}
      {consecutiveLosses >= 2 && (
        <div className={`ed-circuit-breaker ${consecutiveLosses >= 4 ? 'paused' : 'warning'}`}>
          <span className="ed-cb-icon">{consecutiveLosses >= 4 ? '🛑' : '⚠️'}</span>
          <span>
            {consecutiveLosses >= 4
              ? 'Circuit breaker active — trading paused'
              : `${consecutiveLosses} consecutive losses — monitoring`}
          </span>
          <small>Daily P&L: ${dailyPnl.toFixed(2)} | Drawdown: {drawdownPct.toFixed(1)}%</small>
        </div>
      )}

      {/* Mode Banner */}
      {mode === 'SIMULATION' && (
        <div className="ed-sim-banner">
          SIMULATION MODE — No real trades will be executed
        </div>
      )}

      {/* Trade Stats Summary */}
      {(status?.tradeStats?.total ?? 0) > 0 && (
        <div className="ed-trade-stats">
          <div className="section-header" style={{ marginBottom: '8px' }}>
            <span>Trade Performance</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
            <div className="ed-stat">
              <span className="ed-stat-label">Total Trades</span>
              <span className="ed-stat-value" style={{ fontSize: '16px' }}>{status.tradeStats.total}</span>
            </div>
            <div className="ed-stat">
              <span className="ed-stat-label">Wins / Losses</span>
              <span className="ed-stat-value" style={{ fontSize: '16px' }}>
                <span style={{ color: 'var(--green)' }}>{status.tradeStats.wins}</span>
                {' / '}
                <span style={{ color: 'var(--red)' }}>{status.tradeStats.losses}</span>
              </span>
            </div>
            <div className="ed-stat">
              <span className="ed-stat-label">Win Rate</span>
              <span className={`ed-stat-value ${winRate >= 50 ? 'positive' : 'negative'}`} style={{ fontSize: '16px' }}>
                {winRate.toFixed(1)}%
              </span>
            </div>
            <div className="ed-stat">
              <span className="ed-stat-label">Avg P&L</span>
              <span className={`ed-stat-value ${(status.tradeStats.avgPnl ?? 0) >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '16px' }}>
                {(status.tradeStats.avgPnl ?? 0) >= 0 ? '+' : ''}{(status.tradeStats.avgPnl ?? 0).toFixed(2)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Recent Trades */}
      {(status?.recentTrades?.length ?? 0) > 0 && (
        <div className="ed-recent-trades" style={{ marginTop: '12px' }}>
          <div className="section-header" style={{ marginBottom: '8px' }}>
            <span>Recent Trades (last {Math.min(status.recentTrades.length, 10)})</span>
          </div>
          <table className="trade-table" style={{ width: '100%', fontSize: '12px' }}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Strategy</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P&L</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {status.recentTrades.slice(-10).reverse().map((t: any, i: number) => {
                const tPnl = t.pnl ?? t.pnlPct ?? 0;
                const dur = t.holdTime ? `${Math.floor(t.holdTime / 3600000)}h ${Math.floor((t.holdTime % 3600000) / 60000)}m` : '—';
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{(t.ticker || '').replace('USD', '')}</td>
                    <td><span className="badge badge-blue" style={{ fontSize: '10px' }}>{t.strategy || t.entryStrategy || '—'}</span></td>
                    <td>${(t.entryPrice ?? t.openPrice ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>${(t.exitPrice ?? t.closePrice ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ color: tPnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {tPnl >= 0 ? '+' : ''}{tPnl.toFixed(2)}%
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{dur}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="ed-error">
          Failed to connect to {displayName}: {(error as Error).message}
        </div>
      )}
    </div>
  );
}
