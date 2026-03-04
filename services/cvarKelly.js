/**
 * CVaR-Adjusted Kelly Criterion — Tail-Risk-Aware Position Sizing.
 *
 * Standard Kelly criterion maximizes log-wealth but ignores tail risk.
 * This module computes Conditional Value at Risk (CVaR, aka Expected Shortfall)
 * and adjusts Kelly fractions to account for fat-tailed crypto returns.
 *
 * Formula:
 *   Kelly_adjusted = Kelly_standard × (1 - CVaR_penalty)
 *
 * Where CVaR_penalty increases when the left tail of returns is fat,
 * reducing position size to protect against rare large losses.
 *
 * Features:
 * - Rolling CVaR calculation from recent trade returns
 * - Regime-aware adjustment (more conservative in volatile regimes)
 * - Min/max position size bounds
 * - Integration with existing Kelly from circuitBreaker.js
 */

// ─── Configuration ───────────────────────────────────────────

const CVaR_CONFIDENCE = 0.95;  // 95% CVaR (expected loss in worst 5% of cases)
const MAX_RETURN_HISTORY = 200; // Rolling window of returns
const MIN_SAMPLES_FOR_CVAR = 20; // Need at least 20 returns to compute CVaR
const MAX_POSITION_PCT = 0.25;  // Never risk more than 25% of portfolio
const MIN_POSITION_PCT = 0.02;  // Never risk less than 2% of portfolio (too small = just fees)

// ─── State ───────────────────────────────────────────────────

const returnHistory = []; // Array of { pnlPercent, timestamp, regime }
let cachedCVaR = null;
let lastCalcTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // Recalc every 5 minutes

// ─── Core CVaR Calculation ──────────────────────────────────

/**
 * Calculate Value at Risk (VaR) at given confidence level.
 * VaR = the loss threshold at the X-th percentile.
 * @param {number[]} returns - Array of return percentages (can be negative)
 * @param {number} confidence - Confidence level (e.g., 0.95)
 * @returns {number} VaR as a positive loss percentage
 */
function calculateVaR(returns, confidence = CVaR_CONFIDENCE) {
  if (returns.length < MIN_SAMPLES_FOR_CVAR) return 0;

  const sorted = [...returns].sort((a, b) => a - b); // Ascending (worst first)
  const index = Math.floor((1 - confidence) * sorted.length);
  return -sorted[index]; // Return as positive loss value
}

/**
 * Calculate Conditional Value at Risk (CVaR / Expected Shortfall).
 * CVaR = average of all losses worse than VaR.
 * This captures the "average worst case" rather than just a single percentile.
 * @param {number[]} returns - Array of return percentages
 * @param {number} confidence - Confidence level (e.g., 0.95)
 * @returns {number} CVaR as a positive loss percentage
 */
function calculateCVaR(returns, confidence = CVaR_CONFIDENCE) {
  if (returns.length < MIN_SAMPLES_FOR_CVAR) return 0;

  const sorted = [...returns].sort((a, b) => a - b); // Ascending
  const cutoffIndex = Math.ceil((1 - confidence) * sorted.length);

  if (cutoffIndex === 0) return -sorted[0]; // Edge case: only 1 tail value

  // Average of the worst (1-confidence)% of returns
  let tailSum = 0;
  for (let i = 0; i < cutoffIndex; i++) {
    tailSum += sorted[i];
  }
  return -(tailSum / cutoffIndex); // Return as positive loss value
}

/**
 * Calculate kurtosis of returns distribution.
 * High kurtosis = fat tails = more tail risk than normal distribution.
 * Normal distribution kurtosis = 3.
 */
