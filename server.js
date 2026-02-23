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

// Import Advanced Services
import * as VolatilityService from './services/volatilityService.js';
import * as SentimentService from './services/sentimentService.js';
import * as RiskService from './services/riskService.js';

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
import { recordTradeResult as cbRecordTrade, setDailyBalance, shouldPauseTrading, resetCircuitBreaker, fullResetCircuitBreaker, calculateKellyFraction, getKellyPositionSize, getStrategyKelly, getCircuitBreakerStatus, exportState as cbExportState, importState as cbImportState } from './services/circuitBreaker.js';
import { recordStrategyResult, getStrategyWeight, adjustPositionSize, isStrategyThrottled, getAdaptiveWeightsStatus, fullResetWeights, exportState as awExportState, importState as awImportState } from './services/adaptiveWeights.js';
import { calculateAllIndicators } from './services/advancedIndicators.js';
import { runBacktest, getAvailableBacktestData, runMultiBacktest, runWalkForward, runParameterSweep } from './services/backtestEngine.js';
import { getSocialSentimentScore, fetchFearGreedIndex, shouldTradeBasedOnSentiment } from './services/socialSentiment.js';
import { setGeminiKey, getPreTradeDecision, getPreTradeAIStatus } from './services/preTradeAI.js';
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

let multiExchangeService = null;
let mlPredictionService = null;
let selfTeachingLoop = null;
let smartMoneyService = null;
let localNLPService = null;
let adaptiveThresholdsService = null;

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
    RATE_LIMIT_MAX_REQUESTS: 100,

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
    'AVAXUSD', 'LINKUSD', 'DOTUSD', 'MATICUSD', 'UNIUSD', 'ATOMUSD', 'LTCUSD',
    'BCHUSD', 'NEARUSD', 'FILUSD', 'APTUSD', 'ARBUSD', 'OPUSD',
    'AAVEUSD', 'MKRUSD', 'INJUSD', 'SUIUSD', 'SEIUSD', 'TIAUSD',
    'RENDERUSD', 'FETUSD', 'GRTUSD', 'IMXUSD', 'SANDUSD', 'MANAUSD',
    'AXSUSD', 'ALGOUSD', 'FTMUSD', 'RUNEUSD', 'ENSUSD', 'LDOUSD',
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
app.use(rateLimit);

// Serve built frontend (production)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'dist')));

// Mount persistence routes (SQLite database)
app.use('/api/db', persistenceRoutes);

// Mount TradingView webhook routes
// app.use('/api/tradingview', tradingviewRoutes);

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

// Clean expired sessions periodically
setInterval(() => {
    const cleaned = SessionManager.cleanExpiredSessions();
    if (cleaned > 0) {
        console.log(`[SessionManager] Cleaned up ${cleaned} expired sessions.`);
    }
}, 300000); // Every 5 minutes

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
// Crypto.com API Logic
// ============================================
async function makePublicRequest(method, params = {}) {
    const url = new URL(`${CONFIG.API_BASE_URL}${method}`);
    url.search = new URLSearchParams(params).toString();

    const response = await fetch(url.toString());
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
        })
    });

    const data = await response.json();

    if (data.code != 0) {
        console.error(`[Crypto.com] ${method} failed:`, JSON.stringify(data));
        throw new Error(`Crypto.com API Error (Code: ${data.code}): ${data.message || 'No message provided.'}`);
    }
    return data.result;
}

// ============================================
// Helper: Convert ticker to instrument_name format
// ============================================
function toInstrumentName(ticker) {
    if (ticker.includes('_')) return ticker; // Already formatted
    if (ticker.endsWith('USDC')) return ticker.replace('USDC', '_USDC');
    if (ticker.endsWith('USDT')) return ticker.replace('USDT', '_USDT');
    if (ticker.endsWith('CAD')) return ticker.replace('CAD', '_CAD');
    if (ticker.endsWith('USD')) return ticker.replace('USD', '_USD');
    return ticker;
}

