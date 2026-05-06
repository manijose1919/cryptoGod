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
// MOMENTUM Strategy Config (v2 — rebuilt 2026-05-06)
// ============================================
// Replaces the old "1h MACD-spike" momentum that produced 0% WR.
// New strategy: 4h candles, z-score histogram spike, higher-highs filter,
// percent-giveback trail. Backtest proved: PF 1.70-2.32 across 30/60/90d.
//
// To enable: set ENABLED: true (v2/index.ts gates engine startup on this).
// ============================================

export const MOMENTUM_CONFIG = {
  ENABLED: true,   // 2026-05-06: ENABLED for live testing alongside TREND. Backtest validated PF 1.41-1.70 across 90d windows. Watch for 50+ closes before evaluating.

  // Tickers — chosen via wide-ticker scan in backtest. These 7 produced
  // PF > 1 individually under v2 logic; combined PF was 1.70 (90d).
  // ZECUSD overlaps with TREND's SCAN_TICKERS — that's intentional, the two
  // strategies pick different signal patterns and rarely fire simultaneously.
  SCAN_TICKERS: ['ZECUSD', 'RUNEUSD', 'FLOWUSD', 'ENAUSD', 'KASUSD', 'ICPUSD', 'WIFUSD'] as readonly string[],

  CANDLE_INTERVAL: '4h' as string,  // 4h was the best timeframe — 1h gave PF 0 (too noisy)
  ALLOWED_REGIMES: ['STRONG_UP', 'UP', 'SIDEWAYS'] as readonly string[],
  MIN_CANDLES: 50,

  // Entry filters (v2):
  HISTOGRAM_SPIKE_Z: 1.0,  // macdHist must be ≥1 std-dev above 20-bar rolling mean
  RSI_MIN: 50,
  RSI_MAX: 70,
  VOLUME_MULTIPLIER: 1.3,
  MIN_UP_BARS: 3,  // require 3+ of last 5 closes > previous

  // Position sizing:
  POSITION_SIZE_PERCENT: 0.20,
  MAX_POSITION_PERCENT: 0.30,
  MAX_OPEN_POSITIONS: 2,

  // Loop:
  LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 15_000,  // 15s after TREND so logs interleave cleanly
} as const;

// ============================================
// MOMENTUM Exit Config (used by momentumExitManager v2)
// Switched from histogram_decay (too sensitive, exits at first stall)
// to percent_giveback trail — same pattern as TREND/MR.
// ============================================

export const MOM_EXIT_CONFIG = {
  SL_ATR_MULT: 2.0,                    // backup ATR-based stop if swing-low not available

  // Take-profit (v2 added):
  TP_ATR_MULT: 3.0,                    // hard TP at 3× ATR

  // Break-even:
  BREAKEVEN_TRIGGER: 0.015,            // raise SL to entry+offset at +1.5% PnL
  BREAKEVEN_OFFSET: 0.001,             // BE stop sits at entry × 1.001

  // Trailing (replaces histogram_decay):
  TRAIL_ACTIVATE: 0.025,               // activate at +2.5% PnL — wait for real momentum
  TRAIL_GIVEBACK: 0.05,                // give back only 5% of peak gain when triggered

  // Quick-kill (v2 added):
  QUICK_KILL_ENABLED: true,
  QUICK_KILL_BARS: 4,                  // 4 × 4h = 16h with no progress
  QUICK_KILL_MIN_GAIN: 0.006,
  QUICK_KILL_SL_TIGHTEN: 1.2,

  // Time-kill:
  TIME_KILL_BARS: 16,                  // 16 × 4h = 2.7 days — 4h candles need more room than 1h
  TIME_KILL_MIN_MOVE: 0.005,

  // Legacy field — kept for backward compat with momentumExitManager v1 references.
  // No longer used; the new exit manager uses TRAIL_ACTIVATE/TRAIL_GIVEBACK above.
  HISTOGRAM_DECAY_THRESHOLD: 0.50,
} as const;

// ============================================
// SNIPER Strategy Config (new-coin sniper, 2026-05-06)
// ============================================
// Side-project strategy: snipe new Kraken USD listings during their early
// volatility window. Cannot be backtested (by definition new data) — paper-only
// at first; tune from live trade outcomes. Stats kept separate from TREND/MOM
// per the reporting contract in CHANGELOG.md.
// ============================================

export const SNIPER_CONFIG = {
  ENABLED: true,             // ship enabled — paper mode for safety
  BUDGET_USD: 500,           // separate bucket; not aggregated with TREND/MOM
  STRATEGY_TAG: 'SNIPER' as const,  // v2_trades.strategy filter for reports

  // --- Detection / scan loop ---
  PAIR_REFRESH_INTERVAL_MS: 30 * 60 * 1000,  // re-fetch Kraken pair list every 30 min
  LOOP_INTERVAL_MS: 60_000,                  // entry/exit check every 60s
  LOOP_OFFSET_MS: 30_000,                    // 30s after MOMENTUM (which is +15s after TREND)

  // --- Listing eligibility window ---
  // Skip the absolute first 30 min — worst slippage, manipulation, no structure.
  // Stop sniping after 7 days — by then it's just another tradable coin.
  MIN_LISTING_AGE_MS: 30 * 60 * 1000,
  MAX_LISTING_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  CANDLE_INTERVAL: '15m' as string,
  MIN_CANDLES: 20,            // need ~5h of 15m bars to compute indicators

  // --- Entry triggers (ALL must hit) ---
  RSI_MAX: 70,                // not yet overbought
  VOLUME_MULTIPLIER: 1.5,     // current bar vol >= 1.5× last 12-bar avg
  MIN_UP_BARS: 3,             // 3+ of last 5 bars closed higher than previous
  MAX_RUG_PULL_SCORE: 1,      // detector score must be < 2 (no major red flags)
  MIN_BAR_VOLUME_USD: 500,    // floor: avoid dead-listing dust

  // --- Position sizing ---
  POSITION_SIZE_PERCENT: 0.10,   // 10% of $500 = $50 per trade (small)
  MAX_POSITION_PERCENT: 0.20,    // hard cap 20% even with high confidence
  MAX_OPEN_POSITIONS: 2,         // never more than 2 sniper trades simultaneously

  // --- Exits ---
  STOP_LOSS_PERCENT: 0.03,             // -3% hard stop
  TRAIL_ACTIVATE_PERCENT: 0.05,        // start trailing at +5%
  TRAIL_GIVEBACK_PERCENT: 0.30,        // give back 30% of peak gain (wider than TREND — newcoins are wild)
  TIME_KILL_MS: 8 * 60 * 60 * 1000,    // 8h max hold

  // --- Telegram ---
  TELEGRAM_TAG: '[SNIPER]',
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
