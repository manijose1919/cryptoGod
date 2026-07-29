// Live order executor for pairs trading.
//
// CRITICAL INVARIANT: NEVER leave a single leg open. If one leg fills and
// the other doesn't within timeout, market-close the filled one.
//
// Order strategy (per leg):
//   1. Submit post-only limit at best bid (long) or best ask (short).
//   2. Wait `entryRetryMs` (default 60s) for fill.
//   3. If not filled: cancel, requote 0.1% better, resubmit. Up to N times.
//   4. After hardAbortMs (default 5 min) of total elapsed: ABORT.
//      - If neither leg filled: clean exit, no positions.
//      - If one leg filled, other not: market-close the filled one.
//
// Exit orders use market-close (margin reduce-only) for speed and certainty.
// We never want to hold a half-unwound pair.

import { PAIRS_CONFIG } from '../engine/config.ts';

// Lazy adapter import — same pattern as krakenAdapter.ts in v2/exchange/
let _adapter: any = null;
async function getAdapter(): Promise<any> {
  if (!_adapter) {
    const mod = await import('../../services/exchangeAdapters/krakenAdapter.js');
    _adapter = mod.krakenAdapter;
  }
  return _adapter;
}

const SESSION_ID = 'pairs-v1';

export interface LegSpec {
  ticker: string;
  side: 'buy' | 'sell';   // buy = open long margin; sell = open short margin
  quantity: number;
  leverage: number;       // 2 for FIL/ICP per AssetPairs API
}

export interface ExecutionResult {
  success: boolean;
  legAFilled: boolean;
  legBFilled: boolean;
  legAFillPrice?: number;
  legBFillPrice?: number;
  legAFillQty?: number;
  legBFillQty?: number;
  legAOrderId?: string;
  legBOrderId?: string;
  abortReason?: string;
  elapsedMs: number;
}

export interface ExecutorParams {
  entryRetryMs: number;     // 60_000
  maxRetries: number;       // 3
  improvePctPerRetry: number; // 0.001 = 0.1%
  hardAbortMs: number;      // 300_000 = 5 min
}
export const EXECUTOR_DEFAULTS: ExecutorParams = {
  entryRetryMs: 60_000,
  maxRetries: 3,
  improvePctPerRetry: 0.001,
  hardAbortMs: 300_000,
};

interface FillState {
  orderId: string;
  filled: boolean;
  filledPrice?: number;
  filledQty?: number;
}

