/**
 * Persistence API Routes
 * Express routes for CRUD operations on SQLite database tables.
 */

import express from 'express';
import {
  insertTrade, getTrades, getTradeCount,
  insertTradeMemory, getTradeMemories,
  upsertLearnedPattern, getLearnedPatterns,
  insertParameterSnapshot, getParameterHistory, getLatestParameters,
  insertSession, updateSession, getSessions,
  insertCandlesBatch, getCandles, getCandleCount,
  insertSentimentSnapshot, getSentimentHistory,
  setSetting, getSetting, getAllSettings,
} from '../services/database.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const router = express.Router();

// ============================================
// TRADES
// ============================================
router.get('/trades', (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 500, 5000));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const strategy = req.query.strategy || null;
    const trades = getTrades({ limit, offset, strategy });
    const total = getTradeCount(strategy);
    res.json({ trades, total, limit, offset });
  } catch (error) {
    next(error);
  }
});

router.post('/trades', (req, res, next) => {
  try {
    const { ticker, strategy, entryPrice, exitPrice, quantity, pnl, pnlPercent, outcome, reason, entryTime, exitTime } = req.body;
    if (!ticker || !strategy || !entryPrice || !quantity || !entryTime) {
      return res.status(400).json({ message: 'Missing required fields: ticker, strategy, entryPrice, quantity, entryTime' });
    }
    const result = insertTrade({
      ticker, strategy, entryPrice, exitPrice: exitPrice || null,
      quantity, pnl: pnl ?? null, pnlPercent: pnlPercent ?? null,
      outcome: outcome || null, reason: reason || null,
      entryTime, exitTime: exitTime || null,
    });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

// ============================================
// TRADE MEMORY (AI Learning)
// ============================================
router.get('/trade-memory', (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    const memories = getTradeMemories(limit);
    res.json({ memories, count: memories.length });
  } catch (error) {
    next(error);
  }
});

router.post('/trade-memory', (req, res, next) => {
  try {
    const m = req.body;
    if (!m.ticker || !m.strategy) {
      return res.status(400).json({ message: 'Missing required fields: ticker, strategy' });
    }
    const result = insertTradeMemory({
      ticker: m.ticker,
      strategy: m.strategy,
      entryPrice: m.entryPrice || null,
      exitPrice: m.exitPrice || null,
      entryTime: m.entryTime || null,
      exitTime: m.exitTime || null,
      pnl: m.pnl || null,
      pnlPercent: m.pnlPercent || null,
      outcome: m.outcome || null,
      holdDuration: m.holdDuration || null,
      marketVolatility: m.marketConditions?.volatility || null,
      marketTrend: m.marketConditions?.trend || null,
      marketVolume: m.marketConditions?.volume || null,
      tcValue: m.indicators?.tcValue || null,
      momentumValue: m.indicators?.momentumValue || null,
      whaleValue: m.indicators?.whaleValue || null,
      confluenceScore: m.indicators?.confluenceScore || null,
      aiAnalysis: m.aiAnalysis || null,
    });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

// ============================================
// LEARNED PATTERNS
// ============================================
router.get('/learned-patterns', (req, res, next) => {
  try {
    const patterns = getLearnedPatterns();
    res.json({ patterns });
  } catch (error) {
    next(error);
  }
});

router.put('/learned-patterns/:id', (req, res, next) => {
  try {
    const p = req.body;
    const id = req.params.id;
    upsertLearnedPattern({
      id,
      description: p.description || '',
      tcRangeLow: p.conditions?.tcRange?.[0] ?? p.tcRangeLow ?? 0,
      tcRangeHigh: p.conditions?.tcRange?.[1] ?? p.tcRangeHigh ?? 100,
      momentumRangeLow: p.conditions?.momentumRange?.[0] ?? p.momentumRangeLow ?? 0,
      momentumRangeHigh: p.conditions?.momentumRange?.[1] ?? p.momentumRangeHigh ?? 100,
      volatility: p.conditions?.volatility ?? p.volatility ?? '',
      trend: p.conditions?.trend ?? p.trend ?? '',
      successRate: p.successRate ?? 0,
      sampleSize: p.sampleSize ?? 0,
      recommendation: p.recommendation ?? 'AVOID',
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PARAMETER HISTORY
// ============================================
router.get('/parameter-history', (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const history = getParameterHistory(limit);
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

router.get('/parameter-history/latest', (req, res, next) => {
  try {
    const latest = getLatestParameters();
    res.json({ latest: latest || null });
  } catch (error) {
    next(error);
  }
});

router.post('/parameter-history', (req, res, next) => {
  try {
    const { params, winRate, profitFactor, totalTrades, reason } = req.body;
    if (!params) {
      return res.status(400).json({ message: 'Missing required field: params' });
    }
    const result = insertParameterSnapshot({
      paramsJson: typeof params === 'string' ? params : JSON.stringify(params),
      winRate: winRate ?? null,
      profitFactor: profitFactor ?? null,
      totalTrades: totalTrades ?? null,
      reason: reason || null,
    });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SESSIONS
// ============================================
router.get('/sessions', (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const sessionList = getSessions(limit);
    res.json({ sessions: sessionList });
  } catch (error) {
    next(error);
  }
});

router.post('/sessions', (req, res, next) => {
  try {
    const { startTime, initialBudget, notes } = req.body;
    if (!startTime) {
      return res.status(400).json({ message: 'Missing required field: startTime' });
    }
    const result = insertSession({
      startTime,
      initialBudget: initialBudget || 0,
      notes: notes || null,
    });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

router.put('/sessions/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { endTime, finalValue, totalTrades, winRate, pnl } = req.body;
    updateSession(id, {
      endTime: endTime || null,
      finalValue: finalValue ?? null,
      totalTrades: totalTrades ?? 0,
      winRate: winRate ?? null,
      pnl: pnl ?? null,
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CANDLE HISTORY
// ============================================
router.get('/candles', (req, res, next) => {
  try {
    const { ticker, timeframe, start, end } = req.query;
    if (!ticker || !timeframe) {
      return res.status(400).json({ message: 'Missing required params: ticker, timeframe' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);
    // M12: validate timestamps as finite numbers. parseInt('2024-01-01')
    // silently returns 2024 (interpreted as ms = 1970), and 'abc' returns
    // NaN making `time >= NaN` always false → empty result with no error.
    // Reject malformed input instead of silently returning nothing.
    const parseTs = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw Object.assign(new Error(`Invalid timestamp: ${v} (must be a millisecond integer)`), { status: 400 });
      return n;
    };
    let parsedStart, parsedEnd;
    try {
      parsedStart = parseTs(start);
      parsedEnd = parseTs(end);
    } catch (e) {
      return res.status(e.status || 400).json({ message: e.message });
    }
    const candles = getCandles({
      ticker,
      timeframe,
      start: parsedStart,
      end: parsedEnd,
      limit,
    });
    const total = getCandleCount(ticker, timeframe);
    res.json({ candles, count: candles.length, total });
  } catch (error) {
    next(error);
  }
});

router.post('/candles/batch', (req, res, next) => {
  try {
    const { candles } = req.body;
    if (!Array.isArray(candles) || candles.length === 0) {
      return res.status(400).json({ message: 'candles must be a non-empty array' });
    }
    insertCandlesBatch(candles);
    res.status(201).json({ inserted: candles.length });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SENTIMENT SNAPSHOTS
// ============================================
router.get('/sentiment/:ticker', (req, res, next) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // max 7 days
    const history = getSentimentHistory({ ticker: req.params.ticker, hours });
    res.json({ history, count: history.length });
  } catch (error) {
    next(error);
  }
});

router.post('/sentiment', (req, res, next) => {
  try {
    const { ticker, source, score, rawData } = req.body;
    if (!ticker || !source) {
      return res.status(400).json({ message: 'Missing required fields: ticker, source' });
    }
    const result = insertSentimentSnapshot({
      ticker,
      source,
      score: score ?? null,
      rawData: rawData ? (typeof rawData === 'string' ? rawData : JSON.stringify(rawData)) : null,
    });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SETTINGS
// ============================================
router.get('/settings', (req, res, next) => {
  try {
    const all = getAllSettings();
    res.json({ settings: all });
  } catch (error) {
    next(error);
  }
});

router.get('/settings/:key', (req, res, next) => {
  try {
    const value = getSetting(req.params.key);
    res.json({ key: req.params.key, value });
  } catch (error) {
    next(error);
  }
});

// PUT /settings/:key — C4: admin-gated. The audit found this endpoint allowed
// arbitrary settings writes including stats_baseline_time (which affects all
// reports/monitoring filtering). No auth meant any reachable client could
// nuke the baseline. Now: localhost exempt, otherwise X-API-Key required.
router.put('/settings/:key', requireAdminAuth, (req, res, next) => {
  try {
    const { value } = req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ message: 'Missing required field: value' });
    }
    const stored = typeof value === 'string' ? value : JSON.stringify(value);
    setSetting(req.params.key, stored);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
