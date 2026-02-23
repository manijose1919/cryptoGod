/**
 * Adversarial Dual-Brain System — System D
 * Bull model vs Bear model debate. Only proceed if Bull >> Bear.
 *
 * BullBrain: label=1 means profitable trade (standard)
 * BearBrain: label=1 means losing trade (inverted labels, same features)
 *
 * Consensus types:
 *   STRONG_BUY: bull > 65% AND bear < 40%
 *   WEAK_BUY: bull beats bear by >= minMargin points
 *   CONTESTED: margin < minMargin (skip trade)
 *   REJECT: bear > bull
 *
 * Bear can only reduce confidence, never increase (conservative bias).
 */

import { MLEngine } from './mlEngine.js';
import { getFlag } from './systemConfig.js';
import { insertAdversarialModel } from './database.js';

let bullBrain = null;
let bearBrain = null;
let bullSampleCount = 0;
let bearSampleCount = 0;
let isReady = false;

/**
 * Initialize the adversarial system
 */
export function init(config = {}) {
  bullBrain = new MLEngine({
    nTrees: config.nTrees || 50,
    maxDepth: config.maxDepth || 10,
    nEstimators: config.nEstimators || 100,
    seed: config.seed || 42,
  });
  bearBrain = new MLEngine({
    nTrees: config.nTrees || 50,
    maxDepth: config.maxDepth || 10,
    nEstimators: config.nEstimators || 100,
    seed: (config.seed || 42) + 1000, // Different seed for diversity
  });
  isReady = false;
  console.log('[AdversarialBrains] Initialized Bull and Bear models');
}

/**
 * Train both brains from the same sample set.
 * Bull gets standard labels. Bear gets inverted labels.
 *
 * @param {number[][]} features2D - Feature vectors
 * @param {number[]} labels - Standard labels (1 = profitable, 0 = loss)
 * @param {object} options - Training options
 * @returns {object} Training metrics for both models
 */
export function trainBoth(features2D, labels, options = {}) {
  if (!bullBrain || !bearBrain) {
    init();
  }

  const minSamples = getFlag('ADVERSARIAL_MIN_SAMPLES');
  if (minSamples > 0 && features2D.length < minSamples) {
    console.log(`[AdversarialBrains] Not enough samples (${features2D.length} < ${minSamples}), skipping training`);
    return { success: false, reason: `Need ${minSamples} samples, have ${features2D.length}` };
  }
  if (features2D.length < 10) {
    return { success: false, reason: `Need at least 10 samples, have ${features2D.length}` };
  }

  console.log(`[AdversarialBrains] Training both brains on ${features2D.length} samples...`);

  // Train Bull (standard labels)
  const bullMetrics = bullBrain.train(features2D, labels, {
    validationSplit: options.validationSplit || 0.2,
  });
  bullSampleCount = features2D.length;
  console.log(`[AdversarialBrains] Bull trained: accuracy=${(bullMetrics.validationAccuracy*100).toFixed(1)}%`);

  // Train Bear (inverted labels: 1 = loss, 0 = profit)
  const invertedLabels = labels.map(l => l === 1 ? 0 : 1);
  const bearMetrics = bearBrain.train(features2D, invertedLabels, {
    validationSplit: options.validationSplit || 0.2,
  });
  bearSampleCount = features2D.length;
  console.log(`[AdversarialBrains] Bear trained: accuracy=${(bearMetrics.validationAccuracy*100).toFixed(1)}%`);

  isReady = true;

  // Persist metadata
  try {
    insertAdversarialModel({
      model_type: 'ensemble',
      role: 'BULL',
      sample_count: bullSampleCount,
      accuracy: bullMetrics.validationAccuracy,
      last_trained_at: Date.now(),
      config: options,
    });
    insertAdversarialModel({
      model_type: 'ensemble',
      role: 'BEAR',
      sample_count: bearSampleCount,
      accuracy: bearMetrics.validationAccuracy,
      last_trained_at: Date.now(),
      config: options,
    });
  } catch (e) {
    // Non-critical
  }

  return {
    success: true,
    bull: bullMetrics,
    bear: bearMetrics,
    sampleCount: features2D.length,
  };
}

/**
 * Evaluate consensus between Bull and Bear models.
 *
 * @param {number[]} features - Feature vector (raw, not scaled — MLEngine handles scaling)
 * @returns {object} { bullConfidence, bearConfidence, netConfidence, consensus, marginOfVictory }
 */
export function evaluateConsensus(features) {
  if (!isReady || !bullBrain?.isTrained || !bearBrain?.isTrained) {
    return {
      bullConfidence: 50,
      bearConfidence: 50,
      netConfidence: 0,
      consensus: 'NOT_READY',
      marginOfVictory: 0,
    };
  }

  const minSamples = getFlag('ADVERSARIAL_MIN_SAMPLES');
  if (minSamples > 0 && (bullSampleCount < minSamples || bearSampleCount < minSamples)) {
    return {
      bullConfidence: 50,
      bearConfidence: 50,
      netConfidence: 0,
      consensus: 'INSUFFICIENT_DATA',
      marginOfVictory: 0,
    };
  }

  const minMargin = getFlag('ADVERSARIAL_MIN_MARGIN');

  // Get predictions from both brains
  const bullPred = bullBrain.predict(features);
  const bearPred = bearBrain.predict(features);

  // Bull confidence = probability of UP (profitable trade)
  const bullConfidence = bullPred.probabilities.up * 100;
  // Bear confidence = probability of UP in bear model = probability trade is a LOSS
  const bearConfidence = bearPred.probabilities.up * 100;

  const marginOfVictory = bullConfidence - bearConfidence;
  const netConfidence = bullConfidence - bearConfidence;

  // Determine consensus
  let consensus;
  if (bullConfidence > 65 && bearConfidence < 40) {
    consensus = 'STRONG_BUY';
  } else if (marginOfVictory >= minMargin) {
    consensus = 'WEAK_BUY';
  } else if (bearConfidence > bullConfidence) {
    consensus = 'REJECT';
  } else {
    consensus = 'CONTESTED';
  }

  return {
    bullConfidence,
    bearConfidence,
    netConfidence,
    consensus,
    marginOfVictory,
  };
}

/**
 * Check if the adversarial system is ready (both models trained with enough data)
 */
export function isAdversarialReady() {
  const minSamples = getFlag('ADVERSARIAL_MIN_SAMPLES');
  return isReady && bullSampleCount >= minSamples && bearSampleCount >= minSamples;
}

/**
 * Get status of both brains
 */
export function getAdversarialStatus() {
  return {
    enabled: getFlag('ADVERSARIAL_ENABLED'),
    isReady,
    bullTrained: !!bullBrain?.isTrained,
    bearTrained: !!bearBrain?.isTrained,
    bullSampleCount,
    bearSampleCount,
    bullAccuracy: bullBrain?.validationAccuracy || 0,
    bearAccuracy: bearBrain?.validationAccuracy || 0,
    minSamples: getFlag('ADVERSARIAL_MIN_SAMPLES'),
    minMargin: getFlag('ADVERSARIAL_MIN_MARGIN'),
  };
}

/**
 * Get the Bull brain MLEngine (for external use like self-teaching)
 */
export function getBullBrain() { return bullBrain; }
export function getBearBrain() { return bearBrain; }
