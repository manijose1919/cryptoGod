# Monitoring Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a clean, read-only monitoring GUI for the Phoenix V2 trading bot, served by the running `serverV2.ts` process and reachable at `https://VPS_HOST_REDACTED.sslip.io` behind a Let's Encrypt cert and an HTTP basic-auth password.

**Architecture:** One new read-only endpoint `GET /api/v2/monitor/summary` on the already-mounted `v2Router`, backed by a pure, unit-tested `buildMonitorSummary()` helper. A single self-contained `public/monitor.html` (modern CSS + vanilla JS + inline SVG chart) polls that endpoint every 10s. nginx terminates TLS and enforces basic-auth, proxying to `localhost:3033`; public port 3033 is then closed.

**Tech Stack:** Node with `--experimental-strip-types` (TypeScript run directly, no build), Express `Router`, `better-sqlite3` (via `services/database.js` `getDb()`), Vitest, nginx + certbot, vanilla HTML/CSS/JS.

## Global Constraints

- Runtime entry point is `serverV2.ts` (pm2 app `canuck-node`), NOT `server.js`. All routing changes go in the V2 files.
- TypeScript files run via `--experimental-strip-types` — no build step; type-only imports must use `import type`.
- The bot runs in **paper** mode (`V2_MODE=paper`); the status badge must read the real mode from `getV2Status().mode`, never hardcode "LIVE".
- Cohort filter is **`entry_time >= stats_baseline_time`** (entry-time, per CLAUDE.md standing rule) — NOT `exit_time`. Do not reuse `getClosedTradesSince` (it filters on `exit_time`).
- `v2_trades` has no `outcome` column; derive win/loss from `pnl_net` (`>0` WIN, `<0` LOSS, else BREAKEVEN).
- Read-only only: no mutation/control routes. No `requireAdminAuth` needed (nginx gates the whole surface); but never add POST/mutation here.
- Frontend file lives in source-controlled `public/`, never in `dist/` (the deploy hook runs `npx vite build`, which wipes `dist/`).
- USD pairs only; fees are Kraken-based — not relevant to display logic but keep any labels consistent.
- Push to BOTH git remotes via `bash scripts/push-deploy.sh`.

---

## File Structure

- **Create** `v2/dashboard/monitorSummary.ts` — types + pure `buildMonitorSummary(deps)`. One responsibility: shape live+DB data into the dashboard payload. No I/O.
- **Create** `v2/dashboard/monitorSummary.test.ts` — Vitest unit tests for the pure helper.
- **Modify** `v2/dashboard/attributionAPI.ts` — add `GET /monitor/summary` route that gathers live data (impure) and calls the helper.
- **Create** `public/monitor.html` — the self-contained dashboard.
- **Modify** `serverV2.ts` — add `GET /monitor` route (serve the file) before the catch-all.
- **Modify** `CHANGELOG.md` — material-change entry.
- **VPS-only (manual, documented in Task 4):** `/etc/nginx/sites-available/monitor`, `/etc/nginx/.htpasswd`, certbot cert, `ufw` rule changes.

---

## Task 1: Pure summary builder + tests

**Files:**
- Create: `v2/dashboard/monitorSummary.ts`
- Test: `v2/dashboard/monitorSummary.test.ts`

**Interfaces:**
- Consumes: `V2Trade` (from `../attribution/attributionStore.ts`) and `V2EngineStatus` (from `../engine/tradeEngine.ts`) — used as `import type`.
- Produces:
  - `interface MonitorSummary` (payload shape below)
  - `interface MonitorDeps { status: V2EngineStatus; openTrades: V2Trade[]; cohortClosed: V2Trade[]; baselineTs: number; baselineMissing: boolean; now: number }`
  - `export function buildMonitorSummary(deps: MonitorDeps): MonitorSummary`

- [ ] **Step 1: Write the failing test**

