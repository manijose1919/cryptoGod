
import type { TradingStrategy } from './types';

// ============================================
// TIME FRAME CONFIGURATIONS
// ============================================
export const TIME_FRAMES = ['5M', '15M', '30M', '1H', '4H', '1D', '1W'] as const;

export const TIME_FRAMES_MAP: Record<string, string> = {
    '5M': '5m',
    '15M': '15m',
    '30M': '30m',
    '1H': '1h',
    '4H': '4h',
    '1D': '1D',
    '1W': '7D',
};

// ============================================
// FALLBACK TICKERS (if API fails)
// ============================================
// Canadian-supported crypto pairs only (USD pairs - NO USDT)
// Note: USDC doesn't exist on Crypto.com Exchange API, using USD instead
export const FALLBACK_TICKERS = [
    'BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD'
];

// Allowed base currencies for Canadian accounts
export const CANADIAN_ALLOWED_BASES = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'ADA', 'DOGE', 'LINK', 'DOT', 'AVAX'];

// ============================================
// QUESTRADE / STOCK TRADING CONFIG
// ============================================
export const QUESTRADE_EXCHANGES = {
    TSX: { name: 'Toronto Stock Exchange', suffix: '.TO' },
    TSXV: { name: 'TSX Venture Exchange', suffix: '.V' },
    CSE: { name: 'Canadian Securities Exchange', suffix: '' },
    NEO: { name: 'NEO Exchange', suffix: '' },
    NYSE: { name: 'New York Stock Exchange', suffix: '' },
    NASDAQ: { name: 'NASDAQ', suffix: '' },
} as const;

export const QUESTRADE_CONFIG = {
    MARKET_OPEN_HOUR: 9,
    MARKET_OPEN_MIN: 30,
    MARKET_CLOSE_HOUR: 16,
    MARKET_CLOSE_MIN: 0,
    PRE_MARKET_OPEN: 7,
    AFTER_HOURS_CLOSE: 20,
    POLL_INTERVAL_MS: 5000,
    BOT_LOOP_MS: 5000,
    MIN_CANDLES_REQUIRED: 50,
    PAPER_INITIAL_BALANCE: 100000,
} as const;

export const QUESTRADE_INTERVALS: Record<string, string> = {
    '1m': 'OneMinute',
    '2m': 'TwoMinutes',
    '3m': 'ThreeMinutes',
    '5m': 'FiveMinutes',
    '10m': 'TenMinutes',
    '15m': 'FifteenMinutes',
    '20m': 'TwentyMinutes',
    '30m': 'HalfHour',
    '1h': 'OneHour',
    '2h': 'TwoHours',
    '4h': 'FourHours',
    '1d': 'OneDay',
    '1w': 'OneWeek',
    '1M': 'OneMonth',
};

// ============================================
// TRADING THRESHOLDS & SIGNALS
// ============================================
export const SIGNAL_THRESHOLDS = {
    // TREND Strategy (TC Score)
    TREND_BULLISH_ENTRY: 30,      // Enter when TC < 30 (oversold)
    TREND_BEARISH_EXIT: 70,       // Exit when TC > 70 (overbought)
    TREND_STRONG_BULLISH: 20,     // Strong buy signal
    TREND_STRONG_BEARISH: 80,     // Strong sell signal

    // BREAKOUT Strategy (Volatility RSI)
    BREAKOUT_SQUEEZE_ENTRY: 25,   // Enter when squeeze detected (low volatility)
    BREAKOUT_EXPANSION_EXIT: 55,  // Exit when volatility expands
    BREAKOUT_EXTREME_SQUEEZE: 15, // Very tight squeeze - strong signal

    // WHALE Strategy (Money Flow)
    WHALE_BUYING_ENTRY: 60,       // Enter when whales buying
    WHALE_SELLING_EXIT: 40,       // Exit when whales selling
    WHALE_STRONG_BUYING: 75,      // Very strong whale accumulation
    WHALE_STRONG_SELLING: 25,     // Very strong whale distribution

    // CONFLUENCE Strategy (Multi-indicator score)
    CONFLUENCE_BULLISH_ENTRY: 4,  // Enter when 4+ indicators bullish
    CONFLUENCE_BEARISH_EXIT: 2,   // Exit when 2 or fewer bullish
    CONFLUENCE_STRONG_BULLISH: 5, // Very strong alignment
    CONFLUENCE_STRONG_BEARISH: 1, // Very bearish alignment

    // MOMENTUM Strategy (new)
    MOMENTUM_BULLISH_ENTRY: 20,   // Positive momentum threshold
    MOMENTUM_BEARISH_EXIT: -20,   // Negative momentum threshold
    MOMENTUM_STRONG_BULLISH: 50,  // Strong upward momentum
    MOMENTUM_STRONG_BEARISH: -50, // Strong downward momentum

    // DIVERGENCE Strategy (new)
    DIVERGENCE_MIN_CONFIDENCE: 60, // Minimum confidence for divergence trade
    DIVERGENCE_STRONG_SIGNAL: 80,  // High confidence divergence

    // ADAPTIVE Strategy (TC Adaptive Trades in Favor)
    ADAPTIVE_BULLISH_ENTRY: 30,    // Enter when adaptive TC < 30
    ADAPTIVE_BEARISH_EXIT: 70,     // Exit when adaptive TC > 70
    ADAPTIVE_EXTREME_BULLISH: 5,   // 99% pump probability
    ADAPTIVE_EXTREME_BEARISH: 95,  // 99% drop probability
} as const;

