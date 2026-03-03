// Use 'import' syntax for ES Modules
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import http from 'node:http';
import fetch from 'node-fetch';
import { URLSearchParams, fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { 
    calculateTCSeries, 
    calculateBreakoutDetectorSeries, 
    calculateWhaleMoneyFlowSeries, 
    calculateTrendDashboard, 
    calculateMomentumSeries, 
    calculateDivergence, 
    calculateAdaptiveTCSeries,
    // New Smart Trading Features
    detectMarketRegime,
    calculateOpportunityScore,
    calculateAdaptiveData,
    calculateATR
} from './server-indicator-service.js';

// Import Advanced Services (dead imports removed: VolatilityService, SentimentService, RiskService)

// Feature names for SHAP explainer (Batch 2B fix)
import { getFeatureNames } from './services/featureEngineering.js';

import { 
    initializeDatabase, 
    closeDatabase, 
    insertCandlesBatch, 
    setSetting, 
    getSetting,
    insertSystemLog,
    getSystemLogs
} from './services/database.js';
import persistenceRoutes from './routes/persistence.js';
import tradingviewRoutes, { injectSignal } from './routes/tradingview.js';
import { SignalScanner } from './services/signalScanner.js';
import { checkProfitMethodExits, runProfitMethods, getProfitMethodsStatus, exportState as pmExportState, importState as pmImportState, setSessionStart as pmSetSessionStart, cleanupProfitMethodState, persistPositionsToDB, restorePositionsFromDatabase } from './services/profitMethods.js';

// Phase 2-5 Services
// WebSocket services are accessed dynamically via getWebSocketService()
import * as cryptoComWsService from './services/websocketService.js';
import { analyzeMultiTimeframe, shouldEnterLong, getMultiTimeframeStatus } from './services/multiTimeframe.js';
import { recordTradeResult as cbRecordTrade, setDailyBalance, setCurrentBalance, shouldPauseTrading, resetCircuitBreaker, fullResetCircuitBreaker, calculateKellyFraction, getKellyPositionSize, getStrategyKelly, getCircuitBreakerStatus, exportState as cbExportState, importState as cbImportState } from './services/circuitBreaker.js';
import { recordStrategyResult, getStrategyWeight, adjustPositionSize, isStrategyThrottled, getAdaptiveWeightsStatus, fullResetWeights, exportState as awExportState, importState as awImportState } from './services/adaptiveWeights.js';
import { calculateAllIndicators } from './services/advancedIndicators.js';
import { runBacktest, getAvailableBacktestData, runMultiBacktest, runWalkForward, runParameterSweep } from './services/backtestEngine.js';
import { getSocialSentimentScore, fetchFearGreedIndex, shouldTradeBasedOnSentiment } from './services/socialSentiment.js';
import { getPreTradeDecision, getPreTradeAIStatus } from './services/preTradeAI.js';
import { getMarketRegime, getStrategyPool, isStrategyAllowedForRegime, adjustForVolatility, getCompoundMultiplier, getDynamicTargets, checkDynamicExit, recordTradeResult as beastRecordTrade, updateBalance as beastUpdateBalance, setSessionBalance as beastSetSessionBalance, fullResetBeastMode, getBeastModeStatus, exportState as beastExportState, importState as beastImportState, setRoundTripFee as beastSetRoundTripFee, setTargetOverrides } from './services/beastMode.js';
import { triggerOptimization, getOptimizedEntryParams, getOptimizedTargets, getOptimizerStatus, forceOptimize, recordPostOptTrade, resetToDefaults as resetOptimizer, setFeeForSimulation, exportState as optExportState, importState as optImportState } from './services/parameterOptimizer.js';

// Phase 6: New Backend Services (SIM parity)
import { getMasterSurgeDecision, detectSurge, detectCandlestickPatterns } from './services/surgeTradingBackend.js';
import { recordTradeForLearning, shouldTakeTradeAI, getAILearningStatus, restoreFromDatabase as restoreAILearning, getParameterAdjustments } from './services/aiLearningBackend.js';
import { getOnChainSignals } from './services/onChainBackend.js';
import { getLearnedState } from './services/historicalTrainingEngine.js';
import { getTrainingRun, pingDatabase } from './services/database.js';
import { getAssetProfile, getStrategyAssetMatch, getBestStrategyForAsset, getPositionSizeForLiquidity, getRiskAdjustedParams } from './services/assetIntelligenceBackend.js';
import * as CapitalTierManager from './services/capitalTierManager.js';
import * as SessionManager from './services/sessionManager.js';

// Batch 1: Trading Performance Services
import { isStrategyEnabledForRegime, filterStrategiesByRegime } from './services/regimeStrategyMap.js';
import { getMTFAlignmentScore, getMTFConfidencePoints } from './services/mtfConfluence.js';
import { getFundingRateSignal, getFundingConfidenceAdjustment, shouldBlockEntryOnFunding, isFundingContrarian } from './services/fundingRateStrategy.js';

// Batch 2: Intelligence Layer Services
import { getOrderBookSignal, getOrderBookConfidenceAdjustment } from './services/orderBookSignals.js';
import { analyzeOrderBook, optimizeEntryExit } from './services/orderBookService.js';
import { getCorrelationMatrix, checkCorrelationRisk } from './services/correlationRiskBackend.js';
import { initJournalTable, recordTradeForJournal, autoJournal, getJournalEntries, forceGenerateJournal } from './services/tradeJournal.js';

// Batch 3: Quality of Life Services
import { initTelegram, isEnabled as telegramEnabled, getStatus as telegramStatus, alertTradeExecution, alertCircuitBreaker, sendTestMessage } from './services/telegramService.js';

// Batch 5: Session Persistence
import {
  saveFullState, restoreFullState, getSessionStatus, recordSessionTrade, startAutoSave, stopAutoSave,
  setActiveSession, getActiveSessionId, getTradingMode,
  recordEquitySnapshot, recordSessionTradeDetail,
  getEquityCurve, getTradeHistory, getTradeStats,
} from './services/sessionPersistence.js';

// ML Thought Logger
import { logThought, getThoughts, getCurrentFocus, getThoughtStats, clearThoughts, setSessionId as setThoughtSessionId, restoreThoughts } from './services/mlThoughtLogger.js';

// New Questrade & AI Services
import { QuestradeService } from './services/questradeService.js';
import { PaperTrader } from './services/PaperTrader.js';
import { StrategyEngine } from './services/StrategyEngine.js';
import { GeminiBrain } from './services/GeminiBrain.js';
import { dataIngestion } from './services/DataIngestionService.js';

// Exchange Adapter System
import { getExchangeAdapter, setActiveExchange, getActiveExchangeId, listExchanges, setSessionManager as setAdapterSessionManager, getWebSocketService } from './services/exchangeAdapters/index.js';

// Route Modules
import createMarketRouter from './routes/market.js';
import createExchangeRouter from './routes/exchange.js';
import createAuthRouter from './routes/auth.js';
import createQuestradeRouter from './routes/questrade.js';
import createSessionsRouter from './routes/sessions.js';
import createIntelligenceRouter from './routes/intelligence.js';
import createSentimentRouter from './routes/sentiment.js';
import createSignalsRouter from './routes/signals.js';
import createNotificationsRouter from './routes/notifications.js';
import createConfigRouter from './routes/config.js';
import createBacktestRouter from './routes/backtest.js';
import createMultiExchangeRouter from './routes/multiExchange.js';

// Phase 7: Multi-Exchange Data + ML Services
import {
    insertExchangeSnapshot, getExchangeSnapshots, getLatestExchangeSnapshot,
    insertDerivativesData, getDerivativesHistory, getLatestDerivatives,
    insertDeFiSnapshot, getLatestDeFiSnapshot, getDeFiHistory,
    insertNewsItem, insertNewsItemsBatch, getNewsItems,
    insertMLFeatures, getUnlabeledFeatures, getLabeledFeatures, labelMLFeatures,
    insertMLModel, getLatestMLModel, getMLModelHistory,
    insertMLPrediction, resolveMLPrediction, getMLPredictions, getMLAccuracyStats,
    cleanupOldData,
    insertSessionRecord, completeSession, markAbandonedSessions, getSessionHistory, getSessionDetail
} from './services/database.js';

// ML Pipeline (4-Layer System)
import { initSystemConfig, getAllFlags, setFlags, getFlag, killAll as killAllSystems } from './services/systemConfig.js';
import * as mlGatekeeper from './services/mlGatekeeper.js';
import * as portfolioCorrelationEngine from './services/portfolioCorrelationEngine.js';
import * as adversarialBrains from './services/adversarialBrains.js';
import { getPopulation as getGeneticPopulation } from './services/geneticStrategyEngine.js';

// Batch 4C: Continuous backtester
let continuousBacktester = null;
try {
    continuousBacktester = await import('./services/continuousBacktester.js');
    console.log('[Server] Continuous backtester loaded');
} catch (e) {
    console.warn('[Server] Continuous backtester not available:', e.message);
}

let multiExchangeService = null;
let mlPredictionService = null;
let selfTeachingLoop = null;
let smartMoneyService = null;
let localNLPService = null;
let adaptiveThresholdsService = null;
let shapExplainer = null;       // Upgrade #12: SHAP values
let portfolioOptimizer = null;  // Upgrade #10: Portfolio rebalancer

try {
    const mes = await import('./services/multiExchangeService.js');
    multiExchangeService = mes;
    console.log('[Server] Multi-exchange service loaded');
} catch (e) {
    console.warn('[Server] Multi-exchange service not available:', e.message);
}

try {
    mlPredictionService = await import('./services/mlPredictionService.js');
    console.log('[Server] ML prediction service loaded');
} catch (e) {
    console.warn('[Server] ML prediction service not available:', e.message);
}

try {
    selfTeachingLoop = await import('./services/selfTeachingLoop.js');
    console.log('[Server] Self-teaching loop loaded');
} catch (e) {
    console.warn('[Server] Self-teaching loop not available:', e.message);
}

try {
    smartMoneyService = await import('./services/smartMoneyService.js');
    console.log('[Server] Smart money service loaded');
} catch (e) {
    console.warn('[Server] Smart money service not available:', e.message);
}

try {
    localNLPService = await import('./services/localNLPService.js');
    console.log('[Server] Local NLP service loaded');
} catch (e) {
    console.warn('[Server] Local NLP service not available:', e.message);
}

try {
    adaptiveThresholdsService = await import('./services/adaptiveThresholds.js');
    console.log('[Server] Adaptive thresholds service loaded');
} catch (e) {
    console.warn('[Server] Adaptive thresholds service not available:', e.message);
}

// Performance Upgrade services
try {
    shapExplainer = await import('./services/shapExplainer.js');
    console.log('[Server] SHAP explainer loaded');
} catch (e) {
    console.warn('[Server] SHAP explainer not available:', e.message);
}

try {
    portfolioOptimizer = await import('./services/portfolioOptimizer.js');
    console.log('[Server] Portfolio optimizer loaded');
} catch (e) {
    console.warn('[Server] Portfolio optimizer not available:', e.message);
}

// Execution Engine (Batch 2D: activate dead code)
let executionEngine = null;
try {
    executionEngine = await import('./services/executionEngine.js');
    console.log('[Server] Execution engine loaded');
} catch (e) {
    console.warn('[Server] Execution engine not available:', e.message);
}

// On-Chain Data Service (Batch 2A: wire into ML features)
let onChainDataService = null;
try {
    onChainDataService = await import('./services/onChainDataService.js');
    console.log('[Server] On-chain data service loaded');
} catch (e) {
    console.warn('[Server] On-chain data service not available:', e.message);
}

// Redis Cache
let redisCache = null;
try {
    redisCache = await import('./services/redisCache.js');
    console.log('[Server] Redis cache loaded:', redisCache.getStats().mode);
} catch (e) {
    console.warn('[Server] Redis cache not available:', e.message);
}

// External data services
let cryptoCompareService = null;
let etherscanService = null;
let messariService = null;
let coinDeskService = null;
let coinMarketCapService = null;

try { cryptoCompareService = await import('./services/cryptoCompareService.js'); console.log('[Server] CryptoCompare service loaded'); } catch (e) {}
try { etherscanService = await import('./services/etherscanService.js'); console.log('[Server] Etherscan service loaded'); } catch (e) {}
try { messariService = await import('./services/messariService.js'); console.log('[Server] Messari service loaded'); } catch (e) {}
try { coinDeskService = await import('./services/coinDeskService.js'); console.log('[Server] CoinDesk service loaded'); } catch (e) {}
try { coinMarketCapService = await import('./services/coinMarketCapService.js'); console.log('[Server] CoinMarketCap service loaded'); } catch (e) {}

// Phase 4: Enhanced Sentiment Services
let youtubeSentimentService = null;
let redditSentimentService = null;

try {
    youtubeSentimentService = await import('./services/youtubeSentimentService.js');
    console.log('[Server] YouTube sentiment service loaded');
} catch (e) {
    console.warn('[Server] YouTube sentiment service not available:', e.message);
}

try {
    redditSentimentService = await import('./services/redditSentimentService.js');
    console.log('[Server] Reddit sentiment service loaded');
} catch (e) {
    console.warn('[Server] Reddit sentiment service not available:', e.message);
}

// Phase 3: Timeframe Strategy Service
let timeframeStrategyService = null;
try {
    timeframeStrategyService = await import('./services/timeframeStrategyService.js');
    console.log('[Server] Timeframe strategy service loaded');
} catch (e) {
    console.warn('[Server] Timeframe strategy service not available:', e.message);
}

// Phase 2: Kraken Minimums
let krakenMinimums = null;
try {
    krakenMinimums = await import('./services/krakenMinimums.js');
    console.log('[Server] Kraken minimums service loaded');
} catch (e) {
    console.warn('[Server] Kraken minimums service not available:', e.message);
}

// Load environment variables from .env file
import 'dotenv/config';

// ============================================
// DYNAMIC WEBSOCKET + FEE HELPERS
// ============================================

/** Get the active WS service (Crypto.com or Kraken) based on current exchange */
function getActiveWsService() {
    return getWebSocketService();
}

/** Proxy functions that delegate to the active WS service */
function mergeCandles(restCandles, ticker) {
    return getActiveWsService().mergeCandles(restCandles, ticker);
}
function getLatestPrice(ticker) {
    return getActiveWsService().getLatestPrice(ticker);
}
function getRealtimeCandles(ticker) {
    return getActiveWsService().getRealtimeCandles(ticker);
}
function wsSubscribeTickers(tickers) {
    return getActiveWsService().subscribeTickers(tickers);
}
function wsConnected() {
    return getActiveWsService().isConnected();
}
function getWebSocketStatusProxy() {
    return getActiveWsService().getWebSocketStatus();
}

/** Get dynamic fees from the active exchange adapter */
function getActiveFees() {
    const adapter = getExchangeAdapter();
    const perSide = adapter.getFeePercent();  // e.g. 0.00075 or 0.0026
    return { perSide, roundTrip: perSide * 2 };
}

/** Stored reference to broadcastToFrontend for WS reconnect on exchange switch */
let _broadcastToFrontend = null;

/** Initialize WebSocket for the active exchange with candle/trade relay to frontend */
function initExchangeWebSocket(tickers, broadcastFn) {
    if (broadcastFn) _broadcastToFrontend = broadcastFn;
    const wsService = getActiveWsService();
    wsService.initWebSocket(tickers, {
        onConnect: () => console.log(`[WS] Connected to ${getActiveExchangeId()} market stream`),
        onCandle: (ticker, candles) => {
            if (candles && candles.length > 0 && _broadcastToFrontend) {
                const latest = candles[candles.length - 1];
                _broadcastToFrontend({
                    method: 'subscribe',
                    result: {
                        channel: `candlestick.1m.${ticker.replace(/USD$/, '_USD')}`,
                        instrument_name: ticker.replace(/USD$/, '_USD'),
                        data: [latest]
                    }
                });
            }
        },
        onTrade: (ticker, trade) => {
            if (_broadcastToFrontend) {
                _broadcastToFrontend({
                    method: 'subscribe',
                    result: {
                        channel: `trade.${ticker.replace(/USD$/, '_USD')}`,
                        instrument_name: ticker.replace(/USD$/, '_USD'),
                        data: [trade]
                    }
                });
            }
            // Real-time SL/TP exit check on every trade tick
            if (portfolio.positions[ticker] && exitLevelCache.has(ticker)) {
                checkTickExit(ticker, trade.price);
            }
        }
    });
}

/** Reconnect WebSocket when exchange is switched */
function reconnectWebSocketForExchange(tickers) {
    // Close the old WS (try both services to be safe)
    try { cryptoComWsService.closeWebSocket(); } catch (e) { console.warn('[WS] Error closing Crypto.com WS:', e.message); }
    try {
        const krakenWs = getWebSocketService('kraken');
        krakenWs.closeWebSocket();
    } catch (e) { console.warn('[WS] Error closing Kraken WS:', e.message); }

    // Init the new one
    initExchangeWebSocket(tickers, _broadcastToFrontend);
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    PORT: 3033,
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
    API_BASE_URL: 'https://api.crypto.com/exchange/v1/',
    BOT_INTERVAL_MS: 2000,             // Beast Mode: 2s (was 5s)
    TICKER_REFRESH_MS: 3600000,
    MAX_LOGS: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 600,

    // Signal thresholds (BEAST MODE - further relaxed ~10-15%)
    THRESHOLDS: {
        TREND_BULLISH_ENTRY: 40,       // Tightened: was 50 (lower = more bullish required)
        TREND_BEARISH_EXIT: 75,        // Beast Mode: was 70 (hold longer)
        BREAKOUT_SQUEEZE_ENTRY: 40,    // Beast Mode: was 35
        BREAKOUT_EXPANSION_EXIT: 60,   // Beast Mode: was 55
        WHALE_BUYING_ENTRY: 48,        // Beast Mode: was 52
        WHALE_SELLING_EXIT: 35,        // Beast Mode: was 40 (hold longer)
        CONFLUENCE_BULLISH_ENTRY: 2,   // Beast Mode: was 3
        CONFLUENCE_BEARISH_EXIT: 1,    // Beast Mode: was 2
        // MOMENTUM Strategy
        MOMENTUM_BULLISH_ENTRY: 50,    // Beast Mode: was 55
        MOMENTUM_BEARISH_EXIT: 25,     // Beast Mode: was 30 (hold longer)
        // DIVERGENCE Strategy
        DIVERGENCE_MIN_CONFIDENCE: 35, // Beast Mode: was 45
        // ADAPTIVE Strategy (TC Adaptive Trades in Favor)
        ADAPTIVE_BULLISH_ENTRY: 45,    // Beast Mode: was 40
        ADAPTIVE_BEARISH_EXIT: 75,     // Beast Mode: was 70
    },

    MIN_TRADE_SIZE: 1.00,              // Practical minimum for Crypto.com
    MIN_CANDLES_REQUIRED: 30,          // Need sufficient data for reliable indicators

    // Liquidity filter: reject tickers with insufficient volume
    MIN_AVG_CANDLE_USD_VOLUME: 5000,   // $5K avg per-candle USD volume (from recent 20 candles)
    MIN_PRICE: 0.01,                   // Skip sub-penny tokens
};

// ============================================
// QUALITY TICKER WHITELIST (~50 established, liquid coins)
// ============================================
const QUALITY_TICKERS = [
    'BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'BNBUSD', 'ADAUSD', 'DOGEUSD',
    'AVAXUSD', 'LINKUSD', 'DOTUSD', 'POLUSD', 'UNIUSD', 'ATOMUSD', 'LTCUSD',
    'BCHUSD', 'NEARUSD', 'FILUSD', 'APTUSD', 'ARBUSD', 'OPUSD',
    'AAVEUSD', 'INJUSD', 'SUIUSD', 'SEIUSD', 'TIAUSD',
    'RENDERUSD', 'FETUSD', 'GRTUSD', 'IMXUSD', 'SANDUSD', 'MANAUSD',
    'AXSUSD', 'ALGOUSD', 'SONICUSD', 'RUNEUSD', 'ENSUSD', 'LDOUSD',
    'SNXUSD', 'COMPUSD', 'CRVUSD', 'SUSHIUSD', 'YFIUSD',
    'PEPEUSD', 'SHIBUSD', 'BONKUSD', 'WIFUSD', 'FLOKIUSD',
    'ICPUSD', 'HBARUSD', 'VETUSD', 'XTZUSD', 'EGLDUSD',
];

// ============================================
// Server Setup
// ============================================
const app = express();
let publicIp = 'not detected';

// Initialize Exchange Adapter with SessionManager
setAdapterSessionManager(SessionManager);

// Initialize New Services
const questrade = new QuestradeService();
const paperTrader = new PaperTrader(questrade, 100000);
const strategyEngine = new StrategyEngine();
const brain = new GeminiBrain();
const brainThoughts = []; // Store thinking logs

// Questrade Bot State
let questradeBotState = {
    isActive: false,
    isPaper: true,
    accountId: null,
    watchlist: ['SHOP', 'TD', 'RY', 'BNS', 'ENB', 'CNR', 'CP', 'BMO', 'BCE', 'T'],
    interval: null,
    loopMs: 5000,
};

// Setup Brain Listeners
brain.on('thought', (thought) => {
    brainThoughts.unshift({ time: Date.now(), ...thought });
    if (brainThoughts.length > 50) brainThoughts.pop();
    // Also push to main logs
    addLog(`[BRAIN] ${thought.type}: ${thought.decision || 'Thinking'} on ${thought.asset}`, 'AI');
});

brain.on('learning', (data) => {
    addLog(`[BRAIN] Learning insights: ${data.insights.slice(0, 100)}...`, 'AI');
});

// Setup Data Ingestion Listeners
dataIngestion.on('data', (items) => {
    // Optionally trigger immediate analysis on breaking news
    if (items.length > 0) {
        // console.log(`[DataIngestion] Received ${items.length} new items`);
    }
});

// ============================================
// Rate Limiting (Simple in-memory implementation)
// ============================================
const rateLimitStore = new Map();

// Clean up stale IPs every 5 minutes to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, requests] of rateLimitStore) {
        if (requests.length === 0 || requests[requests.length - 1] < now - CONFIG.RATE_LIMIT_WINDOW_MS) {
            rateLimitStore.delete(ip);
        }
    }
}, 5 * 60 * 1000);

