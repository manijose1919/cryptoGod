import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime, adx } from '../indicators/indicators.ts';
import { MR_CONFIG } from '../engine/config.ts';

export interface MRSignalResult extends SignalResult {
  side: 'long' | 'short';
}

export function detectMeanReversionEntry(
  candles: Candle[],
  ticker: string,
): MRSignalResult | null {
  if (candles.length < MR_CONFIG.MIN_CANDLES) return null;

  // Primary gate: ADX must be below threshold (market must be ranging, not trending)
  const adxVal = adx(candles);
  if (adxVal >= MR_CONFIG.ADX_MAX_FOR_ENTRY) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!MR_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi    = signals.rsi as number;
  const pctB   = signals.bb_percent_b as number;
  const atrPct = signals.atr_percent as number;
  const price  = signals.close_price as number;
  const ema    = signals.ema_12 as number;

  if (atrPct > MR_CONFIG.MAX_ATR_PERCENT) return null;

  const atrDollar = price * atrPct / 100;
  if (atrDollar <= 0) return null;

  // --- LONG: oversold, price below lower BB, mean (EMA) above price ---
  if (
    rsi < MR_CONFIG.RSI_LONG_THRESHOLD &&
    pctB < MR_CONFIG.BB_LONG_THRESHOLD &&
    ema > price
  ) {
    const oversoldDepth = (MR_CONFIG.RSI_LONG_THRESHOLD - rsi) / MR_CONFIG.RSI_LONG_THRESHOLD;
    const confidence = Math.max(0.3, Math.min(0.9,
      0.4 + oversoldDepth * 0.4 + (MR_CONFIG.BB_LONG_THRESHOLD - pctB) * 2
    ));
    return {
      ticker,
      passed: true,
      compositeScore: confidence * 100,
      confidence,
      signals: { ...signals, adx: adxVal },
      regime: regimeResult.regime,
      reason: `MR_LONG RSI=${rsi.toFixed(0)} pctB=${pctB.toFixed(2)} ema=${ema.toFixed(2)} adx=${adxVal.toFixed(1)}`,
      side: 'long',
    };
  }

  // --- SHORT: overbought, price above upper BB, mean (EMA) below price ---
  if (
    MR_CONFIG.SHORTS_ENABLED &&
    rsi > MR_CONFIG.RSI_SHORT_THRESHOLD &&
    pctB > MR_CONFIG.BB_SHORT_THRESHOLD &&
    ema < price
  ) {
    const overboughtDepth = (rsi - MR_CONFIG.RSI_SHORT_THRESHOLD) / (100 - MR_CONFIG.RSI_SHORT_THRESHOLD);
    const confidence = Math.max(0.3, Math.min(0.9,
      0.4 + overboughtDepth * 0.4 + (pctB - MR_CONFIG.BB_SHORT_THRESHOLD) * 2
    ));
    return {
      ticker,
      passed: true,
      compositeScore: confidence * 100,
      confidence,
      signals: { ...signals, adx: adxVal },
      regime: regimeResult.regime,
      reason: `MR_SHORT RSI=${rsi.toFixed(0)} pctB=${pctB.toFixed(2)} ema=${ema.toFixed(2)} adx=${adxVal.toFixed(1)}`,
      side: 'short',
    };
  }

  return null;
}
