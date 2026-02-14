/**
 * Order Book Service (Backend)
 *
 * Analyzes order book depth, imbalance, and walls.
 * Used for short-term direction prediction and entry/exit optimization.
 *
 * Requirement 37
 */

/**
 * Analyze order book for a given ticker
 * @param {Object} orderBook - { bids: [[price, qty, count], ...], asks: [...] }
 * @returns {Object} Analysis result
 */
export function analyzeOrderBook(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks || orderBook.bids.length === 0 || orderBook.asks.length === 0) {
    return { imbalance: 0, walls: [], direction: 'NEUTRAL', bidDepth: 0, askDepth: 0 };
  }

  // Crypto.com format: bids: [[price, quantity, count], ...]
  const bids = orderBook.bids;
  const asks = orderBook.asks;

  // 1. Calculate Imbalance (Top 10 levels)
  const bidDepth = bids.slice(0, 10).reduce((sum, level) => sum + parseFloat(level[1]), 0);
  const askDepth = asks.slice(0, 10).reduce((sum, level) => sum + parseFloat(level[1]), 0);
  
  // Imbalance ratio: 1.0 = all bids, -1.0 = all asks, 0.0 = balanced
  const imbalance = (bidDepth + askDepth) > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;

  // 2. Detect Walls (Depth > 5x average of neighboring levels)
  const walls = [];
  
  const detectWallsInSide = (levels, type) => {
    for (let i = 0; i < Math.min(levels.length - 5, 20); i++) {
      const qty = parseFloat(levels[i][1]);
      const nextAvg = levels.slice(i + 1, i + 6).reduce((sum, l) => sum + parseFloat(l[1]), 0) / 5;
      
      if (nextAvg > 0 && qty > nextAvg * 5) {
        walls.push({
          type,
          price: parseFloat(levels[i][0]),
          quantity: qty,
          strength: Math.round(qty / nextAvg),
          distancePercent: Math.abs((parseFloat(levels[i][0]) - parseFloat(levels[0][0])) / parseFloat(levels[0][0])) * 100
        });
      }
    }
  };

  detectWallsInSide(bids, 'BUY_WALL');
  detectWallsInSide(asks, 'SELL_WALL');

  // 3. Directional Prediction
  let direction = 'NEUTRAL';
  let confidence = Math.abs(imbalance) * 100;

  if (imbalance > 0.4) direction = 'BULLISH';
  else if (imbalance < -0.4) direction = 'BEARISH';

  // Wall-adjusted direction
  const strongestBuyWall = walls.filter(w => w.type === 'BUY_WALL').sort((a, b) => b.strength - a.strength)[0];
  const strongestSellWall = walls.filter(w => w.type === 'SELL_WALL').sort((a, b) => b.strength - a.strength)[0];

  if (strongestBuyWall && strongestBuyWall.distancePercent < 1 && direction !== 'BEARISH') {
      direction = 'BULLISH';
      confidence = Math.max(confidence, 60);
  } else if (strongestSellWall && strongestSellWall.distancePercent < 1 && direction !== 'BULLISH') {
      direction = 'BEARISH';
      confidence = Math.max(confidence, 60);
  }

  return {
    imbalance: Math.round(imbalance * 100) / 100,
    bidDepth,
    askDepth,
    walls: walls.sort((a, b) => b.strength - a.strength).slice(0, 5),
    direction,
    confidence: Math.round(confidence),
    timestamp: Date.now()
  };
}

/**
 * Calculate optimal entry/exit price based on order book
 * @param {Object} orderBook
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} quantity - Quantity to trade
 * @returns {Object} { price, slippage }
 */
export function optimizeEntryExit(orderBook, side, quantity) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) return null;
    
    const levels = side === 'BUY' ? orderBook.asks : orderBook.bids;
    let remaining = quantity;
    let totalValue = 0;
    
    for (const level of levels) {
        const levelPrice = parseFloat(level[0]);
        const levelQty = parseFloat(level[1]);
        const fill = Math.min(remaining, levelQty);
        
        totalValue += fill * levelPrice;
        remaining -= fill;
        
        if (remaining <= 0) break;
    }
    
    const avgPrice = totalValue / (quantity - remaining);
    const bestPrice = parseFloat(levels[0][0]);
    const slippage = Math.abs(avgPrice - bestPrice) / bestPrice;
    
    return {
        price: avgPrice,
        slippagePercent: slippage * 100,
        isLiquiditySufficient: remaining === 0
    };
}
