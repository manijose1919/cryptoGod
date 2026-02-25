/**
 * Pure JavaScript LSTM Engine for Sequence-Based Trade Prediction
 * Implements LSTM cells with forget/input/output gates, BPTT training,
 * Xavier/Glorot weight initialization, and gradient clipping.
 * No external dependencies — all math is pure JS.
 *
 * Input:  sliding window of feature vectors (seqLen x inputSize matrix)
 * Output: probability [0,1] (UP vs DOWN)
 */

// ============================================================================
// MATH UTILITIES
// ============================================================================

/**
 * Numerically stable sigmoid: clamp input to [-15, 15] to avoid exp overflow
 */
function sigmoid(x) {
  const clamped = Math.max(-15, Math.min(15, x));
  return 1 / (1 + Math.exp(-clamped));
}

/**
 * Sigmoid derivative given the sigmoid output: s * (1 - s)
 */
function dsigmoid(s) {
  return s * (1 - s);
}

/**
 * Tanh (built-in Math.tanh is fine, but we clamp for safety)
 */
function tanh(x) {
  const clamped = Math.max(-15, Math.min(15, x));
  return Math.tanh(clamped);
}

/**
 * Tanh derivative given the tanh output: 1 - t^2
 */
function dtanh(t) {
  return 1 - t * t;
}

/**
 * Xavier/Glorot uniform initialization: U(-limit, limit)
 * where limit = sqrt(6 / (fanIn + fanOut))
 */
function xavierInit(fanIn, fanOut) {
  const limit = Math.sqrt(6.0 / (fanIn + fanOut));
  return (Math.random() * 2 - 1) * limit;
}

/**
 * Create a 2D matrix initialized with Xavier/Glorot weights
 */
function createMatrix(rows, cols, fanIn, fanOut) {
  const m = new Array(rows);
  for (let i = 0; i < rows; i++) {
    m[i] = new Float64Array(cols);
    for (let j = 0; j < cols; j++) {
      m[i][j] = xavierInit(fanIn, fanOut);
    }
  }
  return m;
}

/**
 * Create a zero-filled 2D matrix
 */
function zeroMatrix(rows, cols) {
  const m = new Array(rows);
  for (let i = 0; i < rows; i++) {
    m[i] = new Float64Array(cols);
  }
  return m;
}

/**
 * Create a zero-filled 1D vector
 */
function zeroVec(n) {
  return new Float64Array(n);
}

/**
 * Clone a 1D Float64Array
 */
function cloneVec(v) {
  return new Float64Array(v);
}

/**
 * Binary cross-entropy loss for a single sample
 */
function binaryCrossEntropy(predicted, label) {
  const eps = 1e-12;
  const p = Math.max(eps, Math.min(1 - eps, predicted));
  return -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
}

// ============================================================================
// LSTM CELL
// ============================================================================

/**
 * Single LSTM cell with forget, input, output gates.
 *
 * Gate equations (at each time step t):
 *   concat = [x_t, h_{t-1}]                        (inputSize + hiddenSize)
 *   f_t = sigmoid(W_f * concat + b_f)               forget gate
 *   i_t = sigmoid(W_i * concat + b_i)               input gate
 *   g_t = tanh(W_g * concat + b_g)                  candidate cell
 *   o_t = sigmoid(W_o * concat + b_o)               output gate
 *   c_t = f_t * c_{t-1} + i_t * g_t                 cell state
 *   h_t = o_t * tanh(c_t)                           hidden state
 */
class LSTMCell {
  constructor(inputSize, hiddenSize) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    const concatSize = inputSize + hiddenSize;

    // Gate weight matrices: each is (hiddenSize x concatSize)
    // Xavier init uses fanIn = concatSize, fanOut = hiddenSize
    this.Wf = createMatrix(hiddenSize, concatSize, concatSize, hiddenSize);
    this.Wi = createMatrix(hiddenSize, concatSize, concatSize, hiddenSize);
    this.Wg = createMatrix(hiddenSize, concatSize, concatSize, hiddenSize);
    this.Wo = createMatrix(hiddenSize, concatSize, concatSize, hiddenSize);

