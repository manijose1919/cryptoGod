/**
 * Pure JavaScript ML Engine for Trade Direction Prediction
 * Implements Decision Trees, Random Forest, Gradient Boosted Trees, and Logistic Regression
 * No native dependencies - all math is pure JS
 */

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Seeded pseudo-random number generator (Linear Congruential Generator)
 * Used for reproducible random sampling
 */
class SeededRandom {
  constructor(seed = 42) {
    this.seed = seed;
  }

  next() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  nextInt(min, max) {
    return Math.floor(this.next() * (max - min) + min);
  }

  shuffle(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  sample(array, count) {
    const shuffled = this.shuffle(array);
    return shuffled.slice(0, count);
  }
}

/**
 * Feature scaler for standardization (zero mean, unit variance)
 */
class FeatureScaler {
  constructor() {
    this.means = null;
    this.stds = null;
  }

  fit(features2D) {
    const numFeatures = features2D[0].length;
    this.means = new Array(numFeatures).fill(0);
    this.stds = new Array(numFeatures).fill(0);

    // Calculate means
    for (const row of features2D) {
      for (let i = 0; i < numFeatures; i++) {
        const val = isNaN(row[i]) || !isFinite(row[i]) ? 0 : row[i];
        this.means[i] += val;
      }
    }
    for (let i = 0; i < numFeatures; i++) {
      this.means[i] /= features2D.length;
    }

    // Calculate standard deviations
    for (const row of features2D) {
      for (let i = 0; i < numFeatures; i++) {
        const val = isNaN(row[i]) || !isFinite(row[i]) ? 0 : row[i];
        this.stds[i] += Math.pow(val - this.means[i], 2);
      }
    }
    for (let i = 0; i < numFeatures; i++) {
      this.stds[i] = Math.sqrt(this.stds[i] / features2D.length);
      // Avoid division by zero
      if (this.stds[i] === 0) this.stds[i] = 1;
    }
  }

  transform(features2D) {
    return features2D.map(row => this.transformRow(row));
  }

  transformRow(row) {
    // Truncate row to scaler's trained dimensions if longer (e.g., 109 features → 103 scaler)
    const scalerLen = this.means.length;
    const slice = row.length > scalerLen ? row.slice(0, scalerLen) : row;
    return slice.map((val, i) => {
      const cleaned = isNaN(val) || !isFinite(val) ? 0 : val;
      const std = this.stds[i];
      return std > 0 ? (cleaned - this.means[i]) / std : 0;
    });
  }

  fitTransform(features2D) {
    this.fit(features2D);
    return this.transform(features2D);
  }
}

/**
 * Calculate class weights for imbalanced datasets
 */
function calculateClassWeights(labels) {
  const counts = { 0: 0, 1: 0 };
  for (const label of labels) {
    counts[label]++;
  }
  const total = labels.length;
  return {
    0: total / (2 * counts[0]),
    1: total / (2 * counts[1])
  };
}

/**
 * Calculate Gini impurity
 */
function calculateGini(labels, weights = null) {
  if (labels.length === 0) return 0;

  const counts = { 0: 0, 1: 0 };
  let totalWeight = 0;

  for (let i = 0; i < labels.length; i++) {
    const weight = weights ? weights[i] : 1;
    counts[labels[i]] += weight;
    totalWeight += weight;
  }

  const p0 = counts[0] / totalWeight;
  const p1 = counts[1] / totalWeight;
  return 1 - (p0 * p0 + p1 * p1);
}

/**
 * Sigmoid function
 */
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// ============================================================================
// DECISION TREE
// ============================================================================

class DecisionTreeNode {
  constructor() {
    this.featureIndex = null;
    this.threshold = null;
    this.left = null;
    this.right = null;
    this.value = null; // For leaf nodes: predicted class
    this.samples = 0;
    this.gini = 0;
  }

  isLeaf() {
    return this.value !== null;
  }
}

class DecisionTree {
  constructor(config = {}) {
    this.maxDepth = config.maxDepth || 10;
    this.minSamples = config.minSamples || 5;
    this.maxFeatures = config.maxFeatures || null; // null = use all features
    this.random = config.random || new SeededRandom();
    this.root = null;
    this.featureImportances = null;
  }

  fit(features2D, labels, weights = null) {
    const numFeatures = features2D[0].length;
    this.featureImportances = new Array(numFeatures).fill(0);

    const sampleWeights = weights || new Array(labels.length).fill(1);
    this.root = this._buildTree(features2D, labels, sampleWeights, 0);

    // Normalize feature importances
    const totalImportance = this.featureImportances.reduce((a, b) => a + b, 0);
    if (totalImportance > 0) {
      this.featureImportances = this.featureImportances.map(imp => imp / totalImportance);
    }
  }

  _buildTree(features2D, labels, weights, depth) {
    const node = new DecisionTreeNode();
    node.samples = labels.length;
    node.gini = calculateGini(labels, weights);

    // Stopping criteria
    if (depth >= this.maxDepth ||
        labels.length < this.minSamples ||
        node.gini === 0) {
      node.value = this._majorityClass(labels, weights);
      return node;
    }

    // Find best split
    const split = this._findBestSplit(features2D, labels, weights);
    if (!split) {
      node.value = this._majorityClass(labels, weights);
      return node;
    }

    // Record feature importance (weighted gini decrease)
    const impurityDecrease = node.gini - split.gini;
    this.featureImportances[split.featureIndex] += impurityDecrease * labels.length;

    // Split data
    const { leftIndices, rightIndices } = this._splitData(features2D, split.featureIndex, split.threshold);

    if (leftIndices.length === 0 || rightIndices.length === 0) {
      node.value = this._majorityClass(labels, weights);
      return node;
    }

    // Build subtrees
    node.featureIndex = split.featureIndex;
    node.threshold = split.threshold;

    const leftFeatures = leftIndices.map(i => features2D[i]);
    const leftLabels = leftIndices.map(i => labels[i]);
    const leftWeights = leftIndices.map(i => weights[i]);

    const rightFeatures = rightIndices.map(i => features2D[i]);
    const rightLabels = rightIndices.map(i => labels[i]);
    const rightWeights = rightIndices.map(i => weights[i]);

    node.left = this._buildTree(leftFeatures, leftLabels, leftWeights, depth + 1);
    node.right = this._buildTree(rightFeatures, rightLabels, rightWeights, depth + 1);

    return node;
  }

