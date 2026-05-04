/**
 * ShortSellingEngine — Support for profiting from downtrends.
 *
 * Enables trading in DOWN/STRONG_DOWN regimes by shorting.
 * Starts in SIMULATION mode with a $1K simulated account.
 *
 * Kraken: Margin trading (borrow → sell → buy back → return)
 * Crypto.com: Derivatives/perpetuals (synthetic short exposure)
 */

import tradingBus from './eventBus.ts';
import type { ExitEvent } from './eventBus.ts';

// ─── Types ───────────────────────────────────────────────────

export type ShortPosition = {
  id: string;
  exchange: 'kraken' | 'crypto.com';
  ticker: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  leverage: number;         // 1x = no leverage, 2x = 2x margin
  stopLossPrice: number;
  takeProfitPrice: number;
  highestPrice: number;     // For trailing stop (worst price for short = highest)
  lowestPrice: number;      // Best price for short = lowest
  marginUsed: number;       // USD margin locked
  liquidationPrice: number; // Price at which position is auto-closed
  status: 'open' | 'closing' | 'closed';
  unrealizedPnl: number;
};

export interface ShortConfig {
  enabled: boolean;
  maxLeverage: number;        // Max leverage (default 1x for safety, 2x for sim)
  maxShortPositions: number;  // Max simultaneous shorts
  maxExposurePct: number;     // Max % of portfolio in shorts
  minConfidence: number;      // Min ML confidence to short
  stopLossPct: number;        // Default SL for shorts (positive = above entry)
  takeProfitPct: number;      // Default TP for shorts (positive = below entry)
  onlyInRegimes: string[];    // Only short in these regimes
}

const DEFAULT_CONFIG: ShortConfig = {
  enabled: true,
  maxLeverage: 1,           // No leverage by default (safest)
  maxShortPositions: 3,
  maxExposurePct: 0.20,     // Max 20% of portfolio in shorts
  minConfidence: 0.70,      // Need 70%+ ML confidence to short
  stopLossPct: 3.0,         // Close if price rises 3% above entry
  takeProfitPct: 5.0,       // Take profit when price drops 5%
  onlyInRegimes: ['DOWN', 'STRONG_DOWN', 'DOWNTREND'],
};

// ─── Short Selling Engine ────────────────────────────────────

class ShortSellingEngine {
  private config: ShortConfig;
  private positions: Map<string, ShortPosition> = new Map();
  private simBalance = 1000; // Simulated $1K account for shorts
  private simInitialBalance = 1000;
  private tradeHistory: { time: number; pnl: number; ticker: string }[] = [];

  constructor(config: Partial<ShortConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    console.log('[ShortEngine] Initialized', this.config.enabled ? '(enabled)' : '(disabled)');
  }

