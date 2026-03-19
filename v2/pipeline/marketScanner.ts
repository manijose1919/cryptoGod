// ============================================
// Phoenix V2 Market Scanner
// Filters tickers by volume, volatility, regime
// ============================================

import type { Candle, ScanResult } from './types.ts';
import { REGIME } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import { ema, detectRegime } from '../indicators/indicators.ts';

// --- Helpers ---

function makeReject(ticker: string, reason: string): ScanResult {
  return {
    ticker,
    passed: false,
    regime: REGIME.SIDEWAYS,
    atrPercent: 0,
    volumeUsd24h: 0,
    spreadPercent: 0,
    reason,
  };
}

// --- Scanner ---

/**
 * Scan all tickers and reject any that fail volume, volatility, or regime checks.
 * Returns one ScanResult per ticker (passed or rejected).
 */
export function scanMarket(tickerCandles: Map<string, Candle[]>): ScanResult[] {
  const results: ScanResult[] = [];
  const allowedRegimes: ReadonlySet<string> = new Set(V2_CONFIG.ALLOWED_REGIMES);

  for (const [ticker, candles] of tickerCandles) {
    // Gate 1: minimum candle count
    if (candles.length < V2_CONFIG.MIN_CANDLES) {
      results.push(makeReject(ticker, `Insufficient candles: ${candles.length} < ${V2_CONFIG.MIN_CANDLES}`));
      continue;
    }

    // Compute regime
    const regimeResult = detectRegime(candles);

    // Gate 2: regime filter
    if (!allowedRegimes.has(regimeResult.regime)) {
      results.push({
        ticker,
        passed: false,
        regime: regimeResult.regime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `Regime ${regimeResult.regime} not in allowed: [${V2_CONFIG.ALLOWED_REGIMES.join(', ')}]`,
      });
      continue;
    }

    // Gate 2b: Regime momentum — catch deteriorating SIDEWAYS before it flips to DOWN.
    // If regime is SIDEWAYS but EMA20 is falling, price is likely heading into DOWN.
    if (regimeResult.regime === REGIME.SIDEWAYS) {
      const closes = candles.map((c) => c.close);
      const ema20 = ema(closes, 20);
      const lookback = V2_CONFIG.REGIME_MOMENTUM_LOOKBACK;
      if (ema20.length >= lookback + 1) {
        const recentEma = ema20[ema20.length - 1];
        const pastEma = ema20[ema20.length - 1 - lookback];
        const slope = pastEma !== 0 ? (recentEma - pastEma) / pastEma : 0;
        if (slope < V2_CONFIG.REGIME_MOMENTUM_MIN_SLOPE) {
          results.push({
            ticker,
            passed: false,
            regime: regimeResult.regime,
            atrPercent: regimeResult.atrPercent,
            volumeUsd24h: 0,
            spreadPercent: 0,
            reason: `SIDEWAYS deteriorating: EMA20 slope ${(slope * 100).toFixed(3)}% < ${(V2_CONFIG.REGIME_MOMENTUM_MIN_SLOPE * 100).toFixed(1)}%`,
          });
          continue;
        }
      }
    }

    // Gate 3: ATR percent (volatility floor)
    if (regimeResult.atrPercent < V2_CONFIG.MIN_ATR_PERCENT) {
      results.push({
        ticker,
        passed: false,
        regime: regimeResult.regime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `ATR% ${regimeResult.atrPercent.toFixed(3)} < min ${V2_CONFIG.MIN_ATR_PERCENT}`,
      });
      continue;
    }

    // Gate 3b: ATR percent ceiling (extreme volatility = flash crash / news spike)
    if (V2_CONFIG.MAX_ATR_PERCENT && regimeResult.atrPercent > V2_CONFIG.MAX_ATR_PERCENT) {
      results.push({
        ticker,
        passed: false,
        regime: regimeResult.regime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `ATR% ${regimeResult.atrPercent.toFixed(3)} > max ${V2_CONFIG.MAX_ATR_PERCENT} (extreme volatility)`,
      });
      continue;
    }

    // Gate 4: estimated 24h volume
    const recentCandles = candles.slice(-20);
    const avgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
    const lastPrice = candles[candles.length - 1].close;
    // Scale volume to 24h based on candle interval (1440 minutes / interval minutes)
    const intervalMinutes = V2_CONFIG.CANDLE_INTERVAL === '1m' ? 1
      : V2_CONFIG.CANDLE_INTERVAL === '5m' ? 5
      : V2_CONFIG.CANDLE_INTERVAL === '15m' ? 15
      : V2_CONFIG.CANDLE_INTERVAL === '1h' ? 60
      : V2_CONFIG.CANDLE_INTERVAL === '4h' ? 240 : 1;
    const candlesPerDay = 1440 / intervalMinutes;
    const volumeUsd24h = avgVolume * lastPrice * candlesPerDay;

    if (volumeUsd24h < V2_CONFIG.MIN_VOLUME_24H_USD) {
      results.push({
        ticker,
        passed: false,
        regime: regimeResult.regime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h,
        spreadPercent: 0,
        reason: `24h volume $${volumeUsd24h.toFixed(0)} < min $${V2_CONFIG.MIN_VOLUME_24H_USD}`,
      });
      continue;
    }

    // Spread from last candle
    const lastCandle = candles[candles.length - 1];
    const spreadPercent = lastCandle.close !== 0
      ? ((lastCandle.high - lastCandle.low) / lastCandle.close) * 100
      : 0;

    // All gates passed
    results.push({
      ticker,
      passed: true,
      regime: regimeResult.regime,
      atrPercent: regimeResult.atrPercent,
      volumeUsd24h,
      spreadPercent,
      reason: `PASS: regime=${regimeResult.regime}, ATR%=${regimeResult.atrPercent.toFixed(3)}, vol24h=$${volumeUsd24h.toFixed(0)}`,
    });
  }

  return results;
}

/**
 * Filter scan results to only those that passed.
 */
export function getPassedTickers(results: ScanResult[]): ScanResult[] {
  return results.filter((r) => r.passed);
}
