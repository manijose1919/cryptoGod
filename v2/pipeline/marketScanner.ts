// ============================================
// Phoenix V2 Market Scanner
// Filters tickers by volume, volatility, regime
// ============================================

import type { Candle, ScanResult, Regime } from './types.ts';
import { REGIME } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import { atr, detectRegime } from '../indicators/indicators.ts';

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

    // Gate 4: estimated 24h volume
    const recentCandles = candles.slice(-20);
    const avgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
    const lastPrice = candles[candles.length - 1].close;
    // 1440 minutes in a day — assumes 1-minute candles equivalent scaling
    const volumeUsd24h = avgVolume * lastPrice * 1440;

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
