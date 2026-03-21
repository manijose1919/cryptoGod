// ============================================
// Phoenix V2 Dashboard API
// Express router for /api/v2 routes
// ============================================

import { Router } from 'express';
import type { Request, Response } from 'express';

import { getOpenTrades, getClosedTrades, getSignalScores } from '../attribution/attributionStore.ts';
import { getScorecard } from '../attribution/signalScorecard.ts';
import { recomputeAllScores } from '../attribution/postTradeAnalyzer.ts';
import { getV2Status } from '../engine/tradeEngine.ts';
import { getDualStatus, getDualTrades, initDualEngine, startDualEngine, stopDualEngine } from '../engine/dualExchangeEngine.ts';
import { initKrakenAdapter, krakenV2 } from '../exchange/krakenAdapter.ts';
import { initCryptoComAdapter, cryptoComV2 } from '../exchange/cryptoComV2Adapter.ts';

export const v2Router = Router();

// --- GET /status ---
v2Router.get('/status', (_req: Request, res: Response) => {
  try {
    const status = getV2Status();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- GET /trades ---
v2Router.get('/trades', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const open = getOpenTrades();
    const closed = getClosedTrades(limit);
    res.json({ open, closed });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- GET /scorecard ---
v2Router.get('/scorecard', (_req: Request, res: Response) => {
  try {
    const scorecard = getScorecard();
    res.json(scorecard);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- GET /signal-scores ---
v2Router.get('/signal-scores', (_req: Request, res: Response) => {
  try {
    const scores = getSignalScores();
    res.json(scores);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- POST /recompute-scores ---
v2Router.post('/recompute-scores', (_req: Request, res: Response) => {
  try {
    recomputeAllScores();
    const scorecard = getScorecard();
    res.json({ status: 'ok', scorecard });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- GET /dual/status --- Dual Exchange Competition Status
v2Router.get('/dual/status', (_req: Request, res: Response) => {
  try {
    const status = getDualStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- GET /dual/trades/:exchange --- Trades for a specific exchange
v2Router.get('/dual/trades/:exchange', (req: Request, res: Response) => {
  try {
    const exchange = req.params.exchange;
    const trades = getDualTrades(exchange);
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- POST /dual/start --- Start dual engine via API
v2Router.post('/dual/start', async (_req: Request, res: Response) => {
  try {
    await Promise.all([initKrakenAdapter(), initCryptoComAdapter()]);
    initDualEngine(krakenV2, cryptoComV2);
    startDualEngine();
    res.json({ status: 'started', message: 'Kraken vs Crypto.com competition running (paper mode)' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- POST /dual/stop --- Stop dual engine
v2Router.post('/dual/stop', (_req: Request, res: Response) => {
  try {
    stopDualEngine();
    const status = getDualStatus();
    res.json({ status: 'stopped', finalStatus: status });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
