This file exists because LLMs make predictable mistakes when writing code. Not random mistakes. The same ones, over and over. I've watched it happen enough times to write them down.

These are not suggestions. These are rules. Follow them and you'll produce code that doesn't need to be rewritten. Ignore them and you'll produce code that looks impressive and breaks in production.

## 1. Read Before You Write

The single biggest source of bad LLM code is not reading the existing codebase before writing new code. You see a task, you pattern-match to something in your training data, and you start generating. This is almost always wrong.

Before writing anything:

- Read the files you're about to modify. Not skim. Read.
- Look at how similar things are done elsewhere in the project. If there's a pattern for API routes, follow that pattern. If there's a utility function that does half of what you need, use it.
- Check the imports at the top of the file. They tell you what libraries this project actually uses. Don't introduce axios if the project uses fetch everywhere. Don't introduce lodash if the project uses native methods.
- Look at the test files. They tell you what the expected behavior actually is, not what you think it should be.

The failure mode here is obvious: you generate "correct" code that's completely alien to the codebase it lives in. It works but it looks like a different person wrote it (because a different entity did). The human then has to either rewrite it to match the project style or live with inconsistency forever. Both are bad.

If you're not sure how something is done in this project, say so. "I don't see a pattern for X in the codebase, should I follow the approach in Y or do something different?" is always better than guessing.

## 2. Think Before You Code

Don't start writing code until you've figured out what you're actually doing. This sounds obvious but it's the most common failure mode.

What this looks like in practice:

**State your assumptions.** If the user says "add authentication" that could mean session cookies, JWTs, OAuth, basic auth, or five other things. Don't pick one silently. Say "I'm assuming you want JWT-based auth with refresh tokens, stored in httpOnly cookies. If you want something different, let me know." If you're wrong, you've lost 10 seconds. If you silently guess wrong, you've lost an hour.

**Name the tradeoffs.** Almost every implementation choice has a tradeoff. If you're adding caching, say "this trades memory for speed and introduces cache invalidation as a thing we now have to think about." The user might say "actually I don't want that complexity." Better to know before you write 200 lines.

**If multiple approaches exist, present them briefly.** Not five. Two, maybe three. With a recommendation. "There are two ways to do this. Option A is simpler but doesn't handle edge case X. Option B handles everything but adds a dependency on Z. I'd go with A unless you expect X to actually happen."

**If something is confusing, stop.** Don't fill confusion with plausible-sounding code. The result of generating code when you don't understand the requirements is code that passes a casual review but fails when it matters. Just say what's confusing and ask.

## 3. Simplicity

Write the minimum amount of code that solves the problem. Not the minimum amount of code you can imagine theoretically solving the problem. The minimum amount that actually solves this specific problem right now.

The instinct to over-engineer is strong. Resist it. Here's what over-engineering looks like in practice:

**Premature abstraction.** You need to send one type of email. You write an EmailService class with a strategy pattern that supports multiple providers, template engines, and retry policies. The user wanted `sendWelcomeEmail(user)`. Write that function. If they need more later, they'll ask.

```python
# bad: you wrote this
class EmailService:
    def __init__(self, provider: EmailProvider, template_engine: TemplateEngine):
        self.provider = provider
        self.template_engine = template_engine

    async def send(self, template: str, context: dict, recipient: str, **kwargs):
        rendered = self.template_engine.render(template, context)
        await self.provider.send(recipient, rendered, **kwargs)

# good: you should have written this
async def send_welcome_email(user):
    body = f"Welcome {user.name}! Your account is ready."
    await send_email(to=user.email, subject="Welcome", body=body)
```

**Speculative error handling.** You wrap everything in try/catch blocks for errors that can't happen. You validate inputs that come from your own code and are already validated upstream. You add null checks on values that are never null. Every line of error handling is a line someone has to read and understand. Only handle errors that can actually occur.

**Unnecessary configurability.** You make the batch size a parameter. You make the retry count configurable. You add environment variables for things that will never change. Configuration is not free. Every config option is a decision someone has to make and a value someone has to set correctly. Hardcode things until there's a real reason not to.

**Dead flexibility.** Interfaces with one implementation. Abstract base classes with one child. Generic type parameters that are only ever instantiated with one type. These things have a cost (cognitive overhead, indirection, more files to navigate) and zero benefit until a second implementation actually exists.

