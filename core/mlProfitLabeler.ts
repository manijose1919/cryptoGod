/**
 * ML Profit Labeler — Retrain ML on profitability, not direction.
 *
 * Old labels: WIN (price up) / LOSS (price down)
 * New labels: BIG_WIN (+3%+), SMALL_WIN (0-3%), BREAK_EVEN (-0.5% to 0%), LOSS (<-0.5%), BIG_LOSS (<-3%)
 *
 * This module relabels existing training data and provides the new labeling
 * function for future trades.
 */

// ─── Label Tiers ─────────────────────────────────────────────

export enum ProfitLabel {
  BIG_WIN = 2,       // PnL > +3% after fees
  SMALL_WIN = 1,     // PnL 0% to +3%
  BREAK_EVEN = 0,    // PnL -0.5% to 0%
  LOSS = -1,         // PnL < -0.5%
  BIG_LOSS = -2,     // PnL < -3%
}

export const LABEL_NAMES: Record<number, string> = {
  [ProfitLabel.BIG_WIN]: 'BIG_WIN',
  [ProfitLabel.SMALL_WIN]: 'SMALL_WIN',
  [ProfitLabel.BREAK_EVEN]: 'BREAK_EVEN',
  [ProfitLabel.LOSS]: 'LOSS',
  [ProfitLabel.BIG_LOSS]: 'BIG_LOSS',
};

// ─── Fee-Adjusted Thresholds ─────────────────────────────────

interface FeeConfig {
  roundTripPct: number; // Round-trip fee as decimal (e.g., 0.0052 for Kraken)
  slippagePct: number;  // Estimated slippage as decimal (e.g., 0.001)
}

const FEE_CONFIGS: Record<string, FeeConfig> = {
  kraken: { roundTripPct: 0.0052, slippagePct: 0.001 },
  'crypto.com': { roundTripPct: 0.0015, slippagePct: 0.0005 },
};

// ─── Labeling Functions ──────────────────────────────────────

/**
 * Label a trade based on fee-adjusted PnL percentage.
 * This is the NEW labeling function that replaces the old WIN/LOSS binary.
 */
export function labelTrade(
  pnlPct: number,
  exchange: string = 'kraken',
): ProfitLabel {
  const fees = FEE_CONFIGS[exchange] || FEE_CONFIGS.kraken;
  const netPnlPct = pnlPct - (fees.roundTripPct * 100) - (fees.slippagePct * 100);

  if (netPnlPct > 3.0) return ProfitLabel.BIG_WIN;
  if (netPnlPct > 0.0) return ProfitLabel.SMALL_WIN;
  if (netPnlPct > -0.5) return ProfitLabel.BREAK_EVEN;
  if (netPnlPct > -3.0) return ProfitLabel.LOSS;
  return ProfitLabel.BIG_LOSS;
}

/**
 * Convert old WIN/LOSS label to new profitability label.
 * Requires the original PnL percentage (stored in training data).
 */
export function relabelFromPnl(
  oldLabel: string,
  pnlPct: number | null,
  exchange: string = 'kraken',
): ProfitLabel {
  // If we have actual PnL, use it directly
  if (pnlPct !== null && pnlPct !== undefined) {
    return labelTrade(pnlPct, exchange);
  }

  // Fallback: convert old binary labels
  // This is lossy — we don't know the magnitude
  if (oldLabel === 'WIN' || oldLabel === '1') return ProfitLabel.SMALL_WIN;
  if (oldLabel === 'LOSS' || oldLabel === '0') return ProfitLabel.LOSS;
  return ProfitLabel.BREAK_EVEN;
}

/**
 * For ML training: convert label to numeric target.
 * For classification: use as-is (5-class).
 * For regression: use the numeric value directly.
 */
export function labelToNumeric(label: ProfitLabel): number {
  return label; // Already numeric: -2, -1, 0, 1, 2
}

/**
 * For binary classification compatibility: is this a "profitable" trade?
 * Useful for the existing RF/GBT ensemble that expects binary labels.
 */
export function labelToBinary(label: ProfitLabel): number {
  return label >= ProfitLabel.SMALL_WIN ? 1 : 0;
}

/**
 * For risk-adjusted ML: weight labels by magnitude.
 * BIG_WIN trades are more valuable to predict correctly than BREAK_EVEN.
 */
export function getLabelWeight(label: ProfitLabel): number {
  switch (label) {
    case ProfitLabel.BIG_WIN: return 3.0;    // Most valuable to predict
    case ProfitLabel.SMALL_WIN: return 1.5;
    case ProfitLabel.BREAK_EVEN: return 0.5; // Least important
    case ProfitLabel.LOSS: return 1.5;
    case ProfitLabel.BIG_LOSS: return 3.0;   // Most important to avoid
    default: return 1.0;
  }
}

// ─── Batch Relabeling ────────────────────────────────────────

export interface TrainingSample {
  id: number;
  features: number[];
  label: string;        // Old label: 'WIN' or 'LOSS'
  pnlPct?: number;      // Original PnL if available
  exchange?: string;
}

export interface RelabeledSample {
  id: number;
  features: number[];
  profitLabel: ProfitLabel;
  binaryLabel: number;  // For backwards compatibility
  weight: number;
  exchange: string;
}

/**
 * Relabel an entire batch of training samples.
 * Used during the ML V2 migration to convert existing 5,121 samples.
 */
export function relabelBatch(
  samples: TrainingSample[],
  defaultExchange: string = 'kraken',
): RelabeledSample[] {
  const results: RelabeledSample[] = [];
  const stats = { BIG_WIN: 0, SMALL_WIN: 0, BREAK_EVEN: 0, LOSS: 0, BIG_LOSS: 0 };

  for (const sample of samples) {
    const exchange = sample.exchange || defaultExchange;
    const profitLabel = relabelFromPnl(sample.label, sample.pnlPct ?? null, exchange);
    const labelName = LABEL_NAMES[profitLabel] as keyof typeof stats;
    stats[labelName]++;

    results.push({
      id: sample.id,
      features: sample.features,
      profitLabel,
      binaryLabel: labelToBinary(profitLabel),
      weight: getLabelWeight(profitLabel),
      exchange,
    });
  }

  console.log('[MLProfitLabeler] Relabeled', samples.length, 'samples:', stats);
  return results;
}

export default {
  labelTrade,
  relabelFromPnl,
  labelToNumeric,
  labelToBinary,
  getLabelWeight,
  relabelBatch,
  ProfitLabel,
  LABEL_NAMES,
};
