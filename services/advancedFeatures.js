/**
 * Advanced Feature Engineering - Phase 8
 * Extends the 103 base features with:
 * - Feature Interactions (+20): Top pairwise interactions from SHAP
 * - Multi-Timeframe Fusion (+15): RSI, MACD, Bollinger, ATR from extra timeframes
 * - Wavelet Decomposition (+8): Haar wavelet DWT on price series
 *
 * Total: 103 + 43 = 146 features
 */

import { getFlag } from './systemConfig.js';

export const ADVANCED_FEATURE_COUNT = 43; // Features added by this module

// ================================================================
// Feature Interactions (+20)
// ================================================================

// Top-10 most interacting feature pairs (indices from SHAP analysis)
// These are updated by the SHAP interaction tracker at runtime
let interactionPairs = [
  [0, 1],    // RSI × MACD
  [0, 3],    // RSI × Bollinger %B
  [1, 10],   // MACD × ATR
  [0, 20],   // RSI × Volume Ratio
  [3, 4],    // Bollinger %B × Bollinger Width
  [10, 11],  // ATR × Price Change 1c
  [5, 6],    // EMA9/21 × EMA21/50
  [16, 17],  // Stochastic K × Stochastic D
  [0, 18],   // RSI × ADX
  [20, 24],  // Volume Ratio × Volume Spike
];

/**
 * Update interaction pairs from SHAP analysis results
 * @param {Array<{index1, index2}>} pairs - Top interaction pairs from SHAP
 */
export function updateInteractionPairs(pairs) {
  if (pairs && pairs.length >= 5) {
    interactionPairs = pairs.slice(0, 10).map(p => [p.index1, p.index2]);
  }
}

/**
 * Compute feature interaction features
 * @param {number[]} baseFeatures - 103-element base feature vector
 * @returns {number[]} 20-element array (10 products + 10 ratios)
 */
export function computeInteractions(baseFeatures) {
  if (!getFlag('FEATURE_INTERACTIONS_ENABLED')) return new Array(20).fill(0);

  const interactions = [];

  for (const [i, j] of interactionPairs) {
    const fi = baseFeatures[i] || 0;
    const fj = baseFeatures[j] || 0;

    // Product interaction
    interactions.push(fi * fj);

    // Ratio interaction (safe division)
    const denom = Math.abs(fj) > 0.001 ? fj : 0.001;
    interactions.push(fi / denom);
  }

  // Clamp to prevent extreme values
  return interactions.map(v => {
    if (isNaN(v) || !isFinite(v)) return 0;
    return Math.max(-10, Math.min(10, v));
  });
}

// ================================================================
// Multi-Timeframe Fusion (+15)
// ================================================================

/**
 * Compute multi-timeframe features from candles at different timeframes
 * @param {object} mtfCandles - { h4: candles, d1: candles, w1: candles } (optional)
 * @param {number[]} baseFeatures - For cross-TF comparison
 * @returns {number[]} 15-element array
 */
