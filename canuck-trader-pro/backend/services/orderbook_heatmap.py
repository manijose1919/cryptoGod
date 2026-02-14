"""
Order Book Heatmap & Depth Analysis Service

Analyzes Binance order book depth snapshots to detect buy/sell walls,
bid-ask imbalance, spoofing behaviour, and wall movement direction.
Produces trading signals and confidence adjustments for the bot loop.
"""

import logging
import threading
import time
from collections import defaultdict, deque
from typing import Optional

import numpy as np

logger = logging.getLogger("orderbook_heatmap")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WALL_MULTIPLIER = 3.0        # Orders > 3x average = wall
PROXIMITY_PCT = 0.01         # 1% from mid-price
HISTORY_LENGTH = 20          # Rolling snapshots kept per symbol
SPOOF_DISAPPEAR_PCT = 0.70   # Wall vanishes by 70% between snapshots = spoof
IMBALANCE_STRONG = 0.40      # |imbalance| above this is a strong signal
MAX_CONFIDENCE_ADJ = 10      # Confidence adjustment cap


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

class WallInfo:
    """Represents a detected wall in the order book."""

    __slots__ = ("price", "quantity", "side", "distance_pct")

    def __init__(self, price: float, quantity: float, side: str, distance_pct: float):
        self.price = price
        self.quantity = quantity
        self.side = side
        self.distance_pct = distance_pct

    def to_dict(self) -> dict:
        return {
            "price": round(self.price, 8),
            "quantity": round(self.quantity, 8),
            "side": self.side,
            "distance_pct": round(self.distance_pct, 4),
        }


class DepthSnapshot:
    """Lightweight record of walls seen in a single depth update."""

    __slots__ = ("time", "buy_walls", "sell_walls", "mid_price")

    def __init__(
        self,
        ts: float,
        buy_walls: list[WallInfo],
        sell_walls: list[WallInfo],
        mid_price: float,
    ):
        self.time = ts
        self.buy_walls = buy_walls
        self.sell_walls = sell_walls
        self.mid_price = mid_price


# ---------------------------------------------------------------------------
# OrderBookHeatmap
# ---------------------------------------------------------------------------

