/**
 * Portfolio Manager (Backend)
 *
 * Unifies multi-strategy allocation, compounding, and risk management.
 * Provides high-level portfolio oversight and rebalancing logic.
 *
 * Requirements 14, 19, 20
 */

import * as AdaptiveWeights from './adaptiveWeights.js';
import * as BeastMode from './beastMode.js';
import * as CapitalTierManager from './capitalTierManager.js';

/**
 * Get current portfolio status and optimization recommendations
 * @param {number} totalValue
 * @param {number} cash
 */
export function getPortfolioStatus(totalValue, cash) {
  const tier = CapitalTierManager.getTier(totalValue);
  const weights = AdaptiveWeights.getAllWeights();
  const beast = BeastMode.getBeastModeStatus();
  
  return {
    totalValue: Math.round(totalValue * 100) / 100,
    cash: Math.round(cash * 100) / 100,
    capitalTier: tier.name,
    tierDescription: tier.description,
    strategyWeights: weights,
    compounding: beast.compounding,
    limits: {
      maxConcurrentTrades: tier.maxConcurrentTrades,
      maxPositionSizePercent: tier.maxPositionSizePercent * 100,
      maxDrawdownLimit: tier.maxDrawdownLimit
    },
    performance: beast.streak,
    lastUpdated: Date.now()
  };
}

/**
 * Record a trade result across all management systems
 * @param {number} pnl - Profit/Loss in USD
 * @param {string} strategy
 * @param {string} ticker
 */
export function recordTradeResult(pnl, strategy, ticker) {
  AdaptiveWeights.recordStrategyResult(strategy, pnl);
  BeastMode.recordTradeResult(pnl, ticker, strategy);
}

/**
 * Calculate recommended investment for a new trade
 * @param {string} strategy
 * @param {number} totalValue
 * @param {number} cash
 * @param {number} riskAmount (0..1)
 */
export function calculateRecommendedInvestment(strategy, totalValue, cash, riskAmount) {
    // 1. Base allocation from risk amount
    let amount = (totalValue * riskAmount);
    
    // 2. Adjust by adaptive strategy weight
    amount = AdaptiveWeights.adjustPositionSize(strategy, amount, totalValue);
    
    // 3. Adjust by beast mode compounding multiplier
    const compound = BeastMode.getCompoundMultiplier();
    amount *= compound.multiplier;
    
    // 4. Enforce capital tier limits
    amount = CapitalTierManager.getRecommendedPositionSize(totalValue, amount);
    
    // 5. Final cash check
    return Math.min(amount, cash * 0.95);
}
