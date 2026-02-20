
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorData {
  time: number;
  value: number;
  close: number;
}

export interface Position {
  quantity: number;
  openPrice: number;
  ticker: string;
  entryStrategy: TradingStrategy;
  entryTime: number;
  highestPrice: number; // For trailing stop
  lowestPrice: number;  // For tracking
  exitStage: number;        // 0=no exits, 1=first partial, 2=second partial, 3=fully exited
  originalQuantity: number; // Tracks initial size for partial exit % calculations
}

// Slow Market Detection Result
export interface SlowMarketResult {
  isSlow: boolean;
  avgRange: number;
  consecutiveSmallCandles: number;
}

export interface CryptoHolding {
  quantity: number;
  usdValue: number;
  price?: number;
}

export interface PortfolioState {
  cash: number;
  initialBudget: number;
  positions: Record<string, Position>;
  holdings?: Record<string, CryptoHolding>;
}

export interface SystemEvent {
  id: number;
  time: number;
  message: string;
  type: 'BUY' | 'SELL' | 'INFO' | 'ERROR' | 'SPECIAL';
}

export interface Trade {
  id: number;
  time: number;
  type: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  ticker: string;
  strategy: TradingStrategy;
  reason: string;
  pnl?: number; // Only for SELL trades
}

export type TradingStrategy = 'TREND' | 'BREAKOUT' | 'WHALE' | 'CONFLUENCE' | 'MOMENTUM' | 'DIVERGENCE' | 'ADAPTIVE' | 'MA_CROSSOVER' | 'MEAN_REVERSION' | 'REVERSAL' | 'RANGE' | 'VWAP';

export type TradingMode = 'SIMULATION' | 'REAL';

export type BrokerType = 'CRYPTO_COM' | 'QUESTRADE';

export type QuestradeExchange = 'TSX' | 'TSXV' | 'CSE' | 'NEO' | 'NYSE' | 'NASDAQ';

export interface QuestradeSymbol {
    symbol: string;
    symbolId: number;
    description: string;
    exchange: string;
    securityType: string;
    isActive: boolean;
}

export interface QuestradeQuote {
    symbol: string;
    symbolId: number;
    lastTradePrice: number;
    bidPrice: number;
    askPrice: number;
    volume: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
}

export interface QuestradePosition {
    symbol: string;
    symbolId: number;
    openQuantity: number;
    currentMarketValue: number;
    currentPrice: number;
    averageEntryPrice: number;
    openPnl: number;
    dayPnl: number;
}

export interface QuestradeAccount {
    type: string;
    number: string;
    status: string;
    isPrimary: boolean;
}

export interface QuestradeBalance {
    cash: number;
    marketValue: number;
    totalEquity: number;
    buyingPower: number;
}

export interface ApiCredentials {
    apiKey: string;
    secretKey: string;
    twoFactorCode: string;
}

export interface TrendDashboardData {
    rsi: boolean;
    stoch: boolean;
    macd: boolean;
    ma50: boolean;
    ma100: boolean;
    ma200: boolean;
    score: number;
    ma50Values?: number[];
    ma100Values?: number[];
    ma200Values?: number[];
    rsiValue?: number;
    stochValue?: number;
    macdHistogram?: number;
}

export interface SRLevels {
    support: number | null;
    resistance: number | null;
}

// New: RSI Divergence Detection
export interface DivergenceData {
    type: 'bullish' | 'bearish' | 'none';
    strength: number; // 0-100
    priceDirection: 'up' | 'down' | 'flat';
    rsiDirection: 'up' | 'down' | 'flat';
    confidence: number; // 0-100
}

// New: Momentum Indicator Data
export interface MomentumData {
    value: number; // -100 to 100
    trend: 'accelerating' | 'decelerating' | 'neutral';
    strength: number; // 0-100
    crossover: 'bullish' | 'bearish' | 'none';
}

// New: Volume Profile Data
export interface VolumeProfileData {
    poc: number; // Point of Control - highest volume price
    valueAreaHigh: number;
    valueAreaLow: number;
    volumeStrength: number; // 0-100, current volume vs average
    buyPressure: number; // 0-100
}

