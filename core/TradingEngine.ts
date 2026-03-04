/**
 * TradingEngine — Exchange-agnostic trading bot that can be instantiated per exchange.
 *
 * Each exchange (Kraken, Crypto.com) gets its own TradingEngine instance with:
 * - Independent portfolio (cash, positions, equity)
 * - Independent config (fee-tuned thresholds)
 * - Independent trading mode (SIMULATION or REAL)
 * - Shared ML pipeline (predictions consumed independently)
 * - Shared EventBus (events routed by exchange tag)
 */

import tradingBus from './eventBus.js';
import type { EntryEvent, ExitEvent, SignalEvent, RiskEvent } from './eventBus.js';

// ─── Types ───────────────────────────────────────────────────

export type ExchangeId = 'kraken' | 'crypto.com';
export type EngineMode = 'SIMULATION' | 'REAL';
export type EngineState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR';

export interface EnginePosition {
  ticker: string;
  quantity: number;
  openPrice: number;
  entryTime: number;
  entryStrategy: string;
  highestPrice: number;
  lowestPrice: number;
  exitStage: number;
  originalQuantity: number;
  // Exchange-native SL/TP order IDs (if placed)
  nativeSlOrderId?: string;
  nativeTpOrderId?: string;
}

export interface EnginePortfolio {
  cash: number;
  initialBudget: number;
  positions: Record<string, EnginePosition>;
}

export interface ExchangeConfig {
  name: string;
  takerFee: number;
  makerFee: number;
  roundTripTaker: number;
  roundTripMaker: number;
  minProfitTarget: number;
  minProfitMaker: number;
  preferLimitOrders: boolean;
  minOrderUsd: number;
  wsUrl: string;
  strategyFocus: string[];
}

export interface EngineConfig {
  exchange: ExchangeId;
  exchangeConfig: ExchangeConfig;
  mode: EngineMode;
  budget: number;
  tickers: string[];
  intervalMs: number;           // Bot loop interval (default 1500ms)
  maxPositions: number;         // Max simultaneous positions
  maxPerTickerPct: number;      // Max % of portfolio per ticker
  maxExposurePct: number;       // Max % of portfolio deployed
  useNativeStopLoss: boolean;   // Place SL orders on exchange
  useNativeTakeProfit: boolean; // Place TP orders on exchange
  simulatedBudget?: number;     // For sim mode: simulated $1K account
}

// ─── Exchange Adapter Interface ──────────────────────────────

export interface ExchangeAdapter {
  getInstruments(): Promise<{ ticker: string; minOrderSize: number }[]>;
  getCandles(ticker: string, interval: string, limit: number): Promise<unknown[]>;
  getBalance(): Promise<{ cashBalance: number; holdings: Record<string, { quantity: number; usdValue: number }> }>;
  getOrderBook(ticker: string, depth?: number): Promise<{ bids: [number, number][]; asks: [number, number][] }>;
  placeBuyOrder(ticker: string, quantity: number, options?: { type?: 'market' | 'limit'; price?: number }): Promise<{ orderId: string; filledPrice: number; filledQuantity: number }>;
  placeSellOrder(ticker: string, quantity: number, options?: { type?: 'market' | 'limit'; price?: number }): Promise<{ orderId: string; filledPrice: number; filledQuantity: number }>;
  placeStopLoss?(ticker: string, quantity: number, stopPrice: number): Promise<{ orderId: string }>;
  placeTakeProfit?(ticker: string, quantity: number, limitPrice: number): Promise<{ orderId: string }>;
  cancelOrder?(orderId: string): Promise<void>;
  getOpenOrders?(): Promise<{ orderId: string; ticker: string; side: string; price: number }[]>;
  getFeePercent(): number;
  getMakerFeePercent?(): number;
}

// ─── TradingEngine Class ─────────────────────────────────────

export class TradingEngine {
  readonly exchange: ExchangeId;
  readonly config: EngineConfig;
  private adapter: ExchangeAdapter;
  private wsService: unknown; // WebSocket service (typed loosely for now)
  private portfolio: EnginePortfolio;
  private state: EngineState = 'IDLE';
  private mode: EngineMode;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private sessionId: string | null = null;
  private peakEquity = 0;
  private sessionStartTime = 0;

  // Circuit breaker state (per-engine)
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private dailyTradeCount = 0;
  private pauseUntil = 0;

  // Performance tracking
  private trades: { time: number; pnl: number; ticker: string; strategy: string }[] = [];

