// ============================================
// Kraken Pro fee tiers (cross-platform schedule effective 2026-07-09)
// ============================================
// Source: https://support.kraken.com/ca/articles/cross-platform-fee-tier-changes
//
// Before 2026-07-09 the engine assumed 0.16% maker / 0.26% taker. Under the
// current schedule a fresh account (< $2.5K 30-day spot volume, no assets on
// platform) pays 0.40% / 0.80% — 2.5-3x more. Every fee-derived gate in the
// engine (MIN_EXPECTED_RETURN, trailing-activation floor, paper PnL) reads
// fees through getExchangeFees(), so keeping this table current is what makes
// those gates mean anything.
//
// The tier is the BEST of: 30-day spot volume, or current assets on platform
// (AoP). Futures volume is irrelevant here. Tiers 1-2 have no AoP path.
//
// No imports from config.ts or the DB — this module must stay dependency-free
// so config.ts can import it without a cycle. tradeEngine feeds it the rolling
// 30-day notional via setKrakenVolume30d() once per loop.

export interface FeeTable {
  TAKER_PERCENT: number;
  MAKER_PERCENT: number;
  ROUND_TRIP_TAKER: number;
  ROUND_TRIP_MAKER: number;
  /** maker entry + taker exit — how the engine actually trades (see config.ts) */
  ROUND_TRIP_REAL: number;
}

interface KrakenTier {
  tier: number;
  minVolume30dUsd: number;
  /** Infinity = no AoP path to this tier */
  minAopUsd: number;
  maker: number;
  taker: number;
}

export const KRAKEN_FEE_TIERS: readonly KrakenTier[] = [
  { tier: 1,  minVolume30dUsd: 0,          minAopUsd: Infinity,   maker: 0.0040, taker: 0.0080 },
  { tier: 2,  minVolume30dUsd: 2_500,      minAopUsd: Infinity,   maker: 0.0030, taker: 0.0060 },
  { tier: 3,  minVolume30dUsd: 10_000,     minAopUsd: 20_000,     maker: 0.0022, taker: 0.0038 },
  { tier: 4,  minVolume30dUsd: 25_000,     minAopUsd: 50_000,     maker: 0.0020, taker: 0.0035 },
  { tier: 5,  minVolume30dUsd: 50_000,     minAopUsd: 100_000,    maker: 0.0015, taker: 0.0030 },
  { tier: 6,  minVolume30dUsd: 100_000,    minAopUsd: 200_000,    maker: 0.0012, taker: 0.0025 },
  { tier: 7,  minVolume30dUsd: 250_000,    minAopUsd: 400_000,    maker: 0.0010, taker: 0.0022 },
  { tier: 8,  minVolume30dUsd: 500_000,    minAopUsd: 600_000,    maker: 0.0008, taker: 0.0020 },
  { tier: 9,  minVolume30dUsd: 1_000_000,  minAopUsd: 1_000_000,  maker: 0.0006, taker: 0.0018 },
  { tier: 10, minVolume30dUsd: 2_500_000,  minAopUsd: 2_500_000,  maker: 0.0004, taker: 0.0015 },
  { tier: 11, minVolume30dUsd: 5_000_000,  minAopUsd: 5_000_000,  maker: 0.0002, taker: 0.0012 },
  { tier: 12, minVolume30dUsd: 10_000_000, minAopUsd: 10_000_000, maker: 0.0000, taker: 0.0010 },
];

export function feesForTier(tier: number): FeeTable {
  const row = KRAKEN_FEE_TIERS.find(t => t.tier === tier) ?? KRAKEN_FEE_TIERS[0];
  return {
    TAKER_PERCENT: row.taker,
    MAKER_PERCENT: row.maker,
    ROUND_TRIP_TAKER: row.taker * 2,
    ROUND_TRIP_MAKER: row.maker * 2,
    ROUND_TRIP_REAL: row.maker + row.taker,
  };
}

/** Highest tier reachable by either 30-day volume or assets on platform. */
export function resolveKrakenTier(volume30dUsd: number, aopUsd: number): number {
  let best = 1;
  for (const t of KRAKEN_FEE_TIERS) {
    if (volume30dUsd >= t.minVolume30dUsd || aopUsd >= t.minAopUsd) best = t.tier;
  }
  return best;
}

export interface KrakenFeeState {
  tier: number;
  volume30dUsd: number;
  aopUsd: number;
  /** 'env-tier' = KRAKEN_FEE_TIER pinned it; 'computed' = from volume/AoP */
  source: 'env-tier' | 'computed';
  fees: FeeTable;
}

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// KRAKEN_AOP_USD: what the account actually holds on Kraken (crypto + fiat +
// staked). A $20K balance is Tier 3 regardless of trading volume.
// KRAKEN_FEE_TIER: pin a tier outright (testing, or a known live account).
let _volume30dUsd = 0;
let _state: KrakenFeeState = computeState();

function computeState(): KrakenFeeState {
  const aopUsd = envNumber('KRAKEN_AOP_USD') ?? 0;
  const pinned = envNumber('KRAKEN_FEE_TIER');
  if (pinned != null && pinned >= 1 && pinned <= 12) {
    return { tier: pinned, volume30dUsd: _volume30dUsd, aopUsd, source: 'env-tier', fees: feesForTier(pinned) };
  }
  const tier = resolveKrakenTier(_volume30dUsd, aopUsd);
  return { tier, volume30dUsd: _volume30dUsd, aopUsd, source: 'computed', fees: feesForTier(tier) };
}

/**
 * Feed the rolling 30-day traded notional (entries + exits, USD). Returns the
 * new state so the caller can log a tier change.
 */
export function setKrakenVolume30d(volumeUsd: number): KrakenFeeState {
  _volume30dUsd = Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0;
  _state = computeState();
  return _state;
}

export function getKrakenFeeState(): KrakenFeeState {
  return _state;
}

export function getKrakenFees(): FeeTable {
  return _state.fees;
}
