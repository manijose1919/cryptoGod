/**
 * Synthetic Labeler Service
 * Generates ML training samples from historical candle data.
 * For each ticker, fetches candles from the exchange adapter, builds feature vectors,
 * and labels them by looking ahead at future price movement.
 */

// Dynamic imports for resilience (pattern used throughout the codebase)
let buildFeatureVector = null;
let FEATURE_COUNT = 103;
let db = null;

try {
  const fe = await import('./featureEngineering.js');
  buildFeatureVector = fe.buildFeatureVector;
  FEATURE_COUNT = fe.FEATURE_COUNT;
} catch (err) {
  console.warn('[SyntheticLabeler] featureEngineering.js not available:', err.message);
}

try {
  db = await import('./database.js');
} catch (err) {
  console.warn('[SyntheticLabeler] database.js not available:', err.message);
}

// --- Constants ---
const BREAK_EVEN_THRESHOLD = 0.0067; // 0.67% — Kraken fees + slippage
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1500;

// Horizons: how many candles to look ahead for labeling, per timeframe
// Format: { label, candles_5m, candles_15m, candles_1h }
const HORIZONS = [
  { label: '1h',  candles: { '5m': 12,  '15m': 4,   '1h': 1  } },
  { label: '4h',  candles: { '5m': 48,  '15m': 16,  '1h': 4  } },
  { label: '24h', candles: { '5m': 288, '15m': 96,  '1h': 24 } },
];

const TIMEFRAMES = ['5m', '15m', '1h'];

// In-memory job tracker
let currentJob = null;

/**
 * Get current running job or latest from DB.
 */
export function getJobStatus() {
  if (currentJob) return currentJob;
  if (!db) return null;
  try {
    return db.getLatestLabelingJob();
  } catch (err) {
    console.warn('[SyntheticLabeler] getJobStatus DB error:', err.message);
    return null;
  }
}

/**
 * Main entry point: generate labeled ML samples from exchange candle data.
 *
 * @param {object} adapter - Exchange adapter (KrakenAdapter, etc.)
 * @param {object} [options]
 * @param {string[]|null} [options.tickerList] - Specific tickers, or null for all USD pairs
 * @param {number} [options.maxCandles=500] - Max candles to fetch per ticker/timeframe
 * @returns {{ jobId, totalPairs, status } | { error }}
 */
export function generateSamples(adapter, options = {}) {
  // Prevent concurrent runs
  if (currentJob && currentJob.status === 'running') {
    return { error: 'A labeling job is already running', jobId: currentJob.jobId };
  }

  if (!buildFeatureVector) {
    return { error: 'featureEngineering.js not loaded — cannot build feature vectors' };
  }

  if (!db) {
    return { error: 'database.js not loaded — cannot persist samples' };
  }

  const maxCandles = options.maxCandles || 500;

  // Create DB job record
  let jobId;
  try {
    jobId = db.createLabelingJob();
  } catch (err) {
    return { error: `Failed to create labeling job: ${err.message}` };
  }

  // Fire-and-forget async processing
  (async () => {
    try {
      // Resolve ticker list
      let tickers = options.tickerList;
      if (!tickers) {
        const adapterResult = await adapter.getInstruments();
        const instruments = Array.isArray(adapterResult)
          ? adapterResult
          : (adapterResult?.data || adapterResult?.instruments || []);
        tickers = instruments
          .filter(i => (i.quote_currency || '').toUpperCase() === 'USD')
          .map(i => i.instrument_name);
      }

      currentJob = {
        jobId,
        status: 'running',
        totalPairs: tickers.length,
        completedPairs: 0,
        totalSamples: 0,
        startedAt: Date.now(),
      };

      try {
        db.updateLabelingJob(jobId, { totalPairs: tickers.length });
      } catch (err) {
        console.warn('[SyntheticLabeler] DB update error (totalPairs):', err.message);
      }

      console.log(`[SyntheticLabeler] Job ${jobId} started: ${tickers.length} tickers, maxCandles=${maxCandles}`);

      // Process in batches
      for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
        const batch = tickers.slice(i, i + BATCH_SIZE);

        for (const ticker of batch) {
          try {
            const samples = await processTickerCandles(adapter, ticker, TIMEFRAMES, maxCandles, HORIZONS);
            currentJob.completedPairs++;
            currentJob.totalSamples += samples;
          } catch (err) {
            console.warn(`[SyntheticLabeler] Error processing ${ticker}:`, err.message);
            currentJob.completedPairs++;
          }

          // Update DB progress periodically
          try {
            db.updateLabelingJob(jobId, {
              completedPairs: currentJob.completedPairs,
              totalSamples: currentJob.totalSamples,
            });
          } catch (err) {
            // Non-fatal — keep going
          }
        }

        // Delay between batches to avoid rate limits
        if (i + BATCH_SIZE < tickers.length) {
          await sleep(BATCH_DELAY_MS);
        }
      }

      // Mark complete
      currentJob.status = 'completed';
      currentJob.completedAt = Date.now();
      console.log(`[SyntheticLabeler] Job ${jobId} completed: ${currentJob.totalSamples} samples from ${currentJob.completedPairs} tickers`);

      try {
        db.updateLabelingJob(jobId, {
          status: 'completed',
          completedPairs: currentJob.completedPairs,
          totalSamples: currentJob.totalSamples,
          completedAt: Date.now(),
        });
      } catch (err) {
        console.warn('[SyntheticLabeler] DB update error (complete):', err.message);
      }
    } catch (err) {
      console.error(`[SyntheticLabeler] Job ${jobId} failed:`, err.message);
      currentJob = { ...currentJob, status: 'failed', error: err.message };
      try {
        db.updateLabelingJob(jobId, { status: 'failed', error: err.message, completedAt: Date.now() });
      } catch (dbErr) {
        // Non-fatal
      }
    }
  })();

  // Return immediately
  return { jobId, totalPairs: 0, status: 'started' };
}

