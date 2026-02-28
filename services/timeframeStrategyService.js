/**
 * Timeframe Strategy Service
 *
 * Maps 12 trading timeframes to Kraken candle intervals with per-timeframe
 * entry criteria, profit targets, stop losses, position sizing, and strategy
 * selection. Supports two market-speed variants (SLOW / FAST) so the bot
 * automatically adapts its strategy mix and risk parameters to current
 * conditions.
 *
 * Kraken available intervals (minutes): 1, 5, 15, 30, 60, 240, 1440, 10080.
 * Where exact matches don't exist we fall back to the nearest supported value.
 *
 * Candle shape convention: { o, h, l, c, v } (matching server.js / beastMode.js).
 */

// ============================================
// TIMEFRAME DEFINITIONS (12 timeframes)
// ============================================

/**
 * @typedef {Object} TimeframeDef
 * @property {string}  id             - Human-readable label (e.g. '15m', '1d')
 * @property {number}  minutes        - Logical duration in minutes
 * @property {number}  krakenInterval - Nearest Kraken-supported interval (minutes)
 * @property {number}  profitTarget   - Base profit target (percent)
 * @property {number}  stopLoss       - Base stop loss (percent)
 * @property {number}  positionSize   - Base position size as % of portfolio
 * @property {number}  minConfidence  - Minimum signal confidence (0-100)
 * @property {number}  minOppScore    - Minimum opportunity score (20-35 range)
 * @property {number}  maxHoldMs      - Max hold duration in milliseconds (2x the timeframe)
 */

/** @type {TimeframeDef[]} */
export const TIMEFRAME_DEFINITIONS = [
  {
    id: '15m',
    minutes: 15,
    krakenInterval: 15,
    profitTarget: 0.50,
    stopLoss: 0.30,
    positionSize: 20,
    minConfidence: 30,
    minOppScore: 20,
    maxHoldMs: 15 * 60 * 1000 * 2,
  },
  {
    id: '30m',
    minutes: 30,
    krakenInterval: 30,
    profitTarget: 0.65,
    stopLoss: 0.40,
    positionSize: 18,
    minConfidence: 33,
    minOppScore: 20,
    maxHoldMs: 30 * 60 * 1000 * 2,
  },
  {
    id: '1h',
    minutes: 60,
    krakenInterval: 60,
    profitTarget: 0.85,
    stopLoss: 0.50,
    positionSize: 16,
    minConfidence: 36,
    minOppScore: 22,
    maxHoldMs: 60 * 60 * 1000 * 2,
  },
  {
    id: '2h',
    minutes: 120,
    krakenInterval: 60,     // Kraken has no 120, fall back to 60
    profitTarget: 1.00,
    stopLoss: 0.60,
    positionSize: 15,
    minConfidence: 40,
    minOppScore: 22,
    maxHoldMs: 120 * 60 * 1000 * 2,
  },
  {
    id: '3h',
    minutes: 180,
    krakenInterval: 60,     // Kraken has no 180, fall back to 60
    profitTarget: 1.20,
    stopLoss: 0.75,
    positionSize: 14,
    minConfidence: 42,
    minOppScore: 24,
    maxHoldMs: 180 * 60 * 1000 * 2,
  },
  {
    id: '6h',
    minutes: 360,
    krakenInterval: 240,    // Kraken has no 360, fall back to 240
    profitTarget: 1.50,
    stopLoss: 1.00,
    positionSize: 12,
    minConfidence: 45,
    minOppScore: 24,
    maxHoldMs: 360 * 60 * 1000 * 2,
  },
  {
    id: '12h',
    minutes: 720,
    krakenInterval: 240,    // Kraken has no 720, fall back to 240
    profitTarget: 2.00,
    stopLoss: 1.25,
    positionSize: 10,
    minConfidence: 48,
    minOppScore: 26,
    maxHoldMs: 720 * 60 * 1000 * 2,
  },
  {
    id: '1d',
    minutes: 1440,
    krakenInterval: 1440,
    profitTarget: 2.50,
    stopLoss: 1.50,
    positionSize: 8,
    minConfidence: 52,
    minOppScore: 28,
    maxHoldMs: 1440 * 60 * 1000 * 2,
  },
  {
    id: '2d',
    minutes: 2880,
    krakenInterval: 1440,   // Kraken has no 2880, fall back to 1440
    profitTarget: 3.00,
    stopLoss: 1.80,
    positionSize: 7,
    minConfidence: 55,
    minOppScore: 28,
    maxHoldMs: 2880 * 60 * 1000 * 2,
  },
  {
    id: '3d',
    minutes: 4320,
    krakenInterval: 1440,   // Kraken has no 4320, fall back to 1440
    profitTarget: 3.50,
    stopLoss: 2.20,
    positionSize: 6,
    minConfidence: 58,
    minOppScore: 30,
    maxHoldMs: 4320 * 60 * 1000 * 2,
  },
  {
    id: '5d',
    minutes: 7200,
    krakenInterval: 10080,  // Kraken has no 7200, use weekly
    profitTarget: 4.00,
    stopLoss: 2.50,
    positionSize: 6,
    minConfidence: 60,
    minOppScore: 32,
    maxHoldMs: 7200 * 60 * 1000 * 2,
  },
  {
    id: '1wk',
    minutes: 10080,
    krakenInterval: 10080,
    profitTarget: 5.00,
    stopLoss: 3.00,
    positionSize: 5,
    minConfidence: 65,
    minOppScore: 35,
    maxHoldMs: 10080 * 60 * 1000 * 2,
  },
];

