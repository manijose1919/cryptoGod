export type TradeSide = 'long' | 'short';
export type FillPhase = 'entry' | 'exit';

export function applyPaperSlippage(
  price: number,
  side: TradeSide,
  phase: FillPhase,
  slippagePerSide: number,
): number {
  const isBuy = (side === 'long' && phase === 'entry')
    || (side === 'short' && phase === 'exit');
  return price * (isBuy ? 1 + slippagePerSide : 1 - slippagePerSide);
}

export function calculateRealizedPnl(
  side: TradeSide,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  feesPaid: number,
): { pnlGross: number; pnlNet: number } {
  const direction = side === 'long' ? 1 : -1;
  const pnlGross = (exitPrice - entryPrice) * quantity * direction;
  return { pnlGross, pnlNet: pnlGross - feesPaid };
}

export function getGapAwareStopFill(
  side: TradeSide,
  stopPrice: number,
  observedPrice: number,
): number {
  return side === 'long'
    ? Math.min(stopPrice, observedPrice)
    : Math.max(stopPrice, observedPrice);
}
