/**
 * Deep Reinforcement Learning Agent - PPO Implementation
 * Phase 3: Optimizes for risk-adjusted PnL rather than classification accuracy
 *
 * State: 103 features + 5 portfolio state = 108 dims
 * Action: Discrete {BUY, SELL, HOLD} + continuous position_size [0, 1]
 * Reward: realized PnL - 0.5*variance - 0.001*hours_held - 2*max(drawdown-5%, 0)
 */

import { getFlag } from './systemConfig.js';

let tf;
try {
  try { tf = await import('@tensorflow/tfjs-node'); } catch { tf = await import('@tensorflow/tfjs'); }
} catch (err) {
  console.warn('[RL Agent] TensorFlow.js not available:', err.message);
}

// PPO hyperparameters
const CLIP_RATIO = 0.2;
const ENTROPY_BONUS = 0.01;
const GAE_LAMBDA = 0.95;
const GAMMA = 0.99;
const MINI_BATCH_SIZE = 64;
const PPO_EPOCHS = 4;
const STATE_DIM = 114; // 109 features + 5 portfolio state
const ACTION_DIM = 3;  // BUY, SELL, HOLD

class PPOAgent {
  constructor() {
    this.actor = null;
    this.critic = null;
    this.isTrained = false;
    this.metrics = {};
    this.totalSteps = 0;
  }

  buildNetworks(stateDim = STATE_DIM) {
    if (!tf) return;

    // Actor: state → action logits + position size
    const actorInput = tf.input({ shape: [stateDim] });
    let actorHidden = tf.layers.dense({ units: 128, activation: 'relu' }).apply(actorInput);
    actorHidden = tf.layers.dense({ units: 64, activation: 'relu' }).apply(actorHidden);
    const actionLogits = tf.layers.dense({ units: ACTION_DIM, name: 'action_logits' }).apply(actorHidden);
    const positionSize = tf.layers.dense({ units: 1, activation: 'sigmoid', name: 'position_size' }).apply(actorHidden);

    this.actor = tf.model({ inputs: actorInput, outputs: [actionLogits, positionSize] });
    this.actor.compile({ optimizer: tf.train.adam(3e-4), loss: 'meanSquaredError' });

    // Critic: state → value
    const criticInput = tf.input({ shape: [stateDim] });
    let criticHidden = tf.layers.dense({ units: 128, activation: 'relu' }).apply(criticInput);
    criticHidden = tf.layers.dense({ units: 64, activation: 'relu' }).apply(criticHidden);
    const value = tf.layers.dense({ units: 1, name: 'value' }).apply(criticHidden);

    this.critic = tf.model({ inputs: criticInput, outputs: value });
    this.critic.compile({ optimizer: tf.train.adam(1e-3), loss: 'meanSquaredError' });
  }