  _findBestSplit(features2D, labels, weights) {
    const numFeatures = features2D[0].length;
    let featureIndices = Array.from({ length: numFeatures }, (_, i) => i);

    // Random feature subset if maxFeatures is set
    if (this.maxFeatures && this.maxFeatures < numFeatures) {
      featureIndices = this.random.sample(featureIndices, this.maxFeatures);
    }

    let bestSplit = null;
    let bestGini = Infinity;

    for (const featureIndex of featureIndices) {
      // Get unique values for this feature
      const values = features2D.map(row => row[featureIndex]);
      const uniqueValues = [...new Set(values)].sort((a, b) => a - b);

      // Try midpoints between consecutive unique values
      for (let i = 0; i < uniqueValues.length - 1; i++) {
        const threshold = (uniqueValues[i] + uniqueValues[i + 1]) / 2;
        const { leftIndices, rightIndices } = this._splitData(features2D, featureIndex, threshold);

        if (leftIndices.length === 0 || rightIndices.length === 0) continue;

        const leftLabels = leftIndices.map(i => labels[i]);
        const leftWeights = leftIndices.map(i => weights[i]);
        const rightLabels = rightIndices.map(i => labels[i]);
        const rightWeights = rightIndices.map(i => weights[i]);

        const leftGini = calculateGini(leftLabels, leftWeights);
        const rightGini = calculateGini(rightLabels, rightWeights);

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const leftTotalWeight = leftWeights.reduce((a, b) => a + b, 0);
        const rightTotalWeight = rightWeights.reduce((a, b) => a + b, 0);

        const weightedGini = (leftTotalWeight / totalWeight) * leftGini +
                            (rightTotalWeight / totalWeight) * rightGini;

        if (weightedGini < bestGini) {
          bestGini = weightedGini;
          bestSplit = { featureIndex, threshold, gini: weightedGini };
        }
      }
    }

    return bestSplit;
  }

  _splitData(features2D, featureIndex, threshold) {
    const leftIndices = [];
    const rightIndices = [];

    for (let i = 0; i < features2D.length; i++) {
      if (features2D[i][featureIndex] <= threshold) {
        leftIndices.push(i);
      } else {
        rightIndices.push(i);
      }
    }

    return { leftIndices, rightIndices };
  }

  _majorityClass(labels, weights) {
    const counts = { 0: 0, 1: 0 };
    for (let i = 0; i < labels.length; i++) {
      counts[labels[i]] += weights[i];
    }
    return counts[0] > counts[1] ? 0 : 1;
  }

  predict(features) {
    let node = this.root;
    while (!node.isLeaf()) {
      if (features[node.featureIndex] <= node.threshold) {
        node = node.left;
      } else {
        node = node.right;
      }
    }
    return node.value;
  }

  predictProba(features) {
    const prediction = this.predict(features);
    // Trees don't have probabilities, return hard predictions
    return prediction === 1 ? [0.0, 1.0] : [1.0, 0.0];
  }
}

// ============================================================================
// RANDOM FOREST
// ============================================================================

class RandomForest {
  constructor(config = {}) {
    this.nTrees = config.nTrees || 50;
    this.maxDepth = config.maxDepth || 10;
    this.minSamples = config.minSamples || 5;
    this.bootstrapRatio = config.bootstrapRatio || 0.7;
    this.random = new SeededRandom(config.seed || 42);
    this.trees = [];
    this.featureImportances = null;
  }

  fit(features2D, labels, weights = null) {
    const numFeatures = features2D[0].length;
    const maxFeaturesPerTree = Math.floor(Math.sqrt(numFeatures));
    const sampleWeights = weights || new Array(labels.length).fill(1);

    this.trees = [];
    this.featureImportances = new Array(numFeatures).fill(0);

    for (let i = 0; i < this.nTrees; i++) {
      // Bootstrap sampling
      const bootstrapSize = Math.floor(features2D.length * this.bootstrapRatio);
      const indices = [];
      for (let j = 0; j < bootstrapSize; j++) {
        indices.push(this.random.nextInt(0, features2D.length));
      }

      const bootstrapFeatures = indices.map(idx => features2D[idx]);
      const bootstrapLabels = indices.map(idx => labels[idx]);
      const bootstrapWeights = indices.map(idx => sampleWeights[idx]);

      // Train tree
      const tree = new DecisionTree({
        maxDepth: this.maxDepth,
        minSamples: this.minSamples,
        maxFeatures: maxFeaturesPerTree,
        random: this.random
      });

      tree.fit(bootstrapFeatures, bootstrapLabels, bootstrapWeights);
      this.trees.push(tree);

      // Accumulate feature importances
      for (let f = 0; f < numFeatures; f++) {
        this.featureImportances[f] += tree.featureImportances[f];
      }
    }

    // Average feature importances
    this.featureImportances = this.featureImportances.map(imp => imp / this.nTrees);
  }

  predict(features) {
    const votes = { 0: 0, 1: 0 };
    for (const tree of this.trees) {
      const prediction = tree.predict(features);
      votes[prediction]++;
    }
    return votes[0] > votes[1] ? 0 : 1;
  }

  predictProba(features) {
    const votes = { 0: 0, 1: 0 };
    for (const tree of this.trees) {
      const prediction = tree.predict(features);
      votes[prediction]++;
    }
    const total = this.trees.length;
    return [votes[0] / total, votes[1] / total];
  }
}

// ============================================================================
// GRADIENT BOOSTED TREES
// ============================================================================

class GradientBoostedTrees {
  constructor(config = {}) {
    this.nEstimators = config.nEstimators || 100;
    this.learningRate = config.learningRate || 0.1;
    this.maxDepth = config.maxDepth || 6;
    this.minSamples = config.minSamples || 5;
    this.l2Lambda = config.l2Lambda || 1.0;
    this.random = new SeededRandom(config.seed || 42);
    this.trees = [];
    this.initialPrediction = 0;
  }

  fit(features2D, labels, weights = null) {
    const sampleWeights = weights || new Array(labels.length).fill(1);

    // Initial prediction (log odds)
    const positives = labels.reduce((sum, label, i) => sum + label * sampleWeights[i], 0);
    const totalWeight = sampleWeights.reduce((a, b) => a + b, 0);
    const p = positives / totalWeight;
    this.initialPrediction = Math.log(p / (1 - p));

    // Initialize predictions
    let predictions = new Array(labels.length).fill(this.initialPrediction);

    this.trees = [];

    for (let i = 0; i < this.nEstimators; i++) {
      // Calculate gradients (negative gradient of log loss)
      const residuals = labels.map((label, idx) => {
        const prob = sigmoid(predictions[idx]);
        return label - prob;
      });

      // Train tree on residuals
      const tree = new DecisionTree({
        maxDepth: this.maxDepth,
        minSamples: this.minSamples,
        maxFeatures: Math.floor(Math.sqrt(features2D[0].length)),
        random: this.random
      });

      // Create regression tree by treating residuals as continuous targets
      // We'll use a simplified approach: predict mean residual in each leaf
      const regressionTree = this._buildRegressionTree(features2D, residuals, sampleWeights, 0);
      this.trees.push(regressionTree);

      // Update predictions
      for (let j = 0; j < predictions.length; j++) {
        const leafValue = this._predictRegressionTree(regressionTree, features2D[j]);
        predictions[j] += this.learningRate * leafValue;
      }
    }
  }