    // Biases
    this.bf = new Float64Array(hiddenSize);
    this.bi = new Float64Array(hiddenSize);
    this.bg = new Float64Array(hiddenSize);
    this.bo = new Float64Array(hiddenSize);

    // Initialize forget gate bias to 1.0 (helps learning long-term dependencies)
    for (let i = 0; i < hiddenSize; i++) {
      this.bf[i] = 1.0;
    }
  }

  /**
   * Forward pass for one time step.
   * Returns { h, c, cache } where cache stores intermediates for BPTT.
   */
  forward(x, hPrev, cPrev) {
    const H = this.hiddenSize;
    const concatSize = this.inputSize + H;

    // Concatenate input and previous hidden state
    const concat = new Float64Array(concatSize);
    concat.set(x, 0);
    concat.set(hPrev, this.inputSize);

    // Compute gates
    const fGate = new Float64Array(H);
    const iGate = new Float64Array(H);
    const gGate = new Float64Array(H);
    const oGate = new Float64Array(H);

    for (let i = 0; i < H; i++) {
      let fSum = this.bf[i];
      let iSum = this.bi[i];
      let gSum = this.bg[i];
      let oSum = this.bo[i];
      for (let j = 0; j < concatSize; j++) {
        fSum += this.Wf[i][j] * concat[j];
        iSum += this.Wi[i][j] * concat[j];
        gSum += this.Wg[i][j] * concat[j];
        oSum += this.Wo[i][j] * concat[j];
      }
      fGate[i] = sigmoid(fSum);
      iGate[i] = sigmoid(iSum);
      gGate[i] = tanh(gSum);
      oGate[i] = sigmoid(oSum);
    }

    // Cell state and hidden state
    const c = new Float64Array(H);
    const tanhC = new Float64Array(H);
    const h = new Float64Array(H);

    for (let i = 0; i < H; i++) {
      c[i] = fGate[i] * cPrev[i] + iGate[i] * gGate[i];
      tanhC[i] = tanh(c[i]);
      h[i] = oGate[i] * tanhC[i];
    }

    return {
      h, c,
      cache: { concat, fGate, iGate, gGate, oGate, cPrev: cloneVec(cPrev), tanhC }
    };
  }

  /**
   * Backward pass for one time step.
   * Given dh (gradient of loss w.r.t. h_t) and dc_next (gradient from future cell state),
   * compute gradients for all weights/biases and return { dxPrev, dhPrev, dcPrev }.
   */
  backward(dh, dcNext, cache, grads) {
    const H = this.hiddenSize;
    const concatSize = this.inputSize + H;
    const { concat, fGate, iGate, gGate, oGate, cPrev, tanhC } = cache;

    // Gradient through h_t = o_t * tanh(c_t)
    const doGate = new Float64Array(H);
    const dc = new Float64Array(H);

    for (let i = 0; i < H; i++) {
      doGate[i] = dh[i] * tanhC[i] * dsigmoid(oGate[i]);
      dc[i] = dh[i] * oGate[i] * dtanh(tanhC[i]) + dcNext[i];
    }

    // Gradient through cell state: c_t = f_t * c_{t-1} + i_t * g_t
    const dfGate = new Float64Array(H);
    const diGate = new Float64Array(H);
    const dgGate = new Float64Array(H);
    const dcPrev = new Float64Array(H);

    for (let i = 0; i < H; i++) {
      dfGate[i] = dc[i] * cPrev[i] * dsigmoid(fGate[i]);
      diGate[i] = dc[i] * gGate[i] * dsigmoid(iGate[i]);
      dgGate[i] = dc[i] * iGate[i] * dtanh(gGate[i]);
      dcPrev[i] = dc[i] * fGate[i];
    }

    // Accumulate weight and bias gradients
    for (let i = 0; i < H; i++) {
      grads.dbf[i] += dfGate[i];
      grads.dbi[i] += diGate[i];
      grads.dbg[i] += dgGate[i];
      grads.dbo[i] += doGate[i];
      for (let j = 0; j < concatSize; j++) {
        grads.dWf[i][j] += dfGate[i] * concat[j];
        grads.dWi[i][j] += diGate[i] * concat[j];
        grads.dWg[i][j] += dgGate[i] * concat[j];
        grads.dWo[i][j] += doGate[i] * concat[j];
      }
    }

    // Gradient w.r.t. concat = [x, h_{t-1}]
    const dConcat = new Float64Array(concatSize);
    for (let j = 0; j < concatSize; j++) {
      for (let i = 0; i < H; i++) {
        dConcat[j] += this.Wf[i][j] * dfGate[i]
                    + this.Wi[i][j] * diGate[i]
                    + this.Wg[i][j] * dgGate[i]
                    + this.Wo[i][j] * doGate[i];
      }
    }

    // Split dConcat into dx and dhPrev
    const dx = new Float64Array(this.inputSize);
    const dhPrev = new Float64Array(H);
    for (let i = 0; i < this.inputSize; i++) {
      dx[i] = dConcat[i];
    }
    for (let i = 0; i < H; i++) {
      dhPrev[i] = dConcat[this.inputSize + i];
    }

    return { dx, dhPrev, dcPrev };
  }

  /**
   * Create a zeroed gradient accumulator matching this cell's parameters
   */
  createGradAccumulator() {
    const concatSize = this.inputSize + this.hiddenSize;
    return {
      dWf: zeroMatrix(this.hiddenSize, concatSize),
      dWi: zeroMatrix(this.hiddenSize, concatSize),
      dWg: zeroMatrix(this.hiddenSize, concatSize),
      dWo: zeroMatrix(this.hiddenSize, concatSize),
      dbf: zeroVec(this.hiddenSize),
      dbi: zeroVec(this.hiddenSize),
      dbg: zeroVec(this.hiddenSize),
      dbo: zeroVec(this.hiddenSize),
    };
  }

  /**
   * Apply gradients with learning rate and gradient clipping (already applied externally).
   */
  applyGradients(grads, lr) {
    const H = this.hiddenSize;
    const concatSize = this.inputSize + H;

    for (let i = 0; i < H; i++) {
      this.bf[i] -= lr * grads.dbf[i];
      this.bi[i] -= lr * grads.dbi[i];
      this.bg[i] -= lr * grads.dbg[i];
      this.bo[i] -= lr * grads.dbo[i];
      for (let j = 0; j < concatSize; j++) {
        this.Wf[i][j] -= lr * grads.dWf[i][j];
        this.Wi[i][j] -= lr * grads.dWi[i][j];
        this.Wg[i][j] -= lr * grads.dWg[i][j];
        this.Wo[i][j] -= lr * grads.dWo[i][j];
      }
    }
  }
}

