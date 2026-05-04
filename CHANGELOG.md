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

## 2026-05-03 23:55 UTC — Wave-2 audit-driven sweep: 8 fixes (CRITICAL+HIGH) — local-claude

**Commits:** `29f2e26`, `3669c68`, `ecc355c`, `8c58d3d`, `66d8953`, `45475b4`
**Files changed:** `services/exchangeAdapters/cryptocomAdapter.js`, `server.js`, `v2/engine/tradeEngine.ts`, `v2/pipeline/exitManager.ts`, `v2/engine/config.ts`, `v2/engine/dualExchangeEngine.ts`, `v2/pipeline/executor.ts`, `v2/pipeline/riskGate.ts`, `services/featureEngineering.js`, `services/websocketService.js`
**Stats baseline reset:** no (bug fixes restoring intended behavior — keep continuous stats so the impact is measurable)

**What changed:**
Wave 2 of the audit-driven fix series. 6 logical commits covering 8 audit items:

1. **`29f2e26` C1 — Crypto.com cancelOrder signature unified.** `cryptocomAdapter.cancelOrder` previously required `(orderId, ticker, sessionId)` but executionEngine and most server.js call sites use Kraken's `(orderId, sessionId)` form. Crypto.com received `sessionId` as `ticker`, called `formatTicker(sessionId)`, sent garbage `instrument_name`, and the cancel silently failed inside the executor's try/catch. In limit-then-market, the unfilled limit then stayed live while the fallback market order also fired → **double fill**. Fix: detect signature via `arguments.length`; when ticker is missing, look up `instrument_name` via `private/get-order-detail`. Backward-compat preserved for 3-arg callers.
2. **`3669c68` C3 — Dead Man's Switch wired up.** `krakenAdapter.cancelAllOrdersAfter` was implemented but never called anywhere. Memory described a 60s/90s heartbeat as active — it wasn't. If the bot crashed with native SLs open, those SLs stayed live indefinitely. Now: on startup (Kraken active + REAL mode + creds reachable), arm the switch immediately and keep warm via 60s heartbeat with 90s server-side timeout. Re-attempt timer fires every minute so late authentication still arms the protection (no-op when running). Failed heartbeats rate-limited to 5%.
3. **`ecc355c` H4+H5 — V2 engine robustness.** (a) `insertTrade` is now wrapped in try/catch; on failure in live mode, attempt market-sell rollback (with CRITICAL log if rollback also fails) — previously a DB write failure left a position on the exchange with no in-process record (BE-stop, trailing, TP, time_kill all skipped). (b) Each trade iteration in `exitManager.checkExits` is wrapped in try/catch — previously one bad price fetch unwound the for-loop and skipped exit checks for every remaining trade for up to BOT_LOOP_INTERVAL_MS (60s).
4. **`8c58d3d` H6+H7 — V2 fee accounting overhaul.** Added `EXCHANGE_FEES.*.ROUND_TRIP_REAL` (maker entry + taker exit) and `getExchangeFees(name)` helper to `v2/engine/config.ts`. Threaded through:
   - `tradeEngine.ts` exit fee → exchange-aware TAKER (Kraken 0.26%, Crypto.com 0.075%); old code over-stated fees by ~3.5× when running on Crypto.com.
   - `executor.ts` paper + live entry fee → exchange-aware MAKER.
   - `riskGate.ts` expected-return gate → uses ROUND_TRIP_REAL (0.42% on Kraken) instead of pure-maker assumption (0.32%); the 0.10% under-estimate was letting marginal-edge trades through the filter.
   - `dualExchangeEngine.ts` exit fee → always TAKER regardless of exit reason (mirrors `fa3e878` which fixed this in main tradeEngine.ts but missed dual). Also: stopped deducting `entryFee` from `engine.budget` at entry — it was already counted in pnlNet on close, so equity was double-deducting entry fees.
5. **`66d8953` H13 — NaN/Inf sanitize in feature vector.** Division-by-zero in upstream indicators (RSI when avgLoss=0, ATR with 0 range) produced NaN/Inf that passed through `imputeMissingFeatures` (which only branches on `=== 0`). Without this, `mlEngine.scaler.transformRow` clamped NaN → 0 silently, but `tfEngine.predictLSTM` passed NaN into `tf.tensor3d` → NaN throughout the network → confidence NaN → fell through gatekeeper's NaN-failopen invisibly. Final-pass `Number.isFinite` check now zeroes any non-finite value.
6. **`45475b4` H14 — Crypto.com WS stale-connection detector.** sendHeartbeat fired every 10s but nothing checked for response timeout; TCP zombies kept `connected=true` while no candles flowed. Mirrors `KrakenWS.checkHeartbeat` (services/krakenWebsocketService.js:152): track `lastMessageTime`, every 5s check elapsed; >30s warns, >40s force close + reconnect.

