/**
 * Smart Order Execution Engine
 * Handles intelligent order routing with slippage estimation, TWAP splitting,
 * limit-then-market fallback, and execution quality tracking.
 */

import http from 'node:http';
import { getFlag } from './systemConfig.js';
import { getSetting, setSetting, getDb } from './database.js';

// ============================================
// KEEP-ALIVE HTTP AGENT
// ============================================

let _keepAliveAgent = null;

export function getKeepAliveAgent() {
  if (!_keepAliveAgent) {
    _keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });
  }
  return _keepAliveAgent;
}

// ============================================
// INTERNAL STATE
// ============================================

const MAX_RECENT_EXECUTIONS = 100;
const recentExecutions = [];

const TWAP_CHUNK_DELAY_MS = 12000;  // 12 seconds between TWAP chunks
const LIMIT_WAIT_MS = 10000;        // Wait 10s for limit order fill
const VOLUME_THRESHOLD_PCT = 0.05;  // 5% of estimated 1h volume triggers TWAP

// ============================================
// DATABASE: execution_metrics table
// ============================================

let _tableInitialized = false;

function ensureTable() {
  if (_tableInitialized) return;
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS execution_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        estimated_slippage REAL DEFAULT 0,
        actual_slippage REAL DEFAULT 0,
        fill_rate REAL DEFAULT 1,
        execution_time_ms INTEGER DEFAULT 0,
        order_type TEXT DEFAULT 'MARKET',
        timestamp INTEGER DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_execution_metrics_ticker
        ON execution_metrics(ticker, timestamp);
    `);
    _tableInitialized = true;
  } catch (e) {
    // Table may already exist, that is fine
    _tableInitialized = true;
  }
}

export function insertExecutionMetric(metric) {
  ensureTable();
  try {
    return getDb().prepare(`
      INSERT INTO execution_metrics (ticker, side, estimated_slippage, actual_slippage, fill_rate, execution_time_ms, order_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metric.ticker,
      metric.side,
      metric.estimated_slippage || 0,
      metric.actual_slippage || 0,
      metric.fill_rate ?? 1,
      metric.execution_time_ms || 0,
      metric.order_type || 'MARKET',
      metric.timestamp || Date.now()
    );
  } catch (e) {
    console.warn('[ExecutionEngine] Failed to insert metric:', e.message);
  }
}

// ============================================
// SLIPPAGE ESTIMATION
// ============================================

/**
 * Estimate slippage by walking the order book.
 * @param {Object} orderBook - { bids: [[price, qty, count], ...], asks: [[price, qty, count], ...] }
 * @param {number} notional - USD amount to fill (for buys) or quantity * price estimate (for sells)
 * @param {'BUY'|'SELL'} side
 * @returns {{ slippagePct: number, vwap: number, bestPrice: number, depthAvailable: number }}
 */
export function estimateSlippage(orderBook, notional, side) {
  if (!orderBook) {
    return { slippagePct: 0, vwap: 0, bestPrice: 0, depthAvailable: 0 };
  }

  // For buys we walk the asks (ascending price), for sells we walk the bids (descending price)
  const levels = side === 'BUY' ? (orderBook.asks || []) : (orderBook.bids || []);

  if (levels.length === 0) {
    return { slippagePct: 0, vwap: 0, bestPrice: 0, depthAvailable: 0 };
  }

  const bestPrice = parseFloat(levels[0][0]);
  if (bestPrice <= 0) {
    return { slippagePct: 0, vwap: 0, bestPrice: 0, depthAvailable: 0 };
  }

  let remainingNotional = notional;
  let totalCost = 0;
  let totalQty = 0;

  for (const level of levels) {
    const price = parseFloat(level[0]);
    const qty = parseFloat(level[1]);
    if (price <= 0 || qty <= 0) continue;

    const levelNotional = price * qty;

    if (levelNotional >= remainingNotional) {
      // This level can fill the remainder
      const fillQty = remainingNotional / price;
      totalCost += fillQty * price;
      totalQty += fillQty;
      remainingNotional = 0;
      break;
    } else {
      // Consume the entire level
      totalCost += qty * price;
      totalQty += qty;
      remainingNotional -= levelNotional;
    }
  }

  const depthAvailable = notional - remainingNotional;
  const vwap = totalQty > 0 ? totalCost / totalQty : bestPrice;

  // Slippage: how far the VWAP deviates from best price
  const slippagePct = side === 'BUY'
    ? ((vwap - bestPrice) / bestPrice) * 100
    : ((bestPrice - vwap) / bestPrice) * 100;

  return {
    slippagePct: Math.max(0, slippagePct),
    vwap,
    bestPrice,
    depthAvailable,
  };
}

