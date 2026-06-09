// SQLite schema for pairs trading. One row per pair-trade (containing BOTH
// legs). Separate from v2_trades to keep the single-asset attribution clean.

// @ts-expect-error JS module without .d.ts; project tsconfig allows it elsewhere
import { getDb } from '../../services/database.js';

export function initPairsTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_pairs_trades (
      id              TEXT PRIMARY KEY,
      mode            TEXT NOT NULL,                    -- 'paper' | 'live'
      sym_a           TEXT NOT NULL,
      sym_b           TEXT NOT NULL,
      side            TEXT NOT NULL,                    -- 'long_spread' | 'short_spread'
      status          TEXT NOT NULL,                    -- 'open' | 'closed' | 'error'
      -- Entry
      entry_time      INTEGER NOT NULL,
      entry_price_a   REAL NOT NULL,
      entry_price_b   REAL NOT NULL,
      qty_a           REAL NOT NULL,
      qty_b           REAL NOT NULL,
      beta            REAL NOT NULL,
      alpha           REAL NOT NULL,
      entry_z         REAL NOT NULL,
      spread_mean     REAL NOT NULL,
      spread_std      REAL NOT NULL,
      adf_t_stat      REAL NOT NULL,
      halflife        REAL,
      total_notional_usd REAL NOT NULL,
      -- Exit
      exit_time       INTEGER,
      exit_price_a    REAL,
      exit_price_b    REAL,
      exit_z          REAL,
      exit_reason     TEXT,
      pnl_leg_a       REAL,
      pnl_leg_b       REAL,
      pnl_gross       REAL,
      pnl_net         REAL,
      fees_paid       REAL,
      hold_bars       INTEGER,
      -- Operational
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_pairs_trades_status ON v2_pairs_trades(status);
    CREATE INDEX IF NOT EXISTS idx_pairs_trades_pair ON v2_pairs_trades(sym_a, sym_b);

    -- Heartbeat / state snapshot for monitoring.
    -- Captures the engine's view of cointegration at each loop so we can
    -- detect drift without re-running the whole pipeline post-hoc.
    CREATE TABLE IF NOT EXISTS v2_pairs_state (
      loop_at         INTEGER PRIMARY KEY,
      sym_a           TEXT NOT NULL,
      sym_b           TEXT NOT NULL,
      beta            REAL NOT NULL,
      alpha           REAL NOT NULL,
      spread_mean     REAL NOT NULL,
      spread_std      REAL NOT NULL,
      current_spread  REAL NOT NULL,
      z_score         REAL NOT NULL,
      adf_t_stat      REAL,
      halflife        REAL,
      in_position     INTEGER NOT NULL DEFAULT 0,
      mode            TEXT NOT NULL
    );

    -- Alert log. Mirrors what's sent to Telegram so the dashboard can show
    -- recent events even when Telegram isn't configured.
    CREATE TABLE IF NOT EXISTS v2_pairs_alerts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      INTEGER NOT NULL,
      severity        TEXT NOT NULL,    -- 'info' | 'warn' | 'crit'
      kind            TEXT NOT NULL,    -- 'entry' | 'exit' | 'pause' | 'drawdown_kill' | 'adf_degrade' | 'margin_low' | 'margin_critical' | 'state_drift' | 'partial_fill' | 'stale_candles'
      message         TEXT NOT NULL,
      data_json       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pairs_alerts_created_at ON v2_pairs_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pairs_alerts_kind ON v2_pairs_alerts(kind);
  `);
}

// Key-value persistence in the shared `settings` table (created by
// services/database.js). Used for engine state that must survive pm2
// restarts (kill-switch counters, pause timestamps).
export function setPairsSetting(key: string, value: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, unixepoch() * 1000)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = unixepoch() * 1000
    `).run(key, value, value);
  } catch {
    /* settings persistence must never crash the engine */
  }
}

