# Sprint Re-Review — 2026-07-14 (baseline 1782834161576, n=38)

Follow-up to VPS Claude's 2026-07-05 review at n=15 (verdict then: −$1.30/trade,
"no config change"). Trades 16–38 ran ≈ +$0.91/trade (net +$21.00/23) — the cohort
verdict changed with sample size — n=15 was a losing streak inside a cohort that,
at n=38, nets slightly positive (+$1.56, avg +$0.041/trade). This review supersedes
the 2026-07-05 verdict for the overall-expectancy question, but the underlying
segment-level problems the 2026-07-05 review didn't have the data to see (shorts,
1h TREND, gate leakage) are now visible and drive the DECISIONS below.

## Pre-registered checks

| # | Check | Result | Pass |
|---|---|---|---|
| 1 | Risk cap (worst loss ≥ −$15) | Worst = TAOUSD MOMENTUM 1h −$8.28; #2 TAOUSD TREND 4h −$7.32; #3 ZECUSD TREND 4h −$6.00 | ✓ PASS |
| 2 | Expectancy vs +$0.25 baseline | n=38, avg **+$0.041**, sum **+$1.56** | ✗ FAIL (below +$0.25 target, though positive — see trajectory below) |
| 2b | Trajectory: trades 1–15 vs 16–38 | 1–15: n=15, sum −$19.44, avg −$1.296 (matches 2026-07-05 review). 16–38: n=23, sum **+$21.00**, avg **+$0.913** | Trajectory reversed — later trades are strongly positive |
| 3 | Regime gates (MOMENTUM must be STRONG_UP; shorts must be STRONG_DOWN) | **1 violation**: TAOUSD MEAN_REVERSION short, entry_regime=SIDEWAYS, id `6b10c397-2409-4697-a1b5-c9fefa07f068`, pnl −$4.22, entry 2026-07-08 | ✗ FAIL (expected 0 rows) |
| 4 | Time gate (block UTC hours 0–7, 13, 20) | **3 violations**, all in hour 0–1 UTC: GROVE_USD ×2 (2026-07-11 01:41, 2026-07-12 01:47), TAOUSD (2026-07-12 00:00) | ✗ FAIL (expected 0 rows) |
| 5 | Gatekeeper A/B | PROCEED: n=537, 49% win. PROCEED_AB: n=5, 60% win | INSUFFICIENT — PROCEED_AB n=5 is far below the n≥30 threshold for a decision |

