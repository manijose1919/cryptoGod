import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Notifications');

export default function createNotificationsRouter(ctx) {
    const router = Router();

    // POST /telegram/test
    router.post('/telegram/test', async (req, res) => {
        try {
            const result = await ctx.sendTestMessage();
            res.json(result);
        } catch (e) {
            log.error('telegram/test failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /telegram/status
    router.get('/telegram/status', (req, res) => {
        res.json(ctx.telegramStatus());
    });

    // GET /journal
    router.get('/journal', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const entries = ctx.getJournalEntries(limit);
            res.json({ entries });
        } catch (e) {
            log.error('journal failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /journal/generate
    router.post('/journal/generate', (req, res) => {
        try {
            const entry = ctx.forceGenerateJournal();
            res.json(entry);
        } catch (e) {
            log.error('journal/generate failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
