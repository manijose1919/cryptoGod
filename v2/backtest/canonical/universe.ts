// Candidate ticker universe for cross-strategy backtesting.
// Picked for breadth across:
//   - market-cap tiers (large/mid/small)
//   - sectors (L1, L2, DeFi, meme, infra)
//   - volatility profiles (BTC-stable vs meme-vol)
// All USD pairs (Canadian market compliance).
//
// CryptoCompare coverage verified against histohour endpoint at run time;
// any ticker with < 2000 bars over 90d gets dropped automatically by the
// fitness scorer (insufficient data).

export const CANDIDATE_UNIVERSE: string[] = [
  // Majors
  'BTCUSD', 'ETHUSD',
  // Large alts
  'SOLUSD', 'XRPUSD', 'ADAUSD', 'AVAXUSD', 'LINKUSD', 'DOTUSD', 'LTCUSD', 'BCHUSD',
  // Mid-cap L1/L2
  'ATOMUSD', 'NEARUSD', 'FILUSD', 'ICPUSD', 'HBARUSD', 'ALGOUSD',
  // DeFi
  'AAVEUSD', 'UNIUSD', 'COMPUSD', 'MKRUSD',
  // High-vol / meme / newer
  'DOGEUSD', 'SHIBUSD', 'INJUSD', 'RUNEUSD', 'FETUSD',
];
