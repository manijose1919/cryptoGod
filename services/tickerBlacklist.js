/**
 * Ticker Blacklist Service
 *
 * Data-driven runtime filter that blocks new TREND entries for tickers with
 * poor historical performance. Recomputed hourly from the `trades` table.
 *
 * Criteria (a ticker is blacklisted if ALL hold):
 *   - strategy = 'TREND'              (only strategy with significant data)
 *   - closed trades >= TICKER_BLACKLIST_MIN_TRADES  (default 10)
 *   - win rate      <  TICKER_BLACKLIST_MAX_WIN_RATE (default 0.20)
 *   - net P&L       <  0
 *
 * Fails open: any error -> empty blacklist, no ticker is blocked.
 * Only blocks new entries; existing open positions are unaffected.
 */

import { getDb } from './database.js';
import { getFlag } from './systemConfig.js';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let blacklist = new Set();
let stats = [];
let lastRefresh = 0;
let refreshTimer = null;

function computeBlacklist() {
  try {
    const minTrades = Number(getFlag('TICKER_BLACKLIST_MIN_TRADES') ?? 10);
    const maxWR = Number(getFlag('TICKER_BLACKLIST_MAX_WIN_RATE') ?? 0.20);

    const rows = getDb().prepare(`
      SELECT
        ticker,
        COUNT(*) AS n,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(pnl) AS net
      FROM trades
      WHERE strategy = 'TREND' AND exit_time IS NOT NULL
      GROUP BY ticker
      HAVING n >= ? AND (CAST(wins AS REAL) / n) < ? AND net < 0
      ORDER BY net ASC
    `).all(minTrades, maxWR);

    const next = new Set();
    const nextStats = [];
    for (const r of rows) {
      next.add(r.ticker);
      nextStats.push({
        ticker: r.ticker,
        trades: r.n,
        wins: r.wins,
        winRate: r.n > 0 ? r.wins / r.n : 0,
        netPnl: Number((r.net ?? 0).toFixed(4)),
      });
    }

    blacklist = next;
    stats = nextStats;
    lastRefresh = Date.now();

    if (nextStats.length > 0) {
      const preview = nextStats.slice(0, 5).map(s =>
        `${s.ticker}(${s.wins}/${s.trades}=${(s.winRate * 100).toFixed(0)}%,$${s.netPnl.toFixed(2)})`
      ).join(', ');
      const suffix = nextStats.length > 5 ? `, +${nextStats.length - 5} more` : '';
      console.log(`[TickerBlacklist] Refreshed — ${nextStats.length} blocked: ${preview}${suffix}`);
    } else {
      console.log('[TickerBlacklist] Refreshed — 0 blocked');
    }
  } catch (err) {
    // Fail open — do not block any ticker if query fails
    console.warn('[TickerBlacklist] Refresh failed, failing open:', err.message);
    blacklist = new Set();
    stats = [];
  }
}

export function initTickerBlacklist() {
  computeBlacklist();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(computeBlacklist, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

export function isTickerBlacklisted(ticker) {
  if (!getFlag('TICKER_BLACKLIST_ENABLED')) return false;
  return blacklist.has(ticker);
}

export function getBlacklistStats() {
  return {
    enabled: Boolean(getFlag('TICKER_BLACKLIST_ENABLED')),
    count: blacklist.size,
    tickers: Array.from(blacklist),
    lastRefresh,
    lastRefreshAgo: lastRefresh ? Date.now() - lastRefresh : null,
    criteria: {
      minTrades: Number(getFlag('TICKER_BLACKLIST_MIN_TRADES') ?? 10),
      maxWinRate: Number(getFlag('TICKER_BLACKLIST_MAX_WIN_RATE') ?? 0.20),
      strategy: 'TREND',
    },
    stats,
  };
}

export function refreshTickerBlacklist() {
  computeBlacklist();
  return getBlacklistStats();
}
