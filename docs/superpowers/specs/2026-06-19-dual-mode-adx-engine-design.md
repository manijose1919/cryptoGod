# Dual-Mode ADX Engine — Design Spec
**Date:** 2026-06-19
**Status:** Approved, pending implementation
**Author:** Local Claude (brainstorming session with Joseph)

---

## Problem Statement

The TREND strategy is breakeven at -$25 net on 52 post-baseline trades (57.7% WR, fee drag 186%). Root cause: the EMA10/EMA30 regime detector calls "UP" in markets that are actually choppy and ranging, causing trend-following logic to fire in mean-reverting conditions. The result is trailing exits that reach activation then fully reverse — losing trades that look like wins on entry.

Patching trailing thresholds or dropping timeframes alone doesn't fix the root cause: a single-strategy engine has no edge in sideways conditions, which is the dominant market state most of the time.

---

## Solution Overview

Replace the single-strategy scanner with a **two-lane engine** gated by ADX (Average Directional Index). ADX measures trend *strength* independent of direction, flipping much faster than EMA crossover when markets transition from trending to ranging.

```
For each ticker on each scan:
  Calculate ADX (14-period, same timeframe as candidate trade)

  ADX > 25  → TREND lane  (4h only, STRONG_UP regime required)
  ADX 20–25 → dead zone   (no new entries from either strategy)
  ADX < 20  → MR lane     (1h + 4h, any non-DOWN regime)
```

Both strategies feed into the existing `v2_trades` table, exit infrastructure, circuit breaker, and UI. No architectural changes to the execution path.

---

## Phase 1 — TREND Pruning (deploy first, alone)

### Changes

**`constants.ts`**
- `STRATEGY_TIMEFRAMES.TREND`: `['30m', '1h', '4h']` → `['4h']`
- `ALLOWED_REGIMES.TREND`: `['STRONG_UP', 'UP']` → `['STRONG_UP']`
- `STRATEGY_EXIT_CONFIGS.TREND.trailActivation`: raise from 55% → 75% of TP
- Add `ADX_THRESHOLDS: { TREND_MIN: 25, MR_MAX: 20 }`

**`services/indicatorService.ts`**
- Add `calculateADX(candles: Candle[], period = 14): number`
- Uses Wilder's smoothing: True Range → smoothed +DM/-DM → +DI/-DI → DX → ADX
- Returns single number; used by scanner immediately, by MR engine in Phase 2

**`services/signalScanner.js`**
- After fetching candles for a ticker/timeframe, compute ADX
- If `adx < ADX_THRESHOLDS.TREND_MIN`: skip TREND evaluation for this ticker/timeframe
- If `adx >= ADX_THRESHOLDS.TREND_MIN` AND regime is STRONG_UP: evaluate TREND as normal

### Rationale for each change

| Change | Why |
|---|---|
| Drop 1h/30m TREND | Live data: 1h TREND consistently losing (TAO 1h: -$6.41, -$2.00, -$0.09; ZEC 1h: -$1.94). 4h gives trades room above 0.42% fee floor. |
| STRONG_UP only | "UP" regime (EMA crossover) can still be choppy. STRONG_UP + ADX > 25 = two independent confirmations of genuine trend. |
| Trail activation 55%→75% | At 55% (~+0.83% gross), a reversal to the trail can still produce a net loss after fees. At 75% (~+1.12% gross), the minimum locked-in net is ~+$1.40 on a $200 trade — trailing losses become small wins instead. |
| ADX > 25 gate | Primary fix. EMA regime is slow-moving; ADX detects trend strength in real time. |

### Post-deploy monitoring
- Reset `stats_baseline_time` on VPS after deploy
- Watch: TREND trade frequency (expect significant drop), trailing loss rate (expect sharp decline)
- Run 5–7 days before deploying Phase 2
- Rollback: revert `constants.ts` only (one line each)

---

## Phase 2 — Mean Reversion Engine (deploy after Phase 1 is stable)

### Signal Design

