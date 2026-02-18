/**
 * Feature Engineering Service
 * Builds 62-element feature vectors from all data sources for ML training/prediction
 */

import { getDb } from './database.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export const FEATURE_COUNT = 68;

/**
 * Get all 62 feature names in order
 */
export function getFeatureNames() {
  return [
    // Price Technical (20)
    'rsi_14',
    'macd_histogram_norm',
    'macd_signal_cross',
    'bollinger_percent_b',
    'bollinger_width',
    'ema9_ema21_ratio',
    'ema21_ema50_ratio',
    'ema9_slope',
    'ema21_slope',
    'price_vwap_ratio',
    'atr_norm',
    'price_change_1c',
    'price_change_5c',
    'price_change_20c',
    'candle_range_norm',
    'close_position_in_candle',
    'stochastic_k',
    'stochastic_d',
    'adx_14',
    'price_vs_range_mid',
    // Volume (8)
    'volume_sma_ratio',
    'volume_trend',
    'obv_slope',
    'buy_volume_pct',
    'volume_spike',
    'volume_price_divergence',
    'consecutive_volume_increase',
    'volume_ratio_5_20',
    // Order Book (8)
    'bid_ask_imbalance',
    'spread_pct',
    'buy_wall_strength',
    'sell_wall_strength',
    'cross_exchange_spread',
    'large_trade_ratio',
    'orderbook_depth_ratio',
    'bid_volume_change',
    // Derivatives (6)
    'funding_rate',
    'oi_change_pct',
    'oi_price_divergence',
    'liquidation_imbalance',
    'futures_spot_basis',
    'basis_change_direction',
    // Sentiment (8)
    'fear_greed_index',
    'fear_greed_trend',
    'news_sentiment',
    'news_volume',
    'reddit_sentiment',
    'reddit_activity',
    'social_momentum',
    'sentiment_price_divergence',
    // DeFi/Macro (5)
    'tvl_change_24h',
    'dex_volume_change',
    'btc_dominance',
    'btc_dominance_change',
    'eth_btc_correlation',
    // Context (7)
    'market_regime',
    'hour_sin',
    'hour_cos',
    'day_sin',
    'day_cos',
    'minutes_since_last_trade',
    'candle_count_norm',
    // MTF Confluence (1) - Feature 3
    'mtf_alignment_score',
    // Enhanced Sentiment (5) - Phase 4
    'youtube_sentiment',
    'youtube_video_count_24h',
    'reddit_comment_sentiment',
    'reddit_post_volume_change',
    'market_speed_indicator',
  ];
}

/**
 * Build complete 62-element feature vector
 */
export function buildFeatureVector(ticker, candles, options = {}) {
  if (!candles || candles.length < 50) {
    throw new Error('Need at least 50 candles for feature extraction');
  }

  const features = new Array(FEATURE_COUNT).fill(0);
  const featureNames = getFeatureNames();

  try {
    // Extract features by group
    const priceFeatures = extractPriceFeatures(candles);
    const volumeFeatures = extractVolumeFeatures(candles);
    const orderBookFeatures = extractOrderBookFeatures(options.exchangeSnapshot);
    const derivativesFeatures = extractDerivativesFeatures(options.derivativesData);
    const sentimentFeatures = extractSentimentFeatures(options.sentimentData, candles);
    const defiFeatures = extractDeFiFeatures(options.defiData);
    const contextFeatures = extractContextFeatures(options.marketRegime, options.lastTradeTime, candles.length);

    // MTF alignment score (Feature 3)
    const mtfScore = options.mtfAlignmentScore != null ? options.mtfAlignmentScore / 100 : 0.5;

    // Combine all features
    let idx = 0;
    priceFeatures.forEach(f => features[idx++] = f);
    volumeFeatures.forEach(f => features[idx++] = f);
    orderBookFeatures.forEach(f => features[idx++] = f);
    derivativesFeatures.forEach(f => features[idx++] = f);
    sentimentFeatures.forEach(f => features[idx++] = f);
    defiFeatures.forEach(f => features[idx++] = f);
    contextFeatures.forEach(f => features[idx++] = f);
    features[idx++] = mtfScore;

    // Enhanced Sentiment features (Phase 4)
    features[idx++] = clamp(options.youtubeSentiment || 0, -1, 1);         // youtube_sentiment
    features[idx++] = clamp((options.youtubeVideoCount || 0) / 50, 0, 1);  // youtube_video_count_24h (normalized)
    features[idx++] = clamp(options.redditCommentSentiment || 0, -1, 1);   // reddit_comment_sentiment
    features[idx++] = clamp((options.redditPostVolumeChange || 0) / 100, -1, 1); // reddit_post_volume_change
    features[idx++] = options.marketSpeed === 'FAST' ? 1 : 0;              // market_speed_indicator

    return {
      features,
      featureNames,
      featureGroups: {
        price: priceFeatures,
        volume: volumeFeatures,
        orderBook: orderBookFeatures,
        derivatives: derivativesFeatures,
        sentiment: sentimentFeatures,
        defi: defiFeatures,
        context: contextFeatures,
        enhancedSentiment: [
          options.youtubeSentiment || 0,
          options.youtubeVideoCount || 0,
          options.redditCommentSentiment || 0,
          options.redditPostVolumeChange || 0,
          options.marketSpeed === 'FAST' ? 1 : 0,
        ],
      }
    };
  } catch (err) {
    console.error('Error building feature vector:', err);
    return {
      features,
      featureNames,
      featureGroups: {}
    };
  }
}

