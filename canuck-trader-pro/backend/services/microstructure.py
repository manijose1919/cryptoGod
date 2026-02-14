"""
Market Microstructure Analysis Service

Analyzes market microstructure for better entry/exit timing using:
1. Bid-Ask Spread Analysis - track effective spread, z-score for liquidity assessment
2. Trade Flow Toxicity (Kyle's Lambda) - price impact per unit order flow
3. Amihud Illiquidity Ratio - |return| / dollar_volume
4. Roll Spread Estimator - spread from auto-covariance of price changes
5. Tick Imbalance Bars - group trades by imbalance, detect informed trading
6. Volume Clock - volume-weighted time for adaptive analysis windows

Key signals:
- Wide spread / high illiquidity -> reduce position size, widen stops
- Tight spread / low illiquidity -> normal sizing
- High Kyle's Lambda -> toxic flow, avoid entries
- Tick imbalance exceeds threshold -> informed trading detected
- Fast volume clock -> shorten analysis window
- Slow volume clock -> lengthen analysis window
"""
import logging
import threading
import time
from collections import defaultdict, deque
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

# Spread analysis
SPREAD_HISTORY_SIZE = 200         # number of spread observations to retain
SPREAD_ZSCORE_WINDOW = 50         # rolling window for z-score calculation
SPREAD_WIDE_ZSCORE = 1.5          # z-score above which spread is considered wide
SPREAD_TIGHT_ZSCORE = -1.0        # z-score below which spread is considered tight

# Kyle's Lambda
LAMBDA_WINDOW = 100               # observations for regression
LAMBDA_HIGH_THRESHOLD = 0.7       # normalized lambda above which flow is toxic
LAMBDA_EXTREME_THRESHOLD = 0.9    # extreme toxicity

# Amihud illiquidity
AMIHUD_WINDOW = 60                # candles for Amihud calculation
AMIHUD_HIGH_THRESHOLD = 0.75      # normalized percentile for illiquid classification
AMIHUD_EXTREME_THRESHOLD = 0.90

# Roll spread
ROLL_WINDOW = 50                  # price changes for Roll estimator

# Tick imbalance bars
TICK_IMB_EWMA_SPAN = 20           # EWMA span for expected tick imbalance
TICK_IMB_HISTORY_SIZE = 100       # completed imbalance bars to retain
TICK_IMB_MIN_TRADES = 10          # minimum trades before first bar

# Volume clock
VOL_CLOCK_WINDOW = 60             # minutes for baseline volume rate
VOL_CLOCK_FAST_THRESHOLD = 1.5    # multiplier for "fast" volume clock
VOL_CLOCK_SLOW_THRESHOLD = 0.5    # multiplier for "slow" volume clock

# Cache
CACHE_TTL = 5                     # seconds


