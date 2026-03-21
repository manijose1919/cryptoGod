// ============================================
// Phoenix V2 Risk Gate
// Hard kills + Fear & Greed macro filter
// ============================================

import type { SignalResult, RiskResult, V2PortfolioState } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';

// --- Fear & Greed (lazy-loaded from existing service) ---

let _fgModule: any = null;
let _fgLoaded = false;

async function loadFearGreed(): Promise<void> {
  if (_fgLoaded) return;
  try {
    _fgModule = await import('../../services/fearGreedGate.js');
    _fgLoaded = true;
  } catch {
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
): RiskResult[] {
  const results: RiskResult[] = [];
  const now = Date.now();

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

    // Gate 3: Max open positions
    if (portfolio.openPositions.size >= V2_CONFIG.MAX_OPEN_POSITIONS) {
      results.push(makeReject(signal, `Max positions reached: ${portfolio.openPositions.size} >= ${V2_CONFIG.MAX_OPEN_POSITIONS}`));
      continue;
    }

    // Gate 4: Already holding this ticker
    if (portfolio.openPositions.has(signal.ticker)) {
      results.push(makeReject(signal, `Already holding ${signal.ticker}`));
      continue;
    }

    // Compute position sizing
    const atrPercent = signal.signals.atr_percent;
    const tpPercent = atrPercent * V2_CONFIG.TAKE_PROFIT_ATR_MULT / 100;
    const slPercent = atrPercent * V2_CONFIG.STOP_LOSS_ATR_MULT / 100;
    // Use maker fees when USE_MAKER_ORDERS is on, taker otherwise
    const feeRoundTrip = V2_CONFIG.USE_MAKER_ORDERS
      ? V2_CONFIG.FEE_ROUND_TRIP_MAKER
      : V2_CONFIG.FEE_ROUND_TRIP_TAKER;

    // Gate 5: Expected return must exceed minimum
    // TP% is the raw target move — confidence already scales position size, not ER
    const expectedReturn = tpPercent - feeRoundTrip;
    if (expectedReturn < V2_CONFIG.MIN_EXPECTED_RETURN) {
      results.push(makeReject(signal, `Expected return ${(expectedReturn * 100).toFixed(2)}% < min ${(V2_CONFIG.MIN_EXPECTED_RETURN * 100).toFixed(1)}%`));
      continue;
    }

    // Position sizing: scale by confidence × Fear & Greed multiplier
    const maxPositionUsd = portfolio.availableCapital * V2_CONFIG.MAX_POSITION_PERCENT;
    const positionSizeUsd = maxPositionUsd * signal.confidence * fgMultiplier;

    // Gate 6: Minimum order size ($10 Kraken minimum)
    if (positionSizeUsd < 10) {
      results.push(makeReject(signal, `Position size $${positionSizeUsd.toFixed(2)} < $10 minimum`));
      continue;
    }

    // Compute stop loss and take profit prices using actual close price (not EMA which lags)
    const lastPrice = (signal.signals.close_price || signal.signals.ema_12) as number;
    const atrValue = signal.signals.atr as number;
    const stopLoss = lastPrice - atrValue * V2_CONFIG.STOP_LOSS_ATR_MULT;
    const takeProfit = lastPrice + atrValue * V2_CONFIG.TAKE_PROFIT_ATR_MULT;
    const quantity = lastPrice > 0 ? positionSizeUsd / lastPrice : 0;

    results.push({
      ticker: signal.ticker,
      passed: true,
      positionSizeUsd,
      quantity,
      stopLoss,
      takeProfit,
      expectedReturn,
      reason: `APPROVED: size=$${positionSizeUsd.toFixed(2)}, SL=${stopLoss.toFixed(2)}, TP=${takeProfit.toFixed(2)}, ER=${(expectedReturn * 100).toFixed(2)}%, F&G=${fgMultiplier}x`,
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
