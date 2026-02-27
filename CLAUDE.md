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

## Common Issues
1. **Blank window / app won't load**: Backend crash. Check `node server.js` output for missing module errors
2. **Port conflicts**: Kill node processes before restart (`taskkill /F /IM node.exe` on Windows)
3. **Bot not trading**: Check confidence thresholds, aggressive mode settings, and candle count requirements (min 21)
4. **USDC errors**: Must use USD pairs, not USDC/USDT
5. **API proxy failures**: Ensure backend is running on port 3033 before starting Vite dev server
