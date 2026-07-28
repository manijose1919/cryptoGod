/**
 * StakingPanel — Shows staking status, positions, and auto-stake toggle.
 */

import { useEffect, useState, useCallback } from 'react';

interface StakingStatus {
  enabled: boolean;
  positions?: { asset: string; amount: number; apy: number; stakedAt: string }[];
  totalEarned?: number;
  idleAssets?: { asset: string; balance: number }[];
}

export default function StakingPanel() {
  const [status, setStatus] = useState<StakingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/staking/status');
      const data = await res.json();
      setStatus(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const toggleStaking = async () => {
    if (!status) return;
    try {
      await fetch('/api/staking/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      fetchStatus();
    } catch { /* ignore */ }
  };

  if (loading) return <div className="glass-card-sm p-4 text-slate-400 text-sm">Loading staking...</div>;

  return (
    <div className="glass-card p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-bold text-slate-200">Staking</h3>
        <button
          onClick={toggleStaking}
          className={`text-xs px-3 py-1 rounded ${
            status?.enabled ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-slate-600/20 text-slate-400 border border-slate-500/30'
          }`}
        >
          {status?.enabled ? 'Auto-Stake ON' : 'Auto-Stake OFF'}
        </button>
      </div>

      {/* Staked positions */}
      {status?.positions && status.positions.length > 0 ? (
        <div className="space-y-2 mb-3">
          {status.positions.map((pos, i) => (
            <div key={i} className="flex justify-between text-xs text-slate-300">
              <span>{pos.asset}: {pos.amount.toFixed(4)}</span>
              <span className="text-green-400">{pos.apy.toFixed(1)}% APY</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mb-3">No active staking positions</p>
      )}

      {/* Total earned */}
      {status?.totalEarned != null && status.totalEarned > 0 && (
        <div className="text-xs text-green-400">
          Total Earned: ${status.totalEarned.toFixed(4)}
        </div>
      )}
    </div>
  );
}
