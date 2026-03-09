// Load .env FIRST — before any module reads process.env (exchange adapter needs TRADING_EXCHANGE)
import 'dotenv/config';

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
    getSystemLogs,
    getDb
} from './services/database.js';
import persistenceRoutes from './routes/persistence.js';
import tradingviewRoutes, { injectSignal } from './routes/tradingview.js';
import mlTrainingRouter, { setContext as setMLTrainingContext } from './routes/mlTraining.js';
import { SignalScanner } from './services/signalScanner.js';
import { checkProfitMethodExits, runProfitMethods, getProfitMethodsStatus, exportState as pmExportState, importState as pmImportState, setSessionStart as pmSetSessionStart, cleanupProfitMethodState, persistPositionsToDB, restorePositionsFromDatabase } from './services/profitMethods.js';

// Phase 2-5 Services
// WebSocket services are accessed dynamically via getWebSocketService()
import * as cryptoComWsService from './services/websocketService.js';
import { analyzeMultiTimeframe, shouldEnterLong, getMultiTimeframeStatus } from './services/multiTimeframe.js';
import { recordTradeResult as cbRecordTrade, setDailyBalance, setCurrentBalance, setCurrentRegime as cbSetRegime, shouldPauseTrading, resetCircuitBreaker, fullResetCircuitBreaker, calculateKellyFraction, getKellyPositionSize, getStrategyKelly, getCircuitBreakerStatus, exportState as cbExportState, importState as cbImportState } from './services/circuitBreaker.js';
import { recordStrategyResult, getStrategyWeight, adjustPositionSize, isStrategyThrottled, getAdaptiveWeightsStatus, fullResetWeights, exportState as awExportState, importState as awImportState } from './services/adaptiveWeights.js';
import { calculateAllIndicators } from './services/advancedIndicators.js';
import { runBacktest, getAvailableBacktestData, runMultiBacktest, runWalkForward, runParameterSweep } from './services/backtestEngine.js';
import { getSocialSentimentScore, fetchFearGreedIndex, shouldTradeBasedOnSentiment, fetchCryptoNews, fetchCoinGeckoTrending, getTickerNewsSentiment, isTrendingCoin } from './services/socialSentiment.js';
import { getPreTradeDecision, getPreTradeAIStatus } from './services/preTradeAI.js';
import { getMarketRegime, detectRegimeTransition, getStrategyPool, isStrategyAllowedForRegime, adjustForVolatility, getCompoundMultiplier, getDynamicTargets, checkDynamicExit, recordTradeResult as beastRecordTrade, updateBalance as beastUpdateBalance, setSessionBalance as beastSetSessionBalance, fullResetBeastMode, getBeastModeStatus, exportState as beastExportState, importState as beastImportState, setRoundTripFee as beastSetRoundTripFee, setTargetOverrides, checkMaxDrawdown } from './services/beastMode.js';
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
import { initJournalTable, recordTradeForJournal, autoJournal, getJournalEntries, forceGenerateJournal, recordTradeDetail, getMinedBlockedHours, getTickerStrategyScore, getRegimeStrategyAdj } from './services/tradeJournal.js';

// Batch 3: Quality of Life Services
import { initTelegram, isEnabled as telegramEnabled, getStatus as telegramStatus, alertTradeExecution, alertCircuitBreaker, sendTestMessage, alertRegimeTransition, alertMLDegradation, alertConcentrationRisk } from './services/telegramService.js';

// Batch 5: Session Persistence
import {
  saveFullState, restoreFullState, getSessionStatus, recordSessionTrade, startAutoSave, stopAutoSave,
  setActiveSession, getActiveSessionId, getTradingMode,
  recordEquitySnapshot, recordSessionTradeDetail,
  getEquityCurve, getTradeHistory, getTradeStats,
} from './services/sessionPersistence.js';

// ML Thought Logger
import { logThought, getThoughts, getCurrentFocus, getThoughtStats, clearThoughts, setSessionId as setThoughtSessionId, restoreThoughts } from './services/mlThoughtLogger.js';

// Legacy services removed: Questrade, GeminiBrain, DataIngestion

// Exchange Adapter System
import { getExchangeAdapter, setActiveExchange, getActiveExchangeId, listExchanges, setSessionManager as setAdapterSessionManager, getWebSocketService } from './services/exchangeAdapters/index.js';

// Route Modules
import createMarketRouter from './routes/market.js';
import createExchangeRouter from './routes/exchange.js';
import createAuthRouter from './routes/auth.js';
// Questrade router removed
import createSessionsRouter from './routes/sessions.js';
import createIntelligenceRouter from './routes/intelligence.js';
import createSentimentRouter from './routes/sentiment.js';
import createSignalsRouter from './routes/signals.js';
import createNotificationsRouter from './routes/notifications.js';
import createConfigRouter from './routes/config.js';
import createBacktestRouter from './routes/backtest.js';
import createMultiExchangeRouter from './routes/multiExchange.js';
import createEngineRouter from './routes/engines.js';
import createNewsRouter from './routes/news.js';

// Discord Webhook
import { initDiscord, sendDiscordAlert, alertTradeExecution as discordAlertTrade, alertDrawdown as discordAlertDrawdown, alertCircuitBreaker as discordAlertCB, alertSessionSummary as discordAlertSummary } from './services/discordWebhook.js';

// API Key Health Monitor
import { initApiKeyHealthMonitor, getApiKeyHealth } from './services/apiKeyHealthMonitor.js';

// ─── Core V2 Modules (Overhaul) ─────────────────────────────
import tradingBus from './core/eventBus.ts';
import { portfolioManager } from './core/portfolioManager.ts';
import { shortSellingEngine } from './core/shortSellingEngine.ts';
import { stakingEngine } from './core/stakingEngine.ts';
import { arbitrageEngine } from './core/arbitrageEngine.ts';
import { incrementalIndicators } from './core/incrementalIndicators.ts';
import { healthMonitor } from './core/healthMonitor.ts';
import { dbBatcher } from './core/dbBatcher.ts';
import { logger } from './core/structuredLogger.ts';

// Tier 1: Derivatives Intelligence + Fear & Greed Gate
let derivativesIntel = null;
try {
    derivativesIntel = await import('./services/derivativesIntelligence.js');
    console.log('[Server] DerivativesIntelligence loaded');
} catch (e) {
    console.warn('[Server] DerivativesIntelligence not available:', e.message);
}

let fearGreedGate = null;
try {
    fearGreedGate = await import('./services/fearGreedGate.js');
    console.log('[Server] FearGreedGate loaded');
} catch (e) {
    console.warn('[Server] FearGreedGate not available:', e.message);
}

// Tier 2: Order Book Microstructure + CVaR Kelly
let orderBookMicro = null;
try {
    orderBookMicro = await import('./services/orderBookMicrostructure.js');
    console.log('[Server] OrderBookMicrostructure loaded');
} catch (e) {
    console.warn('[Server] OrderBookMicrostructure not available:', e.message);
}

let cvarKelly = null;
try {
    cvarKelly = await import('./services/cvarKelly.js');
    console.log('[Server] CVaR Kelly loaded');
} catch (e) {
    console.warn('[Server] CVaR Kelly not available:', e.message);
}

// Tier 3B: Liquidation Sweep + ML A/B Testing + Meta-RL
let liquidationSweep = null;
try {
    liquidationSweep = await import('./services/liquidationSweepDetector.js');
    console.log('[Server] LiquidationSweepDetector loaded');
} catch (e) {
    console.warn('[Server] LiquidationSweepDetector not available:', e.message);
}

let mlABTest = null;
try {
    mlABTest = await import('./services/mlModelABTest.js');
    console.log('[Server] ML Model A/B Test loaded');
} catch (e) {
    console.warn('[Server] ML A/B Test not available:', e.message);
}

let metaRL = null;
try {
    metaRL = await import('./services/metaRLAgent.js');
    console.log('[Server] MetaRL Agent loaded');
} catch (e) {
    console.warn('[Server] MetaRL Agent not available:', e.message);
}

// Tier 3A: Basis Trading Engine
let basisEngine = null;
try {
    basisEngine = await import('./services/basisTradingEngine.js');
    console.log('[Server] BasisTradingEngine loaded');
} catch (e) {
    console.warn('[Server] BasisTradingEngine not available:', e.message);
}

// Tier 2B: Whale Flow Tracker + Position Reconciler
let whaleFlowTracker = null;
try {
    whaleFlowTracker = await import('./services/whaleFlowTracker.js');
    console.log('[Server] WhaleFlowTracker loaded');
} catch (e) {
    console.warn('[Server] WhaleFlowTracker not available:', e.message);
}

let positionReconciler = null;
try {
    positionReconciler = await import('./services/positionReconciler.js');
    console.log('[Server] PositionReconciler loaded');
} catch (e) {
    console.warn('[Server] PositionReconciler not available:', e.message);
}

let telegramV2 = null;
try {
    telegramV2 = await import('./core/telegramV2.ts');
    console.log('[Server] TelegramV2 loaded');
} catch (e) {
    console.warn('[Server] TelegramV2 not available:', e.message);
}

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

// New Coin Detector (auto-detect new Kraken listings, rug-pull protection)
let initNewCoinDetector, detectNewListings, updateNewCoinSignals, isNewListing, getActiveNewListings, getNewCoinRules, markRugPullExit, getNewCoinStats;
try {
    const ncModule = await import('./services/newCoinDetector.js');
    initNewCoinDetector = ncModule.initialize;
    detectNewListings = ncModule.detectNewListings;
    updateNewCoinSignals = ncModule.updateNewCoinSignals;
    isNewListing = ncModule.isNewListing;
    getActiveNewListings = ncModule.getActiveNewListings;
    getNewCoinRules = ncModule.getNewCoinRules;
    markRugPullExit = ncModule.markRugPullExit;
    getNewCoinStats = ncModule.getStats;
    console.log('[Server] New coin detector loaded');
} catch (err) {
    console.warn('[Server] New coin detector not available:', err.message);
}

// dotenv/config loaded at top of file (must run before exchangeAdapters/index.js)

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

// ═══ PRICE VELOCITY TRACKER ═══
// Computes real-time price velocity ($/sec) and acceleration (change in velocity) from tick stream.
// Used for: faster exit when velocity turns negative, entry confirmation when acceleration is positive.
const priceVelocityTracker = (() => {
    const tickHistory = new Map(); // ticker → [{price, ts}, ...]
    const MAX_TICKS = 30; // Keep last 30 ticks per ticker
    const WINDOW_MS = 60000; // 60-second velocity window

    function recordTick(ticker, price) {
        if (!tickHistory.has(ticker)) tickHistory.set(ticker, []);
        const ticks = tickHistory.get(ticker);
        ticks.push({ price, ts: Date.now() });
        // Trim old ticks
        while (ticks.length > MAX_TICKS) ticks.shift();
    }

    function getMetrics(ticker) {
        const ticks = tickHistory.get(ticker);
        if (!ticks || ticks.length < 3) return { velocity: 0, acceleration: 0, tickCount: 0 };

        const now = Date.now();
        const recent = ticks.filter(t => now - t.ts < WINDOW_MS);
        if (recent.length < 3) return { velocity: 0, acceleration: 0, tickCount: recent.length };

        // Velocity: price change per second over the window
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dtSec = (last.ts - first.ts) / 1000;
        const velocity = dtSec > 0 ? (last.price - first.price) / dtSec : 0;

        // Acceleration: compare velocity of first half vs second half
        const mid = Math.floor(recent.length / 2);
        const firstHalf = recent.slice(0, mid);
        const secondHalf = recent.slice(mid);
        const v1 = firstHalf.length >= 2
            ? (firstHalf[firstHalf.length - 1].price - firstHalf[0].price) / ((firstHalf[firstHalf.length - 1].ts - firstHalf[0].ts) / 1000 || 1)
            : 0;
        const v2 = secondHalf.length >= 2
            ? (secondHalf[secondHalf.length - 1].price - secondHalf[0].price) / ((secondHalf[secondHalf.length - 1].ts - secondHalf[0].ts) / 1000 || 1)
            : 0;
        const acceleration = v2 - v1;

        // Normalize to percentage of price
        const pricePctVelocity = last.price > 0 ? (velocity / last.price) * 100 * 60 : 0; // %/min
        const pricePctAccel = last.price > 0 ? (acceleration / last.price) * 100 * 60 : 0;

        return {
            velocity: pricePctVelocity,  // %/min
            acceleration: pricePctAccel, // %/min²
            tickCount: recent.length,
            rawVelocity: velocity,       // $/sec
        };
    }

    return { recordTick, getMetrics };
})();

// ═══ MICRO VOLUME BURST DETECTOR (Phase 1B) ═══
// Tracks 5-second volume snapshots per ticker (rolling 12-element buffer = 60s window).
// Detects "micro bursts": current 5s volume > 5× rolling average.
// Much faster than the existing 30s volume burst detector — catches the first seconds of a surge.
const microBurstDetector = (() => {
    const buffers = new Map(); // ticker → { snapshots: [{vol, ts}], lastSnapshotTs, accumulatedVol }
    const SNAPSHOT_INTERVAL_MS = 5000; // 5-second buckets
    const BUFFER_SIZE = 12; // 60s rolling window
    const BURST_THRESHOLD = 5; // current 5s vol > 5× avg
    const BURST_COOLDOWN_MS = 30000; // Don't re-trigger for 30s after a burst

    function recordVolume(ticker, volume) {
        if (!buffers.has(ticker)) {
            buffers.set(ticker, { snapshots: [], lastSnapshotTs: Date.now(), accumulatedVol: 0, lastBurstTs: 0 });
        }
        const buf = buffers.get(ticker);
        buf.accumulatedVol += volume;

        const now = Date.now();
        if (now - buf.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS) {
            buf.snapshots.push({ vol: buf.accumulatedVol, ts: now });
            while (buf.snapshots.length > BUFFER_SIZE) buf.snapshots.shift();
            buf.accumulatedVol = 0;
            buf.lastSnapshotTs = now;
        }
    }

    function isMicroBurst(ticker) {
        const buf = buffers.get(ticker);
        if (!buf || buf.snapshots.length < 4) return { burst: false, ratio: 0 };

        // Cooldown check
        if (Date.now() - buf.lastBurstTs < BURST_COOLDOWN_MS) return { burst: false, ratio: 0, cooldown: true };

        const latest = buf.snapshots[buf.snapshots.length - 1];
        // Average of previous snapshots (excluding latest)
        const prevSnapshots = buf.snapshots.slice(0, -1);
        const avgVol = prevSnapshots.reduce((s, snap) => s + snap.vol, 0) / prevSnapshots.length;
        if (avgVol <= 0) return { burst: false, ratio: 0 };

        const ratio = latest.vol / avgVol;
        const burst = ratio >= BURST_THRESHOLD;
        if (burst) buf.lastBurstTs = Date.now();
        return { burst, ratio };
    }

    // Check if a burst was detected in the last N ms
    function recentBurst(ticker, withinMs = 30000) {
        const buf = buffers.get(ticker);
        if (!buf) return false;
        return buf.lastBurstTs > 0 && (Date.now() - buf.lastBurstTs) < withinMs;
    }

    return { recordVolume, isMicroBurst, recentBurst };
})();

// ═══ REGIME TRANSITION BOOST TRACKER (Phase 3C) ═══
// Tracks previous regime per ticker; when regime transitions from SIDEWAYS/DOWN → UP/STRONG_UP:
// apply +20 score boost that decays linearly over 5 minutes.
const regimeTransitionBoost = (() => {
    const boosts = new Map(); // ticker → { boostStart, boostAmount }
    const BOOST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
    const MAX_BOOST = 20;
    const previousRegimes = new Map(); // ticker → last known regime

    function checkTransition(ticker, currentRegime) {
        const prev = previousRegimes.get(ticker);
        previousRegimes.set(ticker, currentRegime);

        if (!prev) return 0;
        if (prev === currentRegime) {
            // No transition — return existing decaying boost if any
            return getBoost(ticker);
        }

        // Bullish transition: SIDEWAYS/DOWN/STRONG_DOWN → UP/STRONG_UP
        const bearishRegimes = ['SIDEWAYS', 'DOWN', 'STRONG_DOWN'];
        const bullishRegimes = ['UP', 'STRONG_UP'];
        if (bearishRegimes.includes(prev) && bullishRegimes.includes(currentRegime)) {
            boosts.set(ticker, { boostStart: Date.now(), boostAmount: MAX_BOOST });
            return MAX_BOOST;
        }

        return getBoost(ticker);
    }

    function getBoost(ticker) {
        const boost = boosts.get(ticker);
        if (!boost) return 0;
        const elapsed = Date.now() - boost.boostStart;
        if (elapsed >= BOOST_DURATION_MS) {
            boosts.delete(ticker);
            return 0;
        }
        // Linear decay
        return Math.round(boost.boostAmount * (1 - elapsed / BOOST_DURATION_MS));
    }

    return { checkTransition, getBoost };
})();

// ═══ HOT TICKERS SET (Phase 3A) ═══
// Tickers with velocity > 0.2%/min or recent volume burst — scanned first every iteration
const hotTickers = new Set();

// ═══ TIME-OF-DAY WIN RATE TRACKER ═══
// Tracks win rates by UTC hour (0-23) and day-of-week (0=Sun..6=Sat).
// Self-learning: blocks entries during historically unprofitable time slots.
const timeOfDayTracker = (() => {
    // hourStats[h] = { wins, losses }  for h in 0..23
    const hourStats = Array.from({ length: 24 }, () => ({ wins: 0, losses: 0 }));
    // dayStats[d] = { wins, losses }  for d in 0..6 (Sun..Sat)
    const dayStats = Array.from({ length: 7 }, () => ({ wins: 0, losses: 0 }));
    // Combined hour×day matrix for finer granularity (168 slots)
    const hourDayMatrix = Array.from({ length: 7 }, () =>
        Array.from({ length: 24 }, () => ({ wins: 0, losses: 0 }))
    );
    const MIN_TRADES_FOR_GATE = 8; // Need 8+ trades in a slot before blocking

    function recordTrade(entryTime, pnl) {
        const d = new Date(entryTime);
        const hour = d.getUTCHours();
        const day = d.getUTCDay();
        if (pnl >= 0) {
            hourStats[hour].wins++;
            dayStats[day].wins++;
            hourDayMatrix[day][hour].wins++;
        } else {
            hourStats[hour].losses++;
            dayStats[day].losses++;
            hourDayMatrix[day][hour].losses++;
        }
    }

    function shouldBlockEntry() {
        const now = new Date();
        const hour = now.getUTCHours();
        const day = now.getUTCDay();
        const reasons = [];

        // Check hour-level win rate
        const hTotal = hourStats[hour].wins + hourStats[hour].losses;
        if (hTotal >= MIN_TRADES_FOR_GATE) {
            const hWR = hourStats[hour].wins / hTotal;
            if (hWR < 0.35) {
                reasons.push(`Hour ${hour} UTC: ${(hWR * 100).toFixed(0)}% WR (${hTotal} trades)`);
            }
        }

        // Check day-level win rate
        const dTotal = dayStats[day].wins + dayStats[day].losses;
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (dTotal >= MIN_TRADES_FOR_GATE * 3) { // Need more trades for day-level gate
            const dWR = dayStats[day].wins / dTotal;
            if (dWR < 0.35) {
                reasons.push(`${dayNames[day]}: ${(dWR * 100).toFixed(0)}% WR (${dTotal} trades)`);
            }
        }

        // Check combined hour×day (most specific, needs more data)
        const hdSlot = hourDayMatrix[day][hour];
        const hdTotal = hdSlot.wins + hdSlot.losses;
        if (hdTotal >= MIN_TRADES_FOR_GATE) {
            const hdWR = hdSlot.wins / hdTotal;
            if (hdWR < 0.30) {
                reasons.push(`${dayNames[day]} ${hour}:00 UTC: ${(hdWR * 100).toFixed(0)}% WR (${hdTotal} trades)`);
            }
        }

        return { blocked: reasons.length > 0, reasons };
    }

    function getStatus() {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const hourSummary = hourStats.map((s, h) => {
            const total = s.wins + s.losses;
            return { hour: h, wins: s.wins, losses: s.losses, winRate: total > 0 ? (s.wins / total * 100).toFixed(0) + '%' : 'N/A', total };
        }).filter(s => s.total > 0);
        const daySummary = dayStats.map((s, d) => {
            const total = s.wins + s.losses;
            return { day: dayNames[d], wins: s.wins, losses: s.losses, winRate: total > 0 ? (s.wins / total * 100).toFixed(0) + '%' : 'N/A', total };
        }).filter(s => s.total > 0);
        return { hourSummary, daySummary, shouldBlockEntry: shouldBlockEntry() };
    }

    // Bootstrap from existing trade log on startup
    function bootstrapFromTradeLog(tradeLog) {
        if (!tradeLog || !Array.isArray(tradeLog)) return;
        for (const t of tradeLog) {
            if (t.entryTime) recordTrade(t.entryTime, t.pnl || 0);
        }
        console.log(`[TimeOfDay] Bootstrapped from ${tradeLog.length} historical trades`);
    }

    return { recordTrade, shouldBlockEntry, getStatus, bootstrapFromTradeLog };
})();

/** Stored reference to broadcastToFrontend for WS reconnect on exchange switch */
let _broadcastToFrontend = null;

