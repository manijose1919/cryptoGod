
import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import type {
    Candle, WatchlistData, MTFData, ScannerInsights, AdaptiveData, MultiAssetAnalysis
} from '../types';
import type { LearningState } from '../services/aiLearningService';
import type { AssetProfile, SentimentData } from '../services/assetIntelligenceService';
import type { EnsembleVolatility } from '../services/volatilityMethodsService';
import type { SentimentSignal, SentimentBurst, SentimentRegime } from '../services/enhancedSentimentService';
import type { OnChainSignals } from '../services/onChainAnalyticsService';
import type { RiskMetrics, KellyResult, MonteCarloResult } from '../services/riskMetricsService';
import {
    calculateTCSeries, calculateBreakoutDetectorSeries, calculateWhaleMoneyFlowSeries,
    calculateTrendDashboard, calculateSRLevels, calculateMomentumSeries,
    calculateDivergence, calculateVolumeProfile, calculateSignalScore,
    toIndicatorData, calculateAdaptiveTCSeries, calculateBollingerBands,
    calculateVWAP, sma,
} from '../services/indicatorService';

interface MarketDataContextType {
    activeWatchlistData: WatchlistData[string] | null;
    setActiveWatchlistData: React.Dispatch<React.SetStateAction<WatchlistData[string] | null>>;
    watchlistDataRef: React.MutableRefObject<WatchlistData>;
    availableTickersRef: React.MutableRefObject<string[]>;
    ws: React.MutableRefObject<WebSocket | null>;
    reconnectAttempts: React.MutableRefObject<number>;
    reconnectTimeout: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    mtfData: MTFData;
    setMtfData: React.Dispatch<React.SetStateAction<MTFData>>;
    isMtfLoading: boolean;
    setIsMtfLoading: React.Dispatch<React.SetStateAction<boolean>>;
    adaptiveData: AdaptiveData | null;
    setAdaptiveData: React.Dispatch<React.SetStateAction<AdaptiveData | null>>;
    multiAssetAnalysis: MultiAssetAnalysis | null;
    setMultiAssetAnalysis: React.Dispatch<React.SetStateAction<MultiAssetAnalysis | null>>;
    marketRegime: { trend: string; volatility: string; tradingCondition: string; recommendedStrategy: string } | null;
    setMarketRegime: React.Dispatch<React.SetStateAction<{ trend: string; volatility: string; tradingCondition: string; recommendedStrategy: string } | null>>;
    scannerInsights: ScannerInsights | null;
    setScannerInsights: React.Dispatch<React.SetStateAction<ScannerInsights | null>>;
    predictionData: any;
    setPredictionData: React.Dispatch<React.SetStateAction<any>>;
    dynamicParams: {
        adjustedMaxTrades: number; adjustedRiskAmount: number; adjustedStopLoss: number;
        aggressivenessLevel: string; reasonForAdjustment: string; marketConditionScore: number;
    } | null;
    setDynamicParams: React.Dispatch<React.SetStateAction<MarketDataContextType['dynamicParams']>>;
    ensembleVolatility: EnsembleVolatility | null;
    setEnsembleVolatility: React.Dispatch<React.SetStateAction<EnsembleVolatility | null>>;
    volatilityExpansion: { isExpanding: boolean; expansionRate: number; signal: string } | null;
    setVolatilityExpansion: React.Dispatch<React.SetStateAction<{ isExpanding: boolean; expansionRate: number; signal: string } | null>>;
    sentimentSignal: SentimentSignal | null;
    setSentimentSignal: React.Dispatch<React.SetStateAction<SentimentSignal | null>>;
    sentimentBurst: SentimentBurst | null;
    setSentimentBurst: React.Dispatch<React.SetStateAction<SentimentBurst | null>>;
    sentimentRegime: SentimentRegime | null;
    setSentimentRegime: React.Dispatch<React.SetStateAction<SentimentRegime | null>>;
    onChainSignals: OnChainSignals | null;
    setOnChainSignals: React.Dispatch<React.SetStateAction<OnChainSignals | null>>;
    riskMetrics: RiskMetrics | null;
    setRiskMetrics: React.Dispatch<React.SetStateAction<RiskMetrics | null>>;
    kellyResult: KellyResult | null;
    setKellyResult: React.Dispatch<React.SetStateAction<KellyResult | null>>;
    monteCarloResult: MonteCarloResult | null;
    setMonteCarloResult: React.Dispatch<React.SetStateAction<MonteCarloResult | null>>;
    isRunningMonteCarlo: boolean;
    setIsRunningMonteCarlo: React.Dispatch<React.SetStateAction<boolean>>;
    learningState: LearningState | null;
    setLearningState: React.Dispatch<React.SetStateAction<LearningState | null>>;
    aiAnalysisResult: string | null;
    setAiAnalysisResult: React.Dispatch<React.SetStateAction<string | null>>;
    isAnalyzing: boolean;
    setIsAnalyzing: React.Dispatch<React.SetStateAction<boolean>>;
    currentAssetProfile: AssetProfile | null;
    setCurrentAssetProfile: React.Dispatch<React.SetStateAction<AssetProfile | null>>;
    currentSentiment: SentimentData | null;
    setCurrentSentiment: React.Dispatch<React.SetStateAction<SentimentData | null>>;
    assetRanking: { symbol: string; score: number; reason: string }[];
    setAssetRanking: React.Dispatch<React.SetStateAction<{ symbol: string; score: number; reason: string }[]>>;
    pendingTrade: any;
    setPendingTrade: React.Dispatch<React.SetStateAction<any>>;
    updateWatchlistData: (candles: Candle[], tickerSymbol: string) => WatchlistData[string];
}