  _buildRegressionTree(features2D, targets, weights, depth) {
    const node = new DecisionTreeNode();
    node.samples = targets.length;

    // Stopping criteria
    if (depth >= this.maxDepth || targets.length < this.minSamples) {
      // Leaf value: weighted mean of targets
      let weightedSum = 0;
      let totalWeight = 0;
      for (let i = 0; i < targets.length; i++) {
        weightedSum += targets[i] * weights[i];
        totalWeight += weights[i];
      }
      node.value = totalWeight > 0 ? weightedSum / totalWeight : 0;
      return node;
    }

    // Find best split (minimize MSE)
    const split = this._findBestRegressionSplit(features2D, targets, weights);
    if (!split) {
      let weightedSum = 0;
      let totalWeight = 0;
      for (let i = 0; i < targets.length; i++) {
        weightedSum += targets[i] * weights[i];
        totalWeight += weights[i];
      }
      node.value = totalWeight > 0 ? weightedSum / totalWeight : 0;
      return node;
    }

    // Split data
    const { leftIndices, rightIndices } = this._splitData(features2D, split.featureIndex, split.threshold);

    if (leftIndices.length === 0 || rightIndices.length === 0) {
      let weightedSum = 0;
      let totalWeight = 0;
      for (let i = 0; i < targets.length; i++) {
        weightedSum += targets[i] * weights[i];
        totalWeight += weights[i];
      }
      node.value = totalWeight > 0 ? weightedSum / totalWeight : 0;
      return node;
    }

    node.featureIndex = split.featureIndex;
    node.threshold = split.threshold;

    const leftFeatures = leftIndices.map(i => features2D[i]);
    const leftTargets = leftIndices.map(i => targets[i]);
    const leftWeights = leftIndices.map(i => weights[i]);

    const rightFeatures = rightIndices.map(i => features2D[i]);
    const rightTargets = rightIndices.map(i => targets[i]);
    const rightWeights = rightIndices.map(i => weights[i]);

    node.left = this._buildRegressionTree(leftFeatures, leftTargets, leftWeights, depth + 1);
    node.right = this._buildRegressionTree(rightFeatures, rightTargets, rightWeights, depth + 1);

    return node;
  }

  _findBestRegressionSplit(features2D, targets, weights) {
    const numFeatures = features2D[0].length;
    const featureIndices = Array.from({ length: numFeatures }, (_, i) => i);
    const maxFeatures = Math.floor(Math.sqrt(numFeatures));
    const selectedFeatures = this.random.sample(featureIndices, maxFeatures);

    let bestSplit = null;
    let bestMSE = Infinity;

    for (const featureIndex of selectedFeatures) {
      const values = features2D.map(row => row[featureIndex]);
      const uniqueValues = [...new Set(values)].sort((a, b) => a - b);

      for (let i = 0; i < uniqueValues.length - 1; i++) {
        const threshold = (uniqueValues[i] + uniqueValues[i + 1]) / 2;
        const { leftIndices, rightIndices } = this._splitData(features2D, featureIndex, threshold);

        if (leftIndices.length === 0 || rightIndices.length === 0) continue;

        const leftMSE = this._calculateMSE(leftIndices.map(i => targets[i]), leftIndices.map(i => weights[i]));
        const rightMSE = this._calculateMSE(rightIndices.map(i => targets[i]), rightIndices.map(i => weights[i]));

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const leftWeight = leftIndices.reduce((sum, i) => sum + weights[i], 0);
        const rightWeight = rightIndices.reduce((sum, i) => sum + weights[i], 0);

        const weightedMSE = (leftWeight / totalWeight) * leftMSE + (rightWeight / totalWeight) * rightMSE;

        if (weightedMSE < bestMSE) {
          bestMSE = weightedMSE;
          bestSplit = { featureIndex, threshold };
        }
      }
    }

    return bestSplit;
  }

  _calculateMSE(targets, weights) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < targets.length; i++) {
      weightedSum += targets[i] * weights[i];
      totalWeight += weights[i];
    }
    const mean = totalWeight > 0 ? weightedSum / totalWeight : 0;

    let mse = 0;
    for (let i = 0; i < targets.length; i++) {
      mse += weights[i] * Math.pow(targets[i] - mean, 2);
    }
    return totalWeight > 0 ? mse / totalWeight : 0;
  }

  _splitData(features2D, featureIndex, threshold) {
    const leftIndices = [];
    const rightIndices = [];

    for (let i = 0; i < features2D.length; i++) {
      if (features2D[i][featureIndex] <= threshold) {
        leftIndices.push(i);
      } else {
        rightIndices.push(i);
      }
    }

    return { leftIndices, rightIndices };
  }

  _predictRegressionTree(node, features) {
    if (node.isLeaf()) {
      return node.value;
    }
    if (features[node.featureIndex] <= node.threshold) {
      return this._predictRegressionTree(node.left, features);
    } else {
      return this._predictRegressionTree(node.right, features);
    }
  }

  predict(features) {
    const logOdds = this.predictLogOdds(features);
    const prob = sigmoid(logOdds);
    return prob >= 0.5 ? 1 : 0;
  }

  predictLogOdds(features) {
    let prediction = this.initialPrediction;
    for (const tree of this.trees) {
      prediction += this.learningRate * this._predictRegressionTree(tree, features);
    }
    return prediction;
  }

  predictProba(features) {
    const logOdds = this.predictLogOdds(features);
    const prob = sigmoid(logOdds);
    return [1 - prob, prob];
  }
}

// ============================================================================
// LOGISTIC REGRESSION
// ============================================================================

class LogisticRegression {
  constructor(config = {}) {
    this.learningRate = config.learningRate || 0.01;
    this.maxIterations = config.maxIterations || 1000;
    this.l2Lambda = config.l2Lambda || 0.1;
    this.weights = null;
    this.bias = 0;
  }

  fit(features2D, labels, weights = null) {
    const numFeatures = features2D[0].length;
    this.weights = new Array(numFeatures).fill(0);
    this.bias = 0;

    const sampleWeights = weights || new Array(labels.length).fill(1);

    for (let iter = 0; iter < this.maxIterations; iter++) {
      let gradWeights = new Array(numFeatures).fill(0);
      let gradBias = 0;

      // Calculate gradients
      for (let i = 0; i < features2D.length; i++) {
        const z = this._computeZ(features2D[i]);
        const prob = sigmoid(z);
        const error = (prob - labels[i]) * sampleWeights[i];

        for (let j = 0; j < numFeatures; j++) {
          gradWeights[j] += error * features2D[i][j];
        }
        gradBias += error;
      }

      // L2 regularization
      for (let j = 0; j < numFeatures; j++) {
        gradWeights[j] += this.l2Lambda * this.weights[j];
      }

      // Update weights
      for (let j = 0; j < numFeatures; j++) {
        this.weights[j] -= this.learningRate * gradWeights[j] / features2D.length;
      }
      this.bias -= this.learningRate * gradBias / features2D.length;
    }
  }

  _computeZ(features) {
    let z = this.bias;
    for (let i = 0; i < features.length; i++) {
      z += this.weights[i] * features[i];
    }
    return z;
  }

  predict(features) {
    const prob = sigmoid(this._computeZ(features));
    return prob >= 0.5 ? 1 : 0;
  }

  predictProba(features) {
    const prob = sigmoid(this._computeZ(features));
    return [1 - prob, prob];
  }
}

// ============================================================================
// ML ENGINE (ENSEMBLE)
// ============================================================================

