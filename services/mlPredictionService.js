/**
 * ML Prediction Service - Main orchestrator for ML prediction pipeline
 *
 * Coordinates:
 * - Feature engineering (buildFeatureVector)
 * - ML predictions (MLEngine)
 * - Anomaly detection (MarketAnomalyDetector)
 * - Database persistence
 * - Model training/retraining
 *
 * Called by bot loop to get ML-based trade recommendations.
 */

// Imports with resilient error handling
let buildFeatureVector, FEATURE_COUNT, getFeatureNames;
let MLEngine;
let MarketAnomalyDetector;
let db;

try {
  const featureModule = await import('./featureEngineering.js');
  buildFeatureVector = featureModule.buildFeatureVector;
  FEATURE_COUNT = featureModule.FEATURE_COUNT;
  getFeatureNames = featureModule.getFeatureNames;
} catch (err) {
  console.error('[ML Prediction] Failed to import featureEngineering.js:', err.message);
}

try {
  const mlEngineModule = await import('./mlEngine.js');
  MLEngine = mlEngineModule.MLEngine;
} catch (err) {
  console.error('[ML Prediction] Failed to import mlEngine.js:', err.message);
}

try {
  const anomalyModule = await import('./anomalyDetector.js');
  MarketAnomalyDetector = anomalyModule.MarketAnomalyDetector;
} catch (err) {
  console.error('[ML Prediction] Failed to import anomalyDetector.js:', err.message);
}

try {
  db = await import('./database.js');
} catch (err) {
  console.error('[ML Prediction] Failed to import database.js:', err.message);
}

// State
let mlEngine = null;
let anomalyDetector = null;
let isInitialized = false;
let lastTrainTime = 0;
let predictionCount = 0;
const MIN_SAMPLES_TO_TRAIN = 100;
const RETRAIN_INTERVAL = 60 * 60 * 1000; // 1 hour
const RETRAIN_SAMPLE_THRESHOLD = 200; // retrain every 200 new samples
let samplesSinceLastTrain = 0;

/**
 * Initialize ML system - load saved model or train initial model
 */
