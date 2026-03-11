/**
 * ML Training Worker Thread
 * Offloads heavy ML retraining off the main event loop using worker_threads.
 * Receives {features2D, labels, config} via parentPort, trains models, returns metrics.
 */

import { parentPort, workerData } from 'node:worker_threads';

// Simple RF, GBT, LR training logic inline (no external ML lib)
// The actual MLEngine class is imported dynamically

let MLEngine, LSTMNetwork;

async function init() {
  try {
    const mlMod = await import('./mlEngine.js');
    MLEngine = mlMod.MLEngine;
  } catch (e) {
    parentPort.postMessage({ error: `Cannot load MLEngine: ${e.message}` });
    process.exit(1);
  }
  try {
    const lstmMod = await import('./lstmEngine.js');
    LSTMNetwork = lstmMod.LSTMNetwork;
  } catch (e) {
    // LSTM optional
  }
}

parentPort.on('message', async (msg) => {
  const { type, features2D, labels, config, regimeLabels, lstmConfig } = msg;

  if (type === 'train') {
    try {
      await init();

      const engine = new MLEngine();

      // Apply tuned config
      if (config?.nTrees) engine.config.nTrees = config.nTrees;
      if (config?.nEstimators) engine.config.nEstimators = config.nEstimators;
      if (config?.maxDepth) engine.config.maxDepth = config.maxDepth;
      if (config?.learningRate) engine.config.learningRate = config.learningRate;

      // Train with cross-validation
      const nFolds = config?.nFolds || 5;
      const metrics = engine.train(features2D, labels, {
        crossValidate: true,
        nFolds,
        purgeGap: 5,
      });

      // Train LSTM if available and enough data (5min timeout to prevent blocking)
      let lstmWeights = null;
      if (LSTMNetwork && lstmConfig?.enabled && features2D.length >= 200) {
        try {
          const lstmTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('LSTM training timeout (5min)')), 300000)
          );
          const lstmTraining = (async () => {
            const seqLen = lstmConfig.sequenceLength || 20;
            const sequences = [];
            const seqLabels = [];
            for (let i = seqLen; i < features2D.length; i++) {
              sequences.push(features2D.slice(i - seqLen, i));
              seqLabels.push(labels[i]);
            }
            if (sequences.length >= 100) {
              const lstm = new LSTMNetwork(features2D[0].length, 64, 1);
              lstm.fit(sequences, seqLabels, Math.min(lstmConfig.epochs || 30, 20), 0.001);
              return lstm.serialize ? lstm.serialize() : null;
            }
            return null;
          })();
          lstmWeights = await Promise.race([lstmTraining, lstmTimeout]);
        } catch (lstmErr) {
          console.error('[MLWorker] LSTM training error:', lstmErr.message);
        }
      }

      const serialized = engine.serialize();

      parentPort.postMessage({
        type: 'trained',
        modelData: serialized,
        metrics,
        lstmWeights,
        sampleCount: features2D.length,
      });
    } catch (err) {
      parentPort.postMessage({ type: 'error', error: err.message });
    }
  }
});

parentPort.postMessage({ type: 'ready' });
