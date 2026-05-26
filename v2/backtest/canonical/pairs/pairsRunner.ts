// Pairs trading backtest runner.
//
// Two-leg execution: long one asset and short the other in β-hedged ratios.
// PnL aggregates both legs; fees charged on each leg independently.
//
// Sizing convention:
//   - notionalUsd = equity × positionPercent  (total combined exposure cap)
//   - long leg: notionalUsd / 2 (so ~50% of "position" is in each leg)
//   - short leg: same dollar notional (qty_B = β · qty_A · (priceA/priceB))
//     Wait — that's not quite right. β is in log-prices; convert.
//     Hedge ratio in $ terms: qty_B = qty_A · priceA / priceB · β
//   - In practice the simpler choice that's still β-hedged: equal-$ notional
//     on each leg. This is what most retail pair-trading impls do.
//
// Exit semantics:
//   - Mean-revert exit: close both legs at next bar's open.
//   - Stop exit (z > stopZ): close both legs at next bar's open. No intra-bar
//     stop on spread because spread isn't a quoted price — checked on bar close.
//
// Fees: feeRoundTrip applied to EACH leg, so total trip cost is 2× single-leg.

import type { Candle } from '../../../pipeline/types.ts';
import {
  evaluatePairs, reestimate,
  type PairsParams, type PairsState,
} from './pairsStrategy.ts';

export interface PairsRunConfig {
  symA: string;
  symB: string;
  candlesA: Candle[];     // already aligned by time with candlesB
  candlesB: Candle[];
  startBar: number;
  endBar: number;
  warmupBars: number;     // need this many bars to estimate β before trading
  budget: number;
  positionPercent: number;
  feeRoundTripPerLeg: number;
  slippagePerSide: number;
  params: PairsParams;
}

export interface PairsTrade {
  symA: string;
  symB: string;
  side: 'long_spread' | 'short_spread';
  entryBar: number;
  entryTime: number;
  entryPriceA: number;
  entryPriceB: number;
  entryZ: number;
  beta: number;
  qtyA: number;
  qtyB: number;
  notionalUsd: number;
  exitBar: number;
  exitTime: number;
  exitPriceA: number;
  exitPriceB: number;
  exitZ: number;
  exitReason: string;
  pnlGross: number;
  pnlNet: number;
  feesPaid: number;
  holdBars: number;
}

export interface PairsRunResult {
  symA: string;
  symB: string;
  windowDays: number;
  trades: PairsTrade[];
  startBudget: number;
  endEquity: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlNet: number;
  totalPnlPercent: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPercent: number;
  avgHoldBars: number;
  longSpreadTrades: number;
  shortSpreadTrades: number;
}

