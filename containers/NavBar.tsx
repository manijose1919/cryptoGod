
import { useState, useEffect } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';

interface NavBarProps {
    onOpenHistory: () => void;
}

function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

export function NavBar({ onOpenHistory }: NavBarProps) {
    const { isBotActive, portfolio, sessionStartTime, isTradingActive } = useTradingContext();
    const { ws } = useMarketDataContext();
    const [elapsed, setElapsed] = useState('');
    const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected'>('disconnected');

    // Session timer
    useEffect(() => {
        if (!isTradingActive || !sessionStartTime) {
            setElapsed('');
            return;
        }
        const interval = setInterval(() => {
            setElapsed(formatElapsed(Date.now() - sessionStartTime));
        }, 1000);
        return () => clearInterval(interval);
    }, [isTradingActive, sessionStartTime]);

    // WebSocket status
    useEffect(() => {
        const check = setInterval(() => {
            setWsStatus(ws.current?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected');
        }, 2000);
        return () => clearInterval(check);
    }, [ws]);

    return (
        <nav className="flex items-center justify-between px-4 py-2 border-b border-gray-700/50 bg-gray-900/80">
            <div className="flex items-center gap-3">
                {[
                    { href: '/', label: 'Crypto', active: true },
                    { href: '/stocks', label: 'Stocks' },
                    { href: '/performance', label: 'Performance' },
                    { href: '/backtest', label: 'Backtest' },
                    { href: '/replay', label: 'Replay' },
                    { href: '/training', label: 'Training' },
                ].map(link => (
                    <a key={link.href} href={link.href}
                        className={`text-xs px-2 py-1 rounded ${link.active ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}>
                        {link.label}
                    </a>
                ))}
                <button
                    onClick={onOpenHistory}
                    className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
                >
                    History
                </button>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-500">
                <span className="flex items-center gap-1" title={`WebSocket ${wsStatus}`}>
                    <span className={`w-2 h-2 rounded-full ${wsStatus === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
                    WS
                </span>
                {isBotActive && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />Bot Active</span>}
                <span>{Object.keys(portfolio.positions).length} positions</span>
                {elapsed && <span className="text-gray-400">{elapsed}</span>}
            </div>
        </nav>
    );
}
