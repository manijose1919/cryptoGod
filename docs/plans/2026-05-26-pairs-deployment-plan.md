# Pairs Trading — Deployment Plan

**Author:** local-claude + Joseph
**Date:** 2026-05-26
**Status:** DRAFT — pre-paper-trade
**Branch:** `feat/canonical-strategy-backtest` (commits `ab1ae8e`...`37709b1`)
**Backtest report:** `v2/backtest/canonical/results/sweep-latest.md` Section 9

---

## 0. Pre-flight verification (do this FIRST, in the Kraken UI)

Before any code change or capital allocation:

1. **Log into Kraken**. Account region = Canada.
2. **Account → Earn / Margin → Enable Margin Trading**. Sign the margin agreement if not yet enabled.
3. **Trade page → search FILUSD**. The order ticket must show a "Margin" tab or leverage selector. If only "Spot" is visible, FIL/USD margin is not enabled for your region/tier — stop here, fall back to plan (b) portfolio-of-pairs in backtest.
4. **Repeat check for ICPUSD**.
5. **Verify margin USD balance** is separate from spot balance (Kraken UI distinguishes them).

This is the binary go/no-go gate. If both FIL and ICP show margin: proceed. Otherwise this plan is unreachable from this venue.

---

## 1. Executive summary

Deploy a single cointegrated pair (FIL/ICP) as a small-capital live test of the strongest signal surfaced by the backtest study. Use Kraken margin (2× max — we'll use 1× = no leverage, pairs-hedged) for the short leg. Allocate ≤ 2% of total trading capital initially. Two-phase validation:

- **Phase A (30 days):** Paper-mode only. Engine fires signals, logs decisions, but does NOT submit orders. Track signal counts, hypothetical PnL, regime stability.
- **Phase B (60 days):** Live with $200–$500 per leg (1–2% of capital), one position at a time, hard kill-switch at −3% drawdown.

Decision criteria for Phase A → B: signals must fire ≥ 3 times, hypothetical net PnL ≥ +1%, and cointegration ADF must remain < −2.86 across the period.

Expected outcome (from backtest walk-forward):
- IS: +2.79% → OOS: +11.28% (fragility 4.05) on the 90d window
- ~9 trades per 90 days on tight(1.5σ) params
- Average hold ≈ 30–50 bars (1–2 days)

---

## 2. The strategy (mechanically)

**Pair:** `A = FILUSD, B = ICPUSD` (FIL is the "y", ICP is the "x")
**Hedge ratio β:** 0.75 (re-estimated every 120 bars)
**Spread:** `s_t = log(FIL_price_t) − β × log(ICP_price_t) − α`
**Window for mean/σ:** 720 bars (30 days on 1h)

**Entry (long-spread):** when z = (s_t − μ_s) / σ_s falls below −1.5
- Long FIL/USD (1 unit of capital)
- Short ICP/USD (1 unit of capital, equal-dollar)

**Entry (short-spread):** when z > +1.5
- Short FIL/USD
- Long ICP/USD

**Exit:** when |z| < 0.3 (mean revert hit) OR |z| > 4.0 (stop) OR 200 bars elapsed (time stop)

**Best param variant (from walk-forward):** `tight(1.5σ/0.3σ)` with maker fills.

---

## 3. Sizing & risk

**Total capital allocation:** 2% of trading equity (cap at $1000 absolute notional total).
**Per leg:** half of allocation, so $500 in FIL + $500 short ICP at the entry.
**Effective leverage:** 1× — we are NOT levering up. Margin is only used because shorting requires it.
**Max simultaneous positions:** 1.
**Margin maintenance buffer:** Kraken liquidates at 50% margin level. With 1× leverage, you'd need a ~50% adverse move to liquidate. Highly unlikely on a hedged pair, but **set a margin alert at 80% maintenance** to be safe.

**Hard kill switches:**
| Trigger | Action |
|---|---|
| Pair PnL drawdown ≥ 3% of allocation in single trade | Force-close both legs immediately, halt strategy |
| Cointegration ADF rolling 7-day re-test > −2.0 | Halt new entries until ADF recovers below −2.86 |
| 3 consecutive losing trades | Halt strategy for 7 days, re-check pair fitness |
| Margin maintenance level < 80% | Force-close, even if PnL still positive |
| FIL or ICP gets delisted/halted on Kraken | Force-close any open position |

---

## 4. Implementation phases

### Phase A — Paper mode (30 days)

Build the pairs engine in the live codebase but with `LIVE_MODE = false`. Engine should:
- Run every 60s, fetch FILUSD + ICPUSD via Kraken websocket
- Maintain rolling 720-bar window of log-prices
- Compute β, α, spread mean, std using same code path as the backtest
- Emit signal logs: `[PAIRS] z=X.XX β=Y.YY action=Z`
- On entry: log a paper trade with simulated fill at next-bar open
- On exit: log paper close, accumulate paper PnL
- Persist all paper trades to a new SQLite table `paper_pairs_trades`

**Phase A success criteria (re-evaluate after 30 days):**
- [ ] ≥ 3 signal triggers fired
- [ ] Paper net PnL ≥ +1% on the allocation
- [ ] Avg hold ≤ 100 bars
- [ ] No catastrophic z-score (> 5σ) events
- [ ] ADF stays < −2.86 throughout

If any fail: do NOT proceed to Phase B. Investigate root cause first.

### Phase B — Live with small capital (60 days)

Move `LIVE_MODE = true`. Replace the simulated fills with actual Kraken margin orders.
- Entry: `placeOrder(pair=FILUSD, side=buy, type=limit, leverage=1, ...)` and `placeOrder(pair=ICPUSD, side=sell, type=limit, leverage=1, ...)` simultaneously
- Use **post-only limit orders** at best-bid for the long leg, best-ask for the short leg (capture maker rebates). If unfilled after 60 seconds, cancel and resubmit at improved price (within 0.1% of last-trade).
- If after 5 minutes either leg is still unfilled, abort the entire signal (don't take leg risk).

**Phase B monitoring (daily):**
- Open PnL marked-to-market
- Margin level (alert at 80%, force-close at 60%)
- Cointegration drift (re-run ADF weekly)
- Slippage tracking (model vs actual fill)

**Phase B success criteria (after 60 days):**
- [ ] Net PnL on allocation ≥ +3%
- [ ] No kill-switch triggers
- [ ] Slippage budget honored (< 0.5% per round-trip)
- [ ] Sharpe (computed on per-trade returns) ≥ 1.5

---

## 5. Ramp schedule (if Phase B succeeds)

Conservative — increase only after each multiplier completes another 30 days clean:

| Period | Allocation | Why |
|---|---|---|
| Phase B months 1-2 | 2% of equity (cap $1000) | Initial proving |
| Phase B month 3 | 4% of equity | Doubled after first cohort |
| Phase B month 4-5 | 6% of equity | Add second pair (LINK/ICP or AVAX/SOL) at 3% each |
| Phase B month 6+ | 10% total across 3 pairs | Diversified pairs portfolio |

Each ramp gates on **walk-forward re-validation** on the most recent 90 days. If the new fragility drops below 1.0, halt ramp.

---

## 6. Code changes required (in this repo)

These are not yet implemented. Listed in dependency order for a follow-up session:

1. `v2/pairs/` (new directory):
   - `cointegration.ts` — port from `v2/backtest/canonical/pairs/stats.ts`
   - `pairsEngine.ts` — the live runner. Mirrors `pairsRunner.ts` but uses real WebSocket/REST instead of historical candles.
   - `pairsExecutor.ts` — two-leg order placement with post-only + retry logic.
   - `pairsMonitor.ts` — margin level + ADF drift checks.

2. `v2/engine/serverV2.ts` — register pairs engine alongside existing TREND/MOMENTUM/etc.

3. New SQLite table `v2_pairs_trades` (separate from `v2_trades`): two-ticker schema, both leg fills, combined PnL.

4. Dashboard widgets — single panel showing current z-score, β, days since cointegration re-test, open paper/live pair PnL.

5. Config flag `PAIRS_MODE = 'off' | 'paper' | 'live'` in `v2/engine/config.ts`.

**Estimated build effort:** 8–12 hours over 2-3 focused sessions.

---

## 7. Monitoring criteria & alerts

| What | Where | Cadence | Alert threshold |
|---|---|---|---|
| Open pair PnL | dashboard + Telegram | every bar | drawdown > 2% |
| z-score | dashboard | every bar | |z| > 4 (stop territory) |
| β re-estimate | log | every 120 bars | β changed > 30% from last |
| ADF on last 720 bars | scheduled task | weekly | t-stat > −2.5 |
| Margin level | Kraken account API | every 60s | < 80% maintenance |
| Slippage actual vs modeled | per trade | post-fill | actual > 1.5× modeled |
| Pair correlation (Pearson on log returns) | weekly | weekly | < 0.6 |

Two consecutive weekly cointegration failures = automatic pause (no new entries) until manual review.

---

## 8. Rollback plan

If anything goes wrong:

1. **Set `PAIRS_MODE = 'off'`** in config and restart the engine. New entries blocked.
2. **Force-close any open position** via dashboard button OR direct SQL:
   ```sql
   -- Mark open pair trade for force-close on next loop
   UPDATE v2_pairs_trades SET force_close = 1 WHERE status = 'open';
   ```
3. **Manual unwind on Kraken** if engine is non-responsive: place opposing market orders on each leg simultaneously.
4. **Don't leave a leg open.** If one leg's order fails to close, fill the other side via market immediately. The largest non-strategy risk in pairs trading is single-leg exposure.

---

## 9. What could go wrong (pre-mortem)

| Failure mode | Probability | Impact | Mitigation |
|---|---|---|---|
| Cointegration breaks (regime change) | Medium | Spread drifts away, time-stop loses fees + drift | Weekly ADF re-test; halt if t > −2.5 |
| One leg fails to fill | Low | Naked directional exposure | Hard 5-min timeout; abort if both legs not filled |
| Kraken margin maintenance call | Very low at 1× lev | Forced liquidation of one leg | Set 80% margin alert; conservative position sizing |
| FIL or ICP gets delisted | Very low (24-month window) | Position frozen | Pre-emptive close on delisting notice (usually 1 week ahead) |
| Backtest was overfit despite walk-forward | Medium | Live PnL diverges from backtest | Paper-mode gate (Phase A); kill-switch on drawdown |
| Slippage worse than modeled | Medium | Per-trade economics inverted | Maker-only fills with 60s retry; track actual vs modeled |
| Exchange downtime during open position | Low | Can't close on signal | Native stop-loss orders on each leg as fallback |

---

## 10. Open questions before Phase A starts

1. **Kraken margin region confirmation.** See Section 0. Hard gate.
2. **Maker fee tier verification.** Section 1 of backtest assumes −0.05% maker rebate (volume tier 2 on Kraken). Your tier may differ. Check at `account → fees`.
3. **Capital source.** Margin USD balance is separate from spot — do you have ≥ $1000 in the margin account? If not, transfer in.
4. **Telegram/Discord alert channel.** Reuse existing `services/telegramService.js`? Add a separate pairs channel?
5. **Re-baseline timing.** When Phase B starts, set a new `stats_baseline_time` per the CLAUDE.md standing rule so pairs trades are reportable separately.

---

## 11. Decision checkpoints

| When | Question | Action if NO |
|---|---|---|
| Now | Margin enabled on FIL+ICP? | Stop; fall back to portfolio-of-pairs backtest work |
| Now | Maker tier ≤ −0.05%? | Adjust fee modeling, possibly re-decide on viability |
| End Phase A | All 5 success criteria met? | Halt; investigate failed criterion before retry |
| End Phase B month 1 | Net PnL positive? Slippage in budget? | Pause; review trade-by-trade |
| End Phase B month 2 | Sharpe ≥ 1.0? Walk-forward re-validation positive on last 90d? | Don't ramp; keep at Phase B sizing |
| Anytime | Kill switch triggered? | Manual review before resuming |

---

## Appendix A — Walk-forward backtest provenance

These results come from `v2/backtest/canonical/sweep.ts` run at 2026-05-26 15:55 UTC, commit `37709b1`. Reproduce with:
```bash
git checkout feat/canonical-strategy-backtest
npx tsx v2/backtest/canonical/sweep.ts
```

Top FIL/ICP cells (from `results/sweep-latest.md`):
- 90d / tight(1.5σ) / maker: 28 trades, 50% WR, PF 2.57, **+14.26% net**
- 60d / wide(2.5σ) / maker: 5 trades, 100% WR, PF inf, +11.19% net
- 90d / walk-forward: IS +2.79% → **OOS +11.28%, fragility 4.05**
- 60d / walk-forward: IS +1.30% → **OOS +9.59%, fragility 7.38**

Top alternative pairs for the eventual diversification (Phase B month 4+):
- LINK/ICP (90d WF: IS +3.74% → OOS +7.19%, fragility 1.92)
- AVAX/SOL (90d WF: IS +3.16% → OOS +2.58%, fragility 0.82) — solid but lower magnitude
