/**
 * Portfolio Health Optimizer
 * Evaluates portfolio concentration, correlation clustering, and rebalance actions.
 * Provides mean-variance optimal allocation for new candidates.
 *
 * Constraints:
 * - No single position > 30% of portfolio
 * - No correlated cluster (>0.7 correlation) > 40% of portfolio
 * - HHI (Herfindahl-Hirschman Index) < 0.33
 */

import { getFlag } from './systemConfig.js';

const LOG_PREFIX = '[PortfolioOptimizer]';
const MAX_SINGLE_WEIGHT = 0.30;
const MAX_CLUSTER_WEIGHT = 0.40;
const MAX_HHI = 0.33;
const DEFAULT_CORRELATION = 0.5;

/**
 * Calculate Herfindahl-Hirschman Index (sum of squared weights).
 * HHI = 1.0 means fully concentrated; 1/N means perfectly equal.
 *
 * @param {Array<{ticker: string, value: number}>} positions
 * @param {number} totalValue - Total portfolio value
 * @returns {number} HHI value between 0 and 1
 */
export function calculateHHI(positions, totalValue) {
  if (!positions || positions.length === 0 || totalValue <= 0) return 0;

  let hhi = 0;
  for (const pos of positions) {
    const weight = pos.value / totalValue;
    hhi += weight * weight;
  }
  return hhi;
}

/**
 * Look up correlation between two tickers from a correlation matrix.
 * Falls back to DEFAULT_CORRELATION if data is missing.
 *
 * @param {object} correlationMatrix - { ticker: { ticker: correlation } }
 * @param {string} t1
 * @param {string} t2
 * @returns {number}
 */
function getCorrelation(correlationMatrix, t1, t2) {
  if (t1 === t2) return 1.0;
  if (!correlationMatrix) return DEFAULT_CORRELATION;

  if (correlationMatrix[t1] && correlationMatrix[t1][t2] !== undefined) {
    return correlationMatrix[t1][t2];
  }
  if (correlationMatrix[t2] && correlationMatrix[t2][t1] !== undefined) {
    return correlationMatrix[t2][t1];
  }
  return DEFAULT_CORRELATION;
}

/**
 * Find groups of tickers that are correlated above the given threshold.
 * Uses a simple union-find / greedy clustering approach.
 *
 * @param {object} correlationMatrix - { ticker: { ticker: correlation } }
 * @param {string[]} tickers - List of tickers to evaluate
 * @param {number} [threshold=0.7] - Correlation threshold for clustering
 * @returns {string[][]} Array of ticker groups (each group is an array of correlated tickers)
 */
export function findCorrelatedClusters(correlationMatrix, tickers, threshold = 0.7) {
  if (!tickers || tickers.length === 0) return [];
  if (tickers.length === 1) return [[tickers[0]]];

  // Union-Find structure
  const parent = {};
  for (const t of tickers) parent[t] = t;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Merge tickers that exceed the correlation threshold
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const corr = getCorrelation(correlationMatrix, tickers[i], tickers[j]);
      if (Math.abs(corr) >= threshold) {
        union(tickers[i], tickers[j]);
      }
    }
  }

  // Group by root
  const groups = {};
  for (const t of tickers) {
    const root = find(t);
    if (!groups[root]) groups[root] = [];
    groups[root].push(t);
  }

  return Object.values(groups);
}

/**
 * Evaluate overall portfolio health and produce rebalance actions.
 *
 * @param {Array<{ticker: string, value: number, quantity: number, entryPrice: number}>} positions
 * @param {object} correlationMatrix - { ticker: { ticker: correlation } }
 * @param {number} totalValue - Total portfolio value
 * @returns {object} { overweightPositions, underweightPositions, hhi, avgCorrelation, rebalanceActions }
 */
