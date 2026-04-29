# Changelog

Bidirectional change log between local Claude (developer machine) and VPS Claude (live trading host). Both agents must add an entry to this file for every material change they ship, and read this file before making changes when accessing the repo on the VPS.

**Why this file exists:** Both agents work on the same code from different machines, with different views of the live trading state. Without a shared change log, drift accumulates: code changes happen in one place that the other doesn't see, monitoring criteria get out of sync, and miscommunications cause regressions (e.g., the 3-day V2 engine crash from commit `2a96f56` that local Claude initially flagged as "non-blocking").

**Format:** Newest entries at top. Group changes shipped together as one entry. Each entry includes everything the *other* agent needs to act on the change correctly.

## How to use this file

**When you ship a change:** add an entry at the top with the template below. Push with the commit. The other agent's session will see the update on its next git pull / fetch.

**When you access the VPS for any reason:** read the latest entries (at minimum entries since your previous interaction) so you're current on what changed, why, and what's being monitored. Don't assume your local view of the code matches what's running.

**When you make a material trading-config change:** also follow the standing rule in CLAUDE.md ("Stats Baseline Resets") — note the new baseline timestamp in your changelog entry.

## Entry template

```
## YYYY-MM-DD HH:MM UTC — <short title> — <agent: local-claude | vps-claude | user>

**Commits:** <SHA short-list>
**Files changed:** <brief list>
**Stats baseline reset:** yes / no — if yes, new baseline = <epoch ms>

**What changed:**
<one or two short paragraphs>

**Why:**
<motivation, data references, hypothesis being tested>

**What to monitor / watch for:**
- <specific metric, query, or behavior>
- <expected outcome and threshold for "this isn't working">
- <how to roll back if needed>
```

---

## 2026-04-29 19:30 UTC — Round-3 bug sweep: schema migration + 2 more fixes — local-claude

**Commits:** `1705b17`, `fa3e878`
**Files changed:** `v2/attribution/attributionStore.ts`, `v2/pipeline/momentumExitManager.ts`, `v2/pipeline/breakoutExitManager.ts`, `v2/pipeline/meanReversionExitManager.ts`, `v2/engine/tradeEngine.ts`
**Stats baseline reset:** no (per CLAUDE.md — bug fixes restoring intended behavior keep continuous stats so the impact is measurable)

**What changed:**
1. **`1705b17` — Schema migration: persist `atrPercent`, `peakPrice`, `peakHistogram`.** These were declared on the V2Trade type and set on entry, but missing from the v2_trades schema. So every loop after entry, the trade was loaded with these as `undefined`. Knock-on effects (verified):
   - **TREND quick-kill stop tightening NEVER fired.** Condition `trade.atrPercent != null` was false on every loaded trade. Verified: 0/94 closed TREND trades had a stop tightened below entry. Recent QUICK_KILL_AFTER_MS tuning (8h → 4h) was doing nothing.
   - **TREND ATR-aware trailing-giveback NEVER applied.** Just constant 0.25 giveback regardless of vol.
   - **MOMENTUM histogram-decay exit could never trigger** (peakHist always = currentHist). Dormant — MOMENTUM disabled.
   - **BREAKOUT chandelier and MR peak-trailing similarly broken.** Both dormant.
   - Fix: idempotent ALTER TABLE adds 3 columns, insertTrade/rowToTrade updated, new `updateTradePeakPrice` / `updateTradePeakHistogram` helpers wired into the 3 exit managers that mutate peaks. Old rows (NULL columns) handled by existing `?? entry`/`!= null` fallbacks.

2. **`fa3e878` — Exit fee accounting + ML gatekeeper logging.**
   - **Exit fee:** was computing maker fee for take_profit/trailing exits, but actual exit path always uses `placeMarketSell` (taker). Recorded P&L over-stated by ~0.10% per planned exit. Now: always use FEE_TAKER_PERCENT to match reality.
   - **ML gatekeeper:** changed `} catch { /* swallow */ }` to log a warning (capped at 1/30 loops). The existing catch hid both "ML not configured" *and* real evaluation bugs.

