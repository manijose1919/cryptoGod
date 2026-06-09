// ============================================
// Multi-Strategy Runner
// Runs all enabled strategies on their optimal timeframes
// Collects and ranks all signals for the risk gate
// ============================================

import type { Candle, SignalResult } from '../pipeline/types.ts';
import { V2_CONFIG, MOMENTUM_CONFIG, STRATEGY_TIMEFRAMES } from './config.ts';
import { generateSignals, generateShortSignals, getPassedSignals } from '../pipeline/signalGenerator.ts';
import { detectMomentumEntry } from '../pipeline/momentumSignal.ts';
import { detectBreakoutEntry } from '../pipeline/breakoutSignal.ts';
import { detectMeanReversionEntry } from '../pipeline/meanReversionSignal.ts';
import { detectScalpEntry } from '../pipeline/scalpSignal.ts';
import { scanMarket, getPassedTickers } from '../pipeline/marketScanner.ts';

export interface StrategySignal extends SignalResult {
  _strategy: string;
  _timeframe: string;
}

/**
 * Run all enabled strategies across their optimal timeframes.
 * Returns all passing signals sorted by confidence (best first).
 */
export function runAllStrategies(
  allCandles: Map<string, Map<string, Candle[]>>,
  tickers: string[],
): StrategySignal[] {
  const results: StrategySignal[] = [];

  for (const tf of getUniqueTfs()) {
    // Build ticker→candles map for this timeframe
    const tfCandles = new Map<string, Candle[]>();
    for (const ticker of tickers) {
      const tickerTfs = allCandles.get(ticker);
      if (tickerTfs) {
        const candles = tickerTfs.get(tf);
        if (candles && candles.length >= V2_CONFIG.MIN_CANDLES) {
          tfCandles.set(ticker, candles);
        }
      }
    }

    if (tfCandles.size === 0) continue;

    // Run market scanner for this timeframe
    const scanResults = scanMarket(tfCandles);
    const passedScan = getPassedTickers(scanResults);

    // Strategy lookups are null-safe (?.) — disabling a strategy by removing
    // its STRATEGY_TIMEFRAMES key is the documented kill switch and must not
    // crash the loop (2026-06-09: BREAKOUT removal did exactly that).
    // --- TREND (1h, 4h) ---
    if (STRATEGY_TIMEFRAMES.TREND?.includes(tf) && passedScan.length > 0) {
      const trendSignals = generateSignals(passedScan, tfCandles);
      for (const sig of getPassedSignals(trendSignals)) {
        results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
      }
    }

    // --- MOMENTUM (1h, 4h) ---
    if (MOMENTUM_CONFIG.ENABLED && STRATEGY_TIMEFRAMES.MOMENTUM?.includes(tf)) {
      for (const scan of passedScan) {
        // Skip if TREND already produced a signal for this ticker+timeframe
        if (results.some(r => r.ticker === scan.ticker && r._timeframe === tf && r._strategy === 'TREND')) continue;
        const candles = tfCandles.get(scan.ticker);
        if (!candles) continue;
        const momSignal = detectMomentumEntry(candles, scan.ticker);
        if (momSignal && momSignal.confidence >= MOMENTUM_CONFIG.MIN_CONFIDENCE) {
          results.push({ ...momSignal, _strategy: 'MOMENTUM', _timeframe: tf });
        }
      }
    }

    // --- BREAKOUT (15m, 1h) ---
    if (STRATEGY_TIMEFRAMES.BREAKOUT?.includes(tf)) {
      for (const [ticker, candles] of tfCandles) {
        // Breakout has its own regime check internally
        const boSignal = detectBreakoutEntry(candles, ticker);
        if (boSignal && boSignal.confidence >= 0.70) {
          results.push({ ...boSignal, _strategy: 'BREAKOUT', _timeframe: tf });
        }
      }
    }

    // --- MEAN_REVERSION — DISABLED (live: 0% WR, 0/4 wins, -$13) ---
    // --- SCALP — DISABLED (live: 22% WR, 4/18 wins, -$24) ---
    // Both strategies lose money in live execution despite backtest promise.
    // Re-enable only after fundamental rework of entry logic.

    // --- SHORTS (any TF where TREND runs) ---
    if (V2_CONFIG.SHORTS_ENABLED && V2_CONFIG.MODE !== 'live' && STRATEGY_TIMEFRAMES.TREND?.includes(tf)) {
      const shortScanResults = scanMarket(tfCandles, 'short');
      const passedShortScan = getPassedTickers(shortScanResults);
      if (passedShortScan.length > 0) {
        const shortSignals = generateShortSignals(passedShortScan, tfCandles);
        for (const sig of getPassedSignals(shortSignals)) {
          results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
        }
      }
    }
  }

  // Sort by confidence descending — best signal first
  results.sort((a, b) => b.confidence - a.confidence);

  // Deduplicate: keep only the best signal per ticker.
  // Multiple strategies/timeframes can fire on the same ticker —
  // without dedup, we'd open multiple positions on the same asset.
  const seen = new Set<string>();
  const deduped: StrategySignal[] = [];
  for (const sig of results) {
    const key = `${sig.ticker}:${sig.side ?? 'long'}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(sig);
    }
  }
  return deduped;
}

function getUniqueTfs(): string[] {
  const tfs = new Set<string>();
  for (const tfList of Object.values(STRATEGY_TIMEFRAMES)) {
    for (const tf of tfList) tfs.add(tf);
  }
  return Array.from(tfs);
}
