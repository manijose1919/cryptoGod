# Multi-Timeframe Regime Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow 15m DOWN tickers through the V2 scanner when the 4h regime is UP/STRONG_UP (pullback-in-uptrend pattern), with 75% position sizing and separate attribution tracking.

**Architecture:** Fetch 4h candles from Kraken REST alongside existing 15m candles. When the scanner rejects a ticker for DOWN regime on 15m, run `detectRegime()` on 4h candles. If 4h is UP/STRONG_UP, pass the ticker through tagged as `PULLBACK_UP`. Risk gate applies 0.75x position multiplier. Attribution tracks pullback trades separately.

**Tech Stack:** TypeScript (ES Modules, `.ts` imports), Kraken REST OHLC API (interval=240), existing V2 pipeline infrastructure.

---

## Decision Log

| Decision | Alternatives | Why |
|----------|-------------|-----|
| Fetch 4h candles via separate REST call | Aggregate 15m→4h | Kraken natively supports 4h interval; more accurate than aggregation, simpler code |
| Use 1h regime as secondary check | Only 4h | 4h is higher quality — 1h is too noisy, only marginally better than 15m |
| 75% position size for pullbacks | 100% or 50% | Conservative start; can adjust up based on attribution data |
| Cache 4h regime for 15 minutes | No cache / 4h cache | 4h bars change slowly; 15min avoids redundant API calls without stale data |
| Tag as `PULLBACK_UP` regime | New strategy type | Regime tag is simpler; keeps TREND strategy logic unchanged, just different entry context |
| Same signal scoring for pullbacks | Separate signal weights | YAGNI — same quality gate, just different regime allowance. Separate weights can be added later if attribution shows divergence |

---

### Task 1: Add PULLBACK_UP regime and config

**Files:**
- Modify: `v2/pipeline/types.ts` (add PULLBACK_UP to REGIME const)
- Modify: `v2/engine/config.ts` (add MTF config section)

**Step 1: Add PULLBACK_UP to REGIME constant in types.ts**

In `v2/pipeline/types.ts`, add `PULLBACK_UP` to the REGIME object:

```typescript
export const REGIME = {
  STRONG_UP: 'STRONG_UP',
  UP: 'UP',
  SIDEWAYS: 'SIDEWAYS',
  DOWN: 'DOWN',
  STRONG_DOWN: 'STRONG_DOWN',
  PULLBACK_UP: 'PULLBACK_UP',
} as const;
```

**Step 2: Add MTF config to config.ts**

In `v2/engine/config.ts`, add after the `TC_CONSENSUS_MIN` line (before `} as const`):

```typescript
  // --- Multi-Timeframe Regime ---
  MTF_ENABLED: true,
  MTF_HIGHER_TIMEFRAME: '4h' as string,
  MTF_ALLOWED_HIGHER_REGIMES: ['STRONG_UP', 'UP'] as readonly string[],
  MTF_POSITION_MULTIPLIER: 0.75,       // 75% of normal size for pullback entries
  MTF_REGIME_CACHE_TTL_MS: 15 * 60 * 1000,  // Cache 4h regime for 15 minutes
  MTF_MAX_15M_REGIME: ['DOWN'] as readonly string[],  // Only rescue DOWN (not STRONG_DOWN)
```

**Step 3: Commit**

```bash
git add v2/pipeline/types.ts v2/engine/config.ts
git commit -m "feat(v2): add PULLBACK_UP regime type and MTF config"
```

---

### Task 2: Add 4h candle fetching with cache to tradeEngine

**Files:**
- Modify: `v2/engine/tradeEngine.ts` (add fetch4hCandles function and 4h cache)

**Step 1: Add 4h candle fetcher with per-ticker cache**

In `v2/engine/tradeEngine.ts`, add after the existing `fetchCandles` function (after line 159):

