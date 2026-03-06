/**
 * Self-Teaching Loop Service
 * Phase 5: Orchestrates the feedback loop for continuous ML improvement
 *
 * Flow:
 * 1. Trade completes → label feature vector
 * 2. Update adaptive thresholds
 * 3. Check if retrain needed (time or sample count)
 * 4. Retrain model → evaluate → update strategy weights
 * 5. Track performance over time
 */

// Dynamic imports with fallback
let mlPredictionService = null;
let adaptiveThresholds = null;

try {
  mlPredictionService = await import('./mlPredictionService.js');
} catch (e) {
  console.warn('[SelfTeach] mlPredictionService not available:', e.message);
}

try {
  adaptiveThresholds = await import('./adaptiveThresholds.js');
} catch (e) {
  console.warn('[SelfTeach] adaptiveThresholds not available:', e.message);
}

// ML Pipeline imports (4-Layer System)
let adversarialBrains = null;
let geneticEngine = null;
let mlGatekeeper = null;
let portfolioCorrelationEngine = null;

try {
  adversarialBrains = await import('./adversarialBrains.js');
} catch (e) {
  console.warn('[SelfTeach] adversarialBrains not available:', e.message);
}

try {
  geneticEngine = await import('./geneticStrategyEngine.js');
} catch (e) {
  console.warn('[SelfTeach] geneticEngine not available:', e.message);
}

try {
  mlGatekeeper = await import('./mlGatekeeper.js');
} catch (e) {
  console.warn('[SelfTeach] mlGatekeeper not available:', e.message);
}

try {
  portfolioCorrelationEngine = await import('./portfolioCorrelationEngine.js');
} catch (e) {
  console.warn('[SelfTeach] portfolioCorrelationEngine not available:', e.message);
}

let systemConfig = null;
try {
  systemConfig = await import('./systemConfig.js');
} catch (e) {
  console.warn('[SelfTeach] systemConfig not available:', e.message);
}

import {
  getLabeledFeatures,
  getUnlabeledFeatures,
  labelMLFeatures,
  getMLAccuracyStats,
  getLatestMLModel
} from './database.js';

// State
let isRunning = false;
let checkInterval = null;
let lastRetrainTime = 0;
let totalTradesProcessed = 0;
let retrainCount = 0;
let newSamplesSinceRetrain = 0;
let performanceHistory = [];

// Accumulated trade results for genetic evolution fitness
const recentTradeResults = []; // { pnl, pnlPercent, strategy, ticker, outcome }
const MAX_TRADE_RESULTS = 100;

// Configuration
const RETRAIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_NEW_SAMPLES = 20;                   // minimum new labeled samples to trigger retrain
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // check every 5 minutes
const MAX_HISTORY_LENGTH = 20;               // keep last 20 performance snapshots
const MIN_SAMPLES_FOR_RELIABILITY = 100;     // minimum samples before predictions are reliable
const HIGH_ANOMALY_THRESHOLD = 0.15;         // 15% anomaly rate is high
const ACCURACY_IMPROVEMENT_THRESHOLD = 0.02; // 2% improvement threshold

/**
 * Start the self-teaching loop
 * @returns {Function} Cleanup function to stop the loop
 */
export function startSelfTeaching() {
  if (isRunning) {
    console.log('[SelfTeach] Already running');
    return stopSelfTeaching;
  }

  console.log('[SelfTeach] Starting self-teaching loop');
  isRunning = true;
  newSamplesSinceRetrain = 0;

  // Initialize with current state
  try {
    const stats = getMLAccuracyStats();
    if (stats) {
      performanceHistory.push({
        time: Date.now(),
        accuracy: stats.accuracy || 0,
        sampleCount: stats.total_predictions || 0,
        modelType: 'initial'
      });
    }
  } catch (e) {
    console.warn('[SelfTeach] Could not load initial stats:', e.message);
  }

  // Set up periodic check
  checkInterval = setInterval(async () => {
    try {
      await checkAndRetrain();
    } catch (error) {
      console.error('[SelfTeach] Error in check cycle:', error);
    }
  }, CHECK_INTERVAL_MS);

  console.log(`[SelfTeach] Check interval set to ${CHECK_INTERVAL_MS / 1000}s`);

  return stopSelfTeaching;
}

