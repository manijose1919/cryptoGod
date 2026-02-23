/**
 * ML Gatekeeper Service — System A
 * Promotes ML ensemble from advisory-only to actual decision-maker.
 *
 * Confidence tiers:
 *   STRONG (>75%): Full position, ML overrides weak rule signals
 *   MEDIUM (60-75%): Proceed only if rules also agree
 *   WEAK (50-60%): Defer entirely to rule-based logic
 *   REJECT (<50%): Block the trade (in HARD_GATE mode)
 *
 * Auto-downgrades to ADVISORY if accuracy < 52% over rolling window.
 */

import { getFlag, setFlag } from './systemConfig.js';
import { buildFeatureVector, FEATURE_COUNT } from './featureEngineering.js';
import { insertGatekeeperDecision } from './database.js';

// ML engine — dynamically loaded
let mlEngine = null;
let adversarialBrains = null;

// Rolling accuracy tracker
const rollingDecisions = [];
const MAX_ROLLING = 200;

// Per-tier accuracy tracking
const tierStats = {
  STRONG: { total: 0, correct: 0 },
  MEDIUM: { total: 0, correct: 0 },
  WEAK:   { total: 0, correct: 0 },
  REJECT: { total: 0, correct: 0 },
};

// Auto-downgrade state
let wasAutoDowngraded = false;

/**
 * Initialize with ML engine reference
 */
export function init(engine, advBrains = null) {
  mlEngine = engine;
  adversarialBrains = advBrains;
  console.log('[MLGatekeeper] Initialized', {
    hasEngine: !!engine,
    hasAdversarial: !!advBrains,
  });
}

/**
 * Set adversarial brains reference (can be set after init)
 */
export function setAdversarialBrains(brains) {
  adversarialBrains = brains;
}

/**
 * Main entry point: evaluate whether a trade should proceed.
 *
 * @param {string} ticker - Trading pair
 * @param {Array} candles - OHLCV candles
 * @param {string} ruleStrategy - Strategy selected by rule-based logic
 * @param {number} ruleStrength - Signal strength from rules (0-1)
 * @param {object} options - Additional context (strategySignals, etc.)
 * @returns {object} { proceed, confidence, tier, sizeMultiplier, reason, mlPrediction, adversarialConsensus }
 */
