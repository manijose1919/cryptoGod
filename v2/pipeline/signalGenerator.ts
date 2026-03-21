// ============================================
// Phoenix V2 Signal Generator
// TREND strategy only, individually scored signals
// ============================================

import type { Candle, ScanResult, SignalResult } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import { computeSignals } from '../indicators/indicators.ts';
import { getSignalScores } from '../attribution/attributionStore.ts';

// --- Internal Types ---

interface SignalEval {
  name: string;
  score: number;   // 0-100
  active: boolean;
  weight: number;
}

// --- Adaptive Weight Map ---
// Maps signal eval names to scorecard signal names for weight adaptation
const EVAL_TO_SCORECARD: Record<string, string> = {
  rsi_momentum: 'rsi',
  macd_cross: 'macd_cross',
  trend_strength: 'trend_strength',
  volume_spike: 'volume_ratio',
  bb_lower_touch: 'bb_percent_b',
  tc_momentum: 'tc_value',
  sr_position: 'sr_channel_position',
  td_consensus: 'td_score',
};

// Cache scorecard verdicts for 5 minutes to avoid hammering SQLite
let _cachedVerdicts: Map<string, string> | null = null;
let _verdictCacheTime = 0;
const VERDICT_CACHE_TTL = 5 * 60 * 1000;

function getScorecardVerdicts(): Map<string, string> {
  const now = Date.now();
  if (_cachedVerdicts && now - _verdictCacheTime < VERDICT_CACHE_TTL) {
    return _cachedVerdicts;
  }
  try {
    const scores = getSignalScores();
    _cachedVerdicts = new Map(scores.map((s) => [s.signalName, '']));
    for (const s of scores) {
      let verdict: string;
      if (s.totalTrades < V2_CONFIG.MIN_TRADES_FOR_SCORING) verdict = 'inconclusive';
      else if (s.edge > 0.003 && s.winRate > 0.55) verdict = 'proven';
      else if (s.edge < -0.002) verdict = 'negative';
      else verdict = 'inconclusive';
      _cachedVerdicts.set(s.signalName, verdict);
    }
  } catch {
    _cachedVerdicts = new Map();
  }
  _verdictCacheTime = now;
  return _cachedVerdicts;
}

/**
 * Adjust signal weight based on scorecard verdict.
 * Proven → 1.5x weight, Negative → 0.5x weight, Inconclusive → 1.0x
 */
function adaptWeight(evalName: string, baseWeight: number): number {
  const scorecardName = EVAL_TO_SCORECARD[evalName];
  if (!scorecardName) return baseWeight;
  const verdicts = getScorecardVerdicts();
  const verdict = verdicts.get(scorecardName);
  if (verdict === 'proven') return Math.round(baseWeight * 1.5);
  if (verdict === 'negative') return Math.round(baseWeight * 0.5);
  return baseWeight;
}

// --- Signal Evaluation ---

/**
 * Evaluate 5 TREND signals independently. Each gets a score (0-100),
 * active flag, and weight for weighted averaging.
 * Weights are adapted based on signal scorecard verdicts.
 */
