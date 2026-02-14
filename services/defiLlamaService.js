/**
 * DeFi Llama Service - Backend Node.js Service
 *
 * Fetches free public DeFi data from DeFiLlama API (no auth required)
 * Endpoints: TVL, Chain TVLs, DEX volumes, Stablecoins
 *
 * Rate limit: ~300 req/5min (generous, tracking anyway)
 * Cache TTL: 15min for all endpoints
 */

import fetch from 'node-fetch';

// Cache storage
const cache = {
  tvl: { data: null, timestamp: 0 },
  chains: { data: null, timestamp: 0 },
  dexs: { data: null, timestamp: 0 },
  stablecoins: { data: null, timestamp: 0 },
  snapshot: { data: null, timestamp: 0 }
};

// Rate limiting tracker
const rateLimiter = {
  requests: [],
  maxRequests: 300,
  windowMs: 5 * 60 * 1000 // 5 minutes
};

// Historical tracking for trend detection
let previousTVL = null;
let dexVolumeHistory = []; // Last 7 days for average calculation

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if cached data is still valid
 */
function isCacheValid(cacheEntry) {
  return cacheEntry.data && (Date.now() - cacheEntry.timestamp < CACHE_TTL_MS);
}

/**
 * Rate limit check - ensure we don't exceed DeFiLlama limits
 */
function checkRateLimit() {
  const now = Date.now();
  // Remove requests older than the window
  rateLimiter.requests = rateLimiter.requests.filter(
    timestamp => now - timestamp < rateLimiter.windowMs
  );

  if (rateLimiter.requests.length >= rateLimiter.maxRequests) {
    console.log('[DeFiLlama] Rate limit reached, using cached data');
    return false;
  }

  rateLimiter.requests.push(now);
  return true;
}

/**
 * Generic fetch wrapper with error handling
 */