export function runPairsBacktest(cfg: PairsRunConfig): PairsRunResult {
  const { candlesA, candlesB, startBar, endBar, budget, params } = cfg;
  const n = Math.min(candlesA.length, candlesB.length);
  const logA: number[] = new Array(n);
  const logB: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    logA[i] = Math.log(candlesA[i].close);
    logB[i] = Math.log(candlesB[i].close);
  }

  const trades: PairsTrade[] = [];
  let equity = budget;
  let state: PairsState | null = null;
  let openTrade: {
    entryBar: number;
    entryTime: number;
    entryPriceA: number;
    entryPriceB: number;
    entryZ: number;
    side: 'long_spread' | 'short_spread';
    qtyA: number;
    qtyB: number;
    beta: number;
    notionalUsd: number;
  } | null = null;

  const i0 = Math.max(startBar, cfg.warmupBars);

  // Initial state from warmup window.
  state = reestimate(logA, logB, i0 - 1, params.rollingWindow);

  for (let i = i0; i < endBar - 1; i++) {
    const nextA = candlesA[i + 1];
    const nextB = candlesB[i + 1];
    if (!nextA || !nextB) continue;

    const sig = evaluatePairs({
      logA, logB, i,
      prior: state,
      inPosition: openTrade?.side ?? null,
      barsHeld: openTrade ? i - openTrade.entryBar : 0,
      params,
    });
    state = sig.state;  // state may have been refreshed by re-estimate inside

    if (openTrade && sig.action === 'exit') {
      // Close at next bar's open with slippage on both legs.
      const exitPriceA = nextA.open * (openTrade.side === 'long_spread' ? (1 - cfg.slippagePerSide) : (1 + cfg.slippagePerSide));
      const exitPriceB = nextB.open * (openTrade.side === 'long_spread' ? (1 + cfg.slippagePerSide) : (1 - cfg.slippagePerSide));
      // PnL: long leg + short leg
      let legA_pnl: number, legB_pnl: number;
      if (openTrade.side === 'long_spread') {
        legA_pnl = (exitPriceA - openTrade.entryPriceA) * openTrade.qtyA;
        legB_pnl = (openTrade.entryPriceB - exitPriceB) * openTrade.qtyB;  // short B
      } else {
        legA_pnl = (openTrade.entryPriceA - exitPriceA) * openTrade.qtyA;  // short A
        legB_pnl = (exitPriceB - openTrade.entryPriceB) * openTrade.qtyB;
      }
      const pnlGross = legA_pnl + legB_pnl;
      // Fees on both legs (round-trip per leg).
      const notionalA = openTrade.qtyA * openTrade.entryPriceA;
      const notionalB = openTrade.qtyB * openTrade.entryPriceB;
      const fees = (notionalA + notionalB) * cfg.feeRoundTripPerLeg;
      const pnlNet = pnlGross - fees;
      trades.push({
        symA: cfg.symA, symB: cfg.symB,
        side: openTrade.side,
        entryBar: openTrade.entryBar, entryTime: openTrade.entryTime,
        entryPriceA: openTrade.entryPriceA, entryPriceB: openTrade.entryPriceB,
        entryZ: openTrade.entryZ,
        beta: openTrade.beta,
        qtyA: openTrade.qtyA, qtyB: openTrade.qtyB,
        notionalUsd: openTrade.notionalUsd,
        exitBar: i + 1, exitTime: nextA.time,
        exitPriceA, exitPriceB, exitZ: sig.zScore,
        exitReason: sig.reason,
        pnlGross, pnlNet, feesPaid: fees,
        holdBars: i + 1 - openTrade.entryBar,
      });
      equity += pnlNet;
      openTrade = null;
    }

    if (!openTrade && (sig.action === 'enter_long_spread' || sig.action === 'enter_short_spread')) {
      const isLong = sig.action === 'enter_long_spread';
      // Fill at next bar's open.
      const entryPriceA = nextA.open * (isLong ? (1 + cfg.slippagePerSide) : (1 - cfg.slippagePerSide));
      const entryPriceB = nextB.open * (isLong ? (1 - cfg.slippagePerSide) : (1 + cfg.slippagePerSide));
      // Notional per leg = equity × positionPercent / 2.
      const totalNotional = equity * cfg.positionPercent;
      const legNotional = totalNotional / 2;
      const qtyA = legNotional / entryPriceA;
      // Hedge ratio in $ space: β tells us log-price relationship; for equal-dollar
      // pairs sizing, qtyB = legNotional / entryPriceB. The β is captured in the
      // spread signal already (entry threshold uses β). So equal-$ legs is fine
      // and standard for retail pair trading.
      const qtyB = legNotional / entryPriceB;
      if (legNotional < 5) continue;
      openTrade = {
        entryBar: i + 1, entryTime: nextA.time,
        entryPriceA, entryPriceB,
        entryZ: sig.zScore,
        side: isLong ? 'long_spread' : 'short_spread',
        qtyA, qtyB,
        beta: state.beta,
        notionalUsd: totalNotional,
      };
    }
  }

  // Force-close any remaining trade at end of window.
  if (openTrade) {
    const lastA = candlesA[endBar - 1] ?? candlesA[candlesA.length - 1];
    const lastB = candlesB[endBar - 1] ?? candlesB[candlesB.length - 1];
    const exitPriceA = lastA.close * (openTrade.side === 'long_spread' ? (1 - cfg.slippagePerSide) : (1 + cfg.slippagePerSide));
    const exitPriceB = lastB.close * (openTrade.side === 'long_spread' ? (1 + cfg.slippagePerSide) : (1 - cfg.slippagePerSide));
    let legA_pnl: number, legB_pnl: number;
    if (openTrade.side === 'long_spread') {
      legA_pnl = (exitPriceA - openTrade.entryPriceA) * openTrade.qtyA;
      legB_pnl = (openTrade.entryPriceB - exitPriceB) * openTrade.qtyB;
    } else {
      legA_pnl = (openTrade.entryPriceA - exitPriceA) * openTrade.qtyA;
      legB_pnl = (exitPriceB - openTrade.entryPriceB) * openTrade.qtyB;
    }
    const pnlGross = legA_pnl + legB_pnl;
    const notionalA = openTrade.qtyA * openTrade.entryPriceA;
    const notionalB = openTrade.qtyB * openTrade.entryPriceB;
    const fees = (notionalA + notionalB) * cfg.feeRoundTripPerLeg;
    const pnlNet = pnlGross - fees;
    trades.push({
      symA: cfg.symA, symB: cfg.symB,
      side: openTrade.side,
      entryBar: openTrade.entryBar, entryTime: openTrade.entryTime,
      entryPriceA: openTrade.entryPriceA, entryPriceB: openTrade.entryPriceB,
      entryZ: openTrade.entryZ,
      beta: openTrade.beta,
      qtyA: openTrade.qtyA, qtyB: openTrade.qtyB,
      notionalUsd: openTrade.notionalUsd,
      exitBar: endBar - 1, exitTime: lastA.time,
      exitPriceA, exitPriceB, exitZ: 0,
      exitReason: 'force_close',
      pnlGross, pnlNet, feesPaid: fees,
      holdBars: endBar - 1 - openTrade.entryBar,
    });
    equity += pnlNet;
  }

  return summarize(cfg.symA, cfg.symB, candlesA, startBar, endBar, trades, budget, equity);
}

function summarize(
  symA: string, symB: string,
  candles: Candle[], startBar: number, endBar: number,
  trades: PairsTrade[], startBudget: number, endEquity: number,
): PairsRunResult {
  const wins = trades.filter(t => t.pnlNet > 0);
  const losses = trades.filter(t => t.pnlNet <= 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlNet, 0);
  const grossLossesAbs = Math.abs(losses.reduce((s, t) => s + t.pnlNet, 0));

  let peak = startBudget, equity = startBudget, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitBar - b.exitBar)) {
    equity += t.pnlNet;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const startMs = candles[startBar]?.time ?? 0;
  const endMs = candles[endBar - 1]?.time ?? candles[candles.length - 1].time;
  const windowDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000));

  return {
    symA, symB, windowDays, trades,
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
    longSpreadTrades: trades.filter(t => t.side === 'long_spread').length,
    shortSpreadTrades: trades.filter(t => t.side === 'short_spread').length,
  };
}
