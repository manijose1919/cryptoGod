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
                onClick={() => startEngine.mutate({ exchange, mode, budget })}
                disabled={startEngine.isPending}
              >
                {startEngine.isPending ? 'Starting...' : 'Start'}
              </button>
            </>
          )}
          {engineState === 'RUNNING' && (
            <button
              className="ed-btn ed-btn-pause"
              onClick={() => pauseEngine.mutate(exchange)}
              disabled={pauseEngine.isPending}
            >
              Pause
            </button>
          )}
          {engineState === 'PAUSED' && (
            <button
              className="ed-btn ed-btn-resume"
              onClick={() => resumeEngine.mutate(exchange)}
              disabled={resumeEngine.isPending}
            >
              Resume
            </button>
          )}
          {(engineState === 'RUNNING' || engineState === 'PAUSED') && (
            <button
              className="ed-btn ed-btn-stop"
              onClick={() => stopEngine.mutate(exchange)}
              disabled={stopEngine.isPending}
            >
              Stop
            </button>
          )}
          <button
            className={`ed-btn ed-btn-mode ${mode === 'REAL' ? 'ed-btn-mode-real' : ''}`}
            onClick={() => switchMode.mutate({
              exchange,
              mode: mode === 'SIMULATION' ? 'REAL' : 'SIMULATION',
            })}
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
          <span className="ed-stat-value">${portfolio?.equity?.toFixed(2) || '0.00'}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">Cash</span>
          <span className="ed-stat-value">${portfolio?.cash?.toFixed(2) || '0.00'}</span>
        </div>
        <div className="ed-stat">
          <span className="ed-stat-label">P&L</span>
          <span className={`ed-stat-value ${(portfolio?.pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
            {(portfolio?.pnl || 0) >= 0 ? '+' : ''}${portfolio?.pnl?.toFixed(2) || '0.00'}
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
