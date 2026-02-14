/**
 * Swing Trading Service
 *
 * Longer-duration trades targeting bigger moves (2-10%).
 * Uses higher timeframe analysis, support/resistance levels,
 * and trend strength to find high-conviction setups.
 *
 * Holds positions for hours to days vs day trading's minutes.
 */

import type { Candle } from '../types';

// ============================================
// TYPES
// ============================================

export interface SwingSetup {
  ticker: string;
  type: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  targetPercent: number;
  riskPercent: number;
  riskReward: number;        // Reward:Risk ratio (want > 2)
  confidence: number;        // 0-100
  reason: string;
  timeframe: string;
  signals: SwingSignalDetail[];
}

export interface SwingSignalDetail {
  name: string;
  bullish: boolean;
  weight: number;
}

export interface SwingPosition {
  ticker: string;
  entryPrice: number;
  quantity: number;
  targetPrice: number;
  stopLoss: number;
  entryTime: number;
  highestPrice: number;
  setup: SwingSetup;
}

export interface SwingAnalysis {
  hasSetup: boolean;
  setup: SwingSetup | null;
  trendStrength: number;     // 0-100
  keyLevels: { support: number; resistance: number };
  marketStructure: 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'BREAKOUT';
}

// ============================================
// STATE
// ============================================

const swingPositions: Map<string, SwingPosition> = new Map();

// ============================================
// SWING ANALYSIS
// ============================================

/**
 * Calculate swing-specific EMAs (longer periods than day trading)
 */
function swingEMA(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * Find key support and resistance levels
 */
function findKeyLevels(candles: Candle[]): { support: number; resistance: number; pivots: number[] } {
  if (candles.length < 20) {
    const price = candles[candles.length - 1]?.close || 0;
    return { support: price * 0.97, resistance: price * 1.03, pivots: [] };
  }

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // Find pivot highs and lows
  const pivots: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    // Pivot high
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      pivots.push(highs[i]);
    }
    // Pivot low
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      pivots.push(lows[i]);
    }
  }

  // Nearest support = highest pivot below current price
  const supports = pivots.filter(p => p < currentPrice).sort((a, b) => b - a);
  const resistances = pivots.filter(p => p > currentPrice).sort((a, b) => a - b);

  const support = supports[0] || currentPrice * 0.97;
  const resistance = resistances[0] || currentPrice * 1.03;

  return { support, resistance, pivots };
}

/**
 * Determine market structure for swing trading
 */
function analyzeMarketStructure(candles: Candle[]): {
  structure: SwingAnalysis['marketStructure'];
  trendStrength: number;
  momentum: number;
} {
  if (candles.length < 30) {
    return { structure: 'RANGE', trendStrength: 0, momentum: 0 };
  }

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  // Multiple EMA analysis
  const ema20 = swingEMA(closes, 20);
  const ema50 = swingEMA(closes, 50);

  const ema20Now = ema20[ema20.length - 1];
  const ema50Now = ema50[ema50.length - 1];
  const ema20Prev = ema20[ema20.length - 10] || ema20Now;
  const ema50Prev = ema50[ema50.length - 10] || ema50Now;

  // Higher highs / higher lows analysis
  const recentHighs: number[] = [];
  const recentLows: number[] = [];
  for (let i = candles.length - 30; i < candles.length; i += 5) {
    const slice = candles.slice(i, i + 5);
    recentHighs.push(Math.max(...slice.map(c => c.high)));
    recentLows.push(Math.min(...slice.map(c => c.low)));
  }

  const higherHighs = recentHighs.every((h, i) => i === 0 || h >= recentHighs[i - 1] * 0.998);
  const lowerLows = recentLows.every((l, i) => i === 0 || l <= recentLows[i - 1] * 1.002);
  const higherLows = recentLows.every((l, i) => i === 0 || l >= recentLows[i - 1] * 0.998);

  // Momentum
  const change10 = ((price - closes[closes.length - 11]) / closes[closes.length - 11]) * 100;
  const change20 = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;

  // Range detection
  const range20 = candles.slice(-20);
  const rangeHigh = Math.max(...range20.map(c => c.high));
  const rangeLow = Math.min(...range20.map(c => c.low));
  const rangePercent = ((rangeHigh - rangeLow) / rangeLow) * 100;

  // Breakout detection
  const prev20High = Math.max(...candles.slice(-40, -20).map(c => c.high));
  const isBreakout = price > prev20High && change10 > 1;

  let structure: SwingAnalysis['marketStructure'];
  let trendStrength = 0;

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
    trendStrength = Math.max(0, 30 - rangePercent * 5);
  }

  return { structure, trendStrength, momentum: change10 };
}

/**
 * Generate swing trading signals for a ticker
 */
