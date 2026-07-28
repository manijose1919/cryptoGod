# Repository Documentation and Cleanup — Design

**Date:** 2026-07-28
**Author:** local-claude (with Joseph)
**Status:** Approved. Amended 2026-07-28 (see "Amendment: CI and type errors").
**Plan:** `docs/superpowers/plans/2026-07-28-repo-documentation-and-cleanup.md`

---

## Amendment: CI and type errors (2026-07-28)

Measuring the baseline gate revealed a condition this spec did not account for.
**CI has been failing on every run** — the last five GitHub Actions runs are all
`failure` — because `.github/workflows/ci.yml` runs `npx tsc --noEmit`, which exits 2
with **157 type errors**. `npx vitest run` (18/18) and `npx vite build` both pass; only
the type check fails.

This breaks two things in the design as written. Success criterion 5 ("all three gates
pass after every commit") is unmeetable, because they do not pass now. And Part 1's
badge row would render a bright red CI badge on a portfolio repository — worse than no
badge.

The error inventory: 69 unused declarations (TS6133), 48 untyped `.js` import errors
(TS7016), 22 other cosmetic errors, and **18 substantive ones** — possibly-`undefined`
access and genuine type mismatches, including `trade.peakPrice` in
`v2/pipeline/momentumExitManager.ts`, which is live exit logic.

**Approved resolution: fix all 157 properly.** No `tsconfig` relaxation and no
`continue-on-error` in CI — both would produce a green badge that no longer means the
code type-checks. Ambient declarations are written for the untyped `services/*.js`
modules, the substantive errors are investigated individually, and the cosmetic ones
are cleared by removing dead declarations and annotating implicit parameters.

Success criterion 5 is restated: **all three gates pass from Task 7 onward.** Tasks 1
and 2 are measured against the 157-error baseline, not against zero.

This does not alter the no-trading-change constraint. The `momentumExitManager` fix
preserves existing behaviour for every trade that has `peakPrice` set; it only defines
what happens in the case that was previously undefined.

---

## Goal

Make the `cryptoGod` repository read as a serious engineering project to a technical
reader, and make it safe to publish. Today the repository fails both tests: the README
is unmodified Google AI Studio scaffolding, three separate sources disagree about what
the system even runs, and the live VPS address is committed in both the working tree
and history.

Success criteria:

1. A reader who has never seen the project understands what it does, how it is built,
   and how to run it, within two minutes of opening the README.
2. Every "how to run this" statement in the repository agrees with what PM2 actually
   executes.
3. No VPS address remains in the working tree or in git history.
4. The repository contains no stack that nothing runs.
5. `npx tsc --noEmit`, `npx vitest run`, and `npx vite build` pass after every commit.

Explicit non-goal: no trading behaviour changes. No strategy, threshold, gate, or
config value is touched. Per the standing rule in `CLAUDE.md`, **no stats baseline
reset** — this work cannot affect trade-level expected outcomes.

---

## Findings that drive the design

These were established by inspection before any design work.

### The README describes a different project

`README.md` is the untouched Google AI Studio template. It carries a stock banner
image, the heading "Run and deploy your AI Studio app", a link to an ai.studio drive
app, and instructions to set `GEMINI_API_KEY`. The actual system is a Kraken trading
engine that authenticates with Anthropic and Kraken. Nothing in the current README is
true.

### Three sources disagree about the entry point

| Source | Claims the system starts with |
|---|---|
| `ecosystem.config.cjs` (PM2 — authoritative) | `serverV2.ts` under `node --experimental-strip-types` |
| `package.json` `npm start` | `python canuck-trader-pro/backend/main.py` |
| `CLAUDE.md` Architecture section | `node server.js` |

PM2 is the source of truth because it is what runs on the VPS. The other two send a
reader down dead paths. Self-contradicting documentation is worse than none, because
it costs the reader time before it costs them trust.

### `server.js` is orphaned; `services/` is not

`server.js` is 418KB and **imported by nothing**. Every occurrence of the string
`server.js` elsewhere in the codebase is inside a comment, not an import statement.

`services/` is a different case and must be kept. `serverV2.ts` statically imports
`database.js`, `fearGreedGate.js`, `krakenWebsocketService.js`, and
`telegramService.js` from it, and dynamically imports `mlPredictionService.js`,
`mlGatekeeper.js`, `systemConfig.js`, `derivativesIntelligence.js`, and
`whaleFlowTracker.js`. The services survived the V2 rewrite even though their original
host did not. Treating the whole directory as legacy would break the live system.

`canuck-trader-pro/` is an 89-file parallel Python backend. No Node module imports it,
and PM2 does not run it. It is referenced only by `package.json` scripts,
`docker-compose.yml`, `prometheus/prometheus.yml`, and the `deploy/` scripts.

### Secret exposure is narrower than feared

No credentials appear anywhere in 485 commits. `.env` and `.env.local` were never
committed. There are no `sk-ant-` keys and no Kraken secrets. The single
`TELEGRAM_BOT_TOKEN=` match in history is `.env.example` carrying the placeholder
value `your_telegram_bot_token`. The `.gitignore` did its job.

The one real exposure is the VPS address `VPS_HOST_REDACTED`, including the form
`root@VPS_HOST_REDACTED`, present in 10 tracked files and 10 commits. An IP is not a
credential, but publishing "the root SSH box running a money-handling bot is at this
address" is an invitation to brute-force scanning.

---

## Design

### Part 1 — `README.md` rewrite

Complete replacement. Section order, chosen so the highest-value information is above
the fold:

1. Title, one-line positioning, badge row (CI status, license, Node 20, TypeScript)
2. What it is — honest, including that the engine runs in paper mode
3. Risk disclaimer — prominent and early, not buried at the bottom
4. Architecture diagram
5. The V2 pipeline: market scan → signal generation → risk gate → executor → exit manager
6. Tech stack table
7. Quickstart
8. Project layout
9. Documentation index
10. License

The architecture diagram is a Mermaid code block, not an image. GitHub renders Mermaid
natively, so the diagram needs no binary asset, stays diffable, and cannot drift out of
sync with a checked-in PNG that nobody remembers to regenerate.

Any performance figure in the README is quoted from `docs/reviews/` or `CHANGELOG.md`
and labelled paper-trading or backtest at the point of use. No figure is estimated,
rounded for effect, or carried over from memory.

### Part 2 — New documents

| File | Purpose |
|---|---|
| `LICENSE` | Proprietary / All Rights Reserved. The repository is readable as a portfolio piece; the trading logic is not licensed for reuse. |
| `docs/ARCHITECTURE.md` | Accurate system design: process model, V2 engine internals, data flow, persistence, deployment topology. |
| `docs/README.md` | Index for the 13 existing plan, spec, review, and runbook documents, which currently have no entry point. |

Deliberately excluded: `CONTRIBUTING.md`, issue templates, PR templates, and
`SECURITY.md`. On a single-author repository these are ceremony. Including them signals
that a checklist was followed rather than that a judgement was made.

### Part 3 — Drift fixes

`package.json`: correct `name` and `description`; point `start` at
`node --experimental-strip-types serverV2.ts` so it matches `ecosystem.config.cjs`;
remove the Python `dev` and `start` variants along with the stack they invoke.

`CLAUDE.md`: surgical correction to the Architecture section only. The rest of the file
stands.

### Part 4 — Junk removal

Untrack `next _step_evolution.txt` (a scratch file, with a space in its name) and
`canuck-trader-pro/data/trading.db-shm` and `-wal` (SQLite write-ahead temp files that
should never have been committed).

Extend `.gitignore` with `*.db-shm`, `*.db-wal`, `*.tar.gz`, `*.tar`, `*.log`.

Local untracked clutter — `deploy.tar.gz`, `deploy-bundle.tar`, `canuck-trader.log`,
and the root `.txt` scratch files — is **gitignored, not deleted**. These are not on
GitHub and were never in scope; removing a user's untracked files uninvited is
destructive and outside the request.

### Part 5 — Dead stack retirement

Remove `server.js` and `canuck-trader-pro/`, and the references to the latter in
`docker-compose.yml`, `prometheus/prometheus.yml`, and `deploy/`.

Gate: `npx tsc --noEmit`, `npx vitest run`, and `npx vite build` must pass both before
and after. Capturing the before-state matters — if any of the three is already failing,
that is pre-existing and must be reported as such rather than attributed to this work.

Git history retains both stacks, so this is recoverable.

### Part 6 — History purge

Ordered last, so that everything else is committed and pushed before any SHA changes.

1. `git bundle create ../cryptogod-backup-2026-07-28.bundle --all` — full recoverable backup
2. `git filter-repo --replace-text` mapping `VPS_HOST_REDACTED` to the literal token
   `VPS_HOST_REDACTED`, applied to both the bare address and the `root@VPS_HOST_REDACTED` form
3. Re-add `origin` and `vps` remotes — `git filter-repo` removes remotes by design
4. Force-push both
5. Verify the VPS deploy recovered and the API is serving

**Accepted cost:** every commit SHA changes. `CHANGELOG.md` cites SHAs (`6617d40`,
`2a96f56`, and others) as its audit trail, and those references become dangling. This
was raised before approval and accepted. Mitigation: a dated note at the top of
`CHANGELOG.md` recording that history was rewritten on 2026-07-28 and why, so a future
reader encountering an unresolvable SHA finds an explanation instead of a mystery.

The complementary mitigation is server-side and outside this repository: SSH key-only
authentication and fail2ban on the VPS. Redacting the address raises the cost of
finding the box; it does not harden the box.

### Part 7 — GitHub metadata

Set repository description and topics via `gh`. Current description is one generic
line; there are no topics.

---

## Commit sequence

One logical change per commit, so any piece can be reverted independently.

1. Junk removal and `.gitignore`
2. Dead stack retirement, with build verification
3. Drift fixes — `package.json`, `CLAUDE.md`
4. Documentation — README, LICENSE, ARCHITECTURE, docs index, VPS address scrub
5. Push both remotes via `scripts/push-deploy.sh`, verify deployed SHA
6. History purge
7. GitHub metadata
8. `CHANGELOG.md` entry

Steps 1–4 are ordinary commits. Step 5 is the checkpoint: everything valuable is
landed and deployed before step 6 rewrites anything.

---

## Risks

| Risk | Mitigation |
|---|---|
| Deleting `canuck-trader-pro/` breaks the Vite build via an unnoticed import | Build gate before and after; revert the commit if it fails |
| Force-push corrupts the VPS deploy | Backup bundle taken first; `push-deploy.sh` verifies the deployed SHA; PM2 has `autorestart` |
| `git filter-repo` is not installed on Windows | Confirm availability before starting Part 6; Parts 1–5 are independent and already pushed if it is unavailable |
| Live bot restarts during deploy | Engine runs `V2_MODE: paper` and `PAIRS_MODE: paper`, so a restart carries no capital risk |
| Stale SHA references in `CHANGELOG.md` | Dated explanatory note at the top of the file |
