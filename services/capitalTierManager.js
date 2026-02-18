/**
 * Capital Tier Manager (Backend)
 *
 * Classifies capital into MICRO, SMALL, MEDIUM, and LARGE tiers
 * and enforces strategy availability and risk limits based on the tier.
 *
 * Requirements 1-4, Property 1, Property 6
 */

export const TIERS = {
  MICRO: {
    name: 'MICRO',
    min: 1,
    max: 100,
    strategies: ['DCA', 'TREND', 'BREAKOUT', 'WHALE', 'MOMENTUM', 'ADAPTIVE', 'CONFLUENCE', 'DIVERGENCE'],
    maxConcurrentTrades: 3,
    maxPositionSizePercent: 1.0, // 100% allowed
    maxDrawdownLimit: 25,
    description: 'Fractional purchases, micro-trades, DCA'
  },
  SMALL: {
    name: 'SMALL',
    min: 100,
    max: 1000,
    strategies: ['GRID', 'DCA', 'SWING', 'TREND', 'BREAKOUT', 'WHALE', 'MOMENTUM', 'ADAPTIVE', 'CONFLUENCE', 'DIVERGENCE'],
    maxConcurrentTrades: 5,
    maxPositionSizePercent: 0.5, // 50% max
    maxDrawdownLimit: 20,
    description: 'Grid trading, 2-5 strategies, swing trading'
  },
  MEDIUM: {
    name: 'MEDIUM',
    min: 1000,
    max: 10000,
    strategies: ['GRID', 'DCA', 'SWING', 'MM', 'PAIR_LONG', 'TREND', 'BREAKOUT', 'WHALE', 'MOMENTUM', 'ADAPTIVE', 'CONFLUENCE', 'DIVERGENCE'],
    maxConcurrentTrades: 10,
    maxPositionSizePercent: 0.15, // 15% max (was 25%, reduced to prevent oversized trades)
    maxDrawdownLimit: 30,         // was 15%, too tight for simulation (halted trading at 15%)
    description: 'Market making, pair trading, 5-10 strategies'
  },
  LARGE: {
    name: 'LARGE',
    min: 10000,
    max: Infinity,
    strategies: ['GRID', 'DCA', 'SWING', 'MM', 'PAIR_LONG', 'ARB', 'TREND', 'BREAKOUT', 'WHALE', 'MOMENTUM', 'ADAPTIVE', 'CONFLUENCE', 'DIVERGENCE'],
    maxConcurrentTrades: 20,
    maxPositionSizePercent: 0.15, // 15% max
    maxDrawdownLimit: 10,
    description: 'Institutional arbitrage, 10+ strategies'
  }
};

/**
 * Get tier based on capital amount
 */
export function getTier(capital) {
  if (capital < TIERS.SMALL.min) return TIERS.MICRO;
  if (capital < TIERS.MEDIUM.min) return TIERS.SMALL;
  if (capital < TIERS.LARGE.min) return TIERS.MEDIUM;
  return TIERS.LARGE;
}

/**
 * Check if a strategy is allowed for a given capital amount
 */
export function isStrategyAllowed(strategy, capital) {
  const tier = getTier(capital);
  // Support prefixes like [GRID] or strategy names like GRID
  const cleanStrategy = strategy.replace('[', '').replace(']', '').split(' ')[0].toUpperCase();
  return tier.strategies.includes(cleanStrategy) || tier.strategies.includes(strategy);
}

/**
 * Get recommended position size based on capital tier
 */
export function getRecommendedPositionSize(capital, requestedSize) {
  const tier = getTier(capital);
  const maxSize = capital * tier.maxPositionSizePercent;
  return Math.min(requestedSize, maxSize);
}

/**
 * Get capital tier metrics and status
 */
export function getCapitalTierStatus(capital) {
  const tier = getTier(capital);
  return {
    currentTier: tier.name,
    description: tier.description,
    allowedStrategies: tier.strategies,
    limits: {
      maxConcurrentTrades: tier.maxConcurrentTrades,
      maxPositionSizePercent: tier.maxPositionSizePercent * 100,
      maxDrawdownLimit: tier.maxDrawdownLimit
    }
  };
}