export function computeMTFFeatures(mtfCandles = {}, baseFeatures = []) {
  if (!getFlag('MTF_FEATURES_ENABLED')) return new Array(15).fill(0);

  const features = new Array(15).fill(0);
  let idx = 0;

  // 4H timeframe indicators (5 features)
  const h4 = mtfCandles.h4 || [];
  if (h4.length >= 20) {
    const closes = h4.map(c => c.c || c.close || c[4] || 0);
    features[idx++] = calculateSimpleRSI(closes, 14) / 100;         // RSI 4H
    features[idx++] = calculateSimpleMACD(closes);                     // MACD 4H
    features[idx++] = calculateSimpleBollingerB(closes, 20);          // Bollinger %B 4H
    features[idx++] = calculateSimpleATR(h4, 14);                      // ATR 4H norm
    features[idx++] = closes[closes.length - 1] > sma(closes, 50) ? 1 : -1; // Price vs SMA50 4H
  } else {
    idx += 5;
  }

  // Daily timeframe indicators (5 features)
  const d1 = mtfCandles.d1 || [];
  if (d1.length >= 20) {
    const closes = d1.map(c => c.c || c.close || c[4] || 0);
    features[idx++] = calculateSimpleRSI(closes, 14) / 100;
    features[idx++] = calculateSimpleMACD(closes);
    features[idx++] = calculateSimpleBollingerB(closes, 20);
    features[idx++] = calculateSimpleATR(d1, 14);
    features[idx++] = closes[closes.length - 1] > sma(closes, 50) ? 1 : -1;
  } else {
    idx += 5;
  }

  // Weekly timeframe indicators (4 features)
  const w1 = mtfCandles.w1 || [];
  if (w1.length >= 14) {
    const closes = w1.map(c => c.c || c.close || c[4] || 0);
    features[idx++] = calculateSimpleRSI(closes, 14) / 100;
    features[idx++] = calculateSimpleMACD(closes);
    features[idx++] = calculateSimpleBollingerB(closes, 20);
    features[idx++] = calculateSimpleATR(w1, 14);
  } else {
    idx += 4;
  }

  // Cross-timeframe agreement score (1 feature)
  // How many timeframes agree on direction with the 1H base
  const baseRSI = baseFeatures[0] || 0.5;
  const baseDirection = baseRSI > 0.5 ? 1 : -1;
  let agreement = 0;
  let tfCount = 0;

  if (features[0] > 0) { // 4H RSI exists
    agreement += (features[0] > 0.5 ? 1 : -1) === baseDirection ? 1 : 0;
    tfCount++;
  }
  if (features[5] > 0) { // D1 RSI exists
    agreement += (features[5] > 0.5 ? 1 : -1) === baseDirection ? 1 : 0;
    tfCount++;
  }
  if (features[10] > 0) { // W1 RSI exists
    agreement += (features[10] > 0.5 ? 1 : -1) === baseDirection ? 1 : 0;
    tfCount++;
  }

  features[idx++] = tfCount > 0 ? agreement / tfCount : 0;

  return features;
}

// ================================================================
// Wavelet Decomposition (+8)
// ================================================================

/**
 * Haar wavelet 3-level DWT decomposition
 * Extracts energy, slope, zero-crossings per level
 * @param {number[]} prices - Close prices (at least 30)
 * @returns {number[]} 8-element array
 */
export function computeWaveletFeatures(prices) {
  if (!getFlag('WAVELET_FEATURES_ENABLED') || !prices || prices.length < 16) {
    return new Array(8).fill(0);
  }

  // Take last 64 prices (power of 2 for DWT)
  const signal = prices.slice(-64);
  while (signal.length < 64) signal.unshift(signal[0] || 0);

  // Normalize signal
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  const std = Math.sqrt(signal.reduce((a, b) => a + (b - mean) ** 2, 0) / signal.length) || 1;
  const normalized = signal.map(v => (v - mean) / std);

  // 3-level Haar wavelet decomposition
  const details = [];
  let approx = [...normalized];

  for (let level = 0; level < 3; level++) {
    const newApprox = [];
    const detail = [];

    for (let i = 0; i < approx.length - 1; i += 2) {
      newApprox.push((approx[i] + approx[i + 1]) / Math.SQRT2);
      detail.push((approx[i] - approx[i + 1]) / Math.SQRT2);
    }

    details.push(detail);
    approx = newApprox;
  }

  const features = [];

  // Per-level features (3 levels × 2 features = 6)
  for (let level = 0; level < 3; level++) {
    const d = details[level];
    if (!d || d.length === 0) {
      features.push(0, 0);
      continue;
    }

    // Energy (sum of squared coefficients, normalized)
    const energy = d.reduce((a, b) => a + b * b, 0) / d.length;
    features.push(Math.min(energy, 10));

    // Zero-crossings (indicator of frequency content)
    let zeroCrossings = 0;
    for (let i = 1; i < d.length; i++) {
      if ((d[i - 1] > 0 && d[i] < 0) || (d[i - 1] < 0 && d[i] > 0)) {
        zeroCrossings++;
      }
    }
    features.push(zeroCrossings / d.length);
  }

  // Approximation features (2)
  // Slope of the low-frequency approximation
  if (approx.length >= 2) {
    const slope = (approx[approx.length - 1] - approx[0]) / (approx.length - 1);
    features.push(Math.max(-5, Math.min(5, slope)));
  } else {
    features.push(0);
  }

  // Energy ratio (high-freq vs low-freq)
  const totalDetailEnergy = details.reduce((sum, d) =>
    sum + d.reduce((a, b) => a + b * b, 0), 0);
  const approxEnergy = approx.reduce((a, b) => a + b * b, 0);
  features.push(totalDetailEnergy / (approxEnergy + totalDetailEnergy + 1e-8));

  return features;
}