// New: Combined Signal Score
export interface SignalScore {
    overall: number; // -100 (extreme bearish) to 100 (extreme bullish)
    confidence: number; // 0-100
    signals: {
        trend: number;
        breakout: number;
        whale: number;
        confluence: number;
        momentum: number;
        divergence: number;
    };
}

export type WatchlistData = Record<string, {
  candles: Candle[];
  indicatorData: IndicatorData[];
  breakoutData: IndicatorData[];
  whaleData: IndicatorData[];
  momentumData: IndicatorData[];
  adaptiveData: IndicatorData[];
  divergenceData: DivergenceData;
  volumeProfileData: VolumeProfileData;
  trendDashboardData: TrendDashboardData;
  srLevels: SRLevels;
  signalScore: SignalScore;
  bollingerBands: {
    upper: IndicatorData[];
    middle: IndicatorData[];
    lower: IndicatorData[];
  };
  vwap: IndicatorData[];
  ma50: IndicatorData[];
  ma200: IndicatorData[];
  lastUpdated: number;
}>;

export type MTFData = Record<string, number>;

export type ScannerInsight = {
  ticker: string;
  score: number;
  value: number;
};

export type ScannerInsights = Partial<Record<TradingStrategy, ScannerInsight[]>>;

// Bot Settings Interface
export interface BotSettings {
  strategy: TradingStrategy;
  riskAmount: number;
  profitGoals: Record<TradingStrategy, number>;
  sessionProfitGoal: number;
  maxConcurrentTrades: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  useTrailingStop: boolean;
  minSignalConfidence: number;
}

// WebSocket State
export interface WebSocketState {
  isConnected: boolean;
  reconnectAttempts: number;
  lastMessageTime: number;
}

