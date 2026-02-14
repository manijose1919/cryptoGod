"""
Smart Order Router

Compares prices across exchanges (Crypto.com via ccxt + Binance WebSocket)
and routes to the best execution price. In paper trading mode, simulates
price improvement from cross-exchange comparison.
"""

import logging
import time
from typing import Optional

logger = logging.getLogger("smart_order_router")


class SmartOrderRouter:
    """Routes orders to the best available price across exchanges."""

    def __init__(self):
        self._binance_ws = None
        self._price_improvements: list = []  # Track historical improvements
        self._total_saved = 0.0

    def set_binance_ws(self, ws):
        """Inject Binance WebSocket reference."""
        self._binance_ws = ws

    def get_best_price(self, symbol: str, side: str, crypto_com_price: float) -> dict:
        """Compare prices and return the best execution venue.

        Args:
            symbol: Trading pair (e.g., "BTC/USD")
            side: "BUY" or "SELL"
            crypto_com_price: Current price on Crypto.com

        Returns:
            {
                best_price: float,
                venue: "crypto_com" | "binance",
                improvement_pct: float,
                binance_price: float | None,
            }
        """
        result = {
            "best_price": crypto_com_price,
            "venue": "crypto_com",
            "improvement_pct": 0.0,
            "binance_price": None,
            "crypto_com_price": crypto_com_price,
        }

        # Get Binance price from WebSocket
        binance_price = None
        if self._binance_ws:
            binance_price = self._binance_ws.get_price(symbol)

        if binance_price is None or binance_price <= 0:
            return result

        result["binance_price"] = binance_price

        # Determine best price based on side
        if side == "BUY":
            # For buying, lower price is better
            if binance_price < crypto_com_price:
                improvement = (crypto_com_price - binance_price) / crypto_com_price * 100
                result["best_price"] = binance_price
                result["venue"] = "binance"
                result["improvement_pct"] = round(improvement, 4)
        else:
            # For selling, higher price is better
            if binance_price > crypto_com_price:
                improvement = (binance_price - crypto_com_price) / crypto_com_price * 100
                result["best_price"] = binance_price
                result["venue"] = "binance"
                result["improvement_pct"] = round(improvement, 4)

        # Track improvements
        if result["improvement_pct"] > 0:
            self._price_improvements.append({
                "symbol": symbol,
                "side": side,
                "improvement_pct": result["improvement_pct"],
                "time": time.time(),
            })
            # Keep last 100
            if len(self._price_improvements) > 100:
                self._price_improvements = self._price_improvements[-100:]

        return result

    def simulate_price_improvement(self, symbol: str, side: str, price: float, size_usd: float) -> dict:
        """For paper trading: simulate the price improvement from smart routing.

        Returns adjusted price and estimated savings.
        """
        routing = self.get_best_price(symbol, side, price)

        if routing["improvement_pct"] > 0:
            # Apply price improvement
            improved_price = routing["best_price"]
            savings_usd = abs(improved_price - price) * (size_usd / price)
            self._total_saved += savings_usd

            return {
                "original_price": price,
                "improved_price": improved_price,
                "venue": routing["venue"],
                "savings_usd": round(savings_usd, 4),
                "improvement_pct": routing["improvement_pct"],
            }

        return {
            "original_price": price,
            "improved_price": price,
            "venue": "crypto_com",
            "savings_usd": 0.0,
            "improvement_pct": 0.0,
        }

    def get_cross_exchange_spread(self, symbol: str) -> dict:
        """Get the spread between Crypto.com and Binance for arbitrage detection."""
        if not self._binance_ws:
            return {"spread_pct": 0, "available": False}

        binance_price = self._binance_ws.get_price(symbol)
        if not binance_price:
            return {"spread_pct": 0, "available": False}

        # We don't have Crypto.com real-time price here,
        # but depth data from Binance can show spread
        depth = self._binance_ws.get_depth_snapshot(symbol)

        return {
            "binance_price": binance_price,
            "binance_spread_pct": depth.get("spread", 0) if depth else 0,
            "available": True,
        }

    def get_status(self) -> dict:
        recent = self._price_improvements[-10:] if self._price_improvements else []
        avg_improvement = (
            sum(r["improvement_pct"] for r in self._price_improvements) / len(self._price_improvements)
            if self._price_improvements else 0
        )
        return {
            "total_improvements": len(self._price_improvements),
            "avg_improvement_pct": round(avg_improvement, 4),
            "total_saved_usd": round(self._total_saved, 4),
            "recent_improvements": recent[-5:],
            "binance_ws_connected": self._binance_ws is not None and self._binance_ws._running,
        }


# Singleton
_instance: Optional[SmartOrderRouter] = None


def get_smart_router() -> SmartOrderRouter:
    global _instance
    if _instance is None:
        _instance = SmartOrderRouter()
    return _instance
