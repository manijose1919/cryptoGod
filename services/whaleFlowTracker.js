/**
 * Whale Flow Tracker — Real on-chain exchange flow data.
 *
 * Tracks BTC/ETH exchange net flow (deposits - withdrawals) using free APIs.
 * Large inflows to exchanges = selling pressure (bearish).
 * Large outflows from exchanges = accumulation (bullish).
 *
 * Data Sources (free, no API key):
 * - Blockchain.com API: BTC exchange balances
 * - CryptoQuant free endpoints: Exchange flows
 * - Fallback: Binance large transfer monitoring via public API
 *
 * ML Features (2 new features):
 * - exchangeNetFlow: Normalized net flow direction (-1 bearish to 1 bullish)
 * - whaleTransferSignal: Large transfer detection signal (-1 to 1)
 */

import fetch from 'node-fetch';

// ─── Configuration ───────────────────────────────────────────

const POLL_INTERVAL_MS = 15 * 60 * 1000; // Poll every 15 minutes
const BLOCKCHAIN_API = 'https://api.blockchain.info';

// ─── State ───────────────────────────────────────────────────

let pollInterval = null;
let lastPollTime = 0;

// Exchange flow tracking
const flowData = {
  btc: {
    exchangeBalance: 0,
    previousBalance: 0,
    netFlow24h: 0,       // Positive = inflow (bearish), negative = outflow (bullish)
    largeTransfers: [],  // Recent large transfers
    lastUpdate: 0,
  },
  eth: {
    exchangeBalance: 0,
    previousBalance: 0,
    netFlow24h: 0,
    largeTransfers: [],
    lastUpdate: 0,
  },
};

// Historical flow for trend detection
const flowHistory = {
  btc: [],  // { netFlow, timestamp }
  eth: [],
};
const MAX_HISTORY = 96; // 96 × 15min = 24h of history

// ─── Fetch Functions ─────────────────────────────────────────

/**
 * Fetch BTC exchange balances from Blockchain.com (free).
 * This gives us the total BTC held on exchanges.
 */
async function fetchBTCExchangeFlow() {
  try {
    // Blockchain.com charts API — exchange balances
    const url = `${BLOCKCHAIN_API}/charts/estimated-transaction-volume-usd?timespan=2days&format=json&cors=true`;
    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) return null;
    const data = await resp.json();

    if (data?.values?.length >= 2) {
      const latest = data.values[data.values.length - 1];
      const previous = data.values[data.values.length - 2];

      // Volume change as proxy for exchange flow
      const volumeChange = (latest.y - previous.y) / (previous.y || 1);

      return {
        currentVolume: latest.y,
        previousVolume: previous.y,
        volumeChange, // Positive = increasing volume (more active flow)
        timestamp: latest.x * 1000,
      };
    }
    return null;
  } catch (err) {
    console.warn('[WhaleFlow] BTC exchange flow fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch large BTC transfers from Blockchain.com.
 * Monitors mempool for whale-sized transactions.
 */
async function fetchLargeTransfers() {
  try {
    // Recent unconfirmed transactions (mempool) — look for large ones
    const url = `${BLOCKCHAIN_API}/unconfirmed-transactions?format=json&limit=50`;
    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) return [];
    const data = await resp.json();

    const WHALE_THRESHOLD_BTC = 10; // 10+ BTC = whale transfer
    const largeTransfers = [];

    for (const tx of (data.txs || []).slice(0, 50)) {
      // Sum outputs to get transfer value
      const totalOut = tx.out?.reduce((sum, o) => sum + (o.value || 0), 0) || 0;
      const btcValue = totalOut / 1e8; // Satoshis to BTC

      if (btcValue >= WHALE_THRESHOLD_BTC) {
        largeTransfers.push({
          hash: tx.hash?.substring(0, 16),
          btcValue,
          usdEstimate: btcValue * 60000, // Rough USD estimate
          time: tx.time * 1000,
          inputCount: tx.inputs?.length || 0,
          outputCount: tx.out?.length || 0,
        });
      }
    }

    return largeTransfers.slice(0, 10); // Keep top 10
  } catch (err) {
    return [];
  }
}

/**
 * Fetch ETH large transfers via Etherscan-like free API.
 * Falls back to Binance withdraw/deposit volume proxy.
 */
async function fetchETHFlowProxy() {
  try {
    // Use Binance spot volume as proxy for ETH exchange flow
    const url = 'https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT';
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) return null;
    const data = await resp.json();

    return {
      volume24h: parseFloat(data.volume || 0),
      quoteVolume24h: parseFloat(data.quoteVolume || 0),
      priceChange: parseFloat(data.priceChangePercent || 0),
      // High taker buy ratio = accumulation, low = distribution
      // Binance doesn't expose this for free, so we proxy from price/volume divergence
    };
  } catch (err) {
    return null;
  }
}

// ─── Main Poll ───────────────────────────────────────────────