```typescript
// --- 4h Candle Cache for MTF Regime ---

const _4hCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

async function fetch4hCandles(ticker: string): Promise<Candle[] | null> {
  // Check cache
  const cached = _4hCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < V2_CONFIG.MTF_REGIME_CACHE_TTL_MS) {
    return cached.candles;
  }

  try {
    const adapterModule = await import('../../services/exchangeAdapters/krakenAdapter.js');
    const adapter = adapterModule.krakenAdapter;
    const candles = await adapter.getCandles(ticker, '4h', 200);
    if (candles && candles.length > 0) {
      const normalized = normalizeCandles(candles);
      _4hCache.set(ticker, { candles: normalized, fetchedAt: Date.now() });
      return normalized;
    }
  } catch {
    // 4h fetch failed — return cached if available (even if stale)
    if (cached) return cached.candles;
  }

  return null;
}
```

**Step 2: Export fetch4hCandles for use by scanner**

Also add an export wrapper so the scanner can access it:

```typescript
/** Fetch 4h candles for MTF regime detection (cached) */
export { fetch4hCandles };
```

**Step 3: Commit**

```bash
git add v2/engine/tradeEngine.ts
git commit -m "feat(v2): add cached 4h candle fetcher for MTF regime"
```

---

### Task 3: Add MTF regime check to market scanner

**Files:**
- Modify: `v2/pipeline/marketScanner.ts` (add pullback-in-uptrend bypass)

**Step 1: Convert scanMarket to async and add MTF bypass**

The scanner needs to become async since fetching 4h candles is async. Replace the entire `scanMarket` function:

```typescript
import { detectRegime } from '../indicators/indicators.ts';

// --- 4h Regime Cache (populated by tradeEngine, read by scanner) ---

const _htfRegimeCache = new Map<string, { regime: string; fetchedAt: number }>();

/**
 * Set higher-timeframe regime for a ticker (called from tradeEngine after fetching 4h candles).
 */
export function setHTFRegime(ticker: string, regime: string): void {
  _htfRegimeCache.set(ticker, { regime, fetchedAt: Date.now() });
}

/**
 * Get cached higher-timeframe regime for a ticker.
 * Returns null if not cached or expired.
 */
function getHTFRegime(ticker: string): string | null {
  const cached = _htfRegimeCache.get(ticker);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > V2_CONFIG.MTF_REGIME_CACHE_TTL_MS) return null;
  return cached.regime;
}
```

Then modify the regime rejection block in `scanMarket` (around line 46). After the existing regime check rejects a ticker, add the MTF rescue logic:

```typescript
    // Gate 2: regime filter
    if (!allowedRegimes.has(regimeResult.regime)) {
      // --- MTF Pullback Rescue ---
      // If 15m is DOWN (not STRONG_DOWN) and MTF is enabled,
      // check if 4h regime is bullish → pullback-in-uptrend
      if (
        V2_CONFIG.MTF_ENABLED &&
        (V2_CONFIG.MTF_MAX_15M_REGIME as readonly string[]).includes(regimeResult.regime)
      ) {
        const htfRegime = getHTFRegime(ticker);
        if (htfRegime && (V2_CONFIG.MTF_ALLOWED_HIGHER_REGIMES as readonly string[]).includes(htfRegime)) {
          // Pullback in uptrend — allow through with PULLBACK_UP tag
          results.push({
            ticker,
            passed: true,
            regime: REGIME.PULLBACK_UP,
            atrPercent: regimeResult.atrPercent,
            volumeUsd24h: 0, // Will be computed in Gate 4 below — skip for now, re-check below
            spreadPercent: 0,
            reason: `PULLBACK: 15m=${regimeResult.regime}, 4h=${htfRegime} → allowed as pullback-in-uptrend`,
          });
          continue;
        }
      }

      // Normal rejection
      results.push({
        ticker,
        passed: false,
        regime: regimeResult.regime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `Regime ${regimeResult.regime} not in allowed: [${V2_CONFIG.ALLOWED_REGIMES.join(', ')}]`,
      });
      continue;
    }
```

**Important:** The pullback path currently skips the volume/ATR/spread gates (Gates 3-4). We need to restructure so pullback tickers still go through those gates. The cleanest approach: instead of `continue` after the pullback push, let the ticker fall through to the remaining gates. This requires changing the flow slightly — set a flag and let it continue:

