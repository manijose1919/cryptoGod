// ============================================
// Phoenix V2 Pipeline Types
// ============================================

// --- Const enums (as const objects, no TS enums) ---

export const V2_MODE = {
  shadow: 'shadow',
  paper: 'paper',
  live: 'live',
} as const;
export type V2Mode = typeof V2_MODE[keyof typeof V2_MODE];

export const TRADE_STATUS = {
  open: 'open',
  closed: 'closed',
  cancelled: 'cancelled',
} as const;
export type TradeStatus = typeof TRADE_STATUS[keyof typeof TRADE_STATUS];

export const EXIT_REASON = {
  stop_loss: 'stop_loss',
  take_profit: 'take_profit',
  trailing: 'trailing',
  time_kill: 'time_kill',
  manual: 'manual',
} as const;
export type ExitReason = typeof EXIT_REASON[keyof typeof EXIT_REASON];

export const PIPELINE_STAGE = {
  scan: 'scan',
  signal: 'signal',
  risk: 'risk',
  execute: 'execute',
  exit: 'exit',
  analyze: 'analyze',
} as const;
export type PipelineStage = typeof PIPELINE_STAGE[keyof typeof PIPELINE_STAGE];

export const DECISION = {
  pass: 'pass',
  reject: 'reject',
  execute: 'execute',
} as const;
export type Decision = typeof DECISION[keyof typeof DECISION];

export const REGIME = {
  STRONG_UP: 'STRONG_UP',
  UP: 'UP',
  SIDEWAYS: 'SIDEWAYS',
  DOWN: 'DOWN',
  STRONG_DOWN: 'STRONG_DOWN',
  PULLBACK_UP: 'PULLBACK_UP',
} as const;
export type Regime = typeof REGIME[keyof typeof REGIME];

// --- Core Data Interfaces ---

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DecisionRecord {
  tradeId: string;
  stage: PipelineStage;
  timestamp: number;
  decision: Decision;
  reason: string;
  signals: Record<string, number>;
  thresholds: Record<string, number>;
  confidence: number;
}

export interface SignalSnapshot {
  rsi: number;
  macd_value: number;
  macd_signal: number;
  macd_histogram: number;
  macd_cross: boolean;
  ema_12: number;
  ema_26: number;
  ema_50: number;
  atr: number;
  atr_percent: number;
  bb_upper: number;
  bb_lower: number;
  bb_width: number;
  bb_percent_b: number;
  volume_ratio: number;
  trend_strength: number;
  price_vs_ema50: number;
  // TC (Trend Composite) indicators — ported from PineScript
  tc_value: number;           // TC oscillator 0-100 (below 20 = buy, above 80 = sell)
  tc_zone: string;            // 'buy' | 'sell' | 'neutral'
  tc_consensus: number;       // Multi-timeframe TC consensus 0-100 (high = bullish)
  // Support/Resistance
  sr_channel_position: number; // 0 = at support, 1 = at resistance
  sr_support_distance: number; // Distance to nearest support as %
  sr_resistance_distance: number; // Distance to nearest resistance as %
  // Trend Dashboard
  td_score: number;           // 0-100 based on 6 indicators (RSI, Stoch, MACD, SMA50/100/200)
  td_bullish_count: number;   // 0-6 bullish indicator count
  [key: string]: number | boolean | string;
}

// --- Pipeline Stage Results ---

export interface ScanResult {
  ticker: string;
  passed: boolean;
  regime: Regime;
  atrPercent: number;
  volumeUsd24h: number;
  spreadPercent: number;
  reason?: string;
}

export interface SignalResult {
  ticker: string;
  passed: boolean;
  compositeScore: number;
  confidence: number;
  signals: SignalSnapshot;
  regime: Regime;
  side?: 'long' | 'short';
  reason?: string;
}

export interface RiskResult {
  ticker: string;
  passed: boolean;
  positionSizeUsd: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  expectedReturn: number;
  side?: 'long' | 'short';
  reason?: string;
}

// --- Trade Lifecycle ---

export interface V2Trade {
  id: string;
  ticker: string;
  side: 'long' | 'short';
  status: TradeStatus;
  entryPrice: number;
  entryTime: number;
  entryOrderType: string;
  quantity: number;
  positionSizeUsd: number;
  exitPrice: number | null;
  exitTime: number | null;
  exitReason: ExitReason | null;
  pnlGross: number | null;
  pnlNet: number | null;
  feesPaid: number;
  holdDurationMs: number | null;
  initialStop: number;
  currentStop: number;
  takeProfitTarget: number;
  trailingActivated: boolean;
  entrySignals: SignalSnapshot;
  entryRegime: Regime;
  entryConfidence: number;
  atrPercent?: number;           // ATR% at entry — used for ATR-aware trailing stops
  peakPrice?: number;            // Highest price seen since entry — used by Chandelier exit
  peakHistogram?: number;        // Peak MACD histogram since entry — used by Momentum exit
  strategy?: string;             // 'TREND' | 'MEAN_REVERSION' | 'BREAKOUT' | 'MOMENTUM'
  timeframe?: string;            // entry timeframe ('30m'|'1h'|'4h'...) — scales per-strategy time-kill/quick-kill bars to real time
  stopOrderId?: string | null;   // C2: native exchange stop-loss order id; cancel before market-sell on managed exit
  decisionLog: DecisionRecord[];
  createdAt: number;
}

// --- Signal Scoring ---

export interface SignalScore {
  signalName: string;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  avgPnlWhenActive: number;
  avgPnlWhenInactive: number;
  edge: number;
  lastUpdated: number;
}

// --- Portfolio State ---

export interface V2PortfolioState {
  openPositions: Map<string, V2Trade>;
  totalEquity: number;
  availableCapital: number;
  dailyPnl: number;
  dailyTradeCount: number;
  circuitBreakerActive: boolean;
  circuitBreakerUntil: number | null;
}

// --- Exit Check ---

export interface ExitCheck {
  shouldExit: boolean;
  reason: ExitReason | null;
  exitPrice: number;
  signals?: SignalSnapshot;
}