  /**
   * Evaluate whether to open a short position.
   * Called by TradingEngine when regime is bearish.
   */
  evaluateShortEntry(
    ticker: string,
    exchange: 'kraken' | 'crypto.com',
    currentPrice: number,
    regime: string,
    mlConfidence: number,
    tcScore: number,
    rsi?: number,
    priceChange5?: number,
    extraSignals?: { emaSlope?: number; bbPercentB?: number; priceChange20?: number },
  ): { shouldShort: boolean; reason: string; size?: number } {
    if (!this.config.enabled) {
      return { shouldShort: false, reason: 'Short selling disabled' };
    }

    // Regime check — only short in bearish regimes
    if (!this.config.onlyInRegimes.includes(regime)) {
      return { shouldShort: false, reason: `Regime ${regime} not in short list` };
    }

    // ML Confidence check
    if (mlConfidence < this.config.minConfidence) {
      return { shouldShort: false, reason: `ML confidence ${(mlConfidence * 100).toFixed(0)}% < ${this.config.minConfidence * 100}%` };
    }

    // TC check — relaxed to 45 (was 40). In slow bleeds TC hovers near 40.
    if (tcScore > 45) {
      return { shouldShort: false, reason: `TC score ${tcScore} too bullish for short (need <45)` };
    }

    // Position limit check
    if (this.positions.size >= this.config.maxShortPositions) {
      return { shouldShort: false, reason: `Max ${this.config.maxShortPositions} short positions reached` };
    }

    // Already have a short on this ticker?
    if (this.positions.has(`${exchange}:${ticker}`)) {
      return { shouldShort: false, reason: `Already short ${ticker} on ${exchange}` };
    }

    // Exposure check
    const totalExposure = this.getTotalExposure();
    if (totalExposure / this.simBalance >= this.config.maxExposurePct) {
      return { shouldShort: false, reason: `Short exposure ${((totalExposure / this.simBalance) * 100).toFixed(1)}% >= ${this.config.maxExposurePct * 100}%` };
    }

    // ─── Short signal detection (need at least 1 of 4 signals) ───
    const rsiVal = rsi ?? 50;
    const priceChg = priceChange5 ?? 0;
    const emaSlope = extraSignals?.emaSlope ?? 0;
    const bbPctB = extraSignals?.bbPercentB ?? 0.5;
    const priceChg20 = extraSignals?.priceChange20 ?? 0;

    const signals: string[] = [];
    let signalCount = 0;

    // Signal 1: RSI overbought bounce (mean-reversion short)
    const hasOverboughtRSI = rsiVal > 60;
    if (hasOverboughtRSI) { signals.push(`RSI=${rsiVal.toFixed(0)}`); signalCount++; }

    // Signal 2: Sharp bearish momentum (5-bar drop)
    const hasBearishMomentum = priceChg < -1.2;
    if (hasBearishMomentum) { signals.push(`5bar=${priceChg.toFixed(1)}%`); signalCount++; }

    // Signal 3: Trend-following — EMA slope negative (all EMAs declining)
    // emaSlope is (ema20 - ema50) / ema50 as percentage. Negative = bearish trend.
    const hasTrendFollow = emaSlope < -0.5;
    if (hasTrendFollow) { signals.push(`slope=${emaSlope.toFixed(2)}%`); signalCount++; }

    // Signal 4: BB lower break — price near or below lower Bollinger Band in downtrend
    // bbPercentB < 0.1 means price is at or below the lower band
    const hasBBBreak = bbPctB < 0.15;
    if (hasBBBreak) { signals.push(`BB%B=${bbPctB.toFixed(2)}`); signalCount++; }

    // Signal 5: Sustained decline — 20-bar price change deeply negative
    const hasSustainedDecline = priceChg20 < -3.0;
    if (hasSustainedDecline) { signals.push(`20bar=${priceChg20.toFixed(1)}%`); signalCount++; }

    // Need at least 1 signal to short
    if (signalCount === 0) {
      return { shouldShort: false, reason: `No short signal: RSI=${rsiVal.toFixed(0)}, 5bar=${priceChg.toFixed(1)}%, slope=${emaSlope.toFixed(2)}%, BB%B=${bbPctB.toFixed(2)}, 20bar=${priceChg20.toFixed(1)}%` };
    }

    // STRONG_DOWN regime: relax to just 1 signal. DOWN regime: need 2+.
    if (regime === 'DOWN' && signalCount < 2) {
      return { shouldShort: false, reason: `DOWN regime needs 2+ signals, got ${signalCount}: ${signals.join(', ')}` };
    }

    // Calculate position size (conservative: 5-15% of sim balance)
    // Scale with signal count: more signals = more conviction
    const sizePct = 0.05 + Math.min(signalCount, 3) * 0.025 + (mlConfidence - this.config.minConfidence) * 0.10;
    const size = this.simBalance * Math.min(sizePct, 0.15);

    return {
      shouldShort: true,
      reason: `Bearish ${regime}, TC=${tcScore}, ${signalCount} signals: ${signals.join(', ')}`,
      size,
    };
  }

  /**
   * Open a simulated short position.
   */
  openShort(
    ticker: string,
    exchange: 'kraken' | 'crypto.com',
    entryPrice: number,
    usdAmount: number,
    reason: string,
  ): ShortPosition {
    const quantity = usdAmount / entryPrice;
    const leverage = this.config.maxLeverage;
    const marginUsed = usdAmount / leverage;

    // Calculate liquidation price (for leveraged shorts)
    // If 2x leverage: liquidation when price rises 50% above entry
    const liquidationPrice = leverage > 1
      ? entryPrice * (1 + 1 / leverage)
      : entryPrice * 10; // Effectively no liquidation at 1x

    const position: ShortPosition = {
      id: `${exchange}:${ticker}`,
      exchange,
      ticker,
      quantity,
      entryPrice,
      entryTime: Date.now(),
      leverage,
      stopLossPrice: entryPrice * (1 + this.config.stopLossPct / 100),
      takeProfitPrice: entryPrice * (1 - this.config.takeProfitPct / 100),
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      marginUsed,
      liquidationPrice,
      status: 'open',
      unrealizedPnl: 0,
    };

    this.positions.set(position.id, position);
    this.simBalance -= marginUsed;

    console.log(
      `[ShortEngine] Opened short: ${ticker} on ${exchange}`,
      `@ $${entryPrice.toFixed(2)} x${leverage}`,
      `SL: $${position.stopLossPrice.toFixed(2)}`,
      `TP: $${position.takeProfitPrice.toFixed(2)}`
    );

    // Emit entry event (tagged as short via direction='short' — M6)
    tradingBus.emit('trade:entry', {
      type: 'BUY',
      direction: 'short',
      exchange,
      ticker,
      price: entryPrice,
      quantity,
      usdAmount,
      strategy: 'SHORT_TREND',
      confidence: 0,
      mode: 'SIMULATION',
      timestamp: Date.now(),
      targetPct: -this.config.takeProfitPct, // Negative = short target
      stopLossPct: this.config.stopLossPct,
      maxHoldHours: 168,
      reason: `[SHORT] ${reason}`,
    });

    return position;
  }

