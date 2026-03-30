// ============================================
// Phoenix V2 Entry Point
// Boots the V2 engine and exports router + controls
// ============================================

import { initV2Engine, startV2Engine, stopV2Engine, getV2Status } from './engine/tradeEngine.ts';
import { initKrakenAdapter, krakenV2 } from './exchange/krakenAdapter.ts';
import { initCryptoComAdapter, cryptoComV2 } from './exchange/cryptoComV2Adapter.ts';
import { initDualEngine, startDualEngine, stopDualEngine, getDualStatus } from './engine/dualExchangeEngine.ts';
import { initBearishServices, startBearishServices, stopBearishServices, getBearishStatus } from './engine/bearishServices.ts';
import { v2Router } from './dashboard/attributionAPI.ts';
import { V2_CONFIG } from './engine/config.ts';

export { v2Router, getV2Status, stopV2Engine, getDualStatus, stopDualEngine, getBearishStatus, stopBearishServices };

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