  constructor(
    config: EngineConfig,
    adapter: ExchangeAdapter,
    wsService?: unknown,
  ) {
    this.config = config;
    this.exchange = config.exchange;
    this.mode = config.mode;
    this.adapter = adapter;
    this.wsService = wsService;
    this.portfolio = {
      cash: config.mode === 'SIMULATION' ? (config.simulatedBudget || config.budget) : config.budget,
      initialBudget: config.mode === 'SIMULATION' ? (config.simulatedBudget || config.budget) : config.budget,
      positions: {},
    };
    this.peakEquity = this.portfolio.cash;

    console.log(`[TradingEngine:${this.exchange}] Created in ${this.mode} mode with $${this.portfolio.cash} budget`);
  }

  // ─── Lifecycle ───────────────────────────────────────────

  async start(sessionId?: string): Promise<void> {
    if (this.state === 'RUNNING') {
      console.warn(`[TradingEngine:${this.exchange}] Already running`);
      return;
    }

    this.sessionId = sessionId || `${this.exchange}-${Date.now()}`;
    this.sessionStartTime = Date.now();
    this.state = 'RUNNING';
    this.dailyPnl = 0;
    this.dailyTradeCount = 0;
    this.consecutiveLosses = 0;

    // Sync real balance if REAL mode
    if (this.mode === 'REAL') {
      try {
        const balance = await this.adapter.getBalance();
        this.portfolio.cash = balance.cashBalance;
        console.log(`[TradingEngine:${this.exchange}] Real balance synced: $${this.portfolio.cash}`);
      } catch (err) {
        console.error(`[TradingEngine:${this.exchange}] Failed to sync balance:`, err);
      }
    }

    // Start bot loop
    this.loopTimer = setInterval(() => this.tick(), this.config.intervalMs);

    tradingBus.emit('session:change', {
      exchange: this.exchange,
      action: 'start',
      mode: this.mode,
      budget: this.portfolio.cash,
      timestamp: Date.now(),
    });

    console.log(`[TradingEngine:${this.exchange}] Started (${this.mode}, interval=${this.config.intervalMs}ms)`);
  }

  async pause(): Promise<void> {
    if (this.state !== 'RUNNING') return;
    this.state = 'PAUSED';
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;

    tradingBus.emit('session:change', {
      exchange: this.exchange,
      action: 'pause',
      mode: this.mode,
      timestamp: Date.now(),
    });

    console.log(`[TradingEngine:${this.exchange}] Paused`);
  }

  async resume(): Promise<void> {
    if (this.state !== 'PAUSED') return;
    this.state = 'RUNNING';
    this.loopTimer = setInterval(() => this.tick(), this.config.intervalMs);

    tradingBus.emit('session:change', {
      exchange: this.exchange,
      action: 'resume',
      mode: this.mode,
      timestamp: Date.now(),
    });

    console.log(`[TradingEngine:${this.exchange}] Resumed`);
  }

  async stop(): Promise<void> {
    this.state = 'IDLE';
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;

    tradingBus.emit('session:change', {
      exchange: this.exchange,
      action: 'stop',
      mode: this.mode,
      timestamp: Date.now(),
    });

    console.log(`[TradingEngine:${this.exchange}] Stopped. Session P&L: $${this.dailyPnl.toFixed(2)}`);
  }

  // ─── Main Bot Loop ───────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.state !== 'RUNNING') return;

    // Check circuit breaker pause
    if (Date.now() < this.pauseUntil) return;

    this.tickCount++;

