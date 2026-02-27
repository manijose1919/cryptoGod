
import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import type { TradingStrategy } from '../types';
import { RISK_DEFAULTS, DEFAULT_PROFIT_GOALS, DEFAULT_SESSION_PROFIT_GOAL, TRADING_FEES } from '../constants';

interface SettingsContextType {
    ticker: string;
    setTicker: React.Dispatch<React.SetStateAction<string>>;
    strategy: TradingStrategy;
    setStrategy: React.Dispatch<React.SetStateAction<TradingStrategy>>;
    riskAmount: number;
    setRiskAmount: React.Dispatch<React.SetStateAction<number>>;
    profitGoals: Record<TradingStrategy, number>;
    setProfitGoals: React.Dispatch<React.SetStateAction<Record<TradingStrategy, number>>>;
    sessionProfitGoal: number;
    setSessionProfitGoal: React.Dispatch<React.SetStateAction<number>>;
    maxConcurrentTrades: number;
    setMaxConcurrentTrades: React.Dispatch<React.SetStateAction<number>>;
    stopLossPercent: number;
    setStopLossPercent: React.Dispatch<React.SetStateAction<number>>;
    trailingStopPercent: number;
    setTrailingStopPercent: React.Dispatch<React.SetStateAction<number>>;
    useTrailingStop: boolean;
    setUseTrailingStop: React.Dispatch<React.SetStateAction<boolean>>;
    currentExchange: string;
    setCurrentExchange: React.Dispatch<React.SetStateAction<string>>;
    currentExchangeFees: { takerFee: number; roundTripFee: number };
    setCurrentExchangeFees: React.Dispatch<React.SetStateAction<{ takerFee: number; roundTripFee: number }>>;
    smartTradingEnabled: boolean;
    setSmartTradingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    aiLearningEnabled: boolean;
    setAiLearningEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    assetIntelligenceEnabled: boolean;
    setAssetIntelligenceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    volatilityAnalysisEnabled: boolean;
    setVolatilityAnalysisEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    enhancedSentimentEnabled: boolean;
    setEnhancedSentimentEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    onChainEnabled: boolean;
    setOnChainEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    riskMetricsEnabled: boolean;
    setRiskMetricsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    microTradingEnabled: boolean;
    setMicroTradingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    unlimitedTrades: boolean;
    setUnlimitedTrades: React.Dispatch<React.SetStateAction<boolean>>;
    lastMicroTradeTime: Record<string, number>;
    setLastMicroTradeTime: React.Dispatch<React.SetStateAction<Record<string, number>>>;
    sessionDurationMinutes: number;
    setSessionDurationMinutes: React.Dispatch<React.SetStateAction<number>>;
    aggressiveLevel: number;
    setAggressiveLevel: React.Dispatch<React.SetStateAction<number>>;
    sessionDurationRef: React.MutableRefObject<number>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function useSettingsContext() {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error('useSettingsContext must be used within SettingsProvider');
    return ctx;
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    const [ticker, setTicker] = useState('BTCUSD');
    const [strategy, setStrategy] = useState<TradingStrategy>('TREND');
    const [riskAmount, setRiskAmount] = useState<number>(RISK_DEFAULTS.DEFAULT_RISK_AMOUNT);
    const [profitGoals, setProfitGoals] = useState<Record<TradingStrategy, number>>(DEFAULT_PROFIT_GOALS);
    const [sessionProfitGoal, setSessionProfitGoal] = useState<number>(DEFAULT_SESSION_PROFIT_GOAL);
    const [maxConcurrentTrades, setMaxConcurrentTrades] = useState<number>(RISK_DEFAULTS.MAX_CONCURRENT_TRADES);
    const [stopLossPercent, setStopLossPercent] = useState<number>(RISK_DEFAULTS.DEFAULT_STOP_LOSS_PERCENT);
    const [trailingStopPercent, setTrailingStopPercent] = useState<number>(RISK_DEFAULTS.DEFAULT_TRAILING_STOP_PERCENT);
    const [useTrailingStop, setUseTrailingStop] = useState(true);
    const [currentExchange, setCurrentExchange] = useState('kraken');
    const [currentExchangeFees, setCurrentExchangeFees] = useState<{ takerFee: number; roundTripFee: number }>({
        takerFee: TRADING_FEES.TAKER_FEE_PERCENT,
        roundTripFee: TRADING_FEES.ROUND_TRIP_FEE_PERCENT,
    });
    const [smartTradingEnabled, setSmartTradingEnabled] = useState(true);
    const [aiLearningEnabled, setAiLearningEnabled] = useState(true);
    const [assetIntelligenceEnabled, setAssetIntelligenceEnabled] = useState(true);
    const [volatilityAnalysisEnabled, setVolatilityAnalysisEnabled] = useState(true);
    const [enhancedSentimentEnabled, setEnhancedSentimentEnabled] = useState(true);
    const [onChainEnabled, setOnChainEnabled] = useState(true);
    const [riskMetricsEnabled, setRiskMetricsEnabled] = useState(true);
    const [microTradingEnabled, setMicroTradingEnabled] = useState(false);
    const [unlimitedTrades, setUnlimitedTrades] = useState(false);
    const [lastMicroTradeTime, setLastMicroTradeTime] = useState<Record<string, number>>({});
    const [sessionDurationMinutes, setSessionDurationMinutes] = useState(0);
    const [aggressiveLevel, setAggressiveLevel] = useState(75);

    const sessionDurationRef = useRef(0);
    useEffect(() => { sessionDurationRef.current = sessionDurationMinutes; }, [sessionDurationMinutes]);

    return (
        <SettingsContext.Provider value={{
            ticker, setTicker, strategy, setStrategy, riskAmount, setRiskAmount,
            profitGoals, setProfitGoals, sessionProfitGoal, setSessionProfitGoal,
            maxConcurrentTrades, setMaxConcurrentTrades,
            stopLossPercent, setStopLossPercent, trailingStopPercent, setTrailingStopPercent,
            useTrailingStop, setUseTrailingStop,
            currentExchange, setCurrentExchange, currentExchangeFees, setCurrentExchangeFees,
            smartTradingEnabled, setSmartTradingEnabled,
            aiLearningEnabled, setAiLearningEnabled,
            assetIntelligenceEnabled, setAssetIntelligenceEnabled,
            volatilityAnalysisEnabled, setVolatilityAnalysisEnabled,
            enhancedSentimentEnabled, setEnhancedSentimentEnabled,
            onChainEnabled, setOnChainEnabled,
            riskMetricsEnabled, setRiskMetricsEnabled,
            microTradingEnabled, setMicroTradingEnabled,
            unlimitedTrades, setUnlimitedTrades,
            lastMicroTradeTime, setLastMicroTradeTime,
            sessionDurationMinutes, setSessionDurationMinutes,
            aggressiveLevel, setAggressiveLevel,
            sessionDurationRef,
        }}>
            {children}
        </SettingsContext.Provider>
    );
}
