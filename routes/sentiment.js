import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Sentiment');

export default function createSentimentRouter(ctx) {
    const router = Router();

    // GET /sentiment/news/:ticker
    router.get('/sentiment/news/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            const hours = parseInt(req.query.hours) || 24;
            if (ctx.multiExchangeService) {
                const data = ctx.multiExchangeService.getNewsSnapshot(ticker);
                if (data) return res.json(data);
            }
            const dbData = ctx.getNewsItems({ ticker, hours, limit: 50 });
            res.json({ ticker, items: dbData, source: 'database' });
        } catch (e) {
            log.error('sentiment/news failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /sentiment/social/:ticker
    router.get('/sentiment/social/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            if (ctx.multiExchangeService) {
                const data = ctx.multiExchangeService.getSocialSnapshot(ticker);
                if (data) return res.json(data);
            }
            res.json({ ticker, error: 'Social data not available yet' });
        } catch (e) {
            log.error('sentiment/social failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /sentiment/fear-greed
    router.get('/sentiment/fear-greed', async (req, res) => {
        try {
            if (ctx.multiExchangeService) {
                const data = ctx.multiExchangeService.getFearGreed();
                if (data) return res.json(data);
            }
            res.json({ value: 50, classification: 'Neutral', error: 'Fear & Greed not available yet' });
        } catch (e) {
            log.error('sentiment/fear-greed failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /sentiment/youtube/:ticker
    router.get('/sentiment/youtube/:ticker', async (req, res) => {
        try {
            if (!ctx.youtubeSentimentService) {
                return res.json({ sentiment: 0, videoCount: 0, enabled: false });
            }
            const data = await ctx.youtubeSentimentService.getYouTubeSentiment(req.params.ticker);
            res.json(data);
        } catch (e) {
            res.json({ sentiment: 0, videoCount: 0, error: e.message });
        }
    });

    // GET /sentiment/reddit-enhanced/:ticker
    router.get('/sentiment/reddit-enhanced/:ticker', async (req, res) => {
        try {
            if (!ctx.redditSentimentService) {
                return res.json({ combinedSentiment: 0, signal: 'NEUTRAL', enabled: false });
            }
            const data = await ctx.redditSentimentService.getEnhancedTickerSentiment(req.params.ticker);
            res.json(data);
        } catch (e) {
            res.json({ combinedSentiment: 0, signal: 'NEUTRAL', error: e.message });
        }
    });

    // GET /sentiment/combined/:ticker
    router.get('/sentiment/combined/:ticker', async (req, res) => {
        try {
            const ticker = req.params.ticker;
            const results = {};

            const [redditData, youtubeData, fearGreed] = await Promise.allSettled([
                ctx.redditSentimentService ? ctx.redditSentimentService.getEnhancedTickerSentiment(ticker) : null,
                ctx.youtubeSentimentService ? ctx.youtubeSentimentService.getYouTubeSentiment(ticker) : null,
                ctx.multiExchangeService ? Promise.resolve(ctx.multiExchangeService.getFearGreed()) : null,
            ]);

            results.reddit = redditData.status === 'fulfilled' ? redditData.value : null;
            results.youtube = youtubeData.status === 'fulfilled' ? youtubeData.value : null;
            results.fearGreed = fearGreed.status === 'fulfilled' ? fearGreed.value : null;

            let weightedSum = 0, totalWeight = 0;
            if (results.reddit?.combinedSentiment != null) {
                weightedSum += results.reddit.combinedSentiment * 0.35;
                totalWeight += 0.35;
            }
            if (results.youtube?.sentiment != null) {
                weightedSum += results.youtube.sentiment * 0.25;
                totalWeight += 0.25;
            }
            if (results.fearGreed?.value != null) {
                const fgNorm = (results.fearGreed.value - 50) / 50;
                weightedSum += fgNorm * 0.40;
                totalWeight += 0.40;
            }

            const combinedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

            res.json({
                ticker,
                combinedScore: Math.round(combinedScore * 100) / 100,
                signal: combinedScore > 0.3 ? 'BULLISH' : combinedScore < -0.3 ? 'BEARISH' : 'NEUTRAL',
                sources: results,
                timestamp: Date.now(),
            });
        } catch (e) {
            log.error('sentiment/combined failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
