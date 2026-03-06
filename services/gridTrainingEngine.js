/**
 * Grid Trading Training Engine
 *
 * Sweeps grid parameters (grid count × grid width) in SIDEWAYS regime
 * periods. For each combo: sets grid levels, walks candles, buys at
 * down-cross, sells at up-cross. Fee-aware: 0.52% round-trip must be
 * beaten per fill.
 */

import { getDb } from './database.js';
import { getHistoricalCandles } from './database.js';

let state = {
  running: false,
  totalCombos: 0,
  completedCombos: 0,
  currentCombo: null,
  results: null,
  error: null,
  aborted: false,
};

function yield50() {
  return new Promise(resolve => setImmediate(resolve));
}

function detectRegime(candles) {
  if (candles.length < 21) return 'SIDEWAYS';
  const closes = candles.slice(-21).map(c => c.close);
  const pctChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  if (pctChange > 10) return 'STRONG_UP';
  if (pctChange > 3) return 'UP';
  if (pctChange < -10) return 'STRONG_DOWN';
  if (pctChange < -3) return 'DOWN';
  return 'SIDEWAYS';
}

const FEE_ROUND_TRIP = 0.0052; // 0.52% Kraken taker both sides

export async function startGridTraining({
  tickers,
  gridCounts = [3, 4, 5, 6, 7, 8],
  gridWidths = [5, 8, 10, 12, 15, 20],
}) {
  if (state.running) throw new Error('Grid training already running');

  const allTickers = tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD'];
  const combos = [];
  for (const count of gridCounts) {
    for (const width of gridWidths) {
      combos.push({ gridCount: count, gridWidth: width });
    }
  }

  state = {
    running: true,
    totalCombos: combos.length,
    completedCombos: 0,
    currentCombo: null,
    results: null,
    error: null,
    aborted: false,
  };

  runSweep(allTickers, combos).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { totalCombos: combos.length, tickers: allTickers };
}

async function runSweep(tickers, combos) {
  const now = Date.now();
  const twoYearsAgo = now - 2 * 365 * 24 * 3600 * 1000;
  const candlesByTicker = {};

  for (const ticker of tickers) {
    try {
      candlesByTicker[ticker] = getHistoricalCandles(ticker, '1h', twoYearsAgo, now, 50000);
    } catch { candlesByTicker[ticker] = []; }
  }

  // Pre-identify SIDEWAYS periods across all tickers
  const sidewaysPeriods = {};
  for (const ticker of tickers) {
    const candles = candlesByTicker[ticker];
    sidewaysPeriods[ticker] = [];
    if (candles.length < 50) continue;

    let periodStart = null;
    for (let i = 21; i < candles.length; i++) {
      const window = candles.slice(Math.max(0, i - 21), i + 1);
      const regime = detectRegime(window);
      if (regime === 'SIDEWAYS') {
        if (periodStart === null) periodStart = i;
      } else {
        if (periodStart !== null && i - periodStart >= 24) { // Min 24h sideways
          sidewaysPeriods[ticker].push({ start: periodStart, end: i });
        }
        periodStart = null;
      }
    }
    if (periodStart !== null) {
      sidewaysPeriods[ticker].push({ start: periodStart, end: candles.length - 1 });
    }
  }

  const comboResults = [];

  for (const combo of combos) {
    if (state.aborted) { state.running = false; return; }
    state.currentCombo = combo;

    let totalPnl = 0;
    let totalFills = 0;
    let totalProfitableFills = 0;

    for (const ticker of tickers) {
      const candles = candlesByTicker[ticker];
      const periods = sidewaysPeriods[ticker];

      for (const period of periods) {
        const periodCandles = candles.slice(period.start, period.end + 1);
        if (periodCandles.length < 10) continue;

        // Determine grid center and levels
        const prices = periodCandles.map(c => c.close);
        const midPrice = (Math.max(...prices) + Math.min(...prices)) / 2;
        const halfWidth = midPrice * (combo.gridWidth / 100) / 2;
        const gridStep = (halfWidth * 2) / combo.gridCount;

        // Build grid levels
        const gridLevels = [];
        for (let g = 0; g <= combo.gridCount; g++) {
          gridLevels.push(midPrice - halfWidth + g * gridStep);
        }

        // Walk candles, track grid fills
        const holdings = new Map(); // level → true/false (holding at this level)
        for (const level of gridLevels) holdings.set(level, false);

        let prevPrice = periodCandles[0].close;
        for (let i = 1; i < periodCandles.length; i++) {
          const price = periodCandles[i].close;

          for (const level of gridLevels) {
            // Price crossed down through level → BUY
            if (prevPrice >= level && price < level && !holdings.get(level)) {
              holdings.set(level, true);
            }
            // Price crossed up through level → SELL (if holding)
            else if (prevPrice <= level && price > level && holdings.get(level)) {
              holdings.set(level, false);
              // Calculate P&L for this grid fill
              // We bought below and sold above the same level — profit is the grid step
              const gridPnlPct = gridStep / level;
              const netPnl = gridPnlPct - FEE_ROUND_TRIP;
              totalPnl += netPnl * 100;
              totalFills++;
              if (netPnl > 0) totalProfitableFills++;
            }
          }
          prevPrice = price;
        }
      }
    }

    comboResults.push({
      gridCount: combo.gridCount,
      gridWidth: combo.gridWidth,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalFills,
      profitableFills: totalProfitableFills,
      avgPnlPerFill: totalFills > 0 ? Math.round((totalPnl / totalFills) * 100) / 100 : 0,
      fillRate: totalFills > 0 ? Math.round((totalProfitableFills / totalFills) * 100) : 0,
    });

    state.completedCombos++;
    if (state.completedCombos % 5 === 0) await yield50();
  }

  comboResults.sort((a, b) => b.totalPnl - a.totalPnl);

  state.results = {
    combos: comboResults,
    bestCombo: comboResults[0] || null,
    tickers,
    totalCombos: combos.length,
  };
  state.running = false;
  console.log(`[GridTraining] Completed ${combos.length} combos. Best: ${comboResults[0]?.gridCount} grids × ${comboResults[0]?.gridWidth}% width = ${comboResults[0]?.totalPnl}% PnL`);
}

export function stopGridTraining() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  return { stopped: true };
}

export function getGridTrainingStatus() {
  return {
    running: state.running,
    totalCombos: state.totalCombos,
    completedCombos: state.completedCombos,
    pct: state.totalCombos > 0 ? Math.round((state.completedCombos / state.totalCombos) * 100) : 0,
    currentCombo: state.currentCombo,
    error: state.error,
  };
}

export function getGridTrainingResults() {
  return state.results;
}
