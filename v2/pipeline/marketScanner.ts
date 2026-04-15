// ============================================
// Phoenix V2 Market Scanner
// Filters tickers by volume, volatility, regime
// With Multi-Timeframe (MTF) pullback rescue
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

// --- HTF Regime Cache (populated by tradeEngine, read by scanner) ---

const _htfRegimeCache = new Map<string, { regime: string; fetchedAt: number }>();

/**
 * Set higher-timeframe regime for a ticker.
 * Called from tradeEngine after fetching 4h candles and running detectRegime().
 */
export function setHTFRegime(ticker: string, regime: string): void {
  _htfRegimeCache.set(ticker, { regime, fetchedAt: Date.now() });
}

/**
 * Get cached higher-timeframe regime for a ticker.
 * Returns null if not cached or expired.
 */
function getHTFRegime(ticker: string): string | null {
  const cached = _htfRegimeCache.get(ticker);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > V2_CONFIG.MTF_REGIME_CACHE_TTL_MS) return null;
  return cached.regime;
}

// --- Scanner ---

/**
 * Scan all tickers and reject any that fail volume, volatility, or regime checks.
 * When MTF is enabled, tickers in DOWN regime on 15m can pass if the 4h regime
 * is UP or STRONG_UP (pullback-in-uptrend pattern).
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

    // Gate 2: regime filter (with MTF pullback rescue)
    let effectiveRegime = regimeResult.regime;
    let isPullback = false;

    if (!allowedRegimes.has(regimeResult.regime)) {
      // Check MTF rescue: 15m is DOWN, 4h might be bullish
      if (
        V2_CONFIG.MTF_ENABLED &&
        (V2_CONFIG.MTF_MAX_15M_REGIME as readonly string[]).includes(regimeResult.regime)
      ) {
        const htfRegime = getHTFRegime(ticker);
        if (htfRegime && (V2_CONFIG.MTF_ALLOWED_HIGHER_REGIMES as readonly string[]).includes(htfRegime)) {
          effectiveRegime = REGIME.PULLBACK_UP;
          isPullback = true;
          // Fall through to remaining gates
        } else {
          // 4h not bullish or not cached — reject
          const htfNote = htfRegime ? `, 4h=${htfRegime}` : ', 4h=unknown';
          results.push({
            ticker,
            passed: false,
            regime: regimeResult.regime,
            atrPercent: regimeResult.atrPercent,
            volumeUsd24h: 0,
            spreadPercent: 0,
            reason: `Regime ${regimeResult.regime} not in allowed: [${V2_CONFIG.ALLOWED_REGIMES.join(', ')}]${htfNote}`,
          });
          continue;
        }
      } else {
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
    }

    // Gate 2a: HTF veto — block trades when 4h regime is bearish, even if 15m says UP
    // This is the symmetric counterpart to the MTF rescue logic.
    // Missing this gate caused DOTUSD entry at 15m=UP while 4h=STRONG_DOWN/DOWN.
    if (V2_CONFIG.MTF_ENABLED && !isPullback) {
      const htfRegime = getHTFRegime(ticker);
      if (htfRegime && (htfRegime === REGIME.DOWN || htfRegime === REGIME.STRONG_DOWN)) {
        results.push({
          ticker,
          passed: false,
          regime: regimeResult.regime,
          atrPercent: regimeResult.atrPercent,
          volumeUsd24h: 0,
          spreadPercent: 0,
          reason: `HTF veto: 15m=${regimeResult.regime} but 4h=${htfRegime} (bearish higher timeframe)`,
        });
        continue;
      }
    }

    // Gate 2b: Regime momentum — catch deteriorating SIDEWAYS before it flips to DOWN.
    // Skip for pullbacks — they're already in DOWN, slope is expected negative.
    if (!isPullback && effectiveRegime === REGIME.SIDEWAYS) {
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
        regime: effectiveRegime,
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
        regime: effectiveRegime,
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
        regime: effectiveRegime,
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
    const pullbackNote = isPullback ? ' (pullback-in-uptrend)' : '';
    results.push({
      ticker,
      passed: true,
      regime: effectiveRegime,
      atrPercent: regimeResult.atrPercent,
      volumeUsd24h,
      spreadPercent,
      reason: `PASS: regime=${effectiveRegime}, ATR%=${regimeResult.atrPercent.toFixed(3)}, vol24h=$${volumeUsd24h.toFixed(0)}${pullbackNote}`,
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
