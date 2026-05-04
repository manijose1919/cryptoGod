/**
 * Online Learning Service - Phase 6
 * Real-time model adaptation after each trade
 *
 * Components:
 * - Thompson Sampling: Model accuracy as Beta(α, β), stochastic weight sampling
 * - ADWIN Drift Detection: Sliding window detects accuracy change points
 * - Model Rollback: Keeps last 3 snapshots, restores best if accuracy < 45%
 * - Online LR Update: Single-sample SGD for logistic regression component
 */

import { getFlag } from './systemConfig.js';

let db;
try { db = await import('./database.js'); } catch {}

// ================================================================
// Thompson Sampling for Model Weights
// ================================================================

class ThompsonSampler {
  /**
   * @param {string[]} modelNames - Names of models to weight
   */
  constructor(modelNames) {
    this.models = {};
    for (const name of modelNames) {
      this.models[name] = {
        alpha: 1,  // Prior successes (Beta distribution)
        beta: 1,   // Prior failures
        name,
      };
    }
  }

  /**
   * Sample weights from Beta distributions
   * @returns {object} { modelName: weight, ... } (sums to 1)
   */
  sampleWeights() {
    const samples = {};
    let total = 0;

    for (const [name, model] of Object.entries(this.models)) {
      // Sample from Beta(alpha, beta) using Jitter method
      const sample = this._sampleBeta(model.alpha, model.beta);
      samples[name] = sample;
      total += sample;
    }

    // Normalize to sum to 1
    if (total > 0) {
      for (const name of Object.keys(samples)) {
        samples[name] /= total;
      }
    }

    return samples;
  }

  /**
   * Get expected weights (mean of Beta distributions)
   * @returns {object} { modelName: weight, ... }
   */
  getExpectedWeights() {
    const weights = {};
    let total = 0;

    for (const [name, model] of Object.entries(this.models)) {
      const mean = model.alpha / (model.alpha + model.beta);
      weights[name] = mean;
      total += mean;
    }

    if (total > 0) {
      for (const name of Object.keys(weights)) {
        weights[name] /= total;
      }
    }

    return weights;
  }

  /**
   * Update model's Beta distribution after a prediction outcome
   * @param {string} modelName
   * @param {boolean} wasCorrect
   */
  update(modelName, wasCorrect) {
    const model = this.models[modelName];
    if (!model) return;

    if (wasCorrect) {
      model.alpha += 1;
    } else {
      model.beta += 1;
    }

    // Decay old counts to stay adaptive (cap at 200 effective samples)
    const total = model.alpha + model.beta;
    if (total > 200) {
      const scale = 200 / total;
      model.alpha *= scale;
      model.beta *= scale;
    }
  }

  /**
   * Sample from Beta distribution using gamma-based method
   */
  _sampleBeta(alpha, beta) {
    const x = this._sampleGamma(alpha);
    const y = this._sampleGamma(beta);
    return (x + y) > 0 ? x / (x + y) : 0.5;
  }

  /**
   * Sample from Gamma(shape, 1) using Marsaglia and Tsang's method
   */
  _sampleGamma(shape) {
    if (shape < 1) {
      return this._sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x, v;
      do {
        x = this._randn();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(Math.max(1e-10, u)) < 0.5 * x * x + d * (1 - v + Math.log(Math.max(1e-10, v)))) return d * v;
    }
  }

  /**
   * Standard normal sample (Box-Muller)
   */
  _randn() {
    const u1 = Math.max(1e-10, Math.random());
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Serialize for persistence
   * M15: returns a plain object (NOT a JSON string). Callers that wrap this
   * in JSON.stringify avoid the double-encoding bug class that 7e80042
   * fixed in mlPredictionService. deserialize() still accepts both string
   * and object inputs for back-compat with any old persisted blobs.
   */
  serialize() {
    return { ...this.models };
  }

  deserialize(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      for (const [name, model] of Object.entries(data)) {
        if (this.models[name]) {
          this.models[name].alpha = model.alpha;
          this.models[name].beta = model.beta;
        }
      }
    } catch {}
  }
}

