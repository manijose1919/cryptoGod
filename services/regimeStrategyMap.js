/**
 * Regime-Aware Strategy Switching
 * Maps market regimes to enabled strategies for smarter entry filtering.
 */

// LOCKED: Only TREND is profitable — validated via walk-forward backtesting
// All other strategies lose money. Do NOT re-enable without OOS proof.
const REGIME_STRATEGY_MAP = {
  UPTREND:    ['TREND'],
  SIDEWAYS:   [],  // Sit out — no profitable strategy
  DOWNTREND:  [],  // Sit out — short selling TBD
  VOLATILE:   [],  // Sit out
  UNKNOWN:    ['TREND'],  // Default to TREND only
};

/**
 * Check if a strategy is suitable for the current market regime.
 * @param {string} strategy - e.g. 'TREND', 'BREAKOUT'
 * @param {string} regime - e.g. 'UPTREND', 'SIDEWAYS', 'DOWNTREND'
 * @returns {boolean}
 */
export function isStrategyEnabledForRegime(strategy, regime) {
  const normalizedRegime = (regime || 'UNKNOWN').toUpperCase();
  const allowed = REGIME_STRATEGY_MAP[normalizedRegime] || REGIME_STRATEGY_MAP.UNKNOWN;
  return allowed.includes(strategy);
}

/**
 * Get the list of strategies enabled for a given regime.
 * @param {string} regime
 * @returns {string[]}
 */
export function getStrategiesForRegime(regime) {
  const normalizedRegime = (regime || 'UNKNOWN').toUpperCase();
  return REGIME_STRATEGY_MAP[normalizedRegime] || REGIME_STRATEGY_MAP.UNKNOWN;
}

/**
 * Filter a list of candidate strategies to only those suitable for the current regime.
 * @param {string[]} candidates
 * @param {string} regime
 * @returns {string[]}
 */
export function filterStrategiesByRegime(candidates, regime) {
  return candidates.filter(s => isStrategyEnabledForRegime(s, regime));
}

export default { isStrategyEnabledForRegime, getStrategiesForRegime, filterStrategiesByRegime };
