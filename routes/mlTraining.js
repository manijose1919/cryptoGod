/**
 * ML Training API Routes
 * Endpoints for synthetic sample generation and new coin listing detection.
 */

import { Router } from 'express';

const router = Router();

let syntheticLabeler, newCoinDetector;

try {
  syntheticLabeler = await import('../services/syntheticLabeler.js');
} catch (err) {
  console.warn('[MLTraining Routes] Synthetic labeler not available:', err.message);
}

try {
  newCoinDetector = await import('../services/newCoinDetector.js');
} catch (err) {
  console.warn('[MLTraining Routes] New coin detector not available:', err.message);
}

// Will be set by server.js when mounting
let getExchangeAdapterFn = null;

export function setContext(ctx) {
  getExchangeAdapterFn = ctx.getExchangeAdapter;
}

// POST /generate-samples - Trigger bulk synthetic sample generation
router.post('/generate-samples', async (req, res, next) => {
  try {
    if (!syntheticLabeler?.generateSamples) {
      return res.status(503).json({ error: 'Synthetic labeler not available' });
    }
    const adapter = getExchangeAdapterFn ? getExchangeAdapterFn() : null;
    if (!adapter) {
      return res.status(503).json({ error: 'Exchange adapter not available' });
    }
    const { tickerList, timeframes, maxCandles } = req.body;
    const result = await syntheticLabeler.generateSamples(adapter, {
      tickerList: tickerList || null,
      timeframes: timeframes || ['5m', '15m', '1h'],
      maxCandlesPerTf: maxCandles || 720,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /sample-generation-status - Check job progress
router.get('/sample-generation-status', (req, res) => {
  if (!syntheticLabeler?.getJobStatus) {
    return res.json({ status: 'unavailable' });
  }
  res.json(syntheticLabeler.getJobStatus());
});

// GET /new-listings - Get active new coin listings
router.get('/new-listings', (req, res) => {
  if (!newCoinDetector?.getActiveNewListings) {
    return res.json({ listings: [], stats: {} });
  }
  res.json({
    listings: newCoinDetector.getActiveNewListings(),
    stats: newCoinDetector.getStats(),
  });
});

export default router;
