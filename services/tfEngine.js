/**
 * TF.js Engine - GPU-accelerated deep learning models
 * Phase 1: LSTM model replacing hand-written implementation
 * Phase 2: Temporal Fusion Transformer (TFT)
 *
 * Same predict interface as MLEngine: predict(features) → { prediction, confidence, probabilities }
 */

import { getFlag } from './systemConfig.js';

let tf;
try {
  // Try native bindings first (VPS), fall back to pure JS
  try {
    tf = await import('@tensorflow/tfjs-node');
  } catch {
    tf = await import('@tensorflow/tfjs');
  }
} catch (err) {
  console.warn('[TF Engine] TensorFlow.js not available:', err.message);
}

const MODEL_DIR = 'data/tf-models';

// Custom layer: softmax on last axis for 3D tensors (tf.layers.softmax fails on rank>2)
class Softmax3DLayer extends (tf?.layers?.Layer || class {}) {
  constructor(config) {
    super(config || {});
  }
  computeOutputShape(inputShape) {
    return inputShape;
  }
  call(inputs) {
    const input = Array.isArray(inputs) ? inputs[0] : inputs;
    return tf.tidy(() => tf.softmax(input, -1));
  }
  static get className() { return 'Softmax3D'; }
}
if (tf) {
  try { tf.serialization.registerClass(Softmax3DLayer); } catch {}
}

// Custom layer: extract last timestep from sequence (tf.layers.lambda not available in TF.js)
class LastTimestepLayer extends (tf?.layers?.Layer || class {}) {
  constructor(config) {
    super(config || {});
  }
  computeOutputShape(inputShape) {
    return [inputShape[0], inputShape[2]];
  }
  call(inputs) {
    const input = Array.isArray(inputs) ? inputs[0] : inputs;
    return tf.tidy(() => {
      const lastIdx = input.shape[1] - 1;
      return input.slice([0, lastIdx, 0], [-1, 1, -1]).squeeze([1]);
    });
  }
  static get className() { return 'LastTimestep'; }
}
if (tf) {
  try { tf.serialization.registerClass(LastTimestepLayer); } catch {}
}

class TFEngine {
  constructor() {
    this.lstmModel = null;
    this.tftModel = null;
    this.isLSTMTrained = false;
    this.isTFTTrained = false;
    this.lstmMetrics = {};
    this.tftMetrics = {};
    this.featureCount = 109;
    this.sequenceLength = 30;
  }

  // ================================================================
  // LSTM Model (Phase 1)
  // ================================================================

  buildLSTMModel(featureCount) {
    if (!tf) return null;
    this.featureCount = featureCount || this.featureCount;

    const hiddenUnits = getFlag('TF_LSTM_HIDDEN_UNITS') || 128;
    const dropoutRate = getFlag('TF_DROPOUT_RATE') || 0.3;
    const learningRate = getFlag('TF_LEARNING_RATE') || 0.001;

    const model = tf.sequential();

    // Input: (sequenceLength, featureCount) → LSTM(128)
    model.add(tf.layers.lstm({
      units: hiddenUnits,
      inputShape: [this.sequenceLength, this.featureCount],
      returnSequences: false,
    }));

    model.add(tf.layers.dropout({ rate: dropoutRate }));

    // Dense(64, relu)
    model.add(tf.layers.dense({ units: 64, activation: 'relu' }));

    // Output: Dense(1, sigmoid)
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

    model.compile({
      optimizer: tf.train.adam(learningRate),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy'],
    });

    this.lstmModel = model;
    return model;
  }