Actually, the simplest refactor: extract the regime check into a boolean, and let all tickers flow through all gates sequentially. Here's the full replacement for `scanMarket`:

```typescript
export function scanMarket(tickerCandles: Map<string, Candle[]>): ScanResult[] {
  const results: ScanResult[] = [];
  const allowedRegimes: ReadonlySet<string> = new Set(V2_CONFIG.ALLOWED_REGIMES);

  for (const [ticker, candles] of tickerCandles) {
    // Gate 1: minimum candle count
    if (candles.length < V2_CONFIG.MIN_CANDLES) {
      results.push(makeReject(ticker, `Insufficient candles: ${candles.length} < ${V2_CONFIG.MIN_CANDLES}`));
      continue;
    }

    // Compute regime
    const regimeResult = detectRegime(candles);

    // Gate 2: regime filter (with MTF pullback rescue)
    let effectiveRegime = regimeResult.regime;
    let isPullback = false;

    if (!allowedRegimes.has(regimeResult.regime)) {
      // Check MTF rescue: 15m is DOWN, 4h might be bullish
      if (
        V2_CONFIG.MTF_ENABLED &&
        (V2_CONFIG.MTF_MAX_15M_REGIME as readonly string[]).includes(regimeResult.regime)
      ) {
        const htfRegime = getHTFRegime(ticker);
        if (htfRegime && (V2_CONFIG.MTF_ALLOWED_HIGHER_REGIMES as readonly string[]).includes(htfRegime)) {
          effectiveRegime = REGIME.PULLBACK_UP;
          isPullback = true;
          // Fall through to remaining gates
        } else {
          // 4h not bullish or not cached — reject
          const htfNote = htfRegime ? `, 4h=${htfRegime}` : ', 4h=unknown';
          results.push({
            ticker,
            passed: false,
            regime: regimeResult.regime,
            atrPercent: regimeResult.atrPercent,
            volumeUsd24h: 0,
            spreadPercent: 0,
            reason: `Regime ${regimeResult.regime} not in allowed: [${V2_CONFIG.ALLOWED_REGIMES.join(', ')}]${htfNote}`,
          });
          continue;
        }
      } else {
        results.push({
          ticker,
          passed: false,
          regime: regimeResult.regime,
          atrPercent: regimeResult.atrPercent,
          volumeUsd24h: 0,
          spreadPercent: 0,
          reason: `Regime ${regimeResult.regime} not in allowed: [${V2_CONFIG.ALLOWED_REGIMES.join(', ')}]`,
        });
        continue;
      }
    }

    // Gate 2b: Regime momentum gate (skip for pullbacks — they're already in DOWN, slope is expected negative)
    if (!isPullback && effectiveRegime === REGIME.SIDEWAYS) {
      const closes = candles.map((c) => c.close);
      const ema20 = ema(closes, 20);
      const lookback = V2_CONFIG.REGIME_MOMENTUM_LOOKBACK;
      if (ema20.length >= lookback + 1) {
        const recentEma = ema20[ema20.length - 1];
        const pastEma = ema20[ema20.length - 1 - lookback];
        const slope = pastEma !== 0 ? (recentEma - pastEma) / pastEma : 0;
        if (slope < V2_CONFIG.REGIME_MOMENTUM_MIN_SLOPE) {
          results.push({
            ticker,
            passed: false,
            regime: regimeResult.regime,
            atrPercent: regimeResult.atrPercent,
            volumeUsd24h: 0,
            spreadPercent: 0,
            reason: `SIDEWAYS deteriorating: EMA20 slope ${(slope * 100).toFixed(3)}% < ${(V2_CONFIG.REGIME_MOMENTUM_MIN_SLOPE * 100).toFixed(1)}%`,
          });
          continue;
        }
      }
    }

    // Gate 3: ATR percent (volatility floor)
    if (regimeResult.atrPercent < V2_CONFIG.MIN_ATR_PERCENT) {
      results.push({
        ticker,
        passed: false,
        regime: effectiveRegime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `ATR% ${regimeResult.atrPercent.toFixed(3)} < min ${V2_CONFIG.MIN_ATR_PERCENT}`,
      });
      continue;
    }

    // Gate 3b: ATR percent ceiling
    if (V2_CONFIG.MAX_ATR_PERCENT && regimeResult.atrPercent > V2_CONFIG.MAX_ATR_PERCENT) {
      results.push({
        ticker,
        passed: false,
        regime: effectiveRegime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h: 0,
        spreadPercent: 0,
        reason: `ATR% ${regimeResult.atrPercent.toFixed(3)} > max ${V2_CONFIG.MAX_ATR_PERCENT} (extreme volatility)`,
      });
      continue;
    }

    // Gate 4: estimated 24h volume
    const recentCandles = candles.slice(-20);
    const avgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
    const lastPrice = candles[candles.length - 1].close;
    const intervalMinutes = V2_CONFIG.CANDLE_INTERVAL === '1m' ? 1
      : V2_CONFIG.CANDLE_INTERVAL === '5m' ? 5
      : V2_CONFIG.CANDLE_INTERVAL === '15m' ? 15
      : V2_CONFIG.CANDLE_INTERVAL === '1h' ? 60
      : V2_CONFIG.CANDLE_INTERVAL === '4h' ? 240 : 1;
    const candlesPerDay = 1440 / intervalMinutes;
    const volumeUsd24h = avgVolume * lastPrice * candlesPerDay;

    if (volumeUsd24h < V2_CONFIG.MIN_VOLUME_24H_USD) {
      results.push({
        ticker,
        passed: false,
        regime: effectiveRegime,
        atrPercent: regimeResult.atrPercent,
        volumeUsd24h,
        spreadPercent: 0,
        reason: `24h volume $${volumeUsd24h.toFixed(0)} < min $${V2_CONFIG.MIN_VOLUME_24H_USD}`,
      });
      continue;
    }

    // Spread from last candle
    const lastCandle = candles[candles.length - 1];
    const spreadPercent = lastCandle.close !== 0
      ? ((lastCandle.high - lastCandle.low) / lastCandle.close) * 100
      : 0;

    // All gates passed
    const pullbackNote = isPullback ? ' (pullback-in-uptrend)' : '';
    results.push({
      ticker,
      passed: true,
      regime: effectiveRegime,
      atrPercent: regimeResult.atrPercent,
      volumeUsd24h,
      spreadPercent,
      reason: `PASS: regime=${effectiveRegime}, ATR%=${regimeResult.atrPercent.toFixed(3)}, vol24h=$${volumeUsd24h.toFixed(0)}${pullbackNote}`,
    });
  }

  return results;
}
```

