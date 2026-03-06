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
  const portfolio = status?.portfolio;
  const cb = status?.circuitBreaker;
  const trades = status?.trades;
  const positions = status?.positionDetails || [];

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
          <span className="ed-stat-value">${(portfolio?.equity || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Cash</span>
          <span className="ed-stat-value">${(portfolio?.cash || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">P&L</span>
          <span className={`ed-stat-value ${(portfolio?.pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
            {(portfolio?.pnl || 0) >= 0 ? '+' : ''}${(portfolio?.pnl || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            <small> ({portfolio?.pnlPct?.toFixed(1) || '0.0'}%)</small>
          </span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Positions</span>
          <span className="ed-stat-value">{portfolio?.positions || 0}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Exposure</span>
          <span className="ed-stat-value">{portfolio?.exposurePct?.toFixed(1) || '0.0'}%</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Win Rate</span>
          <span className="ed-stat-value">{trades?.winRate?.toFixed(1) || '0.0'}%</span>
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
              {positions.map((pos) => {
                const holdHrs = pos.holdTime ? Math.floor(pos.holdTime / 3600000) : 0;
                const holdMin = pos.holdTime ? Math.floor((pos.holdTime % 3600000) / 60000) : 0;
                return (
                  <tr key={pos.ticker}>
                    <td style={{ fontWeight: 600 }}>{pos.ticker.replace('USD', '')}</td>
                    <td><span className="badge badge-blue" style={{ fontSize: '10px' }}>{pos.strategy}</span></td>
                    <td>${pos.entryPrice?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>${pos.currentPrice?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ color: pos.pnlPct >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct?.toFixed(2)}%
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{holdHrs}h {holdMin}m</td>
                    <td><span className={`badge ${pos.regime?.includes('UP') ? 'badge-green' : pos.regime?.includes('DOWN') ? 'badge-red' : 'badge-blue'}`} style={{ fontSize: '10px' }}>{pos.regime}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Circuit Breaker */}
      {cb && (cb.isPaused || cb.consecutiveLosses >= 2) && (
        <div className={`ed-circuit-breaker ${cb.isPaused ? 'paused' : 'warning'}`}>
          <span className="ed-cb-icon">{cb.isPaused ? '🛑' : '⚠️'}</span>
          <span>
            {cb.isPaused
              ? 'Circuit breaker active — trading paused'
              : `${cb.consecutiveLosses} consecutive losses — monitoring`}
          </span>
          <small>Daily P&L: ${cb.dailyPnl?.toFixed(2)} | Drawdown: {cb.drawdownPct?.toFixed(1)}%</small>
        </div>
      )}

      {/* Mode Banner */}
      {mode === 'SIMULATION' && (
        <div className="ed-sim-banner">
          SIMULATION MODE — No real trades will be executed
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
