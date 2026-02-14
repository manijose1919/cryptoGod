"""
Paper Trader for Questrade
Port of services/PaperTrader.js.

Virtual portfolio with cash + positions for paper trading stocks.
"""

import time
import logging

logger = logging.getLogger("paper_trader")


class PaperTrader:
    def __init__(self, questrade_service, starting_cash: float = 100000):
        self.questrade = questrade_service
        self.cash = starting_cash
        self.starting_cash = starting_cash
        self.positions: dict[str, dict] = {}  # ticker -> position
        self.trade_history: list[dict] = []

    def get_positions(self) -> list[dict]:
        result = []
        for ticker, pos in self.positions.items():
            result.append({
                "symbol": ticker,
                "quantity": pos["quantity"],
                "avg_entry": pos["avg_entry"],
                "current_value": pos["quantity"] * pos.get("last_price", pos["avg_entry"]),
                "unrealized_pnl": (pos.get("last_price", pos["avg_entry"]) - pos["avg_entry"]) * pos["quantity"],
            })
        return result

    def get_account_summary(self) -> dict:
        positions_value = sum(
            p["quantity"] * p.get("last_price", p["avg_entry"])
            for p in self.positions.values()
        )
        total = self.cash + positions_value
        pnl = total - self.starting_cash
        pnl_pct = (pnl / self.starting_cash * 100) if self.starting_cash > 0 else 0

        return {
            "cash": round(self.cash, 2),
            "positions_value": round(positions_value, 2),
            "total_value": round(total, 2),
            "starting_cash": self.starting_cash,
            "pnl": round(pnl, 2),
            "pnl_percent": round(pnl_pct, 2),
            "position_count": len(self.positions),
            "trade_count": len(self.trade_history),
        }

    def buy(self, ticker: str, quantity: float, price: float) -> dict:
        cost = quantity * price
        if cost > self.cash:
            return {"success": False, "error": "Insufficient funds"}

        self.cash -= cost

        if ticker in self.positions:
            pos = self.positions[ticker]
            total_qty = pos["quantity"] + quantity
            total_cost = pos["avg_entry"] * pos["quantity"] + cost
            pos["avg_entry"] = total_cost / total_qty
            pos["quantity"] = total_qty
            pos["last_price"] = price
        else:
            self.positions[ticker] = {
                "quantity": quantity, "avg_entry": price,
                "last_price": price, "open_time": time.time(),
            }

        trade = {
            "action": "BUY", "ticker": ticker, "quantity": quantity,
            "price": price, "cost": cost, "time": time.time(),
        }
        self.trade_history.append(trade)
        logger.info(f"Paper BUY: {quantity} {ticker} @ {price:.2f}")
        return {"success": True, "trade": trade}

    def sell(self, ticker: str, quantity: float, price: float) -> dict:
        pos = self.positions.get(ticker)
        if not pos or pos["quantity"] < quantity:
            return {"success": False, "error": f"Insufficient position in {ticker}"}

        revenue = quantity * price
        pnl = (price - pos["avg_entry"]) * quantity
        self.cash += revenue
        pos["quantity"] -= quantity
        pos["last_price"] = price

        if pos["quantity"] <= 0:
            del self.positions[ticker]

        trade = {
            "action": "SELL", "ticker": ticker, "quantity": quantity,
            "price": price, "revenue": revenue, "pnl": round(pnl, 2),
            "pnl_percent": round((price - pos["avg_entry"]) / pos["avg_entry"] * 100, 2),
            "time": time.time(),
        }
        self.trade_history.append(trade)
        logger.info(f"Paper SELL: {quantity} {ticker} @ {price:.2f} (PnL: {pnl:.2f})")
        return {"success": True, "trade": trade}

    def update_prices(self, price_map: dict[str, float]):
        for ticker, price in price_map.items():
            if ticker in self.positions:
                self.positions[ticker]["last_price"] = price

    def get_history(self, limit: int = 100) -> list[dict]:
        return self.trade_history[-limit:]

    def reset(self, starting_cash: float | None = None):
        self.cash = starting_cash or self.starting_cash
        self.starting_cash = self.cash
        self.positions.clear()
        self.trade_history.clear()
        logger.info(f"Paper portfolio reset to ${self.cash:.2f}")
        return {"success": True, "cash": self.cash}
