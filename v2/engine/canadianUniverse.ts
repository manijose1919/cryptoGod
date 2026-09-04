// Canadian-legal Kraken spot universe for the daytrading engine.
// CSA/CIRO accounts cannot trade USDT/USDC pairs; Kraken is the execution
// venue. BNB is in the historical "allowed bases" list but is not listed on
// Kraken, so it is omitted here.

export const CANADIAN_DAYTRADE_BASES = [
  'BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK', 'DOT', 'AVAX',
] as const;

export type CanadianDaytradeBase = typeof CANADIAN_DAYTRADE_BASES[number];

export const CANADIAN_DAYTRADE_TICKERS: readonly string[] =
  CANADIAN_DAYTRADE_BASES.map((base) => `${base}USD`);

/**
 * True only for `<BASE>USD` where BASE is in the Canadian Kraken daytrade set.
 * `BTCUSDT` / `ETHUSDC` fail even though they end with the letters "USD".
 */
export function isCanadianUsdPair(ticker: string): boolean {
  if (typeof ticker !== 'string' || ticker.length < 6) return false;
  if (ticker.endsWith('USDT') || ticker.endsWith('USDC')) return false;
  if (!ticker.endsWith('USD')) return false;
  const base = ticker.slice(0, -3);
  return (CANADIAN_DAYTRADE_BASES as readonly string[]).includes(base);
}

export function assertCanadianUniverse(tickers: readonly string[]): void {
  for (const ticker of tickers) {
    if (!isCanadianUsdPair(ticker)) {
      throw new Error(`Ticker ${ticker} is not a Canadian-legal Kraken USD pair`);
    }
  }
}
