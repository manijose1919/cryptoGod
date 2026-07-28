import React, { useState, useEffect } from 'react';
import LastUpdated from './LastUpdated';
import AnimatedNumber from './AnimatedNumber';
import SkeletonPanel from './SkeletonPanel';

interface FullStatus {
  sessionActive: boolean;
  tradingMode: string;
  sessionStartTime: number | null;
  uptime: number;
  portfolio: {
    cash: number;
    initialBudget: number;
    holdingsValue: number;
    totalValue: number;
    pnl: number;
    pnlPercent: number;
    positions: Array<{
      ticker: string;
      quantity: number;
      openPrice: number;
      currentPrice: number;
      entryStrategy: string;
      unrealizedPnl: number;
      unrealizedPnlPercent: number;
    }>;
  };
  exchange: {
    id: string;
    fees: { perSide: number; roundTrip: number };
    wsConnected: boolean;
    tickerCount: number;
  };
  ml: {
    currentFocus: { ticker: string; confidence: number } | null;
    thoughtStats: { buys: number; sells: number; skips: number; avgConfidence: string } | null;
  };
  session: {
    totalTrades: number;
    totalPnl: string;
    uptime: string;
  };
  circuitBreaker: { paused?: boolean };
  beastMode: { winRate?: string; streak?: { consecutiveWins: number; consecutiveLosses: number } };
}

interface EquityCurvePoint {
  time: number;
  value: number;
}

interface Props {
  pollInterval?: number;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

const VPSMonitor: React.FC<Props> = ({ pollInterval = 3000 }) => {
  const [status, setStatus] = useState<FullStatus | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityCurvePoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const [statusRes, curveRes] = await Promise.all([
          fetch('/api/session/full-status'),
          fetch('/api/session/equity-curve'),
        ]);
        const statusData = await statusRes.json();
        const curveData = await curveRes.json();
        setStatus(statusData);
        setEquityCurve(curveData.curve || []);
        setError(null);
        setLastFetched(Date.now());
      } catch (e) {
        setError('Failed to connect to backend');
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval]);

  if (error) {
    return (
      <div className="glass-card p-4 border-red-800/30">
        <div className="flex items-center gap-2 text-red-400">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="font-bold">Backend Disconnected</span>
        </div>
        <p className="text-sm text-gray-400 mt-2">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="glass-card p-4">
        <div className="text-xs text-gray-500 mb-2">VPS Monitor</div>
        <SkeletonPanel rows={4} />
      </div>
    );
  }

  const portfolio = status.portfolio || { initialBudget: 0, pnl: 0, pnlPercent: 0, totalValue: 0, positions: [] };
  const exchange = status.exchange || { id: 'unknown', wsConnected: false };
  const uptime = status.uptime || 0;

  // uptime from session/full-status is in milliseconds (Date.now() - sessionStartTime)
  // Require at least 1 hour of uptime before extrapolating daily rate (avoids misleading spikes)
  const dailyRate = uptime > 3600000 && portfolio.initialBudget > 0
    ? (portfolio.pnl / portfolio.initialBudget * 100) / (uptime / 86400000)
    : 0;

  const estimatedDaysToDouble = dailyRate > 0
    ? Math.ceil(100 / dailyRate)
    : Infinity;

  // Mini equity chart using CSS
  const chartMin = equityCurve.length > 0 ? Math.min(...equityCurve.map(p => p.value)) : 0;
  const chartMax = equityCurve.length > 0 ? Math.max(...equityCurve.map(p => p.value)) : 1;
  const chartRange = chartMax - chartMin || 1;

  return (
    <div className="glass-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${status.sessionActive ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
          <h3 className="text-lg font-bold gradient-header">VPS Monitor</h3>
          <LastUpdated timestamp={lastFetched} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={status.tradingMode === 'REAL' ? 'text-red-400 font-bold' : 'text-cyan-400'}>
            {status.tradingMode}
          </span>
          <span className="text-gray-500">|</span>
          <span className="text-gray-400">{exchange.id}</span>
          <span className={`w-2 h-2 rounded-full ${exchange.wsConnected ? 'bg-green-400' : 'bg-red-400'}`} />
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="stat-card">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Session Uptime</div>
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{formatUptime(uptime)}</div>
        </div>
        <div className="stat-card">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Portfolio Value</div>
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>${(portfolio.totalValue || 0).toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Total P&L</div>
          <div className="text-sm font-bold">
            <AnimatedNumber value={portfolio.pnl || 0} showSign />
            <span className="text-xs ml-1">(<AnimatedNumber value={portfolio.pnlPercent || 0} format="percent" showSign />)</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Trades Today</div>
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{status.session?.totalTrades || 0}</div>
        </div>
      </div>

      {/* Equity Curve (Mini) */}
      {equityCurve.length > 1 && (
        <div className="glass-card-sm p-3">
          <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Equity Curve</div>
          <div className="flex items-end gap-px h-16">
            {equityCurve.slice(-60).map((point, i) => {
              const height = ((point.value - chartMin) / chartRange) * 100;
              const isPositive = point.value >= (portfolio.initialBudget || 0);
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-t-sm ${isPositive ? 'bg-green-500/70' : 'bg-red-500/70'}`}
                  style={{ height: `${Math.max(2, height)}%` }}
                  title={`$${point.value.toFixed(2)}`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Open Positions */}
      {portfolio.positions.length > 0 && (
        <div className="glass-card-sm p-3">
          <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Open Positions ({portfolio.positions.length})</div>
          <div className="space-y-1">
            {portfolio.positions.map((pos: any) => (
              <div key={pos.ticker} className="flex items-center justify-between text-xs py-1 last:border-0" style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold" style={{ color: 'var(--text-primary)' }}>{pos.ticker}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{pos.entryStrategy}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span style={{ color: 'var(--text-secondary)' }}>${(pos.currentPrice || 0).toFixed(2)}</span>
                  <span className={(pos.unrealizedPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {(pos.unrealizedPnl || 0) >= 0 ? '+' : ''}${(pos.unrealizedPnl || 0).toFixed(2)}
                    <span className="text-[10px] ml-1">({(pos.unrealizedPnlPercent || 0).toFixed(2)}%)</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bot Health */}
      <div className="grid grid-cols-3 gap-2">
        <div className="glass-card-sm p-2 text-center">
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Daily Rate</div>
          <div className="text-xs font-bold" style={{ color: dailyRate >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {dailyRate.toFixed(2)}%/day
          </div>
        </div>
        <div className="glass-card-sm p-2 text-center">
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Est. Double</div>
          <div className="text-xs font-bold" style={{ color: 'var(--cyan)' }}>
            {estimatedDaysToDouble === Infinity ? '--' : `${estimatedDaysToDouble}d`}
          </div>
        </div>
        <div className="glass-card-sm p-2 text-center">
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Circuit Breaker</div>
          <div className="text-xs font-bold" style={{ color: status.circuitBreaker?.paused ? 'var(--red)' : 'var(--green)' }}>
            {status.circuitBreaker?.paused ? 'PAUSED' : 'OK'}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VPSMonitor;