The test for simplicity: show your code to someone unfamiliar with the project. If they have to ask "why is this abstracted like this?" and the answer is "in case we need to..." then you've over-engineered it. "In case we need to" is not a requirement. It's a guess about the future, and guesses about the future are usually wrong.

## 4. Surgical Changes

When you edit existing code, your diff should be as small as possible. Every line you change is a line that could introduce a bug, a line someone has to review, and a line that shows up in git blame forever.

Rules:

**Don't touch what you weren't asked to touch.** If you're fixing a bug in function A and you notice function B has a weird variable name, leave it. If function C has a comment with a typo, leave it. If the import order doesn't match your preference, leave it. Your job is to fix the bug in function A.

**Match the existing style.** If the file uses single quotes, use single quotes. If the file uses `snake_case`, use `snake_case`. If the file has no semicolons, don't add semicolons. If the file uses `var` (yes, even in 2025), use `var` in your additions unless the user asked you to modernize. Consistency within a file beats your personal preference.

**Clean up after yourself, not after others.** If your change makes an import unused, remove that import. If your change makes a variable unused, remove that variable. If your change makes a function unused, remove that function. But only if YOUR change caused it. Pre-existing dead code is not your problem unless someone asked you to clean it up.

**Don't reformat.** Don't run prettier on a file that wasn't formatted with prettier. Don't change indentation from 4 spaces to 2. Don't reorder imports alphabetically if they weren't alphabetical before. Reformatting creates massive diffs that hide your actual changes and make code review painful.

The test: look at your diff. Can you justify every single changed line with a direct connection to what was asked? If any line is there because "while I was in there I thought I'd..." then revert it.

## 5. Verification

The difference between code that works and code you think works is testing. You should be paranoid about this distinction.

**Write the test first when fixing bugs.** Before you fix anything, write a test that reproduces the bug. Run it. Watch it fail. Then fix the bug. Run the test. Watch it pass. This is not optional and not TDD dogma. It's the only way to prove you actually fixed the thing and didn't just make the symptoms go away.

**Run existing tests before and after your changes.** If tests passed before your change and fail after, you broke something. This is obvious. What's less obvious: if tests were already failing before your change, say so. Don't silently ignore pre-existing failures and let your changes get blamed for them.

**Don't write tests for the sake of writing tests.** A test that checks whether a constructor sets properties is worthless. A test that checks whether your validation actually rejects bad input is valuable. Test behavior, not implementation. Test the interesting cases, not the trivial ones.

**If you can't write a test, say why.** Sometimes the architecture makes testing hard. That's useful information. "I can't easily test this because the database calls are tightly coupled to the business logic" is a signal that something might need to be restructured. Don't just skip testing and hope.

## 6. Goal-Driven Execution

Every task should have a clear success criterion before you start writing code. If the criterion is vague, make it specific. If you can't make it specific, ask.

Transform vague tasks into verifiable ones:

- "Add validation" becomes "reject inputs where email is missing or invalid, return 400 with a message that says what's wrong, add tests for both cases"
- "Fix the bug" becomes "write a test that reproduces the reported behavior, make the test pass, verify existing tests still pass"
- "Improve performance" becomes "profile first, identify the bottleneck, fix that specific thing, measure again"

For anything that takes more than one step, state the plan before executing:

```
Plan:
1. Add the new database column with a migration
2. Update the model to include the new field
3. Modify the API endpoint to accept and return the field
4. Add validation for the field
5. Write tests for the new behavior
6. Run full test suite to check for regressions
```

This does two things: it lets the user catch mistakes in your approach before you waste time implementing them, and it forces you to actually think through the steps instead of just diving in and figuring it out as you go.

## 7. Debugging

When something doesn't work, don't guess. Investigate.

**Read the error message.** The whole thing. Including the stack trace. LLMs have a terrible habit of seeing an error and immediately generating a "fix" based on the error type without reading what it actually says. A TypeError could mean a hundred different things. The message and stack trace tell you which one.

**Reproduce first.** Before you change anything, make sure you can reproduce the problem. If you can't reproduce it, you can't verify your fix. "I think this should fix it" is not debugging. It's gambling.

**Change one thing at a time.** If you change three things and the bug goes away, you don't know which change fixed it. You also don't know if the other two changes introduced new bugs. Change one thing. Test. Change another. Test.

**Don't add workarounds without understanding the root cause.** If a value is unexpectedly null, don't just add a null check and move on. Figure out why it's null. The null check might prevent a crash, but the underlying bug is still there and will manifest differently later.

