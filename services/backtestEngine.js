/**
 * Backtesting Engine
 *
 * Replays historical candle data through strategy logic to evaluate performance.
 * Loads candles from SQLite, simulates trades with configurable strategies,
 * and produces detailed performance metrics.
 *
 * Strategies: TREND, BREAKOUT, MOMENTUM, SWING
 */

import { getDb } from './database.js';

// ============================================
// CONSTANTS
// ============================================
const MIN_CANDLES = 30;
const MINUTES_PER_YEAR = 525600;

/** Map timeframe strings to their duration in minutes for annualization. */
const TIMEFRAME_MINUTES = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

// ============================================
// INDICATOR HELPERS
// ============================================

/**
 * Exponential Moving Average over an array of numeric values.
 * Returns an array the same length as `values`; the first element equals values[0].
 * @param {number[]} values
 * @param {number}   period
 * @returns {number[]}
 */
function calcEMA(values, period) {
  if (values.length === 0) return [];

  const k = 2 / (period + 1);
  const ema = [values[0]];

  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/**
 * Relative Strength Index (Wilder smoothing).
 * Returns an array the same length as `closes`.
 * The first `period` entries are null (not enough data).
 * @param {number[]} closes
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  // Seed averages from the first `period` changes
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

/**
 * Compute the maximum drawdown and maximum drawdown percentage from an
 * array of portfolio equity values.
 * @param {number[]} equityCurve
 * @returns {{ maxDrawdown: number, maxDrawdownPercent: number }}
 */
function calcMaxDrawdown(equityCurve) {
  let peak = -Infinity;
  let maxDD = 0;
  let maxDDPercent = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPercent = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  return { maxDrawdown: maxDD, maxDrawdownPercent: maxDDPercent };
}

/**
 * Annualized Sharpe Ratio from an array of per-bar returns.
 * Assumes risk-free rate = 0.
 * @param {number[]} returns    - per-candle fractional returns
 * @param {number}   barsPerYear - how many bars fit in a year
 * @returns {number}
 */
function calcSharpeRatio(returns, barsPerYear) {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(barsPerYear);
}

// ============================================
// STRATEGY SIGNAL GENERATORS
// ============================================

/**
 * Each strategy function receives the full candle array and the current index,
 * and returns a signal string: 'BUY', 'SELL', or null.
 * The candle window up to `index` (inclusive) is guaranteed to have >= MIN_CANDLES entries.
 */

/**
 * TREND: EMA(10) crosses above EMA(30) = BUY, crosses below = SELL
 */
function trendSignal(candles, index) {
  if (index < 1) return null;

  const closes = candles.slice(0, index + 1).map((c) => c.c);
  const ema10 = calcEMA(closes, 10);
  const ema30 = calcEMA(closes, 30);

  const prevEma10 = ema10[ema10.length - 2];
  const prevEma30 = ema30[ema30.length - 2];
  const currEma10 = ema10[ema10.length - 1];
  const currEma30 = ema30[ema30.length - 1];

  // Crossover detection
  if (prevEma10 <= prevEma30 && currEma10 > currEma30) return 'BUY';
  if (prevEma10 >= prevEma30 && currEma10 < currEma30) return 'SELL';
  return null;
}

/**
 * BREAKOUT: Price breaks above 20-candle high = BUY,
 *           breaks below 20-candle low = SELL
 */
function breakoutSignal(candles, index) {
  if (index < 20) return null;

  const lookback = candles.slice(index - 20, index); // previous 20 candles (not including current)
  const high20 = Math.max(...lookback.map((c) => c.h));
  const low20 = Math.min(...lookback.map((c) => c.l));
  const currentClose = candles[index].c;

  if (currentClose > high20) return 'BUY';
  if (currentClose < low20) return 'SELL';
  return null;
}

/**
 * MOMENTUM: RSI(14) crosses above 30 = BUY, crosses below 70 = SELL
 */
function momentumSignal(candles, index) {
  if (index < 15) return null; // need at least period + 1 bars for a previous RSI

  const closes = candles.slice(0, index + 1).map((c) => c.c);
  const rsi = calcRSI(closes, 14);

  const prevRSI = rsi[rsi.length - 2];
  const currRSI = rsi[rsi.length - 1];

  if (prevRSI === null || currRSI === null) return null;

  // Cross above 30 (oversold recovery)
  if (prevRSI <= 30 && currRSI > 30) return 'BUY';
  // Cross below 70 (overbought reversal)
  if (prevRSI >= 70 && currRSI < 70) return 'SELL';
  return null;
}

/**
 * SWING: Price bounces off support (20-candle low + 1%) = BUY,
 *        hits resistance (20-candle high - 1%) = SELL
 */
function swingSignal(candles, index) {
  if (index < 20) return null;

  const lookback = candles.slice(index - 20, index);
  const high20 = Math.max(...lookback.map((c) => c.h));
  const low20 = Math.min(...lookback.map((c) => c.l));
  const currentClose = candles[index].c;

  const supportZone = low20 * 1.01; // 1% above the 20-candle low
  const resistanceZone = high20 * 0.99; // 1% below the 20-candle high

  if (currentClose <= supportZone) return 'BUY';
  if (currentClose >= resistanceZone) return 'SELL';
  return null;
}

/**
 * WHALE: Volume spike > 3x average = BUY, drops back with price decline = SELL
 */
function whaleSignal(candles, index) {
  if (index < 20) return null;
  const volumes = candles.slice(index - 20, index).map(c => c.v);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const currentVol = candles[index].v;
  if (currentVol > avgVol * 3 && candles[index].c > candles[index].o) return 'BUY';
  if (currentVol > avgVol * 2 && candles[index].c < candles[index].o) return 'SELL';
  return null;
}

/**
 * CONFLUENCE: Multiple signals align = BUY/SELL
 */
function confluenceSignal(candles, index) {
  let bullish = 0, bearish = 0;
  const t = trendSignal(candles, index);
  const m = momentumSignal(candles, index);
  const b = breakoutSignal(candles, index);
  if (t === 'BUY') bullish++; if (t === 'SELL') bearish++;
  if (m === 'BUY') bullish++; if (m === 'SELL') bearish++;
  if (b === 'BUY') bullish++; if (b === 'SELL') bearish++;
  if (bullish >= 2) return 'BUY';
  if (bearish >= 2) return 'SELL';
  return null;
}

/**
 * DIVERGENCE: RSI makes higher low while price makes lower low = BUY
 */
function divergenceSignal(candles, index) {
  if (index < 30) return null;
  const closes = candles.slice(0, index + 1).map(c => c.c);
  const rsiArr = calcRSI(closes, 14);
  const curr = rsiArr[rsiArr.length - 1];
  const prev = rsiArr[rsiArr.length - 10];
  if (prev === null || curr === null) return null;
  const priceNow = closes[closes.length - 1];
  const pricePrev = closes[closes.length - 10];
  // Bullish divergence
  if (priceNow < pricePrev && curr > prev && curr < 40) return 'BUY';
  // Bearish divergence
  if (priceNow > pricePrev && curr < prev && curr > 60) return 'SELL';
  return null;
}

/**
 * ADAPTIVE: Combines EMA crossover with volatility filter
 */
function adaptiveSignal(candles, index) {
  if (index < 30) return null;
  const closes = candles.slice(0, index + 1).map(c => c.c);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  // Volatility filter: only trade when ATR is above average
  const lookback = candles.slice(Math.max(0, index - 14), index + 1);
  const ranges = lookback.map(c => c.h - c.l);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const currRange = candles[index].h - candles[index].l;
  if (currRange < avgRange * 0.5) return null; // Too quiet
  const prev9 = ema9[ema9.length - 2], curr9 = ema9[ema9.length - 1];
  const prev21 = ema21[ema21.length - 2], curr21 = ema21[ema21.length - 1];
  if (prev9 <= prev21 && curr9 > curr21) return 'BUY';
  if (prev9 >= prev21 && curr9 < curr21) return 'SELL';
  return null;
}

/**
 * MA_CROSSOVER: EMA(5) / EMA(20) crossover
 */
function maCrossoverSignal(candles, index) {
  if (index < 1) return null;
  const closes = candles.slice(0, index + 1).map(c => c.c);
  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  const prev5 = ema5[ema5.length - 2], curr5 = ema5[ema5.length - 1];
  const prev20 = ema20[ema20.length - 2], curr20 = ema20[ema20.length - 1];
  if (prev5 <= prev20 && curr5 > curr20) return 'BUY';
  if (prev5 >= prev20 && curr5 < curr20) return 'SELL';
  return null;
}

/**
 * MEAN_REVERSION: Bollinger Band mean reversion
 */
function meanReversionSignal(candles, index) {
  if (index < 20) return null;
  const closes = candles.slice(0, index + 1).map(c => c.c);
  const period = 20;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const upper = mean + 2 * stdDev;
  const lower = mean - 2 * stdDev;
  const price = closes[closes.length - 1];
  if (price < lower) return 'BUY';
  if (price > upper) return 'SELL';
  return null;
}

/**
 * REVERSAL: RSI extreme + price action reversal
 */
function reversalSignal(candles, index) {
  if (index < 15) return null;
  const closes = candles.slice(0, index + 1).map(c => c.c);
  const rsi = calcRSI(closes, 14);
  const curr = rsi[rsi.length - 1];
  if (curr === null) return null;
  const candle = candles[index];
  const bullishCandle = candle.c > candle.o && (candle.c - candle.o) > (candle.h - candle.l) * 0.6;
  const bearishCandle = candle.o > candle.c && (candle.o - candle.c) > (candle.h - candle.l) * 0.6;
  if (curr < 25 && bullishCandle) return 'BUY';
  if (curr > 75 && bearishCandle) return 'SELL';
  return null;
}

/**
 * RANGE: Trade within a range (buy at support, sell at resistance)
 */
function rangeSignal(candles, index) {
  if (index < 30) return null;
  const lookback = candles.slice(index - 30, index);
  const high30 = Math.max(...lookback.map(c => c.h));
  const low30 = Math.min(...lookback.map(c => c.l));
  const range = high30 - low30;
  if (range <= 0) return null;
  const price = candles[index].c;
  const position = (price - low30) / range;
  if (position < 0.15) return 'BUY';
  if (position > 0.85) return 'SELL';
  return null;
}

/** Map strategy name strings to their signal functions. */
const STRATEGY_MAP = {
  TREND: trendSignal,
  BREAKOUT: breakoutSignal,
  MOMENTUM: momentumSignal,
  SWING: swingSignal,
  WHALE: whaleSignal,
  CONFLUENCE: confluenceSignal,
  DIVERGENCE: divergenceSignal,
  ADAPTIVE: adaptiveSignal,
  MA_CROSSOVER: maCrossoverSignal,
  MEAN_REVERSION: meanReversionSignal,
  REVERSAL: reversalSignal,
  RANGE: rangeSignal,
};

// ============================================
// MAIN BACKTEST
// ============================================

/**
 * Run a backtest on historical candle data.
 *
 * @param {Object} options
 * @param {string} options.ticker       - e.g. 'BTCUSD'
 * @param {string} options.strategy     - 'TREND' | 'BREAKOUT' | 'MOMENTUM' | 'SWING'
 * @param {number} options.startTime    - Unix ms timestamp for range start
 * @param {number} options.endTime      - Unix ms timestamp for range end
 * @param {string} [options.timeframe='1m']
 * @param {number} [options.initialCash=1000]
 * @param {number} [options.riskPercent=0.5] - fraction of cash per trade (0-100 scale; 0.5 = 0.5%)
 * @returns {Object} BacktestResult
 */
export function runBacktest(options) {
  const {
    ticker,
    strategy,
    startTime,
    endTime,
    timeframe = '1m',
    initialCash = 1000,
    riskPercent = 0.5,
  } = options;

  // --- Validate strategy ---
  const signalFn = STRATEGY_MAP[strategy?.toUpperCase()];
  if (!signalFn) {
    throw new Error(
      `Unknown strategy "${strategy}". Supported: ${Object.keys(STRATEGY_MAP).join(', ')}`
    );
  }

  // --- Load candles from SQLite ---
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT time, open, high, low, close, volume
       FROM candle_history
       WHERE ticker = ? AND timeframe = ?
         AND time >= ? AND time <= ?
       ORDER BY time ASC`
    )
    .all(ticker, timeframe, startTime, endTime);

  // Convert to shorthand candle format
  const candles = rows.map((r) => ({
    t: r.time,
    o: r.open,
    h: r.high,
    l: r.low,
    c: r.close,
    v: r.volume,
  }));

  if (candles.length < MIN_CANDLES) {
    return {
      ticker,
      strategy,
      timeframe,
      startTime,
      endTime,
      initialCash,
      finalValue: initialCash,
      totalReturn: 0,
      trades: [],
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      buyAndHoldReturn: 0,
      error: `Insufficient data: found ${candles.length} candles, need at least ${MIN_CANDLES}.`,
    };
  }

  // --- Simulation state ---
  let cash = initialCash;
  let positionQty = 0;
  let positionEntryPrice = 0;
  const trades = [];
  const equityCurve = [];
  const barReturns = [];
  let prevEquity = initialCash;

  // Position sizing: riskPercent is on a 0-100 scale
  const riskFraction = riskPercent / 100;

  // --- Walk through candles ---
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const currentEquity = cash + positionQty * candle.c;
    equityCurve.push(currentEquity);

    // Track per-bar returns for Sharpe
    if (i > 0) {
      barReturns.push(prevEquity > 0 ? (currentEquity - prevEquity) / prevEquity : 0);
    }
    prevEquity = currentEquity;

    // Need at least MIN_CANDLES of history before generating signals
    if (i < MIN_CANDLES - 1) continue;

    const signal = signalFn(candles, i);

    if (signal === 'BUY' && positionQty === 0) {
      // Enter long position
      const allocCash = cash * riskFraction;
      if (allocCash <= 0 || candle.c <= 0) continue;

      const qty = allocCash / candle.c;
      positionQty = qty;
      positionEntryPrice = candle.c;
      cash -= allocCash;

      trades.push({
        type: 'BUY',
        price: candle.c,
        quantity: qty,
        time: candle.t,
        pnl: 0,
      });
    } else if (signal === 'SELL' && positionQty > 0) {
      // Exit long position
      const proceeds = positionQty * candle.c;
      const cost = positionQty * positionEntryPrice;
      const pnl = proceeds - cost;
      cash += proceeds;

      trades.push({
        type: 'SELL',
        price: candle.c,
        quantity: positionQty,
        time: candle.t,
        pnl,
      });

      positionQty = 0;
      positionEntryPrice = 0;
    }
  }

  // --- Final portfolio value (mark-to-market any open position) ---
  const lastPrice = candles[candles.length - 1].c;
  const finalValue = cash + positionQty * lastPrice;

  // --- Compute trade metrics ---
  const sellTrades = trades.filter((t) => t.type === 'SELL');
  const wins = sellTrades.filter((t) => t.pnl > 0);
  const losses = sellTrades.filter((t) => t.pnl <= 0);

  const totalWinPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

  // --- Drawdown ---
  const { maxDrawdown, maxDrawdownPercent } = calcMaxDrawdown(equityCurve);

  // --- Sharpe Ratio ---
  const tfMinutes = TIMEFRAME_MINUTES[timeframe] || 1;
  const barsPerYear = MINUTES_PER_YEAR / tfMinutes;
  const sharpeRatio = calcSharpeRatio(barReturns, barsPerYear);

  // --- Buy & Hold comparison ---
  const firstPrice = candles[0].c;
  const buyAndHoldReturn =
    firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  return {
    ticker,
    strategy,
    timeframe,
    startTime,
    endTime,
    initialCash,
    finalValue: Math.round(finalValue * 100) / 100,
    totalReturn: Math.round(((finalValue - initialCash) / initialCash) * 100 * 100) / 100,
    trades,
    totalTrades: sellTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sellTrades.length > 0 ? Math.round((wins.length / sellTrades.length) * 100 * 100) / 100 : 0,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: profitFactor === Infinity ? Infinity : Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    buyAndHoldReturn: Math.round(buyAndHoldReturn * 100) / 100,
  };
}

// ============================================
// AVAILABLE DATA QUERY
// ============================================

/**
 * Query SQLite for available ticker/timeframe combinations and their date ranges.
 * @returns {Array<{ ticker: string, timeframe: string, candleCount: number, startTime: number, endTime: number }>}
 */
export function getAvailableBacktestData() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ticker, timeframe,
              COUNT(*) AS candleCount,
              MIN(time) AS startTime,
              MAX(time) AS endTime
       FROM candle_history
       GROUP BY ticker, timeframe
       ORDER BY ticker, timeframe`
    )
    .all();

  return rows.map((r) => ({
    ticker: r.ticker,
    timeframe: r.timeframe,
    candleCount: r.candleCount,
    startTime: r.startTime,
    endTime: r.endTime,
  }));
}