**What to monitor / watch for:**
- **Quick-kill should now actually fire.** Look for trades with `current_stop > initial_stop AND current_stop < entry_price` after 4+ hours of no profit. Query: `SELECT id, ticker, ROUND(current_stop,4), ROUND(initial_stop,4), ROUND(entry_price,4) FROM v2_trades WHERE status='closed' AND current_stop > initial_stop AND current_stop < entry_price AND entry_time > 1777485600000;` — should produce non-zero count over coming days.
- **Schema migration:** boot logs should show no errors. Verify columns exist via `PRAGMA table_info(v2_trades)` — should include atr_percent, peak_price, peak_histogram REAL.
- **New entries should populate the new columns.** Query `SELECT atr_percent, peak_price FROM v2_trades WHERE entry_time > <baseline>` — should see non-null values for trades after this deploy.
- **ML bypass warnings** in logs would indicate gatekeeper failure — investigate if observed.
- **Old trades** keep NULL for new columns; that's expected and safe.

---

## 2026-04-29 19:00 UTC — Round-2 bug sweep: 3 more fixes (incl. MOMENTUM regression) — local-claude

**Commits:** `30762ff`, `09746f4`, `6c9127e`
**Files changed:** `v2/index.ts`, `v2/engine/momentumEngine.ts`, `v2/pipeline/executor.ts`
**Stats baseline reset:** no (per CLAUDE.md — bug fixes restoring intended behavior keep continuous stats)

**What changed:**
1. **`30762ff` — Re-disable MOMENTUM engine.** This was a regression from my own 17:39 UTC force-push to the VPS bare repo: VPS Claude's `2a96f56` (MOMENTUM disable) lived only on the bare repo and got overwritten when I pushed my origin history. The MOMENTUM init/start calls returned to v2/index.ts. Engine has been "running" for 4 days but produced 0 trades due to market conditions — pure luck. Now restored to disabled state, mirroring `2a96f56`'s edit.
2. **`09746f4` — Set MOMENTUM `takeProfitTarget` to SL-mirror sentinel.** Was 0, which broke analytics queries (R:R formula produced -70.04 for SOL entries). Now: `entry + atrDollar * SL_ATR_MULT` (mirrors SL distance, R:R = 1.0). Functionally identical at runtime since `momentumExitManager` doesn't read the field; purely fixes analytics.
3. **`6c9127e` — Live-mode SL retry + rollback in executor.** Previously a `placeStopLoss` failure was logged but the trade was kept — leaving a real exchange position with no native SL, exposed if the bot crashed. Now: 3-attempt retry with 1s/2s/4s backoff, market-sell rollback if all fail, CRITICAL log if rollback also fails. Currently masked by paper mode but ready for live transition.

**Why:**
Round-2 audit (user-requested "nothing too small to mention" check) caught the MOMENTUM regression, which was the most important finding by far. The other two are low-impact correctness/hardening fixes.

**What to monitor / watch for:**
- **MOMENTUM should NOT log "Momentum engine started" or open trades.** Boot log should now show `[V2] Momentum engine disabled (0% WR over 7 trades, buying overbought)`. If MOMENTUM trades appear in `v2_trades` with `entry_time > 1777485600000`, the regression returned — revert `30762ff` is not the fix; investigate why the disable didn't take.
- **Exit reason classification fix from earlier (`8259538`) and this batch's MOMENTUM fixes both deployed in the same window.** Use `WHERE entry_time > <baseline>` to isolate cohort.
- **Future force-pushes:** before any force-push to vps remote, check whether the bare repo has commits ahead that aren't in origin. The CHANGELOG system + this lesson should prevent silent commit loss going forward.

**Process improvement:** the MOMENTUM regression is exactly what the new CHANGELOG.md system is designed to catch. Each entry from now on should help surface multi-agent state drift earlier.

---

## 2026-04-29 18:30 UTC — Bug-fix sweep (5 issues) + bidirectional changelog system — local-claude

**Commits:** `8259538`, `0e30f19`, `6cd1e24`, plus this changelog + CLAUDE.md handoff rule
**Files changed:** `v2/pipeline/exitManager.ts`, `v2/pipeline/riskGate.ts`, `v2/engine/positionManager.ts`, `v2/engine/tradeEngine.ts`, `CHANGELOG.md` (new), `CLAUDE.md`
**Stats baseline reset:** no (per CLAUDE.md — bug fixes restoring intended behavior keep continuous stats)

