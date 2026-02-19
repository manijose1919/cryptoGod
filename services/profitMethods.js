/**
 * Profit Methods Service (Backend)
 *
 * Ports all 6 frontend profit methods to server-side JavaScript for real trading:
 *   1. Swing Trading - Higher TF analysis, S/R levels, R:R filtering, trailing stops
 *   2. Smart DCA - Timer-based buys, smart dip/pump multiplier, auto take-profit
 *   3. Grid Trading - Range detection, buy/sell at grid levels, sideways market profits
 *   4. Market Making - Virtual bid/ask spread capture, inventory management
 *   5. Arbitrage - Stat arb via z-score, ratio arb, cross-pair divergence
 *   6. Pair Trading - Correlation tracking, z-score entry/exit, market-neutral
 *
 * Uses shorthand candle keys: c, o, h, l, v (matching server.js convention)
 */

// ============================================
// CONFIGURATION (mirrors constants.ts PROFIT_METHODS)
// ============================================

// Kraken round-trip fees: 0.26% per side = 0.52% total
// ALL profit targets must exceed this to be profitable
const KRAKEN_RT_FEE = 0.52;

const PM_CONFIG = {
  GRID: {
    ENABLED: true,
    GRID_COUNT: 5,                        // Was 10: wider spacing per level to exceed 0.52% fees
    PORTFOLIO_ALLOCATION: 0.05,
    MIN_RANGE_PERCENT: 3.0,               // Was 1.0: each of 5 levels = 0.6% spacing (above fees)
    MIN_GRID_SPACING_PCT: 0.7,            // Min spacing between grid levels (must exceed RT fees)
  },
  DCA: {
    ENABLED: true,
    INTERVAL_MS: 5 * 60 * 1000,           // Was 2min: slower DCA to avoid fee drag
    BASE_ALLOCATION: 0.02,
    MAX_DIP_MULTIPLIER: 3.0,
    MIN_PUMP_MULTIPLIER: 0.3,
    TAKE_PROFIT_PERCENT: 1.5,             // Was 5%: unreachable. 1.5% = ~1% net after 0.52% fees
    DIP_THRESHOLD: 2.0,                   // Was 1.0: require real dips, not noise
    PUMP_THRESHOLD: 1.5,                  // Was 1.0: don't reduce too aggressively
    MAX_DCA_BUYS: 3,                      // Cap to prevent endless averaging down
  },
  ARBITRAGE: {
    ENABLED: true,
    MIN_SPREAD_ZSCORE: 1.5,               // Was 1.2: tighter filter
    MIN_CONFIDENCE: 55,                   // Was 50
    PORTFOLIO_ALLOCATION: 0.10,
  },
  PAIR_TRADING: {
    ENABLED: true,
    ENTRY_ZSCORE: 2.0,
    EXIT_ZSCORE: 0.5,
    MIN_CORRELATION: 0.5,
    PORTFOLIO_ALLOCATION: 0.10,
  },
  SWING: {
    ENABLED: true,
    MIN_CONFIDENCE: 55,                   // Was 50: require 4+ strong signals
    MIN_RISK_REWARD: 2.5,                 // Was 1.5: fee-adjusted (need wider edge)
    PORTFOLIO_ALLOCATION: 0.05,
    TRAILING_STOP_TRIGGER: 2,
    TRAILING_STOP_PCT: 1.5,              // Trail 1.5% below highest price (was 0.5% of pnl)
    MIN_TARGET_PCT: 2.0,                  // Was 1%: min target must exceed fees meaningfully
  },
  MARKET_MAKING: {
    ENABLED: false,                       // DISABLED: virtual spread capture is unrealistic
    PORTFOLIO_ALLOCATION: 0.05,           // 0.06% spread capture vs 0.52% fees = guaranteed loss
    ORDER_EXPIRY_MS: 5 * 60 * 1000,
    MIN_SPREAD_PERCENT: 0.01,
  },
};

// ============================================
// INTERNAL STATE
// ============================================

const swingPositions = new Map();     // ticker -> SwingPosition
const dcaPositions = new Map();       // ticker -> DCAPosition
const gridStates = new Map();         // ticker -> GridState
const mmStates = new Map();           // ticker -> MMState
const pairRatios = new Map();         // "T1/T2" -> PairRatio
const pairCorrelations = new Map();   // "T1:T2" -> PairCorrelation
const openPairPositions = new Map();  // "T1:T2" -> PairPosition

// DCA warmup: no DCA buys for first 5 minutes of a session
let sessionStartTimestamp = 0;
const DCA_WARMUP_MS = 5 * 60 * 1000; // 5 min warmup

export function setSessionStart(timestamp) {
    sessionStartTimestamp = timestamp || Date.now();
}

// Stats tracking
const methodStats = {
  swing: { trades: 0, pnl: 0 },
  dca: { trades: 0, pnl: 0 },
  grid: { trades: 0, pnl: 0 },
  mm: { trades: 0, pnl: 0 },
  arb: { trades: 0, pnl: 0 },
  pair: { trades: 0, pnl: 0 },
};

// Known correlated pairs for arbitrage/pair trading
const CORRELATED_PAIRS = [
  ['BTCUSD', 'ETHUSD'],
  ['ETHUSD', 'SOLUSD'],
  ['BTCUSD', 'SOLUSD'],
  ['DOGEUSD', 'ADAUSD'],
  ['BTCUSD', 'XRPUSD'],
  ['ETHUSD', 'LINKUSD'],
  ['SOLUSD', 'AVAXUSD'],
  ['BTCUSD', 'ADAUSD'],
  ['ETHUSD', 'DOTUSD'],
];

// ============================================
// HELPERS
// ============================================

function ema(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const xm = xs.reduce((s, v) => s + v, 0) / n;
  const ym = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, xv = 0, yv = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xm;
    const dy = ys[i] - ym;
    cov += dx * dy;
    xv += dx * dx;
    yv += dy * dy;
  }
  const d = Math.sqrt(xv * yv);
  return d > 0 ? cov / d : 0;
}

function zScore(values) {
  if (values.length < 2) return { mean: 0, std: 0, z: 0, current: 0 };
  const current = values[values.length - 1];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  return { mean, std, z: std > 0 ? (current - mean) / std : 0, current };
}

// ============================================
// 1. SWING TRADING
// ============================================

function findKeyLevels(candles) {
  if (candles.length < 20) {
    const p = candles[candles.length - 1]?.c || 0;
    return { support: p * 0.97, resistance: p * 1.03 };
  }
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const price = candles[candles.length - 1].c;

  const pivots = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      pivots.push(highs[i]);
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      pivots.push(lows[i]);
    }
  }

  const supports = pivots.filter(p => p < price).sort((a, b) => b - a);
  const resistances = pivots.filter(p => p > price).sort((a, b) => a - b);

  return {
    support: supports[0] || price * 0.97,
    resistance: resistances[0] || price * 1.03,
  };
}