// ============================================
// HELPERS
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeMidPrice(orderBook) {
  if (!orderBook) return 0;
  const bestBid = orderBook.bids?.[0] ? parseFloat(orderBook.bids[0][0]) : 0;
  const bestAsk = orderBook.asks?.[0] ? parseFloat(orderBook.asks[0][0]) : 0;
  if (bestBid <= 0 || bestAsk <= 0) return bestBid || bestAsk;
  return (bestBid + bestAsk) / 2;
}

function estimateHourlyVolume(orderBook) {
  // Rough heuristic: sum visible book depth * 20 as 1h volume proxy
  // Real implementation would use recent trade history
  if (!orderBook) return Infinity;
  let totalNotional = 0;
  for (const level of (orderBook.asks || [])) {
    totalNotional += parseFloat(level[0]) * parseFloat(level[1]);
  }
  for (const level of (orderBook.bids || [])) {
    totalNotional += parseFloat(level[0]) * parseFloat(level[1]);
  }
  return totalNotional * 20; // Scale visible depth to approximate hourly volume
}

function recordExecution(exec) {
  recentExecutions.push(exec);
  if (recentExecutions.length > MAX_RECENT_EXECUTIONS) {
    recentExecutions.shift();
  }
}

function adapterSupportsLimitOrders(adapter) {
  try {
    // Check if placeLimitBuyOrder is overridden from BaseExchangeAdapter
    const proto = Object.getPrototypeOf(adapter);
    const hasLimit = proto.hasOwnProperty('placeLimitBuyOrder') ||
                     (typeof adapter.placeLimitBuyOrder === 'function' &&
                      !adapter.placeLimitBuyOrder.toString().includes('not supported'));
    return hasLimit;
  } catch {
    return false;
  }
}

function adapterIsSimulation(adapter) {
  // If the adapter lacks real order methods, treat as simulation
  try {
    if (typeof adapter.placeBuyOrder !== 'function') return true;
    const name = adapter.getName?.() || '';
    return name.toLowerCase().includes('sim') || name.toLowerCase().includes('paper');
  } catch {
    return true;
  }
}

// ============================================
// SMART BUY EXECUTION
// ============================================

/**
 * Execute a smart buy order with slippage estimation, optional TWAP, and limit-then-market fallback.
 * @param {BaseExchangeAdapter} adapter
 * @param {string} ticker
 * @param {number} notional - USD amount to buy
 * @param {string} sessionId
 * @param {Object} [orderBook] - Pre-fetched order book (optional; will fetch if missing)
 * @returns {Promise<Object>} { avgPrice, totalQty, fills, slippage, executionTimeMs }
 */