Create `v2/dashboard/monitorSummary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMonitorSummary } from './monitorSummary.ts';
import type { MonitorDeps } from './monitorSummary.ts';

// Minimal V2Trade factory — only the fields buildMonitorSummary reads.
function trade(over: Record<string, unknown> = {}): any {
  return {
    id: 'x', ticker: 'BTCUSD', side: 'long', status: 'closed',
    entryPrice: 100, entryTime: 1_000, quantity: 1, positionSizeUsd: 100,
    exitPrice: 110, exitTime: 2_000, exitReason: 'take_profit',
    pnlGross: 10, pnlNet: 9, feesPaid: 1, holdDurationMs: 1_000,
    initialStop: 90, currentStop: 95, takeProfitTarget: 120,
    strategy: 'TREND', entryRegime: 'UP', entryConfidence: 0.7,
    ...over,
  };
}

const baseStatus: any = {
  mode: 'paper', isRunning: true, lastLoopTime: 5_000, loopCount: 3,
  rejectedByScan: 0, rejectedBySignal: 0, rejectedByRisk: 0,
  htfRegimes: { BTCUSD: 'UP' }, openPositions: 0, totalTrades: 0,
  portfolioCash: 1000, totalPnlNet: 0,
};

function deps(over: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    status: baseStatus, openTrades: [], cohortClosed: [],
    baselineTs: 1_784_740_967_690, baselineMissing: false, now: 9_999,
    ...over,
  } as MonitorDeps;
}

describe('buildMonitorSummary', () => {
  it('empty cohort → null rates, zero pnl, empty arrays (no throw)', () => {
    const s = buildMonitorSummary(deps());
    expect(s.cohort.tradeCount).toBe(0);
    expect(s.cohort.winRate).toBeNull();
    expect(s.cohort.avgR).toBeNull();
    expect(s.cohort.netPnl).toBe(0);
    expect(s.equityCurve).toEqual([]);
    expect(s.recentClosed).toEqual([]);
    expect(s.account.balance).toBe(1000);
  });

  it('computes winRate, netPnl and monotonic cumulative equity curve', () => {
    const cohortClosed = [
      trade({ pnlNet: 9, exitTime: 3_000, entryTime: 2_500 }),   // win
      trade({ pnlNet: -4, exitTime: 2_000, entryTime: 1_800 }),  // loss
    ];
    const s = buildMonitorSummary(deps({ cohortClosed }));
    expect(s.cohort.tradeCount).toBe(2);
    expect(s.cohort.netPnl).toBeCloseTo(5);
    expect(s.cohort.winRate).toBeCloseTo(0.5);
    // equity curve ordered oldest→newest by exitTime, cumulative
    expect(s.equityCurve.map(p => p.cumPnl)).toEqual([-4, 5]);
    // last cumPnl equals netPnl
    expect(s.equityCurve.at(-1)!.cumPnl).toBeCloseTo(s.cohort.netPnl);
  });

  it('avgR uses risk = |entry-initialStop|*qty', () => {
    // risk = |100-90|*1 = 10; R = pnlNet/risk = 9/10 = 0.9
    const s = buildMonitorSummary(deps({ cohortClosed: [trade({ pnlNet: 9 })] }));
    expect(s.cohort.avgR).toBeCloseTo(0.9);
  });

  it('recentClosed derives outcome from pnlNet and caps at 25 newest', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      trade({ pnlNet: i % 2 === 0 ? 5 : -5, exitTime: 1_000 + i }));
    const s = buildMonitorSummary(deps({ cohortClosed: many }));
    expect(s.recentClosed.length).toBe(25);
    // newest first (highest exitTime)
    expect(s.recentClosed[0].exitTs).toBe(1_029);
    expect(s.recentClosed[0].outcome).toBe(i => i); // placeholder replaced below
  });

  it('maps open positions from openTrades', () => {
    const openTrades = [trade({ status: 'open', ticker: 'ETHUSD', strategy: 'MOMENTUM',
      side: 'long', entryPrice: 50, positionSizeUsd: 200, currentStop: 45,
      takeProfitTarget: 60, entryTime: 4_000 })];
    const s = buildMonitorSummary(deps({ openTrades }));
    expect(s.openPositions).toHaveLength(1);
    expect(s.openPositions[0]).toMatchObject({
      ticker: 'ETHUSD', strategy: 'MOMENTUM', side: 'long',
      entry: 50, positionSizeUsd: 200, stop: 45, target: 60,
    });
    expect(s.account.openPositionsCount).toBe(1);
  });

  it('regime falls back to first htfRegime then UNKNOWN', () => {
    expect(buildMonitorSummary(deps()).status.regime).toBe('UP');
    const noBtc = { ...baseStatus, htfRegimes: {} };
    expect(buildMonitorSummary(deps({ status: noBtc })).status.regime).toBe('UNKNOWN');
  });

  it('flags stale engine when lastLoopTime is old', () => {
    const s = buildMonitorSummary(deps({ now: 5_000 + 6 * 60_000 }));
    expect(s.status.stale).toBe(true);
  });
});
```