**If you're stuck, say so.** "I've tried X and Y and neither worked. Here's what I'm seeing. I think the issue might be Z but I'm not sure." This is infinitely more useful than silently trying random things for 20 iterations.

## 8. Dependencies

Don't add dependencies without thinking about it.

Every dependency you add is code you don't control that becomes a permanent part of the project. It needs to be maintained, updated, audited for security issues, and understood by everyone on the team. The cost is almost always higher than it looks.

Before adding a package:

- Can you do this with what's already in the project? If the project has axios, don't add node-fetch. If the project uses date-fns, don't add moment.
- Can you do this with the standard library? You don't need lodash for `Array.prototype.map`. You don't need uuid if `crypto.randomUUID()` exists.
- Is this dependency actually maintained? Check the last commit date. Check the issue count. Check if the maintainer responds to issues.
- How big is it? If you're adding a 500KB package to format a date, that's probably not worth it.

When you do add a dependency, say why. "I'm adding zod because this project needs runtime schema validation and there's nothing in the existing dependencies that does this" is fine. Silently adding packages to package.json is not.

## 9. Communication

How you communicate about code matters as much as the code itself.

**Say what you did and why.** Don't just dump a code block. "I moved the validation logic into a separate function because it was duplicated in three endpoints. This also makes it testable independently." Now the user understands the change without reading every line.

**Flag concerns.** If you implemented what was asked but you think there's a problem with the approach, say so. "This works but it makes a database call for every item in the list. If the list gets large this will be slow. Want me to batch it?" is the kind of proactive communication that saves hours later.

**Be precise about what you're uncertain about.** "I'm not sure if this library supports streaming responses" is useful. "I think this should work" is not. The difference is that the first one tells the user exactly what to verify.

**Don't explain things the user already knows.** If they asked you to add a REST endpoint, don't explain what REST is. If they asked for a database index, don't explain what indexes do. Match your explanation level to the user's demonstrated knowledge.

**Commit messages matter.** If you're writing a commit message, make it specific. "Fix bug" is useless. "Fix null pointer in user lookup when email contains uppercase chars" tells the next person exactly what happened.

## 10. Common Failure Modes

These are the patterns I see most often. If you catch yourself doing any of these, stop and reconsider.

**The Kitchen Sink.** Asked to add one feature, you restructure half the codebase "while you're at it." Don't. Do the one thing.

**The Wrong Abstraction.** You build a beautiful generic solution to a problem that only exists in one place. Duplication is far cheaper than the wrong abstraction. Copy-paste twice before you abstract.

**The Invisible Decision.** You make an architectural choice (database schema, API shape, auth strategy) without flagging it as a decision. These choices are hard to reverse and the user should be aware you made them.

**The Optimistic Path.** You write code that handles the happy path perfectly and ignores or crashes on everything else. Think about what happens when the API returns 500. When the file doesn't exist. When the user submits an empty form.

**The Knowledge Hallucination.** You confidently use an API that doesn't exist, a parameter that was removed two versions ago, or a library feature you're imagining. If you're not 100% sure a method exists with this exact signature, say so. Check the docs. Look at the actual source code in the project.

**The Style Drift.** You write code in your "preferred" style instead of matching the project. Functional patterns in an OOP codebase. Classes in a functional codebase. TypeScript patterns in a JavaScript project. Match the codebase, not your preferences.

**The Runaway Refactor.** You start fixing one thing. It touches another thing. That touches another. Twenty minutes later you've changed 15 files and you're not sure what you originally set out to do. If a fix is cascading, stop. Tell the user what's happening. Get buy-in before continuing.

---

These guidelines work when they produce fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# Project Reference: CRYPTO_GOD

Everything above is how to work. Everything below is what you're working on — this specific repository, its architecture, and its standing operational rules. Both apply on both machines (local dev and the VPS at `/opt/trading-bot`).

## Development Commands

```bash
# Start both backend + frontend dev server (recommended)
npm run dev

# Start backend only (port 3033)
npm start    # or: node --experimental-strip-types serverV2.ts

# Start frontend only (port 3000, proxies /api to :3033)
npx vite

# Build frontend for production
npm run build

# Type-check without emitting (no test suite exists)
npx tsc --noEmit
```

**Note:** There is no linter configured. The project uses `"strict": true` in tsconfig but Vite does not enforce type-checking at build time. Tests run via `npx vitest run`.