function analyzeMarketStructure(candles) {
  if (candles.length < 30) return { structure: 'RANGE', trendStrength: 0, momentum: 0 };

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Now = ema20[ema20.length - 1];
  const ema50Now = ema50[ema50.length - 1];

  // Higher highs / higher lows
  const recentHighs = [];
  const recentLows = [];
  for (let i = candles.length - 30; i < candles.length; i += 5) {
    const slice = candles.slice(i, i + 5);
    recentHighs.push(Math.max(...slice.map(c => c.h)));
    recentLows.push(Math.min(...slice.map(c => c.l)));
  }
  const higherHighs = recentHighs.every((h, i) => i === 0 || h >= recentHighs[i - 1] * 0.998);
  const lowerLows = recentLows.every((l, i) => i === 0 || l <= recentLows[i - 1] * 1.002);
  const higherLows = recentLows.every((l, i) => i === 0 || l >= recentLows[i - 1] * 0.998);

  const change10 = ((price - closes[closes.length - 11]) / closes[closes.length - 11]) * 100;
  const change20 = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;

  // Breakout detection
  const prev20High = Math.max(...candles.slice(-40, -20).map(c => c.h));
  const isBreakout = price > prev20High && change10 > 1;

  let structure, trendStrength;
  if (isBreakout) {
    structure = 'BREAKOUT';
    trendStrength = Math.min(100, 70 + Math.abs(change10) * 5);
  } else if (price > ema20Now && ema20Now > ema50Now && higherLows) {
    structure = 'UPTREND';
    trendStrength = Math.min(100, 50 + Math.abs(change20) * 5 + (higherHighs ? 20 : 0));
  } else if (price < ema20Now && ema20Now < ema50Now && lowerLows) {
    structure = 'DOWNTREND';
    trendStrength = Math.min(100, 50 + Math.abs(change20) * 5);
  } else {
    structure = 'RANGE';
    const range20 = candles.slice(-20);
    const rangeHigh = Math.max(...range20.map(c => c.h));
    const rangeLow = Math.min(...range20.map(c => c.l));
    const rangePercent = ((rangeHigh - rangeLow) / rangeLow) * 100;
    trendStrength = Math.max(0, 30 - rangePercent * 5);
  }

  return { structure, trendStrength, momentum: change10 };
}

