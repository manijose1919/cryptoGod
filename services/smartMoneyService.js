/**
 * Smart Money / Whale Detection Service
 *
 * Combines order book analysis, derivatives data, and cross-exchange comparison
 * to detect institutional activity and whale positioning.
 *
 * Data sources:
 * - Binance order books (via binanceDataService.js)
 * - OKX derivatives data (via okxDataService.js)
 * - Database exchange snapshots
 */

import { getExchangeSnapshots, getDerivativesHistory } from './database.js';

// Dynamic imports for data services (may not be loaded yet)
let binanceData = null;
let okxData = null;

// State tracking for historical analysis
const orderBookHistory = new Map(); // ticker -> [{timestamp, snapshot, walls}]
const oiHistory = new Map(); // ticker -> [{timestamp, oi, fundingRate}]
const divergenceHistory = new Map(); // ticker -> [{timestamp, divergence}]

const MAX_ORDERBOOK_HISTORY = 100;
const MAX_OI_HISTORY = 50;
const MAX_DIVERGENCE_HISTORY = 20;

// Initialize data services
(async () => {
  try {
    binanceData = await import('./binanceDataService.js');
    console.log('[SmartMoney] Binance data service loaded');
  } catch (e) {
    console.warn('[SmartMoney] Binance data service not available:', e.message);
  }

  try {
    okxData = await import('./okxDataService.js');
    console.log('[SmartMoney] OKX data service loaded');
  } catch (e) {
    console.warn('[SmartMoney] OKX data service not available:', e.message);
  }
})();

/**
 * Detect whale activity from order book analysis
 * @param {string} ticker - Trading pair (e.g., 'BTCUSD')
 * @param {object} options - Detection options
 * @returns {object} Whale detection results
 */
