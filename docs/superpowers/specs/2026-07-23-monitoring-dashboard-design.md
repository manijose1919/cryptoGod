# Monitoring Dashboard — Design Spec

**Date:** 2026-07-23
**Author:** local-claude (with Joseph)
**Status:** Approved for planning

## Goal

Provide a clean, professional, bug-tested, read-only monitoring GUI for the CRYPTO_GOD trading bot, accessible over a real HTTPS URL, hosted on the VPS (`VPS_HOST_REDACTED`, `/opt/trading-bot`).

Success criteria:
- A single-screen dashboard shows bot status, account balance, current-cohort KPIs, an equity curve, open positions, and recent closed trades.
- Reachable at `https://VPS_HOST_REDACTED.sslip.io` behind a trusted Let's Encrypt cert and an HTTP basic-auth password.
- Renders correctly in all states, including the **empty cohort** (0 trades since baseline — the actual live state today) and **API-down**.
- No control actions: the GUI can display but never place/close trades or alter the bot.

## Context (verified state, 2026-07-23)

- The Node backend `canuck-node` (`server.js`, 8140 lines) runs under pm2 and binds `*:3033`. `ufw` currently allows `3033`, `3000`, `80`, `443` from anywhere.
- An existing sprawling 40+ panel React "Trading Indicator Dashboard" is already served from `dist/` at `:3033`. It is a dev tool, not a monitoring GUI, and has a `window.onerror` white-screen catcher (history of crashes). We are **not** modifying or reusing it.
- No nginx, no domain, no HTTPS currently.
- Live balance and open positions live **in-memory** in `server.js` as `portfolio.cash` and `portfolio.positions[ticker]` (see server.js:1088, 1472). They are NOT persisted as `open` rows.
- `v2_trades` (SQLite, `data/trading.db`) holds closed trades only (`status` ∈ {`closed`, `duplicate`}), `entry_time` as integer ms. 575 legacy rows; **0 rows since the current `stats_baseline_time` = `1784740967690` (2026-07-22 17:22:47 UTC)**.
- Some existing `/api/*` endpoints returned the SPA HTML instead of JSON during probing. Root cause not fully diagnosed; we sidestep it by adding one **new, explicitly-verified** endpoint rather than depending on the existing ones.

## Chosen approach

**Standalone single-file dashboard + one dedicated JSON endpoint.** (Rejected: adding a route to the existing React SPA — couples to crash-prone frontend; a separate Vite app — build overkill for one screen.)

Rationale: a self-contained `monitor.html` (modern CSS + vanilla JS + inline SVG chart) has the smallest bug surface, no build-pipeline failure mode, and full isolation from the existing app — the best fit for "professional + reliable."

## Architecture / data flow

```
Browser ──HTTPS──▶ nginx (TLS + basic-auth) ──proxy──▶ localhost:3033 (Node)
        https://VPS_HOST_REDACTED.sslip.io                    ├─ GET /monitor            → monitor.html (static)
                                                         └─ GET /api/monitor/summary → JSON
monitor.html polls /api/monitor/summary every 10s.
```

## Components

### 1. Backend endpoint `GET /api/monitor/summary`
- Registered in `server.js` **before** the catch-all (`app.get('*')`, line 7117).
- Delegates all data shaping to a pure, testable helper `buildMonitorSummary({ portfolio, db, baselineTs, health })` so logic is unit-tested independently of Express and the live process.
- Read-only. No side effects.

Response shape:
```jsonc
{
  "asOf": 1690000000000,
  "status": {
    "online": true,
    "live": true,
    "lastLoopTs": 1690000000000,   // last bot-loop heartbeat
    "regime": "UP",
    "circuitBreaker": "OK"          // or tripped state
  },
  "account": {
    "balance": 0.0,                 // portfolio.cash
    "equity": 0.0,                  // cash + sum(position mkt value)
    "openPositionsCount": 0
  },
  "cohort": {                       // from v2_trades WHERE entry_time >= baselineTs
    "baselineTs": 1784740967690,
    "winRate": null,                // null when tradeCount === 0
    "netPnl": 0,
    "tradeCount": 0,
    "avgR": null,
    "openCount": 0
  },
  "equityCurve": [                  // cumulative net PnL over closed cohort trades, ascending by exit_time
    { "t": 1690000000000, "cumPnl": 0 }
  ],
  "openPositions": [                // from portfolio.positions
    { "ticker": "BTCUSD", "strategy": "TREND", "side": "long",
      "entry": 0, "current": 0, "unrealizedPnl": 0,
      "stop": 0, "target": 0, "heldMs": 0 }
  ],
  "recentClosed": [                 // last N (e.g. 25) closed cohort trades, newest first
    { "ticker": "BTCUSD", "strategy": "TREND", "entry": 0, "exit": 0,
      "pnlNet": 0, "outcome": "WIN", "reason": "take_profit", "exitTs": 1690000000000 }
  ]
}
```

