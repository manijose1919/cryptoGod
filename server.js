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
import { checkProfitMethodExits, runProfitMethods, getProfitMethodsStatus, exportState as pmExportState, importState as pmImportState } from './services/profitMethods.js';

// Phase 2-5 Services
// WebSocket services are accessed dynamically via getWebSocketService()
import * as cryptoComWsService from './services/websocketService.js';
import { analyzeMultiTimeframe, shouldEnterLong, getMultiTimeframeStatus } from './services/multiTimeframe.js';
import { recordTradeResult as cbRecordTrade, setDailyBalance, shouldPauseTrading, resetCircuitBreaker, calculateKellyFraction, getKellyPositionSize, getStrategyKelly, getCircuitBreakerStatus, exportState as cbExportState, importState as cbImportState } from './services/circuitBreaker.js';
import { recordStrategyResult, getStrategyWeight, adjustPositionSize, isStrategyThrottled, getAdaptiveWeightsStatus, exportState as awExportState, importState as awImportState } from './services/adaptiveWeights.js';
import { calculateAllIndicators } from './services/advancedIndicators.js';
import { runBacktest, getAvailableBacktestData, runMultiBacktest, runWalkForward, runParameterSweep } from './services/backtestEngine.js';
import { getSocialSentimentScore, fetchFearGreedIndex, shouldTradeBasedOnSentiment } from './services/socialSentiment.js';
import { setGeminiKey, getPreTradeDecision, getPreTradeAIStatus } from './services/preTradeAI.js';
import { getMarketRegime, getStrategyPool, isStrategyAllowedForRegime, adjustForVolatility, getCompoundMultiplier, getDynamicTargets, checkDynamicExit, recordTradeResult as beastRecordTrade, updateBalance as beastUpdateBalance, setSessionBalance as beastSetSessionBalance, getBeastModeStatus, exportState as beastExportState, importState as beastImportState, setRoundTripFee as beastSetRoundTripFee } from './services/beastMode.js';

// Phase 6: New Backend Services (SIM parity)
import { getMasterSurgeDecision, detectSurge, detectCandlestickPatterns } from './services/surgeTradingBackend.js';
import { recordTradeForLearning, shouldTakeTradeAI, getAILearningStatus, restoreFromDatabase as restoreAILearning, getParameterAdjustments } from './services/aiLearningBackend.js';
import { getOnChainSignals } from './services/onChainBackend.js';
import { getAssetProfile, getStrategyAssetMatch, getBestStrategyForAsset, getPositionSizeForLiquidity, getRiskAdjustedParams } from './services/assetIntelligenceBackend.js';
import * as CapitalTierManager from './services/capitalTierManager.js';
import * as SessionManager from './services/sessionManager.js';

// Batch 1: Trading Performance Services
import { isStrategyEnabledForRegime, filterStrategiesByRegime } from './services/regimeStrategyMap.js';
import { getMTFAlignmentScore, getMTFConfidencePoints } from './services/mtfConfluence.js';
import { getFundingRateSignal, getFundingConfidenceAdjustment } from './services/fundingRateStrategy.js';

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

// Phase 7: Multi-Exchange Data + ML Services
import {
    insertExchangeSnapshot, getExchangeSnapshots, getLatestExchangeSnapshot,
    insertDerivativesData, getDerivativesHistory, getLatestDerivatives,
    insertDeFiSnapshot, getLatestDeFiSnapshot, getDeFiHistory,
    insertNewsItem, insertNewsItemsBatch, getNewsItems,
    insertMLFeatures, getUnlabeledFeatures, getLabeledFeatures, labelMLFeatures,
    insertMLModel, getLatestMLModel, getMLModelHistory,
    insertMLPrediction, resolveMLPrediction, getMLPredictions, getMLAccuracyStats,
    cleanupOldData
} from './services/database.js';

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
    try { cryptoComWsService.closeWebSocket(); } catch (e) { /* ok */ }
    try {
        const krakenWs = getWebSocketService('kraken');
        krakenWs.closeWebSocket();
    } catch (e) { /* ok */ }

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
        TREND_BULLISH_ENTRY: 50,       // Beast Mode: was 45
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
    MIN_CANDLES_REQUIRED: 10,          // Beast Mode: 10 (was 15)
};

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
        // Allow VPS direct access
        if (origin.includes('31.97.7.138')) return callback(null, true);
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
    }));
    setSetting('session_bot', JSON.stringify({
      isActive: botState.isActive,
      settings: botState.settings,
      tradingMode: botState.tradingMode,
      sessionStartTime: botState.sessionStartTime,
    }));
    setSetting('session_circuit_breaker', JSON.stringify(cbExportState()));
    setSetting('session_adaptive_weights', JSON.stringify(awExportState()));
    setSetting('session_beast_mode', JSON.stringify(beastExportState()));
    setSetting('session_profit_methods', JSON.stringify(pmExportState()));
    setSetting('session_timestamp', JSON.stringify(Date.now()));
  } catch (e) {
    console.log(`[SESSION] Save failed: ${e.message}`);
  }
}

