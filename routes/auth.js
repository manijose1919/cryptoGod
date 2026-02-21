import { Router } from 'express';
import crypto from 'node:crypto';
import { createLogger } from '../services/logger.js';
import { validateBody } from '../middleware/validate.js';

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
            let balanceResult = await ctx.makeSignedRequest('private/user-balance', {}, sessionId);

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

            const totalBalance = cashBalance;
            ctx.portfolio.cash = cashBalance;
            ctx.portfolio.initialBudget = totalBalance;
            ctx.portfolio.positions = {};
            ctx.portfolio.holdings = holdings;
            ctx.botState.sessionId = sessionId;
            ctx.beastSetSessionBalance(totalBalance);
            ctx.saveSessionState();

            res.status(200).json({ balance: totalBalance, holdings, sessionId, portfolio: ctx.portfolio });
        } catch (error) {
            next(error);
        }
    });

    // GET /ws-auth
    router.get('/ws-auth', (req, res) => {
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
