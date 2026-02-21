import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Market');

export default function createMarketRouter(ctx) {
    const router = Router();

    // GET /market-data
    router.get('/market-data', async (req, res, next) => {
        try {
            const { instrument_name, timeframe, exchange } = req.query;
            if (!instrument_name || !timeframe) {
                return res.status(400).json({ message: 'instrument_name and timeframe are required' });
            }

            const activeExchange = exchange || ctx.getActiveExchangeId();
            if (activeExchange !== 'crypto.com') {
                const adapter = ctx.getExchangeAdapter(activeExchange);
                const candles = await adapter.getCandles(instrument_name, timeframe, 200);
                return res.status(200).json({ data: candles });
            }

            const data = await ctx.getMarketData(instrument_name, timeframe, 200);
            res.status(200).json({ data });
        } catch (error) {
            next(error);
        }
    });

    // GET /instruments
    router.get('/instruments', async (req, res, next) => {
        try {
            const { exchange } = req.query;

            if (exchange && exchange !== 'crypto.com') {
                const adapter = ctx.getExchangeAdapter(exchange);
                const result = await adapter.getInstruments();
                return res.status(200).json(result);
            }

            const result = await ctx.makePublicRequest('public/get-instruments');
            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    });

    return router;
}
