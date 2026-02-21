import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('MultiExchange');

export default function createMultiExchangeRouter(ctx) {
    const router = Router();

    // GET /exchange-data/:ticker
    router.get('/exchange-data/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            if (ctx.multiExchangeService) {
                const snapshot = ctx.multiExchangeService.getExchangeSnapshot(ticker);
                if (snapshot) return res.json(snapshot);
            }
            const dbData = ctx.getExchangeSnapshots(ticker, 1);
            res.json({ ticker, snapshots: dbData.slice(0, 10), source: 'database' });
        } catch (e) {
            log.error('exchange-data failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /derivatives/:ticker
    router.get('/derivatives/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            if (ctx.multiExchangeService) {
                const data = ctx.multiExchangeService.getDerivativesSnapshot(ticker);
                if (data) return res.json(data);
            }
            const dbData = ctx.getLatestDerivatives(ticker);
            res.json(dbData || { ticker, error: 'No derivatives data yet' });
        } catch (e) {
            log.error('derivatives failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /defi/overview
    router.get('/defi/overview', async (req, res) => {
        try {
            if (ctx.multiExchangeService) {
                const data = ctx.multiExchangeService.getDeFiSnapshot();
                if (data) return res.json(data);
            }
            const dbData = ctx.getLatestDeFiSnapshot();
            res.json(dbData || { error: 'No DeFi data yet' });
        } catch (e) {
            log.error('defi/overview failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /multi-exchange/status
    router.get('/multi-exchange/status', (req, res) => {
        try {
            if (ctx.multiExchangeService) {
                res.json(ctx.multiExchangeService.getCollectionStatus());
            } else {
                res.json({ isRunning: false, error: 'Multi-exchange service not loaded' });
            }
        } catch (e) {
            log.error('multi-exchange/status failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
