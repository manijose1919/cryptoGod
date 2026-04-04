/**
 * V2AttributionTab — Phoenix V2 signal attribution + trade performance dashboard (F7 tab).
 * Shows signal scorecard, trade history, regime performance, and live engine status.
 */
import React, { useState, useEffect, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────

interface V2Status {
  mode: string;
  isRunning: boolean;
  lastLoopTime: number;
  loopCount: number;
  rejectedByScan: number;
  rejectedBySignal: number;
  rejectedByRisk: number;
  htfRegimes: Record<string, string>;
  openPositions: number;
  totalTrades: number;
  portfolioCash: number;
  totalPnlNet: number;
  lastScanReasons: Array<{ ticker: string; reason: string }>;
  candleCounts: Record<string, number>;
}

interface V2Trade {
  id: string;
  ticker: string;
  side: string;
  status: string;
  entryPrice: number;
  entryTime: number;
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  pnlGross?: number;
  pnlNet?: number;
  feesPaid?: number;
  holdDurationMs?: number;
  entryRegime?: string;
  entryConfidence?: number;
  entrySignals?: Record<string, number | boolean | string>;
  quantity?: number;
  positionSizeUsd?: number;
}

interface SignalScore {
  signalName: string;
  totalTrades: number;
  winningTrades?: number;
  winRate: number;
  avgPnlWhenActive: number;
  avgPnlWhenInactive: number;
  edge: number;
  verdict: 'proven' | 'inconclusive' | 'negative';
}

interface BearishStatus {
  isRunning: boolean;
  shorts: { open: number; totalPnl: number; totalEvals: number; totalOpened: number; totalClosed: number };
  dca: { totalBuys: number; positions: Array<{ ticker: string; qty: number; avgPrice: number; invested: number }> };
  arb: { opportunities: number };
  staking: { positions: number };
}

// ─── Helpers ─────────────────────────────────────────

const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';
const fmtTime = (ms: number) => {
  if (ms < 3600000) return (ms / 60000).toFixed(0) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
};
const fmtDate = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const verdictColor = (v: string) => v === 'proven' ? 'var(--green)' : v === 'negative' ? 'var(--red)' : 'var(--text-muted)';
const pnlColor = (n: number) => n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text-muted)';
const regimeColor = (r: string) => {
  if (r === 'STRONG_UP') return '#22c55e';
  if (r === 'UP' || r === 'PULLBACK_UP') return '#4ade80';
  if (r === 'SIDEWAYS') return '#fbbf24';
  if (r === 'DOWN') return '#f87171';
  if (r === 'STRONG_DOWN') return '#ef4444';
  return 'var(--text-muted)';
};

const exitReasonLabel: Record<string, string> = {
  take_profit: 'TP',
  stop_loss: 'SL',
  trailing: 'TRAIL',
  time_kill: 'TIME',
  manual: 'MANUAL',
};

// ─── Sub-components ─────────────────────────────────

