
import type {
    Trade,
    SystemEvent,
    PortfolioState,
    BotSettings,
    TradingStrategy,
    Candle,
    WatchlistData
} from '../types';
import { SYSTEM_LIMITS, DEFAULT_PROFIT_GOALS, RISK_DEFAULTS, DEFAULT_SESSION_PROFIT_GOAL } from '../constants';

/**
 * Data Service
 * Handles data persistence, caching, and state management utilities
 */

// Storage keys
const STORAGE_KEYS = {
    TRADES: 'trading_dashboard_trades',
    SETTINGS: 'trading_dashboard_settings',
    PORTFOLIO: 'trading_dashboard_portfolio',
    SESSION: 'trading_dashboard_session',
    PREFERENCES: 'trading_dashboard_preferences'
} as const;

// Session data interface
interface SessionData {
    startTime: number;
    endTime?: number;
    initialBudget: number;
    finalValue?: number;
    totalTrades: number;
    winRate: number;
    pnl: number;
    strategy: TradingStrategy;
}

// User preferences interface
interface UserPreferences {
    defaultTicker: string;
    defaultStrategy: TradingStrategy;
    defaultBudget: number;
    theme: 'dark' | 'light';
    soundEnabled: boolean;
    notificationsEnabled: boolean;
}

class DataService {
    private isStorageAvailable: boolean;

    constructor() {
        this.isStorageAvailable = this.checkStorageAvailability();
    }

    // ============================================
    // STORAGE AVAILABILITY CHECK
    // ============================================

    private checkStorageAvailability(): boolean {
        try {
            const testKey = '__storage_test__';
            localStorage.setItem(testKey, testKey);
            localStorage.removeItem(testKey);
            return true;
        } catch {
            console.warn('LocalStorage is not available. Data will not persist between sessions.');
            return false;
        }
    }

    // ============================================
    // GENERIC STORAGE METHODS
    // ============================================

    private saveToStorage<T>(key: string, data: T): boolean {
        if (!this.isStorageAvailable) return false;

        try {
            localStorage.setItem(key, JSON.stringify(data));
            return true;
        } catch (error) {
            console.error(`Failed to save data to storage (${key}):`, error);
            return false;
        }
    }

    private loadFromStorage<T>(key: string, defaultValue: T): T {
        if (!this.isStorageAvailable) return defaultValue;

        try {
            const data = localStorage.getItem(key);
            if (data === null) return defaultValue;
            return JSON.parse(data) as T;
        } catch (error) {
            console.error(`Failed to load data from storage (${key}):`, error);
            return defaultValue;
        }
    }

