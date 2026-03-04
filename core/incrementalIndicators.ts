/**
 * IncrementalIndicators — 10-50x faster indicator calculations.
 *
 * Instead of recalculating all 103 features from scratch every tick,
 * this engine updates incrementally when a new candle arrives.
 * EMA: O(1) per tick (previous EMA + new price)
 * RSI: O(1) per tick (running gain/loss averages)
 * ATR: O(1) per tick (running average of true range)
 */

// ─── Types ───────────────────────────────────────────────────

export interface IndicatorState {
  // EMA state
  ema10: number;
  ema20: number;
  ema30: number;
  ema50: number;
  ema200: number;

  // RSI state
  rsiAvgGain: number;
  rsiAvgLoss: number;
  rsi: number;

  // ATR state
  atr14: number;
  atrPercent: number;

  // MACD state
  macdEma12: number;
  macdEma26: number;
  macdSignal: number;
  macdHistogram: number;

  // Bollinger state
  bbMiddle: number;   // SMA20
  bbUpper: number;
  bbLower: number;
  bbWidth: number;

  // Volume state
  volumeSma20: number;
  volumeRatio: number;

  // Price state
  lastPrice: number;
  lastVolume: number;
  priceBuffer: number[];      // Last 200 prices for SMA/BB
  volumeBuffer: number[];     // Last 20 volumes
  highBuffer: number[];       // Last 14 highs for ATR
  lowBuffer: number[];        // Last 14 lows for ATR
  closeBuffer: number[];      // Last 14 closes for ATR

  // Metadata
  tickCount: number;
  isWarmedUp: boolean;        // Need at least 200 ticks before reliable
}

// ─── Constants ───────────────────────────────────────────────

const EMA_ALPHAS = {
  10: 2 / (10 + 1),
  12: 2 / (12 + 1),
  20: 2 / (20 + 1),
  26: 2 / (26 + 1),
  30: 2 / (30 + 1),
  50: 2 / (50 + 1),
  200: 2 / (200 + 1),
};

const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const BB_PERIOD = 20;
const BB_STD_MULT = 2;
const MACD_SIGNAL_PERIOD = 9;
const MACD_SIGNAL_ALPHA = 2 / (MACD_SIGNAL_PERIOD + 1);
const VOL_SMA_PERIOD = 20;

// ─── Incremental Engine ──────────────────────────────────────

export class IncrementalIndicatorEngine {
  private states: Map<string, IndicatorState> = new Map();

  /**
   * Initialize state for a new ticker.
   * Call this once with historical data to warm up.
   */
  warmUp(ticker: string, candles: { c: number; h: number; l: number; v: number }[]): IndicatorState {
    const state: IndicatorState = {
      ema10: 0, ema20: 0, ema30: 0, ema50: 0, ema200: 0,
      rsiAvgGain: 0, rsiAvgLoss: 0, rsi: 50,
      atr14: 0, atrPercent: 0,
      macdEma12: 0, macdEma26: 0, macdSignal: 0, macdHistogram: 0,
      bbMiddle: 0, bbUpper: 0, bbLower: 0, bbWidth: 0,
      volumeSma20: 0, volumeRatio: 1,
      lastPrice: 0, lastVolume: 0,
      priceBuffer: [],
      volumeBuffer: [],
      highBuffer: [],
      lowBuffer: [],
      closeBuffer: [],
      tickCount: 0,
      isWarmedUp: false,
    };

    // Process all historical candles
    for (const candle of candles) {
      this.updateState(state, candle.c, candle.h, candle.l, candle.v);
    }

    state.isWarmedUp = state.tickCount >= 200;
    this.states.set(ticker, state);
    return state;
  }

  /**
   * Update indicators with a new price tick.
   * O(1) amortized — no full recalculation needed.
   */
  update(ticker: string, close: number, high: number, low: number, volume: number): IndicatorState | null {
    const state = this.states.get(ticker);
    if (!state) return null;

    this.updateState(state, close, high, low, volume);
    return state;
  }

