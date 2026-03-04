/**
 * ArbitrageEngine — Cross-exchange arbitrage detection and execution.
 *
 * Monitors price differences between Kraken and Crypto.com.
 * When spread exceeds combined fees (>0.40%), executes simultaneous trades.
 * Buy on cheaper exchange, sell on expensive exchange.
 */

import tradingBus from './eventBus.ts';

// ─── Types ───────────────────────────────────────────────────

export interface ArbOpportunity {
  ticker: string;
  buyExchange: 'kraken' | 'crypto.com';
  sellExchange: 'kraken' | 'crypto.com';
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  estimatedProfitPct: number;  // After fees
  estimatedProfitUsd: number;
  timestamp: number;
}

interface PriceSnapshot {
  ticker: string;
  exchange: 'kraken' | 'crypto.com';
  price: number;
  bid: number;
  ask: number;
  timestamp: number;
}

// ─── Fee Constants ───────────────────────────────────────────

const FEES = {
  kraken: { taker: 0.0026, maker: 0.0016 },
  'crypto.com': { taker: 0.00075, maker: 0.00050 },
};

// Minimum spread to be profitable (both sides' fees + slippage buffer)
const MIN_PROFITABLE_SPREAD = 0.004; // 0.40%
const SLIPPAGE_BUFFER = 0.001; // 0.10% slippage per side

// ─── Arbitrage Engine ────────────────────────────────────────

class ArbitrageEngine {
  private prices: Map<string, Map<string, PriceSnapshot>> = new Map(); // ticker → exchange → snapshot
  private enabled = true;
  private scanIntervalMs = 2000; // Check every 2 seconds
  private timer: ReturnType<typeof setInterval> | null = null;
  private opportunities: ArbOpportunity[] = [];
  private maxOpportunityAge = 30000; // 30 seconds max
  private minTradeUsd = 20; // Minimum $20 per arb trade

  // Adapters for execution
  private adapters: Map<string, unknown> = new Map();
  // WebSocket services for real-time prices
  private wsServices: Map<string, unknown> = new Map();

  // Tracked tickers (must be available on BOTH exchanges)
  private commonTickers: string[] = [];

  constructor() {
    console.log('[ArbitrageEngine] Initialized');
  }

  registerAdapter(exchange: string, adapter: unknown): void {
    this.adapters.set(exchange, adapter);
  }

  registerWsService(exchange: string, ws: unknown): void {
    this.wsServices.set(exchange, ws);
  }

