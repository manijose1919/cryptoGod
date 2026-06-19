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
    // 2026-05-27: Concentrated on 6 top performers. $10K/6 = $1,667/ticker.
    // PF 8.64, +$8,443 (84.4% in 90d), 180d +$13,486 (134.8%)
    'AKTUSD',    // PF best, 93.3% WR, +$2,009
    'ZECUSD',    // 92.4% WR, +$1,554
    'FETUSD',    // 91.7% WR, +$1,402
    'PENGUUSD',  // 90.9% WR, +$1,489
    'TAOUSD',    // 89.5% WR, +$1,479
    'PENDLEUSD', // 88.1% WR, +$511, PF 8.20
    // 2026-05-06 (Config A — wide-ticker optimization sweep, 80+ backtests):
    //   AKTUSD: PF 1.69 alone (Akash compute) — best PF found across 50+ tested tickers
    //   ZECUSD: PF 1.33 alone (Zcash privacy) — second strongest individual edge
    //   COMPUSD: PF 1.20 alone (Compound DeFi) — third strongest, low-correlation to AKT/ZEC
    // Combined (AKT+ZEC+COMP, single-strategy backtest, 4h, 90d): PF 1.62, +$151, +5.0%, max DD 2.3%
    // Robustness: 30d PF 1.00 (break-even, yellow flag), 60d PF 1.33, 90d PF 1.62 — improves with longer window
    // Removed: ETHUSD, XRPUSD, DOGEUSD, DOTUSD, ADAUSD (all PF<1 in current 90d regime under tuned config)
    // Per-ticker (90d, Config A): ETH -4.2%, XRP losing, DOGE losing, DOT/ADA worst-2 (-$84/-$112)
    // 2026-05-17: Added SOL ($9.4M vol), HYPE ($7M vol, +7.1% today), SUI ($5.6M vol), LINK ($2.3M vol)
    //   — diversify out of 3 correlated mid-cap alts all stuck in DOWN regime. Higher vol + different sectors.
  ],
  MIN_VOLUME_24H_USD: 500_000,
  MIN_ATR_PERCENT: 0.3,  // Calibrated for 4h candles (0.05 was for 1m/15m)
  MAX_ATR_PERCENT: 8.0,  // Widened for 4h — normal BTC 4h ATR% is 1-4%
  MAX_SPREAD_PERCENT: 0.15,

  // --- Regime ---
  ALLOWED_REGIMES: ['STRONG_UP'] as const, // 2026-06-19: removed UP. ADX>25 gate in strategyRunner is now the primary trend-strength check; STRONG_UP is the regime backstop. UP was too broad — EMA crossover calls UP in choppy conditions. STRONG_UP + ADX>25 = two independent confirmations.

  // --- Signal ---
  MIN_COMPOSITE_SCORE: 60,                // Was 70 — scoring math caps at ~64 in normal STRONG_UP; 70 only fires on extreme pullbacks
  MIN_CONFIDENCE: 0.65,
  MIN_CANDLES: 50,

  // --- Fees (Kraken) ---
  FEE_TAKER_PERCENT: 0.0026,
  FEE_MAKER_PERCENT: 0.0016,
  FEE_ROUND_TRIP_MAKER: 0.0032,
  FEE_ROUND_TRIP_TAKER: 0.0052,

  // Fee-aware trailing-activation floor: trail may not arm until unrealized
  // profit >= this multiple of round-trip taker fee (3 × 0.52% = 1.56%).
  // Both fixed values failed live: 2.5% armed too late (20 SLs), 1% armed
  // too early (trailing wins +$1.55 < $1.90 fee floor). Fee multiple self-scales.
  TRAIL_ACTIVATE_FEE_FLOOR_MULT: 3.0,

  // --- Position Sizing ---
  MIN_EXPECTED_RETURN: 0.008,    // 0.8% — was 0.5%, too close to fees; need meaningful edge above 0.52% round-trip
  BASE_POSITION_PERCENT: 0.40,  // 2026-05-18: 0.25→0.40. Backtest: PF 3.84→6.63, +$414→+$888 on $6K. Safe — max DD stays 0.2%.
  MAX_RISK_PER_TRADE_PERCENT: 0.015, // 2026-06-06: 0.03→0.015. Live: high-ATR trades (FET 4.5%, ZEC 3%) got $400+ positions with $40 max loss. Caps high-ATR smaller while low-ATR unaffected.
  MAX_OPEN_POSITIONS: 3,         // Cap at 3 — data shows 4-5 adds correlation risk without enough upside (Apr 18: 5 correlated longs lost $35)

  // --- Re-entry Cooldown ---
  REENTRY_COOLDOWN_MS: 0,  // 2026-05-27: disabled. Backtest: 0h cooldown triples trades (357→1207) while maintaining 88% WR. Intra-bar trailing catches re-entries profitably.

  // --- Correlation Check ---
  CORRELATION_MAX_AVG: 0.70,           // reject if avg correlation with open positions > this
  CORRELATION_LOOKBACK_BARS: 20,       // 20 × 4h = ~3.3 days of return data

  // --- Trend Maturity ---
  TREND_MATURITY_PENALTY_THRESHOLD: 70,  // start penalizing composite score above this maturity
  TREND_MATURITY_MAX_PENALTY: 15,        // subtract up to 15 from composite score for exhausted trends

  // --- Short Selling ---
  SHORTS_ENABLED: true,                  // 2026-05-18: enabled for paper testing
  SHORT_ALLOWED_REGIMES: ['STRONG_DOWN', 'DOWN'] as readonly string[],
  SHORT_FEE_ROUND_TRIP: 0.0052,          // taker both sides for shorts on Kraken
  SHORT_STOP_LOSS_ATR_MULT: 1.5,  // 2026-06-06: matched to long SL. ZEC short lost -$39.53 at 2.0x ATR (9% stop). At 1.5x would be ~-$28.
  SHORT_TAKE_PROFIT_ATR_MULT: 3.5,
  SHORT_TRAILING_ACTIVATE_PERCENT: 0.01,
  SHORT_TRAILING_GIVEBACK_PERCENT: 0.03,

  // --- Risk ---
  MAX_DAILY_LOSS_PERCENT: 0.03,
  CIRCUIT_BREAKER_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes

  // --- Order Execution ---
  MAKER_FILL_TIMEOUT_MS: 30_000,
  USE_MAKER_ORDERS: true,

  // --- Candle Timeframe ---
  CANDLE_INTERVAL: '4h' as string, // Was 15m — backtest: 15m=21%WR/-$1030, 1h=26%WR/-$1669, 4h=27%WR/-$455. 4h gives trends room past 0.52% fees.

  // --- Exit Management ---
  STOP_LOSS_ATR_MULT: 1.5,  // 2026-06-03: 2.0→1.5. Live data: SL avg -$11.13 vs trail avg +$2.13 (5.2:1 ratio). Tighter SL cuts loss size ~33%. Backtest: +$6,391→+$7,186, PF 9.07→9.50.
  TAKE_PROFIT_ATR_MULT: 4.0,       // 2026-04-29: 3.5 → 4.0 (R:R 1.4 → 1.6). Avg_win problem: at R:R 1.4 the cohort was avg_win $0.97 vs needed ~$1.10 for 59% WR break-even. Wider TP makes individual TP hits +$2.00 instead of +$1.75. Risk: historical R:R 1.6 cohort underperformed R:R 1.4 (-$10.89 vs -$1.89), but that was without working BE/trailing stops. With current trailing-active@1% catching moderate winners, wider TP may behave differently. Deliberate test under user's risk-on framing 2026-04-29.
  TRAILING_ACTIVATE_PERCENT: 0.01, // 2026-05-18: 0.025→0.015. At 2.5% most trades peaked +1-2% and never trailed. At 1.5% trailing engages on moderate moves — PF 1.67→3.71, time_kill 72→26 trades.
  TRAILING_GIVEBACK_PERCENT: 0.03,  // 2026-05-06 Config A: 0.25 → 0.03 — extreme tight trail. Once activated, surrender only 3% of peak gain. The trailing-exit P&L moved from +$216 (PF 1.43) to +$312 (PF 1.62) on AKT+ZEC+COMP 90d
  TIME_KILL_MS: 6 * 60 * 60 * 1000,      // 6h — was 8h; backtest shows time_kill is #1 PnL drag (-$125/128 trades). Cutting 2h earlier reduces fee bleed on stale positions.
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
// Multi-Timeframe Strategy Configuration
// ============================================