    try {
      tradingBus.emit('engine:tick', {
        exchange: this.exchange,
        timestamp: Date.now(),
        activePositions: Object.keys(this.portfolio.positions).length,
      });

      // 1. Check exits on existing positions
      await this.checkExits();

      // 2. Check circuit breaker
      if (this.shouldPause()) return;

      // 3. Scan for entry signals (only if capacity available)
      const posCount = Object.keys(this.portfolio.positions).length;
      if (posCount < this.config.maxPositions) {
        await this.scanForEntries();
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TradingEngine:${this.exchange}] Tick error:`, msg);
      tradingBus.emit('engine:error', {
        exchange: this.exchange,
        error: msg,
        timestamp: Date.now(),
      });
    }
  }

  // ─── Exit Management ─────────────────────────────────────

  private async checkExits(): Promise<void> {
    for (const [ticker, position] of Object.entries(this.portfolio.positions)) {
      try {
        // Get current price (from WS or REST fallback)
        const currentPrice = await this.getCurrentPrice(ticker);
        if (!currentPrice) continue;

        // Track highest/lowest for trailing stop
        if (currentPrice > position.highestPrice) {
          position.highestPrice = currentPrice;
        }
        if (currentPrice < position.lowestPrice) {
          position.lowestPrice = currentPrice;
        }

        const pnlPct = ((currentPrice - position.openPrice) / position.openPrice) * 100;
        const holdMs = Date.now() - position.entryTime;
        const holdHours = holdMs / (1000 * 60 * 60);
        const fees = this.config.exchangeConfig.roundTripTaker * 100;

        let exitReason: string | null = null;

        // Stop loss check (fee-adjusted)
        const slThreshold = -3.5; // Base SL from best seed
        if (pnlPct <= slThreshold) {
          exitReason = `Stop-loss hit (${pnlPct.toFixed(2)}%)`;
        }

        // Take profit check (regime-aware — simplified for now)
        const tpThreshold = 12; // Base TP from best seed
        if (pnlPct >= tpThreshold) {
          exitReason = `Take-profit hit (${pnlPct.toFixed(2)}%)`;
        }

        // Trailing stop (activates at 8%, gives back 20% of peak)
        if (pnlPct > 8) {
          const peakPnl = ((position.highestPrice - position.openPrice) / position.openPrice) * 100;
          const giveBack = peakPnl * 0.20;
          if (pnlPct < peakPnl - giveBack) {
            exitReason = `Trailing stop (peak ${peakPnl.toFixed(1)}%, current ${pnlPct.toFixed(1)}%)`;
          }
        }

        // Max hold time (168h = 7 days)
        if (holdHours > 168) {
          exitReason = `Max hold time exceeded (${holdHours.toFixed(0)}h)`;
        }

        // Stale position exit (>24h and losing after fees)
        if (holdHours > 24 && pnlPct < -fees) {
          exitReason = `Stale losing position (${holdHours.toFixed(0)}h, ${pnlPct.toFixed(2)}%)`;
        }

        if (exitReason) {
          await this.executeExit(ticker, position, currentPrice, exitReason);
        }
      } catch (err) {
        console.error(`[TradingEngine:${this.exchange}] Exit check error for ${ticker}:`, err);
      }
    }
  }

  // ─── Entry Scanning ──────────────────────────────────────

  private async scanForEntries(): Promise<void> {
    // Placeholder — will be wired to signal scanner + ML pipeline
    // For now, this is where the integration with existing signalScanner.js
    // and mlPredictionService.js will happen
  }

  // ─── Order Execution ─────────────────────────────────────

  async executeEntry(
    ticker: string,
    price: number,
    usdAmount: number,
    strategy: string,
    confidence: number,
    reason: string,
  ): Promise<boolean> {
    const { exchangeConfig } = this.config;

    // Validate position limits
    const equity = this.getEquity();
    const positionPct = (usdAmount / equity) * 100;
    if (positionPct > this.config.maxPerTickerPct * 100) {
      usdAmount = equity * this.config.maxPerTickerPct;
    }

    // Validate minimum order
    if (usdAmount < exchangeConfig.minOrderUsd) {
      console.log(`[TradingEngine:${this.exchange}] Order too small: $${usdAmount} < $${exchangeConfig.minOrderUsd}`);
      return false;
    }

    const quantity = usdAmount / price;

    if (this.mode === 'SIMULATION') {
      // Simulate fill with slippage
      const slippage = 1 + (0.0002 + Math.random() * 0.0003); // 0.02-0.05% slippage
      const fillPrice = price * slippage;
      const fillQty = usdAmount / fillPrice;
      const feeCost = usdAmount * exchangeConfig.takerFee;

      this.portfolio.cash -= (usdAmount + feeCost);
      this.portfolio.positions[ticker] = {
        ticker,
        quantity: fillQty,
        openPrice: fillPrice,
        entryTime: Date.now(),
        entryStrategy: strategy,
        highestPrice: fillPrice,
        lowestPrice: fillPrice,
        exitStage: 0,
        originalQuantity: fillQty,
      };

      const event: EntryEvent = {
        type: 'BUY',
        exchange: this.exchange,
        ticker,
        price: fillPrice,
        quantity: fillQty,
        usdAmount,
        strategy,
        confidence,
        mode: this.mode,
        timestamp: Date.now(),
        targetPct: 12,
        stopLossPct: -3.5,
        maxHoldHours: 168,
        reason,
      };
      tradingBus.emit('trade:entry', event);
      return true;
    }

    // REAL mode execution
    try {
      const orderType = exchangeConfig.preferLimitOrders ? 'limit' : 'market';
      const result = await this.adapter.placeBuyOrder(ticker, quantity, {
        type: orderType,
        price: orderType === 'limit' ? price * 1.001 : undefined, // Slightly above for limit fills
      });

      this.portfolio.positions[ticker] = {
        ticker,
        quantity: result.filledQuantity,
        openPrice: result.filledPrice,
        entryTime: Date.now(),
        entryStrategy: strategy,
        highestPrice: result.filledPrice,
        lowestPrice: result.filledPrice,
        exitStage: 0,
        originalQuantity: result.filledQuantity,
      };

      // Place exchange-native SL/TP if configured
      if (this.config.useNativeStopLoss && this.adapter.placeStopLoss) {
        const slPrice = result.filledPrice * (1 - 0.035); // -3.5%
        const slResult = await this.adapter.placeStopLoss(ticker, result.filledQuantity, slPrice);
        this.portfolio.positions[ticker].nativeSlOrderId = slResult.orderId;
      }

      if (this.config.useNativeTakeProfit && this.adapter.placeTakeProfit) {
        const tpPrice = result.filledPrice * (1 + 0.12); // +12%
        const tpResult = await this.adapter.placeTakeProfit(ticker, result.filledQuantity, tpPrice);
        this.portfolio.positions[ticker].nativeTpOrderId = tpResult.orderId;
      }

      const event: EntryEvent = {
        type: 'BUY',
        exchange: this.exchange,
        ticker,
        price: result.filledPrice,
        quantity: result.filledQuantity,
        usdAmount: result.filledPrice * result.filledQuantity,
        strategy,
        confidence,
        mode: this.mode,
        timestamp: Date.now(),
        targetPct: 12,
        stopLossPct: -3.5,
        maxHoldHours: 168,
        reason,
      };
      tradingBus.emit('trade:entry', event);
      return true;
    } catch (err) {
      console.error(`[TradingEngine:${this.exchange}] Buy order failed:`, err);
      return false;
    }
  }

  private async executeExit(
    ticker: string,
    position: EnginePosition,
    currentPrice: number,
    reason: string,
  ): Promise<void> {
    const { exchangeConfig } = this.config;
    const pnlPct = ((currentPrice - position.openPrice) / position.openPrice) * 100;
    const pnlUsd = (currentPrice - position.openPrice) * position.quantity;
    const feesUsd = (position.openPrice * position.quantity * exchangeConfig.takerFee) +
                    (currentPrice * position.quantity * exchangeConfig.takerFee);
    const netPnl = pnlUsd - feesUsd;
    const isProfit = netPnl > 0;

    if (this.mode === 'SIMULATION') {
      // Simulate sell
      const slippage = 1 - (0.0002 + Math.random() * 0.0003);
      const fillPrice = currentPrice * slippage;
      const proceeds = fillPrice * position.quantity;
      const fees = proceeds * exchangeConfig.takerFee;

      this.portfolio.cash += (proceeds - fees);
      delete this.portfolio.positions[ticker];
    } else {
      // REAL sell
      try {
        // Cancel exchange-native SL/TP orders first
        if (position.nativeSlOrderId && this.adapter.cancelOrder) {
          await this.adapter.cancelOrder(position.nativeSlOrderId).catch(() => {});
        }
        if (position.nativeTpOrderId && this.adapter.cancelOrder) {
          await this.adapter.cancelOrder(position.nativeTpOrderId).catch(() => {});
        }

        await this.adapter.placeSellOrder(ticker, position.quantity, { type: 'market' });
        delete this.portfolio.positions[ticker];
      } catch (err) {
        console.error(`[TradingEngine:${this.exchange}] Sell order failed for ${ticker}:`, err);
        return;
      }
    }

    // Track performance
    this.dailyPnl += netPnl;
    this.dailyTradeCount++;
    if (isProfit) {
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }

    this.trades.push({
      time: Date.now(),
      pnl: netPnl,
      ticker,
      strategy: position.entryStrategy,
    });

    // Emit exit event
    const event: ExitEvent = {
      type: 'SELL',
      exchange: this.exchange,
      ticker,
      price: currentPrice,
      quantity: position.quantity,
      usdAmount: currentPrice * position.quantity,
      strategy: position.entryStrategy,
      confidence: 0,
      mode: this.mode,
      timestamp: Date.now(),
      entryPrice: position.openPrice,
      pnlPercent: pnlPct,
      pnlUsd,
      feesUsd,
      netPnlUsd: netPnl,
      holdDurationMs: Date.now() - position.entryTime,
      reason,
      isProfit,
    };
    tradingBus.emit('trade:exit', event);
  }

  // ─── Circuit Breaker ─────────────────────────────────────

  private shouldPause(): boolean {
    const equity = this.getEquity();
    const drawdownPct = ((this.peakEquity - equity) / this.peakEquity) * 100;

    // Update peak
    if (equity > this.peakEquity) this.peakEquity = equity;

    // Escalating drawdown response
    if (drawdownPct >= 25) {
      // 25% monthly → switch to simulation
      if (this.mode === 'REAL') {
        console.log(`[TradingEngine:${this.exchange}] CRITICAL: 25% drawdown, switching to SIMULATION`);
        this.mode = 'SIMULATION';
        tradingBus.emit('risk:alert', {
          exchange: this.exchange,
          type: 'circuit_break',
          reason: `25% drawdown — auto-switched to SIMULATION`,
          severity: 'critical',
          timestamp: Date.now(),
        });
      }
      return true;
    }

    if (drawdownPct >= 12) {
      this.pauseUntil = Date.now() + 24 * 60 * 60 * 1000; // 24h pause
      tradingBus.emit('risk:alert', {
        exchange: this.exchange,
        type: 'circuit_break',
        reason: `12% drawdown — paused 24h`,
        severity: 'critical',
        timestamp: Date.now(),
      });
      return true;
    }

    if (drawdownPct >= 8) {
      this.pauseUntil = Date.now() + 60 * 60 * 1000; // 1h pause
      tradingBus.emit('risk:alert', {
        exchange: this.exchange,
        type: 'drawdown_warning',
        reason: `8% drawdown — paused 1h`,
        severity: 'warning',
        timestamp: Date.now(),
      });
      return true;
    }

    // Consecutive losses
    if (this.consecutiveLosses >= 3) {
      this.pauseUntil = Date.now() + 10 * 60 * 1000; // 10min pause
      tradingBus.emit('risk:alert', {
        exchange: this.exchange,
        type: 'circuit_break',
        reason: `${this.consecutiveLosses} consecutive losses — paused 10min`,
        severity: 'warning',
        timestamp: Date.now(),
      });
      this.consecutiveLosses = 0; // Reset after pause
      return true;
    }

    return false;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private async getCurrentPrice(ticker: string): Promise<number | null> {
    // Try WebSocket first, then REST fallback
    try {
      const ws = this.wsService as { getLatestPrice?: (t: string) => number | null };
      if (ws?.getLatestPrice) {
        const wsPrice = ws.getLatestPrice(ticker);
        if (wsPrice && wsPrice > 0) return wsPrice;
      }
    } catch { /* WS unavailable */ }

    // REST fallback
    try {
      const candles = await this.adapter.getCandles(ticker, '1m', 1);
      if (Array.isArray(candles) && candles.length > 0) {
        return (candles[candles.length - 1] as { c: number }).c;
      }
    } catch { /* REST unavailable */ }

    return null;
  }

  getEquity(): number {
    let equity = this.portfolio.cash;
    // In real implementation, sum position mark-to-market values
    // For now, use open price as estimate (will be refined)
    for (const pos of Object.values(this.portfolio.positions)) {
      equity += pos.openPrice * pos.quantity;
    }
    return equity;
  }

  // ─── Public Getters ──────────────────────────────────────

  getState(): EngineState { return this.state; }
  getMode(): EngineMode { return this.mode; }
  getExchange(): ExchangeId { return this.exchange; }
  getPortfolio(): EnginePortfolio { return { ...this.portfolio }; }
  getSessionId(): string | null { return this.sessionId; }
  getTickCount(): number { return this.tickCount; }

  setMode(mode: EngineMode): void {
    this.mode = mode;
    console.log(`[TradingEngine:${this.exchange}] Mode changed to ${mode}`);
  }

  getStatus() {
    const equity = this.getEquity();
    const posCount = Object.keys(this.portfolio.positions).length;
    return {
      exchange: this.exchange,
      state: this.state,
      mode: this.mode,
      sessionId: this.sessionId,
      equity,
      cash: this.portfolio.cash,
      initialBudget: this.portfolio.initialBudget,
      pnlUsd: equity - this.portfolio.initialBudget,
      pnlPct: ((equity - this.portfolio.initialBudget) / this.portfolio.initialBudget) * 100,
      positions: posCount,
      positionDetails: this.portfolio.positions,
      tickCount: this.tickCount,
      dailyPnl: this.dailyPnl,
      dailyTradeCount: this.dailyTradeCount,
      consecutiveLosses: this.consecutiveLosses,
      peakEquity: this.peakEquity,
      drawdownPct: ((this.peakEquity - equity) / this.peakEquity) * 100,
      trades: this.trades.slice(-50), // Last 50 trades
      uptime: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
    };
  }
}

export default TradingEngine;
