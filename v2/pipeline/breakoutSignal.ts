import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime } from '../indicators/indicators.ts';

const BREAKOUT_CONFIG = {
  ALLOWED_REGIMES: ['STRONG_UP', 'UP', 'SIDEWAYS'],
  LOOKBACK_BARS: 30,
  VOLUME_MULTIPLIER: 2.0,
  MIN_ATR_PERCENT: 0.3,
  MIN_CANDLES: 50,
};

export function detectBreakoutEntry(
  candles: Candle[],
  ticker: string,
): SignalResult | null {
  if (candles.length < Math.max(BREAKOUT_CONFIG.MIN_CANDLES, BREAKOUT_CONFIG.LOOKBACK_BARS + 1)) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!BREAKOUT_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const price = signals.close_price as number;
  const atrPct = signals.atr_percent as number;
  const volRatio = signals.volume_ratio as number;

  if (atrPct < BREAKOUT_CONFIG.MIN_ATR_PERCENT) return null;
  if (volRatio < BREAKOUT_CONFIG.VOLUME_MULTIPLIER) return null;

  const lookbackCandles = candles.slice(-BREAKOUT_CONFIG.LOOKBACK_BARS - 1, -1);
  const nBarHigh = Math.max(...lookbackCandles.map(c => c.high));

  if (price <= nBarHigh) return null;

  const atrDollar = price * atrPct / 100;
  const breakoutStrength = (price - nBarHigh) / atrDollar;
  const confidence = Math.min(0.9, 0.5 + breakoutStrength * 0.15 + (volRatio - 1) * 0.1);

  return {
    ticker,
    passed: true,
    compositeScore: confidence * 100,
    confidence: Math.max(0.3, confidence),
    signals,
    regime: regimeResult.regime,
    reason: `BREAKOUT ${BREAKOUT_CONFIG.LOOKBACK_BARS}-bar high=${nBarHigh.toFixed(2)}, vol=${volRatio.toFixed(1)}x`,
  };
}