const rateLimit = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    // Skip rate limiting for localhost (personal trading app)
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        return next();
    }
    const now = Date.now();
    const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

    // Clean old entries
    const requests = rateLimitStore.get(ip) || [];
    const recentRequests = requests.filter(time => time > windowStart);

    if (recentRequests.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({
            message: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil((recentRequests[0] + CONFIG.RATE_LIMIT_WINDOW_MS - now) / 1000)
        });
    }

    recentRequests.push(now);
    rateLimitStore.set(ip, recentRequests);
    next();
};

// ============================================
// Middleware
// ============================================
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        // Allow localhost on any port for development
        if (origin.startsWith('http://localhost:')) return callback(null, true);
        // Allow same-server access (browser accessing the server directly by IP/hostname)
        const serverPort = CONFIG.PORT || 3033;
        if (origin === `http://localhost:${serverPort}`) return callback(null, true);
        if (/^https?:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(origin)) return callback(null, true);
        // Allow VPS direct access
        const vpsIp = process.env.VPS_IP;
        if (vpsIp && origin.includes(vpsIp)) return callback(null, true);
        // Allow configured origin
        if (origin === CONFIG.CORS_ORIGIN) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(express.json({ limit: '10mb' })); // Increased for candle batch inserts
// Rate limiting disabled for local development — re-enable for production/VPS
// app.use(rateLimit);

// Serve built frontend (production)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'dist')));

// Mount persistence routes (SQLite database)
app.use('/api/db', persistenceRoutes);

// Mount TradingView webhook routes (Batch 6A: re-enabled)
app.use('/api/tradingview', tradingviewRoutes);

// Mount Historical Training (Time Machine) routes
let trainingRoutes = null;
try {
    const mod = await import('./routes/training.js');
    trainingRoutes = mod.default;
    app.use('/api/training', trainingRoutes);
    console.log('[Server] Training routes loaded');
} catch (e) {
    console.warn('[Server] Training routes not available:', e.message);
}