const MarketDataContext = createContext<MarketDataContextType | null>(null);

export function useMarketDataContext() {
    const ctx = useContext(MarketDataContext);
    if (!ctx) throw new Error('useMarketDataContext must be used within MarketDataProvider');
    return ctx;
}

export function MarketDataProvider({ children }: { children: React.ReactNode }) {
    const [activeWatchlistData, setActiveWatchlistData] = useState<WatchlistData[string] | null>(null);
    const [mtfData, setMtfData] = useState<MTFData>({});
    const [isMtfLoading, setIsMtfLoading] = useState(false);
    const [adaptiveData, setAdaptiveData] = useState<AdaptiveData | null>(null);
    const [multiAssetAnalysis, setMultiAssetAnalysis] = useState<MultiAssetAnalysis | null>(null);
    const [marketRegime, setMarketRegime] = useState<MarketDataContextType['marketRegime']>(null);
    const [scannerInsights, setScannerInsights] = useState<ScannerInsights | null>(null);
    const [predictionData, setPredictionData] = useState<any>(null);
    const [dynamicParams, setDynamicParams] = useState<MarketDataContextType['dynamicParams']>(null);
    const [ensembleVolatility, setEnsembleVolatility] = useState<EnsembleVolatility | null>(null);
    const [volatilityExpansion, setVolatilityExpansion] = useState<MarketDataContextType['volatilityExpansion']>(null);
    const [sentimentSignal, setSentimentSignal] = useState<SentimentSignal | null>(null);
    const [sentimentBurst, setSentimentBurst] = useState<SentimentBurst | null>(null);
    const [sentimentRegime, setSentimentRegime] = useState<SentimentRegime | null>(null);
    const [onChainSignals, setOnChainSignals] = useState<OnChainSignals | null>(null);
    const [riskMetrics, setRiskMetrics] = useState<RiskMetrics | null>(null);
    const [kellyResult, setKellyResult] = useState<KellyResult | null>(null);
    const [monteCarloResult, setMonteCarloResult] = useState<MonteCarloResult | null>(null);
    const [isRunningMonteCarlo, setIsRunningMonteCarlo] = useState(false);
    const [learningState, setLearningState] = useState<LearningState | null>(null);
    const [aiAnalysisResult, setAiAnalysisResult] = useState<string | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [currentAssetProfile, setCurrentAssetProfile] = useState<AssetProfile | null>(null);
    const [currentSentiment, setCurrentSentiment] = useState<SentimentData | null>(null);
    const [assetRanking, setAssetRanking] = useState<{ symbol: string; score: number; reason: string }[]>([]);
    const [pendingTrade, setPendingTrade] = useState<any>(null);

    const watchlistDataRef = useRef<WatchlistData>({});
    const availableTickersRef = useRef<string[]>([]);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectAttempts = useRef(0);
    const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    const updateWatchlistData = useCallback((candles: Candle[], tickerSymbol: string): WatchlistData[string] => {
        const closes = candles.map(c => c.close);
        const tcSeries = calculateTCSeries(candles);
        const breakoutSeries = calculateBreakoutDetectorSeries(candles);
        const whaleSeries = calculateWhaleMoneyFlowSeries(candles);
        const momentumSeries = calculateMomentumSeries(candles);
        const adaptiveSeries = calculateAdaptiveTCSeries(candles, tickerSymbol);
        const bollingerBands = calculateBollingerBands(candles);
        const vwap = calculateVWAP(candles);
        const ma50 = sma(closes, 50);
        const ma200 = sma(closes, 200);

        return {
            candles,
            indicatorData: toIndicatorData(tcSeries, candles),
            breakoutData: toIndicatorData(breakoutSeries, candles),
            whaleData: toIndicatorData(whaleSeries, candles),
            momentumData: toIndicatorData(momentumSeries, candles),
            adaptiveData: toIndicatorData(adaptiveSeries, candles),
            divergenceData: calculateDivergence(candles),
            volumeProfileData: calculateVolumeProfile(candles),
            trendDashboardData: calculateTrendDashboard(candles),
            srLevels: calculateSRLevels(candles),
            signalScore: calculateSignalScore(candles),
            bollingerBands: {
                upper: toIndicatorData(bollingerBands.upper, candles),
                middle: toIndicatorData(bollingerBands.middle, candles),
                lower: toIndicatorData(bollingerBands.lower, candles),
            },
            vwap: toIndicatorData(vwap, candles),
            ma50: toIndicatorData(ma50, candles),
            ma200: toIndicatorData(ma200, candles),
            lastUpdated: Date.now(),
        };
    }, []);

    return (
        <MarketDataContext.Provider value={{
            activeWatchlistData, setActiveWatchlistData,
            watchlistDataRef, availableTickersRef, ws: wsRef,
            reconnectAttempts, reconnectTimeout,
            mtfData, setMtfData, isMtfLoading, setIsMtfLoading,
            adaptiveData, setAdaptiveData,
            multiAssetAnalysis, setMultiAssetAnalysis,
            marketRegime, setMarketRegime,
            scannerInsights, setScannerInsights,
            predictionData, setPredictionData,
            dynamicParams, setDynamicParams,
            ensembleVolatility, setEnsembleVolatility,
            volatilityExpansion, setVolatilityExpansion,
            sentimentSignal, setSentimentSignal,
            sentimentBurst, setSentimentBurst,
            sentimentRegime, setSentimentRegime,
            onChainSignals, setOnChainSignals,
            riskMetrics, setRiskMetrics,
            kellyResult, setKellyResult,
            monteCarloResult, setMonteCarloResult,
            isRunningMonteCarlo, setIsRunningMonteCarlo,
            learningState, setLearningState,
            aiAnalysisResult, setAiAnalysisResult,
            isAnalyzing, setIsAnalyzing,
            currentAssetProfile, setCurrentAssetProfile,
            currentSentiment, setCurrentSentiment,
            assetRanking, setAssetRanking,
            pendingTrade, setPendingTrade,
            updateWatchlistData,
        }}>
            {children}
        </MarketDataContext.Provider>
    );
}
