/**
 * New Coin Detector Service
 * Auto-detects new Kraken listings and provides rug-pull protection signals.
 *
 * Monitors the ticker list for new additions, tracks price/volume behavior,
 * and calculates a rug-pull risk score based on volume crashes, price drops,
 * spread widening, and volume/price divergence.
 */

// Dynamic imports with try/catch
let database = null;
let telegram = null;

try {
  database = await import('./database.js');
} catch (e) {
  console.warn('[NewCoinDetector] database not available:', e.message);
}

try {
  telegram = await import('./telegramService.js');
} catch (e) {
  console.warn('[NewCoinDetector] telegramService not available:', e.message);
}

// ============================================
// CONSTANTS
// ============================================

const RUG_PULL_SIGNALS = {
  VOLUME_CRASH: { threshold: 0.30, weight: 2 },         // volume drops to 30% of peak
  PRICE_DROP_FROM_PEAK: { threshold: -0.15, weight: 2 }, // 15% drop from 24h high
  SPREAD_WIDENING: { threshold: 0.01, weight: 1 },       // bid-ask > 1%
  VOLUME_PRICE_DIVERGENCE: { threshold: 0.5, weight: 1 }, // price up but volume dying
};

const NEW_COIN_TRADING_RULES = {
  positionSizeMultiplier: 0.5,   // 50% of normal size
  trailingStopPercent: 10,       // tighter trailing (10% vs normal 20%)
  maxHoldDays: 7,
  reEntryCooldownHours: 24,
};

const MAX_HOURLY_VOLUMES = 168;  // 7 days of hourly data
const MAX_LISTING_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ============================================
// STATE — namespaced by exchange (2026-05-06)
// ============================================
// Each exchange gets its own cache + listing map. Default 'kraken' preserves
// back-compat with V1 server.js callers that don't pass an exchange.
//
// DB persistence (known_tickers table) only covers Kraken — to add Crypto.com
// we'd need a schema migration to add an exchange column (SQLite doesn't
// support DROP CONSTRAINT, would require table rebuild). For now Crypto.com
// uses memory-only state and is warmup-acknowledged on every restart.

const DEFAULT_EXCHANGE = 'kraken';

// exchange => Set<ticker>
const knownByExchange = new Map();
knownByExchange.set(DEFAULT_EXCHANGE, new Set());

// exchange => Map<ticker, ListingState>
const listingsByExchange = new Map();
listingsByExchange.set(DEFAULT_EXCHANGE, new Map());

let initialized = false;

function getKnownCache(exchange) {
  const ex = exchange || DEFAULT_EXCHANGE;
  if (!knownByExchange.has(ex)) knownByExchange.set(ex, new Set());
  return knownByExchange.get(ex);
}

function getListings(exchange) {
  const ex = exchange || DEFAULT_EXCHANGE;
  if (!listingsByExchange.has(ex)) listingsByExchange.set(ex, new Map());
  return listingsByExchange.get(ex);
}

// ============================================
// HELPER: Send Telegram message safely
// ============================================

/**
 * Send a notification via Telegram. Uses alertCircuitBreaker as the
 * general-purpose message channel since telegramService does not
 * export a generic sendMessage function.
 */
function sendTelegramMessage(text) {
  try {
    if (!telegram) return;
    if (typeof telegram.isEnabled === 'function' && !telegram.isEnabled()) return;

    if (typeof telegram.alertCircuitBreaker === 'function') {
      telegram.alertCircuitBreaker(text);
    }
  } catch (e) {
    console.warn('[NewCoinDetector] Telegram notification failed:', e.message);
  }
}

// ============================================
// EXPORTS
// ============================================

/**
 * Bulk-acknowledge a set of tickers as already-known WITHOUT treating them as
 * new listings. Used by sniperEngine on cold start to warm up the in-memory
 * cache from the live Kraken pair list — prevents the entire universe from
 * being mis-flagged as "new" when initialize() can't load the DB cache for
 * any reason (race condition, fresh DB, etc.).
 */
