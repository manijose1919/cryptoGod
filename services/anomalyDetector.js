// anomalyDetector.js
// Backend Node.js service implementing Isolation Forest for market anomaly detection
// Pure JavaScript, no native dependencies

/**
 * Seeded PRNG for reproducibility
 */
class SeededRandom {
  constructor(seed = 42) {
    this.seed = seed;
  }

  next() {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  nextInt(min, max) {
    return Math.floor(this.next() * (max - min)) + min;
  }

  nextFloat(min, max) {
    return this.next() * (max - min) + min;
  }

  sample(array, size) {
    const result = [];
    const indices = new Set();
    while (result.length < size && result.length < array.length) {
      const idx = this.nextInt(0, array.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        result.push(array[idx]);
      }
    }
    return result;
  }
}

/**
 * Node in an isolation tree
 */
class IsolationTreeNode {
  constructor(isLeaf = false, pathLength = 0) {
    this.isLeaf = isLeaf;
    this.pathLength = pathLength;
    this.splitFeature = null;
    this.splitValue = null;
    this.left = null;
    this.right = null;
  }
}

/**
 * Single isolation tree
 */
class IsolationTree {
  constructor(maxDepth, rng) {
    this.maxDepth = maxDepth;
    this.rng = rng;
    this.root = null;
  }

  fit(data) {
    this.root = this._buildTree(data, 0);
  }

  _buildTree(data, currentDepth) {
    const n = data.length;

    // Base cases: leaf node
    if (currentDepth >= this.maxDepth || n <= 1) {
      const c = this._averagePathLength(n);
      return new IsolationTreeNode(true, currentDepth + c);
    }

    // Randomly select feature and split value
    const numFeatures = data[0].length;
    const splitFeature = this.rng.nextInt(0, numFeatures);

    // Get min/max for this feature
    let min = Infinity;
    let max = -Infinity;
    for (const point of data) {
      const val = point[splitFeature];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    // If all values are the same, make it a leaf
    if (min === max) {
      const c = this._averagePathLength(n);
      return new IsolationTreeNode(true, currentDepth + c);
    }

    // Random split value between min and max
    const splitValue = this.rng.nextFloat(min, max);

    // Split data
    const leftData = [];
    const rightData = [];
    for (const point of data) {
      if (point[splitFeature] < splitValue) {
        leftData.push(point);
      } else {
        rightData.push(point);
      }
    }

    // Create internal node
    const node = new IsolationTreeNode(false, currentDepth);
    node.splitFeature = splitFeature;
    node.splitValue = splitValue;

    // Recursively build subtrees
    node.left = this._buildTree(leftData, currentDepth + 1);
    node.right = this._buildTree(rightData, currentDepth + 1);

    return node;
  }

  pathLength(point) {
    return this._pathLengthRecursive(point, this.root, 0);
  }

  _pathLengthRecursive(point, node, currentDepth) {
    if (node.isLeaf) {
      return node.pathLength;
    }

    if (point[node.splitFeature] < node.splitValue) {
      return this._pathLengthRecursive(point, node.left, currentDepth + 1);
    } else {
      return this._pathLengthRecursive(point, node.right, currentDepth + 1);
    }
  }

  // Average path length for unsuccessful search in BST of size n
  _averagePathLength(n) {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    const H = Math.log(n - 1) + 0.5772156649; // Euler's constant
    return 2 * H - (2 * (n - 1) / n);
  }
}

/**
 * Isolation Forest
 * Detects anomalies by isolating observations in random trees
 */
class IsolationForest {
  constructor(config = {}) {
    this.nTrees = config.nTrees || 100;
    this.sampleSize = config.sampleSize || 256;
    this.maxDepth = config.maxDepth || Math.ceil(Math.log2(this.sampleSize));
    this.seed = config.seed || 42;
    this.rng = new SeededRandom(this.seed);
    this.trees = [];
    this.trainingSize = 0;
  }

  /**
   * Train the forest on data
   * @param {number[][]} data - N samples x M features
   */
  fit(data) {
    if (!data || data.length === 0) {
      throw new Error('Training data cannot be empty');
    }

    this.trainingSize = data.length;
    this.trees = [];

    const sampleSize = Math.min(this.sampleSize, data.length);

    for (let i = 0; i < this.nTrees; i++) {
      // Random subsample
      const sample = this.rng.sample(data, sampleSize);

      // Build tree
      const tree = new IsolationTree(this.maxDepth, this.rng);
      tree.fit(sample);
      this.trees.push(tree);
    }
  }

  /**
   * Compute anomaly score for a single point
   * @param {number[]} point - Feature vector
   * @returns {number} Anomaly score between 0 and 1 (1 = most anomalous)
   */
  score(point) {
    if (this.trees.length === 0) {
      throw new Error('Forest not trained. Call fit() first.');
    }

    // Average path length across all trees
    let sumPathLength = 0;
    for (const tree of this.trees) {
      sumPathLength += tree.pathLength(point);
    }
    const avgPathLength = sumPathLength / this.trees.length;

    // Normalize to 0-1 scale
    const c = this._averagePathLength(this.sampleSize);
    const score = Math.pow(2, -avgPathLength / c);

    return score;
  }

