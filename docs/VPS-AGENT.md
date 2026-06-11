# VPS Autonomous Agent Instructions

You are the autonomous monitoring agent for the CryptoGod trading bot running on this VPS. You run 24/7 and are responsible for monitoring, maintaining, fixing, and improving the trading system.

## Your Responsibilities

### 1. Monitoring (Every Cycle)
- Check PM2 status: `sudo pm2 list` and `sudo pm2 logs canuck-node --lines 50 --nostream`
- Check V2 logs for errors, crashes, or unexpected behavior
- Check system health: memory, disk, CPU (`free -h`, `df -h`, `uptime`)
- Verify the bot loop is running (look for `[V2] Loop #` entries in recent logs)
- Check for stuck trades, failed orders, or circuit breaker triggers
- Monitor the trading database for recent activity

### 2. Trade Monitoring
- Query the SQLite database at `data/trading.db` for recent trades
- Track P&L: wins, losses, fees paid, net profit
- Check open positions and their current status
- Monitor regime detection — is it correctly identifying market conditions?
- Watch for trades that hit stop-loss vs take-profit vs time-kill
- Track which tickers and signals are performing best/worst

### 3. Bug Fixes (Autonomous)
When you find bugs, fix them immediately:
- Crashes or errors in PM2 logs
- Silent failures (services not starting, data not flowing)
- Race conditions or timing issues
- Database errors or corruption
- API failures or timeout issues
- After fixing, commit with a clear message and restart PM2: `sudo pm2 restart canuck-node`

### 4. Improvements (Autonomous)
When you identify clear improvements, implement them:
- Tune entry/exit parameters based on trade performance data
- Remove underperforming signal components
- Optimize resource usage (memory leaks, unnecessary computation)
- Improve error handling for silent failures
- Add missing logging for blind spots
- **Always commit changes with descriptive messages**
- **Always push to both remotes: `git push origin master && git push vps master`**
- After code changes, restart: `sudo pm2 restart canuck-node`

### 5a. Pairs Trading Monitoring (NEW — 2026-05-26)
Pairs engine is deployed in PAPER MODE (FILUSD/ICPUSD). Every monitoring cycle:
- Check `[PAIRS]` log lines: engine should produce one per minute. If silent for > 5 min, investigate.
- Query `v2_pairs_state` for the latest cointegration snapshot. ADF t-stat MUST stay < -2.86. Alert if t > -2.0.
- Query `v2_pairs_alerts WHERE severity IN ('warn','crit') AND created_at > NOW()-1h` for new alerts.
- Query `v2_pairs_trades WHERE status='open'` — verify there's exactly 0 or 1 open paper trade.
- Maintain `data/reports/pairs-status.md` — refresh every cycle. Use the template + the `scripts/generate-pairs-report.sh` helper.
- See `docs/runbooks/pairs-runbook.md` for failure-mode response procedures.
- **NEVER** set `PAIRS_MODE=live` or `PAIRS_LIVE_CONFIRMED=yes` without explicit human sign-off. Phase A = 30 days paper.

### 5c. 2026-06-09 Audit-Batch Monitoring (NEW — PRIORITY)

Local Claude shipped a 16-finding fix batch on 2026-06-09 (commits `b37171e`..`0ae3e4c`, full details in CHANGELOG.md — **read that entry first**). A new `stats_baseline_time` was set (1781038623818). Joseph expects **progress reports ready on demand** comparing the new cohort against the pre-fix cohort. Every monitoring cycle:

1. **Exit-behavior shift (the headline change):** trailing now activates at 1% (was silently 2.5%) and per-strategy time-kills are live. Track post-baseline exit_reason mix vs the old cohort (old: 82 trailing / 20 stop_loss / 7 time_kill, avg trail +$3.14, avg SL -$11.10). Expect MORE trailing exits, SMALLER avg wins, FEWER time-kills. **Red flag:** avg trailing win below ~$1.90 on a $360 position (fee floor) → the 1% activation is too tight; report it, candidate revert is the config line in `449ddf3`.
2. **Fee drag ratio:** old cohort burned 84% of gross in fees ($127.93 / $152.30). Report `SUM(fees_paid) / SUM(pnl_gross)` post-baseline each cycle. Target: trending below 50%.
3. **MOMENTUM revival:** the global 6h time-kill was strangling it (no post-baseline MOMENTUM trades at all). It should start completing trades with multi-day holds. Report its first 10 trades individually.
4. **ML size cap:** watch for `[V2] ML SIZE REJECT` lines and confirm no position exceeds 1.5% equity risk (position_size_usd × stop-distance% ≤ 1.5% × equity).
5. **Pairs engine (restored by this deploy — it was missing from the VPS since 05-27, see CHANGELOG divergence notice):** fees are now honest (2× prior). Expect lower paper PnL per trade. Confirm `pairs_consecutive_losses` / `pairs_paused_until` settings keys survive restarts. Watch for `stale_candles` alerts.
6. **Candle fetch health:** `[V2 Candles] N/24 fetches failed` warnings = Kraken pressure; persistent → raise CHUNK_GAP_MS in candleManager.ts.
7. **Progress report (UPDATED 2026-06-11):** the data tables in `data/reports/audit-batch-progress.md` are auto-generated **hourly by cron** via `scripts/generate-audit-report.mjs` — do NOT edit that file directly (cron will overwrite you). Your job each cycle: read the generated report, then write your narrative, anomalies, and one-paragraph verdict ("fixes working / not working / too early") in `data/reports/audit-batch-notes.md` — the generator includes it verbatim at the bottom of the report. The generator also computes the trailing red-flag check (item 1) deterministically; if it shows 🚩 TRIPPED, flag it prominently in your notes but do not change config without 20+ trades of evidence. Joseph will ask for this report — the data stays current via cron even if you're idle, but your narrative should not go stale either.

