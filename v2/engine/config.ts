// ============================================
// Phoenix V2 Engine Configuration
// All tunable parameters in one place
// ============================================

import type { V2Mode } from '../pipeline/types.ts';

export const V2_CONFIG = {
  // --- Mode ---
  MODE: (process.env.V2_MODE || 'shadow') as V2Mode,

  // --- Scan ---
  SCAN_TICKERS: [
    'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD',
    // Removed: ADAUSD (13.2% WR, -$73 on 4h backtest), DOTUSD (20% WR, -$65)
    // Removed: LINKUSD (0/4 trades, -$9.02), AVAXUSD (24.2% WR, -$79), BNBUSD (22.6% WR, -$46)
    // Keeping top 5 by win rate: BTC 38%, DOGE 37%, XRP 32%, SOL 30%, ETH 27%
  ],
  MIN_VOLUME_24H_USD: 500_000,
  MIN_ATR_PERCENT: 0.3,  // Calibrated for 4h candles (0.05 was for 1m/15m)
  MAX_ATR_PERCENT: 8.0,  // Widened for 4h — normal BTC 4h ATR% is 1-4%
  MAX_SPREAD_PERCENT: 0.15,

  // --- Regime ---
  ALLOWED_REGIMES: ['STRONG_UP', 'UP'] as const, // SIDEWAYS removed — backtest showed 10.4% WR, -$252 (worst regime)

  // --- Signal ---
  MIN_COMPOSITE_SCORE: 60,                // Was 70 — scoring math caps at ~64 in normal STRONG_UP; 70 only fires on extreme pullbacks
  MIN_CONFIDENCE: 0.70,
  MIN_CANDLES: 50,

  // --- Fees (Kraken) ---
  FEE_TAKER_PERCENT: 0.0026,
  FEE_MAKER_PERCENT: 0.0016,
  FEE_ROUND_TRIP_MAKER: 0.0032,
  FEE_ROUND_TRIP_TAKER: 0.0052,

  // --- Position Sizing ---
  MIN_EXPECTED_RETURN: 0.008,    // 0.8% — was 0.5%, too close to fees; need meaningful edge above 0.52% round-trip
  BASE_POSITION_PERCENT: 0.25,  // Base size as % of equity — actual size = base × confidence × F&G multiplier (can exceed this)
  MAX_OPEN_POSITIONS: 3,         // Cap at 3 — data shows 4-5 adds correlation risk without enough upside (Apr 18: 5 correlated longs lost $35)

  // --- Risk ---
  MAX_DAILY_LOSS_PERCENT: 0.03,
  CIRCUIT_BREAKER_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes

  // --- Order Execution ---
  MAKER_FILL_TIMEOUT_MS: 30_000,
  USE_MAKER_ORDERS: true,

  // --- Candle Timeframe ---
  CANDLE_INTERVAL: '4h' as string, // Was 15m — backtest: 15m=21%WR/-$1030, 1h=26%WR/-$1669, 4h=27%WR/-$455. 4h gives trends room past 0.52% fees.

  // --- Exit Management ---
  STOP_LOSS_ATR_MULT: 2.5,
  TAKE_PROFIT_ATR_MULT: 2.0,       // Reachable on 4h; produces 54% WR with % trailing
  TRAILING_ACTIVATE_PERCENT: 0.015, // 1.5% — matches exitManager BE stop intent (BE covers 0.8–1.5% gap, trailing above)
  TRAILING_GIVEBACK_PERCENT: 0.30,
  TIME_KILL_MS: 16 * 60 * 60 * 1000,     // 16h — 4 bars on 4h candles
  TIME_KILL_MIN_MOVE: 0.007,
  EXIT_CHECK_INTERVAL_MS: 15_000,

  // --- Quick-Kill (dud trade detection) ---
  QUICK_KILL_AFTER_MS: 8 * 60 * 60 * 1000,
  QUICK_KILL_MIN_GAIN: 0.006,
  QUICK_KILL_SL_ATR_MULT: 1.2,

  // --- Regime Momentum Gate ---
  REGIME_MOMENTUM_LOOKBACK: 5,            // Compare EMA20 slope over last 5 bars
  REGIME_MOMENTUM_MIN_SLOPE: -0.002,      // Reject SIDEWAYS if EMA20 slope < -0.2% (trending down)

  // --- Bot Loop ---
  BOT_LOOP_INTERVAL_MS: 60_000,            // Was 30s — 60s is plenty for 4h candles; reduces log noise + CPU

  // --- Telegram ---
  TELEGRAM_TAG: '[V2]',

  // --- Signal Scoring ---
  MIN_TRADES_FOR_SCORING: 20,

  // --- TC (Trend Composite) Indicator Thresholds ---
  TC_BUY_ZONE: 20,           // TC below this = strong buy zone
  TC_SELL_ZONE: 80,          // TC above this = sell zone / avoid
  TC_CONSENSUS_MIN: 50,      // Minimum multi-TF consensus to boost score

  // --- Multi-Timeframe Regime ---
  MTF_ENABLED: false,             // Disabled — primary timeframe is now 4h, no higher TF to compare against
  MTF_HIGHER_TIMEFRAME: '1d' as string,  // Would need daily candles if re-enabled
  MTF_ALLOWED_HIGHER_REGIMES: ['STRONG_UP', 'UP'] as readonly string[],
  MTF_POSITION_MULTIPLIER: 0.75,       // 75% of normal size for pullback entries
  MTF_REGIME_CACHE_TTL_MS: 15 * 60 * 1000,  // Cache 4h regime for 15 minutes
  MTF_MAX_15M_REGIME: ['DOWN'] as readonly string[],  // Only rescue DOWN (not STRONG_DOWN)
} as const;