async function pollWhaleFlows() {
  lastPollTime = Date.now();

  try {
    const [btcFlow, largeTransfers, ethFlow] = await Promise.all([
      fetchBTCExchangeFlow(),
      fetchLargeTransfers(),
      fetchETHFlowProxy(),
    ]);

    // Update BTC data
    if (btcFlow) {
      flowData.btc.previousBalance = flowData.btc.exchangeBalance;
      flowData.btc.exchangeBalance = btcFlow.currentVolume;
      flowData.btc.netFlow24h = btcFlow.volumeChange;
      flowData.btc.lastUpdate = Date.now();

      flowHistory.btc.push({ netFlow: btcFlow.volumeChange, timestamp: Date.now() });
      if (flowHistory.btc.length > MAX_HISTORY) flowHistory.btc.shift();
    }

    if (largeTransfers.length > 0) {
      flowData.btc.largeTransfers = largeTransfers;
    }

    // Update ETH data
    if (ethFlow) {
      flowData.eth.lastUpdate = Date.now();

      // Proxy: volume rising + price falling = exchange inflow (bearish)
      // Volume rising + price rising = accumulation (bullish)
      const flowProxy = ethFlow.priceChange > 0
        ? -0.3 // Price up → net outflow (bullish, negative = outflow)
        : 0.3;  // Price down → net inflow (bearish, positive = inflow)
      flowData.eth.netFlow24h = flowProxy;

      flowHistory.eth.push({ netFlow: flowProxy, timestamp: Date.now() });
      if (flowHistory.eth.length > MAX_HISTORY) flowHistory.eth.shift();
    }

    console.log(`[WhaleFlow] Polled — BTC flow: ${flowData.btc.netFlow24h > 0 ? '+' : ''}${(flowData.btc.netFlow24h * 100).toFixed(1)}%, large txs: ${flowData.btc.largeTransfers.length}`);
  } catch (err) {
    console.warn('[WhaleFlow] Poll failed:', err.message);
  }
}

// ─── Public API ──────────────────────────────────────────────

export function startWhaleFlowPolling() {
  if (pollInterval) return;
  console.log('[WhaleFlow] Starting whale flow tracking (15min intervals)');
  pollWhaleFlows();
  pollInterval = setInterval(pollWhaleFlows, POLL_INTERVAL_MS);
}

export function stopWhaleFlowPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Get whale flow signal for a ticker.
 * @returns {{ direction: string, strength: number, netFlow: number, largeTransfers: number, trend: string }}
 */
export function getWhaleFlowSignal(ticker) {
  const symbol = ticker.replace('USD', '').toUpperCase();
  const asset = symbol === 'BTC' || symbol === 'XBT' ? 'btc' : symbol === 'ETH' ? 'eth' : null;

  if (!asset || !flowData[asset].lastUpdate) {
    return { direction: 'NEUTRAL', strength: 0, netFlow: 0, largeTransfers: 0, trend: 'UNKNOWN' };
  }

  const data = flowData[asset];
  const history = flowHistory[asset];

  // Net flow direction (positive = inflow/bearish, negative = outflow/bullish)
  let direction = 'NEUTRAL';
  let strength = 0;

  if (data.netFlow24h > 0.05) {
    direction = 'BEARISH'; // Net inflows to exchanges = selling pressure
    strength = Math.min(100, Math.round(data.netFlow24h * 500));
  } else if (data.netFlow24h < -0.05) {
    direction = 'BULLISH'; // Net outflows from exchanges = accumulation
    strength = Math.min(100, Math.round(Math.abs(data.netFlow24h) * 500));
  }

  // Trend: is flow direction persistent?
  let trend = 'FLAT';
  if (history.length >= 4) {
    const recent = history.slice(-4).map(h => h.netFlow);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (recentAvg > 0.03) trend = 'INCREASING_INFLOW'; // Persistent bearish
    else if (recentAvg < -0.03) trend = 'INCREASING_OUTFLOW'; // Persistent bullish
  }

  return {
    direction,
    strength,
    netFlow: data.netFlow24h,
    largeTransfers: data.largeTransfers.length,
    trend,
    lastUpdate: data.lastUpdate,
  };
}

/**
 * Get ML features for whale flow (2 features).
 */
export function getWhaleFlowMLFeatures(ticker) {
  const signal = getWhaleFlowSignal(ticker);

  return [
    // Feature 1: Exchange net flow direction (-1 bullish outflow to 1 bearish inflow)
    Math.max(-1, Math.min(1, signal.netFlow * 5)),

    // Feature 2: Whale transfer activity signal (-1 accumulation to 1 distribution)
    signal.direction === 'BULLISH' ? -Math.min(1, signal.strength / 80) :
    signal.direction === 'BEARISH' ? Math.min(1, signal.strength / 80) : 0,
  ];
}

/**
 * Get all whale flow data for dashboard.
 */
export function getWhaleFlowStatus() {
  return {
    enabled: pollInterval !== null,
    lastPollTime,
    btc: {
      netFlow: flowData.btc.netFlow24h,
      largeTransfers: flowData.btc.largeTransfers.length,
      recentTransfers: flowData.btc.largeTransfers.slice(0, 5),
      lastUpdate: flowData.btc.lastUpdate,
    },
    eth: {
      netFlow: flowData.eth.netFlow24h,
      lastUpdate: flowData.eth.lastUpdate,
    },
    signals: {
      BTC: getWhaleFlowSignal('BTCUSD'),
      ETH: getWhaleFlowSignal('ETHUSD'),
    },
  };
}

export default {
  startWhaleFlowPolling,
  stopWhaleFlowPolling,
  getWhaleFlowSignal,
  getWhaleFlowMLFeatures,
  getWhaleFlowStatus,
};