export async function detectWhaleActivity(ticker, options = {}) {
  if (!binanceData) {
    return {
      whaleDetected: false,
      direction: 'NEUTRAL',
      wallsDetected: [],
      confidence: 0,
      error: 'Binance data not available'
    };
  }

  try {
    // Convert ticker to Binance format (BTCUSD -> BTCUSDT)
    const binanceTicker = ticker.replace('USD', 'USDT');

    // Get order book data
    const orderBook = await binanceData.getOrderBook(binanceTicker, options.depth || 100);

    if (!orderBook || !orderBook.bids || !orderBook.asks) {
      return {
        whaleDetected: false,
        direction: 'NEUTRAL',
        wallsDetected: [],
        confidence: 0,
        error: 'No order book data'
      };
    }

    // Calculate average order sizes
    const avgBidSize = orderBook.bids.reduce((sum, [_, size]) => sum + parseFloat(size), 0) / orderBook.bids.length;
    const avgAskSize = orderBook.asks.reduce((sum, [_, size]) => sum + parseFloat(size), 0) / orderBook.asks.length;
    const avgOrderSize = (avgBidSize + avgAskSize) / 2;

    // Detect large orders (>5x average)
    const largeOrderThreshold = avgOrderSize * 5;
    const largeBids = orderBook.bids.filter(([_, size]) => parseFloat(size) >= largeOrderThreshold);
    const largeAsks = orderBook.asks.filter(([_, size]) => parseFloat(size) >= largeOrderThreshold);

    // Get current price (mid price)
    const bestBid = parseFloat(orderBook.bids[0][0]);
    const bestAsk = parseFloat(orderBook.asks[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;

    // Detect walls (within 0.5% of current price)
    const wallThreshold = 0.005; // 0.5%
    const buyWalls = largeBids.filter(([price, _]) => {
      const priceVal = parseFloat(price);
      return Math.abs(priceVal - midPrice) / midPrice <= wallThreshold;
    }).map(([price, size]) => ({
      price: parseFloat(price),
      size: parseFloat(size),
      side: 'BID'
    }));

    const sellWalls = largeAsks.filter(([price, _]) => {
      const priceVal = parseFloat(price);
      return Math.abs(priceVal - midPrice) / midPrice <= wallThreshold;
    }).map(([price, size]) => ({
      price: parseFloat(price),
      size: parseFloat(size),
      side: 'ASK'
    }));

    const allWalls = [...buyWalls, ...sellWalls];

    // Calculate cumulative volume at walls
    const buyWallVolume = buyWalls.reduce((sum, wall) => sum + wall.size, 0);
    const sellWallVolume = sellWalls.reduce((sum, wall) => sum + wall.size, 0);

    // Track history for spoofing detection
    const history = orderBookHistory.get(ticker) || [];
    history.push({
      timestamp: Date.now(),
      snapshot: { bids: orderBook.bids.length, asks: orderBook.asks.length },
      walls: allWalls
    });

    // Keep only recent history
    if (history.length > MAX_ORDERBOOK_HISTORY) {
      history.shift();
    }
    orderBookHistory.set(ticker, history);

    // Detect spoofing (walls appearing/disappearing)
    let spoofingDetected = false;
    if (history.length >= 5) {
      const recentWalls = history.slice(-5);
      const wallCounts = recentWalls.map(h => h.walls.length);
      const variance = wallCounts.reduce((sum, count) => sum + Math.abs(count - wallCounts[0]), 0);
      spoofingDetected = variance > 10; // High variance = potential spoofing
    }

    // Determine direction
    let direction = 'NEUTRAL';
    if (buyWallVolume > sellWallVolume * 1.5) {
      direction = 'ACCUMULATING';
    } else if (sellWallVolume > buyWallVolume * 1.5) {
      direction = 'DISTRIBUTING';
    }

    // Calculate confidence
    const whaleDetected = allWalls.length > 0;
    let confidence = 0;
    if (whaleDetected) {
      confidence = Math.min(100, (allWalls.length * 15) + (spoofingDetected ? 20 : 0));
    }

    return {
      whaleDetected,
      direction,
      wallsDetected: allWalls,
      buyWallVolume,
      sellWallVolume,
      spoofingDetected,
      confidence,
      avgOrderSize
    };

  } catch (error) {
    console.error('[SmartMoney] Error detecting whale activity:', error);
    return {
      whaleDetected: false,
      direction: 'NEUTRAL',
      wallsDetected: [],
      confidence: 0,
      error: error.message
    };
  }
}

/**
 * Detect cross-exchange price divergence
 * @param {string} ticker - Trading pair
 * @returns {object} Divergence analysis
 */
export async function detectCrossExchangeDivergence(ticker) {
  if (!binanceData) {
    return {
      divergence: 0,
      divergencePercent: 0,
      leader: 'UNKNOWN',
      signal: 'NEUTRAL',
      error: 'Binance data not available'
    };
  }

  try {
    // Convert ticker to Binance format
    const binanceTicker = ticker.replace('USD', 'USDT');

    // Get Binance ticker price
    const binancePrice = await binanceData.getTickerPrice(binanceTicker);

    if (!binancePrice) {
      return {
        divergence: 0,
        divergencePercent: 0,
        leader: 'UNKNOWN',
        signal: 'NEUTRAL',
        error: 'No Binance price data'
      };
    }

    // Get Crypto.com price from database snapshots
    const snapshots = await getExchangeSnapshots(ticker, 1);

    if (!snapshots || snapshots.length === 0) {
      return {
        divergence: 0,
        divergencePercent: 0,
        leader: 'UNKNOWN',
        signal: 'NEUTRAL',
        binancePrice,
        error: 'No Crypto.com snapshot data'
      };
    }

    const cryptocomPrice = snapshots[0].price;

    // Calculate divergence
    const divergence = binancePrice - cryptocomPrice;
    const divergencePercent = (divergence / cryptocomPrice) * 100;

    // Track history
    const history = divergenceHistory.get(ticker) || [];
    history.push({
      timestamp: Date.now(),
      divergence: divergencePercent
    });

    if (history.length > MAX_DIVERGENCE_HISTORY) {
      history.shift();
    }
    divergenceHistory.set(ticker, history);

    // Determine leader and signal
    let leader = 'UNKNOWN';
    let signal = 'NEUTRAL';

    if (Math.abs(divergencePercent) > 0.1) {
      // Significant divergence detected
      if (binancePrice > cryptocomPrice) {
        leader = 'BINANCE';
        signal = 'BULLISH'; // Binance leading up
      } else {
        leader = 'CRYPTOCOM';
        signal = 'BEARISH'; // Crypto.com leading up (unusual, potential mean reversion)
      }
    }

    return {
      divergence,
      divergencePercent,
      binancePrice,
      cryptocomPrice,
      leader,
      signal,
      isSignificant: Math.abs(divergencePercent) > 0.1
    };

  } catch (error) {
    console.error('[SmartMoney] Error detecting divergence:', error);
    return {
      divergence: 0,
      divergencePercent: 0,
      leader: 'UNKNOWN',
      signal: 'NEUTRAL',
      error: error.message
    };
  }
}

/**
 * Detect smart money flow from derivatives data
 * @param {string} ticker - Trading pair
 * @returns {object} Smart money flow analysis
 */
export async function detectSmartMoneyFlow(ticker) {
  if (!okxData) {
    return {
      flow: 'NEUTRAL',
      signals: [],
      confidence: 0,
      error: 'OKX data not available'
    };
  }

  try {
    // Convert ticker to OKX format (BTCUSD -> BTC-USDT)
    const okxTicker = ticker.replace('USD', '').replace(/(.+)/, '$1-USDT');

    // Get derivatives data
    const derivativesData = await okxData.getDerivativesData(okxTicker);

    if (!derivativesData) {
      return {
        flow: 'NEUTRAL',
        signals: [],
        confidence: 0,
        error: 'No derivatives data'
      };
    }

    const { fundingRate, openInterest, volume24h } = derivativesData;

    // Track OI history
    const history = oiHistory.get(ticker) || [];
    history.push({
      timestamp: Date.now(),
      oi: openInterest,
      fundingRate
    });

    if (history.length > MAX_OI_HISTORY) {
      history.shift();
    }
    oiHistory.set(ticker, history);

    const signals = [];
    let flow = 'NEUTRAL';
    let confidence = 0;

    // Analyze funding rate extremes
    if (fundingRate > 0.03) {
      signals.push('OVERLEVERAGED_LONGS');
      flow = 'SMART_SELLING';
      confidence += 25;
    } else if (fundingRate < -0.01) {
      signals.push('OVERLEVERAGED_SHORTS');
      flow = 'SMART_BUYING';
      confidence += 25;
    }

    // Analyze OI trends (need at least 10 data points)
    if (history.length >= 10) {
      const recentOI = history.slice(-10);
      const oldOI = recentOI[0].oi;
      const currentOI = recentOI[recentOI.length - 1].oi;
      const oiChange = ((currentOI - oldOI) / oldOI) * 100;

      // Get price snapshot from database
      const snapshots = await getExchangeSnapshots(ticker, 10);

      if (snapshots && snapshots.length >= 10) {
        const oldPrice = snapshots[snapshots.length - 1].price;
        const currentPrice = snapshots[0].price;
        const priceChange = ((currentPrice - oldPrice) / oldPrice) * 100;

        // OI increasing + price flat = smart money positioning
        if (oiChange > 5 && Math.abs(priceChange) < 1) {
          signals.push('SMART_POSITIONING');
          if (fundingRate > 0) {
            flow = 'SMART_SELLING'; // Building shorts
          } else {
            flow = 'SMART_BUYING'; // Building longs
          }
          confidence += 20;
        }

        // OI decreasing + price rising = short squeeze
        if (oiChange < -5 && priceChange > 2) {
          signals.push('SHORT_SQUEEZE');
          flow = 'SMART_BUYING';
          confidence += 30;
        }

        // OI decreasing + price falling = long liquidation
        if (oiChange < -5 && priceChange < -2) {
          signals.push('LONG_LIQUIDATION');
          flow = 'SMART_SELLING';
          confidence += 30;
        }
      }

      // Large OI changes in 1h (institutional activity)
      if (history.length >= 12) { // ~1h of 5min data
        const oneHourAgo = history[history.length - 12].oi;
        const oiChange1h = ((currentOI - oneHourAgo) / oneHourAgo) * 100;

        if (Math.abs(oiChange1h) > 5) {
          signals.push('INSTITUTIONAL_ACTIVITY');
          confidence += 15;

          if (oiChange1h > 0) {
            flow = flow === 'SMART_SELLING' ? flow : 'SMART_BUYING';
          } else {
            flow = flow === 'SMART_BUYING' ? flow : 'SMART_SELLING';
          }
        }
      }
    }

    // Ensure confidence is bounded
    confidence = Math.min(100, confidence);

    return {
      flow,
      signals,
      confidence,
      fundingRate,
      openInterest,
      volume24h
    };

  } catch (error) {
    console.error('[SmartMoney] Error detecting smart money flow:', error);
    return {
      flow: 'NEUTRAL',
      signals: [],
      confidence: 0,
      error: error.message
    };
  }
}

/**
 * Detect liquidation cascade events
 * @param {string} ticker - Trading pair
 * @returns {object} Liquidation cascade analysis
 */
export async function detectLiquidationCascade(ticker) {
  try {
    const history = oiHistory.get(ticker) || [];

    if (history.length < 5) {
      return {
        cascadeDetected: false,
        type: 'NONE',
        magnitude: 0,
        error: 'Insufficient OI history'
      };
    }

    // Get recent OI data
    const recent = history.slice(-5);
    const oldestOI = recent[0].oi;
    const latestOI = recent[recent.length - 1].oi;
    const oiChange = ((latestOI - oldestOI) / oldestOI) * 100;

    // Get recent price data
    const snapshots = await getExchangeSnapshots(ticker, 5);

    if (!snapshots || snapshots.length < 5) {
      return {
        cascadeDetected: false,
        type: 'NONE',
        magnitude: 0,
        error: 'Insufficient price data'
      };
    }

    const oldestPrice = snapshots[snapshots.length - 1].price;
    const latestPrice = snapshots[0].price;
    const priceChange = ((latestPrice - oldestPrice) / oldestPrice) * 100;

    // Check funding rate snap back
    const oldestFunding = recent[0].fundingRate;
    const latestFunding = recent[recent.length - 1].fundingRate;
    const fundingChange = Math.abs(latestFunding - oldestFunding);

    let cascadeDetected = false;
    let type = 'NONE';
    let magnitude = 0;

    // Long liquidation: OI down + price down + funding normalizing
    if (oiChange < -3 && priceChange < -1 && fundingChange > 0.01) {
      cascadeDetected = true;
      type = 'LONG_LIQUIDATION';
      magnitude = Math.min(100, Math.abs(oiChange) * 10 + Math.abs(priceChange) * 5);
    }

    // Short squeeze: OI down + price up + funding normalizing
    if (oiChange < -3 && priceChange > 1 && fundingChange > 0.01) {
      cascadeDetected = true;
      type = 'SHORT_SQUEEZE';
      magnitude = Math.min(100, Math.abs(oiChange) * 10 + Math.abs(priceChange) * 5);
    }

    return {
      cascadeDetected,
      type,
      magnitude,
      oiChange,
      priceChange,
      fundingChange
    };

  } catch (error) {
    console.error('[SmartMoney] Error detecting liquidation cascade:', error);
    return {
      cascadeDetected: false,
      type: 'NONE',
      magnitude: 0,
      error: error.message
    };
  }
}

/**
 * Detect correlation break with BTC
 * @param {string} ticker - Trading pair
 * @param {array} candles - Price candles
 * @returns {object} Correlation break analysis
 */
export async function detectCorrelationBreak(ticker, candles) {
  // Skip for BTC itself
  if (ticker.startsWith('BTC')) {
    return {
      normalCorrelation: 1.0,
      currentCorrelation: 1.0,
      isBreaking: false,
      direction: 'NEUTRAL',
      note: 'BTC itself - skipping correlation check'
    };
  }

  try {
    if (!candles || candles.length < 20) {
      return {
        normalCorrelation: 0,
        currentCorrelation: 0,
        isBreaking: false,
        direction: 'NEUTRAL',
        error: 'Insufficient candle data'
      };
    }

    // Get BTC candles for comparison
    const btcSnapshots = await getExchangeSnapshots('BTCUSD', 20);

    if (!btcSnapshots || btcSnapshots.length < 20) {
      return {
        normalCorrelation: 0,
        currentCorrelation: 0,
        isBreaking: false,
        direction: 'NEUTRAL',
        error: 'Insufficient BTC data'
      };
    }

    // Calculate returns
    const assetReturns = candles.slice(0, 20).map((c, i, arr) => {
      if (i === arr.length - 1) return 0;
      return (c.c - arr[i + 1].c) / arr[i + 1].c;
    }).filter(r => r !== 0);

    const btcReturns = btcSnapshots.slice(0, 20).map((s, i, arr) => {
      if (i === arr.length - 1) return 0;
      return (s.price - arr[i + 1].price) / arr[i + 1].price;
    }).filter(r => r !== 0);

    if (assetReturns.length < 10 || btcReturns.length < 10) {
      return {
        normalCorrelation: 0,
        currentCorrelation: 0,
        isBreaking: false,
        direction: 'NEUTRAL',
        error: 'Insufficient return data'
      };
    }

    // Calculate correlation (Pearson)
    const correlation = calculateCorrelation(assetReturns, btcReturns);

    // Calculate recent correlation (last 5 candles)
    const recentAssetReturns = assetReturns.slice(0, 5);
    const recentBtcReturns = btcReturns.slice(0, 5);
    const recentCorrelation = calculateCorrelation(recentAssetReturns, recentBtcReturns);

    // Detect break
    const normalCorrelation = correlation;
    const currentCorrelation = recentCorrelation;
    const isBreaking = Math.abs(normalCorrelation) > 0.7 && Math.abs(currentCorrelation - normalCorrelation) > 0.3;

    // Determine direction
    let direction = 'NEUTRAL';
    if (isBreaking) {
      const latestAssetReturn = assetReturns[0];
      const latestBtcReturn = btcReturns[0];

      if (latestAssetReturn > latestBtcReturn) {
        direction = 'OUTPERFORMING';
      } else {
        direction = 'UNDERPERFORMING';
      }
    }

    return {
      normalCorrelation,
      currentCorrelation,
      isBreaking,
      direction
    };

  } catch (error) {
    console.error('[SmartMoney] Error detecting correlation break:', error);
    return {
      normalCorrelation: 0,
      currentCorrelation: 0,
      isBreaking: false,
      direction: 'NEUTRAL',
      error: error.message
    };
  }
}

/**
 * Calculate Pearson correlation coefficient
 * @param {array} x - First dataset
 * @param {array} y - Second dataset
 * @returns {number} Correlation coefficient
 */
function calculateCorrelation(x, y) {
  const n = Math.min(x.length, y.length);

  if (n === 0) return 0;

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);

  const meanX = xSlice.reduce((sum, val) => sum + val, 0) / n;
  const meanY = ySlice.reduce((sum, val) => sum + val, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  if (denomX === 0 || denomY === 0) return 0;

  return numerator / Math.sqrt(denomX * denomY);
}

/**
 * Master function: Get comprehensive smart money signal
 * @param {string} ticker - Trading pair
 * @param {array} candles - Price candles
 * @returns {object} Complete smart money analysis
 */
export async function getSmartMoneySignal(ticker, candles) {
  try {
    // Run all analyses in parallel
    const [
      whaleActivity,
      exchangeDivergence,
      smartMoneyFlow,
      liquidationRisk,
      correlationBreak
    ] = await Promise.all([
      detectWhaleActivity(ticker),
      detectCrossExchangeDivergence(ticker),
      detectSmartMoneyFlow(ticker),
      detectLiquidationCascade(ticker),
      detectCorrelationBreak(ticker, candles)
    ]);

    // Calculate master score (start at 50 = neutral)
    let score = 50;
    const scoringFactors = [];

    // Whale activity scoring
    if (whaleActivity.whaleDetected) {
      if (whaleActivity.direction === 'ACCUMULATING') {
        score += 15;
        scoringFactors.push('+15: Whale accumulation');
      } else if (whaleActivity.direction === 'DISTRIBUTING') {
        score -= 15;
        scoringFactors.push('-15: Whale distribution');
      }
    }

    // Smart money flow scoring
    if (smartMoneyFlow.flow === 'SMART_BUYING') {
      score += 20;
      scoringFactors.push('+20: Smart money buying');
    } else if (smartMoneyFlow.flow === 'SMART_SELLING') {
      score -= 20;
      scoringFactors.push('-20: Smart money selling');
    }

    // Exchange divergence scoring
    if (exchangeDivergence.isSignificant) {
      if (exchangeDivergence.leader === 'BINANCE' && exchangeDivergence.signal === 'BULLISH') {
        score += 10;
        scoringFactors.push('+10: Binance leading up');
      } else if (exchangeDivergence.leader === 'BINANCE' && exchangeDivergence.signal === 'BEARISH') {
        score -= 10;
        scoringFactors.push('-10: Binance leading down');
      }
    }

    // Liquidation cascade scoring
    if (liquidationRisk.cascadeDetected) {
      if (liquidationRisk.type === 'LONG_LIQUIDATION') {
        score -= 25;
        scoringFactors.push('-25: Long liquidation cascade');
      } else if (liquidationRisk.type === 'SHORT_SQUEEZE') {
        score += 25;
        scoringFactors.push('+25: Short squeeze');
      }
    }

    // Correlation break scoring
    if (correlationBreak.isBreaking) {
      if (correlationBreak.direction === 'OUTPERFORMING') {
        score += 10;
        scoringFactors.push('+10: Outperforming BTC');
      } else if (correlationBreak.direction === 'UNDERPERFORMING') {
        score -= 10;
        scoringFactors.push('-10: Underperforming BTC');
      }
    }

    // Determine signal
    let signal = 'NEUTRAL';
    if (score > 70) {
      signal = 'STRONG_BUY';
    } else if (score >= 60) {
      signal = 'BUY';
    } else if (score > 40) {
      signal = 'NEUTRAL';
    } else if (score >= 30) {
      signal = 'SELL';
    } else {
      signal = 'STRONG_SELL';
    }

    // Calculate confidence (based on data availability)
    let confidence = 0;
    let dataPoints = 0;

    if (!whaleActivity.error) {
      confidence += whaleActivity.confidence;
      dataPoints++;
    }
    if (!smartMoneyFlow.error) {
      confidence += smartMoneyFlow.confidence;
      dataPoints++;
    }
    if (!exchangeDivergence.error) {
      confidence += exchangeDivergence.isSignificant ? 50 : 25;
      dataPoints++;
    }
    if (!liquidationRisk.error) {
      confidence += liquidationRisk.cascadeDetected ? 75 : 25;
      dataPoints++;
    }
    if (!correlationBreak.error) {
      confidence += correlationBreak.isBreaking ? 50 : 25;
      dataPoints++;
    }

    confidence = dataPoints > 0 ? confidence / dataPoints : 0;

    // Generate summary
    const summaryParts = [];
    if (whaleActivity.whaleDetected) {
      summaryParts.push(`Whale ${whaleActivity.direction.toLowerCase()}`);
    }
    if (smartMoneyFlow.signals.length > 0) {
      summaryParts.push(smartMoneyFlow.signals.join(', '));
    }
    if (liquidationRisk.cascadeDetected) {
      summaryParts.push(liquidationRisk.type.replace('_', ' ').toLowerCase());
    }

    const summary = summaryParts.length > 0
      ? summaryParts.join('; ')
      : 'No significant smart money activity';

    return {
      signal,
      confidence: Math.round(confidence),
      score,
      scoringFactors,
      whaleActivity,
      exchangeDivergence,
      smartMoneyFlow,
      liquidationRisk,
      correlationBreak,
      summary,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[SmartMoney] Error getting smart money signal:', error);
    return {
      signal: 'NEUTRAL',
      confidence: 0,
      score: 50,
      scoringFactors: [],
      whaleActivity: { whaleDetected: false, direction: 'NEUTRAL', wallsDetected: [], confidence: 0 },
      exchangeDivergence: { divergence: 0, divergencePercent: 0, leader: 'UNKNOWN', signal: 'NEUTRAL' },
      smartMoneyFlow: { flow: 'NEUTRAL', signals: [], confidence: 0 },
      liquidationRisk: { cascadeDetected: false, type: 'NONE', magnitude: 0 },
      correlationBreak: { normalCorrelation: 0, currentCorrelation: 0, isBreaking: false, direction: 'NEUTRAL' },
      summary: 'Error analyzing smart money',
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * Clear history for a specific ticker (useful for testing or memory management)
 * @param {string} ticker - Trading pair
 */
export function clearHistory(ticker) {
  orderBookHistory.delete(ticker);
  oiHistory.delete(ticker);
  divergenceHistory.delete(ticker);
  console.log(`[SmartMoney] Cleared history for ${ticker}`);
}

/**
 * Get current history stats (for debugging)
 * @returns {object} History statistics
 */
export function getHistoryStats() {
  return {
    orderBookHistory: orderBookHistory.size,
    oiHistory: oiHistory.size,
    divergenceHistory: divergenceHistory.size,
    tickers: Array.from(new Set([
      ...orderBookHistory.keys(),
      ...oiHistory.keys(),
      ...divergenceHistory.keys()
    ]))
  };
}