/**
 * Process a single ticker across timeframes, building labeled feature vectors.
 *
 * @param {object} adapter - Exchange adapter
 * @param {string} ticker - e.g. "BTCUSD"
 * @param {string[]} timeframes - e.g. ["5m", "15m", "1h"]
 * @param {number} maxCandles - Max candles to fetch per timeframe
 * @param {Array} horizons - Horizon definitions
 * @returns {number} Count of samples generated
 */
async function processTickerCandles(adapter, ticker, timeframes, maxCandles, horizons) {
  let totalSamples = 0;

  for (const tf of timeframes) {
    let candles;
    try {
      candles = await adapter.getCandles(ticker, tf, maxCandles);
    } catch (err) {
      console.warn(`[SyntheticLabeler] getCandles(${ticker}, ${tf}) failed:`, err.message);
      continue;
    }

    if (!candles || candles.length < 50) {
      continue; // Not enough data for feature extraction
    }

    // Determine the maximum lookahead for this timeframe across all horizons
    const maxHorizonCandles = Math.max(
      ...horizons.map(h => h.candles[tf] || 0)
    );

    if (maxHorizonCandles === 0) continue; // No horizons defined for this timeframe

    // Start at index 30 (need enough history for indicators)
    // End at candles.length - maxHorizonCandles (need room to look ahead)
    const startIdx = 30;
    const endIdx = candles.length - maxHorizonCandles;

    if (startIdx >= endIdx) continue; // Not enough candles for both history and lookahead

    const samples = [];

    for (let idx = startIdx; idx < endIdx; idx++) {
      // Build feature vector from candles up to and including current index
      const currentCandles = candles.slice(0, idx + 1);
      let featureVector;
      try {
        featureVector = buildFeatureVector(ticker, currentCandles, {});
      } catch (err) {
        continue; // Skip this candle if feature extraction fails
      }

      if (!featureVector || featureVector.length !== FEATURE_COUNT) {
        continue; // Invalid feature vector
      }

      const currentClose = candles[idx].c;
      const candleTimestamp = candles[idx].t;

      // Label for each horizon
      for (const horizon of horizons) {
        const lookAhead = horizon.candles[tf];
        if (!lookAhead || idx + lookAhead >= candles.length) continue;

        const futureClose = candles[idx + lookAhead].c;
        if (currentClose <= 0) continue;
        const priceChange = (futureClose - currentClose) / currentClose;
        const label = priceChange > BREAK_EVEN_THRESHOLD ? 'UP' : 'DOWN';
        const labelValue = priceChange * 100; // As percentage

        samples.push({
          ticker,
          timestamp: candleTimestamp,
          featuresJson: JSON.stringify(featureVector),
          label,
          labelValue,
          labeledAt: Date.now(),
        });
      }
    }

    // Bulk insert
    if (samples.length > 0) {
      try {
        db.insertMLFeaturesBatch(samples);
        totalSamples += samples.length;
      } catch (err) {
        console.warn(`[SyntheticLabeler] insertMLFeaturesBatch(${ticker}, ${tf}) failed:`, err.message);
      }
    }
  }

  return totalSamples;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
