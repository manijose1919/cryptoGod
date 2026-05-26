// Canonical strategy backtest types.
// Deliberately minimal — these are pure textbook implementations of the
// strategies in docs (MA Crossover, RSI Reversal, Bollinger MR, MACD, Donchian
// Breakout). No composite scoring, no regime gates layered on top, no
// portfolio-level guards. The goal is to measure each signal's raw edge.

import type { Candle } from '../../pipeline/types.ts';

export type CanonicalStrategyName =
  | 'MA_CROSS'
  | 'RSI_REVERSAL'
  | 'BOLLINGER_MR'
  | 'MACD'
  | 'DONCHIAN_BREAKOUT';

export interface EntryDecision {
  enter: boolean;
  stop: number;       // initial stop price (long-side)
  target: number;     // initial take-profit price; 0 = no fixed TP, trail only
  reason: string;
}

export interface StrategyContext {
  candles: Candle[];  // window: candles[0..i] inclusive of i
  i: number;          // current bar index (closed)
}

export interface CanonicalStrategy {
  name: CanonicalStrategyName;
  warmupBars: number;                              // min bars before evaluating
  evaluateEntry(ctx: StrategyContext): EntryDecision;
  // Returns updated stop or null (keep current). For trailing logic.
  updateStop?(ctx: StrategyContext, entryPrice: number, currentStop: number, peak: number): number;
}

export interface CanonicalTrade {
  strategy: CanonicalStrategyName;
  ticker: string;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'force_close';
  quantity: number;
  positionSizeUsd: number;
  pnlGross: number;
  pnlNet: number;
  feesPaid: number;
  holdBars: number;
}

export interface RunConfig {
  strategy: CanonicalStrategy;
  ticker: string;
  candles: Candle[];
  startBar: number;        // inclusive
  endBar: number;          // exclusive
  budget: number;          // starting USD
  positionPercent: number; // fraction of equity per trade
  feeRoundTrip: number;    // e.g., 0.0052 Kraken taker
  slippagePerSide: number; // e.g., 0.0005 (5 bps)
}

export interface RunResult {
  strategy: CanonicalStrategyName;
  ticker: string;
  windowDays: number;
  trades: CanonicalTrade[];
  startBudget: number;
  endEquity: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlNet: number;
  totalPnlPercent: number;
  profitFactor: number;     // grossWins / |grossLosses|
  avgWin: number;
  avgLoss: number;
  maxDrawdownPercent: number;
  avgHoldBars: number;
}
