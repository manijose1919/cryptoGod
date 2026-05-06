// ============================================
// Phoenix V2 Backtest Engine
// Bar-by-bar replay through the V2 pipeline
// Uses real computeSignals + evaluateSignals,
// implements exit simulation on OHLC bars
// ============================================

import type { Candle, SignalSnapshot, Regime } from '../pipeline/types.ts';
import { EXIT_REASON } from '../pipeline/types.ts';
import { V2_CONFIG } from '../engine/config.ts';
import { computeSignals } from '../indicators/indicators.ts';
import { evaluateSignals } from '../pipeline/signalGenerator.ts';
import { checkTimeGate } from '../pipeline/timeGate.ts';
import { scanMarket } from '../pipeline/marketScanner.ts';
import { SIGNAL_ACTIVE_THRESHOLDS } from '../attribution/postTradeAnalyzer.ts';
import type {
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
  BacktestSummary,
  SignalScoreResult,
  RegimeBreakdown,
  TickerBreakdown,
} from './types.ts';
import { loadAllCandles } from './candleCache.ts';

// --- ID Generator ---

let _tradeCounter = 0;
function nextTradeId(ticker: string): string {
  _tradeCounter++;
  return `bt_${ticker}_${_tradeCounter}`;
}

// --- Exit Simulation (in-memory, uses OHLC bars) ---

interface ExitCheckResult {
  shouldExit: boolean;
  exitPrice: number;
  exitReason: typeof EXIT_REASON[keyof typeof EXIT_REASON] | null;
  newStop: number;
  trailingActivated: boolean;
}

function checkExitOnBar(
  trade: BacktestTrade,
  bar: Candle,
  barIndex: number,
  config: BacktestConfig,
): ExitCheckResult {
  const holdBars = barIndex - trade.entryBar;
  const holdMs = holdBars * config.intervalMinutes * 60 * 1000;

  let currentStop = trade.currentStop;
  let trailingActivated = trade.trailingActivated;

  // Update peak price
  if (bar.high > trade.peakPrice) {
    trade.peakPrice = bar.high;
  }

  // --- 1. Stop Loss (check bar.low) ---
  // --- 2. Take Profit (check bar.high) ---
  // If both can trigger on same bar, SL wins (conservative)
  const slHit = bar.low <= currentStop;
  const tpHit = bar.high >= trade.takeProfit;

  if (slHit && tpHit) {
    // Both triggered same bar — SL wins (conservative assumption)
    return {
      shouldExit: true,
      exitPrice: currentStop,
      exitReason: EXIT_REASON.stop_loss,
      newStop: currentStop,
      trailingActivated,
    };
  }

  if (slHit) {
    return {
      shouldExit: true,
      exitPrice: currentStop,
      exitReason: EXIT_REASON.stop_loss,
      newStop: currentStop,
      trailingActivated,
    };
  }

  if (tpHit) {
    return {
      shouldExit: true,
      exitPrice: trade.takeProfit,
      exitReason: EXIT_REASON.take_profit,
      newStop: currentStop,
      trailingActivated,
    };
  }

  // --- 3. Break-Even Stop ---
  // If price reached entry+1.5%, move SL to entry+0.1%
  const pnlPercentAtHigh = (bar.high - trade.entryPrice) / trade.entryPrice;
  if (pnlPercentAtHigh >= 0.015) {
    const breakEvenStop = trade.entryPrice * 1.001;
    if (breakEvenStop > currentStop) {
      currentStop = breakEvenStop;
    }
  }

  // --- 4. Quick-Kill ---
  // After 45min, if peak gain < 0.3%, tighten SL
  const quickKillBars = Math.ceil(V2_CONFIG.QUICK_KILL_AFTER_MS / (config.intervalMinutes * 60 * 1000));
  const peakPnlPercent = (trade.peakPrice - trade.entryPrice) / trade.entryPrice;

  if (
    holdBars >= quickKillBars &&
    peakPnlPercent < V2_CONFIG.QUICK_KILL_MIN_GAIN &&
    trade.atrPercent > 0
  ) {
    const tighterStop = trade.entryPrice - (trade.entryPrice * trade.atrPercent / 100) * V2_CONFIG.QUICK_KILL_SL_ATR_MULT;
    if (tighterStop > currentStop) {
      currentStop = tighterStop;
    }
  }

  // --- 5. Trailing Stop ---
  const pnlPercentAtClose = (bar.close - trade.entryPrice) / trade.entryPrice;

  if (pnlPercentAtClose >= V2_CONFIG.TRAILING_ACTIVATE_PERCENT) {
    trailingActivated = true;

    // ATR-aware giveback
    let givebackFraction = V2_CONFIG.TRAILING_GIVEBACK_PERCENT;
    if (trade.atrPercent > 2.0) givebackFraction *= 1.3;
    else if (trade.atrPercent > 1.0) givebackFraction *= 1.1;
    else if (trade.atrPercent < 0.3) givebackFraction *= 0.7;

    // Profit-tier tightening
    const tpPercent = (trade.takeProfit - trade.entryPrice) / trade.entryPrice;
    const profitMultiple = tpPercent > 0 ? pnlPercentAtClose / tpPercent : 1;
    if (profitMultiple >= 2.0) givebackFraction *= 0.6;
    else if (profitMultiple >= 1.5) givebackFraction *= 0.8;

    const peakGain = trade.peakPrice - trade.entryPrice;
    const trailingStop = trade.peakPrice - peakGain * givebackFraction;

    if (trailingStop > currentStop) {
      currentStop = trailingStop;
    }

    // Check if trailing stop hit at bar low
    if (bar.low <= currentStop) {
      return {
        shouldExit: true,
        exitPrice: currentStop,
        exitReason: EXIT_REASON.trailing,
        newStop: currentStop,
        trailingActivated,
      };
    }
  }

  // --- 6. Time Kill ---
  if (holdMs > V2_CONFIG.TIME_KILL_MS && Math.abs(pnlPercentAtClose) < V2_CONFIG.TIME_KILL_MIN_MOVE) {
    return {
      shouldExit: true,
      exitPrice: bar.close,
      exitReason: EXIT_REASON.time_kill,
      newStop: currentStop,
      trailingActivated,
    };
  }

  return {
    shouldExit: false,
    exitPrice: bar.close,
    exitReason: null,
    newStop: currentStop,
    trailingActivated,
  };
}