// ML Pipeline System Config API
app.get('/api/system-config', (req, res) => {
    try {
        const flags = getAllFlags();
        const stats = {
            flags,
            gatekeeper: mlGatekeeper.getGatekeeperStats(),
            correlation: portfolioCorrelationEngine.getCorrelationStatus(),
            adversarial: adversarialBrains.getAdversarialStatus(),
            genetic: (() => { try { return getGeneticPopulation().getStatus(); } catch(e) { return { enabled: false }; } })(),
        };
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/system-config', express.json(), (req, res) => {
    try {
        const updates = req.body;
        if (updates.killAll) {
            killAllSystems();
            return res.json({ success: true, message: 'All systems disabled', flags: getAllFlags() });
        }
        if (updates.flags) {
            setFlags(updates.flags);
        }
        res.json({ success: true, flags: getAllFlags() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Continuous Backtest API (Batch 4C) ---
app.get('/api/backtest/continuous', (req, res) => {
    try {
        if (!continuousBacktester) return res.json({ enabled: false });
        const { strategy } = req.query;
        const results = strategy
            ? continuousBacktester.getBacktestHistory(strategy)
            : continuousBacktester.getBacktestResults();
        res.json({ enabled: true, status: continuousBacktester.getStatus(), results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Redis Cache Stats API (Batch 1A) ---
app.get('/api/cache/stats', (req, res) => {
    try {
        res.json(redisCache ? redisCache.getStats() : { mode: 'none' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ML Health Check Endpoint (Upgrade #14) ---
app.get('/api/health/ml', (req, res) => {
    try {
        const mlStatus = mlPredictionService?.getMLStatus?.() || {};
        const engineStats = mlPredictionService?.getMLEngine?.()?.getModelStats() || {};
        res.json({
            status: 'ok',
            ml: {
                initialized: mlStatus.isInitialized,
                trained: mlStatus.isTrained,
                accuracy: mlStatus.accuracy,
                sampleCount: mlStatus.sampleCount,
                predictionCount: mlStatus.predictionCount,
                featureCount: mlStatus.featureCount,
                lastTrainTime: mlStatus.lastTrainTime,
                hasLSTM: engineStats.hasLSTM || false,
                hasCalibration: engineStats.hasCalibration || false,
                rfTreeCount: engineStats.rfTreeCount || 0,
                gbtTreeCount: engineStats.gbtTreeCount || 0,
                selectedFeatureCount: engineStats.selectedFeatureCount || null,
            },
            uptime: process.uptime(),
            memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// --- Monte Carlo Backtest Endpoint (Upgrade #11) ---
app.get('/api/backtest/monte-carlo', async (req, res) => {
    try {
        let monteCarloService;
        try {
            monteCarloService = await import('./services/monteCarloService.js');
        } catch (e) {
            return res.status(501).json({ error: 'Monte Carlo service not available' });
        }

        // Get trade history from session trades
        const sessionId = botState.sessionId;
        let tradeHistory = [];
        if (sessionId && db.getSessionTrades) {
            const trades = db.getSessionTrades(sessionId, 500);
            tradeHistory = trades
                .filter(t => t.type === 'SELL' && t.pnl !== 0)
                .map(t => ({
                    pnl: t.pnl,
                    pnlPercent: t.pnl / (t.price * t.quantity) * 100,
                    holdDuration: 0
                }));
        }

        const nSims = parseInt(req.query.sims) || 1000;
        const result = monteCarloService.runMonteCarloSimulation(tradeHistory, nSims, portfolio.cash + Object.values(portfolio.positions).reduce((s, p) => s + p.quantity * (p.currentPrice || p.openPrice), 0));

        if (!result) {
            return res.json({ error: 'Insufficient trade history (min 20 trades)', trades: tradeHistory.length });
        }

        // Save results
        if (monteCarloService.saveMonteCarloResults) {
            monteCarloService.saveMonteCarloResults(sessionId, result);
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// External data services API endpoint
app.get('/api/market-intelligence', async (req, res) => {
    try {
        const data = {};
        const promises = [];

        if (coinMarketCapService) promises.push(
            coinMarketCapService.getGlobalMetrics?.().then(r => { data.globalMetrics = r; }).catch(() => {})
        );
        if (coinMarketCapService) promises.push(
            coinMarketCapService.getMarketDominance?.().then(r => { data.dominance = r; }).catch(() => {})
        );
        if (coinMarketCapService) promises.push(
            coinMarketCapService.getFearGreedIndex?.().then(r => { data.fearGreed = r; }).catch(() => {})
        );
        if (etherscanService) promises.push(
            etherscanService.getNetworkStats?.().then(r => { data.ethNetwork = r; }).catch(() => {})
        );
        if (coinDeskService) promises.push(
            coinDeskService.getBitcoinPriceIndex?.().then(r => { data.btcPrice = r; }).catch(() => {})
        );
        if (messariService) promises.push(
            messariService.getMarketOverview?.().then(r => { data.messariOverview = r; }).catch(() => {})
        );

        await Promise.all(promises);

        data.services = {
            cryptoCompare: cryptoCompareService?.getStatus?.() || { enabled: false },
            etherscan: etherscanService?.getStatus?.() || { enabled: false },
            messari: messariService?.getStatus?.() || { enabled: false },
            coinDesk: coinDeskService?.getStatus?.() || { enabled: false },
            coinMarketCap: coinMarketCapService?.getStatus?.() || { enabled: false },
        };

        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clean expired sessions periodically
setInterval(() => {
    const cleaned = SessionManager.cleanExpiredSessions();
    if (cleaned > 0) {
        console.log(`[SessionManager] Cleaned up ${cleaned} expired sessions.`);
    }
}, 300000); // Every 5 minutes

// Daily maintenance: vacuum old data, reanalyze indexes (Upgrade #17)
setInterval(() => {
    try {
        db.runMaintenance();
        console.log('[Maintenance] Daily SQLite maintenance completed.');
    } catch (e) {
        console.error('[Maintenance] Error:', e.message);
    }
}, 24 * 60 * 60 * 1000); // Every 24 hours

// ============================================
// In-Memory State
// ============================================
let peakValue = 0; // Track peak portfolio value for drawdown calculation

let botState = {
    isActive: false,
    settings: {},
    sessionId: null,
    tradingMode: 'SIMULATION', // 'SIMULATION' | 'REAL'
    sessionStartTime: null,
};

let portfolio = {
    cash: 0,
    initialBudget: 0,
    positions: {},
};

let logs = [];
let botInterval = null;
let availableTickers = [];
const instrumentSpecs = new Map(); // Cache: instrument_name -> { quantity_decimals, qty_tick_size }

// Sentiment cache: ticker -> { score, timestamp }. TTL = 5 minutes (sentiment changes slowly)
const SENTIMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const sentimentCachePersistent = new Map();

const addLog = (message, type = 'INFO') => {
    const newLog = {
        id: Date.now(),
        time: Date.now(),
        message: `[Backend] ${message}`,
        type
    };
    logs = [newLog, ...logs].slice(0, CONFIG.MAX_LOGS);
    console.log(`[${type}] ${message}`);

    // Persist to database
    try {
        insertSystemLog(newLog);
    } catch (e) {
        console.error(`[Database] Failed to insert log: ${e.message}`);
    }
};

// ============================================
// Timeout Utility (hang protection)
// ============================================
function withTimeout(promise, ms, label = 'operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
        )
    ]);
}

// ============================================
// Crypto.com API Logic
// ============================================
async function makePublicRequest(method, params = {}) {
    const url = new URL(`${CONFIG.API_BASE_URL}${method}`);
    url.search = new URLSearchParams(params).toString();

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const data = await response.json();

    if (data.code != 0) {
        throw new Error(`Crypto.com API Error for ${method}: ${data.message || 'No message'}`);
    }
    return data.result;
}

function paramsToStr(obj, level = 0) {
    const MAX_LEVEL = 3;
    if (level >= MAX_LEVEL) return String(obj);

    let result = '';
    for (const key of Object.keys(obj).sort()) {
        result += key;
        const val = obj[key];
        if (val === null || val === undefined) {
            result += 'null';
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (typeof item === 'object' && item !== null) {
                    result += paramsToStr(item, level + 1);
                } else {
                    result += String(item);
                }
            }
        } else if (typeof val === 'object') {
            result += paramsToStr(val, level + 1);
        } else {
            result += String(val);
        }
    }
    return result;
}

function generateSignature(method, id, apiKey, secretKey, params, nonce) {
    const paramStr = params && Object.keys(params).length > 0
        ? paramsToStr(params, 0)
        : '';
    const sigPayload = method + String(id) + apiKey + paramStr + String(nonce);
    return crypto.createHmac('sha256', secretKey).update(sigPayload).digest('hex');
}

async function makeSignedRequest(method, params = {}, sessionId = null) {
    // Get credentials from session or environment
    let apiKey, secretKey;

    if (sessionId) {
        const session = SessionManager.getSession(sessionId);
        if (session) {
            apiKey = session.apiKey;
            secretKey = session.secretKey;
        }
    }
    
    if (!apiKey || !secretKey) {
        apiKey = process.env.SESSION_API_KEY;
        secretKey = process.env.SESSION_SECRET_KEY;
    }

    if (!apiKey || !secretKey) {
        throw new Error('API credentials not available. Please authenticate first.');
    }

    const id = Date.now();
    const nonce = Date.now();
    const sig = generateSignature(method, id, apiKey, secretKey, params, nonce);

    const response = await fetch(`${CONFIG.API_BASE_URL}${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id,
            method,
            api_key: apiKey,
            params,
            sig,
            nonce
        }),
        signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (data.code != 0) {
        console.error(`[Crypto.com] ${method} failed:`, JSON.stringify(data));
        throw new Error(`Crypto.com API Error (Code: ${data.code}): ${data.message || 'No message provided.'}`);
    }
    return data.result;
}

// Market Data Fetching (Parallel) + Auto-collect to SQLite
// ============================================
async function getMarketData(ticker, timeframe = '1m', count = 100) {
    const adapter = getExchangeAdapter();
    const candles = await adapter.getCandles(ticker, timeframe, count);

    // Auto-collect candles into SQLite for backtesting history
    if (candles && candles.length > 0) {
        try {
            const rows = candles.map(c => ({
                ticker: ticker,
                timeframe: timeframe,
                time: c.t,
                open: c.o,
                high: c.h,
                low: c.l,
                close: c.c,
                volume: c.v,
            }));
            insertCandlesBatch(rows);
        } catch (dbError) {
            // Don't let DB errors break market data fetching
            console.error(`[Database] Candle insert error for ${ticker}: ${dbError.message}`);
        }
    }

    return candles;
}

async function getMultipleMarketData(tickers, timeframe = '1m') {
    const results = [];
    const restNeeded = [];

    // For 1m timeframe: use WebSocket buffer when available (instant, no REST call)
    if (timeframe === '1m' && wsConnected()) {
        for (const ticker of tickers) {
            const wsCandles = getRealtimeCandles(ticker);
            if (wsCandles && wsCandles.length >= CONFIG.MIN_CANDLES_REQUIRED) {
                // WS buffer has enough candles — use directly, skip REST
                // Persist to SQLite async (non-blocking) for backtesting history
                try {
                    const rows = wsCandles.slice(-50).map(c => ({
                        ticker, timeframe: '1m', time: c.t,
                        open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
                    }));
                    insertCandlesBatch(rows);
                } catch (e) { /* non-blocking */ }
                results.push({ ticker, candles: wsCandles, error: null, source: 'ws' });
            } else {
                restNeeded.push(ticker);
            }
        }
    } else {
        restNeeded.push(...tickers);
    }

    // REST-fetch only tickers that don't have sufficient WS data
    if (restNeeded.length > 0) {
        const promises = restNeeded.map(async (ticker) => {
            try {
                const candles = await getMarketData(ticker, timeframe);
                return { ticker, candles, error: null, source: 'rest' };
            } catch (error) {
                return { ticker, candles: null, error: error.message, source: 'rest' };
            }
        });
        const restResults = await Promise.all(promises);
        results.push(...restResults);
    }

    return results;
}

// ============================================
// Input Validation
// ============================================
function validateBotSettings(settings) {
    const errors = [];

    if (typeof settings.riskAmount !== 'number' || settings.riskAmount <= 0 || settings.riskAmount > 1) {
        errors.push('riskAmount must be a number between 0 and 1');
    }

    if (typeof settings.maxConcurrentTrades !== 'number' || settings.maxConcurrentTrades < 1 || settings.maxConcurrentTrades > 20) {
        errors.push('maxConcurrentTrades must be between 1 and 20');
    }

    if (typeof settings.sessionProfitGoal !== 'number' || settings.sessionProfitGoal < 0) {
        errors.push('sessionProfitGoal must be a non-negative number');
    }

    if (settings.profitGoal !== undefined && (typeof settings.profitGoal !== 'number' || settings.profitGoal < 0)) {
        errors.push('profitGoal must be a non-negative number');
    }

    return errors;
}

// ============================================
// Session State Persistence
// ============================================
function saveSessionState() {
  try {
    setSetting('session_portfolio', JSON.stringify({
      cash: portfolio.cash,
      initialBudget: portfolio.initialBudget,
      positions: portfolio.positions,
      holdings: portfolio.holdings || {},
      tradeLog: (portfolio.tradeLog || []).slice(-500),
    }));
    setSetting('session_bot', JSON.stringify({
      isActive: botState.isActive,
      settings: botState.settings,
      sessionId: botState.sessionId,
      tradingMode: botState.tradingMode,
      sessionStartTime: botState.sessionStartTime,
    }));
    setSetting('session_circuit_breaker', JSON.stringify(cbExportState()));
    setSetting('session_adaptive_weights', JSON.stringify(awExportState()));
    setSetting('session_beast_mode', JSON.stringify(beastExportState()));
    setSetting('session_optimizer', JSON.stringify(optExportState()));
    setSetting('session_profit_methods', JSON.stringify(pmExportState()));
    setSetting('session_timestamp', JSON.stringify(Date.now()));
    // Persist DCA/Grid/Swing positions to SQLite
    persistPositionsToDB();
  } catch (e) {
    console.log(`[SESSION] Save failed: ${e.message}`);
  }
}

// ============================================
// Liquidity Filter
// ============================================
/**
 * Check if a ticker has sufficient volume to trade.
 * Computes avg USD volume per candle over the most recent 20 candles.
 * @param {Array<{o,h,l,c,v}>} candles
 * @returns {{ pass: boolean, avgUsdVol: number, reason?: string }}
 */
function checkLiquidity(candles) {
    if (!candles || candles.length < 5) return { pass: false, avgUsdVol: 0, reason: 'insufficient candles' };

    const recent = candles.slice(-20);
    const lastPrice = recent[recent.length - 1].c;

    // Price floor: skip sub-penny tokens
    if (lastPrice < CONFIG.MIN_PRICE) {
        return { pass: false, avgUsdVol: 0, reason: `price $${lastPrice} < $${CONFIG.MIN_PRICE} floor` };
    }

    // Volume check: avg USD volume per candle
    let totalUsdVol = 0;
    for (const c of recent) {
        const typicalPrice = (c.o + c.c) / 2;
        totalUsdVol += (c.v || 0) * typicalPrice;
    }
    const avgUsdVol = totalUsdVol / recent.length;

    if (avgUsdVol < CONFIG.MIN_AVG_CANDLE_USD_VOLUME) {
        return { pass: false, avgUsdVol, reason: `avg candle vol $${avgUsdVol.toFixed(0)} < $${CONFIG.MIN_AVG_CANDLE_USD_VOLUME}` };
    }

    // Stale price check: if latest WS price diverges >50% from candle close, skip
    // (catches tokens where candle data and live feed are wildly different)
    return { pass: true, avgUsdVol };
}

/**
 * Simple EMA calculation for 1h cross-TF trend check.
 * Returns null if not enough data.
 */
function simpleEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const mult = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * mult + ema;
    }
    return ema;
}

/**
 * Check 1h trend direction: EMA(9) vs EMA(21).
 * Returns 'BULLISH', 'BEARISH', or 'NEUTRAL'.
 */
function get1hTrend(candles1h) {
    if (!candles1h || candles1h.length < 21) return 'NEUTRAL';
    const closes = candles1h.map(c => c.c);
    const ema9 = simpleEMA(closes, 9);
    const ema21 = simpleEMA(closes, 21);
    if (ema9 === null || ema21 === null) return 'NEUTRAL';
    if (ema9 > ema21) return 'BULLISH';
    if (ema9 < ema21) return 'BEARISH';
    return 'NEUTRAL';
}

// ============================================
// Real-Time SL/TP Exit via WebSocket Ticks
// ============================================
const exitLevelCache = new Map();
// Map<ticker, { tpPrice, slPrice, trailActivationPrice, trailPct, profitGoal, regime }>

function refreshExitLevels(marketDataMap) {
    const fees = getActiveFees();
    const { profitGoals } = botState.settings;
    for (const [ticker, position] of Object.entries(portfolio.positions)) {
        const candles = marketDataMap.get(ticker);
        if (!candles || candles.length < 10) continue;

        const targets = getDynamicTargets(candles);
        const openPrice = position.openPrice;

        // Upgrade #9: ATR-based dynamic exits with regime multipliers
        const atr = calculateATRFromCandles(candles, 14);
        const atrPct = openPrice > 0 ? (atr / openPrice) : 0.01;

        // Regime multipliers for exit tightness
        let regimeMultiplier = 1.0;
        if (targets.regime === 'SIDEWAYS') regimeMultiplier = 0.75;
        else if (targets.regime === 'UPTREND') regimeMultiplier = 1.25;
        else if (targets.regime === 'DOWNTREND') regimeMultiplier = 0.5;

        const adjustedATR = atrPct * regimeMultiplier;

        // Stage 1: exit 25% at 1.0× ATR profit
        const stage1Price = openPrice * (1 + adjustedATR * 1.0 + fees.roundTrip);
        // Stage 2: exit 35% at 2.0× ATR profit
        const stage2Price = openPrice * (1 + adjustedATR * 2.0 + fees.roundTrip);
        // Stage 3: trail remaining at 1.5× ATR below high-water mark
        const trailATRPct = adjustedATR * 1.5;

        // TP price: use stage 2 as main TP target
        const tpPrice = stage2Price;

        // SL price: 2× ATR below entry (fee-adjusted)
        const feeAdjustedSL = adjustedATR * 2.0 + fees.roundTrip;
        const slPrice = openPrice * (1 - feeAdjustedSL);

        // Trail activation: at stage 1 price
        const trailActivationPrice = stage1Price;

        // Trail distance percentage
        const trailPct = Math.max(0.3, trailATRPct * 100);

        // Per-trade profit goal (dollar amount)
        const profitGoal = profitGoals?.[position.entryStrategy] || 0;

        exitLevelCache.set(ticker, {
            tpPrice, slPrice, trailActivationPrice, trailPct, profitGoal, regime: targets.regime,
            stage1Price, stage2Price, atrPct: adjustedATR, regimeMultiplier
        });
    }
    // Clean stale entries for closed positions
    for (const ticker of exitLevelCache.keys()) {
        if (!portfolio.positions[ticker]) exitLevelCache.delete(ticker);
    }
}

// ATR calculation helper for exit levels
function calculateATRFromCandles(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(
            candles[i].h - candles[i].l,
            Math.abs(candles[i].h - candles[i - 1].c),
            Math.abs(candles[i].l - candles[i - 1].c)
        );
        trs.push(tr);
    }
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

async function checkTickExit(ticker, price) {
    const position = portfolio.positions[ticker];
    if (!position || position._exitPending) return;

    const levels = exitLevelCache.get(ticker);
    if (!levels) return; // No cached levels yet (first bot loop hasn't run)

    // Update tracking prices on every tick
    if (price > (position.highestPrice || 0)) position.highestPrice = price;
    if (price < (position.lowestPrice || Infinity)) position.lowestPrice = price;
    position.currentPrice = price;

    let exitReason = null;
    let isStopLoss = false; // SL exits always fire (protective); TP/trail exits are profit-checked

    // 1. Per-trade profit goal
    if (levels.profitGoal > 0) {
        const profit = (price - position.openPrice) * position.quantity;
        if (profit >= levels.profitGoal) {
            exitReason = `[RT] Per-trade profit goal $${levels.profitGoal.toFixed(2)} reached`;
        }
    }

    // 2. Take-profit
    if (!exitReason && price >= levels.tpPrice) {
        const pnl = ((price - position.openPrice) / position.openPrice * 100).toFixed(2);
        exitReason = `[RT-TP] +${pnl}% hit TP @ ${levels.tpPrice.toFixed(4)} (${levels.regime})`;
    }

    // 3. Trailing stop (only if trail activated)
    if (!exitReason && position.highestPrice >= levels.trailActivationPrice) {
        const trailLevel = position.highestPrice * (1 - levels.trailPct / 100);
        if (price <= trailLevel) {
            exitReason = `[RT-TRAIL] price ${price.toFixed(4)} <= trail ${trailLevel.toFixed(4)} (peak ${position.highestPrice.toFixed(4)})`;
        }
    }

    // 4. Stop-loss (always fires — protective exit)
    if (!exitReason && price <= levels.slPrice) {
        const pnl = ((price - position.openPrice) / position.openPrice * 100).toFixed(2);
        exitReason = `[RT-SL] ${pnl}% hit SL @ ${levels.slPrice.toFixed(4)} (${levels.regime})`;
        isStopLoss = true;
    }

    // Pre-check exit profitability after estimated slippage + fees (for non-SL exits only).
    // Stop-loss exits always fire because they're protective. But TP/trailing exits that
    // would become net losses after slippage + fees should NOT fire — wait for a better price.
    if (exitReason && !isStopLoss) {
        const fees = getActiveFees();
        const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(ticker);
        const estSlippagePct = isMajor ? 0.05 : 0.15; // % slippage estimate (Kraken has wider spreads)
        const estExitPrice = price * (1 - estSlippagePct / 100); // sells slip down
        const sellFee = estExitPrice * position.quantity * fees.perSide;
        const buyFee = position.openPrice * position.quantity * fees.perSide;
        const netPnl = (estExitPrice - position.openPrice) * position.quantity - sellFee - buyFee;

        if (netPnl < 0) {
            // This "profitable" exit would actually be a loss after costs — skip it
            // Log occasionally (1 in 20) to avoid log spam
            if (Math.random() < 0.05) {
                addLog(`[RT-SKIP] ${ticker}: Exit at ${price.toFixed(4)} would net $${netPnl.toFixed(2)} after slippage+fees — waiting for better price`, 'INFO');
            }
            return; // Don't exit — let price move further into profit
        }
    }

    if (exitReason) {
        position._exitPending = true; // Prevent double-exit from bot loop
        try {
            await handleSell(position, price, exitReason);
        } catch (err) {
            console.error(`[RT-EXIT] Failed for ${ticker}: ${err.message}`);
            // Clear flag so bot loop can retry
            if (portfolio.positions[ticker]) portfolio.positions[ticker]._exitPending = false;
        }
    }
}

// ============================================
// Trading Bot Loop (Optimized for Large Universes)
// ============================================
let botLoopRunning = false;
let botLoopStartTime = 0;
// Fix #23 (Tier 3): MTF data cache to avoid redundant REST calls
let _mtfCache5m = { data: null, ts: 0 };
let _mtfCache15m = { data: null, ts: 0 };
let _mtfCache1h = { data: null, ts: 0 };
async function tradingBotLoop() {
    if (!botState.isActive) return;
    if (botLoopRunning) return; // prevent overlapping async iterations
    botLoopRunning = true;
    botLoopStartTime = Date.now();

    try {
        // Defensive: ensure botLoopRunning is ALWAYS cleared, even on unexpected errors.
        // The finally block below handles this, but we also have the watchdog as a safety net.
        const { sessionProfitGoal, riskAmount, profitGoals } = botState.settings;

        // --- CAPITAL TIER MANAGEMENT ---
        let holdingsValue = Object.values(portfolio.positions).reduce((sum, pos) =>
            sum + (pos.quantity * (pos.currentPrice || pos.openPrice)), 0
        );
        let totalValue = portfolio.cash + holdingsValue;
        if (totalValue > peakValue) peakValue = totalValue;

        // Update circuit breaker daily balance on day change
        const today = new Date().toDateString();
        if (botState._lastCBDay !== today) {
            setDailyBalance(totalValue);
            botState._lastCBDay = today;
        }

        const tier = CapitalTierManager.getTier(totalValue);

        // Enforce tier's maxConcurrentTrades as a hard cap
        const maxConcurrentTrades = tier.maxConcurrentTrades;

        // Halt trading if drawdown exceeds tier limits
        const drawdown = peakValue > 0 ? ((peakValue - totalValue) / peakValue) * 100 : 0;
        if (drawdown > tier.maxDrawdownLimit) {
            if (Math.random() < 0.05) addLog(`[CAPITAL TIER] Trading halted: Drawdown ${drawdown.toFixed(1)}% exceeds ${tier.name} limit (${tier.maxDrawdownLimit}%)`, 'WARN');
            // Allow exits but skip all entries
        }

        // --- DYNAMIC MARKET SCANNING ---
        const positionTickers = Object.keys(portfolio.positions);

        // Always scan QUALITY_TICKERS (the curated list), regardless of session ticker selection
        // This ensures the bot scans all supported pairs even if session was started with just 1 ticker
        const tickerPool = QUALITY_TICKERS.length > 0 ? QUALITY_TICKERS : availableTickers.slice(0, 50);
        const BATCH_SIZE = 20;
        const cycleIndex = Math.floor(Date.now() / 1000) % Math.max(1, Math.ceil(tickerPool.length / BATCH_SIZE));
        const scanBatch = tickerPool.slice(cycleIndex * BATCH_SIZE, (cycleIndex + 1) * BATCH_SIZE);
        
        const tickersToFetch = [...new Set([...positionTickers, ...scanBatch])];

        // Auto-subscribe scan batch to WebSocket so future loops use WS buffer
        if (wsConnected()) wsSubscribeTickers(tickersToFetch);

        const allMarketData = await getMultipleMarketData(tickersToFetch);

        // Create a lookup map
        const marketDataMap = new Map();
        let wsHits = 0, restHits = 0;
        for (const { ticker, candles, error, source } of allMarketData) {
            if (!error && candles && candles.length >= CONFIG.MIN_CANDLES_REQUIRED) {
                marketDataMap.set(ticker, candles);
            }
            if (source === 'ws') wsHits++; else restHits++;
        }
        if (wsHits > 0 && Math.random() < 0.05) {
            addLog(`[DATA] WS: ${wsHits} tickers (instant), REST: ${restHits} tickers`, 'INFO');
        }

        // --- CIRCUIT BREAKER CHECK ---
        const pauseCheck = shouldPauseTrading(botState.tradingMode);
        if (pauseCheck.paused) {
            if (Math.random() < 0.1) addLog(`[CIRCUIT BREAKER] Paused: ${pauseCheck.reason} (${pauseCheck.remainingMinutes}min left)`, 'WARN');
        }

        // --- MULTI-TIMEFRAME DATA (5m, 15m, 1h alongside 1m) ---
        // Fix #23 (Tier 3): Cache MTF data with TTL matching timeframe period
        // 5m data cached 4 min, 15m cached 12 min, 1h cached 50 min
        // Eliminates redundant REST calls every 1.5-5s bot loop
        let mtfDataMap = new Map();
        let data1hMap = new Map();
        try {
            const mtfTickers = [...new Set([...positionTickers, ...scanBatch.slice(0, 6)])];
            const now = Date.now();

            // Check if cached MTF data is still fresh
            const mtf5mStale = !_mtfCache5m.ts || (now - _mtfCache5m.ts) > 4 * 60 * 1000;
            const mtf15mStale = !_mtfCache15m.ts || (now - _mtfCache15m.ts) > 12 * 60 * 1000;
            const mtf1hStale = !_mtfCache1h.ts || (now - _mtfCache1h.ts) > 50 * 60 * 1000;

            // Only fetch stale timeframes
            const fetches = [];
            fetches.push(mtf5mStale ? getMultipleMarketData(mtfTickers, '5m') : Promise.resolve(_mtfCache5m.data));
            fetches.push(mtf15mStale ? getMultipleMarketData(mtfTickers, '15m') : Promise.resolve(_mtfCache15m.data));
            fetches.push(mtf1hStale ? getMultipleMarketData(mtfTickers, '1h') : Promise.resolve(_mtfCache1h.data));

            const [data5m, data15m, data1h] = await Promise.all(fetches);

            // Update caches
            if (mtf5mStale && data5m) { _mtfCache5m = { data: data5m, ts: now }; }
            if (mtf15mStale && data15m) { _mtfCache15m = { data: data15m, ts: now }; }
            if (mtf1hStale && data1h) { _mtfCache1h = { data: data1h, ts: now }; }

            for (const ticker of mtfTickers) {
                const candles1m = marketDataMap.get(ticker);
                const entry5m = data5m.find(d => d.ticker === ticker);
                const entry15m = data15m.find(d => d.ticker === ticker);
                const entry1h = data1h.find(d => d.ticker === ticker);
                if (candles1m) {
                    mtfDataMap.set(ticker, {
                        '1m': candles1m,
                        '5m': entry5m?.candles || [],
                        '15m': entry15m?.candles || [],
                    });
                }
                if (entry1h?.candles?.length > 0) {
                    data1hMap.set(ticker, entry1h.candles);
                }
            }
        } catch (e) {}

        // --- MTF CONFLUENCE SCORING ---
        const mtfScores = new Map();
        for (const [ticker, tfData] of mtfDataMap) {
            try {
                const alignment = getMTFAlignmentScore(tfData);
                mtfScores.set(ticker, alignment);
            } catch (e) {}
        }

        // --- MERGE WEBSOCKET CANDLES ---
        for (const [ticker, candles] of marketDataMap) {
            const merged = mergeCandles(candles, ticker);
            if (merged && merged.length > candles.length) {
                marketDataMap.set(ticker, merged);
            }
        }

        const prices = {};
        refreshExitLevels(marketDataMap); // Refresh cached levels for real-time tick checker

        // Fix #16 (Tier 2): WebSocket disconnect fallback for exits
        // When WS is disconnected, RT tick checks don't fire. Run a fast SL/TP check
        // using the latest REST candle close prices for all open positions.
        if (!wsConnected() && positionTickers.length > 0) {
            for (const ticker of positionTickers) {
                const position = portfolio.positions[ticker];
                if (!position || position._exitPending) continue;
                const candles = marketDataMap.get(ticker);
                if (!candles || candles.length === 0) continue;
                const latestPrice = candles[candles.length - 1].c;
                // Run the same tick-level exit check using REST-sourced price
                try {
                    await checkTickExit(ticker, latestPrice);
                } catch (e) {
                    // Non-blocking: log once per 100 failures
                    if (Math.random() < 0.01) console.warn(`[WS-FALLBACK] checkTickExit error for ${ticker}:`, e.message);
                }
            }
        }

        // --- EXIT LOGIC ---
        for (const ticker of positionTickers) {
            const position = portfolio.positions[ticker];
            if (!position || position._exitPending) continue; // Skip positions being exited by RT tick checker
            const candles = marketDataMap.get(ticker);

            if (!candles) continue;

            const currentPrice = candles[candles.length - 1].c;
            prices[ticker] = currentPrice;

            const profitGoal = profitGoals?.[position.entryStrategy] || 0;
            const currentProfit = (currentPrice - position.openPrice) * position.quantity;

            let exitReason = null;

            if (profitGoal > 0 && currentProfit >= profitGoal) {
                exitReason = `Per-trade profit goal of $${profitGoal.toFixed(2)} reached.`;
            }

            if (!exitReason && position.entryStrategy !== 'EXISTING') {
                const dynamicCheck = checkDynamicExit(position, currentPrice, candles);
                if (dynamicCheck.shouldExit) exitReason = dynamicCheck.reason;
            }

            // Strategy indicator exits — only fire after minimum hold time.
            // Fix #12 (Tier 2): Adaptive hold time based on asset volatility + timeframe.
            // High-vol assets (SOL, DOGE) need less hold time; slow movers (BTC) need more.
            const indicatorHoldMs = Date.now() - (position.entryTime || 0);
            const holdBaseCurrency = ticker.replace(/USD$/, '');
            const ASSET_HOLD_SCALE = {
                BTC: 1.5, ETH: 1.0, SOL: 0.5, XRP: 0.8, DOGE: 0.4,
                ADA: 1.0, LINK: 0.9, DOT: 1.0, AVAX: 0.6, BNB: 1.0,
            };
            const holdScale = ASSET_HOLD_SCALE[holdBaseCurrency] || 1.0;
            // Base hold: 5 minutes, scaled by asset volatility profile
            // Fast assets (SOL, DOGE) → ~2-2.5 min; BTC → ~7.5 min
            const MIN_HOLD_FOR_INDICATOR_EXIT = Math.round(5 * 60 * 1000 * holdScale);

            if (!exitReason && indicatorHoldMs >= MIN_HOLD_FOR_INDICATOR_EXIT) {
                const tcValue = calculateTCSeries(candles).pop() ?? 50;
                const momentumValue = calculateMomentumSeries(candles).pop() ?? 50;

                switch (position.entryStrategy) {
                    case 'TREND':
                        if (tcValue > CONFIG.THRESHOLDS.TREND_BEARISH_EXIT) exitReason = 'Trend Signal: Bearish exit';
                        break;
                    case 'MOMENTUM':
                        if (momentumValue < CONFIG.THRESHOLDS.MOMENTUM_BEARISH_EXIT) exitReason = 'Momentum Signal: Bearish Momentum';
                        break;
                    case 'BREAKOUT': {
                        const bkout = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
                        if (bkout < CONFIG.THRESHOLDS.BREAKOUT_EXPANSION_EXIT) exitReason = 'Breakout Signal: Expansion faded';
                        break;
                    }
                    case 'ADAPTIVE': {
                        const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                        if (adpValue > CONFIG.THRESHOLDS.ADAPTIVE_BEARISH_EXIT) exitReason = 'Adaptive Signal: Bearish exit';
                        break;
                    }
                    case 'WHALE': {
                        const whaleValue = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50;
                        if (whaleValue < CONFIG.THRESHOLDS.WHALE_SELLING_EXIT) exitReason = 'Whale Signal: Selling pressure';
                        break;
                    }
                    case 'CONFLUENCE': {
                        const trendDash = calculateTrendDashboard(candles);
                        const bullishCount = trendDash ? Object.values(trendDash).filter(v => v === true || v === 'BULLISH' || v === 'UP').length : 0;
                        if (bullishCount <= CONFIG.THRESHOLDS.CONFLUENCE_BEARISH_EXIT) exitReason = 'Confluence Signal: Bearish alignment';
                        break;
                    }
                    case 'DIVERGENCE': {
                        const div = calculateDivergence(candles);
                        if (div && div.type === 'bearish' && div.confidence >= CONFIG.THRESHOLDS.DIVERGENCE_MIN_CONFIDENCE) exitReason = 'Divergence Signal: Bearish divergence';
                        break;
                    }
                }
            }

            if (exitReason) await handleSell(position, currentPrice, exitReason);
        }

        // --- PROFIT METHOD EXITS ---
        const pmExits = checkProfitMethodExits(portfolio.positions, marketDataMap);
        for (const exit of pmExits) {
            const pos = portfolio.positions[exit.ticker];
            if (!pos || pos._exitPending) continue;
            const candles = marketDataMap.get(exit.ticker);
            const exitPrice = candles ? candles[candles.length - 1].c : pos.openPrice;
            await handleSell(pos, exitPrice, exit.reason);
        }

        // Recalculate total value
        holdingsValue = Object.values(portfolio.positions).reduce((sum, pos) =>
            sum + (pos.quantity * (prices[pos.ticker] || pos.openPrice)), 0
        );
        totalValue = portfolio.cash + holdingsValue;
        beastUpdateBalance(totalValue);
        setCurrentBalance(totalValue);  // Upgrade #3: Drawdown-adaptive Kelly tracking

        if (sessionProfitGoal && totalValue >= sessionProfitGoal && botState.tradingMode !== 'SIMULATION') {
            addLog(`SESSION PROFIT GOAL REACHED! Total: $${totalValue.toFixed(2)}`, 'SPECIAL');
            botState.isActive = false;
            clearInterval(botInterval);
            botInterval = null;
            return;
        }

        // --- ENTRY LOGIC ---
        // Determine current market regime for strategy filtering
        const currentRegime = (() => {
            try {
                const firstTicker = marketDataMap.keys().next().value;
                const firstCandles = firstTicker ? marketDataMap.get(firstTicker) : null;
                if (firstCandles) {
                    // Pass ticker to enable 30s regime cache + populate beastMode status
                    const regime = getMarketRegime(firstCandles, firstTicker);
                    return regime || 'UNKNOWN';
                }
            } catch (e) {}
            return 'UNKNOWN';
        })();

        // --- TIMEFRAME STRATEGY: detect market speed + get active profile ---
        let marketSpeed = 'FAST';
        let activeProfile = null;
        try {
            if (timeframeStrategyService) {
                const refCandles = marketDataMap.values().next().value;
                if (refCandles) {
                    marketSpeed = timeframeStrategyService.detectMarketSpeed(refCandles);
                }
                const bestTf = timeframeStrategyService.getBestTimeframe(
                    marketDataMap.values().next().value || [], marketSpeed
                );
                activeProfile = timeframeStrategyService.getTimeframeProfile(bestTf.timeframeId, marketSpeed);
            }
        } catch (e) {
            // Graceful fallback — continue without timeframe profile
        }

        // Log regime thought (now includes market speed + timeframe info)
        logThought({
            type: 'REGIME',
            ticker: scanBatch[0] || '',
            action: `REGIME_${currentRegime}`,
            confidence: 0,
            reason: `Market regime: ${currentRegime}, speed: ${marketSpeed}, TF: ${activeProfile?.timeframeId || 'default'}, scanning ${scanBatch.length} tickers, ${Object.keys(portfolio.positions).length} open positions`,
            regime: currentRegime,
            market_speed: marketSpeed,
            indicators: {
                totalValue, drawdown: drawdown.toFixed(2),
                openPositions: Object.keys(portfolio.positions).length,
                marketSpeed,
                timeframeId: activeProfile?.timeframeId || null,
                profileStrategies: activeProfile?.activeStrategies || [],
            },
        });

        // Derive entry thresholds from timeframe profile, then overlay optimizer values
        const optParams = getOptimizedEntryParams();
        const minOppScore = activeProfile?.entry?.minOpportunityScore ?? optParams.minOpportunityScore;
        const profileStrategies = activeProfile?.activeStrategies || null;
        const profilePosSize = activeProfile?.positionSizePercent ?? null;

        const openSlots = maxConcurrentTrades - Object.keys(portfolio.positions).length;
        if (openSlots > 0 && portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && (botState.tradingMode === 'SIMULATION' || drawdown <= tier.maxDrawdownLimit)) {

            // Calculate Opportunity Scores for current batch (with liquidity filter)
            const candidates = [];
            for (const ticker of scanBatch) {
                if (portfolio.positions[ticker]) continue;
                const candles = marketDataMap.get(ticker);
                if (!candles) continue;

                // Liquidity gate: skip low-volume garbage tokens
                const liq = checkLiquidity(candles);
                if (!liq.pass) {
                    continue; // silently skip — too many low-vol tickers to log each one
                }

                const score = calculateOpportunityScore(candles, ticker);
                if (score.compositeScore > minOppScore) candidates.push({ ticker, score, candles });
            }

            candidates.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

            // --- SENTIMENT ENRICHMENT: cached with 5min TTL to avoid redundant API calls ---
            const sentimentCache = new Map();
            try {
                const topTickers = candidates.slice(0, 5).map(c => c.ticker);
                const now = Date.now();
                const tickersToFetchSentiment = [];

                // Use cached sentiment where available
                for (const ticker of topTickers) {
                    const cached = sentimentCachePersistent.get(ticker);
                    if (cached && (now - cached.timestamp) < SENTIMENT_CACHE_TTL_MS) {
                        sentimentCache.set(ticker, cached.score);
                    } else {
                        tickersToFetchSentiment.push(ticker);
                    }
                }

                // Only fetch sentiment for tickers not in cache
                if (tickersToFetchSentiment.length > 0) {
                    const sentimentResults = await Promise.allSettled(
                        tickersToFetchSentiment.map(async (ticker) => {
                            let score = 0;
                            let sources = 0;
                            if (redditSentimentService) {
                                try {
                                    const rd = await redditSentimentService.getEnhancedTickerSentiment(ticker);
                                    if (rd?.combinedSentiment != null) { score += rd.combinedSentiment * 0.35; sources += 0.35; }
                                } catch (e) {}
                            }
                            if (youtubeSentimentService) {
                                try {
                                    const yt = await youtubeSentimentService.getYouTubeSentiment(ticker);
                                    if (yt?.sentiment != null) { score += yt.sentiment * 0.25; sources += 0.25; }
                                } catch (e) {}
                            }
                            if (multiExchangeService) {
                                try {
                                    const fg = multiExchangeService.getFearGreed();
                                    if (fg?.value != null) { const fgNorm = (fg.value - 50) / 50; score += fgNorm * 0.40; sources += 0.40; }
                                } catch (e) {}
                            }
                            return { ticker, sentiment: sources > 0 ? score / sources : 0 };
                        })
                    );
                    for (const r of sentimentResults) {
                        if (r.status === 'fulfilled' && r.value) {
                            sentimentCache.set(r.value.ticker, r.value.sentiment);
                            sentimentCachePersistent.set(r.value.ticker, { score: r.value.sentiment, timestamp: now });
                        }
                    }
                }
            } catch (e) {}

            for (const candidate of candidates) {
                if (maxConcurrentTrades - Object.keys(portfolio.positions).length <= 0) break;
                if (portfolio.cash < CONFIG.MIN_TRADE_SIZE) break;

                const { ticker, score, candles } = candidate;
                const currentPrice = candles[candles.length - 1].c;
                const tcValue = calculateTCSeries(candles).pop() ?? 50;

                // Determine entry strategy — evaluate ALL allowed strategies and pick strongest signal
                let entryStrategy = null;
                let triggerValue = tcValue; // default for TREND
                if (profileStrategies) {
                    // Fix #8 (Tier 2): Adaptive Lookback Periods Per Asset
                    // Extract base currency from ticker (e.g., 'BTCUSD' → 'BTC') and get asset-specific lookback scale
                    const baseCurrency = ticker.replace(/USD$/, '');
                    const ASSET_LOOKBACK_SCALE = {
                        BTC: 1.5, ETH: 1.0, SOL: 0.6, XRP: 0.85, DOGE: 0.6,
                        ADA: 1.0, LINK: 0.85, DOT: 1.0, AVAX: 0.7, BNB: 1.0,
                    };
                    const lookbackScale = ASSET_LOOKBACK_SCALE[baseCurrency] || 1.0;
                    // Scale indicator periods: fast-moving assets (SOL, DOGE) → shorter periods; slow (BTC) → longer
                    const scaledBreakoutLen = Math.max(4, Math.round(8 * lookbackScale));
                    const scaledWhaleLen = Math.max(5, Math.round(10 * lookbackScale));
                    const scaledMfiLen = Math.max(7, Math.round(14 * lookbackScale));

                    // Evaluate all profile-allowed strategies, pick the one with strongest signal
                    // Signal strength = how far past threshold (normalized 0-1 range)
                    const stratCandidates = [];

                    if (profileStrategies.includes('TREND') && tcValue < optParams.TREND_BULLISH_ENTRY) {
                        // TREND: lower = more bullish, strength = how far below threshold
                        const strength = (optParams.TREND_BULLISH_ENTRY - tcValue) / optParams.TREND_BULLISH_ENTRY;
                        stratCandidates.push({ strategy: 'TREND', value: tcValue, strength });
                    }
                    if (profileStrategies.includes('MOMENTUM')) {
                        const momValue = calculateMomentumSeries(candles).pop() ?? 50;
                        if (momValue > optParams.MOMENTUM_BULLISH_ENTRY) {
                            const strength = (momValue - optParams.MOMENTUM_BULLISH_ENTRY) / (100 - optParams.MOMENTUM_BULLISH_ENTRY);
                            stratCandidates.push({ strategy: 'MOMENTUM', value: momValue, strength });
                        }
                    }
                    if (profileStrategies.includes('BREAKOUT')) {
                        const bkout = calculateBreakoutDetectorSeries(candles, scaledBreakoutLen).pop() ?? 50;
                        if (bkout > optParams.BREAKOUT_SQUEEZE_ENTRY) {
                            const strength = (bkout - optParams.BREAKOUT_SQUEEZE_ENTRY) / (100 - optParams.BREAKOUT_SQUEEZE_ENTRY);
                            stratCandidates.push({ strategy: 'BREAKOUT', value: bkout, strength });
                        }
                    }
                    if (profileStrategies.includes('ADAPTIVE')) {
                        const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                        if (adpValue < optParams.ADAPTIVE_BULLISH_ENTRY) {
                            const strength = (optParams.ADAPTIVE_BULLISH_ENTRY - adpValue) / optParams.ADAPTIVE_BULLISH_ENTRY;
                            stratCandidates.push({ strategy: 'ADAPTIVE', value: adpValue, strength });
                        }
                    }
                    // WHALE: high whale money flow = smart money buying (with adaptive lookback)
                    if (profileStrategies.includes('WHALE')) {
                        const whaleValue = calculateWhaleMoneyFlowSeries(candles, scaledWhaleLen, scaledMfiLen).pop() ?? 50;
                        const whaleThreshold = optParams.WHALE_BUYING_ENTRY || 48;
                        if (whaleValue > whaleThreshold) {
                            const strength = (whaleValue - whaleThreshold) / (100 - whaleThreshold);
                            stratCandidates.push({ strategy: 'WHALE', value: whaleValue, strength });
                        }
                    }
                    // CONFLUENCE: multiple bullish signals aligned
                    if (profileStrategies.includes('CONFLUENCE')) {
                        const trendDash = calculateTrendDashboard(candles);
                        const bullishCount = trendDash ? Object.values(trendDash).filter(v => v === true || v === 'BULLISH' || v === 'UP').length : 0;
                        const confluenceThreshold = optParams.CONFLUENCE_BULLISH_ENTRY || 2;
                        if (bullishCount >= confluenceThreshold) {
                            const strength = Math.min(1, bullishCount / 5);
                            stratCandidates.push({ strategy: 'CONFLUENCE', value: bullishCount, strength });
                        }
                    }

                    // Fix #14 (Tier 2): Pick strategies weighted by signal strength × historical win rate
                    // Instead of pure signal strength, blend in adaptive weights from past performance
                    if (stratCandidates.length > 0) {
                        for (const cand of stratCandidates) {
                            const adaptiveWeight = getStrategyWeight(cand.strategy); // 0 to 1
                            // Blended score: 60% signal strength + 40% historical performance weight
                            cand.blendedScore = cand.strength * 0.6 + adaptiveWeight * 0.4;
                        }
                        stratCandidates.sort((a, b) => b.blendedScore - a.blendedScore);
                        for (const cand of stratCandidates) {
                            // Check regime filter
                            if (!isStrategyEnabledForRegime(cand.strategy, currentRegime)) {
                                logThought({ type: 'SKIP', ticker, action: 'REGIME_FILTER',
                                    confidence: score.compositeScore,
                                    reason: `${cand.strategy} not allowed in ${currentRegime} regime (trying next)`,
                                    regime: currentRegime });
                                continue;
                            }
                            // Check throttle
                            if (isStrategyThrottled(cand.strategy)) {
                                logThought({ type: 'SKIP', ticker, action: 'STRATEGY_THROTTLED',
                                    confidence: score.compositeScore,
                                    reason: `${cand.strategy} throttled (trying next)`,
                                    regime: currentRegime });
                                continue;
                            }
                            entryStrategy = cand.strategy;
                            triggerValue = cand.value;
                            break;
                        }
                    }
                } else {
                    // Fallback: original TREND-only entry (optimizer-tuned threshold)
                    if (tcValue < optParams.TREND_BULLISH_ENTRY) {
                        if (isStrategyEnabledForRegime('TREND', currentRegime) && !isStrategyThrottled('TREND')) {
                            entryStrategy = 'TREND';
                        }
                    }
                }

                // Feature 3: MTF confluence confidence adjustment
                let mtfConfidenceAdj = 0;
                const mtfScore = mtfScores.get(ticker);
                if (mtfScore) {
                    mtfConfidenceAdj = getMTFConfidencePoints(mtfScore.alignmentScore);
                }

                // Feature 8: Funding rate adjustment + entry gate
                let fundingAdj = 0;
                try {
                    const fundingSignal = getFundingRateSignal(ticker);
                    const fundingResult = getFundingConfidenceAdjustment(fundingSignal, 'LONG');
                    fundingAdj = fundingResult.adjustment;

                    // Funding rate entry gate: block entry if funding is extreme for LONG
                    if (entryStrategy) {
                        const fundingBlock = shouldBlockEntryOnFunding(ticker, 'LONG');
                        if (fundingBlock.blocked) {
                            logThought({ type: 'SKIP', ticker, action: 'FUNDING_BLOCKED',
                                confidence: score.compositeScore,
                                reason: fundingBlock.reason,
                                regime: currentRegime });
                            entryStrategy = null;
                        }
                    }

                    // Funding contrarian signal: boost score if contrarian agrees with entry direction
                    if (entryStrategy) {
                        const contrarian = isFundingContrarian(ticker);
                        if (contrarian.signal === 'LONG_BIAS') {
                            fundingAdj += 5; // Contrarian agrees with LONG entry
                        }
                    }
                } catch (e) {}

                // Cross-timeframe momentum check (1h trend)
                let htfAdj = 0;
                if (entryStrategy) {
                    try {
                        const candles1h = data1hMap.get(ticker);
                        const trend1h = get1hTrend(candles1h);
                        const mtfTfData = mtfDataMap.get(ticker);
                        const candles15m = mtfTfData?.['15m'];
                        let trend15m = 'NEUTRAL';
                        if (candles15m && candles15m.length >= 21) {
                            const closes15m = candles15m.map(c => c.c);
                            const ema9_15m = simpleEMA(closes15m, 9);
                            const ema21_15m = simpleEMA(closes15m, 21);
                            if (ema9_15m !== null && ema21_15m !== null) {
                                trend15m = ema9_15m > ema21_15m ? 'BULLISH' : ema9_15m < ema21_15m ? 'BEARISH' : 'NEUTRAL';
                            }
                        }

                        if (trend1h === 'BEARISH') {
                            htfAdj = -8; // Reduce composite score by 8 for bearish 1h
                            // Fix #18 (Tier 3): Hard gate — block non-reversal LONG entries when 1h is bearish
                            // In simulation mode, skip gate — we want entries in all conditions for ML training
                            if (botState.tradingMode !== 'SIMULATION') {
                                const reversalStrategies = ['REVERSAL', 'DIVERGENCE', 'MEAN_REVERSION'];
                                if (entryStrategy && !reversalStrategies.includes(entryStrategy)) {
                                    logThought({ type: 'SKIP', ticker, action: 'HTF_1H_BEARISH_GATE',
                                        confidence: score.compositeScore,
                                        reason: `1h trend is BEARISH — blocking ${entryStrategy} LONG entry (only reversal strats allowed)`,
                                        regime: currentRegime });
                                    entryStrategy = null;
                                }
                            }
                        }

                        // Fix #18 (Tier 3): Require 15m alignment for 5m entries
                        if (entryStrategy && trend15m === 'BEARISH' && trend1h !== 'BULLISH') {
                            htfAdj -= 5; // Further penalty when 15m is bearish and 1h isn't bullish
                        }

                        // If both 1h AND 15m are bearish, skip entry entirely (REAL mode only)
                        if (botState.tradingMode !== 'SIMULATION' && trend1h === 'BEARISH' && trend15m === 'BEARISH') {
                            logThought({ type: 'SKIP', ticker, action: 'HTF_BEARISH',
                                confidence: score.compositeScore,
                                reason: `Both 1h and 15m trends are bearish — skipping entry`,
                                regime: currentRegime });
                            entryStrategy = null;
                        }
                    } catch (e) {}
                }

                // Sentiment confidence adjustment (-10 to +10 range)
                let sentimentAdj = 0;
                const sentimentScore = sentimentCache.get(ticker);
                if (sentimentScore != null) {
                    sentimentAdj = Math.round(sentimentScore * 10); // -1..1 → -10..+10
                }

                // ML Advisory — now active: scales position size and can block conflicting entries
                let mlAdvice = { available: false, direction: null, confidence: 0 };
                let mlSizeMultiplier = 1.0;
                if (entryStrategy && mlPredictionService?.getMLAdvice) {
                    try {
                        mlAdvice = await mlPredictionService.getMLAdvice(ticker, candles, {});
                        if (mlAdvice.available) {
                            // ML agrees with LONG entry: boost position size by confidence
                            if (mlAdvice.direction === 'BUY' || mlAdvice.direction === 'LONG') {
                                if (mlAdvice.confidence >= 70) {
                                    mlSizeMultiplier = 1.15; // High-confidence agreement: +15%
                                } else if (mlAdvice.confidence >= 50) {
                                    mlSizeMultiplier = 1.05; // Moderate agreement: +5%
                                }
                            }
                            // ML strongly disagrees (predicts SELL with high confidence): reduce or block
                            else if ((mlAdvice.direction === 'SELL' || mlAdvice.direction === 'SHORT') && mlAdvice.confidence >= 65) {
                                if (mlAdvice.confidence >= 80) {
                                    logThought({ type: 'SKIP', ticker, action: 'ML_DISAGREE_STRONG',
                                        confidence: mlAdvice.confidence,
                                        reason: `ML predicts ${mlAdvice.direction} with ${mlAdvice.confidence}% confidence — blocking LONG entry`,
                                        regime: currentRegime });
                                    entryStrategy = null;
                                } else {
                                    mlSizeMultiplier = 0.60; // ML moderately disagrees: reduce size 40%
                                }
                            }

                            logThought({ type: 'ML_ADVICE', ticker, action: 'ML_PREDICTION',
                                confidence: mlAdvice.confidence,
                                reason: `ML predicts ${mlAdvice.direction} with ${mlAdvice.confidence}% confidence → size×${mlSizeMultiplier.toFixed(2)}`,
                                regime: currentRegime });
                        }
                    } catch (e) {}
                }

                // ===== ML PIPELINE (4-Layer System) =====
                // Layer 1: Genetic signals → become ML features
                let geneticSignals = [];
                let pipelineResult = null;
                if (entryStrategy) {
                    // Compute indicator snapshots needed for pipeline
                    const momValue = calculateMomentumSeries(candles).pop() ?? 50;
                    const bkoutValue = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
                    const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                    const whaleValue = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50;
                    const trendDash = calculateTrendDashboard(candles);
                    const bullishCount = trendDash ? Object.values(trendDash).filter(v => v === true || v === 'BULLISH' || v === 'UP').length : 0;

                    try {
                        if (getFlag('GENETIC_ENABLED')) {
                            const genPop = getGeneticPopulation();
                            const genIndicators = {
                                tc: tcValue,
                                momentum: momValue,
                                breakout: bkoutValue,
                                adaptive: adpValue,
                                whale: whaleValue,
                                divergence: 0,
                                rsi: 50,
                                macd_histogram: 0,
                                bollinger_b: 0.5,
                                volume_ratio: 1,
                                atr_norm: 0,
                                regime_score: currentRegime === 'UPTREND' ? 1 : currentRegime === 'DOWNTREND' ? -1 : 0,
                            };
                            geneticSignals = genPop.getTopSignals(genIndicators);
                        }
                    } catch (e) {}

                    // Layer 2: ML Gatekeeper — build strategy signals for feature vector
                    try {
                        const strategySignals = {
                            trend: (tcValue < 40) ? (40 - tcValue) / 40 : -(tcValue - 40) / 60,
                            momentum: (momValue - 50) / 50,
                            breakout: (bkoutValue - 50) / 50,
                            adaptive: (50 - adpValue) / 50,
                            whale: (whaleValue - 50) / 50,
                            confluence: Math.min(1, bullishCount / 5),
                            divergence: 0,
                            agreementCount: [
                                tcValue < 40, momValue > 50, bkoutValue > 40,
                                adpValue < 45, whaleValue > 48, bullishCount >= 2,
                            ].filter(Boolean).length,
                        };

                        // Find the strongest strategy candidate's strength from stratCandidates
                        const bestStrength = score.compositeScore / 100;

                        // Batch 2A: Fetch on-chain data for ML features
                        let onChainData = null;
                        try {
                            if (onChainDataService?.getAllOnChainData && getFlag('ONCHAIN_DATA_ENABLED')) {
                                onChainData = await onChainDataService.getAllOnChainData(ticker);
                            }
                        } catch (e) { /* fail open */ }

                        // Batch 3A: Aggregate market intelligence for ML features
                        let marketIntelligence = null;
                        try {
                            const [cmcData, ethData, ccData, messData] = await Promise.allSettled([
                                coinMarketCapService?.getGlobalMetrics?.(),
                                etherscanService?.getGasPrice?.(),
                                cryptoCompareService?.getSocialStats?.(ticker.replace('USD', '')),
                                messariService?.getAssetMetrics?.(ticker.replace('USD', '')),
                            ]);
                            marketIntelligence = {
                                fearGreed: cmcData?.value?.fear_greed_value || 0,
                                btcDominance: cmcData?.value?.btc_dominance || 0,
                                ethGasGwei: ethData?.value?.gasPrice || 0,
                                socialScore: ccData?.value?.socialScore || 0,
                                marketCapChange24h: messData?.value?.market_cap_change_24h || 0,
                            };
                        } catch (e) { /* fail open */ }

                        pipelineResult = mlGatekeeper.evaluateEntry(
                            ticker, candles, entryStrategy, bestStrength,
                            { strategySignals, geneticSignals, onChainData, marketIntelligence }
                        );

                        if (pipelineResult && !pipelineResult.proceed) {
                            logThought({
                                type: 'SKIP', ticker, action: 'ML_GATEKEEPER_BLOCKED',
                                confidence: pipelineResult.confidence,
                                reason: pipelineResult.reason,
                                regime: currentRegime,
                            });
                            entryStrategy = null;
                        } else if (pipelineResult) {
                            // Upgrade #12: SHAP explanation for trade entries
                            let shapReason = '';
                            try {
                                if (shapExplainer && getFlag('SHAP_ENABLED')) {
                                    const engine = mlPredictionService?.getMLEngine?.();
                                    if (engine && engine.isTrained) {
                                        const featureNames = getFeatureNames ? getFeatureNames() : [];
                                        const explanation = shapExplainer.explainPrediction(engine, pipelineResult.lastFeatureVector || [], featureNames);
                                        if (explanation) {
                                            shapReason = shapExplainer.formatExplanation(explanation);
                                        }
                                    }
                                }
                            } catch (shapErr) { /* non-critical */ }

                            logThought({
                                type: 'ML_PIPELINE', ticker, action: 'ML_GATEKEEPER_PASS',
                                confidence: pipelineResult.confidence,
                                reason: `${pipelineResult.tier}: ${pipelineResult.reason} (size×${pipelineResult.sizeMultiplier.toFixed(2)})${shapReason ? ' | ' + shapReason : ''}`,
                                regime: currentRegime,
                            });
                        }
                    } catch (e) {
                        // ML gatekeeper error — fail open, but log for diagnosis
                        console.warn(`[MLGatekeeper] Error for ${ticker}: ${e.message}`);
                    }
                }
                // ===== END ML PIPELINE =====

                // Hard floor: reject any entry with adjusted compositeScore below optimizer floor
                // Now includes sentiment adjustment so strongly negative sentiment can reject entries
                const adjustedComposite = score.compositeScore + htfAdj + fundingAdj + sentimentAdj;
                if (entryStrategy && adjustedComposite < optParams.compositeScoreFloor) {
                    logThought({
                        type: 'SKIP', ticker, action: 'LOW_COMPOSITE',
                        confidence: adjustedComposite,
                        reason: `adjustedComposite ${adjustedComposite} (raw=${score.compositeScore}, htf=${htfAdj}, funding=${fundingAdj}, sentiment=${sentimentAdj}) < ${optParams.compositeScoreFloor} floor`,
                        regime: currentRegime,
                        indicators: { compositeScore: score.compositeScore, adjustedComposite, htfAdj, fundingAdj, sentimentAdj, entryStrategy },
                    });
                    entryStrategy = null;
                }

                if (entryStrategy && CapitalTierManager.isStrategyAllowed(entryStrategy, totalValue)) {
                    // Feature 4: Dynamic Kelly position sizing
                    const kellySize = getKellyPositionSize(totalValue);
                    const kellyFraction = kellySize.kelly.stats?.trades >= 20
                        ? Math.min(0.25, kellySize.fraction)
                        : 0.10; // Fall back to 10% if < 20 trades

                    // Position size: prefer timeframe profile's positionSizePercent if available
                    let positionPercent = profilePosSize ? (profilePosSize / 100) : kellyFraction;
                    positionPercent = Math.min(positionPercent, kellyFraction * 2); // Don't exceed 2x Kelly

                    let investmentAmount = Math.min(portfolio.cash * 0.95, totalValue * positionPercent * riskAmount);

                    // Fix #7 (Tier 2): Confidence-based position sizing
                    // Scale position size by signal compositeScore: weak signals (30-50) → 0.7x, avg (50-70) → 1.0x, strong (70+) → 1.2x
                    const confidenceScore = adjustedComposite || score.compositeScore || 50;
                    let confidenceSizeMultiplier = 1.0;
                    if (confidenceScore >= 80) confidenceSizeMultiplier = 1.25;
                    else if (confidenceScore >= 70) confidenceSizeMultiplier = 1.15;
                    else if (confidenceScore >= 60) confidenceSizeMultiplier = 1.05;
                    else if (confidenceScore >= 50) confidenceSizeMultiplier = 1.0;
                    else if (confidenceScore >= 40) confidenceSizeMultiplier = 0.85;
                    else confidenceSizeMultiplier = 0.70;
                    investmentAmount *= confidenceSizeMultiplier;

                    // Fix #15 (Tier 2): Drawdown-graduated position sizing
                    // Instead of binary halt at max drawdown, gradually reduce sizes as drawdown grows.
                    // 0-3% drawdown: 100% size, 3-5%: 85%, 5-8%: 65%, 8-12%: 45%, 12%+: 25%
                    // In simulation mode, skip reduction — we want full-size trades for ML training data
                    if (drawdown > 0 && botState.tradingMode !== 'SIMULATION') {
                        let drawdownMultiplier = 1.0;
                        if (drawdown >= 12) drawdownMultiplier = 0.25;
                        else if (drawdown >= 8) drawdownMultiplier = 0.45;
                        else if (drawdown >= 5) drawdownMultiplier = 0.65;
                        else if (drawdown >= 3) drawdownMultiplier = 0.85;
                        investmentAmount *= drawdownMultiplier;
                    }

                    // Apply beast mode compound multiplier (cold streak 0.5x, hot streak 1.5x)
                    const compMult = getCompoundMultiplier();
                    investmentAmount *= compMult.multiplier;

                    investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);

                    // Apply sentiment penalty/boost: reduce size 20% for bearish, increase 10% for bullish
                    if (sentimentAdj < -3) {
                        investmentAmount *= 0.80;
                    } else if (sentimentAdj > 3) {
                        investmentAmount *= 1.10;
                    }
                    // Re-cap after sentiment adjustment so boost can't exceed tier limits
                    investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);

                    // ML Pipeline: apply gatekeeper size multiplier
                    if (pipelineResult && pipelineResult.sizeMultiplier !== 1.0) {
                        investmentAmount *= pipelineResult.sizeMultiplier;
                    }

                    // ML Advisory: scale position size by ML confidence agreement/disagreement
                    if (mlSizeMultiplier !== 1.0) {
                        investmentAmount *= mlSizeMultiplier;
                        investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);
                    }

                    // Layer 4: Portfolio Correlation Engine — size based on portfolio-level risk
                    try {
                        if (getFlag('CORRELATION_ENGINE_ENABLED')) {
                            const corrResult = portfolioCorrelationEngine.evaluateEntry(
                                ticker, investmentAmount, portfolio.positions, totalValue
                            );
                            if (!corrResult.allowed) {
                                logThought({
                                    type: 'SKIP', ticker, action: 'CORRELATION_BLOCKED',
                                    confidence: score.compositeScore,
                                    reason: corrResult.reason,
                                    regime: currentRegime,
                                });
                                entryStrategy = null;
                                investmentAmount = 0;
                            } else if (corrResult.sizeMultiplier !== 1.0) {
                                investmentAmount *= corrResult.sizeMultiplier;
                                investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);
                            }
                        }
                    } catch (e) {}

                    // Upgrade #10: Portfolio Optimizer — check portfolio health before entry
                    if (entryStrategy && investmentAmount > CONFIG.MIN_TRADE_SIZE && portfolioOptimizer) {
                        try {
                            if (getFlag('PORTFOLIO_OPTIMIZER_ENABLED')) {
                                const health = portfolioOptimizer.evaluatePortfolioHealth(
                                    portfolio.positions, null, totalValue
                                );
                                // Block entry if HHI is too concentrated
                                if (health.hhi > 0.33) {
                                    logThought({
                                        type: 'SKIP', ticker, action: 'PORTFOLIO_TOO_CONCENTRATED',
                                        confidence: score.compositeScore,
                                        reason: `HHI=${health.hhi.toFixed(3)} > 0.33 threshold, ${health.overweightPositions.length} overweight positions`,
                                        regime: currentRegime,
                                    });
                                    entryStrategy = null;
                                    investmentAmount = 0;
                                }
                            }
                        } catch (e) { /* fail open */ }
                    }

                    if (entryStrategy && investmentAmount > CONFIG.MIN_TRADE_SIZE) {
                        const pipelineTier = pipelineResult?.tier || 'N/A';
                        const pipelineMult = pipelineResult?.sizeMultiplier?.toFixed(2) || '1.00';
                        logThought({
                            type: 'ENTRY_EVAL', ticker, action: 'ENTERING',
                            confidence: score.compositeScore + mtfConfidenceAdj + fundingAdj + htfAdj + sentimentAdj,
                            reason: `${entryStrategy} entry [${marketSpeed}/${activeProfile?.timeframeId || 'default'}]: score=${score.compositeScore}, kelly=${(kellyFraction*100).toFixed(1)}%, mtf=${mtfConfidenceAdj}, funding=${fundingAdj}, htf=${htfAdj}, sentiment=${sentimentAdj}, pipeline=${pipelineTier}×${pipelineMult}${mlAdvice.available ? `, ml=${mlAdvice.direction}@${mlAdvice.confidence}%` : ''}`,
                            regime: currentRegime,
                            market_speed: marketSpeed,
                            indicators: { tcValue, compositeScore: score.compositeScore, kellyFraction, mtfConfidenceAdj, fundingAdj, htfAdj, sentimentAdj, investmentAmount, timeframeId: activeProfile?.timeframeId, mlDirection: mlAdvice.direction, mlConfidence: mlAdvice.confidence, pipelineTier, pipelineMult },
                        });
                        const volTargets = getDynamicTargets(candles);
                        await handleBuy(ticker, currentPrice, entryStrategy, `Batch scan [${marketSpeed}/${activeProfile?.timeframeId || 'default'}] (score=${score.compositeScore}, pipeline=${pipelineTier})`, investmentAmount, {
                            compositeScore: score.compositeScore,
                            triggerValue,
                            regime: volTargets.regime,
                            mlInfluenced: mlAdvice.available || (pipelineResult?.tier !== 'DISABLED'),
                            mlConfidence: pipelineResult?.confidence || mlAdvice.confidence,
                            mlDirection: mlAdvice.direction,
                            pipelineTier,
                            pipelineSizeMultiplier: pipelineResult?.sizeMultiplier || 1,
                        });
                    }
                }
            }
        }

        // --- PROFIT METHOD ENTRIES ---
        if (portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && (botState.tradingMode === 'SIMULATION' || drawdown <= tier.maxDrawdownLimit)) {
            const qualityForPM = availableTickers.filter(t => QUALITY_TICKERS.includes(t));
            const pmTickers = qualityForPM.length > 0 ? qualityForPM : availableTickers.slice(0, 50);
            const pmEntries = runProfitMethods(marketDataMap, portfolio, pmTickers, CONFIG.MIN_TRADE_SIZE);
            for (const entry of pmEntries) {
                if (portfolio.cash < CONFIG.MIN_TRADE_SIZE) break;
                // Enforce position count limit for profit methods too
                if (Object.keys(portfolio.positions).length >= maxConcurrentTrades && !portfolio.positions[entry.ticker]) break;
                if (!CapitalTierManager.isStrategyAllowed(entry.strategy, totalValue)) continue;

                // Liquidity gate for profit method entries too
                const pmCandles = marketDataMap.get(entry.ticker);
                if (pmCandles) {
                    const liq = checkLiquidity(pmCandles);
                    if (!liq.pass) continue;
                }

                let amount = CapitalTierManager.getRecommendedPositionSize(totalValue, Math.min(entry.amount, portfolio.cash * 0.9));
                if (amount >= CONFIG.MIN_TRADE_SIZE) {
                    const pmRegime = pmCandles ? getDynamicTargets(pmCandles).regime : 'NORMAL';
                    await handleBuy(entry.ticker, entry.price, entry.strategy, entry.reason, amount, { regime: pmRegime });
                }
            }
        }
        // Update position current prices for accurate holdings value
        for (const [ticker, pos] of Object.entries(portfolio.positions)) {
            const latestPrice = getLatestPrice(ticker);
            if (latestPrice > 0) {
                pos.currentPrice = latestPrice;
                if (latestPrice > (pos.highestPrice || 0)) pos.highestPrice = latestPrice;
                if (latestPrice < (pos.lowestPrice || Infinity)) pos.lowestPrice = latestPrice;
            }
        }

        // Record equity snapshot AFTER price update for accuracy
        recordEquitySnapshot(portfolio);

        // Update correlation matrix periodically
        try {
            if (getFlag('CORRELATION_ENGINE_ENABLED') && portfolioCorrelationEngine.isMatrixStale() && marketDataMap.size >= 2) {
                portfolioCorrelationEngine.updateCorrelationMatrix(marketDataMap);
            }
        } catch (e) {}

        saveSessionState();
    } catch (error) {
        // Log full error with stack trace for debugging — this is critical because
        // any unhandled error here would previously deadlock the entire bot
        console.error(`Bot loop error: ${error.message}\n${error.stack || ''}`);
        try {
            addLog(`Bot loop error: ${error.message}`, 'ERROR');
        } catch (logErr) {
            // Don't let logging errors prevent finally from running
        }
    } finally {
        // CRITICAL: Always clear the running flag. Without this, the bot deadlocks
        // permanently on any error. The watchdog at line ~3000 is a backup but has
        // a 60-second delay — this immediate reset is the primary safety mechanism.
        botLoopRunning = false;
        botLoopStartTime = 0;
    }
}

const MAX_TICKER_ALLOCATION = 0.10; // 10% max of portfolio in any single ticker

const handleBuy = async (ticker, price, strategy, reason, notional, entryMeta = {}) => {
    // Per-ticker cap: reject if this ticker already exceeds max allocation
    const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
        (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0);
    const existingPos = portfolio.positions[ticker];
    if (existingPos) {
        const existingValue = existingPos.quantity * (existingPos.currentPrice || existingPos.openPrice);
        const newTotalValue = existingValue + notional;
        if (newTotalValue > totalValue * MAX_TICKER_ALLOCATION) {
            const maxAdd = Math.max(0, totalValue * MAX_TICKER_ALLOCATION - existingValue);
            if (maxAdd < 1) {
                addLog(`[CAP] Skipping ${ticker}: already ${((existingValue / totalValue) * 100).toFixed(1)}% of portfolio`, 'WARN');
                return;
            }
            notional = maxAdd; // Reduce to fit within cap
        }
    }

    // Kraken minimum order validation
    if (getActiveExchangeId() === 'kraken' && krakenMinimums) {
        const minOrder = krakenMinimums.getMinimumOrder(ticker);
        if (notional < minOrder.minNotional) {
            addLog(`[KRAKEN] Order $${notional.toFixed(2)} below minimum $${minOrder.minNotional} for ${ticker} — skipping`, 'WARN');
            return;
        }
    }

    addLog(`Triggering BUY for ${ticker} @ ${price}. Reason: [${strategy}] ${reason}`, 'BUY');

    try {
        let quantity, avgPrice;
        const fees = getActiveFees();

        if (botState.tradingMode === 'SIMULATION') {
            // Simulation: synthetic slippage model (conservative estimate)
            // Small orders on major pairs: ~0.01-0.05%, large orders on altcoins: up to 0.2%
            const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(ticker);
            const baseSlippageBps = isMajor ? 2 : 8; // 0.02% majors, 0.08% alts
            const sizeMultiplier = Math.min(3, notional / 100); // scales up for larger orders
            const slippagePct = (baseSlippageBps * Math.max(1, sizeMultiplier)) / 10000 * 100;
            avgPrice = price * (1 + slippagePct / 100);
            quantity = notional / avgPrice;
        } else {
            // Real: smart order routing with order book slippage estimation
            const adapter = getExchangeAdapter();

            // Batch 2D: Try execution engine first (TWAP, limit-then-market)
            if (executionEngine && getFlag('SMART_EXECUTION_ENABLED')) {
                try {
                    const execResult = await executionEngine.executeSmartBuy(adapter, ticker, notional, botState.sessionId);
                    if (execResult && execResult.avgPrice > 0) {
                        avgPrice = execResult.avgPrice;
                        quantity = execResult.totalQty;
                        addLog(`[EXEC-ENGINE] Smart buy: ${quantity.toFixed(6)} @ ${avgPrice.toFixed(2)}, slippage=${execResult.slippage?.actualSlippage?.toFixed(3) || '?'}%, time=${execResult.executionTimeMs}ms`, 'INFO');
                        // Skip the inline order routing below
                    }
                } catch (execErr) {
                    addLog(`[EXEC-ENGINE] Smart buy failed: ${execErr.message}, falling back to inline routing`, 'WARN');
                    // Fall through to existing logic
                }
            }

            // Existing inline order routing (fallback if execution engine not used)
            if (!quantity) {
            let usedLimit = false;
            let partialFillQty = 0;
            let partialFillCost = 0;

            // Fetch order book for slippage estimation + adaptive limit pricing
            let orderBook = null;
            let estimatedSlippage = null;
            let adaptiveLimitPrice = price * (1 + 0.0001); // fallback: +0.01%
            try {
                orderBook = await withTimeout(adapter.getOrderBook(ticker, 20), 5000, 'getOrderBook');
                if (orderBook && orderBook.asks && orderBook.asks.length > 0) {
                    const estQty = notional / price;
                    estimatedSlippage = optimizeEntryExit(orderBook, 'BUY', estQty);

                    if (estimatedSlippage && estimatedSlippage.slippagePercent > 1.0) {
                        addLog(`[ORDER-BOOK] Skipping ${ticker}: estimated slippage ${estimatedSlippage.slippagePercent.toFixed(3)}% exceeds 1% threshold`, 'WARN');
                        return { success: false, slippageRejected: true };
                    }
                    if (!estimatedSlippage?.isLiquiditySufficient) {
                        addLog(`[ORDER-BOOK] Skipping ${ticker}: insufficient order book depth for $${notional.toFixed(2)}`, 'WARN');
                        return { success: false, slippageRejected: true };
                    }
                    // Adaptive limit price: best ask + 30% of spread (tighter than market, wider than book)
                    const bestBid = parseFloat(orderBook.bids[0]?.[0] || 0);
                    const bestAsk = parseFloat(orderBook.asks[0]?.[0] || 0);
                    if (bestBid > 0 && bestAsk > 0) {
                        const spread = bestAsk - bestBid;
                        adaptiveLimitPrice = bestAsk + spread * 0.3;
                    }
                    if (estimatedSlippage) {
                        addLog(`[ORDER-BOOK] ${ticker}: est. slippage ${estimatedSlippage.slippagePercent.toFixed(3)}%, spread ${bestAsk > 0 && bestBid > 0 ? ((bestAsk - bestBid) / bestBid * 100).toFixed(4) : '?'}%`, 'INFO');
                    }
                }
            } catch (e) {
                // Order book fetch failed — proceed without it (non-blocking)
            }

            // Try limit order if adapter supports it and spread is wide enough
            if (adapter.getMakerFeePercent && adapter.placeLimitBuyOrder) {
                try {
                    const limitPrice = adaptiveLimitPrice; // Use order-book-informed price
                    const vol = notional / limitPrice;

                    const limitOrder = await withTimeout(adapter.placeLimitBuyOrder(ticker, limitPrice, vol, botState.sessionId), 20000, 'placeLimitBuyOrder');

                    // Wait up to 10s for fill
                    let filled = false;
                    for (let i = 0; i < 5; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        const status = await withTimeout(adapter.getOrderStatus(limitOrder.orderId, botState.sessionId), 10000, 'getOrderStatus');
                        if (status.status === 'closed' || status.filledQty >= vol * 0.95) {
                            quantity = status.filledQty || vol;
                            avgPrice = status.avgPrice || limitPrice;
                            filled = true;
                            usedLimit = true;
                            break;
                        }
                    }

                    // If not fully filled, check for partial fill before cancelling
                    if (!filled) {
                        const finalStatus = await withTimeout(adapter.getOrderStatus(limitOrder.orderId, botState.sessionId), 10000, 'getOrderStatus');
                        partialFillQty = finalStatus.filledQty || 0;
                        partialFillCost = partialFillQty * (finalStatus.avgPrice || limitPrice);

                        await withTimeout(adapter.cancelOrder(limitOrder.orderId, botState.sessionId), 15000, 'cancelOrder');

                        if (partialFillQty > 0) {
                            // Reduce notional by what was already filled
                            notional -= partialFillCost;
                            addLog(`[SMART-ORDER] Limit partially filled ${partialFillQty.toFixed(6)} for ${ticker}, market-ordering $${notional.toFixed(2)} remainder`, 'INFO');
                        } else {
                            addLog(`[SMART-ORDER] Limit order not filled for ${ticker}, falling back to market`, 'INFO');
                        }

                        // If remainder is too small, just use the partial fill
                        if (notional < CONFIG.MIN_TRADE_SIZE) {
                            if (partialFillQty > 0) {
                                quantity = partialFillQty;
                                avgPrice = finalStatus.avgPrice || limitPrice;
                                usedLimit = true;
                            } else {
                                addLog(`[SMART-ORDER] Remaining notional $${notional.toFixed(2)} below min trade size, aborting`, 'WARN');
                                return;
                            }
                        }
                    }
                } catch (e) {
                    // Limit order failed, fall through to market
                    addLog(`[SMART-ORDER] Limit failed: ${e.message}, using market`, 'WARN');
                }
            }

            if (!usedLimit) {
                const orderResult = await withTimeout(adapter.placeBuyOrder(ticker, notional, botState.sessionId), 20000, 'placeBuyOrder');
                const marketQty = orderResult.quantity || (notional / price);
                const marketPrice = orderResult.avgPrice || price;

                if (partialFillQty > 0) {
                    // Aggregate partial limit fill + market fill
                    const totalQty = partialFillQty + marketQty;
                    avgPrice = (partialFillCost + marketQty * marketPrice) / totalQty;
                    quantity = totalQty;
                } else {
                    quantity = marketQty;
                    avgPrice = marketPrice;
                }
            }
            } // end if (!quantity) — execution engine fallback
        }

        // Use actual fill values for fee and cash deduction (not pre-fill estimate)
        const actualCost = parseFloat(quantity) * parseFloat(avgPrice);
        const buyFee = actualCost * fees.perSide;

        // Aggregate into existing position (weighted avg) instead of overwriting
        const existing = portfolio.positions[ticker];
        if (existing) {
            const oldQty = existing.quantity;
            const newQty = parseFloat(quantity);
            const totalQty = oldQty + newQty;
            const weightedAvg = (oldQty * existing.openPrice + newQty * parseFloat(avgPrice)) / totalQty;
            // Update entryStrategy + metadata if the new addition is larger (dominant strategy)
            const newIsDominant = newQty > oldQty;
            portfolio.positions[ticker] = {
                ...existing,
                quantity: totalQty,
                openPrice: weightedAvg,
                entryStrategy: newIsDominant ? strategy : existing.entryStrategy,
                highestPrice: Math.max(existing.highestPrice || weightedAvg, parseFloat(avgPrice)),
                lowestPrice: Math.min(existing.lowestPrice || weightedAvg, parseFloat(avgPrice)),
                // Keep metadata in sync with dominant strategy for optimizer accuracy
                ...(newIsDominant ? {
                    compositeScore: entryMeta.compositeScore || existing.compositeScore || 0,
                    triggerValue: entryMeta.triggerValue || existing.triggerValue || 0,
                    regime: entryMeta.regime || existing.regime || 'NORMAL',
                } : {}),
            };
        } else {
            portfolio.positions[ticker] = {
                quantity: parseFloat(quantity),
                openPrice: parseFloat(avgPrice),
                currentPrice: parseFloat(avgPrice),
                ticker,
                entryStrategy: strategy,
                entryTime: Date.now(),
                highestPrice: parseFloat(avgPrice),
                lowestPrice: parseFloat(avgPrice),
                compositeScore: entryMeta.compositeScore || 0,
                triggerValue: entryMeta.triggerValue || 0,
                regime: entryMeta.regime || 'NORMAL',
                mlInfluenced: entryMeta.mlInfluenced || false,
                mlConfidence: entryMeta.mlConfidence || 0,
                mlDirection: entryMeta.mlDirection || null,
            };
        }
        portfolio.cash -= (actualCost + buyFee);

        // Log the thought
        logThought({
            type: 'BUY',
            ticker,
            action: 'ENTERED_LONG',
            confidence: 0, // will be overridden by caller context
            reason: `[${strategy}] ${reason}`,
            indicators: { price: avgPrice, notional, fee: buyFee },
            regime: '',
        });

        // Record trade detail for session history
        recordSessionTradeDetail({
            type: 'BUY',
            ticker,
            price: parseFloat(avgPrice),
            quantity: parseFloat(quantity),
            notional,
            strategy,
            reason,
            fee: buyFee,
            balance_after: portfolio.cash,
        });

        if (telegramEnabled()) alertTradeExecution({ type: 'BUY', ticker, price: parseFloat(avgPrice), strategy, pnl: null });
        saveSessionState();
        return { success: true };
    } catch (error) {
        addLog(`BUY order failed: ${error.message}`, 'ERROR');
        return { success: false, insufficientBalance: error.message?.includes('INSUFFICIENT') };
    }
};

const handleSell = async (position, price, reason) => {
    addLog(`Triggering SELL for ${position.ticker} @ ${price}. Reason: ${reason}`, 'SELL');

    try {
        let avgPrice;
        const fees = getActiveFees();

        if (botState.tradingMode === 'SIMULATION') {
            // Simulation: synthetic sell-side slippage (selling into bids, slightly worse)
            const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(position.ticker);
            const sellNotional = position.quantity * price;
            const baseSlippageBps = isMajor ? 3 : 10; // sell-side slightly worse than buy
            const sizeMultiplier = Math.min(3, sellNotional / 100);
            const slippagePct = (baseSlippageBps * Math.max(1, sizeMultiplier)) / 10000 * 100;
            avgPrice = price * (1 - slippagePct / 100); // sells slip DOWN
        } else {
            // Real: route through exchange adapter
            const adapter = getExchangeAdapter();

            // Batch 2D: Try execution engine for smart sell (TWAP, limit-then-market)
            if (executionEngine && getFlag('SMART_EXECUTION_ENABLED')) {
                try {
                    const execResult = await executionEngine.executeSmartSell(adapter, position.ticker, position.quantity, botState.sessionId);
                    if (execResult && execResult.avgPrice > 0) {
                        avgPrice = execResult.avgPrice;
                        addLog(`[EXEC-ENGINE] Smart sell: ${position.quantity.toFixed(6)} @ ${avgPrice.toFixed(2)}, slippage=${execResult.slippage?.actualSlippage?.toFixed(3) || '?'}%, time=${execResult.executionTimeMs}ms`, 'INFO');
                    }
                } catch (execErr) {
                    addLog(`[EXEC-ENGINE] Smart sell failed: ${execErr.message}, falling back`, 'WARN');
                }
            }

            // Fallback: original order routing
            if (!avgPrice) {
            try {
                const orderBook = await withTimeout(adapter.getOrderBook(position.ticker, 20), 3000, 'getOrderBook-sell');
                if (orderBook?.bids?.length > 0) {
                    const slippageEst = optimizeEntryExit(orderBook, 'SELL', position.quantity);
                    if (slippageEst) {
                        addLog(`[ORDER-BOOK] SELL ${position.ticker}: est. slippage ${slippageEst.slippagePercent.toFixed(3)}%${slippageEst.isLiquiditySufficient ? '' : ' (INSUFFICIENT DEPTH)'}`, 'INFO');
                    }
                }
            } catch (e) {
                // Non-blocking — proceed with sell regardless
            }
            const orderResult = await withTimeout(adapter.placeSellOrder(position.ticker, position.quantity, botState.sessionId, instrumentSpecs), 20000, 'placeSellOrder');
            avgPrice = parseFloat(orderResult.avgPrice) || price;
            }
        }

        const sellFee = avgPrice * position.quantity * fees.perSide;
        const buyFee = position.openPrice * position.quantity * fees.perSide;
        const pnl = (avgPrice - position.openPrice) * position.quantity - sellFee - buyFee;

        // Update portfolio AFTER successful sell (not before, so failed sells don't orphan positions)
        portfolio.cash += (position.quantity * avgPrice) - sellFee;
        delete portfolio.positions[position.ticker];
        exitLevelCache.delete(position.ticker); // Clean RT exit cache

        // Clean up profit method internal state for this ticker
        cleanupProfitMethodState(position.ticker, position.entryStrategy);

        cbRecordTrade(pnl, position.entryStrategy, position.ticker);
        recordStrategyResult(position.entryStrategy, pnl);
        beastRecordTrade(pnl, position.ticker, position.entryStrategy);
        recordTradeForJournal({ ticker: position.ticker, strategy: position.entryStrategy, pnl, price: avgPrice, quantity: position.quantity, type: 'SELL' });
        autoJournal();
        recordSessionTrade(pnl);

        // Feed trade outcome to ML self-teaching loop
        try {
          recordTradeForLearning({
            ticker: position.ticker,
            strategy: position.entryStrategy,
            outcome: pnl >= 0 ? 'WIN' : 'LOSS',
            pnl,
            pnlPercent: ((avgPrice - position.openPrice) / position.openPrice) * 100,
            entryPrice: position.openPrice,
            exitPrice: avgPrice,
            entryTime: position.entryTime,
            exitTime: Date.now(),
            holdDuration: Date.now() - position.entryTime,
          });
        } catch (mlErr) {
          console.warn('[ML Feedback] Error recording trade for learning:', mlErr.message);
        }

        // Log the thought
        logThought({
            type: 'SELL',
            ticker: position.ticker,
            action: pnl >= 0 ? 'EXIT_PROFIT' : 'EXIT_LOSS',
            confidence: 0,
            reason,
            indicators: { entryPrice: position.openPrice, exitPrice: avgPrice, pnl, fee: sellFee },
            regime: '',
        });

        // Record trade detail
        recordSessionTradeDetail({
            type: 'SELL',
            ticker: position.ticker,
            price: avgPrice,
            quantity: position.quantity,
            strategy: position.entryStrategy,
            reason,
            pnl,
            fee: sellFee,
            balance_after: portfolio.cash,
        });

        if (telegramEnabled()) alertTradeExecution({ type: 'SELL', ticker: position.ticker, price: avgPrice, strategy: position.entryStrategy, pnl });

        // Track trade for optimizer
        const pnlPercent = ((avgPrice - position.openPrice) / position.openPrice) * 100;
        if (!portfolio.tradeLog) portfolio.tradeLog = [];
        portfolio.tradeLog.push({
            ticker: position.ticker,
            strategy: position.entryStrategy,
            entryPrice: position.openPrice,
            exitPrice: avgPrice,
            highestPrice: position.highestPrice || avgPrice,
            lowestPrice: position.lowestPrice || avgPrice,
            pnl,
            pnlPercent,
            entryTime: position.entryTime,
            exitTime: Date.now(),
            compositeScore: position.compositeScore || 0,
            triggerValue: position.triggerValue || 0,
            regime: position.regime || 'NORMAL',
            mlInfluenced: position.mlInfluenced || false,
            mlConfidence: position.mlConfidence || 0,
            mlDirection: position.mlDirection || null,
        });
        if (portfolio.tradeLog.length > 500) portfolio.tradeLog.splice(0, portfolio.tradeLog.length - 500);

        // Trigger optimizer (internal gating: first at 30 trades, then every 50)
        let optimizerJustRan = false;
        try {
            const result = triggerOptimization(portfolio.tradeLog);
            if (result.profitFactorBefore !== undefined) optimizerJustRan = true;
            if (result.changed) {
                setTargetOverrides(result.targets);
                logThought({ type: 'REGIME', ticker: 'OPTIMIZER', action: 'PARAMS_UPDATED',
                    confidence: 0, reason: `Optimizer adjusted ${result.changedParams.join(', ')}` });
                addLog(`[OPTIMIZER] Adjusted ${result.changedParams.length} params (PF: ${result.profitFactorBefore}, WR: ${result.winRateBefore}%) after ${portfolio.tradeLog.length} trades`, 'AI');
            } else if (optimizerJustRan) {
                // Optimizer ran but found no improvements — log for visibility
                const rejMsg = result.rejectedParams?.length > 0 ? `, rejected: ${result.rejectedParams.join(', ')}` : '';
                addLog(`[OPTIMIZER] Ran at ${portfolio.tradeLog.length} trades — no changes (PF: ${result.profitFactorBefore}, WR: ${result.winRateBefore}%${rejMsg})`, 'INFO');
            }
        } catch (e) {
            console.error('[OPTIMIZER] Error:', e.message);
        }

        // Post-optimization rollback check — skip if optimizer just ran on this trade
        // (this trade's outcome was determined by pre-optimization params)
        if (!optimizerJustRan) {
            try {
                const rollback = recordPostOptTrade(pnl);
                if (rollback.rolledBack) {
                    setTargetOverrides(rollback.targets);
                    logThought({ type: 'REGIME', ticker: 'OPTIMIZER', action: 'ROLLBACK',
                        confidence: 0, reason: rollback.reason });
                    addLog(`[OPTIMIZER] ROLLBACK: ${rollback.reason}`, 'WARN');
                }
            } catch (e) {}
        }

        saveSessionState();
    } catch (error) {
        addLog(`SELL order failed for ${position.ticker}: ${error.message}`, 'ERROR');
    }
};

const logPublicIp = async () => {
    try {
        const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
        const data = await response.json();
        publicIp = data.ip;
    } catch (error) {
        publicIp = 'error';
    }
};

const updateAvailableTickers = async () => {
    try {
        const activeExchange = getActiveExchangeId();
        const adapter = getExchangeAdapter();
        const adapterResult = await adapter.getInstruments();
        // Adapters may return { data: [...] } or a plain array
        const instruments = Array.isArray(adapterResult) ? adapterResult : (adapterResult?.data || adapterResult?.instruments || []);

        // Handle both Crypto.com (instrument_name, tradeable) and Kraken (symbol, tradable) field names
        availableTickers = instruments
            .filter(i => {
                const tradable = i.tradable ?? i.tradeable ?? true;
                return tradable === true || tradable === 'true';
            })
            .map(i => i.instrument_name || i.symbol || '')
            .filter(name => name.length > 0)
            .sort();

        for (const inst of instruments) {
            const name = inst.instrument_name || inst.symbol || '';
            if (name && inst.quantity_decimals !== undefined) {
                instrumentSpecs.set(name, {
                    quantity_decimals: parseInt(inst.quantity_decimals),
                    qty_tick_size: inst.qty_tick_size || '0.01'
                });
            }
        }

        if (availableTickers.length > 0) {
            console.log(`[Tickers] Updated: ${availableTickers.length} tickers from ${activeExchange}`);
        }
    } catch (error) {
        console.warn(`[Tickers] ${getActiveExchangeId()} getInstruments failed: ${error.message} — keeping ${availableTickers.length} existing tickers`);
    }
};


// ============================================
// Route Context + Mounting
// ============================================
const ctx = {
    // In-memory state (live references)
    get portfolio() { return portfolio; },
    get botState() { return botState; },
    get logs() { return logs; },
    get availableTickers() { return availableTickers; },
    get botInterval() { return botInterval; },
    set botInterval(v) { botInterval = v; },
    get peakValue() { return peakValue; },
    set peakValue(v) { peakValue = v; },
    get publicIp() { return publicIp; },
    CONFIG,
    QUALITY_TICKERS,

    // Core functions
    addLog,
    getMarketData,
    makePublicRequest,
    makeSignedRequest,
    saveSessionState,
    tradingBotLoop,
    handleBuy,
    handleSell,
    updateAvailableTickers,
    logPublicIp,
    getActiveFees,
    getLatestPrice,

    // Exchange adapter
    getExchangeAdapter,
    setActiveExchange,
    getActiveExchangeId,
    listExchanges,
    reconnectWebSocketForExchange,
    getWebSocketStatusProxy,
    wsConnected,
    beastSetRoundTripFee,
    setFeeForSimulation,
    beastSetSessionBalance,

    // Session management
    SessionManager,
    setActiveSession,
    getActiveSessionId,
    setThoughtSessionId,
    saveFullState,
    recordEquitySnapshot,
    recordSessionTradeDetail,
    getSessionStatus,
    getTradeHistory,
    getTradeStats,
    getEquityCurve,
    getSessionHistory,
    getSessionDetail,
    insertSessionRecord,
    completeSession,
    pmSetSessionStart,

    // State export/import
    cbExportState,
    awExportState,
    beastExportState,
    pmExportState,
    optExportState,
    cbImportState,
    awImportState,
    optImportState,

    // Reset functions
    fullResetCircuitBreaker,
    fullResetBeastMode,
    fullResetWeights,
    setDailyBalance,

    // Status functions
    getCircuitBreakerStatus,
    getBeastModeStatus,
    getAdaptiveWeightsStatus,
    getOptimizerStatus,
    getProfitMethodsStatus,
    getPreTradeAIStatus,
    getAILearningStatus,

    // ML/Thought logger
    getThoughts,
    getCurrentFocus,
    getThoughtStats,

    // Optimizer
    forceOptimize,
    setTargetOverrides,
    resetOptimizer,

    // DB functions
    pingDatabase,
    getSetting,
    setSetting,
    getLatestMLModel,
    getMLAccuracyStats,
    getMLModelHistory,
    getMLPredictions,
    getNewsItems,
    getExchangeSnapshots,
    getLatestDerivatives,
    getLatestDeFiSnapshot,

    // Learned state
    getLearnedState,

    // Signals
    getOrderBookSignal,
    getCorrelationMatrix,
    getFundingRateSignal,

    // Backtest
    runBacktest,
    getAvailableBacktestData,
    runParameterSweep,
    runWalkForward,

    // Telegram
    sendTestMessage,
    telegramStatus,

    // Journal
    getJournalEntries,
    forceGenerateJournal,

    // Questrade & brain
    questrade,
    paperTrader,
    strategyEngine,
    brain,
    brainThoughts,
    questradeBotState,
    dataIngestion,

    // Dynamic services
    multiExchangeService,
    smartMoneyService,
    localNLPService,
    adaptiveThresholdsService,
    selfTeachingLoop,
    youtubeSentimentService,
    redditSentimentService,
    timeframeStrategyService,
    krakenMinimums,
};

// Mount extracted route modules
app.use('/api', createMarketRouter(ctx));
app.use('/api', createExchangeRouter(ctx));
app.use('/api', createAuthRouter(ctx));
app.use('/api', createQuestradeRouter(ctx));
app.use('/api', createSessionsRouter(ctx));
app.use('/api', createIntelligenceRouter(ctx));
app.use('/api', createSentimentRouter(ctx));
app.use('/api', createSignalsRouter(ctx));
app.use('/api', createNotificationsRouter(ctx));
app.use('/api', createConfigRouter(ctx));
app.use('/api', createBacktestRouter(ctx));
app.use('/api', createMultiExchangeRouter(ctx));

// SPA catch-all (must be AFTER all API routes)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.use((err, req, res, next) => {
    res.status(500).json({ message: err.message });
});

const startServer = async () => {
    initializeDatabase();
    markAbandonedSessions();
    initJournalTable();
    initTelegram();

    // Check exchange credentials at startup (no longer fatal — user can provide via login)
    if (getActiveExchangeId() === 'kraken') {
        if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_SECRET) {
            console.log('[Server] Kraken mode: no env vars set — user must authenticate via UI');
        } else {
            console.log('[Server] Kraken mode: env credentials available');
        }
    }

    // Restore previous session state before anything else
    const restoredState = restoreFullState();
    if (restoredState) {
        if (restoredState.portfolio) {
            portfolio.cash = restoredState.portfolio.cash ?? portfolio.cash;
            portfolio.initialBudget = restoredState.portfolio.initialBudget ?? portfolio.initialBudget;
            portfolio.positions = restoredState.portfolio.positions ?? {};
            portfolio.holdings = restoredState.portfolio.holdings ?? {};
            portfolio.tradeLog = restoredState.portfolio.tradeLog ?? [];
            // Ensure restored positions have currentPrice initialized
            for (const pos of Object.values(portfolio.positions)) {
                if (!pos.currentPrice) pos.currentPrice = pos.openPrice;
            }
        }
        if (restoredState.circuitBreaker) try { cbImportState(restoredState.circuitBreaker); } catch(e) {}
        if (restoredState.adaptiveWeights) try { awImportState(restoredState.adaptiveWeights); } catch(e) {}
        if (restoredState.beastMode) try { beastImportState(restoredState.beastMode); } catch(e) {}
        if (restoredState.profitMethods) try { pmImportState(restoredState.profitMethods); } catch(e) {}
        if (restoredState.optimizer) try {
            optImportState(restoredState.optimizer);
            const optTargets = getOptimizedTargets();
            if (optTargets) setTargetOverrides(optTargets);
        } catch(e) {}
        if (restoredState.botState?.sessionId) botState.sessionId = restoredState.botState.sessionId;
        if (restoredState.botState?.settings) botState.settings = { ...botState.settings, ...restoredState.botState.settings };

        // Initialize circuit breaker daily balance from restored portfolio
        const restoredHoldings = Object.values(portfolio.positions).reduce(
            (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0);
        setDailyBalance(portfolio.cash + restoredHoldings);

        console.log(`[Server] Session restored: $${portfolio.cash?.toFixed(2)} cash, ${Object.keys(portfolio.positions).length} positions`);

        // Restore DCA/Grid/Swing positions from database
        const activeSessionId = getActiveSessionId();
        if (activeSessionId) {
            restorePositionsFromDatabase(activeSessionId);
        }
    }

    // Sync exchange fee to beast mode + optimizer at startup
    try {
        const startupFees = getActiveFees();
        beastSetRoundTripFee(startupFees.roundTrip * 100);   // Was missing! Beast mode defaulted to 0.15% (Crypto.com)
        setFeeForSimulation(startupFees.roundTrip * 100);
        console.log(`[Server] Fee synced: ${(startupFees.roundTrip * 100).toFixed(2)}% round-trip (${getActiveExchangeId()})`);
    } catch(e) {}

    await logPublicIp();
    await updateAvailableTickers();
    // preTradeAI is a local rule engine — no API key needed
    restoreAILearning();
    
    // Create HTTP server and attach WebSocket relay for frontend clients
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws/market' });
    const frontendClients = new Set();

    wss.on('connection', (clientWs) => {
        frontendClients.add(clientWs);
        clientWs.on('close', () => frontendClients.delete(clientWs));
        clientWs.on('error', () => frontendClients.delete(clientWs));
        // Send initial status
        clientWs.send(JSON.stringify({ type: 'connected', tickers: availableTickers }));
    });

    // Broadcast function for relaying Crypto.com data to all frontend clients
    function broadcastToFrontend(data) {
        const msg = typeof data === 'string' ? data : JSON.stringify(data);
        for (const client of frontendClients) {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(msg);
            }
        }
    }

    // Initialize WebSocket for the active exchange — subscribe to all quality tickers
    // so WS buffer starts filling immediately (avoids REST for 1m data once buffer is warm)
    const FALLBACK_TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
    const wsTickers = [...new Set([...QUALITY_TICKERS, ...(availableTickers.length > 0 ? availableTickers : FALLBACK_TICKERS)])];
    initExchangeWebSocket(wsTickers, broadcastToFrontend);

    setInterval(updateAvailableTickers, CONFIG.TICKER_REFRESH_MS);

    // Start multi-exchange data collection
    if (multiExchangeService) {
        try {
            multiExchangeService.startDataCollection('BTCUSD');
            console.log('[Server] Multi-exchange data collection started');
        } catch (e) {
            console.warn('[Server] Failed to start multi-exchange collection:', e.message);
        }
    }

    // Initialize ML Pipeline (4-Layer System)
    try {
        initSystemConfig();
        console.log('[Server] System config initialized');
    } catch (e) {
        console.warn('[Server] System config init failed:', e.message);
    }

    // Initialize ML prediction engine
    if (mlPredictionService) {
        try {
            await mlPredictionService.initializeML();
            console.log('[Server] ML prediction engine initialized');

            // Wire ML engine into gatekeeper
            if (mlPredictionService.getMLEngine) {
                const engine = mlPredictionService.getMLEngine();
                if (engine) mlGatekeeper.init(engine);
            }
        } catch (e) {
            console.warn('[Server] ML init failed (will retry on data):', e.message);
        }
    }

    // Initialize adversarial brains
    try {
        adversarialBrains.init();
        mlGatekeeper.setAdversarialBrains(adversarialBrains);
        console.log('[Server] Adversarial brains initialized');
    } catch (e) {
        console.warn('[Server] Adversarial brains init failed:', e.message);
    }

    // Initialize portfolio correlation engine
    try {
        portfolioCorrelationEngine.init();
        console.log('[Server] Portfolio correlation engine initialized');
    } catch (e) {
        console.warn('[Server] Correlation engine init failed:', e.message);
    }

    // Initialize genetic population (always, for when toggled on)
    try {
        const pop = getGeneticPopulation();
        console.log('[Server] Genetic population initialized:', pop.getStatus().populationSize, 'genomes');
    } catch (e) {
        console.warn('[Server] Genetic engine init failed:', e.message);
    }

    // Initialize adaptive thresholds
    if (adaptiveThresholdsService) {
        try {
            adaptiveThresholdsService.initializeThresholds();
            console.log('[Server] Adaptive thresholds initialized');
        } catch (e) {
            console.warn('[Server] Adaptive thresholds init failed:', e.message);
        }
    }

    // Start self-teaching loop
    if (selfTeachingLoop) {
        try {
            selfTeachingLoop.startSelfTeaching();
            console.log('[Server] Self-teaching loop started');
        } catch (e) {
            console.warn('[Server] Self-teaching start failed:', e.message);
        }
    }

    // Schedule DB cleanup weekly (Batch 5A: 90-day retention)
    setInterval(() => {
        try { cleanupOldData(90); } catch (e) { console.warn('[DB Cleanup] Error:', e.message); }
    }, 7 * 24 * 60 * 60 * 1000);

    // Start continuous backtester (Batch 4C)
    if (continuousBacktester) {
        try {
            continuousBacktester.start();
            console.log('[Server] Continuous backtester started');
        } catch (e) {
            console.warn('[Server] Continuous backtester start failed:', e.message);
        }
    }

    const scanner = new SignalScanner(
        async (ticker, timeframe) => await getMarketData(ticker, timeframe, 100),
        addLog,
        injectSignal
    );
    scanner.start();

    // Restore ML thought logger session
    if (restoredState?.botState?.sessionId) {
        const sid = getActiveSessionId() || restoredState.botState.sessionId;
        setThoughtSessionId(sid);
        restoreThoughts(sid);
    }

    // Auto-start bot if it was active in previous session
    if (restoredState?.wasActive && botState.sessionId) {
        botState.isActive = true;
        botState.tradingMode = restoredState.botState?.tradingMode || 'SIMULATION';
        botState.sessionStartTime = restoredState.uptime?.startTime || Date.now();
        pmSetSessionStart(Date.now());
        botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);
        console.log('[Server] Bot auto-resumed from previous session');
        addLog('[SESSION] Bot auto-resumed after restart', 'INFO');
    }

    // Start auto-save (every 60 seconds)
    startAutoSave({
        get portfolio() { return portfolio; },
        get botState() { return botState; },
        cbExportState, awExportState, beastExportState, pmExportState, optExportState,
        get availableTickers() { return availableTickers; },
    }, 60000);

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[Server] Port ${CONFIG.PORT} in use, retrying in 5 seconds...`);
            setTimeout(() => server.listen(CONFIG.PORT), 5000);
        } else {
            console.error('[Server] Fatal server error:', err);
            process.exit(1);
        }
    });

    server.listen(CONFIG.PORT, () => {
        console.log(`Server running on port ${CONFIG.PORT} (HTTP + WebSocket relay)`);
    });
};

let isShuttingDown = false;

function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[Server] ${signal} received, shutting down gracefully...`);

    // Force exit after 30 seconds
    const forceTimer = setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out after 30s, forcing exit');
        process.exit(1);
    }, 30000);
    forceTimer.unref();

    // Log final portfolio state
    try {
        const posCount = Object.keys(portfolio.positions).length;
        const totalPnl = (portfolio.tradeLog || []).reduce((sum, t) => sum + (t.pnl || 0), 0);
        console.log(`[Server] Final state: cash=$${portfolio.cash?.toFixed(2)}, positions=${posCount}, trades=${portfolio.tradeLog?.length || 0}, totalPnl=$${totalPnl.toFixed(2)}`);
    } catch (e) {
        console.warn('[Server] Could not log final portfolio:', e.message);
    }

    // Save state
    try {
        stopAutoSave();
        saveFullState({
            portfolio, botState,
            cbExportState, awExportState, beastExportState, pmExportState, optExportState,
            availableTickers,
        });
        console.log('[Server] State saved successfully');
    } catch (e) {
        console.error('[Server] State save failed:', e.message);
    }

    // Close connections
    try {
        getActiveWsService().closeWebSocket();
    } catch (e) {
        console.warn('[Server] WebSocket close error:', e.message);
    }

    try {
        closeDatabase();
    } catch (e) {
        console.warn('[Server] Database close error:', e.message);
    }

    console.log('[Server] Shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================
// Bot Loop Watchdog (hang recovery)
// ============================================
const BOT_LOOP_MAX_DURATION_MS = 60000; // 60s max per loop iteration
setInterval(() => {
    if (botLoopRunning && botLoopStartTime > 0) {
        const elapsed = Date.now() - botLoopStartTime;
        if (elapsed > BOT_LOOP_MAX_DURATION_MS) {
            console.error(`[WATCHDOG] Bot loop stuck for ${(elapsed / 1000).toFixed(0)}s — force-resetting botLoopRunning`);
            try { addLog(`[WATCHDOG] Bot loop hung for ${(elapsed / 1000).toFixed(0)}s, force-reset to unblock`, 'ERROR'); } catch (e) {}
            botLoopRunning = false;
            botLoopStartTime = 0;
        }
    }
}, 10000);

// ============================================
// Process Crash Handlers
// ============================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH-GUARD] Unhandled Promise rejection:', reason);
    try { addLog(`[CRASH-GUARD] Unhandled rejection: ${reason}`, 'ERROR'); } catch (e) {}
    // Don't exit — watchdog will recover if bot loop is stuck
});

process.on('uncaughtException', (error) => {
    // EADDRINUSE is handled by server.on('error') retry — don't exit
    if (error.code === 'EADDRINUSE') {
        console.warn(`[CRASH-GUARD] Port in use, server will retry automatically`);
        return;
    }
    console.error('[CRASH-GUARD] Uncaught exception:', error);
    try { addLog(`[CRASH-GUARD] Uncaught exception: ${error.message}`, 'ERROR'); } catch (e) {}
    try { saveSessionState(); } catch (e) {}
    process.exit(1); // Let PM2/systemd restart clean
});

startServer();