// ============================================================================
// LSTM NETWORK
// ============================================================================

/**
 * Single-layer LSTM network with a dense output layer for binary classification.
 *
 * Architecture:
 *   Input sequence (seqLen x inputSize) → LSTM (hiddenSize units) → Dense → sigmoid → p(UP)
 *
 * Training uses BPTT with gradient clipping (max L2 norm = 5.0).
 */
class LSTMNetwork {
  /**
   * @param {object} config
   * @param {number} config.inputSize   - Feature vector dimension (auto-detected from data if omitted)
   * @param {number} config.hiddenSize  - Number of LSTM hidden units (default 64)
   * @param {number} config.seqLen      - Sequence length / sliding window (default 20)
   */
  constructor(config = {}) {
    this.hiddenSize = config.hiddenSize || 64;
    this.seqLen = config.seqLen || 20;
    this.inputSize = config.inputSize || null; // auto-detected on first fit()
    this.cell = null;

    // Dense output layer: hiddenSize → 1
    this.Wd = null; // Float64Array(hiddenSize)
    this.bd = 0;

    this.isTrained = false;
    this.trainedAt = null;
    this.trainLosses = [];
  }

  /**
   * Lazily initialize weights once we know the input feature dimension.
   */
  _initWeights(inputSize) {
    this.inputSize = inputSize;
    this.cell = new LSTMCell(inputSize, this.hiddenSize);

    // Dense layer: Xavier init with fanIn=hiddenSize, fanOut=1
    this.Wd = new Float64Array(this.hiddenSize);
    for (let i = 0; i < this.hiddenSize; i++) {
      this.Wd[i] = xavierInit(this.hiddenSize, 1);
    }
    this.bd = 0;
  }

