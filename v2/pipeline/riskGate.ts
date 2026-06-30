// ============================================
// Phoenix V2 Risk Gate
// Hard kills + Fear & Greed macro filter
// ============================================

import type { SignalResult, RiskResult, V2PortfolioState } from './types.ts';
import { REGIME } from './types.ts';
import type { Candle } from './types.ts';
import { V2_CONFIG, STRATEGY_EXIT_CONFIGS, getExchangeFees } from '../engine/config.ts';
import { getRecentClosedByTicker } from '../attribution/attributionStore.ts';
import { closesToReturns, pearsonCorrelation } from '../indicators/indicators.ts';

// --- Fear & Greed (lazy-loaded from existing service) ---

let _fgModule: any = null;
let _fgLoaded = false;

async function loadFearGreed(): Promise<void> {
  if (_fgLoaded) return;
  try {
    _fgModule = await import('../../services/fearGreedGate.js');
    _fgLoaded = true;
  } catch (err) {
    console.warn('[RiskGate] Fear & Greed module failed to load — using defaults (1.0x, no blocking):', (err as Error).message);
    _fgLoaded = true; // Don't retry
  }
}

// Pre-load on module init (non-blocking)
loadFearGreed();

/** Get F&G position multiplier (1.0 if unavailable) */
export function getFearGreedMultiplier(): number {
  if (!_fgModule) return 1.0;
  return _fgModule.getPositionMultiplier?.() ?? 1.0;
}

/** Check if F&G blocks entry */
export function getFearGreedBlock(): { block: boolean; reason: string } {
  if (!_fgModule) return { block: false, reason: '' };
  return _fgModule.shouldBlockEntry?.() ?? { block: false, reason: '' };
}

// --- Types ---

export interface CircuitBreakerState {
  dailyPnlPercent: number;
  lastLossTime: number;
}

// --- Helpers ---

function makeReject(signal: SignalResult, reason: string): RiskResult {
  return {
    ticker: signal.ticker,
    passed: false,
    positionSizeUsd: 0,
    quantity: 0,
    stopLoss: 0,
    takeProfit: 0,
    expectedReturn: 0,
    reason,
  };
}

// --- Risk Evaluation ---

/**
 * Evaluate each signal against hard risk gates.
 * Rejects on: daily loss, circuit breaker cooldown, max positions,
 * duplicate ticker, insufficient expected return, minimum order size.
 */
