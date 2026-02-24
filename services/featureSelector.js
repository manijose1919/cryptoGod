/**
 * Feature Selection Service — Permutation Importance
 *
 * Identifies which features in the ML pipeline actually contribute to
 * prediction accuracy, allowing the system to drop noise features and
 * reduce overfitting.
 *
 * Algorithm: For each feature column, shuffle it nRepeats times, measure
 * the accuracy drop vs the unshuffled baseline. Features whose removal
 * causes a larger accuracy drop are more important.
 */

import { getSetting, setSetting } from './database.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let selectedFeatureIndices = null; // null means "use all features"

// Attempt to hydrate from DB on module load
try {
  const stored = getSetting('ml_selected_features');
  if (stored) {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.length > 0) {
      selectedFeatureIndices = parsed;
    }
  }
} catch (_err) {
  // Database may not be ready yet — fail silently, keep null
}

// ---------------------------------------------------------------------------
// Utility: Fisher-Yates shuffle of a single column in a 2-D array (in place)
// ---------------------------------------------------------------------------

function shuffleColumn(matrix, colIndex) {
  const len = matrix.length;
  for (let i = len - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = matrix[i][colIndex];
    matrix[i][colIndex] = matrix[j][colIndex];
    matrix[j][colIndex] = tmp;
  }
}

// ---------------------------------------------------------------------------
// Deep-copy a 2-D numeric array
// ---------------------------------------------------------------------------

function copy2D(arr) {
  return arr.map(row => row.slice());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run permutation importance on a trained ML engine.
 *
 * @param {object}     mlEngine     — trained MLEngine instance (needs .evaluate())
 * @param {number[][]} valFeatures  — 2-D validation feature matrix
 * @param {number[]}   valLabels    — validation labels (0 / 1)
 * @param {number}     nRepeats     — shuffles per feature (default 5)
 * @returns {Array<{featureIndex: number, importance: number}>}
 */
export function runPermutationImportance(mlEngine, valFeatures, valLabels, nRepeats = 5) {
  // Guard: unusable inputs
  if (!mlEngine || !valFeatures || !valLabels) return [];
  if (valFeatures.length === 0 || valLabels.length === 0) return [];

  const nFeatures = valFeatures[0].length;
  if (nFeatures === 0) return [];

  // Baseline accuracy (unshuffled)
  let baselineAcc;
  try {
    baselineAcc = mlEngine.evaluate(valFeatures, valLabels).accuracy;
  } catch (_err) {
    return [];
  }

  const importances = [];

  for (let f = 0; f < nFeatures; f++) {
    let totalDrop = 0;

    for (let r = 0; r < nRepeats; r++) {
      const shuffled = copy2D(valFeatures);
      shuffleColumn(shuffled, f);

      let shuffledAcc;
      try {
        shuffledAcc = mlEngine.evaluate(shuffled, valLabels).accuracy;
      } catch (_err) {
        shuffledAcc = baselineAcc; // treat errors as no change
      }

      totalDrop += baselineAcc - shuffledAcc;
    }

    importances.push({
      featureIndex: f,
      importance: totalDrop / nRepeats
    });
  }

  // Sort descending by importance for convenience
  importances.sort((a, b) => b.importance - a.importance);

  return importances;
}

/**
 * Given an array of importance scores, return the indices of features that
 * exceed the threshold. Enforces a minimum of 30 features (or all features
 * if there are fewer than 30 total).
 *
 * @param {Array<{featureIndex: number, importance: number}>} importances
 * @param {number} threshold — minimum importance to keep (default 0.005)
 * @returns {number[]} selectedIndices sorted ascending
 */
export function selectTopFeatures(importances, threshold = 0.005) {
  if (!importances || importances.length === 0) return [];

  const totalFeatures = importances.length;
  const MIN_FEATURES = 30;

  // Features above threshold
  let selected = importances
    .filter(item => item.importance > threshold)
    .map(item => item.featureIndex);

  // Enforce minimum — fill from the top of the ranked list
  if (selected.length < Math.min(MIN_FEATURES, totalFeatures)) {
    // importances is already sorted descending by importance
    selected = importances
      .slice(0, Math.min(MIN_FEATURES, totalFeatures))
      .map(item => item.featureIndex);
  }

  // Sort ascending so index order is preserved for downstream use
  selected.sort((a, b) => a - b);

  return selected;
}

/**
 * Return the currently active feature-index mask.
 * Returns null if no selection has been made (meaning "use all features").
 * @returns {number[] | null}
 */
export function getSelectedFeatures() {
  return selectedFeatureIndices;
}

/**
 * Set the active feature-index mask and persist to DB.
 * Pass null to clear the selection (use all features).
 * @param {number[] | null} indices
 */
export function setSelectedFeatures(indices) {
  selectedFeatureIndices = indices;

  try {
    if (indices === null || indices === undefined) {
      setSetting('ml_selected_features', JSON.stringify(null));
    } else {
      setSetting('ml_selected_features', JSON.stringify(indices));
    }
  } catch (_err) {
    // DB write failed — in-memory state is still updated
  }
}

/**
 * Filter a 1-D feature vector down to only the selected indices.
 * If selectedIndices is null/empty, returns the original vector unchanged.
 *
 * @param {number[]}      featureVector   — flat feature array
 * @param {number[]|null} selectedIndices — indices to keep
 * @returns {number[]}
 */
export function applyFeatureMask(featureVector, selectedIndices) {
  if (!selectedIndices || selectedIndices.length === 0) return featureVector;
  if (!featureVector || featureVector.length === 0) return featureVector;

  return selectedIndices
    .filter(idx => idx < featureVector.length)
    .map(idx => featureVector[idx]);
}

/**
 * Filter a 2-D feature matrix down to only the selected column indices.
 * If selectedIndices is null/empty, returns the original matrix unchanged.
 *
 * @param {number[][]}    features2D      — rows of feature vectors
 * @param {number[]|null} selectedIndices — column indices to keep
 * @returns {number[][]}
 */
export function applyFeatureMask2D(features2D, selectedIndices) {
  if (!selectedIndices || selectedIndices.length === 0) return features2D;
  if (!features2D || features2D.length === 0) return features2D;

  return features2D.map(row => applyFeatureMask(row, selectedIndices));
}