  /**
   * Forward pass through the full sequence.
   * @param {number[][]} sequence - seqLen x inputSize matrix
   * @returns {{ output: number, caches: object[], hFinal: Float64Array }}
   */
  _forward(sequence) {
    const H = this.hiddenSize;
    const T = sequence.length;

    let h = zeroVec(H);
    let c = zeroVec(H);
    const caches = [];

    // Unroll LSTM through time
    for (let t = 0; t < T; t++) {
      const x = sequence[t] instanceof Float64Array
        ? sequence[t]
        : new Float64Array(sequence[t]);
      const result = this.cell.forward(x, h, c);
      caches.push(result.cache);
      h = result.h;
      c = result.c;
    }

    // Dense output: sigmoid(Wd . h + bd)
    let z = this.bd;
    for (let i = 0; i < H; i++) {
      z += this.Wd[i] * h[i];
    }
    const output = sigmoid(z);

    return { output, caches, hFinal: h, cFinal: c, z };
  }

  /**
   * Backward pass through the full sequence (BPTT).
   * @param {number[][]} sequence - Input sequence
   * @param {number} label - 0 or 1
   * @param {{ output, caches, hFinal, z }} fwdResult - Forward pass results
   * @returns {object} Gradient accumulator for LSTM cell + dense layer gradients
   */
  _backward(sequence, label, fwdResult) {
    const H = this.hiddenSize;
    const T = sequence.length;
    const { output, caches, hFinal } = fwdResult;

    // Gradient of BCE w.r.t. the pre-sigmoid logit z
    // d(BCE)/dz = output - label (standard result)
    const dz = output - label;

    // Dense layer gradients
    const dWd = new Float64Array(H);
    const dh = new Float64Array(H);
    for (let i = 0; i < H; i++) {
      dWd[i] = dz * hFinal[i];
      dh[i] = dz * this.Wd[i];
    }
    const dbd = dz;

    // BPTT through the LSTM
    const grads = this.cell.createGradAccumulator();
    let dhPrev = cloneVec(dh);
    let dcPrev = zeroVec(H);

    for (let t = T - 1; t >= 0; t--) {
      const result = this.cell.backward(dhPrev, dcPrev, caches[t], grads);
      dhPrev = result.dhPrev;
      dcPrev = result.dcPrev;
    }

    return { cellGrads: grads, dWd, dbd };
  }

  /**
   * Compute the global L2 norm of all gradients (for clipping).
   */
  _gradNorm(cellGrads, dWd, dbd) {
    let sumSq = 0;
    const H = this.hiddenSize;
    const concatSize = this.inputSize + H;

    // LSTM cell gradients
    for (let i = 0; i < H; i++) {
      sumSq += cellGrads.dbf[i] ** 2;
      sumSq += cellGrads.dbi[i] ** 2;
      sumSq += cellGrads.dbg[i] ** 2;
      sumSq += cellGrads.dbo[i] ** 2;
      for (let j = 0; j < concatSize; j++) {
        sumSq += cellGrads.dWf[i][j] ** 2;
        sumSq += cellGrads.dWi[i][j] ** 2;
        sumSq += cellGrads.dWg[i][j] ** 2;
        sumSq += cellGrads.dWo[i][j] ** 2;
      }
    }

    // Dense layer gradients
    for (let i = 0; i < H; i++) {
      sumSq += dWd[i] ** 2;
    }
    sumSq += dbd ** 2;

    return Math.sqrt(sumSq);
  }

  /**
   * Scale all gradients by a scalar factor (for clipping).
   */
  _scaleGrads(cellGrads, dWd, dbd, scale) {
    const H = this.hiddenSize;
    const concatSize = this.inputSize + H;

    for (let i = 0; i < H; i++) {
      cellGrads.dbf[i] *= scale;
      cellGrads.dbi[i] *= scale;
      cellGrads.dbg[i] *= scale;
      cellGrads.dbo[i] *= scale;
      for (let j = 0; j < concatSize; j++) {
        cellGrads.dWf[i][j] *= scale;
        cellGrads.dWi[i][j] *= scale;
        cellGrads.dWg[i][j] *= scale;
        cellGrads.dWo[i][j] *= scale;
      }
    }

    for (let i = 0; i < H; i++) {
      dWd[i] *= scale;
    }
    // dbd is a number, return the scaled version
    return dbd * scale;
  }