class OrderBookHeatmap:
    """Thread-safe order book depth analyser (singleton)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # symbol -> deque of DepthSnapshot
        self._history: dict[str, deque[DepthSnapshot]] = defaultdict(
            lambda: deque(maxlen=HISTORY_LENGTH)
        )
        # Cache latest analysis per symbol
        self._latest: dict[str, dict] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze_depth(self, symbol: str, depth_data: dict) -> dict:
        """Analyse a depth snapshot and return trading signals.

        Parameters
        ----------
        symbol : str
            Our normalised symbol, e.g. "BTC/USD".
        depth_data : dict
            Depth dict from BinanceWebSocket._depth[symbol].
            Expected keys: ``bids`` (list of (price, qty) tuples),
            ``asks`` (list of (price, qty) tuples).  May also contain
            ``bid_total``, ``ask_total``, ``spread``, ``time``.

        Returns
        -------
        dict
            ``buy_walls``, ``sell_walls``, ``imbalance`` (-1..1),
            ``spoofing_detected``, ``wall_direction``, ``signal``.
        """
        try:
            bids: list[tuple[float, float]] = depth_data.get("bids", [])
            asks: list[tuple[float, float]] = depth_data.get("asks", [])

            if not bids or not asks:
                return self._neutral_result()

            mid_price = (bids[0][0] + asks[0][0]) / 2.0

            buy_walls = self._detect_walls(bids, mid_price, "BUY")
            sell_walls = self._detect_walls(asks, mid_price, "SELL")
            imbalance = self._calc_imbalance(bids, asks, mid_price)
            spoofing = False
            wall_direction = "NEUTRAL"

            snapshot = DepthSnapshot(
                ts=time.time(),
                buy_walls=buy_walls,
                sell_walls=sell_walls,
                mid_price=mid_price,
            )

            with self._lock:
                history = self._history[symbol]
                if len(history) >= 2:
                    spoofing = self._detect_spoofing(history[-1], snapshot)
                    wall_direction = self._calc_wall_direction(history, snapshot)
                history.append(snapshot)

            signal = self._determine_signal(buy_walls, sell_walls, imbalance, spoofing)

            result: dict = {
                "buy_walls": [w.to_dict() for w in buy_walls],
                "sell_walls": [w.to_dict() for w in sell_walls],
                "imbalance": round(imbalance, 4),
                "spoofing_detected": spoofing,
                "wall_direction": wall_direction,
                "signal": signal,
                "mid_price": round(mid_price, 8),
                "timestamp": time.time(),
            }

            with self._lock:
                self._latest[symbol] = result

            return result

        except Exception as e:
            logger.error(f"analyze_depth error for {symbol}: {e}", exc_info=True)
            return self._neutral_result()

    def get_confidence_adjustment(self, symbol: str, action: str) -> int:
        """Return a confidence adjustment from -10 to +10.

        A positive value means the order book supports *action*;
        negative means it opposes it.

        Parameters
        ----------
        symbol : str
            Normalised symbol, e.g. "BTC/USD".
        action : str
            ``"BUY"`` or ``"SELL"``.

        Returns
        -------
        int
            Confidence delta in [-10, +10].
        """
        with self._lock:
            analysis = self._latest.get(symbol)

        if analysis is None:
            return 0

        try:
            imbalance: float = analysis["imbalance"]
            buy_wall_strength = sum(w["quantity"] for w in analysis["buy_walls"])
            sell_wall_strength = sum(w["quantity"] for w in analysis["sell_walls"])
            spoofing: bool = analysis["spoofing_detected"]
            wall_dir: str = analysis["wall_direction"]
            signal: str = analysis["signal"]

            adj = 0.0

            # --- Imbalance component (max +/- 4) ---
            if action == "BUY":
                adj += imbalance * 4.0   # positive imbalance = more bids = good for buy
            else:
                adj -= imbalance * 4.0   # positive imbalance = bad for sell

            # --- Wall component (max +/- 3) ---
            total_wall = buy_wall_strength + sell_wall_strength
            if total_wall > 0:
                wall_ratio = (buy_wall_strength - sell_wall_strength) / total_wall
                if action == "BUY":
                    adj += wall_ratio * 3.0
                else:
                    adj -= wall_ratio * 3.0

            # --- Signal alignment (max +/- 2) ---
            if signal == action:
                adj += 2.0
            elif signal != "NEUTRAL" and signal != action:
                adj -= 2.0

            # --- Wall direction (max +/- 1) ---
            if action == "BUY" and wall_dir == "UP":
                adj += 1.0
            elif action == "BUY" and wall_dir == "DOWN":
                adj -= 1.0
            elif action == "SELL" and wall_dir == "DOWN":
                adj += 1.0
            elif action == "SELL" and wall_dir == "UP":
                adj -= 1.0

            # --- Spoofing penalty ---
            if spoofing:
                # Reduce magnitude — we are less sure about anything
                adj *= 0.5

            return int(max(-MAX_CONFIDENCE_ADJ, min(MAX_CONFIDENCE_ADJ, round(adj))))

        except Exception as e:
            logger.error(f"get_confidence_adjustment error for {symbol}: {e}", exc_info=True)
            return 0

    def get_latest_analysis(self, symbol: str) -> Optional[dict]:
        """Return the most recently cached analysis for *symbol*."""
        with self._lock:
            return self._latest.get(symbol)

    def get_all_analyses(self) -> dict[str, dict]:
        """Return latest analyses for every tracked symbol."""
        with self._lock:
            return dict(self._latest)

    def get_status(self) -> dict:
        """Return a summary of tracked symbols and snapshot counts."""
        with self._lock:
            return {
                "tracked_symbols": list(self._history.keys()),
                "snapshot_counts": {
                    sym: len(dq) for sym, dq in self._history.items()
                },
                "symbols_with_analysis": list(self._latest.keys()),
            }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _detect_walls(
        orders: list[tuple[float, float]],
        mid_price: float,
        side: str,
    ) -> list[WallInfo]:
        """Find orders that are > WALL_MULTIPLIER x the average size
        and within PROXIMITY_PCT of mid_price."""
        if not orders:
            return []

        prices = np.array([o[0] for o in orders], dtype=np.float64)
        qtys = np.array([o[1] for o in orders], dtype=np.float64)

        # Filter to orders within proximity band
        lower = mid_price * (1.0 - PROXIMITY_PCT)
        upper = mid_price * (1.0 + PROXIMITY_PCT)
        mask = (prices >= lower) & (prices <= upper)

        if not np.any(mask):
            return []

        nearby_prices = prices[mask]
        nearby_qtys = qtys[mask]

        avg_qty = float(np.mean(nearby_qtys))
        if avg_qty <= 0:
            return []

        threshold = avg_qty * WALL_MULTIPLIER
        wall_mask = nearby_qtys > threshold

        walls: list[WallInfo] = []
        for i in np.where(wall_mask)[0]:
            p = float(nearby_prices[i])
            q = float(nearby_qtys[i])
            dist = abs(p - mid_price) / mid_price
            walls.append(WallInfo(price=p, quantity=q, side=side, distance_pct=dist))

        # Sort by quantity descending
        walls.sort(key=lambda w: w.quantity, reverse=True)
        return walls

    @staticmethod
    def _calc_imbalance(
        bids: list[tuple[float, float]],
        asks: list[tuple[float, float]],
        mid_price: float,
    ) -> float:
        """Bid-ask imbalance ratio in [-1, 1].

        Positive means more bid volume (buying pressure).
        Only considers orders within PROXIMITY_PCT of mid.
        """
        lower = mid_price * (1.0 - PROXIMITY_PCT)
        upper = mid_price * (1.0 + PROXIMITY_PCT)

        bid_vol = sum(q for p, q in bids if p >= lower)
        ask_vol = sum(q for p, q in asks if p <= upper)

        total = bid_vol + ask_vol
        if total == 0:
            return 0.0

        return (bid_vol - ask_vol) / total

    @staticmethod
    def _detect_spoofing(prev: DepthSnapshot, curr: DepthSnapshot) -> bool:
        """Check if large walls from the previous snapshot vanished.

        A wall that loses > SPOOF_DISAPPEAR_PCT of its size between two
        consecutive snapshots is flagged as a potential spoof.
        """
        def _wall_set(walls: list[WallInfo]) -> dict[float, float]:
            return {w.price: w.quantity for w in walls}

        for prev_walls, curr_walls in [
            (prev.buy_walls, curr.buy_walls),
            (prev.sell_walls, curr.sell_walls),
        ]:
            prev_map = _wall_set(prev_walls)
            curr_map = _wall_set(curr_walls)

            for price, prev_qty in prev_map.items():
                curr_qty = curr_map.get(price, 0.0)
                if prev_qty > 0 and (1.0 - curr_qty / prev_qty) >= SPOOF_DISAPPEAR_PCT:
                    logger.debug(
                        f"Potential spoof: wall at {price} dropped "
                        f"{prev_qty:.4f} -> {curr_qty:.4f}"
                    )
                    return True

        return False

    @staticmethod
    def _calc_wall_direction(
        history: deque[DepthSnapshot],
        current: DepthSnapshot,
    ) -> str:
        """Determine if the dominant wall cluster is moving UP, DOWN, or NEUTRAL.

        Compares the volume-weighted average wall price over the last few
        snapshots to the current one.
        """
        def _vwap_walls(snap: DepthSnapshot) -> Optional[float]:
            all_walls = snap.buy_walls + snap.sell_walls
            if not all_walls:
                return None
            total_qty = sum(w.quantity for w in all_walls)
            if total_qty == 0:
                return None
            return sum(w.price * w.quantity for w in all_walls) / total_qty

        # Collect recent VWAPs (up to last 5 snapshots)
        recent_vwaps: list[float] = []
        lookback = min(5, len(history))
        for i in range(lookback):
            snap = history[-(i + 1)]
            v = _vwap_walls(snap)
            if v is not None:
                recent_vwaps.append(v)

        curr_vwap = _vwap_walls(current)

        if curr_vwap is None or len(recent_vwaps) < 2:
            return "NEUTRAL"

        avg_past = float(np.mean(recent_vwaps))
        if avg_past == 0:
            return "NEUTRAL"

        change_pct = (curr_vwap - avg_past) / avg_past

        if change_pct > 0.001:
            return "UP"
        elif change_pct < -0.001:
            return "DOWN"
        return "NEUTRAL"

    @staticmethod
    def _determine_signal(
        buy_walls: list[WallInfo],
        sell_walls: list[WallInfo],
        imbalance: float,
        spoofing: bool,
    ) -> str:
        """Combine wall and imbalance data into a single signal."""

        # If spoofing is detected, be cautious
        if spoofing:
            return "NEUTRAL"

        buy_strength = sum(w.quantity for w in buy_walls)
        sell_strength = sum(w.quantity for w in sell_walls)

        # Strong imbalance with supporting walls
        if imbalance > IMBALANCE_STRONG and buy_strength > sell_strength:
            return "BUY"
        if imbalance < -IMBALANCE_STRONG and sell_strength > buy_strength:
            return "SELL"

        # Moderate imbalance alone
        if imbalance > IMBALANCE_STRONG:
            return "BUY"
        if imbalance < -IMBALANCE_STRONG:
            return "SELL"

        # Heavy wall imbalance without strong bid/ask skew
        total = buy_strength + sell_strength
        if total > 0:
            wall_ratio = (buy_strength - sell_strength) / total
            if wall_ratio > 0.6:
                return "BUY"
            if wall_ratio < -0.6:
                return "SELL"

        return "NEUTRAL"

    @staticmethod
    def _neutral_result() -> dict:
        return {
            "buy_walls": [],
            "sell_walls": [],
            "imbalance": 0.0,
            "spoofing_detected": False,
            "wall_direction": "NEUTRAL",
            "signal": "NEUTRAL",
            "mid_price": 0.0,
            "timestamp": time.time(),
        }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[OrderBookHeatmap] = None
_instance_lock = threading.Lock()


def get_orderbook_heatmap() -> OrderBookHeatmap:
    """Return the singleton OrderBookHeatmap instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = OrderBookHeatmap()
                logger.info("OrderBookHeatmap service initialized")
    return _instance
