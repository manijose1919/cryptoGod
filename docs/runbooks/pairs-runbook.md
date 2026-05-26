# Pairs Trading — Operational Runbook

**Audience:** Joseph (operator), future-Claude sessions (any agent triaging an incident).
**Scope:** Live pairs-trading deployment (FIL/ICP and any future pairs).
**Last updated:** 2026-05-26.

When something fires — partial fill, margin critical, ADF degradation, engine crash — the steps below are the **exact** sequence to follow. Don't improvise; the failure modes have been thought through. Improvising under stress is how single-leg exposure becomes a real loss.

---

## 0. Pre-incident: Know These Three Things

Before any alert fires, internalize these:

| Question | Answer |
|---|---|
| **Where is the engine running?** | Local dev machine (paper mode), or the VPS (live, if Phase B is active). Currently: paper-only locally. |
| **What's the smallest unit of "I'm safe"?** | Both legs flat on Kraken **AND** `v2_pairs_trades` shows `status='closed'`. **Either alone is not enough.** |
| **Who has authority to disable the engine?** | You. Always. The engine never overrides a manual `PAIRS_MODE=off` restart. |

---

## 1. Engine running normally — Daily checks (Phase A & B)

**Cadence:** Once per day, or after any alert. Takes ~3 minutes.

1. **UI check** — open dashboard → F8 (Pairs tab):
   - Header shows ● RUNNING in green.
   - Mode badge matches expectation (PAPER in Phase A, LIVE in Phase B).
   - "Loop N" counter is incrementing (refresh page; should go up).
   - Cointegration ADF t-stat is < −2.86 (green check shown).
2. **Alerts pane** — scan last 20 events. Anything `crit` severity? Anything weird?
3. **Open trade (if any)** — unrealized PnL banner present, marks updating, % moves sensible.

**If any of these fail:** go to the relevant section below.

---

## 2. Critical Scenarios — Step-by-Step Recovery

### 2.1 🚨 PARTIAL FILL ALERT FIRES

**What it means:** The executor tried to enter both legs, ONE filled, the OTHER didn't within the 60-second post-only timeout. The executor's emergency-close already ran (market-close on the filled leg with `reduce_only=true`). You are *probably* flat, but **verify** before doing anything else.

**Severity:** CRITICAL. Stop everything else until this is reconciled.

**Step 1 — Verify you're flat on Kraken (CRITICAL).**

In a browser, log into Kraken → Trade → Positions tab. Look for any open margin position on FILUSD or ICPUSD.

| Result | Action |
|---|---|
| **No positions** | You're flat. Skip to Step 3. |
| **One position open** | Go to Step 2 immediately. |
| **Two positions open (both legs)** | The executor's emergency close failed. Manually flatten — Step 2. |

**Step 2 — Manually flatten any remaining position.**

