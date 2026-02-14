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
    "http://VPS_HOST_REDACTED:3033", "http://VPS_HOST_REDACTED:3000",
]

# ── Crypto.com API (via ccxt) ──────────────────────────────────────────────
CRYPTO_COM_API_KEY = os.environ.get("CRYPTO_COM_API_KEY", "")
CRYPTO_COM_SECRET = os.environ.get("CRYPTO_COM_SECRET", "")

# ── Local ML (no external API dependencies) ───────────────────────────────
ML_MODEL_DIR = "models"            # directory for persisted models
ML_MIN_SAMPLES = 50                # trades before switching heuristic → ML
ML_RETRAIN_INTERVAL = 25           # retrain after this many new outcomes

# ── Canadian-Allowed USD Pairs (10) ────────────────────────────────────────
PAIRS = [
    "BTC/USD", "ETH/USD", "XRP/USD", "SOL/USD",
    "ADA/USD", "DOGE/USD", "LINK/USD", "DOT/USD", "AVAX/USD",
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
MIN_SIGNAL_CONFIDENCE = 40     # minimum score (0-100) to act on signal
CONSENSUS_THRESHOLD = 5        # min strategies agreeing for consensus signal
PROFIT_TARGET_PCT = 0.01       # 1% default take-profit
STOP_LOSS_PCT = 0.008          # 0.8% default stop-loss

# ── Kelly Criterion ────────────────────────────────────────────────────────
KELLY_FRACTION = 0.25          # quarter-Kelly for safety
MIN_TRADES_FOR_KELLY = 20      # need history before using Kelly

# ── ATR Stops ──────────────────────────────────────────────────────────────
ATR_PERIOD = 14
ATR_STOP_MULTIPLIER = 2.0      # stop = entry - 2 * ATR

# ── Loop Timing ────────────────────────────────────────────────────────────
MAIN_LOOP_INTERVAL = 10        # seconds between full analysis cycles
HEARTBEAT_INTERVAL = 5         # seconds between ZMQ heartbeats

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