    private removeFromStorage(key: string): boolean {
        if (!this.isStorageAvailable) return false;

        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error(`Failed to remove data from storage (${key}):`, error);
            return false;
        }
    }

    // ============================================
    // TRADE HISTORY METHODS
    // ============================================

    saveTrades(trades: Trade[]): boolean {
        const limitedTrades = trades.slice(0, SYSTEM_LIMITS.MAX_TRADE_HISTORY);
        return this.saveToStorage(STORAGE_KEYS.TRADES, limitedTrades);
    }

    loadTrades(): Trade[] {
        return this.loadFromStorage<Trade[]>(STORAGE_KEYS.TRADES, []);
    }

    appendTrade(trade: Trade): Trade[] {
        const trades = this.loadTrades();
        const updatedTrades = [trade, ...trades].slice(0, SYSTEM_LIMITS.MAX_TRADE_HISTORY);
        this.saveTrades(updatedTrades);
        return updatedTrades;
    }

    clearTrades(): boolean {
        return this.removeFromStorage(STORAGE_KEYS.TRADES);
    }

    // ============================================
    // SETTINGS METHODS
    // ============================================

    saveSettings(settings: BotSettings): boolean {
        return this.saveToStorage(STORAGE_KEYS.SETTINGS, settings);
    }

    loadSettings(): BotSettings {
        return this.loadFromStorage<BotSettings>(STORAGE_KEYS.SETTINGS, {
            strategy: 'TREND',
            riskAmount: RISK_DEFAULTS.DEFAULT_RISK_AMOUNT,
            profitGoals: DEFAULT_PROFIT_GOALS,
            sessionProfitGoal: DEFAULT_SESSION_PROFIT_GOAL,
            maxConcurrentTrades: RISK_DEFAULTS.MAX_CONCURRENT_TRADES,
            stopLossPercent: RISK_DEFAULTS.DEFAULT_STOP_LOSS_PERCENT,
            trailingStopPercent: RISK_DEFAULTS.DEFAULT_TRAILING_STOP_PERCENT,
            useTrailingStop: true,
            minSignalConfidence: RISK_DEFAULTS.MIN_SIGNAL_CONFIDENCE
        });
    }

    // ============================================
    // PORTFOLIO METHODS
    // ============================================

    savePortfolio(portfolio: PortfolioState): boolean {
        return this.saveToStorage(STORAGE_KEYS.PORTFOLIO, portfolio);
    }

    loadPortfolio(): PortfolioState | null {
        return this.loadFromStorage<PortfolioState | null>(STORAGE_KEYS.PORTFOLIO, null);
    }

    clearPortfolio(): boolean {
        return this.removeFromStorage(STORAGE_KEYS.PORTFOLIO);
    }

    // ============================================
    // SESSION METHODS
    // ============================================

    saveSession(session: SessionData): boolean {
        const sessions = this.loadAllSessions();
        sessions.unshift(session);
        // Keep last 50 sessions
        const limitedSessions = sessions.slice(0, 50);
        return this.saveToStorage(STORAGE_KEYS.SESSION, limitedSessions);
    }

    loadAllSessions(): SessionData[] {
        return this.loadFromStorage<SessionData[]>(STORAGE_KEYS.SESSION, []);
    }

    getLastSession(): SessionData | null {
        const sessions = this.loadAllSessions();
        return sessions.length > 0 ? sessions[0] : null;
    }

    clearSessions(): boolean {
        return this.removeFromStorage(STORAGE_KEYS.SESSION);
    }

    // ============================================
    // USER PREFERENCES METHODS
    // ============================================

    savePreferences(preferences: Partial<UserPreferences>): boolean {
        const current = this.loadPreferences();
        return this.saveToStorage(STORAGE_KEYS.PREFERENCES, { ...current, ...preferences });
    }

    loadPreferences(): UserPreferences {
        return this.loadFromStorage<UserPreferences>(STORAGE_KEYS.PREFERENCES, {
            defaultTicker: 'BTCUSDC',
            defaultStrategy: 'TREND',
            defaultBudget: 10000,
            theme: 'dark',
            soundEnabled: false,
            notificationsEnabled: true
        });
    }

    // ============================================
    // DATA ANALYSIS HELPERS
    // ============================================

    /**
     * Calculate statistics from trade history
     */
    calculateTradeStats(trades: Trade[]): {
        totalTrades: number;
        winningTrades: number;
        losingTrades: number;
        winRate: number;
        totalPnL: number;
        avgWin: number;
        avgLoss: number;
        profitFactor: number;
        largestWin: number;
        largestLoss: number;
        avgHoldTime: number;
        strategyBreakdown: Record<TradingStrategy, { count: number; pnl: number; winRate: number }>;
    } {
        const sellTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);
        const buyTrades = trades.filter(t => t.type === 'BUY');

        if (sellTrades.length === 0) {
            const emptyBreakdown: Record<TradingStrategy, { count: number; pnl: number; winRate: number }> = {
                TREND: { count: 0, pnl: 0, winRate: 0 },
                BREAKOUT: { count: 0, pnl: 0, winRate: 0 },
                WHALE: { count: 0, pnl: 0, winRate: 0 },
                CONFLUENCE: { count: 0, pnl: 0, winRate: 0 },
                MOMENTUM: { count: 0, pnl: 0, winRate: 0 },
                DIVERGENCE: { count: 0, pnl: 0, winRate: 0 }
            };

            return {
                totalTrades: trades.length,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnL: 0,
                avgWin: 0,
                avgLoss: 0,
                profitFactor: 0,
                largestWin: 0,
                largestLoss: 0,
                avgHoldTime: 0,
                strategyBreakdown: emptyBreakdown
            };
        }

        const pnlList = sellTrades.map(t => t.pnl!);
        const wins = pnlList.filter(p => p > 0);
        const losses = pnlList.filter(p => p < 0);

        const totalWins = wins.reduce((a, b) => a + b, 0);
        const totalLosses = Math.abs(losses.reduce((a, b) => a + b, 0));

        // Calculate hold times
        const holdTimes: number[] = [];
        for (const sell of sellTrades) {
            const matchingBuy = buyTrades.find(b => b.ticker === sell.ticker && b.time < sell.time);
            if (matchingBuy) {
                holdTimes.push(sell.time - matchingBuy.time);
            }
        }

        // Calculate per-strategy breakdown
        const strategyBreakdown: Record<TradingStrategy, { count: number; pnl: number; winRate: number }> = {
            TREND: { count: 0, pnl: 0, winRate: 0 },
            BREAKOUT: { count: 0, pnl: 0, winRate: 0 },
            WHALE: { count: 0, pnl: 0, winRate: 0 },
            CONFLUENCE: { count: 0, pnl: 0, winRate: 0 },
            MOMENTUM: { count: 0, pnl: 0, winRate: 0 },
            DIVERGENCE: { count: 0, pnl: 0, winRate: 0 }
        };

        for (const trade of sellTrades) {
            const strat = trade.strategy;
            strategyBreakdown[strat].count++;
            strategyBreakdown[strat].pnl += trade.pnl!;
        }

        // Calculate win rates per strategy
        for (const strat of Object.keys(strategyBreakdown) as TradingStrategy[]) {
            const stratTrades = sellTrades.filter(t => t.strategy === strat);
            const stratWins = stratTrades.filter(t => t.pnl! > 0).length;
            strategyBreakdown[strat].winRate = stratTrades.length > 0
                ? (stratWins / stratTrades.length) * 100
                : 0;
        }

        return {
            totalTrades: trades.length,
            winningTrades: wins.length,
            losingTrades: losses.length,
            winRate: (wins.length / sellTrades.length) * 100,
            totalPnL: pnlList.reduce((a, b) => a + b, 0),
            avgWin: wins.length > 0 ? totalWins / wins.length : 0,
            avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
            profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
            largestWin: Math.max(0, ...pnlList),
            largestLoss: Math.min(0, ...pnlList),
            avgHoldTime: holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0,
            strategyBreakdown
        };
    }

    /**
     * Export trades to CSV format
     */
    exportTradesToCSV(trades: Trade[]): string {
        const headers = ['ID', 'Time', 'Type', 'Ticker', 'Price', 'Quantity', 'Strategy', 'Reason', 'PnL'];
        const rows = trades.map(t => [
            t.id,
            new Date(t.time).toISOString(),
            t.type,
            t.ticker,
            t.price.toFixed(2),
            t.quantity.toFixed(6),
            t.strategy,
            `"${t.reason.replace(/"/g, '""')}"`,
            t.pnl !== undefined ? t.pnl.toFixed(2) : ''
        ]);

        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    /**
     * Download trades as CSV file
     */
    downloadTradesCSV(trades: Trade[], filename: string = 'trade_history.csv'): void {
        const csv = this.exportTradesToCSV(trades);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    // ============================================
    // CACHE MANAGEMENT
    // ============================================

    /**
     * Clear all stored data
     */
    clearAllData(): boolean {
        let success = true;
        for (const key of Object.values(STORAGE_KEYS)) {
            if (!this.removeFromStorage(key)) {
                success = false;
            }
        }
        return success;
    }

    /**
     * Get storage usage information
     */
    getStorageInfo(): { used: number; available: boolean } {
        if (!this.isStorageAvailable) {
            return { used: 0, available: false };
        }

        let totalSize = 0;
        for (const key of Object.values(STORAGE_KEYS)) {
            const item = localStorage.getItem(key);
            if (item) {
                totalSize += item.length * 2; // UTF-16 encoding
            }
        }

        return { used: totalSize, available: true };
    }
}

// Export singleton instance
export const dataService = new DataService();

// Export types
export type { SessionData, UserPreferences };