function analyzeSwingSetup(ticker, candles) {
  if (candles.length < 30) return { hasSetup: false, setup: null };

  const price = candles[candles.length - 1].c;
  const { support, resistance } = findKeyLevels(candles);
  const { structure, trendStrength, momentum } = analyzeMarketStructure(candles);
  const closes = candles.map(c => c.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const signals = [];

  // 1. EMA alignment
  const aboveEma20 = price > ema20[ema20.length - 1];
  const aboveEma50 = price > ema50[ema50.length - 1];
  const emasBullish = ema20[ema20.length - 1] > ema50[ema50.length - 1];
  signals.push({ name: 'EMA', bullish: aboveEma20 && aboveEma50 && emasBullish, weight: 25 });

  // 2. Support bounce
  const nearSupport = (price - support) / support < 0.015;
  const bouncing = nearSupport && price > candles[candles.length - 2].c;
  signals.push({ name: 'SUPPORT', bullish: bouncing, weight: 20 });

  // 3. Volume confirmation
  const avgVol = candles.slice(-20).reduce((s, c) => s + c.v, 0) / 20;
  const recentVol = candles.slice(-3).reduce((s, c) => s + c.v, 0) / 3;
  signals.push({ name: 'VOLUME', bullish: recentVol > avgVol * 1.2, weight: 15 });

  // 4. Momentum
  signals.push({ name: 'MOMENTUM', bullish: momentum > 0.5, weight: 15 });

  // 5. Higher TF trend
  const longTrend = candles.length > 50 ? price > ema(closes, 50)[closes.length - 1] : true;
  signals.push({ name: 'HTF', bullish: longTrend, weight: 15 });

  // 6. Breakout
  signals.push({ name: 'BREAKOUT', bullish: structure === 'BREAKOUT', weight: 10 });

  const confidence = signals.filter(s => s.bullish).reduce((sum, s) => sum + s.weight, 0);
  if (confidence < PM_CONFIG.SWING.MIN_CONFIDENCE) return { hasSetup: false, setup: null };

  const targetPrice = resistance;
  const stopLoss = support * 0.995;
  const targetPercent = ((targetPrice - price) / price) * 100;
  const riskPercent = ((price - stopLoss) / price) * 100;
  const riskReward = riskPercent > 0 ? targetPercent / riskPercent : 0;

  // Target must exceed round-trip fees meaningfully
  const feeAdjustedTarget = targetPercent - KRAKEN_RT_FEE;
  if (riskReward < PM_CONFIG.SWING.MIN_RISK_REWARD || feeAdjustedTarget < PM_CONFIG.SWING.MIN_TARGET_PCT) {
    return { hasSetup: false, setup: null };
  }

  const bullishNames = signals.filter(s => s.bullish).map(s => s.name).join(', ');
  return {
    hasSetup: true,
    setup: {
      ticker, entryPrice: price, targetPrice, stopLoss,
      targetPercent, riskPercent, riskReward, confidence,
      reason: `Swing ${structure}: R:R=${riskReward.toFixed(1)}, tgt=${targetPercent.toFixed(1)}% | ${bullishNames}`,
    },
  };
}

function checkSwingExit(ticker, currentPrice) {
  const pos = swingPositions.get(ticker);
  if (!pos) return { shouldExit: false, reason: '', pnlPercent: 0 };

  const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  pos.highestPrice = Math.max(pos.highestPrice, currentPrice);

  if (currentPrice >= pos.targetPrice) {
    return { shouldExit: true, reason: `Swing target: +${pnlPercent.toFixed(2)}%`, pnlPercent };
  }
  if (currentPrice <= pos.stopLoss) {
    return { shouldExit: true, reason: `Swing stop: ${pnlPercent.toFixed(2)}%`, pnlPercent };
  }
  if (pnlPercent > PM_CONFIG.SWING.TRAILING_STOP_TRIGGER) {
    // Trail a fixed % below the highest price reached (not entry-based)
    const trailingLevel = pos.highestPrice * (1 - PM_CONFIG.SWING.TRAILING_STOP_PCT / 100);
    if (currentPrice < trailingLevel) {
      return { shouldExit: true, reason: `Swing trail: +${pnlPercent.toFixed(2)}% (peak: ${pos.highestPrice.toFixed(2)})`, pnlPercent };
    }
  }
  return { shouldExit: false, reason: '', pnlPercent };
}

// ============================================
// 2. SMART DCA
// ============================================

function calculateDCAMultiplier(candles, position) {
  if (candles.length < 10) return { multiplier: 1, reason: 'Insufficient data' };

  const price = candles[candles.length - 1].c;
  const prices20 = candles.slice(-20).map(c => c.c);
  const avg20 = prices20.reduce((s, p) => s + p, 0) / prices20.length;
  const recentHigh = Math.max(...candles.slice(-20).map(c => c.h));
  const dipFromHigh = ((recentHigh - price) / recentHigh) * 100;
  const priceVsAvg = ((price - avg20) / avg20) * 100;

  const cfg = PM_CONFIG.DCA;
  let multiplier = 1, reason = 'Normal range -> 1x';

  if (dipFromHigh > cfg.DIP_THRESHOLD * 3) {
    multiplier = cfg.MAX_DIP_MULTIPLIER;
    reason = `Major dip: ${dipFromHigh.toFixed(1)}% from high -> ${multiplier}x`;
  } else if (dipFromHigh > cfg.DIP_THRESHOLD * 2) {
    multiplier = 2.0;
    reason = `Moderate dip: ${dipFromHigh.toFixed(1)}% -> 2x`;
  } else if (dipFromHigh > cfg.DIP_THRESHOLD) {
    multiplier = 1.5;
    reason = `Small dip: ${dipFromHigh.toFixed(1)}% -> 1.5x`;
  } else if (priceVsAvg < -cfg.DIP_THRESHOLD) {
    multiplier = 1.3;
    reason = `Below avg: ${priceVsAvg.toFixed(1)}% -> 1.3x`;
  } else if (priceVsAvg > cfg.PUMP_THRESHOLD * 2) {
    multiplier = cfg.MIN_PUMP_MULTIPLIER;
    reason = `Above avg: +${priceVsAvg.toFixed(1)}% -> ${multiplier}x (reduced)`;
  } else if (priceVsAvg > cfg.PUMP_THRESHOLD) {
    multiplier = 0.7;
    reason = `Slightly above avg -> 0.7x`;
  }

  // Use initial entry price (not averaged-down price) so multiplier doesn't shrink on successive dips
  const referencePrice = position?.initialEntryPrice || position?.avgEntryPrice;
  if (position && referencePrice && price < referencePrice * 0.98) {
    multiplier = Math.min(cfg.MAX_DIP_MULTIPLIER, multiplier * 1.3);
    reason += ' | below initial entry';
  }

  return {
    multiplier: Math.max(cfg.MIN_PUMP_MULTIPLIER, Math.min(cfg.MAX_DIP_MULTIPLIER, multiplier)),
    reason,
  };
}

function processDCA(ticker, candles, cashAvailable, portfolioBudget, openPositions) {
  if (!PM_CONFIG.DCA.ENABLED || candles.length < 5) return null;
  // No DCA for first 5 minutes of session (prevents carpet-bombing on start)
  if (sessionStartTimestamp > 0 && Date.now() - sessionStartTimestamp < DCA_WARMUP_MS) return null;
  // Only DCA into existing positions (don't open new ones)
  if (!openPositions || !openPositions[ticker]) return null;

  const baseAmount = portfolioBudget * PM_CONFIG.DCA.BASE_ALLOCATION;
  if (baseAmount <= 0) return null;

  const position = dcaPositions.get(ticker);
  const lastBuy = position?.lastBuyTime || 0;
  if (Date.now() - lastBuy < PM_CONFIG.DCA.INTERVAL_MS) return null;

  // Cap maximum DCA buys per position to prevent endless averaging down
  if (position && position.buys >= PM_CONFIG.DCA.MAX_DCA_BUYS) return null;

  const price = candles[candles.length - 1].c;
  const { multiplier, reason } = calculateDCAMultiplier(candles, position);

  // Don't DCA when multiplier is reduced (price pumping) — only DCA into dips
  if (multiplier < 1.0) return null;

  const buyAmount = Math.min(baseAmount * multiplier, cashAvailable * 0.1);

  if (buyAmount < 0.10) return null;

  return { shouldBuy: true, ticker, amount: buyAmount, multiplier, reason: `DCA: ${reason}`, price };
}

function recordDCABuy(ticker, price, quantity, amount) {
  const existing = dcaPositions.get(ticker);
  if (existing) {
    const totalQty = existing.totalQuantity + quantity;
    const totalInvested = existing.totalInvested + amount;
    dcaPositions.set(ticker, {
      ...existing,
      totalInvested, totalQuantity: totalQty,
      avgEntryPrice: totalInvested / totalQty,
      buys: existing.buys + 1,
      lastBuyTime: Date.now(),
      lastBuyPrice: price,
    });
  } else {
    dcaPositions.set(ticker, {
      ticker, totalInvested: amount, totalQuantity: quantity,
      avgEntryPrice: price, initialEntryPrice: price, buys: 1,
      lastBuyTime: Date.now(), lastBuyPrice: price,
    });
  }
}

function checkDCATakeProfit(ticker, currentPrice) {
  const pos = dcaPositions.get(ticker);
  if (!pos) return { shouldSell: false, pnlPercent: 0, reason: '' };
  const pnlPercent = ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
  if (pnlPercent >= PM_CONFIG.DCA.TAKE_PROFIT_PERCENT) {
    return {
      shouldSell: true, pnlPercent,
      reason: `DCA take profit: +${pnlPercent.toFixed(2)}% (avg: ${pos.avgEntryPrice.toFixed(2)})`,
    };
  }
  return { shouldSell: false, pnlPercent, reason: '' };
}

// ============================================
// 3. GRID TRADING
// ============================================

function detectGridRange(candles, gridCount = 10) {
  const recent = Math.min(50, candles.length);
  const sortedPrices = candles.slice(-recent).map(c => c.c).sort((a, b) => a - b);
  const p10 = sortedPrices[Math.floor(sortedPrices.length * 0.05)];
  const p90 = sortedPrices[Math.floor(sortedPrices.length * 0.95)];
  const upperBound = p90 * 1.005;
  const lowerBound = p10 * 0.995;
  const gridSpacing = (upperBound - lowerBound) / gridCount;
  return { upperBound, lowerBound, gridCount, gridSpacing, investmentPerGrid: 0 };
}

function initGrid(ticker, candles, totalBudget, gridCount = 5) {
  const config = detectGridRange(candles, gridCount);

  // Validate grid spacing exceeds fees — if too tight, reduce grid count
  const rangePercent = ((config.upperBound - config.lowerBound) / config.lowerBound) * 100;
  const spacingPercent = rangePercent / gridCount;
  if (spacingPercent < PM_CONFIG.GRID.MIN_GRID_SPACING_PCT) {
    // Range too narrow for profitable grid trading
    return null;
  }

  config.investmentPerGrid = totalBudget / gridCount;
  const price = candles[candles.length - 1].c;

  const levels = [];
  for (let i = 0; i <= gridCount; i++) {
    const levelPrice = config.lowerBound + (i * config.gridSpacing);
    levels.push({
      price: levelPrice,
      type: levelPrice < price ? 'BUY' : 'SELL',
      filled: false, fillPrice: null, fillTime: null, pnl: 0,
    });
  }

  const state = { config, levels, totalPnl: 0, filledBuys: 0, filledSells: 0, isActive: true, lastUpdate: Date.now() };
  gridStates.set(ticker, state);
  return state;
}

function processGrid(ticker, candles, cashAvailable) {
  if (!PM_CONFIG.GRID.ENABLED || candles.length < 20) return null;

  const price = candles[candles.length - 1].c;
  const prevPrice = candles[candles.length - 2].c;

  // Trend filter: only grid trade in sideways/range markets
  const { structure } = analyzeMarketStructure(candles);
  if (structure === 'UPTREND' || structure === 'DOWNTREND') return null;

  // Re-init grid if price moved out of range
  let state = gridStates.get(ticker);
  if (!state) {
    const budget = cashAvailable * PM_CONFIG.GRID.PORTFOLIO_ALLOCATION;
    if (budget < 0.10) return null;
    const result = initGrid(ticker, candles, budget, PM_CONFIG.GRID.GRID_COUNT);
    if (!result) return null; // Grid spacing too narrow for fees
    state = gridStates.get(ticker);
  } else {
    const { upperBound, lowerBound } = state.config;
    const buffer = (upperBound - lowerBound) * 0.2;
    if (price > upperBound + buffer || price < lowerBound - buffer) {
      const budget = cashAvailable * PM_CONFIG.GRID.PORTFOLIO_ALLOCATION;
      if (budget < 0.10) return null;
      const result = initGrid(ticker, candles, budget, PM_CONFIG.GRID.GRID_COUNT);
      if (!result) return null; // Grid spacing too narrow for fees
      state = gridStates.get(ticker);
    }
  }

  if (!state || !state.isActive) return null;

  for (let i = 0; i < state.levels.length; i++) {
    const level = state.levels[i];
    if (level.filled) continue;

    // Price crossed DOWN through BUY level
    if (level.type === 'BUY' && prevPrice > level.price && price <= level.price) {
      level.filled = true;
      level.fillPrice = price;
      level.fillTime = Date.now();
      state.filledBuys++;
      state.lastUpdate = Date.now();

      if (i + 1 < state.levels.length) {
        state.levels[i + 1].type = 'SELL';
        state.levels[i + 1].filled = false;
      }

      return {
        action: 'BUY', ticker, price, gridLevel: i,
        investmentAmount: state.config.investmentPerGrid,
        reason: `Grid BUY: level ${i} (${level.price.toFixed(2)})`,
      };
    }

    // Price crossed UP through SELL level
    if (level.type === 'SELL' && prevPrice < level.price && price >= level.price) {
      const buyLevel = state.levels.slice(0, i).reverse().find(l => l.filled && l.type === 'BUY');
      const buyPrice = buyLevel?.fillPrice || level.price - state.config.gridSpacing;
      const pnl = ((price - buyPrice) / buyPrice) * 100;

      level.filled = true;
      level.fillPrice = price;
      level.fillTime = Date.now();
      level.pnl = pnl;
      state.filledSells++;
      state.totalPnl += pnl;
      state.lastUpdate = Date.now();

      if (i - 1 >= 0) {
        state.levels[i - 1].type = 'BUY';
        state.levels[i - 1].filled = false;
      }

      return {
        action: 'SELL', ticker, price, gridLevel: i,
        investmentAmount: state.config.investmentPerGrid,
        reason: `Grid SELL: level ${i} (+${pnl.toFixed(2)}%)`,
      };
    }
  }

  return null;
}

// ============================================
// 4. MARKET MAKING
// ============================================

function estimateSpread(candles) {
  if (candles.length < 10) return { optimalSpread: 0.1, isFavorable: false };

  const recentSpreads = candles.slice(-20).map(c => ((c.h - c.l) / c.c) * 100);
  const avgSpread = recentSpreads.reduce((s, v) => s + v, 0) / recentSpreads.length;

  const returns = [];
  for (let i = 1; i < Math.min(20, candles.length); i++) {
    returns.push(Math.abs((candles[candles.length - i].c - candles[candles.length - i - 1].c) / candles[candles.length - i - 1].c) * 100);
  }
  const volatility = returns.reduce((s, r) => s + r, 0) / returns.length;

  const optimalSpread = Math.max(PM_CONFIG.MARKET_MAKING.MIN_SPREAD_PERCENT, avgSpread * 0.6);
  const isFavorable = volatility < avgSpread * 2 && avgSpread > PM_CONFIG.MARKET_MAKING.MIN_SPREAD_PERCENT;

  return { optimalSpread, avgSpread, volatility, isFavorable };
}

function processMarketMaking(ticker, candles, cashAvailable) {
  if (!PM_CONFIG.MARKET_MAKING.ENABLED || candles.length < 15) return null;

  const price = candles[candles.length - 1].c;
  const spreadAnalysis = estimateSpread(candles);
  if (!spreadAnalysis.isFavorable) return null;

  let state = mmStates.get(ticker);
  if (!state) {
    state = {
      ticker, isActive: true, currentBid: null, currentAsk: null,
      inventory: 0, inventoryValue: 0, totalSpreadsCaptured: 0,
      totalProfit: 0, avgSpread: 0, tradesCompleted: 0, lastUpdate: Date.now(),
    };
    mmStates.set(ticker, state);
  }

  const halfSpread = (spreadAnalysis.optimalSpread / 100) * price / 2;
  const bidPrice = price - halfSpread;
  const askPrice = price + halfSpread;
  const orderValue = cashAvailable * PM_CONFIG.MARKET_MAKING.PORTFOLIO_ALLOCATION;
  const quantity = orderValue / price;

  // Check existing bid fill
  if (state.currentBid && !state.currentBid.filled) {
    if (candles[candles.length - 1].l <= state.currentBid.price) {
      state.currentBid.filled = true;
      state.currentBid.fillTime = Date.now();
      state.inventory += state.currentBid.quantity;
      state.inventoryValue += state.currentBid.price * state.currentBid.quantity;
    }
  }

  // Check existing ask fill
  if (state.currentAsk && !state.currentAsk.filled) {
    if (candles[candles.length - 1].h >= state.currentAsk.price) {
      state.currentAsk.filled = true;
      state.currentAsk.fillTime = Date.now();
      state.inventory -= state.currentAsk.quantity;
    }
  }

  // Both filled = round trip complete -> BUY the long leg for real
  if (state.currentBid?.filled && state.currentAsk?.filled) {
    const spreadCapture = state.currentAsk.price - state.currentBid.price;
    const profit = spreadCapture * Math.min(state.currentBid.quantity, state.currentAsk.quantity);
    const spreadPercent = (spreadCapture / state.currentBid.price) * 100;

    state.totalProfit += profit;
    state.totalSpreadsCaptured += spreadPercent;
    state.tradesCompleted++;
    state.avgSpread = state.totalSpreadsCaptured / state.tradesCompleted;

    const result = {
      action: 'BUY', ticker, price: state.currentBid.price,
      quantity: state.currentBid.quantity,
      investmentAmount: state.currentBid.price * state.currentBid.quantity,
      reason: `MM spread capture: ${spreadPercent.toFixed(3)}% = $${profit.toFixed(4)} (total: $${state.totalProfit.toFixed(2)})`,
      askPrice: state.currentAsk.price,
    };

    state.currentBid = null;
    state.currentAsk = null;
    state.lastUpdate = Date.now();
    return result;
  }

  // Bid filled only -> we need to buy for real when bid fills
  if (state.currentBid?.filled && !state.currentAsk?.filled) {
    // Already returned BUY on previous fill, just wait for ask
    return null;
  }

  // Place new orders if none active or expired
  const orderExpiry = PM_CONFIG.MARKET_MAKING.ORDER_EXPIRY_MS;
  const bidExpired = state.currentBid && !state.currentBid.filled && (Date.now() - state.currentBid.placed) > orderExpiry;
  const askExpired = state.currentAsk && !state.currentAsk.filled && (Date.now() - state.currentAsk.placed) > orderExpiry;

  if (!state.currentBid || bidExpired || !state.currentAsk || askExpired) {
    let bidAdj = 0, askAdj = 0;
    if (state.inventory > 0) askAdj = -halfSpread * 0.2;
    else if (state.inventory < 0) bidAdj = halfSpread * 0.2;

    state.currentBid = {
      price: bidPrice + bidAdj, quantity, side: 'BID',
      placed: Date.now(), filled: false, fillTime: null,
    };
    state.currentAsk = {
      price: askPrice + askAdj, quantity, side: 'ASK',
      placed: Date.now(), filled: false, fillTime: null,
    };
    state.lastUpdate = Date.now();
    // Just placed virtual orders, no real action yet
    return null;
  }

  return null;
}

// ============================================
// 5. ARBITRAGE
// ============================================

function calculateSpreadBetween(candles1, candles2, lookback = 50) {
  const len = Math.min(candles1.length, candles2.length, lookback);
  if (len < 10) return { currentSpread: 0, avgSpread: 0, stdDev: 0, zScore: 0 };

  const base1 = candles1[candles1.length - len].c;
  const base2 = candles2[candles2.length - len].c;
  const spreads = [];
  for (let i = 0; i < len; i++) {
    const idx1 = candles1.length - len + i;
    const idx2 = candles2.length - len + i;
    const norm1 = (candles1[idx1].c / base1 - 1) * 100;
    const norm2 = (candles2[idx2].c / base2 - 1) * 100;
    spreads.push(norm1 - norm2);
  }

  const currentSpread = spreads[spreads.length - 1];
  const avgSpread = spreads.reduce((s, v) => s + v, 0) / spreads.length;
  const variance = spreads.reduce((s, v) => s + Math.pow(v - avgSpread, 2), 0) / spreads.length;
  const stdDev = Math.sqrt(variance);
  return { currentSpread, avgSpread, stdDev, zScore: stdDev > 0 ? (currentSpread - avgSpread) / stdDev : 0 };
}

function updatePairRatio(t1, t2, p1, p2) {
  const key = `${t1}/${t2}`;
  const ratio = p1 / p2;
  const existing = pairRatios.get(key);

  if (existing) {
    existing.history.push(ratio);
    if (existing.history.length > 200) existing.history = existing.history.slice(-200);
    existing.currentRatio = ratio;
    existing.avgRatio = existing.history.reduce((s, r) => s + r, 0) / existing.history.length;
    const variance = existing.history.reduce((s, r) => s + Math.pow(r - existing.avgRatio, 2), 0) / existing.history.length;
    existing.stdDev = Math.sqrt(variance);
    existing.zScore = existing.stdDev > 0 ? (ratio - existing.avgRatio) / existing.stdDev : 0;
    return existing;
  }

  const newR = { ticker1: t1, ticker2: t2, currentRatio: ratio, avgRatio: ratio, stdDev: 0, zScore: 0, history: [ratio] };
  pairRatios.set(key, newR);
  return newR;
}

function detectArbitrage(marketDataMap) {
  if (!PM_CONFIG.ARBITRAGE.ENABLED) return { opportunities: [], bestOpportunity: null };

  const opportunities = [];
  const tickers = [...marketDataMap.keys()];

  for (const [t1, t2] of CORRELATED_PAIRS) {
    const candles1 = marketDataMap.get(t1);
    const candles2 = marketDataMap.get(t2);
    if (!candles1 || !candles2 || candles1.length < 20 || candles2.length < 20) continue;

    const p1 = candles1[candles1.length - 1].c;
    const p2 = candles2[candles2.length - 1].c;
    const ratio = updatePairRatio(t1, t2, p1, p2);
    if (ratio.history.length < 30) continue;

    const spread = calculateSpreadBetween(candles1, candles2);

    if (Math.abs(spread.zScore) > PM_CONFIG.ARBITRAGE.MIN_SPREAD_ZSCORE) {
      const isBuyFirst = spread.zScore < -PM_CONFIG.ARBITRAGE.MIN_SPREAD_ZSCORE;
      const confidence = Math.min(95, Math.abs(spread.zScore) * 25);
      const expectedProfit = Math.abs(spread.currentSpread - spread.avgSpread) * 0.6;

      if (confidence >= PM_CONFIG.ARBITRAGE.MIN_CONFIDENCE) {
        opportunities.push({
          type: 'STAT_ARB',
          buyTicker: isBuyFirst ? t1 : t2,
          sellTicker: isBuyFirst ? t2 : t1,
          spreadPercent: spread.currentSpread,
          deviation: spread.zScore,
          confidence, expectedProfit,
          reason: `${isBuyFirst ? t1 : t2} undervalued vs ${isBuyFirst ? t2 : t1}: z=${spread.zScore.toFixed(2)}`,
        });
      }
    }

    if (Math.abs(ratio.zScore) > 2 && ratio.history.length >= 50) {
      const isBuyFirst = ratio.zScore < -2;
      const confidence = Math.min(90, Math.abs(ratio.zScore) * 20);
      const expectedProfit = Math.abs(ratio.currentRatio - ratio.avgRatio) / ratio.avgRatio * 100 * 0.5;

      if (confidence >= PM_CONFIG.ARBITRAGE.MIN_CONFIDENCE) {
        opportunities.push({
          type: 'RATIO_ARB',
          buyTicker: isBuyFirst ? t1 : t2,
          sellTicker: isBuyFirst ? t2 : t1,
          spreadPercent: (ratio.currentRatio / ratio.avgRatio - 1) * 100,
          deviation: ratio.zScore,
          confidence, expectedProfit,
          reason: `Ratio arb: ${t1}/${t2} ratio=${ratio.currentRatio.toFixed(4)} vs avg=${ratio.avgRatio.toFixed(4)}`,
        });
      }
    }
  }

  // Cross-pair divergence
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      const c1 = marketDataMap.get(t1), c2 = marketDataMap.get(t2);
      if (!c1 || !c2 || c1.length < 10 || c2.length < 10) continue;

      const change1 = ((c1[c1.length - 1].c - c1[c1.length - 2].c) / c1[c1.length - 2].c) * 100;
      const change2 = ((c2[c2.length - 1].c - c2[c2.length - 2].c) / c2[c2.length - 2].c) * 100;
      const divergence = Math.abs(change1 - change2);

      if (divergence > 1.0) {
        const laggard = change1 < change2 ? t1 : t2;
        const leader = change1 < change2 ? t2 : t1;
        const leaderChange = Math.max(change1, change2);
        const confidence = Math.min(80, divergence * 20);

        if (confidence >= PM_CONFIG.ARBITRAGE.MIN_CONFIDENCE) {
          opportunities.push({
            type: 'CROSS_PAIR',
            buyTicker: laggard, sellTicker: leader,
            spreadPercent: divergence, deviation: divergence,
            confidence, expectedProfit: divergence * 0.4,
            reason: `Cross-pair: ${leader} +${leaderChange.toFixed(2)}%, ${laggard} lagging ${divergence.toFixed(2)}%`,
          });
        }
      }
    }
  }

  opportunities.sort((a, b) => (b.expectedProfit * b.confidence) - (a.expectedProfit * a.confidence));
  return {
    opportunities: opportunities.slice(0, 5),
    bestOpportunity: opportunities[0] || null,
  };
}

