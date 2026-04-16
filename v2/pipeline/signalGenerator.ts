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
  } catch (err) {
    console.warn('[SignalGenerator] Scorecard verdicts failed — using default weights:', (err as Error).message);
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
  const prevMacdHist = signals.prev_macd_histogram as number ?? macdHist;
  const trendStr = signals.trend_strength as number;
  const volRatio = signals.volume_ratio as number;
  const pctB = signals.bb_percent_b as number;

  const evals: SignalEval[] = [];

  // 1. RSI momentum (weight 15)
  // TREND-following: RSI 45-65 is the sweet spot (healthy uptrend momentum)
  // Not mean-reversion — we don't need oversold, we need momentum
  let rsiScore: number;
  if (rsiVal < 30) rsiScore = 50;        // oversold — could be reversal but risky for trend entry
  else if (rsiVal < 45) rsiScore = 65;   // pullback zone — good for trend re-entry
  else if (rsiVal < 55) rsiScore = 80;   // ideal trend momentum
  else if (rsiVal < 65) rsiScore = 75;   // strong momentum, still healthy
  else if (rsiVal < 75) rsiScore = 50;   // getting extended
  else rsiScore = 15;                     // overbought — avoid
  evals.push({ name: 'rsi_momentum', score: rsiScore, active: rsiVal > 40 && rsiVal < 70, weight: adaptWeight('rsi_momentum', 15) });

  // 2. MACD cross (base weight 20, adapted by scorecard)
  // Fresh cross is best, but sustained positive histogram also valuable in trends
  let macdScore: number;
  if (macdCross) macdScore = 95;                    // fresh bullish cross
  else if (macdHist > 0 && macdHist > prevMacdHist) macdScore = 80;  // rising histogram — accelerating
  else if (macdHist > 0) macdScore = 65;            // positive but decelerating
  else macdScore = 20;
  evals.push({ name: 'macd_cross', score: macdScore, active: macdCross || macdHist > 0, weight: adaptWeight('macd_cross', 20) });

  // 3. Trend strength (base weight 25, adapted by scorecard)
  // This is the most important signal for a TREND strategy — weight it highest
  let trendScore: number;
  if (trendStr > 2) trendScore = 90;
  else if (trendStr > 1) trendScore = 80;
  else if (trendStr > 0.5) trendScore = 70;
  else if (trendStr > 0) trendScore = 50;
  else trendScore = 10;
  evals.push({ name: 'trend_strength', score: trendScore, active: trendStr > 0.3, weight: adaptWeight('trend_strength', 25) });

  // 4. Volume confirmation (base weight 10, adapted by scorecard)
  // Volume confirms moves but shouldn't gate entries — reduced weight
  let volScore: number;
  if (volRatio > 2) volScore = 90;
  else if (volRatio > 1.5) volScore = 80;
  else if (volRatio > 1) volScore = 65;
  else if (volRatio > 0.7) volScore = 50;   // slightly below avg is ok in steady trends
  else volScore = 30;
  evals.push({ name: 'volume_spike', score: volScore, active: volRatio > 0.8, weight: adaptWeight('volume_spike', 10) });

  // 5. Bollinger position (base weight 10, adapted by scorecard)
  // TREND-following: price in upper half of bands is bullish, not bearish
  // Only avoid extremes (>0.95 = overextended)
  let bbScore: number;
  if (pctB < 0.2) bbScore = 55;        // near lower band — potential trend entry on pullback
  else if (pctB < 0.4) bbScore = 65;   // lower half — good pullback entry
  else if (pctB < 0.6) bbScore = 70;   // mid-band — neutral-positive
  else if (pctB < 0.8) bbScore = 65;   // upper half — trending, still ok
  else if (pctB < 0.95) bbScore = 40;  // near upper — getting stretched
  else bbScore = 15;                    // above upper band — overextended
  evals.push({ name: 'bb_lower_touch', score: bbScore, active: pctB < 0.85, weight: adaptWeight('bb_lower_touch', 10) });

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
  // In trends, mid-channel is fine — only heavily penalize entries right at resistance
  const srPos = signals.sr_channel_position as number ?? 0.5;
  let srScore: number;
  if (srPos < 0.15) srScore = 85;      // Right at support — excellent
  else if (srPos < 0.30) srScore = 75; // Near support
  else if (srPos < 0.50) srScore = 65; // Lower half of channel — good
  else if (srPos < 0.70) srScore = 55; // Upper half — acceptable in uptrend
  else if (srPos < 0.85) srScore = 35; // Near resistance — caution
  else srScore = 15;                    // At resistance — worst entry
  evals.push({ name: 'sr_position', score: srScore, active: srPos < 0.70, weight: adaptWeight('sr_position', 10) });

  // 8. Trend Dashboard consensus (base weight 15) — 6-indicator bull/bear vote
  // Bumped weight — strong consensus is a reliable trend confirmation
  const tdScore = signals.td_score as number ?? 50;
  let dashScore: number;
  if (tdScore >= 83) dashScore = 90;    // 5-6 bullish indicators
  else if (tdScore >= 67) dashScore = 80; // 4 bullish — strong
  else if (tdScore >= 50) dashScore = 60; // 3 bullish (neutral-bullish)
  else if (tdScore >= 33) dashScore = 35; // 2 bullish
  else dashScore = 15;                    // 0-1 bullish — bearish
  evals.push({ name: 'td_consensus', score: dashScore, active: tdScore >= 50, weight: adaptWeight('td_consensus', 15) });

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

    // Regime bonus: reward trend alignment
    if (regime.regime === 'STRONG_UP') compositeScore += 8;
    else if (regime.regime === 'UP') compositeScore += 5;
    else if (regime.regime === 'PULLBACK_UP') compositeScore += 3;  // 4h bullish but 15m dipped

    compositeScore = Math.min(compositeScore, 100);

    // MACD gate: only penalize when MACD histogram is fully negative
    // In sustained uptrends, histogram stays positive without fresh crosses — that's fine
    const macdHistPositive = (signals.macd_histogram as number) > 0;
    if (!macdHistPositive) {
      compositeScore -= 8; // Moderate penalty — bearish MACD momentum
    }

    // S/R position gate: only penalize entries very near resistance (>0.85)
    // In uptrends, price naturally sits in upper half of its channel
    const srPos = signals.sr_channel_position as number ?? 0.5;
    if (srPos > 0.85) {
      compositeScore -= Math.round(5 + (srPos - 0.85) * 40); // -5 at 0.85, -11 at 1.0
    }

    // BB overbought filter: only penalize extreme overextension (>0.95)
    // In trends, price riding upper band is normal behavior
    const pctB = signals.bb_percent_b as number;
    if (pctB > 0.95) {
      compositeScore -= Math.round(10 + (pctB - 0.95) * 200); // -10 at 0.95, -20 at 1.0
    }

    // TC sell-zone veto: when TC >= 80, the trend is exhausted (per TC indicator's own design)
    // Data evidence: TC >= 80 had 16.7% WR and -$1.64 avg PnL across all tickers (as of 2026-04-16)
    // Code comment in evaluateSignals() already says "Sell zone — avoid" but weighted avg let it through
    const tcVal = signals.tc_value as number ?? 50;
    const tcVeto = tcVal >= 80;
    if (tcVeto) {
      compositeScore -= 30; // Strong penalty — should push score below threshold
    }

    const confidence = compositeScore / 100;

    const passed = compositeScore >= V2_CONFIG.MIN_COMPOSITE_SCORE;

    const activeSignals = evals.filter((e) => e.active).map((e) => e.name);
    const bbNote = pctB > 0.95 ? `, BB%B=${pctB.toFixed(2)}(penalty)` : '';
    const tcNote = tcVeto ? `, TC=${tcVal.toFixed(1)}(sell-zone)` : '';
    const reason = passed
      ? `PASS: score=${compositeScore.toFixed(1)}, active=[${activeSignals.join(', ')}]${bbNote}${tcNote}`
      : `REJECT: score=${compositeScore.toFixed(1)} < min ${V2_CONFIG.MIN_COMPOSITE_SCORE}${bbNote}${tcNote}`;

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