export async function executeSmartBuy(adapter, ticker, notional, sessionId, orderBook) {
  const startTime = Date.now();

  // Check feature flag — if disabled, pass through directly
  try {
    if (!getFlag('SMART_EXECUTION_ENABLED')) {
      return await executeDirectBuy(adapter, ticker, notional, sessionId, startTime);
    }
  } catch {
    // Flag system not available, proceed with smart execution
  }

  try {
    // Fetch order book if not provided
    if (!orderBook) {
      try {
        orderBook = await adapter.getOrderBook(ticker, 20);
      } catch {
        // No order book available — fall back to direct execution
        return await executeDirectBuy(adapter, ticker, notional, sessionId, startTime);
      }
    }

    const estimation = estimateSlippage(orderBook, notional, 'BUY');
    const hourlyVolume = estimateHourlyVolume(orderBook);
    const needsTwap = notional > hourlyVolume * VOLUME_THRESHOLD_PCT;

    // Simulation mode: simulate fill at estimated price
    if (adapterIsSimulation(adapter)) {
      const fillPrice = estimation.vwap > 0 ? estimation.vwap : computeMidPrice(orderBook);
      const simQty = fillPrice > 0 ? notional / fillPrice : 0;
      const result = {
        avgPrice: fillPrice,
        totalQty: simQty,
        fills: [{ price: fillPrice, qty: simQty, type: 'SIMULATED' }],
        slippage: {
          estimatedSlippage: estimation.slippagePct,
          actualSlippage: estimation.slippagePct,
          fillRate: 1,
          executionTimeMs: Date.now() - startTime,
        },
        executionTimeMs: Date.now() - startTime,
      };
      recordAndPersist(ticker, 'BUY', result);
      return result;
    }

    // TWAP splitting for large orders
    if (needsTwap) {
      return await executeTwapBuy(adapter, ticker, notional, sessionId, orderBook, estimation, startTime);
    }

    // Single order: try limit first, then fall back to market
    return await executeLimitThenMarketBuy(adapter, ticker, notional, sessionId, orderBook, estimation, startTime);
  } catch (err) {
    console.warn(`[ExecutionEngine] Smart buy failed for ${ticker}, falling back to direct:`, err.message);
    return await executeDirectBuy(adapter, ticker, notional, sessionId, startTime);
  }
}

// ============================================
// SMART SELL EXECUTION
// ============================================

/**
 * Execute a smart sell order with slippage estimation, optional TWAP, and limit-then-market fallback.
 * @param {BaseExchangeAdapter} adapter
 * @param {string} ticker
 * @param {number} quantity - Amount to sell
 * @param {string} sessionId
 * @param {Object} [orderBook] - Pre-fetched order book (optional)
 * @returns {Promise<Object>} { avgPrice, totalQty, fills, slippage, executionTimeMs }
 */
export async function executeSmartSell(adapter, ticker, quantity, sessionId, orderBook) {
  const startTime = Date.now();

  // Check feature flag
  try {
    if (!getFlag('SMART_EXECUTION_ENABLED')) {
      return await executeDirectSell(adapter, ticker, quantity, sessionId, startTime);
    }
  } catch {
    // Flag system not available, proceed with smart execution
  }

  try {
    if (!orderBook) {
      try {
        orderBook = await adapter.getOrderBook(ticker, 20);
      } catch {
        return await executeDirectSell(adapter, ticker, quantity, sessionId, startTime);
      }
    }

    const bestBid = orderBook.bids?.[0] ? parseFloat(orderBook.bids[0][0]) : 0;
    const sellNotional = quantity * bestBid;
    const estimation = estimateSlippage(orderBook, sellNotional, 'SELL');
    const hourlyVolume = estimateHourlyVolume(orderBook);
    const needsTwap = sellNotional > hourlyVolume * VOLUME_THRESHOLD_PCT;

    // Simulation mode
    if (adapterIsSimulation(adapter)) {
      const fillPrice = estimation.vwap > 0 ? estimation.vwap : bestBid;
      const result = {
        avgPrice: fillPrice,
        totalQty: quantity,
        fills: [{ price: fillPrice, qty: quantity, type: 'SIMULATED' }],
        slippage: {
          estimatedSlippage: estimation.slippagePct,
          actualSlippage: estimation.slippagePct,
          fillRate: 1,
          executionTimeMs: Date.now() - startTime,
        },
        executionTimeMs: Date.now() - startTime,
      };
      recordAndPersist(ticker, 'SELL', result);
      return result;
    }

    if (needsTwap) {
      return await executeTwapSell(adapter, ticker, quantity, sessionId, orderBook, estimation, startTime);
    }

    return await executeLimitThenMarketSell(adapter, ticker, quantity, sessionId, orderBook, estimation, startTime);
  } catch (err) {
    console.warn(`[ExecutionEngine] Smart sell failed for ${ticker}, falling back to direct:`, err.message);
    return await executeDirectSell(adapter, ticker, quantity, sessionId, startTime);
  }
}

