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

  // Track active trading tickers so we don't stake assets we're trading
  private activeTradingAssets: Set<string> = new Set();

  setActiveTradingAssets(assets: string[]): void {
    this.activeTradingAssets = new Set(assets);
  }

  /**
   * Evaluate staking opportunities for all idle assets.
   * Auto-stakes assets not needed for trading. Tracks rewards in simulation.
   */
  async evaluate(): Promise<void> {
    if (!this.enabled) return;

    // Update reward accrual for existing staked positions
    this.accrueRewards();

    for (const [exchangeId, adapter] of this.adapters) {
      try {
        const balance = await (adapter as { getBalance: () => Promise<{ holdings: Record<string, { quantity: number; usdValue?: number }> }> }).getBalance();
        const holdings = balance.holdings || {};

        for (const [asset, holding] of Object.entries(holdings)) {
          const product = STAKING_PRODUCTS.find(
            p => p.exchange === exchangeId && p.asset === asset && p.active
          );
          if (!product) continue;

          // Don't stake if below minimum
          if (holding.quantity < product.minStake) continue;

          // Don't stake if asset is in an active trading position
          const ticker = `${asset}USD`;
          if (this.activeTradingAssets.has(ticker)) continue;

          // Don't double-stake — check if we already have a position for this asset
          const existingStake = this.stakedPositions.find(
            p => p.exchange === exchangeId && p.asset === asset && p.status === 'staking'
          );
          if (existingStake) continue;

          // Stake up to 80% of idle holdings (keep 20% for liquidity)
          const stakeAmount = holding.quantity * 0.80;
          if (stakeAmount < product.minStake) continue;

          // Calculate estimated annual reward
          const annualReward = stakeAmount * (product.apy / 100);

          // Execute staking — try real API first, fall back to simulation tracking
          let staked = false;
          try {
            const adapterAny = adapter as Record<string, unknown>;
            if (typeof adapterAny.stakeAsset === 'function') {
              // Real staking via exchange API
              await adapterAny.stakeAsset(asset, stakeAmount);
              staked = true;
              console.log(
                `[StakingEngine] STAKED ${stakeAmount.toFixed(4)} ${asset} on ${exchangeId}`,
                `at ${product.apy}% APY = ~${annualReward.toFixed(4)} ${asset}/year`
              );
            }
          } catch (err) {
            console.warn(`[StakingEngine] Real stake failed for ${asset} on ${exchangeId}: ${(err as Error).message}`);
          }

          // Track position regardless (sim tracking for P&L)
          const posId = `${exchangeId}:${asset}:${Date.now()}`;
          this.stakedPositions.push({
            id: posId,
            exchange: exchangeId as 'kraken' | 'crypto.com',
            asset,
            quantity: stakeAmount,
            stakedAt: Date.now(),
            apy: product.apy,
            lockUntil: product.lockPeriod > 0 ? Date.now() + product.lockPeriod * 86400000 : 0,
            earnedReward: 0,
            status: 'staking',
          });

          console.log(
            `[StakingEngine] ${staked ? 'REAL' : 'SIM'} stake: ${stakeAmount.toFixed(4)} ${asset} on ${exchangeId}`,
            `@ ${product.apy}% APY = ~${annualReward.toFixed(4)} ${asset}/year`,
            `(total staked positions: ${this.stakedPositions.length})`
          );

          tradingBus.emit('ml:event', {
            type: 'prediction',
            exchange: exchangeId as 'kraken' | 'crypto.com',
            data: {
              subtype: 'staking_executed',
              asset,
              quantity: stakeAmount,
              apy: product.apy,
              annualReward,
              realExecution: staked,
            },
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[StakingEngine] Error evaluating ${exchangeId}:`, err);
      }
    }
  }

  /**
   * Accrue rewards on all staked positions based on elapsed time and APY.
   */
  private accrueRewards(): void {
    const now = Date.now();
    for (const pos of this.stakedPositions) {
      if (pos.status !== 'staking') continue;
      // Calculate reward since last check (hourly interval)
      const hoursElapsed = Math.min(1.0, (now - pos.stakedAt) / (1000 * 60 * 60));
      const hourlyRate = pos.apy / 100 / 8760; // APY to hourly
      const reward = pos.quantity * hourlyRate * hoursElapsed;
      pos.earnedReward += reward;
    }
  }

  /**
   * Unstake an asset when capital is needed for trading.
   */
  async unstake(exchange: string, asset: string): Promise<boolean> {
    const pos = this.stakedPositions.find(
      p => p.exchange === exchange && p.asset === asset && p.status === 'staking'
    );
    if (!pos) return false;

    // Check lock period
    if (pos.lockUntil > 0 && Date.now() < pos.lockUntil) {
      console.log(`[StakingEngine] Cannot unstake ${asset} on ${exchange} — locked until ${new Date(pos.lockUntil).toISOString()}`);
      return false;
    }

    pos.status = 'unstaking';

    // Try real unstaking
    try {
      const adapter = this.adapters.get(exchange) as Record<string, unknown> | undefined;
      if (adapter && typeof adapter.unstakeAsset === 'function') {
        await adapter.unstakeAsset(asset, pos.quantity);
        console.log(`[StakingEngine] UNSTAKED ${pos.quantity.toFixed(4)} ${asset} on ${exchange} (earned: ${pos.earnedReward.toFixed(6)} ${asset})`);
      }
    } catch (err) {
      console.warn(`[StakingEngine] Real unstake failed: ${(err as Error).message}`);
    }

    // Remove from active positions
    const idx = this.stakedPositions.indexOf(pos);
    if (idx >= 0) this.stakedPositions.splice(idx, 1);
    return true;
  }

  private isAssetInTradingPosition(_exchange: string, asset: string): boolean {
    return this.activeTradingAssets.has(`${asset}USD`);
  }

  // ─── Getters ─────────────────────────────────────────────

  getProducts(): StakingProduct[] {
    return STAKING_PRODUCTS.filter(p => p.active);
  }

  getStakedPositions(): StakedPosition[] {
    return [...this.stakedPositions];
  }

  getStatus() {
    const totalEarned = this.stakedPositions.reduce((sum, p) => sum + p.earnedReward, 0);
    const positionDetails = this.stakedPositions.map(p => ({
      asset: p.asset,
      exchange: p.exchange,
      quantity: p.quantity,
      apy: p.apy,
      earnedReward: p.earnedReward,
      stakedHours: ((Date.now() - p.stakedAt) / 3600000).toFixed(1),
      status: p.status,
    }));

    return {
      enabled: this.enabled,
      products: STAKING_PRODUCTS.filter(p => p.active).length,
      stakedPositions: this.stakedPositions.length,
      totalEarnedRewards: totalEarned,
      positions: positionDetails,
      estimatedDailyReward: this.stakedPositions.reduce(
        (sum, p) => sum + (p.quantity * p.apy / 100 / 365), 0
      ),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const stakingEngine = new StakingEngine();
export default stakingEngine;