// ============================================
// 6. PAIR TRADING
// ============================================

function calculateNormalizedSpread(prices1, prices2) {
  const n = Math.min(prices1.length, prices2.length);
  if (n < 2) return [];
  const base1 = prices1[prices1.length - n];
  const base2 = prices2[prices2.length - n];
  const spreads = [];
  for (let i = 0; i < n; i++) {
    const idx1 = prices1.length - n + i;
    const idx2 = prices2.length - n + i;
    spreads.push(prices1[idx1] / base1 - prices2[idx2] / base2);
  }
  return spreads;
}

function estimateHalfLife(spreads) {
  if (spreads.length < 20) return 100;
  const y = [], x = [];
  for (let i = 1; i < spreads.length; i++) {
    y.push(spreads[i] - spreads[i - 1]);
    x.push(spreads[i - 1]);
  }
  const xm = x.reduce((s, v) => s + v, 0) / x.length;
  const ym = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - xm) * (y[i] - ym);
    den += (x[i] - xm) * (x[i] - xm);
  }
  const beta = den > 0 ? num / den : 0;
  if (beta >= 0) return 100;
  return Math.max(1, Math.min(100, -Math.log(2) / Math.log(1 + beta)));
}

function analyzePair(t1, t2, candles1, candles2) {
  const prices1 = candles1.map(c => c.c);
  const prices2 = candles2.map(c => c.c);
  const correlation = pearsonCorrelation(prices1, prices2);
  const spreadHistory = calculateNormalizedSpread(prices1, prices2);
  const avgSpread = spreadHistory.length > 0 ? spreadHistory.reduce((s, v) => s + v, 0) / spreadHistory.length : 0;
  const variance = spreadHistory.length > 0 ? spreadHistory.reduce((s, v) => s + Math.pow(v - avgSpread, 2), 0) / spreadHistory.length : 1;
  const stdDev = Math.sqrt(variance);
  const currentSpread = spreadHistory.length > 0 ? spreadHistory[spreadHistory.length - 1] : 0;
  const currentZScore = stdDev > 0 ? (currentSpread - avgSpread) / stdDev : 0;
  const halfLife = estimateHalfLife(spreadHistory);
  // Only positive correlation for long-only pair trading (negative = doubling exposure, not hedging)
  const cointegrated = correlation > PM_CONFIG.PAIR_TRADING.MIN_CORRELATION && halfLife < 30;

  const key = `${t1}:${t2}`;
  const data = { ticker1: t1, ticker2: t2, correlation, cointegrated, halfLife, currentZScore, spreadHistory: spreadHistory.slice(-100) };
  pairCorrelations.set(key, data);
  return data;
}