export function evaluateEntry(ticker, candles, ruleStrategy, ruleStrength, options = {}) {
  const mode = getFlag('ML_GATEKEEPER_MODE');
  const enabled = getFlag('ML_GATEKEEPER_ENABLED');

  // If disabled, pass through
  if (!enabled) {
    return {
      proceed: true,
      confidence: 0,
      tier: 'DISABLED',
      sizeMultiplier: 1.0,
      reason: 'ML Gatekeeper disabled',
      mlPrediction: null,
      adversarialConsensus: null,
    };
  }

  // If ML engine not trained, pass through
  if (!mlEngine || !mlEngine.isTrained) {
    return {
      proceed: true,
      confidence: 0,
      tier: 'NO_MODEL',
      sizeMultiplier: 1.0,
      reason: 'ML model not trained yet',
      mlPrediction: null,
      adversarialConsensus: null,
    };
  }

  try {
    // Build feature vector with strategy signals
    const featureResult = buildFeatureVector(ticker, candles, {
      ...options,
      strategySignals: options.strategySignals || {},
    });

    // Append genetic signals if available
    let features = featureResult.features;
    if (options.geneticSignals && Array.isArray(options.geneticSignals)) {
      features = [...features, ...options.geneticSignals];
    }

    // Get ML prediction
    const mlPrediction = mlEngine.predict(features);
    const mlConfidence = mlPrediction.confidence * 100; // Convert to 0-100

    // Adversarial consensus (if enabled)
    let advConsensus = null;
    if (getFlag('ADVERSARIAL_ENABLED') && adversarialBrains) {
      try {
        advConsensus = adversarialBrains.evaluateConsensus(features);
      } catch (e) {
        // Adversarial not ready, skip
      }
    }

    // Determine confidence tier
    const minBlock = getFlag('ML_MIN_CONFIDENCE_TO_BLOCK');
    const minOverride = getFlag('ML_MIN_CONFIDENCE_TO_OVERRIDE');
    let tier, proceed, sizeMultiplier, reason;

    if (mlPrediction.prediction === 'UP') {
      // ML agrees with entry
      if (mlConfidence >= minOverride) {
        tier = 'STRONG';
        proceed = true;
        sizeMultiplier = 1.2; // Boost position
        reason = `ML STRONG BUY (${mlConfidence.toFixed(1)}% > ${minOverride}%)`;
      } else if (mlConfidence >= minBlock) {
        tier = 'MEDIUM';
        proceed = true; // Proceed since rules also agree
        sizeMultiplier = 1.0;
        reason = `ML MEDIUM BUY (${mlConfidence.toFixed(1)}%)`;
      } else {
        tier = 'WEAK';
        proceed = true; // Defer to rules
        sizeMultiplier = 0.8; // Slightly reduce size
        reason = `ML WEAK (${mlConfidence.toFixed(1)}%), deferring to rules`;
      }
    } else {
      // ML predicts DOWN — considers blocking
      if (mlConfidence >= minOverride) {
        tier = 'REJECT';
        if (mode === 'HARD_GATE') {
          proceed = false;
          sizeMultiplier = 0;
          reason = `ML REJECT (${mlConfidence.toFixed(1)}% DOWN confidence) — HARD GATE blocked`;
        } else if (mode === 'SOFT_GATE') {
          proceed = ruleStrength > 0.7; // Only proceed if rule signal very strong
          sizeMultiplier = proceed ? 0.5 : 0;
          reason = proceed
            ? `ML REJECT but rules strong (${(ruleStrength*100).toFixed(0)}%) — reduced size`
            : `ML REJECT (${mlConfidence.toFixed(1)}% DOWN) and rules weak — SOFT GATE blocked`;
        } else {
          // ADVISORY mode
          proceed = true;
          sizeMultiplier = 0.8;
          reason = `ML predicts DOWN (${mlConfidence.toFixed(1)}%) — ADVISORY only, reducing size`;
        }
      } else if (mlConfidence >= minBlock) {
        tier = 'MEDIUM';
        proceed = true;
        sizeMultiplier = 0.7;
        reason = `ML slightly bearish (${mlConfidence.toFixed(1)}%), reducing size`;
      } else {
        tier = 'WEAK';
        proceed = true;
        sizeMultiplier = 0.9;
        reason = `ML uncertain (${mlConfidence.toFixed(1)}%), slight size reduction`;
      }
    }

    // Adversarial override: if adversarial strongly disagrees, reduce further
    if (advConsensus) {
      if (advConsensus.consensus === 'REJECT') {
        if (mode === 'HARD_GATE') {
          proceed = false;
          sizeMultiplier = 0;
          reason += ' | Adversarial REJECT';
        } else {
          sizeMultiplier *= 0.5;
          reason += ` | Adversarial REJECT (bear=${advConsensus.bearConfidence.toFixed(1)}%)`;
        }
      } else if (advConsensus.consensus === 'CONTESTED') {
        sizeMultiplier *= 0.7;
        reason += ` | Adversarial CONTESTED (margin=${advConsensus.marginOfVictory.toFixed(1)})`;
      } else if (advConsensus.consensus === 'STRONG_BUY') {
        sizeMultiplier *= 1.1;
        reason += ' | Adversarial STRONG_BUY';
      }
      // WEAK_BUY: no change
    }

    // Clamp size multiplier
    sizeMultiplier = Math.max(0, Math.min(1.5, sizeMultiplier));

    // Record decision for accuracy tracking
    const decision = {
      ticker,
      proceed,
      confidence: mlConfidence,
      tier,
      sizeMultiplier,
      reason,
      mlPrediction,
      adversarialConsensus: advConsensus,
      timestamp: Date.now(),
    };

    rollingDecisions.push(decision);
    if (rollingDecisions.length > MAX_ROLLING) {
      rollingDecisions.shift();
    }

    // Log to DB
    try {
      insertGatekeeperDecision({
        ticker,
        decision: proceed ? 'PROCEED' : 'BLOCK',
        ml_confidence: mlConfidence,
        tier,
        rule_strategy: ruleStrategy,
        rule_strength: ruleStrength,
        adversarial_consensus: advConsensus?.consensus || '',
        correlation_multiplier: 1, // Will be set by correlation engine
        final_size_multiplier: sizeMultiplier,
        reason,
      });
    } catch (e) {
      // Non-critical
    }

    // Check for auto-downgrade
    checkAutoDowngrade();

    return {
      proceed,
      confidence: mlConfidence,
      tier,
      sizeMultiplier,
      reason,
      mlPrediction,
      adversarialConsensus: advConsensus,
    };

  } catch (err) {
    console.error('[MLGatekeeper] Error evaluating entry:', err.message);
    return {
      proceed: true, // Fail open
      confidence: 0,
      tier: 'ERROR',
      sizeMultiplier: 1.0,
      reason: `MLGatekeeper error: ${err.message}`,
      mlPrediction: null,
      adversarialConsensus: null,
    };
  }
}