// ================================================================
// ADWIN Drift Detection
// ================================================================

class ADWINDriftDetector {
  constructor(config = {}) {
    this.delta = config.delta || 0.01; // Confidence parameter
    this.maxWindowSize = config.maxWindowSize || 500;
    this.window = [];      // Sliding window of accuracy values (1=correct, 0=wrong)
    this.driftDetected = false;
    this.lastDriftTime = 0;
    this.driftCount = 0;
  }

  /**
   * Add new observation and check for drift
   * @param {number} value - 1 (correct) or 0 (wrong)
   * @returns {{ driftDetected: boolean, windowAccuracy: number, details: string }}
   */
  addObservation(value) {
    this.window.push(value);
    if (this.window.length > this.maxWindowSize) {
      this.window.shift();
    }

    if (this.window.length < 20) {
      return { driftDetected: false, windowAccuracy: this._mean(this.window), details: 'Not enough data' };
    }

    // ADWIN: find the largest difference between two sub-windows
    this.driftDetected = false;
    const n = this.window.length;

    for (let cut = Math.floor(n * 0.3); cut <= Math.floor(n * 0.7); cut++) {
      const w0 = this.window.slice(0, cut);
      const w1 = this.window.slice(cut);

      const mean0 = this._mean(w0);
      const mean1 = this._mean(w1);
      const diff = Math.abs(mean0 - mean1);

      // Hoeffding bound for detecting change
      const n0 = w0.length;
      const n1 = w1.length;
      const m = 1 / (1 / n0 + 1 / n1);
      const epsilon = Math.sqrt((1 / (2 * m)) * Math.log(4 / this.delta));

      if (diff > epsilon) {
        this.driftDetected = true;
        this.lastDriftTime = Date.now();
        this.driftCount++;

        // Shrink window to more recent data
        this.window = this.window.slice(cut);

        console.log(`[ADWIN] Drift detected: ${mean0.toFixed(3)} → ${mean1.toFixed(3)} (diff=${diff.toFixed(3)} > ε=${epsilon.toFixed(3)})`);

        // Log drift event to DB
        this._logDriftEvent(mean0, mean1, diff);

        return {
          driftDetected: true,
          windowAccuracy: mean1,
          accuracyBefore: mean0,
          accuracyAfter: mean1,
          details: `Accuracy shifted from ${(mean0 * 100).toFixed(1)}% to ${(mean1 * 100).toFixed(1)}%`,
        };
      }
    }

    return {
      driftDetected: false,
      windowAccuracy: this._mean(this.window),
      details: 'No drift detected',
    };
  }