/**
 * Extract 20 price technical features
 */
function extractPriceFeatures(candles) {
  const features = new Array(20).fill(0);

  try {
    const closes = candles.map(c => c.c);
    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const volumes = candles.map(c => c.v);

    const current = candles[candles.length - 1];
    const currentPrice = current.c;

    // 1. RSI(14)
    features[0] = calculateRSI(closes, 14) / 100; // Normalize to 0-1

    // 2-3. MACD
    const macd = calculateMACD(closes);
    const atr = calculateATR(candles, 14);
    features[1] = macd.histogram / (atr || 1); // Normalized by ATR
    features[2] = macd.signal > 0 ? 1 : (macd.signal < 0 ? -1 : 0);

    // 4-5. Bollinger Bands
    const bb = calculateBollingerBands(closes, 20, 2);
    features[3] = bb.width > 0 ? (currentPrice - bb.lower) / bb.width : 0.5; // %B
    features[4] = bb.middle > 0 ? bb.width / bb.middle : 0; // Width normalized

    // 6-7. EMA ratios
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    features[5] = ema21 > 0 ? ema9 / ema21 - 1 : 0; // Centered at 0
    features[6] = ema50 > 0 ? ema21 / ema50 - 1 : 0;

    // 8-9. EMA slopes
    const ema9Series = closes.slice(-10).map((_, i) => calculateEMA(closes.slice(0, -10 + i + 1), 9));
    const ema21Series = closes.slice(-10).map((_, i) => calculateEMA(closes.slice(0, -10 + i + 1), 21));
    features[7] = calculateSlope(ema9Series.slice(-5)) / currentPrice; // Normalized
    features[8] = calculateSlope(ema21Series.slice(-5)) / currentPrice;

    // 10. VWAP
    const vwap = calculateVWAP(candles);
    features[9] = vwap > 0 ? currentPrice / vwap - 1 : 0;

    // 11. ATR normalized
    features[10] = atr / currentPrice;

    // 12-14. Price changes
    features[11] = closes.length >= 2 ? (closes[closes.length - 1] / closes[closes.length - 2] - 1) : 0;
    features[12] = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) : 0;
    features[13] = closes.length >= 21 ? (closes[closes.length - 1] / closes[closes.length - 21] - 1) : 0;

    // 15-16. Candle position
    const candleRange = current.h - current.l;
    features[14] = current.c > 0 ? candleRange / current.c : 0;
    features[15] = candleRange > 0 ? (current.c - current.l) / candleRange : 0.5;

    // 17-18. Stochastic
    const stoch = calculateStochastic(candles, 14, 3);
    features[16] = stoch.k / 100;
    features[17] = stoch.d / 100;

    // 19. ADX
    features[18] = calculateADX(candles, 14) / 100;

    // 20. Price vs 50-candle range midpoint
    const range50High = Math.max(...highs.slice(-50));
    const range50Low = Math.min(...lows.slice(-50));
    const range50Mid = (range50High + range50Low) / 2;
    features[19] = range50Mid > 0 ? currentPrice / range50Mid - 1 : 0;

  } catch (err) {
    console.error('Error extracting price features:', err);
  }

  return features;
}