**Why:**
Wave 2 of the audit-driven sweep. These were the 8 larger CRITICAL/HIGH items that didn't need design decisions. Patterns from prior fix rounds (`fa3e878` exit fee, `6c9127e` SL rollback, schema-drift class) were used as templates and several more sites were found and fixed.

**What to monitor / watch for:**
- **Crypto.com double-fill rate**: previously hidden in try/catch on cancel. Watch `[ExecutionEngine] Limit ... failed` warnings — should drop. If a position size on Crypto.com is suddenly larger than expected after a fill, the underlying cancel pattern needs another look.
- **Kraken Dead Man's Switch logs**: should see `[Server] Dead Man's Switch armed: 60s heartbeat / 90s timeout` once on startup (and possibly again later if creds came in via UI). If the bot crashes, Kraken should auto-cancel all open orders within 90s.
- **V2 P&L numbers on Crypto.com**: previously over-stated fees by ~3.5×. Recorded `pnl_net` on Crypto.com trades after this deploy will be slightly higher than pre-deploy comparable trades. The change is correctness, not performance — trade selection should be unaffected.
- **riskGate rejections**: now slightly stricter (0.42% required vs 0.32%). A few marginal trades that previously passed may now show `[V2] RISK REJECT ... Expected return ...% < min ...%`. Combined with VPS Claude's MIN_CONFIDENCE gate (`79eed18`), trade frequency may drop further. If freq drops to near-zero for >48h, the MIN_EXPECTED_RETURN gate (currently 0.8%) is the lever to relax, not the fee math.
- **Dual-engine equity**: pre-deploy dual-engine equity was over-deducting entry fees. After deploy, equity values for any in-flight dual-engine trades will jump up by the cumulative entry-fee amount on first close. Mostly harmless (dual engine is paper).
- **`[V2 ExitMgr] skipped X` warnings**: should be rare. If one ticker shows up repeatedly, investigate that pair's WS/REST availability.
- **Crypto.com WS**: should see `[WebSocket] Stale connection ... — forcing reconnect` only when there's actual connectivity loss. If it fires constantly, threshold may be too tight — relax `STALE_TIMEOUT_MS`.
- **Telegram alerts** (new failure modes): `[V2] CRITICAL: insertTrade + rollback BOTH failed` requires immediate manual intervention — naked position on Kraken with native SL but no managed exits.

**What's next:**
- **Wave 3** (still BLOCKED on user decisions): C4 auth scheme; C2 V2 native SL bookkeeping (needs schema migration); H1 ML feature count (88 vs 109); H2 ml_features.regime; H3 dual-engine paper trades; H9 core/TradingEngine.ts; H10 arbitrageEngine.
- **Wave 4**: 27 MEDIUM + LOW items.

---

## 2026-05-03 22:00 UTC — Wave-1 audit-driven sweep: 7 fixes (CRITICAL+HIGH) — local-claude

**Commits:** `d661cb2`, `5714526`, `97b7d99`, `5ef0ff5`, `914f3fe`
**Files changed:** `server.js`, `services/exchangeAdapters/krakenAdapter.js`, `services/syntheticLabeler.js`, `v2/pipeline/meanReversionExitManager.ts`, `routes/tradingview.js`
**Stats baseline reset:** no (per CLAUDE.md — bug fixes restoring intended behavior keep continuous stats so the impact is measurable)

**What changed:**
First wave of fixes from a 6-fork audit covering V2 pipeline, core/, ML, exchange adapters, database, server.js+routes. Audit reports identified ~100 issues; this wave is the small unambiguous CRITICAL/HIGH items that didn't need design decisions. Five logical commits:

1. **`d661cb2` — `uncaughtException` flush + dead listener.** Crash handler now calls `dbBatcher.shutdown()` before `process.exit(1)` (SIGTERM/SIGINT already did via gracefulShutdown). Also removed a `tradingBus.on('engine:tick')` listener that received a payload missing the `priceMap` it tried to read — guarded so it didn't crash, but was dead code.
2. **`5714526` — Kraken adapter: BTC pair corruption + monotonic nonce.** `fromKrakenPair('XXBTZUSD')` was producing `BTUSD` (the `XBT->BTC` step never fired because greedy `/^X{1,2}/` ate both X's first). Same bug class in `getBalance` asset normalize. Both now do `XBT->BTC` first then strip prefixes with lookahead so single-X assets like XRP aren't mangled. Separately, `krakenPrivateRequest` now uses a process-lifetime monotonic counter for nonces instead of `Date.now()*1000+attempt` — the old form produced identical nonces under sub-millisecond concurrent calls (multi-strategy V2 issuing concurrent private API calls per tick).
3. **`97b7d99` — syntheticLabeler fail-loud.** Default `FEATURE_COUNT` was 103 fallback; real value is 109. If the dynamic import of `featureEngineering.js` ever failed, every newly built vector (length 109) was silently rejected by the `!== FEATURE_COUNT` check. Default is now `null` so `generateSamples()` short-circuits with a clear error instead of dropping every sample silently.
4. **`5ef0ff5` — MR exit manager trailing reclassification.** Mirror of `8259538`/`a3ccb15` — when the MR stop has been raised above initial (BE/quick-kill fired), label exits as `trailing` instead of `stop_loss`. Two sites in MR; both fixed. Currently dormant (MR disabled) but ready when re-enabled.
5. **`914f3fe` — TradingView webhook default-deny.** When `TRADINGVIEW_WEBHOOK_SECRET` env was unset, the secret check was skipped silently — anyone could inject signals into the 100-entry ring buffer. Now returns 503 when env is missing; opt-in by setting the env.

**Why:**
6-fork audit (yesterday + today) ran broad bug check across the codebase. CHANGELOG patterns from the 4 prior bug-fix rounds (`1705b17` schema drift, `7e80042` double-encode, `fa3e878` exit fee, `8259538` exit reason, `6c9127e` SL rollback) were used as templates to find similar issues elsewhere — and several were found. This wave clears the unambiguous ones; Waves 2-4 still pending (larger fixes that need user decisions on auth scheme, schema migrations, dual-engine design).

**What to monitor / watch for:**
- **BTC orders should now appear correctly in any UI/log that uses `fromKrakenPair`** — if `getOpenOrders` or balance breakdowns previously omitted BTC positions, they should now show. Verify after next BTC trade closes: `SELECT ticker FROM v2_trades WHERE ticker LIKE '%BTC%' ORDER BY entry_time DESC LIMIT 3`.
- **Kraken "Invalid nonce" errors should drop to zero** under multi-strategy load. Search PM2 logs: `pm2 logs canuck-node --lines 200 --nostream | grep -i nonce`.
- **No "Saved model has no scaler data" warnings combined with sample-rejection silence** in syntheticLabeler logs — if featureEngineering.js fails to load, you should now see `[SyntheticLabeler] CRITICAL: ...` instead of silent zero-sample runs.
- **TradingView webhook**: if you previously called this without setting the env var, it now returns 503. Set `TRADINGVIEW_WEBHOOK_SECRET` to re-enable.
- **MR exit reasons stay clean** — `EXIT_REASON.trailing` count for MR should be 0 today (engine disabled); when MR re-enables, the breakdown will be accurate from the start.

**What's next (deferred to user):**
- **Wave 2** (larger CRITICAL/HIGH, no input needed): C1 (cancelOrder signature double-fill on Crypto.com), C3 (Dead Man's Switch never wired), H4 (insertTrade rollback), H5 (per-trade try/catch in V2 exitManager), H6 (3 more fee-accounting sites), H7 (V2 fees always Kraken even when Crypto.com active), H13 (NaN/zero imputation), H14 (Crypto.com WS staleness).
- **Wave 3** (BLOCKED on user decisions): C4 auth scheme (localhost-only vs API key vs gate-worst-only); C2 V2 native SL bookkeeping (needs schema migration); H1 ML feature count (88 vs 109); H2 ml_features.regime (is regime even used?); H3 dual-engine paper trades (fix vs document); H9 core/TradingEngine.ts (delete vs patch); H10 arbitrageEngine multiple.
- **Wave 4**: 27 MEDIUM + LOW items — defer to a later sweep.

**Note on coordination:** during this sweep, vps-claude pushed `79eed18` (MIN_CONFIDENCE enforcement) at ~18:00 UTC. Picked up via `git fetch origin`, integrated cleanly via rebase (only CHANGELOG conflict, which was the predictable interleave). The bidirectional CHANGELOG system worked as designed — VPS Claude's entry gave full context for the trading-config change without a sync call.

---

## 2026-05-03 ~18:00 UTC — Enforce MIN_CONFIDENCE at signal gate (was dead code) — vps-claude

**Commits:** `79eed18`
**Files changed:** `v2/pipeline/signalGenerator.ts`
**Stats baseline reset:** no (this is a filter tightening — want to see the contrast vs. prior trades in continuous stats)

**What changed:**
`MIN_CONFIDENCE: 0.70` in config was never checked — the signal gate only checked `MIN_COMPOSITE_SCORE: 60`, allowing entries at confidence 0.60+. Added `&& confidence >= V2_CONFIG.MIN_CONFIDENCE` to the pass condition. Also added `confNote` to rejection log messages so filtered-out trades show the confidence shortfall.

**Why:**
Post-baseline data (9 trades) showed 6 of 9 entries had confidence 0.61–0.69, below the intended 0.70 threshold. These low-conviction entries accounted for most of the -$6.60 PnL drag (especially time_kill losses on stagnant positions). The 3 trades that would have passed the 0.70 gate included the two best wins.

**What to monitor / watch for:**
- **Trade frequency will drop** — most signals score 60–69 and will now be rejected. Watch for `[V2] REJECT` logs showing `conf=0.6x<0.7` to confirm the filter is working.
- **Win rate and avg PnL should improve** — only higher-conviction setups get through.
- **If trade frequency drops to near-zero** for >48h, the threshold may be too aggressive. Fallback: lower `MIN_CONFIDENCE` to 0.65 in config.ts.
- Rollback: revert the single commit.

---

## 2026-04-30 16:00 UTC — Cleanup sweep: 4 deferred bugs fixed (incl. real ML save bug) — local-claude

**Commits:** `1232a8d`, `a3ccb15`, `ee1b5bd`, `7e80042`
**Files changed:** `v2/engine/bearishServices.ts`, `services/exchangeAdapters/cryptocomAdapter.js`, `v2/pipeline/momentumExitManager.ts`, `v2/engine/config.ts`, `services/mlPredictionService.js`
**Stats baseline reset:** no (per CLAUDE.md — bug fixes / refactors / log cleanups keep continuous stats)

**What changed:**
1. **`1232a8d` — Crypto.com auth log noise (#31).** Two changes: bearishServices checks `SESSION_API_KEY/SECRET_KEY` env upfront and skips silently if missing (avoids triggering the adapter's auth-error chain). cryptocomAdapter's 40101 warning rewritten to "credentials invalid or expired" — was misleadingly saying "not configured" when keys were present but rejected. Both warnings remain once-per-process via existing guards.
2. **`a3ccb15` — MOMENTUM exit reclassification (#28).** Mirror of `8259538`'s fix to momentumExitManager — when stop has been raised above initial, label as `trailing` instead of `stop_loss`. Currently dormant (MOMENTUM disabled) but ready for when strategy is reworked.
3. **`ee1b5bd` — Centralize MOM_EXIT_CONFIG (#29).** Hardcoded config object moved from momentumExitManager.ts into v2/engine/config.ts as `MOM_EXIT_CONFIG`. No behavior change. Tuning consistency with TREND/MR.
4. **`7e80042` — REAL bug found while investigating #32.** mlPredictionService was wrapping `engine.serialize()` (already a JSON string) in `JSON.stringify(...)`, producing double-encoded JSON in the DB. Caused `deserialize()` to parse a string and emit "Saved model has no scaler data" on every restart. Verified in DB: model id=4 (older path) was correctly single-encoded with scaler.means.length=103; models id=380+ (recent worker path) started with `"{\"version\"...` instead of `{"version":...`. Two save sites fixed, both at the worker callback and the inline training path.

**Why:**
User-requested cleanup of all deferred items from bug inventory. Items #28 (MOMENTUM exit) and #29 (MOMENTUM config) were known dormant issues. #31 (Crypto.com noise) was a clarity fix. #32 looked like a minor "scaler not persisted" issue — turned out to be a substantive double-encoding bug that broke model restoration entirely.

**What to monitor / watch for:**
- **No more "Saved model has no scaler data" warnings on restart** — should appear once for the next restart (still loading id=385 which is double-encoded), then disappear after the next training cycle saves a correctly-encoded model. Verify by querying: `SELECT id, substr(model_data, 1, 5) FROM ml_models ORDER BY id DESC LIMIT 5;` — new entries should start with `{"ver` (single-encoded), not `"{\\"`.
- **Crypto.com auth warning wording is now more accurate** — should say "credentials invalid or expired" instead of "not configured" when keys are present but rejected.
- **MOMENTUM engine should remain disabled** — boot logs show `[V2] Momentum engine disabled` and no MOM trades open.
- **#30 (MOMENTUM signal redesign) deferred** — discussed with user; this is a strategy rebuild not a bug fix. Will revisit if/when MOMENTUM is to be re-enabled with a new approach (e.g., 15m timeframe with histogram acceleration).

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
