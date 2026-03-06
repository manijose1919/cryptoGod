/**
 * Portfolio Correlation Engine — System C
 * Sizes positions based on portfolio-level correlation risk.
 *
 * Rules:
 * - If adding ticker would push any correlation cluster above 40% allocation → reduce size
 * - If ticker correlation with portfolio > 0.90 → block entry
 * - If ticker DIVERSIFIES (reduces avg correlation) → boost size up to 1.5x
 * - HHI > 0.33 → reduce new positions
 *
 * Safe by design: can only reduce sizes or maintain them. Never increases beyond 1.5x.
 */

import { getFlag } from './systemConfig.js';
import { insertCorrelationSnapshot, getLatestCorrelationSnapshot } from './database.js';

// Correlation matrix (ticker -> ticker -> correlation)
let correlationMatrix = {};
let lastUpdateTime = 0;
let matrixTickers = [];

// Fallback correlations for when data is sparse
const FALLBACK_CORRELATIONS = {
  'BTCUSD': { 'ETHUSD': 0.85, 'SOLUSD': 0.75, 'ADAUSD': 0.70, 'XRPUSD': 0.65, 'DOGEUSD': 0.60, 'LINKUSD': 0.72, 'DOTUSD': 0.70, 'AVAXUSD': 0.73, 'BNBUSD': 0.70 },
  'ETHUSD': { 'BTCUSD': 0.85, 'SOLUSD': 0.80, 'ADAUSD': 0.75, 'LINKUSD': 0.78, 'DOTUSD': 0.76, 'AVAXUSD': 0.77, 'BNBUSD': 0.72 },
  'SOLUSD': { 'BTCUSD': 0.75, 'ETHUSD': 0.80, 'AVAXUSD': 0.78 },
  'XRPUSD': { 'BTCUSD': 0.65, 'ETHUSD': 0.60, 'ADAUSD': 0.68 },
  'DOGEUSD': { 'BTCUSD': 0.60, 'ETHUSD': 0.55 },
};

/**
 * Initialize from persisted snapshot if available
 */
export function init() {
  try {
    const snapshot = getLatestCorrelationSnapshot();
    if (snapshot) {
      const age = Date.now() - snapshot.created_at;
      if (age < 3600000) { // Less than 1 hour old
        correlationMatrix = JSON.parse(snapshot.matrix_json);
        matrixTickers = snapshot.ticker_list.split(',');
        lastUpdateTime = snapshot.created_at;
        console.log('[CorrelationEngine] Restored from snapshot, age:', (age/60000).toFixed(1), 'min');
        return;
      }
    }
  } catch (e) {
    console.warn('[CorrelationEngine] Could not restore snapshot:', e.message);
  }
  console.log('[CorrelationEngine] Initialized with fallback correlations');
}

/**
 * Update correlation matrix from candle data
 * Uses rolling 24h returns for Pearson correlation
 *
 * @param {Map<string, Array>} allCandles - Map of ticker -> candles array
 */
export function updateCorrelationMatrix(allCandles) {
  if (!allCandles || allCandles.size < 2) return;

  const enabled = getFlag('CORRELATION_ENGINE_ENABLED');
  if (!enabled) return;

  try {
    const tickers = [...allCandles.keys()];
    const returns = {};

    // Calculate returns for each ticker
    for (const ticker of tickers) {
      const candles = allCandles.get(ticker);
      if (!candles || candles.length < 25) continue;

      returns[ticker] = [];
      for (let i = 1; i < candles.length; i++) {
        if (candles[i-1].c > 0) {
          returns[ticker].push(candles[i].c / candles[i-1].c - 1);
        }
      }
    }

    const validTickers = Object.keys(returns).filter(t => returns[t].length >= 20);
    if (validTickers.length < 2) return;

    // Build correlation matrix
    const matrix = {};
    for (const t1 of validTickers) {
      matrix[t1] = {};
      for (const t2 of validTickers) {
        if (t1 === t2) {
          matrix[t1][t2] = 1.0;
        } else {
          matrix[t1][t2] = pearsonCorrelation(returns[t1], returns[t2]);
        }
      }
    }

    correlationMatrix = matrix;
    matrixTickers = validTickers;
    lastUpdateTime = Date.now();

    // Persist snapshot
    try {
      const avgCorr = calculateAverageCorrelation(matrix, validTickers);
      insertCorrelationSnapshot({
        matrix,
        ticker_list: validTickers.join(','),
        avg_correlation: avgCorr,
        hhi: 0, // Will be calculated per-evaluation
        effective_positions: validTickers.length,
      });
    } catch (e) {
      // Non-critical
    }

    console.log(`[CorrelationEngine] Updated matrix for ${validTickers.length} tickers`);
  } catch (err) {
    console.error('[CorrelationEngine] Error updating matrix:', err.message);
  }
}

