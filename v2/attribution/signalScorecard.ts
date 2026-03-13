// ============================================
// Phoenix V2 Signal Scorecard
// Formats signal scores for the dashboard
// ============================================

import { getSignalScores } from './attributionStore.ts';
import { V2_CONFIG } from '../engine/config.ts';

// --- Types ---

export interface ScorecardEntry {
  signalName: string;
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  edge: number;
  verdict: 'proven' | 'inconclusive' | 'negative';
}

// --- Scorecard ---

/**
 * Get signal scores from DB and map each to a ScorecardEntry with a verdict.
 */
export function getScorecard(): ScorecardEntry[] {
  const scores = getSignalScores();

  return scores.map((score) => {
    let verdict: ScorecardEntry['verdict'];

    if (score.totalTrades < V2_CONFIG.MIN_TRADES_FOR_SCORING) {
      verdict = 'inconclusive';
    } else if (score.edge > 0.003 && score.winRate > 0.55) {
      verdict = 'proven';
    } else if (score.edge < -0.002) {
      verdict = 'negative';
    } else {
      verdict = 'inconclusive';
    }

    return {
      signalName: score.signalName,
      totalTrades: score.totalTrades,
      winRate: score.winRate,
      avgPnl: score.avgPnlWhenActive,
      edge: score.edge,
      verdict,
    };
  });
}
