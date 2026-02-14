/**
 * TradingView Webhook Routes (Stub)
 *
 * Receives webhook alerts from TradingView and injects them into the signal pipeline.
 * Currently a stub - the SignalScanner handles signal generation internally.
 */

import express from 'express';
const router = express.Router();

// In-memory signal store
const signals = [];
const MAX_SIGNALS = 100;

/**
 * Inject a signal into the pipeline (called by SignalScanner)
 */
export function injectSignal(signalObj) {
    signals.unshift({ ...signalObj, receivedAt: Date.now() });
    if (signals.length > MAX_SIGNALS) {
        signals.length = MAX_SIGNALS;
    }
}

// POST /api/tradingview/webhook - Receive TradingView alerts
router.post('/webhook', (req, res) => {
    try {
        const alert = req.body;
        if (!alert || !alert.ticker) {
            return res.status(400).json({ error: 'Missing ticker in alert payload' });
        }

        const signalObj = {
            ticker: alert.ticker,
            signal: alert.signal || alert.action || 'INFO',
            timeframes: alert.timeframes || ['unknown'],
            totalScore: alert.score || 0,
            details: alert.details || [alert.message || 'TradingView alert'],
            confidence: alert.confidence || 50,
            source: 'tradingview',
            receivedAt: Date.now(),
        };

        injectSignal(signalObj);
        res.json({ success: true, signal: signalObj });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process alert' });
    }
});

// GET /api/tradingview/signals - Get recent signals
router.get('/signals', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, MAX_SIGNALS);
    res.json({ signals: signals.slice(0, limit) });
});

export default router;
