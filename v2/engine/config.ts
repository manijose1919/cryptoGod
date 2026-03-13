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
  MIN_ATR_PERCENT: 0.3,
  MAX_SPREAD_PERCENT: 0.15,

  // --- Regime ---
  ALLOWED_REGIMES: ['STRONG_UP', 'UP'] as const,

  // --- Signal ---
  MIN_COMPOSITE_SCORE: 65,
  MIN_CONFIDENCE: 0.60,
  MIN_CANDLES: 50,

  // --- Fees (Kraken) ---
  FEE_TAKER_PERCENT: 0.0026,
  FEE_MAKER_PERCENT: 0.0016,
  FEE_ROUND_TRIP_MAKER: 0.0032,
  FEE_ROUND_TRIP_TAKER: 0.0052,

  // --- Position Sizing ---
  MIN_EXPECTED_RETURN: 0.015,
  MAX_POSITION_PERCENT: 0.25,
  MAX_OPEN_POSITIONS: 1,

  // --- Risk ---
  MAX_DAILY_LOSS_PERCENT: 0.03,
  CIRCUIT_BREAKER_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes

  // --- Order Execution ---
  MAKER_FILL_TIMEOUT_MS: 30_000,
  USE_MAKER_ORDERS: true,

  // --- Exit Management ---
  STOP_LOSS_ATR_MULT: 2.0,
  TAKE_PROFIT_ATR_MULT: 4.0,
  TRAILING_ACTIVATE_PERCENT: 0.02,
  TRAILING_GIVEBACK_PERCENT: 0.40,
  TIME_KILL_MS: 4 * 60 * 60 * 1000, // 4 hours
  TIME_KILL_MIN_MOVE: 0.005,
  EXIT_CHECK_INTERVAL_MS: 5_000,

  // --- Bot Loop ---
  BOT_LOOP_INTERVAL_MS: 30_000,

  // --- Telegram ---
  TELEGRAM_TAG: '[V2]',

  // --- Signal Scoring ---
  MIN_TRADES_FOR_SCORING: 20,
} as const;
