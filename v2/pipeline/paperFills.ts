// ============================================
// Paper-fill realism helpers (shadow / paper modes only)
// ============================================
// Before 2026-09-04 a simulated trade entered at the exact candle close, exited
// a stop at the exact stop price even when the market was already through it,
// and paid no slippage anywhere. That is the most favourable fill on every
// side of every trade, so paper PnL systematically overstated live PnL.
// These helpers make the simulation err the other way — a paper edge that
// survives them has a chance of surviving Kraken.

import { V2_CONFIG } from '../engine/config.ts';

export type Side = 'long' | 'short';

export function paperSlippageFraction(): number {
  const bps = V2_CONFIG.PAPER_SLIPPAGE_BPS;
  return Number.isFinite(bps) && bps > 0 ? bps / 10_000 : 0;
}

/**
 * Move a fill price against the trader by the configured slippage.
 * Buying (long entry, short exit) fills higher; selling (long exit, short
 * entry) fills lower.
 */
export function applyPaperSlippage(price: number, side: Side, leg: 'entry' | 'exit'): number {
  const slip = paperSlippageFraction();
  if (slip === 0 || !Number.isFinite(price) || price <= 0) return price;
  const isBuy = (side === 'long') === (leg === 'entry');
  return isBuy ? price * (1 + slip) : price * (1 - slip);
}

/**
 * Where a stop-market order really fills once the exit loop notices it.
 * The loop polls every 60s, so by the time `currentPrice` is observed the
 * market may be well through the stop; a stop-market on Kraken fills at
 * market, not at the trigger. Book the WORSE of the two, then slip it.
 */
export function paperStopFillPrice(stop: number, currentPrice: number, side: Side): number {
  const raw = side === 'short'
    ? Math.max(stop, currentPrice)
    : Math.min(stop, currentPrice);
  return applyPaperSlippage(raw, side, 'exit');
}