export function getPairsSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function recordPairsAlert(a: {
  severity: 'info' | 'warn' | 'crit';
  kind: string;
  message: string;
  data?: unknown;
}): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO v2_pairs_alerts (created_at, severity, kind, message, data_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), a.severity, a.kind, a.message, a.data ? JSON.stringify(a.data) : null);
  } catch {
    /* alerts must never crash the engine */
  }
}

export interface PairsTradeRow {
  id: string;
  mode: 'paper' | 'live';
  sym_a: string;
  sym_b: string;
  side: 'long_spread' | 'short_spread';
  status: 'open' | 'closed' | 'error';
  entry_time: number;
  entry_price_a: number;
  entry_price_b: number;
  qty_a: number;
  qty_b: number;
  beta: number;
  alpha: number;
  entry_z: number;
  spread_mean: number;
  spread_std: number;
  adf_t_stat: number;
  halflife: number | null;
  total_notional_usd: number;
  exit_time?: number | null;
  exit_price_a?: number | null;
  exit_price_b?: number | null;
  exit_z?: number | null;
  exit_reason?: string | null;
  pnl_leg_a?: number | null;
  pnl_leg_b?: number | null;
  pnl_gross?: number | null;
  pnl_net?: number | null;
  fees_paid?: number | null;
  hold_bars?: number | null;
}

export function insertPairsTrade(t: PairsTradeRow): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO v2_pairs_trades (
      id, mode, sym_a, sym_b, side, status,
      entry_time, entry_price_a, entry_price_b, qty_a, qty_b,
      beta, alpha, entry_z, spread_mean, spread_std, adf_t_stat, halflife,
      total_notional_usd
    ) VALUES (
      @id, @mode, @sym_a, @sym_b, @side, @status,
      @entry_time, @entry_price_a, @entry_price_b, @qty_a, @qty_b,
      @beta, @alpha, @entry_z, @spread_mean, @spread_std, @adf_t_stat, @halflife,
      @total_notional_usd
    )
  `);
  stmt.run(t);
}

export function closePairsTrade(
  id: string,
  exitFields: {
    exit_time: number;
    exit_price_a: number;
    exit_price_b: number;
    exit_z: number;
    exit_reason: string;
    pnl_leg_a: number;
    pnl_leg_b: number;
    pnl_gross: number;
    pnl_net: number;
    fees_paid: number;
    hold_bars: number;
  },
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE v2_pairs_trades SET
      status = 'closed',
      exit_time = @exit_time,
      exit_price_a = @exit_price_a,
      exit_price_b = @exit_price_b,
      exit_z = @exit_z,
      exit_reason = @exit_reason,
      pnl_leg_a = @pnl_leg_a,
      pnl_leg_b = @pnl_leg_b,
      pnl_gross = @pnl_gross,
      pnl_net = @pnl_net,
      fees_paid = @fees_paid,
      hold_bars = @hold_bars
    WHERE id = @id
  `);
  stmt.run({ id, ...exitFields });
}

export function getOpenPairsTrade(symA: string, symB: string): PairsTradeRow | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM v2_pairs_trades WHERE sym_a = ? AND sym_b = ? AND status = 'open' ORDER BY entry_time DESC LIMIT 1`,
  ).get(symA, symB);
  return (row as PairsTradeRow) ?? null;
}

export function recordPairsState(s: {
  loop_at: number;
  sym_a: string;
  sym_b: string;
  beta: number;
  alpha: number;
  spread_mean: number;
  spread_std: number;
  current_spread: number;
  z_score: number;
  adf_t_stat: number | null;
  halflife: number | null;
  in_position: boolean;
  mode: 'paper' | 'live';
}): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO v2_pairs_state (
      loop_at, sym_a, sym_b, beta, alpha, spread_mean, spread_std,
      current_spread, z_score, adf_t_stat, halflife, in_position, mode
    ) VALUES (
      @loop_at, @sym_a, @sym_b, @beta, @alpha, @spread_mean, @spread_std,
      @current_spread, @z_score, @adf_t_stat, @halflife, @in_position, @mode
    )
  `).run({
    ...s,
    in_position: s.in_position ? 1 : 0,
  });
}