export function evaluatePortfolioHealth(positions, correlationMatrix, totalValue) {
  const result = {
    overweightPositions: [],
    underweightPositions: [],
    hhi: 0,
    avgCorrelation: 0,
    rebalanceActions: [],
  };

  // Edge cases
  if (!positions || positions.length === 0 || totalValue <= 0) return result;

  const enabled = getFlag('PORTFOLIO_OPTIMIZER_ENABLED');
  if (!enabled) {
    // Still compute metrics, just skip rebalance actions
    result.hhi = calculateHHI(positions, totalValue);
    return result;
  }

  // Single position: can only flag overweight, no correlation to evaluate
  if (positions.length === 1) {
    const weight = positions[0].value / totalValue;
    result.hhi = 1.0;
    result.rebalanceActions.push({
      ticker: positions[0].ticker,
      action: weight > MAX_SINGLE_WEIGHT ? 'REDUCE' : 'HOLD',
      currentWeight: weight,
      targetWeight: Math.min(weight, MAX_SINGLE_WEIGHT),
      reduceAmount: weight > MAX_SINGLE_WEIGHT
        ? (weight - MAX_SINGLE_WEIGHT) * totalValue
        : 0,
    });
    if (weight > MAX_SINGLE_WEIGHT) result.overweightPositions.push(positions[0].ticker);
    return result;
  }

  const tickers = positions.map(p => p.ticker);
  const valueMap = {};
  for (const p of positions) valueMap[p.ticker] = p.value;

  // 1. HHI
  result.hhi = calculateHHI(positions, totalValue);

  // 2. Average pairwise correlation
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      corrSum += Math.abs(getCorrelation(correlationMatrix, tickers[i], tickers[j]));
      corrCount++;
    }
  }
  result.avgCorrelation = corrCount > 0 ? corrSum / corrCount : 0;

  // 3. Find correlated clusters and compute cluster weights
  const clusters = findCorrelatedClusters(correlationMatrix, tickers, 0.7);
  const clusterWeights = {};  // ticker -> cluster total weight
  for (const cluster of clusters) {
    let clusterValue = 0;
    for (const t of cluster) clusterValue += (valueMap[t] || 0);
    const clusterWeight = clusterValue / totalValue;
    for (const t of cluster) {
      clusterWeights[t] = clusterWeight;
    }
  }

  // 4. Evaluate each position and build rebalance actions
  const equalWeight = 1 / positions.length;

  for (const pos of positions) {
    const weight = pos.value / totalValue;
    let targetWeight = weight;
    let action = 'HOLD';

    // Constraint: single position <= 30%
    if (weight > MAX_SINGLE_WEIGHT) {
      targetWeight = Math.min(targetWeight, MAX_SINGLE_WEIGHT);
      action = 'REDUCE';
      result.overweightPositions.push(pos.ticker);
    }

    // Constraint: correlated cluster <= 40%
    const cWeight = clusterWeights[pos.ticker] || 0;
    if (cWeight > MAX_CLUSTER_WEIGHT) {
      // Scale this position down proportionally to bring cluster within limit
      const scaleFactor = MAX_CLUSTER_WEIGHT / cWeight;
      const clusterTarget = weight * scaleFactor;
      if (clusterTarget < targetWeight) {
        targetWeight = clusterTarget;
        action = 'REDUCE';
        if (!result.overweightPositions.includes(pos.ticker)) {
          result.overweightPositions.push(pos.ticker);
        }
      }
    }

    // Constraint: HHI < 0.33 — push overweight positions toward equal weight
    if (result.hhi > MAX_HHI && weight > equalWeight * 1.5) {
      const hhiTarget = Math.max(equalWeight, weight * 0.8);
      if (hhiTarget < targetWeight) {
        targetWeight = hhiTarget;
        action = 'REDUCE';
        if (!result.overweightPositions.includes(pos.ticker)) {
          result.overweightPositions.push(pos.ticker);
        }
      }
    }

    // Underweight detection: significantly below equal weight
    if (weight < equalWeight * 0.5 && action !== 'REDUCE') {
      result.underweightPositions.push(pos.ticker);
    }

    const reduceAmount = action === 'REDUCE'
      ? Math.max(0, (weight - targetWeight) * totalValue)
      : 0;

    result.rebalanceActions.push({
      ticker: pos.ticker,
      action,
      currentWeight: Math.round(weight * 10000) / 10000,
      targetWeight: Math.round(targetWeight * 10000) / 10000,
      reduceAmount: Math.round(reduceAmount * 100) / 100,
    });
  }

  return result;
}