// Which timeframes each strategy runs on
export const STRATEGY_TIMEFRAMES: Record<string, string[]> = {
  TREND:           ['4h'],  // 2026-06-19: dropped 1h/30m. VPS-claude removed 30m (2026-06-13, 4 trades, 1 win, -$21.29). Local-claude also removed 1h (TAO -$6.41, ZEC -$4.60, -$1.94). 4h only.
  MOMENTUM:        ['1h', '4h'],
  // BREAKOUT disabled 2026-06-09 — live post-baseline: 2/12 wins (17%), -$50.28.
  // Still losing after the 2026-06-01 executor-SL fix (Jun 8: 4 trades, -$7.69).
  // Re-enable only after a walk-forward refit validates positive OOS expectancy.
  // BREAKOUT:        ['15m', '30m', '1h'],
  // MEAN_REVERSION and SCALP disabled — live data: 0% and 22% WR respectively
};

// Per-strategy exit parameters
export interface StrategyExitConfig {
  slAtrMult: number;
  tpAtrMult: number;
  trailActivatePercent: number;
  trailGivebackPercent: number;
  timeKillBars: number;      // bars to hold before time-kill
  timeKillMinMove: number;
  quickKillBars: number;     // bars before quick-kill tightens
  quickKillMinGain: number;
  quickKillSlMult: number;
  useTrailing: boolean;
}

