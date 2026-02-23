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
    return row.map((val, i) => {
      const cleaned = isNaN(val) || !isFinite(val) ? 0 : val;
      return (cleaned - this.means[i]) / this.stds[i];
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
      nTrees: config.nTrees || 50,
      maxDepth: config.maxDepth || 10,
      learningRate: config.learningRate || 0.1,
      minSamples: config.minSamples || 5,
      nEstimators: config.nEstimators || 100,
      seed: config.seed || 42
    };

    this.scaler = new FeatureScaler();
    this.randomForest = null;
    this.gradientBoosted = null;
    this.logisticRegression = null;

    this.isTrained = false;
    this.trainedAt = null;
    this.accuracy = 0;
    this.validationAccuracy = 0;
    this.sampleCount = 0;
    this.modelWeights = { rf: 0, gb: 0, lr: 0 };
    this.featureImportance = null;
  }

  /**
   * Train the ensemble on labeled data
   * @param {number[][]} features2D - N samples x M features
   * @param {number[]} labels - 0 (DOWN) or 1 (UP)
   * @param {object} options - { validationSplit: 0.2, modelType: 'ensemble' }
   * @returns {object} Training metrics
   */
  train(features2D, labels, options = {}) {
    const validationSplit = options.validationSplit || 0.2;
    const modelType = options.modelType || 'ensemble';

    if (features2D.length !== labels.length) {
      throw new Error('Features and labels must have same length');
    }

    this.sampleCount = features2D.length;

    // Clean features (replace NaN/Infinity)
    const cleanedFeatures = features2D.map(row =>
      row.map(val => isNaN(val) || !isFinite(val) ? 0 : val)
    );

    // Scale features
    const scaledFeatures = this.scaler.fitTransform(cleanedFeatures);

    // Split train/validation
    const splitIndex = Math.floor(scaledFeatures.length * (1 - validationSplit));
    const trainFeatures = scaledFeatures.slice(0, splitIndex);
    const trainLabels = labels.slice(0, splitIndex);
    const valFeatures = scaledFeatures.slice(splitIndex);
    const valLabels = labels.slice(splitIndex);

    // Calculate class weights
    const classWeights = calculateClassWeights(trainLabels);
    const sampleWeights = trainLabels.map(label => classWeights[label]);

    console.log('[MLEngine] Training started...', {
      totalSamples: features2D.length,
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
      rf: rfMetrics.accuracy / totalAcc,
      gb: gbMetrics.accuracy / totalAcc,
      lr: lrMetrics.accuracy / totalAcc
    };

    console.log('[MLEngine] Model weights:', this.modelWeights);

    // Evaluate ensemble on validation set
    const ensembleMetrics = this.evaluate(valFeatures, valLabels);

    // Evaluate on full training set for training accuracy
    const trainMetrics = this.evaluate(trainFeatures, trainLabels);

    this.accuracy = trainMetrics.accuracy;
    this.validationAccuracy = ensembleMetrics.accuracy;
    this.isTrained = true;
    this.trainedAt = new Date().toISOString();

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
      confusionMatrix: ensembleMetrics.confusionMatrix
    };
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

    // Clean and scale features
    const cleanedFeatures = features.map(val => isNaN(val) || !isFinite(val) ? 0 : val);
    const scaledFeatures = this.scaler.transformRow(cleanedFeatures);

    // Get predictions from all models
    const rfProba = this.randomForest.predictProba(scaledFeatures);
    const gbProba = this.gradientBoosted.predictProba(scaledFeatures);
    const lrProba = this.logisticRegression.predictProba(scaledFeatures);

    // Weighted ensemble
    const downProb =
      this.modelWeights.rf * rfProba[0] +
      this.modelWeights.gb * gbProba[0] +
      this.modelWeights.lr * lrProba[0];

    const upProb =
      this.modelWeights.rf * rfProba[1] +
      this.modelWeights.gb * gbProba[1] +
      this.modelWeights.lr * lrProba[1];

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

    return JSON.stringify({
      config: this.config,
      scaler: {
        means: this.scaler.means,
        stds: this.scaler.stds
      },
      modelWeights: this.modelWeights,
      featureImportance: this.featureImportance,
      accuracy: this.accuracy,
      validationAccuracy: this.validationAccuracy,
      sampleCount: this.sampleCount,
      trainedAt: this.trainedAt,
      // Note: Tree structures are complex to serialize, omitted for now
      // In production, would use a more sophisticated serialization format
    });
  }

  /**
   * Deserialize model from JSON
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

    // Note: Would need to deserialize tree structures
    // For now, model needs to be retrained after load
    this.isTrained = false;

    console.log('[MLEngine] Model metadata loaded, retraining required');
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
      config: this.config,
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
