import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Exchange');

export default function createExchangeRouter(ctx) {
    const router = Router();

    // GET /exchange/current
    router.get('/exchange/current', (req, res) => {
        const adapter = ctx.getExchangeAdapter();
        res.json({
            exchange: adapter.getName(),
            feePercent: adapter.getFeePercent() * 100,
            roundTripFeePercent: adapter.getFeePercent() * 200,
        });
    });

    // POST /exchange/switch
    router.post('/exchange/switch', (req, res) => {
        try {
            const { exchange } = req.body;
            if (!exchange) return res.status(400).json({ message: 'exchange is required' });
            const prevExchange = ctx.getActiveExchangeId();
            const newId = ctx.setActiveExchange(exchange);
            const adapter = ctx.getExchangeAdapter();

            // Update fee awareness for beast mode and optimizer simulation
            const fees = ctx.getActiveFees();
            ctx.beastSetRoundTripFee(fees.roundTrip * 100);
            ctx.setFeeForSimulation(fees.roundTrip * 100);

            // Reconnect WebSocket to new exchange if changed
            if (prevExchange !== newId) {
                const FALLBACK_TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
                const tickers = ctx.availableTickers.length > 0 ? ctx.availableTickers : FALLBACK_TICKERS;
                ctx.reconnectWebSocketForExchange(tickers);
                ctx.addLog(`[Exchange] Switched from ${prevExchange} to ${newId}, WebSocket reconnected (${tickers.length} tickers)`, 'INFO');
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

    // GET /exchange/list
    router.get('/exchange/list', (req, res) => {
        res.json(ctx.listExchanges());
    });

    return router;
}
