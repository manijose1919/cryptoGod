/**
 * ShortPositionsPanel — Shows short selling engine positions, P&L, and status.
 */
import React, { useState, useEffect } from 'react';

interface ShortPosition {
  ticker: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  regime: string;
}

interface ShortStatus {
  enabled: boolean;
  simBalance: number;
  simPnl: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  positions: ShortPosition[];
}

export default function ShortPositionsPanel() {
  const [data, setData] = useState<ShortStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () => {
      fetch('/api/shorts/status')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setData(d); setLastUpdated(new Date()); setError(false); } })
        .catch(() => setError(true));
    };
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  if (error) return (
    <div className="glass-card" style={{ padding: '14px', opacity: 0.6 }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>SHORT SELLING ENGINE</h3>
      <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>Unable to load short engine data</p>
    </div>
  );
  if (!data) return (
    <div className="glass-card" style={{ padding: '14px', opacity: 0.5 }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>SHORT SELLING ENGINE</h3>
      <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>Loading...</p>
    </div>
  );

  return (
    <div className="glass-card" style={{ padding: '14px' }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px', letterSpacing: '0.5px' }}>
        SHORT SELLING ENGINE
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
        <MiniStat label="SIM BALANCE" value={`$${(data.simBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          tooltip="Simulated account balance for short selling paper trades. Starts at $1,000." />
        <MiniStat label="SIM P&L" value={`${(data.simPnl || 0) >= 0 ? '+' : ''}$${(data.simPnl || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          color={(data.simPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)'}
          tooltip="Total simulated profit/loss from short positions." />
        <MiniStat label="TRADES" value={`${data.totalTrades || 0}`}
          tooltip="Total number of short trades executed (sim mode)." />
        <MiniStat label="WIN RATE" value={`${(data.winRate || 0).toFixed(0)}%`}
          color={(data.winRate || 0) >= 50 ? 'var(--green)' : 'var(--red)'}
          tooltip="Percentage of short trades that were profitable." />
      </div>

      {data.positions && data.positions.length > 0 ? (
        <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '4px', padding: '4px 0', borderBottom: '1px solid var(--border-primary)', color: 'var(--text-muted)', fontWeight: 600 }}>
            <span>PAIR</span><span>ENTRY</span><span>CURRENT</span><span>P&L</span><span>SL/TP</span>
          </div>
          {data.positions.map((pos, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '4px', padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--red)', fontWeight: 600 }}>{pos.ticker}</span>
              <span>${(pos.entryPrice ?? 0).toFixed(2)}</span>
              <span>${(pos.currentPrice ?? 0).toFixed(2)}</span>
              <span style={{ color: (pos.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {(pos.pnlPercent || 0).toFixed(2)}%
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>
                {(pos.stopLoss ?? 0).toFixed(0)}/{(pos.takeProfit ?? 0).toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', padding: '8px' }}>
          {data.enabled ? 'NO OPEN SHORT POSITIONS' : 'SHORT ENGINE OFFLINE'}
        </div>
      )}

      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
        <span>{data.enabled ? 'Engine active' : 'Engine offline'}</span>
        {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}</span>}
      </div>
    </div>
  );
}

function MiniStat({ label, value, color, tooltip }: { label: string; value: string; color?: string; tooltip?: string }) {
  return (
    <div style={{ textAlign: 'center' }} title={tooltip}>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.3px', cursor: tooltip ? 'help' : 'default' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: color || 'var(--text-header)', fontFamily: 'var(--font-mono)' }}>{value}</div>
    </div>
  );
}