  /**
   * Compute anomaly scores for multiple points
   * @param {number[][]} data - N samples x M features
   * @returns {number[]} Array of anomaly scores
   */
  scoreBatch(data) {
    return data.map(point => this.score(point));
  }

  /**
   * Check if a point is an anomaly
   * @param {number[]} point - Feature vector
   * @param {number} threshold - Anomaly threshold (default 0.65)
   * @returns {boolean}
   */
  isAnomaly(point, threshold = 0.65) {
    return this.score(point) >= threshold;
  }

  /**
   * Get detailed anomaly information
   * @param {number[]} point - Feature vector
   * @param {number[][]} trainingData - Original training data for z-score calculation
   * @param {string[]} featureNames - Optional feature names
   * @returns {Object}
   */
  getAnomalyDetails(point, trainingData, featureNames = null) {
    const score = this.score(point);
    const isAnomaly = score >= 0.65;

    // Identify anomalous features via z-scores
    const anomalousFeatures = [];
    if (trainingData && trainingData.length > 0) {
      const numFeatures = point.length;

      // Calculate mean and std for each feature
      const means = new Array(numFeatures).fill(0);
      const stds = new Array(numFeatures).fill(0);

      for (let f = 0; f < numFeatures; f++) {
        // Mean
        let sum = 0;
        for (const sample of trainingData) {
          sum += sample[f];
        }
        means[f] = sum / trainingData.length;

        // Std
        let sumSq = 0;
        for (const sample of trainingData) {
          sumSq += Math.pow(sample[f] - means[f], 2);
        }
        stds[f] = Math.sqrt(sumSq / trainingData.length);
      }

      // Calculate z-scores
      for (let f = 0; f < numFeatures; f++) {
        const zScore = stds[f] > 0 ? (point[f] - means[f]) / stds[f] : 0;
        if (Math.abs(zScore) > 2.5) {
          anomalousFeatures.push({
            index: f,
            name: featureNames ? featureNames[f] : `feature_${f}`,
            value: point[f],
            mean: means[f],
            std: stds[f],
            zScore: zScore
          });
        }
      }

      // Sort by absolute z-score (most anomalous first)
      anomalousFeatures.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    }

    return {
      score,
      isAnomaly,
      anomalousFeatures
    };
  }

  _averagePathLength(n) {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    const H = Math.log(n - 1) + 0.5772156649;
    return 2 * H - (2 * (n - 1) / n);
  }
}

/**
 * Market-specific anomaly detector
 * Wraps IsolationForest with market logic
 */
class MarketAnomalyDetector {
  constructor(config = {}) {
    this.forest = new IsolationForest({
      nTrees: config.nTrees || 100,
      sampleSize: config.sampleSize || 256,
      maxDepth: config.maxDepth || 10,
      seed: config.seed || 42
    });

    this.samples = [];
    this.maxSamples = 5000;
    this.minSamplesForTraining = 100;
    this.retrainInterval = 500;
    this.lastRetrained = null;
    this.anomalyCount = 0;
    this.totalChecks = 0;
    this.featureNames = null;

    // Thresholds
    this.normalThreshold = 0.5;
    this.unusualThreshold = 0.65;
  }

  /**
   * Add a sample to the training set
   * @param {number[]} featureVector - Market features (62 features expected)
   */
  addSample(featureVector) {
    if (!Array.isArray(featureVector) || featureVector.length === 0) {
      return;
    }

    this.samples.push([...featureVector]);

    // Memory management: keep max 5000 samples
    if (this.samples.length > this.maxSamples) {
      // Keep newest 4000 + random 1000 from older ones
      const newest = this.samples.slice(-4000);
      const older = this.samples.slice(0, -4000);

      const rng = new SeededRandom(Date.now());
      const randomOlder = rng.sample(older, 1000);

      this.samples = [...randomOlder, ...newest];
    }

    // Auto-retrain when enough new samples
    const samplesSinceRetrain = this.lastRetrained
      ? this.samples.length - this.lastRetrained
      : this.samples.length;

    if (samplesSinceRetrain >= this.retrainInterval &&
        this.samples.length >= this.minSamplesForTraining) {
      this.retrain();
    }
  }

  /**
   * Retrain the forest
   */
  retrain() {
    if (this.samples.length < this.minSamplesForTraining) {
      console.log(`[AnomalyDetector] Not enough samples for training (${this.samples.length}/${this.minSamplesForTraining})`);
      return false;
    }

    try {
      this.forest.fit(this.samples);
      this.lastRetrained = this.samples.length;
      console.log(`[AnomalyDetector] Retrained on ${this.samples.length} samples`);
      return true;
    } catch (error) {
      console.error('[AnomalyDetector] Retrain failed:', error.message);
      return false;
    }
  }