Fix the one placeholder line before running — replace:
```ts
    expect(s.recentClosed[0].outcome).toBe(i => i); // placeholder replaced below
```
with:
```ts
    expect(['WIN', 'LOSS', 'BREAKEVEN']).toContain(s.recentClosed[0].outcome);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run v2/dashboard/monitorSummary.test.ts`
Expected: FAIL — `buildMonitorSummary` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `v2/dashboard/monitorSummary.ts`:

```ts
// ============================================
// Monitor dashboard payload builder (pure).
// No I/O — takes live + DB data, returns the display shape.
// ============================================
import type { V2Trade } from '../attribution/attributionStore.ts';
import type { V2EngineStatus } from '../engine/tradeEngine.ts';

const STALE_MS = 5 * 60_000;      // engine considered stale if no loop in 5 min
const RECENT_CLOSED_LIMIT = 25;

export interface MonitorDeps {
  status: V2EngineStatus;
  openTrades: V2Trade[];
  cohortClosed: V2Trade[];   // v2_trades, status=closed, entry_time >= baselineTs
  baselineTs: number;
  baselineMissing: boolean;
  now: number;
}

export interface MonitorSummary {
  asOf: number;
  status: {
    mode: string;
    isRunning: boolean;
    stale: boolean;
    lastLoopTime: number;
    regime: string;
  };
  account: { balance: number; openPositionsCount: number };
  cohort: {
    baselineTs: number;
    baselineMissing: boolean;
    winRate: number | null;
    netPnl: number;
    tradeCount: number;
    avgR: number | null;
    openCount: number;
  };
  equityCurve: { t: number; cumPnl: number }[];
  openPositions: {
    ticker: string; strategy: string; side: string;
    entry: number; positionSizeUsd: number; stop: number;
    target: number; heldMs: number;
  }[];
  recentClosed: {
    ticker: string; strategy: string; entry: number; exit: number | null;
    pnlNet: number; outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
    reason: string | null; exitTs: number | null;
  }[];
}

function outcomeOf(pnlNet: number): 'WIN' | 'LOSS' | 'BREAKEVEN' {
  if (pnlNet > 0) return 'WIN';
  if (pnlNet < 0) return 'LOSS';
  return 'BREAKEVEN';
}

export function buildMonitorSummary(deps: MonitorDeps): MonitorSummary {
  const { status, openTrades, cohortClosed, baselineTs, baselineMissing, now } = deps;

  const regime =
    (status.htfRegimes && (status.htfRegimes['BTCUSD'] ?? Object.values(status.htfRegimes)[0])) ||
    'UNKNOWN';

  // Cohort stats
  const tradeCount = cohortClosed.length;
  const netPnl = cohortClosed.reduce((s, t) => s + (t.pnlNet ?? 0), 0);
  const wins = cohortClosed.filter(t => (t.pnlNet ?? 0) > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : null;

  // avg R = mean of pnlNet / risk, over trades with positive risk
  const rValues = cohortClosed
    .map(t => {
      const risk = Math.abs((t.entryPrice ?? 0) - (t.initialStop ?? 0)) * (t.quantity ?? 0);
      return risk > 0 ? (t.pnlNet ?? 0) / risk : null;
    })
    .filter((r): r is number => r !== null);
  const avgR = rValues.length > 0 ? rValues.reduce((s, r) => s + r, 0) / rValues.length : null;

  // Equity curve: oldest→newest by exitTime, cumulative net PnL
  const byExit = [...cohortClosed].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let cum = 0;
  const equityCurve = byExit.map(t => {
    cum += t.pnlNet ?? 0;
    return { t: t.exitTime ?? 0, cumPnl: cum };
  });

  // Recent closed: newest first, capped
  const recentClosed = [...cohortClosed]
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, RECENT_CLOSED_LIMIT)
    .map(t => ({
      ticker: t.ticker, strategy: t.strategy, entry: t.entryPrice,
      exit: t.exitPrice ?? null, pnlNet: t.pnlNet ?? 0,
      outcome: outcomeOf(t.pnlNet ?? 0), reason: t.exitReason ?? null,
      exitTs: t.exitTime ?? null,
    }));

  const openPositions = openTrades.map(t => ({
    ticker: t.ticker, strategy: t.strategy, side: t.side,
    entry: t.entryPrice, positionSizeUsd: t.positionSizeUsd,
    stop: t.currentStop, target: t.takeProfitTarget,
    heldMs: Math.max(0, now - (t.entryTime ?? now)),
  }));

  return {
    asOf: now,
    status: {
      mode: status.mode,
      isRunning: status.isRunning,
      stale: !status.isRunning || (now - (status.lastLoopTime ?? 0)) > STALE_MS,
      lastLoopTime: status.lastLoopTime ?? 0,
      regime,
    },
    account: { balance: status.portfolioCash ?? 0, openPositionsCount: openTrades.length },
    cohort: {
      baselineTs, baselineMissing, winRate, netPnl, tradeCount, avgR,
      openCount: openTrades.length,
    },
    equityCurve,
    openPositions,
    recentClosed,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run v2/dashboard/monitorSummary.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add v2/dashboard/monitorSummary.ts v2/dashboard/monitorSummary.test.ts
git commit -m "feat(monitor): pure summary builder for read-only dashboard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W4aHCMZyXSsnw5mjCzEUws"
```