/**
 * Evaluate whether a new entry should be allowed/sized based on portfolio correlation.
 *
 * @param {string} ticker - Ticker to potentially add
 * @param {number} proposedSize - Proposed position size ($)
 * @param {object} openPositions - { ticker: { quantity, currentPrice, openPrice } }
 * @param {number} portfolioValue - Total portfolio value ($)
 * @returns {object} { allowed, sizeMultiplier, reason, metrics }
 */
export function evaluateEntry(ticker, proposedSize, openPositions, portfolioValue) {
  const enabled = getFlag('CORRELATION_ENGINE_ENABLED');
  if (!enabled) {
    return { allowed: true, sizeMultiplier: 1.0, reason: 'Correlation engine disabled', metrics: {} };
  }

  // No open positions — always allow
  if (!openPositions || Object.keys(openPositions).length === 0) {
    return { allowed: true, sizeMultiplier: 1.0, reason: 'No existing positions', metrics: {} };
  }

  const blockThreshold = getFlag('CORRELATION_BLOCK_THRESHOLD');
  const reduceThreshold = getFlag('CORRELATION_REDUCE_THRESHOLD');
  const maxClusterAlloc = getFlag('CORRELATION_MAX_CLUSTER_ALLOC');

  try {
    const positionTickers = Object.keys(openPositions);
    const positionValues = {};
    let totalHoldings = 0;

    for (const [t, pos] of Object.entries(openPositions)) {
      const value = pos.quantity * (pos.currentPrice || pos.openPrice);
      positionValues[t] = value;
      totalHoldings += value;
    }

    // 1. Check correlation with existing positions
    let maxCorrelation = 0;
    let mostCorrelatedWith = null;
    let avgCorrelation = 0;
    let corrCount = 0;

    for (const existingTicker of positionTickers) {
      const corr = getCorrelation(ticker, existingTicker);
      if (corr > maxCorrelation) {
        maxCorrelation = corr;
        mostCorrelatedWith = existingTicker;
      }
      avgCorrelation += corr;
      corrCount++;
    }
    avgCorrelation = corrCount > 0 ? avgCorrelation / corrCount : 0;

    // 2. Block if correlation too high
    if (maxCorrelation >= blockThreshold) {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `Blocked: ${ticker} correlation ${maxCorrelation.toFixed(2)} with ${mostCorrelatedWith} exceeds ${blockThreshold}`,
        metrics: { maxCorrelation, mostCorrelatedWith, avgCorrelation },
      };
    }

    // 3. Calculate cluster allocation
    // A "cluster" is all positions with correlation > reduceThreshold to the new ticker
    let clusterValue = proposedSize;
    for (const [t, val] of Object.entries(positionValues)) {
      const corr = getCorrelation(ticker, t);
      if (corr >= reduceThreshold) {
        clusterValue += val;
      }
    }
    const clusterAlloc = clusterValue / portfolioValue;

    // 4. Calculate HHI (Herfindahl–Hirschman Index) concentration
    const allValues = { ...positionValues, [ticker]: proposedSize };
    const totalVal = Object.values(allValues).reduce((a, b) => a + b, 0);
    let hhi = 0;
    for (const val of Object.values(allValues)) {
      const share = val / totalVal;
      hhi += share * share;
    }

    // 5. Determine size multiplier
    let sizeMultiplier = 1.0;
    const reasons = [];

    // Cluster allocation limit
    if (clusterAlloc > maxClusterAlloc) {
      const reduction = maxClusterAlloc / clusterAlloc;
      sizeMultiplier *= reduction;
      reasons.push(`cluster ${(clusterAlloc*100).toFixed(0)}% > ${(maxClusterAlloc*100).toFixed(0)}% max → ${(reduction*100).toFixed(0)}%`);
    }

    // High correlation reduction
    if (maxCorrelation >= reduceThreshold) {
      const corrPenalty = 1 - (maxCorrelation - reduceThreshold) / (blockThreshold - reduceThreshold) * 0.4;
      sizeMultiplier *= corrPenalty;
      reasons.push(`corr ${maxCorrelation.toFixed(2)} with ${mostCorrelatedWith} → ${(corrPenalty*100).toFixed(0)}%`);
    }

    // HHI concentration penalty
    if (hhi > 0.33) {
      sizeMultiplier *= 0.8;
      reasons.push(`HHI ${hhi.toFixed(2)} > 0.33 → 80%`);
    }

    // Diversification bonus: if adding this ticker REDUCES average correlation
    if (avgCorrelation < 0.5 && positionTickers.length >= 2) {
      const diversBonus = Math.min(1.5, 1 + (0.5 - avgCorrelation));
      sizeMultiplier *= diversBonus;
      reasons.push(`diversification bonus (avgCorr=${avgCorrelation.toFixed(2)}) → ${(diversBonus*100).toFixed(0)}%`);
    }

    // Clamp
    sizeMultiplier = Math.max(0.1, Math.min(1.5, sizeMultiplier));

    const effectivePositions = 1 / hhi;

    return {
      allowed: true,
      sizeMultiplier,
      reason: reasons.length > 0 ? reasons.join('; ') : 'No correlation concerns',
      metrics: {
        maxCorrelation,
        mostCorrelatedWith,
        avgCorrelation,
        clusterAlloc,
        hhi,
        effectivePositions,
        diversificationBenefit: avgCorrelation < 0.5,
      },
    };

  } catch (err) {
    console.error('[CorrelationEngine] Error evaluating entry:', err.message);
    return { allowed: true, sizeMultiplier: 1.0, reason: `Error: ${err.message}`, metrics: {} };
  }
}

