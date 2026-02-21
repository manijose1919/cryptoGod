import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Questrade');

export default function createQuestradeRouter(ctx) {
    const router = Router();
    const { questrade, paperTrader, strategyEngine, brain, questradeBotState, addLog } = ctx;

    // POST /questrade/auth
    router.post('/questrade/auth', async (req, res) => {
        try {
            const { refreshToken, isPractice } = req.body;
            if (refreshToken) {
                questrade.isPractice = isPractice ?? true;
            }
            await questrade.authenticate(refreshToken);
            res.status(200).json({ success: true, status: questrade.getStatus() });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/status
    router.get('/questrade/status', (req, res) => {
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

    // GET /questrade/accounts
    router.get('/questrade/accounts', async (req, res) => {
        try {
            const accounts = await questrade.getAccounts();
            res.status(200).json({ accounts });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/balance/:accountId
    router.get('/questrade/balance/:accountId', async (req, res) => {
        try {
            const data = await questrade.getBalance(req.params.accountId);
            res.status(200).json(data);
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/positions/:accountId
    router.get('/questrade/positions/:accountId', async (req, res) => {
        try {
            const positions = await questrade.getPositions(req.params.accountId);
            res.status(200).json({ positions });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/candles
    router.get('/questrade/candles', async (req, res) => {
        try {
            const { symbol, interval, start, end } = req.query;
            if (!symbol) return res.status(400).json({ message: 'symbol is required' });
            const candles = await questrade.getCandlesByTicker(symbol, interval || '1m', start, end);
            res.status(200).json({ candles });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/search
    router.get('/questrade/search', async (req, res) => {
        try {
            const { prefix } = req.query;
            if (!prefix) return res.status(400).json({ message: 'prefix is required' });
            const symbols = await questrade.searchSymbol(prefix);
            res.status(200).json({ symbols });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/symbols
    router.get('/questrade/symbols', async (req, res) => {
        try {
            const { exchange } = req.query;
            if (!exchange) return res.status(400).json({ message: 'exchange is required' });
            const symbols = await questrade.getSymbolsByExchange(exchange);
            res.status(200).json({ symbols });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // POST /questrade/order
    router.post('/questrade/order', async (req, res) => {
        try {
            const { accountId, ticker, side, quantity, orderType, limitPrice } = req.body;
            if (!ticker || !side || !quantity) {
                return res.status(400).json({ message: 'ticker, side, and quantity are required' });
            }

            if (questradeBotState.isPaper) {
                const trade = await paperTrader.createOrder(ticker, side, quantity, orderType || 'MARKET', limitPrice);
                res.status(200).json({ success: true, trade, paper: true });
            } else {
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

    // GET /questrade/paper/summary
    router.get('/questrade/paper/summary', async (req, res) => {
        try {
            const summary = await paperTrader.getAccountSummary();
            res.status(200).json(summary);
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // GET /questrade/paper/history
    router.get('/questrade/paper/history', (req, res) => {
        res.status(200).json({ trades: paperTrader.getHistory() });
    });

    // POST /questrade/paper/reset
    router.post('/questrade/paper/reset', (req, res) => {
        const { balance } = req.body;
        paperTrader.reset(balance || 100000);
        res.status(200).json({ success: true, message: 'Paper trading reset' });
    });

    // POST /questrade/bot/start
    router.post('/questrade/bot/start', async (req, res) => {
        try {
            const { watchlist, isPaper, accountId } = req.body;
            if (questradeBotState.isActive) {
                return res.status(400).json({ message: 'Questrade bot already running' });
            }

            if (!questrade.isAuthenticated()) {
                await questrade.authenticate();
            }

            questradeBotState.isActive = true;
            questradeBotState.isPaper = isPaper !== false;
            questradeBotState.accountId = accountId || null;
            if (watchlist && Array.isArray(watchlist)) {
                questradeBotState.watchlist = watchlist;
            }

            questradeBotState.interval = setInterval(() => questradeBotLoop(), questradeBotState.loopMs);
            addLog(`[QUESTRADE BOT] Started (${questradeBotState.isPaper ? 'Paper' : 'Live'}) - Watchlist: ${questradeBotState.watchlist.join(', ')}`, 'INFO');
            res.status(200).json({ success: true, state: questradeBotState });
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    });

    // POST /questrade/bot/stop
    router.post('/questrade/bot/stop', (req, res) => {
        if (questradeBotState.interval) {
            clearInterval(questradeBotState.interval);
            questradeBotState.interval = null;
        }
        questradeBotState.isActive = false;
        addLog('[QUESTRADE BOT] Stopped', 'INFO');
        res.status(200).json({ success: true });
    });

    // Questrade Bot Loop (internal)
    function isMarketOpen() {
        const now = new Date();
        const etOffset = -5;
        const utcHour = now.getUTCHours();
        const utcMin = now.getUTCMinutes();
        const etHour = (utcHour + etOffset + 24) % 24;
        const etMinutes = etHour * 60 + utcMin;
        const dayOfWeek = now.getUTCDay();

        if (dayOfWeek === 0 || dayOfWeek === 6) return false;
        const marketOpen = 9 * 60 + 30;
        const marketClose = 16 * 60;
        return etMinutes >= marketOpen && etMinutes < marketClose;
    }

    async function questradeBotLoop() {
        if (!questradeBotState.isActive) return;

        try {
            if (!isMarketOpen()) {
                if (Math.random() < 0.01) {
                    addLog('[QUESTRADE BOT] Market closed - waiting', 'INFO');
                }
                return;
            }

            const watchlist = questradeBotState.watchlist;

            for (const ticker of watchlist) {
                try {
                    const candles = await questrade.getCandlesByTicker(ticker, '5m');
                    if (!candles || candles.length < 50) continue;

                    const signals = strategyEngine.evaluate(ticker, candles);
                    if (signals.length === 0) continue;

                    const bestSignal = signals.reduce((best, s) =>
                        s.confidence > best.confidence ? s : best, signals[0]
                    );

                    let aiDecision = { decision: 'YES', confidence: bestSignal.confidence * 100 };
                    if (bestSignal.confidence < 0.8) {
                        try {
                            const lastCandle = candles[candles.length - 1];
                            aiDecision = await brain.analyzeTradeOpportunity(
                                ticker, signals, {},
                                { price: lastCandle.c, volume: lastCandle.v }
                            );
                        } catch (e) { /* AI failure shouldn't block trades */ }
                    }

                    if (aiDecision.decision === 'NO') continue;

                    const lastPrice = candles[candles.length - 1].c;
                    const positionSize = questradeBotState.isPaper
                        ? Math.floor((paperTrader.portfolio.cash * 0.1) / lastPrice)
                        : 1;

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
                        const hasPosition = questradeBotState.isPaper
                            ? !!paperTrader.portfolio.positions[ticker]
                            : false;

                        if (hasPosition) {
                            const pos = paperTrader.portfolio.positions[ticker];
                            if (questradeBotState.isPaper) {
                                await paperTrader.createOrder(ticker, 'SELL', pos.quantity);
                            }
                            addLog(`[QUESTRADE BOT] SELL ${pos.quantity} ${ticker} @ ${lastPrice} (${bestSignal.strategy}: ${bestSignal.reason})`, 'SELL');
                        }
                    }

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

    return router;
}
