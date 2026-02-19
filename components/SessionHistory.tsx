import React, { useState, useEffect } from 'react';

interface SessionRecord {
  id: number;
  session_id: string;
  start_time: number;
  end_time: number | null;
  initial_budget: number;
  final_value: number | null;
  total_trades: number;
  win_rate: number | null;
  pnl: number | null;
  status: string;
  trading_mode: string;
  notes: string | null;
  trade_count: number;
  last_activity: number | null;
  last_value: number | null;
  last_cash: number | null;
}

interface SessionDetail {
  session: SessionRecord;
  equityCurve: Array<{ time: number; total_value: number; cash: number; holdings_value: number; pnl_percent: number }>;
  trades: Array<{ time: number; type: string; ticker: string; price: number; quantity: number; pnl: number; strategy: string }>;
  stats: { total_trades: number; wins: number; losses: number; total_pnl: number; best_trade: number; worst_trade: number; total_fees: number } | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRestore: (sessionId: string) => Promise<void>;
  isSessionActive: boolean;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startMs: number, endMs: number | null): string {
  const end = endMs || Date.now();
  const diff = end - startMs;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const classes: Record<string, string> = {
    COMPLETED: 'badge-session-completed',
    ABANDONED: 'badge-session-abandoned',
    ACTIVE: 'badge-session-active',
  };
  return <span className={`badge ${classes[status] || 'badge-blue'}`}>{status}</span>;
};

const MiniEquityChart: React.FC<{ curve: SessionDetail['equityCurve'] }> = ({ curve }) => {
  if (curve.length < 2) return <div className="text-xs text-gray-500 italic">No equity data</div>;
  const values = curve.map(p => p.total_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 280;
  const h = 50;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ');
  const isPositive = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} className="mt-1">
      <polyline fill="none" stroke={isPositive ? '#22c55e' : '#ef4444'} strokeWidth="1.5" points={points} />
    </svg>
  );
};

const SessionHistory: React.FC<Props> = ({ isOpen, onClose, onRestore, isSessionActive }) => {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) fetchSessions();
  }, [isOpen]);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sessions/history?limit=50');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchDetail = async (sessionId: string) => {
    if (expandedId === sessionId) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(sessionId);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/details`);
      const data = await res.json();
      setDetail(data);
    } catch (e) {
      console.error('Failed to fetch session detail:', e);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRestore = async (sessionId: string) => {
    setRestoring(sessionId);
    try {
      await onRestore(sessionId);
      onClose();
    } catch (e) {
      console.error('Restore failed:', e);
    } finally {
      setRestoring(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative glass-card w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
          <h2 className="text-lg font-bold gradient-header">Session History</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-400" />
              <span className="ml-3 text-gray-400 text-sm">Loading sessions...</span>
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p className="text-lg">No sessions recorded yet</p>
              <p className="text-sm mt-1">Start a trading session to see history here</p>
            </div>
          ) : (
            sessions.map(s => {
              const pnl = s.pnl ?? (s.last_value ? s.last_value - (s.initial_budget || 0) : null);
              const isExpanded = expandedId === s.session_id;
              return (
                <div key={s.session_id} className="glass-card-sm">
                  {/* Session Row */}
                  <div
                    className="flex items-center gap-3 p-3 cursor-pointer"
                    onClick={() => fetchDetail(s.session_id)}
                  >
                    <StatusBadge status={s.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">{formatDate(s.start_time)}</span>
                        <span className="text-[10px] text-gray-600">{formatDuration(s.start_time, s.end_time)}</span>
                        <span className="text-[10px] text-gray-600 uppercase">{s.trading_mode}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-gray-300">${(s.initial_budget || 0).toFixed(0)} budget</span>
                        <span className="text-xs text-gray-500">{s.trade_count || s.total_trades || 0} trades</span>
                      </div>
                    </div>
                    <div className="text-right">
                      {pnl !== null ? (
                        <span className={`text-sm font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">--</span>
                      )}
                    </div>
                    <svg className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div className="border-t border-gray-700/30 p-3 space-y-3">
                      {detailLoading ? (
                        <div className="flex items-center gap-2 py-4 justify-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-400" />
                          <span className="text-xs text-gray-400">Loading details...</span>
                        </div>
                      ) : detail ? (
                        <>
                          {/* Equity Chart */}
                          <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Equity Curve</div>
                            <MiniEquityChart curve={detail.equityCurve} />
                          </div>

                          {/* Stats Grid */}
                          {detail.stats && (
                            <div className="grid grid-cols-4 gap-2">
                              {[
                                { label: 'Trades', value: detail.stats.total_trades },
                                { label: 'Wins', value: detail.stats.wins, color: 'text-green-400' },
                                { label: 'Losses', value: detail.stats.losses, color: 'text-red-400' },
                                { label: 'Fees', value: `$${(detail.stats.total_fees || 0).toFixed(2)}`, color: 'text-yellow-400' },
                              ].map(({ label, value, color }) => (
                                <div key={label} className="text-center">
                                  <div className="text-[10px] text-gray-500">{label}</div>
                                  <div className={`text-xs font-bold ${color || 'text-white'}`}>{value}</div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Recent Trades */}
                          {detail.trades.length > 0 && (
                            <div>
                              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Recent Trades</div>
                              <div className="max-h-32 overflow-y-auto custom-scrollbar space-y-1">
                                {detail.trades.slice(0, 10).map((t, i) => (
                                  <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
                                    <span className={t.type === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.type}</span>
                                    <span className="text-gray-300 font-mono">{t.ticker}</span>
                                    <span className="text-gray-400">${t.price.toFixed(2)}</span>
                                    {t.type === 'SELL' && (
                                      <span className={t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                        {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                                      </span>
                                    )}
                                    {t.type === 'BUY' && <span className="text-gray-600">--</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Restore button for abandoned sessions */}
                          {s.status === 'ABANDONED' && (
                            <button
                              onClick={() => handleRestore(s.session_id)}
                              disabled={isSessionActive || restoring === s.session_id}
                              className="w-full btn-primary text-xs py-2 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {restoring === s.session_id ? 'Restoring...' : isSessionActive ? 'Stop active session first' : `Restore with $${(detail.equityCurve.at(-1)?.cash || s.initial_budget || 10000).toFixed(0)}`}
                            </button>
                          )}
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default SessionHistory;