// ============================================
// Trading Bot Loop (Optimized for Large Universes)
// ============================================
async function tradingBotLoop() {
    if (!botState.isActive) return;

    try {
        const { sessionProfitGoal, riskAmount, profitGoals } = botState.settings;

        // --- CAPITAL TIER MANAGEMENT ---
        let holdingsValue = Object.values(portfolio.positions).reduce((sum, pos) =>
            sum + (pos.quantity * (pos.currentPrice || pos.openPrice)), 0
        );
        let totalValue = portfolio.cash + holdingsValue;
        if (totalValue > peakValue) peakValue = totalValue;
        const tier = CapitalTierManager.getTier(totalValue);

        // Auto-expand maxConcurrentTrades to at least cover existing positions + 2 new slots
        // But also cap it by the tier's limit
        const existingCount = Object.keys(portfolio.positions).length;
        const maxConcurrentTrades = Math.min(
            tier.maxConcurrentTrades,
            Math.max(botState.settings.maxConcurrentTrades || 5, existingCount + 2)
        );

        // Halt trading if drawdown exceeds tier limits
        const drawdown = peakValue > 0 ? ((peakValue - totalValue) / peakValue) * 100 : 0;
        if (drawdown > tier.maxDrawdownLimit) {
            if (Math.random() < 0.05) addLog(`[CAPITAL TIER] Trading halted: Drawdown ${drawdown.toFixed(1)}% exceeds ${tier.name} limit (${tier.maxDrawdownLimit}%)`, 'WARN');
            // Allow exits but skip all entries
        }

        // --- DYNAMIC MARKET SCANNING ---
        const positionTickers = Object.keys(portfolio.positions);
        
        // Rotate through available tickers
        const BATCH_SIZE = 20; 
        const totalTickers = availableTickers.length;
        const cycleIndex = Math.floor(Date.now() / 1000) % Math.ceil(totalTickers / BATCH_SIZE);
        const scanBatch = availableTickers.slice(cycleIndex * BATCH_SIZE, (cycleIndex + 1) * BATCH_SIZE);
        
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

        // --- MULTI-TIMEFRAME DATA (5m, 15m alongside 1m) ---
        let mtfDataMap = new Map();
        try {
            const mtfTickers = [...new Set([...positionTickers, ...scanBatch.slice(0, 6)])];
            const [data5m, data15m] = await Promise.all([
                getMultipleMarketData(mtfTickers, '5m'),
                getMultipleMarketData(mtfTickers, '15m'),
            ]);
            for (const ticker of mtfTickers) {
                const candles1m = marketDataMap.get(ticker);
                const entry5m = data5m.find(d => d.ticker === ticker);
                const entry15m = data15m.find(d => d.ticker === ticker);
                if (candles1m) {
                    mtfDataMap.set(ticker, {
                        '1m': candles1m,
                        '5m': entry5m?.candles || [],
                        '15m': entry15m?.candles || [],
                    });
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

            if (!exitReason) {
                const tcValue = calculateTCSeries(candles).pop() ?? 50;
                const momentumValue = calculateMomentumSeries(candles).pop() ?? 50;

                switch (position.entryStrategy) {
                    case 'TREND':
                        if (tcValue > CONFIG.THRESHOLDS.TREND_BEARISH_EXIT) exitReason = 'Trend Signal: Bearish exit';
                        break;
                    case 'MOMENTUM':
                        if (momentumValue < CONFIG.THRESHOLDS.MOMENTUM_BEARISH_EXIT) exitReason = 'Momentum Signal: Bearish Momentum';
                        break;
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
                const firstCandles = marketDataMap.values().next().value;
                if (firstCandles) {
                    const regime = getMarketRegime(firstCandles);
                    return regime?.regime || 'UNKNOWN';
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

        // Derive entry thresholds from timeframe profile (or use defaults)
        const minOppScore = activeProfile?.entry?.minOpportunityScore ?? 8;
        const profileStrategies = activeProfile?.activeStrategies || null;
        const profilePosSize = activeProfile?.positionSizePercent ?? null;

        const openSlots = maxConcurrentTrades - Object.keys(portfolio.positions).length;
        if (openSlots > 0 && portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && drawdown <= tier.maxDrawdownLimit) {

            // Calculate Opportunity Scores for current batch
            const candidates = [];
            for (const ticker of scanBatch) {
                if (portfolio.positions[ticker]) continue;
                const candles = marketDataMap.get(ticker);
                if (!candles) continue;
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

                // Determine entry strategy — use timeframe profile's allowed strategies when available
                let entryStrategy = null;
                if (profileStrategies) {
                    // Try each profile-allowed strategy against its indicator signal
                    if (profileStrategies.includes('TREND') && tcValue < CONFIG.THRESHOLDS.TREND_BULLISH_ENTRY) {
                        entryStrategy = 'TREND';
                    } else if (profileStrategies.includes('MOMENTUM')) {
                        const momValue = calculateMomentumSeries(candles).pop() ?? 50;
                        if (momValue > 60) entryStrategy = 'MOMENTUM';
                    } else if (profileStrategies.includes('BREAKOUT')) {
                        const bkout = calculateBreakoutDetectorSeries(candles).pop() ?? 50;
                        if (bkout > 65) entryStrategy = 'BREAKOUT';
                    } else if (profileStrategies.includes('ADAPTIVE')) {
                        const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                        if (adpValue < 40) entryStrategy = 'ADAPTIVE';
                    }
                } else {
                    // Fallback: original TREND-only entry
                    if (tcValue < CONFIG.THRESHOLDS.TREND_BULLISH_ENTRY) entryStrategy = 'TREND';
                }

                // Feature 6: Regime-aware strategy filtering
                if (entryStrategy && !isStrategyEnabledForRegime(entryStrategy, currentRegime)) {
                    logThought({
                        type: 'SKIP', ticker, action: 'REGIME_FILTER',
                        confidence: score.compositeScore,
                        reason: `${entryStrategy} not allowed in ${currentRegime} regime`,
                        regime: currentRegime,
                        indicators: { tcValue, compositeScore: score.compositeScore },
                    });
                    entryStrategy = null;
                }

                // Feature 3: MTF confluence confidence adjustment
                let mtfConfidenceAdj = 0;
                const mtfScore = mtfScores.get(ticker);
                if (mtfScore) {
                    mtfConfidenceAdj = getMTFConfidencePoints(mtfScore.alignmentScore);
                }

                // Feature 8: Funding rate adjustment
                let fundingAdj = 0;
                try {
                    const fundingSignal = getFundingRateSignal(ticker);
                    const fundingResult = getFundingConfidenceAdjustment(fundingSignal, 'LONG');
                    fundingAdj = fundingResult.adjustment;
                } catch (e) {}

                // Sentiment confidence adjustment (-10 to +10 range)
                let sentimentAdj = 0;
                const sentimentScore = sentimentCache.get(ticker);
                if (sentimentScore != null) {
                    sentimentAdj = Math.round(sentimentScore * 10); // -1..1 → -10..+10
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
                    investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);

                    // Apply sentiment penalty/boost: reduce size 20% for bearish, increase 10% for bullish
                    if (sentimentAdj < -3) {
                        investmentAmount *= 0.80;
                    } else if (sentimentAdj > 3) {
                        investmentAmount *= 1.10;
                    }

                    if (investmentAmount > CONFIG.MIN_TRADE_SIZE) {
                        logThought({
                            type: 'ENTRY_EVAL', ticker, action: 'ENTERING',
                            confidence: score.compositeScore + mtfConfidenceAdj + fundingAdj + sentimentAdj,
                            reason: `${entryStrategy} entry [${marketSpeed}/${activeProfile?.timeframeId || 'default'}]: score=${score.compositeScore}, kelly=${(kellyFraction*100).toFixed(1)}%, mtf=${mtfConfidenceAdj}, funding=${fundingAdj}, sentiment=${sentimentAdj}`,
                            regime: currentRegime,
                            market_speed: marketSpeed,
                            indicators: { tcValue, compositeScore: score.compositeScore, kellyFraction, mtfConfidenceAdj, fundingAdj, sentimentAdj, investmentAmount, timeframeId: activeProfile?.timeframeId },
                        });
                        await handleBuy(ticker, currentPrice, entryStrategy, `Batch scan [${marketSpeed}/${activeProfile?.timeframeId || 'default'}] (score=${score.compositeScore}, sentiment=${sentimentAdj})`, investmentAmount);
                    }
                }
            }
        }

        // --- PROFIT METHOD ENTRIES ---
        if (portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && drawdown <= tier.maxDrawdownLimit) {
            const pmEntries = runProfitMethods(marketDataMap, portfolio, availableTickers, CONFIG.MIN_TRADE_SIZE);
            for (const entry of pmEntries) {
                if (portfolio.cash < CONFIG.MIN_TRADE_SIZE) break;
                if (!CapitalTierManager.isStrategyAllowed(entry.strategy, totalValue)) continue;

                let amount = CapitalTierManager.getRecommendedPositionSize(totalValue, Math.min(entry.amount, portfolio.cash * 0.9));
                if (amount >= CONFIG.MIN_TRADE_SIZE) {
                    await handleBuy(entry.ticker, entry.price, entry.strategy, entry.reason, amount);
                }
            }
        }
        // Record equity snapshot every iteration
        recordEquitySnapshot(portfolio);

        // Update position current prices for accurate holdings value
        for (const [ticker, pos] of Object.entries(portfolio.positions)) {
            const latestPrice = getLatestPrice(ticker);
            if (latestPrice > 0) {
                pos.currentPrice = latestPrice;
                if (latestPrice > (pos.highestPrice || 0)) pos.highestPrice = latestPrice;
                if (latestPrice < (pos.lowestPrice || Infinity)) pos.lowestPrice = latestPrice;
            }
        }

        saveSessionState();
    } catch (error) {
        console.error(`Bot loop error: ${error.message}`);
    }
}

const handleBuy = async (ticker, price, strategy, reason, notional) => {
    addLog(`Triggering BUY for ${ticker} @ ${price}. Reason: [${strategy}] ${reason}`, 'BUY');

    try {
        let quantity, avgPrice;
        const fees = getActiveFees();
        const buyFee = notional * fees.perSide;

        if (botState.tradingMode === 'SIMULATION') {
            // Simulation: use current price + fee, no exchange call
            avgPrice = price;
            quantity = notional / price;
        } else {
            // Real: smart order routing (limit vs market based on spread)
            const adapter = getExchangeAdapter();
            let usedLimit = false;

            // Try limit order if adapter supports it and spread is wide enough
            if (adapter.getMakerFeePercent && adapter.placeLimitBuyOrder) {
                try {
                    // Check spread: price is approx mid, if we can save fees with limit order
                    const spreadThreshold = 0.001; // 0.1%
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

                    // If not filled, cancel and fall through to market
                    if (!filled) {
                        await adapter.cancelOrder(limitOrder.orderId, botState.sessionId);
                        addLog(`[SMART-ORDER] Limit order not filled for ${ticker}, falling back to market`, 'INFO');
                    }
                } catch (e) {
                    // Limit order failed, fall through to market
                    addLog(`[SMART-ORDER] Limit failed: ${e.message}, using market`, 'WARN');
                }
            }

            if (!usedLimit) {
                const orderResult = await adapter.placeBuyOrder(ticker, notional, botState.sessionId);
                quantity = orderResult.quantity || (notional / price);
                avgPrice = orderResult.avgPrice || price;
            }
        }

        portfolio.positions[ticker] = {
            quantity: parseFloat(quantity),
            openPrice: parseFloat(avgPrice),
            ticker,
            entryStrategy: strategy,
            entryTime: Date.now(),
            highestPrice: parseFloat(avgPrice),
            lowestPrice: parseFloat(avgPrice)
        };
        portfolio.cash -= (notional + buyFee);

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
            // Real: route through exchange adapter
            const adapter = getExchangeAdapter();
            const orderResult = await adapter.placeSellOrder(position.ticker, position.quantity, botState.sessionId, instrumentSpecs);
            avgPrice = parseFloat(orderResult.avgPrice) || price;
        }

        const sellFee = avgPrice * position.quantity * fees.perSide;
        const buyFee = position.openPrice * position.quantity * fees.perSide;
        const pnl = (avgPrice - position.openPrice) * position.quantity - sellFee - buyFee;

        portfolio.cash += (position.quantity * avgPrice) - sellFee;
        delete portfolio.positions[position.ticker];

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
        saveSessionState();
    } catch (error) {
        addLog(`SELL order failed: ${error.message}`, 'ERROR');
    }
};

// ============================================
// API Endpoints
// ============================================
app.get('/api/market-data', async (req, res, next) => {
    try {
        const { instrument_name, timeframe, exchange } = req.query;
        if (!instrument_name || !timeframe) {
            return res.status(400).json({ message: 'instrument_name and timeframe are required' });
        }

        // Use specified exchange, or fall back to active exchange
        const activeExchange = exchange || getActiveExchangeId();
        if (activeExchange !== 'crypto.com') {
            const adapter = getExchangeAdapter(activeExchange);
            const candles = await adapter.getCandles(instrument_name, timeframe, 200);
            return res.status(200).json({ data: candles });
        }

        // Crypto.com: use existing getMarketData with SQLite caching
        const data = await getMarketData(instrument_name, timeframe, 200);
        res.status(200).json({ data });
    } catch (error) {
        next(error);
    }
});

app.get('/api/instruments', async (req, res, next) => {
    try {
        const { exchange } = req.query;

        if (exchange && exchange !== 'crypto.com') {
            const adapter = getExchangeAdapter(exchange);
            const result = await adapter.getInstruments();
            return res.status(200).json(result);
        }

        const result = await makePublicRequest('public/get-instruments');
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
});

// ── Exchange Adapter Routes ──
app.get('/api/exchange/current', (req, res) => {
    const adapter = getExchangeAdapter();
    res.json({
        exchange: adapter.getName(),
        feePercent: adapter.getFeePercent() * 100,
        roundTripFeePercent: adapter.getFeePercent() * 200,
    });
});

app.post('/api/exchange/switch', (req, res) => {
    try {
        const { exchange } = req.body;
        if (!exchange) return res.status(400).json({ message: 'exchange is required' });
        const prevExchange = getActiveExchangeId();
        const newId = setActiveExchange(exchange);
        const adapter = getExchangeAdapter();

        // Update beast mode fee awareness
        const fees = getActiveFees();
        beastSetRoundTripFee(fees.roundTrip * 100);

        // Reconnect WebSocket to new exchange if changed
        if (prevExchange !== newId) {
            // Use Canadian-allowed tickers as fallback when availableTickers is empty (e.g. Kraken)
            const FALLBACK_TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
            const tickers = availableTickers.length > 0 ? availableTickers : FALLBACK_TICKERS;
            reconnectWebSocketForExchange(tickers);
            addLog(`[Exchange] Switched from ${prevExchange} to ${newId}, WebSocket reconnected (${tickers.length} tickers)`, 'INFO');
        }

        res.json({
            exchange: newId,
            name: adapter.getName(),
            feePercent: adapter.getFeePercent() * 100,
            roundTripFeePercent: adapter.getFeePercent() * 200,
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/exchange/list', (req, res) => {
    res.json(listExchanges());
});

app.post('/api/test-connection', async (req, res, next) => {
    try {
        if (publicIp === 'not detected' || publicIp === 'error fetching IP') {
            await logPublicIp();
        }
        res.status(200).json({ message: 'Backend connection successful!', ip: publicIp });
    } catch (error) {
        next(error);
    }
});

app.post('/api/login', async (req, res, next) => {
    try {
        const { apiKey, secretKey } = req.body;
        if (!apiKey || !secretKey) return res.status(400).json({ message: 'API Key and Secret Key are required.' });

        const sessionId = SessionManager.createSession(apiKey, secretKey);
        let balanceResult = await makeSignedRequest('private/user-balance', {}, sessionId);
        
        const dataArray = balanceResult?.data || [];
        const topLevel = Array.isArray(dataArray) && dataArray.length > 0 ? dataArray[0] : dataArray;

        let cashBalance = 0;
        const holdings = {};
        const positionBalances = topLevel?.position_balances || [];
        
        for (const pos of positionBalances) {
            const currency = pos.instrument_name;
            const qty = parseFloat(pos.quantity || '0');
            if (qty <= 0) continue;
            if (currency === 'USD' || currency === 'USDC') cashBalance += qty;
            else holdings[currency] = { quantity: qty, usdValue: 0 };
        }

        const totalBalance = cashBalance; // Simplified for this overwrite
        portfolio = { cash: cashBalance, initialBudget: totalBalance, positions: {}, holdings };
        botState.sessionId = sessionId;
        beastSetSessionBalance(totalBalance);
        saveSessionState();

        res.status(200).json({ balance: totalBalance, holdings, sessionId, portfolio });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/analyze', async (req, res, next) => {
    try {
        const { prompt, ticker, signals, sentiment, marketData } = req.body;
        
        let analysis;
        if (ticker && signals && marketData) {
            // Specialized analysis
            analysis = await brain.analyzeTradeOpportunity(ticker, signals, sentiment || {}, marketData);
        } else if (prompt) {
            // Generic prompt analysis - handled locally
            analysis = `Local AI: Received prompt (${prompt.length} chars). Use specific ticker/signals/marketData for trade analysis.`;
        } else {
            return res.status(400).json({ message: 'Prompt or ticker/signals/marketData required' });
        }
        
        res.status(200).json({ analysis: typeof analysis === 'string' ? analysis : JSON.stringify(analysis) });
    } catch (error) {
        console.error('[AI Analyze Error]:', error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.status(200).json({ portfolio, logs, isBotActive: botState.isActive });
});

app.get('/api/system/status', (req, res) => {
    try {
        res.status(200).json({
            websocket: getWebSocketStatusProxy(),
            circuitBreaker: getCircuitBreakerStatus(),
            adaptiveWeights: getAdaptiveWeightsStatus(),
            profitMethods: getProfitMethodsStatus(),
            preTradeAI: getPreTradeAIStatus(),
            beastMode: getBeastModeStatus(),
            aiLearning: getAILearningStatus(),
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/ws-auth', (req, res) => {
    try {
        const apiKey = process.env.SESSION_API_KEY;
        const secretKey = process.env.SESSION_SECRET_KEY;
        if (!apiKey || !secretKey) {
            return res.status(404).json({ message: 'WebSocket auth keys not configured' });
        }
        const id = Date.now();
        const nonce = Date.now();
        const method = 'public/auth';
        const sigPayload = method + id + apiKey + nonce;
        const sig = crypto.createHmac('sha256', secretKey).update(sigPayload).digest('hex');
        res.status(200).json({ id, method, api_key: apiKey, sig, nonce });
    } catch (error) {
        res.status(500).json({ message: 'Failed to generate WebSocket auth', error: error.message });
    }
});

// New AI/Brain Endpoints
app.get('/api/brain/thoughts', (req, res) => {
    res.status(200).json(brainThoughts);
});

app.get('/api/feeds/live', async (req, res) => {
    try {
        const feeds = await dataIngestion.fetchAllFeeds();
        res.status(200).json(feeds);
    } catch (e) {
        res.status(500).json({ message: 'Failed to fetch feeds' });
    }
});

// ============================================
// Questrade API Routes
// ============================================

app.post('/api/questrade/auth', async (req, res) => {
    try {
        const { refreshToken, isPractice } = req.body;
        if (refreshToken) {
            questrade.isPractice = isPractice ?? true;
        }
        await questrade.authenticate(refreshToken);
        // Also reinitialize paper trader when re-authing
        res.status(200).json({ success: true, status: questrade.getStatus() });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/status', (req, res) => {
    res.status(200).json({
        questrade: questrade.getStatus(),
        bot: {
            isActive: questradeBotState.isActive,
            isPaper: questradeBotState.isPaper,
            watchlist: questradeBotState.watchlist,
        },
        paperTrading: {
            cash: paperTrader.portfolio.cash,
            positions: Object.keys(paperTrader.portfolio.positions).length,
            tradeCount: paperTrader.portfolio.history.length,
        }
    });
});

app.get('/api/questrade/accounts', async (req, res) => {
    try {
        const accounts = await questrade.getAccounts();
        res.status(200).json({ accounts });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/balance/:accountId', async (req, res) => {
    try {
        const data = await questrade.getBalance(req.params.accountId);
        res.status(200).json(data);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/positions/:accountId', async (req, res) => {
    try {
        const positions = await questrade.getPositions(req.params.accountId);
        res.status(200).json({ positions });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/candles', async (req, res) => {
    try {
        const { symbol, interval, start, end } = req.query;
        if (!symbol) return res.status(400).json({ message: 'symbol is required' });
        const candles = await questrade.getCandlesByTicker(symbol, interval || '1m', start, end);
        res.status(200).json({ candles });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/search', async (req, res) => {
    try {
        const { prefix } = req.query;
        if (!prefix) return res.status(400).json({ message: 'prefix is required' });
        const symbols = await questrade.searchSymbol(prefix);
        res.status(200).json({ symbols });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/symbols', async (req, res) => {
    try {
        const { exchange } = req.query;
        if (!exchange) return res.status(400).json({ message: 'exchange is required' });
        const symbols = await questrade.getSymbolsByExchange(exchange);
        res.status(200).json({ symbols });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.post('/api/questrade/order', async (req, res) => {
    try {
        const { accountId, ticker, side, quantity, orderType, limitPrice } = req.body;
        if (!ticker || !side || !quantity) {
            return res.status(400).json({ message: 'ticker, side, and quantity are required' });
        }

        if (questradeBotState.isPaper) {
            // Paper trade
            const trade = await paperTrader.createOrder(ticker, side, quantity, orderType || 'MARKET', limitPrice);
            res.status(200).json({ success: true, trade, paper: true });
        } else {
            // Live trade
            if (!accountId) return res.status(400).json({ message: 'accountId required for live trading' });
            const symbolId = await questrade.getSymbolId(ticker);
            const order = {
                symbolId,
                quantity,
                icebergQuantity: quantity,
                side: side === 'BUY' ? 'Buy' : 'Sell',
                orderType: orderType === 'LIMIT' ? 'Limit' : 'Market',
                timeInForce: 'Day',
            };
            if (limitPrice) order.limitPrice = limitPrice;
            const result = await questrade.placeOrder(accountId, order);
            res.status(200).json({ success: true, result, paper: false });
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// Paper Trading endpoints
app.get('/api/questrade/paper/summary', async (req, res) => {
    try {
        const summary = await paperTrader.getAccountSummary();
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.get('/api/questrade/paper/history', (req, res) => {
    res.status(200).json({ trades: paperTrader.getHistory() });
});

app.post('/api/questrade/paper/reset', (req, res) => {
    const { balance } = req.body;
    paperTrader.reset(balance || 100000);
    res.status(200).json({ success: true, message: 'Paper trading reset' });
});

// Questrade Bot Control
app.post('/api/questrade/bot/start', async (req, res) => {
    try {
        const { watchlist, isPaper, accountId } = req.body;
        if (questradeBotState.isActive) {
            return res.status(400).json({ message: 'Questrade bot already running' });
        }

        // Ensure authenticated
        if (!questrade.isAuthenticated()) {
            await questrade.authenticate();
        }

        questradeBotState.isActive = true;
        questradeBotState.isPaper = isPaper !== false;
        questradeBotState.accountId = accountId || null;
        if (watchlist && Array.isArray(watchlist)) {
            questradeBotState.watchlist = watchlist;
        }

        // Start bot loop
        questradeBotState.interval = setInterval(() => questradeBotLoop(), questradeBotState.loopMs);
        addLog(`[QUESTRADE BOT] Started (${questradeBotState.isPaper ? 'Paper' : 'Live'}) - Watchlist: ${questradeBotState.watchlist.join(', ')}`, 'INFO');
        res.status(200).json({ success: true, state: questradeBotState });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.post('/api/questrade/bot/stop', (req, res) => {
    if (questradeBotState.interval) {
        clearInterval(questradeBotState.interval);
        questradeBotState.interval = null;
    }
    questradeBotState.isActive = false;
    addLog('[QUESTRADE BOT] Stopped', 'INFO');
    res.status(200).json({ success: true });
});

// ============================================
// Questrade Bot Loop
// ============================================
function isMarketOpen() {
    const now = new Date();
    // Convert to ET (UTC-5 or UTC-4 during DST)
    const etOffset = -5; // EST (simplification - doesn't handle DST)
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const etHour = (utcHour + etOffset + 24) % 24;
    const etMinutes = etHour * 60 + utcMin;
    const dayOfWeek = now.getUTCDay();

    // Weekend check
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    // Market hours: 9:30 AM - 4:00 PM ET
    const marketOpen = 9 * 60 + 30; // 570
    const marketClose = 16 * 60; // 960
    return etMinutes >= marketOpen && etMinutes < marketClose;
}

async function questradeBotLoop() {
    if (!questradeBotState.isActive) return;

    try {
        if (!isMarketOpen()) {
            // Log occasionally during off-hours
            if (Math.random() < 0.01) {
                addLog('[QUESTRADE BOT] Market closed - waiting', 'INFO');
            }
            return;
        }

        const trader = questradeBotState.isPaper ? paperTrader : questrade;
        const watchlist = questradeBotState.watchlist;

        for (const ticker of watchlist) {
            try {
                // 1. Fetch candles
                const candles = await questrade.getCandlesByTicker(ticker, '5m');
                if (!candles || candles.length < 50) continue;

                // 2. Run strategy engine
                const signals = strategyEngine.evaluate(ticker, candles);
                if (signals.length === 0) continue;

                // 3. Get best signal
                const bestSignal = signals.reduce((best, s) =>
                    s.confidence > best.confidence ? s : best, signals[0]
                );

                // 4. AI Brain analysis (skip if confidence is very high to save API calls)
                let aiDecision = { decision: 'YES', confidence: bestSignal.confidence * 100 };
                if (bestSignal.confidence < 0.8) {
                    try {
                        const lastCandle = candles[candles.length - 1];
                        aiDecision = await brain.analyzeTradeOpportunity(
                            ticker,
                            signals,
                            {},
                            { price: lastCandle.c, volume: lastCandle.v }
                        );
                    } catch (e) {
                        // AI failure shouldn't block trades
                    }
                }

                if (aiDecision.decision === 'NO') continue;

                // 5. Execute trade
                const lastPrice = candles[candles.length - 1].c;
                const positionSize = questradeBotState.isPaper
                    ? Math.floor((paperTrader.portfolio.cash * 0.1) / lastPrice)
                    : 1; // Conservative for live

                if (positionSize <= 0) continue;

                if (bestSignal.action === 'BUY') {
                    if (questradeBotState.isPaper) {
                        await paperTrader.createOrder(ticker, 'BUY', positionSize);
                    } else if (questradeBotState.accountId) {
                        const symbolId = await questrade.getSymbolId(ticker);
                        await questrade.placeOrder(questradeBotState.accountId, {
                            symbolId,
                            quantity: positionSize,
                            side: 'Buy',
                            orderType: 'Market',
                            timeInForce: 'Day',
                        });
                    }
                    addLog(`[QUESTRADE BOT] BUY ${positionSize} ${ticker} @ ${lastPrice} (${bestSignal.strategy}: ${bestSignal.reason})`, 'BUY');
                } else if (bestSignal.action === 'SELL') {
                    // Check if we have a position to sell
                    const hasPosition = questradeBotState.isPaper
                        ? !!paperTrader.portfolio.positions[ticker]
                        : false; // For live, would check Questrade positions

                    if (hasPosition) {
                        const pos = paperTrader.portfolio.positions[ticker];
                        if (questradeBotState.isPaper) {
                            await paperTrader.createOrder(ticker, 'SELL', pos.quantity);
                        }
                        addLog(`[QUESTRADE BOT] SELL ${pos.quantity} ${ticker} @ ${lastPrice} (${bestSignal.strategy}: ${bestSignal.reason})`, 'SELL');
                    }
                }

                // Review trade with brain
                brain.reviewTrade({
                    ticker,
                    signal: bestSignal,
                    price: lastPrice,
                    timestamp: Date.now(),
                    paper: questradeBotState.isPaper,
                });

            } catch (tickerError) {
                if (Math.random() < 0.1) {
                    addLog(`[QUESTRADE BOT] Error on ${ticker}: ${tickerError.message}`, 'ERROR');
                }
            }
        }
    } catch (error) {
        addLog(`[QUESTRADE BOT] Loop error: ${error.message}`, 'ERROR');
    }
}

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
                instruments = await adapter.getInstruments();
            } catch (e) {
                console.warn('[Tickers] Adapter getInstruments failed, falling back to Crypto.com');
            }
        }

        // Fallback to Crypto.com API
        if (instruments.length === 0) {
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
// Multi-Exchange Data & ML Routes
// ============================================
app.get('/api/exchange-data/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        if (multiExchangeService) {
            const snapshot = multiExchangeService.getExchangeSnapshot(ticker);
            if (snapshot) return res.json(snapshot);
        }
        // Fallback: query DB directly
        const dbData = getExchangeSnapshots(ticker, 1);
        res.json({ ticker, snapshots: dbData.slice(0, 10), source: 'database' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/derivatives/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        if (multiExchangeService) {
            const data = multiExchangeService.getDerivativesSnapshot(ticker);
            if (data) return res.json(data);
        }
        const dbData = getLatestDerivatives(ticker);
        res.json(dbData || { ticker, error: 'No derivatives data yet' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/defi/overview', async (req, res) => {
    try {
        if (multiExchangeService) {
            const data = multiExchangeService.getDeFiSnapshot();
            if (data) return res.json(data);
        }
        const dbData = getLatestDeFiSnapshot();
        res.json(dbData || { error: 'No DeFi data yet' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sentiment/news/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const hours = parseInt(req.query.hours) || 24;
        if (multiExchangeService) {
            const data = multiExchangeService.getNewsSnapshot(ticker);
            if (data) return res.json(data);
        }
        const dbData = getNewsItems({ ticker, hours, limit: 50 });
        res.json({ ticker, items: dbData, source: 'database' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sentiment/social/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        if (multiExchangeService) {
            const data = multiExchangeService.getSocialSnapshot(ticker);
            if (data) return res.json(data);
        }
        res.json({ ticker, error: 'Social data not available yet' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sentiment/fear-greed', async (req, res) => {
    try {
        if (multiExchangeService) {
            const data = multiExchangeService.getFearGreed();
            if (data) return res.json(data);
        }
        res.json({ value: 50, classification: 'Neutral', error: 'Fear & Greed not available yet' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Phase 4: Enhanced Sentiment Endpoints
app.get('/api/sentiment/youtube/:ticker', async (req, res) => {
    try {
        if (!youtubeSentimentService) {
            return res.json({ sentiment: 0, videoCount: 0, enabled: false });
        }
        const data = await youtubeSentimentService.getYouTubeSentiment(req.params.ticker);
        res.json(data);
    } catch (e) {
        res.json({ sentiment: 0, videoCount: 0, error: e.message });
    }
});

app.get('/api/sentiment/reddit-enhanced/:ticker', async (req, res) => {
    try {
        if (!redditSentimentService) {
            return res.json({ combinedSentiment: 0, signal: 'NEUTRAL', enabled: false });
        }
        const data = await redditSentimentService.getEnhancedTickerSentiment(req.params.ticker);
        res.json(data);
    } catch (e) {
        res.json({ combinedSentiment: 0, signal: 'NEUTRAL', error: e.message });
    }
});

app.get('/api/sentiment/combined/:ticker', async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const results = {};

        // Fetch all sentiment sources in parallel
        const [redditData, youtubeData, fearGreed] = await Promise.allSettled([
            redditSentimentService ? redditSentimentService.getEnhancedTickerSentiment(ticker) : null,
            youtubeSentimentService ? youtubeSentimentService.getYouTubeSentiment(ticker) : null,
            multiExchangeService ? Promise.resolve(multiExchangeService.getFearGreed()) : null,
        ]);

        results.reddit = redditData.status === 'fulfilled' ? redditData.value : null;
        results.youtube = youtubeData.status === 'fulfilled' ? youtubeData.value : null;
        results.fearGreed = fearGreed.status === 'fulfilled' ? fearGreed.value : null;

        // Calculate weighted combined score (-1 to 1)
        let weightedSum = 0, totalWeight = 0;
        if (results.reddit?.combinedSentiment != null) {
            weightedSum += results.reddit.combinedSentiment * 0.35;
            totalWeight += 0.35;
        }
        if (results.youtube?.sentiment != null) {
            weightedSum += results.youtube.sentiment * 0.25;
            totalWeight += 0.25;
        }
        if (results.fearGreed?.value != null) {
            const fgNorm = (results.fearGreed.value - 50) / 50; // Normalize 0-100 to -1 to 1
            weightedSum += fgNorm * 0.40;
            totalWeight += 0.40;
        }

        const combinedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

        res.json({
            ticker,
            combinedScore: Math.round(combinedScore * 100) / 100,
            signal: combinedScore > 0.3 ? 'BULLISH' : combinedScore < -0.3 ? 'BEARISH' : 'NEUTRAL',
            sources: results,
            timestamp: Date.now(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Phase 3: Timeframe Strategy Endpoints
app.get('/api/timeframe/profiles', (req, res) => {
    try {
        if (!timeframeStrategyService) {
            return res.json({ error: 'Timeframe strategy service not loaded', profiles: [] });
        }
        const speed = req.query.speed || 'FAST';
        const profiles = timeframeStrategyService.getActiveProfilesForBot(speed);
        res.json({ profiles, allTimeframes: timeframeStrategyService.getAllTimeframes() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/timeframe/market-speed', async (req, res) => {
    try {
        if (!timeframeStrategyService) {
            return res.json({ speed: 'FAST', error: 'Service not loaded' });
        }
        const ticker = req.query.ticker || availableTickers[0] || 'BTCUSD';
        const candles = await getMarketData(ticker, '1m', 100);
        const speed = timeframeStrategyService.detectMarketSpeed(candles);
        res.json({ ticker, speed, candleCount: candles?.length || 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Phase 2: Kraken Minimums Endpoints
app.get('/api/kraken/minimums', (req, res) => {
    try {
        if (!krakenMinimums) {
            return res.json({ error: 'Kraken minimums not loaded' });
        }
        const budget = parseFloat(req.query.budget) || portfolio.cash;
        const recommended = krakenMinimums.getRecommendedAssetsForTier(budget);
        res.json({ budget, recommended });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/multi-exchange/status', (req, res) => {
    try {
        if (multiExchangeService) {
            res.json(multiExchangeService.getCollectionStatus());
        } else {
            res.json({ isRunning: false, error: 'Multi-exchange service not loaded' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ML Routes (Phase 2 - will be populated when ML engine is built)
app.get('/api/ml/status', (req, res) => {
    try {
        const latestModel = getLatestMLModel();
        const accuracy = getMLAccuracyStats();
        const modelHistory = getMLModelHistory(10);
        res.json({
            hasModel: !!latestModel,
            latestModel: latestModel ? {
                type: latestModel.model_type,
                accuracy: latestModel.accuracy,
                sampleCount: latestModel.sample_count,
                createdAt: latestModel.created_at
            } : null,
            predictionAccuracy: accuracy,
            modelHistory: modelHistory.map(m => ({ type: m.model_type, accuracy: m.accuracy, samples: m.sample_count, date: m.created_at }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ml/predictions/:ticker', (req, res) => {
    try {
        const { ticker } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const predictions = getMLPredictions({ ticker, limit });
        res.json({ ticker, predictions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ml/feature-importance', (req, res) => {
    try {
        const latestModel = getLatestMLModel();
        if (latestModel && latestModel.feature_importance_json) {
            res.json(JSON.parse(latestModel.feature_importance_json));
        } else {
            res.json({ error: 'No model trained yet' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Smart Money / Whale Detection Routes
app.get('/api/smart-money/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        if (smartMoneyService) {
            const signal = await smartMoneyService.getSmartMoneySignal(ticker);
            return res.json(signal);
        }
        res.json({ signal: 'NEUTRAL', confidence: 0, summary: 'Smart money service not available' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// NLP Sentiment Analysis Route
app.post('/api/nlp/analyze', (req, res) => {
    try {
        const { text, texts } = req.body;
        if (!localNLPService) return res.json({ error: 'NLP service not available' });
        if (texts && Array.isArray(texts)) {
            res.json(localNLPService.analyzeMultiple(texts));
        } else if (text) {
            res.json(localNLPService.analyzeSentiment(text));
        } else {
            res.status(400).json({ error: 'Provide text or texts field' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Adaptive Thresholds Routes
app.get('/api/adaptive-thresholds', (req, res) => {
    try {
        if (adaptiveThresholdsService) {
            res.json(adaptiveThresholdsService.getThresholdsWithDefaults());
        } else {
            res.json({ error: 'Adaptive thresholds not available' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/adaptive-thresholds/reset', (req, res) => {
    try {
        if (adaptiveThresholdsService) {
            adaptiveThresholdsService.resetToDefaults();
            res.json({ success: true, message: 'Thresholds reset to defaults' });
        } else {
            res.json({ error: 'Adaptive thresholds not available' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Self-Teaching Status Route
app.get('/api/self-teaching/status', (req, res) => {
    try {
        if (selfTeachingLoop) {
            res.json(selfTeachingLoop.getPerformanceReport());
        } else {
            res.json({ isRunning: false, error: 'Self-teaching not available' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Order Book Signal Route (Batch 2, Feature 2)
app.get('/api/orderbook-signal/:ticker', (req, res) => {
    try {
        const signal = getOrderBookSignal(req.params.ticker);
        res.json(signal);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Correlation Matrix Route (Batch 2, Feature 5)
app.get('/api/correlation-matrix', (req, res) => {
    try {
        const timeframe = req.query.timeframe || '5m';
        const lookback = parseInt(req.query.lookback) || 30;
        const tickers = availableTickers.slice(0, 10); // Top 10 tickers
        const result = getCorrelationMatrix(tickers, timeframe, lookback * 60);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trade Journal Routes (Batch 2, Feature 7)
app.get('/api/journal', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const entries = getJournalEntries(limit);
        res.json({ entries });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/journal/generate', (req, res) => {
    try {
        const entry = forceGenerateJournal();
        res.json(entry);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Telegram Routes (Batch 3, Feature 9)
app.post('/api/telegram/test', async (req, res) => {
    try {
        const result = await sendTestMessage();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/telegram/status', (req, res) => {
    res.json(telegramStatus());
});

// Config Routes (Batch 3, Feature 11)
app.get('/api/config', (req, res) => {
    try {
        const raw = getSetting('trading_config');
        res.json(raw ? JSON.parse(raw) : {});
    } catch (e) {
        res.json({});
    }
});

app.post('/api/config', (req, res) => {
    try {
        setSetting('trading_config', JSON.stringify(req.body));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Session & Health Routes (Batch 5)
app.get('/api/health', (req, res) => {
    const uptime = process.uptime();
    res.json({
        status: 'ok',
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        uptimeSeconds: uptime,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        botActive: botState.isActive,
        positions: Object.keys(portfolio.positions).length,
    });
});

app.get('/api/session/status', (req, res) => {
    res.json(getSessionStatus(portfolio, botState));
});

app.post('/api/session/pause', (req, res) => {
    if (botState.isActive) {
        botState.isActive = false;
        if (botInterval) { clearInterval(botInterval); botInterval = null; }
        addLog('[SESSION] Bot paused via API', 'WARN');
        saveFullState({
            portfolio, botState,
            cbExportState, awExportState, beastExportState, pmExportState,
            availableTickers,
        });
    }
    res.json({ success: true, botActive: false });
});

app.post('/api/session/resume', (req, res) => {
    if (!botState.isActive) {
        botState.isActive = true;
        botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);
        addLog('[SESSION] Bot resumed via API', 'INFO');
    }
    res.json({ success: true, botActive: true });
});

// ============================================
// Session Management (Phase 1: Headless VPS)
// ============================================

/**
 * POST /api/session/start
 * Start a new trading session (simulation or real).
 * Body: { mode: 'SIMULATION'|'REAL', budget: number, tickers?: string[] }
 */
app.post('/api/session/start', async (req, res) => {
    try {
        const { mode = 'SIMULATION', budget = 10000, tickers } = req.body;

        if (botState.isActive) {
            return res.status(400).json({ error: 'A session is already active. Stop it first.' });
        }

        if (mode === 'REAL' && !botState.sessionId) {
            return res.status(400).json({ error: 'Real trading requires API authentication. Call /api/login first.' });
        }

        // Generate a session ID
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Initialize portfolio
        if (mode === 'SIMULATION') {
            portfolio.cash = budget;
            portfolio.initialBudget = budget;
            portfolio.positions = {};
            portfolio.holdings = {};
        }
        // For REAL mode, portfolio was already set from /api/login

        // Set bot state
        botState.isActive = true;
        botState.tradingMode = mode;
        botState.sessionStartTime = Date.now();
        botState.settings = {
            ...botState.settings,
            riskAmount: botState.settings.riskAmount || 0.15,
            maxConcurrentTrades: botState.settings.maxConcurrentTrades || 5,
            sessionProfitGoal: botState.settings.sessionProfitGoal || (budget * 2),
        };

        // Set up session tracking
        setActiveSession(sessionId, mode);
        setThoughtSessionId(sessionId);

        // Update available tickers if custom set provided
        if (tickers && tickers.length > 0) {
            availableTickers = tickers;
        } else if (availableTickers.length === 0) {
            await updateAvailableTickers();
        }

        // Initialize beast mode
        beastSetSessionBalance(portfolio.cash);
        beastUpdateBalance(portfolio.cash);
        peakValue = portfolio.cash;

        // Reset sub-systems
        resetCircuitBreaker();

        // Start the bot loop
        if (botInterval) clearInterval(botInterval);
        botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);

        addLog(`[SESSION] Started ${mode} session: $${budget} budget, ${availableTickers.length} tickers`, 'INFO');
        saveSessionState();

        // Initial equity snapshot
        recordEquitySnapshot(portfolio);

        res.json({
            success: true,
            sessionId,
            mode,
            budget: portfolio.cash,
            tickers: availableTickers.slice(0, 20),
            botActive: true,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/session/stop
 * Stop current session, close all positions, return summary.
 */
app.post('/api/session/stop', async (req, res) => {
    try {
        const wasActive = botState.isActive;

        // Close all open positions at current price
        const closedPositions = [];
        for (const [ticker, position] of Object.entries(portfolio.positions)) {
            const currentPrice = getLatestPrice(ticker) || position.openPrice;
            try {
                await handleSell(position, currentPrice, 'SESSION_STOP: Closing all positions');
                closedPositions.push({ ticker, price: currentPrice, pnl: (currentPrice - position.openPrice) * position.quantity });
            } catch (e) {
                addLog(`Failed to close ${ticker}: ${e.message}`, 'ERROR');
            }
        }

        // Stop bot
        botState.isActive = false;
        if (botInterval) { clearInterval(botInterval); botInterval = null; }

        // Final equity snapshot
        recordEquitySnapshot(portfolio);

        // Get session summary
        const stats = getTradeStats();
        const equityCurve = getEquityCurve();
        const sessionStatus = getSessionStatus(portfolio, botState);

        const summary = {
            success: true,
            wasActive,
            closedPositions,
            finalCash: portfolio.cash,
            initialBudget: portfolio.initialBudget,
            totalPnl: portfolio.cash - portfolio.initialBudget,
            pnlPercent: portfolio.initialBudget > 0
                ? ((portfolio.cash - portfolio.initialBudget) / portfolio.initialBudget * 100).toFixed(2)
                : 0,
            tradeStats: stats,
            equityCurveLength: equityCurve.length,
            session: sessionStatus,
        };

        addLog(`[SESSION] Stopped. Final: $${portfolio.cash.toFixed(2)} (${summary.pnlPercent}%)`, 'WARN');

        // Save final state
        saveFullState({
            portfolio, botState,
            cbExportState, awExportState, beastExportState, pmExportState,
            availableTickers,
        });

        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/session/full-status
 * Everything the frontend needs to render the dashboard.
 */
app.get('/api/session/full-status', (req, res) => {
    try {
        const holdingsValue = Object.values(portfolio.positions || {}).reduce(
            (sum, pos) => sum + ((pos.quantity || 0) * (pos.currentPrice || pos.openPrice || 0)),
            0
        );
        const totalValue = (portfolio.cash || 0) + holdingsValue;

        res.json({
            // Session info
            sessionActive: botState.isActive,
            tradingMode: botState.tradingMode,
            sessionStartTime: botState.sessionStartTime,
            uptime: botState.sessionStartTime ? Date.now() - botState.sessionStartTime : 0,

            // Portfolio
            portfolio: {
                cash: portfolio.cash,
                initialBudget: portfolio.initialBudget,
                holdingsValue,
                totalValue,
                pnl: totalValue - (portfolio.initialBudget || 0),
                pnlPercent: portfolio.initialBudget > 0
                    ? ((totalValue - portfolio.initialBudget) / portfolio.initialBudget * 100)
                    : 0,
                positions: Object.entries(portfolio.positions || {}).map(([ticker, pos]) => ({
                    ticker,
                    quantity: pos.quantity,
                    openPrice: pos.openPrice,
                    currentPrice: pos.currentPrice || pos.openPrice,
                    entryStrategy: pos.entryStrategy,
                    entryTime: pos.entryTime,
                    unrealizedPnl: ((pos.currentPrice || pos.openPrice) - pos.openPrice) * pos.quantity,
                    unrealizedPnlPercent: ((pos.currentPrice || pos.openPrice) - pos.openPrice) / pos.openPrice * 100,
                    highestPrice: pos.highestPrice,
                    lowestPrice: pos.lowestPrice,
                })),
            },

            // Logs (last 50)
            logs: logs.slice(0, 50),

            // Bot state
            botState: {
                isActive: botState.isActive,
                tradingMode: botState.tradingMode,
                settings: botState.settings,
            },

            // Exchange info
            exchange: {
                id: getActiveExchangeId(),
                fees: getActiveFees(),
                wsConnected: wsConnected(),
                tickerCount: availableTickers.length,
            },

            // ML status
            ml: {
                currentFocus: getCurrentFocus(),
                thoughtStats: getThoughtStats(),
                recentThoughts: getThoughts(10),
            },

            // Sub-system status
            circuitBreaker: getCircuitBreakerStatus(),
            beastMode: getBeastModeStatus(),
            adaptiveWeights: getAdaptiveWeightsStatus(),

            // Session persistence
            session: getSessionStatus(portfolio, botState),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/session/trades
 * Full trade history for current session.
 */
app.get('/api/session/trades', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 500;
        const trades = getTradeHistory(null, limit);
        const stats = getTradeStats();
        res.json({ trades, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/session/equity-curve
 * Equity curve data for the current session.
 */
app.get('/api/session/equity-curve', (req, res) => {
    try {
        const curve = getEquityCurve();
        res.json({ curve });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/ml/thoughts
 * ML thought log (last N decisions).
 */
app.get('/api/ml/thoughts', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const thoughts = getThoughts(limit);
        const stats = getThoughtStats();
        const focus = getCurrentFocus();
        res.json({ thoughts, stats, focus });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/session/settings
 * Update bot settings for the active session.
 */
app.post('/api/session/settings', (req, res) => {
    try {
        const { riskAmount, maxConcurrentTrades, sessionProfitGoal, profitGoals } = req.body;
        if (riskAmount !== undefined) botState.settings.riskAmount = riskAmount;
        if (maxConcurrentTrades !== undefined) botState.settings.maxConcurrentTrades = maxConcurrentTrades;
        if (sessionProfitGoal !== undefined) botState.settings.sessionProfitGoal = sessionProfitGoal;
        if (profitGoals !== undefined) botState.settings.profitGoals = profitGoals;
        saveSessionState();
        res.json({ success: true, settings: botState.settings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Backtest Routes (Batch 4, Feature 1)
app.post('/api/backtest/run', (req, res) => {
    try {
        const result = runBacktest(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/backtest/available', (req, res) => {
    try {
        const data = getAvailableBacktestData();
        res.json({ data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backtest/sweep', (req, res) => {
    try {
        const result = runParameterSweep(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backtest/walk-forward', (req, res) => {
    try {
        const result = runWalkForward(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Funding Rate Signal Route (Batch 1, Feature 8)
app.get('/api/funding-rate/:ticker', (req, res) => {
    try {
        const signal = getFundingRateSignal(req.params.ticker);
        res.json(signal);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.use((err, req, res, next) => {
    res.status(500).json({ message: err.message });
});

const startServer = async () => {
    initializeDatabase();
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
        }
        if (restoredState.circuitBreaker) try { cbImportState(restoredState.circuitBreaker); } catch(e) {}
        if (restoredState.adaptiveWeights) try { awImportState(restoredState.adaptiveWeights); } catch(e) {}
        if (restoredState.beastMode) try { beastImportState(restoredState.beastMode); } catch(e) {}
        if (restoredState.profitMethods) try { pmImportState(restoredState.profitMethods); } catch(e) {}
        if (restoredState.botState?.sessionId) botState.sessionId = restoredState.botState.sessionId;
        if (restoredState.botState?.settings) botState.settings = { ...botState.settings, ...restoredState.botState.settings };
        console.log(`[Server] Session restored: $${portfolio.cash?.toFixed(2)} cash, ${Object.keys(portfolio.positions).length} positions`);
    }

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

    // Initialize ML prediction engine
    if (mlPredictionService) {
        try {
            await mlPredictionService.initializeML();
            console.log('[Server] ML prediction engine initialized');
        } catch (e) {
            console.warn('[Server] ML init failed (will retry on data):', e.message);
        }
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
        botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);
        console.log('[Server] Bot auto-resumed from previous session');
        addLog('[SESSION] Bot auto-resumed after restart', 'INFO');
    }

    // Start auto-save (every 60 seconds)
    startAutoSave({
        get portfolio() { return portfolio; },
        get botState() { return botState; },
        cbExportState, awExportState, beastExportState, pmExportState,
        get availableTickers() { return availableTickers; },
    }, 60000);

    server.listen(CONFIG.PORT, () => {
        console.log(`Server running on port ${CONFIG.PORT} (HTTP + WebSocket relay)`);
    });
};

function gracefulShutdown(signal) {
    console.log(`[Server] ${signal} received, saving state...`);
    try {
        stopAutoSave();
        saveFullState({
            portfolio, botState,
            cbExportState, awExportState, beastExportState, pmExportState,
            availableTickers,
        });
        console.log('[Server] State saved successfully');
    } catch (e) {
        console.error('[Server] State save failed:', e.message);
    }
    getActiveWsService().closeWebSocket();
    closeDatabase();
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();