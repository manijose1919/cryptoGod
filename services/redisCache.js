/**
 * Redis Cache Layer
 * Wraps ioredis with fail-open fallback to in-memory Maps.
 * If Redis is unavailable, all operations silently use local cache.
 */

let Redis;
try {
  const mod = await import('ioredis');
  Redis = mod.default || mod;
} catch (e) {
  console.warn('[RedisCache] ioredis not installed, using in-memory fallback');
}

const LOG = '[RedisCache]';

// In-memory fallback cache
const memCache = new Map();
const memTTLs = new Map(); // key -> expiry timestamp

let client = null;
let connected = false;

/**
 * Initialize Redis connection (fail-open)
 */
export function initRedis() {
  if (!Redis) {
    console.log(`${LOG} No Redis driver — in-memory mode`);
    return false;
  }
  try {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 3000)),
      connectTimeout: 5000,
      lazyConnect: true,
    });

    client.on('connect', () => { connected = true; console.log(`${LOG} Connected`); });
    client.on('error', (err) => { connected = false; console.warn(`${LOG} Error: ${err.message}`); });
    client.on('close', () => { connected = false; });

    client.connect().catch(() => {
      console.warn(`${LOG} Could not connect — falling back to in-memory`);
      connected = false;
    });

    return true;
  } catch (e) {
    console.warn(`${LOG} Init failed: ${e.message}`);
    return false;
  }
}

function isReady() {
  return client && connected;
}

// Cleanup expired in-memory entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of memTTLs) {
    if (now > expiry) { memCache.delete(key); memTTLs.delete(key); }
  }
}, 60000);

/**
 * Get a string value
 */
export async function get(key) {
  try {
    if (isReady()) return await client.get(key);
  } catch { /* fall through */ }
  // In-memory fallback
  const expiry = memTTLs.get(key);
  if (expiry && Date.now() > expiry) { memCache.delete(key); memTTLs.delete(key); return null; }
  return memCache.get(key) || null;
}

/**
 * Set a string value with optional TTL (seconds)
 */
export async function set(key, value, ttlSeconds) {
  try {
    if (isReady()) {
      if (ttlSeconds) await client.set(key, value, 'EX', ttlSeconds);
      else await client.set(key, value);
      return;
    }
  } catch { /* fall through */ }
  memCache.set(key, value);
  if (ttlSeconds) memTTLs.set(key, Date.now() + ttlSeconds * 1000);
}

/**
 * Delete a key
 */
export async function del(key) {
  try { if (isReady()) await client.del(key); } catch { /* ignore */ }
  memCache.delete(key);
  memTTLs.delete(key);
}

/**
 * Get a JSON-parsed value
 */
export async function getJSON(key) {
  const raw = await get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Set a JSON value with optional TTL
 */
export async function setJSON(key, obj, ttlSeconds) {
  await set(key, JSON.stringify(obj), ttlSeconds);
}

/**
 * Get cache stats
 */
export function getStats() {
  return {
    redisConnected: connected,
    memCacheSize: memCache.size,
    mode: connected ? 'redis' : 'in-memory',
  };
}

export function isConnected() { return connected; }

// Auto-init on import
initRedis();
