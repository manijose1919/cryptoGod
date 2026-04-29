// ============================================
// Phoenix V2 Attribution Store
// SQLite persistence for v2_trades and v2_signal_scores
// ============================================

import { getDb } from '../../services/database.js';
import type {
  V2Trade,
  SignalScore,
  TradeStatus,
  ExitReason,
  SignalSnapshot,
  DecisionRecord,
  Regime,
} from '../pipeline/types.ts';
import { TRADE_STATUS } from '../pipeline/types.ts';

// --- Schema Init ---

export function initV2Tables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_trades (
      id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      status TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_time INTEGER NOT NULL,
      entry_order_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      position_size_usd REAL NOT NULL,
      exit_price REAL,
      exit_time INTEGER,
      exit_reason TEXT,
      pnl_gross REAL,
      pnl_net REAL,
      fees_paid REAL NOT NULL DEFAULT 0,
      hold_duration_ms INTEGER,
      initial_stop REAL NOT NULL,
      current_stop REAL NOT NULL,
      take_profit_target REAL NOT NULL,
      trailing_activated INTEGER NOT NULL DEFAULT 0,
      entry_signals TEXT,
      entry_regime TEXT,
      entry_confidence REAL,
      decision_log TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_v2_trades_status ON v2_trades(status);
    CREATE INDEX IF NOT EXISTS idx_v2_trades_ticker ON v2_trades(ticker);
    CREATE INDEX IF NOT EXISTS idx_v2_trades_created_at ON v2_trades(created_at);

    CREATE TABLE IF NOT EXISTS v2_signal_scores (
      signal_name TEXT PRIMARY KEY,
      total_trades INTEGER NOT NULL DEFAULT 0,
      winning_trades INTEGER NOT NULL DEFAULT 0,
      win_rate REAL NOT NULL DEFAULT 0,
      avg_pnl_when_active REAL NOT NULL DEFAULT 0,
      avg_pnl_when_inactive REAL NOT NULL DEFAULT 0,
      edge REAL NOT NULL DEFAULT 0,
      last_updated INTEGER
    );
  `);

  // Migration: add strategy column
  try {
    db.exec(`ALTER TABLE v2_trades ADD COLUMN strategy TEXT NOT NULL DEFAULT 'TREND'`);
  } catch { /* column already exists */ }

  // Migration (2026-04-29): persist atrPercent, peakPrice, peakHistogram
  // These were in-memory-only on the V2Trade type but referenced by exit managers.
  // Without persistence, every loop loaded them as undefined, silently breaking:
  //   - quick-kill stop tightening (TREND exitManager) — verified 0/94 firings
  //   - ATR-aware trailing giveback widening/tightening (TREND)
  //   - histogram-decay exit (MOMENTUM)
  //   - chandelier stop (BREAKOUT)
  //   - peak-anchored trailing (MEAN_REVERSION)
  // Old rows have NULL — code falls back to safe defaults via `?? entry`/`!= null` checks.
  try {
    db.exec(`ALTER TABLE v2_trades ADD COLUMN atr_percent REAL`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE v2_trades ADD COLUMN peak_price REAL`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE v2_trades ADD COLUMN peak_histogram REAL`);
  } catch { /* column already exists */ }
}

// --- Prepared Statements (lazily initialized) ---

let _insertStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _closeStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _updateStopStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _trailingStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _openStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _closedStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _byIdStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _getStopStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _scoresStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _upsertScoreStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getInsertStmt() {
  if (!_insertStmt) {
    _insertStmt = getDb().prepare(`
      INSERT INTO v2_trades (
        id, ticker, side, status, entry_price, entry_time, entry_order_type,
        quantity, position_size_usd, exit_price, exit_time, exit_reason,
        pnl_gross, pnl_net, fees_paid, hold_duration_ms,
        initial_stop, current_stop, take_profit_target, trailing_activated,
        entry_signals, entry_regime, entry_confidence, decision_log, strategy,
        atr_percent, peak_price, peak_histogram, created_at
      ) VALUES (
        @id, @ticker, @side, @status, @entryPrice, @entryTime, @entryOrderType,
        @quantity, @positionSizeUsd, @exitPrice, @exitTime, @exitReason,
        @pnlGross, @pnlNet, @feesPaid, @holdDurationMs,
        @initialStop, @currentStop, @takeProfitTarget, @trailingActivated,
        @entrySignals, @entryRegime, @entryConfidence, @decisionLog, @strategy,
        @atrPercent, @peakPrice, @peakHistogram, @createdAt
      )
    `);
  }
  return _insertStmt;
}

// --- Trade CRUD ---

export function insertTrade(trade: V2Trade): void {
  getInsertStmt().run({
    id: trade.id,
    ticker: trade.ticker,
    side: trade.side,
    status: trade.status,
    entryPrice: trade.entryPrice,
    entryTime: trade.entryTime,
    entryOrderType: trade.entryOrderType,
    quantity: trade.quantity,
    positionSizeUsd: trade.positionSizeUsd,
    exitPrice: trade.exitPrice,
    exitTime: trade.exitTime,
    exitReason: trade.exitReason,
    pnlGross: trade.pnlGross,
    pnlNet: trade.pnlNet,
    feesPaid: trade.feesPaid,
    holdDurationMs: trade.holdDurationMs,
    initialStop: trade.initialStop,
    currentStop: trade.currentStop,
    takeProfitTarget: trade.takeProfitTarget,
    trailingActivated: trade.trailingActivated ? 1 : 0,
    entrySignals: JSON.stringify(trade.entrySignals),
    entryRegime: trade.entryRegime,
    entryConfidence: trade.entryConfidence,
    decisionLog: JSON.stringify(trade.decisionLog),
    strategy: trade.strategy ?? 'TREND',
    atrPercent: trade.atrPercent ?? null,
    peakPrice: trade.peakPrice ?? null,
    peakHistogram: trade.peakHistogram ?? null,
    createdAt: trade.createdAt,
  });
}

export function closeTrade(
  tradeId: string,
  exitPrice: number,
  exitReason: ExitReason,
  feesPaid: number,
): void {
  if (!_closeStmt) {
    _closeStmt = getDb().prepare(`
      UPDATE v2_trades SET
        status = @status,
        exit_price = @exitPrice,
        exit_time = @exitTime,
        exit_reason = @exitReason,
        pnl_gross = @pnlGross,
        pnl_net = @pnlNet,
        fees_paid = @feesPaid,
        hold_duration_ms = @holdDurationMs
      WHERE id = @tradeId
    `);
  }

  const trade = getTradeById(tradeId);
  if (!trade) throw new Error(`Trade ${tradeId} not found`);

  const now = Date.now();
  const pnlGross = (exitPrice - trade.entryPrice) * trade.quantity *
    (trade.side === 'long' ? 1 : -1);
  const pnlNet = pnlGross - feesPaid;
  const holdDurationMs = now - trade.entryTime;

  _closeStmt.run({
    status: TRADE_STATUS.closed,
    exitPrice,
    exitTime: now,
    exitReason,
    pnlGross,
    pnlNet,
    feesPaid,
    holdDurationMs,
    tradeId,
  });
}

export function updateTradeStop(tradeId: string, newStop: number): void {
  // Read current stop first — only tighten (for longs: only goes UP)
  if (!_getStopStmt) {
    _getStopStmt = getDb().prepare(
      `SELECT current_stop, side FROM v2_trades WHERE id = @tradeId`
    );
  }
  const row = _getStopStmt.get({ tradeId }) as { current_stop: number; side: string } | undefined;
  if (!row) throw new Error(`Trade ${tradeId} not found`);

  // For longs, stop can only go up; for shorts, stop can only go down
  if (row.side === 'long' && newStop <= row.current_stop) return;
  if (row.side === 'short' && newStop >= row.current_stop) return;

  if (!_updateStopStmt) {
    _updateStopStmt = getDb().prepare(
      `UPDATE v2_trades SET current_stop = @newStop WHERE id = @tradeId`
    );
  }
  _updateStopStmt.run({ newStop, tradeId });
}

export function markTrailingActivated(tradeId: string): void {
  if (!_trailingStmt) {
    _trailingStmt = getDb().prepare(
      `UPDATE v2_trades SET trailing_activated = 1 WHERE id = @tradeId`
    );
  }
  _trailingStmt.run({ tradeId });
}

let _updatePeakPriceStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _updatePeakHistStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

/**
 * Update peak price for a trade — only if newPeak > stored peak (monotonic).
 * Used by momentum/breakout/mr exit managers for chandelier and peak-anchored
 * trailing logic. Without persistence, the peak resets to entryPrice each loop.
 */
export function updateTradePeakPrice(tradeId: string, newPeak: number): void {
  if (!_updatePeakPriceStmt) {
    _updatePeakPriceStmt = getDb().prepare(
      `UPDATE v2_trades SET peak_price = @newPeak
       WHERE id = @tradeId AND (peak_price IS NULL OR peak_price < @newPeak)`
    );
  }
  _updatePeakPriceStmt.run({ tradeId, newPeak });
}

/**
 * Update peak MACD histogram for a trade — only if newPeak > stored peak.
 * Used by MOMENTUM histogram-decay exit. Without persistence the decay
 * comparison `currentHist < peakHist * 0.5` is always false because
 * peakHist defaults to currentHist each loop.
 */
export function updateTradePeakHistogram(tradeId: string, newPeak: number): void {
  if (!_updatePeakHistStmt) {
    _updatePeakHistStmt = getDb().prepare(
      `UPDATE v2_trades SET peak_histogram = @newPeak
       WHERE id = @tradeId AND (peak_histogram IS NULL OR peak_histogram < @newPeak)`
    );
  }
  _updatePeakHistStmt.run({ tradeId, newPeak });
}

// --- Queries ---

export function getOpenTrades(): V2Trade[] {
  if (!_openStmt) {
    _openStmt = getDb().prepare(
      `SELECT * FROM v2_trades WHERE status = 'open' ORDER BY created_at DESC`
    );
  }
  const rows = _openStmt.all() as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export function getClosedTrades(limit: number = 100): V2Trade[] {
  if (!_closedStmt) {
    _closedStmt = getDb().prepare(
      `SELECT * FROM v2_trades WHERE status = 'closed' ORDER BY created_at DESC LIMIT @limit`
    );
  }
  const rows = _closedStmt.all({ limit }) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export function getClosedTradesByStrategy(strategy: string, limit: number = 100): V2Trade[] {
  const stmt = getDb().prepare(
    `SELECT * FROM v2_trades WHERE status = 'closed' AND strategy = @strategy ORDER BY created_at DESC LIMIT @limit`
  );
  const rows = stmt.all({ strategy, limit }) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

export function getTradeById(tradeId: string): V2Trade | null {
  if (!_byIdStmt) {
    _byIdStmt = getDb().prepare(`SELECT * FROM v2_trades WHERE id = @tradeId`);
  }
  const row = _byIdStmt.get({ tradeId }) as Record<string, unknown> | undefined;
  return row ? rowToTrade(row) : null;
}

// --- Signal Scores ---

export function getSignalScores(): SignalScore[] {
  if (!_scoresStmt) {
    _scoresStmt = getDb().prepare(
      `SELECT * FROM v2_signal_scores ORDER BY edge DESC`
    );
  }
  const rows = _scoresStmt.all() as Record<string, unknown>[];
  return rows.map((r) => ({
    signalName: r.signal_name as string,
    totalTrades: r.total_trades as number,
    winningTrades: r.winning_trades as number,
    winRate: r.win_rate as number,
    avgPnlWhenActive: r.avg_pnl_when_active as number,
    avgPnlWhenInactive: r.avg_pnl_when_inactive as number,
    edge: r.edge as number,
    lastUpdated: r.last_updated as number,
  }));
}

export function upsertSignalScore(score: SignalScore): void {
  if (!_upsertScoreStmt) {
    _upsertScoreStmt = getDb().prepare(`
      INSERT INTO v2_signal_scores (
        signal_name, total_trades, winning_trades, win_rate,
        avg_pnl_when_active, avg_pnl_when_inactive, edge, last_updated
      ) VALUES (
        @signalName, @totalTrades, @winningTrades, @winRate,
        @avgPnlWhenActive, @avgPnlWhenInactive, @edge, @lastUpdated
      )
      ON CONFLICT(signal_name) DO UPDATE SET
        total_trades = @totalTrades,
        winning_trades = @winningTrades,
        win_rate = @winRate,
        avg_pnl_when_active = @avgPnlWhenActive,
        avg_pnl_when_inactive = @avgPnlWhenInactive,
        edge = @edge,
        last_updated = @lastUpdated
    `);
  }
  _upsertScoreStmt.run({
    signalName: score.signalName,
    totalTrades: score.totalTrades,
    winningTrades: score.winningTrades,
    winRate: score.winRate,
    avgPnlWhenActive: score.avgPnlWhenActive,
    avgPnlWhenInactive: score.avgPnlWhenInactive,
    edge: score.edge,
    lastUpdated: score.lastUpdated,
  });
}

// --- Row Mapper ---

function rowToTrade(row: Record<string, unknown>): V2Trade {
  let entrySignals: SignalSnapshot;
  try {
    entrySignals = JSON.parse(row.entry_signals as string || '{}');
  } catch {
    entrySignals = {} as SignalSnapshot;
  }

  let decisionLog: DecisionRecord[];
  try {
    decisionLog = JSON.parse(row.decision_log as string || '[]');
  } catch {
    decisionLog = [];
  }

  return {
    id: row.id as string,
    ticker: row.ticker as string,
    side: (row.side as 'long' | 'short') || 'long',
    status: row.status as TradeStatus,
    entryPrice: row.entry_price as number,
    entryTime: row.entry_time as number,
    entryOrderType: row.entry_order_type as string,
    quantity: row.quantity as number,
    positionSizeUsd: row.position_size_usd as number,
    exitPrice: (row.exit_price as number) ?? null,
    exitTime: (row.exit_time as number) ?? null,
    exitReason: (row.exit_reason as ExitReason) ?? null,
    pnlGross: (row.pnl_gross as number) ?? null,
    pnlNet: (row.pnl_net as number) ?? null,
    feesPaid: (row.fees_paid as number) || 0,
    holdDurationMs: (row.hold_duration_ms as number) ?? null,
    initialStop: row.initial_stop as number,
    currentStop: row.current_stop as number,
    takeProfitTarget: row.take_profit_target as number,
    trailingActivated: !!(row.trailing_activated as number),
    entrySignals,
    entryRegime: row.entry_regime as Regime,
    entryConfidence: row.entry_confidence as number,
    decisionLog,
    strategy: (row.strategy as string) ?? 'TREND',
    atrPercent: (row.atr_percent as number) ?? undefined,
    peakPrice: (row.peak_price as number) ?? undefined,
    peakHistogram: (row.peak_histogram as number) ?? undefined,
    createdAt: row.created_at as number,
  };
}

export function getOpenTradesByStrategy(strategy: string): V2Trade[] {
  const stmt = getDb().prepare(
    `SELECT * FROM v2_trades WHERE status = 'open' AND strategy = @strategy ORDER BY created_at DESC`
  );
  const rows = stmt.all({ strategy }) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}
