import type { Candle, SignalSnapshot } from '../../pipeline/types.ts';
import type { RegimeResult } from '../../indicators/indicators.ts';
import type { StrategyConfig, EntrySignal } from './types.ts';
import { evaluateSignals } from '../../pipeline/signalGenerator.ts';

const NO_ENTRY: EntrySignal = {
  shouldEnter: false, confidence: 0, entryPrice: 0,
  stopLoss: 0, takeProfit: 0, reason: '', metadata: {},
};

function atrDollar(signals: SignalSnapshot): number {
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;
  return atrPct > 0 && price > 0 ? price * atrPct / 100 : 0;
}

export function detectEntry(
  strategy: StrategyConfig,
  candles: Candle[],
  signals: SignalSnapshot,
  regime: RegimeResult,
): EntrySignal {
  if (!strategy.allowedRegimes.includes(regime.regime)) return NO_ENTRY;

  switch (strategy.name) {
    case 'TREND': return detectTrend(strategy, candles, signals, regime);
    case 'BREAKOUT': return detectBreakout(strategy, candles, signals, regime);
    case 'MEAN_REVERSION': return detectMeanReversion(strategy, candles, signals, regime);
    case 'MOMENTUM': return detectMomentum(strategy, candles, signals, regime);
    case 'SCALP': return detectScalp(strategy, candles, signals, regime);
    default: return NO_ENTRY;
  }
}

function detectTrend(
  config: StrategyConfig,
  _candles: Candle[],
  signals: SignalSnapshot,
  regime: RegimeResult,
): EntrySignal {
  const evals = evaluateSignals(signals as Record<string, number | boolean | string>);
  const totalWeight = evals.reduce((s, e) => s + e.weight, 0);
  let score = totalWeight > 0
    ? evals.reduce((s, e) => s + e.score * e.weight, 0) / totalWeight
    : 0;

  if (regime.regime === 'STRONG_UP') score += 8;
  else if (regime.regime === 'UP') score += 5;
  score = Math.min(score, 100);

  const macdHist = signals.macd_histogram as number;
  if (macdHist <= 0) score -= 8;

  const srPos = signals.sr_channel_position as number ?? 0.5;
  if (srPos > 0.85) score -= Math.round(5 + (srPos - 0.85) * 40);

  const pctB = signals.bb_percent_b as number;
  if (pctB > 0.95) score -= Math.round(10 + (pctB - 0.95) * 200);

  if (score < config.entryParams.minCompositeScore) return NO_ENTRY;

  const price = signals.close_price as number;
  const atr = atrDollar(signals);
  if (atr <= 0) return NO_ENTRY;

  const confidence = score / 100;
  return {
    shouldEnter: true,
    confidence,
    entryPrice: price,
    stopLoss: price - atr * config.exitParams.stopLossValue,
    takeProfit: price + atr * config.exitParams.takeProfitValue,
    reason: `TREND score=${score.toFixed(1)}`,
    metadata: { compositeScore: score },
  };
}

function detectBreakout(
  config: StrategyConfig,
  candles: Candle[],
  signals: SignalSnapshot,
  _regime: RegimeResult,
): EntrySignal {
  const lookback = config.entryParams.lookbackBars;
  if (candles.length < lookback + 1) return NO_ENTRY;

  const price = signals.close_price as number;
  const atr = atrDollar(signals);
  const atrPct = signals.atr_percent as number;
  const volRatio = signals.volume_ratio as number;

  if (atr <= 0 || atrPct < config.entryParams.minAtrPercent) return NO_ENTRY;
  if (volRatio < config.entryParams.volumeMultiplier) return NO_ENTRY;

  const lookbackCandles = candles.slice(-lookback - 1, -1);
  const nBarHigh = Math.max(...lookbackCandles.map(c => c.high));

  if (price <= nBarHigh) return NO_ENTRY;

  const breakoutStrength = (price - nBarHigh) / atr;
  const confidence = Math.min(0.9, 0.5 + breakoutStrength * 0.15 + (volRatio - 1) * 0.1);

  return {
    shouldEnter: true,
    confidence,
    entryPrice: price,
    stopLoss: nBarHigh - atr * 0.5,
    takeProfit: price + atr * config.exitParams.takeProfitValue,
    reason: `BREAKOUT ${lookback}-bar high=${nBarHigh.toFixed(2)}, vol=${volRatio.toFixed(1)}x`,
    metadata: { breakoutLevel: nBarHigh, breakoutStrength, nBarHigh },
  };
}

