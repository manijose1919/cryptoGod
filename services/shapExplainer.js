/**
 * Tree-Based SHAP Approximation Service
 *
 * Computes approximate SHAP (SHapley Additive exPlanations) values for
 * Random Forest predictions. For each tree, traces the decision path and
 * attributes the change in predicted probability at each split to the
 * feature that was split on. Contributions are averaged across all trees.
 *
 * This is a TreeSHAP-inspired "path" method — not exact Shapley, but a
 * fast, interpretable approximation suitable for real-time trade decisions.
 */

import { getFlag } from './systemConfig.js';

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Estimate P(class=1) for a node by recursively aggregating leaf predictions
 * weighted by sample counts. Internal nodes don't store class proportions
 * directly, so we reconstruct them from the subtree below.
 *
 * @param {object} node - DecisionTreeNode
 * @returns {number} Estimated probability of class 1 (0..1)
 */
function estimateNodeValue(node) {
  if (!node) return 0.5;

  // Leaf node: value is the majority class (0 or 1).
  // We treat it as a hard prediction — P(class=1) = value itself.
  if (node.isLeaf()) {
    return node.value;
  }

  // Internal node: weighted average of children's values by sample counts
  const leftVal = estimateNodeValue(node.left);
  const rightVal = estimateNodeValue(node.right);

  const leftSamples = node.left ? node.left.samples : 0;
  const rightSamples = node.right ? node.right.samples : 0;
  const totalSamples = leftSamples + rightSamples;

  if (totalSamples === 0) return 0.5;

  return (leftVal * leftSamples + rightVal * rightSamples) / totalSamples;
}

/**
 * Trace the decision path through a single tree and compute per-feature
 * contributions as the change in node value at each split.
 *
 * @param {object} root - Tree root (DecisionTreeNode)
 * @param {number[]} features - Input feature vector
 * @param {number} numFeatures - Total number of features
 * @returns {{ contributions: number[], baseValue: number }}
 */
function traceTreePath(root, features, numFeatures) {
  const contributions = new Array(numFeatures).fill(0);

  if (!root || root.isLeaf()) {
    const val = root ? estimateNodeValue(root) : 0.5;
    return { contributions, baseValue: val };
  }

  const baseValue = estimateNodeValue(root);
  let node = root;
  let parentValue = baseValue;

  while (node && !node.isLeaf()) {
    const featureIdx = node.featureIndex;
    const goLeft = features[featureIdx] <= node.threshold;
    const child = goLeft ? node.left : node.right;

    if (!child) break;

    const childValue = estimateNodeValue(child);
    const contribution = childValue - parentValue;

    // Attribute the change in value to the feature at this split
    if (featureIdx >= 0 && featureIdx < numFeatures) {
      contributions[featureIdx] += contribution;
    }

    parentValue = childValue;
    node = child;
  }

  return { contributions, baseValue };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Explain a single prediction by computing approximate SHAP values from the
 * Random Forest ensemble.
 *
 * @param {object} mlEngine - Trained MLEngine instance
 * @param {number[]} features - Raw (unscaled) feature vector
 * @param {string[]} featureNames - Human-readable names for each feature
 * @returns {{ topFeatures: Array<{name: string, contribution: number, direction: string}>, baseValue: number } | null}
 */
export function explainPrediction(mlEngine, features, featureNames) {
  try {
    // Check feature flag
    if (!getFlag('SHAP_ENABLED')) {
      return null;
    }

    // Validate inputs
    if (!mlEngine || !mlEngine.isTrained) {
      return null;
    }

    if (!mlEngine.randomForest || !mlEngine.randomForest.trees || mlEngine.randomForest.trees.length === 0) {
      return null;
    }

    if (!features || !Array.isArray(features) || features.length === 0) {
      return null;
    }

    if (!featureNames || !Array.isArray(featureNames) || featureNames.length === 0) {
      return null;
    }

    // Scale features the same way the model does internally
    const cleanedFeatures = features.map(val => isNaN(val) || !isFinite(val) ? 0 : val);
    let scaledFeatures;
    if (mlEngine.scaler && mlEngine.scaler.means) {
      scaledFeatures = mlEngine.scaler.transformRow(cleanedFeatures);
    } else {
      scaledFeatures = cleanedFeatures;
    }

    const numFeatures = scaledFeatures.length;
    const trees = mlEngine.randomForest.trees;
    const numTrees = trees.length;

    // Accumulate contributions across all trees
    const totalContributions = new Array(numFeatures).fill(0);
    let totalBaseValue = 0;

    for (const tree of trees) {
      if (!tree.root) continue;

      const { contributions, baseValue } = traceTreePath(tree.root, scaledFeatures, numFeatures);
      for (let i = 0; i < numFeatures; i++) {
        totalContributions[i] += contributions[i];
      }
      totalBaseValue += baseValue;
    }

    // Average across trees
    const treeCount = numTrees || 1;
    const avgContributions = totalContributions.map(c => c / treeCount);
    const avgBaseValue = totalBaseValue / treeCount;

    // Build feature explanation objects
    const featureExplanations = avgContributions.map((contribution, idx) => ({
      name: idx < featureNames.length ? featureNames[idx] : `feature_${idx}`,
      contribution: Math.round(contribution * 10000) / 10000, // 4 decimal places
      direction: contribution > 0 ? 'BULLISH' : contribution < 0 ? 'BEARISH' : 'NEUTRAL',
    }));

    // Sort by absolute contribution and take top 5
    const topFeatures = featureExplanations
      .slice() // copy to avoid mutating
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5);

    return {
      topFeatures,
      baseValue: Math.round(avgBaseValue * 10000) / 10000,
    };

  } catch (err) {
    console.error('[SHAP Explainer] explainPrediction error:', err.message);
    return null;
  }
}