// --- Per-Ticker Simulation ---

interface TickerState {
  cash: number;
  openTrades: BacktestTrade[];
  closedTrades: BacktestTrade[];
  dailyPnl: number;
  lastLossTime: number;
}

function simulateTicker(
  ticker: string,
  candles: Candle[],
  config: BacktestConfig,
): BacktestTrade[] {
  const state: TickerState = {
    cash: config.budgetPerTicker,
    openTrades: [],
    closedTrades: [],
    dailyPnl: 0,
    lastLossTime: 0,
  };

  // Walk bar-by-bar from MIN_CANDLES to end
  for (let bar = V2_CONFIG.MIN_CANDLES; bar < candles.length; bar++) {
    const currentCandle = candles[bar];

    // Reset daily PnL at midnight boundaries
    if (bar > V2_CONFIG.MIN_CANDLES) {
      const prevDay = new Date(candles[bar - 1].time).getUTCDate();
      const currDay = new Date(currentCandle.time).getUTCDate();
      if (currDay !== prevDay) {
        state.dailyPnl = 0;
      }
    }

    // --- CHECK EXITS (before entries, like live engine) ---
    const stillOpen: BacktestTrade[] = [];

    for (const trade of state.openTrades) {
      const exitResult = checkExitOnBar(trade, currentCandle, bar, config);

      // Update trade state
      trade.currentStop = exitResult.newStop;
      trade.trailingActivated = exitResult.trailingActivated;

      if (exitResult.shouldExit) {
        // Close trade
        const exitPrice = exitResult.exitPrice;
        const pnlGross = (exitPrice - trade.entryPrice) * trade.quantity;
        const feesPaid = trade.positionSizeUsd * config.feeRoundTrip;
        const pnlNet = pnlGross - feesPaid;
        const holdBars = bar - trade.entryBar;

        trade.exitBar = bar;
        trade.exitPrice = exitPrice;
        trade.exitTime = currentCandle.time;
        trade.exitReason = exitResult.exitReason;
        trade.pnlGross = pnlGross;
        trade.pnlNet = pnlNet;
        trade.feesPaid = feesPaid;
        trade.holdBars = holdBars;
        trade.holdDurationMs = holdBars * config.intervalMinutes * 60 * 1000;

        state.cash += trade.positionSizeUsd + pnlNet;
        state.dailyPnl += pnlNet;
        if (pnlNet < 0) state.lastLossTime = currentCandle.time;

        state.closedTrades.push(trade);
      } else {
        stillOpen.push(trade);
      }
    }

    state.openTrades = stillOpen;

    // --- CHECK ENTRY ---
    if (state.openTrades.length >= config.maxOpenPositions) continue;

    // Circuit breaker cooldown
    if (state.lastLossTime > 0) {
      const timeSinceLoss = currentCandle.time - state.lastLossTime;
      if (timeSinceLoss < V2_CONFIG.CIRCUIT_BREAKER_COOLDOWN_MS) continue;
    }

    // Daily loss limit
    const dailyLossPercent = state.cash > 0 ? state.dailyPnl / config.budgetPerTicker : 0;
    if (dailyLossPercent < -V2_CONFIG.MAX_DAILY_LOSS_PERCENT) continue;

    // Build candle window for indicator computation
    const window = candles.slice(0, bar + 1);

    // Run market scanner (single ticker)
    const tickerCandles = new Map([[ticker, window]]);
    const scanResults = scanMarket(tickerCandles);
    const passed = scanResults.find((s) => s.ticker === ticker && s.passed);
    if (!passed) continue;

    // Compute signals
    const { signals, regime } = computeSignals(window);

    // Evaluate signals (uses base weights — no scorecard data in backtest)
    const evals = evaluateSignals(signals);

    // Compute composite score (replicating signalGenerator logic)
    const totalWeight = evals.reduce((sum, e) => sum + e.weight, 0);
    let compositeScore = totalWeight > 0
      ? evals.reduce((sum, e) => sum + e.score * e.weight, 0) / totalWeight
      : 0;

    // Regime bonus
    if (regime.regime === 'STRONG_UP') compositeScore += 8;
    else if (regime.regime === 'UP') compositeScore += 5;

    compositeScore = Math.min(compositeScore, 100);

    // BB overbought penalty
    const pctB = signals.bb_percent_b as number;
    if (pctB > 0.80) {
      compositeScore -= Math.round(6 + (pctB - 0.80) * 120);
    }

    // TimeGate overlay — block entries during data-discovered worst hours/days,
    // boost during best hours by lowering the score threshold.
    const tg = checkTimeGate(window[window.length - 1]?.time);
    if (!tg.allow) continue;
    if (compositeScore < V2_CONFIG.MIN_COMPOSITE_SCORE - tg.scoreBoost) continue;

    const confidence = compositeScore / 100;

    // Expected return check
    const atrPercent = signals.atr_percent as number;
    const tpPercent = atrPercent * V2_CONFIG.TAKE_PROFIT_ATR_MULT / 100;
    const expectedReturn = tpPercent - config.feeRoundTrip;
    if (expectedReturn < V2_CONFIG.MIN_EXPECTED_RETURN) continue;

    // Position sizing
    const maxPositionUsd = state.cash * V2_CONFIG.BASE_POSITION_PERCENT;
    const positionSizeUsd = maxPositionUsd * confidence;
    if (positionSizeUsd < 10 || positionSizeUsd > state.cash) continue;

    // Entry at bar close price
    const entryPrice = currentCandle.close;
    const atrValue = signals.atr as number;
    const stopLoss = entryPrice - atrValue * V2_CONFIG.STOP_LOSS_ATR_MULT;
    const takeProfit = entryPrice + atrValue * V2_CONFIG.TAKE_PROFIT_ATR_MULT;
    const quantity = entryPrice > 0 ? positionSizeUsd / entryPrice : 0;

    const trade: BacktestTrade = {
      id: nextTradeId(ticker),
      ticker,
      entryBar: bar,
      entryPrice,
      entryTime: currentCandle.time,
      entrySignals: signals,
      entryRegime: regime.regime,
      entryConfidence: confidence,
      compositeScore,
      exitBar: null,
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      quantity,
      positionSizeUsd,
      stopLoss,
      takeProfit,
      currentStop: stopLoss,
      trailingActivated: false,
      peakPrice: entryPrice,
      pnlGross: null,
      pnlNet: null,
      feesPaid: 0,
      holdBars: 0,
      holdDurationMs: null,
      atrPercent,
    };

    state.cash -= positionSizeUsd;
    state.openTrades.push(trade);
  }

  // Force-close any remaining open trades at last bar close
  const lastCandle = candles[candles.length - 1];
  for (const trade of state.openTrades) {
    const exitPrice = lastCandle.close;
    const pnlGross = (exitPrice - trade.entryPrice) * trade.quantity;
    const feesPaid = trade.positionSizeUsd * config.feeRoundTrip;
    const pnlNet = pnlGross - feesPaid;
    const holdBars = candles.length - 1 - trade.entryBar;

    trade.exitBar = candles.length - 1;
    trade.exitPrice = exitPrice;
    trade.exitTime = lastCandle.time;
    trade.exitReason = EXIT_REASON.time_kill;
    trade.pnlGross = pnlGross;
    trade.pnlNet = pnlNet;
    trade.feesPaid = feesPaid;
    trade.holdBars = holdBars;
    trade.holdDurationMs = holdBars * config.intervalMinutes * 60 * 1000;
    state.closedTrades.push(trade);
  }

  return state.closedTrades;
}