/**
 * Extract 8 volume features
 */
function extractVolumeFeatures(candles) {
  const features = new Array(8).fill(0);

  try {
    const volumes = candles.map(c => c.v);
    const closes = candles.map(c => c.c);
    const opens = candles.map(c => c.o);

    const currentVolume = volumes[volumes.length - 1];
    const volumeSMA20 = calculateSMA(volumes, 20);

    // 21. Volume / SMA ratio
    features[0] = volumeSMA20 > 0 ? currentVolume / volumeSMA20 - 1 : 0;

    // 22. Volume trend (5-candle slope)
    features[1] = calculateSlope(volumes.slice(-5)) / (volumeSMA20 || 1);

    // 23. OBV slope
    const obv = calculateOBV(candles);
    features[2] = calculateSlope(obv.slice(-10)) / Math.abs(obv[obv.length - 1] || 1);

    // 24. Buy volume %
    let buyVolume = 0;
    for (let i = Math.max(0, candles.length - 20); i < candles.length; i++) {
      if (candles[i].c > candles[i].o) {
        buyVolume += candles[i].v;
      }
    }
    const totalVolume = volumes.slice(-20).reduce((a, b) => a + b, 0);
    features[3] = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

    // 25. Volume spike
    const volumeRatio = volumeSMA20 > 0 ? currentVolume / volumeSMA20 : 1;
    features[4] = volumeRatio > 2 ? 1 : Math.min(volumeRatio / 2, 1);

    // 26. Volume-price divergence
    const volumeChange = volumes.length >= 6 ? volumes[volumes.length - 1] / volumes[volumes.length - 6] - 1 : 0;
    const priceChange = closes.length >= 6 ? closes[closes.length - 1] / closes[closes.length - 6] - 1 : 0;
    if (volumeChange > 0.2 && priceChange < -0.05) features[5] = -1;
    else if (volumeChange > 0.2 && priceChange > 0.05) features[5] = 1;
    else features[5] = 0;

    // 27. Consecutive volume increases
    let consecutive = 0;
    for (let i = volumes.length - 1; i > 0 && i > volumes.length - 6; i--) {
      if (volumes[i] > volumes[i - 1]) consecutive++;
      else break;
    }
    features[6] = Math.min(consecutive / 5, 1);

    // 28. Volume ratio 5/20
    const volumeSMA5 = calculateSMA(volumes, 5);
    features[7] = volumeSMA20 > 0 ? volumeSMA5 / volumeSMA20 - 1 : 0;

  } catch (err) {
    console.error('Error extracting volume features:', err);
  }

  return features;
}

/**
 * Extract 8 order book features
 */