// Lookup by id for O(1) access
const _defById = new Map(TIMEFRAME_DEFINITIONS.map(d => [d.id, d]));

// ============================================
// STRATEGY / PROFIT-METHOD POOLS
// ============================================

/** Strategies appropriate for slow / ranging markets.
 *  Walk-forward OOS validation (Feb 2026): Only TREND is net profitable.
 *  All other strategies (BREAKOUT, MOMENTUM, WHALE, CONFLUENCE, DIVERGENCE) lose money OOS.
 *  ADAPTIVE kept as fallback — it adapts based on learned adaptive weights. */
const SLOW_STRATEGIES = ['TREND', 'ADAPTIVE'];

/** Strategies appropriate for fast / trending markets.
 *  TREND-only validated profitable: +16.68% OOS, 50.5% WR, 7/9 folds profitable. */
const FAST_STRATEGIES = ['TREND', 'ADAPTIVE'];

/** Profit methods suited to slow markets (spread-capture / accumulation). */
const SLOW_PROFIT_METHODS = ['Grid', 'MarketMaking'];

/** Profit methods suited to fast markets (directional / DCA on dips). */
const FAST_PROFIT_METHODS = ['Swing', 'DCA'];

/**
 * Per-timeframe strategy overrides.  Shorter timeframes favour momentum /
 * breakout regardless of speed, while longer timeframes lean toward trend /
 * swing.  These act as a *base* that gets intersected with the speed pool.
 */
const TF_STRATEGY_BIAS = {
  '15m':  ['BREAKOUT', 'MOMENTUM', 'TREND', 'RANGE', 'MEAN_REVERSION', 'ADAPTIVE'],
  '30m':  ['BREAKOUT', 'MOMENTUM', 'TREND', 'RANGE', 'MEAN_REVERSION', 'ADAPTIVE'],
  '1h':   ['TREND', 'MOMENTUM', 'BREAKOUT', 'CONFLUENCE', 'RANGE', 'ADAPTIVE', 'DIVERGENCE'],
  '2h':   ['TREND', 'MOMENTUM', 'BREAKOUT', 'CONFLUENCE', 'RANGE', 'ADAPTIVE', 'DIVERGENCE'],
  '3h':   ['TREND', 'CONFLUENCE', 'MOMENTUM', 'ADAPTIVE', 'DIVERGENCE', 'RANGE'],
  '6h':   ['TREND', 'CONFLUENCE', 'ADAPTIVE', 'DIVERGENCE', 'MEAN_REVERSION', 'RANGE'],
  '12h':  ['TREND', 'CONFLUENCE', 'ADAPTIVE', 'DIVERGENCE', 'MEAN_REVERSION'],
  '1d':   ['TREND', 'CONFLUENCE', 'ADAPTIVE', 'DIVERGENCE', 'MEAN_REVERSION'],
  '2d':   ['TREND', 'ADAPTIVE', 'DIVERGENCE', 'MEAN_REVERSION'],
  '3d':   ['TREND', 'ADAPTIVE', 'DIVERGENCE', 'MEAN_REVERSION'],
  '5d':   ['TREND', 'ADAPTIVE', 'DIVERGENCE'],
  '1wk':  ['TREND', 'ADAPTIVE', 'DIVERGENCE'],
};