function calculateKurtosis(returns) {
  if (returns.length < 10) return 3; // Default to normal

  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 3;

  const fourthMoment = returns.reduce((sum, r) => sum + ((r - mean) / stdDev) ** 4, 0) / n;
  return fourthMoment; // Excess kurtosis = fourthMoment - 3
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Record a trade return for CVaR calculation.
 * @param {number} pnlPercent - Trade P&L as percentage (e.g., -2.5 for 2.5% loss)
 * @param {string} regime - Market regime at time of trade
 */
export function recordReturn(pnlPercent, regime = 'NORMAL') {
  returnHistory.push({
    pnlPercent,
    regime,
    timestamp: Date.now(),
  });

  // Trim to max window
  while (returnHistory.length > MAX_RETURN_HISTORY) {
    returnHistory.shift();
  }

  // Invalidate cache
  cachedCVaR = null;
}

/**
 * Get CVaR-adjusted position size as fraction of portfolio.
 *
 * @param {number} kellyFraction - Standard Kelly fraction from circuitBreaker.js (0 to 1)
 * @param {string} regime - Current market regime
 * @returns {{ fraction: number, cvar: number, var95: number, kurtosis: number, penalty: number, reason: string }}
 */
export function getCVaRAdjustedSize(kellyFraction, regime = 'NORMAL') {
  // Get raw returns
  const returns = returnHistory.map(r => r.pnlPercent);

  if (returns.length < MIN_SAMPLES_FOR_CVAR) {
    // Not enough data — use conservative half-Kelly
    return {
      fraction: Math.min(MAX_POSITION_PCT, Math.max(MIN_POSITION_PCT, kellyFraction * 0.5)),
      cvar: 0,
      var95: 0,
      kurtosis: 3,
      penalty: 0.5,
      reason: `Insufficient data (${returns.length}/${MIN_SAMPLES_FOR_CVAR} trades) — using half-Kelly`,
    };
  }

  // Calculate risk metrics
  const now = Date.now();
  let cvar, var95, kurtosis;

  if (cachedCVaR && now - lastCalcTime < CACHE_TTL_MS) {
    ({ cvar, var95, kurtosis } = cachedCVaR);
  } else {
    cvar = calculateCVaR(returns, CVaR_CONFIDENCE);
    var95 = calculateVaR(returns, CVaR_CONFIDENCE);
    kurtosis = calculateKurtosis(returns);
    cachedCVaR = { cvar, var95, kurtosis };
    lastCalcTime = now;
  }

  // CVaR penalty: higher CVaR → larger penalty → smaller position
  // Base penalty: CVaR/100 (so 5% CVaR → 0.05 penalty)
  let penalty = Math.min(0.8, cvar / 100);

  // Kurtosis penalty: fat tails beyond normal distribution
  // Kurtosis > 3 means fatter tails than normal
  const excessKurtosis = Math.max(0, kurtosis - 3);
  penalty += Math.min(0.2, excessKurtosis * 0.02);

  // Regime adjustment
  const regimeMultipliers = {
    STRONG_DOWN: 0.4, // Very conservative
    DOWN: 0.6,
    SIDEWAYS: 0.85,
    NORMAL: 1.0,
    UP: 1.1,
    STRONG_UP: 1.15,
  };
  const regimeMult = regimeMultipliers[regime] || 1.0;

  // Adjusted Kelly = Kelly × (1 - penalty) × regime
  let adjustedFraction = kellyFraction * (1 - penalty) * regimeMult;

  // Apply bounds
  adjustedFraction = Math.min(MAX_POSITION_PCT, Math.max(MIN_POSITION_PCT, adjustedFraction));

  return {
    fraction: adjustedFraction,
    cvar,
    var95,
    kurtosis,
    penalty,
    regimeMultiplier: regimeMult,
    reason: `CVaR=${cvar.toFixed(2)}%, VaR95=${var95.toFixed(2)}%, kurtosis=${kurtosis.toFixed(1)}, penalty=${(penalty * 100).toFixed(1)}%, regime=${regime}×${regimeMult}`,
  };
}

/**
 * Get CVaR position size in dollar terms.
 * @param {number} totalEquity - Total portfolio value
 * @param {number} kellyFraction - Standard Kelly fraction
 * @param {string} regime - Market regime
 * @returns {number} Dollar amount to risk
 */
export function getCVaRPositionDollars(totalEquity, kellyFraction, regime = 'NORMAL') {
  const result = getCVaRAdjustedSize(kellyFraction, regime);
  return totalEquity * result.fraction;
}

/**
 * Get current CVaR statistics for dashboard.
 */
export function getCVaRStatus() {
  const returns = returnHistory.map(r => r.pnlPercent);
  const winCount = returns.filter(r => r > 0).length;
  const lossCount = returns.filter(r => r <= 0).length;
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const maxLoss = returns.length > 0 ? Math.min(...returns) : 0;
  const maxWin = returns.length > 0 ? Math.max(...returns) : 0;

  return {
    sampleCount: returnHistory.length,
    minRequired: MIN_SAMPLES_FOR_CVAR,
    winCount,
    lossCount,
    winRate: returns.length > 0 ? (winCount / returns.length * 100).toFixed(1) + '%' : 'N/A',
    avgReturn: avgReturn.toFixed(2) + '%',
    maxLoss: maxLoss.toFixed(2) + '%',
    maxWin: maxWin.toFixed(2) + '%',
    cvar: returns.length >= MIN_SAMPLES_FOR_CVAR ? calculateCVaR(returns).toFixed(2) + '%' : 'N/A',
    var95: returns.length >= MIN_SAMPLES_FOR_CVAR ? calculateVaR(returns).toFixed(2) + '%' : 'N/A',
    kurtosis: returns.length >= 10 ? calculateKurtosis(returns).toFixed(2) : 'N/A',
    maxPositionPct: (MAX_POSITION_PCT * 100) + '%',
    minPositionPct: (MIN_POSITION_PCT * 100) + '%',
  };
}

export default {
  recordReturn,
  getCVaRAdjustedSize,
  getCVaRPositionDollars,
  getCVaRStatus,
};