On Kraken's UI:
1. Open the position panel.
2. For each open position, click "Close at market" (Kraken's flatten button).
3. Confirm.
4. Wait for fill confirmation.
5. Re-check the positions tab. Should now be empty.

**Step 3 — Reconcile the DB.**

The engine likely marked the trade as `status='open'` and the executor returned `success: false`. The DB row will be stuck. Fix it:

```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  const row = db.prepare(\"SELECT id, mode, side, entry_time FROM v2_pairs_trades WHERE status='open'\").get();
  console.log('Open trade in DB:', row);
});
"
```

If a row is shown, mark it as `error`:
```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  db.prepare(\"UPDATE v2_pairs_trades SET status='error', exit_reason='manual_reconcile_partial_fill' WHERE status='open'\").run();
  console.log('Marked open trade as error');
});
"
```

**Step 4 — Investigate before restarting.**

Partial fills are rare (post-only on both legs should usually fill or both cancel). When one fills:
- Was one leg's price moving fast (high volatility)? Check the candle log for that minute.
- Was the spread between bid/ask wider on one symbol?
- Did Kraken have an outage?

**Step 5 — Restart the engine.**

```bash
# Stop existing
pm2 stop canuck-node    # (or kill the local node process)

# Restart with same mode
PAIRS_MODE=paper pm2 restart canuck-node
# OR for live:
PAIRS_MODE=live PAIRS_LIVE_CONFIRMED=yes pm2 restart canuck-node
```

The engine will boot, see no open trade (since you marked it `error`), and resume looking for entries. If you don't trust the immediate restart, leave `PAIRS_MODE=off` for 24 hours to cool off, review logs, then restart.

---

### 2.2 🚨 MARGIN LEVEL CRITICAL (< 110%)

**What it means:** Your margin level on Kraken is below 110%. Kraken liquidates at 100%. You have minutes, not hours.

**Severity:** CRITICAL — race condition with the exchange's liquidation engine.

**Step 1 — Click Force Close in the UI immediately.**

Open dashboard → F8 → if there's an open trade, click the red "Force Close" button → confirm. This dispatches a market-close on both legs.

If the UI is unresponsive:

**Step 2 — Manually close via Kraken UI.**

Same as 2.1 Step 2 — Kraken positions tab → close at market on every position.

**Step 3 — Verify flat.**

Re-check positions tab. Should be empty.

**Step 4 — Check margin level recovered.**

Reload the page; margin level should be ∞ or "no positions". If it shows anything below 200%, you may still have residual exposure — investigate.

**Step 5 — Disable the engine until you understand why.**

```bash
# Set in .env or shell
export PAIRS_MODE=off
pm2 restart canuck-node
```

Margin level going critical at 1× leverage on a properly hedged pair is **unexpected**. Investigate:
- Was the hedge ratio (β) far off from realized?
- Did one leg get severely re-priced (e.g., a wick)?
- Are there OTHER open margin positions from a different bot/strategy?

Until you understand the cause, don't re-enable.

---

### 2.3 ⚠️ ADF DEGRADED ALERT

**What it means:** The Augmented Dickey-Fuller test on the rolling 720-bar spread is no longer stationary. The cointegration relationship between FIL and ICP is breaking down.

**Severity:** WARN — the engine has already gated new entries; existing positions are still managed normally.

**This is not an immediate-action alert.** The engine handles it correctly by refusing new entries. Your job is to decide whether to keep the existing position open (if any) or close it.

**Step 1 — Read the ADF t-stat from the alert.**

| t-stat range | Interpretation |
|---|---|
| t > −2.0 | Spread no longer mean-reverts; pair is decoupling |
| −2.86 < t < −2.0 | Marginal; could recover or could break |
| t < −2.86 | (would not have fired) Stationary |

**Step 2 — If you have an open trade, decide:**

- If unrealized PnL is positive: consider closing now. The thesis is breaking; lock the gain.
- If unrealized PnL is negative and small (< 0.5%): hold. Time-stop or stop-z will exit eventually.
- If unrealized PnL is moderately negative (1–2%): force-close. Don't compound regime risk with directional risk.

**Step 3 — Watch the alert pane for re-recovery.**

The engine re-runs the ADF check every 6 hours. If t-stat recovers below −2.86, alerts will stop and entries will resume automatically.

**Step 4 — Don't disable the engine.**

Unless ADF stays > −2.0 for 3+ days, the strategy is doing the right thing (waiting). Disabling deprives you of the entry signal when ADF recovers.

**Step 5 — Long-term: consider pair-swap.**

If ADF stays degraded for 7+ days, the pair has structurally broken. Consider switching to one of the other validated pairs:
- LINK/ICP (backtest fragility 1.92)
- AVAX/SOL (backtest fragility 0.82)

Edit `PAIRS_CONFIG.SYMBOL_A` and `PAIRS_CONFIG.SYMBOL_B` in `v2/engine/config.ts` and restart. **Make sure no open trade exists on the old pair before swapping.**

---

### 2.4 ⏸️ AUTO-PAUSE (3 CONSECUTIVE LOSSES)

**What it means:** Three losing trades in a row triggered the 7-day pause. The engine will not enter new trades until the timeout elapses.

**Severity:** WARN — system is doing the right thing. Don't override.

**Step 1 — Check the recent trades table.**

Were the losses similar (all stop_z)? All time_stop? Mixed? The pattern tells you what's wrong:
- All stop_z: spreads ran further than expected → cointegration may be weakening (cross-check with ADF).
- All time_stop: positions opened correctly but didn't mean-revert → similar concern, slower onset.
- All drawdown_kill: kill-switch fired before z-based exits → consider tightening MAX_DRAWDOWN_PCT_PER_TRADE.

**Step 2 — Use the pause window.**

7 days is your investigation window. Don't manually override unless you have a specific reason. Use the time to:
- Cross-check ADF trends in the state table.
- Read post-trade analysis if available.
- Re-run the walk-forward backtest on recent data.

**Step 3 — When auto-pause expires.**

The engine resumes automatically at the timestamp shown in the pause banner. No action needed.

**To override (rarely needed):**
```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  // The pause is in-memory only — restart clears it.
});
" && pm2 restart canuck-node
```

---

### 2.5 ENGINE CRASH (process died, alerts stop firing)

**What it means:** The Node process holding the pairs engine has exited. PM2 may have restarted it; either way, **state is preserved in SQLite** so resuming is safe.

**Step 1 — Check process status.**

```bash
pm2 list                   # Look for canuck-node
pm2 logs canuck-node --lines 50 --nostream    # Recent error
```

If status is `errored`, look at the last 50 log lines for the crash reason.

**Step 2 — If there's an open trade in DB, the engine will adopt it on restart.**

The `adoptOpenTrade()` function runs in `initPairsEngine`. It picks up the open trade and continues management. Verify after restart:

```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  console.log(db.prepare(\"SELECT id, side, entry_time FROM v2_pairs_trades WHERE status='open'\").all());
});
"
```

**Step 3 — Cross-verify with Kraken.**

If the engine adopted a trade, **verify the positions are still open on Kraken** (1-second job: positions tab). If the DB says open but Kraken says flat, the engine lost track during the crash. Mark the DB row `error`:

```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  db.prepare(\"UPDATE v2_pairs_trades SET status='error', exit_reason='post_crash_reconcile' WHERE status='open'\").run();
});
"
```

**Step 4 — Restart cleanly.**

```bash
PAIRS_MODE=paper pm2 restart canuck-node      # or live, with confirm
```

Watch logs for `[PAIRS] engine initialized` and `[PAIRS] cointegration initialized`. Within 60 seconds you should see normal loop activity.

---

### 2.6 STUCK TRADE (DB shows open, Kraken shows flat)

**What it means:** The engine thinks there's an open position; Kraken doesn't see one. Can happen after a crash, a network glitch, or a manual close on Kraken without going through the engine.

**Severity:** WARN if no real money at risk, CRIT if confused about position state.

**Step 1 — Confirm Kraken positions are flat.**

Kraken UI → Trade → Positions. No FIL/ICP positions.

**Step 2 — Get the stuck DB trade's ID.**

```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  console.log(db.prepare(\"SELECT * FROM v2_pairs_trades WHERE status='open'\").all());
});
"
```

**Step 3 — Mark it as error in DB.**

```bash
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  db.prepare(\"UPDATE v2_pairs_trades SET status='error', exit_reason='manual_reconcile_no_kraken_position' WHERE id=?\").run('<id-from-step-2>');
});
"
```

**Step 4 — Verify the engine catches up.**

The engine refreshes its in-memory `openTrade` from `adoptOpenTrade()` only on restart. So:
- If you marked the trade `error` while engine was running, the in-memory state is stale.
- **Restart the engine.**

```bash
pm2 restart canuck-node
```

After restart, dashboard should show "NO OPEN TRADE" — confirms in-memory + DB + Kraken all agree.

---

### 2.7 KRAKEN OUTAGE DURING OPEN TRADE

**What it means:** Kraken REST/WS is returning errors. The engine's loop logs `candle fetch failed`. You can't see prices, can't place orders, can't close positions.

**Severity:** CRIT if you have an open position; LOW if flat.

**Step 1 — Confirm it's actually Kraken (not your network).**

Open https://status.kraken.com/ in a browser. Verify a system status incident.

**Step 2 — Try to access Kraken's UI.**

If you can log in and see positions, the data layer is up — only the API is down. You can still manually close.

**Step 3 — Wait it out OR manually close via UI.**

| Position open? | Action |
|---|---|
| No | Wait. Engine will resume when API recovers. |
| Yes, modest unrealized | Wait if outage is < 30 min and PnL is within tolerance. |
| Yes, large negative unrealized | Manually close on Kraken UI immediately. Reconcile DB after. |

**Step 4 — After Kraken recovers, reconcile.**

If you manually closed on the UI, the engine still thinks the trade is open. Follow Section 2.6 to mark it `error` in DB and restart.

---

### 2.8 SPREAD RUNS TO > 4σ (stop_z fires)

**What it means:** Normal kill-switch fired. The engine attempted to exit. Verify it succeeded.

**Severity:** WARN — usually expected behavior, but verify.

**Step 1 — Check the trades table.**

The trade should be in `status='closed'` with `exit_reason` starting with `stop_z`. If it's still `open`, the exit failed.

**Step 2 — If exit failed:**

Follow Section 2.6 procedure. Then investigate **why the exit failed** — usually:
- Network glitch during the exit (rare).
- Kraken margin balance went negative (would prevent the reduce-only close — but reduce_only orders should reduce, not increase, exposure).
- A bug. Capture the full log line and review with future-Claude session.

**Step 3 — Don't auto-resume.**

A stop_z exit is usually fine, but it indicates the spread moved 4+ standard deviations against you. The cointegration may be weakening. Cross-check ADF.

---

## 3. Daily / Weekly Reconciliation Tasks

### Daily (during Phase B)

- [ ] Compare `v2_pairs_trades` open count vs Kraken positions count.
- [ ] Spot-check unrealized PnL in UI vs Kraken's Position panel.
- [ ] Read the alerts pane — anything new?

### Weekly (Phase A and B)

- [ ] Run the dup-check query to confirm no duplicate rows in `v2_pairs_trades`:
  ```sql
  SELECT mode, sym_a, sym_b, entry_time, COUNT(*) FROM v2_pairs_trades
  WHERE status IN ('open', 'closed')
  GROUP BY mode, sym_a, sym_b, entry_time HAVING COUNT(*) > 1;
  ```
  Empty result = clean.
- [ ] Run a fresh cointegration test on the recent 720 bars (90d for hourly):
  ```bash
  npx tsx -e "
  import { testCointegration } from './v2/pairs/statsImpl.ts';
  // ... pull recent candles and run testCointegration
  "
  ```
  Compare to live engine's ADF t-stat. Should be close.
- [ ] In Phase B: download Kraken `TradesHistory` for the week and reconcile fees + actual fill prices against `v2_pairs_trades.entry_price_*`. Mismatches > 0.2% indicate slippage exceeded the model.

### Monthly (Phase B)

- [ ] Re-run the walk-forward backtest on the most recent 90 days. If fragility ratio on FIL/ICP drops below 1.0, consider pausing the live engine until next quarter's data.
- [ ] Review per-pair PnL contribution. If a pair is dragging, consider pulling it.

---

## 4. Disable / Re-enable Engine Without Reboot

The engine doesn't have a soft-disable runtime flag — `PAIRS_MODE` is read at boot. To disable:

```bash
# Edit .env or shell var
export PAIRS_MODE=off
pm2 restart canuck-node       # or kill local node
```

To re-enable paper:
```bash
export PAIRS_MODE=paper
pm2 restart canuck-node
```

To re-enable live (Phase B only):
```bash
export PAIRS_MODE=live
export PAIRS_LIVE_CONFIRMED=yes
pm2 restart canuck-node
```

**There is no API endpoint for soft-pause.** Adding one would be a useful future enhancement.

---

## 5. Phase Gates — Decision Checklist

### Phase A → Phase B (end of paper-mode)

Run after 30 days of paper mode. Proceed to Phase B only if ALL pass:

- [ ] ≥ 3 paper entry signals fired
- [ ] Paper net PnL ≥ +1% on the $1000 allocation
- [ ] ADF t-stat stayed < −2.86 throughout (check `v2_pairs_state` history)
- [ ] No catastrophic z-score events (no `|z| > 5`)
- [ ] Average hold ≤ 100 bars

If any fail:
- Investigate the failure mode.
- DO NOT proceed to Phase B yet.
- Consider re-running backtest on the Phase-A period.

### Phase B month 1 → month 2

- [ ] Net PnL ≥ 0 on the live allocation
- [ ] Slippage (actual vs modeled fill) < 0.5% per round-trip
- [ ] Margin level never went below 200%
- [ ] No kill-switch triggers

### Phase B → Ramp (month 3+)

- [ ] Net PnL ≥ +3% on live allocation
- [ ] Sharpe (per-trade) ≥ 1.5
- [ ] Re-run walk-forward on recent 90d; fragility ≥ 1.0

---

## 6. Escalation — When You Need a Future-Claude Session

If any of these happen, the next Claude session should be told **immediately**:

- Partial-fill alert fires and Kraken positions don't match the executor's expected outcome.
- Engine crashes with the same error 3+ times in a row.
- ADF t-stat stays > −2.0 for > 7 days.
- Margin level critical alert fires with 1× leverage (mathematically should not happen on hedged pair).
- Unrealized PnL exceeds 5% on a single open trade (kill-switch should have fired at 3%).
- DB and Kraken disagree on positions for > 2 consecutive loops.

Bring the future session:
1. Full `pm2 logs canuck-node --lines 500 --nostream`.
2. Current `v2_pairs_state` last 50 rows.
3. Current `v2_pairs_trades` for the past 7 days.
4. Current `v2_pairs_alerts` for the past 7 days.
5. Kraken positions screenshot + recent trades export.

---

## 7. Quick Reference — Common Commands

```bash
# Status check
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  console.log('OPEN:', db.prepare(\"SELECT * FROM v2_pairs_trades WHERE status='open'\").all());
  console.log('LAST STATE:', db.prepare(\"SELECT * FROM v2_pairs_state ORDER BY loop_at DESC LIMIT 1\").get());
  console.log('LAST 5 ALERTS:', db.prepare(\"SELECT * FROM v2_pairs_alerts ORDER BY created_at DESC LIMIT 5\").all());
});
"

# Force-close via API (must have engine running)
curl -X POST http://localhost:3033/api/v2/pairs/force-close \
  -H "Content-Type: application/json" \
  -d '{"confirm":"yes","reason":"manual_runbook"}'

# Mark trade as error (manual reconcile)
node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('data/trading.db');
  db.prepare(\"UPDATE v2_pairs_trades SET status='error', exit_reason='manual_runbook_reconcile' WHERE id=?\").run('<trade-id>');
});
"

# Engine on/off
PAIRS_MODE=off pm2 restart canuck-node
PAIRS_MODE=paper pm2 restart canuck-node
PAIRS_MODE=live PAIRS_LIVE_CONFIRMED=yes pm2 restart canuck-node

# View recent log
pm2 logs canuck-node --lines 100 --nostream | grep PAIRS
```

---

## 8. What This Runbook Doesn't Cover (Yet)

- **Multi-pair conflicts.** The runbook assumes one pair at a time. When Phase B month-4 adds 2nd and 3rd pairs, each pair's failure mode interacts with the others (shared margin pool). Update this doc when multi-pair lands.
- **Kraken account suspension or KYC issues.** Out of scope for this runbook — handle through Kraken support.
- **Network attacks / API key compromise.** If you suspect API key compromise: rotate keys immediately, disable engine, audit recent trades for unauthorized activity.
- **Engine bug that causes naked-leg exposure.** This shouldn't happen per the executor design (partial-fill emergency close runs reduce_only), but if it ever does: the executor logs a CRITICAL alert with the unhedged leg's qty + ticker. Manually close on Kraken immediately and file an issue.