  /**
   * Train the network on a set of sequences using mini-batch SGD with BPTT.
   *
   * @param {number[][][]} sequences - Array of sequences, each seqLen x inputSize
   * @param {number[]} labels - Binary labels (0 or 1), one per sequence
   * @param {number} epochs - Number of training epochs (default 50)
   * @param {number} lr - Learning rate (default 0.001)
   * @returns {{ losses: number[], finalLoss: number }}
   */
  fit(sequences, labels, epochs = 50, lr = 0.001) {
    if (sequences.length === 0) {
      throw new Error('No training sequences provided');
    }
    if (sequences.length !== labels.length) {
      throw new Error('Sequences and labels must have same length');
    }

    // Auto-detect input size from the first sequence's first vector
    const detectedInputSize = sequences[0][0].length;
    if (!this.cell || this.inputSize !== detectedInputSize) {
      this._initWeights(detectedInputSize);
    }

    const totalN = sequences.length;
    const H = this.hiddenSize;
    const maxNorm = 2.0; // Fix #20 (Tier 3): Tightened from 3.0 to 2.0 for better stability

    // Fix #20 (Tier 3): Momentum buffers for Adam-style updates on dense layer
    const momentumBeta = 0.9;
    const velocityWd = new Float64Array(H);
    let velocityBd = 0;

    // --- Train/Validation/Test Split (60/20/20, chronological) ---
    // Chronological split prevents look-ahead bias in time-series data
    const nTest = Math.max(1, Math.floor(totalN * 0.2));
    const nVal = Math.max(1, Math.floor(totalN * 0.2));
    const nTrain = totalN - nVal - nTest;

    const trainSeqs = sequences.slice(0, nTrain);
    const trainLabels = labels.slice(0, nTrain);
    const valSeqs = sequences.slice(nTrain, nTrain + nVal);
    const valLabels = labels.slice(nTrain, nTrain + nVal);
    const testSeqs = sequences.slice(nTrain + nVal);
    const testLabels = labels.slice(nTrain + nVal);

    const N = nTrain;
    this.trainLosses = [];
    this.valLosses = [];

    console.log(`[LSTMNetwork] Training: ${N} train, ${nVal} val, ${nTest} test, ${epochs} epochs, lr=${lr}, hidden=${H}, input=${this.inputSize}`);

    // Early stopping: track best validation loss
    let bestValLoss = Infinity;
    let patienceCounter = 0;
    const patience = 10; // Stop if no improvement for 10 epochs

    // Learning rate decay schedule
    const lrSchedule = (epoch) => {
      if (epoch < 10) return lr;
      if (epoch < 30) return lr * 0.5;
      return lr * 0.1;
    };

    for (let epoch = 0; epoch < epochs; epoch++) {
      const currentLr = lrSchedule(epoch);
      let epochLoss = 0;

      // Shuffle training order each epoch
      const indices = Array.from({ length: N }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      for (const idx of indices) {
        const seq = trainSeqs[idx];
        const label = trainLabels[idx];

        // Forward
        const fwdResult = this._forward(seq);
        epochLoss += binaryCrossEntropy(fwdResult.output, label);

        // Backward
        const { cellGrads, dWd, dbd: rawDbd } = this._backward(seq, label, fwdResult);

        // Gradient clipping (max L2 norm)
        const norm = this._gradNorm(cellGrads, dWd, rawDbd);
        let dbd = rawDbd;
        if (norm > maxNorm) {
          const scale = maxNorm / norm;
          dbd = this._scaleGrads(cellGrads, dWd, rawDbd, scale);
        }

        // Apply gradients with scheduled learning rate
        this.cell.applyGradients(cellGrads, currentLr);
        // Fix #20 (Tier 3): Momentum-based updates for dense layer (reduces oscillation)
        for (let i = 0; i < H; i++) {
          velocityWd[i] = momentumBeta * velocityWd[i] + (1 - momentumBeta) * dWd[i];
          this.Wd[i] -= currentLr * velocityWd[i];
        }
        velocityBd = momentumBeta * velocityBd + (1 - momentumBeta) * dbd;
        this.bd -= currentLr * velocityBd;
      }

      const avgTrainLoss = epochLoss / N;
      this.trainLosses.push(avgTrainLoss);

      // Compute validation loss (no gradient updates)
      let valLoss = 0;
      for (let i = 0; i < nVal; i++) {
        const fwd = this._forward(valSeqs[i]);
        valLoss += binaryCrossEntropy(fwd.output, valLabels[i]);
      }
      const avgValLoss = nVal > 0 ? valLoss / nVal : avgTrainLoss;
      this.valLosses.push(avgValLoss);

      // Early stopping check
      if (avgValLoss < bestValLoss) {
        bestValLoss = avgValLoss;
        patienceCounter = 0;
      } else {
        patienceCounter++;
        if (patienceCounter >= patience) {
          console.log(`[LSTMNetwork] Early stopping at epoch ${epoch + 1}: val_loss hasn't improved for ${patience} epochs`);
          break;
        }
      }

      // Log every 10 epochs
      if ((epoch + 1) % 10 === 0 || epoch === 0) {
        console.log(`[LSTMNetwork] Epoch ${epoch + 1}/${epochs} — train_loss: ${avgTrainLoss.toFixed(6)}, val_loss: ${avgValLoss.toFixed(6)}, lr: ${currentLr}`);
      }
    }

    // Evaluate on held-out test set (never seen during training)
    let testCorrect = 0;
    let testLoss = 0;
    for (let i = 0; i < nTest; i++) {
      const fwd = this._forward(testSeqs[i]);
      testLoss += binaryCrossEntropy(fwd.output, testLabels[i]);
      const predicted = fwd.output >= 0.5 ? 1 : 0;
      if (predicted === testLabels[i]) testCorrect++;
    }
    const testAccuracy = nTest > 0 ? (testCorrect / nTest * 100).toFixed(1) : 'N/A';
    const avgTestLoss = nTest > 0 ? testLoss / nTest : 0;

    this.isTrained = true;
    this.trainedAt = new Date().toISOString();
    this.testAccuracy = parseFloat(testAccuracy) || 0;

    const finalLoss = this.trainLosses[this.trainLosses.length - 1];
    console.log(`[LSTMNetwork] Training complete. Final train_loss: ${finalLoss.toFixed(6)}, test_loss: ${avgTestLoss.toFixed(6)}, test_accuracy: ${testAccuracy}%`);

    if (this.valLosses.length > 0 && this.valLosses[this.valLosses.length - 1] > finalLoss * 1.5) {
      console.warn(`[LSTMNetwork] WARNING: Possible overfitting — val_loss >> train_loss`);
    }

    return { losses: this.trainLosses, valLosses: this.valLosses, finalLoss, testAccuracy: this.testAccuracy };
  }

  /**
   * Predict probability of UP (class 1) for a single sequence.
   *
   * @param {number[][]} sequence - seqLen x inputSize matrix
   * @returns {number} Probability in [0, 1]
   */
  predict(sequence) {
    if (!this.isTrained) {
      throw new Error('LSTMNetwork not trained yet');
    }

    // Validate and pad/truncate sequence to expected length
    let seq = sequence;
    if (seq.length > this.seqLen) {
      seq = seq.slice(seq.length - this.seqLen);
    } else if (seq.length < this.seqLen) {
      // Left-pad with zeros
      const padLen = this.seqLen - seq.length;
      const pad = Array.from({ length: padLen }, () => new Float64Array(this.inputSize));
      seq = [...pad, ...seq];
    }

    const { output } = this._forward(seq);
    return output;
  }

  /**
   * Get model status info (mirrors MLEngine.getModelStatus pattern).
   */
  getModelStatus() {
    return {
      type: 'LSTM',
      isTrained: this.isTrained,
      trainedAt: this.trainedAt,
      inputSize: this.inputSize,
      hiddenSize: this.hiddenSize,
      seqLen: this.seqLen,
      finalLoss: this.trainLosses.length > 0
        ? this.trainLosses[this.trainLosses.length - 1]
        : null,
      epochsTrained: this.trainLosses.length,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { LSTMCell, LSTMNetwork };
export default LSTMNetwork;