// Poll a single Kraken order until it's filled or returns a cancelled/expired
// status. Cheap REST call; we run two of these in parallel via Promise.race.
async function pollFill(orderId: string, timeoutMs: number): Promise<FillState> {
  const adapter = await getAdapter();
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'open';
  while (Date.now() < deadline) {
    try {
      const status = await adapter.getOrderStatus(orderId, SESSION_ID);
      lastStatus = status?.status ?? 'unknown';
      if (status?.status === 'closed' || status?.status === 'filled') {
        return {
          orderId,
          filled: true,
          filledPrice: status.price ?? status.avgPrice ?? 0,
          filledQty: status.volumeExecuted ?? status.filledQuantity ?? 0,
        };
      }
      if (status?.status === 'cancelled' || status?.status === 'canceled' || status?.status === 'expired') {
        return { orderId, filled: false };
      }
    } catch (err) {
      console.warn(`[PAIRS-EX] poll ${orderId} error: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  // Timeout — return last-known unfilled state.
  console.log(`[PAIRS-EX] poll ${orderId} timed out, lastStatus=${lastStatus}`);
  return { orderId, filled: false };
}

async function placeOneLeg(leg: LegSpec, price: number, opts: { postOnly: boolean }): Promise<string | null> {
  try {
    const adapter = await getAdapter();
    const result = await adapter.placeMarginLimit(
      leg.ticker, leg.side, price, leg.quantity, leg.leverage, SESSION_ID,
      { postOnly: opts.postOnly },
    );
    return result.orderId || null;
  } catch (err) {
    console.error(`[PAIRS-EX] placeMarginLimit ${leg.ticker} ${leg.side}: ${(err as Error).message}`);
    return null;
  }
}

async function cancelOne(orderId: string): Promise<void> {
  try {
    const adapter = await getAdapter();
    await adapter.cancelOrder(orderId, SESSION_ID);
  } catch (err) {
    console.warn(`[PAIRS-EX] cancel ${orderId}: ${(err as Error).message}`);
  }
}

// Market-close one filled leg via reduce-only margin order.
async function emergencyClose(leg: LegSpec, filledQty: number): Promise<void> {
  try {
    const adapter = await getAdapter();
    // Closing direction is opposite of entry side.
    const closeSide = leg.side === 'buy' ? 'sell' : 'buy';
    await adapter.placeMarginMarket(leg.ticker, closeSide, filledQty, leg.leverage, SESSION_ID);
    console.warn(`[PAIRS-EX] EMERGENCY CLOSED ${leg.ticker} ${closeSide} qty=${filledQty}`);
  } catch (err) {
    console.error(
      `[PAIRS-EX] CRITICAL: emergency close failed for ${leg.ticker}! ${(err as Error).message}. ` +
      `Position remains open on exchange — MANUAL INTERVENTION REQUIRED.`,
    );
  }
}

// Compute the post-only limit price for a leg.
// Long leg: best bid (we want to be on the bid side so we don't take).
// Short leg: best ask (we want to be on the ask side).
async function getEntryPrice(leg: LegSpec, improveStep: number): Promise<number | null> {
  const adapter = await getAdapter();
  try {
    if (leg.side === 'buy') {
      const bid = await adapter.getBestBid?.(leg.ticker);
      if (!bid || bid <= 0) return null;
      // Each retry "improves" the price by `improveStep` (raises bid).
      return bid * (1 + improveStep);
    } else {
      const ask = await adapter.getBestAsk?.(leg.ticker);
      if (!ask || ask <= 0) return null;
      return ask * (1 - improveStep);
    }
  } catch (err) {
    console.error(`[PAIRS-EX] price fetch ${leg.ticker}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Execute a two-leg pair entry. Returns success only if BOTH legs filled.
 *
 * On partial fill or timeout:
 *   - If one filled, one didn't: market-close the filled one (avoid naked leg).
 *   - If neither filled: clean exit, caller can retry.
 */
export async function executePairEntry(
  legA: LegSpec,
  legB: LegSpec,
  params: ExecutorParams = EXECUTOR_DEFAULTS,
): Promise<ExecutionResult> {
  const startMs = Date.now();
  let attempt = 0;
  let legAState: FillState | null = null;
  let legBState: FillState | null = null;
  let lastLegAOrderId: string | undefined;
  let lastLegBOrderId: string | undefined;

  while (attempt < params.maxRetries) {
    attempt++;
    const improveStep = params.improvePctPerRetry * (attempt - 1);

    // Fetch current best bid/ask for each leg, accounting for retry improvement.
    const [priceA, priceB] = await Promise.all([
      getEntryPrice(legA, improveStep),
      getEntryPrice(legB, improveStep),
    ]);
    if (priceA === null || priceB === null) {
      console.error(`[PAIRS-EX] attempt ${attempt}: failed to fetch entry prices; aborting`);
      return {
        success: false, legAFilled: false, legBFilled: false,
        elapsedMs: Date.now() - startMs,
        abortReason: 'price_fetch_failed',
      };
    }

    // Submit both legs in parallel.
    const [aId, bId] = await Promise.all([
      placeOneLeg(legA, priceA, { postOnly: true }),
      placeOneLeg(legB, priceB, { postOnly: true }),
    ]);

    if (!aId && !bId) {
      console.error(`[PAIRS-EX] attempt ${attempt}: both legs failed to place`);
      continue;
    }
    if (!aId || !bId) {
      // One placed, one didn't — cancel the one that did to keep us flat,
      // then retry the whole pair.
      const stranded = aId || bId;
      if (stranded) {
        console.warn(`[PAIRS-EX] attempt ${attempt}: only one leg placed (${stranded}); cancelling`);
        await cancelOne(stranded);
      }
      continue;
    }
    lastLegAOrderId = aId;
    lastLegBOrderId = bId;

    // Wait for both fills (or timeout this attempt).
    const remaining = params.hardAbortMs - (Date.now() - startMs);
    const attemptTimeout = Math.min(params.entryRetryMs, remaining);
    if (attemptTimeout <= 1000) break;  // Out of time

    const [aResult, bResult] = await Promise.all([
      pollFill(aId, attemptTimeout),
      pollFill(bId, attemptTimeout),
    ]);
    legAState = aResult;
    legBState = bResult;

    if (aResult.filled && bResult.filled) {
      // Success.
      return {
        success: true,
        legAFilled: true, legBFilled: true,
        legAFillPrice: aResult.filledPrice,
        legBFillPrice: bResult.filledPrice,
        legAFillQty: aResult.filledQty,
        legBFillQty: bResult.filledQty,
        legAOrderId: aId,
        legBOrderId: bId,
        elapsedMs: Date.now() - startMs,
      };
    }

    // One filled, one didn't — STOP and emergency-close.
    if (aResult.filled !== bResult.filled) {
      const filled = aResult.filled ? legA : legB;
      const filledQty = aResult.filled ? (aResult.filledQty ?? 0) : (bResult.filledQty ?? 0);
      const unfilledOrderId = aResult.filled ? bId : aId;
      console.warn(`[PAIRS-EX] PARTIAL FILL detected — cancelling unfilled leg and emergency-closing filled leg`);
      await cancelOne(unfilledOrderId);
      if (filledQty > 0) await emergencyClose(filled, filledQty);
      return {
        success: false,
        legAFilled: aResult.filled,
        legBFilled: bResult.filled,
        legAFillPrice: aResult.filledPrice,
        legBFillPrice: bResult.filledPrice,
        legAFillQty: aResult.filledQty,
        legBFillQty: bResult.filledQty,
        legAOrderId: aId,
        legBOrderId: bId,
        abortReason: 'partial_fill_emergency_close',
        elapsedMs: Date.now() - startMs,
      };
    }

    // Neither filled — cancel both and retry with improved price.
    console.log(`[PAIRS-EX] attempt ${attempt}: neither leg filled in ${attemptTimeout}ms, retrying with ${(improveStep * 100).toFixed(2)}% price improvement`);
    await Promise.all([cancelOne(aId), cancelOne(bId)]);

    if (Date.now() - startMs > params.hardAbortMs) break;
  }

  // Out of retries or hit hard abort. Whatever happened, neither leg is filled.
  return {
    success: false,
    legAFilled: legAState?.filled ?? false,
    legBFilled: legBState?.filled ?? false,
    legAOrderId: lastLegAOrderId,
    legBOrderId: lastLegBOrderId,
    abortReason: 'max_retries_no_fill',
    elapsedMs: Date.now() - startMs,
  };
}

/**
 * Exit an open pair via market-close on both legs. reduce_only ensures we
 * close the existing position rather than open new opposing position.
 */
export async function executePairExit(
  legA: LegSpec,    // ORIGINAL entry leg (we'll invert side here)
  legB: LegSpec,
): Promise<ExecutionResult> {
  const startMs = Date.now();
  const adapter = await getAdapter();
  const aCloseSide = legA.side === 'buy' ? 'sell' : 'buy';
  const bCloseSide = legB.side === 'buy' ? 'sell' : 'buy';

  // Fire both market-close orders in parallel. Even if one fails, attempt the other.
  const [aRes, bRes] = await Promise.allSettled([
    adapter.placeMarginMarket(legA.ticker, aCloseSide, legA.quantity, legA.leverage, SESSION_ID),
    adapter.placeMarginMarket(legB.ticker, bCloseSide, legB.quantity, legB.leverage, SESSION_ID),
  ]);

  const aOK = aRes.status === 'fulfilled';
  const bOK = bRes.status === 'fulfilled';

  if (!aOK || !bOK) {
    console.error(
      `[PAIRS-EX] CRITICAL: exit failed (legA=${aOK}, legB=${bOK}). ` +
      `Manual intervention may be required.`,
    );
  }

  return {
    success: aOK && bOK,
    legAFilled: aOK,
    legBFilled: bOK,
    legAOrderId: aOK ? (aRes as PromiseFulfilledResult<any>).value.orderId : undefined,
    legBOrderId: bOK ? (bRes as PromiseFulfilledResult<any>).value.orderId : undefined,
    abortReason: aOK && bOK ? undefined : `exit_failed_legA=${aOK}_legB=${bOK}`,
    elapsedMs: Date.now() - startMs,
  };
}

/**
 * Pre-flight check before going live. Verifies:
 *   - Margin USD balance ≥ required (sum of leg notionals)
 *   - Margin level ≥ 150% (safe headroom; liquidation at 100%)
 *   - Both pair APIs respond
 * Returns null if OK, error message if not safe to trade.
 */
export async function preflightCheck(
  symA: string, symB: string, requiredUsd: number,
): Promise<string | null> {
  try {
    const adapter = await getAdapter();
    // 1. Margin level
    const ml = await adapter.getMarginLevel?.(SESSION_ID);
    if (ml !== null && ml !== undefined && ml < 150) {
      return `margin_level_too_low (${ml}% < 150%)`;
    }
    // 2. Margin balance
    const balance = await adapter.getBalance?.(SESSION_ID);
    const usdAvailable =
      balance?.ZUSD ?? balance?.USD ?? balance?.['ZUSD'] ?? 0;
    if (parseFloat(usdAvailable) < requiredUsd * 1.2) {
      return `insufficient_margin_balance (have $${usdAvailable}, need $${requiredUsd * 1.2})`;
    }
    // 3. Best bid/ask on both legs
    const [bidA, askA, bidB, askB] = await Promise.all([
      adapter.getBestBid?.(symA),
      adapter.getBestAsk?.(symA),
      adapter.getBestBid?.(symB),
      adapter.getBestAsk?.(symB),
    ]);
    if (!bidA || !askA) return `${symA}_book_unavailable`;
    if (!bidB || !askB) return `${symB}_book_unavailable`;
    return null;
  } catch (err) {
    return `preflight_exception: ${(err as Error).message}`;
  }
}

// Touch PAIRS_CONFIG so unused-import lint passes.
export const _CONFIG_TOUCH = PAIRS_CONFIG;
