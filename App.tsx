
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LiveFeed } from './components/LiveFeed';
import { IndicatorChart } from './components/IndicatorChart';
import { IndicatorGauge } from './components/IndicatorGauge';
import { SignalDisplay } from './components/SignalDisplay';
import { MultiTimeframeDashboard } from './components/MultiTimeframeDashboard';
import { ConfluenceDashboard } from './components/ConfluenceDashboard';
import { TradingControls } from './components/TradingControls';
import { PortfolioSummary } from './components/PortfolioSummary';
import { SessionSummary } from './components/SessionSummary';
import { SystemLog } from './components/SystemLog';
import { MarketScanner } from './components/MarketScanner';
import { RealTradingModal } from './components/RealTradingModal';
import { TradeHistory } from './components/TradeHistory';
import { SignalHeatMap } from './components/SignalHeatMap';
import { AdaptiveDashboard } from './components/AdaptiveDashboard';
import { AILearningPanel } from './components/AILearningPanel';
import { ExchangeSelector } from './components/ExchangeSelector';
import { AssetIntelligencePanel } from './components/AssetIntelligencePanel';
import { VolatilityPanel } from './components/VolatilityPanel';
import { RiskMetricsPanel } from './components/RiskMetricsPanel';
import { TradeExplainer } from './components/TradeExplainer';
import { PredictiveDisplay } from './components/PredictiveDisplay';
import { NewsDashboard } from './components/NewsDashboard';
import { MLDashboard } from './components/MLDashboard';
import StrategyOverview from './components/StrategyOverview';
import SessionReconnect from './components/SessionReconnect';
import MLThoughtProcess from './components/MLThoughtProcess';
import VPSMonitor from './components/VPSMonitor';
import { fetchHistoricalCandles, fetchAvailableUsdPairs, setActiveExchange as setMarketServiceExchange } from './services/marketService';
import { tradingBotService } from './services/tradingBotService';
import {
    calculateTCSeries,
    calculateBreakoutDetectorSeries,
    calculateWhaleMoneyFlowSeries,
    calculateTrendDashboard,
    calculateSRLevels,
    calculateMomentumSeries,
    calculateDivergence,
    calculateVolumeProfile,
    calculateSignalScore,
    toIndicatorData,
    calculateAdaptiveData,
    calculateAdaptiveTCSeries,
    calculateMultiAssetAnalysis,
    calculateBollingerBands,
    calculateVWAP,
    sma,
    ema,
    detectMarketRegime,
    detectSlowMarket,
    detectGap,
    calculateDynamicParams,
    calculateSessionAnalytics,
    rankOpportunities
} from './services/indicatorService';
import {
    recordTrade,
    shouldTakeTrade,
    getAdjustedParameters,
    getLearningState,
    requestAIAnalysis,
    setAggressiveMode,
    resetLearning,
    restoreFromDatabase,
    persistCurrentState,
    type LearningState,
    type ParameterAdjustments
} from './services/aiLearningService';
import {
    getAssetProfile,
    getRiskAdjustedParams,
    getVolatilityBasedRules,
    isAssetTradeable,
    getBestStrategyForAsset,
    getBestAssetsForMarket,
    getAssetTradingRecommendation,
    fetchSocialSentiment,
    type AssetProfile,
    type SentimentData
} from './services/assetIntelligenceService';
import {
    calculateEnsembleVolatility,
    detectVolatilityExpansion,
    getVolatilityAdjustedParams,
    getBestVolatilityMethodForStrategy,
    type EnsembleVolatility
} from './services/volatilityMethodsService';
import {
    calculateSentimentFromMarketData,
    detectSentimentBurst,
    detectSentimentRegime,
    applySentimentFilter,
    calculateSentimentConfidenceAdjustment,
    getCorrelatedMemeAssets,
    type SentimentSignal,
    type SentimentBurst,
    type SentimentRegime
} from './services/enhancedSentimentService';
import {
    calculateOnChainSignals,
    getOnChainTradingAdjustment,
    type OnChainSignals
} from './services/onChainAnalyticsService';
import {
    calculateRiskMetrics,
    calculateKellyCriterion,
    runMonteCarloSimulation,
    getRiskAdjustedAllocation,
    updateEquityCurve,
    resetEquityTracking,
    type RiskMetrics,
    type KellyResult,
    type MonteCarloResult
} from './services/riskMetricsService';
import type {
    Candle, PortfolioState, Trade, WatchlistData, TradingStrategy,
    MTFData, ScannerInsights, SystemEvent, TradingMode, ApiCredentials,
    Position, BotSettings, AdaptiveData, MultiAssetAnalysis, SlowMarketResult
} from './types';
import {
    TIME_FRAMES_MAP,
    SIGNAL_THRESHOLDS,
    RISK_DEFAULTS,
    DEFAULT_PROFIT_GOALS,
    DEFAULT_SESSION_PROFIT_GOAL,
    WEBSOCKET_CONFIG,
    INTERVALS,
    SYSTEM_LIMITS,
    INDICATOR_PARAMS,
    MICRO_TRADING,
    SURGE_TRADING,
    PROFIT_METHODS,
    TRADING_FEES,
    PARTIAL_EXIT,
    SLOW_MARKET,
    REGIME_STRATEGY_MAP
} from './constants';
import { getSurgeTradingDecision } from './services/surgeTradingService';
import { processGrid } from './services/gridTradingService';
import { processDCA, recordDCABuy, checkDCATakeProfit, clearDCAPosition } from './services/dcaBotService';
import { detectArbitrage } from './services/arbitrageService';
import { getPairSignals, openPairTrade, closePairTrade } from './services/pairTradingService';
import { analyzeSwingSetup, openSwingPosition, checkSwingExit, closeSwingPosition } from './services/swingTradingService';
import { processMarketMaking } from './services/marketMakingService';