export function acknowledgeKnownTickers(tickers, exchange = DEFAULT_EXCHANGE) {
  if (!Array.isArray(tickers) || tickers.length === 0) return 0;
  const cache = getKnownCache(exchange);
  let added = 0;
  for (const t of tickers) {
    if (!t || typeof t !== 'string') continue;
    if (!cache.has(t)) {
      cache.add(t);
      added++;
      // Persist only Kraken to DB (back-compat). Crypto.com is memory-only;
      // gets warmup-acknowledged on every restart.
      if (exchange === DEFAULT_EXCHANGE) {
        try {
          if (database && typeof database.upsertKnownTicker === 'function') {
            database.upsertKnownTicker(t, { acknowledged: true, source: 'sniper-warmup' });
          }
        } catch (e) {
          // Non-fatal — cache is the authoritative source for this run.
        }
      }
    }
  }
  if (added > 0) {
    console.log(`[NewCoinDetector] Acknowledged ${added} ticker(s) as known (warmup, no new-listing flag)`);
  }
  return added;
}

/**
 * Returns a copy of the new coin trading rules.
 */
export function getNewCoinRules() {
  return { ...NEW_COIN_TRADING_RULES };
}

/**
 * Initialize the detector by loading known tickers from DB into the kraken cache.
 * Other exchanges (e.g., crypto.com) start empty and rely on warmup-ack from
 * the engine that uses them.
 */
export function initialize() {
  try {
    if (!database || typeof database.getKnownTickers !== 'function') {
      console.warn('[NewCoinDetector] Database not available, starting with empty cache');
      initialized = true;
      return;
    }

    const rows = database.getKnownTickers();
    const cache = getKnownCache(DEFAULT_EXCHANGE);
    cache.clear();
    for (const row of rows) {
      cache.add(row.ticker);
    }

    initialized = true;
    console.log(`[NewCoinDetector] Initialized with ${cache.size} known kraken tickers`);
  } catch (e) {
    console.error('[NewCoinDetector] Initialize failed:', e.message);
    initialized = true; // still mark as initialized to avoid blocking
  }
}

/**
 * Compare an array of current tickers against the known cache.
 * Records new ones in DB and newListings map, sends Telegram alert for each.
 * Returns array of newly detected ticker strings.
 */
export function detectNewListings(currentTickers, exchange = DEFAULT_EXCHANGE) {
  if (!Array.isArray(currentTickers) || currentTickers.length === 0) return [];

  const cache = getKnownCache(exchange);
  const listings = getListings(exchange);
  const newlyDetected = [];
  const now = Date.now();

  for (const ticker of currentTickers) {
    if (!ticker || typeof ticker !== 'string') continue;

    if (!cache.has(ticker)) {
      // New ticker found
      cache.add(ticker);
      newlyDetected.push(ticker);

      // Initialize tracking entry
      listings.set(ticker, {
        firstSeen: now,
        peakPrice: 0,
        peakVolume: 0,
        lastPrice: 0,
        lastVolume: 0,
        hourlyVolumes: [],
        rugPullScore: 0,
        signals: [],
        exitedRugPull: false,
        cooldownUntil: null,
      });

      // Persist to DB only for Kraken (back-compat with V1 server.js loop).
      if (exchange === DEFAULT_EXCHANGE) {
        try {
          if (database && typeof database.upsertKnownTicker === 'function') {
            database.upsertKnownTicker(ticker, { detectedAt: now, source: 'newCoinDetector' });
          }
        } catch (e) {
          console.error(`[NewCoinDetector] Failed to persist ticker ${ticker}:`, e.message);
        }
      }

      sendTelegramMessage(`New listing detected (${exchange}): ${ticker}`);
      console.log(`[NewCoinDetector] New listing detected (${exchange}): ${ticker}`);
    }
  }

  return newlyDetected;
}

/**
 * Update price/volume tracking for a new listing and calculate rug-pull signals.
 * Returns signal data object with shouldExitRugPull flag.
 */