// ============================================
// TRADING FEES (Crypto.com Exchange)
// ============================================
export const TRADING_FEES = {
    TAKER_FEE_PERCENT: 0.075,      // Crypto.com taker fee per side
    ROUND_TRIP_FEE_PERCENT: 0.15,  // Total buy + sell fees
    FEE_BUFFER_PERCENT: 0.10,      // Slippage buffer
    ESTIMATED_SLIPPAGE_PERCENT: 0.10, // Estimated slippage per trade
    BID_ASK_SPREAD_PERCENT: 0.05,    // Typical bid-ask spread cost
    TOTAL_COST_PER_TRADE: 0.30,      // Total: fees + slippage + spread (round trip)
} as const;

// ============================================
// KRAKEN FEES
// ============================================
export const KRAKEN_FEES = {
    TAKER_FEE_PERCENT: 0.26,       // Kraken taker fee per side (base tier)
    MAKER_FEE_PERCENT: 0.16,       // Kraken maker fee per side (limit orders)
    ROUND_TRIP_FEE_PERCENT: 0.52,  // Total buy + sell taker fees
    ROUND_TRIP_MAKER_PERCENT: 0.32, // Total buy + sell maker fees
    FEE_BUFFER_PERCENT: 0.10,      // Slippage buffer
    ESTIMATED_SLIPPAGE_PERCENT: 0.15, // Kraken typically has wider spreads
    BID_ASK_SPREAD_PERCENT: 0.08,    // Typical bid-ask spread cost
    TOTAL_COST_PER_TRADE: 0.75,      // Total: fees + slippage + spread (round trip)
} as const;

// ============================================
// KRAKEN-OPTIMIZED TRADING CONFIG
// ============================================
export const KRAKEN_OPTIMIZED = {
    // Minimum profit targets (must exceed round-trip fees)
    MIN_PROFIT_TARGET_TAKER: 0.92,   // 0.52% fees + 0.10% slippage + 0.30% min profit
    MIN_PROFIT_TARGET_MAKER: 0.72,   // 0.32% fees + 0.10% slippage + 0.30% min profit

    // Smart order routing
    LIMIT_ORDER_SPREAD_THRESHOLD: 0.10, // Use limit orders when spread > 0.1%
    LIMIT_ORDER_WAIT_MS: 10000,         // Wait 10s for limit fill
    LIMIT_ORDER_PRICE_OFFSET: 0.01,     // Place at best bid/ask + 0.01%

    // Small account optimizations ($20-$200)
    MICRO_ACCOUNT_THRESHOLD: 200,       // Below this = micro account mode
    MICRO_MAX_CONCURRENT: 3,            // Max 3 positions for micro accounts
    MICRO_POSITION_PERCENT: 40,         // Up to 40% per trade (need concentration)
    MICRO_MIN_TRADE_USD: 1.00,          // Kraken practical minimum

    // Partial exit adjustments for higher fees
    PARTIAL_EXIT_STAGE_1_TARGET: 0.92,  // First partial at fee floor
    PARTIAL_EXIT_STAGE_2_TARGET: 2.00,  // Second partial at 2%
    PARTIAL_EXIT_STAGE_3_TRAIL: 1.0,    // Start trailing at 1%

    // Timeframe preferences for Kraken
    PREFERRED_TIMEFRAMES: ['5m', '15m', '1h', '4h'],
    SCALPING_TIMEFRAME: '5m',           // 5m for scalping (1m too noisy with higher fees)
} as const;

