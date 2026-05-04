import { Router } from 'express';
import crypto from 'node:crypto';
import { createLogger } from '../services/logger.js';
import { validateBody } from '../middleware/validate.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const log = createLogger('Auth');

export default function createAuthRouter(ctx) {
    const router = Router();

    // POST /test-connection
    router.post('/test-connection', async (req, res, next) => {
        try {
            if (ctx.publicIp === 'not detected' || ctx.publicIp === 'error fetching IP') {
                await ctx.logPublicIp();
            }
            res.status(200).json({ message: 'Backend connection successful!', ip: ctx.publicIp });
        } catch (error) {
            next(error);
        }
    });

    // POST /login
    router.post('/login', validateBody({
        apiKey: { type: 'string', required: true },
        secretKey: { type: 'string', required: true },
    }), async (req, res, next) => {
        try {
            const { apiKey, secretKey } = req.body;

            const sessionId = ctx.SessionManager.createSession(apiKey, secretKey);
            const adapter = ctx.getExchangeAdapter();
            let { cashBalance, holdings } = await adapter.getBalance(sessionId);

            // Safety net: if CAD/USD/EUR/GBP ended up in holdings, move to cashBalance
            const fiatKeys = Object.keys(holdings).filter(k => /^(CAD|USD|EUR|GBP)$/i.test(k));
            for (const fk of fiatKeys) {
                const fiatQty = holdings[fk].quantity || 0;
                if (fk.toUpperCase() === 'CAD' && fiatQty > 0) {
                    // Convert CAD to USD (approximate)
                    const cadToUsd = fiatQty / 1.37;
                    log.info(`Moving ${fiatQty} CAD from holdings to cash as $${cadToUsd.toFixed(2)} USD`);
                    cashBalance += cadToUsd;
                } else {
                    cashBalance += fiatQty;
                }
                delete holdings[fk];
            }

            // Also price any holdings that have usdValue=0 but valid quantity
            for (const [asset, h] of Object.entries(holdings)) {
                if (h.usdValue === 0 && h.quantity > 0) {
                    try {
                        const pairName = asset === 'BTC' ? 'XBTUSD' : asset + 'USD';
                        const tickerRes = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairName}`);
                        const tickerData = await tickerRes.json();
                        if (!tickerData.error?.length) {
                            const key = Object.keys(tickerData.result || {})[0];
                            if (key) {
                                const price = parseFloat(tickerData.result[key]?.c?.[0] || '0');
                                if (price > 0) {
                                    h.usdValue = h.quantity * price;
                                    h.price = price;
                                }
                            }
                        }
                    } catch { /* non-fatal */ }
                }
            }

            const holdingsValue = Object.values(holdings).reduce((sum, h) => sum + (h.usdValue || 0), 0);
            const totalBalance = cashBalance + holdingsValue;
            log.info('Auth balance breakdown', { cashBalance, holdingsValue, totalBalance, holdings });
            // Use totalBalance as cash so frontend shows full account value
            ctx.portfolio.cash = totalBalance;
            ctx.portfolio.initialBudget = totalBalance;
            ctx.portfolio.positions = {};
            ctx.portfolio.holdings = holdings;
            ctx.botState.sessionId = sessionId;
            ctx.botState.tradingMode = 'REAL';
            ctx.botState.isActive = true;
            ctx.beastSetSessionBalance(totalBalance);
            ctx.saveSessionState();

            const response = { balance: totalBalance, holdings, sessionId, portfolio: ctx.portfolio, _debug: { cashBalance, holdingsValue, codeVersion: 'v2-cad-fix' } };
            log.info('Auth response', { balance: totalBalance, holdingsCount: Object.keys(holdings).length });
            res.status(200).json(response);
        } catch (error) {
            next(error);
        }
    });

    // GET /debug-balance — temporary debug endpoint (C4: admin-gated)
    router.get('/debug-balance', requireAdminAuth, async (req, res) => {
        try {
            const sessionId = ctx.botState.sessionId;
            if (!sessionId) return res.status(400).json({ error: 'No active session. Login first.' });
            const adapter = ctx.getExchangeAdapter();
            const balanceData = await adapter.getBalance(sessionId);
            res.json({ balanceData, currentPortfolio: { cash: ctx.portfolio.cash, holdings: ctx.portfolio.holdings } });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /ws-auth (C4: admin-gated — endpoint returns a signed Crypto.com WS
    // auth payload using the server's session keys. An attacker with this
    // payload can authenticate as the user against Crypto.com WS within the
    // signature replay window.)
    router.get('/ws-auth', requireAdminAuth, (req, res) => {
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
            log.error('WebSocket auth generation failed', { error: error.message });
            res.status(500).json({ message: 'Failed to generate WebSocket auth', error: error.message });
        }
    });

    return router;
}
