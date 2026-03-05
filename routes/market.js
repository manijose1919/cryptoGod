import { Router } from 'express';
import { createLogger } from '../services/logger.js';
import { getJSON, setJSON } from '../services/redisCache.js';

const log = createLogger('Market');

export default function createMarketRouter(ctx) {
    const router = Router();

    // GET /market-data — cached 5s
    router.get('/market-data', async (req, res, next) => {
        try {
            const { instrument_name, timeframe, exchange } = req.query;
            if (!instrument_name || !timeframe) {
                return res.status(400).json({ message: 'instrument_name and timeframe are required' });
            }

            const cacheKey = `mktdata:${exchange || 'default'}:${instrument_name}:${timeframe}`;
            const cached = await getJSON(cacheKey);
            if (cached) {
                res.set('Cache-Control', 'public, max-age=5');
                res.set('X-Cache', 'HIT');
                return res.status(200).json({ data: cached });
            }

            const adapter = ctx.getExchangeAdapter(exchange || undefined);
            const candles = await adapter.getCandles(instrument_name, timeframe, 200);
            await setJSON(cacheKey, candles, 5);
            res.set('Cache-Control', 'public, max-age=5');
            res.set('X-Cache', 'MISS');
            res.status(200).json({ data: candles });
        } catch (error) {
            next(error);
        }
    });

    // GET /instruments — cached 5min
    router.get('/instruments', async (req, res, next) => {
        try {
            const { exchange } = req.query;

            const cacheKey = `instruments:${exchange || 'default'}`;
            const cached = await getJSON(cacheKey);
            if (cached) {
                res.set('Cache-Control', 'public, max-age=300');
                res.set('X-Cache', 'HIT');
                return res.status(200).json(cached);
            }

            const adapter = ctx.getExchangeAdapter(exchange || undefined);
            const result = await adapter.getInstruments();
            await setJSON(cacheKey, result, 300);
            res.set('Cache-Control', 'public, max-age=300');
            res.set('X-Cache', 'MISS');
            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    });

    // GET /orderbook/:ticker — raw order book from exchange
    router.get('/orderbook/:ticker', async (req, res, next) => {
        try {
            const { ticker } = req.params;
            const { exchange, depth } = req.query;
            const adapter = ctx.getExchangeAdapter(exchange || undefined);
            const book = await adapter.getOrderBook(ticker, parseInt(depth) || 25);
            res.set('Cache-Control', 'no-cache');
            res.json(book);
        } catch (error) {
            next(error);
        }
    });

    return router;
}
