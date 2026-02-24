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
let RegimeMLEngine;
let LSTMNetwork;
let featureSelector;
let hyperparamTuner;
let getFlag;

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

// Performance Upgrade imports (all optional — fail gracefully)
try {
  const regimeModule = await import('./regimeMLEngine.js');
  RegimeMLEngine = regimeModule.RegimeMLEngine;
} catch (err) {
  console.warn('[ML Prediction] regimeMLEngine not available:', err.message);
}

try {
  const lstmModule = await import('./lstmEngine.js');
  LSTMNetwork = lstmModule.LSTMNetwork;
} catch (err) {
  console.warn('[ML Prediction] lstmEngine not available:', err.message);
}

try {
  featureSelector = await import('./featureSelector.js');
} catch (err) {
  console.warn('[ML Prediction] featureSelector not available:', err.message);
}

try {
  hyperparamTuner = await import('./hyperparamTuner.js');
} catch (err) {
  console.warn('[ML Prediction] hyperparamTuner not available:', err.message);
}

try {
  const sysConfig = await import('./systemConfig.js');
  getFlag = sysConfig.getFlag;
} catch (err) {
  console.warn('[ML Prediction] systemConfig not available:', err.message);
  getFlag = () => true; // Default: all flags enabled
}

// Worker thread for offloading training
let Worker;
try {
  const wt = await import('node:worker_threads');
  Worker = wt.Worker;
} catch (e) {
  console.warn('[ML Prediction] worker_threads not available');
}
let trainingWorker = null;
let workerTraining = false;

// State
let mlEngine = null;
let anomalyDetector = null;
let regimeEngine = null;     // Upgrade #6: Regime-aware model switching
let lstmModel = null;        // Upgrade #8: LSTM sequence model
let isInitialized = false;
let lastTrainTime = 0;
let predictionCount = 0;
const MIN_SAMPLES_TO_TRAIN = 100;
const RETRAIN_INTERVAL = 30 * 60 * 1000; // 30 min (Batch 5B: increased from 1 hour)
const RETRAIN_SAMPLE_THRESHOLD = 200; // retrain every 200 new samples
let samplesSinceLastTrain = 0;

// Upgrade #1: Incremental learning
let incrementalSampleCount = 0;
const INCREMENTAL_THRESHOLD = 20; // Trigger incremental update every 20 labeled samples
const incrementalBuffer = { features: [], labels: [] };

