/**
 * Multi-Agent Ensemble War Room - Phase 4
 * Specialized competing agents with a meta-learner that dynamically weights them.
 *
 * Agents:
 * - SniperAgent: High confidence only, max 2 trades/day, large size
 * - ScalperAgent: Short momentum, tight SL/TP, 1-4h hold max
 * - RegimeAgent: Active only in STRONG_UP/STRONG_DOWN
 * - ContrarianAgent: Fades extreme sentiment, buys fear/sells greed
 *
 * Meta-Learner: EMA of each agent's recent accuracy, softmax weighting
 */

import { getFlag } from './systemConfig.js';

let db;
try { db = await import('./database.js'); } catch {}

const AGENT_NAMES = ['sniper', 'scalper', 'regime', 'contrarian'];
const META_WINDOW = 50; // Rolling window for meta-learner accuracy tracking

class AgentDecision {
  constructor(action, confidence, positionSize, reason) {
    this.action = action;       // 'BUY' | 'SELL' | 'HOLD'
    this.confidence = confidence; // 0-1
    this.positionSize = positionSize; // 0-1
    this.reason = reason;
  }
}

// ================================================================
// Individual Agents
// ================================================================

class SniperAgent {
  constructor() {
    this.name = 'sniper';
    this.tradesToday = 0;
    this.lastTradeDate = null;
  }

  evaluate(features, prediction, context = {}) {
    // Reset daily counter
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastTradeDate) {
      this.tradesToday = 0;
      this.lastTradeDate = today;
    }

    // Sniper: only fires when confidence is very high and all models agree
    const { mlConfidence, tftConsensus, rlAction, adversarialConsensus } = context;
    const confidence = mlConfidence || prediction?.confidence || 0;

    if (confidence < 0.80) {
      return new AgentDecision('HOLD', confidence, 0, 'Confidence below 80% threshold');
    }

    if (this.tradesToday >= 5) {
      return new AgentDecision('HOLD', confidence, 0, 'Max 5 trades/day reached');
    }

    // Check model agreement
    const direction = prediction?.prediction || 'HOLD';
    const tftAgrees = !tftConsensus || tftConsensus === 'ALL_UP' || tftConsensus === 'ALL_DOWN';
    const rlAgrees = !rlAction || rlAction === direction || rlAction === 'BUY' && direction === 'UP';

    if (!tftAgrees) {
      return new AgentDecision('HOLD', confidence * 0.7, 0, 'TFT horizons divergent');
    }

    // NOTE: tradesToday is incremented via recordSniperTrade(), NOT on evaluate().
    // Old bug: incrementing here disabled the agent after 2 evaluations, not 2 actual trades.
    const action = direction === 'UP' ? 'BUY' : direction === 'DOWN' ? 'SELL' : 'HOLD';
    return new AgentDecision(action, confidence, 0.8, `High-confidence ${direction} signal`);
  }
}

class ScalperAgent {
  constructor() {
    this.name = 'scalper';
  }

  evaluate(features, prediction, context = {}) {
    // Use context values first (passed from mlPredictionService), then feature array as fallback.
    // Old bug: hardcoded indices (features[0], features[3], features[20]) broke when feature order changed.
    const rsiVal = context.rsi || (Array.isArray(features) && features.length > 0 ? features[0] * 100 : 50);
    const macd = context.macdHist || (Array.isArray(features) && features.length > 3 ? features[3] : 0);
    const volRatio = context.volumeRatio || (Array.isArray(features) && features.length > 20 ? features[20] : 1);

    let action = 'HOLD';
    let confidence = 0.5;
    let reason = '';

    // Oversold bounce
    if (rsiVal < 30 && macd > 0 && volRatio > 1.5) {
      action = 'BUY';
      confidence = 0.65 + (30 - rsiVal) / 100;
      reason = 'RSI oversold with momentum reversal';
    }
    // Overbought fade
    else if (rsiVal > 70 && macd < 0 && volRatio > 1.5) {
      action = 'SELL';
      confidence = 0.65 + (rsiVal - 70) / 100;
      reason = 'RSI overbought with momentum reversal';
    }
    // Strong momentum continuation
    else if (Math.abs(macd) > 0.5 && volRatio > 2.0) {
      action = macd > 0 ? 'BUY' : 'SELL';
      confidence = 0.60;
      reason = 'Strong momentum with volume confirmation';
    }

    return new AgentDecision(action, Math.min(confidence, 0.85), 0.4, reason || 'No scalp opportunity');
  }
}