  _mean(arr) {
    return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  _logDriftEvent(before, after, diff) {
    try {
      if (db?.getDb) {
        db.getDb().prepare(`
          INSERT INTO drift_events (event_type, details_json, accuracy_before, accuracy_after, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run('ADWIN_DRIFT', JSON.stringify({ diff }), before, after, Date.now());
      }
    } catch {}
  }

  getStats() {
    return {
      windowSize: this.window.length,
      windowAccuracy: this._mean(this.window),
      driftDetected: this.driftDetected,
      lastDriftTime: this.lastDriftTime,
      totalDrifts: this.driftCount,
    };
  }
}

// ================================================================
// Model Snapshot Manager (Rollback)
// ================================================================

class ModelSnapshotManager {
  constructor(maxSnapshots = 3) {
    this.snapshots = []; // { serialized, accuracy, timestamp }
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Save a model snapshot
   * @param {object} serializedModel - MLEngine.serialize() output
   * @param {number} accuracy - Current model accuracy
   */
  saveSnapshot(serializedModel, accuracy) {
    this.snapshots.push({
      serialized: serializedModel,
      accuracy,
      timestamp: Date.now(),
    });

    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift(); // Remove oldest
    }
  }

  /**
   * Get best snapshot (highest accuracy)
   * @returns {object|null} Best snapshot or null
   */
  getBestSnapshot() {
    if (this.snapshots.length === 0) return null;
    return this.snapshots.reduce((best, s) => s.accuracy > best.accuracy ? s : best);
  }

  /**
   * Check if rollback is needed
   * @param {number} currentAccuracy
   * @returns {object|null} Snapshot to rollback to, or null
   */
  shouldRollback(currentAccuracy) {
    if (!getFlag('ROLLBACK_ENABLED')) return null;
    if (currentAccuracy >= 0.45) return null; // No rollback if accuracy is acceptable

    const best = this.getBestSnapshot();
    if (!best || best.accuracy <= currentAccuracy) return null;

    console.log(`[Rollback] Current accuracy ${(currentAccuracy * 100).toFixed(1)}% < 45%, rolling back to snapshot with ${(best.accuracy * 100).toFixed(1)}%`);

    // Log rollback event
    try {
      if (db?.getDb) {
        db.getDb().prepare(`
          INSERT INTO drift_events (event_type, details_json, accuracy_before, accuracy_after, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run('MODEL_ROLLBACK', JSON.stringify({ reason: 'accuracy_below_45' }), currentAccuracy, best.accuracy, Date.now());
      }
    } catch {}

    return best;
  }

  getStats() {
    return {
      snapshotCount: this.snapshots.length,
      snapshots: this.snapshots.map(s => ({
        accuracy: s.accuracy,
        timestamp: s.timestamp,
      })),
    };
  }
}

// ================================================================
// Online Learner (Coordinator)
// ================================================================

class OnlineLearner {
  constructor() {
    this.thompsonSampler = new ThompsonSampler([
      'rf_gbt_lr',    // Existing ensemble
      'tf_lstm',      // Phase 1
      'tft',          // Phase 2
      'war_room',     // Phase 4
    ]);
    this.driftDetector = new ADWINDriftDetector();
    this.snapshotManager = new ModelSnapshotManager(3);

    this.recentPredictions = []; // { modelName, predicted, actual, timestamp }
    this.updateCount = 0;
  }

  /**
   * Record a trade outcome and update all online learning components
   * @param {object} outcome - { ticker, predicted, actual, modelContributions }
   * @param {object} mlEngine - Reference to MLEngine for online LR update
   * @param {number[]} features - Feature vector for online LR update
   */
  update(outcome, mlEngine = null, features = null) {
    if (!getFlag('ONLINE_LEARNING_ENABLED')) return;

    const { predicted, actual, modelContributions } = outcome;
    const wasCorrect = predicted === actual;

    // 1. Update Thompson Sampling for each model that contributed
    if (modelContributions) {
      for (const modelName of Object.keys(modelContributions)) {
        const modelPredicted = modelContributions[modelName];
        const modelCorrect = modelPredicted === actual;
        this.thompsonSampler.update(modelName, modelCorrect);
      }
    } else {
      // Default: update the ensemble as a whole
      this.thompsonSampler.update('rf_gbt_lr', wasCorrect);
    }

    // 2. ADWIN drift detection
    if (getFlag('DRIFT_DETECTION_ENABLED')) {
      const driftResult = this.driftDetector.addObservation(wasCorrect ? 1 : 0);

      if (driftResult.driftDetected) {
        console.log(`[Online Learner] Drift detected! ${driftResult.details}`);
        this.lastDriftDetectedAt = Date.now();
      }
    }

    // 3. Online LR update (single-sample SGD)
    if (mlEngine && features && mlEngine.logisticRegression) {
      try {
        this._onlineLRUpdate(mlEngine, features, actual === 'UP' ? 1 : 0);
      } catch {}
    }

    // 4. Check for rollback
    if (getFlag('ROLLBACK_ENABLED')) {
      const windowAccuracy = this.driftDetector.getStats().windowAccuracy;
      const rollbackSnapshot = this.snapshotManager.shouldRollback(windowAccuracy);
      if (rollbackSnapshot && mlEngine) {
        try {
          mlEngine.deserialize(rollbackSnapshot.serialized);
          console.log('[Online Learner] Model rolled back to better snapshot');
        } catch (err) {
          console.warn('[Online Learner] Rollback failed:', err.message);
        }
      }
    }

    this.updateCount++;
    this.recentPredictions.push({
      predicted,
      actual,
      correct: wasCorrect,
      timestamp: Date.now(),
    });

    // Keep only last 200 predictions
    if (this.recentPredictions.length > 200) {
      this.recentPredictions.shift();
    }

    return { driftDetected: !!(this.lastDriftDetectedAt && (Date.now() - this.lastDriftDetectedAt) < 10000) };
  }

  /**
   * Single-sample SGD update for logistic regression
   */
  _onlineLRUpdate(mlEngine, features, label) {
    const lr = mlEngine.logisticRegression;
    if (!lr || !lr.weights) return;

    const learningRate = 0.001; // Small LR for stability
    const scaledFeatures = mlEngine.scaler?.transformRow(features) || features;

    // Compute current prediction
    let z = lr.bias;
    for (let i = 0; i < scaledFeatures.length; i++) {
      z += lr.weights[i] * scaledFeatures[i];
    }
    const pred = 1 / (1 + Math.exp(-z)); // Sigmoid

    // Gradient
    const error = pred - label;

    // Update weights
    for (let i = 0; i < scaledFeatures.length; i++) {
      lr.weights[i] -= learningRate * error * scaledFeatures[i];
    }
    lr.bias -= learningRate * error;
  }

  /**
   * Save model snapshot for potential rollback
   */
  saveSnapshot(mlEngine) {
    if (!mlEngine || !mlEngine.isTrained) return;
    try {
      const serialized = mlEngine.serialize();
      const accuracy = this.driftDetector.getStats().windowAccuracy;
      this.snapshotManager.saveSnapshot(serialized, accuracy || mlEngine.accuracy);
    } catch {}
  }

  /**
   * Get dynamically sampled model weights
   * @returns {object} { modelName: weight }
   */
  getModelWeights() {
    return this.thompsonSampler.sampleWeights();
  }

  /**
   * Get expected (deterministic) model weights
   */
  getExpectedWeights() {
    return this.thompsonSampler.getExpectedWeights();
  }

  /**
   * Check if drift was recently detected (within 5 min)
   */
  isDriftActive() {
    const stats = this.driftDetector.getStats();
    return stats.driftDetected && (Date.now() - stats.lastDriftTime) < 5 * 60 * 1000;
  }

  getStats() {
    const recent = this.recentPredictions.slice(-50);
    const recentAccuracy = recent.length > 0
      ? recent.filter(p => p.correct).length / recent.length
      : 0;

    return {
      updateCount: this.updateCount,
      recentAccuracy,
      thompsonWeights: this.thompsonSampler.getExpectedWeights(),
      driftDetector: this.driftDetector.getStats(),
      snapshots: this.snapshotManager.getStats(),
      recentPredictions: recent.length,
    };
  }

  serialize() {
    return JSON.stringify({
      thompson: this.thompsonSampler.serialize(),
      driftWindow: this.driftDetector.window,
      updateCount: this.updateCount,
    });
  }

  deserialize(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      if (data.thompson) this.thompsonSampler.deserialize(data.thompson);
      if (data.driftWindow) this.driftDetector.window = data.driftWindow;
      if (data.updateCount) this.updateCount = data.updateCount;
    } catch {}
  }
}

// Ensure DB tables exist
try {
  if (db?.getDb) {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS drift_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details_json TEXT,
        accuracy_before REAL,
        accuracy_after REAL,
        created_at INTEGER
      )
    `);
  }
} catch {}

// Singleton
const onlineLearner = new OnlineLearner();

export { OnlineLearner, ThompsonSampler, ADWINDriftDetector, ModelSnapshotManager, onlineLearner };
export default onlineLearner;

console.log('[Online Learner] Loaded');
