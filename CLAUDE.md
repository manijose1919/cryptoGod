# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Start both backend + frontend dev server (recommended)
npm run dev

# Start backend only (port 3033)
npm start    # or: node server.js

# Start frontend only (port 3000, proxies /api to :3033)
npx vite

# Build frontend for production
npm run build

# Type-check without emitting (no test suite exists)
npx tsc --noEmit
```

**Note:** There is no linter or test runner configured. The project uses `"strict": true` in tsconfig but Vite does not enforce type-checking at build time.

## Architecture

### Two-Process System
- **Backend** (`server.js`, port 3033): Express server with pluggable exchange adapters (Kraken primary, Crypto.com secondary), serves built frontend from `dist/`, runs WebSocket market stream, signal scanner, circuit breaker, and bot loops
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
