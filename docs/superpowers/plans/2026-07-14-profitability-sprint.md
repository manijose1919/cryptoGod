# Profitability Sprint (Review + Batched Change Set) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift live per-trade expectancy from +$0.04 toward +$0.50–0.60 by disabling proven-negative segments (TREND shorts, possibly 1h TREND longs), fixing the sprint-review reminder so verdicts can't silently expire, and resetting the stats baseline once for the whole batch.

**Architecture:** Config-only trading changes in `v2/engine/config.ts` (gates verified in `v2/engine/strategyRunner.ts:101-116` and `v2/pipeline/exitManager.ts:117-118`), one script fix in `scripts/generate-audit-report.mjs`, diagnostics run read-only against the VPS SQLite DB over SSH. Spec: `docs/superpowers/specs/2026-07-14-profitability-sprint-review-design.md`.

**Tech Stack:** TypeScript (V2 engine), Node ESM script + better-sqlite3 (audit report), sqlite3 CLI over SSH (`root@31.97.7.138`, DB `/opt/trading-bot/data/trading.db`), `bash scripts/push-deploy.sh` for deploys.

## Global Constraints

- Stats baseline (current): `1782834161576`. One NEW baseline reset for the whole batch, applied in Task 5 only.
- One logical change per commit (standing rule) — each task below is its own commit.
- Deploy ONLY via `bash scripts/push-deploy.sh` (pushes origin + vps, verifies SHA).
- No test runner exists in this repo. Verification = `npx tsc --noEmit` (repo has strict TS but no build-time checking) plus the runnable checks written into each task. Do not add a test framework.
- Kitchen-sink guard: anything the diagnostics surface beyond the pre-registered decisions is documented in the review file, NOT shipped in this batch.
- Pre-registered decision rules (from the spec — decide by these, not by vibes):
  - Shorts: disable TREND shorts unless a materially profitable sub-segment with n ≥ 10 exists.
  - 1h TREND longs: keep + extend 1h time-kill (bounded at 2× current, 1h-only via per-timeframe override) if ≥60% of post-baseline 1h time_kill exits were "recoverable" (price reached the trailing-activation level within 2× the kill window from entry); otherwise remove 1h.
  - Gatekeeper: if ≥30 PROCEED_AB samples with outcomes, remove gatekeeper when PROCEED_AB win% ≥ PROCEED win%; else defer with no change. (As of 2026-07-14 there were only 5 — expect "defer".)
- All SQL against the VPS DB in Tasks 1 is READ-ONLY. The only write is the baseline reset in Task 5.
- SQLite CLI quoting gotcha: this repo's SSH one-liners have failed on nested quotes before. Put SQL in a heredoc file, `scp` it, and run `sqlite3 db < file.sql`, or use `sqlite3 db "$(cat file.sql)"`. Avoid single-quoted SQL strings inside double-quoted ssh commands.

---

### Task 1: Run the sprint re-review diagnostics and write the findings

**Files:**
- Create: `docs/reviews/2026-07-14-sprint-review.md` (repo copy, committed)
- Modify (on VPS, via ssh — NOT a repo file): `/opt/trading-bot/data/reports/audit-batch-notes.md` (append the same review + dismissal marker)
- Scratch: put all `.sql` helper files in the session scratchpad, not the repo

**Interfaces:**
- Consumes: VPS DB tables `v2_trades`, `ml_gatekeeper_log`, `candle_history` (schema discovered in Step 3), `settings`.
- Produces: `docs/reviews/2026-07-14-sprint-review.md` containing a **DECISIONS** section with exactly three lines that Tasks 2–3 read: `SHORTS: <disable|keep>`, `1H_TREND: <remove|extend-timekill-to-N-bars>`, `GATEKEEPER: <remove|defer>`. Later tasks branch on these literal values.

- [ ] **Step 1: Run the five pre-registered checks against the current 38+ trade cohort**

Write to scratchpad `check1-5.sql`:

