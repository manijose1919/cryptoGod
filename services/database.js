/**
 * SQLite Database Module
 * Persistent storage for trades, learning data, candle history, and settings.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;

/**
 * Get the database instance (must call initializeDatabase first)
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Initialize the SQLite database with all required tables
 */
export function initializeDatabase() {
  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'trading.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create all tables
  db.exec(`
    -- Core trade history
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      strategy TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      quantity REAL NOT NULL,
      pnl REAL,
      pnl_percent REAL,
      outcome TEXT CHECK(outcome IN ('WIN','LOSS','BREAKEVEN')),
      reason TEXT,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Candle history for backtesting
    CREATE TABLE IF NOT EXISTS candle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      UNIQUE(ticker, timeframe, time)
    );
    CREATE INDEX IF NOT EXISTS idx_candle_lookup
      ON candle_history(ticker, timeframe, time);

    -- AI learning trade memory
    CREATE TABLE IF NOT EXISTS trade_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      strategy TEXT NOT NULL,
      entry_price REAL,
      exit_price REAL,
      entry_time INTEGER,
      exit_time INTEGER,
      pnl REAL,
      pnl_percent REAL,
      outcome TEXT CHECK(outcome IN ('WIN','LOSS','BREAKEVEN')),
      hold_duration REAL,
      market_volatility TEXT,
      market_trend TEXT,
      market_volume TEXT,
      tc_value REAL,
      momentum_value REAL,
      whale_value REAL,
      confluence_score REAL,
      ai_analysis TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Learned patterns from AI analysis
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id TEXT PRIMARY KEY,
      description TEXT,
      tc_range_low REAL,
      tc_range_high REAL,
      momentum_range_low REAL,
      momentum_range_high REAL,
      volatility TEXT,
      trend TEXT,
      success_rate REAL,
      sample_size INTEGER,
      recommendation TEXT,
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Parameter adjustment history
    CREATE TABLE IF NOT EXISTS parameter_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      params_json TEXT NOT NULL,
      win_rate REAL,
      profit_factor REAL,
      total_trades INTEGER,
      reason TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Trading sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      initial_budget REAL,
      final_value REAL,
      total_trades INTEGER DEFAULT 0,
      win_rate REAL,
      pnl REAL,
      notes TEXT
    );

    -- Sentiment snapshots (for social sentiment storage)
    CREATE TABLE IF NOT EXISTS sentiment_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL,
      raw_data TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_sentiment_lookup
      ON sentiment_snapshots(ticker, created_at);

    -- System activity logs
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Key-value settings store
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- Multi-exchange order book / price snapshots
    CREATE TABLE IF NOT EXISTS exchange_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL,
      bid_total REAL,
      ask_total REAL,
      imbalance REAL,
      spread REAL,
      spread_pct REAL,
      best_bid REAL,
      best_ask REAL,
      volume_24h REAL,
      price REAL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exchange_snap
      ON exchange_snapshots(ticker, exchange, timestamp);

    -- Derivatives data (OKX futures/perps)
    CREATE TABLE IF NOT EXISTS derivatives_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      open_interest REAL,
      oi_usd REAL,
      funding_rate REAL,
      futures_price REAL,
      spot_price REAL,
      basis REAL,
      basis_pct REAL,
      oi_change_pct REAL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_derivatives
      ON derivatives_data(ticker, timestamp);

    -- DeFi snapshots (DeFiLlama)
    CREATE TABLE IF NOT EXISTS defi_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_tvl REAL,
      tvl_change_24h REAL,
      dex_volume_24h REAL,
      stablecoin_mcap REAL,
      stablecoin_change REAL,
      top_chains_json TEXT,
      timestamp INTEGER NOT NULL
    );

    -- Aggregated news items (CryptoPanic + Reddit)
    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      currencies TEXT,
      sentiment_score REAL,
      published_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_news_lookup
      ON news_items(currencies, published_at);

    -- Pre-computed ML feature vectors
    CREATE TABLE IF NOT EXISTS ml_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      features_json TEXT NOT NULL,
      label TEXT,
      label_value REAL,
      labeled_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_ml_features
      ON ml_features(ticker, timestamp);

    -- Serialized ML model weights
    CREATE TABLE IF NOT EXISTS ml_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_type TEXT NOT NULL,
      model_data TEXT NOT NULL,
      accuracy REAL,
      precision_score REAL,
      recall REAL,
      f1_score REAL,
      sample_count INTEGER,
      feature_importance_json TEXT,
      config_json TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ML prediction log with retroactive accuracy
    CREATE TABLE IF NOT EXISTS ml_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      model_id INTEGER,
      prediction TEXT NOT NULL,
      confidence REAL,
      features_snapshot TEXT,
      actual_outcome TEXT,
      was_correct INTEGER,
      timestamp INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (model_id) REFERENCES ml_models(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ml_predictions
      ON ml_predictions(ticker, timestamp);
  `);

  // Phase 1: Backend Bot Engine tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      time INTEGER NOT NULL,
      total_value REAL NOT NULL,
      cash REAL NOT NULL,
      holdings_value REAL NOT NULL,
      open_positions INTEGER DEFAULT 0,
      pnl_percent REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_equity_snapshots_session
      ON equity_snapshots(session_id, time);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      time INTEGER NOT NULL,
      type TEXT NOT NULL,
      ticker TEXT NOT NULL,
      price REAL NOT NULL,
      quantity REAL NOT NULL,
      notional REAL DEFAULT 0,
      strategy TEXT,
      reason TEXT,
      pnl REAL DEFAULT 0,
      fee REAL DEFAULT 0,
      balance_after REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_session_trades_session
      ON session_trades(session_id, time);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ml_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      time INTEGER NOT NULL,
      type TEXT NOT NULL,
      ticker TEXT,
      action TEXT,
      confidence REAL,
      reason TEXT,
      indicators TEXT,
      feature_importance TEXT,
      regime TEXT,
      market_speed TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ml_thoughts_session
      ON ml_thoughts(session_id, time);
  `);

  // Migrate sessions table: add session_id, status, trading_mode columns
  try { db.exec(`ALTER TABLE sessions ADD COLUMN session_id TEXT`); } catch(e) { /* already exists */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'ACTIVE'`); } catch(e) {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN trading_mode TEXT DEFAULT 'SIMULATION'`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`); } catch(e) {}

  console.log(`[Database] Initialized SQLite at ${dbPath}`);
  return db;
}