class MLEngine {
  constructor(config = {}) {
    this.config = {
      nTrees: config.nTrees || 150,         // Scaled up from 50 for 16GB RAM
      maxDepth: config.maxDepth || 10,
      learningRate: config.learningRate || 0.1,
      minSamples: config.minSamples || 5,
      nEstimators: config.nEstimators || 250, // Scaled up from 100 for 16GB RAM
      seed: config.seed || 42
    };

    this.scaler = new FeatureScaler();
    this.randomForest = null;
    this.gradientBoosted = null;
    this.logisticRegression = null;
    this.lstmModel = null;  // LSTM sequence model (Upgrade #8)

    this.isTrained = false;
    this.trainedAt = null;
    this.accuracy = 0;
    this.validationAccuracy = 0;
    this.sampleCount = 0;
    this.modelWeights = { rf: 0, gb: 0, lr: 0, lstm: 0 };
    this.featureImportance = null;
    this.cvFolds = null;
    this.cvAccuracies = null;

    // Upgrade #5: Confidence Calibration
    this.calibrationMap = null;  // Array of {rawProb, calibratedProb} breakpoints

    // Upgrade #4: Feature Selection
    this.selectedFeatureIndices = null;  // If set, only use these feature indices
  }

  /**
   * Train the ensemble on labeled data
   * @param {number[][]} features2D - N samples x M features
   * @param {number[]} labels - 0 (DOWN) or 1 (UP)
   * @param {object} options - { validationSplit, modelType, crossValidate, nFolds, purgeGap }
   * @returns {object} Training metrics
   */
  train(features2D, labels, options = {}) {
    const validationSplit = options.validationSplit || 0.2;
    const modelType = options.modelType || 'ensemble';
    const crossValidate = options.crossValidate || false;
    const nFolds = options.nFolds || 5;
    const purgeGap = options.purgeGap || 5;

    if (features2D.length !== labels.length) {
      throw new Error('Features and labels must have same length');
    }

    this.sampleCount = features2D.length;

    // Clean features (replace NaN/Infinity)
    const cleanedFeatures = features2D.map(row =>
      row.map(val => isNaN(val) || !isFinite(val) ? 0 : val)
    );

    // Scale features on ALL data (consistent scaling across folds)
    const scaledFeatures = this.scaler.fitTransform(cleanedFeatures);

    // Calculate class weights from full label distribution
    const classWeights = calculateClassWeights(labels);

    const n = scaledFeatures.length;
    const useCrossValidation = crossValidate && n >= 200;

    // ========================================================================
    // PATH A: Walk-Forward Cross-Validation (≥200 samples)
    // ========================================================================
    if (useCrossValidation) {
      console.log(`[MLEngine] Walk-forward CV: ${nFolds} folds, ${n} samples, purgeGap=${purgeGap}`);

      // Expanding-window fold boundaries (dynamically generated for nFolds)
      // Each fold trains on [0..trainEnd], validates on (trainEnd+gap..valEnd]
      const foldBoundaries = [];
      const startPct = 0.40; // First fold trains on 40% of data
      const step = (1.0 - startPct) / nFolds;
      for (let f = 0; f < nFolds; f++) {
        const trainEnd = startPct + f * step;
        const valEnd = Math.min(trainEnd + step, 1.0);
        foldBoundaries.push({ trainEnd, valStart: trainEnd, valEnd });
      }

      const cvAccuracies = [];
      let validFolds = 0;
      const allOofPredictions = [];  // Out-of-fold predictions for calibration
      const allOofLabels = [];

      for (let fold = 0; fold < nFolds; fold++) {
        const bounds = foldBoundaries[fold];
        const trainEndIdx = Math.floor(n * bounds.trainEnd);
        const valStartIdx = Math.floor(n * bounds.valStart) + purgeGap;
        const valEndIdx = Math.floor(n * bounds.valEnd);

        // Check minimum sizes
        if (trainEndIdx < 50 || (valEndIdx - valStartIdx) < 15) {
          console.log(`[MLEngine] CV fold ${fold}: skipped (train=${trainEndIdx}, val=${valEndIdx - valStartIdx})`);
          continue;
        }

        const foldTrainFeatures = scaledFeatures.slice(0, trainEndIdx);
        const foldTrainLabels = labels.slice(0, trainEndIdx);
        const foldValFeatures = scaledFeatures.slice(valStartIdx, valEndIdx);
        const foldValLabels = labels.slice(valStartIdx, valEndIdx);

        if (foldValFeatures.length < 15) {
          console.log(`[MLEngine] CV fold ${fold}: skipped after purge gap (val=${foldValFeatures.length})`);
          continue;
        }

        const foldWeights = foldTrainLabels.map(label => classWeights[label]);
        const foldResult = this._evaluateFold(foldTrainFeatures, foldTrainLabels, foldValFeatures, foldValLabels, foldWeights);

        cvAccuracies.push(foldResult);
        validFolds++;

        // Collect OOF predictions for calibration
        if (foldResult.oofPredictions) {
          allOofPredictions.push(...foldResult.oofPredictions);
          allOofLabels.push(...foldValLabels);
        }

        console.log(`[MLEngine] CV fold ${fold}: RF=${foldResult.rfAcc.toFixed(3)}, GB=${foldResult.gbAcc.toFixed(3)}, LR=${foldResult.lrAcc.toFixed(3)}`);
      }

      // Need at least 2 valid folds for meaningful averaging
      if (validFolds < 2) {
        console.log('[MLEngine] Insufficient valid CV folds, falling back to single split');
        return this._trainSingleSplit(scaledFeatures, labels, classWeights, modelType);
      }

      // Average per-model accuracies across folds → ensemble weights
      const avgRF = cvAccuracies.reduce((s, f) => s + f.rfAcc, 0) / validFolds;
      const avgGB = cvAccuracies.reduce((s, f) => s + f.gbAcc, 0) / validFolds;
      const avgLR = cvAccuracies.reduce((s, f) => s + f.lrAcc, 0) / validFolds;

      // LSTM weight is 0 unless externally set after training
      const totalAcc = avgRF + avgGB + avgLR;
      this.modelWeights = {
        rf: totalAcc > 0 ? avgRF / totalAcc : 1 / 3,
        gb: totalAcc > 0 ? avgGB / totalAcc : 1 / 3,
        lr: totalAcc > 0 ? avgLR / totalAcc : 1 / 3,
        lstm: 0  // Set externally if LSTM is trained
      };

      // Averaged validation accuracy across folds (weighted ensemble estimate)
      this.validationAccuracy = avgRF * this.modelWeights.rf + avgGB * this.modelWeights.gb + avgLR * this.modelWeights.lr;

      // Build calibration map from OOF predictions (Upgrade #5)
      if (allOofPredictions.length >= 200) {
        this._buildCalibrationMap(allOofPredictions, allOofLabels);
        if (this.calibrationMap) {
          console.log(`[MLEngine] Calibration map built: ${this.calibrationMap.length} bins from ${allOofPredictions.length} OOF predictions`);
        }
      }

      console.log(`[MLEngine] CV weights: RF=${this.modelWeights.rf.toFixed(3)}, GB=${this.modelWeights.gb.toFixed(3)}, LR=${this.modelWeights.lr.toFixed(3)}`);
      console.log(`[MLEngine] CV avgValAcc=${this.validationAccuracy.toFixed(3)} (${validFolds} folds)`);

      // Train final models on ALL data for maximum prediction power
      const allWeights = labels.map(label => classWeights[label]);

      console.log('[MLEngine] Training final models on all data...');
      this.randomForest = new RandomForest({
        nTrees: this.config.nTrees,
        maxDepth: this.config.maxDepth,
        minSamples: this.config.minSamples,
        seed: this.config.seed
      });
      this.randomForest.fit(scaledFeatures, labels, allWeights);

      this.gradientBoosted = new GradientBoostedTrees({
        nEstimators: this.config.nEstimators,
        learningRate: this.config.learningRate,
        maxDepth: this.config.maxDepth,
        minSamples: this.config.minSamples,
        seed: this.config.seed + 1
      });
      this.gradientBoosted.fit(scaledFeatures, labels, allWeights);

      this.logisticRegression = new LogisticRegression({
        learningRate: 0.01,
        maxIterations: 1000,
        l2Lambda: 0.1
      });
      this.logisticRegression.fit(scaledFeatures, labels, allWeights);

      // Feature importance from the final RF (trained on all data)
      this.featureImportance = this.randomForest.featureImportances;

      // Mark as trained so ensemble predict() works for evaluation
      this.isTrained = true;

      // Training accuracy on full data
      const trainMetrics = this.evaluate(scaledFeatures, labels);
      this.accuracy = trainMetrics.accuracy;
      this.trainedAt = new Date().toISOString();
      this.cvFolds = validFolds;
      this.cvAccuracies = cvAccuracies;

      console.log('[MLEngine] Training complete (CV)!', {
        trainAccuracy: this.accuracy,
        validationAccuracy: this.validationAccuracy,
        cvFolds: validFolds
      });

      return {
        accuracy: this.accuracy,
        validationAccuracy: this.validationAccuracy,
        precision: trainMetrics.precision,
        recall: trainMetrics.recall,
        f1: trainMetrics.f1,
        featureImportance: this.featureImportance,
        confusionMatrix: trainMetrics.confusionMatrix,
        cvFolds: validFolds,
        cvAccuracies,
        modelWeights: { ...this.modelWeights }
      };
    }

    // ========================================================================
    // PATH B: Single 80/20 Split (fallback for <200 samples or CV disabled)
    // ========================================================================
    if (crossValidate && n < 200) {
      console.log(`[MLEngine] Insufficient data for CV (${n} < 200), using single split`);
    }
    return this._trainSingleSplit(scaledFeatures, labels, classWeights, modelType);
  }

