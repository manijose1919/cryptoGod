# Canuck-Trader-Pro

Python "Brain" + Node.js "Face" — a decoupled crypto trading system with 25 strategies, Gemini AI analysis, and a Matrix-style terminal dashboard.

## Architecture

```
Python Backend (port 5555/5556)     Node.js Frontend
┌──────────────────────────┐        ┌──────────────────────┐
│  Crypto.com via ccxt     │  ZMQ   │  blessed terminal UI │
│  25 Trading Strategies   │ ─PUB──>│  Price tables        │
│  Gemini AI Analysis      │        │  Signal consensus    │
│  Risk Manager (Kelly)    │ <─REQ─ │  Portfolio tracker   │
│  Sentiment Analyzer      │  /REP  │  Trade log           │
└──────────────────────────┘        └──────────────────────┘
```

## Quick Start

### 1. Python Backend
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### 2. Node.js Dashboard
```bash
cd frontend
npm install
node index.js
```

## Configuration

Edit `backend/config.py`:
- `PAPER_TRADING = True` (default) — no real money
- `CRYPTO_COM_API_KEY` / `CRYPTO_COM_SECRET` — set via environment variables for live trading
- `GEMINI_CLI_PATH` — path to the Gemini CLI binary

## 25 Strategies

| # | Strategy | Category |
|---|----------|----------|
| 1 | EMA Crossover (9/21) | Trend |
| 2 | Triple EMA (8/21/55) | Trend |
| 3 | MACD Signal + Histogram | Trend |
| 4 | ADX Trend Strength | Trend |
| 5 | Supertrend (ATR-based) | Trend |
| 6 | RSI (14) | Momentum |
| 7 | Stochastic RSI | Momentum |
| 8 | Williams %R | Momentum |
| 9 | CCI | Momentum |
| 10 | Rate of Change | Momentum |
| 11 | Bollinger Bands | Volatility |
| 12 | Keltner Channel | Volatility |
| 13 | ATR Breakout | Volatility |
| 14 | Donchian Channel | Volatility |
| 15 | Volatility Squeeze | Volatility |
| 16 | VWAP | Volume |
| 17 | On-Balance Volume | Volume |
| 18 | Volume Spike | Volume |
| 19 | Mean Reversion (Z-score) | Pattern |
| 20 | Ichimoku Cloud | Pattern |
| 21 | Pivot Points | Pattern |
| 22 | Engulfing Pattern | Pattern |
| 23 | RSI Divergence | Divergence |
| 24 | MACD Divergence | Divergence |
| 25 | Multi-Indicator Consensus | Advanced |

## Dashboard Keys

| Key | Action |
|-----|--------|
| `P` | Pause trading |
| `R` | Resume trading |
| `!` | PANIC — close all positions |
| `S` | Show status |
| `Q` | Quit dashboard |

## Risk Management

- **Kelly Criterion**: Quarter-Kelly position sizing (after 20+ trades)
- **ATR Stops**: 2x ATR stop-loss, 2:1 R:R take-profit
- **Daily Loss Cap**: 5% max daily loss halts trading
- **Drawdown Protection**: >10% drawdown reduces position sizes 50%
- **Fee-Aware**: 0.075% per side (0.15% round-trip) built into all calculations

## Canadian Compliance

Only USD pairs — no USDT/USDC (not available in Canada):
BTC, ETH, XRP, BNB, SOL, ADA, DOGE, LINK, DOT, AVAX