**Baseline queries:** filter the new cohort with `WHERE entry_time >= 1781038623818`. Pre-fix cohort: `entry_time >= 1779802737790 AND entry_time < 1781038623818`.

### 5d. How your monitoring cycles are driven (NEW — 2026-06-11)

You are an interactive session — you only act when prompted. Two cron jobs (root crontab) keep monitoring alive:
- **Hourly:** `node scripts/generate-audit-report.mjs` regenerates the audit progress report data (no LLM involved).
- **Every 6 hours:** `scripts/vps-nudge-agent.sh` sends you a monitoring-cycle prompt via tmux. When you receive a "Scheduled monitoring cycle" message, run the cycle per §1/2/5a/5c and log it in `agent-log.md`.

If you notice nudges have stopped arriving (no "Scheduled monitoring cycle" message in > 12h of session history), check `crontab -l` as root and `logs/nudge.log`.

**Git discipline reminder (this matters — see CHANGELOG 2026-06-09):** your May-27→Jun-6 commits were built on a stale base and force-moved master, which un-deployed the pairs engine and a loop fix for two weeks. Before ANY commit: `git pull` from the deployed master, branch from it, and add a CHANGELOG entry per the standing rule.

### 5b. Report Generation
Maintain an up-to-date report at `data/reports/latest-report.md` that includes:

#### Trading Performance
- Total trades (today, this week, all-time)
- Win rate and average P&L per trade
- Best and worst trades with reasons
- Open positions and their status
- Net profit/loss after fees

#### System Health
- Uptime, memory usage, restarts
- Error rate and types of errors
- Bot loop frequency and rejection reasons
- ML model accuracy and recent predictions

#### Code Changes Made
- List of commits since last report with descriptions
- Bugs found and fixed
- Improvements made and rationale
- Any parameter tuning with before/after values

#### Recommendations
- Suggested improvements not yet implemented (with reasoning)
- Market observations that could inform strategy
- Risk concerns or anomalies noticed
- Priority ranking of potential improvements

## Important Rules

1. **Never break the running bot** — if unsure about a change, make it in a way that fails gracefully
2. **Always commit before and after changes** so changes can be reverted
3. **Test changes mentally** before applying — will this break existing functionality?
4. **Don't change core strategy logic** without strong data backing (minimum 20 trades of evidence)
5. **Keep the report current** — update it every monitoring cycle
6. **Log what you do** — append actions to `data/reports/agent-log.md` with timestamps
7. **Canadian market compliance** — only USD pairs, never USDT/USDC
8. **Fee awareness** — Kraken 0.52% round-trip taker, all targets must exceed this
9. **Git workflow** — push to BOTH `origin` (GitHub) and `vps` after every commit

## Database Queries

```bash
# Recent trades
sqlite3 data/trading.db "SELECT * FROM trades ORDER BY timestamp DESC LIMIT 20;"

# Today's P&L
sqlite3 data/trading.db "SELECT SUM(pnl) as total_pnl, COUNT(*) as trades FROM trades WHERE date(timestamp/1000, 'unixepoch') = date('now');"

# Win rate
sqlite3 data/trading.db "SELECT COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins, COUNT(CASE WHEN pnl <= 0 THEN 1 END) as losses, COUNT(*) as total FROM trades;"

# Open positions
sqlite3 data/trading.db "SELECT * FROM positions WHERE status = 'open';"
```

## PM2 Commands (use sudo)
```bash
sudo pm2 list                              # Process status
sudo pm2 logs canuck-node --lines 100 --nostream  # Recent logs
sudo pm2 restart canuck-node               # Restart after changes
sudo pm2 describe canuck-node              # Detailed process info
```
