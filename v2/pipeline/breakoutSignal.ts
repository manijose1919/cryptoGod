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

  // Lookback: find the N-bar high EXCLUDING current and prior bar
  // We need the current bar to be the FIRST close above the level — if the
  // prior bar also closed above, this isn't a fresh breakout, it's continuation.
  const lookbackCandles = candles.slice(-BREAKOUT_CONFIG.LOOKBACK_BARS - 2, -2);
  const nBarHigh = Math.max(...lookbackCandles.map(c => c.high));
  const priorBar = candles[candles.length - 2];

  // Current bar must close above N-bar high
  if (price <= nBarHigh) return null;
  // Prior bar must NOT have closed above — ensures this is a fresh breakout, not continuation
  if (priorBar && priorBar.close > nBarHigh) return null;

  const atrDollar = price * atrPct / 100;
  const breakoutStrength = (price - nBarHigh) / atrDollar;
  // Cap confidence lower — breakouts are inherently uncertain
  const confidence = Math.min(0.80, 0.5 + breakoutStrength * 0.10 + (volRatio - 1) * 0.05);

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