// Upgrade #8: LSTM sequence buffer — last 30 feature vectors per ticker (Batch 5B: 20→30)
const featureSequenceBuffer = new Map(); // ticker -> array of feature vectors
const LSTM_SEQUENCE_LENGTH = 30;

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
    let featureArray;
    try {
      const result = buildFeatureVector(ticker, candles, {
        exchangeSnapshot,
        derivativesData,
        sentimentData,
        defiData,
        marketRegime,
        lastTradeTime
      });

      features = result;
      featureArray = result.features;

      if (!featureArray || featureArray.length !== FEATURE_COUNT) {
        console.warn(`[ML Prediction] Invalid feature vector length: ${featureArray?.length}, expected ${FEATURE_COUNT}`);
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

    // Step 2: Store features in DB for future labeling (include regime)
    try {
      if (db && db.insertMLFeatures) {
        db.insertMLFeatures({
          ticker,
          strategy,
          features_json: JSON.stringify(featureArray),
          timestamp: Date.now(),
          regime: marketRegime || null
        });
      }
    } catch (err) {
      console.warn('[ML Prediction] Failed to store features:', err.message);
    }

    // Buffer feature vectors for LSTM sequence prediction
    try {
      if (!featureSequenceBuffer.has(ticker)) {
        featureSequenceBuffer.set(ticker, []);
      }
      const buffer = featureSequenceBuffer.get(ticker);
      buffer.push(featureArray);
      if (buffer.length > LSTM_SEQUENCE_LENGTH) {
        buffer.shift();
      }
      // Pass sequence to mlEngine for LSTM prediction
      if (mlEngine && buffer.length >= LSTM_SEQUENCE_LENGTH) {
        mlEngine.setLastSequence(buffer.slice(-LSTM_SEQUENCE_LENGTH));
      }
    } catch (err) {
      // Non-critical — LSTM sequence buffer failure
    }

    // Step 3: Check for market anomalies
    let anomalyResult = { isAnomaly: false, severity: 'NORMAL', recommendation: 'PROCEED' };
    try {
      anomalyResult = anomalyDetector.checkAnomaly(featureArray);
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
      prediction = mlEngine.predict(featureArray);
      predictionCount++;

      // Store prediction in DB for later resolution
      if (db && db.insertMLPrediction) {
        db.insertMLPrediction({
          ticker,
          strategy,
          features_json: JSON.stringify(featureArray),
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

    // Step 5: Blend regime prediction (Batch 2C — activate trained but unused regime engine)
    let confidence = prediction.confidence;
    try {
      if (regimeEngine && getFlag('REGIME_MODELS_ENABLED') && marketRegime) {
        const regimePred = regimeEngine.predict(featureArray, marketRegime);
        if (regimePred && typeof regimePred.confidence === 'number') {
          confidence = 0.7 * confidence + 0.3 * regimePred.confidence;
        }
      }
    } catch (regErr) {
      // Non-critical — regime prediction error
    }

    // Combine anomaly check + prediction into decision
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
      mlAvailable: true,
      lastFeatureVector: featureArray, // Batch 2B: expose for SHAP
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

      // Upgrade #1: Buffer for incremental learning
      try {
        const parsedFeatures = JSON.parse(matchingFeature.features_json);
        if (parsedFeatures.length === FEATURE_COUNT) {
          incrementalBuffer.features.push(parsedFeatures);
          incrementalBuffer.labels.push(label === 'UP' ? 1 : 0);
          incrementalSampleCount++;

          // Trigger incremental update every INCREMENTAL_THRESHOLD samples
          if (incrementalSampleCount >= INCREMENTAL_THRESHOLD && mlEngine && mlEngine.isTrained) {
            console.log(`[ML Prediction] Incremental update: ${incrementalBuffer.features.length} new samples`);
            mlEngine.incrementalUpdate(incrementalBuffer.features, incrementalBuffer.labels);
            incrementalBuffer.features.length = 0;
            incrementalBuffer.labels.length = 0;
            incrementalSampleCount = 0;
          }
        }
      } catch (incErr) {
        // Non-critical — incremental learning error
      }

      // Check if full retrain needed
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
 * Train via worker thread (Batch 4A: offload from main event loop)
 */
async function trainOnWorker(features2D, labels, config, labeledSamples) {
  if (!Worker || workerTraining) return false;
  return new Promise((resolve) => {
    try {
      workerTraining = true;
      const workerPath = new URL('./mlTrainingWorker.js', import.meta.url).pathname
        .replace(/^\/([A-Z]:)/, '$1'); // Fix Windows paths
      const worker = new Worker(workerPath);
      const timeout = setTimeout(() => {
        worker.terminate();
        workerTraining = false;
        console.warn('[ML Prediction] Worker training timed out after 120s');
        resolve(false);
      }, 120000);

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          worker.postMessage({
            type: 'train',
            features2D,
            labels,
            config,
            lstmConfig: {
              enabled: getFlag('LSTM_ENABLED'),
              sequenceLength: LSTM_SEQUENCE_LENGTH,
              epochs: 30,
            },
          });
        } else if (msg.type === 'trained') {
          clearTimeout(timeout);
          try {
            mlEngine.deserialize(msg.modelData);
            if (msg.lstmWeights && lstmModel) {
              try { lstmModel.deserialize(msg.lstmWeights); } catch {}
            }
            lastTrainTime = Date.now();
            samplesSinceLastTrain = 0;
            // Save to DB
            if (db?.insertMLModel) {
              db.insertMLModel({
                model_data: JSON.stringify(msg.modelData),
                accuracy: msg.metrics?.accuracy,
                precision: msg.metrics?.precision,
                recall: msg.metrics?.recall,
                f1_score: msg.metrics?.f1Score,
                sample_count: msg.sampleCount,
                trained_at: Date.now(),
              });
            }
            console.log(`[ML Prediction] Worker training complete: acc=${msg.metrics?.accuracy?.toFixed(2)}%`);
          } catch (e) {
            console.warn('[ML Prediction] Failed to deserialize worker model:', e.message);
          }
          workerTraining = false;
          worker.terminate();
          resolve(true);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          console.warn('[ML Prediction] Worker training error:', msg.error);
          workerTraining = false;
          worker.terminate();
          resolve(false);
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        console.warn('[ML Prediction] Worker thread error:', err.message);
        workerTraining = false;
        resolve(false);
      });
    } catch (e) {
      workerTraining = false;
      console.warn('[ML Prediction] Failed to spawn training worker:', e.message);
      resolve(false);
    }
  });
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

    // Batch 4A: Try worker thread training first (keeps main loop responsive)
    if (Worker && !workerTraining && features2D.length >= 200) {
      // Get hyperparams config first
      let workerConfig = {};
      try {
        if (hyperparamTuner) {
          const saved = hyperparamTuner.getBestHyperparams();
          if (saved) workerConfig = saved;
        }
      } catch {}
      workerConfig.nFolds = 7; // Batch 5B: increased from 5
      const workerResult = await trainOnWorker(features2D, labels, workerConfig, labeledSamples);
      if (workerResult) {
        console.log(`[ML Prediction] Worker training succeeded in ${Date.now() - startTime}ms`);
        return true;
      }
      console.log('[ML Prediction] Worker training failed, falling back to main thread');
    }

    // Upgrade #13: Hyperparameter tuning (if enough samples and flag enabled)
    let trainConfig = {};
    try {
      if (hyperparamTuner && getFlag('HYPERPARAM_TUNING_ENABLED') && features2D.length >= 300) {
        console.log('[ML Prediction] Running hyperparameter tuning...');
        const tuneResult = hyperparamTuner.runRandomSearch(features2D, labels, 40, 3); // Batch 5B: 20→40 configs
        if (tuneResult && tuneResult.bestConfig) {
          trainConfig = tuneResult.bestConfig;
          hyperparamTuner.saveBestHyperparams(tuneResult.bestConfig);
          console.log(`[ML Prediction] Best hyperparams: nTrees=${trainConfig.nTrees}, nEstimators=${trainConfig.nEstimators}, maxDepth=${trainConfig.maxDepth}`);
        }
      } else if (hyperparamTuner) {
        // Try loading saved hyperparams
        const saved = hyperparamTuner.getBestHyperparams();
        if (saved) trainConfig = saved;
      }
    } catch (tuneErr) {
      console.warn('[ML Prediction] Hyperparameter tuning error:', tuneErr.message);
    }

    // Apply tuned config if available
    if (trainConfig.nTrees) {
      mlEngine.config.nTrees = trainConfig.nTrees;
      mlEngine.config.nEstimators = trainConfig.nEstimators || mlEngine.config.nEstimators;
      mlEngine.config.maxDepth = trainConfig.maxDepth || mlEngine.config.maxDepth;
      mlEngine.config.learningRate = trainConfig.learningRate || mlEngine.config.learningRate;
    }

    // Train model with walk-forward cross-validation (Batch 5B: 5→7 folds)
    const metrics = mlEngine.train(features2D, labels, { crossValidate: true, nFolds: 7, purgeGap: 5 });
    console.log(`[ML Prediction] Training complete in ${Date.now() - startTime}ms`);
    if (metrics.cvFolds) {
      console.log(`[ML Prediction] CV: ${metrics.cvFolds} folds, avgValAcc=${metrics.validationAccuracy.toFixed(3)}, weights: RF=${metrics.modelWeights.rf.toFixed(3)}, GB=${metrics.modelWeights.gb.toFixed(3)}, LR=${metrics.modelWeights.lr.toFixed(3)}`);
    }
    console.log(`[ML Prediction] Metrics: accuracy=${metrics.accuracy?.toFixed(2)}%, precision=${metrics.precision?.toFixed(2)}%, recall=${metrics.recall?.toFixed(2)}%`);

    // Upgrade #4: Feature Selection (permutation importance)
    try {
      if (featureSelector && getFlag('FEATURE_SELECTION_ENABLED') && features2D.length >= 200) {
        const valStart = Math.floor(features2D.length * 0.8);
        const valFeatures = features2D.slice(valStart);
        const valLabels = labels.slice(valStart);
        // Scale validation features for importance computation
        const scaledVal = mlEngine.scaler.transform(
          valFeatures.map(row => row.map(v => isNaN(v) || !isFinite(v) ? 0 : v))
        );
        const importances = featureSelector.runPermutationImportance(mlEngine, scaledVal, valLabels, 3);
        if (importances) {
          const selected = featureSelector.selectTopFeatures(importances, 0.005);
          featureSelector.setSelectedFeatures(selected);
          mlEngine.setSelectedFeatureIndices(selected);
          console.log(`[ML Prediction] Feature selection: ${selected.length}/${features2D[0].length} features kept`);
        }
      }
    } catch (fsErr) {
      console.warn('[ML Prediction] Feature selection error:', fsErr.message);
    }

    // Upgrade #8: Train LSTM model on sequences
    try {
      if (LSTMNetwork && getFlag('LSTM_ENABLED') && features2D.length >= 200) {
        console.log('[ML Prediction] Training LSTM model...');
        const sequences = [];
        const seqLabels = [];
        for (let i = LSTM_SEQUENCE_LENGTH; i < features2D.length; i++) {
          sequences.push(features2D.slice(i - LSTM_SEQUENCE_LENGTH, i));
          seqLabels.push(labels[i]);
        }
        if (sequences.length >= 100) {
          lstmModel = new LSTMNetwork(features2D[0].length, 64, 1);
          lstmModel.fit(sequences, seqLabels, 50, 0.001); // Batch 5B: 30→50 epochs
          mlEngine.setLSTMModel(lstmModel);
          // Give LSTM 10% weight, redistribute from others
          const w = mlEngine.modelWeights;
          const lstmWeight = 0.10;
          const scale = 1 - lstmWeight;
          mlEngine.modelWeights = {
            rf: w.rf * scale,
            gb: w.gb * scale,
            lr: w.lr * scale,
            lstm: lstmWeight
          };
          console.log(`[ML Prediction] LSTM trained, ensemble weights updated (LSTM=${lstmWeight})`);
        }
      }
    } catch (lstmErr) {
      console.warn('[ML Prediction] LSTM training error:', lstmErr.message);
    }

    // Upgrade #6: Train regime-specific models
    try {
      if (RegimeMLEngine && getFlag('REGIME_MODELS_ENABLED') && features2D.length >= 200) {
        // Fetch regime labels from DB
        const regimeLabels = labeledSamples.map(s => s.regime || 'SIDEWAYS');
        regimeEngine = new RegimeMLEngine(mlEngine.config);
        regimeEngine.train(features2D, labels, regimeLabels);
        console.log('[ML Prediction] Regime models trained');
      }
    } catch (regimeErr) {
      console.warn('[ML Prediction] Regime model training error:', regimeErr.message);
    }

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
/**
 * Get the underlying ML engine instance (for ML gatekeeper integration)
 */
export function getMLEngine() {
  return mlEngine;
}

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

/**
 * Safe ML advice wrapper for A/B tracking.
 * Never throws — always returns a result.
 *
 * @param {string} ticker - Trading pair
 * @param {Array} candles - OHLCV candles
 * @param {Object} options - Additional context
 * @returns {Promise<{ available: boolean, direction: 'UP'|'DOWN'|null, confidence: number }>}
 */
export async function getMLAdvice(ticker, candles, options = {}) {
  try {
    if (!isInitialized || !mlEngine || !buildFeatureVector) {
      return { available: false, direction: null, confidence: 0 };
    }

    const modelStatus = mlEngine.getModelStatus();
    if (!modelStatus.isTrained) {
      return { available: false, direction: null, confidence: 0 };
    }

    const result = await shouldTradeML(ticker, candles, 'ADAPTIVE', options);
    if (!result.mlAvailable) {
      return { available: false, direction: null, confidence: 0 };
    }

    return {
      available: true,
      direction: result.direction || null,
      confidence: result.confidence || 0,
    };
  } catch (err) {
    return { available: false, direction: null, confidence: 0 };
  }
}

// Auto-initialize on module load
initializeML().catch(err => {
  console.error('[ML Prediction] Auto-initialization failed:', err);
});

console.log('[ML Prediction Service] Loaded');