class RegimeAgent {
  constructor() {
    this.name = 'regime';
  }

  evaluate(features, prediction, context = {}) {
    const { marketRegime, regimeConfidence } = context;
    const regime = marketRegime || 'SIDEWAYS';

    // Only active in strong directional regimes
    if (regime === 'SIDEWAYS') {
      return new AgentDecision('HOLD', 0.3, 0, 'Sideways regime — sitting out');
    }

    const isStrongUp = regime === 'STRONG_UP';
    const isStrongDown = regime === 'STRONG_DOWN';
    const isUp = regime === 'UP' || isStrongUp;
    const isDown = regime === 'DOWN' || isStrongDown;

    const mlDirection = prediction?.prediction;
    const mlConfidence = prediction?.confidence || 0.5;

    // Strong regime + ML agrees = high confidence
    if (isStrongUp && mlDirection === 'UP') {
      return new AgentDecision('BUY', Math.min(mlConfidence + 0.1, 0.95), 0.7, 'Strong uptrend + ML agrees');
    }
    if (isStrongDown && mlDirection === 'DOWN') {
      return new AgentDecision('SELL', Math.min(mlConfidence + 0.1, 0.95), 0.7, 'Strong downtrend + ML agrees');
    }

    // Moderate regime
    if (isUp) {
      return new AgentDecision('BUY', mlConfidence * 0.9, 0.5, 'Uptrend regime');
    }
    if (isDown) {
      return new AgentDecision('SELL', mlConfidence * 0.9, 0.5, 'Downtrend regime');
    }

    return new AgentDecision('HOLD', 0.4, 0, 'Unclear regime');
  }
}

class ContrarianAgent {
  constructor() {
    this.name = 'contrarian';
  }

  evaluate(features, prediction, context = {}) {
    const { fearGreedIndex, sentimentScore, rsi } = context;

    // Contrarian: fades extreme sentiment.
    // Use context values first (reliable), then features as fallback.
    // If Fear & Greed data is unavailable (=== 0 or null), HOLD instead of making decisions on bad data.
    const fgi = fearGreedIndex || 50;
    const sentiment = sentimentScore || 0;
    const rsiVal = rsi || (Array.isArray(features) && features.length > 0 ? features[0] * 100 : 50);

    // If Fear & Greed data is missing (defaults to 50), don't act on contrarian signals
    const hasFGData = fearGreedIndex != null && fearGreedIndex !== 0 && fearGreedIndex !== 50;

    let action = 'HOLD';
    let confidence = 0.5;
    let reason = '';

    // Extreme fear = buy opportunity (only if we have real F&G data)
    if (hasFGData && fgi < 20 && rsiVal < 35) {
      action = 'BUY';
      confidence = 0.60 + (20 - fgi) / 100;
      reason = `Extreme fear (FGI=${fgi.toFixed(0)}), contrarian buy`;
    }
    // Extreme greed = sell/reduce (only if we have real F&G data)
    else if (hasFGData && fgi > 80 && rsiVal > 65) {
      action = 'SELL';
      confidence = 0.60 + (fgi - 80) / 100;
      reason = `Extreme greed (FGI=${fgi.toFixed(0)}), contrarian sell`;
    }
    // Sentiment extremes
    else if (sentiment > 0.8 && rsiVal > 70) {
      action = 'SELL';
      confidence = 0.55;
      reason = 'Excessive bullish sentiment';
    }
    else if (sentiment < -0.8 && rsiVal < 30) {
      action = 'BUY';
      confidence = 0.55;
      reason = 'Excessive bearish sentiment';
    }

    return new AgentDecision(action, Math.min(confidence, 0.80), 0.3, reason || 'No extreme sentiment');
  }
}