// --- Signal Score Computation ---

function computeSignalScores(trades: BacktestTrade[]): SignalScoreResult[] {
  const results: SignalScoreResult[] = [];

  for (const signalName of Object.keys(SIGNAL_ACTIVE_THRESHOLDS)) {
    const threshold = SIGNAL_ACTIVE_THRESHOLDS[signalName];

    let activeTrades = 0;
    let activeWins = 0;
    let activePnlSum = 0;
    let inactiveTrades = 0;
    let inactivePnlSum = 0;

    for (const trade of trades) {
      if (trade.pnlNet == null || trade.positionSizeUsd === 0) continue;

      const signalValue = trade.entrySignals[signalName];
      if (signalValue === undefined) continue;

      const pnlPercent = trade.pnlNet / trade.positionSizeUsd;

      if (threshold(signalValue)) {
        activeTrades++;
        activePnlSum += pnlPercent;
        if (trade.pnlNet > 0) activeWins++;
      } else {
        inactiveTrades++;
        inactivePnlSum += pnlPercent;
      }
    }

    const totalTrades = activeTrades + inactiveTrades;
    const winRate = activeTrades > 0 ? activeWins / activeTrades : 0;
    const avgPnlWhenActive = activeTrades > 0 ? activePnlSum / activeTrades : 0;
    const avgPnlWhenInactive = inactiveTrades > 0 ? inactivePnlSum / inactiveTrades : 0;
    const edge = avgPnlWhenActive - avgPnlWhenInactive;

    let verdict: 'proven' | 'negative' | 'inconclusive';
    if (totalTrades < V2_CONFIG.MIN_TRADES_FOR_SCORING) verdict = 'inconclusive';
    else if (edge > 0.003 && winRate > 0.55) verdict = 'proven';
    else if (edge < -0.002) verdict = 'negative';
    else verdict = 'inconclusive';

    results.push({
      signalName,
      totalTrades,
      winningTrades: activeWins,
      winRate,
      avgPnlWhenActive,
      avgPnlWhenInactive,
      edge,
      verdict,
    });
  }

  // Sort by edge descending
  results.sort((a, b) => b.edge - a.edge);
  return results;
}