/**
 * Stop the self-teaching loop
 */
export function stopSelfTeaching() {
  if (!isRunning) {
    return;
  }

  console.log('[SelfTeach] Stopping self-teaching loop');
  isRunning = false;

  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/**
 * Called when a trade completes
 * Labels the ML feature vector and updates adaptive thresholds
 *
 * @param {Object} tradeData - Trade outcome data
 * @param {string} tradeData.ticker - Trading pair
 * @param {string} tradeData.strategy - Strategy used
 * @param {number} tradeData.entryTime - Entry timestamp
 * @param {number} tradeData.exitTime - Exit timestamp
 * @param {number} tradeData.entryPrice - Entry price
 * @param {number} tradeData.exitPrice - Exit price
 * @param {number} tradeData.pnl - Absolute PnL
 * @param {number} tradeData.pnlPercent - PnL percentage
 * @param {string} tradeData.outcome - 'WIN' | 'LOSS' | 'BREAKEVEN'
 */
export async function onTradeComplete(tradeData) {
  if (!tradeData || !tradeData.ticker || !tradeData.outcome) {
    console.warn('[SelfTeach] Invalid trade data received:', tradeData);
    return;
  }

  console.log(`[SelfTeach] Processing trade: ${tradeData.ticker} ${tradeData.strategy} → ${tradeData.outcome} (${tradeData.pnlPercent?.toFixed(2)}%)`);

  try {
    // 1. Record trade outcome in ML service (labels the feature vector)
    if (mlPredictionService?.recordTradeOutcome) {
      await mlPredictionService.recordTradeOutcome(
        tradeData.ticker,
        tradeData.entryTime,
        tradeData.outcome,
        tradeData.pnlPercent != null ? tradeData.pnlPercent : (tradeData.pnl != null ? tradeData.pnl : 0)
      );
    } else {
      console.warn('[SelfTeach] ML prediction service not available, cannot label features');
    }

    // 2. Update adaptive thresholds
    if (adaptiveThresholds?.updateFromTrade) {
      const thresholdUpdate = {
        ticker: tradeData.ticker,
        strategy: tradeData.strategy,
        success: tradeData.outcome === 'WIN',
        pnl: tradeData.pnl,
        pnlPercent: tradeData.pnlPercent,
        holdTime: tradeData.exitTime - tradeData.entryTime,
        timestamp: tradeData.exitTime
      };
      adaptiveThresholds.updateFromTrade(thresholdUpdate);
    } else {
      console.warn('[SelfTeach] Adaptive thresholds service not available');
    }

    // 3. Feed to ML Pipeline systems
    // 3a. Record gatekeeper accuracy (System A)
    if (mlGatekeeper?.recordOutcome) {
      try {
        mlGatekeeper.recordOutcome(
          tradeData.ticker,
          tradeData.pipelineTier || 'UNKNOWN',
          tradeData.outcome === 'WIN'
        );
      } catch (e) {
        console.warn('[SelfTeach] Gatekeeper outcome recording failed:', e.message);
      }
    }

    // 3b. Train adversarial Bear model with inverted label (System D)
    // Note: actual retraining happens in checkAndRetrain() to batch samples
    // Here we just count toward the retrain threshold

    // 3c. Feed genetic evolution results (System B)
    if (systemConfig?.getFlag('GENETIC_ENABLED') && geneticEngine?.getPopulation) {
      try {
        const pop = geneticEngine.getPopulation();
        // Record which genomes were correct — simplified: we record all genome results
        // since we can't track per-genome per-trade in real-time
        // The actual evolution happens in checkAndRetrain()
      } catch (e) {
        console.warn('[SelfTeach] Genetic feedback failed:', e.message);
      }
    }

    // 4. Accumulate trade result for genetic evolution fitness
    recentTradeResults.push({
      pnl: tradeData.pnl || 0,
      pnlPercent: tradeData.pnlPercent || 0,
      strategy: tradeData.strategy,
      ticker: tradeData.ticker,
      outcome: tradeData.outcome,
    });
    if (recentTradeResults.length > MAX_TRADE_RESULTS) recentTradeResults.shift();

    // 5. Update counters
    totalTradesProcessed++;
    newSamplesSinceRetrain++;

    console.log(`[SelfTeach] Trade processed. Total: ${totalTradesProcessed}, New since retrain: ${newSamplesSinceRetrain}`);

    // 4. Check if immediate retrain needed (if we hit sample threshold)
    if (newSamplesSinceRetrain >= MIN_NEW_SAMPLES) {
      console.log(`[SelfTeach] Sample threshold reached (${newSamplesSinceRetrain}/${MIN_NEW_SAMPLES}), triggering retrain`);
      await checkAndRetrain();
    }

  } catch (error) {
    console.error('[SelfTeach] Error processing trade:', error);
  }
}

/**
 * Check conditions and retrain model if needed
 */
export async function checkAndRetrain() {
  if (!mlPredictionService?.trainModel) {
    console.warn('[SelfTeach] ML prediction service not available for retraining');
    return;
  }

  const now = Date.now();
  const timeSinceRetrain = now - lastRetrainTime;
  const hasEnoughNewSamples = newSamplesSinceRetrain >= MIN_NEW_SAMPLES;
  const hasBeenLongEnough = timeSinceRetrain >= RETRAIN_INTERVAL_MS && newSamplesSinceRetrain >= 5;

  if (!hasEnoughNewSamples && !hasBeenLongEnough) {
    console.log(`[SelfTeach] No retrain needed. Samples: ${newSamplesSinceRetrain}/${MIN_NEW_SAMPLES}, Time: ${(timeSinceRetrain / 60000).toFixed(1)}m`);
    return;
  }

  console.log(`[SelfTeach] Starting model retrain. Samples: ${newSamplesSinceRetrain}, Time: ${(timeSinceRetrain / 60000).toFixed(1)}m`);

  try {
    // Get current accuracy before retrain
    let oldAccuracy = 0;
    let oldSampleCount = 0;
    try {
      const oldStats = getMLAccuracyStats();
      if (oldStats) {
        oldAccuracy = oldStats.accuracy || 0;
        oldSampleCount = oldStats.total_predictions || 0;
      }
    } catch (e) {
      console.warn('[SelfTeach] Could not get old accuracy:', e.message);
    }

    // Retrain the model
    const retrainResult = await mlPredictionService.trainModel();

    if (!retrainResult.success) {
      console.error('[SelfTeach] Model retrain failed:', retrainResult.error);
      return;
    }

    // Get new accuracy after retrain
    let newAccuracy = 0;
    let newSampleCount = 0;
    let featureImportance = null;

    try {
      const newStats = getMLAccuracyStats();
      if (newStats) {
        newAccuracy = newStats.accuracy || 0;
        newSampleCount = newStats.total_predictions || 0;
      }

      const latestModel = getLatestMLModel();
      if (latestModel?.feature_importance) {
        try {
          featureImportance = JSON.parse(latestModel.feature_importance);
        } catch (e) {
          console.warn('[SelfTeach] Could not parse feature importance');
        }
      }
    } catch (e) {
      console.warn('[SelfTeach] Could not get new accuracy:', e.message);
    }

    // Update performance history
    performanceHistory.push({
      time: now,
      accuracy: newAccuracy,
      sampleCount: newSampleCount,
      modelType: retrainResult.modelType || 'unknown'
    });

    // Trim history to max length
    if (performanceHistory.length > MAX_HISTORY_LENGTH) {
      performanceHistory = performanceHistory.slice(-MAX_HISTORY_LENGTH);
    }

    // Evaluate performance change
    const accuracyChange = newAccuracy - oldAccuracy;
    const accuracyChangePercent = oldAccuracy > 0 ? (accuracyChange / oldAccuracy) * 100 : 0;

    console.log(`[SelfTeach] Retrain complete. Accuracy: ${(oldAccuracy * 100).toFixed(1)}% → ${(newAccuracy * 100).toFixed(1)}% (${accuracyChangePercent > 0 ? '+' : ''}${accuracyChangePercent.toFixed(1)}%)`);

    // Update strategy weights based on feature importance
    if (featureImportance && adaptiveThresholds?.updateStrategyWeights) {
      const weightAdjustments = updateStrategyWeights(featureImportance);
      adaptiveThresholds.updateStrategyWeights(weightAdjustments);
      console.log('[SelfTeach] Updated strategy weights based on feature importance');
    }

    // ===== ML Pipeline: Retrain all 4 systems =====

    // System D: Retrain adversarial brains (bull + bear)
    if (systemConfig?.getFlag('ADVERSARIAL_ENABLED') && adversarialBrains?.trainBoth) {
      try {
        const labeledFeatures = getLabeledFeatures(5000);
        if (labeledFeatures.length >= 200) {
          const features2D = labeledFeatures.map(f => JSON.parse(f.features_json));
          const labels = labeledFeatures.map(f => f.label_value >= 0 ? 1 : 0);
          const advResult = adversarialBrains.trainBoth(features2D, labels);
          if (advResult.success) {
            console.log(`[SelfTeach] Adversarial brains retrained: bull=${(advResult.bull.validationAccuracy*100).toFixed(1)}%, bear=${(advResult.bear.validationAccuracy*100).toFixed(1)}%`);
          }
        }
      } catch (e) {
        console.warn('[SelfTeach] Adversarial retrain failed:', e.message);
      }
    }

    // System B: Evolve genetic population with accumulated trade results as fitness
    if (systemConfig?.getFlag('GENETIC_ENABLED') && geneticEngine?.getPopulation) {
      try {
        const pop = geneticEngine.getPopulation();
        if (pop.genomes.length > 0 && recentTradeResults.length > 0) {
          // Pass real trade results as fitness signal
          pop.evolve(recentTradeResults);
          pop.persist();
          console.log(`[SelfTeach] Genetic evolution: gen ${pop.generation}, fitness from ${recentTradeResults.length} trades`);
        } else if (pop.genomes.length > 0) {
          // No trades yet — skip evolution (don't evolve with empty fitness)
          console.log(`[SelfTeach] Genetic evolution skipped: no trade results yet`);
        }
      } catch (e) {
        console.warn('[SelfTeach] Genetic evolution failed:', e.message);
      }
    }
    // ===== END ML Pipeline =====

    // Reset counters
    lastRetrainTime = now;
    newSamplesSinceRetrain = 0;
    retrainCount++;

    console.log(`[SelfTeach] Retrain #${retrainCount} complete. Next check in ${CHECK_INTERVAL_MS / 60000}m`);

  } catch (error) {
    console.error('[SelfTeach] Error during retrain:', error);
  }
}

/**
 * Update strategy weights based on ML feature importance
 *
 * @param {Object} featureImportance - Feature importance scores from ML model
 * @returns {Object} Strategy weight adjustments
 */
function updateStrategyWeights(featureImportance) {
  if (!featureImportance || typeof featureImportance !== 'object') {
    return {};
  }

  const adjustments = {
    TREND: 1.0,
    BREAKOUT: 1.0,
    WHALE: 1.0,
    CONFLUENCE: 1.0,
    MOMENTUM: 1.0,
    DIVERGENCE: 1.0,
    ADAPTIVE: 1.0
  };

  try {
    // Calculate category importance
    const technicalImportance = (featureImportance.rsi || 0) +
                                 (featureImportance.macd_line || 0) +
                                 (featureImportance.ema_20 || 0);

    const sentimentImportance = (featureImportance.sentiment || 0) +
                                 (featureImportance.sentiment_regime_score || 0);

    const whaleImportance = (featureImportance.whale_activity || 0) +
                             (featureImportance.exchange_flow || 0);

    const volatilityImportance = (featureImportance.volatility || 0) +
                                  (featureImportance.volume_ratio || 0);

    // Normalize to total importance
    const totalImportance = technicalImportance + sentimentImportance + whaleImportance + volatilityImportance;

    if (totalImportance === 0) {
      return adjustments;
    }

    // Adjust weights based on relative importance
    // High sentiment → boost MOMENTUM and DIVERGENCE
    if (sentimentImportance / totalImportance > 0.3) {
      adjustments.MOMENTUM = 1.15;
      adjustments.DIVERGENCE = 1.10;
      console.log('[SelfTeach] Sentiment features important → boosting MOMENTUM/DIVERGENCE');
    }

    // High whale activity → boost WHALE and CONFLUENCE
    if (whaleImportance / totalImportance > 0.25) {
      adjustments.WHALE = 1.20;
      adjustments.CONFLUENCE = 1.10;
      console.log('[SelfTeach] Whale features important → boosting WHALE/CONFLUENCE');
    }

    // High volatility → boost BREAKOUT
    if (volatilityImportance / totalImportance > 0.3) {
      adjustments.BREAKOUT = 1.15;
      adjustments.ADAPTIVE = 1.10;
      console.log('[SelfTeach] Volatility features important → boosting BREAKOUT/ADAPTIVE');
    }

    // High technical → boost TREND
    if (technicalImportance / totalImportance > 0.35) {
      adjustments.TREND = 1.15;
      adjustments.CONFLUENCE = 1.10;
      console.log('[SelfTeach] Technical features important → boosting TREND/CONFLUENCE');
    }

  } catch (error) {
    console.error('[SelfTeach] Error calculating strategy weights:', error);
  }

  return adjustments;
}

/**
 * Get comprehensive performance report
 *
 * @returns {Object} Performance report with trends and recommendations
 */
export function getPerformanceReport() {
  const report = {
    totalTradesProcessed,
    retrainCount,
    lastRetrainTime,
    newSamplesSinceRetrain,
    performanceHistory: [...performanceHistory],
    currentAccuracy: 0,
    improvementTrend: 'UNKNOWN',
    recommendations: []
  };

  try {
    // Get current accuracy
    const stats = getMLAccuracyStats();
    if (stats) {
      report.currentAccuracy = stats.accuracy || 0;
    }

    // Calculate trend
    if (performanceHistory.length >= 10) {
      const recent5 = performanceHistory.slice(-5);
      const previous5 = performanceHistory.slice(-10, -5);

      const recentAvg = recent5.reduce((sum, h) => sum + h.accuracy, 0) / 5;
      const previousAvg = previous5.reduce((sum, h) => sum + h.accuracy, 0) / 5;

      const improvement = recentAvg - previousAvg;

      if (improvement > ACCURACY_IMPROVEMENT_THRESHOLD) {
        report.improvementTrend = 'IMPROVING';
      } else if (improvement < -ACCURACY_IMPROVEMENT_THRESHOLD) {
        report.improvementTrend = 'DEGRADING';
      } else {
        report.improvementTrend = 'STABLE';
      }
    } else if (performanceHistory.length >= 2) {
      const latest = performanceHistory[performanceHistory.length - 1];
      const previous = performanceHistory[performanceHistory.length - 2];
      const improvement = latest.accuracy - previous.accuracy;

      if (improvement > ACCURACY_IMPROVEMENT_THRESHOLD) {
        report.improvementTrend = 'IMPROVING';
      } else if (improvement < -ACCURACY_IMPROVEMENT_THRESHOLD) {
        report.improvementTrend = 'DEGRADING';
      } else {
        report.improvementTrend = 'STABLE';
      }
    }

    // Generate recommendations
    report.recommendations = generateRecommendations(report);

  } catch (error) {
    console.error('[SelfTeach] Error generating performance report:', error);
  }

  return report;
}

/**
 * Generate human-readable recommendations
 *
 * @param {Object} report - Performance report data
 * @returns {Array<string>} Recommendations
 */
function generateRecommendations(report) {
  const recommendations = [];

  try {
    const { currentAccuracy, improvementTrend, performanceHistory, totalTradesProcessed } = report;

    // Sample size recommendations
    if (totalTradesProcessed < MIN_SAMPLES_FOR_RELIABILITY) {
      recommendations.push(
        `Not enough training data (${totalTradesProcessed}/${MIN_SAMPLES_FOR_RELIABILITY} minimum) - ML predictions not yet reliable. Continue trading to build dataset.`
      );
    } else if (totalTradesProcessed < MIN_SAMPLES_FOR_RELIABILITY * 2) {
      recommendations.push(
        `Training data building up (${totalTradesProcessed}/${MIN_SAMPLES_FOR_RELIABILITY * 2} recommended) - ML predictions gaining reliability.`
      );
    }

    // Accuracy recommendations
    if (currentAccuracy >= 0.65) {
      recommendations.push(
        `Model performing well at ${(currentAccuracy * 100).toFixed(1)}% accuracy - predictions are reliable. Consider increasing position sizes.`
      );
    } else if (currentAccuracy >= 0.55) {
      recommendations.push(
        `Model performing moderately at ${(currentAccuracy * 100).toFixed(1)}% accuracy - predictions are somewhat reliable. Maintain current position sizes.`
      );
    } else if (currentAccuracy > 0) {
      recommendations.push(
        `Model accuracy low at ${(currentAccuracy * 100).toFixed(1)}% - predictions unreliable. Reduce position sizes until model improves.`
      );
    }

    // Trend recommendations
    if (improvementTrend === 'IMPROVING' && performanceHistory.length >= 5) {
      const oldest = performanceHistory[performanceHistory.length - 5];
      const latest = performanceHistory[performanceHistory.length - 1];
      const improvement = ((latest.accuracy - oldest.accuracy) * 100).toFixed(1);

      recommendations.push(
        `Model accuracy improving: ${(oldest.accuracy * 100).toFixed(1)}% → ${(latest.accuracy * 100).toFixed(1)}% over last ${performanceHistory.length >= 10 ? '5 retrains' : 'recent retrains'} (+${improvement}%). Self-teaching is working effectively.`
      );
    } else if (improvementTrend === 'DEGRADING') {
      recommendations.push(
        `Model accuracy declining - market conditions may have changed significantly. Consider reviewing strategy parameters and data quality.`
      );
    } else if (improvementTrend === 'STABLE' && currentAccuracy >= 0.55) {
      recommendations.push(
        `Model accuracy stable at ${(currentAccuracy * 100).toFixed(1)}% - good equilibrium reached. Continue current trading approach.`
      );
    }

    // Check for anomalies if we have recent ML predictions
    try {
      const stats = getMLAccuracyStats();
      if (stats && stats.total_predictions > 0) {
        const anomalyRate = 0; // Would need to track this in database
        if (anomalyRate > HIGH_ANOMALY_THRESHOLD) {
          recommendations.push(
            `Anomaly rate high (${(anomalyRate * 100).toFixed(1)}%) - market conditions unusual. Reduce position sizes and increase caution.`
          );
        }
      }
    } catch (e) {
      // Ignore if stats not available
    }

    // Feature importance recommendations
    try {
      const latestModel = getLatestMLModel();
      if (latestModel?.feature_importance) {
        const importance = JSON.parse(latestModel.feature_importance);
        const topFeature = Object.entries(importance)
          .sort(([, a], [, b]) => b - a)[0];

        if (topFeature && topFeature[1] > 0.15) {
          const featureName = topFeature[0];
          if (featureName.includes('sentiment')) {
            recommendations.push(
              `Sentiment features gaining importance (${(topFeature[1] * 100).toFixed(1)}%) - consider increasing sentiment data collection frequency.`
            );
          } else if (featureName.includes('whale') || featureName.includes('exchange')) {
            recommendations.push(
              `On-chain features important (${(topFeature[1] * 100).toFixed(1)}%) - whale activity and exchange flows are strong signals.`
            );
          } else if (featureName.includes('volume')) {
            recommendations.push(
              `Volume features important (${(topFeature[1] * 100).toFixed(1)}%) - pay close attention to volume confirmation.`
            );
          }
        }
      }
    } catch (e) {
      // Ignore if feature importance not available
    }

    // Retrain frequency recommendations
    if (retrainCount === 0) {
      recommendations.push(
        `No retrains yet - waiting for ${MIN_NEW_SAMPLES} trades or ${RETRAIN_INTERVAL_MS / 60000}m to pass.`
      );
    } else if (newSamplesSinceRetrain >= MIN_NEW_SAMPLES * 0.8) {
      recommendations.push(
        `Approaching retrain threshold (${newSamplesSinceRetrain}/${MIN_NEW_SAMPLES}) - model will update soon with new market patterns.`
      );
    }

  } catch (error) {
    console.error('[SelfTeach] Error generating recommendations:', error);
    recommendations.push('Error generating recommendations - see logs for details.');
  }

  return recommendations;
}

/**
 * Get current status
 *
 * @returns {Object} Current status
 */
export function getStatus() {
  return {
    isRunning,
    totalTradesProcessed,
    retrainCount,
    lastRetrainTime,
    newSamplesSinceRetrain,
    nextCheckIn: isRunning ? CHECK_INTERVAL_MS - (Date.now() - lastRetrainTime) % CHECK_INTERVAL_MS : null
  };
}

// Log service initialization
console.log('[SelfTeach] Service initialized');