// ============================================
// MULTI-TICKER BACKTEST
// ============================================

/**
 * Run backtests across multiple tickers with the same strategy and date range.
 * Returns individual results plus aggregated summary.
 *
 * @param {string[]} tickers
 * @param {string}   strategy
 * @param {number}   startTime
 * @param {number}   endTime
 * @param {Object}   [extraOptions] - Additional options passed to runBacktest (timeframe, initialCash, riskPercent)
 * @returns {{ results: Object[], summary: Object }}
 */
export function runMultiBacktest(tickers, strategy, startTime, endTime, extraOptions = {}) {
  const results = [];

  for (const ticker of tickers) {
    try {
      const result = runBacktest({
        ticker,
        strategy,
        startTime,
        endTime,
        ...extraOptions,
      });
      results.push(result);
    } catch (err) {
      results.push({
        ticker,
        strategy,
        error: err.message,
      });
    }
  }

  // --- Aggregate summary across successful backtests ---
  const valid = results.filter((r) => !r.error && r.totalTrades > 0);

  const summary = {
    tickersTested: tickers.length,
    tickersWithData: valid.length,
    tickersSkipped: tickers.length - valid.length,
    strategy,
    startTime,
    endTime,
    combinedTrades: 0,
    combinedWins: 0,
    combinedLosses: 0,
    combinedWinRate: 0,
    avgReturn: 0,
    bestTicker: null,
    bestReturn: -Infinity,
    worstTicker: null,
    worstReturn: Infinity,
    avgSharpe: 0,
    avgMaxDrawdownPercent: 0,
  };

  if (valid.length > 0) {
    let totalReturn = 0;
    let totalSharpe = 0;
    let totalDrawdown = 0;

    for (const r of valid) {
      summary.combinedTrades += r.totalTrades;
      summary.combinedWins += r.wins;
      summary.combinedLosses += r.losses;
      totalReturn += r.totalReturn;
      totalSharpe += r.sharpeRatio;
      totalDrawdown += r.maxDrawdownPercent;

      if (r.totalReturn > summary.bestReturn) {
        summary.bestReturn = r.totalReturn;
        summary.bestTicker = r.ticker;
      }
      if (r.totalReturn < summary.worstReturn) {
        summary.worstReturn = r.totalReturn;
        summary.worstTicker = r.ticker;
      }
    }

    summary.combinedWinRate =
      summary.combinedTrades > 0
        ? Math.round((summary.combinedWins / summary.combinedTrades) * 100 * 100) / 100
        : 0;
    summary.avgReturn = Math.round((totalReturn / valid.length) * 100) / 100;
    summary.avgSharpe = Math.round((totalSharpe / valid.length) * 100) / 100;
    summary.avgMaxDrawdownPercent = Math.round((totalDrawdown / valid.length) * 100) / 100;
  }

  return { results, summary };
}