```sql
-- 1. Risk cap: worst single loss (expect >= -15)
SELECT 'CHECK1_WORST_LOSS', ticker, strategy, timeframe, ROUND(pnl_net,2)
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576
ORDER BY pnl_net ASC LIMIT 3;
-- 2. Expectancy vs +0.25 baseline
SELECT 'CHECK2_EXPECTANCY', COUNT(*), ROUND(AVG(pnl_net),3), ROUND(SUM(pnl_net),2)
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576;
-- 2b. Trajectory: first 15 vs rest (July 5 review saw only the first 15)
SELECT 'CHECK2B_TRAJECTORY', CASE WHEN rn<=15 THEN 'trades_1_15' ELSE 'trades_16_plus' END grp,
       COUNT(*), ROUND(SUM(pnl_net),2), ROUND(AVG(pnl_net),3)
FROM (SELECT pnl_net, ROW_NUMBER() OVER (ORDER BY exit_time) rn
      FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576)
GROUP BY grp;
-- 3. Regime gates: MOMENTUM outside STRONG_UP, shorts outside STRONG_DOWN (expect 0 rows)
SELECT 'CHECK3_REGIME_VIOLATION', id, strategy, side, entry_regime
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576
AND ((strategy='MOMENTUM' AND entry_regime!='STRONG_UP')
  OR (side='short' AND entry_regime!='STRONG_DOWN'));
-- 4. Time gate: entries in blocked UTC hours 0-7,13,20 (expect 0 rows)
SELECT 'CHECK4_TIMEGATE_VIOLATION', id, ticker,
       CAST(strftime('%H', entry_time/1000, 'unixepoch') AS INTEGER) hr
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576
AND CAST(strftime('%H', entry_time/1000, 'unixepoch') AS INTEGER) IN (0,1,2,3,4,5,6,7,13,20);
-- 5. Gatekeeper A/B
SELECT 'CHECK5_GATEKEEPER', decision, COUNT(*),
       ROUND(100.0*AVG(was_correct),0) win_pct
FROM ml_gatekeeper_log WHERE actual_outcome IS NOT NULL
AND decision LIKE 'PROCEED%' GROUP BY decision;
```

Run: `scp check1-5.sql root@31.97.7.138:/tmp/ && ssh root@31.97.7.138 'sqlite3 -column /opt/trading-bot/data/trading.db < /tmp/check1-5.sql'`
Expected: worst loss ≥ −$15 (cap PASS); expectancy ≈ +$0.04 overall with trades_16_plus strongly positive; zero regime/timegate violations; PROCEED_AB sample count (if <30 → gatekeeper decision is `defer`).

- [ ] **Step 2: Shorts viability (decision input for Task 2)**

Scratchpad `shorts.sql`:

```sql
SELECT 'ALLTIME_SHORTS', timeframe, entry_regime, COUNT(*) n,
       ROUND(SUM(pnl_net),2) net, ROUND(AVG(pnl_net),3) avg_pnl
FROM v2_trades WHERE status='closed' AND side='short' AND timeframe IS NOT NULL
GROUP BY timeframe, entry_regime ORDER BY net;
SELECT 'POSTBASELINE_SHORTS', strategy, timeframe, COUNT(*), ROUND(SUM(pnl_net),2)
FROM v2_trades WHERE status='closed' AND side='short' AND entry_time>=1782834161576
GROUP BY strategy, timeframe;
```

Run the same scp + sqlite3 pattern.
Expected (from recon): every timeframe/regime cell negative or n<10. Decision rule: any cell with n≥10 AND materially positive net ⇒ `SHORTS: keep` (not expected); otherwise `SHORTS: disable`.

- [ ] **Step 3: 1h time_kill recoverability (decision input for Task 3)**

Get the killed trades:

```sql
SELECT id, ticker, ROUND(entry_price,6), entry_time, exit_time, ROUND(pnl_net,2)
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576
AND strategy='TREND' AND timeframe='1h' AND side='long' AND exit_reason='time_kill';
```

For each trade, recoverable ⇔ some 1h candle high in `(entry_time, entry_time + 4h]` reaches `entry_price × 1.014` (TREND `trailActivatePercent: 0.014` from `v2/engine/config.ts:179`; kill window = `timeKillBars: 2` × 1h, 2× window = 4h). Candle source, in order of preference:
1. VPS `candle_history` table — first run `ssh root@31.97.7.138 'sqlite3 /opt/trading-bot/data/trading.db ".schema candle_history"'` and adapt column names; filter to the trade's ticker + 1h interval and the 4h window.
2. If that table lacks the window, Kraken public REST (no auth): `curl "https://api.kraken.com/0/public/OHLC?pair=<TICKER>&interval=60&since=<entry_time_seconds>"` — `result.<pair>` rows are `[time, open, high, low, close, vwap, volume, count]`; check `high` of the first 4 rows after entry. (1h history covers ~30 days back — all post-baseline trades qualify as of 2026-07-14.)

