
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
import { fetchHistoricalCandles, fetchAvailableUsdPairs } from './services/marketService';
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
                if (data.exchange) setCurrentExchange(data.exchange);
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
    // SIMULATION BOT LOOP (Fixed with refs and stop-loss)
    // ============================================
    useEffect(() => {
        if (!isBotActive || !isTradingActive || tradingMode !== 'SIMULATION') return;

        // Use fastest loop for surge trading, micro, or standard
        const loopInterval = SURGE_TRADING.SURGE_BOT_LOOP_MS; // Always 1 second for maximum responsiveness

        const botInterval = setInterval(() => {
            // Use refs to get current state (avoids stale closures)
            if (!isBotActiveRef.current) return;

            let currentPortfolio = { ...portfolioRef.current };
            const availableTickers = Object.keys(watchlistDataRef.current);

            // Wait for market data to load before running bot logic
            if (availableTickers.length === 0) {
                return;
            }

            // --- SESSION DURATION: Wind-down and force-close logic ---
            const durationMins = sessionDurationRef.current;
            if (durationMins > 0 && sessionStartTime > 0) {
                const sessionEndTime = sessionStartTime + (durationMins * 60 * 1000);
                const timeRemaining = sessionEndTime - Date.now();
                const windDownMs = Math.min(5 * 60 * 1000, durationMins * 60 * 1000 * 0.1); // 5 min or 10% of session

                // Force-close: session time expired
                if (timeRemaining <= 0) {
                    // Close ALL open positions at market price
                    for (const positionTicker of Object.keys(currentPortfolio.positions)) {
                        const position = currentPortfolio.positions[positionTicker];
                        const currentData = watchlistDataRef.current[positionTicker];
                        if (!currentData || currentData.candles.length === 0) continue;

                        const currentPrice = Number(currentData.candles.at(-1)!.close) || 0;
                        const pnl = (currentPrice - position.openPrice) * position.quantity;
                        const saleValue = position.quantity * currentPrice;

                        // Record trade via AI learning
                        if (aiLearningEnabled) {
                            const lastTcValue = currentData.indicatorData.at(-1)?.value ?? 50;
                            const lastMomentumValue = currentData.momentumData.at(-1)?.value ?? 50;
                            const lastWhaleValue = currentData.whaleData.at(-1)?.value ?? 50;
                            const lastConfluenceScore = currentData.trendDashboardData.score;

                            recordTrade({
                                ticker: positionTicker,
                                strategy: position.entryStrategy,
                                entryPrice: position.openPrice,
                                exitPrice: currentPrice,
                                entryTime: position.entryTime,
                                exitTime: Date.now(),
                                quantity: position.quantity,
                                indicators: {
                                    tcValue: lastTcValue,
                                    momentumValue: lastMomentumValue,
                                    whaleValue: lastWhaleValue,
                                    confluenceScore: lastConfluenceScore,
                                },
                                marketConditions: {
                                    volatility: 'MEDIUM',
                                    trend: 'SIDEWAYS',
                                    volume: 'MEDIUM',
                                }
                            });
                            setLearningStateData(getLearningState());
                        }

                        addLog(
                            `SESSION END: SELL ${Number(position.quantity).toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${positionTicker} @ ${Number(currentPrice).toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)}. PnL: $${Number(pnl).toFixed(2)}. Reason: Session time expired`,
                            'SELL'
                        );

                        addTrade({
                            type: 'SELL',
                            price: currentPrice,
                            quantity: position.quantity,
                            ticker: positionTicker,
                            strategy: position.entryStrategy,
                            reason: 'Session time expired',
                            pnl
                        });

                        currentPortfolio = {
                            ...currentPortfolio,
                            cash: currentPortfolio.cash + saleValue,
                            positions: {}
                        };
                    }

                    addLog(`Session completed after ${durationMins} minutes - all positions closed`, 'SPECIAL');
                    setPortfolio(currentPortfolio);
                    setIsBotActive(false);
                    return;
                }

                // Wind-down: approaching session end, stop opening new trades
                if (timeRemaining <= windDownMs) {
                    // Still process exits but skip entry logic
                    // Let the exit logic below run, then skip entries by returning early after exits
                }
            }

            // --- MICRO-TRADING: Detect slow market and apply micro parameters ---
            let isMicroMode = microTradingEnabled;
            let microStopLoss = MICRO_TRADING.MICRO_STOP_LOSS_PERCENT;
            let microProfitTarget = MICRO_TRADING.MICRO_PROFIT_TARGET_PERCENT;
            let microTrailingStop = MICRO_TRADING.MICRO_TRAILING_STOP_PERCENT;

            // --- SMART TRADING: Calculate Dynamic Parameters First ---
            let dynamicStopLossForExit = isMicroMode ? microStopLoss : stopLossPercent;

            // Slow market detection (available to both exit and entry logic)
            let isSlowMarket = false;
            let slowMarketResult: SlowMarketResult = { isSlow: false, avgRange: 0, consecutiveSmallCandles: 0 };

            if (smartTradingEnabled) {
                const primaryTicker = availableTickers.find(t => t.includes('BTC')) || availableTickers[0];
                const primaryData = watchlistDataRef.current[primaryTicker];

                if (primaryData && primaryData.candles.length > 20) {
                    const localRegime = detectMarketRegime(primaryData.candles);

                    // Detect slow market
                    if (SLOW_MARKET.ENABLED) {
                        slowMarketResult = detectSlowMarket(primaryData.candles);
                        isSlowMarket = slowMarketResult.isSlow;
                    }

                    // Auto-detect slow market and suggest micro-trading
                    if (!microTradingEnabled && localRegime.volatility === 'LOW') {
                        // Silently apply micro-trading logic in slow markets
                        isMicroMode = true;
                    }

                    // Adjust stop loss based on volatility
                    if (localRegime.volatility === 'HIGH' || localRegime.volatility === 'EXTREME') {
                        dynamicStopLossForExit = (isMicroMode ? microStopLoss : stopLossPercent) * 1.5; // Wider stops in volatile markets
                    } else if (localRegime.volatility === 'LOW') {
                        dynamicStopLossForExit = (isMicroMode ? microStopLoss : stopLossPercent) * 0.75; // Tighter stops in calm markets
                    }

                    // Slow market overrides stop loss
                    if (isSlowMarket) {
                        dynamicStopLossForExit = SLOW_MARKET.STOP_LOSS_SLOW;
                    }
                }
            }

            // --- EXIT LOGIC ---
            for (const positionTicker of Object.keys(currentPortfolio.positions)) {
                const position = currentPortfolio.positions[positionTicker];
                const currentData = watchlistDataRef.current[positionTicker];
                if (!currentData || currentData.candles.length === 0) continue;

                const currentPrice = Number(currentData.candles.at(-1)!.close) || 0;
                const profitGoal = profitGoals[position.entryStrategy];
                const rawProfit = (currentPrice - position.openPrice) * position.quantity;
                const feesPaid = (position.openPrice * position.quantity * TRADING_FEES.TAKER_FEE_PERCENT / 100) +
                                 (currentPrice * position.quantity * TRADING_FEES.TAKER_FEE_PERCENT / 100);
                const currentProfit = rawProfit - feesPaid;
                const profitPercent = ((currentPrice - position.openPrice) / position.openPrice) * 100;
                const profitPercentAfterFees = profitPercent - TRADING_FEES.ROUND_TRIP_FEE_PERCENT;

                // Update highest price for trailing stop
                const updatedPosition = {
                    ...position,
                    highestPrice: Math.max(position.highestPrice, currentPrice),
                    lowestPrice: Math.min(position.lowestPrice, currentPrice)
                };
                currentPortfolio.positions[positionTicker] = updatedPosition;

                let exitReason: string | null = null;

                // ======== PARTIAL EXIT SYSTEM (3-stage) ========
                if (PARTIAL_EXIT.ENABLED && (updatedPosition.exitStage ?? 0) < 3 && updatedPosition.originalQuantity > 0) {
                    const stage = updatedPosition.exitStage ?? 0;
                    const origQty = updatedPosition.originalQuantity;

                    // Stage 1: Sell 30% at +0.50% after fees
                    if (stage === 0 && profitPercentAfterFees >= PARTIAL_EXIT.STAGE_1_TARGET) {
                        const sellQty = origQty * (PARTIAL_EXIT.STAGE_1_PERCENT / 100);
                        if (sellQty > 0 && updatedPosition.quantity > sellQty) {
                            const sellValue = sellQty * currentPrice;
                            const sellFee = sellValue * TRADING_FEES.TAKER_FEE_PERCENT / 100;
                            const partialPnl = (currentPrice - updatedPosition.openPrice) * sellQty -
                                (updatedPosition.openPrice * sellQty * TRADING_FEES.TAKER_FEE_PERCENT / 100) - sellFee;

                            updatedPosition.quantity -= sellQty;
                            updatedPosition.exitStage = 1;
                            currentPortfolio.cash += sellValue - sellFee;

                            addLog(
                                `[PARTIAL-1] SELL ${sellQty.toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${positionTicker} @ ${currentPrice.toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)} (30% of position). PnL: $${partialPnl.toFixed(2)} (+${profitPercentAfterFees.toFixed(2)}%)`,
                                'SELL'
                            );
                            addTrade({
                                type: 'SELL', price: currentPrice, quantity: sellQty,
                                ticker: positionTicker, strategy: updatedPosition.entryStrategy,
                                reason: `[PARTIAL-1] +${profitPercentAfterFees.toFixed(2)}% after fees`, pnl: partialPnl
                            });
                        }
                    }

                    // Stage 2: Sell 40% at +1.50% after fees
                    if (stage === 1 && profitPercentAfterFees >= PARTIAL_EXIT.STAGE_2_TARGET) {
                        const sellQty = origQty * (PARTIAL_EXIT.STAGE_2_PERCENT / 100);
                        if (sellQty > 0 && updatedPosition.quantity > sellQty) {
                            const sellValue = sellQty * currentPrice;
                            const sellFee = sellValue * TRADING_FEES.TAKER_FEE_PERCENT / 100;
                            const partialPnl = (currentPrice - updatedPosition.openPrice) * sellQty -
                                (updatedPosition.openPrice * sellQty * TRADING_FEES.TAKER_FEE_PERCENT / 100) - sellFee;

                            updatedPosition.quantity -= sellQty;
                            updatedPosition.exitStage = 2;
                            currentPortfolio.cash += sellValue - sellFee;

                            addLog(
                                `[PARTIAL-2] SELL ${sellQty.toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${positionTicker} @ ${currentPrice.toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)} (40% of position). PnL: $${partialPnl.toFixed(2)} (+${profitPercentAfterFees.toFixed(2)}%)`,
                                'SELL'
                            );
                            addTrade({
                                type: 'SELL', price: currentPrice, quantity: sellQty,
                                ticker: positionTicker, strategy: updatedPosition.entryStrategy,
                                reason: `[PARTIAL-2] +${profitPercentAfterFees.toFixed(2)}% after fees`, pnl: partialPnl
                            });
                        }
                    }

                    // Stage 3: Tightening trailing stop on remaining 30%
                    if (stage === 2 && profitPercentAfterFees >= PARTIAL_EXIT.STAGE_3_TRAILING_START) {
                        // Interpolate trailing stop: starts at STAGE_3_TRAILING_START, tightens to STAGE_3_TRAILING_TIGHT
                        const profitAboveStart = profitPercentAfterFees - PARTIAL_EXIT.STAGE_3_TRAILING_START;
                        const tightenFactor = Math.min(1, profitAboveStart / 3); // Fully tight at +4.5% profit
                        const trailingPct = PARTIAL_EXIT.STAGE_3_TRAILING_START -
                            tightenFactor * (PARTIAL_EXIT.STAGE_3_TRAILING_START - PARTIAL_EXIT.STAGE_3_TRAILING_TIGHT);

                        const dropFromHigh = ((updatedPosition.highestPrice - currentPrice) / updatedPosition.highestPrice) * 100;
                        if (dropFromHigh >= trailingPct) {
                            exitReason = `[PARTIAL-3] Trailing stop on remaining 30%: dropped ${dropFromHigh.toFixed(2)}% from high (trail: ${trailingPct.toFixed(2)}%)`;
                        }
                    }

                    // Update the position in the portfolio after partial sells
                    currentPortfolio.positions[positionTicker] = updatedPosition;
                }

                // MICRO-TRADING: Quick profit exits
                if (isMicroMode) {
                    // Take quick profits in micro mode (fee-adjusted)
                    if (profitPercentAfterFees >= microProfitTarget) {
                        exitReason = `[MICRO] Quick profit: +${profitPercentAfterFees.toFixed(3)}% after fees (target: ${microProfitTarget}%)`;
                    }
                    // Quick stop loss in micro mode
                    else if (profitPercent <= -microStopLoss) {
                        exitReason = `[MICRO] Quick stop: ${profitPercent.toFixed(3)}% (limit: -${microStopLoss}%)`;
                    }
                    // Micro trailing stop - only trail after fee recovery
                    else if (profitPercentAfterFees > 0) {
                        const dropFromHigh = ((updatedPosition.highestPrice - currentPrice) / updatedPosition.highestPrice) * 100;
                        if (dropFromHigh >= microTrailingStop) {
                            exitReason = `[MICRO] Trailing stop: dropped ${dropFromHigh.toFixed(3)}% from high`;
                        }
                    }
                }

                // SLOW MARKET: Use adjusted targets/stops in slow markets
                if (!exitReason && isSlowMarket && !isMicroMode) {
                    if (profitPercentAfterFees >= SLOW_MARKET.PROFIT_TARGET_SLOW) {
                        exitReason = `[SLOW-MKT] Profit target: +${profitPercentAfterFees.toFixed(3)}% (target: ${SLOW_MARKET.PROFIT_TARGET_SLOW}%)`;
                    } else {
                        const dropFromHigh = ((updatedPosition.highestPrice - currentPrice) / updatedPosition.highestPrice) * 100;
                        if (profitPercentAfterFees > 0 && dropFromHigh >= SLOW_MARKET.TRAILING_STOP_SLOW) {
                            exitReason = `[SLOW-MKT] Trailing stop: dropped ${dropFromHigh.toFixed(2)}% from high`;
                        }
                    }
                }

                // 1. Check profit goal (normal mode)
                if (!exitReason && profitGoal > 0 && currentProfit >= profitGoal) {
                    exitReason = `Profit goal of $${profitGoal.toFixed(2)} reached (+${profitPercent.toFixed(2)}%)`;
                }

                // 2. Check stop-loss (uses dynamic stop loss based on market volatility)
                if (!exitReason && dynamicStopLossForExit > 0) {
                    const lossPercent = ((position.openPrice - currentPrice) / position.openPrice) * 100;
                    if (lossPercent >= dynamicStopLossForExit) {
                        exitReason = `Stop-loss triggered at -${lossPercent.toFixed(2)}% (dynamic: ${dynamicStopLossForExit.toFixed(1)}%)`;
                    }
                }

                // 3. Check trailing stop (NEW)
                if (!exitReason && useTrailingStop && trailingStopPercent > 0) {
                    const dropFromHigh = ((updatedPosition.highestPrice - currentPrice) / updatedPosition.highestPrice) * 100;
                    if (dropFromHigh >= trailingStopPercent && currentPrice > position.openPrice) {
                        exitReason = `Trailing stop triggered (-${dropFromHigh.toFixed(2)}% from high)`;
                    }
                }

                // 4. Check indicator exit signals
                if (!exitReason) {
                    const lastTcValue = currentData.indicatorData.at(-1)?.value ?? 50;
                    const lastBreakoutValue = currentData.breakoutData.at(-1)?.value ?? 50;
                    const lastWhaleValue = currentData.whaleData.at(-1)?.value ?? 50;
                    const confluenceScore = currentData.trendDashboardData.score;
                    const momentumValue = currentData.momentumData.at(-1)?.value ?? 50;

                    switch (position.entryStrategy) {
                        case 'TREND':
                            if (lastTcValue > SIGNAL_THRESHOLDS.TREND_BEARISH_EXIT)
                                exitReason = "Trend Signal: Bearish exit";
                            break;
                        case 'BREAKOUT':
                            if (lastBreakoutValue > SIGNAL_THRESHOLDS.BREAKOUT_EXPANSION_EXIT)
                                exitReason = "Breakout Signal: Volatility Ended";
                            break;
                        case 'WHALE':
                            if (lastWhaleValue < SIGNAL_THRESHOLDS.WHALE_SELLING_EXIT)
                                exitReason = "Whale Signal: Whale Selling";
                            break;
                        case 'CONFLUENCE':
                            if (confluenceScore <= SIGNAL_THRESHOLDS.CONFLUENCE_BEARISH_EXIT)
                                exitReason = "Confluence Signal: Bearish Alignment";
                            break;
                        case 'MOMENTUM':
                            if (momentumValue < 50 - SIGNAL_THRESHOLDS.MOMENTUM_BEARISH_EXIT)
                                exitReason = "Momentum Signal: Bearish Momentum";
                            break;
                        case 'DIVERGENCE':
                            if (currentData.divergenceData.type === 'bearish' &&
                                currentData.divergenceData.confidence > SIGNAL_THRESHOLDS.DIVERGENCE_MIN_CONFIDENCE)
                                exitReason = "Divergence Signal: Bearish Divergence Detected";
                            break;
                        case 'ADAPTIVE': {
                            const adaptiveValue = currentData.adaptiveData?.at(-1)?.value ?? 50;
                            if (adaptiveValue > SIGNAL_THRESHOLDS.ADAPTIVE_BEARISH_EXIT)
                                exitReason = `Adaptive Signal: Bearish exit (${adaptiveValue.toFixed(0)}% drop probability)`;
                            break;
                        }
                    }
                }

                // Time-based exit: cut losers after 15 minutes
                if (!exitReason) {
                    const holdMinutes = (Date.now() - position.entryTime) / 60000;
                    if (holdMinutes > 15 && profitPercentAfterFees < 0) {
                        exitReason = `Time exit: ${profitPercentAfterFees.toFixed(2)}% after fees, ${holdMinutes.toFixed(0)}min hold`;
                    }
                }

                if (exitReason) {
                    const sellFee = currentPrice * position.quantity * TRADING_FEES.TAKER_FEE_PERCENT / 100;
                    const saleValue = position.quantity * currentPrice;
                    const pnl = currentProfit;

                    // AI LEARNING: Record this completed trade
                    if (aiLearningEnabled) {
                        const lastTcValue = currentData.indicatorData.at(-1)?.value ?? 50;
                        const lastMomentumValue = currentData.momentumData.at(-1)?.value ?? 50;
                        const lastWhaleValue = currentData.whaleData.at(-1)?.value ?? 50;
                        const lastConfluenceScore = currentData.trendDashboardData.score;

                        recordTrade({
                            ticker: positionTicker,
                            strategy: position.entryStrategy,
                            entryPrice: position.openPrice,
                            exitPrice: currentPrice,
                            entryTime: position.entryTime,
                            exitTime: Date.now(),
                            quantity: position.quantity,
                            indicators: {
                                tcValue: lastTcValue,
                                momentumValue: lastMomentumValue,
                                whaleValue: lastWhaleValue,
                                confluenceScore: lastConfluenceScore,
                            },
                            marketConditions: {
                                volatility: marketRegime?.volatility as 'LOW' | 'MEDIUM' | 'HIGH' || 'MEDIUM',
                                trend: marketRegime?.trend as 'UP' | 'DOWN' | 'SIDEWAYS' || 'SIDEWAYS',
                                volume: 'MEDIUM', // TODO: Calculate from candles
                            }
                        });

                        // Update learning state for UI
                        setLearningStateData(getLearningState());
                    }

                    addLog(
                        `SIM: SELL ${Number(position.quantity).toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${positionTicker} @ ${Number(currentPrice).toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)}. PnL: $${Number(pnl).toFixed(2)}. Reason: ${exitReason}`,
                        'SELL'
                    );

                    addTrade({
                        type: 'SELL',
                        price: currentPrice,
                        quantity: position.quantity,
                        ticker: positionTicker,
                        strategy: position.entryStrategy,
                        reason: exitReason,
                        pnl
                    });

                    const { [positionTicker]: _, ...remainingPositions } = currentPortfolio.positions;
                    currentPortfolio = {
                        ...currentPortfolio,
                        cash: currentPortfolio.cash + saleValue - sellFee,
                        positions: remainingPositions
                    };
                }
            }

            // Calculate total portfolio value
            const totalValue = currentPortfolio.cash + Object.values(currentPortfolio.positions).reduce((sum, pos) => {
                const price = watchlistDataRef.current[pos.ticker]?.candles?.at(-1)?.close ?? pos.openPrice;
                return sum + (pos.quantity * price);
            }, 0);

            // Check session profit goal (compare total value against initial budget + goal amount)
            const sessionProfit = totalValue - currentPortfolio.initialBudget;
            if (sessionProfitGoal > 0 && totalValue >= sessionProfitGoal && sessionProfit > 0) {
                addLog(`SESSION PROFIT GOAL of $${sessionProfitGoal.toFixed(2)} REACHED! Total value: $${totalValue.toFixed(2)} (Profit: $${sessionProfit.toFixed(2)})`, 'SPECIAL');
                setIsBotActive(false);
                setPortfolio(currentPortfolio);
                return;
            }

            // --- SESSION WIND-DOWN: Skip entries if session is about to end ---
            if (durationMins > 0 && sessionStartTime > 0) {
                const sessionEndTime = sessionStartTime + (durationMins * 60 * 1000);
                const timeRemaining = sessionEndTime - Date.now();
                const windDownMs = Math.min(5 * 60 * 1000, durationMins * 60 * 1000 * 0.1);

                if (timeRemaining <= windDownMs && timeRemaining > 0) {
                    if (Math.random() < 0.05) {
                        const minsLeft = Math.ceil(timeRemaining / 60000);
                        addLog(`Session winding down (${minsLeft}m left) - no new trades, exits only`, 'INFO');
                    }
                    setPortfolio(currentPortfolio);
                    return;
                }
            }

            // --- SMART ENTRY LOGIC ---
            // Calculate session analytics for dynamic adjustments
            const sessionAnalytics = calculateSessionAnalytics(
                trades,
                sessionStartTime || Date.now(),
                sessionProfitGoal,
                totalValue,
                currentPortfolio.initialBudget
            );

            // Get market regime from the most liquid asset (BTC or first available)
            const primaryTicker = availableTickers.find(t => t.includes('BTC')) || availableTickers[0];
            const primaryData = watchlistDataRef.current[primaryTicker];
            let regime: MarketRegime | null = null;
            // UNLIMITED TRADES: Set to very high number when enabled
            let dynamicMaxTrades = unlimitedTrades ? 999999 : maxConcurrentTrades;
            let dynamicRiskAmount = isMicroMode ? (MICRO_TRADING.MICRO_MIN_POSITION_PERCENT / 100) : riskAmount;
            let dynamicStopLoss = isMicroMode ? microStopLoss : stopLossPercent;

            if (smartTradingEnabled && primaryData && primaryData.candles.length > 20) {
                // Detect market regime
                regime = detectMarketRegime(primaryData.candles);

                // Calculate dynamic parameters
                const dynParams = calculateDynamicParams(
                    primaryData.candles,
                    sessionAnalytics,
                    maxConcurrentTrades,
                    riskAmount,
                    stopLossPercent
                );

                dynamicMaxTrades = dynParams.adjustedMaxTrades;
                dynamicRiskAmount = dynParams.adjustedRiskAmount;
                dynamicStopLoss = dynParams.adjustedStopLoss;

                // Update state for UI display (throttled)
                if (Math.random() < 0.2) { // Update 20% of the time to reduce re-renders
                    setDynamicParams(dynParams);
                    setMarketRegime({
                        trend: regime.trend,
                        volatility: regime.volatility,
                        tradingCondition: regime.tradingCondition,
                        recommendedStrategy: regime.recommendedStrategy
                    });
                }

                // In AVOID conditions, reduce position size but DON'T block trades entirely
                // Surge trading can still find opportunities in volatile conditions
                if (regime.tradingCondition === 'AVOID') {
                    dynamicRiskAmount *= 0.5; // Halve position size in poor conditions
                    if (Math.random() < 0.05) {
                        addLog(`Smart Trading: Volatile conditions (${regime.volatility}, ${regime.trend}) - reduced position size, surge detection active`, 'INFO');
                    }
                }
            }

            // Rank opportunities across all assets - use low candle requirement for fast start
            const watchlistForRanking: Record<string, { candles: Candle[]; srLevels: any }> = {};
            for (const t of availableTickers) {
                const data = watchlistDataRef.current[t];
                if (data && data.candles.length > 10 && !currentPortfolio.positions[t]) {
                    watchlistForRanking[t] = { candles: data.candles, srLevels: data.srLevels };
                }
            }

            // Get ranked opportunities (best first)
            const rankedOpportunities = smartTradingEnabled
                ? rankOpportunities(watchlistForRanking)
                : [];

            const openPositionsCount = Object.keys(currentPortfolio.positions).length;
            if (openPositionsCount < dynamicMaxTrades) {
                // Use ranked opportunities if smart trading is enabled, otherwise use original order
                const tickersToCheck = smartTradingEnabled && rankedOpportunities.length > 0
                    ? rankedOpportunities.map(o => o.ticker)
                    : availableTickers;

                for (const entryTicker of tickersToCheck) {
                    if (currentPortfolio.positions[entryTicker] ||
                        Object.keys(currentPortfolio.positions).length >= dynamicMaxTrades) continue;

                    const currentData = watchlistDataRef.current[entryTicker];
                    if (!currentData || currentData.candles.length === 0) continue;

                    const currentPrice = Number(currentData.candles.at(-1)!.close) || 0;
                    const lastTcValue = currentData.indicatorData.at(-1)?.value ?? 50;
                    const lastBreakoutValue = currentData.breakoutData.at(-1)?.value ?? 50;
                    const lastWhaleValue = currentData.whaleData.at(-1)?.value ?? 50;
                    const momentumValue = currentData.momentumData.at(-1)?.value ?? 50;
                    const confluenceScore = currentData.trendDashboardData.score;
                    const divergence = currentData.divergenceData;
                    const signalScore = currentData.signalScore;

                    // Check for gaps (quick opportunities)
                    const gapData = smartTradingEnabled ? detectGap(currentData.candles) : null;

                    let entryReason: string | null = null;
                    let entryStrategy: TradingStrategy | null = null;
                    let urgencyBoost = 0;
                    let surgeDecision: ReturnType<typeof getSurgeTradingDecision> | null = null;

                    // ======== SURGE DETECTION (HIGHEST PRIORITY) ========
                    // Check for surges, dips, and trend rides FIRST - these are time-sensitive
                    if (currentData.candles.length >= 10) {
                        surgeDecision = getSurgeTradingDecision(currentData.candles);

                        if (surgeDecision.shouldTrade && surgeDecision.action === 'BUY' &&
                            surgeDecision.confidence >= SURGE_TRADING.MIN_SURGE_CONFIDENCE) {

                            // Anti-FOMO: RSI proxy overbought check
                            const recentUpCandles = currentData.candles.slice(-14).filter(c => c.close > c.open).length;
                            const isOverbought = recentUpCandles >= 10;

                            // Resistance check (top 5% of 50-candle range)
                            const recentCloses = currentData.candles.slice(-50).map(c => c.close);
                            const rangeHigh = Math.max(...recentCloses);
                            const rangeLow = Math.min(...recentCloses);
                            const pricePercentile = rangeHigh > rangeLow ? (currentPrice - rangeLow) / (rangeHigh - rangeLow) : 0.5;
                            const atResistance = pricePercentile > 0.95;

                            const isDipBuySignal = surgeDecision.strategy === 'DIP_BUY';

                            // Slow market: only allow DIP_BUY surges
                            const slowMarketBlocked = isSlowMarket && !isDipBuySignal;

                            // Block non-dip entries at overbought/resistance or in slow markets
                            if (((isOverbought || atResistance) && !isDipBuySignal) || slowMarketBlocked) {
                                // Skip - FOMO protection / slow market filter
                            } else {
                                // Map surge strategy to trading strategy
                                switch (surgeDecision.strategy) {
                                    case 'DIP_BUY':
                                        entryStrategy = 'TREND';
                                        break;
                                    case 'TREND_RIDE':
                                        entryStrategy = 'TREND';
                                        break;
                                    case 'BREAKOUT_SURGE':
                                        entryStrategy = 'BREAKOUT';
                                        break;
                                    case 'PATTERN':
                                        entryStrategy = 'ADAPTIVE';
                                        break;
                                    default:
                                        entryStrategy = 'MOMENTUM';
                                        break;
                                }
                                entryReason = `[SURGE] ${surgeDecision.reason}`;
                                urgencyBoost = surgeDecision.urgency === 'IMMEDIATE' ? 30 :
                                              surgeDecision.urgency === 'SOON' ? 15 : 5;

                                // Surge trades get extra confidence from the surge system
                                urgencyBoost += Math.floor(surgeDecision.confidence / 5);
                            }
                        }
                    }

                    // Gap-based entry (high priority if breakaway gap)
                    if (!entryStrategy && gapData && gapData.hasGap && !gapData.gapFilled && gapData.isBreakawayGap) {
                        if (gapData.gapType === 'GAP_UP' && momentumValue > 55) {
                            entryStrategy = 'MOMENTUM';
                            entryReason = `Gap Up Breakaway: ${gapData.gapPercent.toFixed(2)}% gap with strong volume`;
                            urgencyBoost = 20;
                        }
                    }

                    // Check each strategy for entry signals (if no gap entry)
                    const adaptiveEntryValue = currentData.adaptiveData?.at(-1)?.value ?? 50;

                    if (!entryStrategy) {
                        // MICRO-TRADING: Use more sensitive entry thresholds
                        const microTcEntry = MICRO_TRADING.MICRO_TC_ENTRY_THRESHOLD;
                        const microMomentumEntry = MICRO_TRADING.MICRO_MOMENTUM_ENTRY;
                        const microWhaleEntry = MICRO_TRADING.MICRO_WHALE_ENTRY;

                        // Prioritize recommended strategy from market regime
                        const allStrategies: TradingStrategy[] = regime?.recommendedStrategy
                            ? [regime.recommendedStrategy, ...Object.keys(DEFAULT_PROFIT_GOALS) as TradingStrategy[]]
                            : [...Object.keys(DEFAULT_PROFIT_GOALS) as TradingStrategy[]];

                        // Regime-aware strategy filtering using imported map
                        // Slow market overrides regime filtering with its own allowed set
                        const regimeTrend = regime?.trend || 'SIDEWAYS';
                        const allowedForRegime: readonly string[] = isSlowMarket
                            ? SLOW_MARKET.ALLOWED_STRATEGIES
                            : (REGIME_STRATEGY_MAP[regimeTrend] || allStrategies);
                        const prioritizedStrategies = allStrategies.filter(s => allowedForRegime.includes(s));

                        for (const strat of prioritizedStrategies) {
                            if (entryStrategy) break;

                            switch (strat) {
                                case 'TREND':
                                    // Use more sensitive threshold in micro mode
                                    const trendThreshold = isMicroMode ? microTcEntry : SIGNAL_THRESHOLDS.TREND_BULLISH_ENTRY;
                                    if (lastTcValue < trendThreshold) {
                                        entryStrategy = 'TREND';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Trend entry (TC=${lastTcValue.toFixed(1)} < ${trendThreshold})`
                                            : `Trend Signal: Bullish entry (TC=${lastTcValue.toFixed(1)})`;
                                    }
                                    break;
                                case 'BREAKOUT':
                                    if (lastBreakoutValue < SIGNAL_THRESHOLDS.BREAKOUT_SQUEEZE_ENTRY) {
                                        entryStrategy = 'BREAKOUT';
                                        entryReason = `Breakout Signal: Volatility Squeeze (V=${lastBreakoutValue.toFixed(1)})`;
                                    }
                                    break;
                                case 'WHALE':
                                    // Use more sensitive threshold in micro mode
                                    const whaleThreshold = isMicroMode ? microWhaleEntry : SIGNAL_THRESHOLDS.WHALE_BUYING_ENTRY;
                                    if (lastWhaleValue > whaleThreshold) {
                                        entryStrategy = 'WHALE';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Whale entry (WMF=${lastWhaleValue.toFixed(1)} > ${whaleThreshold})`
                                            : `Whale Signal: Whale Buying (WMF=${lastWhaleValue.toFixed(1)})`;
                                    }
                                    break;
                                case 'CONFLUENCE':
                                    // In micro mode, accept lower confluence score
                                    const confluenceThreshold = isMicroMode ? 3 : SIGNAL_THRESHOLDS.CONFLUENCE_BULLISH_ENTRY;
                                    if (confluenceScore >= confluenceThreshold) {
                                        entryStrategy = 'CONFLUENCE';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Confluence entry (${confluenceScore}/6 indicators)`
                                            : `Confluence Signal: Bullish Alignment (${confluenceScore}/6)`;
                                    }
                                    break;
                                case 'MOMENTUM':
                                    // Use more sensitive threshold in micro mode
                                    const momentumThreshold = isMicroMode ? microMomentumEntry : SIGNAL_THRESHOLDS.MOMENTUM_BULLISH_ENTRY;
                                    if (momentumValue > 50 + momentumThreshold) {
                                        entryStrategy = 'MOMENTUM';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Momentum entry (M=${momentumValue.toFixed(1)})`
                                            : `Momentum Signal: Strong Upward Momentum (M=${momentumValue.toFixed(1)})`;
                                    }
                                    break;
                                case 'DIVERGENCE':
                                    // In micro mode, accept lower divergence confidence
                                    const divThreshold = isMicroMode ? 45 : SIGNAL_THRESHOLDS.DIVERGENCE_MIN_CONFIDENCE;
                                    if (divergence.type === 'bullish' && divergence.confidence >= divThreshold) {
                                        entryStrategy = 'DIVERGENCE';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Divergence entry (${divergence.confidence.toFixed(0)}% conf)`
                                            : `Divergence Signal: Bullish RSI Divergence (${divergence.confidence.toFixed(0)}% confidence)`;
                                    }
                                    break;
                                case 'ADAPTIVE':
                                    // Use more sensitive threshold in micro mode
                                    const adaptiveThreshold = isMicroMode ? 40 : SIGNAL_THRESHOLDS.ADAPTIVE_BULLISH_ENTRY;
                                    if (adaptiveEntryValue < adaptiveThreshold) {
                                        entryStrategy = 'ADAPTIVE';
                                        entryReason = isMicroMode
                                            ? `[MICRO] Adaptive entry (${Math.round(100 - adaptiveEntryValue)}% pump prob)`
                                            : `Adaptive Signal: ${Math.round(100 - adaptiveEntryValue)}% pump probability (${entryTicker})`;
                                    }
                                    break;
                            }
                        }
                    }

                    // AI LEARNING + ASSET INTELLIGENCE + SENTIMENT + ON-CHAIN: Combined trading decision
                    let shouldEnter = false;
                    let aiDecisionReason = '';
                    let assetRiskParams = { stopLossMultiplier: 1, profitTargetMultiplier: 1, positionSizeMultiplier: 1, confidenceBoost: 0 };
                    let totalConfidenceBoost = 0;

                    // Track if this is a surge-detected entry (bypasses some veto gates)
                    const isSurgeEntry = entryReason?.startsWith('[SURGE]') ?? false;

                    if (entryStrategy && entryReason) {
                        // ASSET INTELLIGENCE: Get asset-specific parameters
                        if (assetIntelligenceEnabled) {
                            assetRiskParams = getRiskAdjustedParams(entryTicker);

                            // Check if this asset is suitable for the strategy
                            // Surge entries bypass tradeability check
                            if (!isSurgeEntry) {
                                const tradeability = isAssetTradeable(entryTicker, entryStrategy);
                                if (!tradeability.tradeable) {
                                    // Reduce confidence instead of hard block
                                    totalConfidenceBoost -= 15;
                                }
                            }

                            // Get volatility-based entry rules
                            const volRules = getVolatilityBasedRules(entryTicker, '1h');
                            totalConfidenceBoost += volRules.entryThresholdAdjustment + assetRiskParams.confidenceBoost;

                            // Get best strategy suggestion for this asset
                            const bestStrategy = getBestStrategyForAsset(entryTicker);
                            if (bestStrategy && bestStrategy === entryStrategy) {
                                totalConfidenceBoost += 10;
                                aiDecisionReason = `Asset-strategy match: ${entryTicker} ideal for ${entryStrategy}`;
                            }
                        }

                        // ENHANCED SENTIMENT: Apply sentiment filter and confidence adjustment
                        if (enhancedSentimentEnabled && currentData.candles.length > 20) {
                            const tickerSentiment = calculateSentimentFromMarketData(currentData.candles, entryTicker);

                            // Sentiment veto: only block non-surge trades with VERY bad sentiment
                            const sentimentFilter = applySentimentFilter(tickerSentiment, 'LONG', -40);
                            if (!sentimentFilter.proceed && !isSurgeEntry) {
                                // Reduce confidence instead of hard block
                                totalConfidenceBoost -= 20;
                            }

                            // Get confidence adjustment from sentiment
                            const sentimentAdjust = calculateSentimentConfidenceAdjustment(tickerSentiment, entryStrategy);
                            totalConfidenceBoost += sentimentAdjust.adjustment;
                            if (sentimentAdjust.adjustment !== 0) {
                                aiDecisionReason += aiDecisionReason ? ` | ${sentimentAdjust.reason}` : sentimentAdjust.reason;
                            }

                            // Check for sentiment burst (micro-trade trigger)
                            const burst = detectSentimentBurst(tickerSentiment, getCorrelatedMemeAssets(entryTicker));
                            if (burst.detected && burst.recommendedAction === 'MICRO_TRADE_LONG') {
                                totalConfidenceBoost += 15;
                                aiDecisionReason += ' | Sentiment burst detected';
                            }
                        }

                        // ON-CHAIN ANALYTICS: Apply on-chain adjustment
                        if (onChainEnabled && currentData.candles.length > 20) {
                            const onChainData = calculateOnChainSignals(currentData.candles, entryTicker);
                            const onChainAdjust = getOnChainTradingAdjustment(onChainData);

                            // Surge entries bypass on-chain veto
                            if (!onChainAdjust.shouldTrade && !isSurgeEntry) {
                                totalConfidenceBoost -= 15;
                            }

                            totalConfidenceBoost += onChainAdjust.confidenceBoost;
                            assetRiskParams.positionSizeMultiplier *= onChainAdjust.positionSizeMultiplier;
                            if (onChainAdjust.confidenceBoost !== 0) {
                                aiDecisionReason += aiDecisionReason ? ` | ${onChainAdjust.reason}` : onChainAdjust.reason;
                            }
                        }

                        // SURGE ENTRIES: High-confidence surge signals bypass AI gating
                        if (isSurgeEntry && urgencyBoost >= 25) {
                            shouldEnter = true;
                            aiDecisionReason = `SURGE BYPASS: High-confidence surge entry (boost=${urgencyBoost})`;
                        } else if (aiLearningEnabled) {
                            // Get AI-powered trade decision with all boosts
                            // Use actual signal confidence - no artificial floor
                            const baseConfidence = signalScore.confidence;
                            const aiDecision = shouldTakeTrade(
                                entryStrategy,
                                {
                                    tcValue: lastTcValue,
                                    momentumValue: momentumValue,
                                    whaleValue: lastWhaleValue,
                                    confluenceScore: confluenceScore,
                                    confidence: baseConfidence + urgencyBoost + totalConfidenceBoost
                                },
                                {
                                    volatility: regime?.volatility as 'LOW' | 'MEDIUM' | 'HIGH' || 'MEDIUM',
                                    trend: regime?.trend as 'UP' | 'DOWN' | 'SIDEWAYS' || 'SIDEWAYS'
                                }
                            );

                            shouldEnter = aiDecision.take;
                            aiDecisionReason = aiDecision.reason + (aiDecisionReason ? ` | ${aiDecisionReason}` : '');

                            // Update learning state periodically
                            if (Math.random() < 0.1) {
                                setLearningStateData(getLearningState());
                            }
                        } else {
                            // Fallback to old logic with all boosts
                            const opportunityScore = rankedOpportunities.find(o => o.ticker === entryTicker);
                            let confidenceThreshold = RISK_DEFAULTS.MIN_SIGNAL_CONFIDENCE;
                            if (opportunityScore && opportunityScore.urgency === 'IMMEDIATE') {
                                confidenceThreshold = Math.max(15, confidenceThreshold - 15);
                            }
                            const effectiveConfidenceThreshold = isMicroMode ? Math.max(10, confidenceThreshold - 25) : confidenceThreshold;
                            // Use actual signal confidence - no artificial floor
                            const effectiveConfidence = signalScore.confidence + urgencyBoost + totalConfidenceBoost;
                            shouldEnter = effectiveConfidence >= effectiveConfidenceThreshold;
                            aiDecisionReason = `Confidence ${effectiveConfidence.toFixed(0)} >= ${effectiveConfidenceThreshold}`;
                        }
                    }

                    if (shouldEnter) {
                        const remainingSlots = unlimitedTrades ? 1 : Math.max(1, dynamicMaxTrades - Object.keys(currentPortfolio.positions).length);

                        // ASSET INTELLIGENCE: Apply position size multiplier based on asset liquidity/risk
                        const assetPositionMultiplier = assetIntelligenceEnabled ? assetRiskParams.positionSizeMultiplier : 1;

                        // VOLATILITY METHODS: Get volatility-adjusted parameters
                        let volAdjustedSize = 1;
                        if (volatilityAnalysisEnabled && currentData.candles.length > 30) {
                            const volParams = getVolatilityAdjustedParams(
                                currentData.candles,
                                dynamicStopLoss,
                                profitGoals[entryStrategy] || 10,
                                1 // Base position size multiplier
                            );
                            volAdjustedSize = volParams.positionSize;
                        }

                        // KELLY CRITERION: Dynamic Kelly-based position sizing (Feature 4)
                        let kellyMultiplier = 1;
                        if (riskMetricsEnabled && kellyResult && kellyResult.recommendedFraction > 0) {
                            const tradeCount = kellyResult.stats?.trades || 0;
                            if (tradeCount >= 20) {
                                // Enough data: use Kelly fraction capped at 25%
                                const kellyFraction = Math.min(0.25, kellyResult.recommendedFraction);
                                kellyMultiplier = kellyFraction / 0.10; // Relative to 10% base
                            } else {
                                // Not enough data: conservative 10% base (multiplier = 1)
                                kellyMultiplier = 1;
                            }
                        }

                        // SURGE/TREND TRADING: Boost position size for high-conviction entries
                        const surgeMultiplier = isSurgeEntry ? SURGE_TRADING.TREND_POSITION_MULTIPLIER : 1;

                        // Combined multiplier from all systems
                        const combinedMultiplier = assetPositionMultiplier * volAdjustedSize * kellyMultiplier * surgeMultiplier;

                        let investmentAmount: number;
                        if (isSurgeEntry) {
                            // Scale position by surge confidence (higher confidence = larger position)
                            const surgeConf = surgeDecision?.confidence ?? 50;
                            const confFactor = Math.max(0, (surgeConf - 30) / 70);
                            const surgePositionPercent = SURGE_TRADING.SURGE_MIN_POSITION_PERCENT +
                                confFactor * (SURGE_TRADING.SURGE_MAX_POSITION_PERCENT - SURGE_TRADING.SURGE_MIN_POSITION_PERCENT);
                            investmentAmount = currentPortfolio.cash * (surgePositionPercent / 100) * combinedMultiplier;
                        } else if (isMicroMode) {
                            // In micro mode, use smaller fixed percentage of cash
                            const microPositionPercent = MICRO_TRADING.MICRO_MIN_POSITION_PERCENT +
                                Math.random() * (MICRO_TRADING.MICRO_MAX_POSITION_PERCENT - MICRO_TRADING.MICRO_MIN_POSITION_PERCENT);
                            investmentAmount = currentPortfolio.cash * (microPositionPercent / 100) * combinedMultiplier;
                        } else if (unlimitedTrades) {
                            // For unlimited trades, use a smaller fixed percentage
                            investmentAmount = currentPortfolio.cash * 0.1 * dynamicRiskAmount * combinedMultiplier;
                        } else {
                            investmentAmount = (currentPortfolio.cash / remainingSlots) * dynamicRiskAmount * combinedMultiplier;
                        }

                        // Hard position cap: never exceed 20% of cash
                        investmentAmount = Math.min(investmentAmount, currentPortfolio.cash * 0.20);

                        // Ensure minimum trade size
                        const minTradeSize = Math.max(1.0, RISK_DEFAULTS.MIN_TRADE_SIZE_USD);
                        if (investmentAmount > minTradeSize) {
                            const quantity = investmentAmount / currentPrice;

                            // Enhanced log with smart trading, AI learning, and asset intelligence info
                            const smartInfo = smartTradingEnabled && regime
                                ? ` [${regime.tradingCondition} market]`
                                : '';
                            const aiInfo = aiLearningEnabled ? ` | AI: ${aiDecisionReason}` : '';
                            const assetInfo = assetIntelligenceEnabled && assetRiskParams.positionSizeMultiplier !== 1
                                ? ` | Size: ${(assetRiskParams.positionSizeMultiplier * 100).toFixed(0)}%`
                                : '';

                            addLog(
                                `SIM: BUY ${Number(quantity).toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${entryTicker} @ ${Number(currentPrice).toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)}. [${entryStrategy}] ${entryReason}${smartInfo}${aiInfo}${assetInfo}`,
                                'BUY'
                            );

                            addTrade({
                                type: 'BUY',
                                price: currentPrice,
                                quantity,
                                ticker: entryTicker,
                                strategy: entryStrategy,
                                reason: entryReason
                            });

                            const newPosition: Position = {
                                quantity,
                                openPrice: currentPrice,
                                ticker: entryTicker,
                                entryStrategy,
                                entryTime: Date.now(),
                                highestPrice: currentPrice,
                                lowestPrice: currentPrice,
                                exitStage: 0,
                                originalQuantity: quantity
                            };

                            const buyFee = investmentAmount * TRADING_FEES.TAKER_FEE_PERCENT / 100;
                            currentPortfolio = {
                                ...currentPortfolio,
                                cash: currentPortfolio.cash - investmentAmount - buyFee,
                                positions: {
                                    ...currentPortfolio.positions,
                                    [entryTicker]: newPosition
                                }
                            };
                        }
                    }
                }
            }

            // ============================================
            // PROFIT METHODS: Grid, DCA, Arbitrage, Pairs, Swing, Market Making
            // These run alongside the main trading strategies
            // ============================================

            // --- GRID TRADING ---
            if (PROFIT_METHODS.GRID.ENABLED) {
                for (const gridTicker of availableTickers) {
                    const gridData = watchlistDataRef.current[gridTicker];
                    if (!gridData || gridData.candles.length < 15) continue;

                    const gridSignal = processGrid(gridTicker, gridData.candles, currentPortfolio.cash);
                    if (gridSignal && gridSignal.shouldAct) {
                        const gridPrice = Number(gridData.candles.at(-1)!.close);
                        const gridAmount = Math.min(gridSignal.investmentAmount, currentPortfolio.cash * 0.1);

                        if (gridSignal.action === 'BUY' && gridAmount > 1 && currentPortfolio.cash > gridAmount) {
                            const qty = gridAmount / gridPrice;
                            addLog(`GRID BUY: ${qty.toFixed(4)} ${gridTicker} @ ${gridPrice.toFixed(2)} | ${gridSignal.reason}`, 'BUY');
                            addTrade({ type: 'BUY', price: gridPrice, quantity: qty, ticker: gridTicker, strategy: 'ADAPTIVE', reason: gridSignal.reason });

                            if (!currentPortfolio.positions[gridTicker]) {
                                currentPortfolio = {
                                    ...currentPortfolio,
                                    cash: currentPortfolio.cash - gridAmount,
                                    positions: {
                                        ...currentPortfolio.positions,
                                        [gridTicker]: { quantity: qty, openPrice: gridPrice, ticker: gridTicker, entryStrategy: 'ADAPTIVE' as TradingStrategy, entryTime: Date.now(), highestPrice: gridPrice, lowestPrice: gridPrice, exitStage: 0, originalQuantity: qty }
                                    }
                                };
                            }
                        } else if (gridSignal.action === 'SELL' && currentPortfolio.positions[gridTicker]) {
                            const pos = currentPortfolio.positions[gridTicker];
                            const pnl = (gridPrice - pos.openPrice) * pos.quantity;
                            addLog(`GRID SELL: ${Number(pos.quantity).toFixed(4)} ${gridTicker} @ ${Number(gridPrice).toFixed(2)} | PnL: $${Number(pnl).toFixed(2)} | ${gridSignal.reason}`, 'SELL');
                            addTrade({ type: 'SELL', price: gridPrice, quantity: pos.quantity, ticker: gridTicker, strategy: 'ADAPTIVE', reason: gridSignal.reason, pnl });

                            const { [gridTicker]: _, ...remaining } = currentPortfolio.positions;
                            currentPortfolio = { ...currentPortfolio, cash: currentPortfolio.cash + pos.quantity * gridPrice, positions: remaining };
                        }
                    }
                }
            }

            // --- SMART DCA ---
            if (PROFIT_METHODS.DCA.ENABLED) {
                for (const dcaTicker of availableTickers) {
                    const dcaData = watchlistDataRef.current[dcaTicker];
                    if (!dcaData || dcaData.candles.length < 10) continue;

                    const dcaSignal = processDCA(dcaTicker, dcaData.candles, currentPortfolio.cash, currentPortfolio.initialBudget);
                    if (dcaSignal && dcaSignal.shouldBuy && dcaSignal.amount > 0.50 && currentPortfolio.cash > dcaSignal.amount) {
                        const dcaPrice = Number(dcaData.candles.at(-1)!.close) || 0;
                        const dcaQty = dcaSignal.amount / dcaPrice;

                        recordDCABuy(dcaTicker, dcaPrice, dcaQty, dcaSignal.amount);
                        addLog(`DCA BUY: ${Number(dcaQty).toFixed(4)} ${dcaTicker} @ ${Number(dcaPrice).toFixed(2)} (${Number(dcaSignal.multiplier).toFixed(1)}x) | ${dcaSignal.reason}`, 'BUY');
                        addTrade({ type: 'BUY', price: dcaPrice, quantity: dcaQty, ticker: dcaTicker, strategy: 'CONFLUENCE', reason: dcaSignal.reason });

                        if (!currentPortfolio.positions[dcaTicker]) {
                            currentPortfolio = {
                                ...currentPortfolio,
                                cash: currentPortfolio.cash - dcaSignal.amount,
                                positions: {
                                    ...currentPortfolio.positions,
                                    [dcaTicker]: { quantity: dcaQty, openPrice: dcaPrice, ticker: dcaTicker, entryStrategy: 'CONFLUENCE' as TradingStrategy, entryTime: Date.now(), highestPrice: dcaPrice, lowestPrice: dcaPrice, exitStage: 0, originalQuantity: dcaQty }
                                }
                            };
                        } else {
                            // Add to existing position
                            const existing = currentPortfolio.positions[dcaTicker];
                            const newQty = existing.quantity + dcaQty;
                            const newAvg = (existing.openPrice * existing.quantity + dcaPrice * dcaQty) / newQty;
                            currentPortfolio = {
                                ...currentPortfolio,
                                cash: currentPortfolio.cash - dcaSignal.amount,
                                positions: {
                                    ...currentPortfolio.positions,
                                    [dcaTicker]: { ...existing, quantity: newQty, openPrice: newAvg }
                                }
                            };
                        }
                    }

                    // Check DCA take profit
                    if (currentPortfolio.positions[dcaTicker]) {
                        const dcaPrice = Number(dcaData.candles.at(-1)!.close) || 0;
                        const dcaTP = checkDCATakeProfit(dcaTicker, dcaPrice, PROFIT_METHODS.DCA.TAKE_PROFIT_PERCENT);
                        if (dcaTP.shouldSell) {
                            const pos = currentPortfolio.positions[dcaTicker];
                            const pnl = (dcaPrice - pos.openPrice) * pos.quantity;
                            addLog(`DCA TAKE PROFIT: ${Number(pos.quantity).toFixed(4)} ${dcaTicker} @ ${Number(dcaPrice).toFixed(2)} | +${Number(dcaTP.pnlPercent).toFixed(2)}% | $${Number(pnl).toFixed(2)}`, 'SELL');
                            addTrade({ type: 'SELL', price: dcaPrice, quantity: pos.quantity, ticker: dcaTicker, strategy: 'CONFLUENCE', reason: dcaTP.reason, pnl });

                            clearDCAPosition(dcaTicker);
                            const { [dcaTicker]: _, ...remaining } = currentPortfolio.positions;
                            currentPortfolio = { ...currentPortfolio, cash: currentPortfolio.cash + pos.quantity * dcaPrice, positions: remaining };
                        }
                    }
                }
            }

            // --- ARBITRAGE ---
            if (PROFIT_METHODS.ARBITRAGE.ENABLED && availableTickers.length >= 2) {
                const arbData: Record<string, { candles: Candle[] }> = {};
                for (const t of availableTickers) {
                    const d = watchlistDataRef.current[t];
                    if (d && d.candles.length > 20) {
                        arbData[t] = { candles: d.candles };
                    }
                }

                const arbResult = detectArbitrage(arbData);
                if (arbResult.bestOpportunity && arbResult.bestOpportunity.confidence >= PROFIT_METHODS.ARBITRAGE.MIN_CONFIDENCE) {
                    const opp = arbResult.bestOpportunity;
                    const buyData = watchlistDataRef.current[opp.buyTicker];

                    if (buyData && !currentPortfolio.positions[opp.buyTicker]) {
                        const buyPrice = Number(buyData.candles.at(-1)!.close) || 0;
                        const arbAmount = Math.min(currentPortfolio.cash * PROFIT_METHODS.ARBITRAGE.PORTFOLIO_ALLOCATION, currentPortfolio.cash * 0.1);

                        if (arbAmount > 1 && currentPortfolio.cash > arbAmount) {
                            const arbQty = arbAmount / buyPrice;
                            addLog(`ARB BUY: ${arbQty.toFixed(4)} ${opp.buyTicker} | ${opp.reason} | Expected: +${opp.expectedProfit.toFixed(2)}%`, 'BUY');
                            addTrade({ type: 'BUY', price: buyPrice, quantity: arbQty, ticker: opp.buyTicker, strategy: 'MOMENTUM', reason: `[ARB] ${opp.reason}` });

                            currentPortfolio = {
                                ...currentPortfolio,
                                cash: currentPortfolio.cash - arbAmount,
                                positions: {
                                    ...currentPortfolio.positions,
                                    [opp.buyTicker]: { quantity: arbQty, openPrice: buyPrice, ticker: opp.buyTicker, entryStrategy: 'MOMENTUM' as TradingStrategy, entryTime: Date.now(), highestPrice: buyPrice, lowestPrice: buyPrice, exitStage: 0, originalQuantity: arbQty }
                                }
                            };
                        }
                    }
                }
            }

            // --- PAIR TRADING ---
            if (PROFIT_METHODS.PAIR_TRADING.ENABLED && availableTickers.length >= 2) {
                const pairData: Record<string, { candles: Candle[] }> = {};
                for (const t of availableTickers) {
                    const d = watchlistDataRef.current[t];
                    if (d && d.candles.length > 30) {
                        pairData[t] = { candles: d.candles };
                    }
                }

                const pairSignals = getPairSignals(pairData);
                for (const signal of pairSignals.slice(0, 1)) { // Process best signal only
                    if (!signal.shouldTrade || signal.confidence < 50) continue;

                    if (signal.action === 'OPEN_PAIR' && !currentPortfolio.positions[signal.longTicker]) {
                        const longData = watchlistDataRef.current[signal.longTicker];
                        if (!longData) continue;

                        const longPrice = Number(longData.candles.at(-1)!.close) || 0;
                        const pairAmount = Math.min(currentPortfolio.cash * PROFIT_METHODS.PAIR_TRADING.PORTFOLIO_ALLOCATION, currentPortfolio.cash * 0.1);

                        if (pairAmount > 1 && currentPortfolio.cash > pairAmount) {
                            const pairQty = pairAmount / longPrice;
                            openPairTrade(signal.longTicker, signal.shortTicker, longPrice, 0, pairQty, 0, 0, signal.zScore);

                            addLog(`PAIR LONG: ${pairQty.toFixed(4)} ${signal.longTicker} vs ${signal.shortTicker} | z=${signal.zScore.toFixed(2)} | ${signal.reason}`, 'BUY');
                            addTrade({ type: 'BUY', price: longPrice, quantity: pairQty, ticker: signal.longTicker, strategy: 'DIVERGENCE', reason: `[PAIR] ${signal.reason}` });

                            currentPortfolio = {
                                ...currentPortfolio,
                                cash: currentPortfolio.cash - pairAmount,
                                positions: {
                                    ...currentPortfolio.positions,
                                    [signal.longTicker]: { quantity: pairQty, openPrice: longPrice, ticker: signal.longTicker, entryStrategy: 'DIVERGENCE' as TradingStrategy, entryTime: Date.now(), highestPrice: longPrice, lowestPrice: longPrice, exitStage: 0, originalQuantity: pairQty }
                                }
                            };
                        }
                    } else if (signal.action === 'CLOSE_PAIR' && currentPortfolio.positions[signal.longTicker]) {
                        const pos = currentPortfolio.positions[signal.longTicker];
                        const closeData = watchlistDataRef.current[signal.longTicker];
                        if (!closeData) continue;

                        const closePrice = Number(closeData.candles.at(-1)!.close) || 0;
                        const pnl = (closePrice - pos.openPrice) * pos.quantity;

                        closePairTrade(`${signal.longTicker}:${signal.shortTicker}`);
                        addLog(`PAIR CLOSE: ${Number(pos.quantity).toFixed(4)} ${signal.longTicker} @ ${Number(closePrice).toFixed(2)} | PnL: $${Number(pnl).toFixed(2)} | ${signal.reason}`, 'SELL');
                        addTrade({ type: 'SELL', price: closePrice, quantity: pos.quantity, ticker: signal.longTicker, strategy: 'DIVERGENCE', reason: `[PAIR] ${signal.reason}`, pnl });

                        const { [signal.longTicker]: _, ...remaining } = currentPortfolio.positions;
                        currentPortfolio = { ...currentPortfolio, cash: currentPortfolio.cash + pos.quantity * closePrice, positions: remaining };
                    }
                }
            }

            // --- SWING TRADING ---
            if (PROFIT_METHODS.SWING.ENABLED) {
                for (const swingTicker of availableTickers) {
                    const swingData = watchlistDataRef.current[swingTicker];
                    if (!swingData || swingData.candles.length < 30) continue;

                    const swingPrice = Number(swingData.candles.at(-1)!.close);

                    // Check existing swing position exits
                    const swingExit = checkSwingExit(swingTicker, swingPrice);
                    if (swingExit.shouldExit && currentPortfolio.positions[swingTicker]) {
                        const pos = currentPortfolio.positions[swingTicker];
                        const pnl = (swingPrice - pos.openPrice) * pos.quantity;
                        addLog(`SWING EXIT: ${Number(pos.quantity).toFixed(4)} ${swingTicker} @ ${Number(swingPrice).toFixed(2)} | PnL: $${Number(pnl).toFixed(2)} | ${swingExit.reason}`, 'SELL');
                        addTrade({ type: 'SELL', price: swingPrice, quantity: pos.quantity, ticker: swingTicker, strategy: 'ADAPTIVE', reason: `[SWING] ${swingExit.reason}`, pnl });
                        
                        const { [swingTicker]: _, ...remaining } = currentPortfolio.positions;
                        currentPortfolio = { ...currentPortfolio, cash: currentPortfolio.cash + pos.quantity * swingPrice, positions: remaining };
                    
                    } else if (!currentPortfolio.positions[swingTicker]) {
                        // Check for new swing entries
                        const swingAnalysis = analyzeSwingSetup(swingTicker, swingData.candles);
                        if (swingAnalysis.hasSetup && swingAnalysis.setup && swingAnalysis.setup.confidence >= PROFIT_METHODS.SWING.MIN_CONFIDENCE && swingAnalysis.setup.riskReward >= PROFIT_METHODS.SWING.MIN_RISK_REWARD) {
                            const swingAmount = Math.min(currentPortfolio.cash * PROFIT_METHODS.SWING.PORTFOLIO_ALLOCATION, currentPortfolio.cash * 0.15);
                            if (swingAmount > 1) {
                                const swingQty = swingAmount / swingPrice;
                                openSwingPosition(swingAnalysis.setup, swingQty);
                                addLog(`SWING LONG: ${swingQty.toFixed(4)} ${swingTicker} @ ${swingPrice.toFixed(2)} | TP: ${swingAnalysis.setup.targetPrice.toFixed(2)}, SL: ${swingAnalysis.setup.stopLoss.toFixed(2)} | R/R: ${swingAnalysis.setup.riskReward.toFixed(1)}`, 'BUY');
                                addTrade({ type: 'BUY', price: swingPrice, quantity: swingQty, ticker: swingTicker, strategy: 'ADAPTIVE', reason: `[SWING] ${swingAnalysis.setup.reason}` });

                                currentPortfolio = {
                                    ...currentPortfolio,
                                    cash: currentPortfolio.cash - swingAmount,
                                    positions: {
                                        ...currentPortfolio.positions,
                                        [swingTicker]: { quantity: swingQty, openPrice: swingPrice, ticker: swingTicker, entryStrategy: 'ADAPTIVE' as TradingStrategy, entryTime: Date.now(), highestPrice: swingPrice, lowestPrice: swingPrice, exitStage: 0, originalQuantity: swingQty }
                                    }
                                };
                            }
                        }
                    }
                }
            }

            // --- MARKET MAKING ---
            if (PROFIT_METHODS.MARKET_MAKING.ENABLED) {
                for (const mmTicker of availableTickers) {
                    const mmData = watchlistDataRef.current[mmTicker];
                    if (!mmData || mmData.candles.length < 10) continue;

                    const mmSignal = processMarketMaking(mmTicker, mmData.candles, currentPortfolio.cash * PROFIT_METHODS.MARKET_MAKING.PORTFOLIO_ALLOCATION);
                    if (mmSignal && mmSignal.shouldAct && mmSignal.action === 'PLACE_ORDERS' && currentPortfolio.cash > 2) {
                        // Simulate placing bid/ask orders
                        if (Math.random() < 0.1) { // Log occasionally
                             addLog(`MM UPDATE: ${mmTicker} | Bid: ${mmSignal.bidPrice.toFixed(2)}, Ask: ${mmSignal.askPrice.toFixed(2)}`, 'INFO');
                        }
                    }
                }
            }


            setPortfolio(currentPortfolio);

        }, loopInterval);

        return () => clearInterval(botInterval);
    }, [isBotActive, isTradingActive, tradingMode, addLog, addTrade, strategy, riskAmount, profitGoals, sessionProfitGoal, maxConcurrentTrades, useTrailingStop, trailingStopPercent, stopLossPercent, isScannerActive, ticker, aiLearningEnabled, assetIntelligenceEnabled, volatilityAnalysisEnabled, enhancedSentimentEnabled, onChainEnabled, riskMetricsEnabled, microTradingEnabled, unlimitedTrades, sessionStartTime]);


    const handleStartSimulation = (budget: number, selectedTicker: string) => {
        addLog(`Starting SIMULATION session with $${budget} for ${selectedTicker}`);
        setPortfolio({
            cash: budget,
            initialBudget: budget,
            positions: {},
        });
        setTicker(selectedTicker);
        setTrades([]);
        resetEquityTracking();
        setSessionStartTime(Date.now());
        setIsTradingActive(true);
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
        if (tradingMode !== 'SIMULATION') {
            addLog('Close All is only available in Simulation mode for now.', 'WARN');
            return;
        }

        let currentPortfolio = { ...portfolioRef.current };
        const openPositions = Object.keys(currentPortfolio.positions);
        if (openPositions.length === 0) {
            addLog('No open positions to close.', 'INFO');
            return;
        }

        addLog(`Closing all ${openPositions.length} positions at market price...`, 'WARN');

        for (const positionTicker of openPositions) {
            const position = currentPortfolio.positions[positionTicker];
            const currentData = watchlistDataRef.current[positionTicker];
            if (!currentData || currentData.candles.length === 0) {
                addLog(`Could not find market data for ${positionTicker} to close position.`, 'ERROR');
                continue;
            };

            const currentPrice = Number(currentData.candles.at(-1)!.close) || 0;
            const pnl = (currentPrice - position.openPrice) * position.quantity;
            const saleValue = position.quantity * currentPrice;
            const sellFee = saleValue * TRADING_FEES.TAKER_FEE_PERCENT / 100;

            addLog(
                `FORCE SELL: ${Number(position.quantity).toFixed(SYSTEM_LIMITS.QUANTITY_DECIMAL_PLACES)} ${positionTicker} @ ${Number(currentPrice).toFixed(SYSTEM_LIMITS.PRICE_DECIMAL_PLACES)}. PnL: $${Number(pnl).toFixed(2)}.`,
                'SELL'
            );

            addTrade({
                type: 'SELL',
                price: currentPrice,
                quantity: position.quantity,
                ticker: positionTicker,
                strategy: position.entryStrategy,
                reason: 'Manual Close All',
                pnl
            });

            const { [positionTicker]: _, ...remainingPositions } = currentPortfolio.positions;
            currentPortfolio = {
                ...currentPortfolio,
                cash: currentPortfolio.cash + saleValue - sellFee,
                positions: remainingPositions
            };
        }

        setPortfolio(currentPortfolio);
        addLog('All positions have been closed.', 'SPECIAL');
    };


    const toggleBot = (isActive: boolean) => {
        if (isActive && tradingMode === 'REAL' && !isApiAuthenticated) {
            addLog('Cannot start real trading bot without API authentication.', 'ERROR');
            setIsAuthModalOpen(true);
            return;
        }
        setIsBotActive(isActive);
        if (isActive) {
            addLog(`Auto-trading bot has been ACTIVATED. Mode: ${tradingMode}.`, 'SPECIAL');
            // If starting bot, also start the session timer
             if (!sessionStartTime) {
                setSessionStartTime(Date.now());
                resetEquityTracking();
             }
        } else {
            addLog('Auto-trading bot has been DEACTIVATED.', 'WARN');
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
                </div>

                {/* Right Column */}
                <div className="lg:col-span-3 space-y-4">
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