function extractOrderBookFeatures(exchangeSnapshot) {
  const features = new Array(8).fill(0);

  if (!exchangeSnapshot) return features;

  try {
    const { bids, asks, trades, crossExchange } = exchangeSnapshot;

    // 29. Bid/ask imbalance
    if (bids && asks) {
      const bidVolume = bids.slice(0, 10).reduce((sum, b) => sum + b.volume, 0);
      const askVolume = asks.slice(0, 10).reduce((sum, a) => sum + a.volume, 0);
      const totalVolume = bidVolume + askVolume;
      features[0] = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;
    }

    // 30. Spread %
    if (bids && asks && bids[0] && asks[0]) {
      const spread = asks[0].price - bids[0].price;
      features[1] = bids[0].price > 0 ? spread / bids[0].price : 0;
    }

    // 31-32. Wall strength
    if (bids && asks) {
      const avgBidVol = bids.slice(0, 10).reduce((sum, b) => sum + b.volume, 0) / 10;
      const avgAskVol = asks.slice(0, 10).reduce((sum, a) => sum + a.volume, 0) / 10;

      const buyWall = bids.filter(b => b.volume > avgBidVol * 3).reduce((sum, b) => sum + b.volume, 0);
      const sellWall = asks.filter(a => a.volume > avgAskVol * 3).reduce((sum, a) => sum + a.volume, 0);

      features[2] = Math.min(buyWall / (avgBidVol * 10 || 1), 2) / 2;
      features[3] = Math.min(sellWall / (avgAskVol * 10 || 1), 2) / 2;
    }

    // 33. Cross-exchange spread
    if (crossExchange && crossExchange.spread) {
      features[4] = crossExchange.spread;
    }

    // 34. Large trade ratio
    if (trades && trades.length > 0) {
      const avgTradeSize = trades.reduce((sum, t) => sum + t.size, 0) / trades.length;
      const largeTradeCount = trades.filter(t => t.size > avgTradeSize * 2).length;
      features[5] = trades.length > 0 ? largeTradeCount / trades.length : 0;
    }

    // 35. Order book depth ratio
    if (bids && asks) {
      const bidDepth = bids.slice(0, 20).reduce((sum, b) => sum + b.volume, 0);
      const askDepth = asks.slice(0, 20).reduce((sum, a) => sum + a.volume, 0);
      features[6] = askDepth > 0 ? (bidDepth / askDepth - 1) : 0;
    }

    // 36. Bid volume change
    if (bids && exchangeSnapshot.previousBids) {
      const currentBidVol = bids.slice(0, 10).reduce((sum, b) => sum + b.volume, 0);
      const previousBidVol = exchangeSnapshot.previousBids.slice(0, 10).reduce((sum, b) => sum + b.volume, 0);
      features[7] = previousBidVol > 0 ? (currentBidVol / previousBidVol - 1) : 0;
    }

  } catch (err) {
    console.error('Error extracting order book features:', err);
  }

  return features;
}

/**
 * Extract 6 derivatives features
 */
function extractDerivativesFeatures(derivativesData) {
  const features = new Array(6).fill(0);

  if (!derivativesData) return features;

  try {
    // 37. Funding rate
    if (derivativesData.fundingRate !== undefined) {
      features[0] = derivativesData.fundingRate;
    }

    // 38. OI change %
    if (derivativesData.openInterestChange !== undefined) {
      features[1] = Math.tanh(derivativesData.openInterestChange / 10); // Normalize
    }

    // 39. OI-price divergence
    if (derivativesData.openInterestChange !== undefined && derivativesData.priceChange !== undefined) {
      const oiUp = derivativesData.openInterestChange > 0.05;
      const oiDown = derivativesData.openInterestChange < -0.05;
      const priceUp = derivativesData.priceChange > 0.01;
      const priceDown = derivativesData.priceChange < -0.01;

      if (oiUp && priceDown) features[2] = -1;
      else if (oiUp && priceUp) features[2] = 1;
      else if (oiDown && priceUp) features[2] = -1;
      else if (oiDown && priceDown) features[2] = 1;
    }

    // 40. Liquidation imbalance
    if (derivativesData.longLiquidations !== undefined && derivativesData.shortLiquidations !== undefined) {
      const total = derivativesData.longLiquidations + derivativesData.shortLiquidations;
      features[3] = total > 0 ? (derivativesData.shortLiquidations - derivativesData.longLiquidations) / total : 0;
    }

    // 41. Futures-spot basis %
    if (derivativesData.basis !== undefined) {
      features[4] = derivativesData.basis;
    }

    // 42. Basis change direction
    if (derivativesData.basisChange !== undefined) {
      features[5] = Math.sign(derivativesData.basisChange);
    }

  } catch (err) {
    console.error('Error extracting derivatives features:', err);
  }

  return features;
}

/**
 * Extract 8 sentiment features
 */