// ============================================
// MEAN_REVERSION Strategy Config
// Profitable on 15m with maker fees: +$6.33, 52% WR, PF 1.73
// ============================================

export const MR_CONFIG = {
  ENABLED: true,
  CANDLE_INTERVAL: '15m' as string,
  ALLOWED_REGIMES: ['SIDEWAYS', 'UP'] as readonly string[],
  SCAN_TICKERS: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'] as string[],

  RSI_THRESHOLD: 30,
  BB_PERCENT_B_THRESHOLD: 0.15,
  MAX_ATR_PERCENT: 3.0,
  MIN_CANDLES: 50,

  POSITION_SIZE_PERCENT: 0.15,
  MAX_POSITION_PERCENT: 0.20,
  MAX_OPEN_POSITIONS: 3,

  STOP_LOSS_ATR_MULT: 1.5,
  TIME_KILL_BARS: 4,            // 4 × 15m = 1 hour
  TIME_KILL_MIN_MOVE: 0.003,
  QUICK_KILL_AFTER_BARS: 2,     // 2 × 15m = 30 min
  QUICK_KILL_MIN_GAIN: 0.002,
  QUICK_KILL_SL_ATR_MULT: 0.8,

  USE_MAKER_ORDERS: true,
  FEE_ROUND_TRIP: 0.0032,       // Maker fees — critical for profitability

  BOT_LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 30_000,       // Stagger 30s from TREND loop to avoid API rate limits
} as const;

// --- Exchange-specific fee configs ---

export const EXCHANGE_FEES = {
  kraken: {
    TAKER_PERCENT: 0.0026,
    MAKER_PERCENT: 0.0016,
    ROUND_TRIP_TAKER: 0.0052,
    ROUND_TRIP_MAKER: 0.0032,
  },
  'crypto.com': {
    TAKER_PERCENT: 0.00075,
    MAKER_PERCENT: 0.00050,
    ROUND_TRIP_TAKER: 0.0015,
    ROUND_TRIP_MAKER: 0.0010,
  },
} as const;

// --- Dual Exchange Competition Config ---

export const DUAL_ENGINE_CONFIG = {
  /** Enable dual-engine mode (run Kraken + Crypto.com side by side) */
  ENABLED: (process.env.DUAL_ENGINE ?? 'false') === 'true',
  /** Budget per engine in USD (each gets its own portfolio) */
  BUDGET_PER_ENGINE: 1000,
  /** Both run in paper mode during competition */
  MODE: 'paper' as const,
} as const;