---

## Task 2: Wire the read-only endpoint

**Files:**
- Modify: `v2/dashboard/attributionAPI.ts` (add route + import)

**Interfaces:**
- Consumes: `buildMonitorSummary`, `MonitorSummary` (Task 1); `getV2Status` (already imported), `getOpenTrades` (already imported), `getDb` (already imported).
- Produces: `GET /api/v2/monitor/summary` → `MonitorSummary` JSON.

- [ ] **Step 1: Add the import**

At the top of `v2/dashboard/attributionAPI.ts`, alongside the existing imports, add:

```ts
import { buildMonitorSummary } from './monitorSummary.ts';
```

- [ ] **Step 2: Add the route**

Immediately after the existing `v2Router.get('/status', ...)` handler, add:

```ts
// --- GET /monitor/summary --- read-only composite for the monitoring GUI
v2Router.get('/monitor/summary', (_req: Request, res: Response) => {
  try {
    const status = getV2Status();
    const openTrades = getOpenTrades();

    const db = getDb();
    const baselineRow = db
      .prepare("SELECT value FROM settings WHERE key = 'stats_baseline_time'")
      .get() as { value?: string } | undefined;
    const baselineMissing = !baselineRow || baselineRow.value == null;
    const baselineTs = baselineMissing ? 0 : Number(baselineRow!.value);

    // Cohort = closed v2_trades with entry_time >= baseline (per standing rule).
    const rows = db
      .prepare(
        "SELECT ticker, strategy, side, entry_price, exit_price, entry_time, exit_time, " +
        "pnl_net, exit_reason, quantity, initial_stop, position_size_usd, current_stop, take_profit_target " +
        "FROM v2_trades WHERE status = 'closed' AND entry_time >= @baselineTs ORDER BY exit_time DESC"
      )
      .all({ baselineTs }) as Record<string, unknown>[];

    // Map raw rows to the subset of V2Trade fields buildMonitorSummary reads.
    const cohortClosed = rows.map((r) => ({
      ticker: r.ticker as string,
      strategy: (r.strategy as string) ?? 'TREND',
      side: (r.side as string) ?? 'long',
      entryPrice: r.entry_price as number,
      exitPrice: (r.exit_price as number) ?? null,
      entryTime: r.entry_time as number,
      exitTime: (r.exit_time as number) ?? null,
      pnlNet: (r.pnl_net as number) ?? 0,
      exitReason: (r.exit_reason as string) ?? null,
      quantity: (r.quantity as number) ?? 0,
      initialStop: (r.initial_stop as number) ?? 0,
      positionSizeUsd: (r.position_size_usd as number) ?? 0,
      currentStop: (r.current_stop as number) ?? 0,
      takeProfitTarget: (r.take_profit_target as number) ?? 0,
    })) as any;

    const summary = buildMonitorSummary({
      status, openTrades, cohortClosed,
      baselineTs, baselineMissing, now: Date.now(),
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no NEW errors referencing `attributionAPI.ts` or `monitorSummary.ts`. (Pre-existing repo errors elsewhere are out of scope — note them but don't fix.)

- [ ] **Step 4: Smoke-test locally (best effort)**

If a local instance can run: `node --experimental-strip-types serverV2.ts` then
`curl -s localhost:3033/api/v2/monitor/summary | head -c 400`
Expected: JSON beginning `{"asOf":`. If the local env can't boot the engine, defer verification to the VPS in Task 5 and note it.

- [ ] **Step 5: Commit**

```bash
git add v2/dashboard/attributionAPI.ts
git commit -m "feat(monitor): add read-only GET /api/v2/monitor/summary endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W4aHCMZyXSsnw5mjCzEUws"
```

---

## Task 3: Frontend dashboard + route

**Files:**
- Create: `public/monitor.html`
- Modify: `serverV2.ts` (add `/monitor` route before the catch-all)

**Interfaces:**
- Consumes: `GET /api/v2/monitor/summary` (Task 2).
- Produces: `GET /monitor` → serves `public/monitor.html`.

- [ ] **Step 1: Add the `/monitor` route in `serverV2.ts`**

In `serverV2.ts`, BEFORE the catch-all `app.get('*', ...)` (currently line ~108), add:

```ts
// Read-only monitoring dashboard (source-controlled; not part of the vite build)
app.get('/monitor', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'monitor.html'));
});
```

(`join` is already imported in `serverV2.ts`.)

- [ ] **Step 2: Create `public/monitor.html`**

Create `public/monitor.html` with a self-contained dashboard. All CSS/JS inline, no external requests. It must render an explicit empty-state and error-state.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CRYPTO_GOD — Monitor</title>
<style>
  :root { --bg:#0d0f1a; --panel:#151827; --line:#232741; --txt:#e6e8f0; --dim:#8a90ab;
          --green:#28c76f; --red:#ff5b5b; --accent:#5b8cff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:20px; }
  header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:18px; }
  h1 { font-size:18px; margin:0; letter-spacing:.5px; }
  .badge { padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge.paper { background:#2a2f52; color:var(--accent); }
  .badge.live { background:#3a2130; color:var(--red); }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
  .dot.ok { background:var(--green); } .dot.bad { background:var(--red); }
  .muted { color:var(--dim); font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .tile .k { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  .tile .v { font-size:22px; font-weight:600; margin-top:4px; }
  .pos { color:var(--green); } .neg { color:var(--red); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:18px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--dim); margin:0 0 10px; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; min-width:640px; }
  th,td { text-align:right; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child,td:first-child { text-align:left; }
  th { color:var(--dim); font-weight:500; }
  .empty { color:var(--dim); padding:16px; text-align:center; }
  .err { background:#3a2130; color:#ffb4b4; border:1px solid #5c2b3a; border-radius:8px;
         padding:10px 14px; margin-bottom:14px; display:none; }
  svg { width:100%; height:120px; display:block; }
</style>
</head>
<body>
<div class="wrap">
  <div id="err" class="err"></div>
  <header>
    <h1>CRYPTO_GOD</h1>
    <span id="mode" class="badge paper">—</span>
    <span><span id="dot" class="dot bad"></span> <span id="health">connecting…</span></span>
    <span style="flex:1"></span>
    <span class="muted" id="asof">—</span>
  </header>

  <div class="grid" id="tiles"></div>

  <div class="panel">
    <h2>Equity curve — current cohort (realized net PnL)</h2>
    <div id="equity"></div>
  </div>

  <div class="panel">
    <h2>Open positions</h2>
    <div class="scroll"><table id="open"></table></div>
  </div>

  <div class="panel">
    <h2>Recent closed — since baseline</h2>
    <div class="scroll"><table id="closed"></table></div>
  </div>
</div>

<script>
const fmtUsd = n => (n>=0?'+':'') + '$' + Math.abs(n).toFixed(2);
const fmtPct = n => n==null ? '—' : (n*100).toFixed(1) + '%';
const fmtNum = (n,d=2) => n==null ? '—' : Number(n).toFixed(d);
const ago = ms => { const s=Math.floor(ms/1000); if(s<60)return s+'s'; const m=Math.floor(s/60);
  if(m<60)return m+'m'; const h=Math.floor(m/60); return h+'h'+(m%60)+'m'; };
const cls = n => n>0?'pos':n<0?'neg':'';

function tiles(s) {
  const c = s.cohort;
  const rows = [
    ['Balance', '$' + fmtNum(s.account.balance), ''],
    ['Net PnL (cohort)', fmtUsd(c.netPnl), cls(c.netPnl)],
    ['Win rate', fmtPct(c.winRate), ''],
    ['Trades', String(c.tradeCount), ''],
    ['Open', String(c.openCount), ''],
    ['Avg R', c.avgR==null?'—':fmtNum(c.avgR), c.avgR==null?'':cls(c.avgR)],
  ];
  document.getElementById('tiles').innerHTML = rows.map(([k,v,cl]) =>
    `<div class="tile"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`).join('');
}

function equity(curve) {
  const el = document.getElementById('equity');
  if (!curve.length) { el.innerHTML = '<div class="empty">No closed trades since baseline yet.</div>'; return; }
  const W=1000, H=120, pad=6;
  const ys = curve.map(p=>p.cumPnl), min=Math.min(0,...ys), max=Math.max(0,...ys);
  const rng = (max-min)||1;
  const x = i => pad + i*(W-2*pad)/Math.max(1,curve.length-1);
  const y = v => H-pad - (v-min)/rng*(H-2*pad);
  const pts = curve.map((p,i)=>`${x(i).toFixed(1)},${y(p.cumPnl).toFixed(1)}`).join(' ');
  const last = ys.at(-1);
  const color = last>=0 ? 'var(--green)' : 'var(--red)';
  const zeroY = y(0).toFixed(1);
  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
       <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--line)"/>
       <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
     </svg>`;
}