  /**
   * Original single-split training logic (fallback / cold-start path)
   * @param {number[][]} scaledFeatures - Already-scaled features
   * @param {number[]} labels - 0/1 labels
   * @param {object} classWeights - Class weight mapping
   * @param {string} modelType - Model type string
   * @returns {object} Training metrics
   */
  _trainSingleSplit(scaledFeatures, labels, classWeights, modelType) {
    const validationSplit = 0.2;
    const splitIndex = Math.floor(scaledFeatures.length * (1 - validationSplit));
    const trainFeatures = scaledFeatures.slice(0, splitIndex);
    const trainLabels = labels.slice(0, splitIndex);
    const valFeatures = scaledFeatures.slice(splitIndex);
    const valLabels = labels.slice(splitIndex);

    const sampleWeights = trainLabels.map(label => classWeights[label]);

    console.log('[MLEngine] Training started (single split)...', {
      totalSamples: scaledFeatures.length,
      trainSamples: trainFeatures.length,
      valSamples: valFeatures.length,
      classWeights,
      modelType
    });

    // Train Random Forest
    console.log('[MLEngine] Training Random Forest...');
    this.randomForest = new RandomForest({
      nTrees: this.config.nTrees,
      maxDepth: this.config.maxDepth,
      minSamples: this.config.minSamples,
      seed: this.config.seed
    });
    this.randomForest.fit(trainFeatures, trainLabels, sampleWeights);
    const rfMetrics = this.evaluate(valFeatures, valLabels, this.randomForest);
    console.log('[MLEngine] Random Forest validation accuracy:', rfMetrics.accuracy);

    // Train Gradient Boosted Trees
    console.log('[MLEngine] Training Gradient Boosted Trees...');
    this.gradientBoosted = new GradientBoostedTrees({
      nEstimators: this.config.nEstimators,
      learningRate: this.config.learningRate,
      maxDepth: this.config.maxDepth,
      minSamples: this.config.minSamples,
      seed: this.config.seed + 1
    });
    this.gradientBoosted.fit(trainFeatures, trainLabels, sampleWeights);
    const gbMetrics = this.evaluate(valFeatures, valLabels, this.gradientBoosted);
    console.log('[MLEngine] Gradient Boosted validation accuracy:', gbMetrics.accuracy);

    // Train Logistic Regression
    console.log('[MLEngine] Training Logistic Regression...');
    this.logisticRegression = new LogisticRegression({
      learningRate: 0.01,
      maxIterations: 1000,
      l2Lambda: 0.1
    });
    this.logisticRegression.fit(trainFeatures, trainLabels, sampleWeights);
    const lrMetrics = this.evaluate(valFeatures, valLabels, this.logisticRegression);
    console.log('[MLEngine] Logistic Regression validation accuracy:', lrMetrics.accuracy);

    // Calculate ensemble weights based on validation accuracy
    const totalAcc = rfMetrics.accuracy + gbMetrics.accuracy + lrMetrics.accuracy;
    this.modelWeights = {
      rf: totalAcc > 0 ? rfMetrics.accuracy / totalAcc : 1 / 3,
      gb: totalAcc > 0 ? gbMetrics.accuracy / totalAcc : 1 / 3,
      lr: totalAcc > 0 ? lrMetrics.accuracy / totalAcc : 1 / 3
    };

    console.log('[MLEngine] Model weights:', this.modelWeights);

    // Mark as trained so ensemble predict() works for evaluation
    this.isTrained = true;

    // Evaluate ensemble on validation set
    const ensembleMetrics = this.evaluate(valFeatures, valLabels);

    // Evaluate on full training set for training accuracy
    const trainMetrics = this.evaluate(trainFeatures, trainLabels);

    this.accuracy = trainMetrics.accuracy;
    this.validationAccuracy = ensembleMetrics.accuracy;
    this.trainedAt = new Date().toISOString();
    this.cvFolds = null;
    this.cvAccuracies = null;

    // Feature importance from Random Forest (best at this)
    this.featureImportance = this.randomForest.featureImportances;

    console.log('[MLEngine] Training complete!', {
      trainAccuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      precision: ensembleMetrics.precision,
      recall: ensembleMetrics.recall,
      f1: ensembleMetrics.f1
    });

    return {
      accuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      precision: ensembleMetrics.precision,
      recall: ensembleMetrics.recall,
      f1: ensembleMetrics.f1,
      featureImportance: this.featureImportance,
      confusionMatrix: ensembleMetrics.confusionMatrix,
      cvFolds: null,
      cvAccuracies: null,
      modelWeights: { ...this.modelWeights }
    };
  }