/**
 * Per-timeframe profit-method bias. Shorter TFs favour Grid / MarketMaking,
 * longer TFs favour Swing / DCA.
 */
const TF_PROFIT_METHOD_BIAS = {
  '15m':  ['Grid', 'MarketMaking', 'DCA'],
  '30m':  ['Grid', 'MarketMaking', 'DCA'],
  '1h':   ['Grid', 'MarketMaking', 'DCA', 'Swing'],
  '2h':   ['Grid', 'DCA', 'Swing'],
  '3h':   ['DCA', 'Swing', 'Grid'],
  '6h':   ['Swing', 'DCA', 'Grid'],
  '12h':  ['Swing', 'DCA'],
  '1d':   ['Swing', 'DCA'],
  '2d':   ['Swing', 'DCA'],
  '3d':   ['Swing', 'DCA'],
  '5d':   ['Swing'],
  '1wk':  ['Swing'],
};

// ============================================
// MARKET SPEED DETECTION
// ============================================

/**
 * Detect whether the market is currently SLOW or FAST.
 *
 * Criteria (all based on the most recent candle window):
 *   - ATR as percent of price (< 0.8% => SLOW — crypto is inherently volatile)
 *   - Volume vs 20-period moving average (< 0.9x => SLOW)
 *   - Average candle body-to-range ratio (< 0.40 => SLOW, meaning indecisive candles)
 *
 * A majority-vote of the three metrics decides the final label.
 *
 * @param {Array<{o:number,h:number,l:number,c:number,v:number}>} candles
 * @returns {'SLOW'|'FAST'}
 */
export function detectMarketSpeed(candles) {
  if (!candles || candles.length < 21) {
    // Not enough data -- assume FAST (higher caution default)
    return 'FAST';
  }

  const recent = candles.slice(-21);
  const price = recent[recent.length - 1].c;

  // --- 1. ATR as % of price ---
  let atrSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].h - recent[i].l,
      Math.abs(recent[i].h - recent[i - 1].c),
      Math.abs(recent[i].l - recent[i - 1].c),
    );
    atrSum += tr;
  }
  const atr = atrSum / (recent.length - 1);
  const atrPercent = (atr / price) * 100;
  const atrVote = atrPercent < 0.8 ? 'SLOW' : 'FAST';

  // --- 2. Volume vs 20-period average ---
  const volumes = recent.map(c => c.v || 0);
  const volAvg = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const latestVol = volumes[volumes.length - 1];
  const volRatio = volAvg > 0 ? latestVol / volAvg : 1;
  const volVote = volRatio < 0.9 ? 'SLOW' : 'FAST';

  // --- 3. Body-to-range ratio ---
  let bodyRatioSum = 0;
  let counted = 0;
  for (const c of recent) {
    const range = c.h - c.l;
    if (range > 0) {
      bodyRatioSum += Math.abs(c.c - c.o) / range;
      counted++;
    }
  }
  const avgBodyRatio = counted > 0 ? bodyRatioSum / counted : 0.5;
  const bodyVote = avgBodyRatio < 0.40 ? 'SLOW' : 'FAST';

  // Majority vote
  const slowVotes = [atrVote, volVote, bodyVote].filter(v => v === 'SLOW').length;
  return slowVotes >= 2 ? 'SLOW' : 'FAST';
}

// ============================================
// PROFILE BUILDER
// ============================================

