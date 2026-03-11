/**
 * Pre-Trade AI Gating Service (Local Rule Engine)
 *
 * Fast local rule-based check before executing a buy:
 *   - Evaluates RSI, volume, sentiment, trend alignment
 *   - Returns GO / REDUCE recommendation (never hard-blocks in Beast Mode)
 *   - No external API calls needed - instant, free, unlimited
 */

// ============================================
// STATE
// ============================================

const decisionCache = new Map(); // ticker -> { decision, timestamp, reason }
const CACHE_TTL_MS = 60000;      // Cache decisions for 60 seconds

// ============================================
// CONFIGURATION (kept for backward compat)
// ============================================

export function setGeminiKey(_key) {
  // No-op: local engine doesn't need API key
}

// ============================================
// CORE: LOCAL RULE ENGINE
// ============================================

/**
 * Get a pre-trade go/no-go decision using local rules.
 *
 * @param {string} ticker - e.g. "BTCUSD"
 * @param {Object} snapshot - { price, change5m, rsi, emaSlope, volume, strategy, sentiment, volumeRatio, mtfAligned }
 * @returns {Object} { decision: 'GO'|'REDUCE', reason, confidence }
 */
export async function getPreTradeDecision(ticker, snapshot) {
  // Check cache first
  const cached = decisionCache.get(ticker);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached, fromCache: true };
  }

  const result = evaluateRules(ticker, snapshot);

  // Cache the decision
  decisionCache.set(ticker, { ...result, timestamp: Date.now() });

  // Periodic cleanup: remove expired entries when cache grows
  if (decisionCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of decisionCache) {
      if (now - v.timestamp > CACHE_TTL_MS) decisionCache.delete(k);
    }
  }

  return { ...result, fromCache: false };
}

// ============================================
// RULE ENGINE
// ============================================

function evaluateRules(_ticker, s) {
  if (!s || typeof s !== 'object') {
    return { decision: 'GO', confidence: 50, reason: 'No snapshot data - default GO' };
  }

  let confidence = 60; // Start optimistic (Beast Mode)
  const flags = [];

  // --- RSI Rules (from the original Gemini prompt) ---
  const rsi = typeof s.rsi === 'number' ? s.rsi : null;
  if (rsi !== null) {
    if (rsi > 80) {
      confidence -= 30;
      flags.push(`Overbought RSI ${rsi.toFixed(0)}`);
    } else if (rsi > 70) {
      confidence -= 15;
      flags.push(`High RSI ${rsi.toFixed(0)}`);
    } else if (rsi < 15) {
      confidence -= 25;
      flags.push(`Falling knife RSI ${rsi.toFixed(0)}`);
    } else if (rsi < 30) {
      confidence += 10;
      flags.push(`Oversold bounce RSI ${rsi.toFixed(0)}`);
    } else if (rsi >= 40 && rsi <= 60) {
      confidence += 5;
    }
  }

  // --- Volume Rules ---
  const volRatio = typeof s.volumeRatio === 'number' ? s.volumeRatio : null;
  if (volRatio !== null) {
    if (volRatio < 0.3) {
      confidence -= 25;
      flags.push(`No liquidity (${volRatio.toFixed(1)}x vol)`);
    } else if (volRatio > 2.0) {
      confidence += 10;
      flags.push(`Strong volume ${volRatio.toFixed(1)}x`);
    } else if (volRatio > 1.0) {
      confidence += 5;
    }
  }

  // --- Sentiment Rules ---
  const sentiment = (s.sentiment || '').toUpperCase();
  if (sentiment.includes('EXTREME_FEAR') || sentiment.includes('CAPITULATION')) {
    confidence -= 15;
    flags.push('Extreme fear sentiment');
  } else if (sentiment.includes('FEAR')) {
    confidence -= 10;
    flags.push('Fear sentiment');
  } else if (sentiment.includes('GREED') || sentiment.includes('EUPHORIA')) {
    confidence += 5;
  }

  // --- Trend Rules ---
  const emaSlope = (s.emaSlope || '').toLowerCase();
  if (emaSlope === 'up' || emaSlope === 'bullish') {
    confidence += 10;
  } else if (emaSlope === 'down' || emaSlope === 'bearish') {
    confidence -= 10;
    flags.push('Against EMA trend');
  }

  // --- MTF Alignment ---
  if (s.mtfAligned === true || s.mtfAligned === 'yes') {
    confidence += 10;
  } else if (s.mtfAligned === false || s.mtfAligned === 'no') {
    confidence -= 5;
  }

  // --- 5-min momentum ---
  const change5m = typeof s.change5m === 'number' ? s.change5m : null;
  if (change5m !== null) {
    if (change5m > 3) {
      confidence -= 10;
      flags.push(`FOMO: already +${change5m.toFixed(1)}%`);
    } else if (change5m < -5) {
      confidence -= 10;
      flags.push(`Crash: ${change5m.toFixed(1)}% drop`);
    } else if (change5m > 0.2 && change5m < 2) {
      confidence += 5;
    }
  }

  // Clamp
  confidence = Math.max(10, Math.min(95, confidence));

  // Beast Mode: never hard block, just REDUCE
  let decision;
  if (confidence >= 45) {
    decision = 'GO';
  } else {
    decision = 'REDUCE';
  }

  const reason = flags.length > 0
    ? flags.slice(0, 3).join(', ')
    : 'All signals aligned';

  return { decision, confidence, reason };
}

// ============================================
// BATCH GATING (for bot loop efficiency)
// ============================================

/**
 * Gate multiple trade candidates using local rules.
 * Instant - no rate limiting needed.
 */
export async function gateTradesCandidates(candidates, _maxGeminiCalls = 3) {
  const results = [];

  for (const c of candidates) {
    const decision = await getPreTradeDecision(c.ticker, c.snapshot || {});
    c.aiDecision = decision;

    // Beast Mode: never hard block
    c.aiBlocked = false;
    c.aiReducePosition = decision.decision === 'REDUCE';
    c.aiReason = decision.reason;

    results.push(c);
  }

  return results;
}

// ============================================
// STATUS
// ============================================

export function getPreTradeAIStatus() {
  const cacheEntries = {};
  for (const [ticker, entry] of decisionCache) {
    cacheEntries[ticker] = {
      decision: entry.decision,
      reason: entry.reason,
      confidence: entry.confidence,
      ageSeconds: Math.round((Date.now() - entry.timestamp) / 1000),
    };
  }

  return {
    enabled: true,
    mode: 'local-rules',
    cacheSize: decisionCache.size,
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    cache: cacheEntries,
  };
}
