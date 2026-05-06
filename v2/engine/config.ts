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
    'AKTUSD', 'ZECUSD', 'COMPUSD',
    // 2026-05-06 (Config A — wide-ticker optimization sweep, 80+ backtests):
    //   AKTUSD: PF 1.69 alone (Akash compute) — best PF found across 50+ tested tickers
    //   ZECUSD: PF 1.33 alone (Zcash privacy) — second strongest individual edge
    //   COMPUSD: PF 1.20 alone (Compound DeFi) — third strongest, low-correlation to AKT/ZEC
    // Combined (AKT+ZEC+COMP, single-strategy backtest, 4h, 90d): PF 1.62, +$151, +5.0%, max DD 2.3%
    // Robustness: 30d PF 1.00 (break-even, yellow flag), 60d PF 1.33, 90d PF 1.62 — improves with longer window
    // Removed: ETHUSD, XRPUSD, DOGEUSD, DOTUSD, ADAUSD (all PF<1 in current 90d regime under tuned config)
    // Per-ticker (90d, Config A): ETH -4.2%, XRP losing, DOGE losing, DOT/ADA worst-2 (-$84/-$112)
  ],
  MIN_VOLUME_24H_USD: 500_000,
  MIN_ATR_PERCENT: 0.3,  // Calibrated for 4h candles (0.05 was for 1m/15m)
  MAX_ATR_PERCENT: 8.0,  // Widened for 4h — normal BTC 4h ATR% is 1-4%
  MAX_SPREAD_PERCENT: 0.15,

  // --- Regime ---
  ALLOWED_REGIMES: ['STRONG_UP', 'UP'] as const, // 2026-04-29: STRONG_UP re-allowed. Original block (Apr 21) was based on R:R 0.8 era (14 trades, 36% WR, -$38). At current R:R 1.4: 5 trades, 60% WR, +$0.04 net (essentially break-even). Different config = different result. Re-evaluate if STRONG_UP underperforms UP in live data.

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
  STOP_LOSS_ATR_MULT: 2.0,  // 2026-05-06 Config A: 2.5 → 2.0 — tighter stop in combination with TG 0.03 reduces avg_loss while win profile preserved by trailing
  TAKE_PROFIT_ATR_MULT: 4.0,       // 2026-04-29: 3.5 → 4.0 (R:R 1.4 → 1.6). Avg_win problem: at R:R 1.4 the cohort was avg_win $0.97 vs needed ~$1.10 for 59% WR break-even. Wider TP makes individual TP hits +$2.00 instead of +$1.75. Risk: historical R:R 1.6 cohort underperformed R:R 1.4 (-$10.89 vs -$1.89), but that was without working BE/trailing stops. With current trailing-active@1% catching moderate winners, wider TP may behave differently. Deliberate test under user's risk-on framing 2026-04-29.
  TRAILING_ACTIVATE_PERCENT: 0.025, // 2026-05-06 Config A: 0.01 → 0.025 — wait longer before activating trail. Reduces premature exits on noise; combined with TG 0.03 produces avg_win $8.03 (was $1.92 baseline)
  TRAILING_GIVEBACK_PERCENT: 0.03,  // 2026-05-06 Config A: 0.25 → 0.03 — extreme tight trail. Once activated, surrender only 3% of peak gain. The trailing-exit P&L moved from +$216 (PF 1.43) to +$312 (PF 1.62) on AKT+ZEC+COMP 90d
  TIME_KILL_MS: 12 * 60 * 60 * 1000,     // 12h — 3 bars on 4h candles (was 16h/4 bars; trades stale after 10.8h avg hold were bleeding fees)
  TIME_KILL_MIN_MOVE: 0.007,
  EXIT_CHECK_INTERVAL_MS: 15_000,

  // --- Quick-Kill (dud trade detection) ---
  QUICK_KILL_AFTER_MS: 4 * 60 * 60 * 1000,  // 4h (1 candle) — was 8h; kill duds faster to free position slots
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
// MOMENTUM Exit Config (used by momentumExitManager)
// Centralized so tuning doesn't require code edits.
// MOMENTUM strategy currently DISABLED (see v2/index.ts) — these values are
// preserved for when the strategy is reworked with a redesigned signal.
// ============================================

export const MOM_EXIT_CONFIG = {
  SL_ATR_MULT: 2.0,
  HISTOGRAM_DECAY_THRESHOLD: 0.50,   // exit when current MACD hist < 50% of peak
  BREAKEVEN_TRIGGER: 0.01,           // raise SL to entry+offset at +1.0% PnL
  BREAKEVEN_OFFSET: 0.001,           // BE stop sits at entry × 1.001
  TIME_KILL_BARS: 6,                  // 6 × 1h = 6 hours
  TIME_KILL_MIN_MOVE: 0.005,
} as const;

// ============================================
// MEAN_REVERSION Strategy Config
// Profitable on 15m with maker fees: +$6.33, 52% WR, PF 1.73
// ============================================

export const MR_CONFIG = {
  ENABLED: false,                  // DISABLED — live results: 0 wins, 4 losses, -$2.80. Backtest claimed +$6.33/52% WR but live is 0% WR. Re-enable when strategy is reworked.
  CANDLE_INTERVAL: '15m' as string,
  ALLOWED_REGIMES: ['SIDEWAYS', 'UP'] as readonly string[],
  SCAN_TICKERS: ['BTCUSD', 'ETHUSD', 'XRPUSD', 'DOGEUSD'] as string[],

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

// ROUND_TRIP_REAL: maker entry + taker exit. This is the true cost when
// USE_MAKER_ORDERS=true: entries fill as maker, but every exit goes through
// placeMarketSell (taker) per tradeEngine.ts:541-548. Use this for any
// gating logic that's deciding whether expected-return covers actual fees.
export const EXCHANGE_FEES = {
  kraken: {
    TAKER_PERCENT: 0.0026,
    MAKER_PERCENT: 0.0016,
    ROUND_TRIP_TAKER: 0.0052,
    ROUND_TRIP_MAKER: 0.0032,
    ROUND_TRIP_REAL: 0.0042, // 0.16% maker entry + 0.26% taker exit
  },
  'crypto.com': {
    TAKER_PERCENT: 0.00075,
    MAKER_PERCENT: 0.00050,
    ROUND_TRIP_TAKER: 0.0015,
    ROUND_TRIP_MAKER: 0.0010,
    ROUND_TRIP_REAL: 0.00125, // 0.05% maker entry + 0.075% taker exit
  },
} as const;

/**
 * Look up the fee table for an exchange by name. Defaults to Kraken if the
 * name is unknown — callers should pass exchange.getName() so this never
 * silently picks the wrong table when running on Crypto.com.
 */
export function getExchangeFees(exchangeName: string) {
  const key = exchangeName.toLowerCase();
  if (key === 'crypto.com' || key === 'cryptocom') return EXCHANGE_FEES['crypto.com'];
  return EXCHANGE_FEES.kraken;
}

// --- Dual Exchange Competition Config ---

export const DUAL_ENGINE_CONFIG = {
  /** Enable dual-engine mode (run Kraken + Crypto.com side by side) */
  ENABLED: (process.env.DUAL_ENGINE ?? 'false') === 'true',
  /** Budget per engine in USD (each gets its own portfolio) */
  BUDGET_PER_ENGINE: 1000,
  /** Both run in paper mode during competition */
  MODE: 'paper' as const,
} as const;