function getPairSignals(marketDataMap) {
  if (!PM_CONFIG.PAIR_TRADING.ENABLED) return [];

  const signals = [];
  const tickers = [...marketDataMap.keys()];

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      const c1 = marketDataMap.get(t1), c2 = marketDataMap.get(t2);
      if (!c1 || !c2 || c1.length < 30 || c2.length < 30) continue;

      const pairData = analyzePair(t1, t2, c1, c2);
      if (!pairData.cointegrated) continue;

      const key = `${t1}:${t2}`;
      const existing = openPairPositions.get(key);

      if (existing) {
        if (Math.abs(pairData.currentZScore) < PM_CONFIG.PAIR_TRADING.EXIT_ZSCORE) {
          signals.push({
            action: 'CLOSE_PAIR', longTicker: existing.longTicker, shortTicker: existing.shortTicker,
            zScore: pairData.currentZScore, confidence: 80,
            expectedProfit: Math.abs(existing.entryZScore - pairData.currentZScore) * 0.5,
            reason: `Pair revert: z=${pairData.currentZScore.toFixed(2)} from ${existing.entryZScore.toFixed(2)}`,
          });
        }
      } else {
        if (Math.abs(pairData.currentZScore) > PM_CONFIG.PAIR_TRADING.ENTRY_ZSCORE && Math.abs(pairData.currentZScore) < 10) {
          const longTicker = pairData.currentZScore < 0 ? t1 : t2;
          const shortTicker = pairData.currentZScore < 0 ? t2 : t1;
          const confidence = Math.min(90, Math.abs(pairData.currentZScore) * 20 + pairData.correlation * 20);

          signals.push({
            action: 'OPEN_PAIR', longTicker, shortTicker,
            zScore: pairData.currentZScore, confidence,
            expectedProfit: Math.abs(pairData.currentZScore) * 0.3,
            reason: `Pair diverge: ${t1}/${t2} z=${pairData.currentZScore.toFixed(2)} corr=${pairData.correlation.toFixed(2)} hl=${pairData.halfLife.toFixed(0)}`,
          });
        }
      }
    }
  }

  return signals.sort((a, b) => (b.confidence * b.expectedProfit) - (a.confidence * a.expectedProfit));
}

