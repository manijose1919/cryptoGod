# Analysis — ATR floor & shorts viability — 2026-07-23 (local-claude)

Triggered by an operational question: the bot had taken **zero entries for ~2 days**
(last TREND entry 2026-07-21 23:47:57 UTC) after the 2026-07-21 overhaul raised
`MIN_ATR_PERCENT` from 0.3 → 1.0. The 2026-07-21 changelog entry pre-registered
0.8% as the candidate relaxation "if too restrictive in low-vol markets".

**Both questions resolved as NO-CHANGE.** The ATR floor is not the binding
constraint, and the shorts edge that looked re-enable-worthy has decayed.

---

## Q1: Is the ATR ≥ 1.0% floor costing trades?

**No. It has rejected exactly zero scans.** Every scan is rejected earlier, at the
regime gate.

Live engine evidence (`/api/v2/status`, recent `logs/output.log`):

| Rejection reason | Count in recent log window |
|---|---|
| `not in allowed` (regime gate) | **396** |
| ATR-related | **0** |

Regime readings observed across recent scans:

| Regime | Count | In `ALLOWED_REGIMES: ['STRONG_UP','UP']`? |
|---|---|---|
| DOWN | 310 | ✗ |
| SIDEWAYS | 159 | ✗ |
| STRONG_DOWN | 122 | ✗ |
| STRONG_UP / UP | **0** | ✓ |

591 regime readings, none in the allowed set. `SHORTS_ENABLED: false`, so the
STRONG_DOWN tickers produce nothing either. **The drought is a long-only strategy
correctly standing aside in a bearish tape — not an over-tight filter.**

### Would relaxing to 0.8% help? No — it would lose money.

TREND closed trades by ATR band (all-time, `v2_trades.atr_percent`):

| ATR band | n | WR | Net PnL | Avg/trade |
|---|---|---|---|---|
| <0.6% | 1 | 0% | −$3.37 | −$3.37 |
| 0.6–0.8% | 2 | 0% | −$2.32 | −$1.16 |
| **0.8–1.0%** (what 0.8 re-admits) | **10** | **30.0%** | **−$17.02** | **−$1.70** |
| 1.0–1.5% | 49 | 53.1% | −$1.27 | −$0.03 |
| 1.5–2.0% | 55 | 54.5% | −$0.58 | −$0.01 |
| **2.0–3.0%** | **90** | **64.4%** | **+$77.47** | **+$0.86** |
| 3%+ | 82 | 68.3% | +$11.84 | +$0.14 |
| unknown (pre-column) | 95 | 45.3% | −$56.58 | −$0.60 |

The 1.0% floor is well-placed. Dropping to 0.8% re-admits the worst populated
band in the dataset.

### Secondary finding: the profit lives in ATR 2–3%, not 1–2%

Win rate rises monotonically with ATR, but **net PnL does not follow win rate**.
The 1.0–2.0% bands win >53% of the time and still make nothing (−$1.85 combined
over 104 trades) — fees consume a >50% win rate when the moves are small.

| Floor | Trades | Net PnL | Per trade |
|---|---|---|---|
| 1.0% (current) | 276 | +$87.46 | +$0.32 |
| **2.0%** | **172** | **+$89.31** | **+$0.52** |

Raising to 2.0% cuts 38% of trades while slightly increasing net profit — less
capital tied up, less fee drag, lower variance, ~60% better per-trade edge.

**Not shipped.** With zero trades currently flowing, this would be an unobservable
change. Queue it for when the regime turns and trades resume, then evaluate on
live post-change data. Caveat: bands are pooled across config eras; the 1.0–2.0%
result is ~breakeven rather than strongly negative, so the gain is efficiency and
variance reduction more than absolute $.

---

## Q2: Re-enable shorts for STRONG_DOWN only?

**No. The edge decayed and reversed sign two months ago.**

`config.ts:87` notes STRONG_DOWN shorts at 74% WR / +$36 vs plain DOWN at 65% / −$42,
which is why STRONG_DOWN-only looked like a salvageable sub-segment after the
2026-07-14 blanket disable. The regime split does hold on aggregate:

| Entry regime | n | WR | Net PnL | Avg/trade |
|---|---|---|---|---|
| **STRONG_DOWN** | 27 | 66.7% | **+$18.35** | +$0.68 |
| DOWN | 52 | 65.4% | −$41.95 | −$0.81 |
| SIDEWAYS | 1 | 0% | −$4.22 | −$4.22 |

**But the aggregate hides a complete regime change within STRONG_DOWN:**