// ═══ PER-TICKER LOSS COOLDOWN ═══
// Raises entry threshold after consecutive losses on a ticker
const tickerLossCooldown = (() => {
    const lossStreak = new Map(); // ticker → { consecutiveLosses, cooldownUntil }
    const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after 3 consecutive losses
    const MAX_CONSECUTIVE_LOSSES = 3;

    function recordTrade(ticker, pnl) {
        if (!lossStreak.has(ticker)) lossStreak.set(ticker, { consecutiveLosses: 0, cooldownUntil: 0 });
        const entry = lossStreak.get(ticker);
        if (pnl < 0) {
            entry.consecutiveLosses++;
            if (entry.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                entry.cooldownUntil = Date.now() + COOLDOWN_MS;
                console.log(`[TickerCooldown] ${ticker}: ${entry.consecutiveLosses} consecutive losses — cooldown for 1 hour`);
            }
        } else {
            entry.consecutiveLosses = 0; // Reset on win
        }
    }

    function getScoreAdjustment(ticker) {
        const entry = lossStreak.get(ticker);
        if (!entry) return 0;
        if (entry.cooldownUntil > Date.now()) {
            return 15; // Raise minimum score by 15 during cooldown
        }
        // Smaller penalty for 1-2 consecutive losses
        if (entry.consecutiveLosses >= 2) return 8;
        if (entry.consecutiveLosses >= 1) return 3;
        return 0;
    }

    function getStatus() {
        const result = {};
        for (const [ticker, entry] of lossStreak) {
            if (entry.consecutiveLosses > 0 || entry.cooldownUntil > Date.now()) {
                result[ticker] = {
                    consecutiveLosses: entry.consecutiveLosses,
                    onCooldown: entry.cooldownUntil > Date.now(),
                    cooldownRemaining: Math.max(0, entry.cooldownUntil - Date.now()),
                };
            }
        }
        return result;
    }

    return { recordTrade, getScoreAdjustment, getStatus };
})();

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
            // Track price velocity from tick stream
            priceVelocityTracker.recordTick(ticker, trade.price);

            // Track micro volume bursts from tick stream (Phase 1B)
            microBurstDetector.recordVolume(ticker, trade.quantity || trade.volume || 0);

            // Update hot tickers set (Phase 3A)
            const velMetrics = priceVelocityTracker.getMetrics(ticker);
            if (velMetrics.velocity > 0.2 || microBurstDetector.recentBurst(ticker)) {
                hotTickers.add(ticker);
                // Phase 3B: Trigger fast-track scan for high-velocity non-held tickers
                if (velMetrics.velocity > 0.5 && _signalScannerRef && !portfolio.positions[ticker]) {
                    _signalScannerRef.fastScan(ticker).catch(() => {}); // fire-and-forget
                }
            } else {
                hotTickers.delete(ticker);
            }

            // Feed VPIN updates from real-time trade stream
            if (orderBookMicro?.updateVPIN) {
                try {
                    orderBookMicro.updateVPIN(ticker, trade.price, trade.quantity || 0, trade.side || 'unknown');
                } catch (e) { /* non-critical */ }
            }

            // Track volume bursts for breakout detection
            trackTickVolume(ticker, trade);

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

    // Signal thresholds — Best seed (mod_1772200892500_11a80bd5): TC<25 entry
    THRESHOLDS: {
        TREND_BULLISH_ENTRY: 25,       // Best seed: strict TC<25 (was 40, proven +16.68% OOS)
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

// Legacy services removed (Questrade, GeminiBrain, DataIngestion)

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
// Rate limiting — skips localhost, protects VPS from abuse
app.use(rateLimit);

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

// Mount ML Training routes (synthetic labeling + new coin detection)
setMLTrainingContext({ getExchangeAdapter });
app.use('/api/ml-training', mlTrainingRouter);

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

// --- Trade Journal Patterns API ---
app.get('/api/journal/patterns', (req, res) => {
    try {
        res.json({ minedBlockedHours: getMinedBlockedHours() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Portfolio Risk Summary API ---
app.get('/api/engines/risk-summary', (req, res) => {
    try {
        const corrStatus = portfolioCorrelationEngine.getCorrelationStatus();
        let cvarData = {};
        try { if (cvarKelly) cvarData = cvarKelly.getStatus?.() || {}; } catch (e) {}

        // Build position risk data
        const posRisk = [];
        const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
            (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0);
        for (const [ticker, pos] of Object.entries(portfolio.positions)) {
            const value = pos.quantity * (pos.currentPrice || pos.openPrice);
            const pnlPct = pos.openPrice > 0 ? ((pos.currentPrice || pos.openPrice) - pos.openPrice) / pos.openPrice * 100 : 0;
            const correlated = [];
            for (const [other] of Object.entries(portfolio.positions)) {
                if (other !== ticker) correlated.push(other);
            }
            posRisk.push({ ticker, weight: totalValue > 0 ? value / totalValue : 0, pnlPct, correlated });
        }

        const ddCheck = checkMaxDrawdown();
        res.json({
            correlation: corrStatus,
            cvarKelly: cvarData,
            heatScore: botState.heatScore || 0,
            drawdown: ddCheck.drawdownPercent || 0,
            maxDrawdown: 15,
            positions: posRisk,
        });
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

// --- Execution Quality Feedback Endpoint ---
app.get('/api/execution/stats', (req, res) => {
    try {
        const stats = executionEngine?.getExecutionStats?.() || { totalExecutions: 0 };
        res.json(stats);
    } catch (e) {
        res.json({ totalExecutions: 0, error: e.message });
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

// --- System Status Endpoint (used by App.tsx + PerformanceDashboard) ---
app.get('/api/system/status', (req, res) => {
    try {
        const cbStatus = getCircuitBreakerStatus();
        res.json({
            aiLearning: {
                isActive: botState.isRunning || false,
                winRate: cbStatus.winRate || 0,
                totalTrades: cbStatus.totalTrades || 0,
                avgWinPercent: cbStatus.avgWin || 0,
                avgLossPercent: cbStatus.avgLoss || 0,
                kellyFraction: cbStatus.kelly || 0,
                netPnl: cbStatus.netPnl || 0,
            },
            portfolio: {
                cash: portfolio.cash,
                initialBudget: portfolio.startingCash || 1000,
                positions: Object.keys(portfolio.positions).length,
            },
            logs: logs.slice(-200),
            uptime: process.uptime(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status', (req, res) => {
    try {
        res.json({
            portfolio: {
                cash: portfolio.cash,
                initialBudget: portfolio.startingCash || 1000,
                positions: portfolio.positions,
            },
            logs: logs.slice(-200),
            tradeLog: portfolio.tradeLog?.slice(-100) || [],
            isRunning: botState.isRunning,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Risk Dashboard Endpoints ---
app.get('/api/risk/var', (req, res) => {
    try {
        const cvarStatus = cvarKelly?.getCVaRStatus?.() || {};
        const cbStatus = getCircuitBreakerStatus();
        const ddCheck = checkMaxDrawdown();
        const kellySize = getKellyPositionSize(portfolio.cash + Object.values(portfolio.positions).reduce(
            (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0));

        res.json({
            var95: parseFloat(cvarStatus.var95) || 0,
            var99: 0,
            cvar95: parseFloat(cvarStatus.cvar) || 0,
            cvar99: 0,
            method: 'historical',
            confidence: 0.95,
            timestamp: Date.now(),
            kelly: {
                full: kellySize.kelly?.fraction || 0,
                half: (kellySize.kelly?.fraction || 0) * 0.5,
                quarter: (kellySize.kelly?.fraction || 0) * 0.25,
                recommended: kellySize.fraction || 0.10,
                winRate: kellySize.kelly?.stats?.winRate || cbStatus.winRate || 0,
                avgWin: kellySize.kelly?.stats?.avgWin || 0,
                avgLoss: kellySize.kelly?.stats?.avgLoss || 0,
            },
            drawdown: {
                current: ddCheck.drawdownPercent || 0,
                max: 15,
                duration: 0,
                peakValue: peakValue,
                troughValue: peakValue * (1 - (ddCheck.drawdownPercent || 0) / 100),
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/risk-budget', (req, res) => {
    try {
        const cbStatus = getCircuitBreakerStatus();
        const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
            (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0);
        const positionCount = Object.keys(portfolio.positions).length;
        const usedPct = totalValue > 0 ? ((totalValue - portfolio.cash) / totalValue * 100) : 0;

        res.json({
            total: 100,
            used: usedPct,
            remaining: 100 - usedPct,
            byStrategy: {},
            positionSizing: Object.entries(portfolio.positions).map(([ticker, pos]) => ({
                ticker,
                weight: totalValue > 0 ? ((pos.quantity * (pos.currentPrice || pos.openPrice)) / totalValue * 100) : 0,
                pnlPct: pos.openPrice > 0 ? ((pos.currentPrice || pos.openPrice) - pos.openPrice) / pos.openPrice * 100 : 0,
            })),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/monte-carlo', async (req, res) => {
    try {
        let monteCarloService;
        try { monteCarloService = await import('./services/monteCarloService.js'); }
        catch { return res.json(null); }

        const trades = portfolio.tradeLog?.map(t => t.pnlPercent || 0) || [];
        if (trades.length < 5) return res.json(null);

        const result = monteCarloService.runMonteCarlo?.(trades, { simulations: 500, periods: 50 });
        res.json(result || null);
    } catch (e) {
        res.json(null);
    }
});

app.get('/api/stress-test', (req, res) => {
    try {
        res.json({
            portfolioHeat: {
                total: botState.heatScore || 0,
                max: 100,
            },
        });
    } catch (e) {
        res.json(null);
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

// Flash crash protection: track price snapshots for velocity detection
const flashCrashState = {
    priceSnapshots: new Map(), // ticker -> { price, timestamp }
    flashCrashActive: false,
    flashCrashUntil: 0,       // timestamp when flash crash lockout expires
    VELOCITY_THRESHOLD: -0.05, // -5% in window = flash crash
    VELOCITY_WINDOW_MS: 2 * 60 * 1000, // 2-minute window
    LOCKOUT_DURATION_MS: 5 * 60 * 1000, // 5-minute entry lockout after crash
};

/**
 * Check for flash crash: if BTC drops >5% in 2 minutes, activate protection.
 * Returns true if flash crash protection is active (block new entries).
 */
function checkFlashCrash(marketDataMap) {
    const now = Date.now();

    // Check if lockout has expired
    if (flashCrashState.flashCrashActive && now > flashCrashState.flashCrashUntil) {
        flashCrashState.flashCrashActive = false;
        addLog('[FLASH-CRASH] Protection expired — resuming normal entries', 'INFO');
    }

    // Check BTC and ETH price velocity (bellwether assets)
    for (const bellwether of ['BTCUSD', 'ETHUSD']) {
        const candles = marketDataMap.get(bellwether);
        if (!candles || candles.length < 3) continue;
        const currentPrice = candles[candles.length - 1].c;
        const prev = flashCrashState.priceSnapshots.get(bellwether);

        if (prev && (now - prev.timestamp) <= flashCrashState.VELOCITY_WINDOW_MS) {
            const velocity = (currentPrice - prev.price) / prev.price;
            if (velocity <= flashCrashState.VELOCITY_THRESHOLD) {
                flashCrashState.flashCrashActive = true;
                flashCrashState.flashCrashUntil = now + flashCrashState.LOCKOUT_DURATION_MS;
                addLog(`[FLASH-CRASH] ${bellwether} dropped ${(velocity * 100).toFixed(2)}% in ${((now - prev.timestamp) / 1000).toFixed(0)}s — blocking new entries for 5 min`, 'WARN');
                if (telegramEnabled()) {
                    try { alertCircuitBreaker(`FLASH CRASH: ${bellwether} ${(velocity*100).toFixed(2)}% in ${((now-prev.timestamp)/1000).toFixed(0)}s`); } catch(e) {}
                }
            }
        }

        // Update snapshot
        flashCrashState.priceSnapshots.set(bellwether, { price: currentPrice, timestamp: now });
    }

    return flashCrashState.flashCrashActive;
}

// Volume burst tracker: detects sudden buy-side volume spikes from WS tick data
const volumeBurstState = new Map(); // ticker -> { buys30s: number, sells30s: number, lastReset: number }
const VOLUME_BURST_WINDOW_MS = 30_000; // 30-second window
const VOLUME_BURST_THRESHOLD = 3.0;    // 3× normal = burst

function trackTickVolume(ticker, trade) {
    const now = Date.now();
    let state = volumeBurstState.get(ticker);
    if (!state || (now - state.lastReset) > VOLUME_BURST_WINDOW_MS) {
        // Save previous window stats before resetting
        if (state) {
            state.prevBuys = state.buys30s;
            state.prevSells = state.sells30s;
        }
        state = { buys30s: 0, sells30s: 0, lastReset: now, prevBuys: state?.buys30s || 0, prevSells: state?.sells30s || 0 };
        volumeBurstState.set(ticker, state);
    }
    const qty = trade.quantity || trade.amount || 0;
    if (trade.side === 'buy' || trade.side === 'b') {
        state.buys30s += qty;
    } else {
        state.sells30s += qty;
    }
}

/**
 * Check if a ticker has a buy-side volume burst (3× normal in 30s window).
 * Returns { burst: boolean, ratio: number }
 */
function getVolumeBurstSignal(ticker) {
    const state = volumeBurstState.get(ticker);
    if (!state || state.prevBuys <= 0) return { burst: false, ratio: 0 };
    const ratio = state.buys30s / Math.max(0.001, state.prevBuys);
    return { burst: ratio >= VOLUME_BURST_THRESHOLD, ratio };
}

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
function checkLiquidity(candles, ticker) {
    if (!candles || candles.length < 5) return { pass: false, avgUsdVol: 0, reason: 'insufficient candles' };

    const recent = candles.slice(-20);
    const lastPrice = recent[recent.length - 1].c;

    // Price floor: skip sub-penny tokens
    if (lastPrice < CONFIG.MIN_PRICE) {
        return { pass: false, avgUsdVol: 0, reason: `price $${lastPrice} < $${CONFIG.MIN_PRICE} floor` };
    }

    // Volume check: avg USD volume per candle
    // New listings get a lower threshold ($1K vs $5K) to allow earlier entry
    let totalUsdVol = 0;
    for (const c of recent) {
        const typicalPrice = (c.o + c.c) / 2;
        totalUsdVol += (c.v || 0) * typicalPrice;
    }
    const avgUsdVol = totalUsdVol / recent.length;
    const minVolume = (ticker && isNewListing && isNewListing(ticker)) ? 1000 : CONFIG.MIN_AVG_CANDLE_USD_VOLUME;

    if (avgUsdVol < minVolume) {
        return { pass: false, avgUsdVol, reason: `avg candle vol $${avgUsdVol.toFixed(0)} < $${minVolume}` };
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
 * Calculate VWAP (Volume Weighted Average Price) for candle array.
 * Returns the latest VWAP value.
 */
function calculateVWAPLatest(candles) {
    if (!candles || candles.length === 0) return null;
    let cumTPV = 0, cumVol = 0;
    for (const c of candles) {
        const tp = ((c.h || c.high || 0) + (c.l || c.low || 0) + (c.c || c.close || 0)) / 3;
        const vol = c.v || c.volume || 0;
        cumTPV += tp * vol;
        cumVol += vol;
    }
    return cumVol > 0 ? cumTPV / cumVol : null;
}

/**
 * Calculate StochRSI latest K value (0-100).
 * < 20 = oversold, > 80 = overbought.
 */
function calculateStochRSILatest(candles, rsiPeriod = 14, stochPeriod = 14) {
    if (!candles || candles.length < rsiPeriod + stochPeriod) return 50;
    const closes = candles.map(c => c.c || c.close || 0);
    // Calculate RSI series
    const rsiValues = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= rsiPeriod; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
    }
    avgGain /= rsiPeriod; avgLoss /= rsiPeriod;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = rsiPeriod + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        avgGain = (avgGain * (rsiPeriod - 1) + (change > 0 ? change : 0)) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + (change < 0 ? Math.abs(change) : 0)) / rsiPeriod;
        rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    // Apply stochastic formula to last stochPeriod RSI values
    if (rsiValues.length < stochPeriod) return 50;
    const window = rsiValues.slice(-stochPeriod);
    const minRSI = Math.min(...window);
    const maxRSI = Math.max(...window);
    if (maxRSI === minRSI) return 50;
    return ((rsiValues[rsiValues.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
}

/**
 * Calculate Delta Volume — buy-side minus sell-side pressure (0-100 scale, 50 = neutral).
 * > 60 = buy dominance, < 40 = sell dominance.
 */
function calculateDeltaVolumeLatest(candles, period = 14) {
    if (!candles || candles.length < period) return 50;
    const recent = candles.slice(-period);
    let totalBuyVol = 0, totalSellVol = 0;
    for (const c of recent) {
        const h = c.h || c.high || 0;
        const l = c.l || c.low || 0;
        const cl = c.c || c.close || 0;
        const vol = c.v || c.volume || 0;
        const range = h - l;
        if (range === 0) continue;
        const buyProportion = (cl - l) / range;
        totalBuyVol += vol * buyProportion;
        totalSellVol += vol * (1 - buyProportion);
    }
    const total = totalBuyVol + totalSellVol;
    if (total === 0) return 50;
    return (totalBuyVol / total) * 100; // 0-100: >50 = buy dominant
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

// Native exchange stop-loss order tracking — survives bot crashes
// Map<ticker, { orderId, stopPrice, volume, placedAt }>
const nativeStopOrders = new Map();

// A3: Simulated native stop-loss for SIM mode — mirrors nativeStopOrders structure
// Map<ticker, { stopPrice, volume, placedAt }>
const simNativeStopOrders = new Map();

// C7: Per-ticker flash crash detection — rolling price buffer for each ticker
// Map<ticker, { prices: Array<{price, ts}>, tightenedSL: boolean }>
const perTickerFlashCrash = new Map();

function refreshExitLevels(marketDataMap) {
    const fees = getActiveFees();
    const { profitGoals } = botState.settings;
    for (const [ticker, position] of Object.entries(portfolio.positions)) {
        const candles = marketDataMap.get(ticker);
        if (!candles || candles.length < 10) continue;

        const targets = getDynamicTargets(candles);
        const openPrice = position.openPrice;

        // Mid-trade regime transition detection: update exit levels when regime changes
        const currentRegimeForTicker = targets.regime;
        if (position.regime && currentRegimeForTicker && position.regime !== currentRegimeForTicker) {
            const oldRegime = position.regime;
            position.regime = currentRegimeForTicker;
            addLog(`[REGIME-SHIFT] ${ticker}: ${oldRegime} → ${currentRegimeForTicker} (mid-trade exit levels recomputed)`, 'INFO');
        }

        // Upgrade #9: ATR-based dynamic exits with regime multipliers
        const atr = calculateATRFromCandles(candles, 14);
        const atrPct = openPrice > 0 ? (atr / openPrice) : 0.01;

        // Regime multipliers for exit tightness (market direction)
        let regimeMultiplier = 1.0;
        if (targets.regime === 'SIDEWAYS') regimeMultiplier = 0.75;
        else if (targets.regime === 'UPTREND') regimeMultiplier = 1.25;
        else if (targets.regime === 'DOWNTREND') regimeMultiplier = 0.5;

        // Volatility regime multiplier (market volatility level)
        // Compare current ATR% to historical ATR% to classify volatility regime
        let volRegimeMultiplier = 1.0;
        if (candles.length >= 50) {
            // Compute ATR percentile from last 50 candles
            const atrHistory = [];
            for (let i = 14; i < candles.length; i++) {
                const slice = candles.slice(i - 14, i);
                const histATR = calculateATRFromCandles(slice, 14);
                const histPrice = slice[slice.length - 1].c || 1;
                atrHistory.push(histATR / histPrice);
            }
            atrHistory.sort((a, b) => a - b);
            const percentileIdx = atrHistory.findIndex(v => v >= atrPct);
            const atrPercentile = percentileIdx >= 0 ? (percentileIdx / atrHistory.length) * 100 : 50;

            if (atrPercentile < 25) {
                // Low volatility: tighter stops, smaller targets (mean-reversion environment)
                volRegimeMultiplier = 0.7;
            } else if (atrPercentile > 75) {
                // High volatility: wider stops, bigger targets (trend/breakout environment)
                volRegimeMultiplier = 1.4;
            }
            // else: normal volatility, multiplier stays 1.0
        }

        const adjustedATR = atrPct * regimeMultiplier * volRegimeMultiplier;

        // Stage 1: exit 25% at 1.0× ATR profit
        const stage1Price = openPrice * (1 + adjustedATR * 1.0 + fees.roundTrip);
        // Stage 2: exit 35% at 2.0× ATR profit
        const stage2Price = openPrice * (1 + adjustedATR * 2.0 + fees.roundTrip);
        // Stage 3: trail remaining at 1.5× ATR below high-water mark
        const trailATRPct = adjustedATR * 1.5;

        // C1: Apply Meta-RL SL/TP multipliers if available
        let metaRLSlMult = 1.0;
        let metaRLTpMult = 1.0;
        if (metaRL && position.metaRLActions) {
            // Use entry-time actions for consistency; clamp to 0.5-2.0 safety range
            metaRLSlMult = Math.max(0.5, Math.min(2.0, position.metaRLActions.slMult || 1.0));
            metaRLTpMult = Math.max(0.5, Math.min(2.0, position.metaRLActions.tpMult || 1.0));
        } else if (metaRL) {
            try {
                const mrParams = metaRL.getRecommendedParams(targets.regime || 'SIDEWAYS');
                if (mrParams && mrParams.confidence > 20) {
                    metaRLSlMult = Math.max(0.5, Math.min(2.0, mrParams.slMult || 1.0));
                    metaRLTpMult = Math.max(0.5, Math.min(2.0, mrParams.tpMult || 1.0));
                }
            } catch (e) {}
        }

        // Phase 2A: SNIPER positions get tighter scalp exits
        const isSniper = position.entryType === 'SNIPER' && getFlag('SNIPER_MODE_ENABLED');
        let tpPrice, slPrice, trailActivationPrice, trailPct;

        if (isSniper) {
            // SNIPER scalp targets: TP 2-3%, SL 1.5%, maxHold 2h, early trail activation
            const sniperTP = getFlag('SNIPER_TP') || 0.025; // 2.5% default
            const sniperSL = getFlag('SNIPER_SL') || 0.015; // 1.5% default

            tpPrice = openPrice * (1 + sniperTP * metaRLTpMult + fees.roundTrip);
            slPrice = openPrice * (1 - sniperSL * metaRLSlMult);
            trailActivationPrice = openPrice * (1 + sniperTP * 0.40); // Trail activates at 40% of TP
            trailPct = 15; // 15% giveback (tight)

            // Phase 2B: Momentum-ride exit extension
            // If position hit TP but velocity still strong, extend TP
            const vel = priceVelocityTracker.getMetrics(ticker);
            const currentPrice = position.currentPrice || openPrice;
            const extensions = position.sniperExtensions || 0;
            if (currentPrice >= tpPrice && vel.velocity > 0.3 && extensions < 3) {
                // Extend TP by 1% per extension
                tpPrice = openPrice * (1 + sniperTP + 0.01 * (extensions + 1) + fees.roundTrip);
                position.sniperExtensions = extensions + 1;
                trailPct = 10; // Tighten trail during extension
                if (extensions === 0) {
                    addLog(`[SNIPER] Momentum-ride extension for ${ticker}: TP extended to +${((tpPrice/openPrice - 1) * 100).toFixed(1)}%, vel=${vel.velocity.toFixed(2)}%/min`, 'INFO');
                }
            }
            // Reset extension counter if velocity fizzles
            if (vel.velocity < 0.1 && extensions > 0) {
                position.sniperExtensions = 0;
            }

            // Phase 2C: Velocity-based emergency exit
            // If velocity flips negative AND acceleration < -0.2%/min²: immediate exit
            if (vel.velocity < -0.1 && vel.acceleration < -0.2 && vel.tickCount >= 5) {
                const pnlPct = ((currentPrice - openPrice) / openPrice) * 100;
                if (!position._exitPending) {
                    addLog(`[SNIPER] Velocity emergency exit for ${ticker}: vel=${vel.velocity.toFixed(2)}%/min, accel=${vel.acceleration.toFixed(2)} — selling at ${pnlPct.toFixed(1)}%`, 'WARN');
                    position._exitPending = true;
                    // Fire-and-forget async sell
                    const _pos = position;
                    const _price = currentPrice;
                    (async () => {
                        try { await handleSell(_pos, _price, `SNIPER_VELOCITY_EXIT (vel=${vel.velocity.toFixed(2)}, accel=${vel.acceleration.toFixed(2)})`); }
                        catch (e) { _pos._exitPending = false; }
                    })();
                }
            }

            // SNIPER max hold time: force exit after 2h
            const sniperMaxHold = (getFlag('SNIPER_MAX_HOLD') || 2) * 60 * 60 * 1000;
            if (Date.now() - (position.entryTime || 0) > sniperMaxHold && !position._exitPending) {
                const _pos = position;
                const _price = position.currentPrice || openPrice;
                position._exitPending = true;
                addLog(`[SNIPER] Max hold time reached for ${ticker} (${((Date.now() - position.entryTime) / 3600000).toFixed(1)}h) — forcing exit`, 'INFO');
                (async () => {
                    try { await handleSell(_pos, _price, 'SNIPER_MAX_HOLD_EXIT'); }
                    catch (e) { _pos._exitPending = false; }
                })();
            }
        } else {
            // Standard exit calculation (unchanged)
            // TP price: use seed/optimizer TP if available (12-35%), otherwise fall back to ATR-based stage 2
            tpPrice = targets.optimized
                ? openPrice * (1 + (targets.takeProfitPct / 100) * metaRLTpMult)
                : stage2Price * (1 + (metaRLTpMult - 1) * (stage2Price - openPrice) / openPrice);

            // SL price: use seed/optimizer SL if available, otherwise 2× ATR
            const feeAdjustedSL = targets.optimized
                ? (targets.stopLossPct / 100) * metaRLSlMult
                : (adjustedATR * 2.0 + fees.roundTrip) * metaRLSlMult;
            slPrice = openPrice * (1 - feeAdjustedSL);

            // Trail activation: at stage 1 price
            trailActivationPrice = stage1Price;

            // Trail distance percentage
            trailPct = Math.max(1.0, trailATRPct * 100); // Floor 1.0% — 0.3% was noise on BTC
        }

        // Per-trade profit goal (dollar amount)
        const profitGoal = profitGoals?.[position.entryStrategy] || 0;

        exitLevelCache.set(ticker, {
            tpPrice, slPrice, trailActivationPrice, trailPct, profitGoal, regime: targets.regime,
            stage1Price, stage2Price, atrPct: adjustedATR, regimeMultiplier, volRegimeMultiplier,
            isSniper,
        });

        // Update native exchange SL if price moved significantly (>1% difference)
        // Fire-and-forget to avoid blocking the synchronous refresh loop
        const nativeSL = nativeStopOrders.get(ticker);
        if (nativeSL && botState.tradingMode !== 'SIMULATION' && getActiveExchangeId() === 'kraken') {
            const priceDiff = Math.abs(nativeSL.stopPrice - slPrice) / slPrice;
            if (priceDiff > 0.01) {
                const _ticker = ticker;
                const _qty = position.quantity;
                const _slPrice = slPrice;
                const _oldPrice = nativeSL.stopPrice;
                const _oldOrderId = nativeSL.orderId;
                (async () => {
                    try {
                        const adapter = getExchangeAdapter();
                        await adapter.cancelOrder(_oldOrderId, botState.sessionId);
                        const newSL = await adapter.placeStopLoss(_ticker, _qty, _slPrice, botState.sessionId);
                        if (newSL.orderId) {
                            nativeStopOrders.set(_ticker, {
                                orderId: newSL.orderId,
                                stopPrice: _slPrice,
                                volume: _qty,
                                placedAt: Date.now(),
                            });
                            addLog(`[NATIVE-SL] Updated ${_ticker} SL: $${_oldPrice.toFixed(2)} → $${_slPrice.toFixed(2)}`, 'INFO');
                        }
                    } catch (e) {
                        addLog(`[NATIVE-SL] Failed to update SL for ${_ticker}: ${e.message}`, 'WARN');
                    }
                })();
            }
        }
    }
    // A3: Check simulated SL triggers in SIM mode
    if (botState.tradingMode === 'SIMULATION' && getFlag('SIMULATION_ACCURACY')) {
        for (const [ticker, simSL] of simNativeStopOrders) {
            const position = portfolio.positions[ticker];
            if (!position) { simNativeStopOrders.delete(ticker); continue; }
            const candles = marketDataMap.get(ticker);
            if (!candles || candles.length === 0) continue;
            const currentPrice = candles[candles.length - 1].c;
            if (currentPrice <= simSL.stopPrice) {
                addLog(`[SIM-SL] Stop-loss TRIGGERED for ${ticker}: price $${currentPrice.toFixed(2)} <= SL $${simSL.stopPrice.toFixed(2)}`, 'WARN');
                handleSell(position, currentPrice, `SIM_NATIVE_SL (hit $${simSL.stopPrice.toFixed(2)})`);
                simNativeStopOrders.delete(ticker);
                continue;
            }
            // Update SIM SL when computed SL changes significantly (same logic as real mode)
            const cached = exitLevelCache.get(ticker);
            if (cached && Math.abs(simSL.stopPrice - cached.slPrice) / cached.slPrice > 0.01) {
                simNativeStopOrders.set(ticker, {
                    stopPrice: cached.slPrice,
                    volume: position.quantity,
                    placedAt: Date.now(),
                });
            }
        }
    }

    // C7: Per-ticker flash crash detection — track last 5 prices per ticker
    for (const [ticker, position] of Object.entries(portfolio.positions)) {
        const candles = marketDataMap.get(ticker);
        if (!candles || candles.length < 2) continue;
        const currentPrice = candles[candles.length - 1].c;
        const now = Date.now();

        if (!perTickerFlashCrash.has(ticker)) {
            perTickerFlashCrash.set(ticker, { prices: [], tightenedSL: false });
        }
        const state = perTickerFlashCrash.get(ticker);
        state.prices.push({ price: currentPrice, ts: now });
        // Keep only prices from last 5 minutes
        state.prices = state.prices.filter(p => now - p.ts <= 5 * 60 * 1000);

        if (state.prices.length >= 2) {
            const oldestPrice = state.prices[0].price;
            const dropPct = (currentPrice - oldestPrice) / oldestPrice;

            // >5% drop in 5 min → emergency close (both SIM and REAL)
            if (dropPct <= -0.05) {
                addLog(`[FLASH-CRASH-TICKER] ${ticker} dropped ${(dropPct * 100).toFixed(2)}% in ${((now - state.prices[0].ts) / 1000).toFixed(0)}s — EMERGENCY CLOSE`, 'WARN');
                handleSell(position, currentPrice, `PER_TICKER_FLASH_CRASH (${(dropPct * 100).toFixed(1)}% drop)`);
                perTickerFlashCrash.delete(ticker);
                continue;
            }

            // >3% drop → tighten SL to 1%
            if (dropPct <= -0.03 && !state.tightenedSL) {
                state.tightenedSL = true;
                const tightSL = currentPrice * 0.99; // 1% SL
                const cached = exitLevelCache.get(ticker);
                if (cached && tightSL > cached.slPrice) {
                    cached.slPrice = tightSL;
                    exitLevelCache.set(ticker, cached);
                    addLog(`[FLASH-CRASH-TICKER] ${ticker} down ${(dropPct * 100).toFixed(2)}% — tightened SL to $${tightSL.toFixed(2)} (1%)`, 'WARN');
                    if (telegramEnabled()) {
                        try { alertCircuitBreaker(`PER-TICKER FLASH: ${ticker} ${(dropPct*100).toFixed(2)}% — SL tightened to 1%`); } catch(e) {}
                    }
                }
            }
        }
    }
    // Clean up flash crash state for closed positions
    for (const ticker of perTickerFlashCrash.keys()) {
        if (!portfolio.positions[ticker]) perTickerFlashCrash.delete(ticker);
    }

    // Clean stale entries for closed positions
    for (const ticker of exitLevelCache.keys()) {
        if (!portfolio.positions[ticker]) exitLevelCache.delete(ticker);
    }
    // Clean stale native SL orders for closed positions
    for (const ticker of nativeStopOrders.keys()) {
        if (!portfolio.positions[ticker]) {
            nativeStopOrders.delete(ticker);
        }
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

/**
 * Partial sell: reduce position quantity by a fraction, book proportional PnL.
 * Used for staged exits (25% at stage1, 35% at stage2).
 */
async function handlePartialSell(position, price, fraction, reason) {
    const ticker = position.ticker;
    const sellQty = position.quantity * fraction;
    if (sellQty <= 0) return;

    const fees = getActiveFees();
    let avgPrice = price;

    if (botState.tradingMode === 'SIMULATION') {
        const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(ticker);
        const slippagePct = (isMajor ? 2 : 8) / 10000 * 100;
        avgPrice = price * (1 - slippagePct / 100);
    } else {
        try {
            const adapter = getExchangeAdapter();
            const orderResult = await withTimeout(
                adapter.placeSellOrder(ticker, sellQty, botState.sessionId, instrumentSpecs),
                20000, 'partialSell'
            );
            avgPrice = parseFloat(orderResult.avgPrice) || price;
        } catch (e) {
            addLog(`[PARTIAL-SELL] Exchange order failed for ${ticker}: ${e.message} — using market price`, 'WARN');
        }
    }

    const sellFee = avgPrice * sellQty * fees.perSide;
    const buyFee = position.openPrice * sellQty * fees.perSide;
    const partialPnl = (avgPrice - position.openPrice) * sellQty - sellFee - buyFee;

    // Reduce position quantity, add proceeds to cash
    position.quantity -= sellQty;
    portfolio.cash += (sellQty * avgPrice) - sellFee;

    addLog(`[PARTIAL-EXIT] ${ticker}: Sold ${(fraction * 100).toFixed(0)}% (${sellQty.toFixed(6)}) @ $${avgPrice.toFixed(2)} | PnL: $${partialPnl.toFixed(2)} | ${reason}`, partialPnl >= 0 ? 'PROFIT' : 'LOSS');

    logThought({
        type: 'SELL', ticker, action: partialPnl >= 0 ? 'PARTIAL_PROFIT' : 'PARTIAL_LOSS',
        confidence: 0, reason: `${reason} (${(fraction*100).toFixed(0)}% of position)`,
        indicators: { entryPrice: position.openPrice, exitPrice: avgPrice, pnl: partialPnl, fraction },
        regime: '',
    });
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

    // --- STAGED PARTIAL EXITS ---
    // Skip staged partials when seed TP overrides are active — partials at 1-2× ATR (0.6-1.0%)
    // would sell 60% of the position before the seed's 12-35% TP is reached
    const skipStaged = levels.regime && levels.tpPrice && (levels.tpPrice / position.openPrice - 1) > 0.05; // TP > 5% = seed override active

    // Stage 1: exit 25% at 1.0× ATR profit (if not already done)
    if (!skipStaged && !position._stage1Done && levels.stage1Price && price >= levels.stage1Price) {
        position._stage1Done = true;
        try {
            const pnl = ((price - position.openPrice) / position.openPrice * 100).toFixed(2);
            await handlePartialSell(position, price, 0.25,
                `[RT-STAGE1] +${pnl}% hit 1×ATR @ ${levels.stage1Price.toFixed(4)}`);
        } catch (e) {
            console.error(`[RT-STAGE1] Failed for ${ticker}: ${e.message}`);
            position._stage1Done = false;
        }
        return; // Don't check further exits this tick
    }

    // Stage 2: exit 35% at 2.0× ATR profit (of remaining position)
    if (!skipStaged && position._stage1Done && !position._stage2Done && levels.stage2Price && price >= levels.stage2Price) {
        position._stage2Done = true;
        // 35% of original = ~46.7% of remaining (after 25% was sold)
        const stage2Fraction = Math.min(0.467, 0.35 / (1 - 0.25));
        try {
            const pnl = ((price - position.openPrice) / position.openPrice * 100).toFixed(2);
            await handlePartialSell(position, price, stage2Fraction,
                `[RT-STAGE2] +${pnl}% hit 2×ATR @ ${levels.stage2Price.toFixed(4)}`);
        } catch (e) {
            console.error(`[RT-STAGE2] Failed for ${ticker}: ${e.message}`);
            position._stage2Done = false;
        }
        return;
    }

    let exitReason = null;
    let isStopLoss = false; // SL exits always fire (protective); TP/trail exits are profit-checked

    // 1. Per-trade profit goal (on remaining quantity)
    if (levels.profitGoal > 0) {
        const profit = (price - position.openPrice) * position.quantity;
        if (profit >= levels.profitGoal) {
            exitReason = `[RT] Per-trade profit goal $${levels.profitGoal.toFixed(2)} reached`;
        }
    }

    // 2. Take-profit (full exit of remainder)
    if (!exitReason && price >= levels.tpPrice) {
        const pnl = ((price - position.openPrice) / position.openPrice * 100).toFixed(2);
        exitReason = `[RT-TP] +${pnl}% hit TP @ ${levels.tpPrice.toFixed(4)} (${levels.regime})`;
    }

    // 3. Trailing stop (only if trail activated — stage1 price acts as trail activation)
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

    // 5. Mid-trade regime-aware exit switching
    // If regime flipped against position since entry, tighten trailing stop dynamically
    if (!exitReason && position.entryRegime) {
        const transition = detectRegimeTransition(ticker);
        if (transition.transition) {
            const pnlPct = (price - position.openPrice) / position.openPrice * 100;
            if (transition.recommendation === 'FORCE_TIGHTEN' || transition.recommendation === 'TIGHTEN_EXITS') {
                // Regime flipped bearish — tighten trail to 50% of normal giveback
                if (position.highestPrice > position.openPrice && pnlPct > 0.5) {
                    const tightTrailPct = (levels.trailPct || 2) * 0.5; // halve the trail giveback
                    const tightTrailLevel = position.highestPrice * (1 - tightTrailPct / 100);
                    if (price <= tightTrailLevel) {
                        exitReason = `[RT-REGIME-FLIP] ${transition.from}→${transition.to} (${transition.transition}): price ${price.toFixed(4)} <= tight trail ${tightTrailLevel.toFixed(4)}`;
                    }
                }
                // If in loss and regime flipped bearish hard, force exit to cut losses early
                if (!exitReason && transition.recommendation === 'FORCE_TIGHTEN' && pnlPct < -1.0) {
                    exitReason = `[RT-REGIME-REVERSAL] ${transition.from}→${transition.to}: cutting loss at ${pnlPct.toFixed(2)}% — regime reversed`;
                    isStopLoss = true; // bypass profitability check
                }
            }
        }
    }

    // 6. Liquidation cascade risk — proactively tighten trailing stop
    if (!exitReason && derivativesIntel && position.highestPrice > position.openPrice) {
        try {
            const cascade = derivativesIntel.predictCascadeRisk(ticker);
            if (cascade.risk !== 'LOW' && cascade.trailTightenPct < 1.0) {
                const tightTrailPct = (levels.trailPct || 2) * cascade.trailTightenPct;
                const cascadeTrailLevel = position.highestPrice * (1 - tightTrailPct / 100);
                if (price <= cascadeTrailLevel) {
                    exitReason = `[RT-CASCADE] ${cascade.risk} risk (score=${cascade.score}): ${cascade.factors.join(', ')} — tight trail hit @ ${cascadeTrailLevel.toFixed(4)}`;
                }
            }
        } catch (e) { /* non-critical */ }
    }

    // 6b. Funding rate exit tightening — extreme funding = overleveraged market = vulnerability
    if (!exitReason && derivativesIntel && position.highestPrice > position.openPrice) {
        try {
            const derivSignal = derivativesIntel.getDerivativesSignal?.(ticker.replace('USD', ''));
            if (derivSignal?.fundingRate) {
                const fundingAPR = Math.abs(derivSignal.fundingRate * 3 * 365 * 100); // 8h rate to annualized
                // If funding is extreme (>50% APR), tighten trailing stop by 30%
                if (fundingAPR > 50) {
                    const fundingTightTrail = (levels.trailPct || 2) * 0.70; // 30% tighter
                    const fundingTrailLevel = position.highestPrice * (1 - fundingTightTrail / 100);
                    if (price <= fundingTrailLevel) {
                        exitReason = `[RT-FUNDING] Extreme funding ${fundingAPR.toFixed(0)}% APR — tight trail hit @ ${fundingTrailLevel.toFixed(4)}`;
                    }
                }
            }
        } catch (e) { /* non-critical */ }
    }

    // 7. Time-based max hold exit — prevent zombie positions
    // TREND positions that linger too long are usually failed setups that didn't trigger SL
    if (!exitReason) {
        const holdMs = Date.now() - (position.entryTime || position.openTime || Date.now());
        const holdHours = holdMs / (1000 * 60 * 60);
        const maxHoldHours = position.entryStrategy === 'TREND' ? (botState._seedMaxHoldHours || 168) : 24; // Seed default 168h for TREND, 24h others
        if (holdHours >= maxHoldHours) {
            const pnlPct = (price - position.openPrice) / position.openPrice * 100;
            exitReason = `[RT-MAX-HOLD] ${holdHours.toFixed(1)}h >= ${maxHoldHours}h limit (PnL: ${pnlPct.toFixed(2)}%)`;
            if (pnlPct < 0) isStopLoss = true; // Force exit even at loss — position is stale
        }
    }

    // 8. Breakeven stop — after position well into profit, protect breakeven
    // Raised from 0.6%/0.1% → 1.5%/0.3%: old thresholds exited on minor retracements after barely covering fees
    // Only before stage1 — once partial exits happen, trailing stop manages risk
    if (!exitReason && !isStopLoss) {
        const pnlPct = (price - position.openPrice) / position.openPrice * 100;
        const peakPnlPct = position.highestPrice ? ((position.highestPrice - position.openPrice) / position.openPrice * 100) : 0;
        if (peakPnlPct >= 1.5 && pnlPct < 0.3 && !position._stage1Done) {
            exitReason = `[RT-BREAKEVEN] Peak was +${peakPnlPct.toFixed(2)}%, now +${pnlPct.toFixed(2)}% — protecting breakeven`;
            isStopLoss = true;
        }
    }

    // 9. Velocity-based emergency exit: if price is crashing (strong negative velocity + acceleration)
    // and we're in profit, exit before the crash wipes gains
    if (!exitReason && !isStopLoss) {
        const vel = priceVelocityTracker.getMetrics(ticker);
        if (vel.tickCount >= 5) {
            const pnlPct = (price - position.openPrice) / position.openPrice * 100;
            // Sharp crash: velocity < -0.5%/min AND accelerating downward
            if (vel.velocity < -0.5 && vel.acceleration < -0.1 && pnlPct > 0.3) {
                exitReason = `[RT-VELOCITY] Price crashing: ${vel.velocity.toFixed(3)}%/min, accel=${vel.acceleration.toFixed(3)} — protecting +${pnlPct.toFixed(2)}% profit`;
            }
            // In loss and velocity strongly negative — cut early before it gets worse
            if (vel.velocity < -1.0 && vel.acceleration < -0.3 && pnlPct < -1.0) {
                exitReason = `[RT-VELOCITY-SL] Rapid decline: ${vel.velocity.toFixed(3)}%/min — cutting loss at ${pnlPct.toFixed(2)}%`;
                isStopLoss = true;
            }
        }
    }

    // Pre-check exit profitability after estimated slippage + fees (for non-SL exits only).
    if (exitReason && !isStopLoss) {
        const fees = getActiveFees();
        const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(ticker);
        const estSlippagePct = isMajor ? 0.05 : 0.15;
        const estExitPrice = price * (1 - estSlippagePct / 100);
        const sellFee = estExitPrice * position.quantity * fees.perSide;
        const buyFee = position.openPrice * position.quantity * fees.perSide;
        const netPnl = (estExitPrice - position.openPrice) * position.quantity - sellFee - buyFee;

        if (netPnl < 0) {
            if (Math.random() < 0.05) {
                addLog(`[RT-SKIP] ${ticker}: Exit at ${price.toFixed(4)} would net $${netPnl.toFixed(2)} after slippage+fees — waiting for better price`, 'INFO');
            }
            return;
        }
    }

    if (exitReason) {
        position._exitPending = true;
        try {
            await handleSell(position, price, exitReason);
        } catch (err) {
            console.error(`[RT-EXIT] Failed for ${ticker}: ${err.message}`);
            if (portfolio.positions[ticker]) portfolio.positions[ticker]._exitPending = false;
        }
        return;
    }

    // ═══ DYNAMIC PYRAMIDING — Add to winners when trend is confirmed ═══
    // Conditions: +2%+ profit, strong trend (TC>70), bullish regime, max 2 pyramids
    if (!position._pyramidCount) position._pyramidCount = 0;
    if (position._pyramidCount < 2 && !position._pyramidCooldown) {
        const pnlPct = ((price - position.openPrice) / position.openPrice) * 100;
        const pyramidThreshold = position._pyramidCount === 0 ? 2.0 : 4.0; // First at +2%, second at +4%

        if (pnlPct >= pyramidThreshold && position.entryStrategy === 'TREND') {
            // Verify trend is still strong
            let tcScore = 0;
            try {
                const mom = position._cachedMom;
                tcScore = mom?.tcScore || 0;
            } catch (e) {}

            // Check regime is still bullish
            let regimeOk = false;
            try {
                const regime = getMarketRegime(ticker)?.regime || 'UNKNOWN';
                regimeOk = regime === 'STRONG_UP' || regime === 'UP';
            } catch (e) {}

            if (tcScore > 70 && regimeOk) {
                // Pyramid: add 30% of original position value
                const originalValue = position.openPrice * (position._originalQuantity || position.quantity);
                const pyramidNotional = originalValue * 0.30;

                if (pyramidNotional >= 5 && portfolio.cash >= pyramidNotional) {
                    if (!position._originalQuantity) position._originalQuantity = position.quantity;
                    position._pyramidCount++;
                    position._pyramidCooldown = true;
                    // Cooldown: don't pyramid again for 30 minutes
                    setTimeout(() => { if (portfolio.positions[ticker]) portfolio.positions[ticker]._pyramidCooldown = false; }, 30 * 60 * 1000);

                    addLog(`[PYRAMID] Adding $${pyramidNotional.toFixed(2)} to ${ticker} (pyramid #${position._pyramidCount}, +${pnlPct.toFixed(1)}%, TC=${tcScore})`, 'BUY');
                    try {
                        await handleBuy(ticker, price, 'TREND', `PYRAMID #${position._pyramidCount} at +${pnlPct.toFixed(1)}%`, pyramidNotional, {
                            isPyramid: true,
                            pyramidNumber: position._pyramidCount,
                        });
                    } catch (e) {
                        addLog(`[PYRAMID] Failed for ${ticker}: ${e.message}`, 'WARN');
                        position._pyramidCount--;
                    }
                }
            }
        }
    }
}

// ============================================
// Trading Bot Loop (Optimized for Large Universes)
// ============================================
let botLoopRunning = false;
let _signalScannerRef = null; // Reference to signal scanner for bot loop access
let botLoopStartTime = 0;
// Monte Carlo risk gate: cached results refreshed every 30 minutes
let _mcRiskGate = { maxDD95: 0, sharpe50: 1, blocked: false, lastUpdate: 0 };
const MC_REFRESH_MS = 30 * 60 * 1000; // 30 min
async function refreshMonteCarloRiskGate() {
    try {
        const mc = await import('./services/monteCarloService.js');
        const tradeHistory = cbExportState()?.tradeHistory || [];
        if (tradeHistory.length < 20) { _mcRiskGate.blocked = false; return; }
        const result = mc.runMonteCarloSimulation(tradeHistory, 300, portfolio.cash + Object.values(portfolio.positions).reduce((s, p) => s + p.quantity * ((p.currentPrice || p.openPrice) || 0), 0));
        if (result) {
            _mcRiskGate.maxDD95 = result.maxDrawdownCI?.p95 || 0;
            _mcRiskGate.sharpe50 = result.sharpeCI?.p50 || 1;
            // Block new entries if worst-case drawdown > 25% OR Sharpe is very poor
            _mcRiskGate.blocked = _mcRiskGate.maxDD95 > 25 || _mcRiskGate.sharpe50 < 0.3;
            _mcRiskGate.lastUpdate = Date.now();
            if (_mcRiskGate.blocked) {
                console.log(`[MC-RISK] Entries BLOCKED: p95 MaxDD=${_mcRiskGate.maxDD95.toFixed(1)}%, Sharpe=${_mcRiskGate.sharpe50.toFixed(2)}`);
            }
        }
    } catch (e) { /* fail open — no Monte Carlo data = no gate */ }
}
// Fix #23 (Tier 3): MTF data cache to avoid redundant REST calls
let _mtfCache5m = { data: null, ts: 0 };
let _mtfCache15m = { data: null, ts: 0 };
let _mtfCache1h = { data: null, ts: 0 };
let _mtfCache4h = { data: null, ts: 0 };
let _mtfCache1d = { data: null, ts: 0 };
async function tradingBotLoop() {
    if (!botState.isActive) return;
    if (botLoopRunning) return; // prevent overlapping async iterations
    botLoopRunning = true;
    botLoopStartTime = Date.now();

    try {
        // Defensive: ensure botLoopRunning is ALWAYS cleared, even on unexpected errors.
        // The finally block below handles this, but we also have the watchdog as a safety net.
        const _boostEntryMultipliers = {}; // Per-ticker position size boosts from BOOST_ENTRY regime transitions
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
        // Merge QUALITY_TICKERS with any newly detected listings
        const newCoinTickers = getActiveNewListings ? getActiveNewListings().map(n => n.ticker).filter(t => !QUALITY_TICKERS.includes(t)) : [];

        // Fetch CoinGecko trending coins and add Kraken-available USD pairs to ticker pool
        let trendingCoinsList = [];
        try {
            trendingCoinsList = await fetchCoinGeckoTrending();
        } catch (e) { /* fail open */ }
        const trendingTickers = trendingCoinsList
            .map(c => `${(c.symbol || '').toUpperCase()}USD`)
            .filter(t => t.length > 3 && !QUALITY_TICKERS.includes(t) && !newCoinTickers.includes(t));

        const tickerPool = [...QUALITY_TICKERS, ...newCoinTickers, ...trendingTickers].slice(0, 75);
        const BATCH_SIZE = 20;
        const cycleIndex = Math.floor(Date.now() / 1000) % Math.max(1, Math.ceil(tickerPool.length / BATCH_SIZE));
        const regularBatch = tickerPool.slice(cycleIndex * BATCH_SIZE, (cycleIndex + 1) * BATCH_SIZE);

        // Phase 3A: Hot tickers (velocity > 0.2%/min or recent volume burst) are scanned FIRST every iteration
        const hotTickerArray = [...hotTickers].filter(t => !positionTickers.includes(t));
        const scanBatch = [...new Set([...hotTickerArray, ...regularBatch])];

        const tickersToFetch = [...new Set([...positionTickers, ...scanBatch])];

        // Auto-subscribe scan batch to WebSocket so future loops use WS buffer
        if (wsConnected()) wsSubscribeTickers(tickersToFetch);

        const allMarketData = await getMultipleMarketData(tickersToFetch);

        // Create a lookup map
        const marketDataMap = new Map();
        let wsHits = 0, restHits = 0;
        for (const { ticker, candles, error, source } of allMarketData) {
            // New listings: lower candle requirement from 30 to 15 (enough for basic RSI/volume)
            const minCandles = (isNewListing && isNewListing(ticker)) ? 15 : CONFIG.MIN_CANDLES_REQUIRED;
            if (!error && candles && candles.length >= minCandles) {
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

        // --- FLASH CRASH PROTECTION ---
        const flashCrashBlocking = checkFlashCrash(marketDataMap);

        // C5: Periodic position reconciliation (every 2 hours)
        if (positionReconciler && botState.sessionId) {
            if (!botState._lastReconcileTime) botState._lastReconcileTime = Date.now();
            if (Date.now() - botState._lastReconcileTime > 2 * 60 * 60 * 1000) {
                botState._lastReconcileTime = Date.now();
                try {
                    const recon = await positionReconciler.reconcilePositions(portfolio, botState.sessionId);
                    if (recon.reconciled && recon.actionsRequired.length > 0) {
                        if (botState.tradingMode === 'SIMULATION') {
                            addLog(`[RECONCILE] Found ${recon.actionsRequired.length} issues (log-only in SIM)`, 'INFO');
                        } else {
                            const fixes = positionReconciler.autoFixReconciliation(portfolio, recon, addLog);
                            addLog(`[RECONCILE] Applied ${fixes.actionsCount} fixes`, 'WARN');
                        }
                    }
                } catch (e) {}
            }
        }

        // C8: Candle gap validation — skip tickers with stale data
        for (const [ticker, candles] of marketDataMap) {
            if (candles.length < 3) continue;
            const lastCandle = candles[candles.length - 1];
            const prevCandle = candles[candles.length - 2];
            if (lastCandle.t && prevCandle.t) {
                const expectedInterval = prevCandle.t && candles.length >= 3
                    ? (candles[candles.length - 2].t - candles[candles.length - 3].t)
                    : 60000; // default 1m
                const actualGap = lastCandle.t - prevCandle.t;
                if (actualGap > expectedInterval * 2 && expectedInterval > 0) {
                    marketDataMap.delete(ticker);
                    if (Math.random() < 0.1) {
                        addLog(`[CANDLE-GAP] ${ticker}: gap ${(actualGap / 60000).toFixed(1)}min (expected ${(expectedInterval / 60000).toFixed(1)}min) — skipping stale data`, 'WARN');
                    }
                }
            }
        }

        // --- MAX DRAWDOWN CHECK (beastMode) ---
        let maxDrawdownBlocking = false;
        try {
            const ddCheck = checkMaxDrawdown(15);
            if (ddCheck.shouldStop) {
                maxDrawdownBlocking = true;
                if (Math.random() < 0.05) addLog(ddCheck.reason, 'WARN');
            }
        } catch (e) {}

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

            // Rug-pull protection for new coin positions
            if (isNewListing && isNewListing(position.ticker)) {
                const rules = getNewCoinRules();
                const holdDays = (Date.now() - position.entryTime) / (1000 * 60 * 60 * 24);

                // Force exit after max hold days
                if (holdDays >= rules.maxHoldDays) {
                    await handleSell(position, currentPrice, `NEW_COIN_MAX_HOLD (${rules.maxHoldDays} days)`);
                    continue;
                }

                // Check rug-pull signals
                if (updateNewCoinSignals) {
                    const signalData = updateNewCoinSignals(position.ticker, currentPrice, 0);
                    if (signalData?.shouldExitRugPull) {
                        await handleSell(position, currentPrice, `RUG_PULL_DETECTED (score: ${signalData.rugPullScore})`);
                        if (markRugPullExit) markRugPullExit(position.ticker);
                        continue;
                    }
                }
            }

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
                    case 'SWING':
                    case 'MA_CROSSOVER':
                    case 'MEAN_REVERSION':
                    case 'REVERSAL':
                    case 'RANGE':
                    case 'VWAP':
                    default: {
                        // Fallback: use ADAPTIVE TC + momentum combined check
                        const adpFallback = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                        if (adpFallback > CONFIG.THRESHOLDS.ADAPTIVE_BEARISH_EXIT && momentumValue < CONFIG.THRESHOLDS.MOMENTUM_BEARISH_EXIT)
                            exitReason = `${position.entryStrategy} Signal: Bearish adaptive+momentum`;
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

        // Regime transition Telegram alert
        if (!botState._lastRegime) botState._lastRegime = currentRegime;
        if (currentRegime !== botState._lastRegime && currentRegime !== 'UNKNOWN' && botState._lastRegime !== 'UNKNOWN') {
            addLog(`[REGIME] Transition: ${botState._lastRegime} → ${currentRegime}`, 'INFO');
            if (telegramEnabled()) {
                alertRegimeTransition(botState._lastRegime, currentRegime);
            }
            botState._lastRegime = currentRegime;
        } else if (currentRegime !== 'UNKNOWN') {
            botState._lastRegime = currentRegime;
        }

        // Update circuit breaker with current regime for adaptive thresholds
        if (currentRegime !== 'UNKNOWN') {
            cbSetRegime(currentRegime);
        }

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

        // Monte Carlo risk gate: refresh every 30 minutes, block entries if tail risk is too high
        if (Date.now() - _mcRiskGate.lastUpdate > MC_REFRESH_MS) {
            refreshMonteCarloRiskGate(); // fire-and-forget (async, won't block loop)
        }
        let mcRiskBlocking = false;
        if (_mcRiskGate.blocked && botState.tradingMode !== 'SIMULATION') {
            mcRiskBlocking = true;
            logThought({ type: 'SKIP', ticker: '', action: 'MC_RISK_GATE',
                confidence: 0,
                reason: `Monte Carlo risk gate: p95 MaxDD=${_mcRiskGate.maxDD95.toFixed(1)}%, Sharpe=${_mcRiskGate.sharpe50.toFixed(2)} — new entries blocked`,
                regime: currentRegime });
        }

        // Derive entry thresholds from timeframe profile, then overlay optimizer + adaptive values
        const optParams = getOptimizedEntryParams();
        // Overlay adaptive thresholds (learned from trade outcomes) if available
        if (adaptiveThresholdsService?.getThreshold) {
            try {
                const adaptiveTrendEntry = adaptiveThresholdsService.getThreshold('TREND_BULLISH_ENTRY');
                if (adaptiveTrendEntry != null) optParams.TREND_BULLISH_ENTRY = adaptiveTrendEntry;
                const adaptiveFloor = adaptiveThresholdsService.getThreshold('compositeScoreFloor');
                if (adaptiveFloor != null) optParams.compositeScoreFloor = adaptiveFloor;
            } catch (e) { /* fall through to optimizer defaults */ }
        }
        // Regime-adaptive entry thresholds: lower bar in strong trends, higher bar in choppy markets
        const regimeScoreFloors = {
            'STRONG_UP': 40,   // Ride the wave — accept weaker signals
            'UP': 45,          // Standard bullish
            'SIDEWAYS': 60,    // High conviction needed — choppy kills profits
            'DOWN': 55,        // Only strong setups in bearish markets
            'STRONG_DOWN': 65, // Very selective — most entries lose here
            'UNKNOWN': 50,     // Conservative default
        };
        const baseMinOppScore = activeProfile?.entry?.minOpportunityScore ?? optParams.minOpportunityScore;
        const regimeFloor = regimeScoreFloors[currentRegime] || 50;
        const minOppScore = Math.max(baseMinOppScore, regimeFloor);
        const profileStrategies = activeProfile?.activeStrategies || null;
        const profilePosSize = activeProfile?.positionSizePercent ?? null;

        const openSlots = maxConcurrentTrades - Object.keys(portfolio.positions).length;
        if (openSlots > 0 && portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && !flashCrashBlocking && !maxDrawdownBlocking && !mcRiskBlocking && (botState.tradingMode === 'SIMULATION' || drawdown <= tier.maxDrawdownLimit)) {

            // Calculate Opportunity Scores for current batch (with liquidity filter)
            const candidates = [];
            for (const ticker of scanBatch) {
                if (portfolio.positions[ticker]) continue;
                const candles = marketDataMap.get(ticker);
                if (!candles) continue;

                // Liquidity gate: skip low-volume garbage tokens
                const liq = checkLiquidity(candles, ticker);
                if (!liq.pass) {
                    continue; // silently skip — too many low-vol tickers to log each one
                }

                // Phase 4A: Pass surge context to volume scoring
                const _surgeOpts = {};
                if (getFlag('SNIPER_MODE_ENABLED')) {
                    const _vel = priceVelocityTracker.getMetrics(ticker);
                    if (_vel.velocity > 0.3) _surgeOpts.surgeActive = true;
                    if (microBurstDetector.recentBurst(ticker)) _surgeOpts.microBurstActive = true;
                }
                const score = calculateOpportunityScore(candles, ticker, _surgeOpts);
                // Per-ticker cooldown raises threshold after consecutive losses
                const tickerCooldownAdj = tickerLossCooldown.getScoreAdjustment(ticker);
                let tickerMinScore = minOppScore + tickerCooldownAdj;

                // Phase 1A: Velocity-triggered entry acceleration
                // If velocity > 0.5%/min AND acceleration > 0: reduce minOppScore by 15-25 points
                // Guard: only in non-bearish regimes
                let sniperCandidate = false;
                if (getFlag('SNIPER_MODE_ENABLED')) {
                    const vel = priceVelocityTracker.getMetrics(ticker);
                    const microBurst = microBurstDetector.isMicroBurst(ticker);
                    const isBearish = currentRegime === 'DOWN' || currentRegime === 'STRONG_DOWN';

                    if (!isBearish && vel.tickCount >= 5) {
                        if (vel.velocity > 0.5 && vel.acceleration > 0) {
                            tickerMinScore -= 20; // Strong surge — aggressive entry
                            sniperCandidate = true;
                        } else if (vel.velocity > 0.3 && vel.acceleration >= 0) {
                            tickerMinScore -= 10; // Moderate surge
                            sniperCandidate = true;
                        }
                    }
                    if (!isBearish && microBurst.burst) {
                        tickerMinScore -= 15; // Micro volume burst — fast entry
                        sniperCandidate = true;
                    }
                    tickerMinScore = Math.max(25, tickerMinScore); // Floor: never go below 25
                }

                if (score.compositeScore > tickerMinScore) candidates.push({ ticker, score, candles, sniperCandidate });

                // === SWING STRATEGY: 4h + 1D candle fetch and evaluation ===
                const now4h = Date.now();
                // 4h candles for swing trading (cache 3 hours)
                let candles4h = _mtfCache4h.data;
                if (!candles4h || (now4h - _mtfCache4h.ts) > 180 * 60 * 1000) {
                  try {
                    candles4h = await getMarketData(ticker, '4h', 100) || [];
                    _mtfCache4h = { data: candles4h, ts: now4h };
                  } catch (err) { candles4h = []; }
                }

                // 1D candles for swing trading (cache 12 hours)
                let candles1d = _mtfCache1d.data;
                if (!candles1d || (now4h - _mtfCache1d.ts) > 720 * 60 * 1000) {
                  try {
                    candles1d = await getMarketData(ticker, '1D', 100) || [];
                    _mtfCache1d = { data: candles1d, ts: now4h };
                  } catch (err) { candles1d = []; }
                }

                if (candles4h && candles4h.length >= 20 && candles1d && candles1d.length >= 20) {
                  try {
                    const swing4h = candles4h.slice(-20);
                    const swing1d = candles1d.slice(-20);

                    // Simple EMA crossover on 4h
                    const closes4h = swing4h.map(c => c.c || c.close);
                    const ema20 = closes4h.slice(-20).reduce((s, v) => s + v, 0) / 20;
                    const ema10 = closes4h.slice(-10).reduce((s, v) => s + v, 0) / 10;

                    // Daily trend
                    const dailyCloses = swing1d.map(c => c.c || c.close);
                    const dailyTrend = dailyCloses[dailyCloses.length - 1] > dailyCloses[dailyCloses.length - 5] ? 'UP' : 'DOWN';

                    // Volume breakout on 4h
                    const vols4h = swing4h.map(c => c.v || c.volume || 0);
                    const avgVol = vols4h.slice(-10).reduce((s, v) => s + v, 0) / 10;
                    const latestVol = vols4h[vols4h.length - 1];
                    const volumeBreakout = avgVol > 0 && latestVol > avgVol * 1.5;

                    let swingScore = 0;
                    if (ema10 > ema20) swingScore += 30;
                    if (dailyTrend === 'UP') swingScore += 30;
                    if (volumeBreakout) swingScore += 20;

                    // Basic RSI check on 4h (simple calculation)
                    const gains = [], losses = [];
                    for (let i = 1; i < closes4h.length; i++) {
                      const diff = closes4h[i] - closes4h[i - 1];
                      gains.push(diff > 0 ? diff : 0);
                      losses.push(diff < 0 ? -diff : 0);
                    }
                    const avgGain = gains.slice(-14).reduce((s, v) => s + v, 0) / 14;
                    const avgLoss = losses.slice(-14).reduce((s, v) => s + v, 0) / 14;
                    const rsi4h = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
                    if (rsi4h > 30 && rsi4h < 70) swingScore += 20;

                    if (swingScore >= 65) {
                      candidates.push({
                        ticker,
                        strategy: 'SWING',
                        score: { compositeScore: swingScore / 100, confidence: swingScore },
                        candles: candles4h,
                        tradeType: 'SWING',
                        swingParams: {
                          stopLoss: -0.06,
                          takeProfit: 0.20,
                          maxHoldHours: 14 * 24,
                          trailingStart: 0.12,
                          trailingGiveBack: 0.15,
                        },
                      });
                    }
                  } catch (swingErr) {
                    // Non-critical — swing evaluation error
                  }
                }
            }

            candidates.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

            // --- SENTIMENT ENRICHMENT (Tiered) ---
            // Tier 1 (ALL candidates): CryptoPanic news + CoinGecko trending (1 global call each, cached)
            // Tier 2 (top 10):         Reddit + YouTube per-ticker sentiment (rate-limited, cached 5min)
            const sentimentCache = new Map();
            let globalNews = [];
            try {
                // Tier 1: Fetch global news once, then filter per-ticker locally
                // Use localNLPService for deeper headline analysis if available
                globalNews = await fetchCryptoNews();
                for (const candidate of candidates) {
                    let newsScore = 0;
                    let sources = 0;

                    // Try NLP-enhanced scoring first (negation detection, intensity weighting)
                    if (localNLPService?.scoreHeadlinesForTicker) {
                        try {
                            const headlines = globalNews.map(n => n.title);
                            const nlpResult = localNLPService.scoreHeadlinesForTicker(headlines, candidate.ticker.replace(/USD$/, ''));
                            if (nlpResult.count > 0) {
                                newsScore = nlpResult.score * 0.40; // NLP score is already -1..1
                                sources = 0.40;
                            }
                        } catch (e) { /* fall through to basic matching */ }
                    }

                    // Fallback: basic string matching if NLP didn't find anything
                    if (sources === 0) {
                        const tickerSentiment = getTickerNewsSentiment(candidate.ticker, globalNews);
                        newsScore = tickerSentiment.sentiment * 0.40;
                        sources = tickerSentiment.mentionCount > 0 ? 0.40 : 0;
                    }

                    // CoinGecko trending boost: +5 pts normalized to sentiment scale
                    if (isTrendingCoin(candidate.ticker, trendingCoinsList)) {
                        newsScore += 0.10; // small bullish boost for trending coins
                        sources += 0.10;
                        candidate._trending = true;
                    }

                    if (sources > 0) {
                        sentimentCache.set(candidate.ticker, newsScore / sources);
                        sentimentCachePersistent.set(candidate.ticker, { score: newsScore / sources, timestamp: Date.now() });
                    }
                }
            } catch (e) { /* fail open — news sentiment defaults to 0 */ }

            try {
                // Tier 2: Reddit + YouTube for top 10 candidates (expanded from 5)
                const topTickers = candidates.slice(0, 10).map(c => c.ticker);
                const now = Date.now();
                const tickersToFetchSentiment = [];

                for (const ticker of topTickers) {
                    const cached = sentimentCachePersistent.get(ticker);
                    if (cached && (now - cached.timestamp) < SENTIMENT_CACHE_TTL_MS) {
                        // Merge cached Reddit/YouTube with existing news sentiment
                        const existing = sentimentCache.get(ticker) || 0;
                        sentimentCache.set(ticker, (existing + cached.score) / 2);
                    } else {
                        tickersToFetchSentiment.push(ticker);
                    }
                }

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
                            const redditYtScore = sources > 0 ? score / sources : 0;
                            // Blend Reddit/YouTube with existing news sentiment
                            const existing = sentimentCache.get(ticker) || 0;
                            const blended = existing !== 0 ? (existing * 0.4 + redditYtScore * 0.6) : redditYtScore;
                            return { ticker, sentiment: blended };
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

            // C4: Pre-fetch ML advice in parallel for top 10 candidates (reduces ~10s → ~2s)
            const _mlAdviceCache = new Map();
            if (mlPredictionService?.getMLAdvice && candidates.length > 0) {
                try {
                    const top10 = candidates.slice(0, 10);
                    const mlPromises = top10.map(async (cand) => {
                        try {
                            const mlOpts = { marketRegime: currentRegime, lastTradeTime: botState.lastTradeTime || 0 };
                            try {
                                if (derivativesIntel) {
                                    const sig = derivativesIntel.getDerivativesSignal(cand.ticker);
                                    if (sig) mlOpts.derivativesData = sig;
                                }
                                if (fearGreedGate) {
                                    const fgi = fearGreedGate.getFearGreedIndex?.();
                                    mlOpts.sentimentData = { fearGreedIndex: fgi?.value || 50 };
                                }
                                if (orderBookMicro) {
                                    const analysis = orderBookMicro.getAnalysis?.(cand.ticker);
                                    if (analysis) mlOpts.exchangeSnapshot = { bidAskImbalance: analysis.bidAskImbalance || 0, spreadBps: analysis.spreadBps || 0 };
                                }
                            } catch (e) {}
                            const advice = await mlPredictionService.getMLAdvice(cand.ticker, cand.candles, mlOpts);
                            return { ticker: cand.ticker, advice };
                        } catch (e) {
                            return { ticker: cand.ticker, advice: { available: false, direction: null, confidence: 0 } };
                        }
                    });
                    const results = await Promise.allSettled(mlPromises);
                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value) {
                            _mlAdviceCache.set(r.value.ticker, r.value.advice);
                        }
                    }
                } catch (e) {}
            }

            for (const candidate of candidates) {
                if (maxConcurrentTrades - Object.keys(portfolio.positions).length <= 0) break;
                if (portfolio.cash < CONFIG.MIN_TRADE_SIZE) break;

                const { ticker, score, candles, sniperCandidate } = candidate;
                const currentPrice = candles[candles.length - 1].c;

                // ═══ PER-TICKER INDICATOR CACHE ═══
                // Compute all indicators ONCE and reuse throughout entry evaluation + ML pipeline
                const tcValue = calculateTCSeries(candles).pop() ?? 50;
                const _cachedMom = calculateMomentumSeries(candles).pop() ?? 50;
                const _cachedTrendDash = calculateTrendDashboard(candles);
                const _cachedBullishCount = _cachedTrendDash ? Object.values(_cachedTrendDash).filter(v => v === true || v === 'BULLISH' || v === 'UP').length : 0;

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

                    // Phase 1C: Dynamic TC threshold relaxation during surges
                    let trendEntryThreshold = optParams.TREND_BULLISH_ENTRY;
                    if (sniperCandidate && getFlag('SNIPER_MODE_ENABLED')) {
                        const vel = priceVelocityTracker.getMetrics(ticker);
                        const microBurst = microBurstDetector.isMicroBurst(ticker);
                        if (microBurst.burst) {
                            trendEntryThreshold = 50; // Micro burst: relax to TC < 50
                        } else if (vel.velocity > 0.3) {
                            trendEntryThreshold = 40; // Active surge: relax to TC < 40
                        }
                        // Tighten back when velocity drops
                        if (vel.velocity < 0.1) trendEntryThreshold = optParams.TREND_BULLISH_ENTRY;
                    }
                    if (profileStrategies.includes('TREND') && tcValue < trendEntryThreshold) {
                        // TREND: lower = more bullish, strength = how far below threshold
                        const strength = (trendEntryThreshold - tcValue) / trendEntryThreshold;
                        stratCandidates.push({ strategy: 'TREND', value: tcValue, strength, sniperEntry: sniperCandidate && trendEntryThreshold > optParams.TREND_BULLISH_ENTRY });
                    }
                    if (profileStrategies.includes('MOMENTUM')) {
                        if (_cachedMom > optParams.MOMENTUM_BULLISH_ENTRY) {
                            const strength = (_cachedMom - optParams.MOMENTUM_BULLISH_ENTRY) / (100 - optParams.MOMENTUM_BULLISH_ENTRY);
                            stratCandidates.push({ strategy: 'MOMENTUM', value: _cachedMom, strength });
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
                    // CONFLUENCE: multiple bullish signals aligned (reuse cached trendDashboard)
                    if (profileStrategies.includes('CONFLUENCE')) {
                        const bullishCount = _cachedBullishCount;
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
                            // Apply backtest penalty if continuous backtester shows poor win rate
                            const backtestPenalty = continuousBacktester?.getStrategyPenalty
                                ? continuousBacktester.getStrategyPenalty(cand.strategy) : 0;
                            cand.blendedScore = (cand.strength * 0.6 + adaptiveWeight * 0.4) * (1 - backtestPenalty);
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

                // New coin momentum signal: allow entry even without a clean TREND signal
                // if the new listing shows strong initial momentum (price up >5%, volume increasing)
                if (!entryStrategy && isNewListing && isNewListing(ticker) && candles.length >= 10) {
                    const firstPrice = candles[0].c;
                    const priceGain = (currentPrice - firstPrice) / firstPrice;
                    // Check volume is increasing over last 5 candles
                    const recentVols = candles.slice(-5).map(c => c.v || 0);
                    const volIncreasing = recentVols.length >= 3 && recentVols[recentVols.length - 1] > recentVols[0];

                    if (priceGain > 0.05 && volIncreasing) {
                        entryStrategy = 'TREND'; // Use TREND strategy for exit logic
                        triggerValue = tcValue;
                        logThought({ type: 'ENTRY_EVAL', ticker, action: 'NEW_COIN_MOMENTUM',
                            confidence: score.compositeScore,
                            reason: `New listing momentum: +${(priceGain * 100).toFixed(1)}% gain, volume rising → TREND entry`,
                            regime: currentRegime });
                    }
                }

                // Cap new coin concurrent positions to 1 to limit exposure
                if (entryStrategy && isNewListing && isNewListing(ticker)) {
                    const existingNewCoinPositions = Object.keys(portfolio.positions)
                        .filter(t => isNewListing(t)).length;
                    if (existingNewCoinPositions >= 1) {
                        logThought({ type: 'SKIP', ticker, action: 'NEW_COIN_CAP',
                            confidence: score.compositeScore,
                            reason: `Already holding ${existingNewCoinPositions} new coin position(s) — max 1 allowed`,
                            regime: currentRegime });
                        entryStrategy = null;
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

                // Tier 1A: Derivatives Intelligence entry gate
                let derivativesAdj = 0;
                let oiSurgeBreakout = false;
                if (entryStrategy && derivativesIntel) {
                    try {
                        const derivBlock = derivativesIntel.shouldBlockLongEntry(ticker);
                        if (derivBlock.block) {
                            logThought({ type: 'SKIP', ticker, action: 'DERIVATIVES_BLOCKED',
                                confidence: score.compositeScore,
                                reason: derivBlock.reason,
                                regime: currentRegime });
                            entryStrategy = null;
                        }
                        // Add ALL 5 derivatives ML features to confidence scoring (was only [0] and [4])
                        const derivFeatures = derivativesIntel.getDerivativesMLFeatures(ticker);
                        // [0] Negative funding (shorts paying longs) = bullish
                        if (derivFeatures[0] < -0.2) derivativesAdj += 5;
                        else if (derivFeatures[0] > 0.5) derivativesAdj -= 3; // Longs overleveraged
                        // [1] OI change: rising OI in uptrend = new money, falling OI = exodus
                        if (derivFeatures[1] > 0.05 && currentRegime.includes('UP')) derivativesAdj += 3;
                        else if (derivFeatures[1] < -0.1) derivativesAdj -= 4;
                        // [2] OI-price divergence: OI up + price down = bearish (strongest signal)
                        if (derivFeatures[2] > 0.3) derivativesAdj -= 6;
                        else if (derivFeatures[2] < -0.3) derivativesAdj += 4; // Short squeeze setup
                        // [3] Long/short ratio: extreme long bias = crowded → contrarian bearish
                        if (derivFeatures[3] > 0.3) derivativesAdj -= 3;
                        else if (derivFeatures[3] < -0.3) derivativesAdj += 3; // Heavy shorts = squeeze
                        // [4] Liquidation imbalance: short liq = bullish squeeze, long liq = cascade
                        if (derivFeatures[4] < -0.5) derivativesAdj += 3;
                        else if (derivFeatures[4] > 0.5) derivativesAdj -= 3;

                        // Cascade risk entry gate — block longs during active liquidation cascades
                        if (entryStrategy) {
                            const cascade = derivativesIntel.predictCascadeRisk(ticker);
                            if (cascade.risk === 'CRITICAL' || (cascade.risk === 'HIGH' && cascade.score > 70)) {
                                logThought({ type: 'SKIP', ticker, action: 'CASCADE_RISK_BLOCKED',
                                    confidence: score.compositeScore,
                                    reason: `Cascade risk ${cascade.risk} (score=${cascade.score}): ${cascade.factors?.join(', ') || 'multiple factors'}`,
                                    regime: currentRegime });
                                entryStrategy = null;
                            } else if (cascade.risk === 'HIGH') {
                                derivativesAdj -= 8; // Strong penalty but don't block
                            }
                        }
                        // OI surge breakout confirmation — rising OI confirms real money behind breakouts
                        if (entryStrategy && derivFeatures[1] > 0.10) {
                            oiSurgeBreakout = true; // 15% size boost applied later in sizing section
                            derivativesAdj += 4; // OI surge = strong conviction signal
                        }
                    } catch (e) {}
                }

                // Tier 1B: Fear & Greed entry gate
                let fearGreedAdj = 0;
                let fearGreedSizeMultiplier = 1.0;
                if (fearGreedGate) {
                    try {
                        const fgBlock = fearGreedGate.shouldBlockEntry();
                        if (fgBlock.block && entryStrategy) {
                            logThought({ type: 'SKIP', ticker, action: 'FEAR_GREED_BLOCKED',
                                confidence: score.compositeScore,
                                reason: fgBlock.reason,
                                regime: currentRegime });
                            entryStrategy = null;
                        }
                        // Scale position size by fear/greed multiplier
                        fearGreedSizeMultiplier = fearGreedGate.getPositionMultiplier();
                        // Extreme fear is bullish for entries
                        const fgIndex = fearGreedGate.getFearGreedIndex();
                        if (fgIndex <= 20) fearGreedAdj += 8;
                        else if (fgIndex <= 35) fearGreedAdj += 3;
                        else if (fgIndex >= 80) fearGreedAdj -= 8;
                        else if (fgIndex >= 65) fearGreedAdj -= 3;
                    } catch (e) {}
                }

                // ═══ COMPOSITE MACRO SIGNAL — Sentiment × Derivatives interaction ═══
                // The highest-alpha setup is when both F&G and funding agree on direction
                let macroCompositeAdj = 0;
                if (entryStrategy && fearGreedGate && derivativesIntel) {
                    try {
                        const fgIndex = fearGreedGate.getFearGreedIndex?.() || 50;
                        const derivSignal = derivativesIntel.getDerivativesSignal?.(ticker.replace('USD', ''));
                        const fundingAPR = derivSignal?.fundingRateAnnualized || 0;

                        // Extreme Fear + negative/low funding = market panic + shorts paying = STRONG BUY
                        if (fgIndex <= 25 && fundingAPR < 5) {
                            macroCompositeAdj = 12; // Very bullish contrarian setup
                        }
                        // Extreme Greed + very high funding = euphoria + longs overleveraged = STRONG WARNING
                        else if (fgIndex >= 75 && fundingAPR > 30) {
                            macroCompositeAdj = -12; // Very bearish contrarian setup
                            if (fgIndex >= 85 && fundingAPR > 50) {
                                // Nuclear option: block entirely
                                logThought({ type: 'SKIP', ticker, action: 'MACRO_EUPHORIA_BLOCK',
                                    confidence: score.compositeScore,
                                    reason: `F&G=${fgIndex} + Funding=${fundingAPR.toFixed(0)}% APR = extreme euphoria`,
                                    regime: currentRegime });
                                entryStrategy = null;
                            }
                        }
                        // Moderate agreement amplification
                        else if (fgIndex <= 40 && fundingAPR < 10) macroCompositeAdj = 5; // Mild fear + low funding
                        else if (fgIndex >= 60 && fundingAPR > 25) macroCompositeAdj = -5; // Mild greed + high funding
                    } catch (e) {}
                }

                // Volume burst signal: buy-side volume spike = breakout confirmation
                let volumeBurstAdj = 0;
                try {
                    const burstSignal = getVolumeBurstSignal(ticker);
                    if (burstSignal.burst) {
                        volumeBurstAdj = 5; // +5 confidence for volume burst
                    }
                } catch (e) { /* non-critical */ }

                // Phase 1B: Micro volume burst injection (+15 pts)
                let microBurstAdj = 0;
                if (getFlag('SNIPER_MODE_ENABLED')) {
                    try {
                        const microBurst = microBurstDetector.isMicroBurst(ticker);
                        if (microBurst.burst) {
                            microBurstAdj = 15;
                            addLog(`[MICRO-BURST] ${ticker}: volume ratio ${microBurst.ratio.toFixed(1)}x — +15 confidence`, 'INFO');
                        }
                    } catch (e) { /* non-critical */ }
                }

                // Phase 3C: Regime transition boost (decaying +20 over 5 minutes)
                let regimeBoostAdj = 0;
                if (getFlag('SNIPER_MODE_ENABLED')) {
                    try {
                        const perTickerRegime = score.regime || currentRegime;
                        regimeBoostAdj = regimeTransitionBoost.checkTransition(ticker, perTickerRegime);
                        if (regimeBoostAdj >= 5) {
                            addLog(`[REGIME-BOOST] ${ticker}: +${regimeBoostAdj} pts from bullish transition`, 'INFO');
                        }
                    } catch (e) { /* non-critical */ }
                }

                // Price velocity confirmation: positive velocity + acceleration = momentum entry
                let velocityAdj = 0;
                try {
                    const vel = priceVelocityTracker.getMetrics(ticker);
                    if (vel.tickCount >= 5) {
                        // Strong positive velocity = price moving up fast = momentum confirmation
                        if (vel.velocity > 0.2 && vel.acceleration > 0) velocityAdj += 5;
                        else if (vel.velocity > 0.5 && vel.acceleration > 0.1) velocityAdj += 8;
                        // Negative velocity = price dropping = caution
                        else if (vel.velocity < -0.3) velocityAdj -= 5;
                        // Sharp deceleration from positive = momentum fading
                        else if (vel.velocity > 0 && vel.acceleration < -0.2) velocityAdj -= 3;
                    }
                } catch (e) { /* non-critical */ }

                // Signal scanner multi-timeframe confirmation
                let scannerAdj = 0;
                if (_signalScannerRef && entryStrategy) {
                    try {
                        const scanResults = _signalScannerRef.getScanResults();
                        const tickerScan = scanResults?.[ticker];
                        if (tickerScan?.combined) {
                            const totalScore = tickerScan.combined.totalScore || 0;
                            if (totalScore >= 20) scannerAdj += 10;
                            else if (totalScore >= 10) scannerAdj += 5;
                            else if (totalScore <= -15) scannerAdj -= 8;
                            else if (totalScore <= -5) scannerAdj -= 3;
                        }
                    } catch (e) {}
                }

                // Tier 2A: VPIN toxic flow gate (orderBookMicrostructure)
                if (entryStrategy && orderBookMicro) {
                    try {
                        const vpin = orderBookMicro.getVPIN(ticker);
                        if (vpin > 0.7) {
                            logThought({ type: 'SKIP', ticker, action: 'VPIN_TOXIC',
                                confidence: score.compositeScore,
                                reason: `VPIN=${vpin.toFixed(3)} > 0.7 — informed trading detected, blocking entry`,
                                regime: currentRegime });
                            entryStrategy = null;
                        } else if (vpin > 0.5) {
                            // Moderate toxicity — reduce position by 30%
                            fearGreedSizeMultiplier *= 0.70;
                        }
                    } catch (e) { /* fail open */ }
                }

                // Tier 3B: Liquidation Sweep entry boost
                let sweepAdj = 0;
                if (liquidationSweep && candles) {
                    try {
                        const sweep = liquidationSweep.detectLiquidationSweep(ticker, candles);
                        if (sweep.sweep && sweep.direction === 'LONG') {
                            sweepAdj += Math.round(sweep.confidence * 0.15); // Up to +14 pts
                            if (!entryStrategy) entryStrategy = 'TREND'; // Re-enable entry on sweep
                        }
                    } catch (e) {}
                }

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
                // C4: Use pre-fetched ML advice from parallel cache when available
                let mlAdvice = _mlAdviceCache.get(ticker) || { available: false, direction: null, confidence: 0 };
                let mlSizeMultiplier = 1.0;
                if (entryStrategy && mlPredictionService?.getMLAdvice && !mlAdvice.available) {
                    try {
                        // Fallback: fetch inline if not in cache (e.g., candidate wasn't in top 10)
                        const mlOptions = {};
                        try {
                            if (derivativesIntel) {
                                const sig = derivativesIntel.getDerivativesSignal(ticker);
                                if (sig) mlOptions.derivativesData = sig;
                            }
                            if (fearGreedGate) {
                                const fgi = fearGreedGate.getFearGreedIndex?.();
                                mlOptions.sentimentData = {
                                    fearGreedIndex: fgi?.value || 50,
                                    fearGreedClassification: fgi?.classification || 'Neutral',
                                    newsSentiment: sentimentCache.get(ticker) || 0,
                                };
                            }
                            if (orderBookMicro) {
                                const vpin = orderBookMicro.getVPIN?.(ticker);
                                const analysis = orderBookMicro.getAnalysis?.(ticker);
                                mlOptions.exchangeSnapshot = {
                                    vpin: vpin || 0,
                                    bidAskImbalance: analysis?.bidAskImbalance || 0,
                                    weightedImbalance: analysis?.weightedImbalance || 0,
                                    spreadBps: analysis?.spreadBps || 0,
                                };
                            }
                            if (whaleFlowTracker) {
                                const flow = whaleFlowTracker.getFlowSignal?.(ticker.replace('USD', ''));
                                if (flow) mlOptions.onChainData = flow;
                            }
                            try {
                                const defi = getLatestDeFiSnapshot?.();
                                if (defi) mlOptions.defiData = typeof defi === 'string' ? JSON.parse(defi) : defi;
                            } catch (e) {}
                            mlOptions.marketRegime = currentRegime;
                            mlOptions.lastTradeTime = botState.lastTradeTime || 0;
                        } catch (enrichErr) { /* fail open */ }

                        mlAdvice = await mlPredictionService.getMLAdvice(ticker, candles, mlOptions);
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
                    // Reuse cached indicators (computed once at top of candidate loop)
                    const momValue = _cachedMom;
                    const bkoutValue = calculateBreakoutDetectorSeries(candles).pop() ?? 50; // Not cached (scaled per-asset)
                    const adpValue = calculateAdaptiveTCSeries(candles).pop() ?? 50;
                    const whaleValue = calculateWhaleMoneyFlowSeries(candles).pop() ?? 50; // Not cached (scaled per-asset)
                    const trendDash = _cachedTrendDash;
                    const bullishCount = _cachedBullishCount;

                    try {
                        if (getFlag('GENETIC_ENABLED')) {
                            const genPop = getGeneticPopulation();
                            // Compute real indicator values from candles instead of hardcoding
                            const _closes = candles.map(c => c.c);
                            let _rsi = 50, _macdHist = 0, _bbB = 0.5, _atrNorm = 0;
                            if (_closes.length >= 14) {
                                // RSI
                                let gains = 0, losses = 0;
                                for (let i = _closes.length - 14; i < _closes.length; i++) {
                                    const change = _closes[i] - _closes[i - 1];
                                    if (change > 0) gains += change; else losses -= change;
                                }
                                const avgGain = gains / 14, avgLoss = losses / 14;
                                _rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
                            }
                            if (_closes.length >= 26) {
                                // Simple MACD histogram (fast EMA12 - slow EMA26)
                                const slice12 = _closes.slice(-12);
                                const slice26 = _closes.slice(-26);
                                const ema12 = slice12.reduce((a, b) => a + b, 0) / 12;
                                const ema26 = slice26.reduce((a, b) => a + b, 0) / 26;
                                _macdHist = (ema12 - ema26) / (_closes[_closes.length - 1] || 1) * 100;
                            }
                            if (_closes.length >= 20) {
                                // Bollinger %B
                                const bb20 = _closes.slice(-20);
                                const bbMean = bb20.reduce((a, b) => a + b, 0) / 20;
                                const bbStd = Math.sqrt(bb20.reduce((s, v) => s + (v - bbMean) ** 2, 0) / 20);
                                const upper = bbMean + 2 * bbStd, lower = bbMean - 2 * bbStd;
                                _bbB = upper !== lower ? (_closes[_closes.length - 1] - lower) / (upper - lower) : 0.5;
                            }
                            // ATR normalized
                            const atr14 = calculateATRFromCandles(candles, 14);
                            _atrNorm = _closes[_closes.length - 1] > 0 ? (atr14 / _closes[_closes.length - 1]) * 100 : 0;

                            const genIndicators = {
                                tc: tcValue,
                                momentum: momValue,
                                breakout: bkoutValue,
                                adaptive: adpValue,
                                whale: whaleValue,
                                divergence: 0, // Divergence still needs full series — keep 0
                                rsi: _rsi,
                                macd_histogram: _macdHist,
                                bollinger_b: _bbB,
                                volume_ratio: score.volumeRatio || 1,
                                atr_norm: _atrNorm,
                                regime_score: currentRegime === 'UPTREND' || currentRegime === 'STRONG_UP' || currentRegime === 'UP' ? 1 : currentRegime === 'DOWNTREND' || currentRegime === 'DOWN' || currentRegime === 'STRONG_DOWN' ? -1 : 0,
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

                        // Phase 5A: Build surge data for ML features
                        let _surgeMLData = {};
                        try {
                            const _sVel = priceVelocityTracker.getMetrics(ticker);
                            _surgeMLData = {
                                priceVelocity: _sVel.velocity || 0,
                                priceAcceleration: _sVel.acceleration || 0,
                                microBurstActive: microBurstDetector.recentBurst(ticker),
                                candlestickSignal: ((score.factors?.candlestickPattern || 50) - 50) / 50, // normalize 0-100 → -1 to 1
                                surgeType: null, // Populated if surgeTradingBackend detects one
                                barsSinceSurge: 0,
                            };
                        } catch (e) {}

                        pipelineResult = mlGatekeeper.evaluateEntry(
                            ticker, candles, entryStrategy, bestStrength,
                            { strategySignals, geneticSignals, onChainData, marketIntelligence, surgeData: _surgeMLData }
                        );

                        // Record ML prediction for A/B testing (champion vs challenger)
                        if (pipelineResult && mlABTest) {
                            try {
                                const predDirection = pipelineResult.proceed ? 'UP' : 'DOWN';
                                const predConfidence = pipelineResult.confidence || 50;
                                mlABTest.recordPrediction(ticker,
                                    { direction: predDirection, confidence: predConfidence },
                                    null // Challenger prediction filled when challenger exists
                                );
                            } catch (e) { /* non-critical */ }
                        }

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

                // Blocked hours filter (from best seed training + mined patterns)
                if (entryStrategy) {
                    const currentUTCHour = new Date().getUTCHours();
                    // Merge seed-based blocked hours with mined blocked hours
                    const seedBlocked = botState._blockedHours || [];
                    let minedBlocked = [];
                    try { minedBlocked = getMinedBlockedHours(); } catch (e) {}
                    const allBlocked = [...new Set([...seedBlocked, ...minedBlocked])];
                    if (allBlocked.includes(currentUTCHour)) {
                        logThought({ type: 'SKIP', ticker, action: 'BLOCKED_HOUR',
                            confidence: score.compositeScore,
                            reason: `UTC hour ${currentUTCHour} blocked (seed: ${seedBlocked.includes(currentUTCHour) ? 'yes' : 'no'}, mined: ${minedBlocked.includes(currentUTCHour) ? 'yes' : 'no'})`,
                            regime: currentRegime });
                        entryStrategy = null;
                    }
                }

                // Time-of-day win rate gate (self-learning from trade outcomes)
                if (entryStrategy) {
                    const todCheck = timeOfDayTracker.shouldBlockEntry();
                    if (todCheck.blocked) {
                        logThought({ type: 'SKIP', ticker, action: 'TIME_OF_DAY_GATE',
                            confidence: score.compositeScore,
                            reason: `Bad time slot: ${todCheck.reasons.join('; ')}`,
                            regime: currentRegime });
                        entryStrategy = null;
                    }
                }

                // Journal pattern: skip ticker+strategy combos that consistently lose
                if (entryStrategy) {
                    const tickerScore = getTickerStrategyScore(ticker, entryStrategy);
                    if (tickerScore?.shouldAvoid) {
                        logThought({ type: 'SKIP', ticker, action: 'JOURNAL_PATTERN',
                            confidence: score.compositeScore,
                            reason: `${ticker}:${entryStrategy} historically bad — ${tickerScore.winRate}% WR over ${tickerScore.total} trades`,
                            regime: currentRegime });
                        entryStrategy = null;
                    }
                }

                // Regime transition confidence boost/penalty
                let regimeTransitionAdj = 0;
                if (entryStrategy) {
                    const transition = detectRegimeTransition(ticker);
                    if (transition.transition) {
                        regimeTransitionAdj = transition.confidence; // -15 to +15
                        if (Math.abs(regimeTransitionAdj) >= 5) {
                            logThought({ type: 'REGIME_TRANSITION', ticker, action: transition.transition,
                                confidence: regimeTransitionAdj,
                                reason: `${transition.from}→${transition.to} (accel=${transition.slopeAccel.toFixed(4)}) → ${transition.recommendation}`,
                                regime: currentRegime });
                        }
                        // BOOST_ENTRY: Breakout/Recovery transitions — boost position size and lower threshold
                        if (transition.recommendation === 'BOOST_ENTRY') {
                            // Accelerating breakout → scale position size by slope acceleration
                            const accelBoost = Math.min(0.3, Math.abs(transition.slopeAccel || 0) * 8);
                            _boostEntryMultipliers[ticker] = 1 + accelBoost;
                            regimeTransitionAdj += 8; // Extra confidence for breakout
                            logThought({ type: 'BOOST_ENTRY', ticker, action: transition.transition,
                                confidence: regimeTransitionAdj,
                                reason: `${transition.transition}: ${transition.from}→${transition.to}, sizeBoost=${(1 + accelBoost).toFixed(2)}x`,
                                regime: currentRegime });
                        }
                        // Block entry on BREAKDOWN or REVERSAL transitions
                        if (transition.recommendation === 'FORCE_TIGHTEN' || (transition.transition === 'BREAKDOWN' && regimeTransitionAdj <= -8)) {
                            logThought({ type: 'SKIP', ticker, action: 'REGIME_REVERSAL',
                                confidence: regimeTransitionAdj, reason: `${transition.transition}: regime shifting against longs`, regime: currentRegime });
                            entryStrategy = null;
                        }
                    }
                }

                // Lead-lag correlation alpha (now bidirectional — blocks when leaders are bearish)
                let leadLagAdj = 0;
                if (entryStrategy && marketDataMap) {
                    try {
                        const opportunities = portfolioCorrelationEngine.detectLeadLagOpportunities(marketDataMap, [ticker]);
                        const match = opportunities.find(o => o.ticker === ticker);
                        if (match) {
                            // Positive: leader is up, follower lagging = buy opportunity
                            if (match.leaderMove > 0 && match.confidence > 0) {
                                leadLagAdj = match.confidence; // 0-25
                                logThought({ type: 'LEAD_LAG', ticker, action: 'BULLISH_ALPHA',
                                    confidence: leadLagAdj,
                                    reason: `${match.leader} +${match.leaderMove}% but ${ticker} only +${match.followerMove}% → expected catch-up`,
                                    regime: currentRegime });
                            }
                            // NEGATIVE: leader is DOWN, follower hasn't dropped yet = avoid entry
                            else if (match.leaderMove < -1 && match.correlation > 0.6) {
                                leadLagAdj = -Math.round(Math.abs(match.leaderMove) * match.correlation * 5);
                                leadLagAdj = Math.max(-15, leadLagAdj); // Cap at -15
                                logThought({ type: 'LEAD_LAG', ticker, action: 'BEARISH_WARNING',
                                    confidence: leadLagAdj,
                                    reason: `${match.leader} ${match.leaderMove}% — ${ticker} likely to follow (corr=${match.correlation})`,
                                    regime: currentRegime });
                                // Strong bearish lead-lag should block entry entirely
                                if (leadLagAdj <= -10 && match.correlation > 0.75) {
                                    logThought({ type: 'SKIP', ticker, action: 'LEAD_LAG_BLOCKED',
                                        confidence: leadLagAdj,
                                        reason: `Leader ${match.leader} falling ${match.leaderMove}% with corr=${match.correlation} — blocking entry`,
                                        regime: currentRegime });
                                    entryStrategy = null;
                                }
                            }
                        }
                    } catch (e) { /* non-critical */ }
                }

                // ═══ NEWLY WIRED SERVICES ═══

                // Candlestick pattern confirmation (was dead code — surgeTradingBackend.js)
                let candlestickAdj = 0;
                if (entryStrategy && candles && candles.length >= 5) {
                    try {
                        const patterns = detectCandlestickPatterns(candles);
                        // Bullish reversal patterns at entry = strong confirmation
                        if (patterns?.bullish) {
                            const bullishPatterns = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'PIERCING_LINE', 'THREE_WHITE_SOLDIERS'];
                            for (const p of patterns.bullish) {
                                if (bullishPatterns.includes(p.pattern)) {
                                    candlestickAdj += Math.round((p.strength || 50) / 10); // +5 to +10
                                }
                            }
                        }
                        // Bearish patterns should reduce conviction
                        if (patterns?.bearish) {
                            const bearishPatterns = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'DARK_CLOUD', 'THREE_BLACK_CROWS'];
                            for (const p of patterns.bearish) {
                                if (bearishPatterns.includes(p.pattern)) {
                                    candlestickAdj -= Math.round((p.strength || 50) / 10); // -5 to -10
                                }
                            }
                        }
                    } catch (e) { /* fail open */ }
                }

                // On-chain signals (was dead code — onChainBackend.js)
                // Regime-conditioned on-chain signals
                let onChainAdj = 0;
                if (entryStrategy) {
                    try {
                        const onChain = getOnChainSignals(ticker);
                        if (onChain?.overallSignal) {
                            const sig = onChain.overallSignal;
                            // Accumulation in downtrend = contrarian bottom signal (higher conviction)
                            // Accumulation in uptrend = trend confirmation (normal conviction)
                            const isBearish = currentRegime === 'DOWN' || currentRegime === 'STRONG_DOWN';
                            if (sig === 'STRONG_ACCUMULATION') onChainAdj += isBearish ? 15 : 10;
                            else if (sig === 'ACCUMULATION') onChainAdj += isBearish ? 8 : 5;
                            else if (sig === 'DISTRIBUTION') onChainAdj -= 5;
                            else if (sig === 'STRONG_DISTRIBUTION') onChainAdj -= 12;
                        }
                    } catch (e) { /* fail open */ }
                }

                // Asset volatility profile for position sizing (was dead code — assetIntelligenceBackend.js)
                let assetVolatilitySizeMultiplier = 1.0;
                if (entryStrategy) {
                    try {
                        const profile = getAssetProfile(ticker);
                        if (profile?.volatilityTier) {
                            // Higher volatility = smaller position (tail risk protection)
                            if (profile.volatilityTier === 'EXTREME') assetVolatilitySizeMultiplier = 0.5;
                            else if (profile.volatilityTier === 'HIGH') assetVolatilitySizeMultiplier = 0.7;
                            else if (profile.volatilityTier === 'MEDIUM') assetVolatilitySizeMultiplier = 1.0;
                            else if (profile.volatilityTier === 'LOW') assetVolatilitySizeMultiplier = 1.2;
                        }
                    } catch (e) { /* fail open */ }
                }

                // Pre-trade AI decision gate (was dead code — preTradeAI.js)
                if (entryStrategy) {
                    try {
                        const preTradeResult = getPreTradeDecision(ticker, score.compositeScore, currentRegime, entryStrategy);
                        if (preTradeResult && preTradeResult.decision === 'REJECT') {
                            logThought({ type: 'SKIP', ticker, action: 'PRETRADE_AI_REJECT',
                                confidence: score.compositeScore,
                                reason: preTradeResult.reason || 'Pre-trade AI rejected entry',
                                regime: currentRegime });
                            entryStrategy = null;
                        }
                    } catch (e) { /* fail open */ }
                }

                // VWAP + StochRSI + Delta Volume entry confirmation signals
                let vwapAdj = 0, stochRSIAdj = 0, deltaVolAdj = 0;
                if (entryStrategy && candles && candles.length >= 30) {
                    try {
                        // VWAP: price below VWAP in uptrend = pullback entry (bullish)
                        const vwapValue = calculateVWAPLatest(candles);
                        const latestClose = candles[candles.length - 1]?.c || candles[candles.length - 1]?.close;
                        if (vwapValue && latestClose) {
                            const vwapDev = ((latestClose - vwapValue) / vwapValue) * 100;
                            if (vwapDev < -0.5 && currentRegime.includes('UP')) vwapAdj = 5;       // Below VWAP in uptrend = pullback entry
                            else if (vwapDev < -1.5) vwapAdj = -3;                                  // Far below VWAP = weakness
                            else if (vwapDev > 2.0) vwapAdj = -3;                                   // Far above VWAP = overextended
                        }

                        // StochRSI: < 20 = oversold (bullish), > 80 = overbought (bearish)
                        const stochK = calculateStochRSILatest(candles);
                        if (stochK < 20) stochRSIAdj = 5;        // Oversold momentum = good entry
                        else if (stochK < 35) stochRSIAdj = 2;   // Moderately oversold
                        else if (stochK > 80) stochRSIAdj = -5;  // Overbought = don't chase
                        else if (stochK > 65) stochRSIAdj = -2;  // Moderately overbought

                        // Delta Volume: > 60 = buy dominance (bullish), < 40 = sell dominance
                        const deltaVol = calculateDeltaVolumeLatest(candles);
                        if (deltaVol > 65) deltaVolAdj = 4;      // Strong buy pressure
                        else if (deltaVol > 55) deltaVolAdj = 2;  // Moderate buy pressure
                        else if (deltaVol < 35) deltaVolAdj = -5; // Sell-dominated — don't buy into selling
                        else if (deltaVol < 45) deltaVolAdj = -2; // Moderate sell pressure
                    } catch (e) { /* fail open */ }
                }

                // Adversarial brains consensus adjustment (from ML gatekeeper pipeline)
                let adversarialAdj = 0;
                if (pipelineResult?.adversarialConsensus) {
                    const adv = pipelineResult.adversarialConsensus;
                    if (adv.consensus === 'STRONG_BUY') adversarialAdj = 6;
                    else if (adv.consensus === 'WEAK_BUY') adversarialAdj = 2;
                    else if (adv.consensus === 'CONTESTED') adversarialAdj = -3;
                    else if (adv.consensus === 'REJECT') adversarialAdj = -8;
                }

                // Hard floor: reject any entry with adjusted compositeScore below optimizer floor
                // Now includes ALL signal sources: sentiment, regime, lead-lag, candlestick, on-chain, VWAP, StochRSI, delta volume, adversarial
                // Journal-mined regime+strategy adjustment
                let journalAdj = 0;
                if (entryStrategy) {
                    try { journalAdj = getRegimeStrategyAdj(currentRegime, entryStrategy); } catch (e) {}
                }

                // Order book confidence adjustment (moved earlier to include in composite)
                let obAdj = 0;
                if (entryStrategy) {
                    try {
                        const obSignal = getOrderBookSignal(ticker);
                        const obResult = getOrderBookConfidenceAdjustment(obSignal, 'BUY');
                        obAdj = obResult.adjustment;
                    } catch (e) { /* fail open */ }
                }

                const adjustedComposite = score.compositeScore + htfAdj + fundingAdj + sentimentAdj + volumeBurstAdj + velocityAdj + regimeTransitionAdj + leadLagAdj + journalAdj + candlestickAdj + onChainAdj + macroCompositeAdj + scannerAdj + derivativesAdj + fearGreedAdj + sweepAdj + mtfConfidenceAdj + obAdj + vwapAdj + stochRSIAdj + deltaVolAdj + adversarialAdj + microBurstAdj + regimeBoostAdj;
                if (entryStrategy && adjustedComposite < optParams.compositeScoreFloor) {
                    logThought({
                        type: 'SKIP', ticker, action: 'LOW_COMPOSITE',
                        confidence: adjustedComposite,
                        reason: `adjustedComposite ${adjustedComposite} (raw=${score.compositeScore}, htf=${htfAdj}, funding=${fundingAdj}, sent=${sentimentAdj}, candle=${candlestickAdj}, onchain=${onChainAdj}, deriv=${derivativesAdj}, fg=${fearGreedAdj}, sweep=${sweepAdj}, mtf=${mtfConfidenceAdj}, ob=${obAdj}) < ${optParams.compositeScoreFloor} floor`,
                        regime: currentRegime,
                        indicators: { compositeScore: score.compositeScore, adjustedComposite, htfAdj, fundingAdj, sentimentAdj, candlestickAdj, onChainAdj, entryStrategy },
                    });
                    entryStrategy = null;
                }

                if (entryStrategy && CapitalTierManager.isStrategyAllowed(entryStrategy, totalValue)) {
                    // Feature 4: Dynamic Kelly position sizing
                    const kellySize = getKellyPositionSize(totalValue);
                    const kellyFraction = kellySize.kelly.stats?.trades >= 20
                        ? Math.min(0.25, kellySize.fraction)
                        : 0.10; // Fall back to 10% if < 20 trades

                    // Tier 2: Per-strategy CVaR-adjusted Kelly — accounts for tail risk + strategy performance
                    let adjustedKelly = kellyFraction;
                    // Use per-strategy Kelly if enough trades for this strategy
                    const stratKelly = getStrategyKelly(entryStrategy, totalValue);
                    if (stratKelly?.kelly?.stats?.trades >= 20) {
                        adjustedKelly = Math.min(0.25, stratKelly.fraction);
                    }
                    if (cvarKelly) {
                        try {
                            const cvarResult = cvarKelly.getStrategyCVaRAdjustedSize
                                ? cvarKelly.getStrategyCVaRAdjustedSize(adjustedKelly, currentRegime, entryStrategy)
                                : cvarKelly.getCVaRAdjustedSize(adjustedKelly, currentRegime);
                            adjustedKelly = cvarResult.fraction;
                        } catch (e) {}
                    }

                    // Position size: prefer timeframe profile's positionSizePercent if available
                    let positionPercent = profilePosSize ? (profilePosSize / 100) : adjustedKelly;
                    positionPercent = Math.min(positionPercent, adjustedKelly * 2); // Don't exceed 2x adjusted Kelly

                    let investmentAmount = Math.min(portfolio.cash * 0.95, totalValue * positionPercent * riskAmount);

                    // Tier 3B: Meta-RL position sizing adjustment
                    let metaRLParams = null;
                    if (metaRL) {
                        try {
                            metaRLParams = metaRL.getRecommendedParams(currentRegime);
                            if (metaRLParams.confidence > 20) {
                                investmentAmount *= metaRLParams.positionSizeMult;
                            }
                        } catch (e) {}
                    }

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

                    // Asset volatility-based sizing: high-vol assets get smaller positions
                    investmentAmount *= assetVolatilitySizeMultiplier;

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

                    // Correlation-aware sizing: reduce size when portfolio is highly correlated
                    // If all open positions are BTC-correlated crypto, adding more correlated exposure increases tail risk
                    try {
                        if (getFlag('CORRELATION_ENGINE_ENABLED') && Object.keys(portfolio.positions).length >= 2) {
                            const corrStatus = portfolioCorrelationEngine.getCorrelationStatus();
                            const avgCorrelation = corrStatus?.averageCorrelation || 0;
                            // High correlation (>0.7) = concentrated risk → reduce size
                            // avgCorr > 0.8 → 0.6x, > 0.7 → 0.8x, > 0.6 → 0.9x
                            if (avgCorrelation > 0.8) investmentAmount *= 0.6;
                            else if (avgCorrelation > 0.7) investmentAmount *= 0.8;
                            else if (avgCorrelation > 0.6) investmentAmount *= 0.9;
                        }
                    } catch {}

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

                    // Tier 1B: Fear & Greed position size scaling
                    if (fearGreedSizeMultiplier !== 1.0) {
                        investmentAmount *= fearGreedSizeMultiplier;
                        investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);
                    }

                    // OI surge breakout confirmation — 15% size boost when OI surges >10% alongside entry signal
                    if (oiSurgeBreakout) {
                        investmentAmount *= 1.15;
                        investmentAmount = CapitalTierManager.getRecommendedPositionSize(totalValue, investmentAmount);
                    }

                    // High win-rate ticker+strategy combo → boost position size
                    try {
                        const tickerScore = getTickerStrategyScore(ticker, entryStrategy);
                        if (tickerScore && tickerScore.winRate > 65 && tickerScore.total >= 8) {
                            investmentAmount *= 1.20; // +20% for historically winning combos
                        }
                    } catch (e) {}

                    // Regime transition acceleration → scale size on breakouts
                    if (_boostEntryMultipliers[ticker]) {
                        investmentAmount *= _boostEntryMultipliers[ticker];
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

                    // C2: Position size floor — prevent dust amounts after 13+ multiplicative stages
                    if (entryStrategy && investmentAmount > 0 && investmentAmount < CONFIG.MIN_TRADE_SIZE * 1.1) {
                        investmentAmount = CONFIG.MIN_TRADE_SIZE * 1.1;
                    }

                    if (entryStrategy && investmentAmount > CONFIG.MIN_TRADE_SIZE) {
                        const pipelineTier = pipelineResult?.tier || 'N/A';
                        const pipelineMult = pipelineResult?.sizeMultiplier?.toFixed(2) || '1.00';
                        logThought({
                            type: 'ENTRY_EVAL', ticker, action: 'ENTERING',
                            confidence: score.compositeScore + mtfConfidenceAdj + fundingAdj + htfAdj + sentimentAdj + derivativesAdj + fearGreedAdj + obAdj,
                            reason: `${entryStrategy} entry [${marketSpeed}/${activeProfile?.timeframeId || 'default'}]: score=${score.compositeScore}, kelly=${(kellyFraction*100).toFixed(1)}%, mtf=${mtfConfidenceAdj}, funding=${fundingAdj}, htf=${htfAdj}, sentiment=${sentimentAdj}, deriv=${derivativesAdj}, fg=${fearGreedAdj}/${fearGreedSizeMultiplier.toFixed(1)}x, ob=${obAdj}, pipeline=${pipelineTier}×${pipelineMult}${mlAdvice.available ? `, ml=${mlAdvice.direction}@${mlAdvice.confidence}%` : ''}`,
                            regime: currentRegime,
                            market_speed: marketSpeed,
                            indicators: { tcValue, compositeScore: score.compositeScore, kellyFraction, mtfConfidenceAdj, fundingAdj, htfAdj, sentimentAdj, derivativesAdj, fearGreedAdj, fearGreedSizeMultiplier, investmentAmount, timeframeId: activeProfile?.timeframeId, mlDirection: mlAdvice.direction, mlConfidence: mlAdvice.confidence, pipelineTier, pipelineMult },
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
                            metaRLActions: metaRLParams ? { positionSizeMult: metaRLParams.positionSizeMult, slMult: metaRLParams.slMult, tpMult: metaRLParams.tpMult, entryThreshMult: metaRLParams.entryThreshMult } : null,
                            entryType: sniperCandidate ? 'SNIPER' : 'STANDARD',
                        });
                    }
                }
            }
        }

        // --- PROFIT METHOD ENTRIES ---
        if (portfolio.cash > CONFIG.MIN_TRADE_SIZE && !pauseCheck.paused && !flashCrashBlocking && !maxDrawdownBlocking && (botState.tradingMode === 'SIMULATION' || drawdown <= tier.maxDrawdownLimit)) {
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
        // --- SHORT SELLING EVALUATION (Core V2) ---
        // Only evaluate shorts in bearish regimes for sim mode learning
        try {
            const overallRegime = getMarketRegime();
            if (shortSellingEngine && (overallRegime === 'DOWNTREND' || overallRegime === 'DOWN' || overallRegime === 'STRONG_DOWN')) {
                const exchangeId = getActiveExchangeId();
                for (const [ticker, candles] of marketDataMap) {
                    if (!candles || candles.length < 21) continue;
                    const latestPrice = candles[candles.length - 1]?.c || 0;
                    if (latestPrice <= 0) continue;

                    // Get TC score, RSI, and price momentum for short evaluation
                    const closes = candles.map(c => c.c);
                    const tcSeries = calculateTCSeries(closes, 14);
                    const tcValue = tcSeries?.[tcSeries.length - 1] || 50;

                    // RSI calculation for overbought detection (inline 14-period)
                    let rsiValue = 50;
                    if (closes.length >= 15) {
                        let avgGain = 0, avgLoss = 0;
                        for (let i = closes.length - 14; i < closes.length; i++) {
                            const diff = closes[i] - closes[i - 1];
                            if (diff > 0) avgGain += diff; else avgLoss -= diff;
                        }
                        avgGain /= 14; avgLoss /= 14;
                        rsiValue = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
                    }

                    // 5-bar price change for momentum
                    const priceChange5 = closes.length >= 6
                        ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
                        : 0;

                    // Evaluate via derivatives intelligence for short signal
                    let derivShortFavor = false;
                    if (derivativesIntel) {
                        const shortCheck = derivativesIntel.shouldFavorShortEntry(ticker.replace('USD', ''));
                        derivShortFavor = shortCheck.favorable;
                    }

                    const shortEval = shortSellingEngine.evaluateShortEntry(
                        ticker, exchangeId, latestPrice, overallRegime,
                        derivShortFavor ? 0.75 : 0.5, // Use derivatives as confidence proxy
                        tcValue, rsiValue, priceChange5
                    );

                    if (shortEval.shouldShort && shortEval.size) {
                        shortSellingEngine.openShort(ticker, exchangeId, latestPrice, shortEval.size);
                        addLog(`[SHORT-SIM] Opened short ${ticker} @ $${latestPrice.toFixed(2)}: ${shortEval.reason}`, 'TRADE');
                    }
                }

                // Check exits on existing short positions — build price Map from live WS prices
                const shortPriceMap = new Map();
                for (const [, pos] of shortSellingEngine.positions || []) {
                    const p = getLatestPrice(pos.ticker);
                    if (p) shortPriceMap.set(`${pos.exchange}:${pos.ticker}`, p);
                }
                if (shortPriceMap.size > 0) shortSellingEngine.checkExits(shortPriceMap);
            }
        } catch (e) {
            // Fail silently — short engine is supplementary
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

    // Reduce position size for new coin trades
    if (isNewListing && isNewListing(ticker)) {
        const rules = getNewCoinRules();
        notional *= rules.positionSizeMultiplier;
        addLog(`[NewCoin] Reduced position to ${(rules.positionSizeMultiplier * 100)}% for ${ticker}`, 'INFO');
    }

    // Exchange minimum order validation
    if (getActiveExchangeId() === 'kraken' && krakenMinimums) {
        const minOrder = krakenMinimums.getMinimumOrder(ticker);
        if (notional < minOrder.minNotional) {
            addLog(`[KRAKEN] Order $${notional.toFixed(2)} below minimum $${minOrder.minNotional} for ${ticker} — skipping`, 'WARN');
            return;
        }
    } else if (getActiveExchangeId() === 'crypto.com') {
        // Crypto.com Exchange minimum notional: $1 for most USD pairs
        if (notional < 1.0) {
            addLog(`[CRYPTO.COM] Order $${notional.toFixed(2)} below $1.00 minimum for ${ticker} — skipping`, 'WARN');
            return;
        }
    }

    addLog(`Triggering BUY for ${ticker} @ ${price}. Reason: [${strategy}] ${reason}`, 'BUY');

    try {
        let quantity, avgPrice;
        const fees = getActiveFees();

        if (botState.tradingMode === 'SIMULATION') {
            // A2: Order-book based slippage in SIM when SIMULATION_ACCURACY enabled
            const simAccuracy = getFlag('SIMULATION_ACCURACY');
            let slippagePct = 0;

            if (simAccuracy && orderBookMicro?.analyze) {
                try {
                    const obAnalysis = orderBookMicro.analyze(ticker);
                    if (obAnalysis && obAnalysis.spreadBps > 0) {
                        const spreadPct = obAnalysis.spreadBps / 100; // bps → %
                        // Slippage scales with order size relative to book depth
                        const depthRatio = obAnalysis.askDepth > 0 ? (notional / obAnalysis.askDepth) : 0.1;
                        const slippageFactor = Math.min(2.0, 0.3 + depthRatio * 1.5);
                        slippagePct = spreadPct * slippageFactor;
                    } else {
                        slippagePct = 0.05; // Fallback: 0.05%
                    }
                } catch (e) {
                    slippagePct = 0.05; // Fallback if order book unavailable
                }
            } else {
                // Legacy synthetic slippage model
                const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(ticker);
                const baseSlippageBps = isMajor ? 2 : 8;
                const sizeMult = Math.min(3, notional / 100);
                slippagePct = (baseSlippageBps * Math.max(1, sizeMult)) / 10000 * 100;
            }

            // A4: Fill latency + partial fill simulation
            if (simAccuracy) {
                // 200-500ms random delay before fill confirmation
                await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

                // 15% chance of partial fill (60-90% of requested qty)
                if (Math.random() < 0.15) {
                    const fillRatio = 0.60 + Math.random() * 0.30;
                    notional *= fillRatio;
                    addLog(`[SIM-FILL] Partial fill for ${ticker}: ${(fillRatio * 100).toFixed(0)}% of requested size ($${notional.toFixed(2)})`, 'INFO');
                }
            }

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

                    // Adaptive slippage threshold: base 1.0%, widen if execution engine historically shows estimates were too conservative
                    let slippageThreshold = 1.0;
                    try {
                        const execStats = executionEngine?.getExecutionStats?.();
                        if (execStats?.totalExecutions >= 10 && execStats.slippageSavings > 0.1) {
                            // Estimates run ~X% higher than actual — widen threshold by half the savings
                            slippageThreshold = Math.min(1.5, 1.0 + execStats.slippageSavings * 0.5);
                        }
                    } catch {}
                    if (estimatedSlippage && estimatedSlippage.slippagePercent > slippageThreshold) {
                        addLog(`[ORDER-BOOK] Skipping ${ticker}: estimated slippage ${estimatedSlippage.slippagePercent.toFixed(3)}% exceeds ${slippageThreshold.toFixed(2)}% threshold`, 'WARN');
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
            // #16: Prefer post-only (maker) orders when flag is set — saves 0.10% per side
            const preferMaker = getFlag('PREFER_MAKER_ORDERS') && adapter.placePostOnlyBuy;
            if (adapter.getMakerFeePercent && (adapter.placeLimitBuyOrder || preferMaker)) {
                try {
                    const limitPrice = adaptiveLimitPrice; // Use order-book-informed price
                    const vol = notional / limitPrice;

                    let limitOrder;
                    if (preferMaker) {
                        try {
                            limitOrder = await withTimeout(adapter.placePostOnlyBuy(ticker, limitPrice, vol, botState.sessionId), 20000, 'placePostOnlyBuy');
                            addLog(`[MAKER] Post-only buy placed for ${ticker} @ ${limitPrice.toFixed(2)} (saving 0.10%/side)`, 'INFO');
                        } catch (postOnlyErr) {
                            // Post-only rejected (would cross spread) — retry at best bid
                            if (orderBook?.bids?.[0]) {
                                const bestBid = parseFloat(orderBook.bids[0][0] || orderBook.bids[0].price || 0);
                                if (bestBid > 0) {
                                    try {
                                        limitOrder = await withTimeout(adapter.placePostOnlyBuy(ticker, bestBid, vol, botState.sessionId), 20000, 'placePostOnlyBuy-retry');
                                    } catch { /* fall through to regular limit */ }
                                }
                            }
                            if (!limitOrder) {
                                addLog(`[MAKER] Post-only rejected, using limit order`, 'INFO');
                                limitOrder = await withTimeout(adapter.placeLimitBuyOrder(ticker, limitPrice, vol, botState.sessionId), 20000, 'placeLimitBuyOrder');
                            }
                        }
                    } else {
                        limitOrder = await withTimeout(adapter.placeLimitBuyOrder(ticker, limitPrice, vol, botState.sessionId), 20000, 'placeLimitBuyOrder');
                    }

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
                entryRegime: entryMeta.regime || 'NORMAL', // Snapshot for mid-trade regime switching
                entryType: entryMeta.entryType || 'STANDARD',
                sniperExtensions: 0, // Phase 2B: momentum-ride extension count
                mlInfluenced: entryMeta.mlInfluenced || false,
                mlConfidence: entryMeta.mlConfidence || 0,
                mlDirection: entryMeta.mlDirection || null,
                metaRLActions: entryMeta.metaRLActions || null,
            };
        }
        portfolio.cash -= (actualCost + buyFee);

        // Emit EventBus entry event for Core V2 modules
        try {
            tradingBus.emit('trade:entry', {
                exchange: getActiveExchangeId(),
                ticker,
                side: 'LONG',
                price: parseFloat(avgPrice),
                quantity: parseFloat(quantity),
                usdAmount: actualCost,
                strategy,
                timestamp: Date.now(),
            });
        } catch (e) {}

        // A3: Simulated native SL in SIM mode (mirrors real-mode SL behavior)
        if (botState.tradingMode === 'SIMULATION' && getFlag('SIMULATION_ACCURACY')) {
            const emergencySlPct = 0.05; // 5% emergency SL, same as real mode
            const slPrice = parseFloat(avgPrice) * (1 - emergencySlPct);
            simNativeStopOrders.set(ticker, {
                stopPrice: slPrice,
                volume: parseFloat(quantity),
                placedAt: Date.now(),
            });
            addLog(`[SIM-SL] Placed simulated stop-loss for ${ticker} @ $${slPrice.toFixed(2)} (-${(emergencySlPct * 100).toFixed(1)}%)`, 'INFO');
        }

        // Place native exchange stop-loss (survives bot crashes)
        if (botState.tradingMode !== 'SIMULATION' && getActiveExchangeId() === 'kraken') {
            try {
                const adapter = getExchangeAdapter();

                // #12: Use trailing stop if enabled, otherwise fixed stop-loss
                if (getFlag('NATIVE_TRAILING_STOP') && adapter.placeTrailingStop) {
                    const trailPct = 0.03; // 3% trail offset
                    const trailOffset = parseFloat(avgPrice) * trailPct;
                    const tsResult = await adapter.placeTrailingStop(ticker, parseFloat(quantity), trailOffset, botState.sessionId);
                    if (tsResult.orderId) {
                        nativeStopOrders.set(ticker, {
                            orderId: tsResult.orderId,
                            type: 'trailing-stop',
                            trailOffset,
                            volume: parseFloat(quantity),
                            placedAt: Date.now(),
                        });
                        addLog(`[NATIVE-TS] Placed trailing stop for ${ticker}: ${tsResult.orderId} offset=$${trailOffset.toFixed(2)} (-${(trailPct * 100).toFixed(1)}%)`, 'INFO');
                    }
                } else {
                    // Emergency SL: 5% below entry (wide enough to avoid noise, tight enough to protect)
                    // Will be tightened by refreshExitLevels() once ATR data is available
                    const emergencySlPct = 0.05;
                    const slPrice = parseFloat(avgPrice) * (1 - emergencySlPct);
                    const slResult = await adapter.placeStopLoss(ticker, parseFloat(quantity), slPrice, botState.sessionId);
                    if (slResult.orderId) {
                        nativeStopOrders.set(ticker, {
                            orderId: slResult.orderId,
                            type: 'stop-loss',
                            stopPrice: slPrice,
                            volume: parseFloat(quantity),
                            placedAt: Date.now(),
                        });
                        addLog(`[NATIVE-SL] Placed exchange stop-loss for ${ticker}: ${slResult.orderId} @ $${slPrice.toFixed(2)} (-${(emergencySlPct * 100).toFixed(1)}%)`, 'INFO');
                    }
                }
            } catch (slErr) {
                // C3: Retry loop — never leave a position without SL protection
                let retrySuccess = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await new Promise(r => setTimeout(r, 2000));
                        addLog(`[NATIVE-SL] Retry ${attempt}/3 for ${ticker}...`, 'WARN');
                        const adapter = getExchangeAdapter();
                        const slPrice = parseFloat(avgPrice) * (1 - 0.05);
                        const retryResult = await adapter.placeStopLoss(ticker, parseFloat(quantity), slPrice, botState.sessionId);
                        if (retryResult.orderId) {
                            nativeStopOrders.set(ticker, {
                                orderId: retryResult.orderId,
                                type: 'stop-loss',
                                stopPrice: slPrice,
                                volume: parseFloat(quantity),
                                placedAt: Date.now(),
                            });
                            addLog(`[NATIVE-SL] Retry ${attempt} succeeded for ${ticker}: ${retryResult.orderId}`, 'INFO');
                            retrySuccess = true;
                            break;
                        }
                    } catch (retryErr) {
                        addLog(`[NATIVE-SL] Retry ${attempt} failed for ${ticker}: ${retryErr.message}`, 'WARN');
                    }
                }
                if (!retrySuccess) {
                    addLog(`[NATIVE-SL] CRITICAL: All 3 retries failed for ${ticker} — NO exchange SL protection!`, 'ERROR');
                    if (telegramEnabled()) {
                        try { alertCircuitBreaker(`CRITICAL: Native SL failed for ${ticker} after 3 retries — software SL only`); } catch(e) {}
                    }
                }
            }
        }

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
        discordAlertTrade({ type: 'BUY', ticker, price: parseFloat(avgPrice), strategy, pnl: null });
        saveSessionState();
        return { success: true };
    } catch (error) {
        addLog(`BUY order failed: ${error.message}`, 'ERROR');
        return { success: false, insufficientBalance: error.message?.includes('INSUFFICIENT') };
    }
};

const handleSell = async (position, price, reason) => {
    addLog(`Triggering SELL for ${position.ticker} @ ${price}. Reason: ${reason}`, 'SELL');

    // A3: Remove simulated SL on SIM sell
    if (botState.tradingMode === 'SIMULATION') {
        simNativeStopOrders.delete(position.ticker);
    }

    // Cancel native exchange stop-loss before selling (prevent double-sell)
    const nativeSL = nativeStopOrders.get(position.ticker);
    if (nativeSL && botState.tradingMode !== 'SIMULATION') {
        try {
            const adapter = getExchangeAdapter();
            await withTimeout(adapter.cancelOrder(nativeSL.orderId, botState.sessionId), 10000, 'cancelNativeSL');
            addLog(`[NATIVE-SL] Cancelled stop-loss ${nativeSL.orderId} for ${position.ticker}`, 'INFO');
        } catch (cancelErr) {
            addLog(`[NATIVE-SL] Failed to cancel SL ${nativeSL.orderId}: ${cancelErr.message}`, 'WARN');
        }
        nativeStopOrders.delete(position.ticker);
    }

    try {
        let avgPrice;
        const fees = getActiveFees();

        if (botState.tradingMode === 'SIMULATION') {
            // A2: Order-book based sell slippage in SIM
            const simAccuracy = getFlag('SIMULATION_ACCURACY');
            let slippagePct = 0;

            if (simAccuracy && orderBookMicro?.analyze) {
                try {
                    const obAnalysis = orderBookMicro.analyze(position.ticker);
                    if (obAnalysis && obAnalysis.spreadBps > 0) {
                        const spreadPct = obAnalysis.spreadBps / 100;
                        const sellNotional = position.quantity * price;
                        const depthRatio = obAnalysis.bidDepth > 0 ? (sellNotional / obAnalysis.bidDepth) : 0.1;
                        const slippageFactor = Math.min(2.0, 0.35 + depthRatio * 1.5); // Sell slightly worse
                        slippagePct = spreadPct * slippageFactor;
                    } else {
                        slippagePct = 0.06;
                    }
                } catch (e) {
                    slippagePct = 0.06;
                }
            } else {
                const isMajor = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'].includes(position.ticker);
                const sellNotional = position.quantity * price;
                const baseSlippageBps = isMajor ? 3 : 10;
                const sizeMult = Math.min(3, sellNotional / 100);
                slippagePct = (baseSlippageBps * Math.max(1, sizeMult)) / 10000 * 100;
            }

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
        recordTradeDetail({
            ticker: position.ticker, strategy: position.entryStrategy,
            regime: position.entryRegime || position.regime || 'UNKNOWN',
            entryPrice: position.openPrice, exitPrice: avgPrice,
            pnlPercent: ((avgPrice - position.openPrice) / position.openPrice) * 100,
            pnlUsd: pnl, entryTime: position.entryTime, exitTime: Date.now(),
        });
        autoJournal();
        recordSessionTrade(pnl);

        // Time-of-day tracker: record trade outcome for time-based gating
        timeOfDayTracker.recordTrade(position.entryTime || Date.now(), pnl);
        tickerLossCooldown.recordTrade(position.ticker, pnl);

        // Feed trade outcome to ML self-teaching loop
        // Use fee-adjusted pnlPercent so thin-margin trades aren't mislabeled
        const feeAdjustedPnlPct = ((pnl) / (position.openPrice * position.quantity)) * 100;

        // Capture exit context for richer ML feedback
        let exitRegime = 'UNKNOWN';
        try { exitRegime = getMarketRegime(position.ticker)?.regime || 'UNKNOWN'; } catch (e) {}
        const exitVelocity = priceVelocityTracker.getMetrics(position.ticker);
        let exitOrderBookImbalance = 0;
        try {
            if (orderBookMicro?.analyze) {
                const obAnalysis = orderBookMicro.analyze(position.ticker);
                exitOrderBookImbalance = obAnalysis?.imbalance || 0;
            }
        } catch (e) {}
        const exitHourUTC = new Date().getUTCHours();
        const exitDayOfWeek = new Date().getUTCDay();

        const tradeOutcomeData = {
            ticker: position.ticker,
            strategy: position.entryStrategy,
            outcome: pnl >= 0 ? 'WIN' : 'LOSS',
            pnl,
            pnlPercent: feeAdjustedPnlPct,
            entryPrice: position.openPrice,
            exitPrice: avgPrice,
            entryTime: position.entryTime,
            exitTime: Date.now(),
            holdDuration: Date.now() - position.entryTime,
            pipelineTier: position.pipelineTier || 'UNKNOWN',
            // Exit context (new)
            exitReason: reason,
            entryRegime: position.entryRegime || position.regime || 'UNKNOWN',
            exitRegime,
            exitVelocity: exitVelocity.velocity,
            exitAcceleration: exitVelocity.acceleration,
            exitOrderBookImbalance,
            exitHourUTC,
            exitDayOfWeek,
            entryCompositeScore: position.compositeScore || 0,
            entryMLConfidence: position.mlConfidence || 0,
            peakPnlPct: position.highestPrice ? ((position.highestPrice - position.openPrice) / position.openPrice) * 100 : 0,
            troughPnlPct: position.lowestPrice ? ((position.lowestPrice - position.openPrice) / position.openPrice) * 100 : 0,
        };
        try {
          recordTradeForLearning(tradeOutcomeData);
        } catch (mlErr) {
          console.warn('[ML Feedback] Error recording trade for learning:', mlErr.message);
        }

        // Feed to self-teaching loop (online learner, gatekeeper, adaptive thresholds)
        if (selfTeachingLoop?.onTradeComplete) {
          try {
            selfTeachingLoop.onTradeComplete(tradeOutcomeData);
          } catch (stErr) {
            console.warn('[SelfTeach] onTradeComplete error:', stErr.message);
          }
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
        discordAlertTrade({ type: 'SELL', ticker: position.ticker, price: avgPrice, strategy: position.entryStrategy, pnl });

        // Emit EventBus exit event for Core V2 modules
        try {
            tradingBus.emit('trade:exit', {
                exchange: getActiveExchangeId(),
                ticker: position.ticker,
                side: 'LONG',
                entryPrice: position.openPrice,
                exitPrice: avgPrice,
                quantity: position.quantity,
                netPnlUsd: pnl,
                netPnlPct: ((avgPrice - position.openPrice) / position.openPrice) * 100,
                strategy: position.entryStrategy,
                holdTimeMs: Date.now() - (position.entryTime || Date.now()),
                reason,
                timestamp: Date.now(),
            });
        } catch (e) {}

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
            // Exit context
            exitReason: reason,
            exitRegime,
            exitVelocity: exitVelocity.velocity,
            exitHourUTC,
            exitDayOfWeek,
            peakPnlPct: position.highestPrice ? ((position.highestPrice - position.openPrice) / position.openPrice) * 100 : 0,
        });
        if (portfolio.tradeLog.length > 500) portfolio.tradeLog.splice(0, portfolio.tradeLog.length - 500);

        // Tier 2: Record return for CVaR-adjusted Kelly sizing
        if (cvarKelly) {
            try { cvarKelly.recordReturn(pnlPercent, position.regime || 'NORMAL', position.entryStrategy || ''); } catch (e) {}
        }

        // Tier 3B: Update Meta-RL beliefs using entry-time actions (not current actions)
        if (metaRL) {
            try {
                const regime = position.regime || 'SIDEWAYS';
                const actions = position.metaRLActions || metaRL.selectActions(regime);
                metaRL.updateBeliefs(regime, actions, pnlPercent);
            } catch (e) {}
        }

        // C6: Signal scanner feedback loop — record outcome for scanner weight adjustment
        if (_signalScannerRef?.recordSignalOutcome) {
            try {
                _signalScannerRef.recordSignalOutcome(position.ticker, 'mixed', pnlPercent);
            } catch (e) {}
        }

        // Tier 3B: Record outcome for ML A/B Testing
        if (mlABTest) {
            try {
                const direction = pnlPercent > 0 ? 'UP' : 'DOWN';
                mlABTest.recordOutcome(position.ticker, direction, pnlPercent, position.entryTime || Date.now());
            } catch (e) {}
        }

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

        // Check for new listings
        try {
            if (detectNewListings) {
                const newlyDetected = detectNewListings(availableTickers);
                if (newlyDetected.length > 0) {
                    console.log(`[Server] New listings detected: ${newlyDetected.join(', ')}`);
                    addLog(`New Kraken listings: ${newlyDetected.join(', ')}`, 'SPECIAL');
                }
            }
        } catch (err) {
            console.warn('[Server] New listing detection error:', err.message);
        }

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
    priceVelocityTracker,
    microBurstDetector,
    regimeTransitionBoost,
    hotTickers,
    timeOfDayTracker,

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

    // Core V2 modules (Overhaul)
    tradingBus,
    portfolioManager,
    shortSellingEngine,
    stakingEngine,
    arbitrageEngine,
    incrementalIndicators,
    telegramV2,
    healthMonitor,
    dbBatcher,
    logger,
    // Tier 1
    derivativesIntel,
    fearGreedGate,
    // Tier 2
    orderBookMicro,
    cvarKelly,
    whaleFlowTracker,
    positionReconciler,
    // Tier 3
    basisEngine,
    liquidationSweep,
    mlABTest,
    metaRL,
};

// Mount extracted route modules
app.use('/api', createMarketRouter(ctx));
app.use('/api', createExchangeRouter(ctx));
app.use('/api', createAuthRouter(ctx));
// Questrade router removed
app.use('/api', createSessionsRouter(ctx));
app.use('/api', createIntelligenceRouter(ctx));
app.use('/api', createSentimentRouter(ctx));
app.use('/api', createSignalsRouter(ctx));
app.use('/api', createNotificationsRouter(ctx));
app.use('/api', createConfigRouter(ctx));
app.use('/api', createBacktestRouter(ctx));
app.use('/api', createMultiExchangeRouter(ctx));
app.use('/api', createEngineRouter(ctx));
app.use('/api', createNewsRouter(ctx));

// ─── Health & Monitoring Endpoints ──────────────────────────
const SERVER_STARTED_AT = new Date().toISOString();
let serverRestartCount = parseInt(process.env.PM2_RESTART_COUNT || '0', 10);

app.get('/api/health', (req, res) => {
    const base = healthMonitor.getStatus();
    res.json({
        ...base,
        startedAt: SERVER_STARTED_AT,
        restartCount: serverRestartCount,
        lastRestartReason: process.env.PM2_RESTART_REASON || 'manual',
        nodeVersion: process.version,
    });
});

app.get('/api/health/detailed', (req, res) => {
    res.json({
        health: healthMonitor.getSnapshot(),
        dbBatcher: dbBatcher.getStats(),
        logs: logger.getStats(),
        startedAt: SERVER_STARTED_AT,
        restartCount: serverRestartCount,
    });
});

app.get('/api/logs/recent', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const level = req.query.level || undefined;
    res.json(logger.getRecentLogs(limit, level));
});

// #28 — Log Level Toggle API
app.get('/api/log-level', (req, res) => {
    res.json({ level: logger.getStats().minLevel });
});

app.post('/api/log-level', (req, res) => {
    const { level } = req.body;
    const valid = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    if (!valid.includes(level)) {
        return res.status(400).json({ error: `Invalid level. Must be one of: ${valid.join(', ')}` });
    }
    logger.setLevel(level);
    res.json({ level, message: `Log level set to ${level}` });
});

// #7 — Discord Webhook API
app.post('/api/discord/test', async (req, res) => {
    try {
        const { sendTestMessage: discordTest } = await import('./services/discordWebhook.js');
        await discordTest();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/discord/status', (req, res) => {
    import('./services/discordWebhook.js').then(m => res.json(m.getStatus())).catch(() => res.json({ enabled: false }));
});

// #13 — API Key Health Monitor
app.get('/api/api-health', (req, res) => {
    res.json(getApiKeyHealth());
});

// Tier 1: Derivatives Intelligence API
app.get('/api/derivatives/status', (req, res) => {
    if (!derivativesIntel) return res.json({ enabled: false });
    res.json(derivativesIntel.getDerivativesStatus());
});
app.get('/api/derivatives/signal/:ticker', (req, res) => {
    if (!derivativesIntel) return res.json(null);
    const signal = derivativesIntel.getDerivativesSignal(req.params.ticker);
    res.json(signal);
});
app.get('/api/derivatives/all', (req, res) => {
    if (!derivativesIntel) return res.json({});
    res.json(derivativesIntel.getAllDerivativesData());
});
app.get('/api/derivatives/block-check/:ticker', (req, res) => {
    if (!derivativesIntel) return res.json({ block: false, reason: 'Service unavailable' });
    const longBlock = derivativesIntel.shouldBlockLongEntry(req.params.ticker);
    const shortFavor = derivativesIntel.shouldFavorShortEntry(req.params.ticker);
    res.json({ long: longBlock, short: shortFavor });
});

// #10 — Liquidation Levels
app.get('/api/derivatives/liquidation-levels/:ticker', (req, res) => {
    if (!derivativesIntel) return res.json({ available: false });
    res.json(derivativesIntel.getLiquidationLevels(req.params.ticker));
});

// Tier 1: Fear & Greed Gate API
app.get('/api/fear-greed/status', (req, res) => {
    if (!fearGreedGate) return res.json({ enabled: false });
    res.json(fearGreedGate.getFearGreedStatus());
});

// Social Sentiment Dashboard API
app.get('/api/sentiment/dashboard', async (req, res) => {
    try {
        const [fearGreed, news, trending] = await Promise.all([
            fetchFearGreedIndex(),
            fetchCryptoNews(),
            fetchCoinGeckoTrending(),
        ]);

        // Per-ticker sentiment for active positions
        const positionSentiments = {};
        for (const ticker of Object.keys(portfolio.positions)) {
            const tickerSent = getTickerNewsSentiment(ticker, news);
            positionSentiments[ticker] = tickerSent;
        }

        // Check which trending coins have Kraken USD pairs
        const trendingWithKraken = trending.map(c => ({
            ...c,
            krakenTicker: `${c.symbol}USD`,
            onKraken: QUALITY_TICKERS.includes(`${c.symbol}USD`) ||
                      (isNewListing && isNewListing(`${c.symbol}USD`)),
        }));

        res.json({
            fearGreed: {
                value: fearGreed.value,
                classification: fearGreed.classification,
            },
            topHeadlines: news.slice(0, 5).map(n => ({
                title: n.title,
                source: n.source,
                sentiment: n.sentiment,
                publishedAt: n.publishedAt,
            })),
            trendingCoins: trendingWithKraken,
            positionSentiments,
            lastUpdated: Date.now(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Tier 2: Order Book Microstructure API
app.get('/api/microstructure/status', (req, res) => {
    if (!orderBookMicro) return res.json({ enabled: false });
    res.json(orderBookMicro.getMicrostructureStatus());
});
app.get('/api/microstructure/analyze/:ticker', async (req, res) => {
    if (!orderBookMicro) return res.json({ error: 'Service unavailable' });
    try {
        const adapter = getExchangeAdapter();
        const orderBook = await adapter.getOrderBook(req.params.ticker, 20);
        const analysis = orderBookMicro.analyzeMicrostructure(orderBook, req.params.ticker);
        res.json(analysis);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Tier 2: CVaR Kelly API
app.get('/api/cvar-kelly/status', (req, res) => {
    if (!cvarKelly) return res.json({ enabled: false });
    res.json(cvarKelly.getCVaRStatus());
});

// Tier 2B: Whale Flow API
app.get('/api/whale-flow/status', (req, res) => {
    if (!whaleFlowTracker) return res.json({ enabled: false });
    res.json(whaleFlowTracker.getWhaleFlowStatus());
});
app.get('/api/whale-flow/signal/:ticker', (req, res) => {
    if (!whaleFlowTracker) return res.json({ direction: 'NEUTRAL', strength: 0 });
    res.json(whaleFlowTracker.getWhaleFlowSignal(req.params.ticker));
});

// Tier 3A: Basis Trading Engine API
app.get('/api/basis/status', (req, res) => {
    if (!basisEngine) return res.json({ enabled: false });
    res.json(basisEngine.getBasisStatus());
});
app.get('/api/basis/opportunities', (req, res) => {
    if (!basisEngine) return res.json([]);
    res.json(basisEngine.scanOpportunities());
});
app.post('/api/basis/open', (req, res) => {
    if (!basisEngine) return res.json({ success: false, reason: 'Service unavailable' });
    const { ticker, amount } = req.body || {};
    if (!ticker) return res.json({ success: false, reason: 'Missing ticker' });
    res.json(basisEngine.openBasisPosition(ticker, amount || 100));
});
app.post('/api/basis/close/:symbol', (req, res) => {
    if (!basisEngine) return res.json({ success: false, reason: 'Service unavailable' });
    res.json(basisEngine.closeBasisPosition(req.params.symbol));
});

// Tier 3B: Liquidation Sweep API
app.get('/api/liquidation-sweep/status', (req, res) => {
    if (!liquidationSweep) return res.json({ enabled: false });
    res.json(liquidationSweep.getSweepStatus());
});
app.get('/api/liquidation-sweep/detect/:ticker', (req, res) => {
    if (!liquidationSweep) return res.json({ sweep: false });
    const candles = marketDataMap?.get(req.params.ticker) || [];
    res.json(liquidationSweep.detectLiquidationSweep(req.params.ticker, candles));
});

// Tier 3B: ML A/B Test API
app.get('/api/ml-ab-test/status', (req, res) => {
    if (!mlABTest) return res.json({ enabled: false });
    res.json(mlABTest.getABTestStatus());
});

// Tier 3B: Meta-RL Agent API
app.get('/api/meta-rl/status', (req, res) => {
    if (!metaRL) return res.json({ enabled: false });
    res.json(metaRL.getMetaRLStatus());
});
app.get('/api/meta-rl/recommend/:regime', (req, res) => {
    if (!metaRL) return res.json({ error: 'Service unavailable' });
    res.json(metaRL.getRecommendedParams(req.params.regime));
});

// Time-of-day win rate tracker
app.get('/api/time-of-day/status', (req, res) => {
    res.json(timeOfDayTracker.getStatus());
});

// Per-ticker loss cooldown status
app.get('/api/ticker-cooldown/status', (req, res) => {
    res.json(tickerLossCooldown.getStatus());
});

// Native exchange stop-loss status
app.get('/api/native-sl/status', (req, res) => {
    const orders = [];
    for (const [ticker, sl] of nativeStopOrders) {
        orders.push({ ticker, ...sl });
    }
    res.json({ count: orders.length, orders });
});

// ─── Phase 3: Price Alerts, DCA, Reports, Staking, Funding, Regime ────────

// #6 — Price Alert API
app.post('/api/alerts', async (req, res) => {
    try {
        const { ticker, condition, targetPrice } = req.body;
        const { createAlert } = await import('./services/priceAlertService.js');
        const alert = createAlert(ticker, condition, targetPrice);
        res.json(alert);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.get('/api/alerts', async (req, res) => {
    try {
        const { listAlerts } = await import('./services/priceAlertService.js');
        res.json(listAlerts());
    } catch (e) {
        res.json([]);
    }
});
app.delete('/api/alerts/:id', async (req, res) => {
    try {
        const { deleteAlert } = await import('./services/priceAlertService.js');
        deleteAlert(parseInt(req.params.id));
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// #8 — Scheduled Reports
app.post('/api/reports/generate', async (req, res) => {
    try {
        const { generateDailyReport } = await import('./services/scheduledReports.js');
        const report = generateDailyReport();
        res.json(report || { error: 'No data' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/reports/latest', async (req, res) => {
    try {
        const { getLatestReport } = await import('./services/scheduledReports.js');
        res.json(getLatestReport() || {});
    } catch (e) {
        res.json({});
    }
});

// #9 — DCA Scheduler
app.post('/api/dca/schedule', async (req, res) => {
    try {
        const { createSchedule } = await import('./services/dcaScheduler.js');
        const { ticker, amountUsd, intervalHours } = req.body;
        res.json(createSchedule(ticker, amountUsd, intervalHours));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.get('/api/dca/schedules', async (req, res) => {
    try {
        const { listSchedules } = await import('./services/dcaScheduler.js');
        res.json(listSchedules());
    } catch (e) {
        res.json([]);
    }
});
app.delete('/api/dca/:id', async (req, res) => {
    try {
        const { deleteSchedule } = await import('./services/dcaScheduler.js');
        deleteSchedule(parseInt(req.params.id));
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.put('/api/dca/:id/pause', async (req, res) => {
    try {
        const { pauseSchedule } = await import('./services/dcaScheduler.js');
        pauseSchedule(parseInt(req.params.id));
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// #19 — Staking API
app.get('/api/staking/status', (req, res) => {
    try {
        res.json(stakingEngine.getStatus());
    } catch {
        res.json({ enabled: false });
    }
});
app.post('/api/staking/toggle', (req, res) => {
    try {
        const { enabled } = req.body;
        stakingEngine.setEnabled(!!enabled);
        res.json({ enabled: !!enabled });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// #20 — Funding Rate Comparison
app.get('/api/funding-rates/compare', async (req, res) => {
    try {
        let rates = [];
        if (derivativesIntel) {
            const allData = derivativesIntel.getAllDerivativesData();
            rates = Object.entries(allData).map(([ticker, data]) => ({
                ticker,
                rate: data?.fundingRate || 0,
                annualized: (data?.fundingRate || 0) * 3 * 365 * 100,
                exchange: 'OKX/Binance',
                basis: data?.basis || null,
            }));
        }
        res.json({ rates });
    } catch (e) {
        res.json({ rates: [] });
    }
});

// #3 — Portfolio Rebalancer
app.post('/api/rebalance/targets', async (req, res) => {
    try {
        const { setTargets } = await import('./services/portfolioRebalancer.js');
        setTargets(req.body);
        res.json({ success: true, targets: req.body });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
app.get('/api/rebalance/status', async (req, res) => {
    try {
        const { getRebalanceStatus } = await import('./services/portfolioRebalancer.js');
        res.json(getRebalanceStatus());
    } catch (e) {
        res.json({ enabled: false });
    }
});
app.post('/api/rebalance/execute', async (req, res) => {
    try {
        const { executeRebalance, isEnabled } = await import('./services/portfolioRebalancer.js');
        if (!isEnabled()) return res.status(400).json({ error: 'Rebalancer is disabled. Set PORTFOLIO_REBALANCER_ENABLED flag.' });
        const result = await executeRebalance(botState.sessionId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// #4 — Trade Export & Tax Reporting
app.get('/api/export/trades', async (req, res) => {
    try {
        const { format, from, to } = req.query;
        const { exportTradesCSV, exportTradesJSON } = await import('./services/tradeExporter.js');
        if (format === 'json') {
            res.json(exportTradesJSON(from, to));
        } else {
            const csv = exportTradesCSV(from, to);
            res.set('Content-Type', 'text/csv');
            res.set('Content-Disposition', `attachment; filename="trades-export.csv"`);
            res.send(csv);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/export/tax-report', async (req, res) => {
    try {
        const { year, format } = req.query;
        const y = parseInt(year) || new Date().getFullYear();
        const { generateTaxReport, generateTaxReportCSV } = await import('./services/tradeExporter.js');
        if (format === 'csv') {
            const csv = generateTaxReportCSV(y);
            res.set('Content-Type', 'text/csv');
            res.set('Content-Disposition', `attachment; filename="tax-report-${y}.csv"`);
            res.send(csv);
        } else {
            res.json(generateTaxReport(y));
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// #18 — Regime endpoint for signals router
app.get('/api/signals/regime', (req, res) => {
    try {
        const beastStatus = ctx.beastMode?.getBeastModeStatus?.();
        const regimes = [];
        if (beastStatus?.regimeCache) {
            for (const [ticker, regime] of Object.entries(beastStatus.regimeCache)) {
                regimes.push({ ticker, regime });
            }
        }
        res.json({ regimes, beastMode: beastStatus?.enabled || false });
    } catch {
        res.json({ regimes: [] });
    }
});

// Tier 2B: Position Reconciliation API
app.post('/api/reconcile', async (req, res) => {
    if (!positionReconciler) return res.json({ error: 'Service unavailable' });
    try {
        const recon = await positionReconciler.reconcilePositions(portfolio, botState.sessionId);
        res.json(recon);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/reconcile/auto-fix', async (req, res) => {
    if (!positionReconciler) return res.json({ error: 'Service unavailable' });
    try {
        const recon = await positionReconciler.reconcilePositions(portfolio, botState.sessionId);
        const fixes = positionReconciler.autoFixReconciliation(portfolio, recon, addLog);
        res.json({ reconciliation: recon, fixes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SPA catch-all (must be AFTER all API routes)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.use((err, req, res, next) => {
    res.status(500).json({ message: err.message });
});

const startServer = async () => {
    initializeDatabase();
    // Initialize DB batcher now that database is ready
    try {
        const db = getDb();
        dbBatcher.init((sql, params) => {
            try { db.prepare(sql).run(...params); } catch (e) { /* logged in batcher */ }
        });
    } catch (e) {
        console.warn('[Server] dbBatcher init failed:', e.message);
    }
    markAbandonedSessions();
    initJournalTable();
    initTelegram();
    initDiscord();
    initApiKeyHealthMonitor();

    // Phase 3: Price Alerts + DCA Scheduler
    try {
        const { initPriceAlerts, setPriceProvider, startAlertChecker } = await import('./services/priceAlertService.js');
        initPriceAlerts();
        setPriceProvider((ticker) => {
            const ws = getWebSocketService();
            return ws?.getPrice?.(ticker) || null;
        });
        startAlertChecker();
    } catch (e) {
        console.warn('[Server] PriceAlerts init failed:', e.message);
    }

    try {
        const { initDCAScheduler, setDCAAdapter, startDCAChecker } = await import('./services/dcaScheduler.js');
        initDCAScheduler();
        setDCAAdapter(getExchangeAdapter());
        startDCAChecker();
    } catch (e) {
        console.warn('[Server] DCA Scheduler init failed:', e.message);
    }

    // Phase 6: Portfolio Rebalancer
    try {
        const { initRebalancer } = await import('./services/portfolioRebalancer.js');
        initRebalancer(getExchangeAdapter(), portfolio);
    } catch (e) {
        console.warn('[Server] Rebalancer init failed:', e.message);
    }

    // Check exchange credentials at startup (no longer fatal — user can provide via login)
    if (getActiveExchangeId() === 'kraken') {
        if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_SECRET) {
            console.log('[Server] Kraken mode: no env vars set — user must authenticate via UI');
        } else {
            console.log('[Server] Kraken mode: env credentials available');
        }
    } else if (getActiveExchangeId() === 'crypto.com') {
        if (!process.env.SESSION_API_KEY || !process.env.SESSION_SECRET_KEY) {
            console.log('[Server] Crypto.com mode: no env vars set — user must authenticate via UI');
        } else {
            console.log('[Server] Crypto.com mode: env credentials available');
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
            // Bootstrap time-of-day tracker from restored trade history
            timeOfDayTracker.bootstrapFromTradeLog(portfolio.tradeLog);
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

    // Register a bridge with PortfolioManager so Core V2 dashboard shows real data
    try {
        const exchangeId = getActiveExchangeId();
        const engineBridge = {
            getStatus: () => {
                const posEntries = Object.values(portfolio.positions);
                const holdingsValue = posEntries.reduce((s, p) => s + p.quantity * (p.currentPrice || p.openPrice), 0);
                const equity = portfolio.cash + holdingsValue;
                const initialBudget = portfolio.initialBudget || equity;
                return {
                    exchange: exchangeId,
                    state: botState.isRunning ? 'RUNNING' : 'IDLE',
                    mode: botState.tradingMode,
                    sessionId: botState.sessionId,
                    equity,
                    cash: portfolio.cash,
                    initialBudget,
                    pnlUsd: equity - initialBudget,
                    pnlPct: initialBudget > 0 ? ((equity - initialBudget) / initialBudget) * 100 : 0,
                    positions: posEntries.length,
                    positionDetails: Object.entries(portfolio.positions).map(([ticker, p]) => ({
                        ticker,
                        entryPrice: p.openPrice,
                        currentPrice: p.currentPrice || p.openPrice,
                        quantity: p.quantity,
                        pnlPct: p.openPrice > 0 ? ((p.currentPrice || p.openPrice) - p.openPrice) / p.openPrice * 100 : 0,
                        strategy: p.entryStrategy || 'UNKNOWN',
                        holdTime: p.entryTime ? Date.now() - p.entryTime : 0,
                        regime: p.regime || 'UNKNOWN',
                    })),
                    portfolio: {
                        equity,
                        cash: portfolio.cash,
                        pnl: equity - initialBudget,
                        pnlPct: initialBudget > 0 ? ((equity - initialBudget) / initialBudget) * 100 : 0,
                        positions: posEntries.length,
                        exposurePct: equity > 0 ? (holdingsValue / equity * 100) : 0,
                    },
                    circuitBreaker: {
                        consecutiveLosses: botState.consecutiveLosses || 0,
                        dailyPnl: botState.dailyPnl || 0,
                        drawdownPct: botState.peakEquity > 0 ? ((botState.peakEquity - equity) / botState.peakEquity * 100) : 0,
                        isPaused: botState.circuitBreakerPaused || false,
                    },
                    trades: {
                        total: portfolio.tradeLog?.length || 0,
                        winRate: (() => {
                            const sells = (portfolio.tradeLog || []).filter(t => t.type === 'SELL');
                            if (sells.length === 0) return 0;
                            const wins = sells.filter(t => (t.pnl || 0) > 0).length;
                            return (wins / sells.length) * 100;
                        })(),
                        avgPnl: (() => {
                            const sells = (portfolio.tradeLog || []).filter(t => t.type === 'SELL');
                            if (sells.length === 0) return 0;
                            return sells.reduce((s, t) => s + (t.pnl || 0), 0) / sells.length;
                        })(),
                    },
                };
            },
            getPortfolio: () => ({
                cash: portfolio.cash,
                initialBudget: portfolio.initialBudget || portfolio.cash,
                positions: portfolio.positions,
            }),
            // Stubs for engine control routes (actual control is via /api/session/* routes)
            start: async () => { addLog('[Engine Bridge] Use /api/session/start', 'INFO'); },
            pause: async () => { addLog('[Engine Bridge] Use /api/session/pause', 'INFO'); },
            resume: async () => { addLog('[Engine Bridge] Use /api/session/resume', 'INFO'); },
            stop: async () => { addLog('[Engine Bridge] Use /api/session/stop', 'INFO'); },
            setMode: (mode) => { botState.tradingMode = mode; },
        };
        portfolioManager.registerEngine(exchangeId, engineBridge);
        // Expose bridge via ctx so engine routes work
        if (exchangeId === 'kraken') ctx.krakenEngine = engineBridge;
        else if (exchangeId === 'crypto.com') ctx.cryptoComEngine = engineBridge;
        console.log(`[Server] PortfolioManager bridge registered for ${exchangeId}`);
    } catch (e) {
        console.warn('[Server] PortfolioManager bridge failed:', e.message);
    }

    // Sync exchange fee to beast mode + optimizer at startup
    try {
        const startupFees = getActiveFees();
        beastSetRoundTripFee(startupFees.roundTrip * 100);
        setFeeForSimulation(startupFees.roundTrip * 100);
        console.log(`[Server] Fee synced: ${(startupFees.roundTrip * 100).toFixed(2)}% round-trip (${getActiveExchangeId()})`);
    } catch(e) {}

    // Load best seed exit targets — try to read regime-specific overrides from learned state
    // Best seed: mod_1772200892500_11a80bd5 (+16.68% OOS, 50.5% WR)
    // Maps 5-state regime overrides → 3-bucket format (HIGH_VOL/NORMAL/LOW_VOL)
    if (!restoredState?.optimizer) {
        let appliedFromSeed = false;
        try {
            // Try to load the best seed's learned state for regime-specific exits
            const db = getDb();
            const bestSeed = db.prepare(
                "SELECT learned_state_json FROM training_runs WHERE run_id LIKE 'mod_1772200892500%' ORDER BY created_at DESC LIMIT 1"
            ).get();
            if (bestSeed?.learned_state_json) {
                const learned = JSON.parse(bestSeed.learned_state_json);
                if (learned.tradeMemory?.regimeExitOverrides) {
                    const ro = learned.tradeMemory.regimeExitOverrides;
                    // Map 5-state regimes → 3 vol buckets
                    // STRONG_UP/UP → HIGH_VOL (wide targets, let runners run)
                    // SIDEWAYS → NORMAL
                    // DOWN/STRONG_DOWN → LOW_VOL (tight targets, quick exits)
                    setTargetOverrides({
                        HIGH_VOL: {
                            tp: ro.STRONG_UP?.tp || ro.UP?.tp || 20.0,
                            sl: ro.STRONG_UP?.sl || ro.UP?.sl || 3.5,
                        },
                        NORMAL: {
                            tp: ro.UP?.tp || ro.SIDEWAYS?.tp || 12.0,
                            sl: ro.SIDEWAYS?.sl || ro.UP?.sl || 3.5,
                        },
                        LOW_VOL: {
                            tp: ro.DOWN?.tp || ro.STRONG_DOWN?.tp || 8.0,
                            sl: ro.DOWN?.sl || ro.STRONG_DOWN?.sl || 3.0,
                        },
                    });
                    console.log('[Server] Best seed regime exit overrides applied from training DB');
                    appliedFromSeed = true;

                    // Apply max hold from seed exit params (168h for best seed)
                    if (learned.tradeMemory?.exitParams?.maxHold) {
                        botState._seedMaxHoldHours = learned.tradeMemory.exitParams.maxHold;
                        console.log(`[Server] Best seed maxHold applied: ${botState._seedMaxHoldHours}h`);
                    }

                    // Also apply blocked hours if present
                    if (learned.tradeMemory?.blockedHours?.length > 0) {
                        botState._blockedHours = learned.tradeMemory.blockedHours;
                        console.log(`[Server] Best seed blocked hours applied: ${learned.tradeMemory.blockedHours.join(', ')} UTC`);
                    }
                }
            }
        } catch (e) {
            console.warn('[Server] Could not load best seed regime overrides:', e.message);
        }

        if (!appliedFromSeed) {
            setTargetOverrides({
                HIGH_VOL: { tp: 12.0, sl: 3.5 },
                NORMAL:   { tp: 8.0,  sl: 3.5 },
                LOW_VOL:  { tp: 5.0,  sl: 3.0 },
            });
            console.log('[Server] Default exit targets loaded (TREND strategy, +16.68% OOS fallback)');
        }
    }

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

    // Initialize new coin detector
    try {
        if (initNewCoinDetector) await initNewCoinDetector();
        console.log('[Server] New coin detector initialized');
    } catch (err) {
        console.warn('[Server] New coin detector init failed:', err.message);
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

    // ─── Core V2 Module Initialization ─────────────────────────
    try {
        // Initialize TelegramV2 (subscribes to EventBus events)
        if (telegramV2?.createTelegramV2) {
            const tg2Instance = telegramV2.createTelegramV2();
            // Register exchange adapter for /price, /alert, /dca commands
            try {
                const adapter = getExchangeAdapter();
                if (adapter) tg2Instance.registerExchangeAdapter(adapter);
            } catch {}
            console.log('[Server] TelegramV2 event-driven notifications initialized');
        }
    } catch (e) {
        console.warn('[Server] TelegramV2 init failed:', e.message);
    }

    // Wire EventBus to existing systems (bridge old → new architecture)
    try {
        // Forward trade exits to short selling engine for price tracking
        tradingBus.on('engine:tick', (data) => {
            if (data.priceMap) {
                shortSellingEngine.checkExits(data.priceMap);
            }
        });
        console.log('[Server] EventBus wired to core V2 modules');
    } catch (e) {
        console.warn('[Server] EventBus wiring failed:', e.message);
    }

    // Start staking evaluation on interval (every hour)
    try {
        // Register exchange adapter so staking engine can execute real staking calls
        stakingEngine.registerAdapter(getActiveExchangeId(), getExchangeAdapter());
        // Wire active trading assets so staking engine avoids assets we're trading
        setInterval(() => {
            try {
                const tradingAssets = Object.keys(portfolio.positions || {});
                stakingEngine.setActiveTradingAssets(tradingAssets);
                stakingEngine.evaluate();
            } catch (e) {}
        }, 60 * 60 * 1000);
        console.log('[Server] Staking engine evaluation scheduled (hourly, adapter registered)');
    } catch (e) {
        console.warn('[Server] Staking engine init failed:', e.message);
    }

    // Start health monitor (checks every 30 seconds)
    try {
        healthMonitor.start(30000);
        healthMonitor.setSystemStatus('signalScanner', true);
        healthMonitor.setSystemStatus('webSocket', true);
        console.log('[Server] Health monitor started');
    } catch (e) {
        console.warn('[Server] Health monitor init failed:', e.message);
    }

    // ML degradation monitor — check every 15 minutes, alert if accuracy drops
    let _lastMLAccuracy = null;
    setInterval(() => {
        try {
            const mlStatus = mlPredictionService?.getMLStatus?.();
            if (!mlStatus?.accuracy || mlStatus.accuracy <= 0) return;
            const accuracy = mlStatus.accuracy;
            const MIN_ML_ACCURACY = 60; // Alert if below 60%
            if (accuracy < MIN_ML_ACCURACY && telegramEnabled()) {
                alertMLDegradation(accuracy, MIN_ML_ACCURACY,
                    `Samples: ${mlStatus.sampleCount || '?'}, Predictions: ${mlStatus.predictionCount || '?'}`);
            }
            // Alert on significant drop (>10 percentage points)
            if (_lastMLAccuracy !== null && _lastMLAccuracy - accuracy > 10 && telegramEnabled()) {
                alertMLDegradation(accuracy, _lastMLAccuracy,
                    `Dropped from ${_lastMLAccuracy.toFixed(1)}% → ${accuracy.toFixed(1)}% (${(_lastMLAccuracy - accuracy).toFixed(1)}pp decline)`);
            }
            _lastMLAccuracy = accuracy;
        } catch (e) {}
    }, 15 * 60 * 1000);

    // Concentration risk monitor — alert if any single position > 35% of portfolio
    setInterval(() => {
        try {
            const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce(
                (sum, p) => sum + (p.quantity * (p.currentPrice || p.openPrice)), 0);
            if (totalValue <= 0) return;
            for (const [ticker, pos] of Object.entries(portfolio.positions)) {
                const posValue = pos.quantity * (pos.currentPrice || pos.openPrice);
                const pct = (posValue / totalValue) * 100;
                if (pct > 35 && telegramEnabled()) {
                    alertConcentrationRisk(ticker, pct);
                }
            }
        } catch (e) {}
    }, 10 * 60 * 1000);

    // Start Derivatives Intelligence polling (Tier 1A)
    if (derivativesIntel) {
        try {
            derivativesIntel.startDerivativesPolling();
            console.log('[Server] Derivatives Intelligence started (5min polling)');
        } catch (e) {
            console.warn('[Server] Derivatives Intelligence init failed:', e.message);
        }
    }

    // Start Fear & Greed Gate (Tier 1B)
    if (fearGreedGate) {
        try {
            fearGreedGate.initFearGreedGate();
            console.log('[Server] Fear & Greed Gate initialized');
        } catch (e) {
            console.warn('[Server] Fear & Greed Gate init failed:', e.message);
        }
    }

    // Start Dead Man's Switch heartbeat for Kraken (Tier 1B)
    if (getActiveExchangeId() === 'kraken') {
        try {
            const adapter = getExchangeAdapter();
            if (adapter.cancelAllOrdersAfter) {
                // Set 90-second timeout, refresh every 60 seconds
                await adapter.cancelAllOrdersAfter(90, botState.sessionId);
                setInterval(async () => {
                    try {
                        await adapter.cancelAllOrdersAfter(90, botState.sessionId);
                    } catch (e) {
                        console.warn('[DeadManSwitch] Heartbeat failed:', e.message);
                    }
                }, 60 * 1000);
                console.log('[Server] Kraken Dead Man\'s Switch active (90s timeout, 60s heartbeat)');
            }
        } catch (e) {
            console.warn('[Server] Dead Man\'s Switch init failed:', e.message);
        }
    }

    // Start Basis Trading Engine (Tier 3A)
    if (basisEngine && derivativesIntel) {
        try {
            basisEngine.startBasisEngine();
            console.log('[Server] Basis Trading Engine started (sim mode, 30min checks)');
        } catch (e) {
            console.warn('[Server] Basis Trading Engine init failed:', e.message);
        }
    }

    // Register active exchange adapter with arbitrage engine
    try {
        const adapter = getExchangeAdapter();
        arbitrageEngine.registerAdapter(getActiveExchangeId(), adapter);
        // Arb engine needs 2+ exchanges to find opportunities — will activate when second exchange configured
        console.log(`[Server] ArbitrageEngine: ${getActiveExchangeId()} adapter registered (needs 2nd exchange for cross-exchange arb)`);
    } catch (e) {}

    // External health ping (healthchecks.io or similar)
    const HEALTH_PING_URL = process.env.HEALTH_PING_URL;
    if (HEALTH_PING_URL) {
        setInterval(async () => {
            try {
                await fetch(HEALTH_PING_URL, { method: 'GET', signal: AbortSignal.timeout(10000) });
            } catch (e) {
                console.warn('[Health] Ping failed:', e.message);
            }
        }, 5 * 60 * 1000); // Every 5 minutes
        console.log('[Server] External health ping configured');
    }

    // Scheduled SQLite backup — every 6 hours
    setInterval(async () => {
        try {
            const { mkdirSync, readdirSync, unlinkSync } = await import('node:fs');
            const backupDir = path.join(__dirname, 'data', 'backups');
            mkdirSync(backupDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupPath = path.join(backupDir, `trading-${timestamp}.db`);
            const db = getDb();
            await db.backup(backupPath);
            console.log(`[Backup] SQLite backed up to ${backupPath}`);
            // Clean up old backups (keep last 7)
            const backups = readdirSync(backupDir)
                .filter(f => f.startsWith('trading-') && f.endsWith('.db'))
                .sort();
            while (backups.length > 7) {
                const oldest = backups.shift();
                unlinkSync(path.join(backupDir, oldest));
                console.log(`[Backup] Removed old backup: ${oldest}`);
            }
        } catch (e) {
            console.warn(`[Backup] Scheduled backup error: ${e.message}`);
        }
    }, 6 * 60 * 60 * 1000); // Every 6 hours

    // Start Whale Flow Tracker (Tier 2B)
    if (whaleFlowTracker) {
        try {
            whaleFlowTracker.startWhaleFlowPolling();
            console.log('[Server] Whale Flow Tracker started (15min polling)');
        } catch (e) {
            console.warn('[Server] Whale Flow Tracker init failed:', e.message);
        }
    }

    // Position Reconciliation on startup (Tier 2B)
    if (positionReconciler && botState.sessionId) {
        try {
            const recon = await positionReconciler.reconcilePositions(portfolio, botState.sessionId);
            if (recon.reconciled && recon.actionsRequired.length > 0) {
                console.log(`[Reconciler] Found ${recon.actionsRequired.length} issues — auto-fixing...`);
                const fixes = positionReconciler.autoFixReconciliation(portfolio, recon, addLog);
                console.log(`[Reconciler] Applied ${fixes.actionsCount} fixes`);
            } else if (recon.reconciled) {
                console.log('[Reconciler] Positions match exchange — all clear');
            }
        } catch (e) {
            console.warn('[Reconciler] Startup reconciliation failed:', e.message);
        }
    }

    // Schedule DB cleanup weekly (Batch 5A: 90-day retention)
    setInterval(() => {
        try { cleanupOldData(90); } catch (e) { console.warn('[DB Cleanup] Error:', e.message); }
    }, 7 * 24 * 60 * 60 * 1000);

    // Continuous backtester DISABLED — buildFeatureVector per simulated trade blocks event loop
    // if (continuousBacktester) { continuousBacktester.start(); }
    console.log('[Server] Continuous backtester DISABLED (event loop protection)');

    const scanner = new SignalScanner(
        async (ticker, timeframe) => await getMarketData(ticker, timeframe, 100),
        addLog,
        injectSignal
    );
    scanner.start();
    _signalScannerRef = scanner;

    // Restore ML thought logger session
    if (restoredState?.botState?.sessionId) {
        const sid = getActiveSessionId() || restoredState.botState.sessionId;
        setThoughtSessionId(sid);
        restoreThoughts(sid);
    }

    // #17 — Enhanced auto-resume: restore session ID from SQLite if not in memory
    if (!botState.sessionId && restoredState?.wasActive) {
        try {
            const db = getDb();
            const row = db.prepare("SELECT value FROM settings WHERE key = 'last_session_id'").get();
            if (row?.value) {
                botState.sessionId = row.value;
                console.log(`[Server] Restored session ID from DB: ${row.value}`);
            }
        } catch { /* settings table may not have the row */ }
    }

    // Auto-start bot if it was active in previous session
    if (restoredState?.wasActive && botState.sessionId) {
        // Validate session with a lightweight API call
        let sessionValid = true;
        if (botState.tradingMode !== 'SIMULATION' && getActiveExchangeId() === 'kraken') {
            try {
                const adapter = getExchangeAdapter();
                await adapter.getBalance(botState.sessionId);
            } catch (e) {
                console.warn(`[Server] Session validation failed: ${e.message}. Not auto-resuming.`);
                sessionValid = false;
            }
        }

        if (sessionValid) {
            botState.isActive = true;
            botState.tradingMode = restoredState.botState?.tradingMode || 'SIMULATION';
            botState.sessionStartTime = restoredState.uptime?.startTime || Date.now();
            pmSetSessionStart(Date.now());
            botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);
            console.log('[Server] Bot auto-resumed from previous session');
            addLog('[SESSION] Bot auto-resumed after restart', 'INFO');

            // Persist session ID for next restart
            try {
                const db = getDb();
                db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_session_id', ?)").run(botState.sessionId);
            } catch { /* ignore */ }

            // Send Telegram notification about auto-resume
            try {
                const posCount = Object.keys(portfolio.positions).length;
                const { queueMessage } = await import('./services/telegramService.js');
                queueMessage?.(`▶️ <b>AUTO-RESUMED</b>\nMode: ${botState.tradingMode}\nPositions: ${posCount}\nSession: ${botState.sessionId.substring(0, 8)}...`);
            } catch { /* telegram may not be configured */ }
        }
    }

    // Fallback: auto-start SIM session if bot didn't auto-resume (fresh deploy or lost state)
    if (!botState.isActive) {
        const simSessionId = `sim_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const simBudget = portfolio.cash > 0 ? portfolio.cash : 10000;

        botState.isActive = true;
        botState.tradingMode = 'SIMULATION';
        botState.sessionId = simSessionId;
        botState.sessionStartTime = Date.now();
        botState.settings = {
            ...botState.settings,
            riskAmount: botState.settings.riskAmount || 0.15,
            maxConcurrentTrades: botState.settings.maxConcurrentTrades || 5,
            sessionProfitGoal: botState.settings.sessionProfitGoal || (simBudget * 2),
        };
        if (portfolio.cash <= 0) {
            portfolio.cash = simBudget;
            portfolio.initialBudget = simBudget;
        }

        pmSetSessionStart(Date.now());
        setActiveSession(simSessionId, 'SIMULATION');
        setThoughtSessionId(simSessionId);
        fullResetCircuitBreaker();
        fullResetBeastMode(portfolio.cash);

        if (botInterval) clearInterval(botInterval);
        botInterval = setInterval(tradingBotLoop, CONFIG.BOT_INTERVAL_MS);

        addLog(`[SESSION] Auto-started SIM session: $${simBudget} budget, ${availableTickers.length} tickers`, 'INFO');
        console.log(`[Server] Auto-started SIM session ${simSessionId} ($${simBudget} budget)`);

        try {
            const db = getDb();
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_session_id', ?)").run(simSessionId);
        } catch { /* ignore */ }

        // Notify Telegram
        try {
            const { queueMessage } = await import('./services/telegramService.js');
            queueMessage?.(`▶️ <b>AUTO-STARTED SIM</b>\nBudget: $${simBudget}\nTickers: ${availableTickers.length}\nSession: ${simSessionId.substring(0, 8)}...`);
        } catch { /* telegram may not be configured */ }
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

    // Alert Telegram
    try {
        if (telegramEnabled()) {
            const posCount = Object.keys(portfolio.positions).length;
            alertTradeExecution({
                type: 'SYSTEM',
                ticker: 'SHUTDOWN',
                price: 0,
                strategy: signal,
                pnl: null,
                reason: `Bot shutting down (${signal}). ${posCount} open positions. Native exchange SLs remain active.`,
            });
        }
    } catch (e) {}

    // Cancel Dead Man's Switch (let native SLs persist on exchange)
    // Do NOT cancel native stop orders — they protect positions while bot is down

    // Log final portfolio state
    try {
        const posCount = Object.keys(portfolio.positions).length;
        const totalPnl = (portfolio.tradeLog || []).reduce((sum, t) => sum + (t.pnl || 0), 0);
        console.log(`[Server] Final state: cash=$${portfolio.cash?.toFixed(2)}, positions=${posCount}, trades=${portfolio.tradeLog?.length || 0}, totalPnl=$${totalPnl.toFixed(2)}`);
    } catch (e) {
        console.warn('[Server] Could not log final portfolio:', e.message);
    }

    // Save state — preserve isActive so auto-resume works after restarts/deploys
    try {
        stopAutoSave();
        const wasRunning = botState.isActive;
        // Temporarily mark as active so restart auto-resumes the session
        if (wasRunning || botState.sessionId) {
            botState.isActive = true;
        }
        saveFullState({
            portfolio, botState,
            cbExportState, awExportState, beastExportState, pmExportState, optExportState,
            availableTickers,
        });
        // Also persist session ID for the fallback restore path
        if (botState.sessionId) {
            try {
                const db = getDb();
                db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_session_id', ?)").run(botState.sessionId);
            } catch { /* ignore */ }
        }
        console.log(`[Server] State saved successfully (wasRunning=${wasRunning})`);
    } catch (e) {
        console.error('[Server] State save failed:', e.message);
    }

    // Flush DB batcher before closing connections
    try {
        dbBatcher.shutdown();
        console.log('[Server] DB batcher flushed');
    } catch (e) {
        console.warn('[Server] DB batcher flush error:', e.message);
    }

    // Stop health monitor
    try {
        healthMonitor.stop();
    } catch (e) {}

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