function openPairTrade(longTicker, shortTicker, longPrice, longQty, z) {
  const key = `${longTicker}:${shortTicker}`;
  openPairPositions.set(key, {
    longTicker, shortTicker, longQuantity: longQty,
    shortQuantity: 0, longEntryPrice: longPrice, shortEntryPrice: 0,
    entrySpread: 0, entryZScore: z, entryTime: Date.now(),
    currentSpread: 0, currentZScore: z, unrealizedPnl: 0,
  });
}

function closePairTrade(key) {
  const pos = openPairPositions.get(key);
  if (pos) openPairPositions.delete(key);
  return pos || null;
}

// ============================================
// ORCHESTRATOR: Exit Logic
// ============================================

/**
 * Check profit method exits for all held positions.
 * Called from server.js tradingBotLoop BEFORE the original exit logic switch.
 * Returns an array of { ticker, reason } for positions that should be sold.
 */
export function checkProfitMethodExits(positions, marketDataMap) {
  const exits = [];

  for (const [ticker, position] of Object.entries(positions)) {
    const candles = marketDataMap.get(ticker);
    if (!candles) continue;
    const price = candles[candles.length - 1].c;

    switch (position.entryStrategy) {
      case 'SWING': {
        const swingCheck = checkSwingExit(ticker, price);
        if (swingCheck.shouldExit) {
          exits.push({ ticker, reason: `[SWING] ${swingCheck.reason}` });
          swingPositions.delete(ticker);
          methodStats.swing.trades++;
          methodStats.swing.pnl += (price - position.openPrice) * position.quantity;
        }
        break;
      }
      case 'DCA': {
        const dcaCheck = checkDCATakeProfit(ticker, price);
        if (dcaCheck.shouldSell) {
          exits.push({ ticker, reason: `[DCA] ${dcaCheck.reason}` });
          dcaPositions.delete(ticker);
          methodStats.dca.trades++;
          methodStats.dca.pnl += (price - position.openPrice) * position.quantity;
        }
        break;
      }
      case 'GRID': {
        // Grid sell signals are handled inline via processGrid; also check range break
        const state = gridStates.get(ticker);
        if (state) {
          const { upperBound, lowerBound } = state.config;
          const buffer = (upperBound - lowerBound) * 0.15;
          if (price > upperBound + buffer || price < lowerBound - buffer) {
            exits.push({ ticker, reason: `[GRID] Range break: price ${price.toFixed(2)} outside grid` });
            gridStates.delete(ticker);
            methodStats.grid.trades++;
            methodStats.grid.pnl += (price - position.openPrice) * position.quantity;
          }
        }
        break;
      }
      case 'ARB': {
        const elapsed = Date.now() - position.entryTime;
        const arbPnlPercent = ((price - position.openPrice) / position.openPrice) * 100;
        let arbExitReason = null;

        // 1. Stop loss: exit if down more than 1.0%
        if (arbPnlPercent <= -1.0) {
          arbExitReason = `[ARB] Stop loss: ${arbPnlPercent.toFixed(2)}%`;
        }

        // 2. Take profit: exit if up more than 1.5% (net ~1% after 0.52% fees)
        if (!arbExitReason && arbPnlPercent >= 1.5) {
          arbExitReason = `[ARB] Take profit: +${arbPnlPercent.toFixed(2)}%`;
        }

        // 3. Z-score normalization: find the correlated pair and check if spread reverted
        if (!arbExitReason) {
          for (const [t1, t2] of CORRELATED_PAIRS) {
            if (t1 === ticker || t2 === ticker) {
              const c1 = marketDataMap.get(t1);
              const c2 = marketDataMap.get(t2);
              if (c1 && c2 && c1.length >= 20 && c2.length >= 20) {
                const spread = calculateSpreadBetween(c1, c2);
                if (Math.abs(spread.zScore) < 0.5) {
                  arbExitReason = `[ARB] Spread reverted: z=${spread.zScore.toFixed(2)}`;
                }
              }
              break;
            }
          }
        }

        // 4. Timeout: 30 min
        if (!arbExitReason && elapsed > 30 * 60 * 1000) {
          arbExitReason = `[ARB] Timeout (30min)`;
        }

        if (arbExitReason) {
          exits.push({ ticker, reason: arbExitReason });
          methodStats.arb.trades++;
          methodStats.arb.pnl += (price - position.openPrice) * position.quantity;
        }
        break;
      }
      case 'PAIR_LONG': {
        // Check if any pair position with this ticker should close
        for (const [key, pp] of openPairPositions) {
          if (pp.longTicker === ticker) {
            // Look for close signals
            const t1 = key.split(':')[0], t2 = key.split(':')[1];
            const c1 = marketDataMap.get(t1), c2 = marketDataMap.get(t2);
            if (c1 && c2 && c1.length >= 30 && c2.length >= 30) {
              const pd = analyzePair(t1, t2, c1, c2);
              if (Math.abs(pd.currentZScore) < PM_CONFIG.PAIR_TRADING.EXIT_ZSCORE) {
                exits.push({ ticker, reason: `[PAIR] Spread reverted: z=${pd.currentZScore.toFixed(2)}` });
                openPairPositions.delete(key);
                methodStats.pair.trades++;
                methodStats.pair.pnl += (price - position.openPrice) * position.quantity;
              }
            }
            // Also timeout after 1 hour
            if (Date.now() - pp.entryTime > 60 * 60 * 1000) {
              exits.push({ ticker, reason: `[PAIR] Timeout (60min)` });
              openPairPositions.delete(key);
              methodStats.pair.trades++;
              methodStats.pair.pnl += (price - position.openPrice) * position.quantity;
            }
            break;
          }
        }
        break;
      }
      case 'MM': {
        // MM positions: take profit above fees, stop loss, or timeout
        const mmElapsed = Date.now() - position.entryTime;
        const mmPnlPercent = ((price - position.openPrice) / position.openPrice) * 100;
        let mmExitReason = null;

        // Stop loss: exit if down more than 0.75%
        if (mmPnlPercent <= -0.75) {
          mmExitReason = `[MM] Stop loss: ${mmPnlPercent.toFixed(3)}%`;
        }
        // Take profit: must exceed round-trip fees (0.52%) + margin
        if (!mmExitReason && mmPnlPercent >= 1.0) {
          mmExitReason = `[MM] Spread captured: +${mmPnlPercent.toFixed(3)}%`;
        }
        // Timeout: 10 min
        if (!mmExitReason && mmElapsed > 10 * 60 * 1000) {
          mmExitReason = `[MM] Timeout (10min): ${mmPnlPercent.toFixed(3)}%`;
        }

        if (mmExitReason) {
          exits.push({ ticker, reason: mmExitReason });
          mmStates.delete(ticker);
          methodStats.mm.trades++;
          methodStats.mm.pnl += (price - position.openPrice) * position.quantity;
        }
        break;
      }
      default: {
        // Non-profit-method positions (TREND, MOMENTUM, BREAKOUT, etc.)
        // Apply a universal stale-position timeout: if down after 30 min, exit
        const defaultElapsed = Date.now() - position.entryTime;
        const defaultPnl = ((price - position.openPrice) / position.openPrice) * 100;
        if (defaultElapsed > 30 * 60 * 1000 && defaultPnl < -0.5) {
          exits.push({
            ticker,
            reason: `[PM-TIMEOUT] Stale ${position.entryStrategy} position: ${defaultPnl.toFixed(2)}% after ${Math.round(defaultElapsed / 60000)}min`,
          });
        }
        break;
      }
    }
  }

  return exits;
}