function extractSentimentFeatures(sentimentData, candles) {
  const features = new Array(8).fill(0);

  if (!sentimentData) return features;

  try {
    const closes = candles.map(c => c.c);
    const priceChange = closes.length >= 6 ? closes[closes.length - 1] / closes[closes.length - 6] - 1 : 0;

    // 43-44. Fear & Greed
    if (sentimentData.fearGreed !== undefined) {
      features[0] = sentimentData.fearGreed / 100;

      // Trend: compare to historical average if available
      if (sentimentData.fearGreedHistory && sentimentData.fearGreedHistory.length > 0) {
        const avg = sentimentData.fearGreedHistory.reduce((a, b) => a + b, 0) / sentimentData.fearGreedHistory.length;
        features[1] = sentimentData.fearGreed > avg ? 1 : (sentimentData.fearGreed < avg ? -1 : 0);
      }
    }

    // 45-46. News sentiment
    if (sentimentData.newsScore !== undefined) {
      features[2] = Math.max(-1, Math.min(1, sentimentData.newsScore));
    }
    if (sentimentData.newsVolume !== undefined) {
      features[3] = Math.min(1, Math.log10(sentimentData.newsVolume + 1) / 2);
    }

    // 47-48. Reddit
    if (sentimentData.redditScore !== undefined) {
      features[4] = Math.max(-1, Math.min(1, sentimentData.redditScore));
    }
    if (sentimentData.redditMentions !== undefined) {
      features[5] = Math.min(1, Math.log10(sentimentData.redditMentions + 1) / 3);
    }

    // 49. Social momentum
    if (sentimentData.socialScore !== undefined) {
      features[6] = sentimentData.socialScore > 0.7 ? 1 : 0;
    }

    // 50. Sentiment-price divergence
    const avgSentiment = (
      (sentimentData.fearGreed || 50) / 100 +
      (sentimentData.newsScore || 0) +
      (sentimentData.redditScore || 0) +
      (sentimentData.socialScore || 0.5)
    ) / 4;

    if (avgSentiment > 0.6 && priceChange < -0.05) features[7] = -1;
    else if (avgSentiment < 0.4 && priceChange > 0.05) features[7] = 1;
    else if (avgSentiment > 0.6 && priceChange > 0.05) features[7] = 0.5;
    else if (avgSentiment < 0.4 && priceChange < -0.05) features[7] = -0.5;

  } catch (err) {
    console.error('Error extracting sentiment features:', err);
  }

  return features;
}

/**
 * Extract 5 DeFi/Macro features
 */
function extractDeFiFeatures(defiData) {
  const features = new Array(5).fill(0);

  if (!defiData) return features;

  try {
    // 51. TVL change
    if (defiData.tvlChange !== undefined) {
      features[0] = Math.tanh(defiData.tvlChange / 10);
    }

    // 52. DEX volume change
    if (defiData.dexVolumeChange !== undefined) {
      features[1] = Math.tanh(defiData.dexVolumeChange / 20);
    }

    // 53-54. BTC dominance
    if (defiData.btcDominance !== undefined) {
      features[2] = defiData.btcDominance / 100;

      if (defiData.btcDominanceChange !== undefined) {
        features[3] = Math.sign(defiData.btcDominanceChange);
      }
    }

    // 55. ETH/BTC correlation
    if (defiData.ethBtcCorrelation !== undefined) {
      features[4] = defiData.ethBtcCorrelation;
    } else {
      features[4] = 0.8; // Default correlation
    }

  } catch (err) {
    console.error('Error extracting DeFi features:', err);
  }

  return features;
}

/**
 * Extract 7 context features
 */