// Adaptive TC Data (from TC Adaptive Trades in Favor)
export interface AdaptiveData {
  tcValue: number;
  probabilityText: string;
  probabilityPercent: number;
  direction: 'PUMP' | 'DROP' | 'NEUTRAL';
  assetParams: {
    lookback: number;
    noiseFilter: number;
    description: string;
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  confidence: number;
}

// Heat Map Entry for multi-asset view
export interface HeatMapEntry {
  ticker: string;
  tcValue: number;
  adaptiveValue: number;
  probabilityText: string;
  direction: 'PUMP' | 'DROP' | 'NEUTRAL';
  momentum: number;
  whaleFlow: number;
  confluenceScore: number;
  overallScore: number;
}

// Asset Correlation Data
export interface CorrelationData {
  asset1: string;
  asset2: string;
  correlation: number;
  strength: 'STRONG_POSITIVE' | 'MODERATE_POSITIVE' | 'WEAK' | 'MODERATE_NEGATIVE' | 'STRONG_NEGATIVE';
}

// Multi-Asset Analysis
export interface MultiAssetAnalysis {
  heatMap: HeatMapEntry[];
  correlations: CorrelationData[];
  topBullish: HeatMapEntry[];
  topBearish: HeatMapEntry[];
  marketSentiment: number; // -100 to 100
}

// ============================================
// NEW: SMART TRADING FEATURES
// ============================================

// Market Regime Detection
export interface MarketRegime {
  trend: 'STRONG_UP' | 'UP' | 'SIDEWAYS' | 'DOWN' | 'STRONG_DOWN';
  volatility: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  momentum: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  atrPercent: number; // ATR as % of price
  trendStrength: number; // 0-100
  volatilityPercentile: number; // 0-100, where current volatility ranks historically
  recommendedStrategy: TradingStrategy;
  tradingCondition: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'AVOID';
}

// Gap Detection
export interface GapData {
  hasGap: boolean;
  gapType: 'GAP_UP' | 'GAP_DOWN' | 'NONE';
  gapPercent: number; // Size of gap as %
  gapFilled: boolean; // Has price returned to fill the gap?
  gapPrice: number; // Price level of the gap
  isBreakawayGap: boolean; // Gap with high volume = likely continuation
  fillProbability: number; // 0-100, likelihood gap will fill
}

// Opportunity Score for prioritizing trades
export interface OpportunityScore {
  ticker: string;
  compositeScore: number; // 0-100, overall opportunity rating
  urgency: 'IMMEDIATE' | 'SOON' | 'WATCH' | 'WAIT';
  confidence: number; // 0-100
  expectedReturn: number; // Estimated % return
  riskRewardRatio: number; // R:R ratio
  timeDecay: number; // How quickly opportunity diminishes (0-100)
  factors: {
    trendAlignment: number;
    momentumStrength: number;
    volumeConfirmation: number;
    priceLocation: number; // Near support/resistance
    gapOpportunity: number;
    multiTimeframeAlignment: number;
  };
}

// Dynamic Trading Parameters
export interface DynamicTradingParams {
  adjustedMaxTrades: number; // Dynamic max concurrent trades
  adjustedRiskAmount: number; // Dynamic risk per trade
  adjustedStopLoss: number; // Dynamic stop loss %
  aggressivenessLevel: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' | 'ULTRA_AGGRESSIVE';
  reasonForAdjustment: string;
  marketConditionScore: number; // 0-100
}

// Session Analytics
export interface SessionAnalytics {
  sessionStartTime: number;
  sessionDuration: number; // ms
  estimatedSessionLength: 'SHORT' | 'MEDIUM' | 'LONG'; // Based on typical patterns
  timeRemaining?: number; // If goal-based session
  profitVelocity: number; // $ per hour
  requiredVelocity: number; // $ per hour needed to hit goal
  winRate: number; // 0-100
  consecutiveWins: number;
  consecutiveLosses: number;
  avgTradeTime: number; // ms
  tradesPerHour: number;
  isOnTrack: boolean; // Meeting session goals?
  recommendedAction: 'INCREASE_TRADES' | 'MAINTAIN' | 'REDUCE_RISK' | 'STOP_TRADING';
}

// Quick Profit Mode Settings
export interface QuickProfitMode {
  enabled: boolean;
  targetPercent: number; // Target profit % per trade
  maxHoldTime: number; // Max time to hold position (ms)
  scalpingMode: boolean; // Ultra-short-term trades
  dynamicTargets: boolean; // Adjust targets based on volatility
}

// ============================================
// ML Prediction Types
// ============================================
export interface MLPrediction {
  prediction: 'UP' | 'DOWN';
  confidence: number; // 0-1
  probabilities: { up: number; down: number };
  agreement?: number; // ensemble agreement 0-1
  modelVotes?: Array<{ type: string; prediction: string; confidence: number }>;
}

export interface MLModelStatus {
  isInitialized: boolean;
  isTrained: boolean;
  accuracy: number | null;
  sampleCount: number;
  predictionCount: number;
  lastTrainTime: number;
  featureCount: number;
  minSamplesToTrain: number;
  anomalyDetectorStatus?: {
    sampleCount: number;
    lastRetrained: number;
    anomalyRate: number;
  };
}

export interface MLFeatureImportance {
  name: string;
  importance: number;
  rank: number;
}

export interface AnomalyResult {
  isAnomaly: boolean;
  score: number;
  severity: 'NORMAL' | 'UNUSUAL' | 'EXTREME';
  recommendation: 'PROCEED' | 'REDUCE_SIZE' | 'PAUSE';
  anomalousFeatures?: Array<{ index: number; name: string; value: number; zScore: number }>;
}

export interface SmartMoneySignal {
  signal: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  whaleActivity: { whaleDetected: boolean; direction: string };
  exchangeDivergence: { divergencePercent: number; leader: string };
  smartMoneyFlow: { flow: string; confidence: number };
  liquidationRisk: { cascadeDetected: boolean; type: string };
  summary: string;
}

export interface AdaptiveThresholds {
  entryConfidence: number;
  profitTargetPercent: number;
  stopLossPercent: number;
  maxPositionPercent: number;
  mlConfidenceThreshold: number;
  [key: string]: number;
}

export interface SelfTeachingStatus {
  isRunning: boolean;
  totalTradesProcessed: number;
  retrainCount: number;
  lastRetrainTime: number;
  performanceHistory: Array<{ time: number; accuracy: number; sampleCount: number }>;
  improvementTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
}

export interface MultiExchangeSnapshot {
  ticker: string;
  binance?: { price: number; imbalance: number; spread: number; volume24h: number };
  okx?: { openInterest: number; fundingRate: number; basis: number };
  fearGreed?: { value: number; classification: string };
  defi?: { tvl: number; tvlChange: number; dexVolume: number };
}

export interface SentimentData {
  newsScore: number;
  redditScore: number;
  fearGreedValue: number;
  fearGreedClassification: string;
  socialMomentum: boolean;
  overallSentiment: 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';
}

// ============================================
// HISTORICAL TRAINING (TIME MACHINE) TYPES
// ============================================

export interface TrainingDownloadStatus {
  active: boolean;
  startTime: number | null;
  elapsed: number;
  pairs: Record<string, { status: string; downloaded: number; timeframes?: Record<string, { downloaded: number; status: string; error?: string }> }>;
  timeframes?: Record<string, { status: string; totalCandles: number }>;
  fearGreed: { status: string; count: number; error?: string };
  defiTvl: { status: string; count: number; error?: string };
  currentTicker?: string;
  currentTimeframe?: string;
  selectedTimeframes?: string[];
  progress?: number;
  completedRequests?: number;
  totalRequestsEstimate?: number;
}

export interface TrainingDataSummary {
  pairs: Record<string, { count: number; totalCount?: number; earliest: string | null; latest: string | null; timeframes?: Record<string, { count: number; earliest: string | null; latest: string | null }> }>;
  timeframeSummary?: Record<string, { totalCandles: number; pairsWithData: number }>;
  totalCandles?: number;
  fearGreed: number;
  defiTvl: number;
}

export interface TrainingProgress {
  currentStep: number;
  totalSteps: number;
  currentDate: string;
  pct: number;
}

export interface TrainingStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  bestTrade: number;
  worstTrade: number;
  totalFees: number;
  maxDrawdown: number;
  winRate: number;
}