// ============================================
// PARTIAL EXIT (3-STAGE EXIT SYSTEM)
// ============================================
export const PARTIAL_EXIT = {
    ENABLED: true,
    STAGE_1_PERCENT: 30,           // Sell 30% of position
    STAGE_1_TARGET: 0.50,          // At +0.50% profit after fees
    STAGE_2_PERCENT: 40,           // Sell 40% of position
    STAGE_2_TARGET: 1.50,          // At +1.50% profit after fees
    STAGE_3_TRAILING_START: 1.5,   // Start trailing at 1.5% profit
    STAGE_3_TRAILING_TIGHT: 0.75,  // Tighten to 0.75% as profit grows
} as const;

// ============================================
// ATR-BASED DYNAMIC EXIT STAGES (Upgrade #9)
// ============================================
export const ATR_EXIT_STAGES = {
    STAGE_1_ATR_MULT: 1.0,        // Exit 25% at 1.0× ATR profit
    STAGE_1_PERCENT: 25,
    STAGE_2_ATR_MULT: 2.0,        // Exit 35% at 2.0× ATR profit
    STAGE_2_PERCENT: 35,
    STAGE_3_TRAIL_ATR_MULT: 1.5,  // Trail remaining at 1.5× ATR below high-water mark
    STAGE_3_PERCENT: 40,          // Remaining 40%
    // Regime multipliers applied to ATR values
    REGIME_MULTIPLIERS: {
        SIDEWAYS: 0.75,           // Tighter exits in sideways markets
        UPTREND: 1.25,            // Wider exits in uptrends
        DOWNTREND: 0.5,           // Very tight exits in downtrends
        DEFAULT: 1.0,
    },
} as const;

// ============================================
// ML MODEL SIZE CONSTANTS (Upgrade #16)
// ============================================
export const ML_MODEL_SIZES = {
    RF_TREES: 150,                // Random Forest: 150 trees (was 50)
    GBT_ESTIMATORS: 250,         // Gradient Boosted Trees: 250 estimators (was 100)
    LSTM_HIDDEN_UNITS: 64,       // LSTM: 64 hidden units
    LSTM_SEQUENCE_LENGTH: 20,    // LSTM input: last 20 feature vectors
    RF_MAX_TREES: 200,           // Max RF trees before retiring oldest
    INCREMENTAL_TRIGGER: 20,    // Trigger incremental update every 20 new samples
} as const;

// ============================================
// SLOW MARKET DETECTION
// ============================================
export const SLOW_MARKET = {
    ENABLED: true,
    MIN_SMALL_CANDLES: 7,          // of last 10 candles
    SMALL_CANDLE_RANGE: 0.10,      // % threshold for "small" candle
    ATR_SLOW_THRESHOLD: 0.15,      // ATR as % of price
    PROFIT_TARGET_SLOW: 0.35,      // % (above 0.15% fees)
    STOP_LOSS_SLOW: 2.5,           // % (wider to avoid whipsaws)
    TRAILING_STOP_SLOW: 1.5,       // %
    ALLOWED_STRATEGIES: ['RANGE', 'MEAN_REVERSION', 'ADAPTIVE', 'DIVERGENCE'] as readonly string[],
} as const;

// ============================================
// REGIME → STRATEGY MAP
// ============================================
export const REGIME_STRATEGY_MAP: Record<string, readonly string[]> = {
    STRONG_UP:    ['TREND', 'MOMENTUM', 'BREAKOUT', 'CONFLUENCE', 'ADAPTIVE'],
    UP:           ['TREND', 'MOMENTUM', 'BREAKOUT', 'CONFLUENCE', 'ADAPTIVE'],
    SIDEWAYS:     ['RANGE', 'MEAN_REVERSION', 'ADAPTIVE', 'DIVERGENCE'],
    DOWN:         ['REVERSAL', 'DIVERGENCE', 'ADAPTIVE'],
    STRONG_DOWN:  ['REVERSAL', 'DIVERGENCE', 'ADAPTIVE'],
    VOLATILE:     ['ADAPTIVE'],
} as const;

// ============================================
// ML CONFIGURATION
// ============================================
export const ML_CONFIG = {
    MIN_SAMPLES_TO_TRAIN: 100,
    RETRAIN_INTERVAL_MS: 60 * 60 * 1000,       // 1 hour
    RETRAIN_SAMPLE_THRESHOLD: 200,
    ML_CONFIDENCE_THRESHOLD: 60,                 // ML must be this confident to override
    ANOMALY_POSITION_REDUCTION: 0.5,             // Reduce position by 50% on anomaly
    FEATURE_COUNT: 91,  // 83 base + 8 on-chain features
    ENSEMBLE_MODELS: ['gradient_boosted', 'random_forest', 'logistic_regression'],
    MAX_TRAINING_SAMPLES: 5000,
    ADAPTIVE_THRESHOLD_SMOOTHING: 0.3,           // Apply 30% of computed adjustment
    ADAPTIVE_MAX_DRIFT_PERCENT: 50,              // Max drift from defaults
} as const;