function extractContextFeatures(marketRegime, lastTradeTime, candleCount) {
  const features = new Array(7).fill(0);

  try {
    const now = Date.now();
    const date = new Date(now);

    // 56. Market regime
    if (marketRegime === 'UPTREND') features[0] = 1;
    else if (marketRegime === 'DOWNTREND') features[0] = -1;
    else features[0] = 0; // SIDEWAYS

    // 57-58. Hour of day (cyclical)
    const hour = date.getHours();
    features[1] = Math.sin(2 * Math.PI * hour / 24);
    features[2] = Math.cos(2 * Math.PI * hour / 24);

    // 59-60. Day of week (cyclical)
    const day = date.getDay();
    features[3] = Math.sin(2 * Math.PI * day / 7);
    features[4] = Math.cos(2 * Math.PI * day / 7);

    // 61. Minutes since last trade
    if (lastTradeTime) {
      const minutesSince = (now - lastTradeTime) / (1000 * 60);
      features[5] = Math.min(minutesSince / 60, 1); // Cap at 60 minutes
    }

    // 62. Candle count normalized
    features[6] = Math.min(candleCount / 200, 1);

  } catch (err) {
    console.error('Error extracting context features:', err);
  }

  return features;
}

/**
 * Normalize features to 0-1 range using min-max normalization
 */
export function normalizeFeatures(features) {
  const normalized = [...features];

  // Find min and max
  const min = Math.min(...features);
  const max = Math.max(...features);

  if (max - min === 0) return normalized;

  // Normalize each feature
  for (let i = 0; i < normalized.length; i++) {
    normalized[i] = (features[i] - min) / (max - min);
  }

  return normalized;
}

// Technical indicator calculations

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateSMA(values, period) {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12 - ema26;

  // Calculate signal line (EMA of MACD)
  const macdValues = [];
  for (let i = 26; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdValues.push(e12 - e26);
  }

  const signalLine = calculateEMA(macdValues, 9);
  const histogram = macdLine - signalLine;

  return {
    line: macdLine,
    signal: signalLine,
    histogram
  };
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  const sma = calculateSMA(closes, period);
  const slice = closes.slice(-period);

  const squaredDiffs = slice.map(c => Math.pow(c - sma, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std,
    width: 2 * stdDev * std
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].h;
    const low = candles[i].l;
    const prevClose = candles[i - 1].c;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  return calculateSMA(trs, period);
}

function calculateVWAP(candles) {
  if (candles.length === 0) return 0;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typical = (candle.h + candle.l + candle.c) / 3;
    cumulativeTPV += typical * candle.v;
    cumulativeVolume += candle.v;
  }

  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
}

function calculateStochastic(candles, period = 14, smoothK = 3) {
  if (candles.length < period) return { k: 50, d: 50 };

  const slice = candles.slice(-period);
  const high = Math.max(...slice.map(c => c.h));
  const low = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;

  const k = high !== low ? ((close - low) / (high - low)) * 100 : 50;

  // Calculate %D (SMA of %K)
  const kValues = [];
  for (let i = period; i <= candles.length; i++) {
    const s = candles.slice(i - period, i);
    const h = Math.max(...s.map(c => c.h));
    const l = Math.min(...s.map(c => c.l));
    const c = s[s.length - 1].c;
    kValues.push(h !== l ? ((c - l) / (h - l)) * 100 : 50);
  }

  const d = calculateSMA(kValues, smoothK);

  return { k, d };
}

function calculateADX(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const dms = [];
  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].h - candles[i - 1].h;
    const lowDiff = candles[i - 1].l - candles[i].l;

    let plusDM = 0;
    let minusDM = 0;

    if (highDiff > lowDiff && highDiff > 0) plusDM = highDiff;
    if (lowDiff > highDiff && lowDiff > 0) minusDM = lowDiff;

    dms.push({ plus: plusDM, minus: minusDM });
  }

  const atr = calculateATR(candles, period);
  if (atr === 0) return 0;

  const plusDI = calculateSMA(dms.map(d => d.plus), period) / atr * 100;
  const minusDI = calculateSMA(dms.map(d => d.minus), period) / atr * 100;

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return dx || 0;
}

function calculateOBV(candles) {
  const obv = [0];

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > candles[i - 1].c) {
      obv.push(obv[i - 1] + candles[i].v);
    } else if (candles[i].c < candles[i - 1].c) {
      obv.push(obv[i - 1] - candles[i].v);
    } else {
      obv.push(obv[i - 1]);
    }
  }

  return obv;
}

function calculateSlope(values) {
  if (values.length < 2) return 0;

  const n = values.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return slope || 0;
}
