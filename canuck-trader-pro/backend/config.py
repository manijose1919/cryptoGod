"""
Canuck-Trader-Pro Configuration
All API keys, trading pairs, thresholds, and feature flags.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ── HTTP Server ───────────────────────────────────────────────────────────
HTTP_PORT = int(os.environ.get("HTTP_PORT", 3033))
CORS_ORIGINS = [
    "http://localhost:3000", "http://localhost:3033",
    "http://31.97.7.138:3033", "http://31.97.7.138:3000",
]

# ── Crypto.com API (via ccxt) ──────────────────────────────────────────────
CRYPTO_COM_API_KEY = os.environ.get("CRYPTO_COM_API_KEY", "")
CRYPTO_COM_SECRET = os.environ.get("CRYPTO_COM_SECRET", "")

# ── Kraken API ─────────────────────────────────────────────────────────────
KRAKEN_API_KEY = os.environ.get("KRAKEN_API_KEY", "")
KRAKEN_SECRET = os.environ.get("KRAKEN_SECRET", "")

# ── Exchange Selection ────────────────────────────────────────────────────
# 'cryptocom' or 'kraken' — determines which ccxt exchange to use
EXCHANGE_ID = os.environ.get("EXCHANGE_ID", "cryptocom")

# ── Local ML (no external API dependencies) ───────────────────────────────
ML_MODEL_DIR = "models"            # directory for persisted models
ML_MIN_SAMPLES = 15                # trades before switching heuristic → ML (was 50)
ML_RETRAIN_INTERVAL = 10           # retrain after this many new outcomes (was 25)

# ── Trading Pairs (focused on liquid, trending assets) ────────────────────
# Reduced from 9 to 5: removed ADA, DOGE, DOT, AVAX (mostly RANGING, all negative PnL)
# These 5 have the best volume + trend behavior on Crypto.com
PAIRS = [
    "BTC/USD", "ETH/USD", "XRP/USD", "SOL/USD", "LINK/USD",
]

# ── Timeframes ─────────────────────────────────────────────────────────────
TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"]
DEFAULT_TIMEFRAME = "5m"
CANDLE_LIMIT = 200  # candles to fetch per request

# ── Trading Mode ───────────────────────────────────────────────────────────
PAPER_TRADING = True  # True = paper, False = live (requires API keys)
STARTING_BALANCE = 10000.0  # USD paper balance

# ── Risk Management ────────────────────────────────────────────────────────
MAX_POSITION_PCT = 0.20        # max 20% of portfolio per trade
MAX_DAILY_LOSS_PCT = 0.05      # 5% daily loss cap → halt trading
MAX_DRAWDOWN_PCT = 0.10        # 10% max drawdown → reduce size 50%
TRADING_FEE_PCT = 0.00075      # 0.075% per side (Crypto.com)
ROUND_TRIP_FEE_PCT = 0.0015    # 0.15% round-trip

# ── Strategy Thresholds ────────────────────────────────────────────────────
MIN_SIGNAL_CONFIDENCE = 65     # only high-conviction signals (was 55)
CONSENSUS_THRESHOLD = 7        # require 7+ strategies agreeing (was 5)
PROFIT_TARGET_PCT = 0.025      # 2.5% take-profit (must exceed avg loss)
STOP_LOSS_PCT = 0.005          # 0.5% stop-loss (tighter = better R:R)

# ── Trailing Stop ─────────────────────────────────────────────────────────
TRAILING_STOP_ACTIVATION_PCT = 0.005   # Activate trailing stop at +0.5% profit
TRAILING_STOP_DISTANCE_PCT = 0.005     # Trail 0.5% behind price

# ── Time-of-Day Filter ───────────────────────────────────────────────────
# Block trading during low-liquidity Asian session (2-8 AM UTC)
# Crypto has most volume/momentum during US + EU overlap (13-21 UTC)
QUIET_HOURS_START = 2   # UTC hour to start blocking
QUIET_HOURS_END = 8     # UTC hour to stop blocking

# ── Kelly Criterion ────────────────────────────────────────────────────────
KELLY_FRACTION = 0.25          # quarter-Kelly for safety
MIN_TRADES_FOR_KELLY = 20      # need history before using Kelly

# ── ATR Stops ──────────────────────────────────────────────────────────────
ATR_PERIOD = 14
ATR_STOP_MULTIPLIER = 2.0      # stop = entry - 2 * ATR

# ── Loop Timing ────────────────────────────────────────────────────────────
MAIN_LOOP_INTERVAL = 5         # seconds between full analysis cycles (was 10, faster for learning)
HEARTBEAT_INTERVAL = 5         # seconds between ZMQ heartbeats

# ── Learning Acceleration ────────────────────────────────────────────────
LEARNING_MODE = False          # Disabled: enough data collected, now focus on quality
LEARNING_MIN_CONFIDENCE = 65   # Match MIN_SIGNAL_CONFIDENCE
LEARNING_MAX_POSITIONS = 3     # Max 3 concurrent positions

# ── Time Exit ────────────────────────────────────────────────────────────
TIME_EXIT_MINUTES = 45         # Give trades 45 min to work (was 15 — trades never reached TP)

# ── ZMQ Ports ──────────────────────────────────────────────────────────────
ZMQ_PUB_PORT = 5555            # PUB socket for data broadcast
ZMQ_REP_PORT = 5556            # REP socket for command requests

# ── Sentiment ──────────────────────────────────────────────────────────────
NEWS_SOURCES = [
    "https://min-api.cryptocompare.com/data/v2/news/?lang=EN",
]
SENTIMENT_WEIGHT = 0.15        # weight in final signal score

# ── Logging ────────────────────────────────────────────────────────────────
LOG_LEVEL = "INFO"
LOG_FILE = "canuck-trader.log"

# ── Database ──────────────────────────────────────────────────────────────
DATABASE_DIR = os.environ.get("DATABASE_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))

# ── Questrade ─────────────────────────────────────────────────────────────
QUESTRADE_REFRESH_TOKEN = os.environ.get("QUESTRADE_REFRESH_TOKEN", "")
QUESTRADE_IS_PRACTICE = os.environ.get("QUESTRADE_IS_PRACTICE", "false").lower() == "true"

# ── Gemini API (optional, for AI analysis) ────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# ── Disabled Strategies ──────────────────────────────────────────────────
# Strategies in this set will be blocked from opening new trades
DISABLED_STRATEGIES = {
    "CONFLUENCE", "MULTI_CONSENSUS",  # 5.6% win rate, -$40 PnL
    "WHALE",                          # 0% win rate, -$1.6 PnL
    "DIVERGENCE", "RSI_DIVERGENCE", "MACD_DIVERGENCE",  # 16.7% win rate, -$7.5 PnL
    "BREAKOUT", "ATR_BREAKOUT",       # 11% win rate, -$14.3 PnL
}

# ── Beast Mode Thresholds ─────────────────────────────────────────────────
BEAST_MODE = True
BOT_INTERVAL_S = 2                       # seconds between bot cycles
MIN_CANDLES_REQUIRED = 10
MIN_TRADE_SIZE = 1.00                    # USD

# ── Signal Thresholds (Beast Mode) ───────────────────────────────────────
THRESHOLDS = {
    "TREND_BULLISH_ENTRY": 50,
    "TREND_BEARISH_EXIT": 75,
    "BREAKOUT_SQUEEZE_ENTRY": 40,
    "BREAKOUT_EXPANSION_EXIT": 60,
    "WHALE_BUYING_ENTRY": 48,
    "WHALE_SELLING_EXIT": 35,
    "CONFLUENCE_BULLISH_ENTRY": 2,
    "CONFLUENCE_BEARISH_EXIT": 1,
    "MOMENTUM_BULLISH_ENTRY": 50,
    "MOMENTUM_BEARISH_EXIT": 25,
    "DIVERGENCE_MIN_CONFIDENCE": 35,
    "ADAPTIVE_BULLISH_ENTRY": 45,
    "ADAPTIVE_BEARISH_EXIT": 75,
}