// ============================================
// WALK-FORWARD ANALYSIS
// ============================================

/**
 * Split data into N windows, train on each, test on next.
 * @param {Object} options
 * @param {string} options.ticker
 * @param {string} options.strategy
 * @param {number} options.startTime
 * @param {number} options.endTime
 * @param {number} [options.windows=5]
 * @param {string} [options.timeframe='1m']
 * @param {number} [options.initialCash=1000]
 * @param {number} [options.riskPercent=0.5]
 * @returns {{ windows: Object[], summary: Object }}
 */
export function runWalkForward(options) {
  const {
    ticker, strategy, startTime, endTime,
    windows = 5, timeframe = '1m', initialCash = 1000, riskPercent = 0.5,
  } = options;

  const totalDuration = endTime - startTime;
  const windowSize = Math.floor(totalDuration / (windows + 1)); // Each window = 1/(windows+1) of total
  const results = [];

  for (let i = 0; i < windows; i++) {
    const trainStart = startTime + i * windowSize;
    const trainEnd = trainStart + windowSize;
    const testStart = trainEnd;
    const testEnd = testStart + windowSize;

    if (testEnd > endTime) break;

    try {
      const trainResult = runBacktest({ ticker, strategy, startTime: trainStart, endTime: trainEnd, timeframe, initialCash, riskPercent });
      const testResult = runBacktest({ ticker, strategy, startTime: testStart, endTime: testEnd, timeframe, initialCash, riskPercent });

      results.push({
        window: i + 1,
        trainPeriod: { start: trainStart, end: trainEnd },
        testPeriod: { start: testStart, end: testEnd },
        trainReturn: trainResult.totalReturn,
        testReturn: testResult.totalReturn,
        trainWinRate: trainResult.winRate,
        testWinRate: testResult.winRate,
        trainTrades: trainResult.totalTrades,
        testTrades: testResult.totalTrades,
        trainSharpe: trainResult.sharpeRatio,
        testSharpe: testResult.sharpeRatio,
      });
    } catch (e) {
      results.push({ window: i + 1, error: e.message });
    }
  }

  const validResults = results.filter(r => !r.error);
  const summary = {
    windows: validResults.length,
    avgTestReturn: validResults.length > 0 ? validResults.reduce((s, r) => s + r.testReturn, 0) / validResults.length : 0,
    avgTestWinRate: validResults.length > 0 ? validResults.reduce((s, r) => s + r.testWinRate, 0) / validResults.length : 0,
    avgTestSharpe: validResults.length > 0 ? validResults.reduce((s, r) => s + r.testSharpe, 0) / validResults.length : 0,
    consistency: validResults.length > 0 ? validResults.filter(r => r.testReturn > 0).length / validResults.length : 0,
  };

  return { windows: results, summary };
}

