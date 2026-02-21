import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Signals');

export default function createSignalsRouter(ctx) {
    const router = Router();

    // GET /timeframe/profiles
    router.get('/timeframe/profiles', (req, res) => {
        try {
            if (!ctx.timeframeStrategyService) {
                return res.json({ error: 'Timeframe strategy service not loaded', profiles: [] });
            }
            const speed = req.query.speed || 'FAST';
            const profiles = ctx.timeframeStrategyService.getActiveProfilesForBot(speed);
            res.json({ profiles, allTimeframes: ctx.timeframeStrategyService.getAllTimeframes() });
        } catch (e) {
            log.error('timeframe/profiles failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /timeframe/market-speed
    router.get('/timeframe/market-speed', async (req, res) => {
        try {
            if (!ctx.timeframeStrategyService) {
                return res.json({ speed: 'FAST', error: 'Service not loaded' });
            }
            const ticker = req.query.ticker || ctx.availableTickers[0] || 'BTCUSD';
            const candles = await ctx.getMarketData(ticker, '1m', 100);
            const speed = ctx.timeframeStrategyService.detectMarketSpeed(candles);
            res.json({ ticker, speed, candleCount: candles?.length || 0 });
        } catch (e) {
            log.error('timeframe/market-speed failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /kraken/minimums
    router.get('/kraken/minimums', (req, res) => {
        try {
            if (!ctx.krakenMinimums) {
                return res.json({ error: 'Kraken minimums not loaded' });
            }
            const budget = parseFloat(req.query.budget) || ctx.portfolio.cash;
            const recommended = ctx.krakenMinimums.getRecommendedAssetsForTier(budget);
            res.json({ budget, recommended });
        } catch (e) {
            log.error('kraken/minimums failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /orderbook-signal/:ticker
    router.get('/orderbook-signal/:ticker', (req, res) => {
        try {
            const signal = ctx.getOrderBookSignal(req.params.ticker);
            res.json(signal);
        } catch (e) {
            log.error('orderbook-signal failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /correlation-matrix
    router.get('/correlation-matrix', (req, res) => {
        try {
            const timeframe = req.query.timeframe || '5m';
            const lookback = parseInt(req.query.lookback) || 30;
            const tickers = ctx.availableTickers.slice(0, 10);
            const result = ctx.getCorrelationMatrix(tickers, timeframe, lookback * 60);
            res.json(result);
        } catch (e) {
            log.error('correlation-matrix failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /funding-rate/:ticker
    router.get('/funding-rate/:ticker', (req, res) => {
        try {
            const signal = ctx.getFundingRateSignal(req.params.ticker);
            res.json(signal);
        } catch (e) {
            log.error('funding-rate failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /optimizer/status
    router.get('/optimizer/status', (req, res) => {
        res.json(ctx.getOptimizerStatus(ctx.portfolio.tradeLog));
    });

    // POST /optimizer/force-run
    router.post('/optimizer/force-run', (req, res) => {
        try {
            const trades = ctx.portfolio.tradeLog || [];
            const result = ctx.forceOptimize(trades);
            if (result.changed) ctx.setTargetOverrides(result.targets);
            res.json(result);
        } catch (e) {
            log.error('optimizer/force-run failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /optimizer/reset
    router.post('/optimizer/reset', (req, res) => {
        try {
            const result = ctx.resetOptimizer();
            ctx.setTargetOverrides(result.targets);
            ctx.addLog('[OPTIMIZER] Reset to defaults via API', 'WARN');
            res.json(result);
        } catch (e) {
            log.error('optimizer/reset failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
