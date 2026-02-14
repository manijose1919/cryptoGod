
import React, { useState, useEffect } from 'react';
import type { Trade } from '../types';

interface SessionSummaryProps {
  trades: Trade[];
  initialBudget: number;
  totalValue?: number;
  sessionStartTime?: number;
  sessionDurationMinutes?: number;
}

const StatCard: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'text-white' }) => (
    <div className="bg-gray-900/50 p-3 rounded-lg text-center">
        <p className="text-xs text-gray-400 uppercase tracking-wider">{label}</p>
        <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
);

export const SessionSummary: React.FC<SessionSummaryProps> = ({ trades, initialBudget, totalValue: totalValueProp, sessionStartTime = 0, sessionDurationMinutes = 0 }) => {
    // Countdown timer
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

    useEffect(() => {
        if (sessionDurationMinutes <= 0 || sessionStartTime <= 0) {
            setTimeRemaining(null);
            return;
        }

        const sessionEndTime = sessionStartTime + (sessionDurationMinutes * 60 * 1000);

        const tick = () => {
            const remaining = sessionEndTime - Date.now();
            setTimeRemaining(remaining > 0 ? remaining : 0);
        };

        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [sessionStartTime, sessionDurationMinutes]);

    const formatCountdown = (ms: number) => {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    const getCountdownColor = (ms: number) => {
        const minutesLeft = ms / 60000;
        if (minutesLeft <= 5) return 'text-red-400';
        if (minutesLeft <= 10) return 'text-yellow-400';
        return 'text-green-400';
    };
    const stats = React.useMemo(() => {
        // Filter to only SELL trades which have PnL
        const sellTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);

        if (sellTrades.length === 0) {
            return {
                totalTrades: 0,
                winRate: 0,
                bestTrade: 0,
                worstTrade: 0,
                avgWin: 0,
                avgLoss: 0,
                profitFactor: 0
            };
        }

        const pnlList = sellTrades.map(t => t.pnl!);
        const winningTrades = pnlList.filter(p => p > 0);
        const losingTrades = pnlList.filter(p => p < 0);

        const totalTrades = pnlList.length;
        const winRate = (winningTrades.length / totalTrades) * 100;
        const bestTrade = Math.max(0, ...pnlList);
        const worstTrade = Math.min(0, ...pnlList);

        const totalWins = winningTrades.reduce((a, b) => a + b, 0);
        const totalLosses = Math.abs(losingTrades.reduce((a, b) => a + b, 0));

        const avgWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

        return {
            totalTrades,
            winRate,
            bestTrade,
            worstTrade,
            avgWin,
            avgLoss,
            profitFactor
        };
    }, [trades]);

    // If totalValue not provided, compute from trades PnL
    const totalValue = totalValueProp ?? (initialBudget + trades.filter(t => t.pnl !== undefined).reduce((sum, t) => sum + (t.pnl ?? 0), 0));
    const totalPnL = totalValue - initialBudget;
    const totalPnLPercent = initialBudget > 0 ? (totalPnL / initialBudget) * 100 : 0;
    const pnlColor = totalPnL >= 0 ? 'text-green-400' : 'text-red-400';

    const formatCurrency = (value: number) =>
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

    const formatProfitFactor = (pf: number) => {
        if (pf === Infinity) return 'N/A';
        if (pf === 0) return '0.00';
        return pf.toFixed(2);
    };

    return (
        <div className="glass-card p-6 animate-fade-up">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold gradient-header">Session Summary</h2>
                {timeRemaining !== null ? (
                    <div className={`text-right ${timeRemaining === 0 ? 'text-red-400 animate-pulse' : ''}`}>
                        <p className="text-xs text-gray-400 uppercase">Time Left</p>
                        <p className={`text-lg font-mono font-bold ${timeRemaining === 0 ? 'text-red-400' : getCountdownColor(timeRemaining)}`}>
                            {timeRemaining === 0 ? 'EXPIRED' : formatCountdown(timeRemaining)}
                        </p>
                        {timeRemaining > 0 && timeRemaining <= 5 * 60 * 1000 && (
                            <p className="text-xs text-red-400">Winding down</p>
                        )}
                    </div>
                ) : sessionDurationMinutes === 0 && sessionStartTime > 0 ? (
                    <div className="text-right">
                        <p className="text-xs text-gray-400 uppercase">Duration</p>
                        <p className="text-sm text-gray-300">Unlimited</p>
                    </div>
                ) : null}
            </div>

            {/* Main PnL Display */}
            <div className="mb-4 p-4 bg-gray-900/50 rounded-lg text-center">
                <p className="text-sm text-gray-400 uppercase">Total P&L</p>
                <p className={`text-3xl font-bold ${pnlColor}`}>
                    {formatCurrency(totalPnL)}
                </p>
                <p className={`text-lg ${pnlColor}`}>
                    {totalPnLPercent >= 0 ? '+' : ''}{totalPnLPercent.toFixed(2)}%
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-3">
                <StatCard
                    label="Win Rate"
                    value={`${stats.winRate.toFixed(1)}%`}
                    color={stats.winRate >= 50 ? 'text-green-400' : 'text-red-400'}
                />
                <StatCard label="Trades" value={`${stats.totalTrades}`} />
                <StatCard
                    label="Best Trade"
                    value={formatCurrency(stats.bestTrade)}
                    color="text-green-400"
                />
                <StatCard
                    label="Worst Trade"
                    value={formatCurrency(stats.worstTrade)}
                    color="text-red-400"
                />
                <StatCard
                    label="Avg Win"
                    value={formatCurrency(stats.avgWin)}
                    color="text-green-400"
                />
                <StatCard
                    label="Avg Loss"
                    value={formatCurrency(-stats.avgLoss)}
                    color="text-red-400"
                />
            </div>

            {/* Profit Factor */}
            {stats.totalTrades > 0 && (
                <div className="mt-3 text-center text-sm text-gray-400">
                    Profit Factor: <span className={stats.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'}>
                        {formatProfitFactor(stats.profitFactor)}
                    </span>
                </div>
            )}

            {/* Recent Trades */}
            {trades.length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-700">
                    <p className="text-sm text-gray-400 mb-2">Recent Trades</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                        {trades.slice(0, 5).map(trade => (
                            <div
                                key={trade.id}
                                className={`text-xs p-2 rounded flex justify-between ${
                                    trade.type === 'BUY'
                                        ? 'bg-green-900/30 text-green-300'
                                        : 'bg-red-900/30 text-red-300'
                                }`}
                            >
                                <span>
                                    {trade.type} {trade.ticker} @ ${Number(trade.price).toFixed(2)}
                                </span>
                                <span>
                                    {trade.pnl !== undefined && (
                                        <span className={trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                            {trade.pnl >= 0 ? '+' : ''}{formatCurrency(trade.pnl)}
                                        </span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