const App: React.FC = () => {
    // ============================================
    // STATE
    // ============================================
    const [activeWatchlistData, setActiveWatchlistData] = useState<WatchlistData[string] | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [scannerInsights, setScannerInsights] = useState<ScannerInsights | null>(null);

    const [ticker, setTicker] = useState<string>('BTCUSD');
    const [strategy, setStrategy] = useState<TradingStrategy>('TREND');
    const [riskAmount, setRiskAmount] = useState(RISK_DEFAULTS.DEFAULT_RISK_AMOUNT);
    const [profitGoals, setProfitGoals] = useState<Record<TradingStrategy, number>>(DEFAULT_PROFIT_GOALS);
    const [sessionProfitGoal, setSessionProfitGoal] = useState(DEFAULT_SESSION_PROFIT_GOAL);
    const [maxConcurrentTrades, setMaxConcurrentTrades] = useState(RISK_DEFAULTS.MAX_CONCURRENT_TRADES);

    // Stop-loss settings (NEW)
    const [stopLossPercent, setStopLossPercent] = useState(RISK_DEFAULTS.DEFAULT_STOP_LOSS_PERCENT);
    const [trailingStopPercent, setTrailingStopPercent] = useState(RISK_DEFAULTS.DEFAULT_TRAILING_STOP_PERCENT);
    const [useTrailingStop, setUseTrailingStop] = useState(true);

    const [mtfData, setMtfData] = useState<MTFData>({});
    const [isMtfLoading, setIsMtfLoading] = useState(false);

    // Trading State
    const [tradingMode, setTradingMode] = useState<TradingMode>('SIMULATION');
    const [isTradingActive, setIsTradingActive] = useState<boolean>(false);
    const [isApiAuthenticated, setIsApiAuthenticated] = useState<boolean>(false);
    const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
    const [portfolio, setPortfolio] = useState<PortfolioState>({
        cash: 10000,
        initialBudget: 10000,
        positions: {}
    });
    const [systemLog, setSystemLog] = useState<SystemEvent[]>([]);
    const [trades, setTrades] = useState<Trade[]>([]); // NEW: Proper trade tracking
    const [isBotActive, setIsBotActive] = useState<boolean>(false);
    const [isScannerActive, setIsScannerActive] = useState<boolean>(false);
    const [scannerPaused, setScannerPaused] = useState<boolean>(false); // NEW: Prevent repeated logging

    // Adaptive TC State
    const [adaptiveData, setAdaptiveData] = useState<AdaptiveData | null>(null);
    const [multiAssetAnalysis, setMultiAssetAnalysis] = useState<MultiAssetAnalysis | null>(null);

    // Smart Trading State (NEW)
    const [smartTradingEnabled, setSmartTradingEnabled] = useState<boolean>(true);
    const [dynamicParams, setDynamicParams] = useState<{
        adjustedMaxTrades: number;
        adjustedRiskAmount: number;
        adjustedStopLoss: number;
        aggressivenessLevel: string;
        reasonForAdjustment: string;
        marketConditionScore: number;
    } | null>(null);
    const [marketRegime, setMarketRegime] = useState<{
        trend: string;
        volatility: string;
        tradingCondition: string;
        recommendedStrategy: string;
    } | null>(null);
    const [sessionStartTime, setSessionStartTime] = useState<number>(0);
    const [sessionDurationMinutes, setSessionDurationMinutes] = useState<number>(0); // 0 = unlimited

    // Micro-Trading & Unlimited Trades State (NEW)
    const [microTradingEnabled, setMicroTradingEnabled] = useState<boolean>(false);
    const [unlimitedTrades, setUnlimitedTrades] = useState<boolean>(false);
    const [lastMicroTradeTime, setLastMicroTradeTime] = useState<Record<string, number>>({});

    // AI Learning State (NEW)
    const [aiLearningEnabled, setAiLearningEnabled] = useState<boolean>(true);
    const [learningState, setLearningStateData] = useState<LearningState | null>(null);
    const [aiAnalysisResult, setAiAnalysisResult] = useState<string | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [aggressiveLevel, setAggressiveLevel] = useState<number>(75); // Start aggressive!

    // Asset Intelligence State (NEW)
    const [assetIntelligenceEnabled, setAssetIntelligenceEnabled] = useState<boolean>(true);
    const [currentAssetProfile, setCurrentAssetProfile] = useState<AssetProfile | null>(null);
    const [currentSentiment, setCurrentSentiment] = useState<SentimentData | null>(null);
    const [assetRanking, setAssetRanking] = useState<{ symbol: string; score: number; reason: string }[]>([]);

    // Volatility Methods State (NEW)
    const [volatilityAnalysisEnabled, setVolatilityAnalysisEnabled] = useState<boolean>(true);
    const [ensembleVolatility, setEnsembleVolatility] = useState<EnsembleVolatility | null>(null);
    const [volatilityExpansion, setVolatilityExpansion] = useState<{
        isExpanding: boolean;
        expansionRate: number;
        signal: string;
    } | null>(null);

    // Enhanced Sentiment State (NEW)
    const [enhancedSentimentEnabled, setEnhancedSentimentEnabled] = useState<boolean>(true);
    const [sentimentSignal, setSentimentSignal] = useState<SentimentSignal | null>(null);
    const [sentimentBurst, setSentimentBurst] = useState<SentimentBurst | null>(null);
    const [sentimentRegime, setSentimentRegime] = useState<SentimentRegime | null>(null);

    // On-Chain Analytics State (NEW)
    const [onChainEnabled, setOnChainEnabled] = useState<boolean>(true);
    const [onChainSignals, setOnChainSignals] = useState<OnChainSignals | null>(null);

    // Exchange State (Kraken/Crypto.com)
    const [currentExchange, setCurrentExchange] = useState<string>('crypto.com');
    const [currentExchangeFees, setCurrentExchangeFees] = useState<{ takerFee: number; roundTripFee: number }>({
        takerFee: TRADING_FEES.TAKER_FEE_PERCENT,
        roundTripFee: TRADING_FEES.ROUND_TRIP_FEE_PERCENT,
    });

    // Risk Metrics & Kelly State (NEW)
    const [riskMetricsEnabled, setRiskMetricsEnabled] = useState<boolean>(true);
    const [riskMetrics, setRiskMetrics] = useState<RiskMetrics | null>(null);
    const [kellyResult, setKellyResult] = useState<KellyResult | null>(null);
    const [monteCarloResult, setMonteCarloResult] = useState<MonteCarloResult | null>(null);
    const [isRunningMonteCarlo, setIsRunningMonteCarlo] = useState<boolean>(false);

    const [pendingTrade, setPendingTrade] = useState<any>(null);
    const [predictionData, setPredictionData] = useState<any>(null);

    // ============================================
    // REFS (For avoiding stale closures in intervals)
    // ============================================
    const ws = useRef<WebSocket | null>(null);
    const watchlistDataRef = useRef<WatchlistData>({});
    const portfolioRef = useRef<PortfolioState>(portfolio); // NEW: Real-time portfolio access
    const isBotActiveRef = useRef<boolean>(false); // NEW: Real-time bot state access
    const reconnectAttempts = useRef<number>(0);
    const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
    const availableTickersRef = useRef<string[]>([]); // NEW: Cache available tickers
    const sessionDurationRef = useRef<number>(0);

    // Keep refs in sync with state
    useEffect(() => {
        portfolioRef.current = portfolio;
    }, [portfolio]);

    useEffect(() => {
        isBotActiveRef.current = isBotActive;
    }, [isBotActive]);

    useEffect(() => {
        sessionDurationRef.current = sessionDurationMinutes;
    }, [sessionDurationMinutes]);

    // Fetch current exchange info on mount
    useEffect(() => {
        fetch('/api/exchange/current')
            .then(r => r.json())
            .then(data => {
                if (data.exchange) {
                    setCurrentExchange(data.exchange);
                    setMarketServiceExchange(data.exchange);
                }
                if (data.feePercent) setCurrentExchangeFees({
                    takerFee: data.feePercent,
                    roundTripFee: data.roundTripFeePercent || data.feePercent * 2,
                });
            })
            .catch(() => { /* Backend not running yet, use defaults */ });
    }, []);

    // ============================================
    // LOGGING HELPERS
    // ============================================
    const addLog = useCallback((message: string, type: SystemEvent['type'] = 'INFO') => {
        setSystemLog(prev => [
            { id: Date.now() + Math.random(), time: Date.now(), message, type },
            ...prev
        ].slice(0, SYSTEM_LIMITS.MAX_LOG_ENTRIES));
    }, []);

    const addTrade = useCallback((trade: Omit<Trade, 'id' | 'time'>) => {
        const newTrade: Trade = {
            ...trade,
            id: Date.now() + Math.random(),
            time: Date.now()
        };
        setTrades(prev => [newTrade, ...prev].slice(0, SYSTEM_LIMITS.MAX_TRADE_HISTORY));
        return newTrade;
    }, []);

    // ============================================
    // RESTORE AI LEARNING FROM DATABASE ON MOUNT
    // ============================================
    useEffect(() => {
        restoreFromDatabase().then(result => {
            if (result.tradesLoaded > 0 || result.patternsLoaded > 0 || result.paramsRestored) {
                addLog(`AI Learning restored from previous sessions: ${result.tradesLoaded} trades, ${result.patternsLoaded} patterns, params=${result.paramsRestored}`, 'SPECIAL');
            }
        }).catch(err => {
            addLog(`AI Learning restore failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'ERROR');
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ============================================
    // INDICATOR CALCULATION
    // ============================================
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
            lastUpdated: Date.now()
        };
    }, []);

    // ============================================
    // WEBSOCKET WITH RECONNECTION (Fixed)
    // ============================================
    const connectWebSocket = useCallback((tickers: string[]) => {
        if (ws.current) {
            ws.current.onclose = null; // Prevent reconnection loops during intentional close
            ws.current.close();
            ws.current = null;
        }

        const connect = () => {
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            
            addLog(`Connecting to market data stream (attempt ${reconnectAttempts.current + 1})...`);

            const socket = new WebSocket(WEBSOCKET_CONFIG.URL);
            ws.current = socket;

            socket.onopen = () => {
                if (ws.current !== socket) return;

                addLog('Market data stream connected (via backend relay).');
                reconnectAttempts.current = 0;
                // No auth or subscribe needed - backend handles Crypto.com connection
                // and relays all candlestick/trade data automatically
            };

            socket.onmessage = (event) => {
                if (ws.current !== socket) return;
                
                const message = JSON.parse(event.data);

                if (message.method === 'public/heartbeat') {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            id: message.id,
                            method: 'public/respond-heartbeat'
                        }));
                    }
                    return;
                }

                // Handle both 'candlestick' (Exchange API) and 'kline' (older API) channels
                const channel = message.result?.channel || '';
                if (message.method === 'subscribe' && (channel.startsWith('candlestick') || channel === 'kline')) {
                    const instrument = message.result.instrument_name;
                    const candleData = message.result.data?.[0];
                    if (!candleData || !instrument) return;

                    const symbol = instrument.replace('_', '');
                    const newCandle: Candle = {
                        time: candleData.t,
                        open: parseFloat(candleData.o),
                        high: parseFloat(candleData.h),
                        low: parseFloat(candleData.l),
                        close: parseFloat(candleData.c),
                        volume: parseFloat(candleData.v),
                    };

                    const currentData = watchlistDataRef.current[symbol];
                    if (currentData) {
                        let updatedCandles = [...currentData.candles];

                        // Update existing candle or add new one
                        if (updatedCandles.length > 0 && updatedCandles.at(-1)!.time === newCandle.time) {
                            updatedCandles[updatedCandles.length - 1] = newCandle;
                        } else {
                            updatedCandles = [...updatedCandles.slice(1), newCandle];
                        }

                        // Only recalculate if data actually changed
                        const lastCandle = currentData.candles.at(-1);
                        if (!lastCandle || lastCandle.close !== newCandle.close || lastCandle.time !== newCandle.time) {
                            watchlistDataRef.current[symbol] = updateWatchlistData(updatedCandles, symbol);
                        }
                    }
                }
            };

            socket.onerror = (wsError) => {
                if (ws.current !== socket) return;
                console.error('WebSocket Error:', wsError);
                addLog('Market data stream error.', 'ERROR');
            };

            socket.onclose = () => {
                if (ws.current !== socket) return;
                
                // Only log disconnection on first few attempts to reduce spam
                if (reconnectAttempts.current < 3) {
                    addLog('Market data stream disconnected.', 'INFO');
                }

                // Exponential backoff reconnection
                if (reconnectAttempts.current < WEBSOCKET_CONFIG.RECONNECT_MAX_ATTEMPTS) {
                    const delay = Math.min(
                        WEBSOCKET_CONFIG.RECONNECT_INITIAL_DELAY_MS * Math.pow(2, reconnectAttempts.current),
                        WEBSOCKET_CONFIG.RECONNECT_MAX_DELAY_MS
                    );
                    reconnectAttempts.current++;

                    // Only log first few reconnection attempts
                    if (reconnectAttempts.current <= 3) {
                        addLog(`Reconnecting in ${delay / 1000}s...`, 'INFO');
                    }

                    reconnectTimeout.current = setTimeout(() => {
                        connect();
                    }, delay);
                } else {
                    // Don't set error - just switch to REST polling mode silently
                    addLog('WebSocket unavailable. Using REST polling for market data.', 'INFO');
                }
            };
        };

        connect();
    }, [addLog, updateWatchlistData]);

    // ============================================
    // MARKET DATA SETUP
    // ============================================
    useEffect(() => {
        if (!isTradingActive) return; // <-- FIX: Only run when trading is active

        const setupMarketData = async () => {
            setIsLoading(true);
            setError(null);

            try {
                addLog('Fetching available markets from /api/instruments...');
                let availableTickers = await fetchAvailableUsdPairs();
                
                // Limit to a manageable number for initial UI load (e.g. 12)
                // The backend scanner handles the full universe
                availableTickers = availableTickers.slice(0, 12);
                
                availableTickersRef.current = availableTickers;
                addLog(`Found ${availableTickers.length} active markets for initialization. Initializing...`);

                const initialWatchlistData: WatchlistData = {};
                const failedTickers: string[] = [];
                let successfulFetches = 0;
                let firstSuccessfulTicker: string | null = null;

                for (const currentTicker of availableTickers) {
                    try {
                        addLog(`Fetching initial 1m candles for ${currentTicker}...`);
                        const candles = await fetchHistoricalCandles(currentTicker, '1m', INDICATOR_PARAMS.MAX_CANDLES_STORED);

                        if (candles.length > 0) {
                            initialWatchlistData[currentTicker] = updateWatchlistData(candles, currentTicker);
                            successfulFetches++;

                            if (!firstSuccessfulTicker) {
                                firstSuccessfulTicker = currentTicker;
                            }
                        } else {
                            addLog(`No candle data returned for ${currentTicker}, skipping.`, 'INFO');
                            failedTickers.push(currentTicker);
                        }
                    } catch (e: unknown) {
                        const errorMsg = `Failed to fetch initial data for ${currentTicker}: ${e instanceof Error ? e.message : 'Unknown error'}`;
                        console.error(errorMsg);
                        addLog(errorMsg, 'ERROR');
                        failedTickers.push(currentTicker);
                    }

                    await new Promise(resolve => setTimeout(resolve, INTERVALS.API_THROTTLE_MS));
                }

                if (successfulFetches === 0) {
                    throw new Error("Failed to fetch market data for all tickers. Backend proxy might be down or API is unresponsive.");
                }
                
                watchlistDataRef.current = initialWatchlistData;

                // Use the pre-selected ticker from controls, or the first successful one
                const startTicker = ticker || firstSuccessfulTicker;
                if (startTicker && initialWatchlistData[startTicker]) {
                    setTicker(startTicker);
                    setActiveWatchlistData(initialWatchlistData[startTicker]);
                } else if (firstSuccessfulTicker) {
                    setTicker(firstSuccessfulTicker);
                    setActiveWatchlistData(initialWatchlistData[firstSuccessfulTicker]);
                }

                addLog(`Initialized historical data for ${successfulFetches}/${availableTickers.length} tickers.`);

                if (failedTickers.length > 0) {
                    addLog(`Could not initialize: ${failedTickers.join(', ')}.`, 'ERROR');
                }

                // Connect WebSocket with reconnection logic
                connectWebSocket(Object.keys(initialWatchlistData));

            } catch (e: unknown) {
                console.error("Failed to setup market data:", e);
                const errorMsg = `Critical setup failure: ${e instanceof Error ? e.message : 'Unknown error'}`;
                setError(errorMsg);
                addLog(errorMsg, 'ERROR');
            } finally {
                setIsLoading(false);
            }
        };

        setupMarketData();

        return () => {
            if (ws.current) {
                ws.current.onclose = null;
                ws.current.close();
            }
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
        };
    }, [isTradingActive, addLog, connectWebSocket, updateWatchlistData, ticker]);


    // ============================================
    // UI REFRESH (Optimized to avoid unnecessary re-renders)
    // ============================================
    useEffect(() => {
        const interval = setInterval(() => {
            const newData = watchlistDataRef.current[ticker];
            if (newData && newData.lastUpdated !== activeWatchlistData?.lastUpdated) {
                setActiveWatchlistData(newData);
            }
        }, INTERVALS.UI_REFRESH_MS);

        return () => clearInterval(interval);
    }, [ticker, activeWatchlistData?.lastUpdated]);

    useEffect(() => {
        if (!activeWatchlistData || activeWatchlistData.candles.length === 0) return;

        // Mock prediction data based on indicators
        const tcValue = activeWatchlistData.indicatorData.at(-1)?.value ?? 50;
        const momValue = activeWatchlistData.momentumData.at(-1)?.value ?? 50;
        const price = activeWatchlistData.candles.at(-1)?.close ?? 0;

        setPredictionData({
            ticker,
            horizons: {
                '1h': { direction: tcValue < 45 ? 'UP' : tcValue > 55 ? 'DOWN' : 'SIDEWAYS', confidence: 75 },
                '4h': { direction: momValue > 55 ? 'UP' : momValue < 45 ? 'DOWN' : 'SIDEWAYS', confidence: 60 },
                '24h': { direction: 'UP', confidence: 45 }
            },
            levels: {
                support: price * 0.98,
                resistance: price * 1.02
            },
            regime: marketRegime?.trend || 'SIDEWAYS',
            factors: [
                { name: 'Technical', impact: (50 - tcValue) },
                { name: 'Momentum', impact: (momValue - 50) },
                { name: 'Sentiment', impact: 20 }
            ]
        });
    }, [ticker, activeWatchlistData, marketRegime]);

    // ============================================
    // ADAPTIVE DATA CALCULATION
    // ============================================
    useEffect(() => {
        if (!activeWatchlistData || activeWatchlistData.candles.length === 0) return;

        const adaptive = calculateAdaptiveData(activeWatchlistData.candles, ticker);
        setAdaptiveData(adaptive);
    }, [ticker, activeWatchlistData]);

    // ============================================
    // ASSET INTELLIGENCE: Profile & Sentiment Updates
    // ============================================
    useEffect(() => {
        if (!assetIntelligenceEnabled || !ticker) return;

        // Update asset profile immediately
        const profile = getAssetProfile(ticker);
        setCurrentAssetProfile(profile);

        // Fetch sentiment asynchronously
        if (isTradingActive) {
            fetchSocialSentiment(ticker).then(sentiment => {
                setCurrentSentiment(sentiment);
                if (sentiment && Math.random() < 0.3) {
                    addLog(`Sentiment for ${ticker}: ${sentiment.overallSentiment} (score: ${sentiment.sentimentScore})`, 'INFO');
                }
            }).catch(() => {
                // Silently fail - sentiment is optional
            });
        }
    }, [ticker, assetIntelligenceEnabled, isTradingActive, addLog]);

    // ============================================
    // ASSET INTELLIGENCE: Ranking Update (for auto-pair selection)
    // ============================================
    useEffect(() => {
        if (!assetIntelligenceEnabled || !isTradingActive || !marketRegime) return;

        const availableAssets = Object.keys(watchlistDataRef.current);
        const volatilityLevel = marketRegime.volatility as 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
        const ranking = getBestAssetsForMarket(volatilityLevel, availableAssets);
        setAssetRanking(ranking);

        // Log best assets occasionally
        if (ranking.length > 0 && Math.random() < 0.1) {
            const top3 = ranking.slice(0, 3).map(r => `${r.symbol}(${r.score})`).join(', ');
            addLog(`Asset Intelligence: Best assets for ${volatilityLevel} market: ${top3}`, 'INFO');
        }
    }, [assetIntelligenceEnabled, isTradingActive, marketRegime, addLog]);

    // ============================================
    // VOLATILITY METHODS: Ensemble Calculation
    // ============================================
    useEffect(() => {
        if (!volatilityAnalysisEnabled || !isTradingActive || !activeWatchlistData) return;

        const candles = activeWatchlistData.candles;
        if (candles.length < 30) return;

        // Calculate ensemble volatility
        const ensemble = calculateEnsembleVolatility(candles, 20);
        setEnsembleVolatility(ensemble);

        // Detect volatility expansion/contraction
        const expansion = detectVolatilityExpansion(candles, 5, 20);
        setVolatilityExpansion(expansion);

        // Log significant changes
        if (Math.random() < 0.05) {
            const volStrategy = (['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'] as const).includes(strategy as any) ? strategy as 'TREND' | 'BREAKOUT' | 'WHALE' | 'CONFLUENCE' | 'MOMENTUM' | 'DIVERGENCE' | 'ADAPTIVE' : 'ADAPTIVE';
            const bestMethod = getBestVolatilityMethodForStrategy(volStrategy);
            addLog(`Volatility: ${ensemble.consensus} (${ensemble.average.toFixed(0)}%) | Best: ${bestMethod.primary} | ${expansion.signal}`, 'INFO');
        }
    }, [volatilityAnalysisEnabled, isTradingActive, activeWatchlistData, strategy, addLog]);

    // ============================================
    // ENHANCED SENTIMENT: Signal Calculation
    // ============================================
    useEffect(() => {
        if (!enhancedSentimentEnabled || !isTradingActive || !activeWatchlistData) return;

        const candles = activeWatchlistData.candles;
        if (candles.length < 20) return;

        // Calculate sentiment from market data
        const signal = calculateSentimentFromMarketData(candles, ticker);
        setSentimentSignal(signal);

        // Detect sentiment bursts
        const correlatedAssets = getCorrelatedMemeAssets(ticker);
        const burst = detectSentimentBurst(signal, correlatedAssets);
        setSentimentBurst(burst);

        // Log burst detection
        if (burst.detected && burst.magnitude > 50) {
            addLog(`Sentiment Burst: ${burst.burstType} on ${ticker} (${burst.magnitude.toFixed(0)}%) - ${burst.recommendedAction}`, 'SPECIAL');
        }

        // Calculate market-wide regime periodically
        if (Math.random() < 0.1) {
            const allSentiments: SentimentSignal[] = [];
            for (const t of Object.keys(watchlistDataRef.current)) {
                const data = watchlistDataRef.current[t];
                if (data && data.candles.length > 20) {
                    allSentiments.push(calculateSentimentFromMarketData(data.candles, t));
                }
            }
            if (allSentiments.length > 0) {
                const regime = detectSentimentRegime(allSentiments, 0);
                setSentimentRegime(regime);
            }
        }
    }, [enhancedSentimentEnabled, isTradingActive, activeWatchlistData, ticker, addLog]);

    // ============================================
    // ON-CHAIN ANALYTICS: Signal Calculation
    // ============================================
    useEffect(() => {
        if (!onChainEnabled || !isTradingActive || !activeWatchlistData) return;

        const candles = activeWatchlistData.candles;
        if (candles.length < 50) return;

        const signals = calculateOnChainSignals(candles, ticker);
        setOnChainSignals(signals);

        // Log significant on-chain signals
        if (Math.random() < 0.05 && signals.overallSignal !== 'NEUTRAL') {
            addLog(`On-Chain: ${signals.overallSignal} | Whale: ${signals.whaleActivity.type} | Flow: ${signals.exchangeFlow.netFlow}`, 'INFO');
        }
    }, [onChainEnabled, isTradingActive, activeWatchlistData, ticker, addLog]);

    // ============================================
    // RISK METRICS: Calculation
    // ============================================
    useEffect(() => {
        if (!riskMetricsEnabled || !isTradingActive) return;

        const calculateMetrics = () => {
            const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce((sum, pos) => {
                const price = watchlistDataRef.current[pos.ticker]?.candles?.at(-1)?.close ?? pos.openPrice;
                return sum + (pos.quantity * price);
            }, 0);

            // Calculate risk metrics
            const metrics = calculateRiskMetrics(trades, totalValue, portfolio.initialBudget);
            setRiskMetrics(metrics);

            // Calculate Kelly criterion
            const kelly = calculateKellyCriterion(trades, 10);
            setKellyResult(kelly);

            // Log significant risk changes
            if (metrics.streakRisk === 'CRITICAL' || metrics.streakRisk === 'HIGH') {
                if (Math.random() < 0.1) {
                    addLog(`Risk Alert: ${metrics.streakRisk} streak risk | DD: ${metrics.currentDrawdown.toFixed(1)}% | Streak: ${metrics.currentStreak}`, 'ERROR');
                }
            }
        };

        // Calculate immediately
        calculateMetrics();

        // Then every 5 seconds
        const interval = setInterval(calculateMetrics, 5000);

        return () => clearInterval(interval);
    }, [riskMetricsEnabled, isTradingActive, trades, portfolio, addLog]);

    // Monte Carlo handler
    const handleRunMonteCarlo = useCallback(() => {
        if (isRunningMonteCarlo) return;
        setIsRunningMonteCarlo(true);

        // Run async to not block UI
        setTimeout(() => {
            const result = runMonteCarloSimulation(trades, portfolio.initialBudget, 100, 1000);
            setMonteCarloResult(result);
            setIsRunningMonteCarlo(false);
            addLog(`Monte Carlo: Median ${result.medianOutcome.toFixed(0)} | Ruin Risk: ${result.ruinProbability.toFixed(1)}%`, 'INFO');
        }, 100);
    }, [trades, portfolio.initialBudget, isRunningMonteCarlo, addLog]);

    // ============================================
    // MULTI-ASSET ANALYSIS (runs periodically)
    // ============================================
    useEffect(() => {
        if (!isTradingActive) return;

        const calculateAnalysis = () => {
            const watchlistData = watchlistDataRef.current;
            if (Object.keys(watchlistData).length > 0) {
                const analysis = calculateMultiAssetAnalysis(watchlistData);
                setMultiAssetAnalysis(analysis);
            }
        };

        // Calculate immediately
        calculateAnalysis();

        // Then every 30 seconds
        const interval = setInterval(calculateAnalysis, 30000);

        return () => clearInterval(interval);
    }, [isTradingActive]);

    // ============================================
    // REST POLLING FOR MARKET DATA (Fallback when WebSocket fails)
    // ============================================
    useEffect(() => {
        if (!isTradingActive) return;

        const pollMarketData = async () => {
            const tickers = Object.keys(watchlistDataRef.current);
            if (tickers.length === 0) return;

            // Poll a subset of tickers each cycle to avoid rate limiting
            const tickersPerCycle = 5;
            const cycleIndex = Math.floor(Date.now() / 10000) % Math.ceil(tickers.length / tickersPerCycle);
            const tickersToUpdate = tickers.slice(
                cycleIndex * tickersPerCycle,
                (cycleIndex + 1) * tickersPerCycle
            );

            for (const tickerSymbol of tickersToUpdate) {
                try {
                    const candles = await fetchHistoricalCandles(tickerSymbol, '1m', 50);
                    if (candles.length > 0) {
                        const currentData = watchlistDataRef.current[tickerSymbol];
                        if (currentData) {
                            // Merge new candles with existing data
                            const existingTimes = new Set(currentData.candles.map(c => c.time));
                            const newCandles = candles.filter(c => !existingTimes.has(c.time));

                            if (newCandles.length > 0 || candles.at(-1)?.close !== currentData.candles.at(-1)?.close) {
                                const mergedCandles = [...currentData.candles];
                                // Update the last candle if it has the same timestamp
                                const latestCandle = candles.at(-1);
                                if (latestCandle && mergedCandles.at(-1)?.time === latestCandle.time) {
                                    mergedCandles[mergedCandles.length - 1] = latestCandle;
                                } else if (latestCandle) {
                                    mergedCandles.push(latestCandle);
                                }
                                // Keep only the latest candles
                                const trimmedCandles = mergedCandles.slice(-INDICATOR_PARAMS.MAX_CANDLES_STORED);
                                watchlistDataRef.current[tickerSymbol] = updateWatchlistData(trimmedCandles, tickerSymbol);
                            }
                        }
                    }
                } catch (err) {
                    // Silently ignore polling errors for individual tickers
                    console.debug(`Polling error for ${tickerSymbol}:`, err);
                }
                // Small delay between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        };

        // Poll every 10 seconds
        const pollInterval = setInterval(pollMarketData, 10000);

        // Initial poll after a short delay
        const initialPoll = setTimeout(pollMarketData, 2000);

        return () => {
            clearInterval(pollInterval);
            clearTimeout(initialPoll);
        };
    }, [isTradingActive, updateWatchlistData]);

    // ============================================
    // MULTI-TIMEFRAME DATA
    // ============================================
    useEffect(() => {
        if (!ticker || !isTradingActive) return;

        const fetchMtfData = async () => {
            setIsMtfLoading(true);
            try {
                const timeframes = Object.values(TIME_FRAMES_MAP);
                const promises = timeframes.map(tf => fetchHistoricalCandles(ticker, tf, INDICATOR_PARAMS.MAX_CANDLES_STORED));
                const results = await Promise.all(promises);

                const newMtfData: MTFData = {};
                Object.keys(TIME_FRAMES_MAP).forEach((tfDisplay, index) => {
                    const series = calculateTCSeries(results[index]);
                    newMtfData[tfDisplay] = series.length > 0 ? series.at(-1) ?? 50 : 50;
                });
                setMtfData(newMtfData);
            } catch (e: unknown) {
                addLog(`Failed to load MTF data for ${ticker}: ${e instanceof Error ? e.message : 'Unknown error'}`, 'ERROR');
            } finally {
                setIsMtfLoading(false);
            }
        };

        fetchMtfData();
    }, [ticker, isTradingActive, addLog]);

    // ============================================
    // MARKET SCANNER (Fixed memory leak)
    // ============================================
    useEffect(() => {
        if (!isScannerActive || !isTradingActive) return;

        const scannerInterval = setInterval(() => {
            const currentPortfolio = portfolioRef.current;
            const hasOpenPositions = Object.keys(currentPortfolio.positions).length > 0;

            // Only log pause once
            if (hasOpenPositions) {
                if (!scannerPaused) {
                    setScannerPaused(true);
                    setScannerInsights(null);
                    addLog('Scanner paused: Positions are currently open.', 'INFO');
                }
                return;
            }

            if (scannerPaused) {
                setScannerPaused(false);
            }

            addLog('Scanner: Analyzing market for signals...', 'INFO');
            const insights: ScannerInsights = {
                TREND: [], BREAKOUT: [], WHALE: [], CONFLUENCE: [], MOMENTUM: [], DIVERGENCE: [], ADAPTIVE: []
            };

            for (const asset of Object.keys(watchlistDataRef.current)) {
                const data = watchlistDataRef.current[asset];
                if (data && data.indicatorData.length > 0) {
                    const tcValue = data.indicatorData.at(-1)?.value ?? 50;
                    const breakoutValue = data.breakoutData.at(-1)?.value ?? 50;
                    const whaleValue = data.whaleData.at(-1)?.value ?? 50;
                    const momentumValue = data.momentumData.at(-1)?.value ?? 50;
                    const confluenceScore = data.trendDashboardData.score;
                    const divergenceConfidence = data.divergenceData.confidence;

                    insights.TREND.push({ ticker: asset, value: tcValue, score: 0 });
                    insights.BREAKOUT.push({ ticker: asset, value: breakoutValue, score: 0 });
                    insights.WHALE.push({ ticker: asset, value: whaleValue, score: 0 });
                    insights.MOMENTUM.push({ ticker: asset, value: momentumValue, score: 0 });
                    insights.CONFLUENCE.push({ ticker: asset, value: 0, score: confluenceScore });
                    insights.DIVERGENCE.push({
                        ticker: asset,
                        value: data.divergenceData.type === 'bullish' ? divergenceConfidence : -divergenceConfidence,
                        score: divergenceConfidence
                    });

                    // ADAPTIVE (uses adaptive TC value)
                    const adaptiveValue = data.adaptiveData?.at(-1)?.value ?? tcValue;
                    insights.ADAPTIVE.push({ ticker: asset, value: adaptiveValue, score: 100 - adaptiveValue });
                }
            }

            // Sort by strategy-specific criteria
            insights.TREND.sort((a, b) => a.value - b.value); // Lower TC = more bullish
            insights.BREAKOUT.sort((a, b) => a.value - b.value); // Lower = squeeze
            insights.WHALE.sort((a, b) => b.value - a.value); // Higher = buying
            insights.MOMENTUM.sort((a, b) => b.value - a.value); // Higher = momentum
            insights.CONFLUENCE.sort((a, b) => b.score - a.score); // Higher score = more bullish
            insights.DIVERGENCE.sort((a, b) => b.value - a.value); // Higher = bullish divergence
            insights.ADAPTIVE.sort((a, b) => a.value - b.value); // Lower = more bullish (like TC)

            setScannerInsights(insights);

            const bestSignal = insights[strategy]?.[0];
            if (bestSignal && bestSignal.ticker !== ticker) {
                setTicker(bestSignal.ticker);
                addLog(`Scanner switched active asset to ${bestSignal.ticker} for optimal ${strategy} signal.`, 'SPECIAL');
            }
        }, INTERVALS.SCANNER_INTERVAL_MS);

        return () => clearInterval(scannerInterval);
    }, [isScannerActive, isTradingActive, ticker, strategy, addLog, scannerPaused]);

    // ============================================
    // BACKEND POLLING LOOP (Phase 1: All trading runs on backend)
    // Frontend is now read-only dashboard polling /api/session/full-status
    // ============================================
    useEffect(() => {
        if (!isBotActive || !isTradingActive) return;

        // Poll backend every 2 seconds for full status
        const pollInterval = 2000;

        const pollBackend = async () => {
            try {
                const res = await fetch('/api/session/full-status');
                if (!res.ok) return;
                const data = await res.json();

                // Update portfolio from backend
                if (data.portfolio) {
                    setPortfolio({
                        cash: data.portfolio.cash,
                        initialBudget: data.portfolio.initialBudget,
                        positions: data.portfolio.positions.reduce((acc: any, pos: any) => {
                            acc[pos.ticker] = {
                                quantity: pos.quantity,
                                openPrice: pos.openPrice,
                                currentPrice: pos.currentPrice,
                                entryStrategy: pos.entryStrategy,
                                entryTime: pos.entryTime,
                                highestPrice: pos.highestPrice,
                                lowestPrice: pos.lowestPrice,
                                unrealizedPnl: pos.unrealizedPnl,
                            };
                            return acc;
                        }, {}),
                    });
                }

                // Update logs from backend
                if (data.logs && data.logs.length > 0) {
                    setSystemLog(prev => {
                        const existingIds = new Set(prev.map((l: any) => l.id));
                        const newLogs = data.logs.filter((l: any) => !existingIds.has(l.id));
                        return newLogs.length > 0 ? [...newLogs, ...prev].slice(0, 200) : prev;
                    });
                }

                // Check if bot was stopped externally
                if (!data.sessionActive && isBotActiveRef.current) {
                    setIsBotActive(false);
                    addLog('Session ended on backend', 'WARN');
                }
            } catch (e) {
                // Silently handle polling errors
            }
        };

        // Initial poll
        pollBackend();
        const botInterval = setInterval(pollBackend, pollInterval);

        return () => clearInterval(botInterval);
    }, [isBotActive, isTradingActive, addLog]);



    const handleStartSimulation = async (budget: number, selectedTicker: string) => {
        addLog(`Starting SIMULATION session with $${budget} for ${selectedTicker}`);
        try {
            const res = await fetch('/api/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'SIMULATION', budget, tickers: [selectedTicker] }),
            });
            const data = await res.json();
            if (data.success) {
                setPortfolio({
                    cash: data.budget,
                    initialBudget: data.budget,
                    positions: {},
                });
                setTicker(selectedTicker);
                setTrades([]);
                resetEquityTracking();
                setSessionStartTime(Date.now());
                setIsTradingActive(true);
                setIsBotActive(true);
                addLog(`Backend session started: ${data.sessionId}`, 'SPECIAL');
            } else {
                addLog(`Failed to start session: ${data.error}`, 'ERROR');
            }
        } catch (e: any) {
            addLog(`Session start error: ${e.message}`, 'ERROR');
            // Fallback: still start locally
            setPortfolio({ cash: budget, initialBudget: budget, positions: {} });
            setTicker(selectedTicker);
            setTrades([]);
            resetEquityTracking();
            setSessionStartTime(Date.now());
            setIsTradingActive(true);
        }
    };

    const handleAuthenticate = async (creds: ApiCredentials) => {
        try {
            addLog('Authenticating with backend...');
            const success = await tradingBotService.login(creds);
            if (success) {
                addLog('Real trading account authenticated successfully.', 'SPECIAL');
                setIsApiAuthenticated(true);
                setIsAuthModalOpen(false);
                // Maybe auto-start bot or fetch positions here
            } else {
                throw new Error('Authentication failed. Please check your API keys.');
            }
        } catch (err: any) {
            addLog(err.message, 'ERROR');
        }
    };

    const handleCloseAllPositions = async () => {
        addLog('Stopping session and closing all positions...', 'WARN');
        try {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPortfolio({
                    cash: data.finalCash || 0,
                    initialBudget: data.initialBudget || portfolio.initialBudget,
                    positions: {},
                });
                setIsBotActive(false);
                addLog(`Session stopped. Final: $${data.finalCash?.toFixed(2)} (${data.pnlPercent}%)`, 'SPECIAL');
                if (data.closedPositions?.length > 0) {
                    data.closedPositions.forEach((p: any) => {
                        addLog(`Closed ${p.ticker}: PnL $${p.pnl?.toFixed(2)}`, 'SELL');
                    });
                }
            }
        } catch (e: any) {
            addLog(`Stop session error: ${e.message}`, 'ERROR');
        }
    };


    const handleStopSession = async () => {
        addLog('Stopping entire session...', 'WARN');
        try {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPortfolio({
                    cash: 0,
                    initialBudget: 0,
                    positions: {},
                });
                setIsBotActive(false);
                setIsTradingActive(false);
                addLog(`Session ended. Final value: $${data.finalCash?.toFixed(2)} | PnL: ${data.pnlPercent}% | Trades: ${data.totalTrades || 0}`, 'SPECIAL');
            }
        } catch (e: any) {
            addLog(`Stop session error: ${e.message}`, 'ERROR');
        }
    };

    const toggleBot = async (isActive: boolean) => {
        if (isActive && tradingMode === 'REAL' && !isApiAuthenticated) {
            addLog('Cannot start real trading bot without API authentication.', 'ERROR');
            setIsAuthModalOpen(true);
            return;
        }

        try {
            if (isActive) {
                // Resume if paused, or start new session
                const res = await fetch('/api/session/resume', { method: 'POST' });
                const data = await res.json();
                setIsBotActive(data.botActive);
                addLog(`Auto-trading bot has been ACTIVATED. Mode: ${tradingMode}.`, 'SPECIAL');
                if (!sessionStartTime) {
                    setSessionStartTime(Date.now());
                    resetEquityTracking();
                }
            } else {
                const res = await fetch('/api/session/pause', { method: 'POST' });
                const data = await res.json();
                setIsBotActive(data.botActive);
                addLog('Auto-trading bot has been PAUSED.', 'WARN');
            }
        } catch (e: any) {
            addLog(`Bot toggle error: ${e.message}`, 'ERROR');
            // Fallback
            setIsBotActive(isActive);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
                <div className="text-center">
                    <div className="text-2xl">Initializing market data stream...</div>
                    <div className="text-xs text-gray-400 mt-4 max-w-md">
                        Disclaimer: This is a simulation. Real trading involves significant risk. Not financial advice.
                    </div>
                </div>
            </div>
        )
    }

    if (error) {
        return <div className="flex items-center justify-center h-screen bg-red-900/50 text-white p-8">
            <div className="text-center">
                <h2 className="text-2xl font-bold mb-4 text-red-300">Application Error</h2>
                <p className="text-lg text-red-200">{error}</p>
                 <button onClick={() => window.location.reload()} className="mt-6 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded">
                    Reload Application
                </button>
            </div>
        </div>
    }

    return (
        <div className="min-h-screen bg-gray-900 text-white font-sans">
            {isAuthModalOpen && (
                <RealTradingModal
                    onClose={() => setIsAuthModalOpen(false)}
                    onAuthenticate={handleAuthenticate}
                />
            )}

            {/* Navigation Bar */}
            <nav className="flex items-center justify-between px-4 py-2 border-b border-gray-700/50 bg-gray-900/80">
                <div className="flex items-center gap-3">
                    {[
                        { href: '/', label: 'Crypto', active: true },
                        { href: '/stocks', label: 'Stocks' },
                        { href: '/performance', label: 'Performance' },
                        { href: '/backtest', label: 'Backtest' },
                        { href: '/replay', label: 'Replay' },
                    ].map(link => (
                        <a key={link.href} href={link.href}
                            className={`text-xs px-2 py-1 rounded ${link.active ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}>
                            {link.label}
                        </a>
                    ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-500">
                    {isBotActive && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />Bot Active</span>}
                    <span>{Object.keys(portfolio.positions).length} positions</span>
                </div>
            </nav>

            {/* Main grid */}
            <main className="grid grid-cols-1 lg:grid-cols-12 gap-4 p-4">
                {/* Left Column */}
                <div className="lg:col-span-3 space-y-4">
                    <ExchangeSelector
                        currentExchange={currentExchange}
                        onExchangeChange={(exchange, fees) => {
                            setCurrentExchange(exchange);
                            setCurrentExchangeFees(fees);
                            setMarketServiceExchange(exchange);
                        }}
                    />
                    <TradingControls
                        onStart={handleStartSimulation}
                        activeTicker={ticker}
                        isTradingActive={isTradingActive}
                        strategy={strategy}
                        setStrategy={setStrategy}
                        isBotActive={isBotActive}
                        toggleBot={toggleBot}
                        addLog={addLog}
                        isScannerActive={isScannerActive}
                        setIsScannerActive={setIsScannerActive}
                        riskAmount={riskAmount}
                        setRiskAmount={setRiskAmount}
                        tradingMode={tradingMode}
                        setTradingMode={setTradingMode}
                        isApiAuthenticated={isApiAuthenticated}
                        profitGoals={profitGoals}
                        setProfitGoals={(strat, val) => setProfitGoals(p => ({ ...p, [strat]: val }))}
                        sessionProfitGoal={sessionProfitGoal}
                        setSessionProfitGoal={setSessionProfitGoal}
                        maxConcurrentTrades={maxConcurrentTrades}
                        setMaxConcurrentTrades={setMaxConcurrentTrades}
                        stopLossPercent={stopLossPercent}
                        setStopLossPercent={setStopLossPercent}
                        trailingStopPercent={trailingStopPercent}
                        setTrailingStopPercent={setTrailingStopPercent}
                        useTrailingStop={useTrailingStop}
                        setUseTrailingStop={setUseTrailingStop}
                        availableTickers={availableTickersRef.current}
                        microTradingEnabled={microTradingEnabled}
                        setMicroTradingEnabled={setMicroTradingEnabled}
                        unlimitedTrades={unlimitedTrades}
                        setUnlimitedTrades={setUnlimitedTrades}
                        sessionDurationMinutes={sessionDurationMinutes}
                        setSessionDurationMinutes={setSessionDurationMinutes}
                        onCloseAll={handleCloseAllPositions}
                        onStopSession={handleStopSession}
                    />
                    <PortfolioSummary portfolio={portfolio} watchlistData={watchlistDataRef.current} />
                    <SessionSummary trades={trades} initialBudget={portfolio.initialBudget} />
                    <TradeHistory trades={trades} />
                </div>

                {/* Center Column */}
                <div className="lg:col-span-6 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <IndicatorGauge
                            label="Trend Clarity"
                            value={activeWatchlistData?.indicatorData.at(-1)?.value ?? null}
                            lower_threshold={SIGNAL_THRESHOLDS.TREND_BULLISH_ENTRY}
                            upper_threshold={SIGNAL_THRESHOLDS.TREND_BEARISH_EXIT}
                            higher_is_better={false}
                        />
                        <IndicatorGauge
                            label="Breakout Power"
                            value={activeWatchlistData?.breakoutData.at(-1)?.value ?? null}
                            lower_threshold={SIGNAL_THRESHOLDS.BREAKOUT_SQUEEZE_ENTRY}
                            upper_threshold={SIGNAL_THRESHOLDS.BREAKOUT_EXPANSION_EXIT}
                            higher_is_better={false}
                        />
                        <IndicatorGauge
                            label="Whale Money Flow"
                            value={activeWatchlistData?.whaleData.at(-1)?.value ?? null}
                            lower_threshold={SIGNAL_THRESHOLDS.WHALE_SELLING_EXIT}
                            upper_threshold={SIGNAL_THRESHOLDS.WHALE_BUYING_ENTRY}
                            higher_is_better={true}
                        />
                        <IndicatorGauge
                            label="Momentum"
                            value={activeWatchlistData?.momentumData.at(-1)?.value ?? null}
                            lower_threshold={50 - SIGNAL_THRESHOLDS.MOMENTUM_BEARISH_EXIT}
                            upper_threshold={50 + SIGNAL_THRESHOLDS.MOMENTUM_BULLISH_ENTRY}
                            higher_is_better={true}
                        />
                    </div>

                    {isTradingActive && activeWatchlistData && (
                        <IndicatorChart
                            candles={activeWatchlistData.candles}
                            tcSeries={activeWatchlistData.indicatorData}
                            breakoutSeries={activeWatchlistData.breakoutData}
                            whaleSeries={activeWatchlistData.whaleData}
                            momentumSeries={activeWatchlistData.momentumData}
                            divergenceData={activeWatchlistData.divergenceData}
                            srLevels={activeWatchlistData.srLevels}
                            volumeProfile={activeWatchlistData.volumeProfileData}
                            trades={trades.filter(t => t.ticker === ticker)}
                            bollingerBands={activeWatchlistData.bollingerBands}
                            vwap={activeWatchlistData.vwap}
                            ma50={activeWatchlistData.ma50}
                            ma200={activeWatchlistData.ma200}
                        />
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <SignalDisplay
                            trendDashboard={activeWatchlistData?.trendDashboardData}
                            adaptiveData={adaptiveData}
                        />
                        <ConfluenceDashboard
                            trendScore={activeWatchlistData?.trendDashboardData?.score ?? 0}
                            breakoutValue={activeWatchlistData?.breakoutData?.at(-1)?.value ?? 50}
                            whaleValue={activeWatchlistData?.whaleData?.at(-1)?.value ?? 50}
                            momentumValue={activeWatchlistData?.momentumData?.at(-1)?.value ?? 50}
                            signalScore={activeWatchlistData?.signalScore}
                        />
                    </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <AILearningPanel learningState={learningState} />
                        <AssetIntelligencePanel
                            profile={currentAssetProfile}
                            sentiment={currentSentiment}
                            ranking={assetRanking.slice(0, 5)}
                        />
                    </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                         <VolatilityPanel
                            ensemble={ensembleVolatility}
                            expansion={volatilityExpansion}
                         />
                         <RiskMetricsPanel
                             metrics={riskMetrics}
                             kelly={kellyResult}
                             monteCarlo={monteCarloResult}
                             onRunMonteCarlo={handleRunMonteCarlo}
                             isRunning={isRunningMonteCarlo}
                         />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <PredictiveDisplay data={predictionData} />
                        <NewsDashboard ticker={ticker} />
                    </div>
                    <MLDashboard ticker={ticker} />
                    <MLThoughtProcess pollInterval={2000} />
                </div>

                {/* Right Column */}
                <div className="lg:col-span-3 space-y-4">
                    <VPSMonitor pollInterval={3000} />
                    <MultiTimeframeDashboard data={mtfData} isLoading={isMtfLoading} />
                    <StrategyOverview data={activeWatchlistData} />
                    <SignalHeatMap watchlistData={watchlistDataRef.current} />
                    <MarketScanner insights={scannerInsights} activeTicker={ticker} onSelectTicker={setTicker} />
                    <SystemLog events={systemLog} />
                    <div className="space-y-4">
                        <TradeExplainer trade={trades.length > 0 ? trades[0] : null} />
                    </div>
                </div>
            </main>
        </div>
    );
};

export default App;
