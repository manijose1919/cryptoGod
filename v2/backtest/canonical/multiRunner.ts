// Multi-position runner. Supports N parallel positions per (strategy × ticker).
// Used primarily by GRID, where the strategy's whole economics depend on
// running multiple simultaneous limit orders. Other strategies can use this
// too via the sweep wiring.
//
// Differences from single-position runner.ts:
//   - openTrades: OpenTrade[] (was OpenTrade | null)
//   - Position size = (equity × positionPercent) / maxConcurrent
//     so 5 simultaneous positions at 50% pos% = 10% each, summing to 50%.
//   - Entry only fires if currentOpen.length < maxConcurrent.
//   - Entries DEDUPED per bar — strategy fires once; runner doesn't pyramid
//     into multiple trades on same bar.

import type { Candle } from '../../pipeline/types.ts';
import type {
  CanonicalStrategy,
  CanonicalTrade,
  RunConfig,
  RunResult,
  StrategyContext,
  ExitProfile,
} from './types.ts';
import { atr } from './indicators.ts';
import { DEFAULT_EXIT_PROFILE } from './types.ts';

export interface MultiRunConfig extends RunConfig {
  maxConcurrent: number;  // e.g., 5 grid slots
}

interface OpenTrade {
  id: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  stop: number;
  target: number;
  initialRisk: number;
  quantity: number;
  positionSizeUsd: number;
  peakPrice: number;
  beTriggered: boolean;
}

export function runMultiBacktest(cfg: MultiRunConfig): RunResult {
  const { strategy, ticker, candles, startBar, endBar, budget, maxConcurrent } = cfg;
  const exit: ExitProfile = cfg.exitProfile ?? DEFAULT_EXIT_PROFILE;
  const trades: CanonicalTrade[] = [];
  let equity = budget;
  const open: OpenTrade[] = [];
  let nextId = 1;

  const i0 = Math.max(startBar, strategy.warmupBars);
  const atrSeries = (exit.chandelierAtR > 0) ? atr(candles, 14) : null;

  for (let i = i0; i < endBar - 1; i++) {
    const next = candles[i + 1];
    if (!next) continue;

    // --- 1. Manage every open trade with NEXT bar's data ---
    const stillOpen: OpenTrade[] = [];
    for (const t of open) {
      if (next.high > t.peakPrice) t.peakPrice = next.high;

      // Asymmetric exit: BE move and chandelier trail.
      if (t.initialRisk > 0) {
        const peakR = (t.peakPrice - t.entryPrice) / t.initialRisk;
        if (exit.breakEvenAtR > 0 && !t.beTriggered && peakR >= exit.breakEvenAtR) {
          const beStop = t.entryPrice * 1.001;
          if (beStop > t.stop) t.stop = beStop;
          t.beTriggered = true;
        }
        if (exit.chandelierAtR > 0 && atrSeries && peakR >= exit.chandelierAtR) {
          const atrAbs = atrSeries[i + 1];
          if (Number.isFinite(atrAbs) && atrAbs > 0) {
            const candidate = t.peakPrice - exit.chandelierAtrMult * atrAbs;
            if (candidate > t.stop) t.stop = candidate;
          }
        }
      }

      // Intrabar resolution; stop-first if both hit.
      let exitPrice = NaN;
      let exitReason: CanonicalTrade['exitReason'] | null = null;
      if (next.low <= t.stop) {
        exitPrice = t.stop * (1 - cfg.slippagePerSide);
        exitReason = 'stop';
      } else if (t.target > 0 && next.high >= t.target) {
        exitPrice = t.target * (1 - cfg.slippagePerSide);
        exitReason = 'target';
      }

      if (exitReason) {
        const pnlGross = (exitPrice - t.entryPrice) * t.quantity;
        const fees = t.positionSizeUsd * cfg.feeRoundTrip;
        const pnlNet = pnlGross - fees;
        trades.push({
          strategy: strategy.name, ticker,
          entryBar: t.entryBar, entryTime: t.entryTime, entryPrice: t.entryPrice,
          exitBar: i + 1, exitTime: next.time, exitPrice,
          exitReason,
          quantity: t.quantity, positionSizeUsd: t.positionSizeUsd,
          pnlGross, pnlNet, feesPaid: fees,
          holdBars: i + 1 - t.entryBar,
        });
        equity += pnlNet;
      } else {
        stillOpen.push(t);
      }
    }
    open.length = 0;
    open.push(...stillOpen);

    // --- 2. Try to add a new entry if there's a free slot ---
    if (open.length < maxConcurrent) {
      const ctx: StrategyContext = { candles, i };
      const decision = strategy.evaluateEntry(ctx);
      if (decision.enter) {
        const fillPrice = next.open * (1 + cfg.slippagePerSide);
        // Per-slot budget so total exposure is capped at equity × positionPercent.
        const slotBudget = (equity * cfg.positionPercent) / maxConcurrent;
        if (slotBudget >= 5 && fillPrice > 0 && decision.stop < fillPrice) {
          // Don't open if we already have a trade with the same stop/target
          // pair on the same bar (avoid one signal yielding N identical trades).
          const dup = open.some(o => Math.abs(o.entryPrice - fillPrice) / fillPrice < 0.001 && o.entryBar === i + 1);
          if (!dup) {
            const qty = slotBudget / fillPrice;
            open.push({
              id: nextId++,
              entryBar: i + 1, entryTime: next.time, entryPrice: fillPrice,
              stop: decision.stop, target: decision.target,
              initialRisk: Math.max(0, fillPrice - decision.stop),
              quantity: qty, positionSizeUsd: slotBudget,
              peakPrice: fillPrice, beTriggered: false,
            });
          }
        }
      }
    }
  }

  // Force-close any remaining at last bar's close.
  const last = candles[endBar - 1] ?? candles[candles.length - 1];
  for (const t of open) {
    const exitPrice = last.close * (1 - cfg.slippagePerSide);
    const pnlGross = (exitPrice - t.entryPrice) * t.quantity;
    const fees = t.positionSizeUsd * cfg.feeRoundTrip;
    const pnlNet = pnlGross - fees;
    trades.push({
      strategy: strategy.name, ticker,
      entryBar: t.entryBar, entryTime: t.entryTime, entryPrice: t.entryPrice,
      exitBar: endBar - 1, exitTime: last.time, exitPrice,
      exitReason: 'force_close',
      quantity: t.quantity, positionSizeUsd: t.positionSizeUsd,
      pnlGross, pnlNet, feesPaid: fees,
      holdBars: endBar - 1 - t.entryBar,
    });
    equity += pnlNet;
  }

  return summarize(strategy.name, ticker, candles, startBar, endBar, trades, budget, equity);
}

