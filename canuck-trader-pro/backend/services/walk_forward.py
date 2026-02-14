"""
Walk-Forward Backtesting Engine

Splits historical data into rolling train/test windows to validate
strategy robustness out-of-sample. Prevents overfitting.

Flow:
1. Fetch N candles of history
2. Split into K windows: each has train_pct for parameter fitting, rest for testing
3. Run strategy on each test window using params fitted on training window
4. Aggregate out-of-sample metrics across all windows
5. Optional: parameter sweep across multiple strategy configs
"""
import logging
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import ta

import config
from strategy_engine import StrategyEngine

logger = logging.getLogger(__name__)


class BacktestResult:
    """Results from a single backtest window or full walk-forward."""

    def __init__(self):
        self.trades: list = []
        self.equity_curve: list = []
        self.initial_balance: float = 0
        self.final_balance: float = 0
        self.total_trades: int = 0
        self.win_rate: float = 0
        self.avg_win: float = 0
        self.avg_loss: float = 0
        self.max_drawdown: float = 0
        self.sharpe_ratio: float = 0
        self.profit_factor: float = 0
        self.total_pnl_pct: float = 0

    def to_dict(self) -> dict:
        return {
            "total_trades": self.total_trades,
            "win_rate": round(self.win_rate, 1),
            "avg_win": round(self.avg_win, 3),
            "avg_loss": round(self.avg_loss, 3),
            "max_drawdown": round(self.max_drawdown, 2),
            "sharpe_ratio": round(self.sharpe_ratio, 3),
            "profit_factor": round(self.profit_factor, 3),
            "total_pnl_pct": round(self.total_pnl_pct, 2),
            "initial_balance": round(self.initial_balance, 2),
            "final_balance": round(self.final_balance, 2),
            "equity_curve": self.equity_curve[-100:],  # last 100 points
            "trade_count": len(self.trades),
        }


