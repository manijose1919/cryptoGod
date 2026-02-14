/**
 * Asset Intelligence Backend Service
 *
 * Ported from assetIntelligenceService.ts for backend use.
 * Contains asset profiles, strategy-asset matching,
 * and liquidity-based position sizing.
 *
 * Pure data + logic, no external deps.
 */

// ============================================
// ASSET PROFILES DATABASE
// ============================================
const ASSET_PROFILES = {
  'BTCUSD': {
    symbol: 'BTCUSD', name: 'Bitcoin', category: 'MAJOR',
    volatility: {
      '15min': [0.2, 0.5], '30min': [0.5, 1], '1h': [1, 2], '2h': [1.5, 3],
      '3h': [2, 4], '6h': [3, 5], '12h': [4, 7], '24h': [5, 10], '1wk': [15, 25]
    },
    liquidity: 'VERY_HIGH', bestStrategies: ['WHALE', 'TREND', 'CONFLUENCE', 'ADAPTIVE'],
    riskLevel: 'LOW', slippageRisk: 'MINIMAL'
  },
  'ETHUSD': {
    symbol: 'ETHUSD', name: 'Ethereum', category: 'MAJOR',
    volatility: {
      '15min': [0.3, 0.7], '30min': [0.7, 1.2], '1h': [1, 2.5], '2h': [1.5, 3],
      '3h': [2, 4], '6h': [3, 5], '12h': [4, 7], '24h': [6, 10], '1wk': [15, 20]
    },
    liquidity: 'VERY_HIGH', bestStrategies: ['TREND', 'WHALE', 'CONFLUENCE', 'ADAPTIVE'],
    riskLevel: 'LOW', slippageRisk: 'MINIMAL'
  },
  'SOLUSD': {
    symbol: 'SOLUSD', name: 'Solana', category: 'ALTCOIN',
    volatility: {
      '15min': [0.5, 1], '30min': [1, 2], '1h': [2, 4], '2h': [3, 5],
      '3h': [4, 6], '6h': [5, 8], '12h': [7, 10], '24h': [10, 15], '1wk': [20, 30]
    },
    liquidity: 'HIGH', bestStrategies: ['TREND', 'MOMENTUM', 'BREAKOUT', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'XRPUSD': {
    symbol: 'XRPUSD', name: 'Ripple', category: 'ALTCOIN',
    volatility: {
      '15min': [0.4, 0.8], '30min': [0.8, 1.5], '1h': [1.5, 3], '2h': [2, 4],
      '3h': [3, 5], '6h': [4, 7], '12h': [6, 9], '24h': [8, 12], '1wk': [15, 25]
    },
    liquidity: 'HIGH', bestStrategies: ['TREND', 'WHALE', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'BNBUSD': {
    symbol: 'BNBUSD', name: 'BNB', category: 'ALTCOIN',
    volatility: {
      '15min': [0.4, 0.8], '30min': [0.8, 1.4], '1h': [1.2, 2.5], '2h': [1.8, 3.5],
      '3h': [2.5, 4], '6h': [3, 6], '12h': [5, 8], '24h': [7, 12], '1wk': [18, 25]
    },
    liquidity: 'HIGH', bestStrategies: ['TREND', 'WHALE', 'CONFLUENCE', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'ADAUSD': {
    symbol: 'ADAUSD', name: 'Cardano', category: 'ALTCOIN',
    volatility: {
      '15min': [0.3, 0.7], '30min': [0.7, 1.3], '1h': [1, 2.5], '2h': [1.5, 3],
      '3h': [2, 4], '6h': [3, 5], '12h': [4, 7], '24h': [6, 10], '1wk': [15, 22]
    },
    liquidity: 'HIGH', bestStrategies: ['TREND', 'CONFLUENCE', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'AVAXUSD': {
    symbol: 'AVAXUSD', name: 'Avalanche', category: 'ALTCOIN',
    volatility: {
      '15min': [0.5, 1], '30min': [1, 1.8], '1h': [1.5, 3], '2h': [2, 4],
      '3h': [3, 5], '6h': [4, 7], '12h': [6, 9], '24h': [8, 13], '1wk': [20, 30]
    },
    liquidity: 'MEDIUM_HIGH', bestStrategies: ['TREND', 'MOMENTUM', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'LINKUSD': {
    symbol: 'LINKUSD', name: 'Chainlink', category: 'DEFI',
    volatility: {
      '15min': [0.5, 1], '30min': [1, 1.7], '1h': [1.5, 3], '2h': [2, 3.5],
      '3h': [2.5, 4.5], '6h': [3.5, 6], '12h': [5, 8], '24h': [7, 12], '1wk': [18, 28]
    },
    liquidity: 'MEDIUM_HIGH', bestStrategies: ['TREND', 'CONFLUENCE', 'WHALE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'DOTUSD': {
    symbol: 'DOTUSD', name: 'Polkadot', category: 'ALTCOIN',
    volatility: {
      '15min': [0.5, 1], '30min': [1, 1.8], '1h': [1.5, 3], '2h': [2, 4],
      '3h': [3, 5], '6h': [4, 7], '12h': [6, 9], '24h': [8, 13], '1wk': [20, 30]
    },
    liquidity: 'MEDIUM_HIGH', bestStrategies: ['TREND', 'CONFLUENCE', 'ADAPTIVE'],
    riskLevel: 'MEDIUM', slippageRisk: 'LOW'
  },
  'DOGEUSD': {
    symbol: 'DOGEUSD', name: 'Dogecoin', category: 'MEME',
    volatility: {
      '15min': [0.5, 1.5], '30min': [1, 2.5], '1h': [2, 4], '2h': [3, 5],
      '3h': [4, 6], '6h': [5, 8], '12h': [6, 10], '24h': [8, 15], '1wk': [20, 30]
    },
    liquidity: 'HIGH', bestStrategies: ['BREAKOUT', 'MOMENTUM', 'DIVERGENCE'],
    riskLevel: 'HIGH', slippageRisk: 'LOW'
  }
};

// ============================================
// STRATEGY-ASSET PREFERENCES
// ============================================
const STRATEGY_ASSET_PREFERENCES = {
  TREND: { preferredCategories: ['MAJOR', 'ALTCOIN'], minLiquidity: 'HIGH', minHourlyRange: 1.5 },
  BREAKOUT: { preferredCategories: ['MEME', 'ALTCOIN'], minLiquidity: 'MEDIUM', minHourlyRange: 3.0 },
  WHALE: { preferredCategories: ['MAJOR', 'ALTCOIN'], minLiquidity: 'VERY_HIGH', minHourlyRange: 1.0 },
  CONFLUENCE: { preferredCategories: ['MAJOR', 'ALTCOIN', 'DEFI'], minLiquidity: 'HIGH', minHourlyRange: 1.5 },
  MOMENTUM: { preferredCategories: ['MEME', 'ALTCOIN'], minLiquidity: 'MEDIUM', minHourlyRange: 2.5 },
  DIVERGENCE: { preferredCategories: ['MEME', 'ALTCOIN'], minLiquidity: 'MEDIUM', minHourlyRange: 2.0 },
  ADAPTIVE: { preferredCategories: ['MAJOR', 'ALTCOIN', 'DEFI'], minLiquidity: 'MEDIUM_HIGH', minHourlyRange: 1.5 },
};

const LIQUIDITY_RANK = {
  'VERY_HIGH': 6, 'HIGH': 5, 'MEDIUM_HIGH': 4, 'MEDIUM': 3, 'LOW_MEDIUM': 2, 'LOW': 1
};

// ============================================
// FUNCTIONS
// ============================================

/**
 * Get asset profile
 * @param {string} ticker
 * @returns {object|null}
 */
export function getAssetProfile(ticker) {
  return ASSET_PROFILES[ticker] || null;
}

/**
 * Score how well a strategy matches an asset (0-100)
 * @param {string} strategy
 * @param {string} ticker
 * @returns {number}
 */
export function getStrategyAssetMatch(strategy, ticker) {
  const profile = ASSET_PROFILES[ticker];
  const prefs = STRATEGY_ASSET_PREFERENCES[strategy];
  if (!profile || !prefs) return 50; // Unknown = neutral

  let score = 50;

  // Best strategy match
  if (profile.bestStrategies.includes(strategy)) score += 25;

  // Category match
  if (prefs.preferredCategories.includes(profile.category)) score += 15;

  // Liquidity match
  const minRank = LIQUIDITY_RANK[prefs.minLiquidity] || 3;
  const assetRank = LIQUIDITY_RANK[profile.liquidity] || 3;
  if (assetRank >= minRank) score += 10;
  else score -= 15;

  // Volatility match
  const hourlyVol = (profile.volatility['1h'][0] + profile.volatility['1h'][1]) / 2;
  if (hourlyVol >= prefs.minHourlyRange) score += 10;
  else score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Get the best strategy for an asset (ordered list)
 * @param {string} ticker
 * @returns {string[]}
 */
export function getBestStrategyForAsset(ticker) {
  const profile = ASSET_PROFILES[ticker];
  if (!profile) return ['TREND']; // Default fallback
  return profile.bestStrategies;
}

/**
 * Position size multiplier based on asset liquidity
 * @param {string} ticker
 * @param {number} baseAmount
 * @returns {{ amount: number, multiplier: number }}
 */
export function getPositionSizeForLiquidity(ticker, baseAmount) {
  const profile = ASSET_PROFILES[ticker];
  if (!profile) return { amount: baseAmount * 0.5, multiplier: 0.5 };

  let multiplier;
  switch (profile.liquidity) {
    case 'VERY_HIGH': multiplier = 1.2; break;
    case 'HIGH': multiplier = 1.0; break;
    case 'MEDIUM_HIGH': multiplier = 0.8; break;
    case 'MEDIUM': multiplier = 0.6; break;
    case 'LOW_MEDIUM': multiplier = 0.4; break;
    case 'LOW': multiplier = 0.2; break;
    default: multiplier = 0.5;
  }

  return { amount: baseAmount * multiplier, multiplier };
}

/**
 * Get risk-adjusted parameters for an asset
 * @param {string} ticker
 * @returns {{ stopLossMultiplier, profitTargetMultiplier, positionSizeMultiplier, confidenceBoost }}
 */
export function getRiskAdjustedParams(ticker) {
  const profile = ASSET_PROFILES[ticker];
  if (!profile) {
    return { stopLossMultiplier: 1, profitTargetMultiplier: 1, positionSizeMultiplier: 0.5, confidenceBoost: 0 };
  }

  const hourlyVol = (profile.volatility['1h'][0] + profile.volatility['1h'][1]) / 2;

  return {
    stopLossMultiplier: Math.max(0.5, Math.min(2, hourlyVol / 2)),
    profitTargetMultiplier: Math.max(0.5, Math.min(2.5, hourlyVol / 1.5)),
    positionSizeMultiplier: getPositionSizeForLiquidity(ticker, 1).multiplier,
    confidenceBoost: profile.category === 'MAJOR' ? 10 : profile.category === 'MEME' ? -5 : 0
  };
}
