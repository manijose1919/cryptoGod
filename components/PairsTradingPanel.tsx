/**
 * PairsTradingPanel — live cointegration metrics + paper/live pair trades.
 *
 * Polls /api/v2/pairs/{status,trades,state,pnl} every 10s. Auto-handles the
 * "engine off" state (no data) gracefully.
 */
import React, { useState, useEffect, useMemo } from 'react';

// ---- Types matching the API responses ----

interface CointegrationState {
  alpha: number;
  beta: number;
  spreadMean: number;
  spreadStd: number;
  adfTStat: number;
  halflife: number;
  lastReestimateBar: number;
  rSquared: number;
}

interface PairsStatus {
  mode: string;
  isRunning: boolean;
  loopCount: number;
  inPosition: boolean;
  paperEntriesOpened: number;
  paperEntriesClosed: number;
  paperPnlTotalUsd: number;
  consecutiveLosses: number;
  pausedUntilTs: number;
  cointegration: CointegrationState | null;
}

interface PairsTrade {
  id: string;
  mode: 'paper' | 'live';
  sym_a: string;
  sym_b: string;
  side: 'long_spread' | 'short_spread';
  status: 'open' | 'closed' | 'error';
  entry_time: number;
  entry_price_a: number;
  entry_price_b: number;
  qty_a: number;
  qty_b: number;
  beta: number;
  entry_z: number;
  total_notional_usd: number;
  exit_time: number | null;
  exit_price_a: number | null;
  exit_price_b: number | null;
  exit_z: number | null;
  exit_reason: string | null;
  pnl_net: number | null;
  fees_paid: number | null;
  hold_bars: number | null;
}

interface StateSnapshot {
  loop_at: number;
  beta: number;
  z_score: number;
  adf_t_stat: number | null;
  halflife: number | null;
  in_position: number;
}

interface PnlSummary {
  summary: Array<{
    mode: string;
    trades: number;
    wins: number;
    total_pnl: number;
    avg_pnl: number;
    total_fees: number;
  }>;
}

// ---- Z-Score Gauge (Bloomberg-style horizontal bar) ----

function ZScoreGauge({ z }: { z: number }): React.ReactElement {
  // Domain: [-4, 4], with marks at -1.5 (entry), -0.3 (exit), 0, +0.3, +1.5, ±4 (stop).
  const clamped = Math.max(-4, Math.min(4, z));
  const pct = ((clamped + 4) / 8) * 100;
  const isEntry = Math.abs(z) >= 1.5;
  const isStop = Math.abs(z) >= 4;
  const fillColor = isStop ? 'var(--red, #ef4444)'
    : isEntry ? 'var(--green, #10b981)'
    : 'var(--text-muted, #888)';

  return (
    <div style={{ position: 'relative', height: '40px', width: '100%' }}>
      {/* Background bands */}
      <div style={{
        position: 'absolute', inset: '10px 0', display: 'flex',
        border: '1px solid var(--border, #333)', borderRadius: '4px', overflow: 'hidden',
      }}>
        {/* -4 to -1.5: stop / entry-short zone */}
        <div style={{ flex: '2.5', background: 'rgba(239, 68, 68, 0.12)' }} />
        {/* -1.5 to -0.3: long entry / mean-revert band */}
        <div style={{ flex: '1.2', background: 'rgba(16, 185, 129, 0.18)' }} />
        {/* -0.3 to 0.3: exit zone */}
        <div style={{ flex: '0.6', background: 'rgba(99, 102, 241, 0.12)' }} />
        {/* 0.3 to 1.5 */}
        <div style={{ flex: '1.2', background: 'rgba(16, 185, 129, 0.18)' }} />
        {/* 1.5 to 4 */}
        <div style={{ flex: '2.5', background: 'rgba(239, 68, 68, 0.12)' }} />
      </div>
      {/* Marker at current z */}
      <div style={{
        position: 'absolute', left: `${pct}%`, top: '4px', bottom: '4px', width: '3px',
        background: fillColor, transform: 'translateX(-50%)',
        boxShadow: `0 0 8px ${fillColor}`,
      }} />
      {/* Number labels under bar */}
      <div style={{
        position: 'absolute', bottom: '-12px', left: 0, right: 0,
        display: 'flex', justifyContent: 'space-between', fontSize: '9px',
        color: 'var(--text-muted, #888)',
      }}>
        <span>-4σ</span>
        <span>-1.5</span>
        <span>0</span>
        <span>+1.5</span>
        <span>+4σ</span>
      </div>
    </div>
  );
}