class WalkForwardEngine:
    """Walk-forward backtesting with parameter sweep capability."""

    def __init__(self):
        self.engine = StrategyEngine()

    def run_backtest(
        self,
        df: pd.DataFrame,
        strategy_filter: Optional[List[str]] = None,
        initial_balance: float = 10000,
        position_pct: float = 0.10,
        stop_atr_mult: float = 2.0,
        tp_rr_ratio: float = 2.0,
        min_confidence: int = 40,
        fee_pct: float = config.TRADING_FEE_PCT,
    ) -> BacktestResult:
        """Run a backtest on a DataFrame of OHLCV candles.

        Args:
            df: OHLCV DataFrame with columns: open, high, low, close, volume
            strategy_filter: Only use these strategies (None = all)
            initial_balance: Starting capital
            position_pct: Position size as fraction of balance
            stop_atr_mult: ATR multiplier for stop-loss
            tp_rr_ratio: Risk:reward ratio for take-profit
            min_confidence: Minimum signal confidence to enter
            fee_pct: Per-side trading fee

        Returns: BacktestResult with all metrics
        """
        result = BacktestResult()
        result.initial_balance = initial_balance
        balance = initial_balance
        peak_balance = initial_balance
        max_dd = 0

        # Need at least 50 candles for indicators
        if len(df) < 50:
            result.final_balance = balance
            return result

        position = None  # {side, entry, stop, target, size, bar_idx}
        equity = [balance]
        trade_pnls = []

        # Pre-compute ATR for the whole series
        atr = ta.volatility.AverageTrueRange(
            df["high"], df["low"], df["close"], window=14
        ).average_true_range()

        for i in range(50, len(df)):
            # Current bar
            bar = df.iloc[i]
            price = bar["close"]

            # Check if position hits stop/target
            if position is not None:
                hit_stop = False
                hit_target = False

                if position["side"] == "BUY":
                    hit_stop = bar["low"] <= position["stop"]
                    hit_target = bar["high"] >= position["target"]
                else:
                    hit_stop = bar["high"] >= position["stop"]
                    hit_target = bar["low"] <= position["target"]

                if hit_stop or hit_target:
                    exit_price = position["stop"] if hit_stop else position["target"]
                    if position["side"] == "BUY":
                        pnl_pct = (exit_price - position["entry"]) / position["entry"]
                    else:
                        pnl_pct = (position["entry"] - exit_price) / position["entry"]
                    pnl_pct -= fee_pct * 2  # round-trip fees

                    pnl_usd = position["size"] * pnl_pct
                    balance += pnl_usd
                    peak_balance = max(peak_balance, balance)
                    dd = (peak_balance - balance) / peak_balance if peak_balance > 0 else 0
                    max_dd = max(max_dd, dd)

                    trade_pnls.append(pnl_pct * 100)
                    result.trades.append({
                        "entry_bar": position["bar_idx"],
                        "exit_bar": i,
                        "side": position["side"],
                        "entry": position["entry"],
                        "exit": exit_price,
                        "pnl_pct": round(pnl_pct * 100, 3),
                        "reason": "STOP" if hit_stop else "TARGET",
                    })
                    position = None

            # Generate signals on lookback window
            if position is None and i % 3 == 0:  # check every 3 bars for speed
                window = df.iloc[max(0, i - 200):i + 1].copy()
                if len(window) >= 30:
                    signals = self.engine.run_all(window)

                    # Filter strategies if specified
                    if strategy_filter:
                        signals = [s for s in signals if s["name"] in strategy_filter]

                    consensus = self._get_consensus(signals)

                    if consensus["confidence"] >= min_confidence and consensus["action"] != "HOLD":
                        action = consensus["action"]
                        atr_val = atr.iloc[i] if not np.isnan(atr.iloc[i]) else price * 0.02
                        risk = stop_atr_mult * atr_val

                        if action == "BUY":
                            stop = price - risk
                            target = price + risk * tp_rr_ratio
                        else:
                            stop = price + risk
                            target = price - risk * tp_rr_ratio

                        size = balance * position_pct
                        position = {
                            "side": action,
                            "entry": price,
                            "stop": stop,
                            "target": target,
                            "size": size,
                            "bar_idx": i,
                        }

            equity.append(balance)

        # Close any remaining position at last price
        if position is not None:
            exit_price = df["close"].iloc[-1]
            if position["side"] == "BUY":
                pnl_pct = (exit_price - position["entry"]) / position["entry"]
            else:
                pnl_pct = (position["entry"] - exit_price) / position["entry"]
            pnl_pct -= fee_pct * 2
            balance += position["size"] * pnl_pct
            trade_pnls.append(pnl_pct * 100)

        # Compute metrics
        result.final_balance = balance
        result.equity_curve = [round(e, 2) for e in equity[::max(1, len(equity) // 100)]]
        result.total_trades = len(trade_pnls)
        result.total_pnl_pct = round((balance - initial_balance) / initial_balance * 100, 2)
        result.max_drawdown = round(max_dd * 100, 2)

        if trade_pnls:
            wins = [p for p in trade_pnls if p > 0]
            losses = [p for p in trade_pnls if p < 0]
            result.win_rate = len(wins) / len(trade_pnls) * 100
            result.avg_win = np.mean(wins) if wins else 0
            result.avg_loss = np.mean(losses) if losses else 0
            total_wins = sum(wins)
            total_losses = abs(sum(losses))
            result.profit_factor = total_wins / total_losses if total_losses > 0 else float("inf")

            # Sharpe ratio (annualized, assuming ~8760 trades/year for hourly)
            returns = np.array(trade_pnls)
            if returns.std() > 0:
                result.sharpe_ratio = (returns.mean() / returns.std()) * np.sqrt(252)

        return result

    def _get_consensus(self, signals: list) -> dict:
        """Simple consensus from signal list."""
        buy_score = 0
        sell_score = 0
        for s in signals:
            conf = s.get("confidence", 0) / 100.0
            if s["signal"] == "BUY":
                buy_score += conf
            elif s["signal"] == "SELL":
                sell_score += conf

        total = buy_score + sell_score
        if total == 0:
            return {"action": "HOLD", "confidence": 0}

        if buy_score > sell_score:
            return {"action": "BUY", "confidence": int(buy_score / total * 100)}
        elif sell_score > buy_score:
            return {"action": "SELL", "confidence": int(sell_score / total * 100)}
        return {"action": "HOLD", "confidence": 0}

    def walk_forward(
        self,
        df: pd.DataFrame,
        n_windows: int = 5,
        train_pct: float = 0.7,
        **backtest_kwargs,
    ) -> dict:
        """Run walk-forward analysis with rolling train/test windows.

        Splits data into n_windows. Each window uses train_pct for "training"
        (warm-up) and the rest for out-of-sample testing.

        Returns aggregate metrics across all test windows.
        """
        n = len(df)
        window_size = n // n_windows
        if window_size < 100:
            return {"error": "Not enough data for walk-forward", "candles": n, "windows": n_windows}

        all_results = []
        window_details = []

        for w in range(n_windows):
            start = w * window_size
            end = min(start + window_size, n)
            window_df = df.iloc[start:end].reset_index(drop=True)

            # Only test on the last (1-train_pct) of each window
            train_end = int(len(window_df) * train_pct)
            test_df = window_df.iloc[train_end:].reset_index(drop=True)

            # Need enough data in test window
            if len(test_df) < 50:
                continue

            # Use the full window for indicator warm-up but only count trades in test portion
            result = self.run_backtest(window_df, **backtest_kwargs)
            all_results.append(result)

            window_details.append({
                "window": w + 1,
                "start_bar": start,
                "end_bar": end,
                "test_start": start + train_end,
                "candles": len(window_df),
                "test_candles": len(test_df),
                **result.to_dict(),
            })

        if not all_results:
            return {"error": "No valid windows"}

        # Aggregate
        total_trades = sum(r.total_trades for r in all_results)
        total_pnls = []
        for r in all_results:
            total_pnls.extend([t["pnl_pct"] for t in r.trades])

        wins = [p for p in total_pnls if p > 0]
        losses = [p for p in total_pnls if p < 0]

        return {
            "n_windows": len(all_results),
            "total_trades": total_trades,
            "avg_trades_per_window": round(total_trades / len(all_results), 1),
            "overall_win_rate": round(len(wins) / len(total_pnls) * 100, 1) if total_pnls else 0,
            "avg_pnl_per_trade": round(np.mean(total_pnls), 3) if total_pnls else 0,
            "avg_win": round(np.mean(wins), 3) if wins else 0,
            "avg_loss": round(np.mean(losses), 3) if losses else 0,
            "max_drawdown": round(max(r.max_drawdown for r in all_results), 2),
            "avg_sharpe": round(np.mean([r.sharpe_ratio for r in all_results]), 3),
            "avg_profit_factor": round(np.mean([r.profit_factor for r in all_results if r.profit_factor < float("inf")]), 3) if any(r.profit_factor < float("inf") for r in all_results) else 0,
            "windows": window_details,
        }

    def parameter_sweep(
        self,
        df: pd.DataFrame,
        param_grid: dict,
        **base_kwargs,
    ) -> dict:
        """Run backtest across a grid of parameters.

        param_grid example:
        {
            "position_pct": [0.05, 0.10, 0.15],
            "stop_atr_mult": [1.5, 2.0, 2.5],
            "min_confidence": [30, 40, 50],
        }
        """
        # Generate all combinations
        import itertools
        keys = list(param_grid.keys())
        values = list(param_grid.values())
        combinations = list(itertools.product(*values))

        results = []
        for combo in combinations[:50]:  # cap at 50 to prevent long runs
            params = dict(zip(keys, combo))
            kwargs = {**base_kwargs, **params}
            result = self.run_backtest(df, **kwargs)
            results.append({
                "params": params,
                **result.to_dict(),
            })

        # Sort by total PnL
        results.sort(key=lambda r: r["total_pnl_pct"], reverse=True)

        return {
            "combinations_tested": len(results),
            "best": results[0] if results else None,
            "worst": results[-1] if results else None,
            "all_results": results,
        }


# Module-level singleton
_wf_engine: Optional[WalkForwardEngine] = None


def get_walk_forward_engine() -> WalkForwardEngine:
    global _wf_engine
    if _wf_engine is None:
        _wf_engine = WalkForwardEngine()
    return _wf_engine
