// ============================================
// Phoenix V2 Backtest Types
// ============================================

import type { SignalSnapshot, ExitReason, Regime } from '../pipeline/types.ts';

// --- Configuration ---

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  tickers: string[];
  budgetPerTicker: number;
  interval: string;       // '15m', '1h', etc.
  intervalMinutes: number; // 15, 60, etc.
  maxOpenPositions: number;
  feeRoundTrip: number;   // e.g. 0.0052 for Kraken taker
  seed: boolean;
}

// --- Trade Record ---

export interface BacktestTrade {
  id: string;
  ticker: string;
  side: 'long' | 'short';
  entryBar: number;        // bar index in candle array
  entryPrice: number;
  entryTime: number;       // Unix ms
  entrySignals: SignalSnapshot;
  entryRegime: Regime;
  entryConfidence: number;
  compositeScore: number;
  exitBar: number | null;
  exitPrice: number | null;
  exitTime: number | null;
  exitReason: ExitReason | null;
  quantity: number;
  positionSizeUsd: number;
  stopLoss: number;        // initial SL
  takeProfit: number;
  currentStop: number;     // tracks SL tightening
  trailingActivated: boolean;
  peakPrice: number;       // highest price seen since entry (for accurate peak PnL)
  pnlGross: number | null;
  pnlNet: number | null;
  feesPaid: number;
  holdBars: number;        // bars held
  holdDurationMs: number | null;
  atrPercent: number;      // ATR% at entry
}

// --- Aggregated Results ---

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  signalScores: SignalScoreResult[];
  regimeBreakdown: RegimeBreakdown[];
  tickerBreakdown: TickerBreakdown[];
}

export interface BacktestSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlNet: number;
  totalPnlPercent: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  avgHoldBars: number;
  avgHoldDurationMs: number;
  bestTrade: BacktestTrade | null;
  worstTrade: BacktestTrade | null;
}

export interface SignalScoreResult {
  signalName: string;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  avgPnlWhenActive: number;
  avgPnlWhenInactive: number;
  edge: number;
  verdict: 'proven' | 'negative' | 'inconclusive';
}

export interface RegimeBreakdown {
  regime: string;
  trades: number;
  winRate: number;
  totalPnl: number;
}

export interface TickerBreakdown {
  ticker: string;
  trades: number;
  winRate: number;
  totalPnl: number;
}
