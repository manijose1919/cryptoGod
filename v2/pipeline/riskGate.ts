// ============================================
// Phoenix V2 Risk Gate
// Hard kills only — no soft adjustments
// ============================================

import type { SignalResult, RiskResult, V2PortfolioState } from './types.ts';
import { V2_CONFIG } from '../engine/config.ts';

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
    const feeRoundTrip = V2_CONFIG.FEE_ROUND_TRIP_TAKER;

    // Gate 5: Expected return must exceed minimum
    const expectedReturn = tpPercent * signal.confidence - feeRoundTrip;
    if (expectedReturn < V2_CONFIG.MIN_EXPECTED_RETURN) {
      results.push(makeReject(signal, `Expected return ${(expectedReturn * 100).toFixed(2)}% < min ${(V2_CONFIG.MIN_EXPECTED_RETURN * 100).toFixed(1)}%`));
      continue;
    }

    // Position sizing: scale by confidence
    const maxPositionUsd = portfolio.availableCapital * V2_CONFIG.MAX_POSITION_PERCENT;
    const positionSizeUsd = maxPositionUsd * signal.confidence;

    // Gate 6: Minimum order size ($10 Kraken minimum)
    if (positionSizeUsd < 10) {
      results.push(makeReject(signal, `Position size $${positionSizeUsd.toFixed(2)} < $10 minimum`));
      continue;
    }

    // Compute stop loss and take profit prices using actual close price (not EMA which lags)
    const lastPrice = signal.signals.close_price || signal.signals.ema_12;
    const atrValue = signal.signals.atr;
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
      reason: `APPROVED: size=$${positionSizeUsd.toFixed(2)}, SL=${stopLoss.toFixed(2)}, TP=${takeProfit.toFixed(2)}, ER=${(expectedReturn * 100).toFixed(2)}%`,
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
