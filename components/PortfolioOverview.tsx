/**
 * PortfolioOverview — Bloomberg Terminal-style cross-exchange portfolio view.
 * Dense data grids, equity curve chart, real-time metrics.
 */

import React, { lazy, Suspense, useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  useAllEnginesStatus,
  useStakingStatus,
  useArbitrageStatus,
  useShortStatus,
  usePerformanceMetrics,
} from '../hooks/useEngineAPI';

const RegimeDashboard = lazy(() => import('./RegimeDashboard'));
const StakingPanel = lazy(() => import('./StakingPanel'));
const FundingRatePanel = lazy(() => import('./FundingRatePanel'));

interface EquityPoint {
  time: string;
  equity: number;
}

export function PortfolioOverview() {
  const { data: enginesData } = useAllEnginesStatus();
  const { data: staking } = useStakingStatus();
  const { data: arb } = useArbitrageStatus();
  const { data: shorts } = useShortStatus();
  usePerformanceMetrics(30);

  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);

  useEffect(() => {
    fetch('/api/sessions/equity-curve?limit=100')
      .then(r => r.ok ? r.json() : [])
      .then(d => {
        if (Array.isArray(d) && d.length > 0) {
          setEquityCurve(d.map((p: { timestamp?: string; equity?: number; t?: string; e?: number }) => ({
            time: new Date(p.timestamp || p.t || '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            equity: p.equity ?? p.e ?? 0,
          })));
        }
      })
      .catch(() => {});
  }, []);

  const global = enginesData?.global;
  const engines = enginesData?.engines || {};
  const totalPnl = global?.totalPnl || 0;
  const equity = global?.totalEquity || 0;

  return (
    <div className="portfolio-overview">
      {/* ═══ TOP METRICS BAR ═══ */}
      <div className="po-section">
        <h3>PORTFOLIO SUMMARY</h3>
        <div className="po-metrics-grid">
          <Metric label="NET EQUITY" value={`$${equity.toFixed(2)}`} />
          <Metric label="SESSION P&L" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
            sub={`${(global?.totalPnlPct || 0).toFixed(2)}%`}
            color={totalPnl >= 0 ? 'positive' : 'negative'} />
          <Metric label="HEAT SCORE" value={`${(global?.heatScore || 0).toFixed(0)}/100`}
            color={getHeatColor(global?.heatScore || 0)} />
          <Metric label="MAX DRAWDOWN" value={`${(global?.maxDrawdownPct || 0).toFixed(2)}%`}
            color="negative" />
          <Metric label="WIN RATE" value={`${(global?.winRate || 0).toFixed(0)}%`}
            color={(global?.winRate || 0) >= 50 ? 'positive' : 'negative'} />
          <Metric label="TOTAL TRADES" value={`${global?.totalTrades || 0}`} />
        </div>
      </div>

      {/* ═══ EQUITY CURVE ═══ */}
      {equityCurve.length > 2 && (
        <div className="po-section">
          <h3>EQUITY CURVE</h3>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-primary)', borderRadius: '4px', padding: '8px' }}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff8c00" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#ff8c00" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#484f58', fontFamily: 'var(--font-mono)' }}
                  axisLine={{ stroke: '#1e2d3d' }} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#484f58', fontFamily: 'var(--font-mono)' }}
                  axisLine={false} tickLine={false} width={60}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                <Tooltip
                  contentStyle={{
                    background: '#0d1117', border: '1px solid #1e2d3d', borderRadius: '4px',
                    fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#e6edf3',
                  }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'Equity']}
                />
                <Area type="monotone" dataKey="equity" stroke="#ff8c00" strokeWidth={1.5}
                  fill="url(#eqGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ═══ EXCHANGE BREAKDOWN ═══ */}
      <div className="po-section">
        <h3>EXCHANGE POSITIONS</h3>
        <div className="po-exchange-cards">
          <ExchangeCard name="KRAKEN" color="#ff8c00"
            equity={global?.krakenEquity || 0} pnl={global?.krakenPnl || 0}
            state={engines.kraken?.state || 'IDLE'} mode={engines.kraken?.mode || 'SIMULATION'} />
          <ExchangeCard name="CRYPTO.COM" color="#58a6ff"
            equity={global?.cryptoComEquity || 0} pnl={global?.cryptoComPnl || 0}
            state={engines['crypto.com']?.state || 'IDLE'} mode={engines['crypto.com']?.mode || 'SIMULATION'} />
        </div>
      </div>

      {/* ═══ REVENUE STREAMS ═══ */}
      <div className="po-section">
        <h3>REVENUE STREAMS</h3>
        <div className="po-revenue-grid">
          <RevenueCard title="STAKING" icon="STK"
            status={staking?.enabled ? `${staking.stakedPositions} STAKED` : 'OFFLINE'}
            active={!!staking?.enabled}
            detail={staking?.products !== undefined ? `${staking.products} products` : undefined} />
          <RevenueCard title="ARBITRAGE" icon="ARB"
            status={arb?.enabled ? `${arb.opportunities} OPPS` : 'SCANNING'}
            active={!!arb?.enabled} />
          <RevenueCard title="SHORT SELL" icon="SHT"
            status={shorts?.enabled ? `$${(shorts.simBalance || 0).toFixed(0)} | ${shorts.openPositions} OPEN` : 'OFFLINE'}
            active={!!shorts?.enabled}
            detail={shorts?.totalTrades ? `${shorts.totalTrades}T ${(shorts.winRate || 0).toFixed(0)}%WR P&L:${(shorts.simPnl || 0) >= 0 ? '+' : ''}$${(shorts.simPnl || 0).toFixed(2)}` : undefined} />
        </div>
      </div>

      {/* ═══ INTELLIGENCE PANELS ═══ */}
      <Suspense fallback={
        <div className="po-section" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          LOADING INTELLIGENCE...
        </div>
      }>
        <div className="po-section"><RegimeDashboard /></div>
        <div className="po-section"><FundingRatePanel /></div>
        <div className="po-section"><StakingPanel /></div>
      </Suspense>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────

