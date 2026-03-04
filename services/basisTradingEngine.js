/**
 * Cash-and-Carry Basis Trading Engine — Market-Neutral Funding Rate Arbitrage.
 *
 * Strategy: When perp funding is highly positive (longs pay shorts):
 * 1. Buy spot asset on primary exchange (e.g., Kraken)
 * 2. Short equivalent perp on derivatives exchange (via Binance perp or Crypto.com)
 * 3. Collect funding payments every 8 hours
 * 4. Close both legs when funding normalizes
 *
 * This is delta-neutral: price movement cancels out because long spot = short perp.
 * Profit comes purely from the funding rate differential.
 *
 * Requirements:
 * - Positive funding rate > MIN_FUNDING_APR (currently 15% annualized)
 * - Both exchanges accessible
 * - Sufficient balance on both sides
 *
 * Risk:
 * - Liquidation risk on perp side if price moves too fast before margin top-up
 * - Exchange counterparty risk
 * - Basis convergence risk (funding can flip negative)
 *
 * NOTE: This engine runs in SIMULATION mode only until perp trading is enabled.
 * Requires margin/futures access on the short leg exchange.
 */

import { getDerivativesSignal } from './derivativesIntelligence.js';

// ─── Configuration ───────────────────────────────────────────

const MIN_FUNDING_APR = 15;      // Minimum annualized funding rate to open (%)
const EXIT_FUNDING_APR = 5;      // Close when funding drops below this (%)
const MAX_POSITION_USD = 500;    // Max USD per basis trade
const MIN_POSITION_USD = 20;     // Min USD per basis trade
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes

// Supported tickers for basis trades
const BASIS_TICKERS = ['BTC', 'ETH', 'SOL', 'XRP'];

// ─── State ───────────────────────────────────────────────────

let checkInterval = null;
const positions = new Map(); // ticker → { spotLeg, perpLeg, entryFunding, entryTime, ... }
let simBalance = 1000; // Simulation balance for tracking
let totalFundingCollected = 0;
let totalTrades = 0;

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Scan for basis trading opportunities.
 * Returns array of opportunities with expected APR.
 */
export function scanOpportunities() {
  const opportunities = [];

  for (const ticker of BASIS_TICKERS) {
    const signal = getDerivativesSignal(ticker);
    if (!signal) continue;

    const fundingAPR = signal.fundingRateAnnualized;
    if (fundingAPR < MIN_FUNDING_APR) continue;

    // Estimate daily income from funding
    const dailyRate = fundingAPR / 365;
    const estDailyIncome = MAX_POSITION_USD * (dailyRate / 100);

    // Funding payment frequency: every 8 hours = 3x/day
    const perPayment = estDailyIncome / 3;

    opportunities.push({
      ticker: ticker + 'USD',
      fundingRate: signal.fundingRate,
      fundingAPR,
      dailyRate,
      estDailyIncome,
      perPayment,
      longShortRatio: signal.longShortRatio,
      openInterest: signal.openInterest,
      isActive: positions.has(ticker),
      score: Math.min(100, fundingAPR * 2), // Higher funding = better opportunity
    });
  }

  // Sort by score (highest funding first)
  return opportunities.sort((a, b) => b.score - a.score);
}

/**
 * Simulate opening a basis trade position.
 * In production: would place spot buy + perp short.
 */
export function openBasisPosition(ticker, amountUSD) {
  const symbol = ticker.replace('USD', '');
  if (positions.has(symbol)) {
    return { success: false, reason: 'Already have basis position in ' + ticker };
  }

  const signal = getDerivativesSignal(symbol);
  if (!signal || signal.fundingRateAnnualized < MIN_FUNDING_APR) {
    return { success: false, reason: 'Funding rate too low' };
  }

  amountUSD = Math.min(MAX_POSITION_USD, Math.max(MIN_POSITION_USD, amountUSD));
  if (simBalance < amountUSD * 2) { // Need 2x (spot + margin for perp)
    return { success: false, reason: 'Insufficient balance' };
  }

  const position = {
    ticker,
    symbol,
    spotSide: 'LONG',
    perpSide: 'SHORT',
    notionalUSD: amountUSD,
    entryPrice: signal.lastPrice,
    entryFundingAPR: signal.fundingRateAnnualized,
    entryFundingRate: signal.fundingRate,
    entryTime: Date.now(),
    fundingCollected: 0,
    paymentCount: 0,
    lastFundingPayment: 0,
    status: 'OPEN',
  };

  positions.set(symbol, position);
  simBalance -= amountUSD; // Lock capital
  totalTrades++;

  console.log(`[BasisEngine] Opened ${ticker} basis trade: $${amountUSD} @ ${signal.fundingRateAnnualized.toFixed(1)}% APR`);

  return { success: true, position };
}

/**
 * Simulate collecting funding payment for a position.
 */