function openTable(rows) {
  const t = document.getElementById('open');
  if (!rows.length) { t.innerHTML = '<tr><td class="empty">No open positions.</td></tr>'; return; }
  t.innerHTML =
    '<tr><th>Ticker</th><th>Strategy</th><th>Side</th><th>Entry</th><th>Size $</th><th>Stop</th><th>Target</th><th>Held</th></tr>' +
    rows.map(r=>`<tr><td>${r.ticker}</td><td>${r.strategy}</td><td>${r.side}</td>
      <td>${fmtNum(r.entry,4)}</td><td>${fmtNum(r.positionSizeUsd)}</td>
      <td>${fmtNum(r.stop,4)}</td><td>${fmtNum(r.target,4)}</td><td>${ago(r.heldMs)}</td></tr>`).join('');
}

function closedTable(rows) {
  const t = document.getElementById('closed');
  if (!rows.length) { t.innerHTML = '<tr><td class="empty">No trades since baseline yet.</td></tr>'; return; }
  t.innerHTML =
    '<tr><th>Ticker</th><th>Strategy</th><th>Entry</th><th>Exit</th><th>Net PnL</th><th>Outcome</th><th>Reason</th><th>When</th></tr>' +
    rows.map(r=>`<tr><td>${r.ticker}</td><td>${r.strategy}</td>
      <td>${fmtNum(r.entry,4)}</td><td>${r.exit==null?'—':fmtNum(r.exit,4)}</td>
      <td class="${cls(r.pnlNet)}">${fmtUsd(r.pnlNet)}</td>
      <td class="${r.outcome==='WIN'?'pos':r.outcome==='LOSS'?'neg':''}">${r.outcome}</td>
      <td>${r.reason||'—'}</td>
      <td>${r.exitTs?new Date(r.exitTs).toISOString().slice(5,16).replace('T',' '):'—'}</td></tr>`).join('');
}

