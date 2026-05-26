# FIL/ICP Expected-Behavior Backtest
Generated: 2026-05-26T18:01:35.848Z

Parameters match the LIVE engine config verbatim. Use this report to set
expectations for what you should see during Phase A paper-mode.

- Pair: FILUSD / ICPUSD
- Entry: |z| ≥ 1.5
- Exit: |z| < 0.3
- Stop: |z| > 4
- Time stop: 200 bars (≈ 8.3 days on 1h)
- β re-estimate: every 120 bars
- Rolling window: 720 bars (≈ 30 days)
- Notional: $1000 total ($500/leg)

## Cointegration stats per window

| Window | β | α | R² | ADF t-stat | Halflife (bars) | Stationary? |
|---|---:|---:|---:|---:|---:|:---:|
| 30d | 0.633 | -0.625 | 0.934 | -5.63 | 8.1 | ✓ 5% ✓ 1% |
| 60d | 0.787 | -0.794 | 0.878 | -4.28 | 27.0 | ✓ 5% ✓ 1% |
| 90d | 0.717 | -0.726 | 0.677 | -4.71 | 44.7 | ✓ 5% ✓ 1% |

## Performance — taker vs maker, by window

| Window | Fees | Trades | WR % | PF | Net % | Net $ | Max DD % | Avg hold (bars) | Avg hold (hrs) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 30d | taker | 7 | 85.7 | 17.27 | 25.06 | $250.64 | 1.54 | 53.7 | 53.7 |
| 30d | maker | 7 | 85.7 | 23.53 | 27.72 | $277.18 | 1.23 | 53.7 | 53.7 |
| 60d | taker | 9 | 66.7 | 6.22 | 21.22 | $212.19 | 4.07 | 90.7 | 90.7 |
| 60d | maker | 9 | 66.7 | 8.78 | 24.57 | $245.72 | 3.16 | 90.7 | 90.7 |
| 90d | taker | 28 | 50.0 | 1.89 | 19.87 | $198.68 | 14.70 | 37.3 | 37.3 |
| 90d | maker | 28 | 50.0 | 2.65 | 30.65 | $306.53 | 10.32 | 37.3 | 37.3 |

## What to expect during Phase A (paper mode, taker fees)

Per-window cadence projection — what 30 days of live trading should look like under similar conditions:

| Source window | Trades / window | Expected trades / 7d | Expected trades / 30d | Avg per-trade net | Projected 30d net |
|---|---:|---:|---:|---:|---:|
| 30d | 7 | 1.6 | 7.0 | $35.81 | $250.64 |
| 60d | 9 | 1.1 | 4.5 | $23.58 | $106.10 |
| 90d | 28 | 2.2 | 9.3 | $7.10 | $66.23 |

**Read these projections with skepticism.** They assume the next 30 days behave like the source window. ADF stationarity does NOT guarantee future stationarity.

## Phase A success criteria (from deployment plan)

Will these be plausibly met if the next 30d looks like the historical 30d?

| Criterion | Threshold | 30d backtest result | Pass? |
|---|---|---|:---:|
| ≥ 3 signals fired | ≥ 3 | 7 | ✓ |
| Paper net PnL ≥ +1% | ≥ +1.0% | 25.06% | ✓ |
| ADF < -2.86 throughout | t < -2.86 | (engine will alert if breached) | n/a |
| No |z| > 5 events | max |z| < 5 | (engine has stop_z at 4σ) | n/a |
| Avg hold ≤ 100 bars | ≤ 100 | 53.7 | ✓ |

## Taker → Maker uplift

Per Phase B deployment plan, live trading targets maker rebates (-0.05%/leg/side).
Same trade sequence, different fee model:

| Window | Taker net | Maker net | Maker uplift |
|---|---:|---:|---:|
| 30d | 25.06% | 27.72% | +2.65% |
| 60d | 21.22% | 24.57% | +3.35% |
| 90d | 19.87% | 30.65% | +10.79% |

## Caveats

- **Lookahead-free backtest.** Each bar uses only prior data for cointegration; entries fill on next bar's open with slippage.
- **Cointegration regimes are not guaranteed to persist.** A pair that mean-reverted with ADF=-5 over the last 90d can break in the next 30d. The walk-forward validation in the original study showed this pair survived OOS, but no guarantee for the future.
- **Margin trading required for live shorts.** Paper mode simulates the short leg; live mode needs margin trading enabled on FIL/USD and ICP/USD (verified by Kraken API; UI confirmation pending).
- **Per-trade economics are sensitive to fees.** Paper-mode taker fees absorb ~1% per round-trip (4 sides × 0.26%). A pair-trade needs > 1% gross edge to be net positive on taker; maker rebates flip this to ~+0.2% per round-trip.

## How to read this report

1. **Cointegration stats first.** If ADF is < -2.86 in all 3 windows, the pair is structurally stationary across the test period. Strong base.
2. **Compare 30d → 60d → 90d.** Are results stable, or does one window dominate? Stability = strategy. One window dominating = window-specific edge that may not repeat.
3. **Read taker rows for paper-mode expectations.** Read maker rows for Phase B targets.
4. **Avg hold tells you how often you'll see status changes** in the dashboard. < 30 bars = trade activity every couple days. 100+ bars = sparse activity, long open positions.
5. **The projection table is rough.** It linearly scales the source window's trade count and avg PnL to a forward 30d. Real outcomes will vary.
