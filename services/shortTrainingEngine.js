/**
 * Short Selling Training Engine
 *
 * Backtests short positions with parameter sweep across SL, TP,
 * and confidence thresholds. Entry requires bearish regime with
 * LOW TC (bearish = price dropping). Short P&L is inverted from longs.
 * Includes RSI overbought signal and trailing stop.
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

/**
 * Simple regime detection from candles.
 * Returns one of: STRONG_UP, UP, SIDEWAYS, DOWN, STRONG_DOWN
 */
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
 * Simple TC (Trend Cipher) approximation — RSI-like.
 * HIGH TC = BULLISH (price rising), LOW TC = BEARISH (price dropping).
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
  if (avgLoss === 0) return 100; // All gains = fully bullish
  if (avgGain === 0) return 0;   // All losses = fully bearish
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate RSI for overbought detection.
 */
function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const closes = candles.slice(-(period + 1)).map(c => c.close);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

const FEE_PER_SIDE = 0.0026; // 0.26% Kraken taker

export async function startShortTraining({
  tickers,
  slRange = [2, 3, 4, 5],
  tpRange = [3, 5, 8, 10],
  confidenceRange = [50, 60, 70, 80],
  regimeFilter = ['DOWN', 'STRONG_DOWN', 'SIDEWAYS'],
  maxHoldHours = 168,
  trailingGiveBack = [0, 15, 25],
}) {
  if (state.running) throw new Error('Short training already running');

  const allTickers = tickers || ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD'];
  const combos = [];
  for (const sl of slRange) {
    for (const tp of tpRange) {
      for (const conf of confidenceRange) {
        for (const trail of trailingGiveBack) {
          combos.push({ sl: sl / 100, tp: tp / 100, confidence: conf, trailingGiveBack: trail / 100 });
        }
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

  const totalCandlesLoaded = Object.values(candlesByTicker).reduce((s, arr) => s + arr.length, 0);
  console.log(`[ShortTraining] Loaded ${totalCandlesLoaded} candles across ${tickers.length} tickers (full data range)`);

  const comboResults = [];

  for (const combo of combos) {
    if (state.aborted) { state.running = false; return; }
    state.currentCombo = combo;

    let totalPnl = 0;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalFees = 0;
    let bestTrade = 0;
    let worstTrade = 0;

    for (const ticker of tickers) {
      const candles = candlesByTicker[ticker];
      if (candles.length < 50) continue;

      let i = 21;
      let inPosition = false;
      let entryPrice = 0;
      let entryIndex = 0;
      let lowestPrice = 0; // For trailing stop on shorts

      while (i < candles.length) {
        if (state.aborted) { state.running = false; return; }

        const window = candles.slice(Math.max(0, i - 21), i + 1);
        const regime = detectRegime(window);
        const tc = calculateTC(window);
        const rsi = calculateRSI(window);

        if (!inPosition) {
          // ENTRY LOGIC (FIXED):
          // TC is RSI-like: HIGH = bullish, LOW = bearish
          // For shorts, we want LOW TC (bearish) = tc < (100 - combo.confidence)
          // e.g., confidence=70 → enter when tc < 30 (very bearish)
          const tcBearish = tc < (100 - combo.confidence);

          // RSI overbought signal: enter short when RSI > 70 + bearish candle
          const currentCandle = candles[i];
          const bearishCandle = currentCandle.close < currentCandle.open;
          const rsiOverbought = rsi > 70 && bearishCandle;

          // Entry: regime is bearish + (TC bearish OR RSI overbought reversal)
          if (regimeFilter.includes(regime) && (tcBearish || rsiOverbought)) {
            inPosition = true;
            entryPrice = candles[i].close;
            entryIndex = i;
            lowestPrice = entryPrice; // Initialize trailing tracker
          }
        } else {
          // Check exits
          const currentPrice = candles[i].close;
          // Short P&L: positive when price drops
          const pnlPct = (entryPrice - currentPrice) / entryPrice;
          const holdHours = i - entryIndex;

          // Track lowest price for trailing stop
          if (currentPrice < lowestPrice) {
            lowestPrice = currentPrice;
          }

          let exit = false;
          let exitReason = '';

          if (pnlPct <= -combo.sl) {
            exit = true;
            exitReason = 'stopLoss';
          } else if (pnlPct >= combo.tp) {
            exit = true;
            exitReason = 'takeProfit';
          } else if (holdHours >= maxHoldHours) {
            exit = true;
            exitReason = 'timeExit';
          } else if (!regimeFilter.includes(regime) && regime !== 'SIDEWAYS') {
            exit = true;
            exitReason = 'regimeFlip';
          }

          // Trailing stop: if price bounced back from lowest by trailingGiveBack%
          if (!exit && combo.trailingGiveBack > 0 && lowestPrice < entryPrice) {
            const profitFromLowest = (entryPrice - lowestPrice) / entryPrice;
            if (profitFromLowest > 0.01) { // Only trail after 1% profit achieved
              const bounceFromLowest = (currentPrice - lowestPrice) / lowestPrice;
              if (bounceFromLowest >= combo.trailingGiveBack) {
                exit = true;
                exitReason = 'trailing';
              }
            }
          }

          if (exit) {
            const fee = FEE_PER_SIDE * 2;
            const netPnl = pnlPct - fee;
            totalPnl += netPnl * 100; // As percentage points
            totalFees += fee * 100;
            totalTrades++;
            if (netPnl > 0) wins++; else losses++;
            if (netPnl * 100 > bestTrade) bestTrade = netPnl * 100;
            if (netPnl * 100 < worstTrade) worstTrade = netPnl * 100;
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
      trailingGiveBack: combo.trailingGiveBack * 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0,
      avgPnl: totalTrades > 0 ? Math.round((totalPnl / totalTrades) * 100) / 100 : 0,
      totalFees: Math.round(totalFees * 100) / 100,
      bestTrade: Math.round(bestTrade * 100) / 100,
      worstTrade: Math.round(worstTrade * 100) / 100,
    });

    state.completedCombos++;
    if (state.completedCombos % 10 === 0) await yield50();
  }

  // Sort by total P&L descending
  comboResults.sort((a, b) => b.totalPnl - a.totalPnl);

  const profitableCombos = comboResults.filter(c => c.totalPnl > 0).length;

  state.results = {
    combos: comboResults,
    bestCombo: comboResults[0] || null,
    tickers,
    totalCombos: combos.length,
    profitableCombos,
    regimeFilter,
  };
  state.running = false;
  console.log(`[ShortTraining] Completed ${combos.length} combos (${profitableCombos} profitable). Best: SL=${comboResults[0]?.sl}% TP=${comboResults[0]?.tp}% Conf=${comboResults[0]?.confidence} Trail=${comboResults[0]?.trailingGiveBack}% PnL=${comboResults[0]?.totalPnl}% (${comboResults[0]?.totalTrades} trades)`);
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