  /**
   * Evaluate a single CV fold: create temporary models, train, and return per-model accuracies.
   * @param {number[][]} trainFeatures - Scaled training features for this fold
   * @param {number[]} trainLabels - Training labels for this fold
   * @param {number[][]} valFeatures - Scaled validation features for this fold
   * @param {number[]} valLabels - Validation labels for this fold
   * @param {number[]} sampleWeights - Per-sample weights for training data
   * @returns {object} { rfAcc, gbAcc, lrAcc, ensembleAcc }
   */
  _evaluateFold(trainFeatures, trainLabels, valFeatures, valLabels, sampleWeights) {
    // Temporary Random Forest
    const foldRF = new RandomForest({
      nTrees: this.config.nTrees,
      maxDepth: this.config.maxDepth,
      minSamples: this.config.minSamples,
      seed: this.config.seed
    });
    foldRF.fit(trainFeatures, trainLabels, sampleWeights);
    const rfAcc = this.evaluate(valFeatures, valLabels, foldRF).accuracy;

    // Temporary Gradient Boosted Trees
    const foldGB = new GradientBoostedTrees({
      nEstimators: this.config.nEstimators,
      learningRate: this.config.learningRate,
      maxDepth: this.config.maxDepth,
      minSamples: this.config.minSamples,
      seed: this.config.seed + 1
    });
    foldGB.fit(trainFeatures, trainLabels, sampleWeights);
    const gbAcc = this.evaluate(valFeatures, valLabels, foldGB).accuracy;

    // Temporary Logistic Regression
    const foldLR = new LogisticRegression({
      learningRate: 0.01,
      maxIterations: 1000,
      l2Lambda: 0.1
    });
    foldLR.fit(trainFeatures, trainLabels, sampleWeights);
    const lrAcc = this.evaluate(valFeatures, valLabels, foldLR).accuracy;

    // Collect OOF ensemble predictions for calibration
    const oofPredictions = valFeatures.map(f => {
      const rfP = foldRF.predictProba(f);
      const gbP = foldGB.predictProba(f);
      const lrP = foldLR.predictProba(f);
      const totalA = rfAcc + gbAcc + lrAcc;
      const wRF = totalA > 0 ? rfAcc / totalA : 1/3;
      const wGB = totalA > 0 ? gbAcc / totalA : 1/3;
      const wLR = totalA > 0 ? lrAcc / totalA : 1/3;
      return wRF * rfP[1] + wGB * gbP[1] + wLR * lrP[1];
    });

    return { rfAcc, gbAcc, lrAcc, oofPredictions };
  }

  // ========================================================================
  // UPGRADE #1: Incremental/Online Learning
  // ========================================================================

  /**
   * Incrementally update models with new data without full retrain
   * @param {number[][]} newFeatures - New feature vectors
   * @param {number[]} newLabels - New labels (0/1)
   */
  incrementalUpdate(newFeatures, newLabels) {
    if (!this.isTrained || !newFeatures.length) return;

    try {
      const cleanedFeatures = newFeatures.map(row =>
        row.map(val => isNaN(val) || !isFinite(val) ? 0 : val)
      );
      const scaledFeatures = this.scaler.transform(cleanedFeatures);
      const classWeights = calculateClassWeights(newLabels);
      const sampleWeights = newLabels.map(label => classWeights[label]);

      // RF: train 10 new trees on recent data, append, retire oldest if >200 trees
      if (this.randomForest) {
        const numFeatures = scaledFeatures[0].length;
        const maxFeaturesPerTree = Math.floor(Math.sqrt(numFeatures));
        const rng = new SeededRandom(Date.now());

        for (let i = 0; i < 10; i++) {
          const bootstrapSize = Math.floor(scaledFeatures.length * 0.7);
          const indices = [];
          for (let j = 0; j < bootstrapSize; j++) {
            indices.push(rng.nextInt(0, scaledFeatures.length));
          }
          const bsFeatures = indices.map(idx => scaledFeatures[idx]);
          const bsLabels = indices.map(idx => newLabels[idx]);
          const bsWeights = indices.map(idx => sampleWeights[idx]);

          const tree = new DecisionTree({
            maxDepth: this.config.maxDepth,
            minSamples: this.config.minSamples,
            maxFeatures: maxFeaturesPerTree,
            random: rng
          });
          tree.fit(bsFeatures, bsLabels, bsWeights);
          this.randomForest.trees.push(tree);
        }

        // Retire oldest trees if >200
        while (this.randomForest.trees.length > 200) {
          this.randomForest.trees.shift();
        }
      }

      // GBT: add 20 new boosting rounds
      if (this.gradientBoosted && this.gradientBoosted.trees) {
        const gbt = this.gradientBoosted;
        let predictions = scaledFeatures.map(f => {
          let pred = gbt.initialPrediction;
          for (const tree of gbt.trees) {
            pred += gbt.learningRate * gbt._predictRegressionTree(tree, f);
          }
          return pred;
        });

        for (let i = 0; i < 20; i++) {
          const residuals = newLabels.map((label, idx) => {
            const prob = sigmoid(predictions[idx]);
            return label - prob;
          });
          const rTree = gbt._buildRegressionTree(scaledFeatures, residuals, sampleWeights, 0);
          gbt.trees.push(rTree);

          for (let j = 0; j < predictions.length; j++) {
            predictions[j] += gbt.learningRate * gbt._predictRegressionTree(rTree, scaledFeatures[j]);
          }
        }
      }

      // LR: run 100 gradient descent iterations from current weights
      if (this.logisticRegression && this.logisticRegression.weights) {
        const lr = this.logisticRegression;
        for (let iter = 0; iter < 100; iter++) {
          const numFeatures = scaledFeatures[0].length;
          let gradWeights = new Array(numFeatures).fill(0);
          let gradBias = 0;

          for (let i = 0; i < scaledFeatures.length; i++) {
            const z = lr._computeZ(scaledFeatures[i]);
            const prob = sigmoid(z);
            const error = (prob - newLabels[i]) * sampleWeights[i];
            for (let j = 0; j < numFeatures; j++) {
              gradWeights[j] += error * scaledFeatures[i][j];
            }
            gradBias += error;
          }

          for (let j = 0; j < numFeatures; j++) {
            gradWeights[j] += lr.l2Lambda * lr.weights[j];
            lr.weights[j] -= lr.learningRate * gradWeights[j] / scaledFeatures.length;
          }
          lr.bias -= lr.learningRate * gradBias / scaledFeatures.length;
        }
      }

      console.log(`[MLEngine] Incremental update: ${newFeatures.length} samples applied`);
    } catch (err) {
      console.error('[MLEngine] Incremental update error:', err.message);
    }
  }

  // ========================================================================
  // UPGRADE #5: Confidence Calibration (Isotonic Regression)
  // ========================================================================

