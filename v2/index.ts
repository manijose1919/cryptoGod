// ============================================
// Phoenix V2 Entry Point
// Boots the V2 engine and exports router + controls
// ============================================

import { initV2Engine, startV2Engine, stopV2Engine, getV2Status } from './engine/tradeEngine.ts';
import { initKrakenAdapter, krakenV2 } from './exchange/krakenAdapter.ts';
import { v2Router } from './dashboard/attributionAPI.ts';
import { V2_CONFIG } from './engine/config.ts';

export { v2Router, getV2Status, stopV2Engine };

export async function bootV2(initialBudget = 1000): Promise<void> {
  console.log(`[V2] Booting Phoenix V2 in ${V2_CONFIG.MODE} mode...`);
  try {
    await initKrakenAdapter();
    initV2Engine(krakenV2, initialBudget);
    startV2Engine();
    console.log('[V2] Phoenix V2 engine running');
  } catch (err: any) {
    console.error(`[V2] Boot failed: ${err.message}`);
  }
}
