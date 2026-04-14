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
    'DOTUSD', 'AVAXUSD', 'DOGEUSD', 'BNBUSD',
    // LINKUSD removed — 0/4 trades, -$9.02, 3 SL hits, enters overbought without MACD confirmation
  ],
  MIN_VOLUME_24H_USD: 500_000,
  MIN_ATR_PERCENT: 0.05, // Calibrated for 1-minute candles (0.3 was for hourly)
  MAX_ATR_PERCENT: 3.0,  // Reject extreme volatility — flash crashes, news spikes
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
  STOP_LOSS_ATR_MULT: 2.5,         // Was 3.0 — tighter SL to cut losers faster; 3.0x let too many trades bleed for 5h before time-kill
  TAKE_PROFIT_ATR_MULT: 3.5,      // Was 5.0 — 5x rarely hit on 15m; 3.5x is achievable (1.4:1 R:R) and reduces time-kills
  TRAILING_ACTIVATE_PERCENT: 0.012,        // Was 1.5% — lowered to 1.2% so trailing locks in gains earlier with tighter TP target
  TRAILING_GIVEBACK_PERCENT: 0.30,        // Was 25% — slightly wider to avoid noise exits on good trends
  TIME_KILL_MS: 5 * 60 * 60 * 1000,      // Was 8h — back to 5h; data shows avg time_kill hold is 4.4h, trades that haven't moved by 5h never do
  TIME_KILL_MIN_MOVE: 0.007,              // Was 1.0% — lowered to 0.7%; 1.0% killed trades that moved 0.5-0.8% (profitable after 0.52% fees)
  EXIT_CHECK_INTERVAL_MS: 5_000,

  // --- Quick-Kill (dud trade detection) ---
  QUICK_KILL_AFTER_MS: 45 * 60 * 1000,   // Was 60min — shortened to 45min; data shows losers are identifiable early (avg SL hit at 2.2h vs TP at 3.5h)
  QUICK_KILL_MIN_GAIN: 0.004,             // Was 0.5% — lowered to 0.4%; if trade hasn't moved 0.4% in 45min, it's a dud
  QUICK_KILL_SL_ATR_MULT: 1.2,            // Was 1.5x — tighter to force quicker exits; time_kill avg loss was -$0.75, quick-kill should reduce this

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
