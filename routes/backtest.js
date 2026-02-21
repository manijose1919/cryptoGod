import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Backtest');

export default function createBacktestRouter(ctx) {
    const router = Router();

    // POST /backtest/run
    router.post('/backtest/run', (req, res) => {
        try {
            const result = ctx.runBacktest(req.body);
            res.json(result);
        } catch (e) {
            log.error('backtest/run failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /backtest/available
    router.get('/backtest/available', (req, res) => {
        try {
            const data = ctx.getAvailableBacktestData();
            res.json({ data });
        } catch (e) {
            log.error('backtest/available failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /backtest/sweep
    router.post('/backtest/sweep', (req, res) => {
        try {
            const result = ctx.runParameterSweep(req.body);
            res.json(result);
        } catch (e) {
            log.error('backtest/sweep failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /backtest/walk-forward
    router.post('/backtest/walk-forward', (req, res) => {
        try {
            const result = ctx.runWalkForward(req.body);
            res.json(result);
        } catch (e) {
            log.error('backtest/walk-forward failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