**Step 2: Commit**

```bash
git add v2/pipeline/marketScanner.ts
git commit -m "feat(v2): add MTF pullback rescue to market scanner"
```

---

### Task 4: Wire 4h fetching into the trade engine loop

**Files:**
- Modify: `v2/engine/tradeEngine.ts` (fetch 4h candles and populate HTF regime cache)

**Step 1: Import setHTFRegime from scanner and detectRegime from indicators**

At the top of `tradeEngine.ts`, add to imports:

```typescript
import { scanMarket, getPassedTickers, setHTFRegime } from '../pipeline/marketScanner.ts';
import { detectRegime } from '../indicators/indicators.ts';
```

(Replace the existing `scanMarket, getPassedTickers` import line.)

**Step 2: Add 4h regime population in Stage 0**

In the `runLoop` function, after the 15m candle fetch completes (after the `stats.candleCounts` block, around line 272), add:

```typescript
    // ==============================
    // Stage 0b: Fetch 4h candles for MTF regime (parallel)
    // ==============================
    if (V2_CONFIG.MTF_ENABLED) {
      const htfResults = await Promise.allSettled(
        V2_CONFIG.SCAN_TICKERS.map(async (ticker) => {
          const candles4h = await fetch4hCandles(ticker);
          if (candles4h && candles4h.length >= 50) {
            const regime4h = detectRegime(candles4h);
            setHTFRegime(ticker, regime4h.regime);
          }
          return ticker;
        }),
      );
      // Log HTF regimes every 10 loops
      if (stats.loopCount % 10 === 1) {
        for (const ticker of V2_CONFIG.SCAN_TICKERS) {
          const cached = _4hCache.get(ticker);
          if (cached) {
            const regime4h = detectRegime(cached.candles);
            console.log(`[V2] HTF ${ticker}: 4h regime=${regime4h.regime}`);
          }
        }
      }
    }
```

