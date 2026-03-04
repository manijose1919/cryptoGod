/**
 * PortfolioOverview — Cross-exchange portfolio view.
 *
 * Aggregates data from both Kraken and Crypto.com,
 * shows global metrics, heat score, staking, arbitrage, and shorts.
 */

import type React from 'react';
import {
  useAllEnginesStatus,
  useStakingStatus,
  useArbitrageStatus,
  useShortStatus,
  usePerformanceMetrics,
} from '../hooks/useEngineAPI';

export function PortfolioOverview() {
  const { data: enginesData } = useAllEnginesStatus();
  const { data: staking } = useStakingStatus();
  const { data: arb } = useArbitrageStatus();
  const { data: shorts } = useShortStatus();
  usePerformanceMetrics(30); // Pre-fetch for future use

  const global = enginesData?.global;
  const engines = enginesData?.engines || {};

  return (
    <div className="portfolio-overview">
      {/* Global Summary */}
      <div className="po-section po-global">
        <h3>Global Portfolio</h3>
        <div className="po-metrics-grid">
          <div className="po-metric">
            <span className="po-metric-label">Total Equity</span>
            <span className="po-metric-value large">
              ${global?.totalEquity?.toFixed(2) || '0.00'}
            </span>
          </div>
          <div className="po-metric">
            <span className="po-metric-label">Total P&L</span>
            <span className={`po-metric-value large ${(global?.totalPnl || 0) >= 0 ? 'positive' : 'negative'}`}>
              {(global?.totalPnl || 0) >= 0 ? '+' : ''}${global?.totalPnl?.toFixed(2) || '0.00'}
              <small> ({global?.totalPnlPct?.toFixed(1) || '0.0'}%)</small>
            </span>
          </div>
          <div className="po-metric">
            <span className="po-metric-label">Heat Score</span>
            <span className={`po-metric-value ${getHeatColor(global?.heatScore || 0)}`}>
              {global?.heatScore?.toFixed(0) || '0'}/100
            </span>
          </div>
          <div className="po-metric">
            <span className="po-metric-label">Max Drawdown</span>
            <span className="po-metric-value negative">
              {global?.maxDrawdownPct?.toFixed(1) || '0.0'}%
            </span>
          </div>
        </div>
      </div>

      {/* Per-Exchange Breakdown */}
      <div className="po-section po-exchanges">
        <h3>Exchange Breakdown</h3>
        <div className="po-exchange-cards">
          <ExchangeCard
            name="Kraken"
            color="#3b82f6"
            equity={global?.krakenEquity || 0}
            pnl={global?.krakenPnl || 0}
            state={engines.kraken?.state || 'IDLE'}
            mode={engines.kraken?.mode || 'SIMULATION'}
          />
          <ExchangeCard
            name="Crypto.com"
            color="#6366f1"
            equity={global?.cryptoComEquity || 0}
            pnl={global?.cryptoComPnl || 0}
            state={engines['crypto.com']?.state || 'IDLE'}
            mode={engines['crypto.com']?.mode || 'SIMULATION'}
          />
        </div>
      </div>

      {/* Revenue Streams */}
      <div className="po-section po-revenue">
        <h3>Revenue Streams</h3>
        <div className="po-revenue-grid">
          {/* Staking */}
          <div className="po-revenue-card">
            <div className="po-revenue-header">
              <span className="po-revenue-icon">🏦</span>
              <span>Staking</span>
            </div>
            <div className="po-revenue-body">
              <span className={staking?.enabled ? 'active' : 'inactive'}>
                {staking?.enabled ? `${staking.stakedPositions} staked` : 'Disabled'}
              </span>
              {staking?.products !== undefined && (
                <small>{staking.products} products available</small>
              )}
            </div>
          </div>

          {/* Arbitrage */}
          <div className="po-revenue-card">
            <div className="po-revenue-header">
              <span className="po-revenue-icon">🔄</span>
              <span>Arbitrage</span>
            </div>
            <div className="po-revenue-body">
              <span className={arb?.enabled ? 'active' : 'inactive'}>
                {arb?.enabled ? `${arb.opportunities} opportunities` : 'Scanning...'}
              </span>
            </div>
          </div>

          {/* Short Selling */}
          <div className="po-revenue-card">
            <div className="po-revenue-header">
              <span className="po-revenue-icon">📉</span>
              <span>Short Selling</span>
            </div>
            <div className="po-revenue-body">
              <span className={shorts?.enabled ? 'active' : 'inactive'}>
                {shorts?.enabled
                  ? `$${shorts.simBalance?.toFixed(0)} bal | ${shorts.openPositions} open`
                  : 'Disabled'}
              </span>
              {shorts?.totalTrades !== undefined && shorts.totalTrades > 0 && (
                <small>
                  {shorts.totalTrades} trades | {shorts.winRate?.toFixed(0)}% WR |
                  P&L: {(shorts.simPnl || 0) >= 0 ? '+' : ''}${shorts.simPnl?.toFixed(2)}
                </small>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────

function ExchangeCard({
  name,
  color,
  equity,
  pnl,
  state,
  mode,
}: {
  name: string;
  color: string;
  equity: number;
  pnl: number;
  state: string;
  mode: string;
}) {
  return (
    <div className="po-exchange-card" style={{ borderLeftColor: color }}>
      <div className="po-ec-header">
        <span style={{ color }}>{name}</span>
        <span className={`po-ec-state po-ec-state-${state.toLowerCase()}`}>{state}</span>
      </div>
      <div className="po-ec-body">
        <div className="po-ec-row">
          <span>Equity</span>
          <span>${equity.toFixed(2)}</span>
        </div>
        <div className="po-ec-row">
          <span>P&L</span>
          <span className={pnl >= 0 ? 'positive' : 'negative'}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
        </div>
        <div className="po-ec-row">
          <span>Mode</span>
          <span className={`po-ec-mode ${mode.toLowerCase()}`}>{mode}</span>
        </div>
      </div>
    </div>
  );
}

function getHeatColor(score: number): string {
  if (score < 30) return 'heat-low';
  if (score < 60) return 'heat-med';
  return 'heat-high';
}