export function evaluateSignals(signals: Record<string, number | boolean | string>): SignalEval[] {
  const rsiVal = signals.rsi as number;
  const macdCross = signals.macd_cross as boolean;
  const macdHist = signals.macd_histogram as number;
  const trendStr = signals.trend_strength as number;
  const volRatio = signals.volume_ratio as number;
  const pctB = signals.bb_percent_b as number;

  const evals: SignalEval[] = [];

  // 1. RSI momentum (weight 20)
  // In uptrends RSI 50-70 is healthy — don't penalize it
  let rsiScore: number;
  if (rsiVal < 30) rsiScore = 90;       // deeply oversold — strong buy
  else if (rsiVal < 40) rsiScore = 75;
  else if (rsiVal < 50) rsiScore = 60;
  else if (rsiVal < 65) rsiScore = 45;   // trend-appropriate range
  else if (rsiVal < 75) rsiScore = 30;   // getting overbought
  else rsiScore = 10;                     // overbought — avoid
  evals.push({ name: 'rsi_momentum', score: rsiScore, active: rsiVal < 65, weight: adaptWeight('rsi_momentum', 20) });

  // 2. MACD cross (base weight 25, adapted by scorecard)
  let macdScore: number;
  if (macdCross) macdScore = 95;
  else if (macdHist > 0) macdScore = 60;
  else macdScore = 20;
  evals.push({ name: 'macd_cross', score: macdScore, active: macdCross || macdHist > 0, weight: adaptWeight('macd_cross', 25) });

  // 3. Trend strength (base weight 25, adapted by scorecard)
  let trendScore: number;
  if (trendStr > 2) trendScore = 90;
  else if (trendStr > 1) trendScore = 75;
  else if (trendStr > 0.5) trendScore = 60;
  else if (trendStr > 0) trendScore = 40;
  else trendScore = 10;
  evals.push({ name: 'trend_strength', score: trendScore, active: trendStr > 0.5, weight: adaptWeight('trend_strength', 25) });

  // 4. Volume spike (base weight 15, adapted by scorecard)
  let volScore: number;
  if (volRatio > 2) volScore = 90;
  else if (volRatio > 1.5) volScore = 75;
  else if (volRatio > 1) volScore = 55;
  else volScore = 30;
  evals.push({ name: 'volume_spike', score: volScore, active: volRatio > 1.2, weight: adaptWeight('volume_spike', 15) });

  // 5. Bollinger lower touch (base weight 10, adapted by scorecard)
  let bbScore: number;
  if (pctB < 0.2) bbScore = 85;
  else if (pctB < 0.4) bbScore = 65;
  else if (pctB < 0.6) bbScore = 45;
  else bbScore = 25;
  evals.push({ name: 'bb_lower_touch', score: bbScore, active: pctB < 0.35, weight: adaptWeight('bb_lower_touch', 10) });

  // ── TC (Trend Composite) Signals ──────────────────

  // 6. TC momentum (base weight 20) — core signal from PineScript daytrading system
  // TC < 20 = strong buy zone, TC > 80 = sell zone, inverted for score
  const tcVal = signals.tc_value as number ?? 50;
  const tcConsensus = signals.tc_consensus as number ?? 50;
  let tcScore: number;
  if (tcVal < 10) tcScore = 95;        // Deep buy zone — strongest signal
  else if (tcVal < 20) tcScore = 85;   // Buy zone
  else if (tcVal < 35) tcScore = 70;   // Leaning bullish
  else if (tcVal < 50) tcScore = 55;   // Neutral-bullish
  else if (tcVal < 65) tcScore = 40;   // Neutral
  else if (tcVal < 80) tcScore = 25;   // Leaning bearish
  else tcScore = 10;                    // Sell zone — avoid
  // Boost if multi-timeframe consensus agrees
  if (tcConsensus > 70 && tcScore > 50) tcScore = Math.min(100, tcScore + 10);
  evals.push({ name: 'tc_momentum', score: tcScore, active: tcVal < 40, weight: adaptWeight('tc_momentum', 20) });

  // 7. S/R channel position (base weight 10) — buy near support, avoid near resistance
  const srPos = signals.sr_channel_position as number ?? 0.5;
  let srScore: number;
  if (srPos < 0.15) srScore = 90;      // Right at support
  else if (srPos < 0.30) srScore = 75; // Near support
  else if (srPos < 0.50) srScore = 55; // Lower half of channel
  else if (srPos < 0.70) srScore = 35; // Upper half
  else if (srPos < 0.85) srScore = 20; // Near resistance
  else srScore = 10;                    // At resistance — worst entry
  evals.push({ name: 'sr_position', score: srScore, active: srPos < 0.40, weight: adaptWeight('sr_position', 10) });

  // 8. Trend Dashboard consensus (base weight 10) — 6-indicator bull/bear vote
  const tdScore = signals.td_score as number ?? 50;
  let dashScore: number;
  if (tdScore >= 83) dashScore = 90;    // 5-6 bullish indicators
  else if (tdScore >= 67) dashScore = 75; // 4 bullish
  else if (tdScore >= 50) dashScore = 55; // 3 bullish (neutral)
  else if (tdScore >= 33) dashScore = 35; // 2 bullish
  else dashScore = 15;                    // 0-1 bullish — bearish
  evals.push({ name: 'td_consensus', score: dashScore, active: tdScore >= 50, weight: adaptWeight('td_consensus', 10) });

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
    let compositeScore = totalWeight > 0
      ? evals.reduce((sum, e) => sum + e.score * e.weight, 0) / totalWeight
      : 0;

    // Regime bonus: reward trend alignment (we only trade UP/STRONG_UP/SIDEWAYS)
    if (regime.regime === 'STRONG_UP') compositeScore += 8;
    else if (regime.regime === 'UP') compositeScore += 5;

    compositeScore = Math.min(compositeScore, 100);

    // BB overbought filter: proportional penalty near upper band.
    // Was flat -12/-6 — now curves up to -30pts at %B=1.0.
    // This prevents buying at the top of Bollinger Bands.
    const pctB = signals.bb_percent_b as number;
    if (pctB > 0.80) {
      // Proportional: 6 + (pctB - 0.80) * 120 → -6 at 0.80, -18 at 0.90, -30 at 1.0
      compositeScore -= Math.round(6 + (pctB - 0.80) * 120);
    }

    const confidence = compositeScore / 100;

    const passed = compositeScore >= V2_CONFIG.MIN_COMPOSITE_SCORE;

    const activeSignals = evals.filter((e) => e.active).map((e) => e.name);
    const bbNote = pctB > 0.80 ? `, BB%B=${pctB.toFixed(2)}(penalty)` : '';
    const reason = passed
      ? `PASS: score=${compositeScore.toFixed(1)}, active=[${activeSignals.join(', ')}]${bbNote}`
      : `REJECT: score=${compositeScore.toFixed(1)} < min ${V2_CONFIG.MIN_COMPOSITE_SCORE}${bbNote}`;

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