// ============================================
// PARAMETER SWEEP
// ============================================

/**
 * Grid search over risk% and other parameters.
 * @param {Object} options
 * @param {string} options.ticker
 * @param {string} options.strategy
 * @param {number} options.startTime
 * @param {number} options.endTime
 * @param {string} [options.timeframe='1m']
 * @param {number} [options.initialCash=1000]
 * @param {number[]} [options.riskPercents] - Array of risk% values to test
 * @returns {{ results: Object[], bestParams: Object }}
 */
export function runParameterSweep(options) {
  const {
    ticker, strategy, startTime, endTime,
    timeframe = '1m', initialCash = 1000,
    riskPercents = [0.25, 0.5, 1, 2, 5, 10, 15, 20],
  } = options;

  const results = [];

  for (const riskPercent of riskPercents) {
    try {
      const result = runBacktest({ ticker, strategy, startTime, endTime, timeframe, initialCash, riskPercent });
      results.push({
        riskPercent,
        totalReturn: result.totalReturn,
        winRate: result.winRate,
        sharpeRatio: result.sharpeRatio,
        maxDrawdownPercent: result.maxDrawdownPercent,
        profitFactor: result.profitFactor,
        totalTrades: result.totalTrades,
        finalValue: result.finalValue,
      });
    } catch (e) {
      results.push({ riskPercent, error: e.message });
    }
  }

  // Find best by Sharpe ratio
  const valid = results.filter(r => !r.error && r.totalTrades > 0);
  const bestBySharpe = valid.length > 0 ? valid.reduce((best, r) => r.sharpeRatio > best.sharpeRatio ? r : best) : null;

  return {
    results,
    bestParams: bestBySharpe ? { riskPercent: bestBySharpe.riskPercent, sharpe: bestBySharpe.sharpeRatio, return: bestBySharpe.totalReturn } : null,
  };
}
