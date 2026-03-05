
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
        <nav className="flex items-center justify-between px-4 py-2" style={{ background: 'var(--bg-secondary)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border-primary)' }}>
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
                        className="text-xs px-3 py-1 rounded-lg transition-colors"
                        style={link.active
                            ? { background: 'rgba(99,102,241,0.1)', color: 'var(--text-header)', fontWeight: 600 }
                            : { color: 'var(--text-secondary)' }}>
                        {link.label}
                    </a>
                ))}
                <button
                    onClick={onOpenHistory}
                    className="text-xs px-3 py-1 rounded-lg transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    History
                </button>
            </div>
            <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span className="flex items-center gap-1" title={`WebSocket ${wsStatus}`}>
                    <span className={`w-2 h-2 rounded-full ${wsStatus === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
                    WS
                </span>
                {isBotActive && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />Bot Active</span>}
                <span>{Object.keys(portfolio.positions).length} positions</span>
                {elapsed && <span style={{ color: 'var(--text-muted)' }}>{elapsed}</span>}
            </div>
        </nav>
    );
}
