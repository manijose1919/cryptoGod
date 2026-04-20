import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime, macd } from '../indicators/indicators.ts';

const MOM_CONFIG = {
  ALLOWED_REGIMES: ['STRONG_UP', 'UP', 'SIDEWAYS'],  // Loosened: momentum can start in consolidation
  HISTOGRAM_SPIKE_MULT: 1.2,   // Was 1.5 — produced 0 trades in 180-day backtest
  RSI_MIN: 40,                  // Was 45 — allow slightly earlier momentum entries
  RSI_MAX: 78,                  // Was 75 — don't cut off strong momentum
  VOLUME_MULTIPLIER: 0.8,       // Was 1.0 — don't require above-average volume
  MIN_CANDLES: 50,
};

export function detectMomentumEntry(
  candles: Candle[],
  ticker: string,
): SignalResult | null {
  if (candles.length < MOM_CONFIG.MIN_CANDLES) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!MOM_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi = signals.rsi as number;
  const macdHist = signals.macd_histogram as number;
  const volRatio = signals.volume_ratio as number;
  const atrPct = signals.atr_percent as number;

  if (rsi < MOM_CONFIG.RSI_MIN || rsi > MOM_CONFIG.RSI_MAX) return null;
  if (volRatio < MOM_CONFIG.VOLUME_MULTIPLIER) return null;
  if (macdHist <= 0 || atrPct <= 0) return null;

  // Compute histogram average from recent candles for spike detection
  const closes = candles.map(c => c.close);
  const macdResult = macd(closes, 12, 26, 9);
  const histArr = macdResult.histogram;
  const recentHist = histArr.slice(-11, -1);
  if (recentHist.length < 10) return null;

  const avgAbsHist = recentHist.reduce((s, h) => s + Math.abs(h), 0) / recentHist.length;
  if (avgAbsHist <= 0) return null;

  const spikeRatio = Math.abs(macdHist) / avgAbsHist;
  if (spikeRatio < MOM_CONFIG.HISTOGRAM_SPIKE_MULT) return null;

  const confidence = Math.max(0.4, Math.min(0.9,
    0.5 + (spikeRatio - 1.5) * 0.1 + (volRatio - 1) * 0.1
  ));

  return {
    ticker,
    passed: true,
    compositeScore: confidence * 100,
    confidence,
    signals,
    regime: regimeResult.regime,
    reason: `MOMENTUM spike=${spikeRatio.toFixed(1)}x, RSI=${rsi.toFixed(0)}, vol=${volRatio.toFixed(1)}x`,
  };
}
