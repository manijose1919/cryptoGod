// ============================================
// Monitor dashboard payload builder (pure).
// No I/O — takes live + DB data, returns the display shape.
// ============================================
import type { V2Trade } from '../pipeline/types.ts';
import type { V2EngineStatus } from '../engine/tradeEngine.ts';

const STALE_MS = 5 * 60_000;      // engine considered stale if no loop in 5 min
const RECENT_CLOSED_LIMIT = 25;

export interface MonitorDeps {
  status: V2EngineStatus;
  openTrades: V2Trade[];         // ALL strategies — drives open table + open count
  cohortClosedTrend: V2Trade[];  // TREND only, entry_time >= baseline — drives KPIs + equity curve
  recentClosedAll: V2Trade[];    // ALL strategies, entry_time >= baseline — drives closed table
  baselineTs: number;
  baselineMissing: boolean;
  now: number;
}

export interface MonitorSummary {
  asOf: number;
  status: {
    mode: string;
    isRunning: boolean;
    stale: boolean;
    lastLoopAt: number;
    regime: string;
  };
  account: { balance: number; openPositionsCount: number };
  cohort: {
    baselineTs: number;
    baselineMissing: boolean;
    winRate: number | null;
    netPnl: number;
    tradeCount: number;
    avgR: number | null;
  };
  equityCurve: { t: number; cumPnl: number }[];
  openPositions: {
    ticker: string; strategy: string; side: string;
    entry: number; positionSizeUsd: number; stop: number;
    target: number; heldMs: number;
  }[];
  recentClosed: {
    ticker: string; strategy: string; entry: number; exit: number | null;
    pnlNet: number; outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
    reason: string | null; exitTs: number | null;
  }[];
}

function outcomeOf(pnlNet: number): 'WIN' | 'LOSS' | 'BREAKEVEN' {
  if (pnlNet > 0) return 'WIN';
  if (pnlNet < 0) return 'LOSS';
  return 'BREAKEVEN';
}

export function buildMonitorSummary(deps: MonitorDeps): MonitorSummary {
  const { status, openTrades, cohortClosedTrend, recentClosedAll, baselineTs, baselineMissing, now } = deps;

  const regime =
    (status.htfRegimes && (status.htfRegimes['BTCUSD'] ?? Object.values(status.htfRegimes)[0])) ||
    'UNKNOWN';

  // Cohort stats — TREND only
  const tradeCount = cohortClosedTrend.length;
  const netPnl = cohortClosedTrend.reduce((s, t) => s + (t.pnlNet ?? 0), 0);
  const wins = cohortClosedTrend.filter(t => (t.pnlNet ?? 0) > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : null;

  // avg R = mean of pnlNet / risk, over trades with positive risk
  const rValues = cohortClosedTrend
    .map(t => {
      const risk = Math.abs((t.entryPrice ?? 0) - (t.initialStop ?? 0)) * (t.quantity ?? 0);
      return risk > 0 ? (t.pnlNet ?? 0) / risk : null;
    })
    .filter((r): r is number => r !== null);
  const avgR = rValues.length > 0 ? rValues.reduce((s, r) => s + r, 0) / rValues.length : null;

  // Equity curve: oldest→newest by exitTime, cumulative net PnL — TREND only
  const byExit = [...cohortClosedTrend].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let cum = 0;
  const equityCurve = byExit.map(t => {
    cum += t.pnlNet ?? 0;
    return { t: t.exitTime ?? 0, cumPnl: cum };
  });

  // Recent closed: newest first, capped — ALL strategies
  const recentClosed = [...recentClosedAll]
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, RECENT_CLOSED_LIMIT)
    .map(t => ({
      ticker: t.ticker, strategy: t.strategy ?? 'UNKNOWN', entry: t.entryPrice,
      exit: t.exitPrice ?? null, pnlNet: t.pnlNet ?? 0,
      outcome: outcomeOf(t.pnlNet ?? 0), reason: t.exitReason ?? null,
      exitTs: t.exitTime ?? null,
    }));

  const openPositions = openTrades.map(t => ({
    ticker: t.ticker, strategy: t.strategy ?? 'UNKNOWN', side: t.side,
    entry: t.entryPrice, positionSizeUsd: t.positionSizeUsd,
    stop: t.currentStop, target: t.takeProfitTarget,
    heldMs: Math.max(0, now - (t.entryTime ?? now)),
  }));

  return {
    asOf: now,
    status: {
      mode: status.mode,
      isRunning: status.isRunning,
      stale: !status.isRunning || (now - (status.lastLoopAt ?? 0)) > STALE_MS,
      lastLoopAt: status.lastLoopAt ?? 0,
      regime,
    },
    account: { balance: status.portfolioCash ?? 0, openPositionsCount: openTrades.length },
    cohort: {
      baselineTs, baselineMissing, winRate, netPnl, tradeCount, avgR,
    },
    equityCurve,
    openPositions,
    recentClosed,
  };
}
