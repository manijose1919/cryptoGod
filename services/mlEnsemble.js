import { MLEngine } from './mlEngine.js';

/**
 * MLEnsemble - Ensemble of multiple ML models for robust predictions
 *
 * Maintains multiple models and combines their predictions using weighted voting.
 * Tracks model performance, agreement rates, and ensemble diversity.
 */
export class MLEnsemble {
  constructor(config = {}) {
    this.config = {
      models: config.models || ['gradient_boosted', 'random_forest', 'logistic_regression'],
      minModels: config.minModels || 2,
      weightByAccuracy: config.weightByAccuracy !== false
    };

    this.models = new Map();
    this.accuracies = new Map();
    this.lastTrained = null;
    this.ensembleAccuracy = 0;

    // Tracking for ensemble health
    this.predictionHistory = []; // Last 100 predictions
    this.maxHistorySize = 100;

    // Initialize models
    this._initializeModels();
  }

  /**
   * Initialize all model instances based on config
   * @private
   */
  _initializeModels() {
    for (const modelType of this.config.models) {
      const mlConfig = this._getModelConfig(modelType);
      const engine = new MLEngine(mlConfig);
      this.models.set(modelType, engine);
      this.accuracies.set(modelType, 0);
    }
  }

  /**
   * Get MLEngine configuration for each model type
   * @private
   */
  _getModelConfig(type) {
    const configs = {
      gradient_boosted: {
        modelType: 'gbt',
        nTrees: 100,
        maxDepth: 6,
        learningRate: 0.1,
        minSamplesSplit: 10,
        subsampleRatio: 0.8
      },
      random_forest: {
        modelType: 'rf',
        nTrees: 50,
        maxDepth: 10,
        minSamplesSplit: 5,
        maxFeatures: 'sqrt'
      },
      logistic_regression: {
        modelType: 'lr',
        learningRate: 0.01,
        iterations: 1000,
        regularization: 0.1
      }
    };

    return configs[type] || configs.logistic_regression;
  }

  /**
   * Train all models in the ensemble
   * @param {Array<Array<number>>} features2D - Training features
   * @param {Array<string>} labels - Training labels ('UP' or 'DOWN')
   * @param {Object} options - Training options
   * @returns {Object} Training results for all models
   */
  train(features2D, labels, options = {}) {
    if (!features2D || features2D.length === 0) {
      throw new Error('No training data provided');
    }

    if (features2D.length !== labels.length) {
      throw new Error('Features and labels length mismatch');
    }

    const results = {
      models: [],
      ensembleAccuracy: 0,
      bestModel: null,
      worstModel: null,
      trainingTime: 0
    };

    const startTime = Date.now();

    // Train each model
    for (const [modelType, engine] of this.models.entries()) {
      try {
        const modelStartTime = Date.now();
        const trainResult = engine.train(features2D, labels, options);
        const modelTime = Date.now() - modelStartTime;

        // Store accuracy
        this.accuracies.set(modelType, trainResult.accuracy);

        results.models.push({
          type: modelType,
          accuracy: trainResult.accuracy,
          precision: trainResult.precision,
          recall: trainResult.recall,
          f1: trainResult.f1,
          trainingTime: modelTime
        });
      } catch (error) {
        console.error(`Failed to train ${modelType}:`, error.message);
        this.accuracies.set(modelType, 0);
        results.models.push({
          type: modelType,
          error: error.message,
          accuracy: 0
        });
      }
    }

    results.trainingTime = Date.now() - startTime;

    // Calculate ensemble accuracy (average of all models)
    const validAccuracies = results.models
      .filter(m => !m.error)
      .map(m => m.accuracy);

    if (validAccuracies.length > 0) {
      this.ensembleAccuracy = validAccuracies.reduce((a, b) => a + b, 0) / validAccuracies.length;
      results.ensembleAccuracy = this.ensembleAccuracy;
    }

    // Find best and worst models
    const sortedModels = [...results.models]
      .filter(m => !m.error)
      .sort((a, b) => b.accuracy - a.accuracy);

    if (sortedModels.length > 0) {
      results.bestModel = sortedModels[0].type;
      results.worstModel = sortedModels[sortedModels.length - 1].type;
    }

    this.lastTrained = new Date().toISOString();

    return results;
  }

