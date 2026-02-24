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
    const avgContributions = totalContributions.map(c => c / numTrees);
    const avgBaseValue = totalBaseValue / numTrees;

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