// ============================================
// RISK MANAGEMENT DEFAULTS
// ============================================
export const RISK_DEFAULTS = {
    DEFAULT_STOP_LOSS_PERCENT: 3,       // 3% stop loss
    DEFAULT_TRAILING_STOP_PERCENT: 2,   // 2% trailing stop
    MIN_TRADE_SIZE_USD: 1.00,           // Minimum trade size (Crypto.com practical minimum)
    MAX_POSITION_PERCENT: 20,           // Max 20% of portfolio per position
    MAX_CORRELATED_EXPOSURE: 35,        // Max 35% of portfolio in correlated assets
    DEFAULT_RISK_AMOUNT: 1.0,           // Risk multiplier (1.0 = 100%)
    MAX_CONCURRENT_TRADES: 5,           // Default max positions (0 = unlimited)
    MIN_SIGNAL_CONFIDENCE: 30,          // Minimum confidence to trade
    MIN_CANDLE_VOLUME_USD: 5000,        // Skip tickers with < $5K average candle volume
    MAX_DRAWDOWN_FROM_PEAK: 15,         // Kill switch: stop trading at 15% drawdown from peak
} as const;

// ============================================
// MICRO-TRADING / SCALPING PARAMETERS
// ============================================
export const MICRO_TRADING = {
    // Scalping thresholds (more sensitive for small moves)
    MICRO_PROFIT_TARGET_PERCENT: 0.75,   // 0.75% profit target (0.50% after fees)
    MICRO_STOP_LOSS_PERCENT: 1.0,        // 1.0% stop loss (give dips room to recover)
    MICRO_TRAILING_STOP_PERCENT: 0.40,   // 0.40% trailing stop (only after breakeven+fees)

    // Slow market detection
    SLOW_MARKET_VOLATILITY_THRESHOLD: 0.3, // Below this ATR% = slow market
    SLOW_MARKET_VOLUME_THRESHOLD: 0.5,     // Below 50% avg volume = slow market

    // Micro-trade entry signals (more sensitive)
    MICRO_TC_ENTRY_THRESHOLD: 40,        // Enter when TC < 40 (less strict)
    MICRO_TC_EXIT_THRESHOLD: 60,         // Exit when TC > 60 (quicker exit)
    MICRO_MOMENTUM_ENTRY: 10,            // Lower momentum threshold
    MICRO_WHALE_ENTRY: 55,               // Lower whale threshold

    // Bot loop speed in micro mode
    MICRO_BOT_LOOP_MS: 2000,             // 2 seconds for faster execution

    // Auto-scaling position sizes
    MICRO_MIN_POSITION_PERCENT: 5,       // Min 5% of cash per micro trade
    MICRO_MAX_POSITION_PERCENT: 15,      // Max 15% of cash per micro trade

    // Trade frequency
    MAX_MICRO_TRADES_PER_MINUTE: 10,     // Rate limit for micro trades
    MICRO_COOLDOWN_MS: 6000,             // 6 seconds between trades on same asset
} as const;