function render(s) {
  document.getElementById('err').style.display = 'none';
  const mode = document.getElementById('mode');
  mode.textContent = (s.status.mode||'—').toUpperCase();
  mode.className = 'badge ' + (s.status.mode==='live'?'live':'paper');
  const healthy = s.status.isRunning && !s.status.stale;
  document.getElementById('dot').className = 'dot ' + (healthy?'ok':'bad');
  document.getElementById('health').textContent =
    (s.status.isRunning ? (s.status.stale ? 'running (stale loop)' : 'running') : 'stopped')
    + ' · regime ' + s.status.regime;
  document.getElementById('asof').textContent =
    'updated ' + new Date(s.asOf).toISOString().slice(11,19) + ' UTC'
    + (s.cohort.baselineMissing ? ' · ⚠ no baseline set' : '');
  tiles(s); equity(s.equityCurve); openTable(s.openPositions); closedTable(s.recentClosed);
}

async function tick() {
  try {
    const r = await fetch('/api/v2/monitor/summary', { cache:'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
  } catch (e) {
    const el = document.getElementById('err');
    el.textContent = 'Can\'t reach backend — retrying… (' + e.message + ')';
    el.style.display = 'block';
    document.getElementById('dot').className = 'dot bad';
    document.getElementById('health').textContent = 'disconnected';
  }
}
tick();
setInterval(tick, 10_000);
</script>
</body>
</html>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors from `serverV2.ts`.

- [ ] **Step 4: Commit**

```bash
git add public/monitor.html serverV2.ts
git commit -m "feat(monitor): self-contained dashboard page + /monitor route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W4aHCMZyXSsnw5mjCzEUws"
```

---

## Task 4: Infra — nginx + TLS + basic-auth + firewall (VPS, one-time)

**Files (on VPS):**
- Create: `/etc/nginx/sites-available/monitor` (+ symlink into `sites-enabled/`)
- Create: `/etc/nginx/.htpasswd`
- Modify: `ufw` rules

**Interfaces:**
- Consumes: Node listening on `127.0.0.1:3033` (already does, on `*:3033`).
- Produces: `https://VPS_HOST_REDACTED.sslip.io` (TLS + basic-auth) → proxy to `:3033`.

> Run these over SSH: `ssh root@VPS_HOST_REDACTED`. This task ships no repo code — verify each step's output before the next.

- [ ] **Step 1: Install nginx + certbot**

```bash
apt-get update && apt-get install -y nginx certbot python3-certbot-nginx apache2-utils
```
Expected: installs cleanly; `systemctl is-active nginx` → `active`.

- [ ] **Step 2: Create the basic-auth password file**

```bash
htpasswd -bc /etc/nginx/.htpasswd admin 'CHOOSE_A_STRONG_PASSWORD'
```
(Replace the password. Tell Joseph the username/password out-of-band; do not commit them.)
Expected: `Adding password for user admin`.

- [ ] **Step 3: Create the nginx site (HTTP first, for the ACME challenge)**

```bash
cat > /etc/nginx/sites-available/monitor <<'NGINX'
server {
    listen 80;
    server_name VPS_HOST_REDACTED.sslip.io;
    location / {
        auth_basic "CRYPTO_GOD Monitor";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3033;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/monitor /etc/nginx/sites-enabled/monitor
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```
Expected: `nginx -t` → syntax ok / test successful.

- [ ] **Step 4: Verify HTTP proxy + auth works before TLS**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://VPS_HOST_REDACTED.sslip.io/monitor            # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -u admin:PASSWORD http://VPS_HOST_REDACTED.sslip.io/monitor  # expect 200
```
Expected: `401` then `200`.

- [ ] **Step 5: Issue the Let's Encrypt cert (certbot rewrites the site to 443 + redirect)**

```bash
certbot --nginx -d VPS_HOST_REDACTED.sslip.io --non-interactive --agree-tos -m manijose1919@gmail.com --redirect
nginx -t && systemctl reload nginx
```
Expected: "Successfully received certificate"; certbot adds the `listen 443 ssl` block and an 80→443 redirect. `auth_basic` lines are preserved in the server block.

- [ ] **Step 6: Verify HTTPS + trusted cert + auth**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://VPS_HOST_REDACTED.sslip.io/monitor            # 401
curl -s -o /dev/null -w "%{http_code}\n" -u admin:PASSWORD https://VPS_HOST_REDACTED.sslip.io/monitor  # 200
curl -s -u admin:PASSWORD https://VPS_HOST_REDACTED.sslip.io/api/v2/monitor/summary | head -c 200      # JSON
```
Expected: `401`, `200`, then JSON beginning `{"asOf":`.

- [ ] **Step 7: Close public port 3033 (and unused 3000/3080); keep 443 + 22**

```bash
ufw allow 443/tcp
ufw delete allow 3033/tcp
ufw delete allow 3000/tcp
ufw delete allow 3080/tcp
ufw status
```
Expected: `status` shows `22`, `80`, `443` allowed; `3033/3000/3080` gone. Confirm the app still works via HTTPS (re-run Step 6). Confirm SSH session stays alive.

> No git commit in this task — these are server-side config files, not repo files. Record exact final nginx config content in the Task 5 changelog entry for reproducibility.

---

## Task 5: Changelog, deploy, live verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

Add at the TOP of `CHANGELOG.md` (below the `---` after "How to use"), using the file's template:

```markdown
## 2026-07-23 — Read-only monitoring dashboard + HTTPS URL — local-claude

**Commits:** <fill with the Task 1-3 + this SHAs>
**Files changed:** `v2/dashboard/monitorSummary.ts`, `v2/dashboard/monitorSummary.test.ts`, `v2/dashboard/attributionAPI.ts`, `public/monitor.html`, `serverV2.ts`, `CHANGELOG.md`
**Stats baseline reset:** no — monitoring/infra change, not a trading-config change.

**What changed:**
New read-only monitoring GUI at https://VPS_HOST_REDACTED.sslip.io (Let's Encrypt cert, HTTP basic-auth). Backed by GET /api/v2/monitor/summary on the existing v2Router — engine status/balance/regime from getV2Status(), open positions from getOpenTrades(), and current-cohort KPIs/equity/closed-log from v2_trades filtered by entry_time >= stats_baseline_time. Single self-contained public/monitor.html polls every 10s.

VPS infra (one-time, not in repo): nginx reverse proxy on 443 with auth_basic → 127.0.0.1:3033; ufw now closes public 3033/3000/3080, leaving only 22/80/443. nginx site file content:
<paste final /etc/nginx/sites-available/monitor here>

**Why:**
Provide a clean, professional, password-gated monitoring surface without exposing the sprawling dev dashboard or a raw IP:port. Read-only by design — no route can move money.

**What to monitor / watch for:**
- https://VPS_HOST_REDACTED.sslip.io/monitor prompts for password, then loads; empty-cohort renders (cohort is currently 0 trades since 2026-07-22 baseline).
- /api/v2/monitor/summary returns JSON; balance matches getV2Status().portfolioCash.
- Cert auto-renew: `certbot renew --dry-run` succeeds.
- Rollback: `ufw allow 3033/tcp` to restore direct access; `rm /etc/nginx/sites-enabled/monitor && systemctl reload nginx` to drop the proxy; `git revert` the code commits.
```

- [ ] **Step 2: Commit the changelog**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): read-only monitoring dashboard + HTTPS URL

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W4aHCMZyXSsnw5mjCzEUws"
```

- [ ] **Step 3: Deploy to BOTH remotes**

Run: `bash scripts/push-deploy.sh`
Expected: pushes to `origin` + `vps`, VPS hook runs `npm install` + `npx vite build` + `pm2 restart`, script confirms deployed SHA matches pushed SHA and API is back online.

- [ ] **Step 4: Final live verification**

```bash
# from local:
curl -s -u admin:PASSWORD https://VPS_HOST_REDACTED.sslip.io/api/v2/monitor/summary | head -c 300
```
Then open `https://VPS_HOST_REDACTED.sslip.io/monitor` in a browser: confirm padlock (trusted cert), password prompt, dashboard loads, mode badge reads "PAPER", empty-cohort states render (not blank), health dot reflects engine state.

Cross-check one number: `ssh root@VPS_HOST_REDACTED "sqlite3 /opt/trading-bot/data/trading.db \"SELECT COUNT(*) FROM v2_trades WHERE status='closed' AND entry_time >= 1784740967690;\""` should equal the dashboard's "Trades" tile.

- [ ] **Step 5: Confirm done**

Report the live URL + credentials location to Joseph. Done.

---

## Self-Review

**Spec coverage:**
- Summary strip (status/balance/asOf) → Task 1 payload + Task 3 header/tiles. ✓
- Cohort KPI tiles (WR, net PnL, count, open, avg R; baseline-filtered) → Task 1 `cohort` + Task 2 query. ✓
- Equity curve → Task 1 `equityCurve` + Task 3 SVG. ✓
- Open positions table → Task 1 `openPositions` + Task 3 (live current-price/unrealized PnL deliberately deferred; documented). ✓ (partial, flagged)
- Recent closed table → Task 1 `recentClosed` + Task 3. ✓
- Engine health (running/stale/regime) → Task 1 `status` + Task 3. ✓
- HTTPS via sslip.io + Let's Encrypt → Task 4. ✓
- Basic-auth password → Task 4. ✓
- Close public 3033 → Task 4 Step 7. ✓
- Empty-cohort + error states → Task 1 tests + Task 3 render. ✓
- Unit tests (baseline boundary, empty cohort, equity accumulation, mapping, missing baseline) → Task 1. ✓
- No stats-baseline reset; changelog entry → Task 5. ✓

**Placeholder scan:** One intentional placeholder in Task 1 Step 1 (`i => i`) with an explicit inline replacement instruction. Passwords shown as `PASSWORD`/`CHOOSE_A_STRONG_PASSWORD` are secrets-by-design, not plan gaps.

**Type consistency:** `buildMonitorSummary(MonitorDeps): MonitorSummary` used identically in Tasks 1 & 2. Field names (`portfolioCash`, `htfRegimes`, `lastLoopTime`, `entryPrice`, `currentStop`, `takeProfitTarget`, `pnlNet`, `initialStop`, `positionSizeUsd`) match the verified `V2EngineStatus` and `V2Trade`/`rowToTrade` sources. Endpoint path `/api/v2/monitor/summary` consistent across Tasks 2, 3, 4, 5.

**Deviation from spec (flagged for user):** open-position **current price / unrealized PnL** deferred from v1 — requires wiring the live exchange adapter into a read-only endpoint (extra failure surface). Realized PnL (closed trades) fully covered. Easy follow-up if wanted.