export function analyzeSwingSetup(ticker: string, candles: Candle[]): SwingAnalysis {
  const noSetup: SwingAnalysis = {
    hasSetup: false,
    setup: null,
    trendStrength: 0,
    keyLevels: { support: 0, resistance: 0 },
    marketStructure: 'RANGE'
  };

  if (candles.length < 30) return noSetup;

  const price = candles[candles.length - 1].close;
  const { support, resistance } = findKeyLevels(candles);
  const { structure, trendStrength, momentum } = analyzeMarketStructure(candles);

  const signals: SwingSignalDetail[] = [];

  // 1. Trend alignment
  const closes = candles.map(c => c.close);
  const ema20 = swingEMA(closes, 20);
  const ema50 = swingEMA(closes, 50);
  const aboveEma20 = price > ema20[ema20.length - 1];
  const aboveEma50 = price > ema50[ema50.length - 1];
  const emasBullish = ema20[ema20.length - 1] > ema50[ema50.length - 1];

  signals.push({
    name: 'EMA_ALIGNMENT',
    bullish: aboveEma20 && aboveEma50 && emasBullish,
    weight: 25
  });

  // 2. Support bounce
  const nearSupport = (price - support) / support < 0.015; // Within 1.5%
  const bouncingFromSupport = nearSupport && price > candles[candles.length - 2].close;

  signals.push({
    name: 'SUPPORT_BOUNCE',
    bullish: bouncingFromSupport,
    weight: 20
  });

  // 3. Volume confirmation
  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const recentVolume = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const volumeRising = recentVolume > avgVolume * 1.2;

  signals.push({
    name: 'VOLUME_CONFIRMATION',
    bullish: volumeRising,
    weight: 15
  });

  // 4. Momentum
  const momentumBullish = momentum > 0.5;
  signals.push({
    name: 'MOMENTUM',
    bullish: momentumBullish,
    weight: 15
  });

  // 5. Higher timeframe trend
  const longTermTrend = candles.length > 50 ?
    price > swingEMA(closes, 50)[closes.length - 1] : true;
  signals.push({
    name: 'HIGHER_TF_TREND',
    bullish: longTermTrend,
    weight: 15
  });

  // 6. Breakout
  signals.push({
    name: 'BREAKOUT',
    bullish: structure === 'BREAKOUT',
    weight: 10
  });

  // Calculate total score
  const bullishScore = signals
    .filter(s => s.bullish)
    .reduce((sum, s) => sum + s.weight, 0);

  const confidence = bullishScore;

  // Only generate setup if confidence is high enough
  if (confidence < 40) {
    return {
      hasSetup: false,
      setup: null,
      trendStrength,
      keyLevels: { support, resistance },
      marketStructure: structure
    };
  }

  // Calculate targets
  const targetPrice = resistance;
  const stopLoss = support * 0.995; // Just below support
  const targetPercent = ((targetPrice - price) / price) * 100;
  const riskPercent = ((price - stopLoss) / price) * 100;
  const riskReward = riskPercent > 0 ? targetPercent / riskPercent : 0;

  // Only take trades with good risk:reward
  if (riskReward < 1.5 || targetPercent < 1) {
    return {
      hasSetup: false,
      setup: null,
      trendStrength,
      keyLevels: { support, resistance },
      marketStructure: structure
    };
  }

  const setup: SwingSetup = {
    ticker,
    type: 'LONG',
    entryPrice: price,
    targetPrice,
    stopLoss,
    targetPercent,
    riskPercent,
    riskReward,
    confidence,
    reason: `Swing ${structure}: R:R=${riskReward.toFixed(1)}, target=${targetPercent.toFixed(1)}% | ${signals.filter(s => s.bullish).map(s => s.name).join(', ')}`,
    timeframe: '4H',
    signals
  };

  return {
    hasSetup: true,
    setup,
    trendStrength,
    keyLevels: { support, resistance },
    marketStructure: structure
  };
}

/**
 * Check if swing position should exit
 */
export function checkSwingExit(
  ticker: string,
  currentPrice: number
): { shouldExit: boolean; reason: string; pnlPercent: number } {
  const position = swingPositions.get(ticker);
  if (!position) return { shouldExit: false, reason: '', pnlPercent: 0 };

  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  // Update highest price
  position.highestPrice = Math.max(position.highestPrice, currentPrice);

  // Target hit
  if (currentPrice >= position.targetPrice) {
    return {
      shouldExit: true,
      reason: `Swing target hit: +${pnlPercent.toFixed(2)}% (target: ${position.setup.targetPercent.toFixed(1)}%)`,
      pnlPercent
    };
  }

  // Stop loss hit
  if (currentPrice <= position.stopLoss) {
    return {
      shouldExit: true,
      reason: `Swing stop loss: ${pnlPercent.toFixed(2)}%`,
      pnlPercent
    };
  }

  // Trailing stop: if we're up 2%+, trail at 50% of profit
  if (pnlPercent > 2) {
    const trailingLevel = position.entryPrice * (1 + pnlPercent * 0.005); // 50% of profit as stop
    if (currentPrice < trailingLevel) {
      return {
        shouldExit: true,
        reason: `Swing trailing stop: +${pnlPercent.toFixed(2)}% (locked in profit)`,
        pnlPercent
      };
    }
  }

  return { shouldExit: false, reason: '', pnlPercent };
}

/**
 * Record opening a swing position
 */
export function openSwingPosition(setup: SwingSetup, quantity: number): void {
  swingPositions.set(setup.ticker, {
    ticker: setup.ticker,
    entryPrice: setup.entryPrice,
    quantity,
    targetPrice: setup.targetPrice,
    stopLoss: setup.stopLoss,
    entryTime: Date.now(),
    highestPrice: setup.entryPrice,
    setup
  });
}

/**
 * Close swing position
 */
export function closeSwingPosition(ticker: string): SwingPosition | null {
  const pos = swingPositions.get(ticker);
  swingPositions.delete(ticker);
  return pos || null;
}

/**
 * Get all swing positions
 */
export function getSwingPositions(): Map<string, SwingPosition> {
  return swingPositions;
}

/**
 * Get swing position for ticker
 */
export function getSwingPosition(ticker: string): SwingPosition | null {
  return swingPositions.get(ticker) || null;
}
