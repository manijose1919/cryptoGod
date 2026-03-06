/**
 * Engine Routes — API for controlling dual Kraken + Crypto.com trading engines.
 *
 * Replaces the old single-exchange session routes with per-engine control.
 */

import { Router } from 'express';

export default function createEngineRouter(ctx) {
  const router = Router();

  // ─── Engine Status ─────────────────────────────────────────

  /**
   * GET /api/engines/status
   * Returns status of both trading engines + global portfolio.
   */
  router.get('/engines/status', (req, res) => {
    const result = {
      engines: {},
      global: null,
    };

    if (ctx.krakenEngine) {
      result.engines.kraken = ctx.krakenEngine.getStatus();
    }
    if (ctx.cryptoComEngine) {
      result.engines['crypto.com'] = ctx.cryptoComEngine.getStatus();
    }
    if (ctx.portfolioManager) {
      result.global = ctx.portfolioManager.getGlobalPortfolio();
    }

    res.json(result);
  });

  /**
   * GET /api/engines/:exchange/status
   * Returns status of a specific engine.
   */
  router.get('/engines/:exchange/status', (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) {
      // Return a "not ready" status instead of 404 to prevent frontend error loops
      return res.json({
        initialized: false,
        running: false,
        mode: 'SIMULATION',
        exchange: req.params.exchange,
        message: 'Engine not yet initialized',
      });
    }
    res.json(engine.getStatus());
  });

  // ─── Engine Control ────────────────────────────────────────

  /**
   * POST /api/engines/:exchange/start
   * Start a trading engine.
   * Body: { mode: 'SIMULATION' | 'REAL', budget: number, tickers?: string[] }
   */
  router.post('/engines/:exchange/start', async (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) return res.status(404).json({ error: 'Engine not found' });

    const { mode, budget } = req.body;
    if (mode) engine.setMode(mode);

    try {
      await engine.start();
      res.json({ success: true, status: engine.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/engines/:exchange/pause
   */
  router.post('/engines/:exchange/pause', async (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) return res.status(404).json({ error: 'Engine not found' });

    await engine.pause();
    res.json({ success: true, status: engine.getStatus() });
  });

  /**
   * POST /api/engines/:exchange/resume
   */
  router.post('/engines/:exchange/resume', async (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) return res.status(404).json({ error: 'Engine not found' });

    await engine.resume();
    res.json({ success: true, status: engine.getStatus() });
  });

  /**
   * POST /api/engines/:exchange/stop
   */
  router.post('/engines/:exchange/stop', async (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) return res.status(404).json({ error: 'Engine not found' });

    await engine.stop();
    res.json({ success: true, status: engine.getStatus() });
  });

  /**
   * POST /api/engines/:exchange/mode
   * Switch between SIMULATION and REAL.
   * Body: { mode: 'SIMULATION' | 'REAL' }
   */
  router.post('/engines/:exchange/mode', (req, res) => {
    const engine = getEngine(ctx, req.params.exchange);
    if (!engine) return res.status(404).json({ error: 'Engine not found' });

    const { mode } = req.body;
    if (!['SIMULATION', 'REAL'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Use SIMULATION or REAL.' });
    }

    engine.setMode(mode);
    res.json({ success: true, mode, status: engine.getStatus() });
  });

  // ─── Global Portfolio ──────────────────────────────────────

  /**
   * GET /api/portfolio/global
   * Combined portfolio across both exchanges.
   */
  router.get('/portfolio/global', (req, res) => {
    if (!ctx.portfolioManager) {
      return res.json({ heatScore: 0, totalValue: 0, exchanges: {}, positions: [], riskAlerts: [] });
    }
    res.json(ctx.portfolioManager.getGlobalPortfolio());
  });

  /**
   * GET /api/portfolio/performance
   * Performance metrics (Sharpe, win rate, etc.).
   */
  router.get('/portfolio/performance', (req, res) => {
    if (!ctx.portfolioManager) {
      return res.status(503).json({ error: 'Portfolio manager not initialized' });
    }
    const days = parseInt(req.query.days) || 30;
    res.json(ctx.portfolioManager.getPerformanceMetrics(days));
  });

  /**
   * GET /api/portfolio/risk-check
   * Check if a new position would be allowed by global risk limits.
   */
  router.get('/portfolio/risk-check', (req, res) => {
    if (!ctx.portfolioManager) {
      return res.status(503).json({ error: 'Portfolio manager not initialized' });
    }
    const { exchange, ticker, amount } = req.query;
    const result = ctx.portfolioManager.canOpenPosition(exchange, ticker, parseFloat(amount) || 0);
    res.json(result);
  });

  // ─── Staking ───────────────────────────────────────────────

  /**
   * GET /api/staking/status
   */
  router.get('/staking/status', (req, res) => {
    if (!ctx.stakingEngine) {
      return res.json({ enabled: false, products: 0, stakedPositions: 0 });
    }
    res.json(ctx.stakingEngine.getStatus());
  });

  /**
   * GET /api/staking/products
   */
  router.get('/staking/products', (req, res) => {
    if (!ctx.stakingEngine) return res.json([]);
    res.json(ctx.stakingEngine.getProducts());
  });

  // ─── Arbitrage ─────────────────────────────────────────────

  /**
   * GET /api/arbitrage/status
   */
  router.get('/arbitrage/status', (req, res) => {
    if (!ctx.arbitrageEngine) {
      return res.json({ enabled: false, opportunities: 0 });
    }
    res.json(ctx.arbitrageEngine.getStatus());
  });

  /**
   * GET /api/arbitrage/opportunities
   */
  router.get('/arbitrage/opportunities', (req, res) => {
    if (!ctx.arbitrageEngine) return res.json([]);
    res.json(ctx.arbitrageEngine.getOpportunities());
  });

  // ─── Short Selling ─────────────────────────────────────────

  /**
   * GET /api/shorts/status
   */
  router.get('/shorts/status', (req, res) => {
    if (!ctx.shortSellingEngine) {
      return res.json({ enabled: false, simBalance: 0, openPositions: 0 });
    }
    res.json(ctx.shortSellingEngine.getStatus());
  });

  /**
   * GET /api/shorts/positions
   */
  router.get('/shorts/positions', (req, res) => {
    if (!ctx.shortSellingEngine) return res.json([]);
    res.json(ctx.shortSellingEngine.getPositions());
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────

function getEngine(ctx, exchangeParam) {
  const exchange = exchangeParam?.toLowerCase();
  if (exchange === 'kraken') return ctx.krakenEngine;
  if (exchange === 'crypto.com' || exchange === 'cryptocom' || exchange === 'crypto-com') {
    return ctx.cryptoComEngine;
  }
  return null;
}