// --- Summary Computation ---

function computeSummary(trades: BacktestTrade[], config: BacktestConfig): BacktestSummary {
  const closed = trades.filter((t) => t.pnlNet != null);
  const wins = closed.filter((t) => t.pnlNet! > 0);
  const losses = closed.filter((t) => t.pnlNet! <= 0);

  const totalPnlNet = closed.reduce((sum, t) => sum + t.pnlNet!, 0);
  const totalBudget = config.budgetPerTicker * config.tickers.length;

  const grossProfit = wins.reduce((sum, t) => sum + t.pnlNet!, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlNet!, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown (equity curve)
  let peak = 0;
  let equity = 0;
  let maxDrawdownUsd = 0;

  // Sort by exit time for equity curve
  const byExitTime = [...closed].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  for (const trade of byExitTime) {
    equity += trade.pnlNet!;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownUsd) maxDrawdownUsd = drawdown;
  }

  const avgHoldBars = closed.length > 0
    ? closed.reduce((sum, t) => sum + t.holdBars, 0) / closed.length
    : 0;
  const avgHoldDurationMs = closed.length > 0
    ? closed.reduce((sum, t) => sum + (t.holdDurationMs ?? 0), 0) / closed.length
    : 0;

  // Best and worst trades
  let bestTrade: BacktestTrade | null = null;
  let worstTrade: BacktestTrade | null = null;
  for (const t of closed) {
    if (!bestTrade || t.pnlNet! > bestTrade.pnlNet!) bestTrade = t;
    if (!worstTrade || t.pnlNet! < worstTrade.pnlNet!) worstTrade = t;
  }

  return {
    totalTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnlNet,
    totalPnlPercent: totalBudget > 0 ? totalPnlNet / totalBudget : 0,
    avgWinPnl: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossPnl: losses.length > 0 ? -grossLoss / losses.length : 0,
    profitFactor,
    maxDrawdownUsd,
    maxDrawdownPercent: totalBudget > 0 ? maxDrawdownUsd / totalBudget : 0,
    avgHoldBars,
    avgHoldDurationMs,
    bestTrade,
    worstTrade,
  };
}