/**
 * Close the database connection gracefully
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Connection closed');
  }
}

// ============================================
// PREPARED STATEMENT HELPERS
// ============================================

// --- Trades ---
export function insertTrade(trade) {
  const stmt = getDb().prepare(`
    INSERT INTO trades (ticker, strategy, entry_price, exit_price, quantity, pnl, pnl_percent, outcome, reason, entry_time, exit_time)
    VALUES (@ticker, @strategy, @entryPrice, @exitPrice, @quantity, @pnl, @pnlPercent, @outcome, @reason, @entryTime, @exitTime)
  `);
  return stmt.run(trade);
}

export function getTrades({ limit = 500, offset = 0, strategy = null } = {}) {
  if (strategy) {
    return getDb().prepare(
      'SELECT * FROM trades WHERE strategy = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(strategy, limit, offset);
  }
  return getDb().prepare(
    'SELECT * FROM trades ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

export function getTradeCount(strategy = null) {
  if (strategy) {
    return getDb().prepare('SELECT COUNT(*) as count FROM trades WHERE strategy = ?').get(strategy).count;
  }
  return getDb().prepare('SELECT COUNT(*) as count FROM trades').get().count;
}

// --- Trade Memory (AI Learning) ---
export function insertTradeMemory(memory) {
  const stmt = getDb().prepare(`
    INSERT INTO trade_memory (ticker, strategy, entry_price, exit_price, entry_time, exit_time, pnl, pnl_percent, outcome, hold_duration, market_volatility, market_trend, market_volume, tc_value, momentum_value, whale_value, confluence_score, ai_analysis)
    VALUES (@ticker, @strategy, @entryPrice, @exitPrice, @entryTime, @exitTime, @pnl, @pnlPercent, @outcome, @holdDuration, @marketVolatility, @marketTrend, @marketVolume, @tcValue, @momentumValue, @whaleValue, @confluenceScore, @aiAnalysis)
  `);
  return stmt.run(memory);
}

export function getTradeMemories(limit = 500) {
  return getDb().prepare(
    'SELECT * FROM trade_memory ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

// --- Learned Patterns ---
export function upsertLearnedPattern(pattern) {
  const stmt = getDb().prepare(`
    INSERT INTO learned_patterns (id, description, tc_range_low, tc_range_high, momentum_range_low, momentum_range_high, volatility, trend, success_rate, sample_size, recommendation, updated_at)
    VALUES (@id, @description, @tcRangeLow, @tcRangeHigh, @momentumRangeLow, @momentumRangeHigh, @volatility, @trend, @successRate, @sampleSize, @recommendation, unixepoch() * 1000)
    ON CONFLICT(id) DO UPDATE SET
      description = @description,
      tc_range_low = @tcRangeLow,
      tc_range_high = @tcRangeHigh,
      momentum_range_low = @momentumRangeLow,
      momentum_range_high = @momentumRangeHigh,
      volatility = @volatility,
      trend = @trend,
      success_rate = @successRate,
      sample_size = @sampleSize,
      recommendation = @recommendation,
      updated_at = unixepoch() * 1000
  `);
  return stmt.run(pattern);
}

export function getLearnedPatterns() {
  return getDb().prepare('SELECT * FROM learned_patterns ORDER BY updated_at DESC').all();
}

// --- Parameter History ---
export function insertParameterSnapshot(snapshot) {
  const stmt = getDb().prepare(`
    INSERT INTO parameter_history (params_json, win_rate, profit_factor, total_trades, reason)
    VALUES (@paramsJson, @winRate, @profitFactor, @totalTrades, @reason)
  `);
  return stmt.run(snapshot);
}

export function getParameterHistory(limit = 50) {
  return getDb().prepare(
    'SELECT * FROM parameter_history ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

export function getLatestParameters() {
  return getDb().prepare(
    'SELECT * FROM parameter_history ORDER BY created_at DESC LIMIT 1'
  ).get();
}

// --- Sessions ---
export function insertSession(session) {
  const stmt = getDb().prepare(`
    INSERT INTO sessions (start_time, initial_budget, notes)
    VALUES (@startTime, @initialBudget, @notes)
  `);
  return stmt.run(session);
}

export function updateSession(id, updates) {
  const stmt = getDb().prepare(`
    UPDATE sessions SET end_time = @endTime, final_value = @finalValue, total_trades = @totalTrades, win_rate = @winRate, pnl = @pnl
    WHERE id = @id
  `);
  return stmt.run({ id, ...updates });
}

export function getSessions(limit = 50) {
  return getDb().prepare(
    'SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?'
  ).all(limit);
}

// --- Session History (Phase 7: Session tracking) ---
export function insertSessionRecord(sessionId, startTime, initialBudget, tradingMode, notes = '') {
  const stmt = getDb().prepare(`
    INSERT INTO sessions (session_id, start_time, initial_budget, trading_mode, status, notes)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
  `);
  return stmt.run(sessionId, startTime, initialBudget, tradingMode, notes);
}

export function completeSession(sessionId, endTime, finalValue, totalTrades, winRate, pnl) {
  return getDb().prepare(`
    UPDATE sessions SET end_time = ?, final_value = ?, total_trades = ?, win_rate = ?, pnl = ?, status = 'COMPLETED'
    WHERE session_id = ?
  `).run(endTime, finalValue, totalTrades, winRate, pnl, sessionId);
}

export function markAbandonedSessions() {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  // Mark any ACTIVE session whose last equity snapshot is older than 5 minutes
  const activeSessions = getDb().prepare(
    `SELECT s.id, s.session_id FROM sessions s WHERE s.status = 'ACTIVE'`
  ).all();
  let marked = 0;
  for (const sess of activeSessions) {
    const latest = getDb().prepare(
      `SELECT MAX(time) as last_time FROM equity_snapshots WHERE session_id = ?`
    ).get(sess.session_id);
    if (!latest?.last_time || latest.last_time < fiveMinAgo) {
      getDb().prepare(`UPDATE sessions SET status = 'ABANDONED' WHERE id = ?`).run(sess.id);
      marked++;
    }
  }
  if (marked > 0) console.log(`[Database] Marked ${marked} abandoned session(s)`);
  return marked;
}

export function getSessionHistory(limit = 50) {
  return getDb().prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM session_trades st WHERE st.session_id = s.session_id) as trade_count,
      (SELECT MAX(time) FROM equity_snapshots es WHERE es.session_id = s.session_id) as last_activity,
      (SELECT total_value FROM equity_snapshots es WHERE es.session_id = s.session_id ORDER BY time DESC LIMIT 1) as last_value,
      (SELECT cash FROM equity_snapshots es WHERE es.session_id = s.session_id ORDER BY time DESC LIMIT 1) as last_cash
    FROM sessions s
    WHERE s.session_id IS NOT NULL
    ORDER BY s.start_time DESC
    LIMIT ?
  `).all(limit);
}

export function getSessionDetail(sessionId) {
  const session = getDb().prepare(
    `SELECT * FROM sessions WHERE session_id = ?`
  ).get(sessionId);
  if (!session) return null;
  const equityCurve = getDb().prepare(
    `SELECT time, total_value, cash, holdings_value, pnl_percent FROM equity_snapshots WHERE session_id = ? ORDER BY time ASC LIMIT 500`
  ).all(sessionId);
  const trades = getDb().prepare(
    `SELECT * FROM session_trades WHERE session_id = ? ORDER BY time DESC LIMIT 100`
  ).all(sessionId);
  const stats = getDb().prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl,
      MAX(pnl) as best_trade,
      MIN(pnl) as worst_trade,
      SUM(fee) as total_fees
    FROM session_trades WHERE session_id = ? AND type = 'SELL'
  `).get(sessionId);
  return { session, equityCurve, trades, stats };
}

// --- Candle History ---
export function insertCandlesBatch(candles) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO candle_history (ticker, timeframe, time, open, high, low, close, volume)
    VALUES (@ticker, @timeframe, @time, @open, @high, @low, @close, @volume)
  `);

  const insertMany = getDb().transaction((rows) => {
    for (const row of rows) {
      stmt.run(row);
    }
  });

  insertMany(candles);
}

export function getCandles({ ticker, timeframe, start, end, limit = 1000 } = {}) {
  let query = 'SELECT * FROM candle_history WHERE ticker = ? AND timeframe = ?';
  const params = [ticker, timeframe];

  if (start) {
    query += ' AND time >= ?';
    params.push(start);
  }
  if (end) {
    query += ' AND time <= ?';
    params.push(end);
  }

  query += ' ORDER BY time ASC LIMIT ?';
  params.push(limit);

  return getDb().prepare(query).all(...params);
}

export function getCandleCount(ticker, timeframe) {
  return getDb().prepare(
    'SELECT COUNT(*) as count FROM candle_history WHERE ticker = ? AND timeframe = ?'
  ).get(ticker, timeframe).count;
}

// --- Sentiment Snapshots ---
export function insertSentimentSnapshot(snapshot) {
  const stmt = getDb().prepare(`
    INSERT INTO sentiment_snapshots (ticker, source, score, raw_data)
    VALUES (@ticker, @source, @score, @rawData)
  `);
  return stmt.run(snapshot);
}

export function getSentimentHistory({ ticker, hours = 24 } = {}) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return getDb().prepare(
    'SELECT * FROM sentiment_snapshots WHERE ticker = ? AND created_at > ? ORDER BY created_at ASC'
  ).all(ticker, cutoff);
}

// --- System Logs ---
export function insertSystemLog(log) {
  const stmt = getDb().prepare(`
    INSERT INTO system_logs (time, message, type)
    VALUES (@time, @message, @type)
  `);
  return stmt.run(log);
}

export function getSystemLogs(limit = 100) {
  return getDb().prepare(
    'SELECT * FROM system_logs ORDER BY time DESC LIMIT ?'
  ).all(limit);
}

// --- Settings ---
export function setSetting(key, value) {
  const stmt = getDb().prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, unixepoch() * 1000)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = unixepoch() * 1000
  `);
  return stmt.run(key, value, value);
}

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function getAllSettings() {
  return getDb().prepare('SELECT * FROM settings ORDER BY key').all();
}

// ============================================
// MULTI-EXCHANGE DATA TABLES
// ============================================

// --- Exchange Snapshots ---
export function insertExchangeSnapshot(snap) {
  const stmt = getDb().prepare(`
    INSERT INTO exchange_snapshots (ticker, exchange, bid_total, ask_total, imbalance, spread, spread_pct, best_bid, best_ask, volume_24h, price, timestamp)
    VALUES (@ticker, @exchange, @bidTotal, @askTotal, @imbalance, @spread, @spreadPct, @bestBid, @bestAsk, @volume24h, @price, @timestamp)
  `);
  return stmt.run(snap);
}

export function insertExchangeSnapshotsBatch(snapshots) {
  const stmt = getDb().prepare(`
    INSERT INTO exchange_snapshots (ticker, exchange, bid_total, ask_total, imbalance, spread, spread_pct, best_bid, best_ask, volume_24h, price, timestamp)
    VALUES (@ticker, @exchange, @bidTotal, @askTotal, @imbalance, @spread, @spreadPct, @bestBid, @bestAsk, @volume24h, @price, @timestamp)
  `);
  const insertMany = getDb().transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(snapshots);
}

export function getExchangeSnapshots(ticker, hours = 1) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return getDb().prepare(
    'SELECT * FROM exchange_snapshots WHERE ticker = ? AND timestamp > ? ORDER BY timestamp DESC'
  ).all(ticker, cutoff);
}

export function getLatestExchangeSnapshot(ticker, exchange) {
  return getDb().prepare(
    'SELECT * FROM exchange_snapshots WHERE ticker = ? AND exchange = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(ticker, exchange);
}

// --- Derivatives Data ---
export function insertDerivativesData(data) {
  const stmt = getDb().prepare(`
    INSERT INTO derivatives_data (ticker, open_interest, oi_usd, funding_rate, futures_price, spot_price, basis, basis_pct, oi_change_pct, timestamp)
    VALUES (@ticker, @openInterest, @oiUsd, @fundingRate, @futuresPrice, @spotPrice, @basis, @basisPct, @oiChangePct, @timestamp)
  `);
  return stmt.run(data);
}

export function getDerivativesHistory(ticker, hours = 24) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return getDb().prepare(
    'SELECT * FROM derivatives_data WHERE ticker = ? AND timestamp > ? ORDER BY timestamp DESC'
  ).all(ticker, cutoff);
}

export function getLatestDerivatives(ticker) {
  return getDb().prepare(
    'SELECT * FROM derivatives_data WHERE ticker = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(ticker);
}

// --- DeFi Snapshots ---
export function insertDeFiSnapshot(snap) {
  const stmt = getDb().prepare(`
    INSERT INTO defi_snapshots (total_tvl, tvl_change_24h, dex_volume_24h, stablecoin_mcap, stablecoin_change, top_chains_json, timestamp)
    VALUES (@totalTvl, @tvlChange24h, @dexVolume24h, @stablecoinMcap, @stablecoinChange, @topChainsJson, @timestamp)
  `);
  return stmt.run(snap);
}

export function getLatestDeFiSnapshot() {
  return getDb().prepare(
    'SELECT * FROM defi_snapshots ORDER BY timestamp DESC LIMIT 1'
  ).get();
}

export function getDeFiHistory(hours = 24) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return getDb().prepare(
    'SELECT * FROM defi_snapshots WHERE timestamp > ? ORDER BY timestamp ASC'
  ).all(cutoff);
}

// --- News Items ---
export function insertNewsItem(item) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO news_items (external_id, source, title, url, currencies, sentiment_score, published_at)
    VALUES (@externalId, @source, @title, @url, @currencies, @sentimentScore, @publishedAt)
  `);
  return stmt.run(item);
}

export function insertNewsItemsBatch(items) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO news_items (external_id, source, title, url, currencies, sentiment_score, published_at)
    VALUES (@externalId, @source, @title, @url, @currencies, @sentimentScore, @publishedAt)
  `);
  const insertMany = getDb().transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(items);
}

export function getNewsItems({ ticker = null, hours = 24, limit = 50 } = {}) {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  if (ticker) {
    const currency = ticker.replace(/USD$/, '');
    return getDb().prepare(
      "SELECT * FROM news_items WHERE currencies LIKE ? AND created_at > ? ORDER BY published_at DESC LIMIT ?"
    ).all(`%${currency}%`, cutoff, limit);
  }
  return getDb().prepare(
    'SELECT * FROM news_items WHERE created_at > ? ORDER BY published_at DESC LIMIT ?'
  ).all(cutoff, limit);
}

// --- ML Features ---
export function insertMLFeatures(features) {
  const stmt = getDb().prepare(`
    INSERT INTO ml_features (ticker, timestamp, features_json, label, label_value, labeled_at)
    VALUES (@ticker, @timestamp, @featuresJson, @label, @labelValue, @labeledAt)
  `);
  return stmt.run(features);
}

export function getUnlabeledFeatures(limit = 1000) {
  return getDb().prepare(
    'SELECT * FROM ml_features WHERE label IS NULL ORDER BY timestamp ASC LIMIT ?'
  ).all(limit);
}

export function getLabeledFeatures(limit = 5000) {
  return getDb().prepare(
    'SELECT * FROM ml_features WHERE label IS NOT NULL ORDER BY timestamp DESC LIMIT ?'
  ).all(limit);
}

export function labelMLFeatures(id, label, labelValue) {
  return getDb().prepare(
    'UPDATE ml_features SET label = ?, label_value = ?, labeled_at = ? WHERE id = ?'
  ).run(label, labelValue, Date.now(), id);
}

// --- ML Models ---
export function insertMLModel(model) {
  const stmt = getDb().prepare(`
    INSERT INTO ml_models (model_type, model_data, accuracy, precision_score, recall, f1_score, sample_count, feature_importance_json, config_json)
    VALUES (@modelType, @modelData, @accuracy, @precisionScore, @recall, @f1Score, @sampleCount, @featureImportanceJson, @configJson)
  `);
  return stmt.run(model);
}

export function getLatestMLModel(modelType = null) {
  if (modelType) {
    return getDb().prepare(
      'SELECT * FROM ml_models WHERE model_type = ? ORDER BY created_at DESC LIMIT 1'
    ).get(modelType);
  }
  return getDb().prepare(
    'SELECT * FROM ml_models ORDER BY created_at DESC LIMIT 1'
  ).get();
}

export function getMLModelHistory(limit = 20) {
  return getDb().prepare(
    'SELECT id, model_type, accuracy, precision_score, recall, f1_score, sample_count, created_at FROM ml_models ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

// --- ML Predictions ---
export function insertMLPrediction(pred) {
  const stmt = getDb().prepare(`
    INSERT INTO ml_predictions (ticker, model_id, prediction, confidence, features_snapshot, timestamp)
    VALUES (@ticker, @modelId, @prediction, @confidence, @featuresSnapshot, @timestamp)
  `);
  return stmt.run(pred);
}

export function resolveMLPrediction(id, actualOutcome, wasCorrect) {
  return getDb().prepare(
    'UPDATE ml_predictions SET actual_outcome = ?, was_correct = ?, resolved_at = ? WHERE id = ?'
  ).run(actualOutcome, wasCorrect ? 1 : 0, Date.now(), id);
}

export function getMLPredictions({ ticker = null, limit = 100, unresolvedOnly = false } = {}) {
  let query = 'SELECT * FROM ml_predictions WHERE 1=1';
  const params = [];
  if (ticker) { query += ' AND ticker = ?'; params.push(ticker); }
  if (unresolvedOnly) { query += ' AND actual_outcome IS NULL'; }
  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(query).all(...params);
}

export function getMLAccuracyStats() {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) as correct,
      AVG(confidence) as avg_confidence,
      ROUND(CAST(SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(CASE WHEN was_correct IS NOT NULL THEN 1 END), 0) * 100, 2) as accuracy_pct
    FROM ml_predictions WHERE actual_outcome IS NOT NULL
  `).get();
}

// --- Cleanup old data ---
export function cleanupOldData(daysToKeep = 30) {
  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  const results = {};
  results.exchangeSnapshots = getDb().prepare('DELETE FROM exchange_snapshots WHERE timestamp < ?').run(cutoff).changes;
  results.derivativesData = getDb().prepare('DELETE FROM derivatives_data WHERE timestamp < ?').run(cutoff).changes;
  results.defiSnapshots = getDb().prepare('DELETE FROM defi_snapshots WHERE timestamp < ?').run(cutoff).changes;
  results.newsItems = getDb().prepare('DELETE FROM news_items WHERE created_at < ?').run(cutoff).changes;
  results.mlFeatures = getDb().prepare('DELETE FROM ml_features WHERE created_at < ?').run(cutoff).changes;
  results.mlPredictions = getDb().prepare('DELETE FROM ml_predictions WHERE timestamp < ?').run(cutoff).changes;
  results.equitySnapshots = getDb().prepare('DELETE FROM equity_snapshots WHERE time < ?').run(cutoff).changes;
  results.sessionTrades = getDb().prepare('DELETE FROM session_trades WHERE time < ?').run(cutoff).changes;
  results.mlThoughts = getDb().prepare('DELETE FROM ml_thoughts WHERE time < ?').run(cutoff).changes;
  console.log(`[Database] Cleanup: removed old data older than ${daysToKeep} days`, results);
  return results;
}

// --- Equity Snapshots ---
export function insertEquitySnapshot(snapshot) {
  return getDb().prepare(`
    INSERT INTO equity_snapshots (session_id, time, total_value, cash, holdings_value, open_positions, pnl_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(snapshot.session_id, snapshot.time, snapshot.total_value, snapshot.cash,
         snapshot.holdings_value, snapshot.open_positions, snapshot.pnl_percent);
}

export function getEquitySnapshots(sessionId, limit = 500) {
  return getDb().prepare(`
    SELECT * FROM equity_snapshots WHERE session_id = ? ORDER BY time ASC LIMIT ?
  `).all(sessionId, limit);
}

export function getLatestEquitySnapshot(sessionId) {
  return getDb().prepare(`
    SELECT * FROM equity_snapshots WHERE session_id = ? ORDER BY time DESC LIMIT 1
  `).get(sessionId);
}

// --- Session Trades ---
export function insertSessionTrade(trade) {
  return getDb().prepare(`
    INSERT INTO session_trades (session_id, time, type, ticker, price, quantity, notional, strategy, reason, pnl, fee, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trade.session_id, trade.time, trade.type, trade.ticker, trade.price, trade.quantity,
         trade.notional || 0, trade.strategy || '', trade.reason || '', trade.pnl || 0,
         trade.fee || 0, trade.balance_after || 0);
}

export function getSessionTrades(sessionId, limit = 500) {
  return getDb().prepare(`
    SELECT * FROM session_trades WHERE session_id = ? ORDER BY time DESC LIMIT ?
  `).all(sessionId, limit);
}

export function getSessionTradeStats(sessionId) {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN type = 'BUY' THEN 1 ELSE 0 END) as buys,
      SUM(CASE WHEN type = 'SELL' THEN 1 ELSE 0 END) as sells,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl,
      AVG(CASE WHEN pnl != 0 THEN pnl ELSE NULL END) as avg_pnl,
      MAX(pnl) as best_trade,
      MIN(pnl) as worst_trade,
      SUM(fee) as total_fees
    FROM session_trades WHERE session_id = ? AND type = 'SELL'
  `).get(sessionId);
}

// --- ML Thoughts ---
export function insertMLThought(thought) {
  return getDb().prepare(`
    INSERT INTO ml_thoughts (session_id, time, type, ticker, action, confidence, reason, indicators, feature_importance, regime, market_speed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(thought.session_id || '', thought.time || Date.now(), thought.type, thought.ticker || '',
         thought.action || '', thought.confidence || 0, thought.reason || '',
         JSON.stringify(thought.indicators || {}), JSON.stringify(thought.feature_importance || {}),
         thought.regime || '', thought.market_speed || '');
}

export function getMLThoughts(sessionId, limit = 200) {
  return getDb().prepare(`
    SELECT * FROM ml_thoughts WHERE session_id = ? ORDER BY time DESC LIMIT ?
  `).all(sessionId || '', limit);
}