export const STRATEGY_EXIT_CONFIGS: Record<string, StrategyExitConfig> = {
  TREND: {
    slAtrMult: 1.5, tpAtrMult: 4.0,
    // 2026-06-09: 0.025→0.01 to match V2_CONFIG.TRAILING_ACTIVATE_PERCENT.
    // exitManager reads ONLY this value — V2_CONFIG's tuned 0.01 was dead config
    // since 2026-05-18 while live trades silently trailed at 2.5% (the backtest
    // that justified 0.01/0.015 claimed PF 1.67→3.71 from this one change).
    trailActivatePercent: 0.014, trailGivebackPercent: 0.03,  // 2026-06-19: 0.01→0.014 (~75% of 1.8% typical TP). At 1%, trail activated in noise zone — reversals still netted below breakeven after fees. At 1.4%, minimum locked-in gross is ~1.35%.
    timeKillBars: 2, timeKillMinMove: 0.007,
    quickKillBars: 1, quickKillMinGain: 0.006, quickKillSlMult: 1.2,
    useTrailing: true,
  },
  MOMENTUM: {
    slAtrMult: 1.5, tpAtrMult: 3.0,
    trailActivatePercent: 0.025, trailGivebackPercent: 0.05,
    timeKillBars: 4, timeKillMinMove: 0.005,
    quickKillBars: 2, quickKillMinGain: 0.006, quickKillSlMult: 1.2,
    useTrailing: true,
  },
  BREAKOUT: {
    slAtrMult: 1.5, tpAtrMult: 3.0,
    trailActivatePercent: 0.02, trailGivebackPercent: 0.04,
    timeKillBars: 8, timeKillMinMove: 0.005,
    quickKillBars: 2, quickKillMinGain: 0.004, quickKillSlMult: 1.0,
    useTrailing: true,
  },
  MEAN_REVERSION: {
    slAtrMult: 2.0, tpAtrMult: 1.5,  // tight TP — MR targets mean reversion, not trend
    trailActivatePercent: 0.01, trailGivebackPercent: 0.10,
    timeKillBars: 8, timeKillMinMove: 0.003,
    quickKillBars: 2, quickKillMinGain: 0.002, quickKillSlMult: 0.8,
    useTrailing: false,  // MR exits at TP or SL, no trailing
  },
  SCALP: {
    slAtrMult: 0.75, tpAtrMult: 1.0,
    trailActivatePercent: 0.005, trailGivebackPercent: 0.15,
    timeKillBars: 30, timeKillMinMove: 0.002,
    quickKillBars: 10, quickKillMinGain: 0.001, quickKillSlMult: 0.5,
    useTrailing: false,
  },
};