**Notes on failures:**
- **Check 2 (expectancy):** technically fails the +$0.25/trade target at the whole-cohort level (+$0.041), but this is driven entirely by the trades 1–15 losing streak that the 2026-07-05 review already reviewed and attributed to signal quality, not new config. Trades 16–38 alone (+$0.913/trade) clear the target by a wide margin. Treat the whole-cohort average as stale — it's mixing pre- and post-improvement behavior within the same baseline window.
- **Check 3 (regime gate leak):** the regime gate query in the brief only catches MOMENTUM and side=short cases; it caught a **MEAN_REVERSION short entering during SIDEWAYS regime** — i.e., MEAN_REVERSION shorts are not constrained to STRONG_DOWN the way TREND/other shorts are. This is a real gate gap, not a query artifact. Flagged below (not shipped — out of scope for Task 1, feeds Task 2's shorts decision as one more data point against shorts generally).
- **Check 4 (time gate leak):** the time-gate feature (commit `afeecc4`, 2026-06-30) predates all three violating trades (2026-07-11/12) by ~2 weeks, and the baseline (2026-06-30 15:42 UTC) also predates them — so this isn't stale pre-deploy data, it's a live gate failing to block some entries in hours 0–1 UTC. Root cause not investigated here (out of scope — analysis only). Flagged below.

## Segment analyses

### Shorts viability

**All-time, by timeframe/regime** (every cell, unfiltered by strategy or baseline):

| Timeframe | Regime | n | Net | Avg |
|---|---|---|---|---|
| 30m | DOWN | 5 | −$18.33 | −$3.666 |
| 4h | STRONG_DOWN | 8 | −$14.19 | −$1.774 |
| 1h | DOWN | 9 | −$9.11 | −$1.013 |
| 1h | STRONG_DOWN | 2 | −$6.61 | −$3.305 |
| 4h | DOWN | 13 | −$6.21 | −$0.478 |

Every cell is negative. The largest sample (4h/DOWN, n=13) is still net negative. No cell has n≥10 with a materially positive net — the "keep" exception condition from the brief is not met.

**Post-baseline shorts** (n=38 cohort, entry_time ≥ 1782834161576):

| Strategy | Timeframe | n | Net |
|---|---|---|---|
| MEAN_REVERSION | (none) | 1 | −$4.22 |
| TREND | 4h | 4 | −$17.99 |

TREND short 4h is the single worst segment in the entire post-baseline cohort (−$4.50/trade avg, matches the pre-registered reference number). Combined with the all-time table and the Check 3 regime-gate leak above (a MEAN_REVERSION short fired outside STRONG_DOWN), shorts show no viable segment at any sample size worth acting on.

**Decision rule applied:** no cell has n≥10 AND materially positive net ⇒ **SHORTS: disable**.

### 1h TREND time_kill recoverability

Post-baseline 1h TREND long trades that exited via `time_kill` (n=5, ≥3 so the thin-sample default does not apply). Activation price = entry × 1.014 (`trailActivatePercent`); window = (entry_time, entry_time+4h] = 4 one-hour candles (2× current `timeKillBars: 2`).

`candle_history` on the VPS only covers up to 2026-04 (`MAX(time)=1775746800000`) — it does not reach the post-baseline window for either ticker involved (ZECUSD isn't in the table at all; TAOUSD's rows stop months before baseline). Used the Kraken REST fallback (`OHLC?pair=<TICKER>&interval=60&since=<entry_epoch_s>`) for all 5 trades, checking the high of the first 4 hourly candles after entry.

| id | ticker | entry | activation (×1.014) | max high, first 4×1h candles | recoverable | pnl_net |
|---|---|---|---|---|---|---|
| `4c00712c` | ZECUSD | 422.38 | 428.30 | 456.13 (candle 2 high 429.35 already clears it) | **YES** | −$0.37 |
| `af2d485f` | TAOUSD | 211.7982 | 214.76 | 211.38 | **NO** | −$3.24 |
| `92f1be8a` | TAOUSD | 209.7241 | 212.66 | 214.10 (candle 4) | **YES** | −$2.98 |
| `2035a501` | ZECUSD | 457.57 | 464.08 | 468.13 (candle 3 high 464.53 clears it) | **YES** | +$0.70 |
| `e61bffbc` | ZECUSD | 537.67 | 545.20 | 541.49 | **NO** | −$3.00 |

Recoverable: 3/5 = **60%**, exactly at the ≥0.6 decision threshold. This is a borderline result on a small sample (n=5) — the margin is one trade either way, and none of the "recoverable" trades activate on the first candle (candles 2, 3, and 4 respectively), meaning even a successful extension would still hold the position most of the way through the new 4-bar window before triggering the trail.

**Decision rule applied:** recoverable_count/total = 0.6 ≥ 0.6 ⇒ **1H_TREND: extend-timekill-to-4-bars**. Flagged as a low-confidence call given n=5 and the exact-threshold margin — Task 3 and future monitoring should treat this as provisional and revisit once more 1h TREND time_kill trades accumulate.

**Backtest caveat for the revisit:** the multi-strategy backtest uses its own exit params (`v2/backtest/multiStrategy/strategyRegistry.ts`, TREND `timeKillBars: 2`) and does NOT read `STRATEGY_EXIT_CONFIGS.timeKillBarsByTf` — a backtest run to re-validate this decision will silently model the OLD 2-bar kill on 1h unless its registry is updated to match. Compare live-vs-live cohorts, or port the override into the backtest registry first.

Context: 1h TREND long overall is flat-to-negative post-baseline (n=14, −$2.17, −$0.155/trade) versus 4h TREND long (n=14, +$22.92, +$1.637/trade) and 4h TREND short (n=4, −$17.99, −$4.498/trade — see shorts section). The recoverability data suggests part of the 1h drag is trades getting timed out just before they would have cleared the trail-activation threshold, which is what the extend decision is meant to address.

### Per-ticker

| Ticker | n | Net | Avg |
|---|---|---|---|
| TAOUSD | 11 | −$36.18 | −$3.29 |
| PENGUUSD | 2 | −$1.85 | −$0.923 |
| ZECUSD | 23 | +$37.92 | +$1.649 |
| GROVE_USD | 2 | +$1.67 | +$0.836 |

ZECUSD is carrying the entire cohort (+$37.92 across 23 trades — larger than the cohort's net +$1.56 by itself, meaning every other ticker combined is net negative). TAOUSD is the single biggest drag at −$36.18/11 trades (−$3.29/trade), roughly offsetting ZECUSD's gains almost 1:1. See "Flagged, not shipped" below — this is documentation only per the kitchen-sink guard, no config change in this task.

## DECISIONS
SHORTS: disable
1H_TREND: extend-timekill-to-4-bars
GATEKEEPER: defer

## Flagged, not shipped

- **TAOUSD single-ticker drag**: −$36.18 net across 11 trades (−$3.29/trade), the worst per-ticker segment in the cohort, driven by a mix of MOMENTUM (worst single loss, −$8.28), TREND 4h (−$7.32), and other strategies. Not broken out by strategy here; worth a dedicated ticker-level review before considering a TAOUSD-specific gate, since disabling a whole ticker is a bigger structural change than this sprint's scope.
- **Regime-gate leak (Check 3)**: MEAN_REVERSION shorts are not constrained to STRONG_DOWN regime the way the pre-registered check assumes all shorts are. One instance found (TAOUSD MEAN_REVERSION short, SIDEWAYS regime, −$4.22). Since `SHORTS: disable` is the decision this task is producing anyway, this gap becomes moot if Task 2 disables shorts cohort-wide — but if any short path is ever re-enabled, the regime gate needs to cover MEAN_REVERSION explicitly, not just TREND/MOMENTUM.
- **Time-gate leak (Check 4)**: 3 trades entered during nominally-blocked hours 0–1 UTC (GROVE_USD ×2, TAOUSD ×1), all well after the timegate feature (`afeecc4`, 2026-06-30) and the baseline reset. The gate is not fully blocking hour 0 and hour 1 entries for at least these two tickers/strategies. Root cause not investigated (out of scope for this analysis-only task) — recommend a follow-up bug investigation, since a leaking time gate undermines the edge basis for that feature.
- **Gatekeeper (Check 5)**: PROCEED_AB n=5 is far too small to act on (60% win looks good but is 3W/2L). Standard PROCEED path sits at 537 decisions / 49% win — statistically indistinguishable from a coin flip, consistent with the 2026-07-05 review's finding that the gatekeeper adds no measurable value. Per the brief's stated rule (PROCEED_AB n<30 ⇒ defer), this task defers rather than recommending removal outright — Task numbering in this sprint doesn't include a gatekeeper-removal step, so `defer` means "no action this sprint, revisit once PROCEED_AB accumulates more samples," not an endorsement of keeping it indefinitely.