## Architecture

### Two-Process System
- **Backend** (`serverV2.ts`, run via `node --experimental-strip-types`, port 3033): boots in order — SQLite → Telegram → on-chain pollers → Fear & Greed gate → Kraken WebSocket → ML → `bootV2()` → HTTP listen. The V2 engine pipeline lives under `v2/` (`engine/`, `pipeline/`, `exchange/`, `indicators/`, `attribution/`, `backtest/`, `pairs/`, `dashboard/`). It still imports shared backend services from `services/` (`database.js`, `fearGreedGate.js`, `krakenWebsocketService.js`, `telegramService.js`) and serves the built frontend from `dist/`, including a read-only monitoring dashboard at `/monitor`
- **Frontend** (Vite, port 3000 in dev): React 18 + TypeScript SPA with TailwindCSS. Vite proxies `/api` requests to the backend

### Flat File Structure (no src/ directory)
All frontend source files live at the project root:
- `index.tsx` - Entry point, React Router setup (`/` for crypto, `/stocks` for Questrade)
- `App.tsx` - Main crypto dashboard (~2400 lines). Contains the bot loop, all state, indicator calculations, and the full render tree
- `types.ts` - All TypeScript interfaces and type definitions
- `constants.ts` - All configuration constants, thresholds, strategy info
- `components/` - React components (TSX)
- `services/` - Mixed TypeScript (frontend) and JavaScript (backend) services

### Service Split Convention
Frontend services (`.ts` in `services/`) run in the browser:
- `indicatorService.ts` - All indicator math (TC, breakout, whale, momentum, etc.)
- `aiLearningService.ts` - Gemini-powered trade learning
- `assetIntelligenceService.ts` - Volatility profiles, liquidity data
- `volatilityMethodsService.ts` - 6-method volatility ensemble
- `surgeTradingService.ts` - Candlestick patterns, surge detection
- `marketService.ts` - Fetch candles/tickers from backend
- Grid, DCA, arbitrage, pair, swing, market-making services

Backend services (`.js` in `services/`) run on Node:
- `database.js` - SQLite via better-sqlite3 (WAL mode, `data/trading.db`)
- `websocketService.js` - Crypto.com WebSocket market stream (secondary)
- `krakenWebsocketService.js` - Kraken v2 WebSocket market stream (primary)
- `signalScanner.js` - Auto-scans 10 tickers across timeframes
- `beastMode.js` - Regime detection, compound multipliers, dynamic targets
- `circuitBreaker.js` - Loss protection, Kelly criterion
- `questradeService.js` - Questrade OAuth2, order placement
- `StrategyEngine.js` - Stock trading strategy engine (10 strategies)
- `PaperTrader.js` - Paper trading wrapper for Questrade

### Backend Routes
- `/api/market-data` - Candle data from active exchange (Kraken primary)
- `/api/instruments` - Available trading pairs
- `/api/db/*` - SQLite persistence CRUD (`routes/persistence.js`)
- `/api/tradingview/*` - Signal injection (`routes/tradingview.js`)
- `/api/questrade/*` - Questrade integration (auth, candles, orders, bot)
- `/api/questrade/paper/*` - Paper trading for stocks

## Key Constraints

### Canadian Market Compliance
- **Only USD pairs** - USDT/USDC pairs are not available in Canada
- Use `BTCUSD`, `ETHUSD`, etc. (never `BTCUSDT`)
- Allowed bases: BTC, ETH, XRP, BNB, SOL, ADA, DOGE, LINK, DOT, AVAX

### Trading Strategies
The `TradingStrategy` type includes: TREND, BREAKOUT, WHALE, CONFLUENCE, MOMENTUM, DIVERGENCE, ADAPTIVE, MA_CROSSOVER, MEAN_REVERSION, REVERSAL, RANGE, VWAP.

**Important:** Many backend/service functions only accept the original 7 strategies (TREND through ADAPTIVE). When passing new strategy types to these functions, fall back to ADAPTIVE.

### Fee-Aware Trading
- **Kraken (primary)**: 0.26% taker per side, 0.52% round-trip; 0.16% maker per side
- **Crypto.com (secondary)**: 0.075% per side, 0.15% round-trip
- `TRADING_FEES` constant defaults to Kraken rates; backend uses `getActiveFees()` dynamically
- All profit targets must exceed fees (min ~0.92% for Kraken taker trades)
- PnL calculations must account for fees
- ML models use 0.67% break-even threshold (Kraken fees + slippage)