function detectMeanReversion(
  config: StrategyConfig,
  _candles: Candle[],
  signals: SignalSnapshot,
  _regime: RegimeResult,
): EntrySignal {
  const rsi = signals.rsi as number;
  const pctB = signals.bb_percent_b as number;
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;
  const atr = atrDollar(signals);
  const ema20 = signals.ema_12 as number;

  if (rsi > config.entryParams.rsiThreshold) return NO_ENTRY;
  if (pctB > config.entryParams.bbPercentBThreshold) return NO_ENTRY;
  if (atrPct > config.entryParams.maxAtrPercent) return NO_ENTRY;
  if (atr <= 0 || ema20 <= price) return NO_ENTRY;

  const oversoldDepth = (config.entryParams.rsiThreshold - rsi) / config.entryParams.rsiThreshold;
  const confidence = Math.min(0.9, 0.4 + oversoldDepth * 0.4 + (0.15 - pctB) * 2);

  return {
    shouldEnter: true,
    confidence: Math.max(0.3, confidence),
    entryPrice: price,
    stopLoss: price - atr * config.exitParams.stopLossValue,
    takeProfit: ema20,
    reason: `MEAN_REV RSI=${rsi.toFixed(0)}, BB%B=${pctB.toFixed(2)}, target=${ema20.toFixed(2)}`,
    metadata: { meanTarget: ema20, rsiAtEntry: rsi, bbAtEntry: pctB },
  };
}

function detectMomentum(
  config: StrategyConfig,
  candles: Candle[],
  signals: SignalSnapshot,
  _regime: RegimeResult,
): EntrySignal {
  const rsi = signals.rsi as number;
  const macdHist = signals.macd_histogram as number;
  const volRatio = signals.volume_ratio as number;
  const price = signals.close_price as number;
  const atr = atrDollar(signals);

  if (rsi < config.entryParams.rsiMin || rsi > config.entryParams.rsiMax) return NO_ENTRY;
  if (volRatio < config.entryParams.volumeMultiplier) return NO_ENTRY;
  if (macdHist <= 0 || atr <= 0) return NO_ENTRY;

  const closes = candles.slice(-11).map(c => c.close);
  if (closes.length < 11) return NO_ENTRY;

  // Need MACD histograms for last 10 bars to compute avg
  // Approximate: use macd_histogram as current, estimate avg from price momentum
  const recentMoves = [];
  for (let i = 1; i < closes.length; i++) {
    recentMoves.push(closes[i] - closes[i - 1]);
  }
  const avgAbsMove = recentMoves.reduce((s, m) => s + Math.abs(m), 0) / recentMoves.length;
  const currentMove = Math.abs(macdHist);

  if (avgAbsMove <= 0) return NO_ENTRY;
  const spikeRatio = currentMove / avgAbsMove;
  if (spikeRatio < config.entryParams.histogramSpikeMultiplier) return NO_ENTRY;

  const confidence = Math.min(0.9, 0.5 + (spikeRatio - 2) * 0.1 + (volRatio - 1) * 0.1);

  return {
    shouldEnter: true,
    confidence: Math.max(0.4, confidence),
    entryPrice: price,
    stopLoss: price - atr * config.exitParams.stopLossValue,
    takeProfit: 0,
    reason: `MOMENTUM spike=${spikeRatio.toFixed(1)}x, RSI=${rsi.toFixed(0)}, vol=${volRatio.toFixed(1)}x`,
    metadata: { peakHistogram: macdHist, spikeRatio },
  };
}

function detectScalp(
  config: StrategyConfig,
  _candles: Candle[],
  signals: SignalSnapshot,
  _regime: RegimeResult,
): EntrySignal {
  const rsi = signals.rsi as number;
  const volRatio = signals.volume_ratio as number;
  const price = signals.close_price as number;
  const atr = atrDollar(signals);

  if (rsi < config.entryParams.rsiPullbackMin || rsi > config.entryParams.rsiPullbackMax) return NO_ENTRY;
  if (volRatio < config.entryParams.minVolumeRatio) return NO_ENTRY;
  if (atr <= 0) return NO_ENTRY;

  const pullbackDepth = Math.abs(rsi - 42.5) / 12.5;
  const confidence = Math.min(0.8, 0.5 + (1 - pullbackDepth) * 0.2 + (volRatio - 0.8) * 0.15);

  return {
    shouldEnter: true,
    confidence: Math.max(0.3, confidence),
    entryPrice: price,
    stopLoss: price - atr * config.exitParams.stopLossValue,
    takeProfit: price + atr * config.exitParams.takeProfitValue,
    reason: `SCALP RSI=${rsi.toFixed(0)}, pullback entry`,
    metadata: {},
  };
}
