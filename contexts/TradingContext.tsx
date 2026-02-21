
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { PortfolioState, Trade, SystemEvent, TradingMode } from '../types';
import { SYSTEM_LIMITS } from '../constants';

interface TradingContextType {
    portfolio: PortfolioState;
    setPortfolio: React.Dispatch<React.SetStateAction<PortfolioState>>;
    trades: Trade[];
    setTrades: React.Dispatch<React.SetStateAction<Trade[]>>;
    systemLog: SystemEvent[];
    setSystemLog: React.Dispatch<React.SetStateAction<SystemEvent[]>>;
    isBotActive: boolean;
    setIsBotActive: React.Dispatch<React.SetStateAction<boolean>>;
    isScannerActive: boolean;
    setIsScannerActive: React.Dispatch<React.SetStateAction<boolean>>;
    scannerPaused: boolean;
    setScannerPaused: React.Dispatch<React.SetStateAction<boolean>>;
    tradingMode: TradingMode;
    setTradingMode: React.Dispatch<React.SetStateAction<TradingMode>>;
    isTradingActive: boolean;
    setIsTradingActive: React.Dispatch<React.SetStateAction<boolean>>;
    isApiAuthenticated: boolean;
    setIsApiAuthenticated: React.Dispatch<React.SetStateAction<boolean>>;
    isAuthModalOpen: boolean;
    setIsAuthModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    isSessionHistoryOpen: boolean;
    setIsSessionHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
    showReconnect: boolean;
    setShowReconnect: React.Dispatch<React.SetStateAction<boolean>>;
    checkingSession: boolean;
    setCheckingSession: React.Dispatch<React.SetStateAction<boolean>>;
    isVPSReconnect: boolean;
    setIsVPSReconnect: React.Dispatch<React.SetStateAction<boolean>>;
    sessionStartTime: number;
    setSessionStartTime: React.Dispatch<React.SetStateAction<number>>;
    isLoading: boolean;
    setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
    error: string | null;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
    addLog: (message: string, type?: SystemEvent['type']) => void;
    addTrade: (trade: Omit<Trade, 'id' | 'time'>) => Trade;
    portfolioRef: React.MutableRefObject<PortfolioState>;
    isBotActiveRef: React.MutableRefObject<boolean>;
}

const TradingContext = createContext<TradingContextType | null>(null);

export function useTradingContext() {
    const ctx = useContext(TradingContext);
    if (!ctx) throw new Error('useTradingContext must be used within TradingProvider');
    return ctx;
}

export function TradingProvider({ children }: { children: React.ReactNode }) {
    const [portfolio, setPortfolio] = useState<PortfolioState>({ cash: 10000, initialBudget: 10000, positions: {} });
    const [trades, setTrades] = useState<Trade[]>([]);
    const [systemLog, setSystemLog] = useState<SystemEvent[]>([]);
    const [isBotActive, setIsBotActive] = useState(false);
    const [isScannerActive, setIsScannerActive] = useState(false);
    const [scannerPaused, setScannerPaused] = useState(false);
    const [tradingMode, setTradingMode] = useState<TradingMode>('SIMULATION');
    const [isTradingActive, setIsTradingActive] = useState(false);
    const [isApiAuthenticated, setIsApiAuthenticated] = useState(false);
    const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
    const [isSessionHistoryOpen, setIsSessionHistoryOpen] = useState(false);
    const [showReconnect, setShowReconnect] = useState(false);
    const [checkingSession, setCheckingSession] = useState(true);
    const [isVPSReconnect, setIsVPSReconnect] = useState(false);
    const [sessionStartTime, setSessionStartTime] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const portfolioRef = useRef(portfolio);
    const isBotActiveRef = useRef(false);

    useEffect(() => { portfolioRef.current = portfolio; }, [portfolio]);
    useEffect(() => { isBotActiveRef.current = isBotActive; }, [isBotActive]);

    const addLog = useCallback((message: string, type: SystemEvent['type'] = 'INFO') => {
        setSystemLog(prev => [
            { id: Date.now() + Math.random(), time: Date.now(), message, type },
            ...prev
        ].slice(0, SYSTEM_LIMITS.MAX_LOG_ENTRIES));
    }, []);

    const addTrade = useCallback((trade: Omit<Trade, 'id' | 'time'>) => {
        const newTrade: Trade = { ...trade, id: Date.now() + Math.random(), time: Date.now() };
        setTrades(prev => [newTrade, ...prev].slice(0, SYSTEM_LIMITS.MAX_TRADE_HISTORY));
        return newTrade;
    }, []);

    return (
        <TradingContext.Provider value={{
            portfolio, setPortfolio, trades, setTrades, systemLog, setSystemLog,
            isBotActive, setIsBotActive, isScannerActive, setIsScannerActive,
            scannerPaused, setScannerPaused, tradingMode, setTradingMode,
            isTradingActive, setIsTradingActive, isApiAuthenticated, setIsApiAuthenticated,
            isAuthModalOpen, setIsAuthModalOpen, isSessionHistoryOpen, setIsSessionHistoryOpen,
            showReconnect, setShowReconnect, checkingSession, setCheckingSession,
            isVPSReconnect, setIsVPSReconnect, sessionStartTime, setSessionStartTime,
            isLoading, setIsLoading, error, setError,
            addLog, addTrade, portfolioRef, isBotActiveRef,
        }}>
            {children}
        </TradingContext.Provider>
    );
}