function Metric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="po-metric">
      <span className="po-metric-label">{label}</span>
      <span className={`po-metric-value ${color || ''}`}>
        {value}
        {sub && <small> ({sub})</small>}
      </span>
    </div>
  );
}

function ExchangeCard({ name, color, equity, pnl, state, mode }: {
  name: string; color: string; equity: number; pnl: number; state: string; mode: string;
}) {
  return (
    <div className="po-exchange-card" style={{ borderLeftColor: color }}>
      <div className="po-ec-header">
        <span style={{ color }}>{name}</span>
        <span className={`po-ec-state po-ec-state-${state.toLowerCase()}`}>{state}</span>
      </div>
      <div className="po-ec-body">
        <div className="po-ec-row"><span>EQUITY</span><span>${equity.toFixed(2)}</span></div>
        <div className="po-ec-row">
          <span>P&L</span>
          <span className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>
        </div>
        <div className="po-ec-row"><span>MODE</span><span className={`po-ec-mode ${mode.toLowerCase()}`}>{mode}</span></div>
      </div>
    </div>
  );
}

function RevenueCard({ title, icon, status, active, detail }: {
  title: string; icon: string; status: string; active: boolean; detail?: string;
}) {
  return (
    <div className="po-revenue-card">
      <div className="po-revenue-header">
        <span style={{ color: 'var(--text-header)', fontSize: '10px', fontWeight: 700, background: 'var(--amber-bg)', padding: '1px 4px', borderRadius: '2px' }}>{icon}</span>
        <span>{title}</span>
      </div>
      <div className="po-revenue-body">
        <span className={active ? 'active' : 'inactive'}>{status}</span>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}

function getHeatColor(score: number): string {
  if (score < 30) return 'heat-low';
  if (score < 60) return 'heat-med';
  return 'heat-high';
}