**Step 3: Commit**

```bash
git add v2/engine/tradeEngine.ts
git commit -m "feat(v2): wire 4h candle fetch and HTF regime cache into bot loop"
```

---

### Task 5: Apply 75% position multiplier for PULLBACK_UP in risk gate

**Files:**
- Modify: `v2/pipeline/riskGate.ts` (reduce position size for pullback entries)

**Step 1: Import REGIME from types**

Add to imports at top of `riskGate.ts`:

```typescript
import { REGIME } from './types.ts';
```

**Step 2: Apply pullback multiplier in position sizing**

In `evaluateRisk`, find the position sizing line (around line 134):

```typescript
    const positionSizeUsd = maxPositionUsd * signal.confidence * fgMultiplier;
```

Replace with:

```typescript
    // Apply pullback multiplier for MTF entries (75% of normal size)
    const pullbackMult = signal.regime === REGIME.PULLBACK_UP
      ? V2_CONFIG.MTF_POSITION_MULTIPLIER
      : 1.0;
    const positionSizeUsd = maxPositionUsd * signal.confidence * fgMultiplier * pullbackMult;
```

**Step 3: Update reason string to show pullback multiplier**

In the APPROVED reason string (around line 158), add pullback info:

```typescript
    const pullbackNote = signal.regime === REGIME.PULLBACK_UP ? `, pullback=${pullbackMult}x` : '';
    reason: `APPROVED: size=$${positionSizeUsd.toFixed(2)}, SL=${stopLoss.toFixed(2)}, TP=${takeProfit.toFixed(2)}, ER=${(expectedReturn * 100).toFixed(2)}%, F&G=${fgMultiplier}x${pullbackNote}`,
```

**Step 4: Commit**

```bash
git add v2/pipeline/riskGate.ts
git commit -m "feat(v2): apply 75% position multiplier for PULLBACK_UP entries"
```

---

### Task 6: Handle PULLBACK_UP in signal generator scoring

**Files:**
- Modify: `v2/pipeline/signalGenerator.ts` (regime bonus for pullback)

**Step 1: Add PULLBACK_UP regime bonus**

In `generateSignals`, find the regime bonus block (around line 206):

```typescript
    // Regime bonus: reward trend alignment (we only trade UP/STRONG_UP/SIDEWAYS)
    if (regime.regime === 'STRONG_UP') compositeScore += 8;
    else if (regime.regime === 'UP') compositeScore += 5;
```

Replace with:

```typescript
    // Regime bonus: reward trend alignment
    if (regime.regime === 'STRONG_UP') compositeScore += 8;
    else if (regime.regime === 'UP') compositeScore += 5;
    else if (regime.regime === 'PULLBACK_UP') compositeScore += 3;  // Small bonus — 4h trend is bullish but 15m is against us
```

**Step 2: Commit**

```bash
git add v2/pipeline/signalGenerator.ts
git commit -m "feat(v2): add +3 regime bonus for PULLBACK_UP entries"
```

---

### Task 7: Update V2 status API to show MTF info

**Files:**
- Modify: `v2/engine/tradeEngine.ts` (add HTF regimes to status output)

**Step 1: Add htfRegimes to stats object**

Add to the `stats` object (around line 37):

```typescript
  htfRegimes: {} as Record<string, string>,
```

**Step 2: Populate htfRegimes in Stage 0b**

In the MTF fetch block (added in Task 4), after `setHTFRegime`, also update stats:

```typescript
            setHTFRegime(ticker, regime4h.regime);
            stats.htfRegimes[ticker] = regime4h.regime;
```

**Step 3: Add to status interface and getV2Status**

Add `htfRegimes` to `V2EngineStatus` interface:

