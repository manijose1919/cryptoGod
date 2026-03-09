/**
 * Regime-Aware Strategy Switching
 * Maps market regimes to enabled strategies for smarter entry filtering.
 */

// TREND is the only validated profitable strategy (walk-forward backtesting).
// Allow TREND in SIDEWAYS too — otherwise the bot sits idle for days/weeks
// in choppy markets, generating zero data and zero profits.
// Higher score floors in SIDEWAYS compensate for the weaker signals.
const REGIME_STRATEGY_MAP = {
  UPTREND:    ['TREND'],
  SIDEWAYS:   ['TREND'],  // Allow TREND with high-conviction signals
  DOWNTREND:  ['TREND'],  // Allow TREND for counter-trend bounces (strict filters apply)
  VOLATILE:   ['TREND'],  // Allow TREND — volatility = opportunity if managed
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