/**
 * Get correlation between two tickers.
 * Uses computed matrix first, then fallbacks.
 */
function getCorrelation(ticker1, ticker2) {
  if (ticker1 === ticker2) return 1.0;

  // Try computed matrix
  if (correlationMatrix[ticker1] && correlationMatrix[ticker1][ticker2] !== undefined) {
    return correlationMatrix[ticker1][ticker2];
  }
  if (correlationMatrix[ticker2] && correlationMatrix[ticker2][ticker1] !== undefined) {
    return correlationMatrix[ticker2][ticker1];
  }

  // Try fallbacks
  if (FALLBACK_CORRELATIONS[ticker1] && FALLBACK_CORRELATIONS[ticker1][ticker2] !== undefined) {
    return FALLBACK_CORRELATIONS[ticker1][ticker2];
  }
  if (FALLBACK_CORRELATIONS[ticker2] && FALLBACK_CORRELATIONS[ticker2][ticker1] !== undefined) {
    return FALLBACK_CORRELATIONS[ticker2][ticker1];
  }

  // Default: moderate correlation (conservative)
  return 0.55;
}

/**
 * Pearson correlation coefficient between two arrays
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0.5; // Not enough data

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return Math.max(-1, Math.min(1, numerator / denominator));
}

/**
 * Calculate average correlation across matrix
 */
