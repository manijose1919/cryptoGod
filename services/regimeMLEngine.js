/**
 * Regime-Aware ML Engine
 * Routes predictions through regime-specific models (uptrend, sideways, downtrend)
 * with a general fallback model for cold-start or low-sample regimes.
 */

import MLEngine from './mlEngine.js';

const REGIMES = ['UPTREND', 'SIDEWAYS', 'DOWNTREND'];
const MIN_REGIME_SAMPLES = 100;

class RegimeMLEngine {
  /**
   * @param {object} config - Passed through to each MLEngine instance
   *   (nTrees, nEstimators, maxDepth, minSamples, learningRate, seed, etc.)
   */
  constructor(config = {}) {
    this.config = config;

    this.uptrendModel   = new MLEngine(config);
    this.sidewaysModel  = new MLEngine(config);
    this.downtrendModel = new MLEngine(config);
    this.generalModel   = new MLEngine(config);

    this._regimeMap = {
      UPTREND:   this.uptrendModel,
      SIDEWAYS:  this.sidewaysModel,
      DOWNTREND: this.downtrendModel,
    };

    this._regimeTrainedOn = {};  // regime -> sampleCount used
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Whether the engine is ready for predictions (general model is trained).
   */
  get isTrained() {
    return this.generalModel.isTrained;
  }

  /**
   * Train regime-specific sub-models plus a general fallback.
   *
   * @param {number[][]} features2D    - Full feature matrix (N x M)
   * @param {number[]}   labels        - Binary labels (0 / 1)
   * @param {string[]}   regimeLabels  - Per-sample regime tag ('UPTREND' | 'SIDEWAYS' | 'DOWNTREND')
   * @returns {object} Training results per regime + general
   */
  train(features2D, labels, regimeLabels) {
    if (features2D.length !== labels.length || labels.length !== regimeLabels.length) {
      throw new Error('features2D, labels, and regimeLabels must have the same length');
    }

    const cvOptions = { crossValidate: true, nFolds: 5, purgeGap: 5 };
    const results = {};

    // ---- 1. Train per-regime models ----------------------------------------
    for (const regime of REGIMES) {
      const indices = [];
      for (let i = 0; i < regimeLabels.length; i++) {
        if (regimeLabels[i] === regime) indices.push(i);
      }

      this._regimeTrainedOn[regime] = indices.length;

      if (indices.length < MIN_REGIME_SAMPLES) {
        console.log(
          `[RegimeMLEngine] ${regime}: only ${indices.length} samples (< ${MIN_REGIME_SAMPLES}), skipping — will use general model`
        );
        // Reset the sub-model so isTrained stays false
        this._regimeMap[regime] = new MLEngine(this.config);
        this._syncMapAlias(regime);
        results[regime] = { skipped: true, sampleCount: indices.length };
        continue;
      }

      const regimeFeatures = indices.map(i => features2D[i]);
      const regimeLabelsArr = indices.map(i => labels[i]);

      console.log(`[RegimeMLEngine] Training ${regime} model (${indices.length} samples)...`);

      try {
        const metrics = this._regimeMap[regime].train(regimeFeatures, regimeLabelsArr, cvOptions);
        results[regime] = { ...metrics, sampleCount: indices.length };
        console.log(
          `[RegimeMLEngine] ${regime} done — valAcc=${metrics.validationAccuracy?.toFixed(3) ?? 'N/A'}`
        );
      } catch (err) {
        console.error(`[RegimeMLEngine] ${regime} training failed:`, err.message);
        this._regimeMap[regime] = new MLEngine(this.config);
        this._syncMapAlias(regime);
        results[regime] = { error: err.message, sampleCount: indices.length };
      }
    }

    // ---- 2. Train general (fallback) model on ALL data ---------------------
    console.log(`[RegimeMLEngine] Training general model (${features2D.length} samples)...`);
    try {
      const generalMetrics = this.generalModel.train(features2D, labels, cvOptions);
      results.general = { ...generalMetrics, sampleCount: features2D.length };
      console.log(
        `[RegimeMLEngine] General done — valAcc=${generalMetrics.validationAccuracy?.toFixed(3) ?? 'N/A'}`
      );
    } catch (err) {
      console.error('[RegimeMLEngine] General model training failed:', err.message);
      results.general = { error: err.message, sampleCount: features2D.length };
    }

    return results;
  }

  /**
   * Predict a single sample, routing to the appropriate regime model.
   *
   * @param {number[]} features - Feature vector
   * @param {string}   regime   - 'UPTREND' | 'SIDEWAYS' | 'DOWNTREND'
   * @returns {object} { prediction, confidence, probabilities, modelUsed }
   */
  predict(features, regime) {
    const regimeModel = this._regimeMap[regime];

    // Use the regime-specific model if it was successfully trained
    if (regimeModel && regimeModel.isTrained) {
      const result = regimeModel.predict(features);
      return { ...result, modelUsed: regime };
    }

    // Fallback to general model
    if (!this.generalModel.isTrained) {
      throw new Error('RegimeMLEngine is not trained — no models available');
    }

    const result = this.generalModel.predict(features);
    return { ...result, modelUsed: 'GENERAL' };
  }

  /**
   * Return stats for every sub-model + general.
   * @returns {object}
   */
  getModelStats() {
    const stats = { general: this.generalModel.getModelStats() };

    for (const regime of REGIMES) {
      const model = this._regimeMap[regime];
      stats[regime] = {
        ...model.getModelStats(),
        regimeSamples: this._regimeTrainedOn[regime] ?? 0,
        usingFallback: !model.isTrained,
      };
    }

    return stats;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * After replacing a model in _regimeMap, keep the named property in sync.
   */
  _syncMapAlias(regime) {
    if (regime === 'UPTREND')   this.uptrendModel   = this._regimeMap[regime];
    if (regime === 'SIDEWAYS')  this.sidewaysModel  = this._regimeMap[regime];
    if (regime === 'DOWNTREND') this.downtrendModel = this._regimeMap[regime];
  }
}

export { RegimeMLEngine };
export default RegimeMLEngine;
