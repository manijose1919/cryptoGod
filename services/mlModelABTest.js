/**
 * ML Model A/B Testing — Compare model versions in production.
 *
 * When a new ML model is trained, instead of immediately replacing the old one,
 * this service runs both in parallel and tracks their performance on live data.
 * After sufficient data, it promotes the winner or rolls back to the champion.
 *
 * Design:
 * - "Champion" model: current production model
 * - "Challenger" model: newly trained model being tested
 * - Both score every entry signal; only Champion's decision is acted on
 * - After N decisions, compare metrics and auto-promote if Challenger wins
 *
 * Metrics tracked:
 * - Accuracy: Did the model correctly predict direction?
 * - Calibration: Are confidence levels accurate?
 * - Profit: Would trades based on this model's signals have been profitable?
 */

// ─── Configuration ───────────────────────────────────────────

const MIN_DECISIONS_FOR_COMPARISON = 50; // Need 50+ signals before comparing
const AUTO_PROMOTE_IMPROVEMENT = 5;      // Challenger must be 5%+ better to auto-promote
const MAX_CHALLENGER_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Max 7 days of testing

// ─── State ───────────────────────────────────────────────────

let champion = {
  modelId: null,
  version: 0,
  decisions: [],       // { ticker, prediction, confidence, actualOutcome, timestamp }
  accuracy: 0,
  profitSum: 0,
  promotedAt: Date.now(),
};

let challenger = null;  // Same structure, or null if no test running

let testHistory = [];   // Past A/B test results
const MAX_HISTORY = 20;

// ─── Public API ──────────────────────────────────────────────

/**
 * Register a new model as challenger.
 * @param {string} modelId - Unique model identifier
 * @param {number} version - Model version number
 */
export function registerChallenger(modelId, version) {
  if (challenger) {
    // Already testing — only replace if new challenger
    console.log(`[MLABTest] Replacing challenger ${challenger.modelId} with ${modelId}`);
    concludeTest('REPLACED');
  }

  challenger = {
    modelId,
    version,
    decisions: [],
    accuracy: 0,
    profitSum: 0,
    registeredAt: Date.now(),
  };

  console.log(`[MLABTest] New challenger registered: ${modelId} (v${version})`);
}

/**
 * Register the current champion model.
 */
export function setChampion(modelId, version) {
  champion.modelId = modelId;
  champion.version = version;
  champion.decisions = [];
  champion.accuracy = 0;
  champion.profitSum = 0;
  champion.promotedAt = Date.now();
  console.log(`[MLABTest] Champion set: ${modelId} (v${version})`);
}

/**
 * Record a prediction from both models.
 * @param {string} ticker
 * @param {Object} championPred - { direction: 'UP'|'DOWN', confidence: 0-100 }
 * @param {Object} challengerPred - { direction: 'UP'|'DOWN', confidence: 0-100 }
 */
export function recordPrediction(ticker, championPred, challengerPred) {
  const timestamp = Date.now();

  champion.decisions.push({
    ticker,
    prediction: championPred.direction,
    confidence: championPred.confidence,
    actualOutcome: null, // Filled in later
    timestamp,
  });

  if (challenger && challengerPred) {
    challenger.decisions.push({
      ticker,
      prediction: challengerPred.direction,
      confidence: challengerPred.confidence,
      actualOutcome: null,
      timestamp,
    });
  }

  // Trim old decisions
  if (champion.decisions.length > 500) champion.decisions = champion.decisions.slice(-500);
  if (challenger?.decisions.length > 500) challenger.decisions = challenger.decisions.slice(-500);
}

/**
 * Record actual trade outcome to evaluate predictions.
 * @param {string} ticker
 * @param {string} actualDirection - 'UP' or 'DOWN'
 * @param {number} pnlPercent - Actual P&L if traded
 * @param {number} timestamp - Approximate time of prediction
 */
export function recordOutcome(ticker, actualDirection, pnlPercent, timestamp) {
  // Find matching predictions within 5 minutes of the timestamp
  const tolerance = 5 * 60 * 1000;

  for (const dec of champion.decisions) {
    if (dec.ticker === ticker && !dec.actualOutcome && Math.abs(dec.timestamp - timestamp) < tolerance) {
      dec.actualOutcome = actualDirection;
      dec.pnl = pnlPercent;
      break;
    }
  }

  if (challenger) {
    for (const dec of challenger.decisions) {
      if (dec.ticker === ticker && !dec.actualOutcome && Math.abs(dec.timestamp - timestamp) < tolerance) {
        dec.actualOutcome = actualDirection;
        dec.pnl = pnlPercent;
        break;
      }
    }
  }

  // Recalculate metrics
  updateMetrics();

  // Check for auto-promotion
  checkPromotion();
}

/**
 * Update accuracy and profit metrics for both models.
 */
