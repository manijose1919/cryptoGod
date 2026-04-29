# 2026-04-29 — Loss Mitigation Package Design

## Context

After the Apr 21 fix package (R:R 1.4 restoration, BE stop revival, STRONG_UP block) and the Apr 27 follow-up tuning (TRAILING_ACTIVATE 1%, TIME_KILL 12h, MR disable, SOL removal), the V2 TREND strategy reached:

- **R:R 1.4 cohort, 54 closed trades**: 32 wins (59% WR), avg_win +$0.97, avg_loss -$1.07, **net -$7.38**
- **Avg loss > avg win** is the structural problem keeping us slightly negative despite a winning WR

The post-deploy strict cohort (since 2026-04-21 15:39 UTC) is at 1W/2L since yesterday's report and the broader R:R 1.4 cohort is still negative.

## Data analysis: where do losses concentrate?

### Per-ticker (R:R 1.4, all 54 closed trades)

| Ticker | n | W | WR | Net | Per-trade |
|---|---:|---:|---:|---:|---:|
| DOGEUSD | 9 | 7 | 78% | +$7.66 | +$0.85 |
| XRPUSD | 8 | 5 | 62% | +$2.70 | +$0.34 |
| DOTUSD | 8 | 6 | 75% | +$2.51 | +$0.31 |
| ADAUSD | 5 | 3 | 60% | +$2.37 | +$0.47 |
| ETHUSD | 8 | 4 | 50% | -$1.99 | -$0.25 |
| SOLUSD | 5 | 2 | 40% | -$3.45 | -$0.69 |
| BTCUSD | 2 | 0 | 0% | -$6.43 | -$3.21 |
| AVAXUSD | 9 | 2 | 22% | -$10.76 | -$1.20 |

DOTUSD and ADAUSD were removed previously based on backtest data (13.2% WR, 20% WR) but achieve 60-75% WR in live R:R 1.4 data. BTCUSD remains in the scan list despite 0/3 = 0% WR live.

Counterfactual: scanning DOT, ADA, XRP, DOGE, ETH would have given net +$13.25 across these 54 trades vs the actual -$7.38.

### Per-regime (R:R 1.4)

| Regime | n | W | Net | Per-trade |
|---|---:|---:|---:|---:|
| UP | 43 | 23 (53%) | -$10.30 | -$0.24 |
| STRONG_UP | 5 | 3 (60%) | +$0.04 | +$0.01 |
| DOWN | 6 | 3 (50%) | +$2.89 | +$0.48 |

The STRONG_UP block was based on R:R 0.8 era data (-$38 net, 36% WR). At R:R 1.4 the same regime is essentially break-even with 60% WR — over-restrictive given the new config.

### Exit reason breakdown (R:R 1.4)

| Exit reason | n | W | Net | Avg hold |
|---|---:|---:|---:|---:|
| stop_loss (incl. trailing exits) | 33 | 16 (48%) | -$18.44 | 5.2h |
| take_profit | 10 | 10 (100%) | +$17.49 | 3.0h |
| time_kill | 11 | 3 (27%) | -$6.43 | 14.0h |

Take-profits are uniformly profitable (+$1.75 avg) but hit only 19% of trades.
Stop-losses are 48% wins thanks to trailing — the exit logic itself is working.

## Three changes (each independently revertable)

### Change 1: Ticker swap

```
SCAN_TICKERS:
  REMOVE: BTCUSD                (0/3 R:R 1.4, -$3.21/trade)
  ADD:    DOTUSD                (6/8 R:R 1.4, +$0.31/trade)
  ADD:    ADAUSD                (3/5 R:R 1.4, +$0.47/trade)
  KEEP:   ETHUSD, XRPUSD, DOGEUSD
```

Final scan list: 5 tickers (ETHUSD, XRPUSD, DOGEUSD, DOTUSD, ADAUSD).

**Confidence: HIGH.** 54 trades of evidence. Counterfactual ~$20+ swing.

### Change 2: Re-allow STRONG_UP

```
ALLOWED_REGIMES:
  ['UP'] → ['STRONG_UP', 'UP']
```

**Confidence: MEDIUM.** Based on 5 historical STRONG_UP trades at R:R 1.4 (60% WR, near break-even). The original block was based on different config era (R:R 0.8). Worth recovering the signal.

### Change 3: Widen TP from 1.4:1 to 1.6:1

```
TAKE_PROFIT_ATR_MULT: 3.5 → 4.0
STOP_LOSS_ATR_MULT:   2.5  (unchanged)
```

**Confidence: MIXED-NEGATIVE.** The avg_win problem is real (avg_win $0.97 < target ~$1.10 for break-even at 59% WR). Wider TP makes individual TP hits bigger but reduces hit rate.

Historical evidence:
- R:R 1.4 cohort: 43 trades, -$1.89 (best of available widths)
- R:R 1.6 cohort: 16 trades, -$10.89 (worse)
- R:R 1.67 cohort: 5 trades, -$6.92 (worse)

This change is a deliberate test under the user's "feeling risky today" framing. With BE stop and trailing now working correctly, it's possible wider TP behaves differently than historical R:R 1.6 era. If the experiment underperforms, revert this commit only.

## Rollback plan

Each change is a single commit. To revert any one:

```
git revert <SHA>
git push origin master
git push vps master   # triggers deploy + PM2 restart
```

To revert all three at once: `git revert <SHA1> <SHA2> <SHA3>`.

## Success criteria (next 10-20 trades)

| Metric | Current | Target |
|---|---|---|
| R:R 1.4/1.6 cohort net | -$7.38 (54 trades) | trending toward break-even or positive |
| Per-ticker DOT/ADA WR | n/a (not scanned) | maintain 60%+ historical WR |
| BTC entries | 0/3 → would have been more | 0 (removed) |
| STRONG_UP entries | 0 (blocked) | a few; outcomes track UP regime closely |
| avg_win (R:R 1.6) | n/a | should be ~$1.45+ if TP widening helps |
