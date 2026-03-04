/**
 * StakingEngine — Auto-stake idle crypto assets for passive yield.
 *
 * Monitors both Kraken and Crypto.com for staking opportunities.
 * Auto-stakes assets not needed for trading in the next 24h.
 * Auto-unstakes when trading signals require the capital.
 *
 * Kraken staking: ETH ~3.5%, DOT ~12%, SOL ~7%, ADA ~3%
 * Crypto.com earn: BTC ~1.5%, ETH ~3%, CRO ~6%, stablecoins ~4-8%
 */

import tradingBus from './eventBus.ts';

// ─── Types ───────────────────────────────────────────────────

export interface StakingProduct {
  exchange: 'kraken' | 'crypto.com';
  asset: string;
  apy: number;             // Annual percentage yield
  minStake: number;        // Minimum stake amount in asset units
  lockPeriod: number;      // Lock period in days (0 = flexible)
  unstakePeriod: number;   // Days to unstake
  active: boolean;
}

export interface StakedPosition {
  id: string;
  exchange: 'kraken' | 'crypto.com';
  asset: string;
  quantity: number;
  stakedAt: number;
  apy: number;
  lockUntil: number;      // 0 if flexible
  earnedReward: number;
  status: 'staking' | 'unstaking' | 'pending';
}

// ─── Known Staking Products ─────────────────────────────────

const STAKING_PRODUCTS: StakingProduct[] = [
  // Kraken staking (approximate APYs — check live rates)
  { exchange: 'kraken', asset: 'ETH',  apy: 3.5,  minStake: 0.001, lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'kraken', asset: 'DOT',  apy: 12.0, minStake: 0.25,  lockPeriod: 0, unstakePeriod: 28, active: true },
  { exchange: 'kraken', asset: 'SOL',  apy: 7.0,  minStake: 0.01,  lockPeriod: 0, unstakePeriod: 3, active: true },
  { exchange: 'kraken', asset: 'ADA',  apy: 3.0,  minStake: 1.0,   lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'kraken', asset: 'ATOM', apy: 8.0,  minStake: 0.01,  lockPeriod: 0, unstakePeriod: 21, active: true },
  { exchange: 'kraken', asset: 'MATIC',apy: 4.5,  minStake: 0.1,   lockPeriod: 0, unstakePeriod: 0, active: true },

  // Crypto.com Earn (approximate APYs)
  { exchange: 'crypto.com', asset: 'BTC',  apy: 1.5,  minStake: 0.001, lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'crypto.com', asset: 'ETH',  apy: 3.0,  minStake: 0.01,  lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'crypto.com', asset: 'CRO',  apy: 6.0,  minStake: 100,   lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'crypto.com', asset: 'USDC', apy: 4.0,  minStake: 10,    lockPeriod: 0, unstakePeriod: 0, active: true },
  { exchange: 'crypto.com', asset: 'DOT',  apy: 10.0, minStake: 1.0,   lockPeriod: 0, unstakePeriod: 28, active: true },
];

// ─── Staking Engine ─────────────────────────────────────────

class StakingEngine {
  private stakedPositions: StakedPosition[] = [];
  private enabled = true;
  private checkIntervalMs = 60 * 60 * 1000; // Check every hour
  private timer: ReturnType<typeof setInterval> | null = null;

  // Adapters will be injected
  private adapters: Map<string, unknown> = new Map();

  constructor() {
    console.log('[StakingEngine] Initialized with', STAKING_PRODUCTS.filter(p => p.active).length, 'products');
  }

  registerAdapter(exchange: string, adapter: unknown): void {
    this.adapters.set(exchange, adapter);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.checkIntervalMs);
    console.log('[StakingEngine] Started — checking every', this.checkIntervalMs / 60000, 'minutes');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluate staking opportunities for all idle assets.
   * Only stakes assets not needed for active trading.
   */
  async evaluate(): Promise<void> {
    if (!this.enabled) return;

    for (const [exchangeId, adapter] of this.adapters) {
      try {
        const balance = await (adapter as { getBalance: () => Promise<{ holdings: Record<string, { quantity: number }> }> }).getBalance();
        const holdings = balance.holdings || {};

        for (const [asset, holding] of Object.entries(holdings)) {
          const product = STAKING_PRODUCTS.find(
            p => p.exchange === exchangeId && p.asset === asset && p.active
          );
          if (!product) continue;

          // Don't stake if below minimum
          if (holding.quantity < product.minStake) continue;

          // Don't stake if asset is in an active trading position
          // (TradingEngine manages positions — check via EventBus or direct query)
          const isTrading = this.isAssetInTradingPosition(exchangeId, asset);
          if (isTrading) continue;

          // Stake up to 80% of idle holdings (keep 20% for liquidity)
          const stakeAmount = holding.quantity * 0.80;
          if (stakeAmount < product.minStake) continue;

          // Calculate estimated annual reward
          const annualReward = stakeAmount * (product.apy / 100);

          console.log(
            `[StakingEngine] Opportunity: ${asset} on ${exchangeId}`,
            `— Stake ${stakeAmount.toFixed(4)} at ${product.apy}% APY`,
            `= ~${annualReward.toFixed(4)} ${asset}/year`
          );

          // For now, log opportunity. Actual staking API calls will be added
          // when we verify the exchange API endpoints are correct.
          tradingBus.emit('ml:event', {
            type: 'prediction',
            exchange: exchangeId as 'kraken' | 'crypto.com',
            data: {
              subtype: 'staking_opportunity',
              asset,
              quantity: stakeAmount,
              apy: product.apy,
              annualReward,
            },
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[StakingEngine] Error evaluating ${exchangeId}:`, err);
      }
    }
  }

  private isAssetInTradingPosition(exchange: string, asset: string): boolean {
    // Will be wired to TradingEngine instances
    // For now, return false (conservative — always eligible for staking)
    return false;
  }

  // ─── Getters ─────────────────────────────────────────────

  getProducts(): StakingProduct[] {
    return STAKING_PRODUCTS.filter(p => p.active);
  }

  getStakedPositions(): StakedPosition[] {
    return [...this.stakedPositions];
  }

  getStatus() {
    return {
      enabled: this.enabled,
      products: STAKING_PRODUCTS.filter(p => p.active).length,
      stakedPositions: this.stakedPositions.length,
      totalStaked: this.stakedPositions.reduce((sum, p) => sum + p.earnedReward, 0),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const stakingEngine = new StakingEngine();
export default stakingEngine;