// ---- Tiny PnL spark chart (SVG) ----

function PnlSparkline({ values }: { values: number[] }): React.ReactElement {
  if (values.length < 2) {
    return (
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
        Not enough closed trades to chart yet.
      </div>
    );
  }
  const w = 320, h = 80;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = h - ((0 - min) / range) * h;
  const lastVal = values[values.length - 1];
  const color = lastVal >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)';
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: '80px' }}>
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--border, #333)" strokeWidth="1" strokeDasharray="2,2" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ---- Main panel ----

export default function PairsTradingPanel(): React.ReactElement {
  const [status, setStatus] = useState<PairsStatus | null>(null);
  const [trades, setTrades] = useState<PairsTrade[]>([]);
  const [state, setState] = useState<StateSnapshot[]>([]);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const [s, t, st, p] = await Promise.all([
          fetch('/api/v2/pairs/status').then(r => r.ok ? r.json() : null),
          fetch('/api/v2/pairs/trades?limit=50').then(r => r.ok ? r.json() : null),
          fetch('/api/v2/pairs/state?limit=100').then(r => r.ok ? r.json() : null),
          fetch('/api/v2/pairs/pnl').then(r => r.ok ? r.json() : null),
        ]);
        if (s) setStatus(s);
        if (t?.trades) setTrades(t.trades);
        if (st?.snapshots) setState(st.snapshots);
        if (p) setPnl(p);
        setLastUpdated(new Date());
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, []);

  const openTrade = trades.find(t => t.status === 'open');
  const closedTrades = trades.filter(t => t.status === 'closed');
  const currentZ = state[0]?.z_score ?? 0;

  // Cumulative paper PnL from oldest → newest
  const cumulativePnl = useMemo(() => {
    const sorted = [...closedTrades].sort((a, b) => (a.exit_time ?? 0) - (b.exit_time ?? 0));
    let acc = 0;
    return sorted.map(t => { acc += t.pnl_net ?? 0; return acc; });
  }, [closedTrades]);

  // Unrealized PnL on open trade (rough; uses entry prices + state mark)
  const unrealizedPnl = useMemo<number | null>(() => {
    if (!openTrade || state.length === 0) return null;
    // We don't yet store mark prices in state snapshots — show null for now.
    // A future endpoint /pairs/mark could compute this server-side.
    return null;
  }, [openTrade, state]);

  if (error) {
    return (
      <div style={{ padding: '20px' }}>
        <div className="glass-card" style={{ padding: '14px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>PAIRS TRADING</h3>
          <p style={{ fontSize: '10px', color: 'var(--red, #ef4444)', marginTop: '8px' }}>
            Error loading: {error}
          </p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ padding: '20px' }}>
        <div className="glass-card" style={{ padding: '14px', opacity: 0.6 }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)' }}>PAIRS TRADING</h3>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Engine off — show how to enable it.
  if (status.mode === 'off') {
    return (
      <div style={{ padding: '20px' }}>
        <div className="glass-card" style={{ padding: '20px' }}>
          <h3 style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-header)' }}>
            PAIRS TRADING — DISABLED
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px', lineHeight: 1.6 }}>
            The pairs trading engine is currently disabled. To enable in paper mode:
          </p>
          <pre style={{
            background: 'var(--bg-secondary, #1a1a1a)',
            padding: '10px', borderRadius: '4px', marginTop: '8px',
            fontSize: '10px', color: 'var(--text-primary)',
          }}>
{`# In your .env or shell:\nexport PAIRS_MODE=paper\nnpm run dev`}
          </pre>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '12px' }}>
            Deployment plan: <code>docs/plans/2026-05-26-pairs-deployment-plan.md</code>
          </p>
        </div>
      </div>
    );
  }

  const modeColor = status.mode === 'live' ? 'var(--red, #ef4444)' : 'var(--blue, #3b82f6)';
  const zEntry = Math.abs(currentZ) >= 1.5;
  const zExit = Math.abs(currentZ) < 0.3;
  const adfHealthy = (status.cointegration?.adfTStat ?? 0) < -2.86;

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ═══ HEADER ═══ */}
      <div className="glass-card" style={{ padding: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-header)', margin: 0 }}>
            PAIRS TRADING — FILUSD / ICPUSD
          </h3>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
            Loop {status.loopCount} · {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{
            fontSize: '10px', fontWeight: 700, color: modeColor,
            padding: '4px 10px', border: `1px solid ${modeColor}`, borderRadius: '3px',
            textTransform: 'uppercase',
          }}>
            {status.mode}
          </span>
          <span style={{
            fontSize: '10px', color: status.isRunning ? 'var(--green, #10b981)' : 'var(--text-muted)',
          }}>
            ● {status.isRunning ? 'RUNNING' : 'STOPPED'}
          </span>
          {status.pausedUntilTs > Date.now() && (
            <span style={{ fontSize: '10px', color: 'var(--yellow, #eab308)' }}>
              ⏸ paused until {new Date(status.pausedUntilTs).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* ═══ Z-SCORE GAUGE ═══ */}
      <div className="glass-card" style={{ padding: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
          <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', margin: 0 }}>
            CURRENT Z-SCORE
          </h4>
          <span style={{
            fontSize: '20px', fontWeight: 700,
            color: zEntry ? 'var(--green, #10b981)' : zExit ? 'var(--blue, #3b82f6)' : 'var(--text-primary)',
          }}>
            {currentZ.toFixed(2)} σ
          </span>
        </div>
        <ZScoreGauge z={currentZ} />
        <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '20px' }}>
          Entry zones (green): |z| ≥ 1.5. Exit zone (blue): |z| &lt; 0.3. Stop zones (red): |z| ≥ 4.
        </p>
      </div>

      {/* ═══ COINTEGRATION METRICS ═══ */}
      {status.cointegration && (
        <div className="glass-card" style={{ padding: '14px' }}>
          <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>
            COINTEGRATION STATE
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px' }}>
            <Metric label="β (hedge ratio)" value={status.cointegration.beta.toFixed(3)} />
            <Metric label="α (intercept)" value={status.cointegration.alpha.toFixed(3)} />
            <Metric label="R²" value={status.cointegration.rSquared.toFixed(3)} />
            <Metric
              label="ADF t-stat"
              value={status.cointegration.adfTStat.toFixed(2)}
              color={adfHealthy ? 'var(--green, #10b981)' : 'var(--yellow, #eab308)'}
              hint={adfHealthy ? '✓ stationary' : '⚠ weakening'}
            />
            <Metric
              label="Halflife (bars)"
              value={isFinite(status.cointegration.halflife) ? status.cointegration.halflife.toFixed(1) : '∞'}
            />
            <Metric label="Spread σ" value={status.cointegration.spreadStd.toFixed(4)} />
          </div>
        </div>
      )}

      {/* ═══ OPEN TRADE ═══ */}
      {openTrade ? (
        <div className="glass-card" style={{ padding: '14px', borderLeft: '3px solid var(--green, #10b981)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', margin: 0 }}>
              OPEN TRADE — {openTrade.side.toUpperCase().replace('_', ' ')}
            </h4>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Entered {new Date(openTrade.entry_time).toLocaleString()}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '10px' }}>
            <div>
              <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>{openTrade.sym_a}</p>
              <p style={{ fontSize: '13px', margin: '2px 0' }}>
                {openTrade.side === 'long_spread' ? 'LONG' : 'SHORT'} {openTrade.qty_a.toFixed(4)} @ ${openTrade.entry_price_a.toFixed(4)}
              </p>
            </div>
            <div>
              <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>{openTrade.sym_b}</p>
              <p style={{ fontSize: '13px', margin: '2px 0' }}>
                {openTrade.side === 'long_spread' ? 'SHORT' : 'LONG'} {openTrade.qty_b.toFixed(4)} @ ${openTrade.entry_price_b.toFixed(4)}
              </p>
            </div>
          </div>
          <div style={{ marginTop: '10px', display: 'flex', gap: '20px', fontSize: '10px', color: 'var(--text-muted)' }}>
            <span>Entry z: {openTrade.entry_z.toFixed(2)}</span>
            <span>β: {openTrade.beta.toFixed(3)}</span>
            <span>Notional: ${openTrade.total_notional_usd.toFixed(0)}</span>
            <span>Mode: {openTrade.mode}</span>
            {unrealizedPnl !== null && (
              <span style={{ color: unrealizedPnl >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)' }}>
                Unrealized: ${unrealizedPnl.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: '14px', opacity: 0.6 }}>
          <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', margin: 0 }}>
            NO OPEN TRADE
          </h4>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
            Engine waiting for |z| ≥ 1.5 entry signal.
          </p>
        </div>
      )}

      {/* ═══ PnL SUMMARY ═══ */}
      <div className="glass-card" style={{ padding: '14px' }}>
        <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>
          CUMULATIVE PNL (closed trades)
        </h4>
        <PnlSparkline values={cumulativePnl} />
        {pnl?.summary && pnl.summary.length > 0 && (
          <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
            {pnl.summary.map(s => (
              <div key={s.mode}>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>{s.mode.toUpperCase()}</p>
                <p style={{
                  fontSize: '16px', fontWeight: 700, margin: '2px 0',
                  color: s.total_pnl >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)',
                }}>
                  ${s.total_pnl.toFixed(2)}
                </p>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>
                  {s.trades} trades · {s.wins} wins ({((s.wins / Math.max(1, s.trades)) * 100).toFixed(0)}%)
                  · ${s.total_fees.toFixed(2)} fees
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ RECENT TRADES TABLE ═══ */}
      <div className="glass-card" style={{ padding: '14px' }}>
        <h4 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>
          RECENT TRADES ({closedTrades.length})
        </h4>
        {closedTrades.length === 0 ? (
          <p style={{ fontSize: '10px', color: 'var(--text-muted)' }}>No closed trades yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '10px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border, #333)' }}>
                  <th style={{ padding: '4px 8px' }}>Exit time</th>
                  <th style={{ padding: '4px 8px' }}>Side</th>
                  <th style={{ padding: '4px 8px' }}>Mode</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Entry z</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Exit z</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Hold</th>
                  <th style={{ padding: '4px 8px' }}>Reason</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>PnL net</th>
                </tr>
              </thead>
              <tbody>
                {closedTrades.slice(0, 20).map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
                    <td style={{ padding: '4px 8px' }}>{t.exit_time ? new Date(t.exit_time).toLocaleString() : '—'}</td>
                    <td style={{ padding: '4px 8px' }}>{t.side === 'long_spread' ? 'L' : 'S'}</td>
                    <td style={{ padding: '4px 8px' }}>{t.mode}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.entry_z.toFixed(2)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.exit_z?.toFixed(2) ?? '—'}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.hold_bars ?? 0}</td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{t.exit_reason ?? '—'}</td>
                    <td style={{
                      padding: '4px 8px', textAlign: 'right', fontWeight: 700,
                      color: (t.pnl_net ?? 0) >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)',
                    }}>
                      ${(t.pnl_net ?? 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Helpers ----

function Metric({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }): React.ReactElement {
  return (
    <div>
      <p style={{ fontSize: '9px', color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </p>
      <p style={{ fontSize: '15px', fontWeight: 700, margin: '2px 0 0 0', color: color ?? 'var(--text-primary)' }}>
        {value}
      </p>
      {hint && <p style={{ fontSize: '9px', color, margin: 0 }}>{hint}</p>}
    </div>
  );
}