  /**
   * Check if current market conditions are anomalous
   * @param {number[]} featureVector - Current market features
   * @returns {Object}
   */
  checkAnomaly(featureVector) {
    this.totalChecks++;

    // Not enough training data yet
    if (this.samples.length < this.minSamplesForTraining) {
      return {
        isAnomaly: false,
        score: 0,
        severity: 'NORMAL',
        anomalousFeatures: [],
        recommendation: 'PROCEED',
        message: `Collecting data (${this.samples.length}/${this.minSamplesForTraining})`
      };
    }

    // Retrain if not trained yet
    if (!this.lastRetrained) {
      this.retrain();
    }

    try {
      // Get anomaly details
      const details = this.forest.getAnomalyDetails(
        featureVector,
        this.samples,
        this.featureNames
      );

      const score = details.score;
      const isAnomaly = score >= this.unusualThreshold;

      if (isAnomaly) {
        this.anomalyCount++;
      }

      // Determine severity and recommendation
      let severity, recommendation;
      if (score < this.normalThreshold) {
        severity = 'NORMAL';
        recommendation = 'PROCEED';
      } else if (score < this.unusualThreshold) {
        severity = 'UNUSUAL';
        recommendation = 'REDUCE_SIZE';
      } else {
        severity = 'EXTREME';
        recommendation = 'PAUSE';
      }

      return {
        isAnomaly,
        score: Math.round(score * 1000) / 1000,
        severity,
        anomalousFeatures: details.anomalousFeatures.slice(0, 10), // Top 10
        recommendation,
        message: this._generateMessage(severity, details.anomalousFeatures)
      };

    } catch (error) {
      console.error('[AnomalyDetector] Check failed:', error.message);
      return {
        isAnomaly: false,
        score: 0,
        severity: 'NORMAL',
        anomalousFeatures: [],
        recommendation: 'PROCEED',
        message: 'Error checking anomaly'
      };
    }
  }

  /**
   * Generate human-readable message
   */
  _generateMessage(severity, anomalousFeatures) {
    if (severity === 'NORMAL') {
      return 'Market conditions within normal parameters';
    }

    const topFeatures = anomalousFeatures.slice(0, 3)
      .map(f => f.name)
      .join(', ');

    if (severity === 'UNUSUAL') {
      return `Unusual market conditions detected (${topFeatures})`;
    }

    return `Extreme market conditions detected (${topFeatures}) - Exercise caution`;
  }

  /**
   * Set feature names for better reporting
   * @param {string[]} names - Array of feature names (62 expected)
   */
  setFeatureNames(names) {
    this.featureNames = names;
  }

  /**
   * Get detector status
   */
  getStatus() {
    const anomalyRate = this.totalChecks > 0
      ? Math.round((this.anomalyCount / this.totalChecks) * 100) / 100
      : 0;

    return {
      sampleCount: this.samples.length,
      lastRetrained: this.lastRetrained,
      anomalyRate,
      totalChecks: this.totalChecks,
      anomalyCount: this.anomalyCount,
      isTrained: this.lastRetrained !== null
    };
  }

  /**
   * Serialize to JSON
   */
  serialize() {
    return JSON.stringify({
      samples: this.samples,
      lastRetrained: this.lastRetrained,
      anomalyCount: this.anomalyCount,
      totalChecks: this.totalChecks,
      featureNames: this.featureNames,
      config: {
        nTrees: this.forest.nTrees,
        sampleSize: this.forest.sampleSize,
        maxDepth: this.forest.maxDepth,
        seed: this.forest.seed
      }
    });
  }

  /**
   * Deserialize from JSON
   */
  deserialize(json) {
    try {
      const data = JSON.parse(json);

      this.samples = data.samples || [];
      this.lastRetrained = data.lastRetrained || null;
      this.anomalyCount = data.anomalyCount || 0;
      this.totalChecks = data.totalChecks || 0;
      this.featureNames = data.featureNames || null;

      if (data.config) {
        this.forest = new IsolationForest(data.config);
      }

      // Retrain if we have samples
      if (this.samples.length >= this.minSamplesForTraining) {
        this.retrain();
      }

      console.log(`[AnomalyDetector] Loaded ${this.samples.length} samples`);
      return true;
    } catch (error) {
      console.error('[AnomalyDetector] Deserialization failed:', error.message);
      return false;
    }
  }

  /**
   * Reset detector
   */
  reset() {
    this.samples = [];
    this.lastRetrained = null;
    this.anomalyCount = 0;
    this.totalChecks = 0;
    this.forest = new IsolationForest({
      nTrees: this.forest.nTrees,
      sampleSize: this.forest.sampleSize,
      maxDepth: this.forest.maxDepth,
      seed: this.forest.seed
    });
  }
}

// Export classes
export { IsolationForest, MarketAnomalyDetector };

// For CommonJS compatibility
export default MarketAnomalyDetector;