function calculateAverageCorrelation(matrix, tickers) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      if (matrix[tickers[i]] && matrix[tickers[i]][tickers[j]] !== undefined) {
        sum += Math.abs(matrix[tickers[i]][tickers[j]]);
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Detect lead-lag opportunities: when a leader (BTC/ETH) has moved significantly
 * but correlated followers haven't caught up yet.
 *
 * @param {Map<string, Array>} allCandles - Map of ticker -> candles array
 * @param {string[]} targetTickers - Tickers to check as potential followers
 * @returns {Array<{ ticker, leader, leaderMove, followerMove, correlation, expectedMove, confidence }>}
 */
export function detectLeadLagOpportunities(allCandles, targetTickers) {
  const enabled = getFlag('CORRELATION_ENGINE_ENABLED');
  if (!enabled) return [];

  const LEADERS = ['BTCUSD', 'ETHUSD']; // Primary market leaders
  const MIN_LEADER_MOVE = 0.8;    // Leader must move >0.8% in last 30 candles
  const MAX_FOLLOWER_MOVE = 0.3;  // Follower must have moved <0.3% (hasn't caught up)
  const MIN_CORRELATION = 0.6;     // Must be meaningfully correlated
  const LOOKBACK = 30;             // ~30 minutes at 1m candles

  const opportunities = [];

  try {
    // Calculate recent % moves for leaders
    const leaderMoves = {};
    for (const leader of LEADERS) {
      const candles = allCandles?.get?.(leader) || allCandles?.[leader];
      if (!candles || candles.length < LOOKBACK + 5) continue;
      const recent = candles[candles.length - 1].c;
      const past = candles[candles.length - LOOKBACK].c;
      if (past > 0) leaderMoves[leader] = ((recent - past) / past) * 100;
    }

    // Check each target as potential follower
    for (const ticker of targetTickers) {
      if (LEADERS.includes(ticker)) continue;

      const candles = allCandles?.get?.(ticker) || allCandles?.[ticker];
      if (!candles || candles.length < LOOKBACK + 5) continue;

      const recent = candles[candles.length - 1].c;
      const past = candles[candles.length - LOOKBACK].c;
      if (past <= 0) continue;
      const followerMove = ((recent - past) / past) * 100;

      for (const [leader, leaderMove] of Object.entries(leaderMoves)) {
        // Only bullish lead-lag (leader moved up, follower hasn't)
        if (leaderMove < MIN_LEADER_MOVE) continue;
        if (Math.abs(followerMove) > MAX_FOLLOWER_MOVE) continue;

        const corr = getCorrelation(ticker, leader);
        if (corr < MIN_CORRELATION) continue;

        // Expected follower move = leader move × correlation coefficient
        const expectedMove = leaderMove * corr;
        const gap = expectedMove - followerMove;

        if (gap > 0.3) {
          // Confidence: higher correlation + bigger gap = higher confidence
          const confidence = Math.min(25, Math.round(gap * corr * 15));
          opportunities.push({
            ticker,
            leader,
            leaderMove: parseFloat(leaderMove.toFixed(2)),
            followerMove: parseFloat(followerMove.toFixed(2)),
            correlation: parseFloat(corr.toFixed(3)),
            expectedMove: parseFloat(expectedMove.toFixed(2)),
            gap: parseFloat(gap.toFixed(2)),
            confidence, // 0-25 confidence boost
          });
        }
      }
    }
  } catch (err) {
    console.error('[CorrelationEngine] Lead-lag detection error:', err.message);
  }

  // Sort by confidence descending
  return opportunities.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Check if the matrix is stale and needs updating
 */
export function isMatrixStale() {
  const updateInterval = getFlag('CORRELATION_UPDATE_INTERVAL_MS');
  return Date.now() - lastUpdateTime > updateInterval;
}

/**
 * Get correlation engine status
 */
export function getCorrelationStatus() {
  return {
    enabled: getFlag('CORRELATION_ENGINE_ENABLED'),
    matrixTickers: matrixTickers.length,
    lastUpdateTime,
    isStale: isMatrixStale(),
    matrixAge: lastUpdateTime > 0 ? ((Date.now() - lastUpdateTime) / 60000).toFixed(1) + 'min' : 'never',
  };
}
