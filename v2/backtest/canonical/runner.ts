// Runner for canonical strategies. Single-position-at-a-time long-only
// backtest. Fills on the NEXT bar's open after a signal closes (no lookahead).
// Fees + slippage applied per side.
//
// Trade lifecycle:
//   bar i closes → evaluateEntry(ctx)
//   if enter: fill at candles[i+1].open × (1 + slip), record stop/target
//   while open:
//     - check intrabar: stop hit (low <= stop) → exit at stop × (1 - slip)
//     - else target hit (high >= target) → exit at target × (1 - slip)
//     - else updateStop(); update peak
//   force-close at end of window

import type { Candle } from '../../pipeline/types.ts';
import type {
  CanonicalStrategy,
  CanonicalTrade,
  RunConfig,
  RunResult,
  StrategyContext,
} from './types.ts';
import { macd } from './indicators.ts';

interface OpenTrade {
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  stop: number;
  target: number;
  quantity: number;
  positionSizeUsd: number;
  peakPrice: number;
  peakHistogram: number;
}

export function runBacktest(cfg: RunConfig): RunResult {
  const { strategy, ticker, candles, startBar, endBar, budget } = cfg;
  const trades: CanonicalTrade[] = [];
  let equity = budget;
  let open: OpenTrade | null = null;

  const i0 = Math.max(startBar, strategy.warmupBars);

  // Pre-compute MACD hist for the MACD trailing exit (avoid per-bar recompute cost).
  const closesAll = candles.map(c => c.close);
  const macdSeries = strategy.name === 'MACD' ? macd(closesAll, 12, 26, 9).hist : null;

  for (let i = i0; i < endBar - 1; i++) {
    const cur = candles[i];
    const next = candles[i + 1];
    if (!cur || !next) continue;

    // --- Manage open trade with NEXT bar's data ---
    if (open) {
      // Update peak before intrabar check (we're now processing bar i+1).
      if (next.high > open.peakPrice) open.peakPrice = next.high;
      if (macdSeries && Number.isFinite(macdSeries[i + 1])) {
        if (macdSeries[i + 1] > open.peakHistogram) open.peakHistogram = macdSeries[i + 1];
      }

      // Update stop via strategy-specific logic, BEFORE checking intrabar hit.
      // Using ctx at i+1 (the bar we're acting on). updateStop ratchets only up.
      if (strategy.updateStop) {
        const ctx: StrategyContext = { candles, i: i + 1 };
        const newStop = strategy.updateStop(ctx, open.entryPrice, open.stop, open.peakPrice);
        if (newStop > open.stop) open.stop = newStop;
      }

      // MACD-specific exit: histogram falls to <50% of peak since entry.
      let macdHistExit = false;
      if (strategy.name === 'MACD' && macdSeries && open.peakHistogram > 0) {
        const hNow = macdSeries[i + 1];
        if (Number.isFinite(hNow) && hNow < 0.5 * open.peakHistogram) macdHistExit = true;
      }

      // Intrabar resolution. Convention when both stop and target are hit on
      // the same bar: assume stop hit first (conservative — pessimistic for
      // longs). This matches typical institutional backtests.
      let exitPrice = NaN;
      let exitReason: CanonicalTrade['exitReason'] | null = null;

      if (next.low <= open.stop) {
        exitPrice = open.stop * (1 - cfg.slippagePerSide);
        exitReason = 'stop';
      } else if (open.target > 0 && next.high >= open.target) {
        exitPrice = open.target * (1 - cfg.slippagePerSide);
        exitReason = 'target';
      } else if (macdHistExit) {
        exitPrice = next.close * (1 - cfg.slippagePerSide);
        exitReason = 'stop'; // treat as managed exit
      }

      if (exitReason) {
        const pnlGross = (exitPrice - open.entryPrice) * open.quantity;
        const fees = open.positionSizeUsd * cfg.feeRoundTrip;
        const pnlNet = pnlGross - fees;
        trades.push({
          strategy: strategy.name,
          ticker,
          entryBar: open.entryBar,
          entryTime: open.entryTime,
          entryPrice: open.entryPrice,
          exitBar: i + 1,
          exitTime: next.time,
          exitPrice,
          exitReason,
          quantity: open.quantity,
          positionSizeUsd: open.positionSizeUsd,
          pnlGross,
          pnlNet,
          feesPaid: fees,
          holdBars: i + 1 - open.entryBar,
        });
        equity += pnlNet;
        open = null;
      }
    }

    // --- Evaluate entry on closed bar i, fill on bar i+1 open ---
    if (!open) {
      const ctx: StrategyContext = { candles, i };
      const decision = strategy.evaluateEntry(ctx);
      if (decision.enter) {
        const fillPrice = next.open * (1 + cfg.slippagePerSide);
        const positionSizeUsd = equity * cfg.positionPercent;
        if (positionSizeUsd >= 5 && fillPrice > 0 && decision.stop < fillPrice) {
          const qty = positionSizeUsd / fillPrice;
          open = {
            entryBar: i + 1,
            entryTime: next.time,
            entryPrice: fillPrice,
            stop: decision.stop,
            target: decision.target,
            quantity: qty,
            positionSizeUsd,
            peakPrice: fillPrice,
            peakHistogram: macdSeries && Number.isFinite(macdSeries[i + 1]) ? macdSeries[i + 1] : 0,
          };
        }
      }
    }
  }

  // Force-close any open trade at last bar's close.
  if (open) {
    const last = candles[endBar - 1] ?? candles[candles.length - 1];
    const exitPrice = last.close * (1 - cfg.slippagePerSide);
    const pnlGross = (exitPrice - open.entryPrice) * open.quantity;
    const fees = open.positionSizeUsd * cfg.feeRoundTrip;
    const pnlNet = pnlGross - fees;
    trades.push({
      strategy: strategy.name,
      ticker,
      entryBar: open.entryBar,
      entryTime: open.entryTime,
      entryPrice: open.entryPrice,
      exitBar: endBar - 1,
      exitTime: last.time,
      exitPrice,
      exitReason: 'force_close',
      quantity: open.quantity,
      positionSizeUsd: open.positionSizeUsd,
      pnlGross,
      pnlNet,
      feesPaid: fees,
      holdBars: endBar - 1 - open.entryBar,
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

  // Drawdown on equity curve.
  let peak = startBudget;
  let equity = startBudget;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnlNet;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const startMs = candles[startBar]?.time ?? 0;
  const endMs = candles[endBar - 1]?.time ?? candles[candles.length - 1].time;
  const windowDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000));

  return {
    strategy: strategyName,
    ticker,
    windowDays,
    trades,
    startBudget,
    endEquity,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
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