Record per trade: ticker, entry, activation price (entry × 1.014), max high in window, recoverable yes/no.
Decision: recoverable_count / total ≥ 0.6 ⇒ `1H_TREND: extend-timekill-to-4-bars` (2× current 2, the spec's bound). Else ⇒ `1H_TREND: remove`.

- [ ] **Step 4: Per-ticker breakdown (documentation only — no shipped change)**

```sql
SELECT ticker, COUNT(*) n, ROUND(SUM(pnl_net),2) net, ROUND(AVG(pnl_net),3)
FROM v2_trades WHERE status='closed' AND entry_time>=1782834161576
GROUP BY ticker ORDER BY net;
```

Any single-ticker drag goes in the review's "flagged, not shipped" section per the kitchen-sink guard.

- [ ] **Step 5: Write `docs/reviews/2026-07-14-sprint-review.md`**

Structure (fill every number from Steps 1–4; no placeholders):

```markdown
# Sprint Re-Review — 2026-07-14 (baseline 1782834161576, n=<N>)

Follow-up to VPS Claude's 2026-07-05 review at n=15 (verdict then: −$1.30/trade,
"no config change"). Trades 16–<N> ran ≈ +$<X>/trade — the cohort verdict changed
with sample size; this review supersedes it.

## Pre-registered checks
| # | Check | Result | Pass |
... five rows with actual numbers ...

## Segment analyses
### Shorts viability
... table from Step 2 ...
### 1h time_kill recoverability
... per-trade table from Step 3 ...
### Per-ticker
... table from Step 4 ...

## DECISIONS
SHORTS: <disable|keep>
1H_TREND: <remove|extend-timekill-to-4-bars>
GATEKEEPER: <remove|defer>

## Flagged, not shipped
... anything else the data surfaced ...
```

- [ ] **Step 6: Append the same review + dismissal marker to the VPS notes file**

```bash
scp docs/reviews/2026-07-14-sprint-review.md root@31.97.7.138:/tmp/review.md
ssh root@31.97.7.138 'printf "\n---\n\n" >> /opt/trading-bot/data/reports/audit-batch-notes.md && cat /tmp/review.md >> /opt/trading-bot/data/reports/audit-batch-notes.md && printf "\n<!-- sprint-review-done baseline=1782834161576 -->\n" >> /opt/trading-bot/data/reports/audit-batch-notes.md'
```

Verify: `ssh root@31.97.7.138 'tail -5 /opt/trading-bot/data/reports/audit-batch-notes.md'` shows the marker. (The marker format must match Task 4's regex exactly: `<!-- sprint-review-done baseline=1782834161576 -->`.)

- [ ] **Step 7: Commit**

```bash
git add docs/reviews/2026-07-14-sprint-review.md
git commit -m "docs(review): sprint re-review at n=38 — supersedes 2026-07-05 n=15 verdict"
```

---

### Task 2: Disable TREND shorts (conditional on `SHORTS: disable`)

If Task 1 decided `SHORTS: keep` (not expected), skip this task entirely and note why in the changelog entry.

**Files:**
- Modify: `v2/engine/config.ts:82`

**Interfaces:**
- Consumes: `DECISIONS → SHORTS` from `docs/reviews/2026-07-14-sprint-review.md`.
- Produces: `V2_CONFIG.SHORTS_ENABLED === false`. Consumed by `v2/engine/strategyRunner.ts:102` (the only non-backtest gate on TREND short signal generation — verified 2026-07-14; `MR_CONFIG.SHORTS_ENABLED` at config.ts:403 is a separate mechanism and is NOT touched).

- [ ] **Step 1: Edit config**

`v2/engine/config.ts` line 82, replace:

```typescript
  SHORTS_ENABLED: true,                  // 2026-05-18: enabled for paper testing
```

with:

```typescript
  SHORTS_ENABLED: false,                 // 2026-07-14: disabled. All-time timeframed shorts −$54.45/37 trades, negative on EVERY timeframe (1h −$15.72/11, 30m −$18.33/5, 4h −$20.40/21); post-baseline 4h shorts −$17.99/4 @ 25% WR. No profitable sub-segment with n≥10. Rollback: set true (SHORT_TIMEFRAMES/SHORT_ALLOWED_REGIMES below retained for that case). Review: docs/reviews/2026-07-14-sprint-review.md
```

- [ ] **Step 2: Verify type-check and that no other live code path reads the flag**

Run: `npx tsc --noEmit` → expected: no NEW errors (record pre-existing ones first with the same command before editing).
Run: `grep -rn "V2_CONFIG.SHORTS_ENABLED" v2 --include="*.ts" | grep -v backtest` → expected: only `v2/engine/strategyRunner.ts:102`.

- [ ] **Step 3: Commit**

```bash
git add v2/engine/config.ts
git commit -m "feat(v2/risk): disable TREND shorts — negative on every timeframe all-time (-\$54/37)"
```

---

### Task 3: 1h TREND decision (branch per Task 1's `1H_TREND` decision)

**Files:**
- Branch A (extend-timekill): Modify `v2/engine/config.ts:159-183` and `v2/pipeline/exitManager.ts:118`
- Branch B (remove): Modify `v2/engine/config.ts:149`

**Interfaces:**
- Consumes: `DECISIONS → 1H_TREND` from the review doc.
- Produces (A): optional `timeKillBarsByTf?: Record<string, number>` on `StrategyExitConfig`, honored by exitManager. Produces (B): `STRATEGY_TIMEFRAMES.TREND === ['4h']`.

**Branch A — `extend-timekill-to-4-bars` (keep 1h, longer leash, 4h untouched):**

- [ ] **Step A1: Add the optional per-timeframe override to the interface**

In `v2/engine/config.ts`, inside `export interface StrategyExitConfig {` (line ~159), after `timeKillBars: number;      // bars to hold before time-kill` add:

```typescript
  timeKillBarsByTf?: Record<string, number>;  // per-timeframe override of timeKillBars (2026-07-14: lets 1h get a longer leash without touching 4h)
```

- [ ] **Step A2: Set the override on TREND**

In `STRATEGY_EXIT_CONFIGS.TREND` (line ~180), replace:

```typescript
    timeKillBars: 2, timeKillMinMove: 0.007,
```

with:

```typescript
    timeKillBars: 2, timeKillBarsByTf: { '1h': 4 }, timeKillMinMove: 0.007,  // 2026-07-14: 1h kills at 2 bars were premature — ≥60% of killed 1h trades reached trail activation within 4h (see docs/reviews/2026-07-14-sprint-review.md). 4h keeps 2 bars.
```

- [ ] **Step A3: Honor the override in the exit manager**

In `v2/pipeline/exitManager.ts` line 118, replace:

```typescript
    const cfgTimeKillMs = tfMs ? exitCfg.timeKillBars * tfMs : V2_CONFIG.TIME_KILL_MS;
```

with:

```typescript
    const cfgTimeKillMs = tfMs
      ? (exitCfg.timeKillBarsByTf?.[trade.timeframe!] ?? exitCfg.timeKillBars) * tfMs
      : V2_CONFIG.TIME_KILL_MS;
```

- [ ] **Step A4: Verify**

Run: `npx tsc --noEmit` → no new errors.
Runnable spot-check (scratchpad `tk-check.ts`, run with `npx tsx tk-check.ts` from repo root):

```typescript
import { STRATEGY_EXIT_CONFIGS, timeframeToMs } from './v2/engine/config.ts';
const cfg = STRATEGY_EXIT_CONFIGS.TREND;
const ms = (tf: string) => (cfg.timeKillBarsByTf?.[tf] ?? cfg.timeKillBars) * timeframeToMs(tf);
console.log('1h kill window h:', ms('1h') / 3.6e6);  // expect 4
console.log('4h kill window h:', ms('4h') / 3.6e6);  // expect 8 (unchanged)
```

Expected output: `1h kill window h: 4` and `4h kill window h: 8`.

- [ ] **Step A5: Commit**

```bash
git add v2/engine/config.ts v2/pipeline/exitManager.ts
git commit -m "feat(v2/exit): per-timeframe time-kill override — 1h TREND 2->4 bars, 4h unchanged"
```

**Branch B — `remove` (drop 1h TREND entries):**

- [ ] **Step B1: Edit config**

`v2/engine/config.ts` line 149, replace:

```typescript
  TREND:           ['1h', '4h'],  // 2026-06-27: 1h restored. Was 4h-only since Jun 19 (1 trade in 9 days). Fee-aware floor now protects 1h wins. 30m stays out (proven loser).
```

with:

```typescript
  TREND:           ['4h'],  // 2026-07-14: 1h dropped again. Post-baseline 1h: −$2.17/14 trades (flat all-time +$1.56/36) and its time_kill exits were NOT recoverable (<60% reached trail activation — docs/reviews/2026-07-14-sprint-review.md). 4h longs +$22.92/14 @ 71% carry the book. NOTE this also stops 4h-gated shorts scanning on 1h (already restricted by SHORT_TIMEFRAMES). Rollback: restore '1h'.
```

- [ ] **Step B2: Verify**

Run: `npx tsc --noEmit` → no new errors.
Run: `grep -n "TREND:" v2/engine/config.ts | head -3` → shows `['4h']`.
Note: `STRATEGY_TIMEFRAMES.MOMENTUM` keeps `['1h', '4h']` — MOMENTUM 1h is +$0.46/2 post-baseline, not part of this decision (kitchen-sink guard).

- [ ] **Step B3: Commit**

```bash
git add v2/engine/config.ts
git commit -m "feat(v2/trend): drop 1h entries — flat all-time, kills not recoverable; concentrate 4h"
```

---

### Task 4: Marker-based sprint-review reminder (no silent expiry)

**Files:**
- Modify: `scripts/generate-audit-report.mjs:128-146`

**Interfaces:**
- Consumes: `NOTES_PATH` (line 20), `BASELINE_MS` (line 50), `post.n` (line 74), `existsSync`/`readFileSync` (already imported, line 15).
- Produces: banner logic that fires whenever `post.n >= 15` AND the notes file lacks `<!-- sprint-review-done baseline=<BASELINE_MS> -->`. Reviewers dismiss it by appending that marker (Task 1 Step 6 already wrote one for the OLD baseline; after Task 5's reset the banner re-arms automatically for the new baseline).

- [ ] **Step 1: Replace the window condition with marker detection**

In `scripts/generate-audit-report.mjs`, replace lines 128–132 (the comment block and `if`):

```javascript
// Self-triggering reminder for VPS Claude: once the post-baseline cohort reaches
// ~15-20 closed trades, run the backtest-vs-live comparison for the 2026-06-30
// R:R + edge sprint and report to Joseph. Fires only inside the review window so it
// doesn't nag forever. (Set by local-claude 2026-06-30.)
if (post.n >= 15 && post.n <= 30) {
```

with:

```javascript
// Self-triggering reminder for VPS Claude: from 15 post-baseline closed trades,
// nag until the notes file contains the dismissal marker for the CURRENT baseline:
//   <!-- sprint-review-done baseline=<BASELINE_MS> -->
// Append the marker only when the review reaches a decision — a "wait for more
// data" verdict leaves the banner up on purpose. The old 15-30 window let the
// 2026-07-05 n=15 "wait" verdict expire silently; marker-based dismissal fixes
// that. A baseline reset re-arms the banner automatically. (2026-07-14)
const reviewDone = existsSync(NOTES_PATH) &&
  readFileSync(NOTES_PATH, 'utf8').includes(`<!-- sprint-review-done baseline=${BASELINE_MS} -->`);
if (post.n >= 15 && !reviewDone) {
```

Also update the banner's instruction line (old line 136) from:

```javascript
  lines.push('> findings to `audit-batch-notes.md`, then ping Joseph. Check specifically:');
```

to:

```javascript
  lines.push('> findings to `audit-batch-notes.md`, append `<!-- sprint-review-done baseline=' + BASELINE_MS + ' -->`');
  lines.push('> once decided (leave it off to keep this banner for a follow-up), then ping Joseph. Check:');
```

- [ ] **Step 2: Verify against a fixture (scratchpad, not repo)**

Build a minimal fixture DB + notes in the scratchpad (`node fixture.mjs` from repo root so `better-sqlite3` resolves):

```javascript
// fixture.mjs — build throwaway db with 20 post-baseline closed trades
import Database from 'better-sqlite3';
const db = new Database(process.env.SCRATCH + '/t.db');
db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO settings VALUES('stats_baseline_time','1000');
CREATE TABLE v2_trades(id TEXT, ticker TEXT, strategy TEXT, side TEXT, timeframe TEXT,
 status TEXT, entry_time INTEGER, exit_time INTEGER, exit_reason TEXT,
 pnl_net REAL, pnl_gross REAL, fees_paid REAL, position_size_usd REAL, atr_percent REAL,
 entry_price REAL, hold_duration_ms INTEGER);
CREATE TABLE v2_pairs_state(loop_at INTEGER);`);
const ins = db.prepare(`INSERT INTO v2_trades VALUES(?, 'AKTUSD','TREND','long','4h','closed',2000,3000,'trailing',1,1.2,0.2,100,1,1,3600000)`);
for (let i = 0; i < 20; i++) ins.run(String(i));
console.log('fixture ready');
```

Then three runs of the report script (set `SCRATCH` to the scratchpad path first):

```bash
AUDIT_DB_PATH=$SCRATCH/t.db AUDIT_NOTES_PATH=$SCRATCH/notes.md AUDIT_REPORT_PATH=$SCRATCH/out.md node scripts/generate-audit-report.mjs && grep -c "ACTION FOR VPS CLAUDE" $SCRATCH/out.md
# expected: 1  (n=20, no marker -> banner)
echo '<!-- sprint-review-done baseline=1000 -->' > $SCRATCH/notes.md
AUDIT_DB_PATH=$SCRATCH/t.db AUDIT_NOTES_PATH=$SCRATCH/notes.md AUDIT_REPORT_PATH=$SCRATCH/out.md node scripts/generate-audit-report.mjs && grep -c "ACTION FOR VPS CLAUDE" $SCRATCH/out.md
# expected: 0  (marker for current baseline -> dismissed)
echo '<!-- sprint-review-done baseline=999 -->' > $SCRATCH/notes.md
AUDIT_DB_PATH=$SCRATCH/t.db AUDIT_NOTES_PATH=$SCRATCH/notes.md AUDIT_REPORT_PATH=$SCRATCH/out.md node scripts/generate-audit-report.mjs && grep -c "ACTION FOR VPS CLAUDE" $SCRATCH/out.md
# expected: 1  (stale marker from an OLD baseline -> re-armed)
```

If the script needs columns the fixture lacks, extend the fixture — do not weaken the script.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-audit-report.mjs
git commit -m "fix(report): sprint-review reminder dismisses by marker, not 30-trade expiry"
```

---

### Task 5: Changelog, deploy, baseline reset, arm monitoring

**Files:**
- Modify: `CHANGELOG.md` (new top entry)
- VPS (via ssh): `settings.stats_baseline_time`

**Interfaces:**
- Consumes: all prior commits on `master`; the standing rules in `CLAUDE.md` (Project Reference part).
- Produces: deployed engine running the new config; new `stats_baseline_time`; changelog entry other agents read.

- [ ] **Step 1: Write the CHANGELOG entry (template at top of CHANGELOG.md)**

Entry must include: all task commit SHAs; `Stats baseline reset: yes — new baseline = <epoch ms>` (fill after Step 3); what changed (shorts off, 1h decision + which branch, reminder fix); why (numbers from the review doc — cite `docs/reviews/2026-07-14-sprint-review.md`); monitoring criteria: (a) expectancy of the new cohort > +$0.25 at the next 15-trade review, (b) zero `side='short'` TREND entries post-deploy, (c) if branch B: zero `timeframe='1h'` TREND entries post-deploy; if branch A: 1h time_kill count should drop vs prior cohort, (d) rollback = `git revert <task SHA>` + `bash scripts/push-deploy.sh`. Commit:

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 2026-07-14 profitability sprint — shorts off, 1h decision, reminder fix"
```

- [ ] **Step 2: Deploy**

```bash
bash scripts/push-deploy.sh master
```

Expected: both pushes succeed, `[push-deploy] OK — deployed SHA matches: <sha>`.

- [ ] **Step 3: Reset the stats baseline (the batch's ONE reset) and record it**

```bash
ssh root@31.97.7.138 'sqlite3 /opt/trading-bot/data/trading.db "INSERT OR REPLACE INTO settings (key, value) VALUES (CHAR(115,116,97,116,115,95,98,97,115,101,108,105,110,101,95,116,105,109,101), CAST(strftime(CHAR(37,115),CHAR(110,111,119))*1000 AS INTEGER));" && sqlite3 /opt/trading-bot/data/trading.db "SELECT value FROM settings WHERE key LIKE (CHAR(37)||CHAR(98,97,115,101,108,105,110,101)||CHAR(37));"'
```

(If the CHAR() quoting workaround is unnecessary in your shell, the plain form is `INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_baseline_time', $(date -u +%s%3N));` run inside the ssh session — use whichever executes cleanly, and verify the SELECT echoes a fresh epoch-ms value.)
Then update the CHANGELOG entry's baseline number with the actual value, amend? NO — standing rule prefers new commits: make a one-line follow-up edit to the entry and include it in a `docs(changelog): record baseline <ms>` commit, then `bash scripts/push-deploy.sh master` again (or fill the number in Step 1 by resetting the baseline FIRST if the deploy window is quiet — either order is acceptable; just ensure the entry ends up with the real number and both remotes have it).

- [ ] **Step 4: Post-deploy verification**

```bash
ssh root@31.97.7.138 'cd /opt/trading-bot && node -e "import(\"./v2/engine/config.ts\").catch(()=>0)" 2>/dev/null; pm2 list | grep canuck-node; tail -20 logs/deploy.log 2>/dev/null'
```

Minimum bar: pm2 shows `canuck-node` online; then confirm behavior over the next loop cycles:

```bash
ssh root@31.97.7.138 'pm2 logs canuck-node --lines 100 --nostream | grep -iE "short|1h" | head -20'
```

Expected: no new short signal generation; if branch B, no 1h TREND scans. Also re-run the hourly report once (`ssh root@31.97.7.138 'cd /opt/trading-bot && node scripts/generate-audit-report.mjs'`) and confirm the banner is ABSENT (n=0 on the new baseline) and the report header shows the new baseline.

- [ ] **Step 5: Confirm open pre-baseline positions are untouched**

```bash
ssh root@31.97.7.138 'sqlite3 -column /opt/trading-bot/data/trading.db "SELECT id, ticker, side, strategy, timeframe FROM v2_trades WHERE status = (SELECT CHAR(111,112,101,110));"'
```

Any open positions keep running on their original config (standing rule) — do NOT force-close them; note them in the changelog entry as in-flight legacy if any exist.

---

## Self-review notes (completed at plan-writing time)

- Spec coverage: diagnostics 1–8 → Task 1; shorts rule → Task 2; 1h rule (both branches + 2× bound + 4h isolation) → Task 3; gatekeeper rule → Task 1 Step 1 (expected `defer`, no code task by design — if it decides `remove`, that is a flagged-not-shipped item for the next batch per the kitchen-sink guard, EXCEPT the spec pre-registers it as in-scope: in that case add a Task 3.5 setting `GATEKEEPER_AB_TEST: false` and disabling the gatekeeper call site — locate via `grep -rn "gatekeeper" v2 --include="*.ts" | grep -iv log` — and treat it as one commit. With 5 samples as of planning, this path is near-certain not to trigger.)
- Reminder fix → Task 4; baseline/changelog/deploy → Task 5. Monitoring section of spec → Task 5 Steps 4–5 + changelog criteria.
- Type consistency: `timeKillBarsByTf` name used identically in interface (Task 3 A1), config (A2), and exitManager (A3). Marker string identical in Task 1 Step 6 and Task 4 (`<!-- sprint-review-done baseline=<ms> -->`).
- The spec's "committed as audit-batch-notes.md (repo root)" was amended 2026-07-14 to the dual write (VPS notes append + `docs/reviews/` repo copy) — matching what Task 1 does.
