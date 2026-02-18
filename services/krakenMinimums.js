/**
 * Kraken Minimum Order Sizes & Budget-Based Asset Filtering
 *
 * Based on Kraken's official minimum order sizes (as of 2025).
 * See: https://support.kraken.com/hc/en-us/articles/205893708-Minimum-order-size-volume-
 *
 * All values are in base currency (minQty) and approximate USD notional (minNotional).
 * minNotional is a convenience estimate and depends on current market prices;
 * the exchange enforces minQty, not minNotional.
 */

// ============================================
// MINIMUM ORDER SIZES PER PAIR
// ============================================

export const KRAKEN_MINIMUMS = {
    BTCUSD:  { minQty: 0.0001,  minNotional: 10.00 },
    ETHUSD:  { minQty: 0.004,   minNotional: 10.00 },
    XRPUSD:  { minQty: 10,      minNotional: 5.00  },
    SOLUSD:  { minQty: 0.02,    minNotional: 3.00  },
    ADAUSD:  { minQty: 10,      minNotional: 4.00  },
    DOGEUSD: { minQty: 30,      minNotional: 5.00  },
    LINKUSD: { minQty: 0.3,     minNotional: 5.00  },
    DOTUSD:  { minQty: 0.5,     minNotional: 3.00  },
    AVAXUSD: { minQty: 0.1,     minNotional: 3.00  },
    BNBUSD:  { minQty: 0.01,    minNotional: 6.00  },
};

// All supported tickers in order of typical price (cheapest first)
const ALL_TICKERS = Object.keys(KRAKEN_MINIMUMS);

// ============================================
// getMinimumOrder(ticker)
// ============================================
/**
 * Returns the minimum order requirements for a given ticker.
 * Falls back to a conservative default if the ticker is unknown.
 *
 * @param {string} ticker - e.g. "BTCUSD", "ETHUSD"
 * @returns {{ minQty: number, minNotional: number }}
 */
export function getMinimumOrder(ticker) {
    const normalized = ticker.replace(/[_\/\-]/g, '').toUpperCase();

    if (KRAKEN_MINIMUMS[normalized]) {
        return { ...KRAKEN_MINIMUMS[normalized] };
    }

    // Try matching just the base currency (e.g., "BTC" matches "BTCUSD")
    for (const [key, value] of Object.entries(KRAKEN_MINIMUMS)) {
        if (key.startsWith(normalized) || normalized.startsWith(key.replace('USD', ''))) {
            return { ...value };
        }
    }

    // Conservative default for unknown pairs
    return { minQty: 1, minNotional: 10.00 };
}

// ============================================
// getTradeableAssetsForBudget(budget, currentPrices)
// ============================================
/**
 * Filters the supported assets to only those the given budget
 * can afford at least one minimum order for.
 *
 * @param {number} budget - Available USD to trade with
 * @param {Record<string, number>} currentPrices - Map of ticker -> current USD price
 *        e.g. { BTCUSD: 97000, ETHUSD: 2600, ... }
 * @returns {Array<{ ticker: string, minQty: number, minCostUSD: number, affordable: boolean }>}
 */
export function getTradeableAssetsForBudget(budget, currentPrices) {
    const results = [];

    for (const [ticker, minimums] of Object.entries(KRAKEN_MINIMUMS)) {
        const price = currentPrices[ticker] || currentPrices[ticker.replace('USD', '')] || 0;
        if (price <= 0) continue;

        const minCostUSD = minimums.minQty * price;
        const affordable = budget >= minCostUSD;

        results.push({
            ticker,
            minQty: minimums.minQty,
            minCostUSD: Math.round(minCostUSD * 100) / 100,
            affordable,
        });
    }

    // Sort by minCostUSD ascending so cheapest assets come first
    results.sort((a, b) => a.minCostUSD - b.minCostUSD);

    return results.filter(r => r.affordable);
}

