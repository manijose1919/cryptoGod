// Pairs trading monitor. Background interval task that:
//   - Polls Kraken margin level every 60s
//   - Recomputes ADF on full rolling window every 6 hours
//   - Detects open-position drift (engine thinks we're flat but exchange shows
//     a margin position, or vice versa)
//
// All findings flow through the alert dispatcher.

import { PAIRS_CONFIG } from '../engine/config.ts';
import { getOpenPairsTrade } from './schema.ts';
import { testCointegration } from './statsImpl.ts';
import type { PairsLiveState } from './cointegration.ts';

let _adapter: any = null;
async function getAdapter(): Promise<any> {
  if (!_adapter) {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    _adapter = mod.krakenAdapter;
  }
  return _adapter;
}

const SESSION_ID = 'pairs-monitor-v1';

// Thresholds — kept small so any one isn't a kill switch by itself; combinations
// are. The engine's loop-level kill switches handle within-trade risk.
const MIN_SAFE_MARGIN_LEVEL = 150;       // < this = warning; engine should consider closing
const CRITICAL_MARGIN_LEVEL = 110;       // < this = imminent liquidation; force-close immediately
const MAX_ADF_T_BEFORE_DEGRADE = -2.0;   // weaker than this = cointegration breaking
const ADF_RECHECK_HOURS = 6;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastAdfCheckMs = 0;

export interface MonitorEvent {
  kind: 'margin_low' | 'margin_critical' | 'adf_degraded' | 'state_drift' | 'ok';
  message: string;
  data?: Record<string, unknown>;
}

type AlertHandler = (e: MonitorEvent) => void;

let alertHandler: AlertHandler = (e) => {
  if (e.kind === 'ok') return;
  console.warn(`[PAIRS-MONITOR] ${e.kind}: ${e.message}`);
};

export function setAlertHandler(h: AlertHandler): void {
  alertHandler = h;
}

export async function checkMarginLevel(): Promise<MonitorEvent> {
  const adapter = await getAdapter();
  try {
    const ml = await adapter.getMarginLevel?.(SESSION_ID);
    if (ml === null || ml === undefined) {
      return { kind: 'ok', message: 'margin level unavailable (no positions yet)' };
    }
    if (ml < CRITICAL_MARGIN_LEVEL) {
      return {
        kind: 'margin_critical',
        message: `margin level ${ml}% < ${CRITICAL_MARGIN_LEVEL}% — imminent liquidation`,
        data: { marginLevel: ml },
      };
    }
    if (ml < MIN_SAFE_MARGIN_LEVEL) {
      return {
        kind: 'margin_low',
        message: `margin level ${ml}% < ${MIN_SAFE_MARGIN_LEVEL}% — reduce risk`,
        data: { marginLevel: ml },
      };
    }
    return { kind: 'ok', message: `margin OK (${ml}%)`, data: { marginLevel: ml } };
  } catch (err) {
    return { kind: 'ok', message: `margin check error: ${(err as Error).message}` };
  }
}

export async function checkAdfDrift(
  cointState: PairsLiveState | null,
  logA: number[],
  logB: number[],
): Promise<MonitorEvent> {
  if (!cointState || logA.length < 200) {
    return { kind: 'ok', message: 'insufficient data for adf check' };
  }
  const stats = testCointegration(logA.slice(-720), logB.slice(-720));
  if (stats.adfTStat > MAX_ADF_T_BEFORE_DEGRADE) {
    return {
      kind: 'adf_degraded',
      message: `cointegration weakening: ADF t=${stats.adfTStat.toFixed(2)} > ${MAX_ADF_T_BEFORE_DEGRADE}`,
      data: { adfTStat: stats.adfTStat, halflife: stats.halflife },
    };
  }
  return { kind: 'ok', message: `cointegration healthy (adf=${stats.adfTStat.toFixed(2)})` };
}

export async function checkPositionDrift(): Promise<MonitorEvent> {
  if (PAIRS_CONFIG.MODE !== 'live') {
    return { kind: 'ok', message: 'paper mode — no exchange position to check' };
  }
  try {
    const adapter = await getAdapter();
    const positions = await adapter.getOpenMarginPositions?.(SESSION_ID);
    const exchangeHasPosition = positions && Object.keys(positions).length > 0;
    const dbTrade = getOpenPairsTrade(PAIRS_CONFIG.SYMBOL_A, PAIRS_CONFIG.SYMBOL_B);
    const dbHasPosition = !!dbTrade;

    if (exchangeHasPosition !== dbHasPosition) {
      return {
        kind: 'state_drift',
        message: `state drift: exchange=${exchangeHasPosition} db=${dbHasPosition}`,
        data: { exchangePositions: positions, dbTrade: dbTrade?.id ?? null },
      };
    }
    return { kind: 'ok', message: 'position state in sync' };
  } catch (err) {
    return { kind: 'ok', message: `position check error: ${(err as Error).message}` };
  }
}

export function startMonitor(getCointState: () => PairsLiveState | null, getLogs: () => { a: number[]; b: number[] }): void {
  if (monitorTimer) return;
  monitorTimer = setInterval(async () => {
    try {
      // Always check margin (cheap).
      const m = await checkMarginLevel();
      alertHandler(m);

      // ADF check less frequently.
      if (Date.now() - lastAdfCheckMs >= ADF_RECHECK_HOURS * 3600 * 1000) {
        const { a, b } = getLogs();
        const e = await checkAdfDrift(getCointState(), a, b);
        alertHandler(e);
        lastAdfCheckMs = Date.now();
      }

      // Position drift (only meaningful in live mode).
      const d = await checkPositionDrift();
      alertHandler(d);
    } catch (err) {
      console.error('[PAIRS-MONITOR] error:', err);
    }
  }, 60_000);
  console.log('[PAIRS-MONITOR] started');
}

export function stopMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    console.log('[PAIRS-MONITOR] stopped');
  }
}