// --- Regime Breakdown ---

function computeRegimeBreakdown(trades: BacktestTrade[]): RegimeBreakdown[] {
  const regimeMap = new Map<string, { trades: number; wins: number; pnl: number }>();

  for (const trade of trades) {
    if (trade.pnlNet == null) continue;
    const r = trade.entryRegime;
    const entry = regimeMap.get(r) ?? { trades: 0, wins: 0, pnl: 0 };
    entry.trades++;
    if (trade.pnlNet > 0) entry.wins++;
    entry.pnl += trade.pnlNet;
    regimeMap.set(r, entry);
  }

  return [...regimeMap.entries()]
    .map(([regime, data]) => ({
      regime,
      trades: data.trades,
      winRate: data.trades > 0 ? data.wins / data.trades : 0,
      totalPnl: data.pnl,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

// --- Ticker Breakdown ---

function computeTickerBreakdown(trades: BacktestTrade[]): TickerBreakdown[] {
  const tickerMap = new Map<string, { trades: number; wins: number; pnl: number }>();

  for (const trade of trades) {
    if (trade.pnlNet == null) continue;
    const t = trade.ticker;
    const entry = tickerMap.get(t) ?? { trades: 0, wins: 0, pnl: 0 };
    entry.trades++;
    if (trade.pnlNet > 0) entry.wins++;
    entry.pnl += trade.pnlNet;
    tickerMap.set(t, entry);
  }

  return [...tickerMap.entries()]
    .map(([ticker, data]) => ({
      ticker,
      trades: data.trades,
      winRate: data.trades > 0 ? data.wins / data.trades : 0,
      totalPnl: data.pnl,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

// --- Main Entry Point ---

/**
 * Run a full backtest across all tickers.
 * Downloads/caches candles, then replays bar-by-bar through the V2 pipeline.
 */
export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  _tradeCounter = 0;

  // Load all candles (cached or fresh from Kraken)
  const allCandles = await loadAllCandles(
    config.tickers,
    config.startDate,
    config.endDate,
    config.interval,
  );

  // Run simulation per ticker
  console.log('Running backtest simulation...');
  const allTrades: BacktestTrade[] = [];

  for (const [ticker, candles] of allCandles) {
    const trades = simulateTicker(ticker, candles, config);
    allTrades.push(...trades);
    const pnl = trades.reduce((sum, t) => sum + (t.pnlNet ?? 0), 0);
    const wins = trades.filter((t) => t.pnlNet != null && t.pnlNet > 0).length;
    console.log(`  ${ticker}: ${trades.length} trades, ${wins}W/${trades.length - wins}L, PnL $${pnl.toFixed(2)}`);
  }

  console.log(`\nTotal: ${allTrades.length} trades across ${allCandles.size} tickers\n`);

  // Compute analytics
  const summary = computeSummary(allTrades, config);
  const signalScores = computeSignalScores(allTrades);
  const regimeBreakdown = computeRegimeBreakdown(allTrades);
  const tickerBreakdown = computeTickerBreakdown(allTrades);

  return {
    config,
    trades: allTrades,
    summary,
    signalScores,
    regimeBreakdown,
    tickerBreakdown,
  };
}