// ============================================
// SURGE TRADING PARAMETERS
// ============================================
export const SURGE_TRADING = {
    // Bot loop speed - FAST for catching surges
    SURGE_BOT_LOOP_MS: 1000,            // 1 second loop for surge detection

    // Surge detection thresholds
    MIN_SURGE_CONFIDENCE: 35,            // Minimum confidence to act on surge
    SURGE_VOLUME_MULTIPLIER: 1.3,        // Volume must be 1.3x average for surge
    SURGE_PRICE_CHANGE_TRIGGER: 0.3,     // 0.3% price change triggers surge check

    // Dip buying
    MIN_DIP_PERCENT: 0.5,               // Minimum dip to consider buying
    DIP_RECOVERY_TRIGGER: 0.3,          // 30% recovery from low triggers entry
    DIP_BUY_CONFIDENCE_MIN: 35,         // Minimum confidence for dip buy

    // Trend riding
    TREND_RIDE_MIN_STRENGTH: 40,        // Minimum trend strength to ride
    TREND_BREAKOUT_BOOST: 20,           // Confidence boost for breakout
    TREND_ALLOCATION_MULTIPLIER: 1.5,   // 50% more capital on trend trades

    // Candlestick patterns
    PATTERN_MIN_STRENGTH: 60,           // Minimum pattern strength to act
    MULTI_PATTERN_BONUS: 15,            // Bonus when multiple patterns confirm

    // Position sizing for surge trades
    SURGE_MIN_POSITION_PERCENT: 5,      // Min 5% of cash on surge
    SURGE_MAX_POSITION_PERCENT: 20,     // Max 20% of cash on surge
    TREND_POSITION_MULTIPLIER: 1.2,     // 20% more on strong trends

    // Quick profit targets
    SURGE_PROFIT_TARGET: 1.0,           // 1.0% profit target (0.85% after fees)
    SURGE_STOP_LOSS: 1.5,              // 1.5% stop loss (allow dip recovery)
    TREND_PROFIT_TARGET: 2.0,          // 2.0% for trend trades (let winners run)
    TREND_TRAILING_STOP: 0.75,         // 0.75% trailing stop on trend trades

    // Data refresh
    CANDLE_REFRESH_MS: 3000,            // Refresh candle data every 3 seconds
    TREND_CHECK_INTERVAL_MS: 1000,      // Check trends every second
} as const;

// ============================================
// PROFIT METHODS CONFIGURATION
// ============================================
export const PROFIT_METHODS = {
    // Grid Trading
    GRID: {
        ENABLED: true,
        GRID_COUNT: 5,                     // Was 10: wider spacing to exceed 0.52% RT fees
        PORTFOLIO_ALLOCATION: 0.05,        // Was 0.15
        MIN_RANGE_PERCENT: 3.0,            // Was 1.0: need 3%+ range for 5 profitable levels
        RECALC_BUFFER_PERCENT: 20,         // Was 10
    },

    // Smart DCA
    DCA: {
        ENABLED: true,
        INTERVAL_MS: 5 * 60 * 1000,       // Buy every 5 minutes
        BASE_ALLOCATION: 0.02,             // 2% of portfolio per buy
        MAX_DIP_MULTIPLIER: 3.0,           // 3x on big dips
        MIN_PUMP_MULTIPLIER: 0.3,          // 0.3x on pumps
        TAKE_PROFIT_PERCENT: 1.5,          // Was 5%: unreachable. 1.5% = ~1% net after fees
        MAX_DCA_BUYS: 3,                   // Max DCA adds per position
    },

    // Arbitrage
    ARBITRAGE: {
        ENABLED: true,
        MIN_SPREAD_ZSCORE: 1.5,            // Min z-score for stat arb
        MIN_CONFIDENCE: 55,                // Was 50
        PORTFOLIO_ALLOCATION: 0.10,        // 10% for arbitrage
    },

    // Pair Trading
    PAIR_TRADING: {
        ENABLED: true,
        ENTRY_ZSCORE: 2.0,                // Z-score to open pair trade
        EXIT_ZSCORE: 0.5,                 // Z-score to close pair trade
        MIN_CORRELATION: 0.5,             // Minimum pair correlation
        PORTFOLIO_ALLOCATION: 0.10,        // 10% for pair trading
    },

    // Swing Trading
    SWING: {
        ENABLED: true,
        MIN_CONFIDENCE: 55,               // Was 40: require 4+ strong signals
        MIN_RISK_REWARD: 2.5,             // Was 1.5: fee-adjusted for 0.52% RT costs
        PORTFOLIO_ALLOCATION: 0.05,        // Was 0.20
        TRAILING_STOP_TRIGGER: 2,          // Start trailing at 2% profit
        TRAILING_STOP_PCT: 1.5,            // Trail 1.5% below peak price
    },

    // Market Making - DISABLED (virtual spread capture < Kraken fees)
    MARKET_MAKING: {
        ENABLED: false,                    // 0.06% spread vs 0.52% fees = guaranteed loss
        PORTFOLIO_ALLOCATION: 0.05,
        ORDER_EXPIRY_MS: 5 * 60 * 1000,
        MIN_SPREAD_PERCENT: 0.02,
    },
} as const;

// ============================================
// DEFAULT PROFIT GOALS BY STRATEGY
// ============================================
export const DEFAULT_PROFIT_GOALS: Record<TradingStrategy, number> = {
    TREND: 500,
    BREAKOUT: 250,
    WHALE: 600,
    CONFLUENCE: 400,
    MOMENTUM: 350,
    DIVERGENCE: 450,
    ADAPTIVE: 550,
    MA_CROSSOVER: 300,
    MEAN_REVERSION: 200,
    REVERSAL: 400,
    RANGE: 250,
    VWAP: 300,
};