async function fetchWithErrorHandling(url, cacheKey) {
  try {
    // Check cache first
    if (isCacheValid(cache[cacheKey])) {
      console.log(`[DeFiLlama] Using cached data for ${cacheKey}`);
      return cache[cacheKey].data;
    }

    // Check rate limit
    if (!checkRateLimit()) {
      return cache[cacheKey].data || null;
    }

    console.log(`[DeFiLlama] Fetching: ${url}`);
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });

    if (!response.ok) {
      console.error(`[DeFiLlama] HTTP ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json();

    // Update cache
    cache[cacheKey] = {
      data,
      timestamp: Date.now()
    };

    return data;
  } catch (error) {
    console.error(`[DeFiLlama] Error fetching ${url}:`, error.message);
    return null;
  }
}

/**
 * Get Total TVL with 24h and 7d changes
 * @returns {Object|null} { totalTvl, change24h, change7d, timestamp }
 */
export async function getTotalTVL() {
  try {
    // Fetch historical TVL data (returns array of { date, tvl })
    const data = await fetchWithErrorHandling(
      'https://api.llama.fi/v2/historicalChainTvl',
      'tvl'
    );

    if (!data || !Array.isArray(data) || data.length < 2) {
      return null;
    }

    // Sort by date descending (most recent first)
    const sorted = data.sort((a, b) => b.date - a.date);

    const latest = sorted[0];
    const oneDayAgo = sorted.find(d => latest.date - d.date >= 86400) || sorted[1];
    const sevenDaysAgo = sorted.find(d => latest.date - d.date >= 7 * 86400) || sorted[Math.min(7, sorted.length - 1)];

    const totalTvl = latest.tvl;
    const change24h = ((latest.tvl - oneDayAgo.tvl) / oneDayAgo.tvl) * 100;
    const change7d = ((latest.tvl - sevenDaysAgo.tvl) / sevenDaysAgo.tvl) * 100;

    // Store for trend tracking
    previousTVL = {
      tvl: totalTvl,
      change24h,
      timestamp: latest.date
    };

    return {
      totalTvl,
      change24h,
      change7d,
      timestamp: latest.date
    };
  } catch (error) {
    console.error('[DeFiLlama] Error in getTotalTVL:', error.message);
    return null;
  }
}

/**
 * Get Chain TVLs - top 20 chains by TVL
 * @returns {Array|null} [{ name, tvl, change1d, change7d }]
 */
export async function getChainTVLs() {
  try {
    const data = await fetchWithErrorHandling(
      'https://api.llama.fi/v2/chains',
      'chains'
    );

    if (!data || !Array.isArray(data)) {
      return null;
    }

    // Extract and sort by TVL
    const chains = data
      .map(chain => ({
        name: chain.name || chain.chainId || 'Unknown',
        tvl: chain.tvl || 0,
        change1d: chain.change_1d || 0,
        change7d: chain.change_7d || 0
      }))
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 20);

    return chains;
  } catch (error) {
    console.error('[DeFiLlama] Error in getChainTVLs:', error.message);
    return null;
  }
}

/**
 * Get DEX Volumes - 24h volume and top DEXes
 * @returns {Object|null} { totalVolume24h, topDexes: [{ name, volume24h, change1d }] }
 */
export async function getDEXVolumes() {
  try {
    const data = await fetchWithErrorHandling(
      'https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyVolume',
      'dexs'
    );

    if (!data || !data.protocols) {
      return null;
    }

    let totalVolume24h = 0;
    const topDexes = [];

    // Process DEX data
    for (const protocol of data.protocols) {
      const volume24h = protocol.total24h || 0;
      const change1d = protocol.change_1d || 0;

      totalVolume24h += volume24h;

      topDexes.push({
        name: protocol.name || protocol.displayName || 'Unknown',
        volume24h,
        change1d
      });
    }

    // Sort by volume and take top 10
    topDexes.sort((a, b) => b.volume24h - a.volume24h);
    const top10 = topDexes.slice(0, 10);

    // Store for volume spike detection
    dexVolumeHistory.push({
      volume: totalVolume24h,
      timestamp: Date.now()
    });

    // Keep only last 7 entries
    if (dexVolumeHistory.length > 7) {
      dexVolumeHistory.shift();
    }

    return {
      totalVolume24h,
      topDexes: top10
    };
  } catch (error) {
    console.error('[DeFiLlama] Error in getDEXVolumes:', error.message);
    return null;
  }
}

/**
 * Get Stablecoin Flows - market cap and changes
 * Inflows = money entering crypto, outflows = money leaving
 * @returns {Object|null} { totalMcap, change24h, topStables: [{ name, mcap, change7d }] }
 */
export async function getStablecoinFlows() {
  try {
    const data = await fetchWithErrorHandling(
      'https://stablecoins.llama.fi/stablecoins?includePrices=true',
      'stablecoins'
    );

    if (!data || !data.peggedAssets) {
      return null;
    }

    let totalMcap = 0;
    let totalMcap24hAgo = 0;
    const topStables = [];

    // Process stablecoin data
    for (const stablecoin of data.peggedAssets) {
      const mcap = stablecoin.circulating?.peggedUSD || 0;
      const mcap24hAgo = stablecoin.circulatingPrevDay?.peggedUSD || mcap;
      const mcap7dAgo = stablecoin.circulatingPrevWeek?.peggedUSD || mcap;

      totalMcap += mcap;
      totalMcap24hAgo += mcap24hAgo;

      const change7d = mcap7dAgo > 0 ? ((mcap - mcap7dAgo) / mcap7dAgo) * 100 : 0;

      topStables.push({
        name: stablecoin.name || 'Unknown',
        mcap,
        change7d
      });
    }

    // Calculate 24h change
    const change24h = totalMcap24hAgo > 0
      ? ((totalMcap - totalMcap24hAgo) / totalMcap24hAgo) * 100
      : 0;

    // Sort by market cap and take top 10
    topStables.sort((a, b) => b.mcap - a.mcap);
    const top10 = topStables.slice(0, 10);

    return {
      totalMcap,
      change24h,
      topStables: top10
    };
  } catch (error) {
    console.error('[DeFiLlama] Error in getStablecoinFlows:', error.message);
    return null;
  }
}

/**
 * Calculate TVL trend based on recent changes
 * @param {number} change24h - 24h TVL change percentage
 * @returns {string} 'RISING' | 'FALLING' | 'STABLE'
 */
function calculateTVLTrend(change24h) {
  if (change24h > 2) return 'RISING';
  if (change24h < -2) return 'FALLING';
  return 'STABLE';
}

/**
 * Detect DEX volume spike
 * @param {number} currentVolume - Current 24h volume
 * @returns {boolean} True if volume > 1.5x recent average
 */
function detectDexVolumeSpike(currentVolume) {
  if (dexVolumeHistory.length < 3) return false;

  const recentAverage = dexVolumeHistory
    .slice(0, -1) // Exclude current
    .reduce((sum, entry) => sum + entry.volume, 0) / (dexVolumeHistory.length - 1);

  return currentVolume > recentAverage * 1.5;
}

/**
 * Get comprehensive DeFi snapshot - combines all metrics
 * @returns {Object|null} Complete DeFi market snapshot
 */
export async function getDeFiSnapshot() {
  try {
    // Check cache first
    if (isCacheValid(cache.snapshot)) {
      console.log('[DeFiLlama] Using cached snapshot');
      return cache.snapshot.data;
    }

    // Fetch all data in parallel
    const [tvlData, chainsData, dexData, stablecoinData] = await Promise.all([
      getTotalTVL(),
      getChainTVLs(),
      getDEXVolumes(),
      getStablecoinFlows()
    ]);

    if (!tvlData || !dexData) {
      console.error('[DeFiLlama] Failed to fetch required data for snapshot');
      return null;
    }

    // Calculate trends and anomalies
    const tvlTrend = calculateTVLTrend(tvlData.change24h);
    const dexVolumeSpike = detectDexVolumeSpike(dexData.totalVolume24h);

    const snapshot = {
      tvl: tvlData.totalTvl,
      tvlChange24h: tvlData.change24h,
      tvlChange7d: tvlData.change7d,
      tvlTrend,

      dexVolume24h: dexData.totalVolume24h,
      dexVolumeSpike,
      topDexes: dexData.topDexes,

      stablecoinMcap: stablecoinData?.totalMcap || null,
      stablecoinChange: stablecoinData?.change24h || null,
      topStablecoins: stablecoinData?.topStables || [],

      topChains: chainsData || [],

      timestamp: Date.now()
    };

    // Cache the snapshot
    cache.snapshot = {
      data: snapshot,
      timestamp: Date.now()
    };

    console.log('[DeFiLlama] Snapshot generated:', {
      tvl: `$${(snapshot.tvl / 1e9).toFixed(2)}B`,
      tvlTrend,
      dexVolume: `$${(snapshot.dexVolume24h / 1e9).toFixed(2)}B`,
      dexVolumeSpike
    });

    return snapshot;
  } catch (error) {
    console.error('[DeFiLlama] Error in getDeFiSnapshot:', error.message);
    return null;
  }
}

/**
 * Clear all caches (useful for testing)
 */
export function clearCache() {
  Object.keys(cache).forEach(key => {
    cache[key] = { data: null, timestamp: 0 };
  });
  console.log('[DeFiLlama] Cache cleared');
}

/**
 * Get cache status for debugging
 */
export function getCacheStatus() {
  const now = Date.now();
  return Object.entries(cache).map(([key, value]) => ({
    key,
    hasData: !!value.data,
    age: value.timestamp ? Math.round((now - value.timestamp) / 1000) : null,
    valid: isCacheValid(value)
  }));
}

export default {
  getTotalTVL,
  getChainTVLs,
  getDEXVolumes,
  getStablecoinFlows,
  getDeFiSnapshot,
  clearCache,
  getCacheStatus
};
