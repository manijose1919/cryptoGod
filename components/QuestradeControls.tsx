
import React, { useState } from 'react';
import { Play, Square, RefreshCw, Key } from 'lucide-react';
import { QUESTRADE_EXCHANGES } from '../constants';

interface QuestradeControlsProps {
    isAuthenticated: boolean;
    isBotActive: boolean;
    isPaper: boolean;
    watchlist: string[];
    onAuthenticate: (refreshToken: string, isPractice: boolean) => void;
    onStartBot: (watchlist: string[], isPaper: boolean) => void;
    onStopBot: () => void;
    onResetPaper: (balance: number) => void;
    onExchangeChange: (exchange: string) => void;
    selectedExchange: string;
}

const QuestradeControls: React.FC<QuestradeControlsProps> = ({
    isAuthenticated,
    isBotActive,
    isPaper,
    watchlist,
    onAuthenticate,
    onStartBot,
    onStopBot,
    onResetPaper,
    onExchangeChange,
    selectedExchange,
}) => {
    const [refreshToken, setRefreshToken] = useState('');
    const [isPractice, setIsPractice] = useState(true);
    const [watchlistInput, setWatchlistInput] = useState(watchlist.join(', '));
    const [paperBalance, setPaperBalance] = useState(100000);

    const handleAuth = () => {
        if (refreshToken.trim()) {
            onAuthenticate(refreshToken.trim(), isPractice);
        }
    };

    const handleStartBot = () => {
        const tickers = watchlistInput.split(',').map(t => t.trim()).filter(Boolean);
        onStartBot(tickers, isPaper);
    };

    return (
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
            <h3 className="text-lg font-semibold text-white">Questrade Controls</h3>

            {/* Auth Section */}
            {!isAuthenticated && (
                <div className="space-y-2">
                    <label className="text-sm text-gray-400">Refresh Token</label>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={refreshToken}
                            onChange={(e) => setRefreshToken(e.target.value)}
                            placeholder="Enter Questrade refresh token..."
                            className="flex-1 bg-gray-700 text-white px-3 py-2 rounded text-sm"
                        />
                        <button
                            onClick={handleAuth}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm flex items-center gap-1"
                        >
                            <Key size={14} /> Auth
                        </button>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-400">
                        <input
                            type="checkbox"
                            checked={isPractice}
                            onChange={(e) => setIsPractice(e.target.checked)}
                            className="rounded"
                        />
                        Practice Mode
                    </label>
                </div>
            )}

            {isAuthenticated && (
                <div className="text-sm text-green-400">Connected to Questrade {isPractice ? '(Practice)' : '(Live)'}</div>
            )}

            {/* Exchange Selector */}
            <div className="space-y-1">
                <label className="text-sm text-gray-400">Exchange</label>
                <select
                    value={selectedExchange}
                    onChange={(e) => onExchangeChange(e.target.value)}
                    className="w-full bg-gray-700 text-white px-3 py-2 rounded text-sm"
                >
                    {Object.entries(QUESTRADE_EXCHANGES).map(([key, val]) => (
                        <option key={key} value={key}>{val.name}</option>
                    ))}
                </select>
            </div>

            {/* Watchlist */}
            <div className="space-y-1">
                <label className="text-sm text-gray-400">Watchlist (comma separated)</label>
                <input
                    value={watchlistInput}
                    onChange={(e) => setWatchlistInput(e.target.value)}
                    className="w-full bg-gray-700 text-white px-3 py-2 rounded text-sm"
                    placeholder="SHOP, TD, RY, ENB..."
                />
            </div>

            {/* Bot Controls */}
            <div className="flex gap-2">
                {!isBotActive ? (
                    <button
                        onClick={handleStartBot}
                        disabled={!isAuthenticated}
                        className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white px-4 py-2 rounded text-sm flex items-center justify-center gap-1"
                    >
                        <Play size={14} /> Start Bot
                    </button>
                ) : (
                    <button
                        onClick={onStopBot}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded text-sm flex items-center justify-center gap-1"
                    >
                        <Square size={14} /> Stop Bot
                    </button>
                )}
            </div>

            {/* Paper Trading Reset */}
            <div className="border-t border-gray-700 pt-3 space-y-2">
                <label className="text-sm text-gray-400">Paper Trading Balance</label>
                <div className="flex gap-2">
                    <input
                        type="number"
                        value={paperBalance}
                        onChange={(e) => setPaperBalance(Number(e.target.value))}
                        className="flex-1 bg-gray-700 text-white px-3 py-2 rounded text-sm"
                    />
                    <button
                        onClick={() => onResetPaper(paperBalance)}
                        className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded text-sm flex items-center gap-1"
                    >
                        <RefreshCw size={14} /> Reset
                    </button>
                </div>
            </div>
        </div>
    );
};

export { QuestradeControls };