export const DEFAULT_SESSION_PROFIT_GOAL = 11000;

// ============================================
// INDICATOR CALCULATION PARAMETERS
// ============================================
export const INDICATOR_PARAMS = {
    // EMA/SMA periods
    EMA_FAST: 12,
    EMA_SLOW: 26,
    EMA_SIGNAL: 9,
    SMA_50: 50,
    SMA_100: 100,
    SMA_200: 200,

    // RSI settings
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30,

    // Stochastic settings
    STOCH_PERIOD: 14,
    STOCH_OVERBOUGHT: 80,
    STOCH_OVERSOLD: 20,

    // TC Score components
    TC_TRENDLINE_PERIOD: 8,
    TC_TRENDLINE2_PERIOD: 20,

    // Breakout detector
    BREAKOUT_VOLATILITY_LENGTH: 8,
    BREAKOUT_RSI_LENGTH: 8,

    // Whale money flow
    WHALE_WMF_LENGTH: 10,
    WHALE_MFI_LENGTH: 14,

    // Momentum oscillator
    MOMENTUM_FAST_PERIOD: 10,
    MOMENTUM_SLOW_PERIOD: 20,
    MOMENTUM_SIGNAL_PERIOD: 9,

    // Divergence detection
    DIVERGENCE_LOOKBACK: 14,
    DIVERGENCE_MIN_BARS: 5,

    // Support/Resistance
    SR_PIVOT_LENGTH: 12,

    // Volume Profile
    VOLUME_PROFILE_BARS: 50,
    VALUE_AREA_PERCENT: 70, // 70% of volume in value area

    // Data limits
    MIN_CANDLES_REQUIRED: 50,
    MIN_CANDLES_FOR_MA200: 200,
    MAX_CANDLES_STORED: 200,
} as const;