/**
 * Build a complete trading profile for a given timeframe and market speed.
 *
 * SLOW adjustments:
 *   - Strategies: RANGE, MEAN_REVERSION, ADAPTIVE, DIVERGENCE
 *   - Profit methods: Grid, MarketMaking
 *   - Wider stop loss (+40%)
 *   - Lower confidence requirement (-15%)
 *   - Lower opportunity score requirement (-1)
 *
 * FAST adjustments:
 *   - Strategies: TREND, MOMENTUM, BREAKOUT, CONFLUENCE
 *   - Profit methods: Swing, DCA
 *   - Tighter stop loss (-15%)
 *   - Higher confidence requirement (+10%)
 *   - Higher opportunity score requirement (+1)
 *
 * @param {string} timeframeId  One of the 12 timeframe ids (e.g. '1h', '1d')
 * @param {'SLOW'|'FAST'} marketSpeed
 * @returns {Object} Full profile object
 */
export function getTimeframeProfile(timeframeId, marketSpeed = 'FAST') {
  const def = _defById.get(timeframeId);
  if (!def) {
    throw new Error(`Unknown timeframe id: "${timeframeId}". ` +
      `Valid ids: ${TIMEFRAME_DEFINITIONS.map(d => d.id).join(', ')}`);
  }

  const speed = marketSpeed === 'SLOW' ? 'SLOW' : 'FAST';

  // --- Strategy selection ---
  const speedStrategies = speed === 'SLOW' ? SLOW_STRATEGIES : FAST_STRATEGIES;
  const tfBias = TF_STRATEGY_BIAS[def.id] || speedStrategies;
  // Intersect: keep only strategies that appear in both the speed pool and TF bias
  let activeStrategies = tfBias.filter(s => speedStrategies.includes(s));
  // Guarantee at least ADAPTIVE as a fallback
  if (activeStrategies.length === 0) {
    activeStrategies = ['ADAPTIVE'];
  }

  // --- Profit method selection ---
  const speedMethods = speed === 'SLOW' ? SLOW_PROFIT_METHODS : FAST_PROFIT_METHODS;
  const tfMethodBias = TF_PROFIT_METHOD_BIAS[def.id] || speedMethods;
  let activeProfitMethods = tfMethodBias.filter(m => speedMethods.includes(m));
  if (activeProfitMethods.length === 0) {
    activeProfitMethods = speedMethods.slice(0, 1); // At least one method
  }

  // --- Numeric adjustments ---
  let profitTarget = def.profitTarget;
  let stopLoss = def.stopLoss;
  let minConfidence = def.minConfidence;
  let minOppScore = def.minOppScore;
  let positionSizePercent = def.positionSize;

  if (speed === 'SLOW') {
    stopLoss = +(stopLoss * 1.40).toFixed(2);            // Wider stops in slow markets
    minConfidence = Math.max(15, Math.round(minConfidence * 0.85)); // Lower bar
    minOppScore = Math.max(8, minOppScore - 1);
    positionSizePercent = Math.min(25, positionSizePercent + 2);   // Slightly larger (low vol = lower risk)
  } else {
    stopLoss = +(stopLoss * 0.85).toFixed(2);            // Tighter stops in fast markets
    minConfidence = Math.min(95, Math.round(minConfidence * 1.10)); // Higher bar
    minOppScore = Math.min(15, minOppScore + 1);
    positionSizePercent = Math.max(3, positionSizePercent - 2);    // Slightly smaller (high vol = higher risk)
  }

  return {
    timeframeId: def.id,
    krakenInterval: def.krakenInterval,
    marketSpeed: speed,
    entry: {
      minConfidence,
      minOpportunityScore: minOppScore,
    },
    profitTarget,
    stopLoss,
    positionSizePercent,
    maxHoldDuration: def.maxHoldMs,
    activeStrategies,
    activeProfitMethods,
  };
}

// ============================================
// QUERIES
// ============================================

/**
 * Return the full list of 12 timeframe definitions.
 *
 * @returns {TimeframeDef[]}
 */
export function getAllTimeframes() {
  return TIMEFRAME_DEFINITIONS.slice(); // shallow copy to prevent mutation
}

