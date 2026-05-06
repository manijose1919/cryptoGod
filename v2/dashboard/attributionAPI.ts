// ============================================
// Phoenix V2 Dashboard API
// Express router for /api/v2 routes
// ============================================

import { Router } from 'express';
import type { Request, Response } from 'express';

import { getOpenTrades, getClosedTrades, getSignalScores, getOpenTradesByStrategy, getClosedTradesByStrategy } from '../attribution/attributionStore.ts';
import { getScorecard } from '../attribution/signalScorecard.ts';
import { recomputeAllScores } from '../attribution/postTradeAnalyzer.ts';
import { getV2Status } from '../engine/tradeEngine.ts';
import { getDualStatus, getDualTrades, initDualEngine, startDualEngine, stopDualEngine } from '../engine/dualExchangeEngine.ts';
import { getBearishStatus, stopBearishServices, startBearishServices, initBearishServices } from '../engine/bearishServices.ts';
import { getSniperStatus } from '../engine/sniperEngine.ts';
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

// ============================================
// SNIPER endpoints (new-coin sniper, side-project, isolated stats)
// ============================================
// IMPORTANT: These endpoints return ONLY trades tagged strategy='SNIPER'.
// Reports must NEVER aggregate sniper P&L with TREND/MOMENTUM (day-trading).
// See CHANGELOG.md "Reporting Contract for Day-Trading vs Sniper" entry.

v2Router.get('/sniper/status', (_req: Request, res: Response) => {
  try {
    res.json(getSniperStatus());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

v2Router.get('/sniper/trades', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const open = getOpenTradesByStrategy('SNIPER');
    const closed = getClosedTradesByStrategy('SNIPER', limit);
    res.json({ open, closed });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

v2Router.get('/sniper/scorecard', (_req: Request, res: Response) => {
  try {
    const closed = getClosedTradesByStrategy('SNIPER', 1000);
    const open = getOpenTradesByStrategy('SNIPER');
    if (closed.length === 0) {
      res.json({ trades: 0, open: open.length, message: 'No closed sniper trades yet — paper-only side project, accumulating data.' });
      return;
    }
    let wins = 0, totalWin = 0, totalLoss = 0, totalPnl = 0;
    for (const t of closed) {
      const pnl = t.pnlNet ?? 0;
      totalPnl += pnl;
      if (pnl > 0) { wins++; totalWin += pnl; }
      else { totalLoss += Math.abs(pnl); }
    }
    const wr = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 0);
    res.json({
      trades: closed.length,
      open: open.length,
      winRate: wr.toFixed(1),
      profitFactor: isFinite(pf) ? pf.toFixed(2) : 'inf',
      totalPnl: totalPnl.toFixed(2),
      avgWin: wins > 0 ? (totalWin / wins).toFixed(4) : '0',
      avgLoss: (closed.length - wins) > 0 ? (totalLoss / (closed.length - wins)).toFixed(4) : '0',
      isolated: true,
      note: 'Sniper stats are isolated from TREND/MOMENTUM. Never aggregate.',
    });
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

// --- Bearish Services ---

v2Router.get('/bearish/status', (_req: Request, res: Response) => {
  try {
    const status = getBearishStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

v2Router.post('/bearish/stop', (_req: Request, res: Response) => {
  try {
    stopBearishServices();
    res.json({ status: 'stopped' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

v2Router.post('/bearish/start', async (_req: Request, res: Response) => {
  try {
    await initKrakenAdapter();
    initBearishServices(krakenV2);
    startBearishServices();
    res.json({ status: 'started' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