// ============================================
// WEBSOCKET CONFIGURATION
// ============================================
export const WEBSOCKET_CONFIG = {
    // Connect to backend relay (proxies Crypto.com data via server's authenticated WS)
    URL: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/market`,
    RECONNECT_INITIAL_DELAY_MS: 1000,
    RECONNECT_MAX_DELAY_MS: 30000,
    RECONNECT_MAX_ATTEMPTS: 10,
    HEARTBEAT_TIMEOUT_MS: 30000,
    MESSAGE_QUEUE_SIZE: 100,
} as const;

// ============================================
// POLLING & REFRESH INTERVALS
// ============================================
export const INTERVALS = {
    UI_REFRESH_MS: 1000,           // 1 second UI update
    SCANNER_INTERVAL_MS: 5000,     // 5 seconds scanner cycle (was 10s)
    BOT_LOOP_SIMULATION_MS: 1500,  // 1.5 seconds bot loop for fast trading
    BOT_LOOP_REAL_MS: 5000,        // 5 seconds bot loop (real trading - was 30s)
    BACKEND_POLL_MS: 3000,         // 3 seconds backend status poll
    MTF_REFRESH_MS: 60000,         // 1 minute MTF data refresh
    TICKER_CACHE_REFRESH_MS: 3600000, // 1 hour ticker list refresh
    API_THROTTLE_MS: 250,          // 250ms between API calls
} as const;

// ============================================
// SYSTEM LIMITS
// ============================================
export const SYSTEM_LIMITS = {
    MAX_LOG_ENTRIES: 100,
    MAX_TRADE_HISTORY: 500,
    MAX_WATCHLIST_TICKERS: 20,
    PRICE_DECIMAL_PLACES: 2,
    QUANTITY_DECIMAL_PLACES: 4,
} as const;

// ============================================
// API ENDPOINTS
// ============================================
export const API_ENDPOINTS = {
    INSTRUMENTS: '/api/instruments',
    MARKET_DATA: '/api/market-data',
    LOGIN: '/api/login',
    BOT_TOGGLE: '/api/bot/toggle',
    STATUS: '/api/status',
    TEST_CONNECTION: '/api/test-connection',
} as const;

// ============================================
// CRYPTO.COM API
// ============================================
export const CRYPTO_COM_API = {
    BASE_URL: 'https://api.crypto.com/v2/',
    PUBLIC_ENDPOINTS: {
        INSTRUMENTS: 'public/get-instruments',
        CANDLESTICK: 'public/get-candlestick',
    },
    PRIVATE_ENDPOINTS: {
        ACCOUNT_SUMMARY: 'private/get-account-summary',
        CREATE_ORDER: 'private/create-order',
    },
} as const;

// ============================================
// ADAPTIVE ASSET PARAMETERS (from TC Adaptive Trades in Favor)
// ============================================
export const ADAPTIVE_ASSET_PARAMS: Record<string, {
    lookback: number;
    noiseFilter: number;
    description: string;
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
}> = {
    BTC: { lookback: 20, noiseFilter: 1.0, description: 'Slower/Stable', volatility: 'MEDIUM' },
    ETH: { lookback: 14, noiseFilter: 1.0, description: 'Balanced', volatility: 'MEDIUM' },
    SOL: { lookback: 8, noiseFilter: 1.0, description: 'Fast/Aggressive', volatility: 'HIGH' },
    XRP: { lookback: 12, noiseFilter: 1.5, description: 'Shielded', volatility: 'MEDIUM' },
    DOGE: { lookback: 8, noiseFilter: 1.2, description: 'Fast/Volatile', volatility: 'HIGH' },
    ADA: { lookback: 14, noiseFilter: 1.0, description: 'Balanced', volatility: 'MEDIUM' },
    LINK: { lookback: 12, noiseFilter: 1.0, description: 'Moderate', volatility: 'MEDIUM' },
    MATIC: { lookback: 10, noiseFilter: 1.0, description: 'Fast', volatility: 'HIGH' },
    DOT: { lookback: 14, noiseFilter: 1.0, description: 'Balanced', volatility: 'MEDIUM' },
    AVAX: { lookback: 10, noiseFilter: 1.0, description: 'Fast', volatility: 'HIGH' },
    DEFAULT: { lookback: 14, noiseFilter: 1.0, description: 'Standard', volatility: 'MEDIUM' },
};

// ============================================
// PROBABILITY THRESHOLDS (Adaptive TC)
// ============================================
export const PROBABILITY_THRESHOLDS = {
    EXTREME_BEARISH: 95,
    STRONG_BEARISH: 80,
    MODERATE_BEARISH: 65,
    NEUTRAL_HIGH: 55,
    NEUTRAL_LOW: 45,
    MODERATE_BULLISH: 35,
    STRONG_BULLISH: 20,
    EXTREME_BULLISH: 5,
} as const;

// ============================================
// CORRELATION THRESHOLDS
// ============================================
export const CORRELATION_THRESHOLDS = {
    STRONG_POSITIVE: 0.7,
    MODERATE_POSITIVE: 0.4,
    WEAK: 0.2,
    MODERATE_NEGATIVE: -0.4,
    STRONG_NEGATIVE: -0.7,
} as const;

// ============================================
// HEAT MAP COLOR RANGES
// ============================================
export const HEAT_MAP_COLORS = {
    EXTREME_BULLISH: '#00ff00',
    STRONG_BULLISH: '#22c55e',
    MODERATE_BULLISH: '#84cc16',
    NEUTRAL: '#facc15',
    MODERATE_BEARISH: '#f97316',
    STRONG_BEARISH: '#ef4444',
    EXTREME_BEARISH: '#dc2626',
} as const;

// ============================================
// STRATEGY DESCRIPTIONS (for UI)
// ============================================
export const STRATEGY_INFO: Record<TradingStrategy, { name: string; description: string; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' }> = {
    TREND: {
        name: 'Trend Confluence',
        description: 'Combines volume-weighted trend analysis with price action for trend-following entries',
        riskLevel: 'MEDIUM',
    },
    BREAKOUT: {
        name: 'Breakout Detector',
        description: 'Identifies volatility squeezes that often precede explosive price moves',
        riskLevel: 'HIGH',
    },
    WHALE: {
        name: 'Whale Money Flow',
        description: 'Tracks large-volume institutional buying and selling patterns',
        riskLevel: 'MEDIUM',
    },
    CONFLUENCE: {
        name: 'Multi-Indicator Confluence',
        description: 'Waits for multiple indicators (RSI, MACD, MAs) to align before trading',
        riskLevel: 'LOW',
    },
    MOMENTUM: {
        name: 'Momentum Oscillator',
        description: 'Captures accelerating price momentum with trend-following confirmation',
        riskLevel: 'HIGH',
    },
    DIVERGENCE: {
        name: 'RSI Divergence',
        description: 'Detects price/RSI divergences that often signal trend reversals',
        riskLevel: 'MEDIUM',
    },
    ADAPTIVE: {
        name: 'Adaptive Multi-Asset',
        description: 'Auto-tunes parameters per asset (BTC=slow, SOL=fast) with probability-based signals',
        riskLevel: 'MEDIUM',
    },
    MA_CROSSOVER: {
        name: 'MA Crossover',
        description: 'Uses a faster moving average crossing over a slower one to indicate a trend change.',
        riskLevel: 'LOW',
    },
    MEAN_REVERSION: {
        name: 'Mean Reversion',
        description: 'Trades on the theory that price will return to its average (mean). Uses Bollinger Bands.',
        riskLevel: 'MEDIUM',
    },
    REVERSAL: {
        name: 'Reversal Trading',
        description: 'Identifies trend exhaustion points and enters trades in the opposite direction.',
        riskLevel: 'HIGH',
    },
    RANGE: {
        name: 'Range Trading',
        description: 'Trades within an established channel, buying at support and selling at resistance.',
        riskLevel: 'LOW',
    },
    VWAP: {
        name: 'VWAP Trading',
        description: 'Uses the Volume-Weighted Average Price as a dynamic support/resistance level.',
        riskLevel: 'MEDIUM',
    },
};

// ============================================
// SMART TRADING PARAMETERS
// ============================================
export const SMART_TRADING = {
    // Dynamic Trade Count Adjustment
    DYNAMIC_TRADES: {
        MIN_TRADES: 1,
        MAX_TRADES: 10,
        EXCELLENT_CONDITION_BOOST: 2,      // Add 2 trades in excellent conditions
        POOR_CONDITION_REDUCTION: 2,        // Remove 2 trades in poor conditions
        WIN_STREAK_BOOST_THRESHOLD: 3,      // Wins before increasing trades
        LOSS_STREAK_REDUCTION_THRESHOLD: 3, // Losses before reducing trades
    },

    // Gap Detection
    GAP_DETECTION: {
        MIN_GAP_PERCENT: 0.5,              // Minimum gap size to detect
        BREAKAWAY_VOLUME_MULTIPLIER: 1.5,  // Volume must be 1.5x average for breakaway
        GAP_FILL_PROBABILITY_BASE: 70,     // Base probability a gap will fill
    },

    // Opportunity Scoring Weights
    OPPORTUNITY_WEIGHTS: {
        TREND_ALIGNMENT: 0.25,
        MOMENTUM_STRENGTH: 0.20,
        VOLUME_CONFIRMATION: 0.15,
        PRICE_LOCATION: 0.15,
        GAP_OPPORTUNITY: 0.10,
        MTF_ALIGNMENT: 0.15,
    },

    // Market Regime Thresholds
    MARKET_REGIME: {
        TREND_STRENGTH_STRONG: 60,         // Above this = strong trend
        VOLATILITY_LOW_PERCENTILE: 25,
        VOLATILITY_HIGH_PERCENTILE: 75,
        VOLATILITY_EXTREME_PERCENTILE: 90,
    },

    // Session Analytics
    SESSION: {
        SHORT_SESSION_HOURS: 2,
        LONG_SESSION_HOURS: 6,
        WIN_RATE_GOOD: 55,
        WIN_RATE_EXCELLENT: 70,
        COLD_STREAK_THRESHOLD: 4,          // Consecutive losses to trigger protection
        HOT_STREAK_THRESHOLD: 5,           // Consecutive wins to increase aggression
    },

    // Risk Adjustment Multipliers
    RISK_ADJUSTMENTS: {
        EXCELLENT_CONDITIONS: 1.2,          // 20% more risk
        GOOD_CONDITIONS: 1.0,               // Normal risk
        FAIR_CONDITIONS: 0.8,               // 20% less risk
        POOR_CONDITIONS: 0.5,               // 50% less risk
        HOT_STREAK_BOOST: 1.1,              // 10% more after wins
        COLD_STREAK_REDUCTION: 0.7,         // 30% less after losses
    },

    // Stop Loss Adjustments
    STOP_LOSS_ADJUSTMENTS: {
        HIGH_VOLATILITY_MULTIPLIER: 1.5,   // Wider stops in volatile markets
        LOW_VOLATILITY_MULTIPLIER: 0.75,   // Tighter stops in calm markets
        POOR_CONDITIONS_MULTIPLIER: 0.75,  // Tighter stops in bad conditions
    },

    // Urgency Thresholds
    URGENCY: {
        IMMEDIATE_SCORE: 75,
        IMMEDIATE_CONFIDENCE: 60,
        SOON_SCORE: 60,
        SOON_CONFIDENCE: 50,
        WATCH_SCORE: 40,
    },
} as const;