  /**
   * Build calibration map from raw probabilities and true labels
   * @param {number[]} rawProbs - Raw P(UP) probabilities
   * @param {number[]} trueLabels - True 0/1 labels
   */
  _buildCalibrationMap(rawProbs, trueLabels) {
    if (!rawProbs || rawProbs.length < 200) {
      this.calibrationMap = null;
      return;
    }

    // Bin raw probabilities into 20 bins
    const nBins = 20;
    const bins = Array.from({ length: nBins }, () => ({ probs: [], labels: [] }));

    for (let i = 0; i < rawProbs.length; i++) {
      const binIdx = Math.min(Math.floor(rawProbs[i] * nBins), nBins - 1);
      bins[binIdx].probs.push(rawProbs[i]);
      bins[binIdx].labels.push(trueLabels[i]);
    }

    // Compute empirical P(UP) per bin
    this.calibrationMap = [];
    for (let i = 0; i < nBins; i++) {
      if (bins[i].labels.length > 0) {
        const rawMean = bins[i].probs.reduce((a, b) => a + b, 0) / bins[i].probs.length;
        const empirical = bins[i].labels.reduce((a, b) => a + b, 0) / bins[i].labels.length;
        this.calibrationMap.push({ rawProb: rawMean, calibratedProb: empirical });
      }
    }

    // Sort by rawProb for interpolation
    this.calibrationMap.sort((a, b) => a.rawProb - b.rawProb);

    if (this.calibrationMap.length < 3) {
      this.calibrationMap = null;  // Not enough bins populated
    }
  }

  /**
   * Apply calibration to a raw probability
   * @param {number} rawProb - Raw probability from ensemble
   * @returns {number} Calibrated probability
   */
  _calibrate(rawProb) {
    if (!this.calibrationMap || this.calibrationMap.length < 3) {
      return rawProb;  // Identity fallback
    }

    // Piecewise linear interpolation
    const map = this.calibrationMap;
    if (rawProb <= map[0].rawProb) return map[0].calibratedProb;
    if (rawProb >= map[map.length - 1].rawProb) return map[map.length - 1].calibratedProb;

    for (let i = 0; i < map.length - 1; i++) {
      if (rawProb >= map[i].rawProb && rawProb <= map[i + 1].rawProb) {
        const t = (rawProb - map[i].rawProb) / (map[i + 1].rawProb - map[i].rawProb);
        return map[i].calibratedProb + t * (map[i + 1].calibratedProb - map[i].calibratedProb);
      }
    }

    return rawProb;
  }

  /**
   * Set the LSTM model instance (injected from lstmEngine.js)
   * @param {object} lstmModel - LSTMNetwork instance with predict() method
   */
  setLSTMModel(lstmModel) {
    this.lstmModel = lstmModel;
  }

  /**
   * Set feature selection mask
   * @param {number[]} indices - Array of selected feature indices
   */
  setSelectedFeatureIndices(indices) {
    this.selectedFeatureIndices = indices;
  }

  /**
   * Apply feature mask to a feature vector
   * @param {number[]} features - Full feature vector
   * @returns {number[]} Filtered feature vector (or original if no mask)
   */
  _applyFeatureMask(features) {
    if (!this.selectedFeatureIndices) return features;
    return this.selectedFeatureIndices.map(i => features[i] !== undefined ? features[i] : 0);
  }

  /**
   * Predict single sample
   * @param {number[]} features - Feature vector
   * @returns {object} { prediction: 'UP'|'DOWN', confidence: 0-1, probabilities: { up, down } }
   */
  predict(features) {
    if (!this.isTrained) {
      throw new Error('Model not trained yet');
    }

    // Clean and scale features (scaler trained on full feature set)
    const cleanedFeatures = features.map(val => isNaN(val) || !isFinite(val) ? 0 : val);
    const scaledFeatures = this.scaler.transformRow(cleanedFeatures);

    // Apply feature mask AFTER scaling if feature selection is active (Upgrade #4)
    const finalFeatures = this._applyFeatureMask(scaledFeatures);

    // Get predictions from all models
    const rfProba = this.randomForest.predictProba(finalFeatures);
    const gbProba = this.gradientBoosted.predictProba(finalFeatures);
    const lrProba = this.logisticRegression.predictProba(finalFeatures);

    // Weighted ensemble (3 or 4 models depending on LSTM availability)
    let downProb =
      this.modelWeights.rf * rfProba[0] +
      this.modelWeights.gb * gbProba[0] +
      this.modelWeights.lr * lrProba[0];

    let upProb =
      this.modelWeights.rf * rfProba[1] +
      this.modelWeights.gb * gbProba[1] +
      this.modelWeights.lr * lrProba[1];

    // Include LSTM if available and has weight
    if (this.lstmModel && this.modelWeights.lstm > 0 && this._lastSequence) {
      try {
        const lstmProb = this.lstmModel.predict(this._lastSequence);
        upProb += this.modelWeights.lstm * lstmProb;
        downProb += this.modelWeights.lstm * (1 - lstmProb);
      } catch (e) {
        // LSTM prediction failed, redistribute weight to other models
        const rescale = 1 / (1 - this.modelWeights.lstm);
        upProb *= rescale;
        downProb *= rescale;
      }
    }

    // Normalize probabilities
    const total = upProb + downProb;
    if (total > 0) {
      upProb /= total;
      downProb /= total;
    }

    // Apply calibration (Upgrade #5)
    upProb = this._calibrate(upProb);
    downProb = 1 - upProb;

    const prediction = upProb >= 0.5 ? 1 : 0;
    const confidence = Math.max(upProb, downProb);

    return {
      prediction: prediction === 1 ? 'UP' : 'DOWN',
      confidence,
      probabilities: {
        up: upProb,
        down: downProb
      }
    };
  }

  /**
   * Set the last feature sequence for LSTM prediction
   * @param {number[][]} sequence - Last N feature vectors (e.g. 20×83)
   */
  setLastSequence(sequence) {
    this._lastSequence = sequence;
  }

  /**
   * Predict batch of samples
   * @param {number[][]} features2D - N samples x M features
   * @returns {object[]} Array of predictions
   */
  predictBatch(features2D) {
    return features2D.map(features => this.predict(features));
  }