class MicrostructureAnalyzer:
    """Analyzes market microstructure for entry/exit timing optimization."""

    def __init__(self):
        self._lock = threading.Lock()

        # Per-symbol state
        # Spread tracking: {symbol: deque of (timestamp, spread_pct, mid_price)}
        self._spread_history: Dict[str, deque] = {}
        # Trade data for Kyle's Lambda: {symbol: deque of (price_change, signed_volume)}
        self._trade_flow: Dict[str, deque] = {}
        # Candle data for Amihud: {symbol: deque of (abs_return, dollar_volume)}
        self._amihud_data: Dict[str, deque] = {}
        # Price changes for Roll spread: {symbol: deque of delta_price}
        self._price_changes: Dict[str, deque] = {}
        self._last_mid_price: Dict[str, float] = {}
        # Tick imbalance bars state
        self._tick_imb_state: Dict[str, dict] = {}
        # Completed imbalance bars: {symbol: deque of bar dicts}
        self._tick_imb_bars: Dict[str, deque] = {}
        # Volume clock: {symbol: deque of (timestamp, volume)}
        self._volume_ticks: Dict[str, deque] = {}
        # Cached analysis results: {symbol: (timestamp, result_dict)}
        self._cache: Dict[str, Tuple[float, dict]] = {}

        logger.info("MicrostructureAnalyzer initialized")

    # ── Internal helpers ─────────────────────────────────────────────────

    def _ensure_symbol(self, symbol: str) -> None:
        """Lazily initialize per-symbol data structures."""
        if symbol not in self._spread_history:
            self._spread_history[symbol] = deque(maxlen=SPREAD_HISTORY_SIZE)
        if symbol not in self._trade_flow:
            self._trade_flow[symbol] = deque(maxlen=LAMBDA_WINDOW)
        if symbol not in self._amihud_data:
            self._amihud_data[symbol] = deque(maxlen=AMIHUD_WINDOW)
        if symbol not in self._price_changes:
            self._price_changes[symbol] = deque(maxlen=ROLL_WINDOW)
        if symbol not in self._tick_imb_state:
            self._tick_imb_state[symbol] = {
                "cumulative_imbalance": 0.0,
                "trade_count": 0,
                "expected_imbalance": 0.0,     # EWMA of |imbalance| at bar completion
                "bar_buy_volume": 0.0,
                "bar_sell_volume": 0.0,
                "bar_start_price": None,
                "bar_start_time": None,
                "last_price": None,
            }
        if symbol not in self._tick_imb_bars:
            self._tick_imb_bars[symbol] = deque(maxlen=TICK_IMB_HISTORY_SIZE)
        if symbol not in self._volume_ticks:
            self._volume_ticks[symbol] = deque(maxlen=3600)  # up to 1hr of ticks

    # ── 1. Bid-Ask Spread Analysis ───────────────────────────────────────

    def _update_spread(self, symbol: str, best_bid: float, best_ask: float,
                       timestamp: Optional[float] = None) -> dict:
        """Record a spread observation and compute spread z-score."""
        if best_bid <= 0 or best_ask <= 0 or best_ask <= best_bid:
            return {"spread_pct": 0.0, "spread_zscore": 0.0, "regime": "UNKNOWN"}

        ts = timestamp or time.time()
        mid = (best_bid + best_ask) / 2.0
        spread_pct = (best_ask - best_bid) / mid * 100.0

        self._spread_history[symbol].append((ts, spread_pct, mid))

        # Update mid price for price change tracking
        prev_mid = self._last_mid_price.get(symbol)
        self._last_mid_price[symbol] = mid
        if prev_mid is not None and prev_mid > 0:
            delta_p = mid - prev_mid
            self._price_changes[symbol].append(delta_p)

        # Compute z-score over rolling window
        spreads = [s[1] for s in self._spread_history[symbol]]
        window = spreads[-SPREAD_ZSCORE_WINDOW:]

        if len(window) < 5:
            return {
                "spread_pct": round(spread_pct, 6),
                "spread_zscore": 0.0,
                "regime": "INSUFFICIENT_DATA",
                "mean_spread": round(spread_pct, 6),
            }

        arr = np.array(window, dtype=np.float64)
        mean_spread = float(np.mean(arr))
        std_spread = float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0

        if std_spread > 1e-12:
            zscore = (spread_pct - mean_spread) / std_spread
        else:
            zscore = 0.0

        if zscore > SPREAD_WIDE_ZSCORE:
            regime = "WIDE"
        elif zscore < SPREAD_TIGHT_ZSCORE:
            regime = "TIGHT"
        else:
            regime = "NORMAL"

        return {
            "spread_pct": round(spread_pct, 6),
            "spread_zscore": round(zscore, 4),
            "regime": regime,
            "mean_spread": round(mean_spread, 6),
            "std_spread": round(std_spread, 6),
            "observations": len(spreads),
        }

    # ── 2. Kyle's Lambda (Trade Flow Toxicity) ──────────────────────────

    def _update_kyle_lambda(self, symbol: str, price_change: float,
                            signed_volume: float) -> dict:
        """Record a trade flow observation and estimate Kyle's Lambda.

        Kyle's Lambda = slope of regression: price_change ~ signed_volume
        High lambda means each unit of order flow moves price more (toxic flow).
        """
        self._trade_flow[symbol].append((price_change, signed_volume))

        data = list(self._trade_flow[symbol])
        if len(data) < 10:
            return {
                "lambda": 0.0,
                "lambda_normalized": 0.0,
                "toxicity": "INSUFFICIENT_DATA",
                "observations": len(data),
            }

        price_changes = np.array([d[0] for d in data], dtype=np.float64)
        signed_vols = np.array([d[1] for d in data], dtype=np.float64)

        # OLS regression: price_change = alpha + lambda * signed_volume + epsilon
        # Using numpy: lambda = cov(price_change, signed_volume) / var(signed_volume)
        vol_var = float(np.var(signed_vols, ddof=1))
        if vol_var < 1e-20:
            return {
                "lambda": 0.0,
                "lambda_normalized": 0.0,
                "toxicity": "NO_VARIANCE",
                "observations": len(data),
            }

        covariance = float(np.cov(price_changes, signed_vols, ddof=1)[0, 1])
        kyle_lambda = covariance / vol_var

        # Normalize lambda to 0-1 range using historical distribution
        # Use absolute lambda (direction doesn't matter for toxicity)
        abs_lambda = abs(kyle_lambda)

        # Running normalization: compare against recent history of lambdas
        # Use percentile rank within rolling window
        all_lambdas = []
        for i in range(max(0, len(data) - 50), len(data)):
            subset = data[max(0, i - 20):i + 1]
            if len(subset) >= 5:
                pc = np.array([d[0] for d in subset], dtype=np.float64)
                sv = np.array([d[1] for d in subset], dtype=np.float64)
                v = float(np.var(sv, ddof=1))
                if v > 1e-20:
                    c = float(np.cov(pc, sv, ddof=1)[0, 1])
                    all_lambdas.append(abs(c / v))

        if len(all_lambdas) >= 3:
            arr_l = np.array(all_lambdas)
            percentile = float(np.searchsorted(np.sort(arr_l), abs_lambda)) / len(arr_l)
            lambda_normalized = min(1.0, percentile)
        else:
            lambda_normalized = min(1.0, abs_lambda * 100)  # rough fallback

        if lambda_normalized >= LAMBDA_EXTREME_THRESHOLD:
            toxicity = "EXTREME"
        elif lambda_normalized >= LAMBDA_HIGH_THRESHOLD:
            toxicity = "HIGH"
        elif lambda_normalized >= 0.4:
            toxicity = "MODERATE"
        else:
            toxicity = "LOW"

        return {
            "lambda": round(kyle_lambda, 8),
            "lambda_abs": round(abs_lambda, 8),
            "lambda_normalized": round(lambda_normalized, 4),
            "toxicity": toxicity,
            "observations": len(data),
        }

    # ── 3. Amihud Illiquidity Ratio ──────────────────────────────────────

    def _update_amihud(self, symbol: str, abs_return: float,
                       dollar_volume: float) -> dict:
        """Update Amihud illiquidity ratio.

        Amihud = |return| / dollar_volume
        High ratio = price moves a lot per dollar traded = illiquid.
        """
        if dollar_volume > 0:
            self._amihud_data[symbol].append((abs_return, dollar_volume))

        data = list(self._amihud_data[symbol])
        if len(data) < 5:
            return {
                "amihud_ratio": 0.0,
                "amihud_normalized": 0.0,
                "liquidity_regime": "INSUFFICIENT_DATA",
                "observations": len(data),
            }

        ratios = np.array(
            [d[0] / d[1] for d in data if d[1] > 0],
            dtype=np.float64,
        )

        if len(ratios) < 3:
            return {
                "amihud_ratio": 0.0,
                "amihud_normalized": 0.0,
                "liquidity_regime": "INSUFFICIENT_DATA",
                "observations": len(data),
            }

        current_ratio = float(ratios[-1])
        mean_ratio = float(np.mean(ratios))
        # Percentile rank of current ratio
        percentile = float(np.searchsorted(np.sort(ratios), current_ratio)) / len(ratios)

        if percentile >= AMIHUD_EXTREME_THRESHOLD:
            regime = "VERY_ILLIQUID"
        elif percentile >= AMIHUD_HIGH_THRESHOLD:
            regime = "ILLIQUID"
        elif percentile <= 0.25:
            regime = "VERY_LIQUID"
        else:
            regime = "NORMAL"

        return {
            "amihud_ratio": round(current_ratio, 12),
            "amihud_mean": round(mean_ratio, 12),
            "amihud_normalized": round(percentile, 4),
            "liquidity_regime": regime,
            "observations": len(ratios),
        }

    # ── 4. Roll Spread Estimator ─────────────────────────────────────────

    def _compute_roll_spread(self, symbol: str) -> dict:
        """Estimate effective spread from auto-covariance of price changes.

        Roll (1984): spread = 2 * sqrt(-Cov(delta_p_t, delta_p_{t-1}))
        If covariance is positive (rare), the model breaks down.
        """
        changes = list(self._price_changes[symbol])
        if len(changes) < 10:
            return {
                "roll_spread": 0.0,
                "roll_spread_valid": False,
                "observations": len(changes),
            }

        arr = np.array(changes, dtype=np.float64)
        # Auto-covariance at lag 1
        delta_t = arr[1:]
        delta_t_minus1 = arr[:-1]

        cov_lag1 = float(np.mean(delta_t * delta_t_minus1) -
                         np.mean(delta_t) * np.mean(delta_t_minus1))

        if cov_lag1 < 0:
            roll_spread = 2.0 * np.sqrt(-cov_lag1)
            valid = True
        else:
            # Positive auto-covariance: model invalid, set to 0
            roll_spread = 0.0
            valid = False

        # Normalize to percentage of current mid price
        mid = self._last_mid_price.get(symbol, 0.0)
        roll_spread_pct = (roll_spread / mid * 100.0) if mid > 0 else 0.0

        return {
            "roll_spread": round(float(roll_spread), 8),
            "roll_spread_pct": round(roll_spread_pct, 6),
            "roll_spread_valid": valid,
            "autocovariance": round(cov_lag1, 12),
            "observations": len(changes),
        }

    # ── 5. Tick Imbalance Bars ───────────────────────────────────────────

    def _update_tick_imbalance(self, symbol: str, price: float, volume: float,
                               is_buy: bool, timestamp: Optional[float] = None) -> Optional[dict]:
        """Process a trade for tick imbalance bar construction.

        A new bar completes when |cumulative_imbalance| exceeds the EWMA
        of past bar imbalances. This signals informed trading activity.

        Returns completed bar dict if a bar just completed, else None.
        """
        ts = timestamp or time.time()
        state = self._tick_imb_state[symbol]

        tick_sign = 1.0 if is_buy else -1.0
        state["cumulative_imbalance"] += tick_sign
        state["trade_count"] += 1

        if is_buy:
            state["bar_buy_volume"] += volume
        else:
            state["bar_sell_volume"] += volume

        if state["bar_start_price"] is None:
            state["bar_start_price"] = price
            state["bar_start_time"] = ts

        state["last_price"] = price

        # Check if we should complete this bar
        completed_bars = list(self._tick_imb_bars[symbol])
        abs_imbalance = abs(state["cumulative_imbalance"])

        # Threshold: EWMA of previous bar absolute imbalances
        if state["expected_imbalance"] < 1.0:
            # Bootstrap: use minimum trades for first bars
            threshold = max(TICK_IMB_MIN_TRADES, state["expected_imbalance"])
        else:
            threshold = state["expected_imbalance"]

        if abs_imbalance >= threshold and state["trade_count"] >= 3:
            # Complete this bar
            bar = {
                "open_price": state["bar_start_price"],
                "close_price": price,
                "high_price": price,  # approximation without tracking
                "low_price": price,   # approximation without tracking
                "buy_volume": state["bar_buy_volume"],
                "sell_volume": state["bar_sell_volume"],
                "imbalance": state["cumulative_imbalance"],
                "trade_count": state["trade_count"],
                "start_time": state["bar_start_time"],
                "end_time": ts,
                "duration": ts - state["bar_start_time"] if state["bar_start_time"] else 0,
                "direction": "BUY" if state["cumulative_imbalance"] > 0 else "SELL",
            }

            self._tick_imb_bars[symbol].append(bar)

            # Update EWMA of expected imbalance
            alpha = 2.0 / (TICK_IMB_EWMA_SPAN + 1)
            state["expected_imbalance"] = (
                alpha * abs_imbalance +
                (1 - alpha) * state["expected_imbalance"]
            )

            # Reset bar state
            state["cumulative_imbalance"] = 0.0
            state["trade_count"] = 0
            state["bar_buy_volume"] = 0.0
            state["bar_sell_volume"] = 0.0
            state["bar_start_price"] = None
            state["bar_start_time"] = None

            return bar

        return None

    def _get_tick_imbalance_summary(self, symbol: str) -> dict:
        """Summarize tick imbalance bar state for a symbol."""
        bars = list(self._tick_imb_bars.get(symbol, []))
        state = self._tick_imb_state.get(symbol, {})

        if len(bars) < 2:
            return {
                "bars_completed": len(bars),
                "current_imbalance": state.get("cumulative_imbalance", 0.0),
                "expected_threshold": state.get("expected_imbalance", 0.0),
                "informed_trading": False,
                "informed_direction": "NEUTRAL",
                "sufficient_data": False,
            }

        recent_bars = bars[-10:]
        buy_bars = sum(1 for b in recent_bars if b["direction"] == "BUY")
        sell_bars = sum(1 for b in recent_bars if b["direction"] == "SELL")
        total_bars = len(recent_bars)

        # Detect informed trading: are bars completing faster than expected?
        durations = [b["duration"] for b in recent_bars if b["duration"] > 0]
        if len(durations) >= 3:
            mean_duration = float(np.mean(durations))
            recent_duration = float(np.mean(durations[-3:]))
            accelerating = recent_duration < mean_duration * 0.7
        else:
            accelerating = False
            mean_duration = 0.0

        # Direction bias in recent bars
        if total_bars > 0:
            buy_pct = buy_bars / total_bars
            if buy_pct > 0.7:
                informed_direction = "BUY"
            elif buy_pct < 0.3:
                informed_direction = "SELL"
            else:
                informed_direction = "NEUTRAL"
        else:
            informed_direction = "NEUTRAL"

        # Informed trading detected if bars are completing fast AND directionally biased
        informed = accelerating and informed_direction != "NEUTRAL"

        current_imb = state.get("cumulative_imbalance", 0.0)
        threshold = state.get("expected_imbalance", 0.0)
        pct_to_threshold = (abs(current_imb) / threshold * 100.0) if threshold > 0 else 0.0

        return {
            "bars_completed": len(bars),
            "recent_bars": len(recent_bars),
            "buy_bars": buy_bars,
            "sell_bars": sell_bars,
            "current_imbalance": round(current_imb, 2),
            "expected_threshold": round(threshold, 2),
            "pct_to_threshold": round(pct_to_threshold, 1),
            "mean_bar_duration_s": round(mean_duration, 2) if durations else 0.0,
            "bars_accelerating": accelerating,
            "informed_trading": informed,
            "informed_direction": informed_direction,
            "sufficient_data": True,
        }

    # ── 6. Volume Clock ──────────────────────────────────────────────────

    def _update_volume_clock(self, symbol: str, volume: float,
                             timestamp: Optional[float] = None) -> dict:
        """Track volume clock speed.

        A "volume minute" is the time it takes to trade the average 1-minute
        volume. If the clock is fast, activity is high (shorten analysis
        window). If slow, activity is low (lengthen window).
        """
        ts = timestamp or time.time()
        self._volume_ticks[symbol].append((ts, volume))

        ticks = list(self._volume_ticks[symbol])
        if len(ticks) < 5:
            return {
                "volume_clock_speed": 1.0,
                "regime": "NORMAL",
                "window_adjustment": 1.0,
                "sufficient_data": False,
            }

        # Calculate volume rate over different windows
        now = ts
        recent_cutoff = now - 300   # last 5 minutes
        baseline_cutoff = now - 3600  # last hour

        recent_ticks = [(t, v) for t, v in ticks if t >= recent_cutoff]
        baseline_ticks = [(t, v) for t, v in ticks if t >= baseline_cutoff]

        if len(recent_ticks) < 2 or len(baseline_ticks) < 5:
            return {
                "volume_clock_speed": 1.0,
                "regime": "NORMAL",
                "window_adjustment": 1.0,
                "sufficient_data": False,
            }

        recent_vol = sum(v for _, v in recent_ticks)
        recent_span = max(1.0, recent_ticks[-1][0] - recent_ticks[0][0])
        recent_rate = recent_vol / recent_span  # vol per second

        baseline_vol = sum(v for _, v in baseline_ticks)
        baseline_span = max(1.0, baseline_ticks[-1][0] - baseline_ticks[0][0])
        baseline_rate = baseline_vol / baseline_span

        if baseline_rate < 1e-12:
            speed = 1.0
        else:
            speed = recent_rate / baseline_rate

        if speed >= VOL_CLOCK_FAST_THRESHOLD:
            regime = "FAST"
            # Shorten analysis window: use fewer bars for faster reaction
            window_adj = max(0.5, 1.0 / speed)
        elif speed <= VOL_CLOCK_SLOW_THRESHOLD:
            regime = "SLOW"
            # Lengthen analysis window: use more bars for stability
            window_adj = min(2.0, 1.0 / speed)
        else:
            regime = "NORMAL"
            window_adj = 1.0

        return {
            "volume_clock_speed": round(speed, 4),
            "recent_vol_rate": round(recent_rate, 6),
            "baseline_vol_rate": round(baseline_rate, 6),
            "regime": regime,
            "window_adjustment": round(window_adj, 4),
            "sufficient_data": True,
        }

    # ── Public API ───────────────────────────────────────────────────────

    def analyze(self, symbol: str, trades_data: Optional[List[dict]] = None,
                orderbook_data: Optional[dict] = None) -> dict:
        """Run full microstructure analysis for a symbol.

        Args:
            symbol: Trading pair (e.g. "BTC/USD")
            trades_data: List of trade dicts, each with keys:
                - price (float)
                - volume (float)
                - side ("BUY" or "SELL") or is_buy (bool)
                - timestamp (float, optional)
                - dollar_volume (float, optional, defaults to price*volume)
            orderbook_data: Order book dict with keys:
                - best_bid (float)
                - best_ask (float)
                - bids (list of [price, size], optional)
                - asks (list of [price, size], optional)

        Returns:
            Full microstructure report dict.
        """
        now = time.time()

        with self._lock:
            # Check cache
            cached = self._cache.get(symbol)
            if cached and now - cached[0] < CACHE_TTL:
                return cached[1]

            self._ensure_symbol(symbol)

            # ── Process order book ───────────────────────────────────
            spread_result = {
                "spread_pct": 0.0, "spread_zscore": 0.0, "regime": "NO_DATA"
            }
            if orderbook_data:
                best_bid = orderbook_data.get("best_bid", 0.0)
                best_ask = orderbook_data.get("best_ask", 0.0)
                if best_bid > 0 and best_ask > 0:
                    spread_result = self._update_spread(symbol, best_bid, best_ask, now)

            # ── Process trades ───────────────────────────────────────
            kyle_result = {
                "lambda": 0.0, "lambda_normalized": 0.0,
                "toxicity": "NO_DATA", "observations": 0,
            }
            amihud_result = {
                "amihud_ratio": 0.0, "amihud_normalized": 0.0,
                "liquidity_regime": "NO_DATA", "observations": 0,
            }
            vol_clock_result = {
                "volume_clock_speed": 1.0, "regime": "NORMAL",
                "window_adjustment": 1.0, "sufficient_data": False,
            }

            if trades_data:
                prev_price = self._last_mid_price.get(symbol)

                for trade in trades_data:
                    price = float(trade.get("price", 0))
                    volume = float(trade.get("volume", 0))
                    ts = trade.get("timestamp", now)

                    if price <= 0 or volume <= 0:
                        continue

                    # Determine trade side
                    is_buy = trade.get("is_buy", trade.get("side", "BUY") == "BUY")

                    # Kyle's Lambda: need price change and signed volume
                    if prev_price is not None and prev_price > 0:
                        price_change = (price - prev_price) / prev_price
                        signed_vol = volume if is_buy else -volume
                        kyle_result = self._update_kyle_lambda(
                            symbol, price_change, signed_vol
                        )

                    # Amihud: |return| / dollar_volume
                    dollar_vol = float(
                        trade.get("dollar_volume", price * volume)
                    )
                    if prev_price is not None and prev_price > 0 and dollar_vol > 0:
                        abs_ret = abs((price - prev_price) / prev_price)
                        amihud_result = self._update_amihud(
                            symbol, abs_ret, dollar_vol
                        )

                    # Tick imbalance bars
                    self._update_tick_imbalance(symbol, price, volume, is_buy, ts)

                    # Volume clock
                    vol_clock_result = self._update_volume_clock(symbol, volume, ts)

                    prev_price = price

            # ── Roll spread ──────────────────────────────────────────
            roll_result = self._compute_roll_spread(symbol)

            # ── Tick imbalance summary ───────────────────────────────
            tick_imb_result = self._get_tick_imbalance_summary(symbol)

            # ── Aggregate scores ─────────────────────────────────────
            liquidity_score = self._compute_liquidity_score(
                spread_result, amihud_result, roll_result
            )
            toxicity_score = self._compute_toxicity_score(
                kyle_result, tick_imb_result
            )
            position_adj = self._compute_position_adjustment(
                liquidity_score, toxicity_score, vol_clock_result
            )

            result = {
                "symbol": symbol,
                "timestamp": now,
                "spread": spread_result,
                "kyle_lambda": kyle_result,
                "amihud": amihud_result,
                "roll_spread": roll_result,
                "tick_imbalance": tick_imb_result,
                "volume_clock": vol_clock_result,
                "liquidity_score": round(liquidity_score, 1),
                "toxicity_score": round(toxicity_score, 1),
                "position_size_adjustment": round(position_adj, 4),
            }

            self._cache[symbol] = (now, result)
            return result

    def _compute_liquidity_score(self, spread: dict, amihud: dict,
                                 roll: dict) -> float:
        """Compute aggregate liquidity score (0-100, higher = more liquid).

        Components:
        - Spread z-score contribution (40%)
        - Amihud illiquidity contribution (40%)
        - Roll spread contribution (20%)
        """
        score = 50.0  # baseline

        # Spread: tight = good, wide = bad
        zscore = spread.get("spread_zscore", 0.0)
        if spread.get("regime") != "NO_DATA" and spread.get("regime") != "INSUFFICIENT_DATA":
            # Map z-score [-3, +3] to [-20, +20] adjustment
            spread_adj = max(-20.0, min(20.0, -zscore * 6.67))
            score += spread_adj

        # Amihud: low ratio = liquid (good), high = illiquid (bad)
        amihud_norm = amihud.get("amihud_normalized", 0.5)
        if amihud.get("liquidity_regime") != "NO_DATA" and \
           amihud.get("liquidity_regime") != "INSUFFICIENT_DATA":
            # Map 0-1 percentile to -20 to +20 adjustment
            amihud_adj = (0.5 - amihud_norm) * 40.0
            score += amihud_adj

        # Roll spread: lower = tighter true spread = more liquid
        if roll.get("roll_spread_valid", False):
            roll_pct = roll.get("roll_spread_pct", 0.0)
            # A roll spread of ~0.01% is very tight, ~0.1%+ is wide
            roll_adj = max(-10.0, min(10.0, (0.05 - roll_pct) * 200.0))
            score += roll_adj

        return max(0.0, min(100.0, score))

    def _compute_toxicity_score(self, kyle: dict, tick_imb: dict) -> float:
        """Compute aggregate toxicity score (0-100, higher = more toxic).

        Components:
        - Kyle's Lambda (60%)
        - Tick imbalance informed trading (40%)
        """
        score = 0.0

        # Kyle's Lambda contribution
        lambda_norm = kyle.get("lambda_normalized", 0.0)
        if kyle.get("toxicity") not in ("NO_DATA", "INSUFFICIENT_DATA", "NO_VARIANCE"):
            score += lambda_norm * 60.0

        # Tick imbalance contribution
        if tick_imb.get("sufficient_data", False):
            if tick_imb.get("informed_trading", False):
                score += 40.0
            elif tick_imb.get("bars_accelerating", False):
                score += 20.0
            elif tick_imb.get("informed_direction") != "NEUTRAL":
                score += 10.0

        return max(0.0, min(100.0, score))

    def _compute_position_adjustment(self, liquidity_score: float,
                                     toxicity_score: float,
                                     vol_clock: dict) -> float:
        """Compute position size adjustment multiplier (0.5-1.5).

        - High liquidity -> can size up (up to 1.2x)
        - Low liquidity -> must size down (down to 0.5x)
        - High toxicity -> reduce size
        - Volume clock adjustments (fast = slightly reduce for chasing risk)
        """
        # Start at 1.0
        adj = 1.0

        # Liquidity component: map 0-100 score to 0.6-1.2
        liq_factor = 0.6 + (liquidity_score / 100.0) * 0.6
        adj *= liq_factor

        # Toxicity penalty: high toxicity -> reduce size
        if toxicity_score > 70:
            adj *= 0.6
        elif toxicity_score > 50:
            adj *= 0.75
        elif toxicity_score > 30:
            adj *= 0.9

        # Volume clock: fast volume might mean chasing, slight reduction
        vol_speed = vol_clock.get("volume_clock_speed", 1.0)
        if vol_speed > 2.5:
            adj *= 0.85  # very fast, reduce
        elif vol_speed < 0.3:
            adj *= 0.9   # very slow, thin market

        return max(0.5, min(1.5, adj))

    def get_liquidity_score(self, symbol: str) -> float:
        """Get liquidity score (0-100) for a symbol.

        Higher = more liquid. Uses cached analysis if available.
        """
        with self._lock:
            cached = self._cache.get(symbol)
            if cached and time.time() - cached[0] < CACHE_TTL:
                return cached[1].get("liquidity_score", 50.0)
        return 50.0  # default when no data

    def get_toxicity_score(self, symbol: str) -> float:
        """Get toxicity score (0-100) for a symbol.

        Higher = more toxic order flow. Uses cached analysis if available.
        """
        with self._lock:
            cached = self._cache.get(symbol)
            if cached and time.time() - cached[0] < CACHE_TTL:
                return cached[1].get("toxicity_score", 0.0)
        return 0.0  # default when no data

    def get_position_size_adjustment(self, symbol: str) -> float:
        """Get position size multiplier (0.5-1.5) based on microstructure.

        < 1.0 = reduce position (poor liquidity or toxic flow)
        = 1.0 = normal sizing
        > 1.0 = can increase (excellent liquidity, clean flow)
        """
        with self._lock:
            cached = self._cache.get(symbol)
            if cached and time.time() - cached[0] < CACHE_TTL:
                return cached[1].get("position_size_adjustment", 1.0)
        return 1.0  # default when no data

    def get_confidence_adjustment(self, symbol: str, action: str) -> int:
        """Get confidence adjustment (-10 to +10) based on microstructure.

        Args:
            symbol: Trading pair
            action: "BUY" or "SELL"

        Returns:
            Integer adjustment to add to trade confidence.
            Positive = microstructure supports the trade.
            Negative = microstructure advises against the trade.
        """
        with self._lock:
            cached = self._cache.get(symbol)
            if not cached or time.time() - cached[0] >= CACHE_TTL:
                return 0

            data = cached[1]
            adjustment = 0

            # Liquidity bonus/penalty
            liq_score = data.get("liquidity_score", 50.0)
            if liq_score >= 75:
                adjustment += 3   # good liquidity supports entry
            elif liq_score <= 25:
                adjustment -= 5   # poor liquidity penalizes

            # Toxicity penalty
            tox_score = data.get("toxicity_score", 0.0)
            if tox_score >= 70:
                adjustment -= 7   # very toxic, strong penalty
            elif tox_score >= 50:
                adjustment -= 4   # moderately toxic

            # Tick imbalance alignment
            tick_imb = data.get("tick_imbalance", {})
            if tick_imb.get("informed_trading", False):
                informed_dir = tick_imb.get("informed_direction", "NEUTRAL")
                if informed_dir == action:
                    adjustment += 4  # aligned with informed flow
                elif informed_dir != "NEUTRAL":
                    adjustment -= 5  # fighting informed traders

            # Spread regime
            spread = data.get("spread", {})
            if spread.get("regime") == "WIDE":
                adjustment -= 2  # wide spread = bad fills
            elif spread.get("regime") == "TIGHT":
                adjustment += 2  # tight spread = good fills

            return max(-10, min(10, adjustment))

    def get_status(self) -> dict:
        """Get service status and summary across all tracked symbols."""
        with self._lock:
            symbols_tracked = list(self._cache.keys())
            now = time.time()

            symbol_summaries = {}
            for sym in symbols_tracked:
                cached = self._cache.get(sym)
                if cached:
                    age = now - cached[0]
                    data = cached[1]
                    symbol_summaries[sym] = {
                        "liquidity_score": data.get("liquidity_score", 0),
                        "toxicity_score": data.get("toxicity_score", 0),
                        "position_adjustment": data.get("position_size_adjustment", 1.0),
                        "spread_regime": data.get("spread", {}).get("regime", "UNKNOWN"),
                        "kyle_toxicity": data.get("kyle_lambda", {}).get("toxicity", "UNKNOWN"),
                        "amihud_regime": data.get("amihud", {}).get("liquidity_regime", "UNKNOWN"),
                        "volume_clock": data.get("volume_clock", {}).get("regime", "UNKNOWN"),
                        "informed_trading": data.get("tick_imbalance", {}).get(
                            "informed_trading", False
                        ),
                        "cache_age_s": round(age, 1),
                    }

            # Aggregate stats
            spread_obs = sum(
                len(self._spread_history.get(s, []))
                for s in symbols_tracked
            )
            trade_flow_obs = sum(
                len(self._trade_flow.get(s, []))
                for s in symbols_tracked
            )
            tick_bars = sum(
                len(self._tick_imb_bars.get(s, []))
                for s in symbols_tracked
            )

            return {
                "service": "MicrostructureAnalyzer",
                "symbols_tracked": len(symbols_tracked),
                "symbols": symbol_summaries,
                "total_spread_observations": spread_obs,
                "total_trade_flow_observations": trade_flow_obs,
                "total_tick_imbalance_bars": tick_bars,
                "cache_ttl_s": CACHE_TTL,
            }


# ── Module-level singleton ───────────────────────────────────────────────────

_microstructure: Optional[MicrostructureAnalyzer] = None
_singleton_lock = threading.Lock()


def get_microstructure() -> MicrostructureAnalyzer:
    """Get or create the singleton MicrostructureAnalyzer instance."""
    global _microstructure
    if _microstructure is None:
        with _singleton_lock:
            if _microstructure is None:
                _microstructure = MicrostructureAnalyzer()
    return _microstructure
