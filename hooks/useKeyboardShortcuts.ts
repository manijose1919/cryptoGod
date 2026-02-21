
import { useEffect } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import type { TradingStrategy } from '../types';

const STRATEGY_KEYS: Record<string, TradingStrategy> = {
    '1': 'TREND',
    '2': 'BREAKOUT',
    '3': 'WHALE',
    '4': 'CONFLUENCE',
    '5': 'MOMENTUM',
    '6': 'DIVERGENCE',
    '7': 'ADAPTIVE',
};

export function useKeyboardShortcuts(toggleBot: (active: boolean) => void) {
    const {
        isBotActive, isScannerActive, setIsScannerActive,
        setIsAuthModalOpen, setIsSessionHistoryOpen, addLog,
    } = useTradingContext();
    const { setStrategy } = useSettingsContext();

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            // Escape: close modals
            if (e.key === 'Escape') {
                setIsAuthModalOpen(false);
                setIsSessionHistoryOpen(false);
                return;
            }

            // Ctrl+B: toggle bot
            if (e.ctrlKey && e.key === 'b') {
                e.preventDefault();
                toggleBot(!isBotActive);
                return;
            }

            // Ctrl+S: toggle scanner
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                setIsScannerActive(!isScannerActive);
                addLog(`Scanner ${!isScannerActive ? 'enabled' : 'disabled'} via keyboard shortcut`, 'INFO');
                return;
            }

            // 1-7: switch strategy
            const strat = STRATEGY_KEYS[e.key];
            if (strat && !e.ctrlKey && !e.altKey && !e.metaKey) {
                setStrategy(strat);
                addLog(`Strategy switched to ${strat} via keyboard shortcut`, 'INFO');
            }
        };

        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isBotActive, isScannerActive, toggleBot, setIsScannerActive, setIsAuthModalOpen, setIsSessionHistoryOpen, setStrategy, addLog]);
}