**What changed:**
1. **`8259538` — Exit reason classification:** when `currentPrice <= currentStop` AND the stop has been raised (`trailingActivated` OR `currentStop > initialStop`), label exit as `trailing` instead of `stop_loss`. Also: BE stop in `exitManager.ts:118` no longer has an upper bound on its trigger range (was `< TRAILING_ACTIVATE_PERCENT`, which silently squeezed to a 0.2% window when trailing activation tightened from 0.015 to 0.01). Now BE always tries to set stop floor at entry+0.1%; trailing tightens further if applicable.
2. **`0e30f19` — riskGate defensive guards:** added `isFinite` checks on `positionSizeUsd` (NaN-comparisons-are-false bug), `lastPrice`, and `atrValue` to prevent silent NaN-priced trades from entering the system.
3. **`6cd1e24` — Per-strategy circuit breaker:** `getCircuitBreakerState()` now accepts a `strategy` parameter and filters `getClosedTradesByStrategy()` accordingly. Previously a loss in any strategy would trigger TREND's cooldown.

**Why:**
Routine bug-check sweep (user-requested) found 5 issues in V2 logic. None were causing P&L damage but the misclassified exit reasons were obscuring our analytics — every BE/trailing save was logged as "stop_loss with positive PnL". Fix #2 restores the intended behavior of the BE stop after VPS Claude's earlier `c277bb4` config tweak inadvertently squeezed it. Fixes #3-#5 are defensive hardening (no current instances in DB).

**What to monitor / watch for:**
- **Exit reason distribution should change visibly.** Before: lots of `stop_loss` exits with positive PnL. After: those should now appear as `trailing`. Query: `SELECT exit_reason, COUNT(*), SUM(CASE WHEN pnl_net > 0 THEN 1 ELSE 0 END) wins FROM v2_trades WHERE exit_time > 1777485000000 GROUP BY exit_reason;`
- **BE stop should fire more often** in trades that reach +0.8% but don't get to +1.0% trailing activation. Watch for trades exiting near entry+0.1% via `trailing` reason (those are BE saves under the new label).
- **Per-strategy circuit breaker:** currently masked because only TREND is enabled. If MOMENTUM or MEAN_REVERSION are re-enabled, verify their lossy trades don't pause TREND.
- **Rollback any single fix** with `git revert <SHA>` (8259538, 0e30f19, or 6cd1e24).

---

## 2026-04-29 17:39 UTC — Loss mitigation package (3 commits) + stats baseline reset — local-claude

**Commits:** `5827dd5`, `254dce6`, `79656ff`, plus design doc `39d0e71`
**Files changed:** `v2/engine/config.ts`, `docs/plans/2026-04-29-loss-mitigation-package-design.md`
**Stats baseline reset:** **YES, new baseline = 1777484345000** (2026-04-29 17:39:05 UTC)

**What changed:**
1. **`5827dd5` — Ticker swap:** removed BTCUSD (0/3 = 0% WR live), added DOTUSD (75% WR) and ADAUSD (60% WR). New scan list: ETH, XRP, DOGE, DOT, ADA.
2. **`254dce6` — Re-allowed STRONG_UP regime:** `ALLOWED_REGIMES: ['UP'] → ['STRONG_UP', 'UP']`. Previous block was based on R:R 0.8 era data; at R:R 1.4 STRONG_UP showed 60% WR break-even.
3. **`79656ff` — Widened TP from 1.4:1 to 1.6:1 R:R:** `TAKE_PROFIT_ATR_MULT: 3.5 → 4.0`. Experimental — historical R:R 1.6 cohorts underperformed but those were before BE/trailing fixes were in place.

**Why:**
Per analysis in `docs/plans/2026-04-29-loss-mitigation-package-design.md`. R:R 1.4 cohort (54 closed trades) was -$7.38 net with avg_win < avg_loss. Per-ticker analysis showed losses heavily concentrated in BTCUSD, while removed-tickers DOT/ADA were actually winners in live data. STRONG_UP block was based on stale config-era data.

