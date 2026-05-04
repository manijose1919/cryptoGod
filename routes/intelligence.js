import { Router } from 'express';
import { createLogger } from '../services/logger.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const log = createLogger('Intelligence');

export default function createIntelligenceRouter(ctx) {
    const router = Router();

    // POST /ai/analyze (C4: admin-gated — endpoint forwards arbitrary prompts
    // to the Anthropic API using the server's ANTHROPIC_API_KEY. Anyone with
    // network reach could otherwise drain billing in a loop.)
    router.post('/ai/analyze', requireAdminAuth, async (req, res, next) => {
        try {
            const { prompt, context, ticker, signals, sentiment, marketData } = req.body;

            // If ticker/signals/marketData provided, use brain for specialized analysis
            if (ticker && signals && marketData && ctx.brain) {
                const analysis = await ctx.brain.analyzeTradeOpportunity(ticker, signals, sentiment || {}, marketData);
                return res.status(200).json({ analysis: typeof analysis === 'string' ? analysis : JSON.stringify(analysis) });
            }

            // Generic prompt analysis via Claude API
            if (prompt) {
                const apiKey = process.env.ANTHROPIC_API_KEY;
                if (!apiKey) return res.status(503).json({ error: 'AI service not configured' });

                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 1024,
                        messages: [{ role: 'user', content: prompt + (context ? '\n\nContext: ' + context : '') }],
                    }),
                });

                if (!response.ok) {
                    const errText = await response.text();
                    return res.status(response.status).json({ error: 'AI API error', details: errText });
                }

                const data = await response.json();
                const text = data?.content?.[0]?.text || 'No response';
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
        res.status(200).json(ctx.brainThoughts || []);
    });

    // GET /feeds/live
    router.get('/feeds/live', async (req, res) => {
        if (!ctx.dataIngestion) {
            return res.status(200).json({ feeds: [], message: 'Data ingestion service not available' });
        }
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

    // ================================================================
    // Phase 1-8: Advanced ML Pipeline Endpoints
    // ================================================================

    // GET /ml/pipeline-status — Full status of all ML systems
    router.get('/ml/pipeline-status', async (req, res) => {
        try {
            const status = {};

            // TF.js Engine (Phase 1+2)
            try {
                const { tfEngine } = await import('../services/tfEngine.js');
                status.tfEngine = tfEngine.getStatus();
            } catch { status.tfEngine = { available: false }; }

            // RL Agent (Phase 3)
            try {
                const { rlAgent } = await import('../services/rlAgent.js');
                status.rlAgent = rlAgent.getStatus();
            } catch { status.rlAgent = { available: false }; }

            // War Room (Phase 4)
            try {
                const { warRoom } = await import('../services/multiAgentSystem.js');
                status.warRoom = warRoom.getStats();
            } catch { status.warRoom = { available: false }; }

            // Synthetic Data (Phase 5)
            try {
                const { syntheticEngine } = await import('../services/syntheticDataEngine.js');
                status.syntheticData = syntheticEngine.getStatus();
            } catch { status.syntheticData = { available: false }; }

            // Online Learner (Phase 6)
            try {
                const { onlineLearner } = await import('../services/onlineLearner.js');
                status.onlineLearner = onlineLearner.getStats();
            } catch { status.onlineLearner = { available: false }; }

            // System Config flags
            try {
                const { getAllFlags } = await import('../services/systemConfig.js');
                const flags = getAllFlags();
                status.flags = Object.fromEntries(
                    Object.entries(flags).filter(([k]) =>
                        k.startsWith('TF_') || k.startsWith('TFT_') || k.startsWith('RL_') ||
                        k.startsWith('MULTI_') || k.startsWith('SYNTHETIC_') || k.startsWith('ONLINE_') ||
                        k.startsWith('DRIFT_') || k.startsWith('ROLLBACK_') || k.startsWith('SHAP_') ||
                        k.startsWith('CALIBRATION_') || k.startsWith('FEATURE_') || k.startsWith('MTF_') ||
                        k.startsWith('WAVELET_') || k.startsWith('META_')
                    )
                );
            } catch {}

            res.json(status);
        } catch (e) {
            log.error('ml/pipeline-status failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/shap/:ticker — SHAP explanation for latest prediction
    router.get('/ml/shap/:ticker', async (req, res) => {
        try {
            const { ticker } = req.params;
            const { explainPrediction, computeInteractionSHAP } = await import('../services/shapExplainer.js');
            const { getMLEngine } = await import('../services/mlPredictionService.js');
            const { getFeatureNames } = await import('../services/featureEngineering.js');

            const mlEngine = getMLEngine();
            if (!mlEngine || !mlEngine.isTrained) {
                return res.json({ error: 'No trained model available' });
            }

            // Get most recent features for this ticker from DB
            const features = ctx.getRecentFeatures?.(ticker);
            if (!features) {
                return res.json({ error: 'No recent features for ticker' });
            }

            const featureNames = getFeatureNames();
            const explanation = explainPrediction(mlEngine, features, featureNames);
            const interactions = computeInteractionSHAP(
                explanation?.topFeatures?.map(() => 0) || [],
                featureNames
            );

            res.json({ ticker, explanation, interactions });
        } catch (e) {
            log.error('ml/shap failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/feature-drift — Feature importance drift alerts
    router.get('/ml/feature-drift', async (req, res) => {
        try {
            const { detectFeatureDrift } = await import('../services/shapExplainer.js');
            const { getFeatureNames } = await import('../services/featureEngineering.js');
            const drift = detectFeatureDrift(getFeatureNames());
            res.json({ driftAlerts: drift });
        } catch (e) {
            log.error('ml/feature-drift failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/calibration — Calibration curve and metrics
    router.get('/ml/calibration', async (req, res) => {
        try {
            const { getMLEngine } = await import('../services/mlPredictionService.js');
            const mlEngine = getMLEngine();
            const calibrator = mlEngine?._isotonicCalibrator;

            res.json({
                calibrated: !!calibrator?.isFitted,
                breakpoints: calibrator?.breakpoints?.length || 0,
            });
        } catch (e) {
            log.error('ml/calibration failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/online-weights — Current Thompson Sampling model weights
    router.get('/ml/online-weights', async (req, res) => {
        try {
            const { onlineLearner } = await import('../services/onlineLearner.js');
            res.json({
                expectedWeights: onlineLearner.getExpectedWeights(),
                sampledWeights: onlineLearner.getModelWeights(),
                driftActive: onlineLearner.isDriftActive(),
                stats: onlineLearner.getStats(),
            });
        } catch (e) {
            log.error('ml/online-weights failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/war-room — Multi-agent war room status
    router.get('/ml/war-room', async (req, res) => {
        try {
            const { warRoom } = await import('../services/multiAgentSystem.js');
            res.json(warRoom.getStats());
        } catch (e) {
            log.error('ml/war-room failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // ================================================================
    // Data Surfacing Endpoints — expose stored DB data to dashboard
    // ================================================================

    // GET /genetic/evolution — Genome population and evolution log
    router.get('/genetic/evolution', async (req, res) => {
        try {
            const { getGeneticGenomes } = await import('../services/database.js');
            const limit = parseInt(req.query.limit) || 50;
            const genomes = getGeneticGenomes(limit);
            // Also try to get the engine stats
            let engineStats = null;
            try {
                const { getEvolutionStats } = await import('../services/geneticStrategyEngine.js');
                engineStats = getEvolutionStats?.();
            } catch {}
            res.json({ genomes, engineStats });
        } catch (e) {
            log.error('genetic/evolution failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/gatekeeper-log — Recent gatekeeper decisions (PASS/BLOCK)
    router.get('/ml/gatekeeper-log', async (req, res) => {
        try {
            const { getRecentGatekeeperDecisions } = await import('../services/database.js');
            const limit = parseInt(req.query.limit) || 100;
            res.json(getRecentGatekeeperDecisions(limit));
        } catch (e) {
            log.error('ml/gatekeeper-log failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /execution/history — Execution metrics (slippage, fill rates)
    router.get('/execution/history', async (req, res) => {
        try {
            const { getExecutionMetrics } = await import('../services/database.js');
            const ticker = req.query.ticker || null;
            const limit = parseInt(req.query.limit) || 100;
            res.json(getExecutionMetrics(ticker, limit));
        } catch (e) {
            log.error('execution/history failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/thoughts-history — ML thoughts from DB (survives restarts)
    router.get('/ml/thoughts-history', async (req, res) => {
        try {
            const { getMLThoughts } = await import('../services/database.js');
            const limit = parseInt(req.query.limit) || 200;
            const sessionId = req.query.sessionId || null;
            res.json(getMLThoughts(sessionId, limit));
        } catch (e) {
            log.error('ml/thoughts-history failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ml/accuracy-by-regime — Per-regime accuracy breakdown
    router.get('/ml/accuracy-by-regime', async (req, res) => {
        try {
            const { getDb } = await import('../services/database.js');
            const database = getDb();
            const rows = database.prepare(`
                SELECT regime,
                       COUNT(*) as total,
                       SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                       SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
                       AVG(pnl_percent) as avg_pnl,
                       MIN(pnl_percent) as worst_trade,
                       MAX(pnl_percent) as best_trade
                FROM ml_regime_accuracy
                WHERE timestamp > ?
                GROUP BY regime
                ORDER BY total DESC
            `).all(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
            const result = rows.map(r => ({
                ...r,
                winRate: r.total > 0 ? (r.wins / r.total * 100).toFixed(1) + '%' : '0%',
                avgPnl: r.avg_pnl?.toFixed(3) + '%',
            }));
            res.json(result);
        } catch (e) {
            log.error('ml/accuracy-by-regime failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /derivatives/history — Current derivatives intelligence data
    router.get('/derivatives/history', async (req, res) => {
        try {
            let data = {};
            if (ctx.derivativesIntel) {
                data = ctx.derivativesIntel.getAllDerivativesData?.() || {};
            }
            res.json(data);
        } catch (e) {
            log.error('derivatives/history failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