  private updateState(state: IndicatorState, close: number, high: number, low: number, volume: number): void {
    const prevClose = state.lastPrice || close;
    state.tickCount++;

    // ── EMA updates (O(1) each) ──
    if (state.tickCount === 1) {
      state.ema10 = state.ema20 = state.ema30 = state.ema50 = state.ema200 = close;
      state.macdEma12 = state.macdEma26 = close;
    } else {
      state.ema10 = EMA_ALPHAS[10] * close + (1 - EMA_ALPHAS[10]) * state.ema10;
      state.ema20 = EMA_ALPHAS[20] * close + (1 - EMA_ALPHAS[20]) * state.ema20;
      state.ema30 = EMA_ALPHAS[30] * close + (1 - EMA_ALPHAS[30]) * state.ema30;
      state.ema50 = EMA_ALPHAS[50] * close + (1 - EMA_ALPHAS[50]) * state.ema50;
      state.ema200 = EMA_ALPHAS[200] * close + (1 - EMA_ALPHAS[200]) * state.ema200;
      state.macdEma12 = EMA_ALPHAS[12] * close + (1 - EMA_ALPHAS[12]) * state.macdEma12;
      state.macdEma26 = EMA_ALPHAS[26] * close + (1 - EMA_ALPHAS[26]) * state.macdEma26;
    }

    // ── MACD (O(1)) ──
    const macdLine = state.macdEma12 - state.macdEma26;
    state.macdSignal = MACD_SIGNAL_ALPHA * macdLine + (1 - MACD_SIGNAL_ALPHA) * state.macdSignal;
    state.macdHistogram = macdLine - state.macdSignal;

    // ── RSI (O(1) using Wilder's smoothing) ──
    const change = close - prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (state.tickCount <= RSI_PERIOD) {
      state.rsiAvgGain += gain / RSI_PERIOD;
      state.rsiAvgLoss += loss / RSI_PERIOD;
    } else {
      state.rsiAvgGain = (state.rsiAvgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      state.rsiAvgLoss = (state.rsiAvgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    }

    if (state.rsiAvgLoss === 0) {
      state.rsi = 100;
    } else {
      const rs = state.rsiAvgGain / state.rsiAvgLoss;
      state.rsi = 100 - (100 / (1 + rs));
    }

    // ── ATR (O(1) using running average) ──
    state.highBuffer.push(high);
    state.lowBuffer.push(low);
    state.closeBuffer.push(close);
    if (state.highBuffer.length > ATR_PERIOD + 1) {
      state.highBuffer.shift();
      state.lowBuffer.shift();
      state.closeBuffer.shift();
    }

    if (state.tickCount >= 2) {
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      if (state.tickCount <= ATR_PERIOD) {
        state.atr14 += tr / ATR_PERIOD;
      } else {
        state.atr14 = (state.atr14 * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      }
      state.atrPercent = close > 0 ? (state.atr14 / close) * 100 : 0;
    }

    // ── Bollinger Bands (O(1) amortized with rolling buffer) ──
    state.priceBuffer.push(close);
    if (state.priceBuffer.length > BB_PERIOD) state.priceBuffer.shift();

    if (state.priceBuffer.length >= BB_PERIOD) {
      const sum = state.priceBuffer.reduce((a, b) => a + b, 0);
      state.bbMiddle = sum / BB_PERIOD;

      const variance = state.priceBuffer.reduce((acc, p) => acc + (p - state.bbMiddle) ** 2, 0) / BB_PERIOD;
      const stdDev = Math.sqrt(variance);

      state.bbUpper = state.bbMiddle + BB_STD_MULT * stdDev;
      state.bbLower = state.bbMiddle - BB_STD_MULT * stdDev;
      state.bbWidth = state.bbMiddle > 0 ? ((state.bbUpper - state.bbLower) / state.bbMiddle) * 100 : 0;
    }

    // ── Volume (O(1)) ──
    state.volumeBuffer.push(volume);
    if (state.volumeBuffer.length > VOL_SMA_PERIOD) state.volumeBuffer.shift();

    if (state.volumeBuffer.length >= VOL_SMA_PERIOD) {
      state.volumeSma20 = state.volumeBuffer.reduce((a, b) => a + b, 0) / VOL_SMA_PERIOD;
      state.volumeRatio = state.volumeSma20 > 0 ? volume / state.volumeSma20 : 1;
    }

    // Update last values
    state.lastPrice = close;
    state.lastVolume = volume;
    if (state.tickCount >= 200) state.isWarmedUp = true;
  }

  /**
   * Get current indicator snapshot for a ticker.
   * Returns all values needed for feature engineering.
   */
  getSnapshot(ticker: string): IndicatorState | null {
    return this.states.get(ticker) || null;
  }

  /**
   * Export feature vector for ML (partial — covers EMA, RSI, ATR, MACD, BB, Volume).
   * These replace ~20 features from the original 103 that were computed from scratch.
   */
  getFeatureVector(ticker: string): number[] | null {
    const s = this.states.get(ticker);
    if (!s || !s.isWarmedUp) return null;

    return [
      // EMA features (5)
      s.lastPrice > 0 ? (s.lastPrice - s.ema10) / s.lastPrice * 100 : 0,
      s.lastPrice > 0 ? (s.lastPrice - s.ema20) / s.lastPrice * 100 : 0,
      s.lastPrice > 0 ? (s.lastPrice - s.ema50) / s.lastPrice * 100 : 0,
      s.lastPrice > 0 ? (s.ema10 - s.ema30) / s.lastPrice * 100 : 0, // EMA crossover
      s.lastPrice > 0 ? (s.lastPrice - s.ema200) / s.lastPrice * 100 : 0,

      // RSI (1)
      s.rsi,

      // ATR (2)
      s.atr14,
      s.atrPercent,

      // MACD (3)
      s.macdEma12 - s.macdEma26, // MACD line
      s.macdSignal,
      s.macdHistogram,

      // Bollinger (3)
      s.bbWidth,
      s.lastPrice > 0 && s.bbUpper !== s.bbLower
        ? (s.lastPrice - s.bbLower) / (s.bbUpper - s.bbLower) * 100 // %B
        : 50,
      s.bbMiddle > 0 ? (s.lastPrice - s.bbMiddle) / s.bbMiddle * 100 : 0,

      // Volume (2)
      s.volumeRatio,
      s.volumeSma20,
    ];
  }

  /**
   * Get all tracked tickers.
   */
  getTrackedTickers(): string[] {
    return Array.from(this.states.keys());
  }

  /**
   * Remove a ticker (no longer needed).
   */
  removeTicker(ticker: string): void {
    this.states.delete(ticker);
  }
}

export const incrementalIndicators = new IncrementalIndicatorEngine();
export default incrementalIndicators;