export function updateNewCoinSignals(ticker, price, volume, spread, exchange = DEFAULT_EXCHANGE) {
  const listings = getListings(exchange);

  // Periodic cleanup: prune listings older than 30 days every 100 calls (per exchange)
  if (!updateNewCoinSignals._callCount) updateNewCoinSignals._callCount = new Map();
  const counts = updateNewCoinSignals._callCount;
  counts.set(exchange, (counts.get(exchange) || 0) + 1);
  if (counts.get(exchange) % 100 === 0) {
    const now = Date.now();
    for (const [t, l] of listings.entries()) {
      if (now - l.firstSeen > MAX_LISTING_AGE_MS) listings.delete(t);
    }
  }

  const listing = listings.get(ticker);
  if (!listing) {
    return { isNewListing: false, rugPullScore: 0, signals: [], shouldExitRugPull: false };
  }

  // Update peak tracking
  if (price > listing.peakPrice) {
    listing.peakPrice = price;
  }
  if (volume > listing.peakVolume) {
    listing.peakVolume = volume;
  }

  listing.lastPrice = price;
  listing.lastVolume = volume;

  // Track hourly volumes (keep last 168 entries = 7 days)
  listing.hourlyVolumes.push(volume);
  if (listing.hourlyVolumes.length > MAX_HOURLY_VOLUMES) {
    listing.hourlyVolumes.shift();
  }

  // Calculate rug-pull signals
  let rugPullScore = 0;
  const signals = [];

  // VOLUME_CRASH: volume / peakVolume <= 0.30
  if (listing.peakVolume > 0 && volume / listing.peakVolume <= RUG_PULL_SIGNALS.VOLUME_CRASH.threshold) {
    rugPullScore += RUG_PULL_SIGNALS.VOLUME_CRASH.weight;
    signals.push({
      type: 'VOLUME_CRASH',
      value: volume / listing.peakVolume,
      threshold: RUG_PULL_SIGNALS.VOLUME_CRASH.threshold,
      weight: RUG_PULL_SIGNALS.VOLUME_CRASH.weight,
    });
  }

  // PRICE_DROP_FROM_PEAK: (price - peakPrice) / peakPrice <= -0.15
  if (listing.peakPrice > 0) {
    const priceDropPct = (price - listing.peakPrice) / listing.peakPrice;
    if (priceDropPct <= RUG_PULL_SIGNALS.PRICE_DROP_FROM_PEAK.threshold) {
      rugPullScore += RUG_PULL_SIGNALS.PRICE_DROP_FROM_PEAK.weight;
      signals.push({
        type: 'PRICE_DROP_FROM_PEAK',
        value: priceDropPct,
        threshold: RUG_PULL_SIGNALS.PRICE_DROP_FROM_PEAK.threshold,
        weight: RUG_PULL_SIGNALS.PRICE_DROP_FROM_PEAK.weight,
      });
    }
  }

  // SPREAD_WIDENING: spread > 0.01
  if (spread > RUG_PULL_SIGNALS.SPREAD_WIDENING.threshold) {
    rugPullScore += RUG_PULL_SIGNALS.SPREAD_WIDENING.weight;
    signals.push({
      type: 'SPREAD_WIDENING',
      value: spread,
      threshold: RUG_PULL_SIGNALS.SPREAD_WIDENING.threshold,
      weight: RUG_PULL_SIGNALS.SPREAD_WIDENING.weight,
    });
  }

  // VOLUME_PRICE_DIVERGENCE: last 3 hourly volumes declining (latest < first * 0.5) AND price rising
  if (listing.hourlyVolumes.length >= 3) {
    const recent3 = listing.hourlyVolumes.slice(-3);
    const volumeDeclining = recent3[2] < recent3[0] * RUG_PULL_SIGNALS.VOLUME_PRICE_DIVERGENCE.threshold;
    const priceRising = listing.peakPrice > 0 && price >= listing.peakPrice * 0.95; // price still near peak or rising

    if (volumeDeclining && priceRising) {
      rugPullScore += RUG_PULL_SIGNALS.VOLUME_PRICE_DIVERGENCE.weight;
      signals.push({
        type: 'VOLUME_PRICE_DIVERGENCE',
        value: recent3[2] / (recent3[0] || 1),
        threshold: RUG_PULL_SIGNALS.VOLUME_PRICE_DIVERGENCE.threshold,
        weight: RUG_PULL_SIGNALS.VOLUME_PRICE_DIVERGENCE.weight,
      });
    }
  }

  // Update listing state
  listing.rugPullScore = rugPullScore;
  listing.signals = signals;

  const shouldExitRugPull = rugPullScore >= 3;

  // Record signals in DB
  if (signals.length > 0) {
    try {
      if (database && typeof database.insertNewCoinSignal === 'function') {
        for (const signal of signals) {
          database.insertNewCoinSignal(ticker, signal.type, signal.value, {
            threshold: signal.threshold,
            weight: signal.weight,
            rugPullScore,
            shouldExit: shouldExitRugPull,
          });
        }
      }
    } catch (e) {
      console.error(`[NewCoinDetector] Failed to record signals for ${ticker}:`, e.message);
    }
  }

  return {
    isNewListing: true,
    rugPullScore,
    signals,
    shouldExitRugPull,
    peakPrice: listing.peakPrice,
    peakVolume: listing.peakVolume,
    lastPrice: listing.lastPrice,
    lastVolume: listing.lastVolume,
  };
}