function Card({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <div style={{
      background: 'var(--bg-card, #1e293b)', border: '1px solid var(--border-primary)',
      borderRadius: '8px', padding: '12px 16px', borderTop: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '1px', marginBottom: '8px' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ marginBottom: '4px' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: '6px' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 700, color: color || 'var(--text-header)', fontFamily: 'var(--font-mono)' }}>
        {value}
      </span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────

export default function V2AttributionTab() {
  const [status, setStatus] = useState<V2Status | null>(null);
  const [trades, setTrades] = useState<{ open: V2Trade[]; closed: V2Trade[] }>({ open: [], closed: [] });
  const [scorecard, setScorecard] = useState<SignalScore[]>([]);
  const [bearish, setBearish] = useState<BearishStatus | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<V2Trade | null>(null);

  const load = useCallback(() => {
    fetch('/api/v2/status').then(r => r.ok ? r.json() : null).then(d => d && setStatus(d)).catch(() => {});
    fetch('/api/v2/trades?limit=100').then(r => r.ok ? r.json() : null).then(d => d && setTrades(d)).catch(() => {});
    fetch('/api/v2/scorecard').then(r => r.ok ? r.json() : null).then(d => Array.isArray(d) && setScorecard(d)).catch(() => {});
    fetch('/api/v2/bearish/status').then(r => r.ok ? r.json() : null).then(d => d && setBearish(d)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  // ─── Computed stats ────────────────────────────

  const closed = trades.closed || [];
  const wins = closed.filter(t => (t.pnlNet ?? 0) > 0);
  const losses = closed.filter(t => (t.pnlNet ?? 0) <= 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnlNet ?? 0), 0);
  const totalFees = closed.reduce((s, t) => s + (t.feesPaid ?? 0), 0);
  const avgHold = closed.length ? closed.reduce((s, t) => s + (t.holdDurationMs ?? 0), 0) / closed.length : 0;
  const winRate = closed.length ? wins.length / closed.length : 0;

  // Per-ticker breakdown
  const tickerStats = closed.reduce<Record<string, { count: number; wins: number; pnl: number }>>((acc, t) => {
    if (!acc[t.ticker]) acc[t.ticker] = { count: 0, wins: 0, pnl: 0 };
    acc[t.ticker].count++;
    acc[t.ticker].pnl += t.pnlNet ?? 0;
    if ((t.pnlNet ?? 0) > 0) acc[t.ticker].wins++;
    return acc;
  }, {});

  // Per-exit-reason breakdown
  const exitStats = closed.reduce<Record<string, { count: number; pnl: number }>>((acc, t) => {
    const reason = t.exitReason ?? 'unknown';
    if (!acc[reason]) acc[reason] = { count: 0, pnl: 0 };
    acc[reason].count++;
    acc[reason].pnl += t.pnlNet ?? 0;
    return acc;
  }, {});

  // Per-regime breakdown
  const regimeStats = closed.reduce<Record<string, { count: number; wins: number; pnl: number }>>((acc, t) => {
    const r = t.entryRegime ?? 'UNKNOWN';
    if (!acc[r]) acc[r] = { count: 0, wins: 0, pnl: 0 };
    acc[r].count++;
    acc[r].pnl += t.pnlNet ?? 0;
    if ((t.pnlNet ?? 0) > 0) acc[r].wins++;
    return acc;
  }, {});

  // Sorted scorecard: proven first, then by edge descending
  const sortedScorecard = [...scorecard].sort((a, b) => {
    const order = { proven: 0, inconclusive: 1, negative: 2 };
    const diff = (order[a.verdict] ?? 1) - (order[b.verdict] ?? 1);
    return diff !== 0 ? diff : b.edge - a.edge;
  });

  return (
    <div style={{ padding: '16px', maxWidth: '1600px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-header)', letterSpacing: '1px', margin: 0 }}>
          PHOENIX V2 ATTRIBUTION
        </h2>
        {status && (
          <span style={{
            fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
            background: status.isRunning ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
            color: status.isRunning ? 'var(--green)' : 'var(--red)',
          }}>
            {status.mode.toUpperCase()} {status.isRunning ? '● RUNNING' : '○ STOPPED'}
          </span>
        )}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          Loop #{status?.loopCount ?? '—'} · {status?.lastLoopTime ?? '—'}ms
        </span>
        <button
          onClick={() => { fetch('/api/v2/recompute-scores', { method: 'POST' }).then(() => load()); }}
          style={{
            marginLeft: 'auto', fontSize: '10px', padding: '4px 10px', borderRadius: '4px',
            background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >
          RECOMPUTE SCORES
        </button>
      </div>

      {/* ═══ ROW 1: Key Metrics ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <Card title="PERFORMANCE" accent={totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}>
          <Metric label="Net P&L" value={'$' + fmt(totalPnl)} color={pnlColor(totalPnl)} />
          <Metric label="Win Rate" value={fmtPct(winRate)} color={winRate >= 0.5 ? 'var(--green)' : 'var(--red)'} />
          <Metric label="Trades" value={`${closed.length} (${wins.length}W / ${losses.length}L)`} />
        </Card>

        <Card title="COSTS & EFFICIENCY">
          <Metric label="Total Fees" value={'$' + fmt(totalFees)} color="var(--red)" />
          <Metric label="Avg Hold" value={fmtTime(avgHold)} />
          <Metric label="Cash" value={'$' + fmt(status?.portfolioCash ?? 0)} />
        </Card>

        <Card title="PIPELINE FUNNEL">
          <Metric label="Scanned" value={(status?.rejectedByScan ?? 0) + (status?.rejectedBySignal ?? 0) + (status?.rejectedByRisk ?? 0) + (status?.totalTrades ?? 0)} />
          <Metric label="→ Signal" value={(status?.rejectedBySignal ?? 0) + (status?.rejectedByRisk ?? 0) + (status?.totalTrades ?? 0)} />
          <Metric label="→ Risk" value={(status?.rejectedByRisk ?? 0) + (status?.totalTrades ?? 0)} />
          <Metric label="→ Traded" value={status?.totalTrades ?? 0} />
        </Card>

        <Card title="EXIT BREAKDOWN">
          {Object.entries(exitStats).sort((a, b) => b[1].count - a[1].count).map(([reason, d]) => (
            <Metric key={reason} label={exitReasonLabel[reason] || reason}
              value={`${d.count} (${d.count > 0 ? '$' + fmt(d.pnl) : '—'})`}
              color={pnlColor(d.pnl)} />
          ))}
        </Card>

        {bearish && (
          <Card title="BEARISH SERVICES" accent="#f59e0b">
            <Metric label="Shorts Open" value={bearish.shorts?.open ?? 0} />
            <Metric label="Short Evals" value={bearish.shorts?.totalEvals ?? 0} />
            <Metric label="DCA Buys" value={bearish.dca?.totalBuys ?? 0} />
            <Metric label="Short P&L" value={'$' + fmt(bearish.shorts?.totalPnl ?? 0)} color={pnlColor(bearish.shorts?.totalPnl ?? 0)} />
          </Card>
        )}
      </div>

      {/* ═══ ROW 2: Signal Scorecard + Regime Performance ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
        {/* Signal Scorecard */}
        <Card title="SIGNAL SCORECARD">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-mono)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Signal</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Win%</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Edge</th>
                  <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600 }}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {sortedScorecard.map(s => (
                  <tr key={s.signalName} style={{ borderBottom: '1px solid var(--border-secondary, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '4px 8px', color: 'var(--text-header)' }}>{s.signalName}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: s.winRate >= 0.5 ? 'var(--green)' : 'var(--text-muted)' }}>
                      {(s.winRate * 100).toFixed(0)}%
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: pnlColor(s.edge) }}>
                      {s.edge >= 0 ? '+' : ''}{(s.edge * 100).toFixed(2)}%
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                      <span style={{
                        fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '3px',
                        background: s.verdict === 'proven' ? 'rgba(34,197,94,0.15)' : s.verdict === 'negative' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.05)',
                        color: verdictColor(s.verdict),
                      }}>
                        {s.verdict.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {scorecard.length > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>
              {scorecard.filter(s => s.verdict === 'proven').length} proven · {scorecard.filter(s => s.verdict === 'inconclusive').length} inconclusive · {scorecard.filter(s => s.verdict === 'negative').length} negative
            </div>
          )}
        </Card>

        {/* Regime + Ticker Performance */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Card title="REGIME PERFORMANCE">
            <table style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-mono)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Regime</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Trades</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Win%</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>P&L</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(regimeStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([regime, d]) => (
                  <tr key={regime} style={{ borderBottom: '1px solid var(--border-secondary, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '4px 8px', color: regimeColor(regime), fontWeight: 700 }}>{regime}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{d.count}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: d.count > 0 && d.wins / d.count >= 0.5 ? 'var(--green)' : 'var(--text-muted)' }}>
                      {d.count > 0 ? ((d.wins / d.count) * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: pnlColor(d.pnl) }}>
                      ${fmt(d.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="TICKER PERFORMANCE">
            <table style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-mono)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Ticker</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Trades</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Win%</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>P&L</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(tickerStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([ticker, d]) => (
                  <tr key={ticker} style={{ borderBottom: '1px solid var(--border-secondary, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '4px 8px', color: 'var(--text-header)' }}>{ticker.replace('USD', '')}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{d.count}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: d.count > 0 && d.wins / d.count >= 0.5 ? 'var(--green)' : 'var(--text-muted)' }}>
                      {d.count > 0 ? ((d.wins / d.count) * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: pnlColor(d.pnl) }}>
                      ${fmt(d.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      {/* ═══ ROW 3: Live Regime Map ═══ */}
      {status?.htfRegimes && (
        <Card title="LIVE REGIME MAP">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {Object.entries(status.htfRegimes).sort().map(([ticker, regime]) => (
              <div key={ticker} style={{
                padding: '4px 10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--font-mono)',
                background: 'var(--bg-primary)', border: `1px solid ${regimeColor(regime)}40`,
              }}>
                <span style={{ color: 'var(--text-header)', fontWeight: 700 }}>{ticker.replace('USD', '')}</span>
                {' '}
                <span style={{ color: regimeColor(regime), fontWeight: 600 }}>{regime}</span>
              </div>
            ))}
          </div>
          {status.lastScanReasons && (
            <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)' }}>
              {status.lastScanReasons.filter(r => r.reason.startsWith('PASS')).length} of {status.lastScanReasons.length} tickers passing scan
            </div>
          )}
        </Card>
      )}

      {/* ═══ ROW 4: Trade History ═══ */}
      <div style={{ marginTop: '16px' }}>
        <Card title={`TRADE HISTORY (${closed.length} closed, ${(trades.open || []).length} open)`}>
          <div style={{ overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-mono)', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card, #1e293b)' }}>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Ticker</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Side</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Entry</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Exit</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Reason</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>P&L</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Fees</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Hold</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Regime</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Conf</th>
                </tr>
              </thead>
              <tbody>
                {/* Open trades first */}
                {(trades.open || []).map(t => (
                  <tr key={t.id} style={{
                    borderBottom: '1px solid var(--border-secondary, rgba(255,255,255,0.05))',
                    background: 'rgba(59,130,246,0.08)', cursor: 'pointer',
                  }} onClick={() => setSelectedTrade(t)}>
                    <td style={{ padding: '4px 8px' }}>{fmtDate(t.entryTime)}</td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-header)', fontWeight: 700 }}>{t.ticker.replace('USD', '')}</td>
                    <td style={{ padding: '4px 8px', color: t.side === 'long' ? 'var(--green)' : 'var(--red)' }}>{t.side.toUpperCase()}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmt(t.entryPrice, 4)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>OPEN</td>
                    <td style={{ padding: '4px 8px' }}>—</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>—</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>—</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmtTime(Date.now() - t.entryTime)}</td>
                    <td style={{ padding: '4px 8px', color: regimeColor(t.entryRegime ?? '') }}>{t.entryRegime ?? '—'}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{((t.entryConfidence ?? 0) * 100).toFixed(0)}%</td>
                  </tr>
                ))}
                {/* Closed trades newest first */}
                {[...closed].reverse().map(t => (
                  <tr key={t.id} style={{
                    borderBottom: '1px solid var(--border-secondary, rgba(255,255,255,0.05))',
                    cursor: 'pointer',
                  }} onClick={() => setSelectedTrade(t)}>
                    <td style={{ padding: '4px 8px' }}>{fmtDate(t.entryTime)}</td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-header)', fontWeight: 700 }}>{t.ticker.replace('USD', '')}</td>
                    <td style={{ padding: '4px 8px', color: t.side === 'long' ? 'var(--green)' : 'var(--red)' }}>{t.side.toUpperCase()}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmt(t.entryPrice, 4)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{t.exitPrice ? fmt(t.exitPrice, 4) : '—'}</td>
                    <td style={{ padding: '4px 8px' }}>
                      <span style={{
                        fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px',
                        background: t.exitReason === 'take_profit' ? 'rgba(34,197,94,0.15)' : t.exitReason === 'stop_loss' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.05)',
                        color: t.exitReason === 'take_profit' ? 'var(--green)' : t.exitReason === 'stop_loss' ? 'var(--red)' : 'var(--text-muted)',
                      }}>
                        {exitReasonLabel[t.exitReason ?? ''] || t.exitReason || '—'}
                      </span>
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: pnlColor(t.pnlNet ?? 0), fontWeight: 700 }}>
                      {(t.pnlNet ?? 0) >= 0 ? '+' : ''}${fmt(t.pnlNet ?? 0)}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--red)' }}>${fmt(t.feesPaid ?? 0)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmtTime(t.holdDurationMs ?? 0)}</td>
                    <td style={{ padding: '4px 8px', color: regimeColor(t.entryRegime ?? '') }}>{t.entryRegime ?? '—'}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{((t.entryConfidence ?? 0) * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ═══ TRADE DETAIL MODAL ═══ */}
      {selectedTrade && (
        <div
          role="dialog" aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setSelectedTrade(null)}
        >
          <div
            style={{
              background: 'var(--bg-card, #1e293b)', border: '1px solid var(--border-primary)',
              borderRadius: '12px', padding: '24px', minWidth: '500px', maxWidth: '700px', maxHeight: '80vh', overflowY: 'auto',
              boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-header)', margin: 0, letterSpacing: '0.5px' }}>
                {selectedTrade.ticker} {selectedTrade.side.toUpperCase()} — {selectedTrade.exitReason ? exitReasonLabel[selectedTrade.exitReason] || selectedTrade.exitReason : 'OPEN'}
              </h3>
              <span style={{ color: pnlColor(selectedTrade.pnlNet ?? 0), fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '16px' }}>
                {selectedTrade.pnlNet !== undefined ? ((selectedTrade.pnlNet >= 0 ? '+$' : '-$') + Math.abs(selectedTrade.pnlNet).toFixed(2)) : 'OPEN'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
              <div><span style={{ color: 'var(--text-muted)' }}>Entry:</span> ${fmt(selectedTrade.entryPrice, 5)} @ {fmtDate(selectedTrade.entryTime)}</div>
              {selectedTrade.exitPrice && <div><span style={{ color: 'var(--text-muted)' }}>Exit:</span> ${fmt(selectedTrade.exitPrice, 5)} @ {fmtDate(selectedTrade.exitTime ?? 0)}</div>}
              <div><span style={{ color: 'var(--text-muted)' }}>Regime:</span> <span style={{ color: regimeColor(selectedTrade.entryRegime ?? '') }}>{selectedTrade.entryRegime}</span></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Confidence:</span> {((selectedTrade.entryConfidence ?? 0) * 100).toFixed(1)}%</div>
              <div><span style={{ color: 'var(--text-muted)' }}>Size:</span> ${fmt(selectedTrade.positionSizeUsd ?? 0)} ({fmt(selectedTrade.quantity ?? 0, 4)} units)</div>
              <div><span style={{ color: 'var(--text-muted)' }}>Fees:</span> <span style={{ color: 'var(--red)' }}>${fmt(selectedTrade.feesPaid ?? 0)}</span></div>
              {selectedTrade.holdDurationMs && <div><span style={{ color: 'var(--text-muted)' }}>Hold:</span> {fmtTime(selectedTrade.holdDurationMs)}</div>}
            </div>

            {/* Entry signals */}
            {selectedTrade.entrySignals && (
              <>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '1px', marginBottom: '8px' }}>
                  ENTRY SIGNALS
                </div>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px',
                  fontSize: '10px', fontFamily: 'var(--font-mono)', background: 'var(--bg-primary)', borderRadius: '6px', padding: '8px',
                }}>
                  {Object.entries(selectedTrade.entrySignals)
                    .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
                    .map(([k, v]) => (
                      <div key={k}>
                        <span style={{ color: 'var(--text-muted)' }}>{k}:</span>{' '}
                        <span style={{ color: 'var(--text-header)' }}>
                          {typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? v.toFixed(4) : String(v)}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}

            <div style={{ textAlign: 'right', marginTop: '16px' }}>
              <button
                onClick={() => setSelectedTrade(null)}
                style={{
                  fontSize: '11px', padding: '6px 16px', borderRadius: '4px', cursor: 'pointer',
                  background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-header)',
                }}
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