Data sources:
- `status`, `account`, `openPositions` — in-memory `portfolio` + engine health vars.
- `cohort`, `equityCurve`, `recentClosed` — `v2_trades` filtered by `entry_time >= baselineTs`; `baselineTs` read from `settings` (key `stats_baseline_time`).

Edge cases the helper must handle explicitly:
- `tradeCount === 0` → `winRate`/`avgR` are `null`, `netPnl` `0`, `equityCurve` `[]`, `recentClosed` `[]`.
- Missing baseline row → treat as `0` (show everything as legacy/none) and flag in payload rather than crash.
- No open positions → `openPositions: []`, `openPositionsCount: 0`.

### 2. Frontend `monitor.html` (single self-contained file)
Layout, top to bottom:
1. **Summary strip** — bot online/offline dot, LIVE badge, balance/equity, "data as of" timestamp.
2. **KPI tiles** — cohort WR, net PnL, trade count, open count, avg R.
3. **Equity curve** — inline SVG area/line of cumulative net PnL for the cohort.
4. **Open positions table** — ticker, strategy, side, entry, current, unrealized PnL, stop, target, hold time.
5. **Recent closed table** — ticker, strategy, entry/exit, net PnL, outcome, reason, time.

Behavior:
- Polls `/api/monitor/summary` every 10s; shows a subtle "updating…" / last-updated indicator.
- **Explicit empty-state**: when `cohort.tradeCount === 0`, tables/chart show "No trades yet since baseline (2026-07-22 17:22 UTC)" — never a blank screen.
- **Explicit error-state**: on fetch failure, show a non-alarming banner ("Can't reach backend — retrying") and keep the last good data visible.
- Dark, professional theme; responsive; wide tables scroll inside their own container (no horizontal page scroll).
- No external CDN dependencies — all CSS/JS inline for reliability.

### 3. Infra / deployment
- Install `nginx` + `certbot` on the VPS (one-time, manual over SSH).
- Issue Let's Encrypt cert for `VPS_HOST_REDACTED.sslip.io` (sslip.io resolves the hostname to `VPS_HOST_REDACTED`; HTTP-01 challenge on port 80).
- nginx server block: TLS termination, `auth_basic` with an `htpasswd` file, `proxy_pass http://127.0.0.1:3033;`.
- **Tighten `ufw`**: remove public access to `3033` (and unused `3000`, `3080`) so the only public entry is `443` (nginx) + `22` (SSH). nginx reaches Node over localhost.
- App code (`monitor.html`, endpoint) ships via the normal `bash scripts/push-deploy.sh` (both remotes). nginx/certbot/ufw are one-time manual VPS steps, documented in the plan.

## Testing ("bug tested")
- **Unit (vitest, already configured):** test `buildMonitorSummary()` against fixture data:
  - baseline boundary — a trade exactly at `baselineTs` is included (`>=`); one just before is excluded.
  - **empty cohort** (0 trades since baseline — current live reality) returns valid nulls/empties, no throw.
  - equity-curve cumulative accumulation is monotonic in order and sums to `netPnl`.
  - open-position field mapping from a `portfolio.positions` fixture.
  - missing-baseline fallback.
- **Live verification:**
  - `curl` the endpoint on the VPS → valid JSON, correct shape.
  - Load `https://VPS_HOST_REDACTED.sslip.io` → browser shows padlock (trusted cert) and prompts for the password.
  - Confirm empty-state renders (cohort is 0 today).
  - Cross-check `account.balance` and `openPositions` against the live `portfolio` and the dashboard's KPIs against a manual `v2_trades` query.

## Security posture
- Read-only endpoint; no mutation routes added.
- HTTP basic-auth at nginx; credentials in an `htpasswd` file (not in git).
- Public `3033` closed; only HTTPS+auth is internet-reachable.

## Standing-rule compliance (CLAUDE.md)
- **Stats baseline reset:** NO. This is a monitoring/infra change, not a trading-config change (falls under "when NOT to reset — trivial / non-trading changes"). The dashboard *reads* the existing baseline; it does not change trade-level expected outcomes.
- **Changelog:** YES — add a `CHANGELOG.md` entry (new monitoring surface + firewall change = material). Commit with the change.
- **Git hygiene:** commit logically; push to **both** remotes via `scripts/push-deploy.sh`.

## Open items to resolve during implementation (not to be guessed)
- Exact field names on `portfolio.positions[ticker]` (entry price, current price, stop, target, side, strategy) — read `server.js` before wiring the mapping.
- In-memory variable names for engine health: last-loop heartbeat, current regime, circuit-breaker state — read `server.js`. If a field is genuinely unavailable, that sub-panel degrades gracefully (shows "—") rather than blocking the build.
- Confirm the new route returns JSON (sidesteps the existing `/api/*`→HTML anomaly).

## Out of scope (YAGNI)
- Any control/mutation actions (pause bot, close position).
- Reusing or fixing the existing 40-panel React dashboard.
- A real purchased domain (sslip.io is sufficient).
- Historical/legacy-cohort deep analytics beyond an optional faint pre-baseline equity line.