  setCommonTickers(tickers: string[]): void {
    this.commonTickers = tickers;
    console.log(`[ArbitrageEngine] Monitoring ${tickers.length} common tickers`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.scanIntervalMs);
    console.log('[ArbitrageEngine] Started — scanning every', this.scanIntervalMs, 'ms');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scan for arbitrage opportunities across exchanges.
   */
  private async scan(): Promise<void> {
    if (!this.enabled || this.commonTickers.length === 0) return;

    for (const ticker of this.commonTickers) {
      try {
        // Get prices from both exchanges (prefer WebSocket for speed)
        const krakenPrice = this.getPrice('kraken', ticker);
        const cryptoComPrice = this.getPrice('crypto.com', ticker);

        if (!krakenPrice || !cryptoComPrice) continue;

        // Calculate spread
        // Buy at ask (higher), sell at bid (lower)
        // Arb 1: Buy Kraken, Sell Crypto.com
        const spread1 = (cryptoComPrice.bid - krakenPrice.ask) / krakenPrice.ask;
        // Arb 2: Buy Crypto.com, Sell Kraken
        const spread2 = (krakenPrice.bid - cryptoComPrice.ask) / cryptoComPrice.ask;

        const totalFees1 = FEES.kraken.taker + FEES['crypto.com'].taker + SLIPPAGE_BUFFER * 2;
        const totalFees2 = FEES['crypto.com'].taker + FEES.kraken.taker + SLIPPAGE_BUFFER * 2;

        if (spread1 > MIN_PROFITABLE_SPREAD) {
          const profitPct = spread1 - totalFees1;
          if (profitPct > 0) {
            this.recordOpportunity({
              ticker,
              buyExchange: 'kraken',
              sellExchange: 'crypto.com',
              buyPrice: krakenPrice.ask,
              sellPrice: cryptoComPrice.bid,
              spreadPct: spread1 * 100,
              estimatedProfitPct: profitPct * 100,
              estimatedProfitUsd: profitPct * this.minTradeUsd,
              timestamp: Date.now(),
            });
          }
        }

        if (spread2 > MIN_PROFITABLE_SPREAD) {
          const profitPct = spread2 - totalFees2;
          if (profitPct > 0) {
            this.recordOpportunity({
              ticker,
              buyExchange: 'crypto.com',
              sellExchange: 'kraken',
              buyPrice: cryptoComPrice.ask,
              sellPrice: krakenPrice.bid,
              spreadPct: spread2 * 100,
              estimatedProfitPct: profitPct * 100,
              estimatedProfitUsd: profitPct * this.minTradeUsd,
              timestamp: Date.now(),
            });
          }
        }
      } catch {
        // Silent fail — arb scanning should never crash
      }
    }

    // Clean old opportunities
    this.opportunities = this.opportunities.filter(
      o => Date.now() - o.timestamp < this.maxOpportunityAge
    );
  }

  private getPrice(exchange: string, ticker: string): PriceSnapshot | null {
    // Try WebSocket service first
    const ws = this.wsServices.get(exchange) as { getLatestPrice?: (t: string) => number } | undefined;
    if (ws?.getLatestPrice) {
      const price = ws.getLatestPrice(ticker);
      if (price && price > 0) {
        // Estimate bid/ask from last price (rough — proper order book would be better)
        const spread = exchange === 'kraken' ? 0.0005 : 0.0003; // Typical spreads
        return {
          ticker,
          exchange: exchange as 'kraken' | 'crypto.com',
          price,
          bid: price * (1 - spread / 2),
          ask: price * (1 + spread / 2),
          timestamp: Date.now(),
        };
      }
    }
    return null;
  }

  private recordOpportunity(opp: ArbOpportunity): void {
    this.opportunities.push(opp);

    console.log(
      `[ArbitrageEngine] Opportunity: ${opp.ticker}`,
      `Buy ${opp.buyExchange} @ $${opp.buyPrice.toFixed(2)}`,
      `Sell ${opp.sellExchange} @ $${opp.sellPrice.toFixed(2)}`,
      `Spread: ${opp.spreadPct.toFixed(3)}%`,
      `Profit: ${opp.estimatedProfitPct.toFixed(3)}%`
    );

    // Emit as signal for TradingEngine or Telegram
    tradingBus.emit('signal:detected', {
      exchange: opp.buyExchange,
      ticker: opp.ticker,
      strategy: 'ARBITRAGE',
      score: opp.estimatedProfitPct * 10, // Scale to 0-100
      confidence: Math.min(opp.estimatedProfitPct / 0.5, 1), // Confidence based on profit %
      regime: 'ARBITRAGE',
      timestamp: opp.timestamp,
    });
  }

  // ─── Getters ─────────────────────────────────────────────

  getOpportunities(): ArbOpportunity[] {
    return this.opportunities.filter(o => Date.now() - o.timestamp < this.maxOpportunityAge);
  }

  getStatus() {
    const recent = this.getOpportunities();
    return {
      enabled: this.enabled,
      commonTickers: this.commonTickers.length,
      recentOpportunities: recent.length,
      bestSpread: recent.length > 0 ? Math.max(...recent.map(o => o.spreadPct)) : 0,
      avgProfit: recent.length > 0 ? recent.reduce((s, o) => s + o.estimatedProfitPct, 0) / recent.length : 0,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const arbitrageEngine = new ArbitrageEngine();
export default arbitrageEngine;