### Environment Variables
- `.env` / `.env.local` - Contains `ANTHROPIC_API_KEY` for Claude AI analysis
- Vite exposes it via `process.env.ANTHROPIC_API_KEY` (defined in vite.config.ts)

## Workflow Rules

### Stats Baseline Resets After Material V2 Config Changes (STANDING RULE)

When shipping changes that affect **trade-level expected outcomes** (R:R ratios, ALLOWED_REGIMES, SCAN_TICKERS, exit logic timers, position sizing, strategy enables/disables), set a new `stats_baseline_time` so reports/monitoring filter pre-change trades out of the current cohort.

**How:** After deploy completes, run on VPS:
```
sqlite3 /opt/trading-bot/data/trading.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_baseline_time', $(date -u +%s%3N));"
```
Then notify all reporters (VPS Claude, future Claude sessions): primary stats use `WHERE entry_time >= <baseline>`; pre-baseline trades go in a "Legacy / Background" section and don't count toward daily/overall totals.

**Open positions from before the baseline keep running** on their original config — don't force-close. Track outcomes as background data.

**The engine's running `totalPnlNet` continues to aggregate everything** (preserves the historical record). Only reports filter by baseline.

**When NOT to reset (advise the user instead):**
- Bug fixes that restore intended behavior — keep continuous stats so the fix's value is visible.
- Multiple small tweaks within a few days — baseline once at the end of a tuning sprint, not per tweak.
- Active high-volume trading window — wait for a quieter moment to deploy + reset, otherwise you create many "in-flight legacy" positions.
- Reverting a recent change with very few post-baseline trades — roll back to the previous baseline rather than create a third.
- Trivial / non-trading changes (typos, comments, log messages, behavior-preserving refactors) — never reset.

### Git Hygiene (STANDING RULE)

- Commit all code/config changes with descriptive messages capturing the data-driven reasoning.
- **ALWAYS push to BOTH remotes.** `origin` (GitHub) is the audit trail; `vps` (local bare repo on the VPS) is the deploy trigger. Pushing to origin alone does NOT update what's running — only the `vps` push triggers the post-receive hook that runs `git checkout`, `npm install`, `npx vite build`, and `pm2 restart`. Forgetting the `vps` push is the single most common deploy-skip incident; "I pushed the fix" without a vps push means the fix isn't running yet.
- **Use `bash scripts/push-deploy.sh` instead of two separate `git push` commands** — it pushes to both remotes, waits for the API to come back online, and verifies the deployed SHA matches the pushed SHA. Catches partial deploys before you assume success.
- For material trading changes, prefer **one logical change per commit** so individual rollbacks via `git revert <SHA>` are clean.
- Even experimental changes get committed (and reverted in a later commit if they don't pan out) — git log is the audit trail of what was tried and learned.

### Bidirectional Changelog (STANDING RULE)

`CHANGELOG.md` (in repo root) is the shared source of truth between local Claude and VPS Claude. Both agents must use it.

**When you ship a material change:** add a top-of-file entry to `CHANGELOG.md` using the template at the top of that file. Include commits, files, why, and what to monitor. Commit the changelog update with the change.

**When you (Claude, any instance) access the VPS for any reason:** read the latest `CHANGELOG.md` entries (at minimum entries since your previous interaction in this session) **before** acting. Don't assume your local view of the code matches what's running on the VPS — check the changelog so you're current on what changed and why.

**Material changes that require an entry:** anything that affects trading behavior, monitoring criteria, deployment config, file structure, or rules. Commit-only edits (typo fixes, comment cleanup) don't need a changelog entry but the commit itself is still required.

**Why this exists:** the 3-day V2 engine crash (commit `2a96f56` brace bug) happened in part because changes shipped from one agent weren't visible to the other in a structured way. The changelog is a compounding investment — every entry makes the next handoff faster.

## Common Issues
1. **Blank window / app won't load**: Backend crash. Check `node server.js` output for missing module errors
2. **Port conflicts**: Kill node processes before restart (`taskkill /F /IM node.exe` on Windows)
3. **Bot not trading**: Check confidence thresholds, aggressive mode settings, and candle count requirements (min 21)
4. **USDC errors**: Must use USD pairs, not USDC/USDT
5. **API proxy failures**: Ensure backend is running on port 3033 before starting Vite dev server
