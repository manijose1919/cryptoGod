import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime } from '../indicators/indicators.ts';
import { MR_CONFIG } from '../engine/config.ts';

export function detectMeanReversionEntry(
  candles: Candle[],
  ticker: string,
): SignalResult | null {
  if (candles.length < MR_CONFIG.MIN_CANDLES) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!MR_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi = signals.rsi as number;
  const pctB = signals.bb_percent_b as number;
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;
  const ema = signals.ema_12 as number; // backtest used ema_12 as mean target

  if (rsi > MR_CONFIG.RSI_THRESHOLD) return null;
  if (pctB > MR_CONFIG.BB_PERCENT_B_THRESHOLD) return null;
  if (atrPct > MR_CONFIG.MAX_ATR_PERCENT) return null;
  if (ema <= price) return null; // mean must be above current price

  const atrDollar = price * atrPct / 100;
  if (atrDollar <= 0) return null;

  const oversoldDepth = (MR_CONFIG.RSI_THRESHOLD - rsi) / MR_CONFIG.RSI_THRESHOLD;
  const confidence = Math.max(0.3, Math.min(0.9,
    0.4 + oversoldDepth * 0.4 + (MR_CONFIG.BB_PERCENT_B_THRESHOLD - pctB) * 2
  ));

  const compositeScore = confidence * 100;

  return {
    ticker,
    passed: true,
    compositeScore,
    confidence,
    signals,
    regime: regimeResult.regime,
    reason: `MR_ENTRY RSI=${rsi.toFixed(0)}, BB%B=${pctB.toFixed(2)}, target=${ema.toFixed(2)}`,
  };
}
