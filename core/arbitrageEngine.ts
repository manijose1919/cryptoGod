/**
 * ArbitrageEngine — Cross-exchange arbitrage detection and execution.
 *
 * **DISABLED (2026-05-04, H10).** This engine is shipped as a no-op.
 * Three high-severity issues identified in audit:
 *   1. Phantom signals: getPrice synthesizes bid/ask as price ± 0.025% instead
 *      of fetching real top-of-book; can fire on a 0.4% spread that's actually
 *      zero or negative when measured from real bid/ask.
 *   2. No leg-failure rollback: scan/execute uses Promise.all on the two legs
 *      — if buy fills and sell rejects, you're left with an unhedged position
 *      and no closing trade.
 *   3. setCommonTickers is never called, so the engine was scanning [] and
 *      effectively idle in production already.
 *
 * Re-enabling requires:
 *   - Real-orderbook bid/ask via adapter.getOrderBook(ticker, 1).
 *   - Promise.allSettled with partial-fill detection + immediate market-close
 *     of the lone successful leg + a critical risk:alert.
 *   - A wired setCommonTickers caller.
 * Until then, start() is a no-op and the engine emits no opportunities.
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
  private enabled = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opportunities: ArbOpportunity[] = [];
  private maxOpportunityAge = 30000; // 30 seconds max
  private simTradeSize = 200; // $200 per simulated arb

  // Adapters for execution
  private adapters: Map<string, unknown> = new Map();
  // WebSocket services for real-time prices
  private wsServices: Map<string, unknown> = new Map();

  // Tracked tickers (must be available on BOTH exchanges)
  private commonTickers: string[] = [];

  // Execution tracking
  private executedArbs: Array<{
    ticker: string;
    buyExchange: string;
    sellExchange: string;
    profitPct: number;
    profitUsd: number;
    timestamp: number;
    simulated: boolean;
  }> = [];
  private totalArbProfitUsd = 0;
  private maxConcurrentArbs = 3;
  private activeArbs = 0;
  private arbCooldownMs = 30000; // 30s cooldown per ticker after execution
  private lastArbTime: Map<string, number> = new Map();

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
    // H10: engine disabled. See file-header comment for the issues + the
    // re-enable checklist. start() is a no-op so callers don't need to be
    // touched, and the existing scan/execute code remains in the file as
    // a reference implementation for the eventual rewrite.
    console.log('[ArbitrageEngine] DISABLED — see file header for re-enable checklist');
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
  // `protected`, not `private`, deliberately: the engine is a no-op (H10) so
  // nothing calls this, but it is retained as the reference implementation for
  // the eventual rewrite. `private` would make tsc flag it as unused and invite
  // someone to delete it.
  protected async scan(): Promise<void> {
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
        const spread1 = krakenPrice.ask > 0 ? (cryptoComPrice.bid - krakenPrice.ask) / krakenPrice.ask : 0;
        // Arb 2: Buy Crypto.com, Sell Kraken
        const spread2 = cryptoComPrice.ask > 0 ? (krakenPrice.bid - cryptoComPrice.ask) / cryptoComPrice.ask : 0;

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
              estimatedProfitUsd: profitPct * this.simTradeSize,
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
              estimatedProfitUsd: profitPct * this.simTradeSize,
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

    // Execute (simulated) arb trade if conditions met
    this.executeArb(opp);

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

  /**
   * Execute an arbitrage trade (simulated with P&L tracking).
   * Real execution requires both exchange adapters active with funds on each.
   */
  private async executeArb(opp: ArbOpportunity): Promise<void> {
    // Throttle: max concurrent arbs, cooldown per ticker
    if (this.activeArbs >= this.maxConcurrentArbs) return;
    const lastTime = this.lastArbTime.get(opp.ticker) || 0;
    if (Date.now() - lastTime < this.arbCooldownMs) return;

    // Only execute if profit exceeds 0.1% after fees (high-confidence only)
    if (opp.estimatedProfitPct < 0.1) return;

    this.activeArbs++;
    try {
    this.lastArbTime.set(opp.ticker, Date.now());

    const tradeSize = this.simTradeSize;
    const profitUsd = tradeSize * (opp.estimatedProfitPct / 100);

    // Try real execution if both adapters are available
    let realExecution = false;
    const buyAdapter = this.adapters.get(opp.buyExchange) as Record<string, unknown> | undefined;
    const sellAdapter = this.adapters.get(opp.sellExchange) as Record<string, unknown> | undefined;

    if (buyAdapter && sellAdapter && typeof buyAdapter.placeBuyOrder === 'function' && typeof sellAdapter.placeSellOrder === 'function') {
      try {
        // Simultaneous buy+sell for true arb
        const qty = tradeSize / opp.buyPrice;
        const [buyResult, sellResult] = await Promise.all([
          (buyAdapter.placeBuyOrder as (t: string, n: number, s?: string) => Promise<unknown>)(opp.ticker, tradeSize),
          (sellAdapter.placeSellOrder as (t: string, q: number, s?: string) => Promise<unknown>)(opp.ticker, qty),
        ]);
        if (buyResult && sellResult) {
          realExecution = true;
          console.log(`[ArbitrageEngine] REAL ARB EXECUTED: ${opp.ticker} buy@${opp.buyExchange} sell@${opp.sellExchange} profit=$${profitUsd.toFixed(2)}`);
        }
      } catch (err) {
        console.warn(`[ArbitrageEngine] Real execution failed: ${(err as Error).message}`);
      }
    }

    // Track as simulated if real execution wasn't possible
    this.executedArbs.push({
      ticker: opp.ticker,
      buyExchange: opp.buyExchange,
      sellExchange: opp.sellExchange,
      profitPct: opp.estimatedProfitPct,
      profitUsd,
      timestamp: Date.now(),
      simulated: !realExecution,
    });
    this.totalArbProfitUsd += profitUsd;
    // Cap executedArbs to prevent unbounded memory growth
    if (this.executedArbs.length > 1000) {
      this.executedArbs = this.executedArbs.slice(-1000);
    }

    if (!realExecution) {
      console.log(`[ArbitrageEngine] SIM ARB: ${opp.ticker} spread=${opp.spreadPct.toFixed(3)}% profit=$${profitUsd.toFixed(2)} (total: $${this.totalArbProfitUsd.toFixed(2)})`);
    }

    tradingBus.emit('ml:event', {
      type: 'prediction',
      exchange: opp.buyExchange,
      data: {
        subtype: 'arb_executed',
        ticker: opp.ticker,
        profitUsd,
        profitPct: opp.estimatedProfitPct,
        real: realExecution,
      },
      timestamp: Date.now(),
    });

    } finally {
      this.activeArbs--;
    }
  }

  // ─── Getters ─────────────────────────────────────────────

  getOpportunities(): ArbOpportunity[] {
    return this.opportunities.filter(o => Date.now() - o.timestamp < this.maxOpportunityAge);
  }

  getStatus() {
    const recent = this.getOpportunities();
    const last24h = this.executedArbs.filter(a => Date.now() - a.timestamp < 86400000);
    return {
      enabled: this.enabled,
      commonTickers: this.commonTickers.length,
      recentOpportunities: recent.length,
      bestSpread: recent.length > 0 ? Math.max(...recent.map(o => o.spreadPct)) : 0,
      avgProfit: recent.length > 0 ? recent.reduce((s, o) => s + o.estimatedProfitPct, 0) / recent.length : 0,
      totalExecuted: this.executedArbs.length,
      totalProfitUsd: this.totalArbProfitUsd,
      last24hTrades: last24h.length,
      last24hProfitUsd: last24h.reduce((s, a) => s + a.profitUsd, 0),
      recentTrades: this.executedArbs.slice(-10).map(a => ({
        ticker: a.ticker,
        profit: `$${a.profitUsd.toFixed(2)}`,
        spread: `${a.profitPct.toFixed(3)}%`,
        simulated: a.simulated,
        time: new Date(a.timestamp).toISOString(),
      })),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const arbitrageEngine = new ArbitrageEngine();
export default arbitrageEngine;
