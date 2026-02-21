import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Intelligence');

export default function createIntelligenceRouter(ctx) {
    const router = Router();

    // POST /ai/analyze
    router.post('/ai/analyze', async (req, res, next) => {
        try {
            const { prompt, context, ticker, signals, sentiment, marketData } = req.body;

            // If ticker/signals/marketData provided, use brain for specialized analysis
            if (ticker && signals && marketData) {
                const analysis = await ctx.brain.analyzeTradeOpportunity(ticker, signals, sentiment || {}, marketData);
                return res.status(200).json({ analysis: typeof analysis === 'string' ? analysis : JSON.stringify(analysis) });
            }

            // Generic prompt analysis via Gemini proxy
            if (prompt) {
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) return res.status(503).json({ error: 'AI service not configured' });

                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt + (context ? '\n\nContext: ' + context : '') }] }],
                            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
                        })
                    }
                );

                if (!response.ok) {
                    const errText = await response.text();
                    return res.status(response.status).json({ error: 'AI API error', details: errText });
                }

                const data = await response.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
                return res.status(200).json({ analysis: text });
            }

            return res.status(400).json({ message: 'Prompt or ticker/signals/marketData required' });
        } catch (error) {
            log.error('ai/analyze failed', { error: error.message });
            res.status(500).json({ message: error.message });
        }
    });

    // GET /brain/thoughts
    router.get('/brain/thoughts', (req, res) => {
        res.status(200).json(ctx.brainThoughts);
    });

    // GET /feeds/live
    router.get('/feeds/live', async (req, res) => {
        try {
            const feeds = await ctx.dataIngestion.fetchAllFeeds();
            res.status(200).json(feeds);
        } catch (e) {
            log.error('feeds/live failed', { error: e.message });
            res.status(500).json({ message: 'Failed to fetch feeds' });
        }
    });

    // GET /ml/status
    router.get('/ml/status', (req, res) => {
        try {
            const latestModel = ctx.getLatestMLModel();
            const accuracy = ctx.getMLAccuracyStats();
            const modelHistory = ctx.getMLModelHistory(10);
            res.json({
                hasModel: !!latestModel,
                latestModel: latestModel ? {
                    type: latestModel.model_type,
                    accuracy: latestModel.accuracy,
                    sampleCount: latestModel.sample_count,
                    createdAt: latestModel.created_at
                } : null,
                predictionAccuracy: accuracy,
                modelHistory: modelHistory.map(m => ({ type: m.model_type, accuracy: m.accuracy, samples: m.sample_count, date: m.created_at }))
            });
        } catch (e) {
            log.error('ml/status failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/predictions/:ticker
    router.get('/ml/predictions/:ticker', (req, res) => {
        try {
            const { ticker } = req.params;
            const limit = parseInt(req.query.limit) || 50;
            const predictions = ctx.getMLPredictions({ ticker, limit });
            res.json({ ticker, predictions });
        } catch (e) {
            log.error('ml/predictions failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/feature-importance
    router.get('/ml/feature-importance', (req, res) => {
        try {
            const latestModel = ctx.getLatestMLModel();
            if (latestModel && latestModel.feature_importance_json) {
                res.json(JSON.parse(latestModel.feature_importance_json));
            } else {
                res.json({ error: 'No model trained yet' });
            }
        } catch (e) {
            log.error('ml/feature-importance failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/thoughts
    router.get('/ml/thoughts', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const thoughts = ctx.getThoughts(limit);
            const stats = ctx.getThoughtStats();
            const focus = ctx.getCurrentFocus();
            res.json({ thoughts, stats, focus });
        } catch (error) {
            log.error('ml/thoughts failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /smart-money/:ticker
    router.get('/smart-money/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            if (ctx.smartMoneyService) {
                const signal = await ctx.smartMoneyService.getSmartMoneySignal(ticker);
                return res.json(signal);
            }
            res.json({ signal: 'NEUTRAL', confidence: 0, summary: 'Smart money service not available' });
        } catch (e) {
            log.error('smart-money failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /nlp/analyze
    router.post('/nlp/analyze', (req, res) => {
        try {
            const { text, texts } = req.body;
            if (!ctx.localNLPService) return res.json({ error: 'NLP service not available' });
            if (texts && Array.isArray(texts)) {
                res.json(ctx.localNLPService.analyzeMultiple(texts));
            } else if (text) {
                res.json(ctx.localNLPService.analyzeSentiment(text));
            } else {
                res.status(400).json({ error: 'Provide text or texts field' });
            }
        } catch (e) {
            log.error('nlp/analyze failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /adaptive-thresholds
    router.get('/adaptive-thresholds', (req, res) => {
        try {
            if (ctx.adaptiveThresholdsService) {
                res.json(ctx.adaptiveThresholdsService.getThresholdsWithDefaults());
            } else {
                res.json({ error: 'Adaptive thresholds not available' });
            }
        } catch (e) {
            log.error('adaptive-thresholds failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // POST /adaptive-thresholds/reset
    router.post('/adaptive-thresholds/reset', (req, res) => {
        try {
            if (ctx.adaptiveThresholdsService) {
                ctx.adaptiveThresholdsService.resetToDefaults();
                res.json({ success: true, message: 'Thresholds reset to defaults' });
            } else {
                res.json({ error: 'Adaptive thresholds not available' });
            }
        } catch (e) {
            log.error('adaptive-thresholds/reset failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /self-teaching/status
    router.get('/self-teaching/status', (req, res) => {
        try {
            if (ctx.selfTeachingLoop) {
                res.json(ctx.selfTeachingLoop.getPerformanceReport());
            } else {
                res.json({ isRunning: false, error: 'Self-teaching not available' });
            }
        } catch (e) {
            log.error('self-teaching/status failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
