/**
 * Hyperparameter Tuner Service
 * Random search over MLEngine hyperparameters with walk-forward cross-validation.
 * Persists best config to SQLite for reuse across restarts.
 */

import { MLEngine } from './mlEngine.js';
import { getFlag } from './systemConfig.js';
import { getSetting, setSetting } from './database.js';

const TAG = '[HyperparamTuner]';
const MIN_SAMPLES = 300;
const DB_KEY = 'ml_best_hyperparams';

// ---------------------------------------------------------------------------
// Search space definition
// ---------------------------------------------------------------------------

/**
 * Random integer in [min, max] (inclusive)
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random float in [min, max]
 */
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Generate a single random hyperparameter configuration from the search space.
 * @returns {{ nTrees: number, maxDepth: number, nEstimators: number, learningRate: number, l2Lambda: number }}
 */
function sampleConfig() {
  return {
    nTrees: randInt(30, 200),
    maxDepth: randInt(6, 15),
    nEstimators: randInt(50, 300),
    learningRate: parseFloat(randFloat(0.05, 0.3).toFixed(4)),
    l2Lambda: parseFloat(randFloat(0.01, 1.0).toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// Walk-forward fold boundaries (expanding window, 3 folds)
// ---------------------------------------------------------------------------

const FOLD_BOUNDARIES = [
  { trainEnd: 0.50, valStart: 0.50, valEnd: 0.70 },   // Fold 0
  { trainEnd: 0.60, valStart: 0.60, valEnd: 0.80 },   // Fold 1
  { trainEnd: 0.70, valStart: 0.70, valEnd: 1.00 },   // Fold 2
];

// ---------------------------------------------------------------------------
// Core evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Compute accuracy (fraction correct) for a trained MLEngine on a validation set.
 * The engine must already be trained (isTrained === true).
 * @param {MLEngine} engine - A trained MLEngine instance
 * @param {number[][]} valFeatures - Validation feature rows
 * @param {number[]} valLabels - True 0/1 labels
 * @returns {number} Accuracy in [0, 1]
 */
function evaluateAccuracy(engine, valFeatures, valLabels) {
  let correct = 0;
  for (let i = 0; i < valFeatures.length; i++) {
    try {
      const result = engine.predict(valFeatures[i]);
      const predicted = result.prediction === 'UP' ? 1 : 0;
      if (predicted === valLabels[i]) correct++;
    } catch {
      // If prediction fails, count as incorrect
    }
  }
  return valLabels.length > 0 ? correct / valLabels.length : 0;
}

/**
 * Evaluate a single config across all walk-forward folds.
 * @param {{ nTrees: number, maxDepth: number, nEstimators: number, learningRate: number, l2Lambda: number }} config
 * @param {number[][]} features2D
 * @param {number[]} labels
 * @param {number} nFolds
 * @returns {{ meanAccuracy: number, foldAccuracies: number[] }}
 */
function evaluateConfig(config, features2D, labels, nFolds) {
  const n = features2D.length;
  const foldAccuracies = [];

  for (let fold = 0; fold < nFolds; fold++) {
    const bounds = FOLD_BOUNDARIES[fold];
    const trainEndIdx = Math.floor(n * bounds.trainEnd);
    const valStartIdx = Math.floor(n * bounds.valStart);
    const valEndIdx = Math.floor(n * bounds.valEnd);

    const trainFeatures = features2D.slice(0, trainEndIdx);
    const trainLabels = labels.slice(0, trainEndIdx);
    const valFeatures = features2D.slice(valStartIdx, valEndIdx);
    const valLabels = labels.slice(valStartIdx, valEndIdx);

    // Sanity: need enough data in both splits
    if (trainFeatures.length < 30 || valFeatures.length < 10) {
      continue;
    }

    try {
      const engine = new MLEngine({
        nTrees: config.nTrees,
        maxDepth: config.maxDepth,
        nEstimators: config.nEstimators,
        learningRate: config.learningRate,
        l2Lambda: config.l2Lambda,
        seed: 42 + fold,
      });

      // Train with a simple split (no nested CV) — the split is handled here
      engine.train(trainFeatures, trainLabels, {
        validationSplit: 0.15,
        modelType: 'ensemble',
        crossValidate: false,
      });

      const acc = evaluateAccuracy(engine, valFeatures, valLabels);
      foldAccuracies.push(acc);
    } catch (err) {
      console.warn(`${TAG} Fold ${fold} failed for config:`, err.message);
    }
  }

  const meanAccuracy = foldAccuracies.length > 0
    ? foldAccuracies.reduce((a, b) => a + b, 0) / foldAccuracies.length
    : 0;

  return { meanAccuracy, foldAccuracies };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run random search over the hyperparameter space.
 * Uses walk-forward cross-validation (expanding window) to evaluate each config.
 *
 * @param {number[][]} features2D - N samples x M features (raw, unscaled)
 * @param {number[]} labels - Binary labels (0 or 1)
 * @param {number} [nConfigs=20] - Number of random configs to try
 * @param {number} [nFolds=3] - Number of walk-forward folds
 * @returns {{ bestConfig: object, allResults: object[] } | null} Best config + all results, or null
 */
export function runRandomSearch(features2D, labels, nConfigs = 20, nFolds = 3) {
  try {
    // Check feature flag
    const enabled = getFlag('HYPERPARAM_TUNING_ENABLED');
    if (enabled === false) {
      console.log(`${TAG} Tuning disabled via HYPERPARAM_TUNING_ENABLED flag`);
      return null;
    }

    // Minimum sample guard
    if (!features2D || !labels || features2D.length < MIN_SAMPLES) {
      console.log(`${TAG} Insufficient data (${features2D ? features2D.length : 0} < ${MIN_SAMPLES}), skipping tuning`);
      return null;
    }

    if (features2D.length !== labels.length) {
      console.warn(`${TAG} Feature/label length mismatch: ${features2D.length} vs ${labels.length}`);
      return null;
    }

    // Clamp nFolds to available fold boundaries
    const effectiveFolds = Math.min(nFolds, FOLD_BOUNDARIES.length);

    console.log(`${TAG} Starting random search: ${nConfigs} configs, ${effectiveFolds} folds, ${features2D.length} samples`);

    const allResults = [];

    for (let i = 0; i < nConfigs; i++) {
      const config = sampleConfig();

      const { meanAccuracy, foldAccuracies } = evaluateConfig(config, features2D, labels, effectiveFolds);

      allResults.push({ config, meanAccuracy, foldAccuracies });

      console.log(
        `${TAG} Config ${i + 1}/${nConfigs}: nTrees=${config.nTrees}, maxDepth=${config.maxDepth}, ` +
        `nEstimators=${config.nEstimators}, lr=${config.learningRate}, l2=${config.l2Lambda}, ` +
        `acc=${meanAccuracy.toFixed(4)}`
      );
    }

    // Sort by mean accuracy descending and pick the best
    allResults.sort((a, b) => b.meanAccuracy - a.meanAccuracy);
    const best = allResults[0];

    if (!best || best.meanAccuracy === 0) {
      console.warn(`${TAG} No valid results from random search`);
      return null;
    }

    console.log(
      `${TAG} Best config: nTrees=${best.config.nTrees}, maxDepth=${best.config.maxDepth}, ` +
      `nEstimators=${best.config.nEstimators}, lr=${best.config.learningRate}, ` +
      `l2=${best.config.l2Lambda}, meanAcc=${best.meanAccuracy.toFixed(4)}`
    );

    // Persist the best config
    try {
      saveBestHyperparams(best.config);
    } catch (err) {
      console.warn(`${TAG} Could not persist best hyperparams:`, err.message);
    }

    return { bestConfig: best.config, allResults };
  } catch (err) {
    console.error(`${TAG} Random search failed:`, err.message);
    return null;
  }
}

/**
 * Load the best hyperparameters from the database.
 * @returns {{ nTrees: number, maxDepth: number, nEstimators: number, learningRate: number, l2Lambda: number } | null}
 */
export function getBestHyperparams() {
  try {
    const stored = getSetting(DB_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    // Validate expected keys exist
    if (parsed && typeof parsed.nTrees === 'number' && typeof parsed.maxDepth === 'number') {
      return parsed;
    }
    return null;
  } catch (err) {
    console.warn(`${TAG} Could not load best hyperparams:`, err.message);
    return null;
  }
}

/**
 * Save the best hyperparameters to the database.
 * @param {{ nTrees: number, maxDepth: number, nEstimators: number, learningRate: number, l2Lambda: number }} config
 */
export function saveBestHyperparams(config) {
  try {
    if (!config || typeof config !== 'object') {
      console.warn(`${TAG} Invalid config, not saving`);
      return;
    }
    setSetting(DB_KEY, JSON.stringify(config));
    console.log(`${TAG} Saved best hyperparams to DB`);
  } catch (err) {
    console.warn(`${TAG} Could not save best hyperparams:`, err.message);
  }
}
