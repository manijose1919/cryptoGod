
import React, { useState, useEffect, useCallback } from 'react';
import { Search, TrendingUp, TrendingDown, Clock, DollarSign, Activity, Brain, Newspaper } from 'lucide-react';
import { QuestradeControls } from './QuestradeControls';
import * as questradeApi from '../services/questradeMarketService';
import type { QuestradeSymbolResult, QuestradeCandle, PaperTradeSummary, PaperTrade, QuestradeStatus } from '../services/questradeMarketService';

const QuestradeDashboard: React.FC = () => {
    // State
    const [status, setStatus] = useState<QuestradeStatus | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<QuestradeSymbolResult[]>([]);
    const [selectedSymbol, setSelectedSymbol] = useState<string>('SHOP');
    const [candles, setCandles] = useState<QuestradeCandle[]>([]);
    const [paperSummary, setPaperSummary] = useState<PaperTradeSummary | null>(null);
    const [tradeHistory, setTradeHistory] = useState<PaperTrade[]>([]);
    const [brainThoughts, setBrainThoughts] = useState<any[]>([]);
    const [newsFeeds, setNewsFeeds] = useState<any[]>([]);
    const [selectedExchange, setSelectedExchange] = useState('TSX');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    // Fetch status periodically
    const fetchStatus = useCallback(async () => {
        try {
            const s = await questradeApi.getStatus();
            setStatus(s);
        } catch (e: any) {
            // Silent - status may not be available before auth
        }
    }, []);

    const fetchPaperData = useCallback(async () => {
        try {
            const [summary, history] = await Promise.all([
                questradeApi.getPaperSummary(),
                questradeApi.getPaperHistory(),
            ]);
            setPaperSummary(summary);
            setTradeHistory(history);
        } catch (e) {
            // Silent
        }
    }, []);

    const fetchCandles = useCallback(async (symbol: string) => {
        try {
            setIsLoading(true);
            const c = await questradeApi.getCandles(symbol, '5m');
            setCandles(c);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Poll for updates
    useEffect(() => {
        fetchStatus();
        const interval = setInterval(() => {
            fetchStatus();
            fetchPaperData();
        }, 5000);
        return () => clearInterval(interval);
    }, [fetchStatus, fetchPaperData]);

    // Fetch brain thoughts and feeds
    useEffect(() => {
        const fetchExtras = async () => {
            try {
                const [thoughts, feeds] = await Promise.all([
                    questradeApi.getBrainThoughts(),
                    questradeApi.getLiveFeeds(),
                ]);
                setBrainThoughts(thoughts);
                setNewsFeeds(feeds);
            } catch (e) { /* silent */ }
        };
        fetchExtras();
        const interval = setInterval(fetchExtras, 30000);
        return () => clearInterval(interval);
    }, []);

    // Search handler
    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        try {
            const results = await questradeApi.searchSymbols(searchQuery.trim());
            setSearchResults(results);
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleSelectSymbol = (symbol: string) => {
        setSelectedSymbol(symbol);
        setSearchResults([]);
        setSearchQuery('');
        fetchCandles(symbol);
    };

    const handleAuthenticate = async (refreshToken: string, isPractice: boolean) => {
        try {
            setError(null);
            await questradeApi.authenticate(refreshToken, isPractice);
            await fetchStatus();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleStartBot = async (watchlist: string[], isPaper: boolean) => {
        try {
            setError(null);
            await questradeApi.startBot({ watchlist, isPaper });
            await fetchStatus();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleStopBot = async () => {
        try {
            await questradeApi.stopBot();
            await fetchStatus();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleResetPaper = async (balance: number) => {
        try {
            await questradeApi.resetPaperTrading(balance);
            await fetchPaperData();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const isAuthenticated = status?.questrade?.isAuthenticated ?? false;
    const isBotActive = status?.bot?.isActive ?? false;
    const isPaper = status?.bot?.isPaper ?? true;

    // Market hours indicator
    const now = new Date();
    const etHour = (now.getUTCHours() - 5 + 24) % 24;
    const etMin = now.getUTCMinutes();
    const etTime = etHour * 60 + etMin;
    const marketOpen = etTime >= 570 && etTime < 960 && now.getUTCDay() > 0 && now.getUTCDay() < 6;
    const preMarket = etTime >= 420 && etTime < 570;
    const afterHours = etTime >= 960 && etTime < 1200;

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4">
            <div className="max-w-7xl mx-auto space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold">Questrade Stock Dashboard</h1>
                        <p className="text-gray-400 text-sm">Canadian & US Stock Trading</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm ${
                            marketOpen ? 'bg-green-900 text-green-300' :
                            preMarket ? 'bg-yellow-900 text-yellow-300' :
                            afterHours ? 'bg-blue-900 text-blue-300' :
                            'bg-red-900 text-red-300'
                        }`}>
                            <Clock size={14} />
                            {marketOpen ? 'Market Open' : preMarket ? 'Pre-Market' : afterHours ? 'After Hours' : 'Market Closed'}
                        </div>
                        <a href="/" className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm">
                            Crypto Dashboard
                        </a>
                    </div>
                </div>

                {error && (
                    <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-white">[x]</button>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                    {/* Left Column - Controls */}
                    <div className="space-y-4">
                        <QuestradeControls
                            isAuthenticated={isAuthenticated}
                            isBotActive={isBotActive}
                            isPaper={isPaper}
                            watchlist={status?.bot?.watchlist ?? ['SHOP', 'TD', 'RY']}
                            onAuthenticate={handleAuthenticate}
                            onStartBot={handleStartBot}
                            onStopBot={handleStopBot}
                            onResetPaper={handleResetPaper}
                            onExchangeChange={setSelectedExchange}
                            selectedExchange={selectedExchange}
                        />

                        {/* Symbol Search */}
                        <div className="bg-gray-800 rounded-lg p-4 space-y-2">
                            <h3 className="text-sm font-semibold text-gray-400 flex items-center gap-1">
                                <Search size={14} /> Symbol Search
                            </h3>
                            <div className="flex gap-2">
                                <input
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                    placeholder="Search SHOP, TD..."
                                    className="flex-1 bg-gray-700 text-white px-3 py-2 rounded text-sm"
                                />
                                <button onClick={handleSearch} className="bg-blue-600 text-white px-3 py-2 rounded text-sm">Go</button>
                            </div>
                            {searchResults.length > 0 && (
                                <div className="max-h-48 overflow-y-auto space-y-1">
                                    {searchResults.slice(0, 10).map((s) => (
                                        <button
                                            key={s.symbolId}
                                            onClick={() => handleSelectSymbol(s.symbol)}
                                            className="w-full text-left bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm"
                                        >
                                            <span className="font-semibold">{s.symbol}</span>
                                            <span className="text-gray-400 ml-2">{s.description}</span>
                                            <span className="text-gray-500 ml-1 text-xs">({s.listingExchange})</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Center - Chart & Signals */}
                    <div className="lg:col-span-2 space-y-4">
                        {/* Price Chart (Simple ASCII-style since we can't import IndicatorChart directly) */}
                        <div className="bg-gray-800 rounded-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="font-semibold">{selectedSymbol}</h3>
                                {candles.length > 0 && (
                                    <div className="text-right">
                                        <span className="text-2xl font-bold">
                                            ${candles[candles.length - 1]?.c?.toFixed(2) ?? '0.00'}
                                        </span>
                                        {candles.length > 1 && (() => {
                                            const change = candles[candles.length - 1].c - candles[candles.length - 2].c;
                                            const pct = (change / candles[candles.length - 2].c) * 100;
                                            return (
                                                <span className={`ml-2 text-sm ${change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {change >= 0 ? '+' : ''}{change.toFixed(2)} ({pct.toFixed(2)}%)
                                                </span>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>

                            {isLoading && <div className="text-gray-400 text-center py-8">Loading candles...</div>}
                            {!isLoading && candles.length === 0 && (
                                <div className="text-gray-500 text-center py-8">
                                    {isAuthenticated ? 'Select a symbol to view chart data' : 'Authenticate with Questrade to view data'}
                                </div>
                            )}
                            {!isLoading && candles.length > 0 && (
                                <div className="space-y-2">
                                    {/* Mini price bars */}
                                    <div className="flex items-end gap-px h-32">
                                        {candles.slice(-60).map((c, i) => {
                                            const min = Math.min(...candles.slice(-60).map(x => x.l));
                                            const max = Math.max(...candles.slice(-60).map(x => x.h));
                                            const range = max - min || 1;
                                            const height = ((c.c - min) / range) * 100;
                                            const isGreen = c.c >= c.o;
                                            return (
                                                <div
                                                    key={i}
                                                    className={`flex-1 rounded-t ${isGreen ? 'bg-green-500' : 'bg-red-500'}`}
                                                    style={{ height: `${Math.max(2, height)}%` }}
                                                    title={`O:${c.o.toFixed(2)} H:${c.h.toFixed(2)} L:${c.l.toFixed(2)} C:${c.c.toFixed(2)}`}
                                                />
                                            );
                                        })}
                                    </div>
                                    <div className="flex justify-between text-xs text-gray-500">
                                        <span>H: ${Math.max(...candles.slice(-60).map(c => c.h)).toFixed(2)}</span>
                                        <span>L: ${Math.min(...candles.slice(-60).map(c => c.l)).toFixed(2)}</span>
                                        <span>V: {(candles[candles.length - 1]?.v || 0).toLocaleString()}</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Strategy Signals */}
                        <div className="bg-gray-800 rounded-lg p-4">
                            <h3 className="font-semibold mb-2 flex items-center gap-1">
                                <Activity size={16} /> Strategy Signals
                            </h3>
                            <div className="text-gray-400 text-sm">
                                {isBotActive ? (
                                    <div className="space-y-1">
                                        <p className="text-green-400">Bot is running - signals are being processed automatically</p>
                                        <p>Watchlist: {status?.bot?.watchlist?.join(', ')}</p>
                                    </div>
                                ) : (
                                    <p>Start the bot to see live strategy signals across your watchlist</p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Right Column - Portfolio & AI */}
                    <div className="space-y-4">
                        {/* Paper Portfolio */}
                        <div className="bg-gray-800 rounded-lg p-4">
                            <h3 className="font-semibold mb-2 flex items-center gap-1">
                                <DollarSign size={16} /> Paper Portfolio
                            </h3>
                            {paperSummary ? (
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">Equity</span>
                                        <span className="font-semibold">${paperSummary.totalEquity.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">Cash</span>
                                        <span>${paperSummary.cash.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">P&L</span>
                                        <span className={paperSummary.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                            {paperSummary.pnl >= 0 ? '+' : ''}${paperSummary.pnl.toFixed(2)} ({paperSummary.pnlPercent.toFixed(2)}%)
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-400">Trades</span>
                                        <span>{paperSummary.tradeCount}</span>
                                    </div>

                                    {/* Positions */}
                                    {paperSummary.positions.length > 0 && (
                                        <div className="border-t border-gray-700 pt-2 mt-2">
                                            <h4 className="text-gray-400 text-xs mb-1">Open Positions</h4>
                                            {paperSummary.positions.map((pos, i) => (
                                                <div key={i} className="flex justify-between py-1">
                                                    <span>{pos.symbol} ({pos.openQuantity})</span>
                                                    <span className={pos.openPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                                        {pos.openPnl >= 0 ? '+' : ''}${pos.openPnl.toFixed(2)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <p className="text-gray-500 text-sm">No paper trading data yet</p>
                            )}
                        </div>

                        {/* AI Brain */}
                        <div className="bg-gray-800 rounded-lg p-4">
                            <h3 className="font-semibold mb-2 flex items-center gap-1">
                                <Brain size={16} /> AI Brain
                            </h3>
                            <div className="max-h-48 overflow-y-auto space-y-2">
                                {brainThoughts.length > 0 ? (
                                    brainThoughts.slice(0, 5).map((thought, i) => (
                                        <div key={i} className="text-sm border-l-2 border-purple-500 pl-2">
                                            <div className="text-purple-300 text-xs">{thought.asset} - {thought.type}</div>
                                            <div className="text-gray-300">{thought.decision || thought.reasoning || 'Analyzing...'}</div>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-gray-500 text-sm">No brain activity yet - start the bot</p>
                                )}
                            </div>
                        </div>

                        {/* News Feed */}
                        <div className="bg-gray-800 rounded-lg p-4">
                            <h3 className="font-semibold mb-2 flex items-center gap-1">
                                <Newspaper size={16} /> News Feed
                            </h3>
                            <div className="max-h-48 overflow-y-auto space-y-2">
                                {newsFeeds.length > 0 ? (
                                    newsFeeds.slice(0, 5).map((item, i) => (
                                        <a
                                            key={i}
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block text-sm hover:bg-gray-700 p-1 rounded"
                                        >
                                            <div className="text-blue-300 text-xs">{item.source}</div>
                                            <div className="text-gray-300">{item.title}</div>
                                        </a>
                                    ))
                                ) : (
                                    <p className="text-gray-500 text-sm">Loading feeds...</p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Trade History */}
                {tradeHistory.length > 0 && (
                    <div className="bg-gray-800 rounded-lg p-4">
                        <h3 className="font-semibold mb-2">Recent Paper Trades</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-gray-400 border-b border-gray-700">
                                        <th className="text-left py-1">Time</th>
                                        <th className="text-left py-1">Symbol</th>
                                        <th className="text-left py-1">Side</th>
                                        <th className="text-right py-1">Qty</th>
                                        <th className="text-right py-1">Price</th>
                                        <th className="text-right py-1">Fee</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {tradeHistory.slice(-20).reverse().map((trade, i) => (
                                        <tr key={i} className="border-b border-gray-700/50">
                                            <td className="py-1 text-gray-400">{new Date(trade.timestamp).toLocaleTimeString()}</td>
                                            <td className="py-1">{trade.ticker}</td>
                                            <td className={`py-1 ${trade.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{trade.side}</td>
                                            <td className="py-1 text-right">{trade.quantity}</td>
                                            <td className="py-1 text-right">${trade.price.toFixed(2)}</td>
                                            <td className="py-1 text-right text-gray-400">${trade.fee.toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export { QuestradeDashboard };
