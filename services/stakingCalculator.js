/**
 * Staking Yield Calculator
 *
 * Compares stake-and-hold vs active trading vs hybrid (80/20)
 * for a given ticker, APY, amount, and time period.
 */

import { getDb } from './database.js';

// Pre-filled APYs for major staking assets
const DEFAULT_APYS = {
  ETHUSD: 3.5,
  DOTUSD: 12.0,
  SOLUSD: 7.0,
  ADAUSD: 3.0,
  AVAXUSD: 8.0,
  XRPUSD: 0,    // Not stakeable
  BTCUSD: 0,    // Not natively stakeable
  DOGEUSD: 0,
  LINKUSD: 4.5,
};

/**
 * Calculate comparative yields for stake vs trade vs hybrid.
 */
export function calculateStakingYield({ ticker, apy, initialAmount = 10000, days = 365 }) {
  if (!ticker) throw new Error('ticker required');
  const effectiveApy = apy ?? DEFAULT_APYS[ticker] ?? 0;

  // 1. Stake-and-hold: compound APY over period + price change
  const dailyRate = effectiveApy / 100 / 365;
  const stakingYield = initialAmount * (Math.pow(1 + dailyRate, days) - 1);
  const stakingTotal = initialAmount + stakingYield;

  // 2. Active trading: look up best training run P&L% for that ticker
  let tradingPnlPct = 0;
  let tradingRunId = null;
  try {
    const bestRun = getDb().prepare(`
      SELECT tr.run_id, tr.total_pnl, tr.config_json
      FROM training_runs tr
      WHERE tr.status = 'completed' AND tr.total_pnl > 0
      ORDER BY tr.total_pnl DESC LIMIT 20
    `).all();

    for (const run of bestRun) {
      try {
        const config = JSON.parse(run.config_json || '{}');
        const tickers = config.tickers || [];
        if (tickers.includes(ticker) || tickers.length === 0) {
          // Annualize: run covers some period, scale to requested days
          const rawDays = config.startTime && config.endTime
            ? (config.endTime - config.startTime) / (24 * 3600 * 1000)
            : 365;
          const runDays = Math.max(1, rawDays); // Guard against division by zero
          const runPnlPct = (run.total_pnl / (config.initialCash || 10000)) * 100;
          tradingPnlPct = (runPnlPct / runDays) * days;
          tradingRunId = run.run_id;
          break;
        }
      } catch { continue; }
    }
  } catch { /* DB may not be initialized */ }

  const tradingYield = initialAmount * (tradingPnlPct / 100);
  const tradingTotal = initialAmount + tradingYield;

  // 3. Hybrid: 80% staked + 20% traded
  const stakedPortion = initialAmount * 0.8;
  const tradedPortion = initialAmount * 0.2;
  const hybridStakingYield = stakedPortion * (Math.pow(1 + dailyRate, days) - 1);
  const hybridTradingYield = tradedPortion * (tradingPnlPct / 100);
  const hybridTotal = stakedPortion + hybridStakingYield + tradedPortion + hybridTradingYield;

  return {
    ticker,
    apy: effectiveApy,
    initialAmount,
    days,
    stakeAndHold: {
      yield: Math.round(stakingYield * 100) / 100,
      total: Math.round(stakingTotal * 100) / 100,
      returnPct: Math.round((stakingYield / initialAmount) * 10000) / 100,
    },
    activeTrading: {
      yield: Math.round(tradingYield * 100) / 100,
      total: Math.round(tradingTotal * 100) / 100,
      returnPct: Math.round(tradingPnlPct * 100) / 100,
      sourceRunId: tradingRunId,
    },
    hybrid: {
      yield: Math.round((hybridStakingYield + hybridTradingYield) * 100) / 100,
      total: Math.round(hybridTotal * 100) / 100,
      returnPct: Math.round(((hybridTotal - initialAmount) / initialAmount) * 10000) / 100,
      stakedPortion: Math.round(stakedPortion * 100) / 100,
      tradedPortion: Math.round(tradedPortion * 100) / 100,
    },
    defaultApys: DEFAULT_APYS,
  };
}