// ============================================
// DIRECT FALLBACK EXECUTION
// ============================================

async function executeDirectBuy(adapter, ticker, notional, sessionId, startTime) {
  const orderResult = await adapter.placeBuyOrder(ticker, notional, sessionId);
  const avgPrice = parseFloat(orderResult.avgPrice || orderResult.avg_price || 0);
  const totalQty = parseFloat(orderResult.quantity || orderResult.filled_quantity || 0);
  const result = {
    avgPrice,
    totalQty,
    fills: [{ price: avgPrice, qty: totalQty, type: 'MARKET_DIRECT' }],
    slippage: {
      estimatedSlippage: 0,
      actualSlippage: 0,
      fillRate: 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };
  recordAndPersist(ticker, 'BUY', result);
  return result;
}

async function executeDirectSell(adapter, ticker, quantity, sessionId, startTime) {
  const orderResult = await adapter.placeSellOrder(ticker, quantity, sessionId);
  const avgPrice = parseFloat(orderResult.avgPrice || orderResult.avg_price || 0);
  const totalQty = parseFloat(orderResult.filledQuantity || orderResult.filled_quantity || quantity);
  const result = {
    avgPrice,
    totalQty,
    fills: [{ price: avgPrice, qty: totalQty, type: 'MARKET_DIRECT' }],
    slippage: {
      estimatedSlippage: 0,
      actualSlippage: 0,
      fillRate: 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };
  recordAndPersist(ticker, 'SELL', result);
  return result;
}

// ============================================
// LIMIT-THEN-MARKET EXECUTION
// ============================================

async function executeLimitThenMarketBuy(adapter, ticker, notional, sessionId, orderBook, estimation, startTime) {
  const fills = [];
  let filledNotional = 0;
  let totalQty = 0;
  let orderType = 'MARKET';

  // Attempt limit order at mid-price if adapter supports it
  if (adapterSupportsLimitOrders(adapter)) {
    const midPrice = computeMidPrice(orderBook);
    if (midPrice > 0) {
      const limitQty = notional / midPrice;
      try {
        const limitResult = await adapter.placeLimitBuyOrder(ticker, midPrice, limitQty, sessionId);
        const orderId = limitResult.orderId;

        if (orderId) {
          // Wait for fill
          await sleep(LIMIT_WAIT_MS);

          const status = await adapter.getOrderStatus(orderId, sessionId);
          const filledQty = parseFloat(status.filledQty || 0);
          const fillPrice = parseFloat(status.avgPrice || midPrice);

          if (filledQty > 0) {
            fills.push({ price: fillPrice, qty: filledQty, type: 'LIMIT' });
            totalQty += filledQty;
            filledNotional += filledQty * fillPrice;
            orderType = filledQty >= limitQty * 0.99 ? 'LIMIT' : 'LIMIT_PARTIAL';
          }

          // Cancel remainder if not fully filled
          if (filledQty < limitQty * 0.99) {
            try { await adapter.cancelOrder(orderId, sessionId); } catch { /* already filled or cancelled */ }
          }
        }
      } catch (e) {
        console.warn(`[ExecutionEngine] Limit buy failed for ${ticker}:`, e.message);
      }
    }
  }

  // Fill remainder with market order
  const remainingNotional = notional - filledNotional;
  if (remainingNotional > 1) { // Minimum $1 to avoid dust orders
    const marketResult = await adapter.placeBuyOrder(ticker, remainingNotional, sessionId);
    const mPrice = parseFloat(marketResult.avgPrice || marketResult.avg_price || 0);
    const mQty = parseFloat(marketResult.quantity || marketResult.filled_quantity || 0);
    if (mQty > 0) {
      fills.push({ price: mPrice, qty: mQty, type: 'MARKET' });
      totalQty += mQty;
      filledNotional += mQty * mPrice;
      if (orderType === 'LIMIT_PARTIAL') orderType = 'LIMIT_THEN_MARKET';
      else if (orderType !== 'LIMIT') orderType = 'MARKET';
    }
  }

  const avgPrice = totalQty > 0 ? filledNotional / totalQty : 0;
  const actualSlippage = estimation.bestPrice > 0
    ? ((avgPrice - estimation.bestPrice) / estimation.bestPrice) * 100
    : 0;

  const result = {
    avgPrice,
    totalQty,
    fills,
    slippage: {
      estimatedSlippage: estimation.slippagePct,
      actualSlippage: Math.max(0, actualSlippage),
      fillRate: notional > 0 ? Math.min(1, filledNotional / notional) : 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };

  recordAndPersist(ticker, 'BUY', result, orderType);
  return result;
}

async function executeLimitThenMarketSell(adapter, ticker, quantity, sessionId, orderBook, estimation, startTime) {
  const fills = [];
  let filledQty = 0;
  let totalRevenue = 0;
  let orderType = 'MARKET';

  // Hoisted for use in the dust-check fallback below (M17).
  const midPrice = computeMidPrice(orderBook);

  if (adapterSupportsLimitOrders(adapter)) {
    if (midPrice > 0) {
      try {
        const limitResult = await adapter.placeLimitSellOrder(ticker, midPrice, quantity, sessionId);
        const orderId = limitResult.orderId;

        if (orderId) {
          await sleep(LIMIT_WAIT_MS);

          const status = await adapter.getOrderStatus(orderId, sessionId);
          const sFilled = parseFloat(status.filledQty || 0);
          const sPrice = parseFloat(status.avgPrice || midPrice);

          if (sFilled > 0) {
            fills.push({ price: sPrice, qty: sFilled, type: 'LIMIT' });
            filledQty += sFilled;
            totalRevenue += sFilled * sPrice;
            orderType = sFilled >= quantity * 0.99 ? 'LIMIT' : 'LIMIT_PARTIAL';
          }

          if (sFilled < quantity * 0.99) {
            try { await adapter.cancelOrder(orderId, sessionId); } catch { /* ok */ }
          }
        }
      } catch (e) {
        console.warn(`[ExecutionEngine] Limit sell failed for ${ticker}:`, e.message);
      }
    }
  }

  // Fill remainder with market (skip dust amounts under $1)
  // M17: previously used `fills[0]?.price || 1` as the value-estimate fallback
  // when the limit got 0 fills. For BTC with remainingQty=0.0001, the check
  // `0.0001 * 1 > 1` = false → market sell never fires → entire position
  // un-exited. Use the midPrice we already computed instead of $1.
  const remainingQty = quantity - filledQty;
  const valueEstimate = remainingQty * (fills[0]?.price || (midPrice > 0 ? midPrice : 0));
  if (remainingQty > 0 && valueEstimate > 1) {
    const marketResult = await adapter.placeSellOrder(ticker, remainingQty, sessionId);
    const mPrice = parseFloat(marketResult.avgPrice || marketResult.avg_price || 0);
    const mQty = parseFloat(marketResult.filledQuantity || marketResult.filled_quantity || remainingQty);
    if (mQty > 0) {
      fills.push({ price: mPrice, qty: mQty, type: 'MARKET' });
      filledQty += mQty;
      totalRevenue += mQty * mPrice;
      if (orderType === 'LIMIT_PARTIAL') orderType = 'LIMIT_THEN_MARKET';
      else if (orderType !== 'LIMIT') orderType = 'MARKET';
    }
  }

  const avgPrice = filledQty > 0 ? totalRevenue / filledQty : 0;
  const actualSlippage = estimation.bestPrice > 0
    ? ((estimation.bestPrice - avgPrice) / estimation.bestPrice) * 100
    : 0;

  const result = {
    avgPrice,
    totalQty: filledQty,
    fills,
    slippage: {
      estimatedSlippage: estimation.slippagePct,
      actualSlippage: Math.max(0, actualSlippage),
      fillRate: quantity > 0 ? Math.min(1, filledQty / quantity) : 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };

  recordAndPersist(ticker, 'SELL', result, orderType);
  return result;
}

// ============================================
// TWAP EXECUTION
// ============================================

async function executeTwapBuy(adapter, ticker, notional, sessionId, orderBook, estimation, startTime) {
  const chunkCount = notional > estimation.depthAvailable * 2 ? 5 : 3;
  const chunkSize = notional / chunkCount;
  const fills = [];
  let totalCost = 0;
  let totalQty = 0;

  console.log(`[ExecutionEngine] TWAP BUY ${ticker}: $${notional.toFixed(2)} in ${chunkCount} chunks of $${chunkSize.toFixed(2)}`);

  for (let i = 0; i < chunkCount; i++) {
    try {
      const orderResult = await adapter.placeBuyOrder(ticker, chunkSize, sessionId);
      const price = parseFloat(orderResult.avgPrice || orderResult.avg_price || 0);
      const qty = parseFloat(orderResult.quantity || orderResult.filled_quantity || 0);
      if (qty > 0) {
        fills.push({ price, qty, type: 'TWAP', chunk: i + 1 });
        totalCost += qty * price;
        totalQty += qty;
      }
    } catch (e) {
      console.warn(`[ExecutionEngine] TWAP chunk ${i + 1}/${chunkCount} failed:`, e.message);
    }

    // Delay between chunks (skip after last)
    if (i < chunkCount - 1) {
      await sleep(TWAP_CHUNK_DELAY_MS);
    }
  }

  const avgPrice = totalQty > 0 ? totalCost / totalQty : 0;
  const actualSlippage = estimation.bestPrice > 0
    ? ((avgPrice - estimation.bestPrice) / estimation.bestPrice) * 100
    : 0;

  const result = {
    avgPrice,
    totalQty,
    fills,
    slippage: {
      estimatedSlippage: estimation.slippagePct,
      actualSlippage: Math.max(0, actualSlippage),
      fillRate: notional > 0 ? totalCost / notional : 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };

  recordAndPersist(ticker, 'BUY', result, 'TWAP');
  return result;
}

async function executeTwapSell(adapter, ticker, quantity, sessionId, orderBook, estimation, startTime) {
  const chunkCount = quantity * estimation.bestPrice > estimation.depthAvailable * 2 ? 5 : 3;
  const chunkSize = quantity / chunkCount;
  const fills = [];
  let totalRevenue = 0;
  let totalQty = 0;

  console.log(`[ExecutionEngine] TWAP SELL ${ticker}: ${quantity} in ${chunkCount} chunks of ${chunkSize.toFixed(8)}`);

  for (let i = 0; i < chunkCount; i++) {
    try {
      const orderResult = await adapter.placeSellOrder(ticker, chunkSize, sessionId);
      const price = parseFloat(orderResult.avgPrice || orderResult.avg_price || 0);
      const qty = parseFloat(orderResult.filledQuantity || orderResult.filled_quantity || chunkSize);
      if (qty > 0) {
        fills.push({ price, qty, type: 'TWAP', chunk: i + 1 });
        totalRevenue += qty * price;
        totalQty += qty;
      }
    } catch (e) {
      console.warn(`[ExecutionEngine] TWAP sell chunk ${i + 1}/${chunkCount} failed:`, e.message);
    }

    if (i < chunkCount - 1) {
      await sleep(TWAP_CHUNK_DELAY_MS);
    }
  }

  const avgPrice = totalQty > 0 ? totalRevenue / totalQty : 0;
  const actualSlippage = estimation.bestPrice > 0
    ? ((estimation.bestPrice - avgPrice) / estimation.bestPrice) * 100
    : 0;

  const result = {
    avgPrice,
    totalQty,
    fills,
    slippage: {
      estimatedSlippage: estimation.slippagePct,
      actualSlippage: Math.max(0, actualSlippage),
      fillRate: quantity > 0 ? totalQty / quantity : 1,
      executionTimeMs: Date.now() - startTime,
    },
    executionTimeMs: Date.now() - startTime,
  };

  recordAndPersist(ticker, 'SELL', result, 'TWAP');
  return result;
}

// ============================================
// RECORDING & PERSISTENCE
// ============================================

function recordAndPersist(ticker, side, result, orderType) {
  const exec = {
    ticker,
    side,
    estimatedSlippage: result.slippage.estimatedSlippage,
    actualSlippage: result.slippage.actualSlippage,
    fillRate: result.slippage.fillRate,
    executionTimeMs: result.executionTimeMs,
    orderType: orderType || (result.fills?.[0]?.type || 'MARKET'),
    timestamp: Date.now(),
  };

  recordExecution(exec);

  try {
    insertExecutionMetric({
      ticker,
      side,
      estimated_slippage: exec.estimatedSlippage,
      actual_slippage: exec.actualSlippage,
      fill_rate: exec.fillRate,
      execution_time_ms: exec.executionTimeMs,
      order_type: exec.orderType,
      timestamp: exec.timestamp,
    });
  } catch {
    // Non-critical — do not let persistence failure block execution
  }
}

// ============================================
// EXECUTION STATS
// ============================================

/**
 * Get rolling execution quality metrics from recentExecutions.
 * @returns {{ totalExecutions, avgEstimatedSlippage, avgActualSlippage, avgFillRate, avgExecutionTimeMs, slippageSavings, limitFillRate }}
 */
export function getExecutionStats() {
  if (recentExecutions.length === 0) {
    return {
      totalExecutions: 0,
      avgEstimatedSlippage: 0,
      avgActualSlippage: 0,
      avgFillRate: 1,
      avgExecutionTimeMs: 0,
      slippageSavings: 0,
      limitFillRate: 0,
    };
  }

  const n = recentExecutions.length;
  let sumEstSlip = 0, sumActSlip = 0, sumFillRate = 0, sumExecTime = 0;
  let limitAttempts = 0, limitFills = 0;

  for (const exec of recentExecutions) {
    sumEstSlip += exec.estimatedSlippage || 0;
    sumActSlip += exec.actualSlippage || 0;
    sumFillRate += exec.fillRate ?? 1;
    sumExecTime += exec.executionTimeMs || 0;
    if (exec.orderType === 'LIMIT' || exec.orderType === 'LIMIT_THEN_MARKET' || exec.orderType === 'LIMIT_PARTIAL') {
      limitAttempts++;
      if (exec.orderType === 'LIMIT') limitFills++;
    }
  }

  const avgEst = sumEstSlip / n;
  const avgAct = sumActSlip / n;

  return {
    totalExecutions: n,
    avgEstimatedSlippage: parseFloat(avgEst.toFixed(4)),
    avgActualSlippage: parseFloat(avgAct.toFixed(4)),
    avgFillRate: parseFloat((sumFillRate / n).toFixed(4)),
    avgExecutionTimeMs: Math.round(sumExecTime / n),
    slippageSavings: parseFloat((avgEst - avgAct).toFixed(4)),
    limitFillRate: limitAttempts > 0 ? parseFloat((limitFills / limitAttempts).toFixed(4)) : 0,
  };
}
