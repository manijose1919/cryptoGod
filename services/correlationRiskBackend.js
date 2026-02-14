/**
 * Correlation Risk Manager (Backend)
 * Computes Pearson correlation matrices from candle history.
 * Blocks/reduces entries when portfolio is too correlated.
 */

import { getDb } from './database.js';

/**
 * Get close prices for a ticker from candle_history.
 * @param {string} ticker
 * @param {string} timeframe
 * @param {number} lookbackMinutes
 * @returns {number[]}
 */
function getClosePrices(ticker, timeframe, lookbackMinutes) {
  const db = getDb();
  if (!db) return [];
  const since = Date.now() - lookbackMinutes * 60 * 1000;
  const rows = db.prepare(
    `SELECT close FROM candle_history WHERE ticker = ? AND timeframe = ? AND timestamp >= ? ORDER BY timestamp ASC`
  ).all(ticker, timeframe, since);
  return rows.map(r => r.close);
}

/**
 * Pearson correlation between two arrays of equal length.
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xSlice[i];
    sumY += ySlice[i];
    sumXY += xSlice[i] * ySlice[i];
    sumX2 += xSlice[i] * xSlice[i];
    sumY2 += ySlice[i] * ySlice[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Compute correlation matrix for a list of tickers.
 * @param {string[]} tickers
 * @param {string} timeframe - e.g. '5m'
 * @param {number} lookbackMinutes - e.g. 1440 for 24h
 * @returns {{ matrix: number[][], tickers: string[] }}
 */
export function getCorrelationMatrix(tickers, timeframe = '5m', lookbackMinutes = 1440) {
  const pricesMap = {};
  for (const ticker of tickers) {
    pricesMap[ticker] = getClosePrices(ticker, timeframe, lookbackMinutes);
  }

  const n = tickers.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1; // Self-correlation
    for (let j = i + 1; j < n; j++) {
      const corr = pearsonCorrelation(pricesMap[tickers[i]], pricesMap[tickers[j]]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return { matrix, tickers };
}

/**
 * Check if a proposed trade has too-high correlation with existing positions.
 * @param {Object} existingPositions - { ticker: { ... } }
 * @param {string} proposedTicker
 * @param {{ matrix: number[][], tickers: string[] }} corrData
 * @returns {{ allowed: boolean, reduction: number, maxCorrelation: number, correlatedWith: string }}
 */
export function checkCorrelationRisk(existingPositions, proposedTicker, corrData) {
  const positionTickers = Object.keys(existingPositions);
  if (positionTickers.length === 0) {
    return { allowed: true, reduction: 1, maxCorrelation: 0, correlatedWith: null };
  }

  const { matrix, tickers } = corrData;
  const proposedIdx = tickers.indexOf(proposedTicker);
  if (proposedIdx === -1) {
    return { allowed: true, reduction: 1, maxCorrelation: 0, correlatedWith: null };
  }

  let maxCorr = 0;
  let correlatedWith = null;

  for (const posTicker of positionTickers) {
    const posIdx = tickers.indexOf(posTicker);
    if (posIdx === -1) continue;

    const corr = Math.abs(matrix[proposedIdx][posIdx]);
    if (corr > maxCorr) {
      maxCorr = corr;
      correlatedWith = posTicker;
    }
  }

  if (maxCorr > 0.9) {
    return { allowed: false, reduction: 0, maxCorrelation: maxCorr, correlatedWith };
  }
  if (maxCorr > 0.8) {
    return { allowed: true, reduction: 0.5, maxCorrelation: maxCorr, correlatedWith };
  }
  return { allowed: true, reduction: 1, maxCorrelation: maxCorr, correlatedWith };
}

export default { getCorrelationMatrix, checkCorrelationRisk };
