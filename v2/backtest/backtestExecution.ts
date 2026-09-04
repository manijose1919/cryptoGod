import type { Candle } from '../pipeline/types.ts';
import { applyPaperSlippage, type TradeSide } from '../engine/tradeAccounting.ts';

export function getNextBarEntryPrice(
  candles: Candle[],
  signalBar: number,
  side: TradeSide,
  slippagePerSide: number,
): number | null {
  const nextBar = candles[signalBar + 1];
  if (!nextBar) return null;
  return applyPaperSlippage(nextBar.open, side, 'entry', slippagePerSide);
}