/**
 * Mark a ticker as having triggered a rug-pull exit.
 * Sets cooldown and sends Telegram alert.
 */
export function markRugPullExit(ticker, exchange = DEFAULT_EXCHANGE) {
  const listings = getListings(exchange);
  const listing = listings.get(ticker);
  if (!listing) return;

  listing.exitedRugPull = true;
  listing.cooldownUntil = Date.now() + (NEW_COIN_TRADING_RULES.reEntryCooldownHours * 60 * 60 * 1000);

  sendTelegramMessage(
    `Rug-pull exit triggered for ${ticker} | ` +
    `Score: ${listing.rugPullScore} | ` +
    `Signals: ${listing.signals.map(s => s.type).join(', ')} | ` +
    `Cooldown: ${NEW_COIN_TRADING_RULES.reEntryCooldownHours}h`
  );

  console.log(`[NewCoinDetector] Rug-pull exit: ${ticker} (score=${listing.rugPullScore})`);
}

/**
 * Check if a ticker is tracked as a new listing on the given exchange.
 */
export function isNewListing(ticker, exchange = DEFAULT_EXCHANGE) {
  return getListings(exchange).has(ticker);
}

/**
 * Returns array of all tracked new listings with their signal data for the
 * given exchange. Cleans up listings older than 30 days.
 */
export function getActiveNewListings(exchange = DEFAULT_EXCHANGE) {
  const now = Date.now();
  const listings = getListings(exchange);
  const active = [];

  for (const [ticker, listing] of listings.entries()) {
    if (now - listing.firstSeen > MAX_LISTING_AGE_MS) {
      listings.delete(ticker);
      continue;
    }

    active.push({
      ticker,
      exchange,
      firstSeen: listing.firstSeen,
      ageDays: ((now - listing.firstSeen) / (24 * 60 * 60 * 1000)).toFixed(1),
      peakPrice: listing.peakPrice,
      peakVolume: listing.peakVolume,
      lastPrice: listing.lastPrice,
      lastVolume: listing.lastVolume,
      rugPullScore: listing.rugPullScore,
      signals: listing.signals,
      exitedRugPull: listing.exitedRugPull,
      cooldownUntil: listing.cooldownUntil,
      isOnCooldown: listing.cooldownUntil ? now < listing.cooldownUntil : false,
      hourlyVolumeCount: listing.hourlyVolumes.length,
    });
  }

  return active;
}

/**
 * Returns summary stats for the detector across all tracked exchanges.
 */
export function getStats() {
  const perExchange = {};
  for (const [ex, cache] of knownByExchange.entries()) {
    perExchange[ex] = {
      knownTickers: cache.size,
      activeNewListings: (listingsByExchange.get(ex) ?? new Map()).size,
    };
  }
  return {
    initialized,
    perExchange,
  };
}

export default {
  getNewCoinRules,
  initialize,
  acknowledgeKnownTickers,
  detectNewListings,
  updateNewCoinSignals,
  markRugPullExit,
  isNewListing,
  getActiveNewListings,
  getStats,
};