function collectFunding(symbol) {
  const pos = positions.get(symbol);
  if (!pos) return;

  const signal = getDerivativesSignal(symbol);
  if (!signal) return;

  // Funding payment = notional × funding rate (per 8h period)
  const payment = pos.notionalUSD * Math.abs(signal.fundingRate);

  // If funding is positive, shorts collect (our perp leg is short)
  if (signal.fundingRate > 0) {
    pos.fundingCollected += payment;
    totalFundingCollected += payment;
    pos.paymentCount++;
    pos.lastFundingPayment = payment;
    simBalance += payment;
  } else {
    // Negative funding — we're paying. Track as negative.
    pos.fundingCollected -= payment;
    totalFundingCollected -= payment;
    pos.paymentCount++;
    pos.lastFundingPayment = -payment;
    simBalance -= payment;
  }
}

/**
 * Close a basis position (simulation).
 */
export function closeBasisPosition(symbol) {
  const pos = positions.get(symbol);
  if (!pos) return { success: false, reason: 'No position found' };

  // Return locked capital + collected funding
  simBalance += pos.notionalUSD;

  const holdTime = Date.now() - pos.entryTime;
  const holdDays = holdTime / (24 * 60 * 60 * 1000);
  const apr = holdDays > 0 ? (pos.fundingCollected / pos.notionalUSD) * (365 / holdDays) * 100 : 0;

  const result = {
    success: true,
    ticker: pos.ticker,
    holdDays: holdDays.toFixed(1),
    fundingCollected: pos.fundingCollected,
    payments: pos.paymentCount,
    realizedAPR: apr.toFixed(1) + '%',
    pnl: pos.fundingCollected,
  };

  positions.delete(symbol);
  console.log(`[BasisEngine] Closed ${pos.ticker} basis: $${pos.fundingCollected.toFixed(4)} funding over ${holdDays.toFixed(1)} days (${apr.toFixed(1)}% APR)`);

  return result;
}

// ─── Periodic Check ──────────────────────────────────────────

function periodicCheck() {
  // Collect funding for open positions
  for (const [symbol] of positions) {
    collectFunding(symbol);
  }

  // Check if any positions should be closed (funding dropped)
  for (const [symbol, pos] of positions) {
    const signal = getDerivativesSignal(symbol);
    if (!signal) continue;

    // Close if funding dropped below exit threshold
    if (signal.fundingRateAnnualized < EXIT_FUNDING_APR) {
      console.log(`[BasisEngine] Funding dropped to ${signal.fundingRateAnnualized.toFixed(1)}% for ${symbol} — closing`);
      closeBasisPosition(symbol);
    }

    // Close if funding flipped negative (we'd be paying)
    if (signal.fundingRate < 0) {
      console.log(`[BasisEngine] Funding flipped negative for ${symbol} — closing`);
      closeBasisPosition(symbol);
    }
  }

  // Auto-open new positions on strong opportunities
  const opps = scanOpportunities();
  for (const opp of opps) {
    if (opp.isActive) continue; // Already have position
    if (opp.fundingAPR < MIN_FUNDING_APR * 1.5) continue; // Only auto-open at 1.5x threshold
    if (positions.size >= 3) continue; // Max 3 concurrent basis trades

    const amount = Math.min(MAX_POSITION_USD, simBalance * 0.3);
    if (amount >= MIN_POSITION_USD) {
      openBasisPosition(opp.ticker, amount);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────

export function startBasisEngine() {
  if (checkInterval) return;
  console.log('[BasisEngine] Starting cash-and-carry basis trading engine (sim mode)');
  periodicCheck();
  checkInterval = setInterval(periodicCheck, CHECK_INTERVAL_MS);
}

export function stopBasisEngine() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

export function getBasisStatus() {
  const positionList = [];
  for (const [symbol, pos] of positions) {
    const signal = getDerivativesSignal(symbol);
    const holdHours = (Date.now() - pos.entryTime) / (60 * 60 * 1000);
    positionList.push({
      ticker: pos.ticker,
      notional: pos.notionalUSD,
      entryFundingAPR: pos.entryFundingAPR.toFixed(1) + '%',
      currentFundingAPR: (signal?.fundingRateAnnualized || 0).toFixed(1) + '%',
      fundingCollected: pos.fundingCollected.toFixed(4),
      payments: pos.paymentCount,
      holdHours: holdHours.toFixed(1),
      lastPayment: pos.lastFundingPayment.toFixed(6),
    });
  }

  return {
    enabled: checkInterval !== null,
    mode: 'SIMULATION',
    simBalance: simBalance.toFixed(2),
    openPositions: positions.size,
    totalTrades,
    totalFundingCollected: totalFundingCollected.toFixed(4),
    positions: positionList,
    opportunities: scanOpportunities(),
    config: {
      minFundingAPR: MIN_FUNDING_APR,
      exitFundingAPR: EXIT_FUNDING_APR,
      maxPositionUSD: MAX_POSITION_USD,
      tickers: BASIS_TICKERS,
    },
  };
}

export default {
  startBasisEngine,
  stopBasisEngine,
  scanOpportunities,
  openBasisPosition,
  closeBasisPosition,
  getBasisStatus,
};
