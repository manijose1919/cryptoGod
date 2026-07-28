# Dual-Mode ADX Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-strategy scanner with an ADX-gated dual-mode engine: TREND fires only when ADX > 25 (4h, STRONG_UP only), Mean Reversion fires when ADX < 20 (1h, SIDEWAYS).

**Architecture:** ADX gate lives in two places — `strategyRunner.ts` filters TREND signals per-ticker before generating them; `meanReversionSignal.ts` gates MR entry. The MR standalone engine (`meanReversionEngine.ts`) gets overhauled rather than built from scratch — it already has its own loop, exit manager, and boot wiring in `v2/index.ts`. Phase 1 is deployed alone and validated before Phase 2 ships.

**Tech Stack:** TypeScript (v2 engine), existing Wilder RMA in `v2/indicators/indicators.ts`, existing `MR_CONFIG` / `STRATEGY_TIMEFRAMES` / `STRATEGY_EXIT_CONFIGS` in `v2/engine/config.ts`.

## Global Constraints

- Never use USDT/USDC pairs — Canadian market only allows USD pairs (BTCUSD, ETHUSD, etc.)
- All TypeScript files use `.ts` extension and ESM imports with explicit `.ts` suffixes
- `rma()` in `v2/indicators/indicators.ts` is unexported (private) — ADX must live in the same file to use it, OR duplicate the RMA logic
- `MR_CONFIG.ENABLED: false` is the kill switch — Phase 2 flips it to `true`
- Paper mode throughout — `V2_CONFIG.MODE` stays as-is, do NOT change it to `'live'`
- Push to BOTH remotes after each deploy: `bash scripts/push-deploy.sh`
- Reset `stats_baseline_time` on VPS after each deploy that changes trading behavior

---

## File Map

**Modified (Phase 1):**
- `v2/indicators/indicators.ts` — add `export function adx()`
- `v2/engine/config.ts` — TREND timeframes, ALLOWED_REGIMES, trail activation, ADX_THRESHOLDS
- `v2/engine/strategyRunner.ts` — ADX gate on TREND and SHORT signal blocks

**Modified (Phase 2):**
- `v2/engine/config.ts` — MR_CONFIG overhaul (enable, tickers, timeframe, SHORT thresholds)
- `v2/pipeline/meanReversionSignal.ts` — ADX gate, SIDEWAYS regime, SHORT signals
- `v2/engine/meanReversionEngine.ts` — SHORT trade support, PnL fix for shorts
- `v2/pipeline/meanReversionExitManager.ts` — SHORT exit conditions, dynamic BAR_MS

---

## PHASE 1

### Task 1: Add `adx()` to indicators

**Files:**
- Modify: `v2/indicators/indicators.ts`

**Interfaces:**
- Produces: `export function adx(candles: Candle[], period?: number): number` — returns the current ADX value (0–100); returns 0 if insufficient data

- [ ] **Step 1: Write the failing type-check**

Add this call at the bottom of `v2/indicators/indicators.ts` temporarily to verify the export compiles:

```typescript
// TEMP: type-check guard — remove after step 4
const _adxTest: number = adx([] as Candle[]);
void _adxTest;
```

Run: `npx tsc --noEmit`
Expected: error `Cannot find name 'adx'`

- [ ] **Step 2: Add the `adx` function**

Add after the `rsi()` function in `v2/indicators/indicators.ts`:

```typescript
/**
 * ADX (Average Directional Index) via Wilder's smoothing.
 * Returns 0–100; values > 25 indicate a trending market.
 * Returns 0 when candle count < period * 2.
 */
export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothTR = rma(trs, period);
  const smoothPlus = rma(plusDMs, period);
  const smoothMinus = rma(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = period - 1; i < smoothTR.length; i++) {
    const tr = smoothTR[i];
    if (!tr || isNaN(tr)) { dxValues.push(0); continue; }
    const pdi = (smoothPlus[i] / tr) * 100;
    const mdi = (smoothMinus[i] / tr) * 100;
    const sum = pdi + mdi;
    dxValues.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  if (dxValues.length < period) return 0;
  const adxArr = rma(dxValues, period);
  const last = adxArr[adxArr.length - 1];
  return isNaN(last) ? 0 : last;
}
```

- [ ] **Step 3: Remove the temp type-check guard**

Delete the two `_adxTest` lines added in step 1.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors related to `adx`

- [ ] **Step 5: Sanity-check the value manually**

Run this in Node (or add temporarily to a test script):