export function evaluateRisk(
  signalResults: SignalResult[],
  portfolio: V2PortfolioState,
  circuitBreaker: CircuitBreakerState,
  exchangeName: string = 'kraken',
  tickerCandles?: Map<string, Candle[]>,
): RiskResult[] {
  const results: RiskResult[] = [];
  const now = Date.now();
  const fees = getExchangeFees(exchangeName);
  const tickersApprovedThisBatch = new Set<string>(); // Prevent same ticker approved twice in one loop

  // Gate 0 (global): Fear & Greed extreme greed block
  const fgBlock = getFearGreedBlock();
  if (fgBlock.block) {
    for (const signal of signalResults) {
      if (signal.passed) results.push(makeReject(signal, `F&G blocked: ${fgBlock.reason}`));
    }
    return results;
  }
  const fgMultiplier = getFearGreedMultiplier();

  for (const signal of signalResults) {
    if (!signal.passed) continue;

    // Gate 1: Daily loss limit
    if (circuitBreaker.dailyPnlPercent < -V2_CONFIG.MAX_DAILY_LOSS_PERCENT * 100) {
      results.push(makeReject(signal, `Daily loss ${circuitBreaker.dailyPnlPercent.toFixed(2)}% exceeds max ${(V2_CONFIG.MAX_DAILY_LOSS_PERCENT * 100).toFixed(1)}%`));
      continue;
    }

    // Gate 2: Circuit breaker cooldown
    const timeSinceLastLoss = now - circuitBreaker.lastLossTime;
    if (circuitBreaker.lastLossTime > 0 && timeSinceLastLoss < V2_CONFIG.CIRCUIT_BREAKER_COOLDOWN_MS) {
      const remainingMs = V2_CONFIG.CIRCUIT_BREAKER_COOLDOWN_MS - timeSinceLastLoss;
      const remainingSec = Math.ceil(remainingMs / 1000);
      results.push(makeReject(signal, `Circuit breaker cooldown: ${remainingSec}s remaining`));
      continue;
    }

    // Gate 2.5: Re-entry cooldown per ticker
    if (V2_CONFIG.REENTRY_COOLDOWN_MS > 0) {
      const recentClosed = getRecentClosedByTicker(signal.ticker, 'TREND', Date.now() - V2_CONFIG.REENTRY_COOLDOWN_MS);
      if (recentClosed.length > 0) {
        const lastExit = recentClosed[0].exitTime!;
        const remainingMs = V2_CONFIG.REENTRY_COOLDOWN_MS - (Date.now() - lastExit);
        results.push(makeReject(signal, `Re-entry cooldown: ${signal.ticker} closed ${Math.ceil(remainingMs / 60000)}m ago`));
        continue;
      }
    }

    // Gate 3: Max open positions per strategy (correlation risk cap)
    if (portfolio.openPositions.size >= V2_CONFIG.MAX_OPEN_POSITIONS) {
      results.push(makeReject(signal, `Max positions reached: ${portfolio.openPositions.size} >= ${V2_CONFIG.MAX_OPEN_POSITIONS}`));
      continue;
    }

    // Gate 4: Already holding this ticker or already approved this loop
    if (portfolio.openPositions.has(signal.ticker) || tickersApprovedThisBatch.has(signal.ticker)) {
      results.push(makeReject(signal, `Already holding or approved ${signal.ticker}`));
      continue;
    }

    // Gate 4.5: Portfolio correlation check
    if (tickerCandles && portfolio.openPositions.size >= 1) {
      const lookback = V2_CONFIG.CORRELATION_LOOKBACK_BARS + 1;
      const candidateCandles = tickerCandles.get(signal.ticker);
      if (candidateCandles && candidateCandles.length >= lookback) {
        const candidateReturns = closesToReturns(
          candidateCandles.slice(-lookback).map(c => c.close)
        );
        let totalCorr = 0;
        let corrCount = 0;
        for (const [openTicker] of portfolio.openPositions) {
          const openCandles = tickerCandles.get(openTicker);
          if (!openCandles || openCandles.length < lookback) continue;
          const openReturns = closesToReturns(
            openCandles.slice(-lookback).map(c => c.close)
          );
          const corr = pearsonCorrelation(candidateReturns, openReturns);
          totalCorr += corr;
          corrCount++;
        }
        if (corrCount > 0) {
          const avgCorr = totalCorr / corrCount;
          if (avgCorr > V2_CONFIG.CORRELATION_MAX_AVG) {
            results.push(makeReject(signal, `Correlated: avg rho=${avgCorr.toFixed(2)} > ${V2_CONFIG.CORRELATION_MAX_AVG} vs ${corrCount} open`));
            continue;
          }
        }
      }
    }

    // Compute position sizing
    const atrPercent = signal.signals.atr_percent as number;
    if (!atrPercent || !isFinite(atrPercent)) {
      results.push(makeReject(signal, `ATR% missing or invalid (${atrPercent})`));
      continue;
    }
    const isShort = signal.side === 'short';
    // Per-strategy SL/TP — must match what the executor will actually set.
    // Using TREND's 4.0× TP here overstated expected return ~33% for
    // MOMENTUM/BREAKOUT (3.0× TP), letting marginal entries past the fee floor.
    const strategy = (signal as any)._strategy ?? 'TREND';
    const exitCfg = STRATEGY_EXIT_CONFIGS[strategy] ?? STRATEGY_EXIT_CONFIGS.TREND;
    const slMult = isShort ? V2_CONFIG.SHORT_STOP_LOSS_ATR_MULT : exitCfg.slAtrMult;
    const tpMult = isShort ? V2_CONFIG.SHORT_TAKE_PROFIT_ATR_MULT : exitCfg.tpAtrMult;
    const tpPercent = atrPercent * tpMult / 100;
    const slPercent = atrPercent * slMult / 100;
    // Shorts use taker fees both sides on Kraken
    const feeRoundTrip = isShort
      ? V2_CONFIG.SHORT_FEE_ROUND_TRIP ?? fees.ROUND_TRIP_TAKER
      : (V2_CONFIG.USE_MAKER_ORDERS ? fees.ROUND_TRIP_REAL : fees.ROUND_TRIP_TAKER);

    // Gate 5: Expected return must exceed minimum
    // TP% is the raw target move — confidence already scales position size, not ER
    const expectedReturn = tpPercent - feeRoundTrip;
    if (expectedReturn < V2_CONFIG.MIN_EXPECTED_RETURN) {
      results.push(makeReject(signal, `Expected return ${(expectedReturn * 100).toFixed(2)}% < min ${(V2_CONFIG.MIN_EXPECTED_RETURN * 100).toFixed(1)}%`));
      continue;
    }

    // Compute stop loss and take profit prices first — needed for risk-based sizing
    const lastPrice = (signal.signals.close_price || signal.signals.ema_12) as number;
    const atrValue = signal.signals.atr as number;
    // Defensive: guard against missing/invalid pricing data — produces NaN stops
    // that would never fire and leave trades open indefinitely.
    if (!isFinite(lastPrice) || lastPrice <= 0 || !isFinite(atrValue) || atrValue <= 0) {
      results.push(makeReject(signal, `Invalid pricing data: lastPrice=${lastPrice}, atr=${atrValue}`));
      continue;
    }
    const stopLoss = isShort
      ? lastPrice + atrValue * slMult   // stop above entry for shorts
      : lastPrice - atrValue * slMult;
    const takeProfit = isShort
      ? lastPrice - atrValue * tpMult   // TP below entry for shorts
      : lastPrice + atrValue * tpMult;
    const stopDistPercent = Math.abs(lastPrice - stopLoss) / lastPrice;

    // Position sizing: scale by confidence × Fear & Greed multiplier × pullback multiplier
    const maxPositionUsd = portfolio.availableCapital * V2_CONFIG.BASE_POSITION_PERCENT;
    const pullbackMult = signal.regime === REGIME.PULLBACK_UP
      ? V2_CONFIG.MTF_POSITION_MULTIPLIER
      : 1.0;
    let positionSizeUsd = maxPositionUsd * signal.confidence * fgMultiplier * pullbackMult;

    // Risk-based cap: limit position so max loss (entry→stop) ≤ MAX_RISK_PER_TRADE of equity.
    // High-ATR assets (e.g. AKT 5% ATR → 10% stop) get smaller positions; low-ATR assets unaffected.
    // The % cap is a ceiling that floated as high as $38 on volatile names; the absolute
    // MAX_RISK_PER_TRADE_USD hard-caps the dollar tail (backtest: worst loss -$40→-$15).
    const maxRiskUsd = Math.min(
      portfolio.totalEquity * V2_CONFIG.MAX_RISK_PER_TRADE_PERCENT,
      V2_CONFIG.MAX_RISK_PER_TRADE_USD,
    );
    const riskCapSizeUsd = stopDistPercent > 0 ? maxRiskUsd / stopDistPercent : positionSizeUsd;
    const riskCapped = positionSizeUsd > riskCapSizeUsd;
    if (riskCapped) {
      positionSizeUsd = riskCapSizeUsd;
    }

    // Gate 6: Position size validity + minimum order size ($10 Kraken minimum)
    // isFinite catches NaN from any upstream undefined/0 multiplier — `NaN < 10` is
    // false so a bare `< 10` check would let NaN-sized orders through.
    if (!isFinite(positionSizeUsd) || positionSizeUsd < 10) {
      results.push(makeReject(signal, `Position size invalid or below minimum: $${positionSizeUsd}`));
      continue;
    }

    const quantity = positionSizeUsd / lastPrice;

    const pullbackNote = signal.regime === REGIME.PULLBACK_UP ? `, pullback=${pullbackMult}x` : '';
    const riskNote = riskCapped ? `, RISK-CAPPED from $${riskCapSizeUsd.toFixed(0)} (stop=${(stopDistPercent * 100).toFixed(1)}%)` : '';
    tickersApprovedThisBatch.add(signal.ticker);
    const sideNote = isShort ? ' [SHORT]' : '';
    results.push({
      ticker: signal.ticker,
      passed: true,
      positionSizeUsd,
      quantity,
      stopLoss,
      takeProfit,
      expectedReturn,
      side: signal.side,
      reason: `APPROVED${sideNote}: size=$${positionSizeUsd.toFixed(2)}, SL=${stopLoss.toFixed(2)}, TP=${takeProfit.toFixed(2)}, ER=${(expectedReturn * 100).toFixed(2)}%, F&G=${fgMultiplier}x${pullbackNote}${riskNote}`,
    });
  }

  return results;
}

/**
 * Filter risk results to only those approved.
 */
export function getApproved(results: RiskResult[]): RiskResult[] {
  return results.filter((r) => r.passed);
}