export async function initializeML() {
  try {
    console.log('[ML Prediction] Initializing ML system...');

    if (!MLEngine || !MarketAnomalyDetector || !buildFeatureVector) {
      console.warn('[ML Prediction] Required modules not loaded, skipping initialization');
      return false;
    }

    // Create engine instances
    mlEngine = new MLEngine();
    anomalyDetector = new MarketAnomalyDetector();

    // Try to load saved model
    try {
      if (db && db.getLatestMLModel) {
        const savedModel = db.getLatestMLModel();
        if (savedModel && savedModel.model_data) {
          const modelData = JSON.parse(savedModel.model_data);
          mlEngine.deserialize(modelData);
          console.log('[ML Prediction] Loaded saved model from database');
          console.log(`[ML Prediction] Model metrics: accuracy=${savedModel.accuracy?.toFixed(2)}%, precision=${savedModel.precision?.toFixed(2)}%`);
          lastTrainTime = new Date(savedModel.trained_at).getTime();
        }
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to load saved model:', err.message);
    }

    // If no saved model, check if we can train one
    if (!mlEngine.getModelStatus().isTrained) {
      try {
        if (db && db.getLabeledFeatures) {
          const labeledSamples = db.getLabeledFeatures();
          console.log(`[ML Prediction] Found ${labeledSamples.length} labeled samples`);

          if (labeledSamples.length >= MIN_SAMPLES_TO_TRAIN) {
            console.log('[ML Prediction] Enough samples to train initial model...');
            await trainModel();
          } else {
            console.log(`[ML Prediction] Need ${MIN_SAMPLES_TO_TRAIN - labeledSamples.length} more samples to train initial model`);
          }
        }
      } catch (err) {
        console.warn('[ML Prediction] Failed to check/train initial model:', err.message);
      }
    }

    isInitialized = true;
    console.log('[ML Prediction] Initialization complete');
    return true;

  } catch (err) {
    console.error('[ML Prediction] Initialization error:', err);
    return false;
  }
}

/**
 * Main entry point - should we take this trade?
 *
 * @param {string} ticker - Trading pair (e.g., 'BTCUSD')
 * @param {Array} candles - OHLCV candles
 * @param {string} strategy - Trading strategy
 * @param {Object} options - Additional context
 * @returns {Object} { take, confidence, direction, anomaly, prediction, reason, mlAvailable }
 */
export async function shouldTradeML(ticker, candles, strategy, options = {}) {
  try {
    if (!isInitialized || !mlEngine || !anomalyDetector || !buildFeatureVector) {
      return {
        take: true,
        mlAvailable: false,
        confidence: 50,
        reason: 'ML system not initialized, deferring to existing logic'
      };
    }

    const {
      exchangeSnapshot,
      derivativesData,
      sentimentData,
      defiData,
      marketRegime,
      lastTradeTime
    } = options;

    // Step 1: Build feature vector
    let features;
    try {
      features = buildFeatureVector({
        ticker,
        candles,
        strategy,
        exchangeSnapshot,
        derivativesData,
        sentimentData,
        defiData,
        marketRegime,
        lastTradeTime
      });

      if (!features || features.length !== FEATURE_COUNT) {
        console.warn(`[ML Prediction] Invalid feature vector length: ${features?.length}, expected ${FEATURE_COUNT}`);
        return {
          take: true,
          mlAvailable: false,
          confidence: 50,
          reason: 'Invalid feature vector, deferring to existing logic'
        };
      }
    } catch (err) {
      console.error('[ML Prediction] Feature engineering error:', err);
      return {
        take: true,
        mlAvailable: false,
        confidence: 50,
        reason: 'Feature engineering failed, deferring to existing logic'
      };
    }

    // Step 2: Store features in DB for future labeling
    try {
      if (db && db.insertMLFeatures) {
        db.insertMLFeatures({
          ticker,
          strategy,
          features_json: JSON.stringify(features),
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to store features:', err.message);
    }

    // Step 3: Check for market anomalies
    let anomalyResult = { isAnomaly: false, severity: 'NORMAL', recommendation: 'PROCEED' };
    try {
      anomalyResult = anomalyDetector.checkAnomaly(features);
    } catch (err) {
      console.warn('[ML Prediction] Anomaly detection error:', err.message);
    }

    // Step 4: Get ML prediction
    const modelStatus = mlEngine.getModelStatus();
    if (!modelStatus.isTrained) {
      return {
        take: true,
        mlAvailable: false,
        confidence: 50,
        direction: 'UNKNOWN',
        anomaly: anomalyResult,
        reason: 'ML model not trained yet, deferring to existing logic'
      };
    }

    let prediction;
    try {
      prediction = mlEngine.predict(features);
      predictionCount++;

      // Store prediction in DB for later resolution
      if (db && db.insertMLPrediction) {
        db.insertMLPrediction({
          ticker,
          strategy,
          features_json: JSON.stringify(features),
          prediction: prediction.prediction,
          confidence: prediction.confidence,
          up_prob: prediction.probabilities?.up || 0,
          down_prob: prediction.probabilities?.down || 0,
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.error('[ML Prediction] Prediction error:', err);
      return {
        take: true,
        mlAvailable: false,
        confidence: 50,
        reason: 'Prediction failed, deferring to existing logic'
      };
    }

    // Step 5: Combine anomaly check + prediction into decision
    let confidence = prediction.confidence;
    const direction = prediction.prediction === 1 ? 'UP' : 'DOWN';
    let take = true;
    let reason = '';

    // Adjust confidence based on anomaly severity
    if (anomalyResult.severity === 'EXTREME') {
      confidence = Math.max(0, confidence - 30);
      reason = 'Extreme market anomaly detected, reducing confidence by 30%';
    } else if (anomalyResult.severity === 'UNUSUAL') {
      confidence = Math.max(0, confidence - 15);
      reason = 'Unusual market conditions detected, reducing confidence by 15%';
    }

    // Decision logic
    if (confidence < 60) {
      take = true;
      reason = reason || `ML confidence ${confidence.toFixed(1)}% below threshold, deferring to existing logic`;
    } else if (direction === 'UP') {
      take = true;
      reason = reason || `ML predicts upward move with ${confidence.toFixed(1)}% confidence`;
    } else if (direction === 'DOWN') {
      take = false;
      reason = reason || `ML predicts downward move with ${confidence.toFixed(1)}% confidence`;
    }

    // Log decision
    console.log(`[ML Prediction] ${ticker} ${strategy}: take=${take}, confidence=${confidence.toFixed(1)}%, direction=${direction}, anomaly=${anomalyResult.severity}`);

    return {
      take,
      confidence: Math.round(confidence),
      direction,
      anomaly: anomalyResult,
      prediction: {
        prediction: prediction.prediction,
        confidence: prediction.confidence,
        probabilities: prediction.probabilities
      },
      reason,
      mlAvailable: true
    };

  } catch (err) {
    console.error('[ML Prediction] shouldTradeML error:', err);
    return {
      take: true,
      mlAvailable: false,
      confidence: 50,
      reason: 'ML error occurred, deferring to existing logic'
    };
  }
}

/**
 * Record trade outcome and label the features
 *
 * @param {string} ticker - Trading pair
 * @param {number} entryTime - Timestamp when trade was entered
 * @param {string} outcome - 'WIN' or 'LOSS'
 * @param {number} pnlPercent - Profit/loss percentage
 */
export async function recordTradeOutcome(ticker, entryTime, outcome, pnlPercent) {
  try {
    if (!db || !db.labelMLFeatures) {
      console.warn('[ML Prediction] Database not available for labeling');
      return;
    }

    // Convert outcome to label
    const label = outcome === 'WIN' ? 'UP' : 'DOWN';
    const labelValue = pnlPercent || 0;

    // Find and label the feature vector closest to entry time
    const unlabeledFeatures = db.getUnlabeledFeatures();
    const matchingFeature = unlabeledFeatures
      .filter(f => f.ticker === ticker)
      .reduce((closest, current) => {
        const currentDiff = Math.abs(current.timestamp - entryTime);
        const closestDiff = closest ? Math.abs(closest.timestamp - entryTime) : Infinity;
        return currentDiff < closestDiff ? current : closest;
      }, null);

    if (matchingFeature && Math.abs(matchingFeature.timestamp - entryTime) < 60000) { // within 1 minute
      db.labelMLFeatures(matchingFeature.id, label, labelValue);
      console.log(`[ML Prediction] Labeled feature #${matchingFeature.id}: ${ticker} ${outcome} (${pnlPercent?.toFixed(2)}%)`);

      // Increment samples counter
      samplesSinceLastTrain++;

      // Check if retrain needed
      if (checkRetrainNeeded()) {
        console.log('[ML Prediction] Retrain conditions met, training model...');
        await trainModel();
      }
    } else {
      console.warn(`[ML Prediction] No matching feature found for ${ticker} at ${entryTime}`);
    }

    // Also resolve any pending ML predictions
    try {
      if (db.resolveMLPrediction) {
        const predictions = db.getMLPredictions({ ticker, resolved: false });
        for (const pred of predictions) {
          if (Math.abs(pred.timestamp - entryTime) < 60000) {
            const correct = (pred.prediction === 1 && outcome === 'WIN') ||
                          (pred.prediction === 0 && outcome === 'LOSS');
            db.resolveMLPrediction(pred.id, outcome, pnlPercent, correct ? 1 : 0);
          }
        }
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to resolve predictions:', err.message);
    }

  } catch (err) {
    console.error('[ML Prediction] recordTradeOutcome error:', err);
  }
}

/**
 * Train/retrain the ML model
 */
export async function trainModel() {
  try {
    if (!mlEngine || !db || !db.getLabeledFeatures) {
      console.warn('[ML Prediction] Cannot train - missing dependencies');
      return false;
    }

    console.log('[ML Prediction] Starting model training...');
    const startTime = Date.now();

    // Fetch all labeled features
    const labeledSamples = db.getLabeledFeatures();
    if (labeledSamples.length < MIN_SAMPLES_TO_TRAIN) {
      console.warn(`[ML Prediction] Not enough samples to train: ${labeledSamples.length} < ${MIN_SAMPLES_TO_TRAIN}`);
      return false;
    }

    // Parse features and labels
    const features2D = [];
    const labels = [];

    for (const sample of labeledSamples) {
      try {
        const features = JSON.parse(sample.features_json);
        if (features.length === FEATURE_COUNT) {
          features2D.push(features);
          labels.push(sample.label === 'UP' ? 1 : 0);
        }
      } catch (err) {
        console.warn(`[ML Prediction] Failed to parse sample #${sample.id}:`, err.message);
      }
    }

    if (features2D.length < MIN_SAMPLES_TO_TRAIN) {
      console.warn(`[ML Prediction] Not enough valid samples after parsing: ${features2D.length}`);
      return false;
    }

    // Train model
    const metrics = mlEngine.train(features2D, labels);
    console.log(`[ML Prediction] Training complete in ${Date.now() - startTime}ms`);
    console.log(`[ML Prediction] Metrics: accuracy=${metrics.accuracy?.toFixed(2)}%, precision=${metrics.precision?.toFixed(2)}%, recall=${metrics.recall?.toFixed(2)}%`);

    // Save model to database
    try {
      if (db.insertMLModel) {
        const modelData = mlEngine.serialize();
        db.insertMLModel({
          model_data: JSON.stringify(modelData),
          accuracy: metrics.accuracy,
          precision: metrics.precision,
          recall: metrics.recall,
          f1_score: metrics.f1Score,
          sample_count: features2D.length,
          trained_at: Date.now()
        });
        console.log('[ML Prediction] Model saved to database');
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to save model:', err.message);
    }

    // Update anomaly detector with new data
    try {
      if (anomalyDetector) {
        anomalyDetector.fit(features2D);
        console.log('[ML Prediction] Anomaly detector updated');
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to update anomaly detector:', err.message);
    }

    // Reset counters
    lastTrainTime = Date.now();
    samplesSinceLastTrain = 0;

    return true;

  } catch (err) {
    console.error('[ML Prediction] trainModel error:', err);
    return false;
  }
}

/**
 * Check if model retraining is needed
 *
 * @returns {boolean} True if retrain conditions are met
 */
export function checkRetrainNeeded() {
  try {
    if (!mlEngine || !mlEngine.getModelStatus().isTrained) {
      return false; // Can't retrain if not trained yet
    }

    // Retrain if we have enough new samples
    if (samplesSinceLastTrain >= RETRAIN_SAMPLE_THRESHOLD) {
      return true;
    }

    // Or if enough time has passed AND we have some new samples
    const timeSinceLastTrain = Date.now() - lastTrainTime;
    if (timeSinceLastTrain >= RETRAIN_INTERVAL && samplesSinceLastTrain > 20) {
      return true;
    }

    return false;

  } catch (err) {
    console.error('[ML Prediction] checkRetrainNeeded error:', err);
    return false;
  }
}

/**
 * Get ML system status
 *
 * @returns {Object} Status information
 */
export function getMLStatus() {
  try {
    const modelStatus = mlEngine?.getModelStatus() || {};
    const anomalyStatus = anomalyDetector?.getStatus() || {};

    let sampleCount = 0;
    try {
      if (db && db.getLabeledFeatures) {
        sampleCount = db.getLabeledFeatures().length;
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to get sample count:', err.message);
    }

    return {
      isInitialized,
      isTrained: modelStatus.isTrained || false,
      accuracy: modelStatus.accuracy || 0,
      sampleCount,
      predictionCount,
      lastTrainTime,
      samplesSinceLastTrain,
      anomalyDetectorStatus: anomalyStatus,
      featureCount: FEATURE_COUNT || 0,
      minSamplesToTrain: MIN_SAMPLES_TO_TRAIN
    };

  } catch (err) {
    console.error('[ML Prediction] getMLStatus error:', err);
    return {
      isInitialized: false,
      isTrained: false,
      error: err.message
    };
  }
}

/**
 * Get feature importance report
 *
 * @returns {Array} Array of { name, importance, rank }
 */
export function getFeatureImportanceReport() {
  try {
    if (!mlEngine || !mlEngine.getModelStatus().isTrained) {
      return [];
    }

    const importances = mlEngine.getFeatureImportance();
    if (!importances || !getFeatureNames) {
      return [];
    }

    const names = getFeatureNames();
    const report = importances
      .map((importance, index) => ({
        name: names[index] || `feature_${index}`,
        importance,
        rank: 0
      }))
      .sort((a, b) => b.importance - a.importance)
      .map((item, index) => ({
        ...item,
        rank: index + 1
      }));

    return report;

  } catch (err) {
    console.error('[ML Prediction] getFeatureImportanceReport error:', err);
    return [];
  }
}

/**
 * Get ML accuracy statistics from database
 *
 * @returns {Object} Accuracy stats by ticker and strategy
 */
export function getMLAccuracyStats() {
  try {
    if (!db || !db.getMLAccuracyStats) {
      return {};
    }

    return db.getMLAccuracyStats();

  } catch (err) {
    console.error('[ML Prediction] getMLAccuracyStats error:', err);
    return {};
  }
}

// Auto-initialize on module load
initializeML().catch(err => {
  console.error('[ML Prediction] Auto-initialization failed:', err);
});

console.log('[ML Prediction Service] Loaded');
