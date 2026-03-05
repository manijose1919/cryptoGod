/**
 * API Key Health Monitor
 * Tracks which API keys are configured, their last success time, and error counts.
 */

const API_KEYS = [
  { id: 'ANTHROPIC_API_KEY', label: 'Claude AI', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'YOUTUBE_API_KEY', label: 'YouTube Data', envVar: 'YOUTUBE_API_KEY' },
  { id: 'CRYPTOPANIC_API_KEY', label: 'CryptoPanic', envVar: 'CRYPTOPANIC_API_KEY' },
  { id: 'COINMARKETCAP_API_KEY', label: 'CoinMarketCap', envVar: 'COINMARKETCAP_API_KEY' },
  { id: 'ETHERSCAN_API_KEY', label: 'Etherscan', envVar: 'ETHERSCAN_API_KEY' },
  { id: 'DISCORD_WEBHOOK_URL', label: 'Discord Webhook', envVar: 'DISCORD_WEBHOOK_URL' },
  { id: 'TELEGRAM_BOT_TOKEN', label: 'Telegram Bot', envVar: 'TELEGRAM_BOT_TOKEN' },
  { id: 'KRAKEN_API_KEY', label: 'Kraken API', envVar: 'KRAKEN_API_KEY' },
  { id: 'KRAKEN_API_SECRET', label: 'Kraken Secret', envVar: 'KRAKEN_API_SECRET' },
];

// Track runtime stats per key
const stats = new Map(); // id -> { lastSuccess, lastError, errorCount, callCount }

export function initApiKeyHealthMonitor() {
  for (const key of API_KEYS) {
    stats.set(key.id, {
      lastSuccess: null,
      lastError: null,
      errorCount: 0,
      callCount: 0,
    });
  }
  console.log('[APIKeyHealth] Monitor initialized');
}

/**
 * Record a successful API call for a key.
 */
export function recordSuccess(keyId) {
  const s = stats.get(keyId);
  if (s) {
    s.lastSuccess = Date.now();
    s.callCount++;
  }
}

/**
 * Record a failed API call for a key.
 */
export function recordError(keyId, errorMsg = '') {
  const s = stats.get(keyId);
  if (s) {
    s.lastError = { time: Date.now(), message: errorMsg };
    s.errorCount++;
    s.callCount++;
  }
}

/**
 * Get health status of all API keys.
 */
export function getApiKeyHealth() {
  return API_KEYS.map(key => {
    const configured = !!process.env[key.envVar];
    const s = stats.get(key.id) || {};
    const masked = configured
      ? process.env[key.envVar].substring(0, 4) + '...' + process.env[key.envVar].slice(-4)
      : null;

    return {
      id: key.id,
      label: key.label,
      configured,
      maskedKey: masked,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      lastError: s.lastError ? { time: new Date(s.lastError.time).toISOString(), message: s.lastError.message } : null,
      errorCount: s.errorCount || 0,
      callCount: s.callCount || 0,
      status: !configured ? 'unconfigured' : (s.errorCount > 5 && !s.lastSuccess) ? 'failing' : 'ok',
    };
  });
}

export default { initApiKeyHealthMonitor, recordSuccess, recordError, getApiKeyHealth };