// ================================================================
// Combined Advanced Feature Builder
// ================================================================

/**
 * Build the full 43 advanced features
 * @param {number[]} baseFeatures - 103-element base vector
 * @param {number[]} prices - Close prices for wavelet
 * @param {object} mtfCandles - Multi-timeframe candles
 * @returns {number[]} 43 advanced features
 */
export function buildAdvancedFeatures(baseFeatures, prices = [], mtfCandles = {}) {
  const interactions = computeInteractions(baseFeatures);     // 20
  const mtf = computeMTFFeatures(mtfCandles, baseFeatures);   // 15
  const wavelet = computeWaveletFeatures(prices);              // 8

  return [...interactions, ...mtf, ...wavelet];
}

/**
 * Get names for all 43 advanced features
 * @returns {string[]}
 */
export function getAdvancedFeatureNames() {
  const names = [];

  // Interaction features (20)
  for (const [i, j] of interactionPairs) {
    names.push(`interact_${i}_${j}_prod`);
    names.push(`interact_${i}_${j}_ratio`);
  }

  // MTF features (15)
  const tfNames = ['rsi', 'macd', 'boll_b', 'atr', 'trend'];
  for (const tf of ['4h', 'd1']) {
    for (const name of tfNames) {
      names.push(`mtf_${tf}_${name}`);
    }
  }
  for (const name of ['rsi', 'macd', 'boll_b', 'atr']) {
    names.push(`mtf_w1_${name}`);
  }
  names.push('mtf_cross_tf_agreement');

  // Wavelet features (8)
  for (let level = 1; level <= 3; level++) {
    names.push(`wavelet_L${level}_energy`);
    names.push(`wavelet_L${level}_zero_cross`);
  }
  names.push('wavelet_approx_slope');
  names.push('wavelet_freq_ratio');

  return names;
}

// ================================================================
// Sequence Matrix Builder (for LSTM/TFT)
// ================================================================

/**
 * Build a (sequenceLength × featureCount) matrix from stored feature vectors
 * @param {number[][]} featureHistory - Array of feature vectors (newest last)
 * @param {number} sequenceLength - Desired sequence length (default 30)
 * @returns {number[][]} sequenceLength × featureCount matrix
 */
export function buildSequenceMatrix(featureHistory, sequenceLength = 30) {
  if (!featureHistory || featureHistory.length === 0) return [];

  // Pad with zeros if not enough history
  const padded = [...featureHistory];
  while (padded.length < sequenceLength) {
    padded.unshift(new Array(padded[0].length).fill(0));
  }

  return padded.slice(-sequenceLength);
}

// ================================================================
// Helper Functions
// ================================================================

function calculateSimpleRSI(closes, period) {
  if (closes.length < period + 1) return 50;

  let gainSum = 0, lossSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateSimpleMACD(closes) {
  if (closes.length < 26) return 0;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 - ema26;
  // Normalize by price
  const price = closes[closes.length - 1] || 1;
  return macdLine / price;
}

function calculateSimpleBollingerB(closes, period) {
  if (closes.length < period) return 0.5;
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / period) || 1;
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const current = closes[closes.length - 1];
  return (upper - lower) > 0 ? (current - lower) / (upper - lower) : 0.5;
}

function calculateSimpleATR(candles, period) {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const h = c.h || c.high || c[2] || 0;
    const l = c.l || c.low || c[3] || 0;
    const prevC = candles[i - 1];
    const prevClose = prevC?.c || prevC?.close || prevC?.[4] || 0;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    atrSum += tr;
  }
  const atr = atrSum / period;
  const price = candles[candles.length - 1]?.c || candles[candles.length - 1]?.close || candles[candles.length - 1]?.[4] || 1;
  return atr / price; // Normalized ATR
}

function sma(arr, period) {
  if (arr.length < period) return arr[arr.length - 1] || 0;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(arr, period) {
  if (arr.length === 0) return 0;
  const k = 2 / (period + 1);
  let emaVal = arr[0];
  for (let i = 1; i < arr.length; i++) {
    emaVal = arr[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

console.log('[Advanced Features] Loaded');
