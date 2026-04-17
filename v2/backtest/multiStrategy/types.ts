import type { SignalSnapshot, Regime, ExitReason } from '../../pipeline/types.ts';

export type StrategyType = 'TREND' | 'BREAKOUT' | 'MEAN_REVERSION' | 'MOMENTUM' | 'SCALP';

export interface StrategyExitParams {
  stopLossMethod: 'atr' | 'fixed_percent' | 'breakout_level';
  stopLossValue: number;
  takeProfitMethod: 'atr' | 'fixed_percent' | 'mean_target' | 'none';
  takeProfitValue: number;
  trailingMethod: 'percent_giveback' | 'chandelier' | 'histogram_decay' | 'none';
  trailingActivatePercent: number;
  trailingParam: number;
  timeKillBars: number;
  timeKillMinMove: number;
  breakEvenEnabled: boolean;
  breakEvenTriggerPercent: number;
  breakEvenOffsetPercent: number;
  quickKillEnabled: boolean;
  quickKillAfterBars: number;
  quickKillMinGain: number;
  quickKillSlTighten: number;
}

export interface StrategyConfig {
  name: StrategyType;
  enabled: boolean;
  allowedRegimes: string[];
  allowedTimeframes: string[];
  positionSizePercent: number;
  maxPositionPercent: number;
  maxOpenPositions: number;
  entryParams: Record<string, number>;
  exitParams: StrategyExitParams;
}

export interface EntrySignal {
  shouldEnter: boolean;
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
  metadata: Record<string, number>;
}

export interface MSTrade {
  id: string;
  strategy: StrategyType;
  ticker: string;
  timeframe: string;
  entryBar: number;
  entryPrice: number;
  entryTime: number;
  entryRegime: string;
  entryConfidence: number;
  exitBar: number | null;
  exitPrice: number | null;
  exitTime: number | null;
  exitReason: string | null;
  quantity: number;
  positionSizeUsd: number;
  stopLoss: number;
  takeProfit: number;
  currentStop: number;
  trailingActivated: boolean;
  peakPrice: number;
  peakHistogram: number;
  pnlGross: number | null;
  pnlNet: number | null;
  feesPaid: number;
  holdBars: number;
  holdDurationMs: number | null;
  atrPercent: number;
  metadata: Record<string, number>;
}

export interface StrategySummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlNet: number;
  totalPnlPercent: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  avgHoldBars: number;
}

export interface StrategyResult {
  strategy: StrategyType;
  timeframe: string;
  budget: number;
  trades: MSTrade[];
  summary: StrategySummary;
  exitBreakdown: { reason: string; count: number; totalPnl: number; avgPnl: number }[];
  tickerBreakdown: { ticker: string; trades: number; winRate: number; totalPnl: number }[];
  regimeBreakdown: { regime: string; trades: number; winRate: number; totalPnl: number }[];
}

export interface MSReport {
  results: StrategyResult[];
  comparison: ComparisonRow[];
}

export interface ComparisonRow {
  strategy: StrategyType;
  timeframe: string;
  trades: number;
  winRate: string;
  pnl: string;
  pnlPercent: string;
  profitFactor: string;
  avgWin: string;
  avgLoss: string;
  maxDD: string;
}
