/**
 * Regime-Aware Meta-RL Agent — Dynamic strategy weight learning.
 *
 * A lightweight meta-reinforcement learning agent that learns which
 * combinations of signals, features, and position sizes work best
 * in each market regime. Unlike the full PPO RL agent (rlAgent.js),
 * this operates at a higher level — it adjusts strategy parameters
 * rather than making individual trade decisions.
 *
 * State: [regime, volatility, momentum, funding, fear_greed, recent_pnl]
 * Actions: [position_size_mult, sl_mult, tp_mult, entry_threshold_adj]
 * Reward: Risk-adjusted return (Sharpe-like metric)
 *
 * Uses contextual bandits (simpler than full RL) with Thompson Sampling:
 * - Maintains a distribution of parameter effectiveness per regime
 * - Samples from posterior to balance exploration/exploitation
 * - Updates beliefs after each trade outcome
 *
 * This is much lighter than PPO and can adapt within a single session.
 */

// ─── Configuration ───────────────────────────────────────────

const REGIMES = ['STRONG_UP', 'UP', 'SIDEWAYS', 'DOWN', 'STRONG_DOWN'];

// Action space: multipliers applied to base parameters
const ACTION_SPACE = {
  positionSizeMult: [0.5, 0.75, 1.0, 1.25, 1.5],    // Position size scaling
  stopLossMult:     [0.7, 0.85, 1.0, 1.15, 1.3],     // SL distance scaling
  takeProfitMult:   [0.7, 0.85, 1.0, 1.15, 1.5],     // TP distance scaling
  entryThresholdAdj:[-5, -2, 0, 2, 5],                 // Entry score adjustment
};

// ─── State ───────────────────────────────────────────────────

// Thompson Sampling: Beta distributions per (regime, action dimension, action index)
// alphas[regime][dimension][actionIdx] = successes + 1
// betas[regime][dimension][actionIdx] = failures + 1
const alphas = {};
const betas = {};

// Current active actions per regime
const currentActions = {};

// Performance tracking
const tradeHistory = []; // { regime, actions, pnl, timestamp }
const MAX_TRADE_HISTORY = 500;

// ─── Initialization ─────────────────────────────────────────

function initDistributions() {
  for (const regime of REGIMES) {
    alphas[regime] = {};
    betas[regime] = {};
    currentActions[regime] = {};

    for (const [dim, values] of Object.entries(ACTION_SPACE)) {
      alphas[regime][dim] = values.map(() => 1); // Uniform prior
      betas[regime][dim] = values.map(() => 1);
      currentActions[regime][dim] = Math.floor(values.length / 2); // Start at center
    }
  }
}

initDistributions();

// ─── Thompson Sampling ──────────────────────────────────────

/**
 * Sample from Beta distribution using the Joehnk method (fast, no dependencies).
 */
function betaSample(alpha, beta) {
  // Simple approximation for Beta sampling
  const u1 = Math.random();
  const u2 = Math.random();
  const x = Math.pow(u1, 1 / alpha);
  const y = Math.pow(u2, 1 / beta);
  const sum = x + y;
  if (sum === 0) return 0.5;
  return x / sum;
}

/**
 * Select actions for current regime using Thompson Sampling.
 * @param {string} regime - Current market regime
 * @returns {Object} { positionSizeMult, stopLossMult, takeProfitMult, entryThresholdAdj }
 */
export function selectActions(regime) {
  if (!REGIMES.includes(regime)) regime = 'SIDEWAYS';

  const selected = {};

  for (const [dim, values] of Object.entries(ACTION_SPACE)) {
    // Sample from each arm's Beta distribution
    const samples = values.map((_, i) =>
      betaSample(alphas[regime][dim][i], betas[regime][dim][i])
    );

    // Pick the arm with highest sample
    let bestIdx = 0;
    let bestSample = samples[0];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i] > bestSample) {
        bestSample = samples[i];
        bestIdx = i;
      }
    }

    currentActions[regime][dim] = bestIdx;
    selected[dim] = values[bestIdx];
  }

  return selected;
}

/**
 * Update beliefs after a trade outcome.
 * @param {string} regime - Market regime during the trade
 * @param {Object} actions - The actions that were used
 * @param {number} pnl - Trade P&L percentage
 * @param {number} risk - Risk taken (position size as fraction)
 */