/**
 * Format an explanation object into a human-readable string.
 *
 * Example output:
 *   "Top drivers: RSI(+0.1200 BULLISH), MACD(-0.0800 BEARISH), VOL(+0.0450 BULLISH)"
 *
 * @param {{ topFeatures: Array<{name: string, contribution: number, direction: string}>, baseValue: number } | null} explanation
 * @returns {string | null}
 */
export function formatExplanation(explanation) {
  try {
    if (!explanation || !explanation.topFeatures || explanation.topFeatures.length === 0) {
      return null;
    }

    const parts = explanation.topFeatures.map(f => {
      const sign = f.contribution >= 0 ? '+' : '';
      return `${f.name}(${sign}${f.contribution.toFixed(4)} ${f.direction})`;
    });

    return `Top drivers: ${parts.join(', ')} | base=${explanation.baseValue.toFixed(4)}`;

  } catch (err) {
    console.error('[SHAP Explainer] formatExplanation error:', err.message);
    return null;
  }
}

// ============================================================================
// Phase 7 Enhancements: Feature Drift, Interaction SHAP, Global Importance
// ============================================================================

let db;
try { db = await import('./database.js'); } catch {}

// Feature drift tracking: rolling window of SHAP importances per feature
const _shapHistory = new Map(); // featureIndex → last 100 importance values
const DRIFT_WINDOW = 100;

/**
 * Track SHAP values over time for feature drift detection
 * @param {number[]} contributions - Full SHAP contribution vector
 * @param {string} ticker - Ticker symbol
 * @param {number} prediction - Model prediction confidence
 */
