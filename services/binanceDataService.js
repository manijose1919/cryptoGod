import fetch from 'node-fetch';

// Rate limiting tracking
const rateLimitTracker = {
  requestCount: 0,
  windowStart: Date.now(),
  maxRequestsPerMinute: 1200,
  currentWeight: 0,
  maxWeight: 1200
};

// In-memory cache
const cache = new Map();

const CACHE_TTL = {
  orderbook: 5000,    // 5 seconds
  trades: 10000,      // 10 seconds
  candles: 30000,     // 30 seconds
  stats: 60000        // 60 seconds
};

/**
 * Maps project tickers (BTCUSD, ETHUSD) to Binance symbols (BTCUSDT, ETHUSDT)
 */
function toBinanceSymbol(ticker) {
  if (!ticker) return null;

  // If already ends with USDT, return as-is
  if (ticker.endsWith('USDT')) return ticker;

  // If ends with USD, replace with USDT
  if (ticker.endsWith('USD')) {
    return ticker.replace(/USD$/, 'USDT');
  }

  // Otherwise, assume it's a base currency and append USDT
  return `${ticker}USDT`;
}

/**
 * Check and update rate limit tracker
 */
function checkRateLimit(weight = 1) {
  const now = Date.now();
  const windowDuration = 60000; // 1 minute

  // Reset window if needed
  if (now - rateLimitTracker.windowStart >= windowDuration) {
    rateLimitTracker.requestCount = 0;
    rateLimitTracker.currentWeight = 0;
    rateLimitTracker.windowStart = now;
  }

  // Check if we're over the limit
  if (rateLimitTracker.currentWeight + weight > rateLimitTracker.maxWeight) {
    console.warn('[BinanceData] Rate limit approaching, throttling request');
    return false;
  }

  // Update counters
  rateLimitTracker.requestCount++;
  rateLimitTracker.currentWeight += weight;

  return true;
}

/**
 * Get cached data if available and not expired
 */
function getCached(key) {
  const cached = cache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > cached.ttl) {
    cache.delete(key);
    return null;
  }

  return cached.data;
}

/**
 * Store data in cache
 */
function setCache(key, data, ttl) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
}

/**
 * Make a request to Binance API
 */
async function binanceRequest(endpoint, params = {}, weight = 1) {
  if (!checkRateLimit(weight)) {
    console.warn('[BinanceData] Rate limit exceeded, skipping request');
    return null;
  }

  try {
    const queryString = new URLSearchParams(params).toString();
    const url = `https://api.binance.com${endpoint}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BinanceData] API error ${response.status}:`, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('[BinanceData] Request failed:', error.message);
    return null;
  }
}

/**
 * Get order book depth
 * Returns { bids, asks, bidTotal, askTotal, imbalance, spread, spreadPercent, timestamp }
 */
export async function getOrderBook(ticker, limit = 20) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) {
    console.error('[BinanceData] Invalid ticker:', ticker);
    return null;
  }

  const cacheKey = `orderbook:${symbol}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await binanceRequest('/api/v3/depth', { symbol, limit }, limit <= 100 ? 1 : 5);
  if (!data || !data.bids || !data.asks) return null;

  // Parse bids and asks (they come as string arrays)
  const bids = data.bids.map(([price, qty]) => ({
    price: parseFloat(price),
    quantity: parseFloat(qty)
  }));

  const asks = data.asks.map(([price, qty]) => ({
    price: parseFloat(price),
    quantity: parseFloat(qty)
  }));

  // Calculate totals
  const bidTotal = bids.reduce((sum, bid) => sum + (bid.price * bid.quantity), 0);
  const askTotal = asks.reduce((sum, ask) => sum + (ask.price * ask.quantity), 0);

  // Calculate imbalance (-1 to 1, positive = more buy pressure)
  const imbalance = (bidTotal - askTotal) / (bidTotal + askTotal);

  // Calculate spread
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const spread = bestAsk - bestBid;
  const spreadPercent = bestBid > 0 ? (spread / bestBid) * 100 : 0;

  const result = {
    bids,
    asks,
    bidTotal,
    askTotal,
    imbalance,
    spread,
    spreadPercent,
    timestamp: Date.now()
  };

  setCache(cacheKey, result, CACHE_TTL.orderbook);
  return result;
}

/**
 * Get recent trades
 * Returns { trades, buyVolume, sellVolume, buyRatio, largeTradeRatio, avgTradeSize }
 */
export async function getRecentTrades(ticker, limit = 50) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) {
    console.error('[BinanceData] Invalid ticker:', ticker);
    return null;
  }

  const cacheKey = `trades:${symbol}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await binanceRequest('/api/v3/trades', { symbol, limit }, 1);
  if (!data || !Array.isArray(data)) return null;

  // Parse trades
  const trades = data.map(trade => ({
    id: trade.id,
    price: parseFloat(trade.price),
    quantity: parseFloat(trade.qty),
    time: trade.time,
    isBuyerMaker: trade.isBuyerMaker,
    side: trade.isBuyerMaker ? 'sell' : 'buy' // If buyer is maker, it's a sell order being filled
  }));

  // Calculate metrics
  let buyVolume = 0;
  let sellVolume = 0;
  let totalVolume = 0;

  trades.forEach(trade => {
    const volume = trade.price * trade.quantity;
    totalVolume += volume;

    if (trade.side === 'buy') {
      buyVolume += volume;
    } else {
      sellVolume += volume;
    }
  });

  const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

  // Calculate average trade size
  const avgTradeSize = trades.length > 0 ? totalVolume / trades.length : 0;

  // Count large trades (> 2x average)
  const largeTrades = trades.filter(trade => {
    const tradeSize = trade.price * trade.quantity;
    return tradeSize > avgTradeSize * 2;
  });

  const largeTradeRatio = trades.length > 0 ? largeTrades.length / trades.length : 0;

  const result = {
    trades,
    buyVolume,
    sellVolume,
    buyRatio,
    largeTradeRatio,
    avgTradeSize
  };

  setCache(cacheKey, result, CACHE_TTL.trades);
  return result;
}