// Per-strategy cooldown (scales with timeframe)
export const STRATEGY_COOLDOWN_MS: Record<string, number> = {
  TREND:          8 * 3600 * 1000,   // 8h
  MOMENTUM:       8 * 3600 * 1000,   // 8h
  BREAKOUT:       2 * 3600 * 1000,   // 2h
  MEAN_REVERSION: 30 * 60 * 1000,    // 30min
  SCALP:          10 * 60 * 1000,    // 10min
};

// ADX routing thresholds (Average Directional Index, 0–100)
// ADX > TREND_MIN: genuinely trending → run TREND signals only
// ADX < MR_MAX: ranging / choppy → run MEAN_REVERSION signals only
// Between: dead zone, skip both (neither strategy has edge here)
export const ADX_THRESHOLDS = {
  TREND_MIN: 25,
  MR_MAX: 20,
} as const;

// Convert timeframe string to milliseconds
export function timeframeToMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  };
  return map[tf] ?? 3_600_000;
}

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
  ENABLED: true,    // 2026-05-18: REBUILT — now routes through main TREND pipeline (same riskGate, exitManager, all guards). No separate engine loop.
  MIN_CONFIDENCE: 0.65,

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
  ENABLED: true,             // master enable — both kraken + cryptocom respect this

  // --- Per-exchange budgets + enable flags (2026-05-06: dual-exchange) ---
  KRAKEN_ENABLED: true,
  CRYPTOCOM_ENABLED: true,
  KRAKEN_BUDGET_USD: 500,
  CRYPTOCOM_BUDGET_USD: 500,

  // Legacy field — used by single-exchange code paths if any remain. Kept for
  // back-compat; the dual setup uses KRAKEN_BUDGET_USD / CRYPTOCOM_BUDGET_USD.
  BUDGET_USD: 500,
  STRATEGY_TAG: 'SNIPER' as const,

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
  // 2026-06-19: Rebuilt from 15m long-only (0/4 wins, -$2.80 live) to
  // 1h dual-direction with ADX<20 gate. Root causes of failure:
  //   1. 15m too noisy — reversion signal drowned in noise
  //   2. BTCUSD/ETHUSD tickers wrong — these trend; ranging MR needs the
  //      same mid-cap tickers as TREND (AKT, ZEC, FET, etc.)
  //   3. No ADX gate — was entering ranging AND trending markets
  //   4. Long-only — missed 50% of MR opportunities (overbought shorts)
  ENABLED: true,
  CANDLE_INTERVAL: '1h' as string,
  ALLOWED_REGIMES: ['SIDEWAYS'] as readonly string[],
  SCAN_TICKERS: [
    'AKTUSD', 'ZECUSD', 'FETUSD', 'PENGUUSD', 'TAOUSD', 'PENDLEUSD',
  ] as string[],

  // ADX gate — only enter when market is ranging (primary gate)
  ADX_MAX_FOR_ENTRY: 20,

  // Long entry: oversold at lower Bollinger Band
  RSI_LONG_THRESHOLD: 28,        // tightened from 30 — more extreme oversold required
  BB_LONG_THRESHOLD: 0.15,       // %B < 0.15 (near lower band)

  // Short entry: overbought at upper Bollinger Band
  SHORTS_ENABLED: true,
  RSI_SHORT_THRESHOLD: 72,       // RSI > 72 = overbought
  BB_SHORT_THRESHOLD: 0.85,      // %B > 0.85 (near upper band)

  // Legacy field used by meanReversionSignal.ts (still referenced; points to long threshold)
  RSI_THRESHOLD: 28,
  BB_PERCENT_B_THRESHOLD: 0.15,

  MAX_ATR_PERCENT: 5.0,          // widened from 3.0 — mid-caps can ATR 4%+ on 1h
  MIN_CANDLES: 50,

  POSITION_SIZE_PERCENT: 0.40,   // matched to TREND — same risk per trade
  MAX_POSITION_PERCENT: 0.50,
  MAX_OPEN_POSITIONS: 2,         // MR can hold long + short on different tickers

  STOP_LOSS_ATR_MULT: 1.5,
  TIME_KILL_BARS: 6,             // 6 × 1h = 6h — MR trades not reverting in 6h likely won't
  TIME_KILL_MIN_MOVE: 0.003,
  QUICK_KILL_AFTER_BARS: 3,      // 3 × 1h = 3h
  QUICK_KILL_MIN_GAIN: 0.003,
  QUICK_KILL_SL_ATR_MULT: 0.8,

  USE_MAKER_ORDERS: true,
  FEE_ROUND_TRIP: 0.0032,        // Maker both sides → 0.32% RT vs TREND's 0.42%

  BOT_LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 30_000,        // 30s stagger from TREND loop
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

