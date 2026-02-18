/**
 * ML Thought Logger
 * Ring buffer of last 200 ML decisions for transparency dashboard.
 * Logs every scan, entry, exit, and skip decision with full reasoning.
 */

import { insertMLThought, getMLThoughts as getMLThoughtsDB } from './database.js';

const MAX_THOUGHTS = 200;
let thoughts = [];
let currentFocus = null;
let sessionId = null;

/**
 * Set the active session ID for logging.
 */
export function setSessionId(id) {
  sessionId = id;
}

/**
 * Log a thought (decision point) from the bot loop.
 * @param {Object} thought
 * @param {string} thought.type - SCAN | BUY | SELL | SKIP | EXIT | ENTRY_EVAL | REGIME
 * @param {string} thought.ticker - Asset being evaluated
 * @param {string} thought.action - What happened (e.g., 'ENTERED_LONG', 'SKIPPED_LOW_CONFIDENCE')
 * @param {number} thought.confidence - Confidence score (0-100)
 * @param {string} thought.reason - Human-readable explanation
 * @param {Object} thought.indicators - Key indicator values at decision time
 * @param {Object} thought.feature_importance - Top features driving decision
 * @param {string} thought.regime - Market regime (UPTREND, SIDEWAYS, DOWNTREND)
 * @param {string} thought.market_speed - SLOW or FAST
 */
export function logThought(thought) {
  const entry = {
    id: Date.now() + Math.random(),
    time: Date.now(),
    session_id: sessionId,
    ...thought,
  };

  thoughts.unshift(entry);
  if (thoughts.length > MAX_THOUGHTS) {
    thoughts = thoughts.slice(0, MAX_THOUGHTS);
  }

  // Update current focus if it's a SCAN or BUY type
  if (thought.type === 'SCAN' || thought.type === 'BUY' || thought.type === 'ENTRY_EVAL') {
    currentFocus = {
      ticker: thought.ticker,
      type: thought.type,
      confidence: thought.confidence,
      regime: thought.regime,
      time: Date.now(),
    };
  }

  // Persist to DB (async, don't block)
  try {
    insertMLThought(entry);
  } catch (e) {
    // Don't let DB errors affect trading
  }
}

/**
 * Get recent thoughts (most recent first).
 */
export function getThoughts(limit = 50) {
  return thoughts.slice(0, limit);
}

/**
 * Get what the bot is currently focused on.
 */
export function getCurrentFocus() {
  return currentFocus;
}

/**
 * Get thought statistics for the current session.
 */
export function getThoughtStats() {
  const buys = thoughts.filter(t => t.type === 'BUY').length;
  const sells = thoughts.filter(t => t.type === 'SELL' || t.type === 'EXIT').length;
  const skips = thoughts.filter(t => t.type === 'SKIP').length;
  const scans = thoughts.filter(t => t.type === 'SCAN').length;

  const avgConfidence = thoughts.length > 0
    ? thoughts.reduce((sum, t) => sum + (t.confidence || 0), 0) / thoughts.length
    : 0;

  // Top reasons for skipping
  const skipReasons = {};
  thoughts.filter(t => t.type === 'SKIP').forEach(t => {
    const reason = t.reason || 'unknown';
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  });

  return {
    total: thoughts.length,
    buys,
    sells,
    skips,
    scans,
    avgConfidence: avgConfidence.toFixed(1),
    topSkipReasons: Object.entries(skipReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Clear all thoughts (used on session reset).
 */
export function clearThoughts() {
  thoughts = [];
  currentFocus = null;
}

/**
 * Restore thoughts from database.
 */
export function restoreThoughts(sid) {
  try {
    if (sid) sessionId = sid;
    const dbThoughts = getMLThoughtsDB(sessionId, MAX_THOUGHTS);
    if (dbThoughts && dbThoughts.length > 0) {
      thoughts = dbThoughts.map(t => ({
        ...t,
        indicators: typeof t.indicators === 'string' ? JSON.parse(t.indicators) : t.indicators,
        feature_importance: typeof t.feature_importance === 'string' ? JSON.parse(t.feature_importance) : t.feature_importance,
      }));
    }
  } catch (e) {
    console.warn('[MLThoughtLogger] Restore failed:', e.message);
  }
}

export default {
  setSessionId, logThought, getThoughts, getCurrentFocus,
  getThoughtStats, clearThoughts, restoreThoughts,
};