/**
 * Get kline/candle data
 * Returns array of { t, o, h, l, c, v }
 */
export async function getCandles(ticker, interval = '1m', limit = 100) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) {
    console.error('[BinanceData] Invalid ticker:', ticker);
    return null;
  }

  const cacheKey = `candles:${symbol}:${interval}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await binanceRequest('/api/v3/klines', { symbol, interval, limit }, 1);
  if (!data || !Array.isArray(data)) return null;

  // Parse candles
  // Binance format: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
  const candles = data.map(kline => ({
    t: kline[0],                    // Open time
    o: parseFloat(kline[1]),        // Open
    h: parseFloat(kline[2]),        // High
    l: parseFloat(kline[3]),        // Low
    c: parseFloat(kline[4]),        // Close
    v: parseFloat(kline[5])         // Volume
  }));

  setCache(cacheKey, candles, CACHE_TTL.candles);
  return candles;
}

/**
 * Get 24hr ticker statistics
 * Returns { price, change24h, changePercent, volume, quoteVolume, high, low }
 */
export async function get24hrStats(ticker) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) {
    console.error('[BinanceData] Invalid ticker:', ticker);
    return null;
  }

  const cacheKey = `stats:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await binanceRequest('/api/v3/ticker/24hr', { symbol }, 1);
  if (!data) return null;

  const result = {
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChange),
    changePercent: parseFloat(data.priceChangePercent),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
    high: parseFloat(data.highPrice),
    low: parseFloat(data.lowPrice),
    openPrice: parseFloat(data.openPrice),
    trades: data.count,
    timestamp: data.closeTime
  };

  setCache(cacheKey, result, CACHE_TTL.stats);
  return result;
}

/**
 * Get aggregated snapshot of all data
 * Combines order book, recent trades, candles, and 24hr stats
 */
export async function getAggregatedSnapshot(ticker) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) {
    console.error('[BinanceData] Invalid ticker:', ticker);
    return null;
  }

  try {
    // Fetch all data in parallel
    const [orderBook, trades, candles, stats] = await Promise.all([
      getOrderBook(ticker, 20),
      getRecentTrades(ticker, 50),
      getCandles(ticker, '1m', 100),
      get24hrStats(ticker)
    ]);

    return {
      ticker,
      binanceSymbol: symbol,
      orderBook,
      trades,
      candles,
      stats,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('[BinanceData] Failed to get aggregated snapshot:', error.message);
    return null;
  }
}

/**
 * Get rate limit status
 */
export function getRateLimitStatus() {
  const now = Date.now();
  const windowRemaining = 60000 - (now - rateLimitTracker.windowStart);

  return {
    requestCount: rateLimitTracker.requestCount,
    currentWeight: rateLimitTracker.currentWeight,
    maxWeight: rateLimitTracker.maxWeight,
    windowRemainingMs: Math.max(0, windowRemaining),
    utilizationPercent: (rateLimitTracker.currentWeight / rateLimitTracker.maxWeight) * 100
  };
}

/**
 * Clear cache (useful for testing or manual refresh)
 */
export function clearCache() {
  cache.clear();
  console.log('[BinanceData] Cache cleared');
}

export default {
  getOrderBook,
  getRecentTrades,
  getCandles,
  get24hrStats,
  getAggregatedSnapshot,
  getRateLimitStatus,
  clearCache,
  toBinanceSymbol
};
