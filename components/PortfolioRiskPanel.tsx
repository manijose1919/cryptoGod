/**
 * PortfolioRiskPanel — Visualizes correlation risk, VaR/CVaR, Kelly, and position heat.
 */
import { useState, useEffect } from 'react';

interface RiskData {
  correlation: {
    enabled: boolean;
    matrixTickers: number;
    isStale: boolean;
    matrixAge: string;
  };
  cvarKelly: {
    kellyFraction: number;
    cvarAdjusted: number;
    regime: string;
  };
  heatScore: number;
  drawdown: number;
  maxDrawdown: number;
  positions: Array<{
    ticker: string;
    pnlPct: number;
    weight: number;
    correlated: string[];
  }>;
}

export default function PortfolioRiskPanel() {
  const [data, setData] = useState<RiskData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () => {
      fetch('/api/engines/risk-summary')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setData(d); setLastUpdated(new Date()); setError(false); } })
        .catch(() => setError(true));
    };
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, []);

  if (error) return (
    <div className="glass-card" style={{ padding: '14px', opacity: 0.6 }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>PORTFOLIO RISK</h3>
      <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>Unable to load risk data</p>
    </div>
  );
  if (!data) return (
    <div className="glass-card" style={{ padding: '14px', opacity: 0.5 }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>PORTFOLIO RISK</h3>
      <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>Loading...</p>
    </div>
  );

  const heatColor = (data.heatScore || 0) < 30 ? 'var(--green)' : (data.heatScore || 0) < 60 ? 'var(--yellow, #eab308)' : 'var(--red)';

  return (
    <div className="glass-card" style={{ padding: '14px' }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px', letterSpacing: '0.5px' }}>
        PORTFOLIO RISK
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
        <MiniStat label="HEAT SCORE" value={`${(data.heatScore || 0).toFixed(0)}/100`} color={heatColor}
          tooltip="Portfolio risk level (0-100). Based on consecutive losses, drawdown depth, and position concentration. Higher = more risk." />
        <MiniStat label="DRAWDOWN" value={`${(data.drawdown || 0).toFixed(2)}%`}
          color={(data.drawdown || 0) > 5 ? 'var(--red)' : 'var(--text-header)'}
          tooltip="Current drawdown from portfolio peak value. Above 5% triggers reduced position sizing." />
        <MiniStat label="KELLY" value={`${((data.cvarKelly?.cvarAdjusted || 0) * 100).toFixed(1)}%`}
          tooltip="CVaR-adjusted Kelly Criterion: optimal fraction of portfolio to risk per trade, accounting for tail risk. Higher = more aggressive sizing allowed." />
        <MiniStat label="CORR PAIRS" value={`${data.correlation?.matrixTickers || 0}`}
          tooltip="Number of tickers tracked in the correlation matrix. High correlation between open positions increases tail risk." />
      </div>

      {/* Heat bar */}
      <div style={{ height: '4px', background: 'var(--border-primary)', borderRadius: '2px', marginBottom: '12px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, data.heatScore || 0)}%`, background: heatColor, borderRadius: '2px', transition: 'width 0.5s' }} />
      </div>

      {/* Position weights */}
      {data.positions && data.positions.length > 0 && (
        <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: '4px', padding: '4px 0', borderBottom: '1px solid var(--border-primary)', color: 'var(--text-muted)', fontWeight: 600 }}>
            <span>POSITION</span><span>WEIGHT</span><span>P&L</span><span>CORRELATED</span>
          </div>
          {data.positions.map((pos, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: '4px', padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ fontWeight: 600 }}>{pos.ticker}</span>
              <span>{(pos.weight * 100).toFixed(1)}%</span>
              <span style={{ color: (pos.pnlPct || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{(pos.pnlPct || 0).toFixed(2)}%</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>
                {pos.correlated?.join(', ') || 'none'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
        <span>Corr matrix: {data.correlation?.matrixAge || 'N/A'} old | {data.correlation?.isStale ? 'STALE' : 'FRESH'}</span>
        {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}</span>}
      </div>
    </div>
  );
}

function MiniStat({ label, value, color, tooltip }: { label: string; value: string; color?: string; tooltip?: string }) {
  return (
    <div style={{ textAlign: 'center' }} title={tooltip}>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, cursor: tooltip ? 'help' : 'default' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: color || 'var(--text-header)', fontFamily: 'var(--font-mono)' }}>{value}</div>
    </div>
  );
}