export function updateBeliefs(regime, actions, pnl, risk = 0.1) {
  if (!REGIMES.includes(regime)) regime = 'SIDEWAYS';

  // Reward: risk-adjusted return (Sharpe-like)
  // Positive PnL beyond fees → success, negative → failure
  const FEE_THRESHOLD = 0.5; // Consider >0.5% as success
  const isSuccess = pnl > FEE_THRESHOLD;

  for (const [dim, values] of Object.entries(ACTION_SPACE)) {
    const actionIdx = values.indexOf(actions[dim]);
    if (actionIdx === -1) continue;

    if (isSuccess) {
      // Scale alpha update by magnitude of success
      const magnitude = Math.min(3, Math.max(0.5, pnl / 2));
      alphas[regime][dim][actionIdx] += magnitude;
    } else {
      // Scale beta update by magnitude of failure
      const magnitude = Math.min(3, Math.max(0.5, Math.abs(pnl) / 2));
      betas[regime][dim][actionIdx] += magnitude;
    }
  }

  // Record trade
  tradeHistory.push({ regime, actions, pnl, risk, timestamp: Date.now() });
  if (tradeHistory.length > MAX_TRADE_HISTORY) tradeHistory.shift();
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get recommended parameter adjustments for current market conditions.
 * @param {string} regime - Current market regime
 * @returns {Object} { positionSizeMult, stopLossMult, takeProfitMult, entryThresholdAdj, confidence }
 */
export function getRecommendedParams(regime) {
  if (!REGIMES.includes(regime)) regime = 'SIDEWAYS';

  const actions = selectActions(regime);

  // Calculate confidence based on how much data we have for this regime
  const regimeTrades = tradeHistory.filter(t => t.regime === regime).length;
  const confidence = Math.min(100, regimeTrades * 2); // 50 trades = 100% confidence

  return {
    ...actions,
    confidence,
    regime,
    regimeTrades,
    totalTrades: tradeHistory.length,
  };
}

/**
 * Get the learned parameter preferences per regime.
 * Returns the "best" action for each dimension based on posterior mean.
 */
export function getLearnedPreferences() {
  const preferences = {};

  for (const regime of REGIMES) {
    preferences[regime] = {};
    for (const [dim, values] of Object.entries(ACTION_SPACE)) {
      // Posterior mean = alpha / (alpha + beta)
      const means = values.map((_, i) => {
        const a = alphas[regime][dim][i];
        const b = betas[regime][dim][i];
        return a / (a + b);
      });

      // Find best action by posterior mean
      let bestIdx = 0;
      let bestMean = means[0];
      for (let i = 1; i < means.length; i++) {
        if (means[i] > bestMean) {
          bestMean = means[i];
          bestIdx = i;
        }
      }

      preferences[regime][dim] = {
        bestAction: values[bestIdx],
        bestMean: bestMean.toFixed(3),
        allMeans: values.map((v, i) => ({ value: v, mean: means[i].toFixed(3) })),
      };
    }
  }

  return preferences;
}

/**
 * Get Meta-RL agent status for dashboard.
 */
export function getMetaRLStatus() {
  const regimeStats = {};
  for (const regime of REGIMES) {
    const trades = tradeHistory.filter(t => t.regime === regime);
    const winTrades = trades.filter(t => t.pnl > 0);
    regimeStats[regime] = {
      trades: trades.length,
      wins: winTrades.length,
      winRate: trades.length > 0 ? (winTrades.length / trades.length * 100).toFixed(1) + '%' : 'N/A',
      avgPnl: trades.length > 0 ? (trades.reduce((s, t) => s + t.pnl, 0) / trades.length).toFixed(2) + '%' : 'N/A',
    };
  }

  return {
    totalTrades: tradeHistory.length,
    regimeStats,
    preferences: getLearnedPreferences(),
    recentTrades: tradeHistory.slice(-10).reverse(),
  };
}

/**
 * Reset all learned parameters.
 */
export function resetMetaRL() {
  tradeHistory.length = 0;
  initDistributions();
  console.log('[MetaRL] Reset all learned parameters');
}

export default {
  selectActions,
  updateBeliefs,
  getRecommendedParams,
  getLearnedPreferences,
  getMetaRLStatus,
  resetMetaRL,
};
