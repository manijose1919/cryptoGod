import React, { useState, useEffect } from 'react';

interface SessionStatus {
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
      unrealizedPnl: number;
    }>;
  };
  exchange: {
    id: string;
    wsConnected: boolean;
  };
  session: {
    totalTrades: number;
  };
}

interface SessionReconnectProps {
  onReconnect: () => void;
  onStopSession: () => void;
  onStartNew: () => void;
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

const SessionReconnect: React.FC<SessionReconnectProps> = ({ onReconnect, onStopSession, onStartNew }) => {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const res = await fetch('/api/session/full-status');
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error('Failed to check session:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      const res = await fetch('/api/session/stop', { method: 'POST' });
      const data = await res.json();
      console.log('Session stopped:', data);
      onStopSession();
    } catch (e) {
      console.error('Failed to stop session:', e);
    } finally {
      setStopping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400" />
        <span className="ml-3 text-gray-400">Checking for active session...</span>
      </div>
    );
  }

  if (!status?.sessionActive) {
    return null; // No active session, parent should show start screen
  }

  return (
    <div className="glass-card p-6 mx-auto max-w-2xl mt-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
        <h2 className="text-xl font-bold text-white">Active Session Detected</h2>
      </div>

      <div className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Mode</span>
          <span className={status.tradingMode === 'REAL' ? 'text-red-400 font-bold' : 'text-cyan-400 font-bold'}>
            {status.tradingMode}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Running for</span>
          <span className="text-white">{formatUptime(status.uptime)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Exchange</span>
          <span className="text-white">{status.exchange.id} {status.exchange.wsConnected ? '(WS connected)' : '(WS disconnected)'}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Trades</span>
          <span className="text-white">{status.session?.totalTrades || 0}</span>
        </div>

        <hr className="border-gray-700 my-2" />

        <div className="flex justify-between">
          <span className="text-gray-400">Portfolio Value</span>
          <span className="text-white font-bold">${status.portfolio.totalValue.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">P&L</span>
          <span className={status.portfolio.pnl >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
            {status.portfolio.pnl >= 0 ? '+' : ''}${status.portfolio.pnl.toFixed(2)}
            ({status.portfolio.pnlPercent >= 0 ? '+' : ''}{status.portfolio.pnlPercent.toFixed(2)}%)
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Open Positions</span>
          <span className="text-white">{status.portfolio.positions.length}</span>
        </div>
      </div>

      {status.portfolio.positions.length > 0 && (
        <div className="bg-gray-800/30 rounded-lg p-3 mb-4">
          <div className="text-xs text-gray-400 mb-2">Open Positions</div>
          {status.portfolio.positions.map(pos => (
            <div key={pos.ticker} className="flex justify-between text-sm py-1 border-b border-gray-700/50 last:border-0">
              <span className="text-white font-mono">{pos.ticker}</span>
              <span className={pos.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onReconnect}
          className="flex-1 px-4 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-lg transition-all"
        >
          View Dashboard
        </button>
        <button
          onClick={handleStop}
          disabled={stopping}
          className="px-4 py-3 bg-red-600/20 hover:bg-red-600/40 text-red-400 font-bold rounded-lg border border-red-600/30 transition-all disabled:opacity-50"
        >
          {stopping ? 'Stopping...' : 'Stop & Reset'}
        </button>
      </div>
    </div>
  );
};

export default SessionReconnect;