  /**
   * Train LSTM on sequence data
   * @param {number[][][]} sequences - Array of (sequenceLength x featureCount) matrices
   * @param {number[]} labels - 0 or 1
   * @returns {object} Training metrics
   */
  async trainLSTM(sequences, labels) {
    if (!tf || !sequences.length) return null;

    const maxEpochs = getFlag('TF_MAX_EPOCHS') || 50;
    const featureCount = sequences[0][0].length;

    // Build model if needed
    if (!this.lstmModel) {
      this.buildLSTMModel(featureCount);
    }

    // Convert to tensors
    const xTensor = tf.tensor3d(sequences);
    const yTensor = tf.tensor2d(labels.map(l => [l]));

    // Split 80/20 for validation
    const splitIdx = Math.floor(sequences.length * 0.8);
    const xTrain = xTensor.slice([0, 0, 0], [splitIdx, -1, -1]);
    const yTrain = yTensor.slice([0, 0], [splitIdx, -1]);
    const xVal = xTensor.slice([splitIdx, 0, 0], [-1, -1, -1]);
    const yVal = yTensor.slice([splitIdx, 0], [-1, -1]);

    // Train with early stopping
    let bestValLoss = Infinity;
    let patience = 10;
    let patienceCounter = 0;
    let bestEpoch = 0;

    const history = await this.lstmModel.fit(xTrain, yTrain, {
      epochs: maxEpochs,
      batchSize: 32,
      validationData: [xVal, yVal],
      shuffle: false, // Time series — don't shuffle
      verbose: 0,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (logs.val_loss < bestValLoss) {
            bestValLoss = logs.val_loss;
            patienceCounter = 0;
            bestEpoch = epoch;
          } else {
            patienceCounter++;
            if (patienceCounter >= patience) {
              this.lstmModel.stopTraining = true;
            }
          }
        }
      }
    });

    // Evaluate on validation set
    const evalResult = this.lstmModel.evaluate(xVal, yVal);
    const valLoss = (await evalResult[0].data())[0];
    const valAcc = (await evalResult[1].data())[0];

    // Cleanup tensors
    xTensor.dispose();
    yTensor.dispose();
    xTrain.dispose();
    yTrain.dispose();
    xVal.dispose();
    yVal.dispose();
    evalResult[0].dispose();
    evalResult[1].dispose();

    this.isLSTMTrained = true;
    this.lstmMetrics = {
      accuracy: valAcc,
      loss: valLoss,
      bestEpoch,
      epochs: history.epoch.length,
      sampleCount: sequences.length,
    };

    console.log(`[TF Engine] LSTM trained: acc=${(valAcc * 100).toFixed(1)}%, loss=${valLoss.toFixed(4)}, epochs=${history.epoch.length}/${maxEpochs}`);

    return this.lstmMetrics;
  }

  /**
   * Predict with LSTM model
   * @param {number[][]} sequence - (sequenceLength x featureCount) matrix
   * @returns {object} { prediction, confidence, probabilities }
   */
  predictLSTM(sequence) {
    if (!tf || !this.lstmModel || !this.isLSTMTrained) return null;

    const inputTensor = tf.tensor3d([sequence]);
    const output = this.lstmModel.predict(inputTensor);
    const upProb = output.dataSync()[0];

    inputTensor.dispose();
    output.dispose();

    const downProb = 1 - upProb;
    return {
      prediction: upProb >= 0.5 ? 'UP' : 'DOWN',
      confidence: Math.max(upProb, downProb),
      probabilities: { up: upProb, down: downProb },
    };
  }

  // ================================================================
  // Temporal Fusion Transformer (Phase 2)
  // ================================================================

  buildTFTModel(featureCount) {
    if (!tf) return null;
    this.featureCount = featureCount || this.featureCount;

    const hiddenDim = getFlag('TFT_HIDDEN_DIM') || 32;
    const attentionHeads = getFlag('TFT_ATTENTION_HEADS') || 4;

    // TFT uses functional API for multi-output
    const input = tf.input({ shape: [this.sequenceLength, this.featureCount] });

    // Variable Selection Network: learns which features matter per timestep
    // Dense → ReLU → Dense → Softmax weights → element-wise multiply
    let vsn = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim, activation: 'relu' })
    }).apply(input);

    const vsnGate = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim, activation: 'sigmoid' })
    }).apply(input);

    // Gated Linear Unit: vsn * sigmoid(vsnGate) + skip
    vsn = tf.layers.multiply().apply([vsn, vsnGate]);

    // Gated Residual Network
    let grn = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim, activation: 'elu' })
    }).apply(vsn);

    grn = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim })
    }).apply(grn);

    const grnGate = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim, activation: 'sigmoid' })
    }).apply(grn);

    // GLU + skip connection
    grn = tf.layers.multiply().apply([grn, grnGate]);
    grn = tf.layers.add().apply([grn, vsn]);
    grn = tf.layers.layerNormalization().apply(grn);

    // LSTM temporal processing
    let temporal = tf.layers.lstm({
      units: hiddenDim * 2,
      returnSequences: true,
    }).apply(grn);

    // Multi-Head Self-Attention (simplified as single attention layer)
    // TF.js doesn't have built-in multi-head attention, simulate with dense projections
    const query = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim })
    }).apply(temporal);

    const key = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim })
    }).apply(temporal);

    const value = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim })
    }).apply(temporal);

    // Attention: softmax(Q*K^T / sqrt(d)) * V — manual dot product attention
    // Q·K^T → (batch, seq, seq) attention scores
    const scores = tf.layers.dot({ axes: 2 }).apply([query, key]);
    // Softmax on last axis → attention weights (custom layer — tf.layers.softmax fails on 3D)
    const attnWeights = new Softmax3DLayer({ name: 'attn_softmax' }).apply(scores);
    // Weighted sum: attnWeights · V → (batch, seq, hiddenDim)
    const attention = tf.layers.dot({ axes: [2, 1] }).apply([attnWeights, value]);

    // Post-attention GRN
    let postAttn = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim, activation: 'elu' })
    }).apply(attention);

    postAttn = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: hiddenDim })
    }).apply(postAttn);

    // Take last timestep for predictions (custom layer — tf.layers.lambda not in TF.js)
    const lastStep = new LastTimestepLayer({ name: 'last_timestep' }).apply(postAttn);

    // Multi-horizon output heads: 1h, 4h, 24h
    const head1h = tf.layers.dense({
      units: 1, activation: 'sigmoid', name: 'pred_1h'
    }).apply(lastStep);

    const head4h = tf.layers.dense({
      units: 1, activation: 'sigmoid', name: 'pred_4h'
    }).apply(lastStep);

    const head24h = tf.layers.dense({
      units: 1, activation: 'sigmoid', name: 'pred_24h'
    }).apply(lastStep);

    this.tftModel = tf.model({
      inputs: input,
      outputs: [head1h, head4h, head24h],
    });

    this.tftModel.compile({
      optimizer: tf.train.adam(0.0005),
      loss: ['binaryCrossentropy', 'binaryCrossentropy', 'binaryCrossentropy'],
      lossWeights: [0.5, 0.3, 0.2],
      metrics: ['accuracy'],
    });

    return this.tftModel;
  }

  /**
   * Train TFT on sequence data with multi-horizon labels
   * @param {number[][][]} sequences - (N x sequenceLength x featureCount)
   * @param {object} labels - { h1: [], h4: [], h24: [] } arrays of 0/1
   * @returns {object} Training metrics
   */
  async trainTFT(sequences, labels) {
    if (!tf || !sequences.length) return null;

    const featureCount = sequences[0][0].length;
    if (!this.tftModel) {
      this.buildTFTModel(featureCount);
    }

    const xTensor = tf.tensor3d(sequences);
    const y1h = tf.tensor2d(labels.h1.map(l => [l]));
    const y4h = tf.tensor2d(labels.h4.map(l => [l]));
    const y24h = tf.tensor2d(labels.h24.map(l => [l]));

    const splitIdx = Math.floor(sequences.length * 0.8);

    const history = await this.tftModel.fit(
      xTensor.slice([0, 0, 0], [splitIdx, -1, -1]),
      [
        y1h.slice([0, 0], [splitIdx, -1]),
        y4h.slice([0, 0], [splitIdx, -1]),
        y24h.slice([0, 0], [splitIdx, -1]),
      ],
      {
        epochs: getFlag('TF_MAX_EPOCHS') || 50,
        batchSize: 32,
        validationSplit: 0.2,
        shuffle: false,
        verbose: 0,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if (epoch > 0 && logs.val_loss > (this._tftBestLoss || Infinity) * 1.1) {
              this._tftPatienceCounter = (this._tftPatienceCounter || 0) + 1;
              if (this._tftPatienceCounter >= 10) {
                this.tftModel.stopTraining = true;
              }
            } else {
              this._tftBestLoss = logs.val_loss;
              this._tftPatienceCounter = 0;
            }
          }
        }
      }
    );

    // Cleanup
    xTensor.dispose();
    y1h.dispose();
    y4h.dispose();
    y24h.dispose();

    this.isTFTTrained = true;
    this.tftMetrics = {
      epochs: history.epoch.length,
      sampleCount: sequences.length,
      finalLoss: history.history.loss?.[history.epoch.length - 1],
    };

    console.log(`[TF Engine] TFT trained: epochs=${history.epoch.length}, samples=${sequences.length}`);
    return this.tftMetrics;
  }

  /**
   * Predict with TFT — returns multi-horizon predictions
   * @param {number[][]} sequence - (sequenceLength x featureCount) matrix
   * @returns {object} { h1, h4, h24, consensus, confidence }
   */
  predictTFT(sequence) {
    if (!tf || !this.tftModel || !this.isTFTTrained) return null;

    const inputTensor = tf.tensor3d([sequence]);
    const [out1h, out4h, out24h] = this.tftModel.predict(inputTensor);

    const p1h = out1h.dataSync()[0];
    const p4h = out4h.dataSync()[0];
    const p24h = out24h.dataSync()[0];

    inputTensor.dispose();
    out1h.dispose();
    out4h.dispose();
    out24h.dispose();

    // Consensus: all horizons agree on direction
    const allUp = p1h > 0.5 && p4h > 0.5 && p24h > 0.5;
    const allDown = p1h < 0.5 && p4h < 0.5 && p24h < 0.5;
    const avgProb = (p1h + p4h + p24h) / 3;

    let consensusModifier = 0;
    if (allUp || allDown) {
      consensusModifier = 0.10; // All agree → boost confidence
    } else {
      consensusModifier = -0.15; // Divergent → reduce confidence
    }

    return {
      h1: { up: p1h, down: 1 - p1h, direction: p1h >= 0.5 ? 'UP' : 'DOWN' },
      h4: { up: p4h, down: 1 - p4h, direction: p4h >= 0.5 ? 'UP' : 'DOWN' },
      h24: { up: p24h, down: 1 - p24h, direction: p24h >= 0.5 ? 'UP' : 'DOWN' },
      consensus: allUp ? 'ALL_UP' : allDown ? 'ALL_DOWN' : 'DIVERGENT',
      consensusModifier,
      prediction: avgProb >= 0.5 ? 'UP' : 'DOWN',
      confidence: Math.max(avgProb, 1 - avgProb),
      probabilities: { up: avgProb, down: 1 - avgProb },
    };
  }

  // ================================================================
  // Model Persistence
  // ================================================================

  async saveLSTM(path) {
    if (!this.lstmModel || !tf) return;
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(MODEL_DIR)) {
        fs.mkdirSync(MODEL_DIR, { recursive: true });
      }
      await this.lstmModel.save(`file://${MODEL_DIR}/lstm`);
      console.log('[TF Engine] LSTM model saved');
    } catch (err) {
      console.warn('[TF Engine] Failed to save LSTM:', err.message);
    }
  }

  async loadLSTM() {
    if (!tf) return false;
    try {
      this.lstmModel = await tf.loadLayersModel(`file://${MODEL_DIR}/lstm/model.json`);
      this.lstmModel.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy'],
      });
      this.isLSTMTrained = true;
      console.log('[TF Engine] LSTM model loaded from disk');
      return true;
    } catch {
      return false;
    }
  }

  async saveTFT() {
    if (!this.tftModel || !tf) return;
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(MODEL_DIR)) {
        fs.mkdirSync(MODEL_DIR, { recursive: true });
      }
      await this.tftModel.save(`file://${MODEL_DIR}/tft`);
      console.log('[TF Engine] TFT model saved');
    } catch (err) {
      console.warn('[TF Engine] Failed to save TFT:', err.message);
    }
  }

  async loadTFT() {
    if (!tf) return false;
    try {
      this.tftModel = await tf.loadLayersModel(`file://${MODEL_DIR}/tft/model.json`);
      this.tftModel.compile({
        optimizer: tf.train.adam(0.0005),
        loss: ['binaryCrossentropy', 'binaryCrossentropy', 'binaryCrossentropy'],
        lossWeights: [0.5, 0.3, 0.2],
      });
      this.isTFTTrained = true;
      console.log('[TF Engine] TFT model loaded from disk');
      return true;
    } catch {
      return false;
    }
  }

  // ================================================================
  // Status & Cleanup
  // ================================================================

  getStatus() {
    return {
      tfAvailable: !!tf,
      lstm: {
        trained: this.isLSTMTrained,
        ...this.lstmMetrics,
      },
      tft: {
        trained: this.isTFTTrained,
        ...this.tftMetrics,
      },
    };
  }

  dispose() {
    if (this.lstmModel) { this.lstmModel.dispose(); this.lstmModel = null; }
    if (this.tftModel) { this.tftModel.dispose(); this.tftModel = null; }
    this.isLSTMTrained = false;
    this.isTFTTrained = false;
  }
}

// Singleton
const tfEngine = new TFEngine();

export { TFEngine, tfEngine };
export default tfEngine;

console.log(`[TF Engine] Loaded (TF.js ${tf ? 'available' : 'NOT available'})`);
