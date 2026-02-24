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

            // Always route through adapter (handles both Kraken and Crypto.com)
            const adapter = ctx.getExchangeAdapter(exchange || undefined);
            const candles = await adapter.getCandles(instrument_name, timeframe, 200);
            res.status(200).json({ data: candles });
        } catch (error) {
            next(error);
        }
    });

    // GET /instruments
    router.get('/instruments', async (req, res, next) => {
        try {
            const { exchange } = req.query;

            const adapter = ctx.getExchangeAdapter(exchange || undefined);
            const result = await adapter.getInstruments();
            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    });

    return router;
}