```typescript
  htfRegimes?: Record<string, string>;
```

Add to `getV2Status()` return:

```typescript
    htfRegimes: stats.htfRegimes,
```

**Step 4: Commit**

```bash
git add v2/engine/tradeEngine.ts
git commit -m "feat(v2): expose HTF regime data in V2 status API"
```

---

### Task 8: Update Telegram alerts for pullback trades

**Files:**
- Modify: `v2/engine/tradeEngine.ts` (tag pullback in Telegram messages)

**Step 1: Modify sendEntryAlert to show pullback tag**

In `sendEntryAlert` (around line 83), update the strategy string:

```typescript
async function sendEntryAlert(trade: V2Trade): Promise<void> {
  try {
    const tg = await import('../../services/telegramService.js');
    if (tg.isEnabled()) {
      const pullbackTag = trade.entryRegime === 'PULLBACK_UP' ? ' [PULLBACK]' : '';
      tg.alertTradeExecution({
        type: 'BUY',
        ticker: trade.ticker,
        price: trade.entryPrice,
        strategy: `${V2_CONFIG.TELEGRAM_TAG}${pullbackTag} ${trade.entryRegime} conf=${trade.entryConfidence.toFixed(2)}`,
      });
    }
  } catch {
    // Telegram not available
  }
}
```

**Step 2: Commit**

```bash
git add v2/engine/tradeEngine.ts
git commit -m "feat(v2): tag PULLBACK entries in Telegram alerts"
```

---

### Task 9: Verify Kraken 4h interval support

**Files:** None (verification only)

**Step 1: Check that Kraken adapter supports `4h` interval**

The existing Kraken adapter (`services/exchangeAdapters/krakenAdapter.js`) translates interval strings to Kraken API values. Verify that `4h` maps to `240` (Kraken's 4-hour OHLC interval).

```bash
grep -n "4h\|240\|interval" services/exchangeAdapters/krakenAdapter.js | head -20
```

If `4h` is not mapped, add it to the interval map. Kraken OHLC API accepts: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600.

**Step 2: Commit (only if adapter needed changes)**

```bash
git add services/exchangeAdapters/krakenAdapter.js
git commit -m "fix: add 4h interval mapping to Kraken adapter"
```

---

### Task 10: Integration test — verify on VPS

**Step 1: Run type check locally**

```bash
npx tsc --noEmit
```

Fix any type errors.

**Step 2: Push to both remotes**

```bash
git push origin master && git push vps master
```

**Step 3: Verify VPS status**

```bash
curl -s http://31.97.7.138:3033/api/v2/status | jq '.htfRegimes'
```

Expected: JSON object with 4h regimes for each ticker, e.g.:
```json
{
  "BTCUSD": "DOWN",
  "ETHUSD": "DOWN",
  ...
}
```

**Step 4: Verify scan reasons show MTF info**

```bash
curl -s http://31.97.7.138:3033/api/v2/status | jq '.lastScanReasons'
```

Expected: Rejection messages now include `4h=<regime>` info when MTF is checked.

**Step 5: Monitor logs for pullback entries**

When market conditions change (some 4h regimes flip to UP while 15m dips), the bot should log:
```
[V2] HTF BTCUSD: 4h regime=UP
[V2] PULLBACK: 15m=DOWN, 4h=UP → allowed as pullback-in-uptrend
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add PULLBACK_UP regime + MTF config | types.ts, config.ts |
| 2 | Add cached 4h candle fetcher | tradeEngine.ts |
| 3 | Add MTF pullback rescue to scanner | marketScanner.ts |
| 4 | Wire 4h fetch into bot loop | tradeEngine.ts |
| 5 | 75% position multiplier for pullbacks | riskGate.ts |
| 6 | +3 regime bonus in signal scoring | signalGenerator.ts |
| 7 | Expose HTF regimes in status API | tradeEngine.ts |
| 8 | Tag pullbacks in Telegram alerts | tradeEngine.ts |
| 9 | Verify Kraken 4h interval support | krakenAdapter.js |
| 10 | Type check + deploy + verify | — |