// ================================================================
// Meta-Learner
// ================================================================

class MetaLearner {
  constructor() {
    this.agentStats = {};
    for (const name of AGENT_NAMES) {
      this.agentStats[name] = {
        decisions: [],     // Last META_WINDOW decisions: { correct: bool, confidence: number }
        emaAccuracy: 0.5,  // EMA of accuracy
        weight: 1 / AGENT_NAMES.length, // Current meta-weight
      };
    }
  }

  /**
   * Record agent decision outcome
   */
  recordOutcome(agentName, wasCorrect, confidence) {
    const stats = this.agentStats[agentName];
    if (!stats) return;

    stats.decisions.push({ correct: wasCorrect, confidence });
    if (stats.decisions.length > META_WINDOW) {
      stats.decisions.shift();
    }

    // Update EMA accuracy
    const alpha = getFlag('META_LEARNER_ALPHA') || 0.1;
    stats.emaAccuracy = alpha * (wasCorrect ? 1 : 0) + (1 - alpha) * stats.emaAccuracy;

    // Recalculate meta-weights via softmax
    this._updateWeights();

    // Persist to DB
    try {
      if (db?.getDb) {
        const database = db.getDb();
        database.prepare(`
          INSERT OR IGNORE INTO agent_performance (agent_name, decision, was_correct, confidence, meta_weight, ticker, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(agentName, wasCorrect ? 'CORRECT' : 'WRONG', wasCorrect ? 1 : 0, confidence, stats.weight, '', Date.now());
      }
    } catch {}
  }

  _updateWeights() {
    // Softmax over EMA accuracies (temperature=2 for moderate sharpness)
    const temp = 2;
    const accuracies = AGENT_NAMES.map(n => this.agentStats[n].emaAccuracy);
    const maxAcc = Math.max(...accuracies);
    const expAccs = accuracies.map(a => Math.exp((a - maxAcc) * temp));
    const sumExp = expAccs.reduce((a, b) => a + b, 0) || 1;

    for (let i = 0; i < AGENT_NAMES.length; i++) {
      this.agentStats[AGENT_NAMES[i]].weight = expAccs[i] / sumExp;
    }
  }

  /**
   * Get current meta-weights for all agents
   */
  getWeights() {
    const weights = {};
    for (const name of AGENT_NAMES) {
      weights[name] = this.agentStats[name].weight;
    }
    return weights;
  }

  getStats() {
    const stats = {};
    for (const name of AGENT_NAMES) {
      const s = this.agentStats[name];
      const recentCorrect = s.decisions.filter(d => d.correct).length;
      stats[name] = {
        weight: s.weight,
        emaAccuracy: s.emaAccuracy,
        recentAccuracy: s.decisions.length > 0 ? recentCorrect / s.decisions.length : 0,
        totalDecisions: s.decisions.length,
      };
    }
    return stats;
  }
}

// ================================================================
// War Room Coordinator
// ================================================================

class MultiAgentWarRoom {
  constructor() {
    this.sniper = new SniperAgent();
    this.scalper = new ScalperAgent();
    this.regime = new RegimeAgent();
    this.contrarian = new ContrarianAgent();
    this.metaLearner = new MetaLearner();
    this.agents = {
      sniper: this.sniper,
      scalper: this.scalper,
      regime: this.regime,
      contrarian: this.contrarian,
    };
  }

  /**
   * Record that a sniper trade was actually executed (not just evaluated).
   * Fixes bug where tradesToday was incremented on evaluate() instead of actual execution.
   */
  recordSniperTrade() {
    this.sniper.tradesToday++;
  }

  /**
   * Get war room consensus
   * @param {number[]} features - 103-dim feature vector
   * @param {object} mlPrediction - { prediction, confidence, probabilities }
   * @param {object} context - Additional context (regime, sentiment, etc.)
   * @returns {object} { action, confidence, positionSize, agentVotes, metaWeights, reason }
   */
  evaluate(features, mlPrediction, context = {}) {
    const decisions = {};
    const metaWeights = this.metaLearner.getWeights();

    // Get each agent's decision
    for (const [name, agent] of Object.entries(this.agents)) {
      try {
        decisions[name] = agent.evaluate(features, mlPrediction, context);
      } catch (err) {
        decisions[name] = new AgentDecision('HOLD', 0.5, 0, `Error: ${err.message}`);
      }
    }

    // Weighted consensus
    let buyScore = 0, sellScore = 0, holdScore = 0;
    let weightedSize = 0;
    let totalWeight = 0;

    for (const [name, decision] of Object.entries(decisions)) {
      const w = metaWeights[name] || 0.25;
      const score = decision.confidence * w;

      if (decision.action === 'BUY') buyScore += score;
      else if (decision.action === 'SELL') sellScore += score;
      else holdScore += score;

      if (decision.action !== 'HOLD') {
        weightedSize += decision.positionSize * w;
        totalWeight += w;
      }
    }

    // Determine consensus action
    const maxScore = Math.max(buyScore, sellScore, holdScore);
    let action, confidence;

    if (maxScore === holdScore || (buyScore < 0.3 && sellScore < 0.3)) {
      action = 'HOLD';
      confidence = holdScore / (buyScore + sellScore + holdScore || 1);
    } else if (buyScore > sellScore) {
      action = 'BUY';
      confidence = buyScore / (buyScore + sellScore + holdScore || 1);
    } else {
      action = 'SELL';
      confidence = sellScore / (buyScore + sellScore + holdScore || 1);
    }

    const positionSize = totalWeight > 0 ? weightedSize / totalWeight : 0;

    // Build reason string
    const agentVotes = {};
    for (const [name, decision] of Object.entries(decisions)) {
      agentVotes[name] = {
        action: decision.action,
        confidence: decision.confidence,
        positionSize: decision.positionSize,
        reason: decision.reason,
        weight: metaWeights[name],
      };
    }

    return {
      action,
      confidence,
      positionSize,
      agentVotes,
      metaWeights,
      prediction: action === 'HOLD' ? 'HOLD' : action === 'BUY' ? 'UP' : 'DOWN',
      probabilities: {
        up: buyScore / (buyScore + sellScore + holdScore || 1),
        down: sellScore / (buyScore + sellScore + holdScore || 1),
      },
      reason: `WarRoom: ${Object.entries(agentVotes).map(([n, v]) => `${n}=${v.action}`).join(', ')}`,
    };
  }

  /**
   * Record outcome for all agents who voted on this trade
   */
  recordOutcome(ticker, actualDirection, agentVotes) {
    if (!agentVotes) return;

    for (const [name, vote] of Object.entries(agentVotes)) {
      if (vote.action === 'HOLD') continue;

      const predicted = vote.action === 'BUY' ? 'UP' : 'DOWN';
      const wasCorrect = predicted === actualDirection;
      this.metaLearner.recordOutcome(name, wasCorrect, vote.confidence);
    }
  }

  getStats() {
    return {
      metaWeights: this.metaLearner.getWeights(),
      agentStats: this.metaLearner.getStats(),
    };
  }
}

// Ensure DB table exists
try {
  if (db?.getDb) {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS agent_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        was_correct INTEGER NOT NULL,
        confidence REAL,
        meta_weight REAL,
        ticker TEXT,
        created_at INTEGER
      )
    `);
  }
} catch {}

// Singleton
const warRoom = new MultiAgentWarRoom();

export { MultiAgentWarRoom, MetaLearner, warRoom };
export default warRoom;

console.log('[Multi-Agent War Room] Loaded');
