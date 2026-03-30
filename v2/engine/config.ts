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
    'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD',
    'LINKUSD', 'DOTUSD', 'AVAXUSD', 'DOGEUSD', 'BNBUSD',
  ],
  MIN_VOLUME_24H_USD: 500_000,
  MIN_ATR_PERCENT: 0.05, // Calibrated for 1-minute candles (0.3 was for hourly)
  MAX_ATR_PERCENT: 3.0,  // Reject extreme volatility — flash crashes, news spikes
  MAX_SPREAD_PERCENT: 0.15,

  // --- Regime ---
  ALLOWED_REGIMES: ['STRONG_UP', 'UP'] as const, // SIDEWAYS removed — backtest showed 10.4% WR, -$252 (worst regime)

  // --- Signal ---
  MIN_COMPOSITE_SCORE: 70,                // Was 60 — backtest showed 12.4% WR at 60; 49% of trades time-killed (no momentum)
  MIN_CONFIDENCE: 0.70,
  MIN_CANDLES: 50,

  // --- Fees (Kraken) ---
  FEE_TAKER_PERCENT: 0.0026,
  FEE_MAKER_PERCENT: 0.0016,
  FEE_ROUND_TRIP_MAKER: 0.0032,
  FEE_ROUND_TRIP_TAKER: 0.0052,

  // --- Position Sizing ---
  MIN_EXPECTED_RETURN: 0.008,    // 0.8% — was 0.5%, too close to fees; need meaningful edge above 0.52% round-trip
  MAX_POSITION_PERCENT: 0.25,
  MAX_OPEN_POSITIONS: 2,         // Was 3 — fewer concurrent trades = cleaner signal attribution

  // --- Risk ---
  MAX_DAILY_LOSS_PERCENT: 0.03,
  CIRCUIT_BREAKER_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes

  // --- Order Execution ---
  MAKER_FILL_TIMEOUT_MS: 30_000,
  USE_MAKER_ORDERS: true,

  // --- Candle Timeframe ---
  CANDLE_INTERVAL: '15m' as string, // '1m', '5m', '15m', '1h', '4h'

  // --- Exit Management ---
  STOP_LOSS_ATR_MULT: 3.0,         // Was 2.5 — 15m noise regularly hit 2.5x; 3.0x absorbs normal pullbacks
  TAKE_PROFIT_ATR_MULT: 5.0,      // Was 4.0 — maintains ~1.67:1 R:R with 3.0 SL; lets trends run further
  TRAILING_ACTIVATE_PERCENT: 0.015,        // Was 2.5% — lowered to 1.5% so trailing protects winners sooner
  TRAILING_GIVEBACK_PERCENT: 0.30,        // Was 25% — slightly wider to avoid noise exits on good trends
  TIME_KILL_MS: 5 * 60 * 60 * 1000,      // Was 3h — extended to 5h; 15m consolidation needs more room
  TIME_KILL_MIN_MOVE: 0.006,              // Was 0.4% — raised to 0.6%; only kill truly dead trades
  EXIT_CHECK_INTERVAL_MS: 5_000,

  // --- Quick-Kill (dud trade detection) ---
  QUICK_KILL_AFTER_MS: 90 * 60 * 1000,   // Was 45min — extended to 90min; good setups often consolidate first
  QUICK_KILL_MIN_GAIN: 0.004,             // Was 0.3% — raised to 0.4%; small moves aren't duds
  QUICK_KILL_SL_ATR_MULT: 2.0,            // Was 1.5x — less aggressive tightening to avoid premature stops

  // --- Regime Momentum Gate ---
  REGIME_MOMENTUM_LOOKBACK: 5,            // Compare EMA20 slope over last 5 bars
  REGIME_MOMENTUM_MIN_SLOPE: -0.002,      // Reject SIDEWAYS if EMA20 slope < -0.2% (trending down)

  // --- Bot Loop ---
  BOT_LOOP_INTERVAL_MS: 30_000,

  // --- Telegram ---
  TELEGRAM_TAG: '[V2]',

  // --- Signal Scoring ---
  MIN_TRADES_FOR_SCORING: 20,

  // --- TC (Trend Composite) Indicator Thresholds ---
  TC_BUY_ZONE: 20,           // TC below this = strong buy zone
  TC_SELL_ZONE: 80,          // TC above this = sell zone / avoid
  TC_CONSENSUS_MIN: 50,      // Minimum multi-TF consensus to boost score

  // --- Multi-Timeframe Regime ---
  MTF_ENABLED: true,
  MTF_HIGHER_TIMEFRAME: '4h' as string,
  MTF_ALLOWED_HIGHER_REGIMES: ['STRONG_UP', 'UP'] as readonly string[],
  MTF_POSITION_MULTIPLIER: 0.75,       // 75% of normal size for pullback entries
  MTF_REGIME_CACHE_TTL_MS: 15 * 60 * 1000,  // Cache 4h regime for 15 minutes
  MTF_MAX_15M_REGIME: ['DOWN'] as readonly string[],  // Only rescue DOWN (not STRONG_DOWN)
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