/**
 * Compute optimal allocation weights using simplified mean-variance optimization.
 * Minimizes portfolio variance for a given set of candidates using correlation data.
 *
 * Uses an iterative minimum-variance approach:
 * 1. Start with inverse-volatility weights
 * 2. Penalize weights for correlated pairs
 * 3. Normalize to sum to 1
 *
 * @param {Array<{ticker: string, expectedReturn: number, volatility: number}>} candidates
 * @param {object} correlationMatrix - { ticker: { ticker: correlation } }
 * @param {Array<{ticker: string, expectedReturn: number}>} [expectedReturns] - Optional override
 * @returns {Array<{ticker: string, weight: number}>}
 */
export function getOptimalAllocation(candidates, correlationMatrix, expectedReturns) {
  if (!candidates || candidates.length === 0) return [];

  // Single candidate gets 100%
  if (candidates.length === 1) {
    return [{ ticker: candidates[0].ticker, weight: 1.0 }];
  }

  const n = candidates.length;

  // Build expected return map from override if provided
  const returnMap = {};
  if (expectedReturns && Array.isArray(expectedReturns)) {
    for (const er of expectedReturns) returnMap[er.ticker] = er.expectedReturn;
  }

  // Step 1: Inverse-volatility initial weights
  let weights = candidates.map(c => {
    const vol = c.volatility > 0 ? c.volatility : 0.01;
    return 1 / vol;
  });

  // Step 2: Adjust for expected returns (tilt toward higher return)
  for (let i = 0; i < n; i++) {
    const er = returnMap[candidates[i].ticker] !== undefined
      ? returnMap[candidates[i].ticker]
      : candidates[i].expectedReturn || 0;
    // Boost weight by return factor (clamped to avoid negatives)
    weights[i] *= Math.max(0.1, 1 + er);
  }

  // Step 3: Penalize for high pairwise correlations (reduce correlated pairs)
  for (let i = 0; i < n; i++) {
    let corrPenalty = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const corr = getCorrelation(correlationMatrix, candidates[i].ticker, candidates[j].ticker);
      if (corr > 0.5) {
        corrPenalty += (corr - 0.5) * weights[j];
      }
    }
    // Apply penalty: reduce weight proportional to correlation overlap
    weights[i] = Math.max(weights[i] * 0.1, weights[i] - corrPenalty * 0.3);
  }

  // Step 4: Enforce max single weight constraint
  const totalRaw = weights.reduce((a, b) => a + b, 0);
  if (totalRaw <= 0) {
    // Fallback to equal weight
    const eqWeight = 1 / n;
    return candidates.map(c => ({ ticker: c.ticker, weight: eqWeight }));
  }

  // Normalize
  weights = weights.map(w => w / totalRaw);

  // Cap at MAX_SINGLE_WEIGHT and redistribute excess
  let excess = 0;
  let uncappedCount = 0;
  for (let i = 0; i < n; i++) {
    if (weights[i] > MAX_SINGLE_WEIGHT) {
      excess += weights[i] - MAX_SINGLE_WEIGHT;
      weights[i] = MAX_SINGLE_WEIGHT;
    } else {
      uncappedCount++;
    }
  }
  if (excess > 0 && uncappedCount > 0) {
    const redistribution = excess / uncappedCount;
    for (let i = 0; i < n; i++) {
      if (weights[i] < MAX_SINGLE_WEIGHT) {
        weights[i] = Math.min(MAX_SINGLE_WEIGHT, weights[i] + redistribution);
      }
    }
  }

  // Final normalization (in case capping introduced drift)
  const finalTotal = weights.reduce((a, b) => a + b, 0);
  weights = weights.map(w => Math.round((w / finalTotal) * 10000) / 10000);

  return candidates.map((c, i) => ({
    ticker: c.ticker,
    weight: weights[i],
  }));
}

export default {
  evaluatePortfolioHealth,
  getOptimalAllocation,
  calculateHHI,
  findCorrelatedClusters,
};