export function trackSHAPDrift(contributions, ticker, prediction) {
  if (!getFlag('SHAP_DRIFT_TRACKING_ENABLED')) return;

  try {
    for (let i = 0; i < contributions.length; i++) {
      if (!_shapHistory.has(i)) _shapHistory.set(i, []);
      const history = _shapHistory.get(i);
      history.push(Math.abs(contributions[i]));
      if (history.length > DRIFT_WINDOW) history.shift();
    }

    // Persist to DB
    if (db?.getDb) {
      const topFeatures = contributions
        .map((c, i) => ({ index: i, importance: Math.abs(c) }))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 10);

      db.getDb().prepare(`
        INSERT INTO shap_history (ticker, feature_importances_json, prediction, confidence, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(ticker, JSON.stringify(topFeatures), prediction > 0.5 ? 'UP' : 'DOWN', prediction, Date.now());
    }
  } catch {}
}

/**
 * Detect feature importance drift
 * Compare first half vs second half of SHAP history window
 * @returns {Array<{featureIndex: number, name: string, driftScore: number, direction: string}>}
 */
export function detectFeatureDrift(featureNames) {
  const driftResults = [];

  for (const [idx, history] of _shapHistory.entries()) {
    if (history.length < 40) continue; // Need enough data

    const mid = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, mid);
    const secondHalf = history.slice(mid);

    const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const driftScore = Math.abs(mean2 - mean1) / (mean1 + 1e-6);

    if (driftScore > 0.3) { // 30% change in importance
      driftResults.push({
        featureIndex: idx,
        name: featureNames?.[idx] || `feature_${idx}`,
        driftScore,
        direction: mean2 > mean1 ? 'INCREASING' : 'DECREASING',
        before: mean1,
        after: mean2,
      });
    }
  }

  return driftResults.sort((a, b) => b.driftScore - a.driftScore);
}

/**
 * Compute feature interaction SHAP values (top pairs)
 * Uses pairwise product of contributions as proxy for interaction strength
 * @param {number[]} contributions - Full SHAP vector
 * @param {string[]} featureNames
 * @returns {Array<{feature1, feature2, interaction}>}
 */
export function computeInteractionSHAP(contributions, featureNames) {
  const interactions = [];

  // Only compute for top 20 most important features
  const topIndices = contributions
    .map((c, i) => ({ index: i, importance: Math.abs(c) }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20)
    .map(x => x.index);

  for (let i = 0; i < topIndices.length; i++) {
    for (let j = i + 1; j < topIndices.length; j++) {
      const idx1 = topIndices[i];
      const idx2 = topIndices[j];
      const interaction = contributions[idx1] * contributions[idx2];

      if (Math.abs(interaction) > 0.001) {
        interactions.push({
          feature1: featureNames?.[idx1] || `feature_${idx1}`,
          feature2: featureNames?.[idx2] || `feature_${idx2}`,
          index1: idx1,
          index2: idx2,
          interaction: Math.round(interaction * 10000) / 10000,
          synergy: interaction > 0 ? 'REINFORCING' : 'OPPOSING',
        });
      }
    }
  }

  return interactions.sort((a, b) => Math.abs(b.interaction) - Math.abs(a.interaction)).slice(0, 10);
}

/**
 * Get global feature importance dashboard data
 * @param {object} mlEngine - Trained MLEngine
 * @param {string[]} featureNames
 * @returns {object} { globalImportance, driftAlerts, recentHistory }
 */
export function getGlobalImportanceDashboard(mlEngine, featureNames) {
  const globalImportance = [];

  if (mlEngine?.randomForest?.featureImportances) {
    const imp = mlEngine.randomForest.featureImportances;
    for (let i = 0; i < imp.length; i++) {
      globalImportance.push({
        index: i,
        name: featureNames?.[i] || `feature_${i}`,
        rfImportance: imp[i],
        shapMean: _shapHistory.has(i)
          ? _shapHistory.get(i).reduce((a, b) => a + b, 0) / _shapHistory.get(i).length
          : 0,
      });
    }
  }

  globalImportance.sort((a, b) => b.rfImportance - a.rfImportance);

  return {
    globalImportance: globalImportance.slice(0, 20),
    driftAlerts: detectFeatureDrift(featureNames),
    historySize: _shapHistory.size,
  };
}

// ============================================================================
// Phase 7: Confidence Calibration (Isotonic Regression + Platt Scaling)
// ============================================================================

/**
 * Isotonic Regression for probability calibration
 * Fits a non-decreasing step function to map raw → calibrated probabilities
 */
export class IsotonicCalibrator {
  constructor() {
    this.breakpoints = []; // { rawProb, calibratedProb }
    this.isFitted = false;
  }

  /**
   * Fit isotonic regression on OOF predictions vs actual labels
   * @param {number[]} rawProbs - Raw model probabilities (P(UP))
   * @param {number[]} labels - Actual labels (0 or 1)
   */
  fit(rawProbs, labels) {
    if (rawProbs.length < 20) return;

    // Sort by raw probability
    const pairs = rawProbs.map((p, i) => ({ raw: p, label: labels[i] }));
    pairs.sort((a, b) => a.raw - b.raw);

    // Pool Adjacent Violators Algorithm (PAVA)
    const blocks = pairs.map(p => ({
      raw: p.raw,
      sum: p.label,
      count: 1,
      mean: p.label,
    }));

    // Merge adjacent blocks to enforce monotonicity
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < blocks.length - 1; i++) {
        if (blocks[i].mean > blocks[i + 1].mean) {
          // Merge
          blocks[i].sum += blocks[i + 1].sum;
          blocks[i].count += blocks[i + 1].count;
          blocks[i].mean = blocks[i].sum / blocks[i].count;
          blocks[i].raw = (blocks[i].raw + blocks[i + 1].raw) / 2; // midpoint
          blocks.splice(i + 1, 1);
          changed = true;
          break;
        }
      }
    }

    this.breakpoints = blocks.map(b => ({
      rawProb: b.raw,
      calibratedProb: b.mean,
    }));

    this.isFitted = true;
  }

  /**
   * Calibrate a raw probability
   * @param {number} rawProb
   * @returns {number} Calibrated probability
   */
  calibrate(rawProb) {
    if (!this.isFitted || this.breakpoints.length === 0) return rawProb;

    // Binary search for the right breakpoint
    let lo = 0, hi = this.breakpoints.length - 1;

    if (rawProb <= this.breakpoints[lo].rawProb) return this.breakpoints[lo].calibratedProb;
    if (rawProb >= this.breakpoints[hi].rawProb) return this.breakpoints[hi].calibratedProb;

    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.breakpoints[mid].rawProb <= rawProb) lo = mid;
      else hi = mid;
    }

    // Linear interpolation between breakpoints
    const bp1 = this.breakpoints[lo];
    const bp2 = this.breakpoints[hi];
    const t = (rawProb - bp1.rawProb) / (bp2.rawProb - bp1.rawProb || 1);
    return bp1.calibratedProb + t * (bp2.calibratedProb - bp1.calibratedProb);
  }

  /**
   * Compute calibration metrics
   * @param {number[]} rawProbs
   * @param {number[]} labels
   * @returns {{ brierScore, ece, calibrationCurve }}
   */
  static computeMetrics(rawProbs, labels) {
    const n = rawProbs.length;
    if (n === 0) return { brierScore: 0, ece: 0, calibrationCurve: [] };

    // Brier score: mean squared error of probabilities
    let brierSum = 0;
    for (let i = 0; i < n; i++) {
      brierSum += (rawProbs[i] - labels[i]) ** 2;
    }
    const brierScore = brierSum / n;

    // Expected Calibration Error (ECE) with 10 bins
    const numBins = 10;
    const bins = Array.from({ length: numBins }, () => ({ probs: [], labels: [] }));

    for (let i = 0; i < n; i++) {
      const binIdx = Math.min(Math.floor(rawProbs[i] * numBins), numBins - 1);
      bins[binIdx].probs.push(rawProbs[i]);
      bins[binIdx].labels.push(labels[i]);
    }

    let ece = 0;
    const calibrationCurve = [];

    for (let b = 0; b < numBins; b++) {
      const bin = bins[b];
      if (bin.probs.length === 0) continue;

      const avgProb = bin.probs.reduce((a, c) => a + c, 0) / bin.probs.length;
      const avgLabel = bin.labels.reduce((a, c) => a + c, 0) / bin.labels.length;
      const weight = bin.probs.length / n;

      ece += weight * Math.abs(avgProb - avgLabel);
      calibrationCurve.push({
        bin: b,
        meanPredicted: avgProb,
        meanActual: avgLabel,
        count: bin.probs.length,
      });
    }

    return { brierScore, ece, calibrationCurve };
  }

  serialize() {
    return JSON.stringify({ breakpoints: this.breakpoints, isFitted: this.isFitted });
  }

  deserialize(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      this.breakpoints = data.breakpoints || [];
      this.isFitted = data.isFitted || false;
    } catch {}
  }
}

// Ensure DB table for SHAP history
try {
  if (db?.getDb) {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS shap_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT,
        feature_importances_json TEXT,
        prediction TEXT,
        confidence REAL,
        created_at INTEGER
      )
    `);
  }
} catch {}
