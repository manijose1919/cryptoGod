/**
 * Correlation Risk Service (Frontend)
 * Fetches correlation matrix from backend and provides risk analysis.
 */

const API_BASE = '/api';

export interface CorrelationMatrix {
  matrix: number[][];
  tickers: string[];
}

export interface CorrelationRisk {
  allowed: boolean;
  reduction: number;
  maxCorrelation: number;
  correlatedWith: string | null;
}

export async function fetchCorrelationMatrix(
  timeframe: string = '5m',
  lookback: number = 30
): Promise<CorrelationMatrix> {
  const res = await fetch(`${API_BASE}/correlation-matrix?timeframe=${timeframe}&lookback=${lookback}`);
  if (!res.ok) throw new Error('Failed to fetch correlation matrix');
  return res.json();
}

/**
 * Compute correlation matrix locally from watchlist price data.
 */
export function computeLocalCorrelationMatrix(
  watchlistData: Map<string, { candles: { c: number }[] }>
): CorrelationMatrix {
  const tickers = [...watchlistData.keys()];
  const n = tickers.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  const pricesMap: Record<string, number[]> = {};
  for (const ticker of tickers) {
    const data = watchlistData.get(ticker);
    pricesMap[ticker] = data?.candles?.map(c => c.c) || [];
  }

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const corr = pearsonCorrelation(pricesMap[tickers[i]], pricesMap[tickers[j]]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return { matrix, tickers };
}

function pearsonCorrelation(x: number[], y: number[]): number {
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
 * Check if a proposed ticker is too correlated with existing positions.
 */
export function checkCorrelationRisk(
  positions: Record<string, any>,
  proposedTicker: string,
  corrData: CorrelationMatrix
): CorrelationRisk {
  const positionTickers = Object.keys(positions);
  if (positionTickers.length === 0) {
    return { allowed: true, reduction: 1, maxCorrelation: 0, correlatedWith: null };
  }

  const { matrix, tickers } = corrData;
  const proposedIdx = tickers.indexOf(proposedTicker);
  if (proposedIdx === -1) {
    return { allowed: true, reduction: 1, maxCorrelation: 0, correlatedWith: null };
  }

  let maxCorr = 0;
  let correlatedWith: string | null = null;

  for (const posTicker of positionTickers) {
    const posIdx = tickers.indexOf(posTicker);
    if (posIdx === -1) continue;
    const corr = Math.abs(matrix[proposedIdx][posIdx]);
    if (corr > maxCorr) {
      maxCorr = corr;
      correlatedWith = posTicker;
    }
  }

  if (maxCorr > 0.9) return { allowed: false, reduction: 0, maxCorrelation: maxCorr, correlatedWith };
  if (maxCorr > 0.8) return { allowed: true, reduction: 0.5, maxCorrelation: maxCorr, correlatedWith };
  return { allowed: true, reduction: 1, maxCorrelation: maxCorr, correlatedWith };
}