function summarize(
  strategyName: CanonicalStrategy['name'],
  ticker: string,
  candles: Candle[],
  startBar: number,
  endBar: number,
  trades: CanonicalTrade[],
  startBudget: number,
  endEquity: number,
): RunResult {
  const wins = trades.filter(t => t.pnlNet > 0);
  const losses = trades.filter(t => t.pnlNet <= 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlNet, 0);
  const grossLossesAbs = Math.abs(losses.reduce((s, t) => s + t.pnlNet, 0));

  // Drawdown on time-ordered equity curve.
  const ordered = [...trades].sort((a, b) => a.exitBar - b.exitBar);
  let peak = startBudget;
  let equity = startBudget;
  let maxDD = 0;
  for (const t of ordered) {
    equity += t.pnlNet;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const startMs = candles[startBar]?.time ?? 0;
  const endMs = candles[endBar - 1]?.time ?? candles[candles.length - 1].time;
  const windowDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000));

  return {
    strategy: strategyName, ticker, windowDays, trades,
    startBudget, endEquity,
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnlNet: endEquity - startBudget,
    totalPnlPercent: ((endEquity - startBudget) / startBudget) * 100,
    profitFactor: grossLossesAbs > 0 ? grossWins / grossLossesAbs : (grossWins > 0 ? Infinity : 0),
    avgWin: wins.length > 0 ? grossWins / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLossesAbs / losses.length : 0,
    maxDrawdownPercent: maxDD * 100,
    avgHoldBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0,
  };
}