// ============================================
// Pairs Trading (cross-asset cointegration)
// Deployment plan: docs/plans/2026-05-26-pairs-deployment-plan.md
// Backtest validation: v2/backtest/canonical (commit 37709b1)
//   FIL/ICP walk-forward: IS +2.79% → OOS +11.28% (fragility 4.05)
// ============================================
export type PairsMode = 'off' | 'paper' | 'live';

export const PAIRS_CONFIG = {
  /**
   * 'off'   — engine doesn't run
   * 'paper' — engine fires signals, logs decisions, simulated fills only
   * 'live'  — submits real margin orders (NOT IMPLEMENTED THIS SESSION;
   *           paper-only for now)
   */
  MODE: (process.env.PAIRS_MODE ?? 'off') as PairsMode,

  // Symbols. Keep generic 'A/B' naming so swapping pairs is a single config edit.
  SYMBOL_A: 'FILUSD',
  SYMBOL_B: 'ICPUSD',

  // Cadence + windows.
  LOOP_INTERVAL_MS: 60_000,           // every 60s
  CANDLE_INTERVAL: '1h' as const,
  ROLLING_WINDOW_BARS: 720,            // 30 days on 1h — matches backtest
  REESTIMATE_BETA_EVERY_BARS: 120,     // 5 days on 1h
  WARMUP_BARS: 720,                    // = ROLLING_WINDOW (Kraken returns 720 on this interval)

  // Signal thresholds (matches backtest 'tight' variant — the best-WF cell).
  ENTRY_Z: 1.5,
  EXIT_Z: 0.3,
  STOP_Z: 4.0,
  MAX_HOLD_BARS: 200,
  ALLOW_SHORT_SPREAD: true,           // both directions of spread divergence

  // Sizing.
  TOTAL_NOTIONAL_USD: 1000,            // total exposure cap (sum of both legs)
  LEG_NOTIONAL_USD: 500,               // per-leg notional (equal-$ hedge)
  MIN_LEG_NOTIONAL_USD: 50,            // refuse trades below this

  // Fees (Kraken; per leg per side).
  FEE_PER_LEG_TAKER: 0.0026,
  FEE_PER_LEG_MAKER: -0.0005,          // negative = rebate at tier 2

  // Slippage assumption for paper-mode fills (per leg per side).
  SLIPPAGE_PER_SIDE: 0.0005,

  // Cointegration gate. Refuse new entries if rolling ADF t-stat is weaker
  // than this threshold (less negative = weaker cointegration).
  REQUIRE_ADF_T_BELOW: -2.86,          // 5% critical value

  // Kill switches.
  MAX_DRAWDOWN_PCT_PER_TRADE: 0.03,    // 3% drawdown on the allocation
  CONSECUTIVE_LOSS_PAUSE_THRESHOLD: 3,
  PAUSE_DURATION_HOURS: 168,           // 7 days
} as const;