export interface TrainingStrategyBreakdown {
  [strategy: string]: {
    wins: number;
    losses: number;
    pnl: number;
  };
}

export interface TrainingTrade {
  id: number;
  run_id: string;
  time: number;
  type: 'BUY' | 'SELL';
  ticker: string;
  strategy: string;
  price: number;
  quantity: number;
  pnl: number;
  pnl_percent: number;
  fee: number;
  balance_after: number;
  regime: string;
  composite_score: number;
}

export interface TrainingEquityPoint {
  time: number;
  total_value: number;
  cash: number;
  holdings_value: number;
  open_positions: number;
  drawdown: number;
}

export interface TrainingStatus {
  active: boolean;
  runId?: string;
  status?: string;
  progress?: TrainingProgress;
  stats?: TrainingStats;
  equity?: { peak: number; current: number };
  strategyBreakdown?: TrainingStrategyBreakdown;
  recentTrades?: TrainingTrade[];
  elapsed?: number;
  epoch?: number;
  seedRunId?: string | null;
  error?: string;
}

export interface TrainingRun {
  id: number;
  run_id: string;
  status: string;
  config_json: string;
  start_time: number;
  end_time: number | null;
  current_step: number;
  total_steps: number;
  current_date: string;
  total_trades: number;
  win_rate: number;
  total_pnl: number;
  max_drawdown: number;
  sharpe_ratio: number;
  final_equity: number;
  created_at: number;
}

export interface TrainingResults {
  run: TrainingRun;
  stats: {
    total_trades: number;
    sells: number;
    wins: number;
    losses: number;
    total_pnl: number;
    avg_pnl: number;
    best_trade: number;
    worst_trade: number;
    total_fees: number;
  };
  learnedState: {
    adaptiveWeights: Record<string, { wins: number; losses: number; totalPnl: number; weight: number }>;
    circuitBreaker: { totalTrades: number; totalWins: number; totalLosses: number };
    strategyBreakdown: TrainingStrategyBreakdown;
  } | null;
  strategyWeights: TrainingStrategyBreakdown | null;
}