// ============================================
// ORCHESTRATOR: Entry Logic
// ============================================

/**
 * Run all 6 profit methods and return buy signals.
 * Called from server.js tradingBotLoop AFTER the original entry logic.
 * Returns array of { ticker, strategy, reason, amount, price }
 */
export function runProfitMethods(marketDataMap, portfolio, availableTickers, minTradeSize) {
  const entries = [];
  const cash = portfolio.cash;
  const budget = portfolio.initialBudget || cash;

  // --- SWING TRADING ---
  if (PM_CONFIG.SWING.ENABLED) {
    for (const ticker of availableTickers) {
      if (portfolio.positions[ticker]) continue;
      const candles = marketDataMap.get(ticker);
      if (!candles || candles.length < 30) continue;

      const price = candles[candles.length - 1].c;
      // Check for existing swing exits first
      if (swingPositions.has(ticker)) continue;

      const analysis = analyzeSwingSetup(ticker, candles);
      if (analysis.hasSetup && analysis.setup) {
        const maxAmount = budget * PM_CONFIG.SWING.PORTFOLIO_ALLOCATION;
        const amount = Math.min(maxAmount, 300); // Hard cap $300 per swing entry
        if (amount >= minTradeSize) {
          const qty = amount / price;
          swingPositions.set(ticker, {
            ticker, entryPrice: price, quantity: qty,
            targetPrice: analysis.setup.targetPrice,
            stopLoss: analysis.setup.stopLoss,
            entryTime: Date.now(),
            highestPrice: price,
          });
          entries.push({
            ticker, strategy: 'SWING', price, amount,
            reason: `[SWING] ${analysis.setup.reason}`,
          });
          break; // One swing entry per cycle
        }
      }
    }
  }

  // --- SMART DCA ---
  if (PM_CONFIG.DCA.ENABLED) {
    for (const ticker of availableTickers) {
      const candles = marketDataMap.get(ticker);
      if (!candles || candles.length < 10) continue;

      const dcaSignal = processDCA(ticker, candles, cash, budget, portfolio.positions);
      if (dcaSignal) {
        const amount = dcaSignal.amount;
        if (amount >= minTradeSize && cash >= amount) {
          const qty = amount / dcaSignal.price;
          recordDCABuy(ticker, dcaSignal.price, qty, amount);

          // If we already hold this ticker (DCA adds to position), tag it for tracking
          entries.push({
            ticker, strategy: 'DCA', price: dcaSignal.price, amount,
            reason: `[DCA] ${dcaSignal.reason}`,
          });
          break; // One DCA entry per cycle
        }
      }
    }
  }

  // --- GRID TRADING ---
  if (PM_CONFIG.GRID.ENABLED) {
    for (const ticker of availableTickers) {
      const candles = marketDataMap.get(ticker);
      if (!candles || candles.length < 15) continue;

      const gridSignal = processGrid(ticker, candles, cash);
      if (gridSignal && gridSignal.action === 'BUY') {
        const amount = gridSignal.investmentAmount;
        if (amount >= minTradeSize && cash >= amount) {
          entries.push({
            ticker, strategy: 'GRID', price: gridSignal.price, amount,
            reason: `[GRID] ${gridSignal.reason}`,
          });
          break; // One grid entry per cycle
        }
      }
      // Grid SELL signals are handled in exit logic
    }
  }

  // --- MARKET MAKING ---
  if (PM_CONFIG.MARKET_MAKING.ENABLED) {
    for (const ticker of availableTickers) {
      const candles = marketDataMap.get(ticker);
      if (!candles || candles.length < 15) continue;

      const mmSignal = processMarketMaking(ticker, candles, cash);
      if (mmSignal && mmSignal.action === 'BUY') {
        const amount = mmSignal.investmentAmount;
        if (amount >= minTradeSize && cash >= amount) {
          entries.push({
            ticker, strategy: 'MM', price: mmSignal.price, amount,
            reason: `[MM] ${mmSignal.reason}`,
          });
          break; // One MM entry per cycle
        }
      }
    }
  }

  // --- ARBITRAGE ---
  if (PM_CONFIG.ARBITRAGE.ENABLED && availableTickers.length >= 2) {
    const arbResult = detectArbitrage(marketDataMap);
    if (arbResult.bestOpportunity) {
      const opp = arbResult.bestOpportunity;
      const candles = marketDataMap.get(opp.buyTicker);
      if (candles && !portfolio.positions[opp.buyTicker]) {
        const price = candles[candles.length - 1].c;
        const amount = Math.min(cash * PM_CONFIG.ARBITRAGE.PORTFOLIO_ALLOCATION, cash * 0.1);
        if (amount >= minTradeSize && cash >= amount) {
          entries.push({
            ticker: opp.buyTicker, strategy: 'ARB', price, amount,
            reason: `[ARB] ${opp.reason}`,
          });
        }
      }
    }
  }

  // --- PAIR TRADING ---
  if (PM_CONFIG.PAIR_TRADING.ENABLED && availableTickers.length >= 2) {
    const pairSignals = getPairSignals(marketDataMap);
    for (const signal of pairSignals) {
      if (signal.action === 'OPEN_PAIR' && !portfolio.positions[signal.longTicker]) {
        const candles = marketDataMap.get(signal.longTicker);
        if (!candles) continue;
        const price = candles[candles.length - 1].c;
        const amount = Math.min(cash * PM_CONFIG.PAIR_TRADING.PORTFOLIO_ALLOCATION, cash * 0.1);
        if (amount >= minTradeSize && cash >= amount) {
          const qty = amount / price;
          openPairTrade(signal.longTicker, signal.shortTicker, price, qty, signal.zScore);
          entries.push({
            ticker: signal.longTicker, strategy: 'PAIR_LONG', price, amount,
            reason: `[PAIR] ${signal.reason}`,
          });
          break; // One pair entry per cycle
        }
      }
    }
  }

  return entries;
}