// ============================================
// Budget Tier Definitions
// ============================================
const BUDGET_TIERS = [
    {
        name: 'micro',
        minBudget: 1,
        maxBudget: 50,
        maxConcurrent: 3,
        tickers: ['XRPUSD', 'ADAUSD', 'DOGEUSD'],
        description: 'Micro account - focus on cheapest assets only',
    },
    {
        name: 'small',
        minBudget: 50,
        maxBudget: 200,
        maxConcurrent: 4,
        tickers: ['XRPUSD', 'ADAUSD', 'DOGEUSD', 'SOLUSD', 'LINKUSD', 'DOTUSD'],
        description: 'Small account - low-price alts with decent liquidity',
    },
    {
        name: 'medium',
        minBudget: 200,
        maxBudget: 1000,
        maxConcurrent: 5,
        tickers: ['XRPUSD', 'ADAUSD', 'DOGEUSD', 'SOLUSD', 'LINKUSD', 'DOTUSD', 'ETHUSD', 'AVAXUSD'],
        description: 'Medium account - can add ETH and mid-caps',
    },
    {
        name: 'standard',
        minBudget: 1000,
        maxBudget: Infinity,
        maxConcurrent: 10,
        tickers: ALL_TICKERS,
        description: 'Standard account - all assets including BTC',
    },
];

// ============================================
// getRecommendedAssetsForTier(budget)
// ============================================
/**
 * Returns recommended assets and concurrency limits based on budget tier.
 *
 * @param {number} budget - Total available USD
 * @returns {{
 *   tier: string,
 *   description: string,
 *   maxConcurrent: number,
 *   recommendedTickers: string[],
 *   budget: number
 * }}
 */
export function getRecommendedAssetsForTier(budget) {
    // Find the matching tier (tiers are ordered from smallest to largest)
    let matchedTier = BUDGET_TIERS[BUDGET_TIERS.length - 1]; // default to standard

    for (const tier of BUDGET_TIERS) {
        if (budget >= tier.minBudget && budget < tier.maxBudget) {
            matchedTier = tier;
            break;
        }
    }

    return {
        tier: matchedTier.name,
        description: matchedTier.description,
        maxConcurrent: matchedTier.maxConcurrent,
        recommendedTickers: [...matchedTier.tickers],
        budget,
    };
}

// ============================================
// calculateMaxPositionSize(budget, ticker, maxPositionPercent)
// ============================================
/**
 * Calculates the maximum position size in USD for a given ticker,
 * clamped between the Kraken minimum and the max % allocation of budget.
 *
 * @param {number} budget - Total available USD
 * @param {string} ticker - e.g. "BTCUSD"
 * @param {number} [maxPositionPercent=20] - Max % of budget for a single position (default 20%)
 * @returns {{
 *   positionUSD: number,
 *   minOrderUSD: number,
 *   maxAllocationUSD: number,
 *   canTrade: boolean,
 *   reason: string | null
 * }}
 */
export function calculateMaxPositionSize(budget, ticker, maxPositionPercent = 20) {
    const minimums = getMinimumOrder(ticker);
    const minOrderUSD = minimums.minNotional;
    const maxAllocationUSD = (budget * maxPositionPercent) / 100;

    // Cannot trade if even the minimum order exceeds the entire budget
    if (minOrderUSD > budget) {
        return {
            positionUSD: 0,
            minOrderUSD,
            maxAllocationUSD,
            canTrade: false,
            reason: `Minimum order ($${minOrderUSD.toFixed(2)}) exceeds total budget ($${budget.toFixed(2)})`,
        };
    }

    // If the max allocation is below the minimum, we must use the minimum
    // but only if the budget can actually cover it
    if (maxAllocationUSD < minOrderUSD) {
        return {
            positionUSD: minOrderUSD,
            minOrderUSD,
            maxAllocationUSD,
            canTrade: true,
            reason: `Using minimum order size ($${minOrderUSD.toFixed(2)}) - exceeds ${maxPositionPercent}% allocation ($${maxAllocationUSD.toFixed(2)}) but within budget`,
        };
    }

    // Normal case: use the max allocation (already above minimum)
    return {
        positionUSD: maxAllocationUSD,
        minOrderUSD,
        maxAllocationUSD,
        canTrade: true,
        reason: null,
    };
}
