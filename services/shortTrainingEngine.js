/**
 * Short Selling Training Engine
 *
 * Backtests short positions with parameter sweep across SL, TP,
 * and confidence thresholds. Entry requires DOWN/STRONG_DOWN regime
 * with TC > 70 (bearish conditions). Short P&L is inverted from longs.
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

/**
 * Simple regime detection from candles (reuses the same logic as training engine).
 * Returns one of: STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN
 */
function detectRegime(candles) {
  if (candles.length < 21) return 'SIDEWAYS';
  const closes = candles.slice(-21).map(c => c.close);
  const sma20 = closes.reduce((s, c) => s + c, 0) / closes.length;
  const current = closes[closes.length - 1];
  const pctChange = ((current - closes[0]) / closes[0]) * 100;

  if (pctChange > 10) return 'STRONG_UP';
  if (pctChange > 3) return 'UP';
  if (pctChange < -10) return 'STRONG_DOWN';
  if (pctChange < -3) return 'DOWN';
  return 'SIDEWAYS';
}

/**
 * Simple TC (Trend Cipher) approximation for entry signal.
 */
function calculateTC(candles) {
  if (candles.length < 14) return 50;
  const closes = candles.slice(-14).map(c => c.close);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) { gains.push(diff); losses.push(0); }
    else { gains.push(0); losses.push(-diff); }
  }
  const avgGain = gains.reduce((s, g) => s + g, 0) / gains.length;
  const avgLoss = losses.reduce((s, l) => s + l, 0) / losses.length;
  if (avgLoss === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs)); // RSI-like, high = bearish for shorts
}

const FEE_PER_SIDE = 0.0026; // 0.26% Kraken taker

export async function startShortTraining({
  tickers,
  slRange = [2, 3, 4, 5],
  tpRange = [3, 5, 8, 10],
  confidenceRange = [50, 60, 70, 80],
  regimeFilter = ['DOWN', 'STRONG_DOWN'],
  maxHoldHours = 168,
}) {
  if (state.running) throw new Error('Short training already running');

  const allTickers = tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD'];
  const combos = [];
  for (const sl of slRange) {
    for (const tp of tpRange) {
      for (const conf of confidenceRange) {
        combos.push({ sl: sl / 100, tp: tp / 100, confidence: conf });
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

  runSweep(allTickers, combos, regimeFilter, maxHoldHours).catch(err => {
    state.error = err.message;
    state.running = false;
  });

  return { totalCombos: combos.length, tickers: allTickers };
}

async function runSweep(tickers, combos, regimeFilter, maxHoldHours) {
  // Load candle data for all tickers (1h timeframe, last 2 years)
  const now = Date.now();
  const twoYearsAgo = now - 2 * 365 * 24 * 3600 * 1000;
  const candlesByTicker = {};

  for (const ticker of tickers) {
    try {
      candlesByTicker[ticker] = getHistoricalCandles(ticker, '1h', twoYearsAgo, now, 50000);
    } catch { candlesByTicker[ticker] = []; }
  }

  const comboResults = [];

  for (const combo of combos) {
    if (state.aborted) { state.running = false; return; }
    state.currentCombo = combo;

    let totalPnl = 0;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;

    for (const ticker of tickers) {
      const candles = candlesByTicker[ticker];
      if (candles.length < 50) continue;

      let i = 21;
      let inPosition = false;
      let entryPrice = 0;
      let entryIndex = 0;

      while (i < candles.length) {
        if (state.aborted) { state.running = false; return; }

        const window = candles.slice(Math.max(0, i - 21), i + 1);
        const regime = detectRegime(window);
        const tc = calculateTC(window);

        if (!inPosition) {
          // Entry: regime is bearish, TC > confidence (bearish signal)
          if (regimeFilter.includes(regime) && tc > combo.confidence) {
            inPosition = true;
            entryPrice = candles[i].close;
            entryIndex = i;
          }
        } else {
          // Check exits
          const currentPrice = candles[i].close;
          // Short P&L: positive when price drops
          const pnlPct = (entryPrice - currentPrice) / entryPrice;
          const holdHours = i - entryIndex;

          let exit = false;
          if (pnlPct <= -combo.sl) exit = true; // Stop loss (price rose)
          else if (pnlPct >= combo.tp) exit = true; // Take profit (price dropped)
          else if (holdHours >= maxHoldHours) exit = true; // Time exit
          else if (!regimeFilter.includes(regime) && regime !== 'SIDEWAYS') exit = true; // Regime flipped bullish

          if (exit) {
            const netPnl = pnlPct - (FEE_PER_SIDE * 2); // Both sides
            totalPnl += netPnl * 100; // As percentage points
            totalTrades++;
            if (netPnl > 0) wins++; else losses++;
            inPosition = false;
          }
        }
        i++;
      }
    }

    comboResults.push({
      sl: combo.sl * 100,
      tp: combo.tp * 100,
      confidence: combo.confidence,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0,
      avgPnl: totalTrades > 0 ? Math.round((totalPnl / totalTrades) * 100) / 100 : 0,
    });

    state.completedCombos++;
    if (state.completedCombos % 10 === 0) await yield50();
  }

  // Sort by total P&L descending
  comboResults.sort((a, b) => b.totalPnl - a.totalPnl);

  state.results = {
    combos: comboResults,
    bestCombo: comboResults[0] || null,
    tickers,
    totalCombos: combos.length,
  };
  state.running = false;
  console.log(`[ShortTraining] Completed ${combos.length} combos. Best: SL=${comboResults[0]?.sl}% TP=${comboResults[0]?.tp}% Conf=${comboResults[0]?.confidence} PnL=${comboResults[0]?.totalPnl}%`);
}

export function stopShortTraining() {
  if (!state.running) return { stopped: false };
  state.aborted = true;
  return { stopped: true };
}

export function getShortTrainingStatus() {
  return {
    running: state.running,
    totalCombos: state.totalCombos,
    completedCombos: state.completedCombos,
    pct: state.totalCombos > 0 ? Math.round((state.completedCombos / state.totalCombos) * 100) : 0,
    currentCombo: state.currentCombo,
    error: state.error,
  };
}

export function getShortTrainingResults() {
  return state.results;
}