| STRONG_DOWN shorts | Period | n | WR | Net PnL | Avg/trade |
|---|---|---|---|---|---|
| Older (`timeframe` NULL) | 2026-05-23 → 2026-06-04 | 17 | **82.4%** | **+$39.15** | +$2.30 |
| Recent (`timeframe` tagged) | 2026-06-11 → 2026-07-14 | 10 | **40.0%** | **−$20.80** | −$2.08 |

The entire +$18.35 comes from a ~2-week window in late May / early June. **Every
STRONG_DOWN short since 2026-06-11 is net negative.**

All shorts by month confirms monotonic decay:

| Month | n | WR | Net PnL |
|---|---|---|---|
| 2026-05 | 16 | 62.5% | +$5.26 |
| 2026-06 | 59 | 69.5% | −$10.87 |
| 2026-07 | 5 | 20.0% | −$22.22 |

Note 2026-06: **69.5% WR and still −$10.87.** Small winners, large losers. The
recent STRONG_DOWN losses are predominantly `trailing` exits giving back open
profit (−$5.96, −$5.90, −$6.52, −$4.95), plus one −$16.73 `stop_loss`.

**If shorts are ever revisited, the trailing-stop giveback is the thing to fix
first — not the regime selection.** Regime selection is already correct; the exit
logic is where the recent money went.

---

## DECISIONS

| # | Decision | Rationale |
|---|---|---|
| 1 | **Keep `MIN_ATR_PERCENT: 1.0`.** Do NOT relax to 0.8. | 0.8–1.0% band is 30% WR / −$1.70 per trade. Floor rejects 0 scans today anyway. |
| 2 | **Keep `SHORTS_ENABLED: false`.** Do NOT re-enable STRONG_DOWN-only. | Edge is stale by ~2 months; recent 10 STRONG_DOWN shorts are 40% WR / −$20.80. |
| 3 | **No stats-baseline reset.** | No trading-config change shipped by this analysis. |

## Flagged, not shipped

- **Raise `MIN_ATR_PERCENT` to ~2.0%** once trades resume (see Q1 secondary finding).
  Revisit when post-baseline n ≥ 20 so the change is observable.
- **Shorts trailing-stop giveback.** Recurring pattern of `trailing` exits
  surrendering open profit. Would need its own review before shorts are
  reconsidered at all.
- **`SCAN_TICKERS` are all high-beta alts** (AKT, ZEC, FET, PENGU, TAO, PENDLE),
  so they are heavily correlated and tend to share a regime. When the tape is
  bearish, all six gate out simultaneously — the effective diversification against
  a regime-gated long-only strategy is near zero. Worth considering whether the
  ticker set should include something less correlated, so the bot isn't strictly
  all-or-nothing on market direction.

## Reproducing

All figures from `/opt/trading-bot/data/trading.db` and the live `/api/v2/status`.

```sql
-- ATR bands (Q1)
SELECT CASE WHEN atr_percent IS NULL THEN 'unknown'
            WHEN atr_percent < 0.6 THEN '<0.6%'
            WHEN atr_percent < 0.8 THEN '0.6-0.8%'
            WHEN atr_percent < 1.0 THEN '0.8-1.0%'
            WHEN atr_percent < 1.5 THEN '1.0-1.5%'
            WHEN atr_percent < 2.0 THEN '1.5-2.0%'
            WHEN atr_percent < 3.0 THEN '2.0-3.0%'
            ELSE '3%+' END AS band,
       COUNT(*) n,
       ROUND(100.0*SUM(CASE WHEN pnl_net>0 THEN 1 ELSE 0 END)/COUNT(*),1) wr,
       ROUND(SUM(pnl_net),2) net
FROM v2_trades WHERE status='closed' AND strategy='TREND' GROUP BY band;

-- Shorts era split (Q2)
SELECT CASE WHEN timeframe IS NULL THEN 'older' ELSE 'recent' END grp,
       COUNT(*) n,
       ROUND(100.0*SUM(CASE WHEN pnl_net>0 THEN 1 ELSE 0 END)/COUNT(*),1) wr,
       ROUND(SUM(pnl_net),2) net,
       date(MIN(entry_time)/1000,'unixepoch') first, date(MAX(entry_time)/1000,'unixepoch') last
FROM v2_trades WHERE status='closed' AND side='short' AND entry_regime='STRONG_DOWN'
GROUP BY grp;
```

Live rejection reasons: `curl -s localhost:3033/api/v2/status | python3 -m json.tool`
(`lastScanReasons`, `htfRegimes`), and
`tail -2000 logs/output.log | grep -oE 'not in allowed' | wc -l`.
