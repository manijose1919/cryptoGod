/**
 * Grid Trading Training Engine
 *
 * Sweeps grid parameters (grid count × grid width) in SIDEWAYS regime
 * periods. For each combo: sets grid levels, walks candles, buys at
 * down-cross, sells at up-cross. Uses maker fees (limit orders).
 * ATR-adaptive grid widths when gridWidths='auto'.
 */

import { getDb } from './database.js';
import { getHistoricalCandles, getHistoricalCandleRange } from './database.js';

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

/**
 * Calculate ATR (Average True Range) for a candle window.
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

// Grid orders are limit orders = maker fees (0.16% per side, 0.32% round-trip)
const FEE_ROUND_TRIP_MAKER = 0.0032;
const FEE_ROUND_TRIP_TAKER = 0.0052;

export async function startGridTraining({
  tickers,
  gridCounts = [3, 4, 5, 6, 7],
  gridWidths = [5, 8, 10, 12, 15, 20],
  useATRWidth = false,
  useTakerFees = false,
}) {
  if (state.running) throw new Error('Grid training already running');

  const allTickers = tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD'];
  const feeRoundTrip = useTakerFees ? FEE_ROUND_TRIP_TAKER : FEE_ROUND_TRIP_MAKER;

  const combos = [];
  if (useATRWidth) {
    // ATR-adaptive: only sweep grid counts, width determined per-period
    for (const count of gridCounts) {
      combos.push({ gridCount: count, gridWidth: 'ATR', adaptive: true });
    }
  } else {
    for (const count of gridCounts) {
      for (const width of gridWidths) {
        combos.push({ gridCount: count, gridWidth: width, adaptive: false });
      }
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

  runSweep(allTickers, combos, feeRoundTrip).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { totalCombos: combos.length, tickers: allTickers, feeMode: useTakerFees ? 'taker' : 'maker' };
}

async function runSweep(tickers, combos, feeRoundTrip) {
  // Use full available data range instead of hardcoded 2 years
  const candlesByTicker = {};
  for (const ticker of tickers) {
    try {
      const range = getHistoricalCandleRange(ticker, '1h');
      if (range && range.earliest) {
        candlesByTicker[ticker] = getHistoricalCandles(ticker, '1h', range.earliest, range.latest, 100000);
      } else {
        candlesByTicker[ticker] = [];
      }
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
    let totalLevelsAvailable = 0;
    let totalLevelsTriggered = 0;

    for (const ticker of tickers) {
      const candles = candlesByTicker[ticker];
      const periods = sidewaysPeriods[ticker];

      for (const period of periods) {
        const periodCandles = candles.slice(period.start, period.end + 1);
        if (periodCandles.length < 10) continue;

        // Determine grid width — ATR-adaptive or fixed
        let effectiveWidth = combo.gridWidth;
        if (combo.adaptive) {
          // Compute 14-period ATR as % of mid price
          const atr = calculateATR(periodCandles.slice(0, Math.min(21, periodCandles.length)), 14);
          const prices = periodCandles.map(c => c.close);
          const midPrice = (Math.max(...prices) + Math.min(...prices)) / 2;
          const atrPct = midPrice > 0 ? (atr / midPrice) * 100 : 5;
          // Grid width = 2 * ATR%, clamped to 3-20%
          effectiveWidth = Math.max(3, Math.min(20, atrPct * 2));
        }

        // Determine grid center and levels
        const prices = periodCandles.map(c => c.close);
        const midPrice = (Math.max(...prices) + Math.min(...prices)) / 2;
        const halfWidth = midPrice * (effectiveWidth / 100) / 2;
        const gridStep = (halfWidth * 2) / combo.gridCount;

        // Build grid levels
        const gridLevels = [];
        for (let g = 0; g <= combo.gridCount; g++) {
          gridLevels.push(midPrice - halfWidth + g * gridStep);
        }

        // Track grid utilization
        totalLevelsAvailable += gridLevels.length;
        const levelTriggered = new Set();

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
              levelTriggered.add(level);
            }
            // Price crossed up through level → SELL (if holding)
            else if (prevPrice <= level && price > level && holdings.get(level)) {
              holdings.set(level, false);
              levelTriggered.add(level);
              // Calculate P&L for this grid fill
              const gridPnlPct = gridStep / level;
              const netPnl = gridPnlPct - feeRoundTrip;
              totalPnl += netPnl * 100;
              totalFills++;
              if (netPnl > 0) totalProfitableFills++;
            }
          }
          prevPrice = price;
        }

        totalLevelsTriggered += levelTriggered.size;
      }
    }

    const gridUtilization = totalLevelsAvailable > 0
      ? Math.round((totalLevelsTriggered / totalLevelsAvailable) * 100) : 0;

    comboResults.push({
      gridCount: combo.gridCount,
      gridWidth: combo.adaptive ? 'ATR' : combo.gridWidth,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalFills,
      profitableFills: totalProfitableFills,
      avgPnlPerFill: totalFills > 0 ? Math.round((totalPnl / totalFills) * 100) / 100 : 0,
      fillRate: totalFills > 0 ? Math.round((totalProfitableFills / totalFills) * 100) : 0,
      gridUtilization,
      feeMode: feeRoundTrip === FEE_ROUND_TRIP_MAKER ? 'maker' : 'taker',
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
    feeRoundTrip: feeRoundTrip,
  };
  state.running = false;
  console.log(`[GridTraining] Completed ${combos.length} combos. Best: ${comboResults[0]?.gridCount} grids × ${comboResults[0]?.gridWidth}% width = ${comboResults[0]?.totalPnl}% PnL (${comboResults[0]?.gridUtilization}% utilization)`);
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
