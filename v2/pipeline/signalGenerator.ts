// ============================================
// Phoenix V2 Signal Generator
// TREND strategy only, individually scored signals
// ============================================

import type { Candle, ScanResult, SignalResult, SignalSnapshot } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import { computeSignals } from '../indicators/indicators.ts';

// --- Internal Types ---

interface SignalEval {
  name: string;
  score: number;   // 0-100
  active: boolean;
  weight: number;
}

// --- Signal Evaluation ---

/**
 * Evaluate 5 TREND signals independently. Each gets a score (0-100),
 * active flag, and weight for weighted averaging.
 */
export function evaluateSignals(signals: Record<string, number | boolean>): SignalEval[] {
  const rsiVal = signals.rsi as number;
  const macdCross = signals.macd_cross as boolean;
  const macdHist = signals.macd_histogram as number;
  const trendStr = signals.trend_strength as number;
  const volRatio = signals.volume_ratio as number;
  const pctB = signals.bb_percent_b as number;

  const evals: SignalEval[] = [];

  // 1. RSI oversold (weight 20)
  let rsiScore: number;
  if (rsiVal < 30) rsiScore = 90;
  else if (rsiVal < 40) rsiScore = 70;
  else if (rsiVal < 50) rsiScore = 50;
  else if (rsiVal < 60) rsiScore = 30;
  else rsiScore = 10;
  evals.push({ name: 'rsi_oversold', score: rsiScore, active: rsiVal < 45, weight: 20 });

  // 2. MACD cross (weight 25)
  let macdScore: number;
  if (macdCross) macdScore = 95;
  else if (macdHist > 0) macdScore = 60;
  else macdScore = 20;
  evals.push({ name: 'macd_cross', score: macdScore, active: macdCross || macdHist > 0, weight: 25 });

  // 3. Trend strength (weight 25)
  let trendScore: number;
  if (trendStr > 2) trendScore = 90;
  else if (trendStr > 1) trendScore = 75;
  else if (trendStr > 0.5) trendScore = 60;
  else if (trendStr > 0) trendScore = 40;
  else trendScore = 10;
  evals.push({ name: 'trend_strength', score: trendScore, active: trendStr > 0.5, weight: 25 });

  // 4. Volume spike (weight 15)
  let volScore: number;
  if (volRatio > 2) volScore = 90;
  else if (volRatio > 1.5) volScore = 75;
  else if (volRatio > 1) volScore = 55;
  else volScore = 30;
  evals.push({ name: 'volume_spike', score: volScore, active: volRatio > 1.2, weight: 15 });

  // 5. Bollinger lower touch (weight 15)
  let bbScore: number;
  if (pctB < 0.2) bbScore = 85;
  else if (pctB < 0.4) bbScore = 65;
  else if (pctB < 0.6) bbScore = 45;
  else bbScore = 25;
  evals.push({ name: 'bb_lower_touch', score: bbScore, active: pctB < 0.35, weight: 15 });

  return evals;
}

// --- Signal Generation ---

/**
 * For each passed scan result, compute indicators, evaluate signals,
 * and produce a composite score. PASS if >= MIN_COMPOSITE_SCORE.
 * Results sorted by compositeScore descending.
 */
export function generateSignals(
  scanResults: ScanResult[],
  tickerCandles: Map<string, Candle[]>,
): SignalResult[] {
  const results: SignalResult[] = [];

  for (const scan of scanResults) {
    if (!scan.passed) continue;

    const candles = tickerCandles.get(scan.ticker);
    if (!candles || candles.length < V2_CONFIG.MIN_CANDLES) continue;

    const { signals, regime } = computeSignals(candles);
    const evals = evaluateSignals(signals);

    // Weighted average
    const totalWeight = evals.reduce((sum, e) => sum + e.weight, 0);
    const compositeScore = totalWeight > 0
      ? evals.reduce((sum, e) => sum + e.score * e.weight, 0) / totalWeight
      : 0;
    const confidence = compositeScore / 100;

    const passed = compositeScore >= V2_CONFIG.MIN_COMPOSITE_SCORE;

    const activeSignals = evals.filter((e) => e.active).map((e) => e.name);
    const reason = passed
      ? `PASS: score=${compositeScore.toFixed(1)}, active=[${activeSignals.join(', ')}]`
      : `REJECT: score=${compositeScore.toFixed(1)} < min ${V2_CONFIG.MIN_COMPOSITE_SCORE}`;

    results.push({
      ticker: scan.ticker,
      passed,
      compositeScore,
      confidence,
      signals,
      regime: regime.regime,
      reason,
    });
  }

  // Sort descending by composite score
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  return results;
}

/**
 * Filter signal results to only those that passed.
 */
export function getPassedSignals(results: SignalResult[]): SignalResult[] {
  return results.filter((r) => r.passed);
}
