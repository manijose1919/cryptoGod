/**
 * Regime-Aware Strategy Switching
 * Maps market regimes to enabled strategies for smarter entry filtering.
 */

const REGIME_STRATEGY_MAP = {
  UPTREND:  ['TREND', 'MOMENTUM', 'BREAKOUT', 'MA_CROSSOVER', 'ADAPTIVE', 'CONFLUENCE'],
  SIDEWAYS: ['RANGE', 'MEAN_REVERSION', 'BREAKOUT', 'ADAPTIVE', 'CONFLUENCE'],
  DOWNTREND: ['REVERSAL', 'MEAN_REVERSION', 'DIVERGENCE', 'ADAPTIVE'],
  VOLATILE: ['BREAKOUT', 'MOMENTUM', 'ADAPTIVE', 'DIVERGENCE'],
  UNKNOWN:  ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'],
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
