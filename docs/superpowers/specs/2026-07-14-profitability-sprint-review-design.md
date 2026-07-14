# Profitability Sprint Review & Batched Change Set — Design

**Date:** 2026-07-14
**Author:** local-claude + Joseph
**Status:** Approved (design approved in session 2026-07-14; spec pending user review)

## Context

The 2026-06-30 R:R + edge sprint shipped with a self-triggering review reminder
(commit `840dc72`) that fires in the hourly audit report at 15–30 post-baseline
closed trades. **Correction (2026-07-14, supersedes the earlier draft of this
section):** the review DID run — VPS Claude wrote it to
`data/reports/audit-batch-notes.md` on 2026-07-05 at exactly 15 trades, verdict:
expectancy −$1.30/trade (FAIL), "no config change recommended — signal quality,
not configuration." The cohort has since grown to 38 trades and swung to +$1.56
total: trades 16–38 made ≈ +$0.91/trade, at/above the backtest target. The
July 5 "wait" verdict was never revisited because the reminder window closed at
30 trades — a one-shot window can't request a follow-up look. That is the actual
reminder defect this sprint fixes (not a missed review).

Live cohort since baseline `1782834161576` (38 closed trades, as of 2026-07-14):

| Segment | Trades | Net PnL | Win rate |
|---|---|---|---|
| TREND long 4h | 14 | +$22.92 | 71% |
| TREND long 1h | 14 | −$2.17 | 57% |
| TREND short 4h | 4 | −$17.99 | 25% |
| Other (MR, MOMENTUM, SNIPER) | 6 | −$1.20 | — |
| **Total** | **38** | **+$1.56 (+$0.04/trade)** | 57.9% |

All-time timeframed shorts: −$54.45 over 37 trades, negative on every timeframe
(1h −$15.72/11, 30m −$18.33/5, 4h −$20.40/21). Exit-reason breakdown since
baseline: trailing +$24.00/27, stop_loss −$13.93/4, time_kill −$8.52/7 — with 5
of the 7 time_kills concentrated in TREND long 1h (−$8.89).

## Goal & success criteria

Lift live per-trade expectancy from +$0.04 toward the backtest-implied
+$0.50–0.60 by cutting proven-negative segments and tuning exits.

Deliverables:
1. Written sprint review: appended to `data/reports/audit-batch-notes.md` on
   the VPS (the runtime notes path the hourly report embeds) and committed to
   the repo as `docs/reviews/2026-07-14-sprint-review.md`.
2. One batched config change set (one logical change per commit).
3. A single new `stats_baseline_time` after the change set deploys.
4. CHANGELOG.md entry per the standing rule.
5. Reminder fix so an unactioned review keeps nagging instead of going silent.

Success threshold (pre-stated): expectancy meaningfully above the +$0.25
pre-sprint baseline at the next 15–30-trade review. If the surviving book
(expected: 4h-long-heavy) can't clear that, the next sprint targets **entries**,
not exits.

## Diagnostics to run (the review)

The five pre-registered checks from the `840dc72` reminder:

1. **$12 risk cap** — no single closed trade should lose more than ~$15 net.
   Query the worst post-baseline loss.
2. **Per-trade expectancy** — compare avg `pnl_net`/trade vs the +$0.25
   pre-sprint baseline and the ~+$0.5–0.6 backtest expectation.
3. **Regime gates** — confirm no MOMENTUM entries outside STRONG_UP and no
   shorts outside STRONG_DOWN in the post-baseline cohort.
4. **Time gate** — confirm no post-baseline entries in 0–7, 13, or 20 UTC.
5. **Gatekeeper A/B** — if ≥30 PROCEED_AB samples with outcomes exist:
   `SELECT decision, COUNT(*), ROUND(100.0*AVG(was_correct),0) win_pct FROM
   ml_gatekeeper_log WHERE actual_outcome IS NOT NULL AND decision LIKE
   'PROCEED%' GROUP BY decision;`
   If PROCEED_AB (would-block) win% ≥ PROCEED win%, the gatekeeper adds no
   value and is removed. If <30 samples, defer with no change.

Added segment analyses:

6. **Shorts viability** — all-time and post-baseline, by timeframe and regime,
   to confirm or contradict the −$54/37 record before disabling.
7. **1h TREND long / time_kill recoverability** — for each post-baseline
   time_kill exit, use `candle_history`/`historical_candles` to determine
   whether price subsequently reached the trailing-activation level within
   2× the kill window (i.e., were kills premature or merciful?).
8. **Per-ticker breakdown** — post-baseline PnL by ticker to spot any
   single-ticker drag.

## Pre-registered decision rules

Written before running diagnostics 6–8, so results can't be rationalized
post-hoc:

- **Shorts:** disable TREND shorts entirely unless diagnostic 6 shows a
  materially profitable sub-segment with n ≥ 10 (not expected).
- **1h TREND longs:** if diagnostic 7 shows killed trades were mostly
  recoverable (≥60% reached trailing activation), extend the 1h time_kill
  window to the duration that would have captured those recoveries (bounded
  at 2× the current window) and keep 1h. Otherwise disable 1h TREND entries
  and concentrate on 4h.
- **Gatekeeper:** strictly by rule 5 above.
- **Anything else discovered:** flagged in the review, NOT shipped in this
  change set (kitchen-sink guard). Next sprint.

## Change-set mechanics

- Config-only edits in the V2 pipeline (strategy enables, timeframe lists,
  time_kill timers) — one logical change per commit.
- Reminder fix in `scripts/generate-audit-report.mjs`: replace the hard
  15–30 window with marker-based dismissal — fires from 15 trades until the
  notes file contains `<!-- sprint-review-done baseline=<BASELINE_MS> -->`,
  which the reviewer appends when the review for that baseline is complete.
  A review can't be silently skipped, and a "wait for more data" verdict
  keeps the banner alive (append the marker only when done deciding).
- Deploy via `bash scripts/push-deploy.sh` (both remotes, SHA verified).
- After deploy: single `stats_baseline_time` reset on the VPS (per standing
  rule — one reset for the whole batch). Open pre-baseline positions keep
  running on their original config.
- CHANGELOG.md entry with commits, reasoning, and monitoring criteria.
- Review findings committed as `audit-batch-notes.md`.

## Monitoring

- The fixed reminder re-arms against the new baseline and fires at 15 trades.
- Watch: expectancy vs +$0.25; worst-loss vs the $12 cap; that no shorts or
  disabled-timeframe entries appear post-deploy.
- Rollback: each change is one commit — `git revert <SHA>` + push-deploy;
  baseline handling per the standing rule (roll back to prior baseline if
  very few post-baseline trades).

## Out of scope

- Architecture overhaul (server.js split, tests) — separate track.
- ML gatekeeper improvements beyond the keep/remove A/B decision.
- New tickers, exchanges, or strategies.