**What to monitor / watch for:**
- **Post-baseline cohort:** primary stats use `WHERE entry_time >= 1777484345000`. Legacy trades reported separately.
- **R:R should be 1.6 on new TREND entries** (was 1.4). Any 0.8 entries are regressions from `79656ff`; revert that commit.
- **Per-ticker WR:** DOT and ADA should deliver on their 60-75% historical WR. BTCUSD entries should not appear (would be regression from `5827dd5`).
- **STRONG_UP entries should perform comparably to UP.** If significantly worse (per-trade), revert `254dce6`.
- **TP widening test:** wide-TP avg_win should rise meaningfully from R:R 1.4 baseline of $0.97. If WR drops or avg_win doesn't improve after 10+ post-baseline closes, revert `79656ff` (the experimental commit).
- Each commit independently revertable.

---

## 2026-04-29 13:42 UTC — Tune exit params + disable MR engine + remove SOLUSD — vps-claude

**Commits:** `c277bb4` (relayed to origin via patch as `c277bb4`)
**Files changed:** `v2/engine/config.ts`, `monitor.sh`
**Stats baseline reset:** no (predates the standing rule)

**What changed:**
- TRAILING_ACTIVATE_PERCENT: 0.015 → 0.01
- TRAILING_GIVEBACK_PERCENT: 0.30 → 0.25
- TIME_KILL_MS: 16h → 12h
- QUICK_KILL_AFTER_MS: 8h → 4h
- SOLUSD removed from SCAN_TICKERS
- TP=5.0 ATR experiment then reverted to 3.5
- MR_CONFIG.ENABLED: true → false (0/4 WR live, -$2.80)

**Why:** Per VPS Claude's analysis of live trade outcomes during the 3-day window after the brace-bug fix.

**Note:** The TRAILING_ACTIVATE_PERCENT change inadvertently squeezed the BE stop window — fixed in subsequent `8259538` commit.

---

## 2026-04-25 23:31 UTC — Fix broken brace structure that crashed V2 engine for 3 days — vps-claude

**Commits:** `5561e1e` (on VPS bare repo, not on origin)
**Files changed:** `v2/index.ts`
**Stats baseline reset:** n/a

**What happened:** The MOM disable edit (`2a96f56`) left a stray `try {` block that broke the module parse. Node's TS stripper rejected the file with `ERR_INVALID_TYPESCRIPT_SYNTAX`. PM2 showed "online" but the V2 engine loop never started — 4 positions left unmanaged for 3 days with no exit checks.

**Lesson:** Startup-time parse errors are NEVER non-blocking when they occur before the work loop initializes. Local Claude misclassified this as "non-blocking" in an earlier progress report.

---

## 2026-04-22 13:31 UTC — Disable MOMENTUM engine — vps-claude

**Commits:** `2a96f56`
**Files changed:** `v2/index.ts`
**Stats baseline reset:** n/a

**What:** Disabled MOMENTUM engine (7 trades, 0 wins, -$9.78 net). MACD histogram spikes on 1h candles catch end-of-move exhaustion, not initiation.

---

## 2026-04-21 15:39 UTC — Initial fix package: R:R restoration, BE stop revival, STRONG_UP block — local-claude

**Commits:** `6868c42`, `83cf3b1`, `6166dae`
**Files changed:** `v2/engine/config.ts`
**Stats baseline reset:** n/a (predates the standing rule)

**What:**
- `6868c42` — TRAILING_ACTIVATE_PERCENT: 0.008 → 0.015 (revives the dead BE stop code path)
- `83cf3b1` — TAKE_PROFIT_ATR_MULT: 2.0 → 3.5 (restores 1.4:1 R:R from inverted 0.8:1)
- `6166dae` — ALLOWED_REGIMES: ['STRONG_UP', 'UP'] → ['UP'] (blocked STRONG_UP — 36% WR / -$38 in R:R 0.8 era)

**Why:** First systematic V2 fix package. Identified that R:R was inverted (every trade structurally negative) and BE stop had a `>= 0.008 AND < 0.008` impossible condition.

**Note:** The STRONG_UP block was later re-evaluated and reversed in `254dce6` after analysis showed the original block was based on stale R:R 0.8 era data.