function updateMetrics() {
  const resolved = champion.decisions.filter(d => d.actualOutcome);
  if (resolved.length > 0) {
    const correct = resolved.filter(d => d.prediction === d.actualOutcome).length;
    champion.accuracy = (correct / resolved.length) * 100;
    champion.profitSum = resolved.reduce((sum, d) => sum + (d.pnl || 0), 0);
  }

  if (challenger) {
    const resolved = challenger.decisions.filter(d => d.actualOutcome);
    if (resolved.length > 0) {
      const correct = resolved.filter(d => d.prediction === d.actualOutcome).length;
      challenger.accuracy = (correct / resolved.length) * 100;
      challenger.profitSum = resolved.reduce((sum, d) => sum + (d.pnl || 0), 0);
    }
  }
}

/**
 * Check if challenger should be promoted or rejected.
 */
function checkPromotion() {
  if (!challenger) return;

  const champResolved = champion.decisions.filter(d => d.actualOutcome).length;
  const challResolved = challenger.decisions.filter(d => d.actualOutcome).length;

  // Not enough data yet
  if (champResolved < MIN_DECISIONS_FOR_COMPARISON || challResolved < MIN_DECISIONS_FOR_COMPARISON) {
    // Check age limit
    if (Date.now() - challenger.registeredAt > MAX_CHALLENGER_AGE_MS) {
      console.log(`[MLABTest] Challenger ${challenger.modelId} expired (${MAX_CHALLENGER_AGE_MS / 86400000}d limit)`);
      concludeTest('EXPIRED');
    }
    return;
  }

  const improvement = challenger.accuracy - champion.accuracy;
  const profitDiff = challenger.profitSum - champion.profitSum;

  if (improvement >= AUTO_PROMOTE_IMPROVEMENT && profitDiff > 0) {
    // Promote challenger to champion
    console.log(`[MLABTest] Promoting challenger ${challenger.modelId}: +${improvement.toFixed(1)}% accuracy, +$${profitDiff.toFixed(2)} profit`);
    concludeTest('PROMOTED');

    champion = {
      modelId: challenger.modelId,
      version: challenger.version,
      decisions: [],
      accuracy: 0,
      profitSum: 0,
      promotedAt: Date.now(),
    };
    challenger = null;
  } else if (champResolved >= MIN_DECISIONS_FOR_COMPARISON * 2) {
    // Enough data and challenger isn't winning — reject
    console.log(`[MLABTest] Rejecting challenger ${challenger.modelId}: ${improvement.toFixed(1)}% accuracy diff`);
    concludeTest('REJECTED');
  }
}

/**
 * Record the conclusion of an A/B test.
 */
function concludeTest(outcome) {
  if (!challenger) return;

  testHistory.push({
    championId: champion.modelId,
    challengerId: challenger.modelId,
    outcome,
    championAccuracy: champion.accuracy.toFixed(1) + '%',
    challengerAccuracy: challenger.accuracy.toFixed(1) + '%',
    championProfit: champion.profitSum.toFixed(2),
    challengerProfit: challenger.profitSum.toFixed(2),
    champDecisions: champion.decisions.filter(d => d.actualOutcome).length,
    challDecisions: challenger.decisions.filter(d => d.actualOutcome).length,
    duration: Date.now() - challenger.registeredAt,
    timestamp: Date.now(),
  });

  if (testHistory.length > MAX_HISTORY) testHistory.shift();

  if (outcome !== 'PROMOTED') {
    challenger = null;
  }
}

/**
 * Get which model to use for a decision (always champion).
 */
export function getActiveModel() {
  return {
    modelId: champion.modelId,
    version: champion.version,
    isChampion: true,
  };
}

/**
 * Get A/B test status for dashboard.
 */
export function getABTestStatus() {
  return {
    champion: {
      modelId: champion.modelId,
      version: champion.version,
      accuracy: champion.accuracy.toFixed(1) + '%',
      profitSum: champion.profitSum.toFixed(2),
      resolvedDecisions: champion.decisions.filter(d => d.actualOutcome).length,
      totalDecisions: champion.decisions.length,
      promotedAt: champion.promotedAt,
    },
    challenger: challenger ? {
      modelId: challenger.modelId,
      version: challenger.version,
      accuracy: challenger.accuracy.toFixed(1) + '%',
      profitSum: challenger.profitSum.toFixed(2),
      resolvedDecisions: challenger.decisions.filter(d => d.actualOutcome).length,
      totalDecisions: challenger.decisions.length,
      registeredAt: challenger.registeredAt,
      ageHours: ((Date.now() - challenger.registeredAt) / 3600000).toFixed(1),
    } : null,
    testRunning: challenger !== null,
    testHistory: testHistory.slice(-5),
    config: {
      minDecisions: MIN_DECISIONS_FOR_COMPARISON,
      autoPromoteThreshold: AUTO_PROMOTE_IMPROVEMENT + '%',
      maxTestDays: MAX_CHALLENGER_AGE_MS / 86400000,
    },
  };
}

export default {
  registerChallenger,
  setChampion,
  recordPrediction,
  recordOutcome,
  getActiveModel,
  getABTestStatus,
};