  /**
   * Ensemble prediction using weighted voting
   * @param {Array<number>} features - Feature vector
   * @returns {Object} Ensemble prediction with confidence and agreement
   */
  predict(features) {
    if (!features || features.length === 0) {
      throw new Error('No features provided for prediction');
    }

    const modelVotes = [];
    let totalWeight = 0;
    let weightedUpProb = 0;

    // Get prediction from each model
    for (const [modelType, engine] of this.models.entries()) {
      try {
        const prediction = engine.predict(features);
        const accuracy = this.accuracies.get(modelType) || 0;

        // Weight by squared accuracy (penalize bad models more)
        const weight = this.config.weightByAccuracy ? Math.pow(accuracy, 2) : 1;

        modelVotes.push({
          type: modelType,
          prediction: prediction.prediction,
          confidence: prediction.confidence,
          weight: weight,
          accuracy: accuracy
        });

        // Accumulate weighted probabilities
        if (prediction.prediction === 'UP') {
          weightedUpProb += weight * prediction.confidence;
        } else {
          weightedUpProb += weight * (1 - prediction.confidence);
        }
        totalWeight += weight;
      } catch (error) {
        console.error(`Prediction failed for ${modelType}:`, error.message);
      }
    }

    if (modelVotes.length === 0) {
      throw new Error('No models available for prediction');
    }

    // Calculate final weighted probabilities
    const finalUpProb = weightedUpProb / totalWeight;
    const finalDownProb = 1 - finalUpProb;

    // Determine final prediction and confidence
    const prediction = finalUpProb > 0.5 ? 'UP' : 'DOWN';
    const confidence = Math.max(finalUpProb, finalDownProb);

    // Calculate agreement (how many models agree with final prediction)
    const agreeingModels = modelVotes.filter(v => v.prediction === prediction).length;
    const agreement = agreeingModels / modelVotes.length;

    const result = {
      prediction,
      confidence,
      agreement,
      modelVotes,
      ensembleMethod: 'weighted_vote',
      upProbability: finalUpProb,
      downProbability: finalDownProb
    };

    // Track prediction for diversity/agreement analysis
    this._trackPrediction(result);

    return result;
  }

  /**
   * Get detailed predictions from all models (for debugging/display)
   * @param {Array<number>} features - Feature vector
   * @returns {Object} Detailed predictions from each model
   */
  predictDetailed(features) {
    const predictions = [];

    for (const [modelType, engine] of this.models.entries()) {
      try {
        const prediction = engine.predict(features);
        const accuracy = this.accuracies.get(modelType);

        predictions.push({
          type: modelType,
          prediction: prediction.prediction,
          confidence: prediction.confidence,
          accuracy: accuracy,
          isTrained: engine.isTrained,
          sampleCount: engine.sampleCount
        });
      } catch (error) {
        predictions.push({
          type: modelType,
          error: error.message
        });
      }
    }

    return {
      models: predictions,
      ensembleAccuracy: this.ensembleAccuracy,
      lastTrained: this.lastTrained
    };
  }

  /**
   * Add a new model type to the ensemble
   * @param {string} type - Model type
   * @param {Object} config - MLEngine config
   */
  addModel(type, config = {}) {
    if (this.models.has(type)) {
      console.warn(`Model ${type} already exists in ensemble`);
      return;
    }

    const engine = new MLEngine(config);
    this.models.set(type, engine);
    this.accuracies.set(type, 0);

    console.log(`Added ${type} to ensemble (now ${this.models.size} models)`);
  }

  /**
   * Remove the worst performing model from ensemble
   * @returns {string|null} Removed model type or null if can't prune
   */
  pruneWorstModel() {
    if (this.models.size <= this.config.minModels) {
      console.warn(`Cannot prune: already at minimum ${this.config.minModels} models`);
      return null;
    }

    // Find model with lowest accuracy
    let worstType = null;
    let worstAccuracy = Infinity;

    for (const [type, accuracy] of this.accuracies.entries()) {
      if (accuracy < worstAccuracy) {
        worstAccuracy = accuracy;
        worstType = type;
      }
    }

    if (worstType) {
      this.models.delete(worstType);
      this.accuracies.delete(worstType);
      console.log(`Pruned ${worstType} (accuracy: ${worstAccuracy.toFixed(3)})`);
      return worstType;
    }

    return null;
  }

  /**
   * Track prediction for diversity/agreement analysis
   * @private
   */
  _trackPrediction(result) {
    this.predictionHistory.push({
      timestamp: Date.now(),
      prediction: result.prediction,
      confidence: result.confidence,
      agreement: result.agreement,
      votes: result.modelVotes.map(v => ({
        type: v.type,
        prediction: v.prediction
      }))
    });

    // Maintain history size
    if (this.predictionHistory.length > this.maxHistorySize) {
      this.predictionHistory.shift();
    }
  }

  /**
   * Calculate ensemble diversity score
   * Higher score = more diverse predictions = healthier ensemble
   * @private
   */
  _calculateDiversity() {
    if (this.predictionHistory.length < 10) {
      return 0;
    }

    const modelTypes = Array.from(this.models.keys());
    if (modelTypes.length < 2) {
      return 0;
    }

    // Calculate pairwise disagreement rates
    const disagreementRates = [];

    for (let i = 0; i < modelTypes.length; i++) {
      for (let j = i + 1; j < modelTypes.length; j++) {
        const type1 = modelTypes[i];
        const type2 = modelTypes[j];

        let disagreements = 0;
        let comparisons = 0;

        for (const pred of this.predictionHistory) {
          const vote1 = pred.votes.find(v => v.type === type1);
          const vote2 = pred.votes.find(v => v.type === type2);

          if (vote1 && vote2) {
            comparisons++;
            if (vote1.prediction !== vote2.prediction) {
              disagreements++;
            }
          }
        }

        if (comparisons > 0) {
          disagreementRates.push(disagreements / comparisons);
        }
      }
    }

    if (disagreementRates.length === 0) {
      return 0;
    }

    // Average disagreement rate = diversity score
    return disagreementRates.reduce((a, b) => a + b, 0) / disagreementRates.length;
  }

