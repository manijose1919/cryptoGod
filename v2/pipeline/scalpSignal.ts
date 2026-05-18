// ============================================
// SCALP Signal Detector — 1m/5m RSI pullback entries
// Short-hold, tight SL/TP, high frequency
// ============================================

import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime } from '../indicators/indicators.ts';
import { checkTimeGate } from './timeGate.ts';

const SCALP_CONFIG = {
  ALLOWED_REGIMES: ['STRONG_UP', 'UP', 'SIDEWAYS'],
  RSI_MIN: 35,
  RSI_MAX: 50,
  VOLUME_MIN: 0.8,
  MIN_CANDLES: 50,
  CONFIDENCE: 0.55, // fixed — scalp doesn't vary much
};

export function detectScalpEntry(
  candles: Candle[],
  ticker: string,
): SignalResult | null {
  if (candles.length < SCALP_CONFIG.MIN_CANDLES) return null;

  const lastCandleTime = candles[candles.length - 1]?.time;
  const tg = checkTimeGate(lastCandleTime);
  if (!tg.allow) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!SCALP_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi = signals.rsi as number;
  const volRatio = signals.volume_ratio as number;
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;

  if (rsi < SCALP_CONFIG.RSI_MIN || rsi > SCALP_CONFIG.RSI_MAX) return null;
  if (volRatio < SCALP_CONFIG.VOLUME_MIN) return null;
  if (atrPct <= 0 || price <= 0) return null;

  // Slight confidence variation based on RSI depth and volume
  const rsiBonus = Math.min(0.10, (SCALP_CONFIG.RSI_MAX - rsi) / 100);
  const volBonus = Math.min(0.10, (volRatio - SCALP_CONFIG.VOLUME_MIN) * 0.1);
  const confidence = Math.max(0.4, Math.min(0.75,
    SCALP_CONFIG.CONFIDENCE + rsiBonus + volBonus
  ));

  return {
    ticker,
    passed: true,
    compositeScore: confidence * 100,
    confidence,
    signals,
    regime: regimeResult.regime,
    reason: `SCALP RSI=${rsi.toFixed(0)}, vol=${volRatio.toFixed(1)}x`,
  };
}