**Entry conditions (all required):**
- ADX < 20 (ranging market)
- Price beyond Bollinger Band outer rail (20-period SMA ± 2σ)
- RSI confirms: RSI < 28 for longs, RSI > 72 for shorts
- Regime is SIDEWAYS (ADX < 20 is the primary gate; SIDEWAYS as a backstop ensures we don't fade even a mild trend — UP/DOWN/STRONG_UP regimes are skipped entirely for MR)

**Entry metadata saved at fill time:**
- `bb_midline`: 20-period SMA price at entry — this is the fixed profit target
- `stop_price`: 1.5× ATR below lower BB (longs) / above upper BB (shorts)

These are locked at entry. BB midline is NOT recalculated as new candles arrive — the target is fixed to the conditions that triggered the trade.

**Exit logic:**
- **Target**: limit order placed at `bb_midline` immediately on entry fill (maker, 0.16% fee)
- **Stop loss**: `stop_price` checked each bar, market exit if breached (taker, 0.26% fee)
- **Time kill**: 6 bars on 1h (6h), 8 bars on 4h (32h) — MR trades that haven't reverted quickly won't
- **No trailing stop**: MR exits are binary — target or stop. Trailing is a trend-following tool.

**Fee profile:**
- Entry: maker limit (0.16%)
- Exit via target: maker limit (0.16%)
- Exit via stop/time-kill: market/taker (0.26%)
- Round-trip on a winning trade: **0.32%** (vs 0.42% for TREND) — 24% cheaper

**Timeframes:** `['1h', '4h']` — MR signal is valid on both; 1h generates more setups, 4h generates cleaner ones.

**Tickers:** Same universe as TREND. No changes.

**Position sizing:** Same as TREND ($200–$400 per trade, existing Kelly/risk infrastructure unchanged).

### Expected trade profile
| Metric | Expected |
|---|---|
| Win rate | 62–68% |
| Avg winner (net) | +$4–6 |
| Avg loser (net) | -$6–8 |
| Round-trip fee (winning trade) | 0.32% |
| Frequency | Higher than pruned TREND (ranging markets generate frequent BB touches) |

### Codebase Changes

**`constants.ts`**
- `STRATEGY_TIMEFRAMES.MEAN_REVERSION`: add `['1h', '4h']`
- `STRATEGY_EXIT_CONFIGS.MEAN_REVERSION`:
  ```
  {
    trailActivation: null,
    timeKillBars: { '1h': 6, '4h': 8 },
    useMarketExit: false
  }
  ```
  Note: TP and SL prices are NOT stored in this config. They are written into the trade record at entry time (`mr_target_price`, `mr_stop_price` columns). The exitManager reads them from the trade row, not from the strategy config.
- `BB_PERIOD: 20`, `BB_STD: 2`, `MR_RSI_LONG: 28`, `MR_RSI_SHORT: 72`

**`services/indicatorService.ts`**
- Add `calculateBollingerBands(candles, period, stdDev)` → `{ upper, middle, lower, bandwidth }`
- `calculateADX` already added in Phase 1

**`services/signalScanner.js`**
- Add MR signal evaluation branch: when `adx < ADX_THRESHOLDS.MR_MAX`, evaluate BB + RSI conditions
- Emit signal with `{ strategy: 'MEAN_REVERSION', bbMidline, stopPrice, direction }`

**`v2/engine/entryEngine.js`**
- On MR fill: save `bb_midline` and `stop_price` to trade record
- Requires either a new JSON metadata column or two new columns on `v2_trades`
- Place limit exit order at `bb_midline` immediately after fill confirmation

**`v2/engine/exitManager.js`**
- Add MR exit branch: check `stop_price` each bar, trigger market exit if breached
- Time-kill: count bars since entry using `timeframe` column + `entry_time`, kill after N bars
- On target fill confirmation: mark trade closed, do not place additional orders

**`v2/engine/liveExecutor.js`**
- Add `placeLimitSell(ticker, price, size)` / `placeLimitBuy(ticker, price, size)` for MR target exits
- TREND exits unchanged (still market orders)

**Database migration:**
- Add columns to `v2_trades`: `mr_target_price REAL`, `mr_stop_price REAL`
- Nullable — TREND trades leave them NULL

### Post-deploy monitoring
- Reset `stats_baseline_time` again after Phase 2 deploy
- First 10 MR trades tracked individually (same protocol as MOMENTUM revival watch)
- Watch: MR win rate vs 62% expectation; avg winner vs +$4 minimum; time-kill rate (high time-kills = ADX threshold needs adjustment)
- Rollback: add `MR_MODE=off` env var gate in scanner — if set, skip MR signal evaluation entirely

---

## What Is Not Changing

- Position sizing and Kelly criterion
- Circuit breaker and daily loss limits
- Pairs engine (paper mode, waiting for FIL/ICP cointegration to return — ADF currently -1.44, gate closed)
- MOMENTUM strategy (still on watch list, insufficient data for decision)
- All risk infrastructure, WebSocket feeds, database schema (except two new columns)
- Dashboard UI (MR trades appear in existing v2 trades table tagged `MEAN_REVERSION`)

---

## Success Criteria

**Phase 1 (after 7 days / ~20+ trades):**
- Trailing loss rate drops below 25% of trailing exits (was 42%)
- Net PnL trend reverses (moving toward 0 or positive)

**Phase 2 (after 30+ MR trades):**
- MR win rate ≥ 60%
- MR avg winner net ≥ $3.50 (clears 0.32% round-trip fees on $200 position)
- Combined (TREND + MR) net PnL positive over 30-day window
- Profit factor > 1.5 combined before considering live trading

---

## Rollback Plan

| Phase | Rollback |
|---|---|
| Phase 1 | Revert 3 lines in `constants.ts` (timeframes, regime, trail activation) |
| Phase 2 | Set `MR_MODE=off` in VPS env — no code revert needed |