  /**
   * Calculate average agreement rate from recent predictions
   * @private
   */
  _calculateAgreementRate() {
    if (this.predictionHistory.length === 0) {
      return 0;
    }

    const agreements = this.predictionHistory.map(p => p.agreement);
    return agreements.reduce((a, b) => a + b, 0) / agreements.length;
  }

  /**
   * Check ensemble health and get recommendation
   * @returns {Object} Health metrics and recommendation
   */
  getHealth() {
    const modelCount = this.models.size;
    const trainedModels = Array.from(this.models.values()).filter(m => m.isTrained).length;

    const accuracyValues = Array.from(this.accuracies.values()).filter(a => a > 0);
    const avgAccuracy = accuracyValues.length > 0
      ? accuracyValues.reduce((a, b) => a + b, 0) / accuracyValues.length
      : 0;

    const agreementRate = this._calculateAgreementRate();
    const diversityScore = this._calculateDiversity();

    // Determine recommendation
    let recommendation = 'HEALTHY';
    const issues = [];

    if (trainedModels === 0) {
      recommendation = 'NOT_TRAINED';
      issues.push('No models trained');
    } else if (trainedModels < this.config.minModels) {
      recommendation = 'INSUFFICIENT_MODELS';
      issues.push(`Only ${trainedModels}/${this.config.minModels} models trained`);
    } else if (avgAccuracy < 0.55) {
      recommendation = 'UNDERPERFORMING';
      issues.push(`Low average accuracy: ${avgAccuracy.toFixed(3)}`);
    } else if (diversityScore < 0.05 && this.predictionHistory.length >= 10) {
      recommendation = 'LOW_DIVERSITY';
      issues.push(`Models too similar (diversity: ${diversityScore.toFixed(3)})`);
    } else if (diversityScore > 0.6 && agreementRate < 0.4) {
      recommendation = 'HIGH_DISAGREEMENT';
      issues.push(`Models disagree too often (agreement: ${agreementRate.toFixed(3)})`);
    } else if (avgAccuracy < 0.60) {
      recommendation = 'NEEDS_RETRAIN';
      issues.push('Accuracy could be improved');
    }

    return {
      modelCount,
      trainedModels,
      avgAccuracy,
      agreementRate,
      diversityScore,
      recommendation,
      issues,
      predictionCount: this.predictionHistory.length,
      lastTrained: this.lastTrained
    };
  }

  /**
   * Get ensemble status
   * @returns {Object} Status of all models
   */
  getStatus() {
    const models = [];

    for (const [type, engine] of this.models.entries()) {
      models.push({
        type,
        accuracy: this.accuracies.get(type),
        sampleCount: engine.sampleCount,
        isTrained: engine.isTrained
      });
    }

    return {
      models,
      ensembleAccuracy: this.ensembleAccuracy,
      lastTrained: this.lastTrained,
      predictionCount: this.predictionHistory.length
    };
  }

  /**
   * Serialize ensemble to JSON
   * @returns {string} JSON string
   */
  serialize() {
    const data = {
      config: this.config,
      accuracies: Object.fromEntries(this.accuracies),
      ensembleAccuracy: this.ensembleAccuracy,
      lastTrained: this.lastTrained,
      models: {}
    };

    // Serialize each model
    for (const [type, engine] of this.models.entries()) {
      try {
        data.models[type] = engine.serialize();
      } catch (error) {
        console.error(`Failed to serialize ${type}:`, error.message);
      }
    }

    return JSON.stringify(data);
  }

  /**
   * Deserialize ensemble from JSON
   * @param {string} json - JSON string
   */
  deserialize(json) {
    const data = JSON.parse(json);

    this.config = data.config || this.config;
    this.accuracies = new Map(Object.entries(data.accuracies || {}));
    this.ensembleAccuracy = data.ensembleAccuracy || 0;
    this.lastTrained = data.lastTrained || null;

    // Deserialize each model
    this.models.clear();
    for (const [type, serializedModel] of Object.entries(data.models || {})) {
      try {
        const mlConfig = this._getModelConfig(type);
        const engine = new MLEngine(mlConfig);
        engine.deserialize(serializedModel);
        this.models.set(type, engine);
      } catch (error) {
        console.error(`Failed to deserialize ${type}:`, error.message);
      }
    }

    console.log(`Deserialized ensemble with ${this.models.size} models`);
  }

  /**
   * Reset ensemble (clear all models and history)
   */
  reset() {
    this.models.clear();
    this.accuracies.clear();
    this.predictionHistory = [];
    this.lastTrained = null;
    this.ensembleAccuracy = 0;
    this._initializeModels();
    console.log('Ensemble reset');
  }
}
