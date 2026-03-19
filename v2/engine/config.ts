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
  ALLOWED_REGIMES: ['STRONG_UP', 'UP', 'SIDEWAYS'] as const, // TODO: remove SIDEWAYS after paper testing

  // --- Signal ---
  MIN_COMPOSITE_SCORE: 60,                // Was 55 — raise bar for 15m entries to reduce noise trades
  MIN_CONFIDENCE: 0.60,
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
  STOP_LOSS_ATR_MULT: 2.5,         // Was 2.0 — too tight, normal 15m noise triggered SL
  TAKE_PROFIT_ATR_MULT: 4.0,      // Was 3.0 — wider TP for 1.6:1 R:R (2.5 SL : 4.0 TP); 1.2:1 was churning fees
  TRAILING_ACTIVATE_PERCENT: 0.025,        // 2.5% — break-even stop covers 1.5-2.5%, trailing takes over above
  TRAILING_GIVEBACK_PERCENT: 0.25,        // Was 40% — tighter trail locks in more profit
  TIME_KILL_MS: 3 * 60 * 60 * 1000,      // 3h — was 2h which killed winners mid-move; 4h was too long
  TIME_KILL_MIN_MOVE: 0.004,              // Was 0.5% — slightly tighter threshold
  EXIT_CHECK_INTERVAL_MS: 5_000,

  // --- Quick-Kill (dud trade detection) ---
  QUICK_KILL_AFTER_MS: 45 * 60 * 1000,   // 45 min: if trade never showed life, tighten SL
  QUICK_KILL_MIN_GAIN: 0.003,             // Must have reached +0.3% at some point to avoid quick-kill
  QUICK_KILL_SL_ATR_MULT: 1.5,            // Tighten SL from 2.5x to 1.5x ATR

  // --- Regime Momentum Gate ---
  REGIME_MOMENTUM_LOOKBACK: 5,            // Compare EMA20 slope over last 5 bars
  REGIME_MOMENTUM_MIN_SLOPE: -0.002,      // Reject SIDEWAYS if EMA20 slope < -0.2% (trending down)

  // --- Bot Loop ---
  BOT_LOOP_INTERVAL_MS: 30_000,

  // --- Telegram ---
  TELEGRAM_TAG: '[V2]',

  // --- Signal Scoring ---
  MIN_TRADES_FOR_SCORING: 20,
} as const;
