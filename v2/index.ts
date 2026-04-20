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
import { v2Router } from './dashboard/attributionAPI.ts';
import { V2_CONFIG, MR_CONFIG } from './engine/config.ts';

export { v2Router, getV2Status, stopV2Engine, getDualStatus, stopDualEngine, getBearishStatus, stopBearishServices, getMRStatus, stopMREngine, getBreakoutStatus, stopBreakoutEngine, getMomentumStatus, stopMomentumEngine };

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

    // Boot Momentum engine (1h, histogram decay exit)
    try {
      initMomentumEngine(krakenV2, initialBudget);
      startMomentumEngine();
      console.log('[V2] Momentum engine running (1h, maker fees)');
    } catch (err: any) {
      console.warn(`[V2] Momentum engine failed to start: ${err.message}`);
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