  /**
   * Get action from current policy
   * @param {number[]} state - 108-dim state vector
   * @returns {{ action: number, positionSize: number, logProb: number, value: number }}
   */
  getAction(state) {
    if (!tf || !this.actor || !this.critic) {
      return { action: 2, positionSize: 0, logProb: 0, value: 0 }; // Default: HOLD
    }

    const stateTensor = tf.tensor2d([state]);
    const [logitsTensor, sizeTensor] = this.actor.predict(stateTensor);
    const valueTensor = this.critic.predict(stateTensor);

    const logits = logitsTensor.dataSync();
    const posSize = sizeTensor.dataSync()[0];
    const value = valueTensor.dataSync()[0];

    // Softmax to get action probabilities
    const maxLogit = Math.max(...logits);
    const expLogits = Array.from(logits).map(l => Math.exp(l - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0);
    const probs = expLogits.map(e => e / sumExp);

    // Sample action from distribution
    const rand = Math.random();
    let cumProb = 0;
    let action = 2; // Default HOLD
    for (let i = 0; i < probs.length; i++) {
      cumProb += probs[i];
      if (rand < cumProb) { action = i; break; }
    }

    const logProb = Math.log(Math.max(probs[action], 1e-8));

    stateTensor.dispose();
    logitsTensor.dispose();
    sizeTensor.dispose();
    valueTensor.dispose();

    return { action, positionSize: posSize, logProb, value };
  }

  /**
   * Get deterministic action for inference (no sampling)
   * @param {number[]} features - 103-dim feature vector
   * @param {object} portfolioState - { position, unrealizedPnl, drawdown, timeSinceEntry, cashRatio }
   * @returns {{ action: string, positionSize: number, confidence: number }}
   */
  predict(features, portfolioState = {}) {
    if (!this.isTrained || !tf || !this.actor) {
      return { action: 'HOLD', positionSize: 0, confidence: 0.5 };
    }

    const state = this._buildState(features, portfolioState);
    const stateTensor = tf.tensor2d([state]);
    const [logitsTensor, sizeTensor] = this.actor.predict(stateTensor);

    const logits = logitsTensor.dataSync();
    const posSize = sizeTensor.dataSync()[0];

    // Softmax
    const maxLogit = Math.max(...logits);
    const expLogits = Array.from(logits).map(l => Math.exp(l - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0);
    const probs = expLogits.map(e => e / sumExp);

    // Greedy action
    const actionIdx = probs.indexOf(Math.max(...probs));
    const actionNames = ['BUY', 'SELL', 'HOLD'];
    const confidence = probs[actionIdx];

    stateTensor.dispose();
    logitsTensor.dispose();
    sizeTensor.dispose();

    return {
      action: actionNames[actionIdx],
      positionSize: posSize,
      confidence,
      actionProbs: { buy: probs[0], sell: probs[1], hold: probs[2] },
    };
  }

  /**
   * Train PPO on collected trajectories
   * @param {object} trajectories - { states, actions, rewards, logProbs, values, dones }
   * @returns {object} Training metrics
   */
  async train(trajectories) {
    if (!tf || !this.actor || !this.critic) return null;

    const { states, actions, rewards, logProbs, values, dones } = trajectories;
    const n = states.length;
    if (n < MINI_BATCH_SIZE) return null;

    // Compute advantages using GAE
    const advantages = new Array(n).fill(0);
    const returns = new Array(n).fill(0);
    let lastGAE = 0;

    for (let t = n - 1; t >= 0; t--) {
      const nextValue = t + 1 < n ? values[t + 1] : 0;
      const delta = rewards[t] + GAMMA * nextValue * (1 - dones[t]) - values[t];
      lastGAE = delta + GAMMA * GAE_LAMBDA * (1 - dones[t]) * lastGAE;
      advantages[t] = lastGAE;
      returns[t] = advantages[t] + values[t];
    }

    // Normalize advantages
    const advMean = advantages.reduce((a, b) => a + b, 0) / n;
    const advStd = Math.sqrt(advantages.reduce((a, b) => a + (b - advMean) ** 2, 0) / n) || 1;
    const normAdvantages = advantages.map(a => (a - advMean) / advStd);

    // PPO update epochs
    let totalActorLoss = 0;
    let totalCriticLoss = 0;

    for (let epoch = 0; epoch < PPO_EPOCHS; epoch++) {
      // Mini-batch updates
      const indices = Array.from({ length: n }, (_, i) => i);
      shuffleArray(indices);

      for (let start = 0; start + MINI_BATCH_SIZE <= n; start += MINI_BATCH_SIZE) {
        const batchIdx = indices.slice(start, start + MINI_BATCH_SIZE);

        const batchStates = batchIdx.map(i => states[i]);
        const batchActions = batchIdx.map(i => actions[i]);
        const batchOldLogProbs = batchIdx.map(i => logProbs[i]);
        const batchAdvantages = batchIdx.map(i => normAdvantages[i]);
        const batchReturns = batchIdx.map(i => returns[i]);

        // Actor update via manual gradient computation
        const statesTensor = tf.tensor2d(batchStates);
        const [newLogitsTensor] = this.actor.predict(statesTensor);
        const newLogits = await newLogitsTensor.array();

        // Compute new log probs
        const newLogProbs = [];
        for (let i = 0; i < MINI_BATCH_SIZE; i++) {
          const logits = newLogits[i];
          const maxL = Math.max(...logits);
          const expL = logits.map(l => Math.exp(l - maxL));
          const sumE = expL.reduce((a, b) => a + b, 0);
          const probs = expL.map(e => e / sumE);
          newLogProbs.push(Math.log(Math.max(probs[batchActions[i]], 1e-8)));
        }

        // PPO clipped objective
        const ratios = newLogProbs.map((nlp, i) => Math.exp(nlp - batchOldLogProbs[i]));
        const clipRatio = getFlag('RL_CLIP_RATIO') || CLIP_RATIO;
        let actorLoss = 0;
        for (let i = 0; i < MINI_BATCH_SIZE; i++) {
          const surr1 = ratios[i] * batchAdvantages[i];
          const surr2 = Math.max(Math.min(ratios[i], 1 + clipRatio), 1 - clipRatio) * batchAdvantages[i];
          actorLoss -= Math.min(surr1, surr2);
        }
        actorLoss /= MINI_BATCH_SIZE;
        totalActorLoss += actorLoss;

        // Critic update
        const returnsTensor = tf.tensor2d(batchReturns.map(r => [r]));
        const criticLoss = await this.critic.trainOnBatch(statesTensor, returnsTensor);
        totalCriticLoss += typeof criticLoss === 'number' ? criticLoss : criticLoss[0];

        statesTensor.dispose();
        newLogitsTensor.dispose();
        returnsTensor.dispose();
      }
    }

    this.isTrained = true;
    this.totalSteps += n;
    this.metrics = {
      actorLoss: totalActorLoss / PPO_EPOCHS,
      criticLoss: totalCriticLoss / PPO_EPOCHS,
      totalSteps: this.totalSteps,
      trajectoryLength: n,
      avgReward: rewards.reduce((a, b) => a + b, 0) / n,
    };

    console.log(`[RL Agent] PPO update: actorLoss=${this.metrics.actorLoss.toFixed(4)}, criticLoss=${this.metrics.criticLoss.toFixed(4)}, avgReward=${this.metrics.avgReward.toFixed(4)}`);
    return this.metrics;
  }

  /**
   * Build state vector from features + portfolio state
   */
  _buildState(features, portfolioState) {
    const ps = portfolioState || {};
    return [
      ...features.slice(0, 103), // Pad/truncate to 103
      ...new Array(Math.max(0, 103 - features.length)).fill(0),
      ps.position || 0,          // 0=flat, 1=long, -1=short
      ps.unrealizedPnl || 0,
      ps.drawdown || 0,
      ps.timeSinceEntry || 0,
      ps.cashRatio || 1,
    ].slice(0, STATE_DIM);
  }

  getStatus() {
    return {
      trained: this.isTrained,
      totalSteps: this.totalSteps,
      ...this.metrics,
    };
  }

  dispose() {
    if (this.actor) { this.actor.dispose(); this.actor = null; }
    if (this.critic) { this.critic.dispose(); this.critic = null; }
    this.isTrained = false;
  }
}

// ================================================================
// RL Trading Environment (Gym-like)
// ================================================================

class TradingEnvironment {
  /**
   * @param {number[][]} candles - OHLCV array
   * @param {number[][]} features2D - Pre-computed feature vectors
   * @param {object} config - { feeRate, episodeLength }
   */
  constructor(candles, features2D, config = {}) {
    this.candles = candles;
    this.features2D = features2D;
    this.feeRate = config.feeRate || 0.0052; // Kraken round-trip
    this.episodeLength = config.episodeLength || 168; // 7 days of 1h candles
    this.reset();
  }

  reset() {
    // Start at a random valid position
    const maxStart = Math.max(0, this.candles.length - this.episodeLength - 1);
    this.startIdx = Math.floor(Math.random() * maxStart);
    this.currentStep = 0;
    this.position = 0;     // 0=flat, 1=long
    this.entryPrice = 0;
    this.cash = 10000;
    this.portfolio = 10000;
    this.maxPortfolio = 10000;
    this.totalPnl = 0;
    this.pnlHistory = [];
    this.hoursHeld = 0;
    this.trades = 0;

    return this._getState();
  }

  step(action, positionSize = 0.5) {
    const idx = this.startIdx + this.currentStep;
    const candle = this.candles[idx];
    const price = candle?.close || candle?.[4] || 0;
    const nextCandle = this.candles[idx + 1];
    const nextPrice = nextCandle?.close || nextCandle?.[4] || price;

    let reward = 0;
    let realized = 0;

    // Execute action
    if (action === 0 && this.position === 0) {
      // BUY
      this.position = 1;
      this.entryPrice = price;
      this.hoursHeld = 0;
      this.trades++;
      reward -= this.feeRate / 2; // Entry fee
    } else if (action === 1 && this.position === 1) {
      // SELL (close position)
      realized = (price - this.entryPrice) / this.entryPrice;
      realized -= this.feeRate; // Fees
      this.totalPnl += realized;
      this.portfolio *= (1 + realized);
      reward += realized;
      this.position = 0;
      this.entryPrice = 0;
    }

    // Holding costs
    if (this.position === 1) {
      this.hoursHeld++;
      // Unrealized PnL tracking
      const unrealized = (nextPrice - this.entryPrice) / this.entryPrice;
      reward -= 0.001; // Time cost per hour held
    }

    // Drawdown penalty
    this.maxPortfolio = Math.max(this.maxPortfolio, this.portfolio);
    const drawdown = (this.maxPortfolio - this.portfolio) / this.maxPortfolio;
    if (drawdown > 0.05) {
      reward -= 2 * (drawdown - 0.05);
    }

    // Variance penalty (from PnL history)
    this.pnlHistory.push(realized);
    if (this.pnlHistory.length > 20) {
      const mean = this.pnlHistory.reduce((a, b) => a + b, 0) / this.pnlHistory.length;
      const variance = this.pnlHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / this.pnlHistory.length;
      reward -= 0.5 * variance;
    }

    this.currentStep++;
    const done = this.currentStep >= this.episodeLength || idx + 1 >= this.candles.length - 1;

    // Force close at episode end
    if (done && this.position === 1) {
      const closeRealized = (nextPrice - this.entryPrice) / this.entryPrice - this.feeRate;
      this.totalPnl += closeRealized;
      reward += closeRealized;
      this.position = 0;
    }

    return {
      state: this._getState(),
      reward,
      done,
      info: {
        totalPnl: this.totalPnl,
        trades: this.trades,
        drawdown,
        portfolio: this.portfolio,
      },
    };
  }

  _getState() {
    const idx = this.startIdx + this.currentStep;
    const features = this.features2D[idx] || new Array(103).fill(0);
    const candle = this.candles[idx];
    const price = candle?.close || candle?.[4] || 0;

    const unrealizedPnl = this.position === 1 && this.entryPrice > 0
      ? (price - this.entryPrice) / this.entryPrice
      : 0;

    const drawdown = this.maxPortfolio > 0
      ? (this.maxPortfolio - this.portfolio) / this.maxPortfolio
      : 0;

    return [
      ...features,
      this.position,
      unrealizedPnl,
      drawdown,
      this.hoursHeld / 168, // Normalized
      this.position === 0 ? 1 : 0, // cashRatio
    ];
  }
}

/**
 * Train RL agent on historical data
 * @param {PPOAgent} agent
 * @param {number[][]} candles
 * @param {number[][]} features2D
 * @param {number} numEpisodes
 * @returns {object} Training summary
 */
async function trainRLAgent(agent, candles, features2D, numEpisodes = 100) {
  if (!tf) return null;
  // Rebuild networks if feature dimension changed (e.g. FEATURE_COUNT updated)
  const actualStateDim = (features2D[0]?.length || 0) + 5; // features + 5 portfolio state
  if (!agent.actor || (agent.actor.inputs[0].shape[1] !== actualStateDim)) {
    if (agent.actor) console.log(`[RL Agent] Rebuilding networks: ${agent.actor.inputs[0].shape[1]} → ${actualStateDim} state dim`);
    agent.buildNetworks(actualStateDim);
  }

  const env = new TradingEnvironment(candles, features2D);
  const allRewards = [];

  for (let ep = 0; ep < numEpisodes; ep++) {
    // Collect trajectory
    const trajectory = { states: [], actions: [], rewards: [], logProbs: [], values: [], dones: [] };
    let state = env.reset();

    for (let step = 0; step < env.episodeLength; step++) {
      const { action, positionSize, logProb, value } = agent.getAction(state);
      const { state: nextState, reward, done } = env.step(action, positionSize);

      trajectory.states.push(state);
      trajectory.actions.push(action);
      trajectory.rewards.push(reward);
      trajectory.logProbs.push(logProb);
      trajectory.values.push(value);
      trajectory.dones.push(done ? 1 : 0);

      state = nextState;
      if (done) break;
    }

    allRewards.push(trajectory.rewards.reduce((a, b) => a + b, 0));

    // Train every episode
    if (trajectory.states.length >= MINI_BATCH_SIZE) {
      await agent.train(trajectory);
    }

    if ((ep + 1) % 10 === 0) {
      const avgReward = allRewards.slice(-10).reduce((a, b) => a + b, 0) / 10;
      console.log(`[RL Agent] Episode ${ep + 1}/${numEpisodes}: avgReward=${avgReward.toFixed(4)}`);
    }
  }

  return {
    episodes: numEpisodes,
    avgReward: allRewards.reduce((a, b) => a + b, 0) / allRewards.length,
    finalAvgReward: allRewards.slice(-10).reduce((a, b) => a + b, 0) / 10,
  };
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Singleton
const rlAgent = new PPOAgent();

export { PPOAgent, TradingEnvironment, trainRLAgent, rlAgent };
export default rlAgent;

console.log('[RL Agent] Loaded');