  /**
   * Check all open shorts for exit conditions.
   */
  checkExits(priceMap: Map<string, number>): void {
    for (const [id, pos] of this.positions) {
      const currentPrice = priceMap.get(`${pos.exchange}:${pos.ticker}`);
      if (!currentPrice) continue;

      // Update tracking
      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

      // For shorts: profit when price goes DOWN
      pos.unrealizedPnl = (pos.entryPrice - currentPrice) * pos.quantity * pos.leverage;

      let exitReason: string | null = null;

      // Stop loss (price went UP above SL)
      if (currentPrice >= pos.stopLossPrice) {
        exitReason = `Stop-loss hit ($${currentPrice.toFixed(2)} >= $${pos.stopLossPrice.toFixed(2)})`;
      }

      // Take profit (price went DOWN below TP)
      if (currentPrice <= pos.takeProfitPrice) {
        exitReason = `Take-profit hit ($${currentPrice.toFixed(2)} <= $${pos.takeProfitPrice.toFixed(2)})`;
      }

      // Liquidation (leveraged only)
      if (currentPrice >= pos.liquidationPrice) {
        exitReason = `LIQUIDATED ($${currentPrice.toFixed(2)} >= $${pos.liquidationPrice.toFixed(2)})`;
      }

      // Trailing stop for shorts: if price dropped significantly then rebounds
      const pnlPct = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
      const peakPnlPct = ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice) * 100;
      if (peakPnlPct > 3 && pnlPct < peakPnlPct * 0.6) {
        exitReason = `Trailing stop (peak ${peakPnlPct.toFixed(1)}%, now ${pnlPct.toFixed(1)}%)`;
      }

      if (exitReason) {
        this.closeShort(pos, currentPrice, exitReason);
      }
    }
  }

  private closeShort(pos: ShortPosition, exitPrice: number, reason: string): void {
    const pnl = (pos.entryPrice - exitPrice) * pos.quantity * pos.leverage;
    const isProfit = pnl > 0;

    this.simBalance += pos.marginUsed + pnl;
    this.positions.delete(pos.id);

    this.tradeHistory.push({ time: Date.now(), pnl, ticker: pos.ticker });
    // Cap trade history to prevent unbounded memory growth
    if (this.tradeHistory.length > 500) {
      this.tradeHistory = this.tradeHistory.slice(-500);
    }

    console.log(
      `[ShortEngine] Closed short: ${pos.ticker} on ${pos.exchange}`,
      `Entry: $${pos.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}`,
      `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
      `Reason: ${reason}`
    );

    tradingBus.emit('trade:exit', {
      type: 'SELL',
      exchange: pos.exchange,
      ticker: pos.ticker,
      price: exitPrice,
      quantity: pos.quantity,
      usdAmount: exitPrice * pos.quantity,
      strategy: 'SHORT_TREND',
      confidence: 0,
      mode: 'SIMULATION',
      timestamp: Date.now(),
      entryPrice: pos.entryPrice,
      pnlPercent: ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100,
      pnlUsd: pnl,
      feesUsd: 0, // Sim mode
      netPnlUsd: pnl,
      holdDurationMs: Date.now() - pos.entryTime,
      reason: `[SHORT] ${reason}`,
      isProfit,
    });
  }

  // ─── Getters ─────────────────────────────────────────────

  getPositions(): ShortPosition[] {
    return Array.from(this.positions.values());
  }

  private getTotalExposure(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.marginUsed, 0);
  }

  getStatus() {
    const wins = this.tradeHistory.filter(t => t.pnl > 0).length;
    const total = this.tradeHistory.length;
    return {
      enabled: this.config.enabled,
      simBalance: this.simBalance,
      simPnl: this.simBalance - this.simInitialBalance,
      simPnlPct: ((this.simBalance - this.simInitialBalance) / this.simInitialBalance) * 100,
      openPositions: this.positions.size,
      totalTrades: total,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      exposure: this.getTotalExposure(),
      exposurePct: this.simBalance > 0 ? (this.getTotalExposure() / this.simBalance) * 100 : 0,
    };
  }

  setConfig(update: Partial<ShortConfig>): void {
    Object.assign(this.config, update);
  }
}

export const shortSellingEngine = new ShortSellingEngine();
export default shortSellingEngine;
