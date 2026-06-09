import { Router } from 'express';
import { createLogger } from '../services/logger.js';
import { validateBody } from '../middleware/validate.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const log = createLogger('Sessions');

export default function createSessionsRouter(ctx) {
    const router = Router();

    // GET /session/status
    router.get('/session/status', (req, res) => {
        res.json(ctx.getSessionStatus(ctx.portfolio, ctx.botState));
    });

    // POST /session/pause — gated: stops the trading loop
    router.post('/session/pause', requireAdminAuth, (req, res) => {
        if (ctx.botState.isActive) {
            ctx.botState.isActive = false;
            if (ctx.botInterval) { clearInterval(ctx.botInterval); ctx.botInterval = null; }
            ctx.addLog('[SESSION] Bot paused via API', 'WARN');
            ctx.saveFullState({
                portfolio: ctx.portfolio, botState: ctx.botState,
                cbExportState: ctx.cbExportState, awExportState: ctx.awExportState,
                beastExportState: ctx.beastExportState, pmExportState: ctx.pmExportState,
                optExportState: ctx.optExportState,
                availableTickers: ctx.availableTickers,
            });
        }
        res.json({ success: true, botActive: false });
    });

    // POST /session/resume — gated: restarts the trading loop
    router.post('/session/resume', requireAdminAuth, async (req, res) => {
        if (!ctx.botState.isActive) {
            ctx.botState.isActive = true;
            ctx.botInterval = setInterval(ctx.tradingBotLoop, ctx.CONFIG.BOT_INTERVAL_MS);
            ctx.addLog('[SESSION] Bot resumed via API', 'INFO');
        }
        // Ensure we have a full ticker list, not just session-saved subset
        if (ctx.availableTickers.length < 10) {
            try {
                await ctx.updateAvailableTickers();
                ctx.addLog(`[SESSION] Refreshed tickers: ${ctx.availableTickers.length} available`, 'INFO');
            } catch (e) {}
        }
        res.json({ success: true, botActive: true });
    });

    // POST /session/start — admin-gated: accepts mode:'REAL' (real-money trading),
    // so it must never be reachable by unauthenticated remote clients.
    router.post('/session/start', requireAdminAuth, validateBody({
        mode: { type: 'string', oneOf: ['SIMULATION', 'REAL'] },
        budget: { type: 'number', min: 1, max: 10000000 },
        tickers: { type: 'array' },
    }), async (req, res) => {
        try {
            const { mode = 'SIMULATION', budget = 10000, tickers, trainedRunId } = req.body;

            if (ctx.botState.isActive) {
                return res.status(400).json({ error: 'A session is already active. Stop it first.' });
            }

            if (mode === 'REAL' && !process.env.KRAKEN_API_KEY && !process.env.KRAKEN_SECRET) {
                return res.status(400).json({ error: 'Real trading requires exchange API keys configured in .env' });
            }

            const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            try { ctx.insertSessionRecord(sessionId, Date.now(), budget, mode); } catch(e) { console.error('[SESSION] DB insert failed:', e.message); }

            if (mode === 'SIMULATION') {
                ctx.portfolio.cash = budget;
                ctx.portfolio.initialBudget = budget;
                ctx.portfolio.positions = {};
                ctx.portfolio.holdings = {};
                if (!ctx.portfolio.tradeLog) ctx.portfolio.tradeLog = [];
            } else {
                // REAL mode: clear any leftover SIM positions to prevent ghost trades
                ctx.portfolio.positions = {};
                ctx.portfolio.holdings = {};
                ctx.portfolio.tradeLog = [];
            }

            ctx.botState.isActive = true;
            ctx.botState.tradingMode = mode;
            ctx.botState.sessionStartTime = Date.now();
            ctx.pmSetSessionStart(Date.now());
            ctx.botState.settings = {
                ...ctx.botState.settings,
                riskAmount: ctx.botState.settings.riskAmount || 0.15,
                maxConcurrentTrades: ctx.botState.settings.maxConcurrentTrades || 5,
                sessionProfitGoal: ctx.botState.settings.sessionProfitGoal || (budget * 2),
            };

            ctx.setActiveSession(sessionId, mode);
            ctx.setThoughtSessionId(sessionId);

            // Always ensure we have a full ticker list for scanning
            // User-selected tickers are stored for display but don't restrict the bot's scan pool
            if (ctx.availableTickers.length < 10) {
                await ctx.updateAvailableTickers();
            }
            // Merge in any user-selected tickers that might not be in the exchange list
            if (tickers && tickers.length > 0) {
                for (const t of tickers) {
                    if (!ctx.availableTickers.includes(t)) {
                        ctx.availableTickers.push(t);
                    }
                }
            }

            ctx.fullResetCircuitBreaker();
            ctx.fullResetBeastMode(ctx.portfolio.cash);
            ctx.fullResetWeights();
            // Clear stale per-ticker cooldowns from previous session
            if (ctx.tradingBotLoop?._reEntryCooldowns) ctx.tradingBotLoop._reEntryCooldowns.clear();
            if (ctx.tradingBotLoop?._pyramidTimers) {
                for (const timer of ctx.tradingBotLoop._pyramidTimers.values()) clearTimeout(timer);
                ctx.tradingBotLoop._pyramidTimers.clear();
            }
            ctx.setDailyBalance(ctx.portfolio.cash);
            ctx.peakValue = ctx.portfolio.cash;

            // Apply trained state from Time Machine if requested
            if (trainedRunId) {
                try {
                    const learnedState = ctx.getLearnedState(trainedRunId);
                    if (learnedState) {
                        if (learnedState.adaptiveWeights) {
                            const awState = {};
                            for (const [strategy, data] of Object.entries(learnedState.adaptiveWeights)) {
                                awState[strategy] = {
                                    weight: data.weight || 1.0,
                                    wins: data.wins || 0,
                                    losses: data.losses || 0,
                                    totalPnl: data.totalPnl || 0,
                                };
                            }
                            ctx.awImportState(awState);
                        }
                        if (learnedState.circuitBreaker) {
                            ctx.cbImportState({
                                totalTrades: learnedState.circuitBreaker.totalTrades,
                                totalWins: learnedState.circuitBreaker.totalWins,
                                totalLosses: learnedState.circuitBreaker.totalLosses,
                            });
                        }
                        if (learnedState.optimizer) {
                            ctx.optImportState(learnedState.optimizer);
                        }
                        ctx.addLog(`[SESSION] Applied trained state from run ${trainedRunId}`, 'SPECIAL');
                    } else {
                        ctx.addLog(`[SESSION] Warning: No trained state found for run ${trainedRunId}`, 'WARN');
                    }
                } catch (e) {
                    console.error('[SESSION] Failed to apply trained state:', e.message);
                    ctx.addLog(`[SESSION] Failed to apply trained state: ${e.message}`, 'ERROR');
                }
            }

            if (ctx.botInterval) clearInterval(ctx.botInterval);
            ctx.botInterval = setInterval(ctx.tradingBotLoop, ctx.CONFIG.BOT_INTERVAL_MS);

            ctx.addLog(`[SESSION] Started ${mode} session: $${budget} budget, ${ctx.availableTickers.length} tickers`, 'INFO');
            ctx.saveSessionState();
            ctx.recordEquitySnapshot(ctx.portfolio);

            res.json({
                success: true,
                sessionId,
                mode,
                budget: ctx.portfolio.cash,
                tickers: ctx.availableTickers.slice(0, 20),
                botActive: true,
            });
        } catch (error) {
            log.error('session/start failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // POST /session/stop — admin-gated: force-closes all open positions.
    router.post('/session/stop', requireAdminAuth, async (req, res) => {
        try {
            const wasActive = ctx.botState.isActive;

            const closedPositions = [];
            for (const [ticker, position] of Object.entries(ctx.portfolio.positions)) {
                const currentPrice = ctx.getLatestPrice(ticker) || position.openPrice;
                try {
                    await ctx.handleSell(position, currentPrice, 'SESSION_STOP: Closing all positions');
                    const fees = ctx.getActiveFees?.() || { perSide: 0.0026 };
                    const grossPnl = (currentPrice - position.openPrice) * position.quantity;
                    const roundTripFee = (position.openPrice + currentPrice) * position.quantity * fees.perSide;
                    closedPositions.push({ ticker, price: currentPrice, pnl: grossPnl - roundTripFee });
                } catch (e) {
                    ctx.addLog(`Failed to close ${ticker}: ${e.message}`, 'ERROR');
                }
            }

            ctx.botState.isActive = false;
            if (ctx.botInterval) { clearInterval(ctx.botInterval); ctx.botInterval = null; }

            ctx.recordEquitySnapshot(ctx.portfolio);

            const stats = ctx.getTradeStats();
            const equityCurve = ctx.getEquityCurve();
            const sessionStatus = ctx.getSessionStatus(ctx.portfolio, ctx.botState);

            const summary = {
                success: true,
                wasActive,
                closedPositions,
                finalCash: ctx.portfolio.cash,
                initialBudget: ctx.portfolio.initialBudget,
                totalPnl: ctx.portfolio.cash - ctx.portfolio.initialBudget,
                pnlPercent: ctx.portfolio.initialBudget > 0
                    ? parseFloat(((ctx.portfolio.cash - ctx.portfolio.initialBudget) / ctx.portfolio.initialBudget * 100).toFixed(2))
                    : 0,
                tradeStats: stats,
                equityCurveLength: equityCurve.length,
                session: sessionStatus,
            };

            ctx.addLog(`[SESSION] Stopped. Final: $${ctx.portfolio.cash.toFixed(2)} (${summary.pnlPercent}%)`, 'WARN');

            try {
                const activeSessionId = ctx.getActiveSessionId();
                if (activeSessionId) {
                    const sellCount = stats?.sells || 0;
                    const winCount = stats?.wins || 0;
                    const wr = sellCount > 0 ? (winCount / sellCount * 100) : 0;
                    ctx.completeSession(activeSessionId, Date.now(), ctx.portfolio.cash, sellCount, wr, summary.totalPnl);
                }
            } catch(e) { console.error('[SESSION] DB complete failed:', e.message); }

            ctx.saveFullState({
                portfolio: ctx.portfolio, botState: ctx.botState,
                cbExportState: ctx.cbExportState, awExportState: ctx.awExportState,
                beastExportState: ctx.beastExportState, pmExportState: ctx.pmExportState,
                optExportState: ctx.optExportState,
                availableTickers: ctx.availableTickers,
            });

            res.json(summary);
        } catch (error) {
            log.error('session/stop failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /session/full-status
    router.get('/session/full-status', (req, res) => {
        try {
            const holdingsValue = Object.values(ctx.portfolio.positions || {}).reduce(
                (sum, pos) => sum + ((pos.quantity || 0) * (pos.currentPrice || pos.openPrice || 0)),
                0
            );
            const totalValue = (ctx.portfolio.cash || 0) + holdingsValue;

            res.json({
                sessionActive: ctx.botState.isActive,
                tradingMode: ctx.botState.tradingMode,
                sessionStartTime: ctx.botState.sessionStartTime,
                uptime: ctx.botState.sessionStartTime ? Math.max(0, Date.now() - ctx.botState.sessionStartTime) : 0,

                portfolio: {
                    cash: ctx.portfolio.cash,
                    initialBudget: ctx.portfolio.initialBudget,
                    holdingsValue,
                    totalValue,
                    pnl: totalValue - (ctx.portfolio.initialBudget || 0),
                    pnlPercent: ctx.portfolio.initialBudget > 0
                        ? ((totalValue - ctx.portfolio.initialBudget) / ctx.portfolio.initialBudget * 100)
                        : 0,
                    positions: Object.entries(ctx.portfolio.positions || {}).map(([ticker, pos]) => ({
                        ticker,
                        quantity: pos.quantity,
                        openPrice: pos.openPrice,
                        currentPrice: pos.currentPrice || pos.openPrice,
                        entryStrategy: pos.entryStrategy,
                        entryTime: pos.entryTime,
                        unrealizedPnl: ((pos.currentPrice || pos.openPrice) - pos.openPrice) * pos.quantity,
                        unrealizedPnlPercent: pos.openPrice > 0 ? ((pos.currentPrice || pos.openPrice) - pos.openPrice) / pos.openPrice * 100 : 0,
                        highestPrice: pos.highestPrice,
                        lowestPrice: pos.lowestPrice,
                    })),
                    holdings: ctx.portfolio.holdings || {},
                },

                logs: ctx.logs.slice(0, 50),

                botState: {
                    isActive: ctx.botState.isActive,
                    tradingMode: ctx.botState.tradingMode,
                    settings: ctx.botState.settings,
                },

                exchange: {
                    id: ctx.getActiveExchangeId(),
                    fees: ctx.getActiveFees(),
                    wsConnected: ctx.wsConnected(),
                    tickerCount: ctx.availableTickers.length,
                },

                ml: {
                    currentFocus: ctx.getCurrentFocus(),
                    thoughtStats: ctx.getThoughtStats(),
                    recentThoughts: ctx.getThoughts(10),
                },

                circuitBreaker: ctx.getCircuitBreakerStatus(),
                beastMode: ctx.getBeastModeStatus(),
                adaptiveWeights: ctx.getAdaptiveWeightsStatus(),
                optimizer: ctx.getOptimizerStatus(ctx.portfolio.tradeLog),

                session: ctx.getSessionStatus(ctx.portfolio, ctx.botState),
            });
        } catch (error) {
            log.error('session/full-status failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /session/trades
    router.get('/session/trades', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 500;
            const trades = ctx.getTradeHistory(null, limit);
            const stats = ctx.getTradeStats();
            res.json({ trades, stats });
        } catch (error) {
            log.error('session/trades failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /session/equity-curve
    router.get('/session/equity-curve', (req, res) => {
        try {
            const curve = ctx.getEquityCurve();
            res.json({ curve });
        } catch (error) {
            log.error('session/equity-curve failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // POST /session/settings — admin-gated: mutates risk/position-sizing settings.
    router.post('/session/settings', requireAdminAuth, validateBody({
        riskAmount: { type: 'number', min: 0.01, max: 1.0 },
        maxConcurrentTrades: { type: 'number', min: 1, max: 50 },
        sessionProfitGoal: { type: 'number', min: 0 },
    }), (req, res) => {
        try {
            const { riskAmount, maxConcurrentTrades, sessionProfitGoal, profitGoals, unlimitedTrades } = req.body;
            if (riskAmount !== undefined) ctx.botState.settings.riskAmount = riskAmount;
            if (maxConcurrentTrades !== undefined) ctx.botState.settings.maxConcurrentTrades = maxConcurrentTrades;
            if (sessionProfitGoal !== undefined) ctx.botState.settings.sessionProfitGoal = sessionProfitGoal;
            if (profitGoals !== undefined) ctx.botState.settings.profitGoals = profitGoals;
            if (unlimitedTrades !== undefined) ctx.botState.settings.unlimitedTrades = !!unlimitedTrades;
            ctx.saveSessionState();
            res.json({ success: true, settings: ctx.botState.settings });
        } catch (error) {
            log.error('session/settings failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /sessions/history
    router.get('/sessions/history', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const sessions = ctx.getSessionHistory(limit);
            res.json({ sessions });
        } catch (error) {
            log.error('sessions/history failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /sessions/:sessionId/details
    router.get('/sessions/:sessionId/details', (req, res) => {
        try {
            const detail = ctx.getSessionDetail(req.params.sessionId);
            if (!detail) return res.status(404).json({ error: 'Session not found' });
            res.json(detail);
        } catch (error) {
            log.error('sessions/:sessionId/details failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // POST /sessions/:sessionId/restore — gated: effectively starts a new session
    router.post('/sessions/:sessionId/restore', requireAdminAuth, async (req, res) => {
        try {
            if (ctx.botState.isActive) {
                return res.status(400).json({ error: 'A session is already active. Stop it first.' });
            }
            const detail = ctx.getSessionDetail(req.params.sessionId);
            if (!detail?.session) return res.status(404).json({ error: 'Session not found' });
            const lastSnap = detail.equityCurve.length > 0 ? detail.equityCurve[detail.equityCurve.length - 1] : null;
            const restoreBudget = lastSnap?.cash || detail.session.final_value || detail.session.initial_budget || 10000;

            const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            try { ctx.insertSessionRecord(sessionId, Date.now(), restoreBudget, 'SIMULATION', `Restored from ${req.params.sessionId}`); } catch(e) {}
            ctx.portfolio.cash = restoreBudget;
            ctx.portfolio.initialBudget = restoreBudget;
            ctx.portfolio.positions = {};
            ctx.portfolio.holdings = {};
            if (!ctx.portfolio.tradeLog) ctx.portfolio.tradeLog = [];
            ctx.botState.isActive = true;
            ctx.botState.tradingMode = 'SIMULATION';
            ctx.botState.sessionStartTime = Date.now();
            ctx.pmSetSessionStart(Date.now());
            ctx.setActiveSession(sessionId, 'SIMULATION');
            ctx.setThoughtSessionId(sessionId);
            ctx.fullResetCircuitBreaker();
            ctx.fullResetBeastMode(ctx.portfolio.cash);
            ctx.fullResetWeights();
            ctx.setDailyBalance(ctx.portfolio.cash);
            ctx.peakValue = ctx.portfolio.cash;
            if (ctx.botInterval) clearInterval(ctx.botInterval);
            ctx.botInterval = setInterval(ctx.tradingBotLoop, ctx.CONFIG.BOT_INTERVAL_MS);
            ctx.addLog(`[SESSION] Restored from abandoned session with $${restoreBudget.toFixed(2)} budget`, 'INFO');
            ctx.saveSessionState();
            ctx.recordEquitySnapshot(ctx.portfolio);
            res.json({ success: true, sessionId, budget: restoreBudget, restoredFrom: req.params.sessionId });
        } catch (error) {
            log.error('sessions/:sessionId/restore failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
