
import React, { useState, useMemo } from 'react';
import type { Trade, TradingStrategy } from '../types';
import { exportTradesToCSV } from '../services/exportService';

interface TradeHistoryProps {
    trades: Trade[];
}

type SortField = 'time' | 'ticker' | 'pnl' | 'strategy';
type SortDirection = 'asc' | 'desc';
type FilterStrategy = TradingStrategy | 'ALL';

export const TradeHistory: React.FC<TradeHistoryProps> = ({ trades }) => {
    const [sortField, setSortField] = useState<SortField>('time');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
    const [filterStrategy, setFilterStrategy] = useState<FilterStrategy>('ALL');
    const [filterType, setFilterType] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
    const [tickerSearch, setTickerSearch] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    const formatCurrency = (value: number) =>
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

    const formatTime = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    const formatDuration = (ms: number) => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    };

    // Calculate statistics
    const stats = useMemo(() => {
        const sellTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);
        const buyTrades = trades.filter(t => t.type === 'BUY');

        if (sellTrades.length === 0) {
            return {
                totalTrades: buyTrades.length,
                closedTrades: 0,
                winRate: 0,
                totalPnL: 0,
                avgPnL: 0,
                largestWin: 0,
                largestLoss: 0,
                avgHoldTime: 0
            };
        }

        const pnlList = sellTrades.map(t => t.pnl!);
        const wins = pnlList.filter(p => p > 0);
        const losses = pnlList.filter(p => p < 0);

        // Calculate average hold time by matching buy/sell pairs
        const holdTimes: number[] = [];
        for (const sell of sellTrades) {
            const matchingBuy = buyTrades.find(b => b.ticker === sell.ticker && b.time < sell.time);
            if (matchingBuy) {
                holdTimes.push(sell.time - matchingBuy.time);
            }
        }

        return {
            totalTrades: trades.length,
            closedTrades: sellTrades.length,
            winRate: (wins.length / sellTrades.length) * 100,
            totalPnL: pnlList.reduce((a, b) => a + b, 0),
            avgPnL: pnlList.reduce((a, b) => a + b, 0) / sellTrades.length,
            largestWin: Math.max(0, ...pnlList),
            largestLoss: Math.min(0, ...pnlList),
            avgHoldTime: holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0
        };
    }, [trades]);

    // Filter and sort trades
    const filteredAndSortedTrades = useMemo(() => {
        let result = [...trades];

        // Apply filters
        if (filterStrategy !== 'ALL') {
            result = result.filter(t => t.strategy === filterStrategy);
        }
        if (filterType !== 'ALL') {
            result = result.filter(t => t.type === filterType);
        }
        if (tickerSearch.trim()) {
            const search = tickerSearch.toUpperCase();
            result = result.filter(t => t.ticker.includes(search));
        }
        if (dateFrom) {
            const fromTs = new Date(dateFrom).getTime();
            result = result.filter(t => t.time >= fromTs);
        }
        if (dateTo) {
            const toTs = new Date(dateTo).getTime() + 86400000; // Include full day
            result = result.filter(t => t.time < toTs);
        }

        // Apply sorting
        result.sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'time':
                    comparison = a.time - b.time;
                    break;
                case 'ticker':
                    comparison = a.ticker.localeCompare(b.ticker);
                    break;
                case 'pnl':
                    comparison = (a.pnl ?? 0) - (b.pnl ?? 0);
                    break;
                case 'strategy':
                    comparison = a.strategy.localeCompare(b.strategy);
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });

        return result;
    }, [trades, filterStrategy, filterType, tickerSearch, dateFrom, dateTo, sortField, sortDirection]);

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    };

    const SortIcon: React.FC<{ field: SortField }> = ({ field }) => {
        if (sortField !== field) return <span className="text-gray-600 ml-1">{'\u21C5'}</span>;
        return <span className="text-cyan-400 ml-1">{sortDirection === 'asc' ? '\u2191' : '\u2193'}</span>;
    };

    const strategies: FilterStrategy[] = ['ALL', 'TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE'];

    return (
        <div className="glass-card p-6 animate-fade-up">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold gradient-header">Trade History</h2>
                <button
                    onClick={() => exportTradesToCSV(trades)}
                    className="text-[10px] px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
                    title="Export trades to CSV"
                >
                    Export CSV
                </button>
            </div>

            {/* Statistics Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-gray-900/50 p-3 rounded-lg text-center">
                    <p className="text-xs text-gray-400 uppercase">Total Trades</p>
                    <p className="text-lg font-bold text-white">{stats.totalTrades}</p>
                </div>
                <div className="bg-gray-900/50 p-3 rounded-lg text-center">
                    <p className="text-xs text-gray-400 uppercase">Win Rate</p>
                    <p className={`text-lg font-bold ${stats.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {stats.winRate.toFixed(1)}%
                    </p>
                </div>
                <div className="bg-gray-900/50 p-3 rounded-lg text-center">
                    <p className="text-xs text-gray-400 uppercase">Total P&L</p>
                    <p className={`text-lg font-bold ${stats.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {formatCurrency(stats.totalPnL)}
                    </p>
                </div>
                <div className="bg-gray-900/50 p-3 rounded-lg text-center">
                    <p className="text-xs text-gray-400 uppercase">Avg Hold Time</p>
                    <p className="text-lg font-bold text-white">
                        {stats.avgHoldTime > 0 ? formatDuration(stats.avgHoldTime) : 'N/A'}
                    </p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3 mb-4">
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        placeholder="Search ticker..."
                        value={tickerSearch}
                        onChange={e => setTickerSearch(e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 w-28"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">From:</label>
                    <input
                        type="date"
                        value={dateFrom}
                        onChange={e => setDateFrom(e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500"
                    />
                    <label className="text-xs text-gray-400">To:</label>
                    <input
                        type="date"
                        value={dateTo}
                        onChange={e => setDateTo(e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500"
                    />
                    {(dateFrom || dateTo) && (
                        <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Strategy:</label>
                    <select
                        value={filterStrategy}
                        onChange={(e) => setFilterStrategy(e.target.value as FilterStrategy)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-cyan-500"
                    >
                        {strategies.map(s => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                    </select>
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Type:</label>
                    <select
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value as 'ALL' | 'BUY' | 'SELL')}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-cyan-500"
                    >
                        <option value="ALL">ALL</option>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                    </select>
                </div>
                <div className="ml-auto text-xs text-gray-400">
                    Showing {filteredAndSortedTrades.length} of {trades.length} trades
                </div>
            </div>

            {/* Trade Table */}
            {filteredAndSortedTrades.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                    No trades to display
                </div>
            ) : (
                <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-sm min-w-[700px]">
                        <thead>
                            <tr className="border-b border-gray-700">
                                <th
                                    className="text-left py-2 px-3 text-gray-400 cursor-pointer hover:text-white whitespace-nowrap"
                                    onClick={() => handleSort('time')}
                                >
                                    Time <SortIcon field="time" />
                                </th>
                                <th className="text-left py-2 px-3 text-gray-400 whitespace-nowrap">Type</th>
                                <th
                                    className="text-left py-2 px-3 text-gray-400 cursor-pointer hover:text-white whitespace-nowrap"
                                    onClick={() => handleSort('ticker')}
                                >
                                    Ticker <SortIcon field="ticker" />
                                </th>
                                <th className="text-right py-2 px-3 text-gray-400 whitespace-nowrap">Price</th>
                                <th className="text-right py-2 px-3 text-gray-400 whitespace-nowrap">Qty</th>
                                <th
                                    className="text-left py-2 px-3 text-gray-400 cursor-pointer hover:text-white whitespace-nowrap"
                                    onClick={() => handleSort('strategy')}
                                >
                                    Strategy <SortIcon field="strategy" />
                                </th>
                                <th
                                    className="text-right py-2 px-3 text-gray-400 cursor-pointer hover:text-white whitespace-nowrap"
                                    onClick={() => handleSort('pnl')}
                                >
                                    P&L <SortIcon field="pnl" />
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredAndSortedTrades.map(trade => (
                                <tr
                                    key={trade.id}
                                    className={`border-b border-gray-800 hover:bg-gray-700/30 ${
                                        trade.type === 'BUY' ? 'bg-green-900/10' : 'bg-red-900/10'
                                    }`}
                                >
                                    <td className="py-2 px-3 text-gray-300 whitespace-nowrap">
                                        {formatTime(trade.time)}
                                    </td>
                                    <td className="py-2 px-3 whitespace-nowrap">
                                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                            trade.type === 'BUY'
                                                ? 'bg-green-500/20 text-green-400'
                                                : 'bg-red-500/20 text-red-400'
                                        }`}>
                                            {trade.type}
                                        </span>
                                    </td>
                                    <td className="py-2 px-3 text-white font-medium whitespace-nowrap">
                                        {trade.ticker}
                                    </td>
                                    <td className="py-2 px-3 text-right text-gray-300 whitespace-nowrap font-mono">
                                        ${Number(trade.price).toFixed(2)}
                                    </td>
                                    <td className="py-2 px-3 text-right text-gray-300 whitespace-nowrap font-mono">
                                        {Number(trade.quantity).toFixed(4)}
                                    </td>
                                    <td className="py-2 px-3 whitespace-nowrap">
                                        <span className={`px-2 py-0.5 rounded text-xs ${
                                            trade.strategy === 'TREND' ? 'bg-blue-500/20 text-blue-400' :
                                            trade.strategy === 'BREAKOUT' ? 'bg-purple-500/20 text-purple-400' :
                                            trade.strategy === 'WHALE' ? 'bg-teal-500/20 text-teal-400' :
                                            trade.strategy === 'CONFLUENCE' ? 'bg-yellow-500/20 text-yellow-400' :
                                            trade.strategy === 'MOMENTUM' ? 'bg-orange-500/20 text-orange-400' :
                                            'bg-pink-500/20 text-pink-400'
                                        }`}>
                                            {trade.strategy}
                                        </span>
                                    </td>
                                    <td className="py-2 px-3 text-right whitespace-nowrap">
                                        {trade.pnl !== undefined ? (
                                            <span className={`font-semibold font-mono ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {trade.pnl >= 0 ? '+' : ''}{formatCurrency(trade.pnl)}
                                            </span>
                                        ) : (
                                            <span className="text-gray-500">-</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Trade Reason Tooltip (shown on hover via title) */}
            {filteredAndSortedTrades.length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-700">
                    <p className="text-xs text-gray-500">
                        Hover over trades for additional details. Most recent trade: {filteredAndSortedTrades[0]?.reason}
                    </p>
                </div>
            )}
        </div>
    );
};