/**
 * Record the actual outcome of a gated trade for accuracy tracking.
 */
export function recordOutcome(ticker, tier, wasCorrect) {
  if (tierStats[tier]) {
    tierStats[tier].total++;
    if (wasCorrect) tierStats[tier].correct++;
  }

  // Update rolling decisions
  const recent = rollingDecisions.filter(d => d.ticker === ticker);
  if (recent.length > 0) {
    const last = recent[recent.length - 1];
    last.actualOutcome = wasCorrect ? 'CORRECT' : 'INCORRECT';
  }
}

/**
 * Check if we should auto-downgrade to ADVISORY mode
 */
function checkAutoDowngrade() {
  const threshold = getFlag('ML_AUTO_DOWNGRADE_THRESHOLD');
  const window = getFlag('ML_AUTO_DOWNGRADE_WINDOW');

  // Need resolved decisions
  const resolved = rollingDecisions.filter(d => d.actualOutcome);
  if (resolved.length < window / 2) return; // Not enough data

  const recent = resolved.slice(-window);
  const correct = recent.filter(d => d.actualOutcome === 'CORRECT').length;
  const accuracy = correct / recent.length;

  if (accuracy < threshold && !wasAutoDowngraded) {
    console.warn(`[MLGatekeeper] AUTO-DOWNGRADE: accuracy ${(accuracy*100).toFixed(1)}% < ${(threshold*100).toFixed(1)}% threshold — reverting to ADVISORY`);
    setFlag('ML_GATEKEEPER_MODE', 'ADVISORY');
    wasAutoDowngraded = true;
  } else if (accuracy >= threshold + 0.05 && wasAutoDowngraded) {
    // Auto-restore if accuracy recovers
    console.log(`[MLGatekeeper] Auto-restore: accuracy ${(accuracy*100).toFixed(1)}% recovered — restoring SOFT_GATE`);
    setFlag('ML_GATEKEEPER_MODE', 'SOFT_GATE');
    wasAutoDowngraded = false;
  }
}

/**
 * Get comprehensive gatekeeper stats
 */
export function getGatekeeperStats() {
  const resolved = rollingDecisions.filter(d => d.actualOutcome);
  const correct = resolved.filter(d => d.actualOutcome === 'CORRECT').length;

  return {
    mode: getFlag('ML_GATEKEEPER_MODE'),
    enabled: getFlag('ML_GATEKEEPER_ENABLED'),
    wasAutoDowngraded,
    totalDecisions: rollingDecisions.length,
    resolvedDecisions: resolved.length,
    overallAccuracy: resolved.length > 0 ? (correct / resolved.length * 100).toFixed(1) + '%' : 'N/A',
    tierStats: { ...tierStats },
    recentDecisions: rollingDecisions.slice(-10).map(d => ({
      ticker: d.ticker,
      tier: d.tier,
      proceed: d.proceed,
      confidence: d.confidence?.toFixed(1),
      outcome: d.actualOutcome || 'PENDING',
    })),
    hasMLEngine: !!mlEngine?.isTrained,
    hasAdversarial: !!adversarialBrains,
  };
}