// ============================================
// CLEANUP: Called from handleSell to clear internal state for a sold ticker
// ============================================

export function cleanupProfitMethodState(ticker, entryStrategy) {
  // Always attempt cleanup for all PM state maps regardless of strategy,
  // since a position might have been entered by one strategy and tracked by another
  swingPositions.delete(ticker);
  dcaPositions.delete(ticker);
  gridStates.delete(ticker);
  mmStates.delete(ticker);

  // Pair positions: clean up any pair that includes this ticker
  for (const [key, pp] of openPairPositions) {
    if (pp.longTicker === ticker || pp.shortTicker === ticker) {
      openPairPositions.delete(key);
    }
  }
}

// ============================================
// STATUS ENDPOINT
// ============================================

// ============================================
// STATE EXPORT / IMPORT (for session persistence)
// ============================================

export function exportState() {
  return { ...methodStats };
}

export function importState(state) {
  if (!state) return;
  for (const key of Object.keys(methodStats)) {
    if (state[key]) {
      methodStats[key].trades = state[key].trades || 0;
      methodStats[key].pnl = state[key].pnl || 0;
    }
  }
}

export function getProfitMethodsStatus() {
  return {
    config: PM_CONFIG,
    stats: methodStats,
    swing: {
      activePositions: swingPositions.size,
      positions: Object.fromEntries(swingPositions),
    },
    dca: {
      activePositions: dcaPositions.size,
      positions: Object.fromEntries(dcaPositions),
    },
    grid: {
      activeGrids: gridStates.size,
      grids: Object.fromEntries(
        [...gridStates.entries()].map(([k, v]) => [k, {
          range: `${v.config.lowerBound.toFixed(2)}-${v.config.upperBound.toFixed(2)}`,
          filledBuys: v.filledBuys, filledSells: v.filledSells,
          totalPnl: v.totalPnl,
        }])
      ),
    },
    marketMaking: {
      activePairs: mmStates.size,
      states: Object.fromEntries(
        [...mmStates.entries()].map(([k, v]) => [k, {
          inventory: v.inventory, totalProfit: v.totalProfit,
          tradesCompleted: v.tradesCompleted,
          hasBid: !!v.currentBid, hasAsk: !!v.currentAsk,
        }])
      ),
    },
    arbitrage: {
      trackedPairs: pairRatios.size,
    },
    pairTrading: {
      correlations: pairCorrelations.size,
      openPositions: openPairPositions.size,
      positions: Object.fromEntries(openPairPositions),
    },
  };
}