```bash
node --input-type=module << 'EOF'
import { adx } from './v2/indicators/indicators.ts';
// Flat market — ADX should be low
const flat = Array.from({length: 60}, (_, i) => ({
  time: i * 3600, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000
}));
// Trending market — ADX should be high
const trend = Array.from({length: 60}, (_, i) => ({
  time: i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000
}));
console.log('flat ADX:', adx(flat));   // expect < 20
console.log('trend ADX:', adx(trend)); // expect > 25
EOF
```

Expected output: `flat ADX: <number below 20>`, `trend ADX: <number above 25>`

- [ ] **Step 6: Commit**

```bash
git add v2/indicators/indicators.ts
git commit -m "feat(indicators): add ADX (Wilder smoothing) to v2 indicator library

Used in Phase 1 (TREND gate: ADX>25) and Phase 2 (MR gate: ADX<20).
Reuses existing rma() — no new dependencies."
```

---

### Task 2: Phase 1 config changes

**Files:**
- Modify: `v2/engine/config.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `ADX_THRESHOLDS` export, updated `STRATEGY_TIMEFRAMES.TREND`, updated `V2_CONFIG.ALLOWED_REGIMES`, updated `STRATEGY_EXIT_CONFIGS.TREND.trailActivatePercent`

- [ ] **Step 1: Update STRATEGY_TIMEFRAMES.TREND**

In `v2/engine/config.ts`, find:
```typescript
export const STRATEGY_TIMEFRAMES: Record<string, string[]> = {
  TREND:           ['30m', '1h', '4h'],
```

Replace with:
```typescript
export const STRATEGY_TIMEFRAMES: Record<string, string[]> = {
  TREND:           ['4h'],  // 2026-06-19: drop 1h/30m — live data shows 1h consistently losing
```

- [ ] **Step 2: Update ALLOWED_REGIMES**

Find in `V2_CONFIG`:
```typescript
  ALLOWED_REGIMES: ['STRONG_UP', 'UP'] as const,
```

Replace with:
```typescript
  ALLOWED_REGIMES: ['STRONG_UP'] as const,  // 2026-06-19: UP too broad; ADX>25 + STRONG_UP = two independent trend confirmations
```

- [ ] **Step 3: Update trail activation**

Find in `STRATEGY_EXIT_CONFIGS.TREND`:
```typescript
    trailActivatePercent: 0.01, trailGivebackPercent: 0.03,
```

Replace with:
```typescript
    trailActivatePercent: 0.014, trailGivebackPercent: 0.03,  // 2026-06-19: 0.01→0.014 (75% of ~1.8% typical TP) — was activating in noise, creating trailing losses
```

- [ ] **Step 4: Add ADX_THRESHOLDS export**

Add after the `STRATEGY_COOLDOWN_MS` block (after line `SCALP: 10 * 60 * 1000,`):

```typescript
// ADX routing thresholds (Average Directional Index)
// ADX > TREND_MIN: market trending → run TREND only
// ADX < MR_MAX: market ranging → run MEAN_REVERSION only
// Between: dead zone, no new entries
export const ADX_THRESHOLDS = {
  TREND_MIN: 25,
  MR_MAX: 20,
} as const;
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add v2/engine/config.ts
git commit -m "feat(config): Phase 1 TREND pruning — 4h only, STRONG_UP, trail 0.01→0.014, ADX_THRESHOLDS

- TREND timeframes: ['30m','1h','4h'] -> ['4h'] (1h live data consistently losing)
- ALLOWED_REGIMES: UP removed (EMA crossover too coarse; ADX>25 replaces it)
- trailActivatePercent: 0.01->0.014 (75% of typical TP, reduces trailing noise exits)
- ADX_THRESHOLDS: {TREND_MIN: 25, MR_MAX: 20} added for Phase 1+2 gate"
```

---

### Task 3: ADX gate in strategyRunner

**Files:**
- Modify: `v2/engine/strategyRunner.ts`

**Interfaces:**
- Consumes: `adx(candles, period)` from `../indicators/indicators.ts`, `ADX_THRESHOLDS` from `./config.ts`

- [ ] **Step 1: Add imports**

At the top of `v2/engine/strategyRunner.ts`, find:
```typescript
import { V2_CONFIG, MOMENTUM_CONFIG, STRATEGY_TIMEFRAMES } from './config.ts';
```

Replace with:
```typescript
import { V2_CONFIG, MOMENTUM_CONFIG, STRATEGY_TIMEFRAMES, ADX_THRESHOLDS } from './config.ts';
import { adx } from '../indicators/indicators.ts';
```

- [ ] **Step 2: Gate TREND long signals**

Find in `runAllStrategies()`:
```typescript
    // --- TREND (1h, 4h) ---
    if (STRATEGY_TIMEFRAMES.TREND?.includes(tf) && passedScan.length > 0) {
      const trendSignals = generateSignals(passedScan, tfCandles);
      for (const sig of getPassedSignals(trendSignals)) {
        results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
      }
    }
```

Replace with:
```typescript
    // --- TREND (4h only, ADX>25 gate) ---
    if (STRATEGY_TIMEFRAMES.TREND?.includes(tf) && passedScan.length > 0) {
      const trendPassed = passedScan.filter(scan => {
        const candles = tfCandles.get(scan.ticker);
        if (!candles || candles.length < 30) return false;
        const adxVal = adx(candles);
        if (adxVal < ADX_THRESHOLDS.TREND_MIN) return false;
        return true;
      });
      if (trendPassed.length > 0) {
        const trendSignals = generateSignals(trendPassed, tfCandles);
        for (const sig of getPassedSignals(trendSignals)) {
          results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
        }
      }
    }
```

- [ ] **Step 3: Gate TREND short signals**

Find:
```typescript
    // --- SHORTS (any TF where TREND runs) ---
    if (V2_CONFIG.SHORTS_ENABLED && V2_CONFIG.MODE !== 'live' && STRATEGY_TIMEFRAMES.TREND?.includes(tf)) {
      const shortScanResults = scanMarket(tfCandles, 'short');
      const passedShortScan = getPassedTickers(shortScanResults);
      if (passedShortScan.length > 0) {
        const shortSignals = generateShortSignals(passedShortScan, tfCandles);
        for (const sig of getPassedSignals(shortSignals)) {
          results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
        }
      }
    }
```

Replace with:
```typescript
    // --- SHORTS (any TF where TREND runs, ADX>25 gate) ---
    if (V2_CONFIG.SHORTS_ENABLED && V2_CONFIG.MODE !== 'live' && STRATEGY_TIMEFRAMES.TREND?.includes(tf)) {
      const shortScanResults = scanMarket(tfCandles, 'short');
      const passedShortScan = getPassedTickers(shortScanResults).filter(scan => {
        const candles = tfCandles.get(scan.ticker);
        if (!candles || candles.length < 30) return false;
        return adx(candles) >= ADX_THRESHOLDS.TREND_MIN;
      });
      if (passedShortScan.length > 0) {
        const shortSignals = generateShortSignals(passedShortScan, tfCandles);
        for (const sig of getPassedSignals(shortSignals)) {
          results.push({ ...sig, _strategy: 'TREND', _timeframe: tf });
        }
      }
    }
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Verify the loop log shows ADX filtering**

Start the backend: `node server.js`
Watch for: `[V2] Loop #N: no signals from any strategy` or reduced signal counts vs before.
If ADX is filtering, you'll see fewer `[V2] executing` lines per hour on choppy days.

- [ ] **Step 6: Commit and deploy Phase 1**

```bash
git add v2/engine/strategyRunner.ts
git commit -m "feat(strategy): ADX>25 gate on TREND and short signals in strategyRunner

TREND now only fires when ADX>25 (genuinely trending) on 4h candles.
Shorts get the same gate. This is the primary fix for the root cause:
EMA regime called UP in ranging conditions, causing trend strategy to
run in mean-reverting markets (live data: 52 trades -$25 post-baseline)."
```

```bash
bash scripts/push-deploy.sh
```

- [ ] **Step 7: Reset stats baseline on VPS**

After deploy confirms healthy (`pm2 status` shows `canuck-node online`):

```bash
ssh root@VPS_HOST_REDACTED "sqlite3 /opt/trading-bot/data/trading.db \"INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_baseline_time', $(date -u +%s%3N));\""
```

Expected: no output (successful insert).

---

## PHASE 2

**Wait for Phase 1 to collect 5–7 days of data confirming trailing loss rate improves before starting Phase 2.**

---

### Task 4: Overhaul MR_CONFIG

**Files:**
- Modify: `v2/engine/config.ts`

**Interfaces:**
- Produces: updated `MR_CONFIG` with `ENABLED: true`, 1h candles, TREND tickers, ADX/RSI/BB thresholds for both longs and shorts, SHORT_ENABLED flag

- [ ] **Step 1: Replace MR_CONFIG**

Find the entire `MR_CONFIG` block in `v2/engine/config.ts`:
```typescript
export const MR_CONFIG = {
  ENABLED: false,                  // DISABLED — live results: ...
  CANDLE_INTERVAL: '15m' as string,
  ALLOWED_REGIMES: ['SIDEWAYS', 'UP'] as readonly string[],
  SCAN_TICKERS: ['BTCUSD', 'ETHUSD', 'XRPUSD', 'DOGEUSD'] as string[],
  ...
} as const;
```

Replace the entire block with:
```typescript
export const MR_CONFIG = {
  // 2026-06-19: Rebuilt from 15m long-only (0/4 wins, -$2.80 live) to
  // 1h dual-direction with ADX<20 gate. Previous failure: 15m too noisy,
  // BTCUSD/ETH tickers wrong for this engine, no ADX gate, no shorts.
  ENABLED: true,
  CANDLE_INTERVAL: '1h' as string,
  ALLOWED_REGIMES: ['SIDEWAYS'] as readonly string[],  // ADX<20 is primary gate; SIDEWAYS backstop
  SCAN_TICKERS: [
    'AKTUSD', 'ZECUSD', 'FETUSD', 'PENGUUSD', 'TAOUSD', 'PENDLEUSD',
  ] as string[],

  // ADX gate: only enter when market is ranging
  ADX_MAX_FOR_ENTRY: 20,

  // Long entry: oversold at lower BB
  RSI_LONG_THRESHOLD: 28,        // RSI < 28 (more extreme than old 30)
  BB_LONG_THRESHOLD: 0.15,       // %B < 0.15 (close to lower band)

  // Short entry: overbought at upper BB
  SHORTS_ENABLED: true,
  RSI_SHORT_THRESHOLD: 72,       // RSI > 72
  BB_SHORT_THRESHOLD: 0.85,      // %B > 0.85 (close to upper band)

  MAX_ATR_PERCENT: 5.0,          // Wider than old 3.0 — these tickers can ATR 4%+
  MIN_CANDLES: 50,

  // Position sizing — same as TREND
  POSITION_SIZE_PERCENT: 0.40,
  MAX_POSITION_PERCENT: 0.50,
  MAX_OPEN_POSITIONS: 2,         // MR can have long + short simultaneously on different tickers

  // Exit — binary (TP or SL), no trailing
  STOP_LOSS_ATR_MULT: 1.5,
  TIME_KILL_BARS: 6,             // 6 × 1h = 6h — MR trades that don't revert quickly won't
  TIME_KILL_MIN_MOVE: 0.003,
  QUICK_KILL_AFTER_BARS: 3,      // 3 × 1h = 3h
  QUICK_KILL_MIN_GAIN: 0.003,
  QUICK_KILL_SL_ATR_MULT: 0.8,

  // Maker both sides: round-trip 0.32% vs TREND's 0.42%
  USE_MAKER_ORDERS: true,
  FEE_ROUND_TRIP: 0.0032,

  BOT_LOOP_INTERVAL_MS: 60_000,
  LOOP_OFFSET_MS: 30_000,        // 30s stagger from TREND loop
} as const;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add v2/engine/config.ts
git commit -m "feat(config): Phase 2 MR_CONFIG overhaul — 1h dual-direction with ADX<20 gate

Enable=true, 1h candles, TREND tickers, ADX<20 gate, SIDEWAYS regime,
RSI<28 longs / RSI>72 shorts, BB thresholds for both directions,
6-bar time-kill, maker both sides (0.32% RT vs TREND's 0.42%)."
```

---

### Task 5: Rework meanReversionSignal to add ADX gate and shorts

**Files:**
- Modify: `v2/pipeline/meanReversionSignal.ts`

**Interfaces:**
- Consumes: `adx()` from `../indicators/indicators.ts`
- Produces: `detectMeanReversionEntry(candles, ticker)` now returns `SignalResult & { side: 'long' | 'short' }` or null; signal includes `side` in the `signals` map as `'long'` or `'short'` (string, for backward compat with V2Trade.entrySignals)

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `v2/pipeline/meanReversionSignal.ts` with:

```typescript
import type { Candle, SignalResult } from './types.ts';
import { computeSignals, detectRegime } from '../indicators/indicators.ts';
import { adx } from '../indicators/indicators.ts';
import { MR_CONFIG } from '../engine/config.ts';

export interface MRSignalResult extends SignalResult {
  side: 'long' | 'short';
}

export function detectMeanReversionEntry(
  candles: Candle[],
  ticker: string,
): MRSignalResult | null {
  if (candles.length < MR_CONFIG.MIN_CANDLES) return null;

  // Primary gate: ADX must be below threshold (ranging market)
  const adxVal = adx(candles);
  if (adxVal >= MR_CONFIG.ADX_MAX_FOR_ENTRY) return null;

  const { signals } = computeSignals(candles);
  const regimeResult = detectRegime(candles);

  if (!MR_CONFIG.ALLOWED_REGIMES.includes(regimeResult.regime)) return null;

  const rsi = signals.rsi as number;
  const pctB = signals.bb_percent_b as number;
  const atrPct = signals.atr_percent as number;
  const price = signals.close_price as number;
  const ema = signals.ema_12 as number;

  if (atrPct > MR_CONFIG.MAX_ATR_PERCENT) return null;

  // --- LONG: oversold at lower BB ---
  if (
    rsi < MR_CONFIG.RSI_LONG_THRESHOLD &&
    pctB < MR_CONFIG.BB_LONG_THRESHOLD &&
    ema > price  // mean is above price — expect upward reversion
  ) {
    const oversoldDepth = (MR_CONFIG.RSI_LONG_THRESHOLD - rsi) / MR_CONFIG.RSI_LONG_THRESHOLD;
    const confidence = Math.max(0.3, Math.min(0.9,
      0.4 + oversoldDepth * 0.4 + (MR_CONFIG.BB_LONG_THRESHOLD - pctB) * 2
    ));
    return {
      ticker,
      passed: true,
      compositeScore: confidence * 100,
      confidence,
      signals: { ...signals, mr_side: 1, adx: adxVal },
      regime: regimeResult.regime,
      reason: `MR_LONG RSI=${rsi.toFixed(0)} pctB=${pctB.toFixed(2)} ema=${ema.toFixed(2)} adx=${adxVal.toFixed(1)}`,
      side: 'long',
    };
  }

  // --- SHORT: overbought at upper BB ---
  if (
    MR_CONFIG.SHORTS_ENABLED &&
    rsi > MR_CONFIG.RSI_SHORT_THRESHOLD &&
    pctB > MR_CONFIG.BB_SHORT_THRESHOLD &&
    ema < price  // mean is below price — expect downward reversion
  ) {
    const overboughtDepth = (rsi - MR_CONFIG.RSI_SHORT_THRESHOLD) / (100 - MR_CONFIG.RSI_SHORT_THRESHOLD);
    const confidence = Math.max(0.3, Math.min(0.9,
      0.4 + overboughtDepth * 0.4 + (pctB - MR_CONFIG.BB_SHORT_THRESHOLD) * 2
    ));
    return {
      ticker,
      passed: true,
      compositeScore: confidence * 100,
      confidence,
      signals: { ...signals, mr_side: -1, adx: adxVal },
      regime: regimeResult.regime,
      reason: `MR_SHORT RSI=${rsi.toFixed(0)} pctB=${pctB.toFixed(2)} ema=${ema.toFixed(2)} adx=${adxVal.toFixed(1)}`,
      side: 'short',
    };
  }

  return null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. If `MRSignalResult` causes issues in consumers, they import `SignalResult` — the `side` field extension is additive and non-breaking.

- [ ] **Step 3: Commit**

```bash
git add v2/pipeline/meanReversionSignal.ts
git commit -m "feat(mr-signal): ADX<20 gate, SIDEWAYS regime, dual-direction (long+short)

Long: RSI<28 + pctB<0.15 + ema>price + ADX<20
Short: RSI>72 + pctB>0.85 + ema<price + ADX<20 + SHORTS_ENABLED
Returns MRSignalResult with side field.
Previous 15m long-only version: 0/4 wins, -$2.80."
```

---

### Task 6: Add SHORT support to MR engine and exit manager

**Files:**
- Modify: `v2/engine/meanReversionEngine.ts`
- Modify: `v2/pipeline/meanReversionExitManager.ts`

**Interfaces:**
- Consumes: `MRSignalResult` (with `side` field) from `detectMeanReversionEntry`
- `meanReversionEngine.ts` reads `signal.side` to set `trade.side` and compute SL/TP direction

- [ ] **Step 1: Update import in meanReversionEngine.ts**

Find:
```typescript
import { detectMeanReversionEntry } from '../pipeline/meanReversionSignal.ts';
```

Replace with:
```typescript
import { detectMeanReversionEntry } from '../pipeline/meanReversionSignal.ts';
import type { MRSignalResult } from '../pipeline/meanReversionSignal.ts';
```

- [ ] **Step 2: Fix PnL calculation for shorts in meanReversionEngine.ts**

Find in `runMRLoop()`:
```typescript
        const pnlGross = (result.exitPrice - t.entryPrice) * t.quantity;
```

Replace with:
```typescript
        const isShort = t.side === 'short';
        const pnlGross = isShort
          ? (t.entryPrice - result.exitPrice) * t.quantity
          : (result.exitPrice - t.entryPrice) * t.quantity;
```

- [ ] **Step 3: Fix SL/TP direction for shorts in meanReversionEngine.ts**

Find in `runMRLoop()` the section that computes `sl`, `tp`, and the `trade` object:
```typescript
      const price0 = signal.signals.close_price as number;
      const ema0 = signal.signals.ema_12 as number;
      const atrDollar = price0 * atrPct / 100;
      const tpPercent = (ema0 - price0) / price0;
      const expectedReturn = tpPercent - MR_CONFIG.FEE_ROUND_TRIP;
      if (expectedReturn < 0.001) continue;

      const price = signal.signals.close_price as number;
      const qty = posSize / price;
      const sl = price - atrDollar * MR_CONFIG.STOP_LOSS_ATR_MULT;
      const tp = signal.signals.ema_12 as number;

      const trade: V2Trade = {
        ...
        side: 'long',
```

Replace with:
```typescript
      const mrSignal = signal as MRSignalResult;
      const side = mrSignal.side ?? 'long';
      const price0 = signal.signals.close_price as number;
      const ema0 = signal.signals.ema_12 as number;
      const atrDollar = price0 * atrPct / 100;

      // For longs: ema > price, tpPercent > 0.
      // For shorts: ema < price, tpPercent = (price - ema) / price > 0.
      const tpPercent = side === 'short'
        ? (price0 - ema0) / price0
        : (ema0 - price0) / price0;
      const expectedReturn = tpPercent - MR_CONFIG.FEE_ROUND_TRIP;
      if (expectedReturn < 0.001) continue;

      const price = price0;
      const qty = posSize / price;
      // SL: above entry for shorts (stop a reversal upward), below for longs
      const sl = side === 'short'
        ? price + atrDollar * MR_CONFIG.STOP_LOSS_ATR_MULT
        : price - atrDollar * MR_CONFIG.STOP_LOSS_ATR_MULT;
      const tp = ema0; // EMA is the mean reversion target in both directions

      const trade: V2Trade = {
        ...
        side: side as any,
```

- [ ] **Step 4: Update position guard to allow long+short simultaneously**

Find:
```typescript
      if (currentMR.some(t => t.ticker === ticker)) continue;
```

Replace with:
```typescript
      // Allow one long and one short per ticker — different directions, different signal
      const mrSide = (signal as MRSignalResult).side ?? 'long';
      if (currentMR.some(t => t.ticker === ticker && t.side === mrSide)) continue;
```

(Note: this change must come AFTER the `signal` is fetched. Move it to after `const signal = detectMeanReversionEntry(candles, ticker);`)

- [ ] **Step 5: Fix meanReversionExitManager.ts for SHORT exits**

Replace the entire contents of `v2/pipeline/meanReversionExitManager.ts` with:

```typescript
import type { V2Trade, DecisionRecord } from './types.ts';
import { EXIT_REASON, PIPELINE_STAGE, DECISION } from './types.ts';
import { MR_CONFIG } from '../engine/config.ts';
import { timeframeToMs } from '../engine/config.ts';
import type { ExchangeAdapter } from '../exchange/types.ts';
import { updateTradeStop, updateTradePeakPrice } from '../attribution/attributionStore.ts';
import type { ExitResult } from './exitManager.ts';

// Dynamic bar duration based on configured candle interval
const BAR_MS = timeframeToMs(MR_CONFIG.CANDLE_INTERVAL);

function makeDecision(
  tradeId: string,
  decision: 'pass' | 'reject' | 'execute',
  reason: string,
  signals: Record<string, number>,
): DecisionRecord {
  return {
    tradeId,
    stage: PIPELINE_STAGE.exit,
    timestamp: Date.now(),
    decision: DECISION[decision],
    reason,
    signals,
    thresholds: {
      timeKillBars: MR_CONFIG.TIME_KILL_BARS,
      timeKillMinMove: MR_CONFIG.TIME_KILL_MIN_MOVE,
      quickKillBars: MR_CONFIG.QUICK_KILL_AFTER_BARS,
    },
    confidence: 0,
  };
}

export async function checkMeanReversionExits(
  openTrades: V2Trade[],
  exchange: ExchangeAdapter,
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  for (const trade of openTrades) {
    const isShort = trade.side === 'short';
    const currentPrice = await exchange.getLatestPrice(trade.ticker);

    // Update peak price (lowest for shorts, highest for longs)
    const newPeak = isShort
      ? Math.min(currentPrice, trade.peakPrice ?? trade.entryPrice)
      : Math.max(currentPrice, trade.peakPrice ?? trade.entryPrice);
    if (newPeak !== trade.peakPrice) {
      trade.peakPrice = newPeak;
      updateTradePeakPrice(trade.id, newPeak);
    }

    const pnlPercent = isShort
      ? (trade.entryPrice - currentPrice) / trade.entryPrice
      : (currentPrice - trade.entryPrice) / trade.entryPrice;
    const holdMs = Date.now() - trade.entryTime;
    const holdBars = Math.floor(holdMs / BAR_MS);
    let newStop = trade.currentStop;

    // --- 1. Stop Loss ---
    const slTriggered = isShort
      ? currentPrice >= trade.currentStop
      : currentPrice <= trade.currentStop;
    if (slTriggered) {
      const stopWasRaised = isShort
        ? trade.currentStop < trade.initialStop
        : trade.currentStop > trade.initialStop;
      const exitReason = stopWasRaised ? EXIT_REASON.trailing : EXIT_REASON.stop_loss;
      results.push({
        trade, shouldExit: true, exitReason,
        exitPrice: trade.currentStop, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR ${isShort ? 'short' : 'long'} stop: price=${currentPrice.toFixed(4)} stop=${trade.currentStop.toFixed(4)}`,
          { currentPrice, currentStop: trade.currentStop, pnlPercent }),
      });
      continue;
    }

    // --- 2. Take Profit (mean reached) ---
    const tpTriggered = isShort
      ? currentPrice <= trade.takeProfitTarget
      : currentPrice >= trade.takeProfitTarget;
    if (tpTriggered) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.take_profit,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR take profit: price=${currentPrice.toFixed(4)} tp=${trade.takeProfitTarget.toFixed(4)}`,
          { currentPrice, takeProfitTarget: trade.takeProfitTarget, pnlPercent }),
      });
      continue;
    }

    // --- 3. Quick Kill (tighten SL on stalled trades) ---
    if (holdBars >= MR_CONFIG.QUICK_KILL_AFTER_BARS && pnlPercent < MR_CONFIG.QUICK_KILL_MIN_GAIN) {
      const atrDollar = trade.atrPercent != null && trade.atrPercent > 0
        ? trade.entryPrice * trade.atrPercent / 100 : 0;
      if (atrDollar > 0) {
        const tighter = isShort
          ? trade.entryPrice + atrDollar * MR_CONFIG.QUICK_KILL_SL_ATR_MULT  // tighten down for shorts
          : trade.entryPrice - atrDollar * MR_CONFIG.QUICK_KILL_SL_ATR_MULT;
        const shouldTighten = isShort
          ? tighter < trade.currentStop
          : tighter > trade.currentStop;
        if (shouldTighten) {
          newStop = tighter;
          updateTradeStop(trade.id, newStop);
        }
      }
    }

    // --- 4. Time Kill ---
    const timeKillMs = MR_CONFIG.TIME_KILL_BARS * BAR_MS;
    if (holdMs > timeKillMs && Math.abs(pnlPercent) < MR_CONFIG.TIME_KILL_MIN_MOVE) {
      results.push({
        trade, shouldExit: true, exitReason: EXIT_REASON.time_kill,
        exitPrice: currentPrice, newStop, trailingJustActivated: false,
        decision: makeDecision(trade.id, 'execute',
          `MR time kill: ${(holdMs / 60000).toFixed(0)}min, pnl=${(pnlPercent * 100).toFixed(2)}%`,
          { currentPrice, holdMs, pnlPercent }),
      });
      continue;
    }

    // --- No exit ---
    results.push({
      trade, shouldExit: false, exitReason: null,
      exitPrice: currentPrice, newStop, trailingJustActivated: false,
      decision: makeDecision(trade.id, 'pass',
        `MR holding: pnl=${(pnlPercent * 100).toFixed(2)}% bars=${holdBars}`,
        { currentPrice, pnlPercent, holdBars }),
    });
  }

  return results;
}
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. Pay attention to `side as any` in meanReversionEngine.ts — if `V2Trade.side` type doesn't accept `'short'`, the cast handles it.

- [ ] **Step 7: Commit**

```bash
git add v2/engine/meanReversionEngine.ts v2/pipeline/meanReversionExitManager.ts
git commit -m "feat(mr-engine): SHORT support — dual-direction PnL, SL/TP, exit conditions

meanReversionEngine: reads signal.side, computes SL/TP direction per side,
  allows long+short on same ticker simultaneously (different guards)
meanReversionExitManager: dynamic BAR_MS from timeframeToMs(MR_CONFIG.CANDLE_INTERVAL),
  correct pnlPercent for shorts, correct slTriggered/tpTriggered comparisons,
  quick-kill direction-aware, stop/peak updates direction-aware"
```

---

### Task 7: Phase 2 deploy

**Files:**
- No code changes — deploy only

- [ ] **Step 1: Verify MR engine boots in v2/index.ts**

Confirm `v2/index.ts` line 39 reads:
```typescript
    if (MR_CONFIG.ENABLED) {
```

This is already correct — setting `MR_CONFIG.ENABLED: true` in Task 4 is sufficient to boot the engine. No changes to index.ts needed.

- [ ] **Step 2: Full type-check before deploy**

Run: `npx tsc --noEmit`
Expected: zero errors

- [ ] **Step 3: Start local server and confirm MR engine starts**

```bash
node server.js 2>&1 | grep -E '\[MR\]|\[V2\]'
```

Expected log lines within 60 seconds:
```
[V2] Mean Reversion engine running (15m, maker fees)   ← boot log (old msg, ok)
[MR] Mean Reversion engine initialized: budget=...
[MR] Loop #1: 0 signals, N rejected, 0 open, PnL=$0.00
```

If you see `[MR] Loop error:` — check the error message and fix before deploying.

- [ ] **Step 4: Deploy**

```bash
bash scripts/push-deploy.sh
```

- [ ] **Step 5: Reset stats baseline on VPS**

```bash
ssh root@VPS_HOST_REDACTED "sqlite3 /opt/trading-bot/data/trading.db \"INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_baseline_time', $(date -u +%s%3N));\""
```

- [ ] **Step 6: Confirm MR engine running on VPS**

```bash
ssh root@VPS_HOST_REDACTED "sudo pm2 logs canuck-node --lines 50 --nostream 2>/dev/null | grep '\[MR\]'"
```

Expected: `[MR] Mean Reversion engine initialized` and `[MR] Loop #1:` lines.

- [ ] **Step 7: Add CHANGELOG entry**

Add to the top of `CHANGELOG.md`:

```markdown
## 2026-06-19 HH:MM UTC — Dual-mode ADX engine: Phase 1 + Phase 2 — local-claude

**Commits:** <SHA from push-deploy output>
**Files changed:** v2/indicators/indicators.ts, v2/engine/config.ts, v2/engine/strategyRunner.ts, v2/pipeline/meanReversionSignal.ts, v2/engine/meanReversionEngine.ts, v2/pipeline/meanReversionExitManager.ts
**Stats baseline reset:** YES — new baseline set after each deploy.

**What changed:**
Phase 1: TREND now requires ADX>25 AND STRONG_UP regime (was STRONG_UP OR UP). Timeframes pruned to 4h only (1h/30m removed — live data showed consistent losses). Trail activation raised from 1% to 1.4% of TP.

Phase 2: Mean Reversion engine rebuilt from 15m long-only (0/4 wins live) to 1h dual-direction. ADX<20 + SIDEWAYS regime gate. Longs: RSI<28 + %B<0.15. Shorts: RSI>72 + %B>0.85. Target: EMA midline. Both sides maker (0.32% RT vs TREND's 0.42%).

**Why:**
Root cause: EMA regime called UP in ranging conditions, trend strategy ran in mean-reverting markets. -$25 net on 52 trades. ADX (trend STRENGTH not direction) is a sharper gate; ADX<20 markets are where MR edge lives.

**What to monitor / watch for:**
- TREND: trade frequency drops significantly (ADX>25 is selective). Trailing loss rate should fall.
- MR: first 10 trades individually — confirm win rate ≥ 60%, avg winner ≥ +$3.50 net.
- MR loop heartbeat: `[MR] Loop #N:` every 60s in pm2 logs.
- Rollback Phase 2: set MR_CONFIG.ENABLED=false, push. Rollback Phase 1: revert 3 constants.
```

- [ ] **Step 8: Commit changelog and push**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): dual-mode ADX engine Phase 1+2 deployed"
bash scripts/push-deploy.sh
```