// Market Data Fetching (Parallel) + Auto-collect to SQLite
// ============================================
async function getMarketData(ticker, timeframe = '1m', count = 100) {
    const instrument_name = toInstrumentName(ticker);
    const result = await makePublicRequest('public/get-candlestick', { instrument_name, timeframe, count });
    const candles = result.data;

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
    // Fetch all tickers in parallel for efficiency
    const promises = tickers.map(async (ticker) => {
        try {
            const candles = await getMarketData(ticker, timeframe);
            return { ticker, candles, error: null };
        } catch (error) {
            return { ticker, candles: null, error: error.message };
        }
    });

    return Promise.all(promises);
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
// Trading Bot Loop (Optimized for Large Universes)
// ============================================
let botLoopRunning = false;
async function tradingBotLoop() {
    if (!botState.isActive) return;
    if (botLoopRunning) return; // prevent overlapping async iterations
    botLoopRunning = true;

    try {
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
        const allMarketData = await getMultipleMarketData(tickersToFetch);

        // Create a lookup map
        const marketDataMap = new Map();
        for (const { ticker, candles, error } of allMarketData) {
            if (!error && candles && candles.length >= CONFIG.MIN_CANDLES_REQUIRED) {
                marketDataMap.set(ticker, candles);
            }
        }

        // --- CIRCUIT BREAKER CHECK ---
        const pauseCheck = shouldPauseTrading();
        if (pauseCheck.paused) {
            if (Math.random() < 0.1) addLog(`[CIRCUIT BREAKER] Paused: ${pauseCheck.reason} (${pauseCheck.remainingMinutes}min left)`, 'WARN');
        }

        // --- MULTI-TIMEFRAME DATA (5m, 15m, 1h alongside 1m) ---
        let mtfDataMap = new Map();
        let data1hMap = new Map(); // 1h candles for cross-TF momentum check
        try {
            const mtfTickers = [...new Set([...positionTickers, ...scanBatch.slice(0, 6)])];
            const [data5m, data15m, data1h] = await Promise.all([
                getMultipleMarketData(mtfTickers, '5m'),
                getMultipleMarketData(mtfTickers, '15m'),
                getMultipleMarketData(mtfTickers, '1h'),
            ]);
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

        // --- EXIT LOGIC ---
        for (const ticker of positionTickers) {
            const position = portfolio.positions[ticker];
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

            // Strategy indicator exits — only fire after minimum 5 min hold time.
            // On 5m/15m candles, indicators are noisy and whipsaw constantly.
            // Training on 1h candles showed trades need room to develop.
            const indicatorHoldMs = Date.now() - (position.entryTime || 0);
            const MIN_HOLD_FOR_INDICATOR_EXIT = 5 * 60 * 1000; // 5 minutes

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
            if (!pos) continue;
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

        if (sessionProfitGoal && totalValue >= sessionProfitGoal) {
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
        if (openSlots > 0 && portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && drawdown <= tier.maxDrawdownLimit) {

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

            // --- SENTIMENT ENRICHMENT: fetch combined sentiment for top candidates ---
            const sentimentCache = new Map();
            try {
                const topTickers = candidates.slice(0, 5).map(c => c.ticker);
                const sentimentResults = await Promise.allSettled(
                    topTickers.map(async (ticker) => {
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
                        const bkout = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
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
                    // WHALE: high whale money flow = smart money buying
                    if (profileStrategies.includes('WHALE')) {
                        const whaleValue = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50;
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

                    // Pick the strongest signal that passes regime + throttle filters
                    if (stratCandidates.length > 0) {
                        stratCandidates.sort((a, b) => b.strength - a.strength);
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
                        }

                        // If both 1h AND 15m are bearish, skip entry entirely
                        if (trend1h === 'BEARISH' && trend15m === 'BEARISH') {
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

                // ML Advisory (A/B tracking) — advisory only, does not block trades
                let mlAdvice = { available: false, direction: null, confidence: 0 };
                if (entryStrategy && mlPredictionService?.getMLAdvice) {
                    try {
                        mlAdvice = await mlPredictionService.getMLAdvice(ticker, candles, {});
                        if (mlAdvice.available) {
                            logThought({ type: 'ML_ADVICE', ticker, action: 'ML_PREDICTION',
                                confidence: mlAdvice.confidence,
                                reason: `ML predicts ${mlAdvice.direction} with ${mlAdvice.confidence}% confidence (advisory only)`,
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

                        pipelineResult = mlGatekeeper.evaluateEntry(
                            ticker, candles, entryStrategy, bestStrength,
                            { strategySignals, geneticSignals }
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
                            logThought({
                                type: 'ML_PIPELINE', ticker, action: 'ML_GATEKEEPER_PASS',
                                confidence: pipelineResult.confidence,
                                reason: `${pipelineResult.tier}: ${pipelineResult.reason} (size×${pipelineResult.sizeMultiplier.toFixed(2)})`,
                                regime: currentRegime,
                            });
                        }
                    } catch (e) {
                        // ML gatekeeper error — fail open
                    }
                }
                // ===== END ML PIPELINE =====

                // Hard floor: reject any entry with adjusted compositeScore below optimizer floor
                const adjustedComposite = score.compositeScore + htfAdj + fundingAdj;
                if (entryStrategy && adjustedComposite < optParams.compositeScoreFloor) {
                    logThought({
                        type: 'SKIP', ticker, action: 'LOW_COMPOSITE',
                        confidence: adjustedComposite,
                        reason: `adjustedComposite ${adjustedComposite} (raw=${score.compositeScore}, htf=${htfAdj}, funding=${fundingAdj}) < ${optParams.compositeScoreFloor} floor`,
                        regime: currentRegime,
                        indicators: { compositeScore: score.compositeScore, adjustedComposite, htfAdj, fundingAdj, entryStrategy },
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
        if (portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && drawdown <= tier.maxDrawdownLimit) {
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
        console.error(`Bot loop error: ${error.message}`);
    } finally {
        botLoopRunning = false;
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

    addLog(`Triggering BUY for ${ticker} @ ${price}. Reason: [${strategy}] ${reason}`, 'BUY');

    try {
        let quantity, avgPrice;
        const fees = getActiveFees();

        if (botState.tradingMode === 'SIMULATION') {
            // Simulation: use current price + fee, no exchange call
            avgPrice = price;
            quantity = notional / price;
        } else {
            // Real: smart order routing (limit vs market based on spread)
            const adapter = getExchangeAdapter();
            let usedLimit = false;
            let partialFillQty = 0;
            let partialFillCost = 0;

            // Try limit order if adapter supports it and spread is wide enough
            if (adapter.getMakerFeePercent && adapter.placeLimitBuyOrder) {
                try {
                    const limitPrice = price * (1 + 0.0001); // best bid + 0.01%
                    const vol = notional / limitPrice;

                    const limitOrder = await adapter.placeLimitBuyOrder(ticker, limitPrice, vol, botState.sessionId);

                    // Wait up to 10s for fill
                    let filled = false;
                    for (let i = 0; i < 5; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        const status = await adapter.getOrderStatus(limitOrder.orderId, botState.sessionId);
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
                        const finalStatus = await adapter.getOrderStatus(limitOrder.orderId, botState.sessionId);
                        partialFillQty = finalStatus.filledQty || 0;
                        partialFillCost = partialFillQty * (finalStatus.avgPrice || limitPrice);

                        await adapter.cancelOrder(limitOrder.orderId, botState.sessionId);

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
                const orderResult = await adapter.placeBuyOrder(ticker, notional, botState.sessionId);
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
            // Simulation: use current price, no exchange call
            avgPrice = price;
        } else {
            // Real: route through exchange adapter — must succeed before we update portfolio
            const adapter = getExchangeAdapter();
            const orderResult = await adapter.placeSellOrder(position.ticker, position.quantity, botState.sessionId, instrumentSpecs);
            avgPrice = parseFloat(orderResult.avgPrice) || price;
        }

        const sellFee = avgPrice * position.quantity * fees.perSide;
        const buyFee = position.openPrice * position.quantity * fees.perSide;
        const pnl = (avgPrice - position.openPrice) * position.quantity - sellFee - buyFee;

        // Update portfolio AFTER successful sell (not before, so failed sells don't orphan positions)
        portfolio.cash += (position.quantity * avgPrice) - sellFee;
        delete portfolio.positions[position.ticker];

        // Clean up profit method internal state for this ticker
        cleanupProfitMethodState(position.ticker, position.entryStrategy);

        cbRecordTrade(pnl, position.entryStrategy, position.ticker);
        recordStrategyResult(position.entryStrategy, pnl);
        beastRecordTrade(pnl, position.ticker, position.entryStrategy);
        recordTradeForJournal({ ticker: position.ticker, strategy: position.entryStrategy, pnl, price: avgPrice, quantity: position.quantity, type: 'SELL' });
        autoJournal();
        recordSessionTrade(pnl);

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
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        publicIp = data.ip;
    } catch (error) {
        publicIp = 'error';
    }
};

const updateAvailableTickers = async () => {
    try {
        // Try active exchange adapter first
        const activeExchange = getActiveExchangeId();
        let instruments = [];

        if (activeExchange !== 'crypto.com') {
            try {
                const adapter = getExchangeAdapter(activeExchange);
                const adapterResult = await adapter.getInstruments();
                // Adapters may return { data: [...] } or a plain array
                instruments = Array.isArray(adapterResult) ? adapterResult : (adapterResult?.data || adapterResult?.instruments || []);
            } catch (e) {
                console.warn('[Tickers] Adapter getInstruments failed, falling back to Crypto.com:', e.message);
            }
        }

        // Fallback to Crypto.com API
        if (!Array.isArray(instruments) || instruments.length === 0) {
            const result = await makePublicRequest('public/get-instruments');
            instruments = result.instruments || result.data || [];
        }

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
        console.error('Ticker update failed:', error.message);
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
    if (process.env.GEMINI_API_KEY) setGeminiKey(process.env.GEMINI_API_KEY);
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

    // Initialize WebSocket for the active exchange
    const FALLBACK_TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
    const wsTickers = availableTickers.length > 0 ? availableTickers : FALLBACK_TICKERS;
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

    // Schedule DB cleanup weekly
    setInterval(() => {
        try { cleanupOldData(30); } catch (e) { console.warn('[DB Cleanup] Error:', e.message); }
    }, 7 * 24 * 60 * 60 * 1000);

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

startServer();