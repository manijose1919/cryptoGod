// ============================================
// Phoenix V2 Entry Point
// Boots the V2 engine and exports router + controls
// ============================================

import { initV2Engine, startV2Engine, stopV2Engine, getV2Status } from './engine/tradeEngine.ts';
import { initKrakenAdapter, krakenV2 } from './exchange/krakenAdapter.ts';
import { initCryptoComAdapter, cryptoComV2 } from './exchange/cryptoComV2Adapter.ts';
import { initDualEngine, startDualEngine, stopDualEngine, getDualStatus } from './engine/dualExchangeEngine.ts';
import { initBearishServices, startBearishServices, stopBearishServices, getBearishStatus } from './engine/bearishServices.ts';
import { initMREngine, startMREngine, stopMREngine, getMRStatus } from './engine/meanReversionEngine.ts';
import { initBreakoutEngine, startBreakoutEngine, stopBreakoutEngine, getBreakoutStatus } from './engine/breakoutEngine.ts';
import { initMomentumEngine, startMomentumEngine, stopMomentumEngine, getMomentumStatus } from './engine/momentumEngine.ts';
import { initSniperEngine, startSniperEngine, stopSniperEngine, getSniperStatus } from './engine/sniperEngine.ts';
import { v2Router } from './dashboard/attributionAPI.ts';
import { V2_CONFIG, MR_CONFIG, MOMENTUM_CONFIG, SNIPER_CONFIG } from './engine/config.ts';

export { v2Router, getV2Status, stopV2Engine, getDualStatus, stopDualEngine, getBearishStatus, stopBearishServices, getMRStatus, stopMREngine, getBreakoutStatus, stopBreakoutEngine, getMomentumStatus, stopMomentumEngine, getSniperStatus, stopSniperEngine };

export async function bootV2(initialBudget = 1000): Promise<void> {
  console.log(`[V2] Booting Phoenix V2 in ${V2_CONFIG.MODE} mode...`);
  try {
    await initKrakenAdapter();
    initV2Engine(krakenV2, initialBudget);
    startV2Engine();
    console.log('[V2] Phoenix V2 engine running');

    // Boot bearish services (shorts, staking, arb, DCA) alongside V2
    try {
      initBearishServices(krakenV2);
      startBearishServices();
      console.log('[V2] Bearish services running (shorts, staking, arb, DCA)');
    } catch (err: any) {
      console.warn(`[V2] Bearish services failed to start: ${err.message}`);
    }

    // Boot Mean Reversion engine (15m, maker orders, independent loop)
    if (MR_CONFIG.ENABLED) {
      try {
        initMREngine(krakenV2, initialBudget);
        startMREngine();
        console.log('[V2] Mean Reversion engine running (15m, maker fees)');
      } catch (err: any) {
        console.warn(`[V2] Mean Reversion engine failed to start: ${err.message}`);
      }
    }

    // Breakout engine DISABLED — backtested 180 days: 341 trades, 28% WR, -$33 net
    // Re-enable when strategy is reworked
    console.log('[V2] Breakout engine disabled (unprofitable in backtest)');

    // Momentum engine v2 (rebuilt 2026-05-06)
    // Original (1h, 1.5x histogram-ratio entry, histogram_decay exit):
    //   0% WR over 7 trades — entry math compared macd-hist (price-acceleration)
    //   to abs price-changes (different scales, near-random output).
    // v2 (4h, z-score spike vs 20-bar stdev, higher-highs filter, RSI 50-70,
    //     percent-giveback trail, 3x ATR TP, swing-low stop):
    //   PF 1.70 / 90d, 1.85 / 60d, 1.92 / 30d on
    //   ZECUSD,RUNEUSD,FLOWUSD,ENAUSD,KASUSD,ICPUSD,WIFUSD
    // Default disabled (MOMENTUM_CONFIG.ENABLED=false) — flip to true when
    // ready to ship live. Single-strategy backtest validates before flipping.
    if (MOMENTUM_CONFIG.ENABLED) {
      try {
        initMomentumEngine(krakenV2, initialBudget);
        startMomentumEngine();
        console.log('[V2] Momentum engine v2 running (4h, z-score spike, 7 tickers)');
      } catch (err: unknown) {
        console.warn(`[V2] Momentum engine failed to start: ${(err as Error).message}`);
      }
    } else {
      console.log('[V2] Momentum engine v2 disabled (MOMENTUM_CONFIG.ENABLED=false). Set true to ship live.');
    }

    // Sniper engine (new-coin sniper, 2026-05-06)
    // SIDE PROJECT — fully isolated stats. Trades tagged strategy='SNIPER'.
    // Reports must NEVER aggregate sniper P&L with TREND/MOMENTUM (see CHANGELOG).
    // Cannot be backtested (by definition new data) — paper-only at first.
    if (SNIPER_CONFIG.ENABLED) {
      try {
        await initSniperEngine(krakenV2);
        startSniperEngine();
        console.log(`[V2] Sniper engine running (15m, $${SNIPER_CONFIG.BUDGET_USD} isolated budget, paper mode)`);
      } catch (err: unknown) {
        console.warn(`[V2] Sniper engine failed to start: ${(err as Error).message}`);
      }
    } else {
      console.log('[V2] Sniper engine disabled (SNIPER_CONFIG.ENABLED=false).');
    }
  } catch (err: any) {
    console.error(`[V2] Boot failed: ${err.message}`);
  }
}

/**
 * Boot the dual-exchange competition engine.
 * Runs Kraken vs Crypto.com in paper mode with identical TC signals.
 */
export async function bootDualEngine(): Promise<void> {
  console.log('[DUAL] Booting Kraken vs Crypto.com competition...');
  try {
    // Initialize both exchange adapters
    await Promise.all([
      initKrakenAdapter(),
      initCryptoComAdapter(),
    ]);

    initDualEngine(krakenV2, cryptoComV2);
    startDualEngine();
    console.log('[DUAL] Competition engine running (paper mode)');
  } catch (err: any) {
    console.error(`[DUAL] Boot failed: ${err.message}`);
  }
}
