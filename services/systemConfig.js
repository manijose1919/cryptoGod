/**
 * System Configuration Service
 * Feature flags + central config for the 4-layer ML pipeline.
 * Persisted to SQLite settings table with runtime toggling.
 */

import { getSetting, setSetting } from './database.js';

// Default flags — used when no persisted value exists
const DEFAULT_FLAGS = {
  // System A: ML Gatekeeper
  ML_GATEKEEPER_ENABLED: true,
  ML_GATEKEEPER_MODE: 'SOFT_GATE',       // 'ADVISORY' | 'SOFT_GATE' | 'HARD_GATE'
  ML_MIN_CONFIDENCE_TO_BLOCK: 60,
  ML_MIN_CONFIDENCE_TO_OVERRIDE: 75,
  ML_AUTO_DOWNGRADE_THRESHOLD: 0.52,      // revert to ADVISORY if accuracy < 52%
  ML_AUTO_DOWNGRADE_WINDOW: 100,          // over last 100 trades

  // System B: Genetic Strategy Evolution
  GENETIC_ENABLED: false,                 // off until validated in walk-forward
  GENETIC_POPULATION_SIZE: 50,
  GENETIC_MAX_DEPTH: 4,
  GENETIC_MIN_TRADES_TO_ACTIVATE: 200,
  GENETIC_MUTATION_RATE: 0.10,
  GENETIC_ELITISM_COUNT: 5,
  GENETIC_TOP_K_SIGNALS: 5,

  // System C: Portfolio Correlation Engine
  CORRELATION_ENGINE_ENABLED: true,       // safe — only reduces sizes
  CORRELATION_BLOCK_THRESHOLD: 0.90,
  CORRELATION_REDUCE_THRESHOLD: 0.75,
  CORRELATION_MAX_CLUSTER_ALLOC: 0.40,
  CORRELATION_UPDATE_INTERVAL_MS: 300000,

  // System D: Adversarial Dual-Brain
  ADVERSARIAL_ENABLED: false,             // off until both models trained
  ADVERSARIAL_MIN_MARGIN: 15,
  ADVERSARIAL_MIN_SAMPLES: 200,
};

// In-memory cache of current flags (seeded from defaults, overwritten by DB on init)
let SYSTEM_FLAGS = { ...DEFAULT_FLAGS };
let initialized = false;

/**
 * Initialize: load persisted flags from SQLite settings table
 */
export function initSystemConfig() {
  if (initialized) return;

  try {
    const stored = getSetting('system_flags');
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge: defaults first, then stored overrides (so new flags get defaults)
      SYSTEM_FLAGS = { ...DEFAULT_FLAGS, ...parsed };
    }
    initialized = true;
    console.log('[SystemConfig] Initialized with flags:', Object.keys(SYSTEM_FLAGS).length, 'keys');
  } catch (e) {
    console.warn('[SystemConfig] Could not load persisted flags:', e.message);
    initialized = true;
  }
}

/**
 * Get a single flag value
 */
export function getFlag(name) {
  if (!initialized) initSystemConfig();
  return SYSTEM_FLAGS[name] !== undefined ? SYSTEM_FLAGS[name] : DEFAULT_FLAGS[name];
}

/**
 * Set a single flag value (persists to DB)
 */
export function setFlag(name, value) {
  if (!initialized) initSystemConfig();
  SYSTEM_FLAGS[name] = value;
  persistFlags();
  console.log(`[SystemConfig] Flag ${name} = ${JSON.stringify(value)}`);
}

/**
 * Get all current flags
 */
export function getAllFlags() {
  if (!initialized) initSystemConfig();
  return { ...SYSTEM_FLAGS };
}

/**
 * Set multiple flags at once
 */
export function setFlags(updates) {
  if (!initialized) initSystemConfig();
  for (const [key, value] of Object.entries(updates)) {
    if (key in DEFAULT_FLAGS) {
      SYSTEM_FLAGS[key] = value;
    }
  }
  persistFlags();
}

/**
 * Reset all flags to defaults
 */
export function resetToDefaults() {
  SYSTEM_FLAGS = { ...DEFAULT_FLAGS };
  persistFlags();
  console.log('[SystemConfig] Reset all flags to defaults');
}

/**
 * Global kill switch — disable all 4 systems
 */
export function killAll() {
  SYSTEM_FLAGS.ML_GATEKEEPER_ENABLED = false;
  SYSTEM_FLAGS.GENETIC_ENABLED = false;
  SYSTEM_FLAGS.CORRELATION_ENGINE_ENABLED = false;
  SYSTEM_FLAGS.ADVERSARIAL_ENABLED = false;
  persistFlags();
  console.log('[SystemConfig] KILL ALL — all 4 systems disabled');
}

/**
 * Persist current flags to SQLite
 */
function persistFlags() {
  try {
    setSetting('system_flags', JSON.stringify(SYSTEM_FLAGS));
  } catch (e) {
    console.warn('[SystemConfig] Could not persist flags:', e.message);
  }
}

/**
 * Convenience: check if a system is enabled
 */
export function isMLGatekeeperEnabled() { return getFlag('ML_GATEKEEPER_ENABLED'); }
export function isGeneticEnabled() { return getFlag('GENETIC_ENABLED'); }
export function isCorrelationEnabled() { return getFlag('CORRELATION_ENGINE_ENABLED'); }
export function isAdversarialEnabled() { return getFlag('ADVERSARIAL_ENABLED'); }

export { DEFAULT_FLAGS };
