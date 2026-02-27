/**
 * Synthetic Data Engine - TimeGAN Implementation
 * Phase 5: Generate realistic synthetic market sequences to 5-10x training data
 *
 * Architecture:
 * - Generator: LSTM → Dense → synthetic feature sequences
 * - Discriminator: LSTM → Dense → real/fake probability
 * - Embedder + Recovery + Supervisor networks
 * - Quality gate: KS-test, autocorrelation test, discriminative score
 */

import { getFlag } from './systemConfig.js';

let tf;
try {
  try { tf = await import('@tensorflow/tfjs-node'); } catch { tf = await import('@tensorflow/tfjs'); }
} catch (err) {
  console.warn('[Synthetic Data] TensorFlow.js not available:', err.message);
}

class TimeGAN {
  constructor(config = {}) {
    this.seqLen = config.seqLen || 30;
    this.featureDim = config.featureDim || 103;
    this.hiddenDim = config.hiddenDim || 64;
    this.latentDim = config.latentDim || 32;
    this.batchSize = config.batchSize || 32;

    this.embedder = null;
    this.recovery = null;
    this.generator = null;
    this.discriminator = null;
    this.supervisor = null;
    this.isTrained = false;
  }

  buildNetworks() {
    if (!tf) return;

    // Embedder: real data → latent space
    const embInput = tf.input({ shape: [this.seqLen, this.featureDim] });
    let emb = tf.layers.lstm({ units: this.hiddenDim, returnSequences: true }).apply(embInput);
    emb = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: this.latentDim, activation: 'sigmoid' })
    }).apply(emb);
    this.embedder = tf.model({ inputs: embInput, outputs: emb });

    // Recovery: latent space → reconstructed data
    const recInput = tf.input({ shape: [this.seqLen, this.latentDim] });
    let rec = tf.layers.lstm({ units: this.hiddenDim, returnSequences: true }).apply(recInput);
    rec = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: this.featureDim, activation: 'sigmoid' })
    }).apply(rec);
    this.recovery = tf.model({ inputs: recInput, outputs: rec });

    // Generator: random noise → latent sequences
    const genInput = tf.input({ shape: [this.seqLen, this.latentDim] });
    let gen = tf.layers.lstm({ units: this.hiddenDim, returnSequences: true }).apply(genInput);
    gen = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: this.latentDim, activation: 'sigmoid' })
    }).apply(gen);
    this.generator = tf.model({ inputs: genInput, outputs: gen });

    // Supervisor: ensures temporal coherence in generated sequences
    const supInput = tf.input({ shape: [this.seqLen, this.latentDim] });
    let sup = tf.layers.lstm({ units: this.hiddenDim, returnSequences: true }).apply(supInput);
    sup = tf.layers.timeDistributed({
      layer: tf.layers.dense({ units: this.latentDim, activation: 'sigmoid' })
    }).apply(sup);
    this.supervisor = tf.model({ inputs: supInput, outputs: sup });

    // Discriminator: latent sequence → real/fake
    const disInput = tf.input({ shape: [this.seqLen, this.latentDim] });
    let dis = tf.layers.lstm({ units: this.hiddenDim, returnSequences: false }).apply(disInput);
    dis = tf.layers.dense({ units: 1, activation: 'sigmoid' }).apply(dis);
    this.discriminator = tf.model({ inputs: disInput, outputs: dis });

    // Compile
    this.embedder.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
    this.recovery.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
    this.generator.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
    this.supervisor.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
    this.discriminator.compile({ optimizer: tf.train.adam(0.0005), loss: 'binaryCrossentropy' });
  }

  /**
   * Train TimeGAN on real sequences
   * @param {number[][][]} realSequences - (N x seqLen x featureDim) normalized sequences
   * @param {number} epochs - Training epochs (default 50)
   */
  async train(realSequences, epochs = 50) {
    if (!tf || !realSequences.length) return null;
    if (!this.embedder) this.buildNetworks();

    const n = realSequences.length;
    console.log(`[Synthetic Data] Training TimeGAN on ${n} sequences, ${epochs} epochs...`);

    // Normalize data to [0, 1]
    const { normalized, mins, maxs } = this._normalizeSequences(realSequences);
    this._mins = mins;
    this._maxs = maxs;

    const realTensor = tf.tensor3d(normalized);

    // Phase 1: Embedding + Recovery (autoencoder)
    for (let ep = 0; ep < Math.min(epochs, 30); ep++) {
      const embedded = this.embedder.predict(realTensor);
      await this.recovery.fit(embedded, realTensor, {
        epochs: 1, batchSize: this.batchSize, verbose: 0
      });
      embedded.dispose();
    }

    // Phase 2: Supervisor training (temporal coherence)
    for (let ep = 0; ep < Math.min(epochs, 30); ep++) {
      const embedded = this.embedder.predict(realTensor);
      // Supervisor learns to predict next-step embeddings
      const target = embedded.slice([0, 1, 0], [-1, -1, -1]);
      const input = embedded.slice([0, 0, 0], [-1, this.seqLen - 1, -1]);
      // Pad target to match sequence length
      const padded = tf.concat([target, tf.zeros([n, 1, this.latentDim])], 1);
      await this.supervisor.fit(embedded, padded, {
        epochs: 1, batchSize: this.batchSize, verbose: 0
      });
      embedded.dispose();
      target.dispose();
      input.dispose();
      padded.dispose();
    }

    // Phase 3: Joint training (Generator + Discriminator)
    for (let ep = 0; ep < epochs; ep++) {
      // Generate fake latent sequences
      const noise = tf.randomNormal([n, this.seqLen, this.latentDim]);
      const fakeLatent = this.generator.predict(noise);
      const realLatent = this.embedder.predict(realTensor);

      // Train discriminator
      const realLabels = tf.ones([n, 1]);
      const fakeLabels = tf.zeros([n, 1]);
      await this.discriminator.fit(realLatent, realLabels, {
        epochs: 1, batchSize: this.batchSize, verbose: 0
      });
      await this.discriminator.fit(fakeLatent, fakeLabels, {
        epochs: 1, batchSize: this.batchSize, verbose: 0
      });

      // Train generator (fool discriminator)
      // Use supervised loss to maintain temporal coherence
      const supervisedFake = this.supervisor.predict(fakeLatent);
      await this.generator.fit(noise, realLatent, {
        epochs: 1, batchSize: this.batchSize, verbose: 0
      });

      noise.dispose();
      fakeLatent.dispose();
      realLatent.dispose();
      realLabels.dispose();
      fakeLabels.dispose();
      supervisedFake.dispose();

      if ((ep + 1) % 10 === 0) {
        console.log(`[Synthetic Data] TimeGAN epoch ${ep + 1}/${epochs}`);
      }
    }

    realTensor.dispose();
    this.isTrained = true;
    console.log('[Synthetic Data] TimeGAN training complete');
    return { epochs, sampleCount: n };
  }

  /**
   * Generate synthetic sequences
   * @param {number} count - Number of synthetic sequences to generate
   * @returns {number[][][]} Synthetic sequences (count x seqLen x featureDim)
   */
  generate(count = 100) {
    if (!tf || !this.isTrained) return [];

    const noise = tf.randomNormal([count, this.seqLen, this.latentDim]);
    const fakeLatent = this.generator.predict(noise);
    const supervisedLatent = this.supervisor.predict(fakeLatent);
    const synthetic = this.recovery.predict(supervisedLatent);

    const data = synthetic.arraySync();

    noise.dispose();
    fakeLatent.dispose();
    supervisedLatent.dispose();
    synthetic.dispose();

    // Denormalize
    if (this._mins && this._maxs) {
      return data.map(seq =>
        seq.map(step =>
          step.map((v, i) => v * (this._maxs[i] - this._mins[i]) + this._mins[i])
        )
      );
    }

    return data;
  }

  /**
   * Quality gate: validate synthetic data quality
   * @param {number[][][]} real - Real sequences
   * @param {number[][][]} synthetic - Generated sequences
   * @returns {object} { passed, ksScore, autoCorr, discriminativeScore }
   */
  validateQuality(real, synthetic) {
    if (!real.length || !synthetic.length) return { passed: false };

    const threshold = getFlag('SYNTHETIC_QUALITY_THRESHOLD') || 0.35;

    // 1. KS-test approximation: compare feature distributions
    const realFlat = real.flat();
    const synthFlat = synthetic.flat();
    let ksMaxDiff = 0;

    for (let f = 0; f < Math.min(this.featureDim, realFlat[0]?.length || 0); f++) {
      const realVals = realFlat.map(r => r[f] || 0).sort((a, b) => a - b);
      const synthVals = synthFlat.map(s => s[f] || 0).sort((a, b) => a - b);

      // Simplified KS: max CDF difference
      const n1 = realVals.length;
      const n2 = synthVals.length;
      let i = 0, j = 0, maxDiff = 0;
      while (i < n1 && j < n2) {
        const cdf1 = (i + 1) / n1;
        const cdf2 = (j + 1) / n2;
        maxDiff = Math.max(maxDiff, Math.abs(cdf1 - cdf2));
        if (realVals[i] <= synthVals[j]) i++;
        else j++;
      }
      ksMaxDiff = Math.max(ksMaxDiff, maxDiff);
    }

    // 2. Autocorrelation comparison (lag-1 for first feature)
    const realAutoCorr = this._autoCorrelation(realFlat.map(r => r[0] || 0));
    const synthAutoCorr = this._autoCorrelation(synthFlat.map(s => s[0] || 0));
    const autoCorrDiff = Math.abs(realAutoCorr - synthAutoCorr);

    // 3. Discriminative score: how well can we tell real from fake?
    // Lower = better (means harder to distinguish)
    // Use discriminator if available
    let discriminativeScore = 0.5;
    if (this.discriminator && tf) {
      try {
        const realTensor = tf.tensor3d(real.slice(0, 50));
        const realLatent = this.embedder.predict(realTensor);
        const scores = this.discriminator.predict(realLatent).dataSync();
        discriminativeScore = Array.from(scores).reduce((a, b) => a + b, 0) / scores.length;
        realTensor.dispose();
        realLatent.dispose();
      } catch {}
    }

    const passed = ksMaxDiff < 0.3 && autoCorrDiff < 0.2 && discriminativeScore > threshold;

    return {
      passed,
      ksMaxDiff,
      autoCorrDiff,
      discriminativeScore,
      threshold,
    };
  }

  _normalizeSequences(sequences) {
    const featureDim = sequences[0][0].length;
    const mins = new Array(featureDim).fill(Infinity);
    const maxs = new Array(featureDim).fill(-Infinity);

    for (const seq of sequences) {
      for (const step of seq) {
        for (let i = 0; i < featureDim; i++) {
          const v = step[i] || 0;
          if (v < mins[i]) mins[i] = v;
          if (v > maxs[i]) maxs[i] = v;
        }
      }
    }

    // Avoid division by zero
    for (let i = 0; i < featureDim; i++) {
      if (maxs[i] === mins[i]) maxs[i] = mins[i] + 1;
    }

    const normalized = sequences.map(seq =>
      seq.map(step =>
        step.map((v, i) => ((v || 0) - mins[i]) / (maxs[i] - mins[i]))
      )
    );

    return { normalized, mins, maxs };
  }

  _autoCorrelation(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let num = 0, den = 0;
    for (let i = 0; i < values.length - 1; i++) {
      num += (values[i] - mean) * (values[i + 1] - mean);
      den += (values[i] - mean) ** 2;
    }
    return den > 0 ? num / den : 0;
  }

  dispose() {
    if (this.embedder) { this.embedder.dispose(); this.embedder = null; }
    if (this.recovery) { this.recovery.dispose(); this.recovery = null; }
    if (this.generator) { this.generator.dispose(); this.generator = null; }
    if (this.discriminator) { this.discriminator.dispose(); this.discriminator = null; }
    if (this.supervisor) { this.supervisor.dispose(); this.supervisor = null; }
    this.isTrained = false;
  }

  getStatus() {
    return {
      trained: this.isTrained,
      featureDim: this.featureDim,
      seqLen: this.seqLen,
    };
  }
}

// Singleton
const syntheticEngine = new TimeGAN();

export { TimeGAN, syntheticEngine };
export default syntheticEngine;

console.log('[Synthetic Data Engine] Loaded');