/**
 * Recommend the single best timeframe to trade based on current candle data.
 *
 * Heuristic:
 *   1. Compute ATR-based volatility percentage.
 *   2. Compute a simple trend-strength score (EMA-10 vs EMA-20 slope).
 *   3. In SLOW markets prefer longer timeframes (more room for mean reversion).
 *      In FAST markets prefer shorter timeframes (capture momentum quickly).
 *   4. Within the preferred group, pick the timeframe whose volatility window
 *      best matches the ATR.
 *
 * @param {Array<{o:number,h:number,l:number,c:number,v:number}>} candles
 * @param {'SLOW'|'FAST'} [marketSpeed] - If omitted, auto-detected from candles.
 * @returns {{ timeframeId: string, reason: string }}
 */
export function getBestTimeframe(candles, marketSpeed) {
  const speed = marketSpeed || detectMarketSpeed(candles);

  if (!candles || candles.length < 21) {
    return {
      timeframeId: speed === 'SLOW' ? '1h' : '15m',
      reason: 'Insufficient candle data; defaulting to safe timeframe.',
    };
  }

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];

  // ATR percent
  let atrSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
    atrSum += tr;
  }
  const atrPct = ((atrSum / (candles.length - 1)) / price) * 100;

  // Trend strength via EMA-10 slope (last 5 bars)
  const ema10 = _ema(closes, 10);
  const slopeLen = Math.min(5, ema10.length - 1);
  const emaSlope = slopeLen > 0
    ? ((ema10[ema10.length - 1] - ema10[ema10.length - 1 - slopeLen]) / ema10[ema10.length - 1]) * 100
    : 0;
  const trendStrength = Math.abs(emaSlope);

  // Pick candidate pool based on speed
  let candidates;
  if (speed === 'SLOW') {
    // Prefer mid-to-long timeframes in slow markets
    candidates = TIMEFRAME_DEFINITIONS.filter(d => d.minutes >= 60);
  } else {
    // Prefer short-to-mid timeframes in fast markets
    candidates = TIMEFRAME_DEFINITIONS.filter(d => d.minutes <= 720);
  }

  // Score each candidate: how well does its profit target align with the ATR?
  // Also factor in trend strength -- strong trend favours shorter TFs.
  let best = candidates[0];
  let bestScore = -Infinity;

  for (const c of candidates) {
    // Volatility fit: prefer TF whose profitTarget is 1-3x the ATR percent
    const volFit = 1 - Math.abs(c.profitTarget - atrPct * 2) / c.profitTarget;

    // Trend bonus: strong trend => prefer shorter
    const trendFit = trendStrength > 0.1
      ? (1 - c.minutes / 10080) * trendStrength * 10
      : 0;

    const score = volFit + trendFit;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  const reasons = [];
  if (speed === 'SLOW') reasons.push('slow market detected');
  else reasons.push('fast market detected');
  reasons.push(`ATR ${atrPct.toFixed(3)}%`);
  if (trendStrength > 0.1) reasons.push(`trend strength ${trendStrength.toFixed(2)}`);

  return {
    timeframeId: best.id,
    reason: `Best fit: ${best.id} (${reasons.join(', ')}).`,
  };
}

/**
 * Return the 3-4 most appropriate timeframe profiles for the given market speed.
 *
 * SLOW market selection (4 profiles):
 *   - 1h   (short-term range trading)
 *   - 6h   (mid-term mean reversion)
 *   - 1d   (daily range / swing)
 *   - 3d   (longer swing / position)
 *
 * FAST market selection (3 profiles):
 *   - 15m  (scalping / quick momentum)
 *   - 1h   (intraday trend)
 *   - 6h   (swing confirmation)
 *
 * @param {'SLOW'|'FAST'} marketSpeed
 * @returns {Object[]} Array of profile objects (from getTimeframeProfile)
 */
export function getActiveProfilesForBot(marketSpeed) {
  const speed = marketSpeed === 'SLOW' ? 'SLOW' : 'FAST';

  const ids = speed === 'SLOW'
    ? ['1h', '6h', '1d', '3d']
    : ['15m', '1h', '6h'];

  return ids.map(id => getTimeframeProfile(id, speed));
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Simple EMA calculation.
 *
 * @param {number[]} data
 * @param {number}   period
 * @returns {number[]}
 */
function _ema(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}