  /**
   * Evaluate model on test data
   * @param {number[][]} features2D - Test features
   * @param {number[]} labels - True labels
   * @param {object} model - Specific model to evaluate (or ensemble if not provided)
   * @returns {object} Metrics
   */
  evaluate(features2D, labels, model = null) {
    let predictions;

    if (model) {
      predictions = features2D.map(features => model.predict(features));
    } else {
      predictions = features2D.map(features => {
        const result = this.predict(features);
        return result.prediction === 'UP' ? 1 : 0;
      });
    }

    // Confusion matrix
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 1 && predictions[i] === 1) tp++;
      else if (labels[i] === 0 && predictions[i] === 1) fp++;
      else if (labels[i] === 0 && predictions[i] === 0) tn++;
      else if (labels[i] === 1 && predictions[i] === 0) fn++;
    }

    const accuracy = (tp + tn) / labels.length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

    return {
      accuracy,
      precision,
      recall,
      f1,
      confusionMatrix: { tp, fp, tn, fn }
    };
  }

  /**
   * Get model status
   * @returns {object} Status info
   */
  getModelStatus() {
    return {
      isTrained: this.isTrained,
      accuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      sampleCount: this.sampleCount,
      featureImportance: this.featureImportance,
      modelType: 'ensemble',
      trainedAt: this.trainedAt,
      modelWeights: this.modelWeights
    };
  }

  /**
   * Serialize model to JSON
   * @returns {string} JSON string
   */
  serialize() {
    if (!this.isTrained) {
      throw new Error('Cannot serialize untrained model');
    }

    // Serialize tree node recursively (compact keys to save space)
    const serializeNode = (node) => {
      if (!node) return null;
      if (node.isLeaf()) {
        return { v: node.value, s: node.samples };
      }
      return {
        f: node.featureIndex,
        t: node.threshold,
        l: serializeNode(node.left),
        r: serializeNode(node.right),
        s: node.samples,
      };
    };

    const serializeTree = (tree) => ({
      maxDepth: tree.maxDepth,
      minSamples: tree.minSamples,
      maxFeatures: tree.maxFeatures,
      root: serializeNode(tree.root),
      featureImportances: tree.featureImportances,
    });

    return JSON.stringify({
      version: 2, // v2 includes full tree serialization
      config: this.config,
      scaler: { means: this.scaler.means, stds: this.scaler.stds },
      modelWeights: this.modelWeights,
      featureImportance: this.featureImportance,
      accuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      sampleCount: this.sampleCount,
      trainedAt: this.trainedAt,
      // Full model serialization
      randomForest: this.randomForest ? {
        nTrees: this.randomForest.nTrees,
        trees: this.randomForest.trees.map(serializeTree),
        featureImportances: this.randomForest.featureImportances,
      } : null,
      gbt: this.gradientBoosted ? {
        nEstimators: this.gradientBoosted.nEstimators,
        learningRate: this.gradientBoosted.learningRate,
        maxDepth: this.gradientBoosted.maxDepth,
        initialPrediction: this.gradientBoosted.initialPrediction,
        trees: this.gradientBoosted.trees.map(serializeNode), // GBT trees are raw nodes
      } : null,
      lr: this.logisticRegression ? {
        weights: this.logisticRegression.weights,
        bias: this.logisticRegression.bias,
      } : null,
    });
  }

  /**
   * Deserialize model from JSON (supports v1 metadata-only and v2 full models)
   * @param {string} json - JSON string
   */
  deserialize(json) {
    const data = JSON.parse(json);

    this.config = data.config;
    this.scaler.means = data.scaler.means;
    this.scaler.stds = data.scaler.stds;
    this.modelWeights = data.modelWeights;
    this.featureImportance = data.featureImportance;
    this.accuracy = data.accuracy;
    this.validationAccuracy = data.validationAccuracy;
    this.sampleCount = data.sampleCount;
    this.trainedAt = data.trainedAt;

    // v2: Full tree deserialization
    if (data.version >= 2 && data.randomForest) {
      const deserializeNode = (obj) => {
        if (!obj) return null;
        const node = new DecisionTreeNode();
        node.samples = obj.s || 0;
        if (obj.v !== undefined) {
          // Leaf node
          node.value = obj.v;
        } else {
          // Internal node
          node.featureIndex = obj.f;
          node.threshold = obj.t;
          node.left = deserializeNode(obj.l);
          node.right = deserializeNode(obj.r);
        }
        return node;
      };

      const deserializeTree = (treeObj) => {
        const tree = new DecisionTree({
          maxDepth: treeObj.maxDepth,
          minSamples: treeObj.minSamples,
          maxFeatures: treeObj.maxFeatures,
        });
        tree.root = deserializeNode(treeObj.root);
        tree.featureImportances = treeObj.featureImportances;
        return tree;
      };

      // Restore Random Forest
      this.randomForest = new RandomForest({ nTrees: data.randomForest.nTrees });
      this.randomForest.trees = data.randomForest.trees.map(deserializeTree);
      this.randomForest.featureImportances = data.randomForest.featureImportances;

      // Restore GBT (trees are raw DecisionTreeNode roots, not DecisionTree instances)
      if (data.gbt) {
        this.gradientBoosted = new GradientBoostedTrees({
          nEstimators: data.gbt.nEstimators,
          learningRate: data.gbt.learningRate,
          maxDepth: data.gbt.maxDepth || 6,
        });
        this.gradientBoosted.initialPrediction = data.gbt.initialPrediction;
        this.gradientBoosted.trees = data.gbt.trees.map(deserializeNode);
      }

      // Restore LR
      if (data.lr) {
        this.logisticRegression = new LogisticRegression();
        this.logisticRegression.weights = data.lr.weights;
        this.logisticRegression.bias = data.lr.bias;
      }

      this.isTrained = true;
      const rfCount = this.randomForest?.trees?.length || 0;
      const gbtCount = this.gradientBoosted?.trees?.length || 0;
      console.log(`[MLEngine] Full model restored: RF(${rfCount} trees) + GBT(${gbtCount} trees) + LR, accuracy=${this.accuracy}`);
    } else {
      // v1: metadata only, needs retraining
      this.isTrained = false;
      console.log('[MLEngine] Model metadata loaded (v1), retraining required');
    }
  }

  /**
   * Clone this MLEngine instance (creates a new engine with same config)
   * Used for creating Bear model from Bull model structure.
   * Note: the clone is untrained — you must call train() on it separately.
   * @returns {MLEngine} New MLEngine instance with same config
   */
  clone() {
    return new MLEngine({ ...this.config });
  }

  /**
   * Get comprehensive model stats for monitoring
   * @returns {object} Model stats
   */
  getModelStats() {
    return {
      isTrained: this.isTrained,
      trainedAt: this.trainedAt,
      accuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      sampleCount: this.sampleCount,
      modelWeights: this.modelWeights,
      featureImportance: this.featureImportance,
      hasRandomForest: !!this.randomForest,
      hasGradientBoosted: !!this.gradientBoosted,
      hasLogisticRegression: !!this.logisticRegression,
      hasLSTM: !!this.lstmModel,
      hasCalibration: !!this.calibrationMap,
      calibrationBins: this.calibrationMap ? this.calibrationMap.length : 0,
      selectedFeatureCount: this.selectedFeatureIndices ? this.selectedFeatureIndices.length : null,
      rfTreeCount: this.randomForest ? this.randomForest.trees.length : 0,
      gbtTreeCount: this.gradientBoosted ? this.gradientBoosted.trees.length : 0,
      config: this.config,
      cvFolds: this.cvFolds,
      cvAccuracies: this.cvAccuracies,
    };
  }

  /**
   * Get feature importance with names
   * @param {string[]} featureNames - Array of feature names
   * @returns {object} Feature name -> importance mapping
   */
  getFeatureImportance(featureNames = null) {
    if (!this.featureImportance) {
      return {};
    }

    if (!featureNames) {
      // Return as array if no names provided
      return this.featureImportance.map((importance, index) => ({
        index,
        importance
      }));
    }

    const importance = {};
    for (let i = 0; i < this.featureImportance.length && i < featureNames.length; i++) {
      importance[featureNames[i]] = this.featureImportance[i];
    }
    return importance;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { MLEngine };
export default MLEngine;
