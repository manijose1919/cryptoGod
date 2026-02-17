"""
Risk Manager
Kelly Criterion sizing, ATR-based stops, daily loss cap, drawdown tracking, CVaR risk budgeting.
"""
import logging
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import ta

import config

logger = logging.getLogger(__name__)


class RiskManager:
    """Manages position sizing, stop-losses, and daily risk limits."""

    def __init__(self, starting_balance: float = config.STARTING_BALANCE):
        self.starting_balance = starting_balance
        self.balance = starting_balance
        self.peak_balance = starting_balance
        self.daily_start_balance = starting_balance
        self.daily_pnl = 0.0
        self.last_daily_reset = time.strftime("%Y-%m-%d")

        # Trade history for Kelly
        self.trade_results: List[float] = []  # pnl percentages
        self.positions: Dict[str, dict] = {}  # symbol -> {entry, size, stop, target, side}
        self.halted = False

        # Anti-martingale streak tracking
        self._win_streak = 0
        self._loss_streak = 0

    def _reset_daily_if_needed(self):
        """Reset daily PnL tracking at midnight."""
        today = time.strftime("%Y-%m-%d")
        if today != self.last_daily_reset:
            self.daily_start_balance = self.balance
            self.daily_pnl = 0.0
            self.last_daily_reset = today
            self.halted = False
            logger.info(f"Daily reset. Balance: ${self.balance:.2f}")

    def update_balance(self, new_balance: float):
        """Update current balance and check limits."""
        self.balance = new_balance
        self.peak_balance = max(self.peak_balance, new_balance)
        self.daily_pnl = new_balance - self.daily_start_balance

    def record_trade(self, pnl_pct: float):
        """Record a completed trade result (as percentage)."""
        self.trade_results.append(pnl_pct)
        # Anti-martingale streak tracking
        if pnl_pct > 0:
            self._win_streak += 1
            self._loss_streak = 0
        elif pnl_pct < 0:
            self._loss_streak += 1
            self._win_streak = 0

    def anti_martingale_multiplier(self) -> float:
        """Anti-martingale: increase size on wins, decrease on losses."""
        if self._win_streak >= 3:
            return 1.3  # 30% bigger after 3+ wins
        elif self._win_streak >= 2:
            return 1.15  # 15% bigger after 2 wins
        elif self._loss_streak >= 3:
            return 0.5  # 50% smaller after 3+ losses
        elif self._loss_streak >= 2:
            return 0.7  # 30% smaller after 2 losses
        return 1.0

    # ── Kelly Criterion ────────────────────────────────────────────────────

    def kelly_fraction(self, regime: str = "SIDEWAYS") -> float:
        """Calculate regime-aware Kelly Criterion fraction for position sizing.

        Kelly f* = (p * b - q) / b
        where p = win rate, b = avg win/avg loss ratio, q = 1 - p

        Regime adjustments:
        - UPTREND/DOWNTREND: half-Kelly (trending is favorable)
        - SIDEWAYS: quarter-Kelly (default conservative)
        - HIGH_VOL: eighth-Kelly (preserve capital)
        - LOW_VOL: third-Kelly (moderate opportunity)
        """
        regime_kelly_mult = {
            "UPTREND": 0.50,
            "DOWNTREND": 0.40,
            "SIDEWAYS": 0.25,
            "HIGH_VOL": 0.125,
            "LOW_VOL": 0.33,
        }
        kelly_mult = regime_kelly_mult.get(regime, config.KELLY_FRACTION)

        if len(self.trade_results) < config.MIN_TRADES_FOR_KELLY:
            return min(config.MAX_POSITION_PCT, kelly_mult)

        wins = [r for r in self.trade_results if r > 0]
        losses = [r for r in self.trade_results if r < 0]

        if not wins or not losses:
            return min(config.MAX_POSITION_PCT, kelly_mult)

        p = len(wins) / len(self.trade_results)
        q = 1 - p
        avg_win = np.mean(wins)
        avg_loss = abs(np.mean(losses))
        b = avg_win / avg_loss if avg_loss > 0 else 1

        kelly = (p * b - q) / b if b > 0 else 0
        kelly = max(0, kelly)

        return min(config.MAX_POSITION_PCT, kelly * kelly_mult)

    # ── ATR Stop-Loss ──────────────────────────────────────────────────────

    def atr_stop_loss(self, df: pd.DataFrame, entry_price: float, side: str = "BUY") -> float:
        """Calculate ATR-based stop-loss price."""
        atr_series = ta.volatility.AverageTrueRange(
            df["high"], df["low"], df["close"], window=config.ATR_PERIOD
        ).average_true_range()
        atr_val = atr_series.iloc[-1]

        if side == "BUY":
            return entry_price - config.ATR_STOP_MULTIPLIER * atr_val
        else:
            return entry_price + config.ATR_STOP_MULTIPLIER * atr_val

    def atr_take_profit(self, df: pd.DataFrame, entry_price: float, side: str = "BUY", rr_ratio: float = 2.0) -> float:
        """Calculate ATR-based take-profit (risk:reward ratio)."""
        atr_series = ta.volatility.AverageTrueRange(
            df["high"], df["low"], df["close"], window=config.ATR_PERIOD
        ).average_true_range()
        atr_val = atr_series.iloc[-1]

        risk = config.ATR_STOP_MULTIPLIER * atr_val
        reward = risk * rr_ratio

        if side == "BUY":
            return entry_price + reward
        else:
            return entry_price - reward

    # ── Position Sizing ────────────────────────────────────────────────────

    def calculate_position_size(self, entry_price: float, stop_price: float) -> float:
        """Calculate position size in USD based on Kelly and risk per trade."""
        self._reset_daily_if_needed()

        if self.halted:
            return 0.0

        kelly = self.kelly_fraction()
        max_risk_usd = self.balance * kelly

        # Risk per unit = distance to stop
        risk_per_unit = abs(entry_price - stop_price)
        if risk_per_unit == 0:
            return 0.0

        # Position size capped by max_risk
        units = max_risk_usd / risk_per_unit
        position_usd = units * entry_price

        # Hard cap at MAX_POSITION_PCT of balance
        max_position = self.balance * config.MAX_POSITION_PCT
        position_usd = min(position_usd, max_position)

        # Account for fees
        position_usd -= position_usd * config.ROUND_TRIP_FEE_PCT

        return max(0, round(position_usd, 2))

    # ── Risk Checks ────────────────────────────────────────────────────────

    def check_daily_loss_limit(self) -> bool:
        """Check if daily loss cap has been hit. Returns True if OK to trade."""
        self._reset_daily_if_needed()
        max_loss = self.daily_start_balance * config.MAX_DAILY_LOSS_PCT
        if self.daily_pnl < -max_loss:
            if not self.halted:
                logger.warning(f"DAILY LOSS CAP HIT: ${self.daily_pnl:.2f} (limit: -${max_loss:.2f})")
                self.halted = True
            return False
        return True

    def _dynamic_drawdown_limit(self) -> float:
        """Compute dynamic max drawdown limit.

        After profits: tighten to protect gains (min 7%).
        At start or after losses: use default (10%).
        """
        pnl_pct = (self.balance - self.starting_balance) / self.starting_balance
        if pnl_pct > 0.10:
            # Up >10%: tighten to 7% to protect profits
            return 0.07
        elif pnl_pct > 0.05:
            # Up >5%: tighten to 8%
            return 0.08
        elif pnl_pct < -0.05:
            # Down >5%: already hurting, keep at 10% (default)
            return config.MAX_DRAWDOWN_PCT
        return config.MAX_DRAWDOWN_PCT

    def check_drawdown(self) -> dict:
        """Check current drawdown from peak. Returns status dict."""
        if self.peak_balance == 0:
            return {"drawdown_pct": 0, "status": "OK", "size_multiplier": 1.0, "peak": 0, "current": 0}

        drawdown = (self.peak_balance - self.balance) / self.peak_balance
        max_dd = self._dynamic_drawdown_limit()
        status = "OK"
        size_mult = 1.0

        if drawdown > max_dd:
            status = "REDUCE"
            size_mult = 0.5
            logger.warning(f"Drawdown {drawdown:.1%} > {max_dd:.0%} (dynamic): reducing position sizes 50%")
        elif drawdown > max_dd * 0.7:
            status = "CAUTION"
            size_mult = 0.75

        return {
            "drawdown_pct": round(drawdown * 100, 2),
            "max_drawdown_pct": round(max_dd * 100, 2),
            "status": status,
            "size_multiplier": size_mult,
            "peak": self.peak_balance,
            "current": self.balance,
        }

    def can_open_position(self, symbol: str) -> bool:
        """Check if we can open a new position for this symbol."""
        if self.halted:
            return False
        if symbol in self.positions:
            return False  # already in position
        if not self.check_daily_loss_limit():
            return False
        return True

    def check_portfolio_correlation(self, proposed_symbol: str, all_data: dict) -> float:
        """Check correlation of proposed trade with existing open positions.

        Returns position size multiplier: 1.0 (no issue), 0.5 (high corr), 0.0 (skip).
        """
        if not self.positions or proposed_symbol not in all_data:
            return 1.0

        proposed_df = all_data.get(proposed_symbol)
        if proposed_df is None or len(proposed_df) < 30:
            return 1.0

        proposed_returns = proposed_df["close"].pct_change().dropna().values[-30:]
        max_corr = 0.0

        for open_symbol in self.positions:
            if open_symbol not in all_data:
                continue
            open_df = all_data[open_symbol]
            if len(open_df) < 30:
                continue
            open_returns = open_df["close"].pct_change().dropna().values[-30:]

            n = min(len(proposed_returns), len(open_returns))
            if n < 10:
                continue

            corr = abs(float(np.corrcoef(proposed_returns[-n:], open_returns[-n:])[0, 1]))
            max_corr = max(max_corr, corr)

        if max_corr > 0.9:
            logger.info(f"Correlation risk: {proposed_symbol} corr={max_corr:.2f} with open position -> SKIP")
            return 0.0  # skip trade
        elif max_corr > 0.8:
            logger.info(f"Correlation risk: {proposed_symbol} corr={max_corr:.2f} with open position -> REDUCE 50%")
            return 0.5
        return 1.0

    # ── Position Tracking ──────────────────────────────────────────────────

    def open_position(self, symbol: str, entry_price: float, size_usd: float,
                      stop: float, target: float, side: str = "BUY"):
        """Record a new open position."""
        self.positions[symbol] = {
            "entry": entry_price,
            "size_usd": size_usd,
            "stop": stop,
            "initial_stop": stop,
            "target": target,
            "side": side,
            "open_time": time.time(),
            "high_water": entry_price,  # for trailing stop
            "low_water": entry_price,   # for trailing stop (SELL side)
            "partial_exited": False,     # for partial exits
        }
        logger.info(f"OPEN {side} {symbol}: ${size_usd:.2f} @ {entry_price}, stop={stop:.6f}, target={target:.6f}")

    def close_position(self, symbol: str, exit_price: float, reason: str = "MANUAL") -> Optional[dict]:
        """Close a position and calculate PnL."""
        if symbol not in self.positions:
            return None

        pos = self.positions.pop(symbol)
        if pos["side"] == "BUY":
            pnl_pct = (exit_price - pos["entry"]) / pos["entry"]
        else:
            pnl_pct = (pos["entry"] - exit_price) / pos["entry"]

        # Subtract round-trip fees
        pnl_pct -= config.ROUND_TRIP_FEE_PCT
        pnl_usd = pos["size_usd"] * pnl_pct

        self.balance += pnl_usd
        self.daily_pnl += pnl_usd
        self.peak_balance = max(self.peak_balance, self.balance)
        self.record_trade(pnl_pct * 100)

        result = {
            "symbol": symbol,
            "side": pos["side"],
            "entry": pos["entry"],
            "exit": exit_price,
            "pnl_pct": round(pnl_pct * 100, 3),
            "pnl_usd": round(pnl_usd, 2),
            "balance": round(self.balance, 2),
            "hold_time": round(time.time() - pos["open_time"], 1),
            "reason": reason,
            "top_signal": pos.get("top_signal", ""),
        }
        logger.info(f"CLOSE {symbol}: PnL {result['pnl_pct']}% (${result['pnl_usd']}) [{reason}]")
        return result

    def _update_trailing_stop(self, symbol: str, price: float):
        """Update trailing stop — percentage-based trail behind price.

        Activates at TRAILING_STOP_ACTIVATION_PCT profit (+0.5%).
        Then trails TRAILING_STOP_DISTANCE_PCT behind the high-water mark.
        Also uses R-multiple tightening on big winners.
        """
        pos = self.positions[symbol]
        entry = pos["entry"]
        initial_risk = abs(entry - pos["initial_stop"])

        trail_activation = getattr(config, "TRAILING_STOP_ACTIVATION_PCT", 0.005)
        trail_distance = getattr(config, "TRAILING_STOP_DISTANCE_PCT", 0.005)

        if pos["side"] == "BUY":
            pos["high_water"] = max(pos["high_water"], price)
            unrealized_pct = (pos["high_water"] - entry) / entry

            # Percentage trailing stop: activate at +0.5%, trail 0.5% behind peak
            if unrealized_pct >= trail_activation:
                trail_stop = pos["high_water"] * (1 - trail_distance)
                if trail_stop > pos["stop"]:
                    if not pos.get("trailing_active"):
                        logger.info(f"TRAIL {symbol}: activated at +{unrealized_pct*100:.2f}%, trail={trail_distance*100:.1f}%")
                        pos["trailing_active"] = True
                    pos["stop"] = trail_stop

            # R-multiple tightening on big runners (if initial_risk is valid)
            if initial_risk > 0:
                profit = pos["high_water"] - entry
                r_multiple = profit / initial_risk
                if r_multiple >= 3.0:
                    # At 3R+, tighten trail to 0.3% behind price
                    tight_stop = pos["high_water"] * (1 - 0.003)
                    if tight_stop > pos["stop"]:
                        pos["stop"] = tight_stop

        else:  # SELL
            pos["low_water"] = min(pos["low_water"], price)
            unrealized_pct = (entry - pos["low_water"]) / entry

            if unrealized_pct >= trail_activation:
                trail_stop = pos["low_water"] * (1 + trail_distance)
                if trail_stop < pos["stop"]:
                    if not pos.get("trailing_active"):
                        logger.info(f"TRAIL {symbol}: activated at +{unrealized_pct*100:.2f}%, trail={trail_distance*100:.1f}%")
                        pos["trailing_active"] = True
                    pos["stop"] = trail_stop

            if initial_risk > 0:
                profit = entry - pos["low_water"]
                r_multiple = profit / initial_risk
                if r_multiple >= 3.0:
                    tight_stop = pos["low_water"] * (1 + 0.003)
                    if tight_stop < pos["stop"]:
                        pos["stop"] = tight_stop

    def _check_partial_exit(self, symbol: str, price: float) -> Optional[dict]:
        """Check if we should do a partial exit (50% at 1R profit).

        Returns partial close result or None.
        """
        pos = self.positions[symbol]
        if pos.get("partial_exited"):
            return None

        entry = pos["entry"]
        initial_risk = abs(entry - pos["initial_stop"])

        if pos["side"] == "BUY":
            profit = price - entry
        else:
            profit = entry - price

        # Partial exit at 1R profit
        if profit >= initial_risk and initial_risk > 0:
            pos["partial_exited"] = True
            partial_size = pos["size_usd"] * 0.5
            pos["size_usd"] *= 0.5  # reduce remaining position

            if pos["side"] == "BUY":
                pnl_pct = (price - entry) / entry - config.ROUND_TRIP_FEE_PCT
            else:
                pnl_pct = (entry - price) / entry - config.ROUND_TRIP_FEE_PCT

            pnl_usd = partial_size * pnl_pct
            self.balance += pnl_usd
            self.daily_pnl += pnl_usd
            self.peak_balance = max(self.peak_balance, self.balance)
            self.record_trade(pnl_pct * 100)

            # Move stop to breakeven for remainder
            pos["stop"] = entry

            result = {
                "symbol": symbol,
                "side": pos["side"],
                "entry": entry,
                "exit": price,
                "pnl_pct": round(pnl_pct * 100, 3),
                "pnl_usd": round(pnl_usd, 2),
                "balance": round(self.balance, 2),
                "reason": "PARTIAL_EXIT_1R",
                "partial": True,
            }
            logger.info(f"PARTIAL EXIT {symbol}: 50% closed at 1R (+{result['pnl_pct']}%)")
            return result
        return None

    def check_stops(self, current_prices: Dict[str, float]) -> List[dict]:
        """Check all open positions against stops, targets, partial exits, and trailing stops."""
        closed = []
        for symbol in list(self.positions.keys()):
            if symbol not in current_prices:
                continue
            price = current_prices[symbol]
            pos = self.positions[symbol]

            # Grace period: no stop-loss in first 60s (let trade breathe past noise)
            hold_seconds = time.time() - pos.get("open_time", time.time())

            # Update trailing stop (always, even during grace)
            self._update_trailing_stop(symbol, price)

            # Break-even stop: once +0.3% in profit, move stop to entry + fees
            # This prevents green trades from turning into losses
            if not pos.get("breakeven_set"):
                if pos["side"] == "BUY":
                    unrealized_pct = (price - pos["entry"]) / pos["entry"]
                else:
                    unrealized_pct = (pos["entry"] - price) / pos["entry"]
                if unrealized_pct >= 0.003:  # +0.3%
                    fee_buffer = pos["entry"] * config.ROUND_TRIP_FEE_PCT  # cover fees
                    if pos["side"] == "BUY":
                        new_stop = pos["entry"] + fee_buffer
                        if new_stop > pos["stop"]:
                            pos["stop"] = new_stop
                            pos["breakeven_set"] = True
                            logger.info(f"BREAKEVEN {symbol}: stop moved to {new_stop:.4f} (+fees)")
                    else:
                        new_stop = pos["entry"] - fee_buffer
                        if new_stop < pos["stop"]:
                            pos["stop"] = new_stop
                            pos["breakeven_set"] = True
                            logger.info(f"BREAKEVEN {symbol}: stop moved to {new_stop:.4f} (-fees)")

            # Check partial exit (only after grace)
            if hold_seconds >= 60:
                partial = self._check_partial_exit(symbol, price)
                if partial:
                    closed.append(partial)

            # Check full stop/target (position may still be open after partial)
            if symbol not in self.positions:
                continue
            pos = self.positions[symbol]

            hit_stop = (pos["side"] == "BUY" and price <= pos["stop"]) or \
                       (pos["side"] == "SELL" and price >= pos["stop"])
            hit_target = (pos["side"] == "BUY" and price >= pos["target"]) or \
                         (pos["side"] == "SELL" and price <= pos["target"])

            # During grace period, only allow take-profit (not stop-loss or time exits)
            if hold_seconds < 60:
                if hit_target:
                    result = self.close_position(symbol, price)
                    if result:
                        result["reason"] = "TAKE_PROFIT"
                        closed.append(result)
                continue

            # Time-based exit: configurable (default 45min) with no profit
            hold_time = time.time() - pos["open_time"]
            if pos["side"] == "BUY":
                unrealized = (price - pos["entry"]) / pos["entry"]
            else:
                unrealized = (pos["entry"] - price) / pos["entry"]
            time_exit_seconds = getattr(config, "TIME_EXIT_MINUTES", 45) * 60
            time_exit = hold_time > time_exit_seconds and unrealized < config.ROUND_TRIP_FEE_PCT

            # When target is hit AFTER partial exit: let trailing stop manage the runner
            if hit_target and pos.get("partial_exited"):
                # Remove fixed target — trailing stop is now the only exit
                if pos["side"] == "BUY":
                    pos["target"] = pos["entry"] * 1.50  # effectively no cap (50% above entry)
                else:
                    pos["target"] = pos["entry"] * 0.50  # effectively no cap (50% below entry)
                logger.info(f"RUNNER {symbol}: target hit, switching to trailing-stop-only mode")
                hit_target = False  # don't exit now

            # Time exit: only force-exit if NOT in profit (let winners run past 15min)
            if time_exit:
                if unrealized > config.ROUND_TRIP_FEE_PCT:
                    time_exit = False  # in profit — keep running with trailing stop

            if hit_stop or hit_target or time_exit:
                reason = "STOP_LOSS" if hit_stop else ("TAKE_PROFIT" if hit_target else "TIME_EXIT")
                result = self.close_position(symbol, price)
                if result:
                    result["reason"] = reason
                    closed.append(result)
        return closed

    # ── CVaR Risk Budgeting ─────────────────────────────────────────────────

    def compute_var_cvar(self, confidence: float = 0.95) -> dict:
        """Compute Value at Risk and Conditional Value at Risk (Expected Shortfall).

        VaR: The maximum loss at the given confidence level.
        CVaR: The expected loss given that loss exceeds VaR (tail risk).

        Uses historical simulation from trade_results.
        """
        if len(self.trade_results) < 10:
            return {
                "var_pct": 0, "cvar_pct": 0,
                "var_usd": 0, "cvar_usd": 0,
                "samples": len(self.trade_results),
                "confidence": confidence,
                "sufficient_data": False,
            }

        returns = np.array(self.trade_results) / 100.0  # convert from % to decimal
        alpha = 1 - confidence

        # VaR: percentile of losses
        var_pct = float(np.percentile(returns, alpha * 100))

        # CVaR: mean of returns worse than VaR
        tail_returns = returns[returns <= var_pct]
        cvar_pct = float(np.mean(tail_returns)) if len(tail_returns) > 0 else var_pct

        return {
            "var_pct": round(var_pct * 100, 3),        # as percentage
            "cvar_pct": round(cvar_pct * 100, 3),      # as percentage
            "var_usd": round(self.balance * abs(var_pct), 2),
            "cvar_usd": round(self.balance * abs(cvar_pct), 2),
            "samples": len(self.trade_results),
            "confidence": confidence,
            "sufficient_data": True,
        }

    def check_intraday_var(self) -> dict:
        """Check 1-hour rolling VaR. If VaR exceeds 2% of balance, signal to reduce/pause.

        Returns: {"var_pct": float, "var_usd": float, "exceeded": bool, "size_multiplier": float}
        """
        VAR_LIMIT_PCT = 0.02  # 2% of balance

        # Use last 12 trade results (roughly 1 hour at 5-min cycles)
        recent = self.trade_results[-12:] if len(self.trade_results) >= 5 else self.trade_results
        if len(recent) < 5:
            return {"var_pct": 0, "var_usd": 0, "exceeded": False, "size_multiplier": 1.0}

        returns = np.array(recent) / 100.0
        var_95 = float(np.percentile(returns, 5))  # 5th percentile = 95% VaR
        var_usd = self.balance * abs(var_95)

        exceeded = abs(var_95) > VAR_LIMIT_PCT
        # If exceeded, scale down positions proportionally
        if exceeded:
            mult = max(0.2, VAR_LIMIT_PCT / abs(var_95))
        else:
            mult = 1.0

        return {
            "var_pct": round(var_95 * 100, 3),
            "var_usd": round(var_usd, 2),
            "exceeded": exceeded,
            "size_multiplier": round(mult, 2),
        }

    def cvar_position_cap(self, base_position_usd: float) -> float:
        """Apply CVaR-based position cap.

        If CVaR exceeds daily loss limit, reduce position sizes proportionally.
        This prevents catastrophic tail-risk drawdowns.
        """
        cvar_data = self.compute_var_cvar()
        if not cvar_data["sufficient_data"]:
            return base_position_usd

        max_daily_loss = self.balance * config.MAX_DAILY_LOSS_PCT
        cvar_usd = cvar_data["cvar_usd"]

        if cvar_usd == 0:
            return base_position_usd

        # If CVaR exposure exceeds daily limit, scale down
        # Count open positions to estimate total exposure
        n_positions = max(1, len(self.positions) + 1)  # +1 for the proposed new one
        total_cvar_exposure = cvar_usd * n_positions

        if total_cvar_exposure > max_daily_loss:
            scale_factor = max_daily_loss / total_cvar_exposure
            capped = base_position_usd * scale_factor
            logger.info(
                f"CVaR cap: {scale_factor:.2f}x (CVaR={cvar_data['cvar_pct']:.2f}%, "
                f"exposure=${total_cvar_exposure:.0f} > daily_limit=${max_daily_loss:.0f})"
            )
            return max(1.0, round(capped, 2))

        return base_position_usd

    def get_risk_budget(self) -> dict:
        """Get current risk budget breakdown for dashboard."""
        cvar_data = self.compute_var_cvar()
        kelly = self.kelly_fraction()
        dd = self.check_drawdown()

        max_daily = self.balance * config.MAX_DAILY_LOSS_PCT
        used_daily = abs(min(0, self.daily_pnl))
        remaining_daily = max(0, max_daily - used_daily)

        # Per-position risk budget
        n_open = len(self.positions)
        max_positions = int(1.0 / config.MAX_POSITION_PCT) if config.MAX_POSITION_PCT > 0 else 5
        slots_remaining = max(0, max_positions - n_open)

        return {
            "cvar": cvar_data,
            "kelly_fraction_pct": round(kelly * 100, 2),
            "drawdown": dd,
            "daily_budget": {
                "max_usd": round(max_daily, 2),
                "used_usd": round(used_daily, 2),
                "remaining_usd": round(remaining_daily, 2),
                "remaining_pct": round(remaining_daily / max_daily * 100, 1) if max_daily > 0 else 0,
            },
            "position_slots": {
                "max": max_positions,
                "used": n_open,
                "remaining": slots_remaining,
            },
        }

    # ── Slippage Estimation ────────────────────────────────────────────────

    def estimate_slippage(self, symbol: str, size_usd: float, side: str = "BUY") -> dict:
        """Estimate market impact/slippage from order book depth.

        Uses MLOFI service data if available, otherwise uses ATR-based estimate.
        Returns: {slippage_bps: float, adjusted_size: float}
        """
        try:
            from services.mlofi_service import get_mlofi_service
            mlofi = get_mlofi_service()
            data = mlofi.get_latest(symbol)
            if data and "spread_pct" in data:
                spread_bps = data["spread_pct"] * 100  # convert % to bps
                depth = data.get("depth_imbalance", 0)
                # Slippage = half spread + market impact
                # Market impact scales with order size relative to depth
                impact_bps = spread_bps * 0.5 + size_usd / 10000 * 2  # rough estimate
                # If buying into selling pressure (depth imbalance < 0), increase slippage
                if side == "BUY" and depth < -0.3:
                    impact_bps *= 1.5
                elif side == "SELL" and depth > 0.3:
                    impact_bps *= 1.5
                return {
                    "slippage_bps": round(impact_bps, 2),
                    "spread_bps": round(spread_bps, 2),
                    "should_reduce": impact_bps > 10,  # > 10bps = significant
                    "adjusted_size": size_usd * (1 - impact_bps / 10000),
                }
        except Exception:
            pass

        # Fallback: ATR-based estimate
        return {
            "slippage_bps": 5.0,  # assume 5bps default
            "spread_bps": 3.0,
            "should_reduce": False,
            "adjusted_size": size_usd * 0.9995,
        }

    # ── Monte Carlo Stress Testing ──────────────────────────────────────────

    def monte_carlo_simulation(self, n_paths: int = 1000, n_trades: int = 100) -> dict:
        """Run Monte Carlo simulation using historical trade distribution.

        Returns probability of ruin, expected drawdown, and confidence intervals.
        """
        if len(self.trade_results) < 10:
            return {"sufficient_data": False, "samples": len(self.trade_results)}

        returns = np.array(self.trade_results) / 100.0  # convert to decimal
        mean_ret = np.mean(returns)
        std_ret = np.std(returns)

        ruin_count = 0
        max_drawdowns = []
        final_balances = []

        for _ in range(n_paths):
            balance = self.balance
            peak = balance
            max_dd = 0

            for _ in range(n_trades):
                ret = np.random.normal(mean_ret, std_ret)
                balance *= (1 + ret)
                peak = max(peak, balance)
                dd = (peak - balance) / peak if peak > 0 else 0
                max_dd = max(max_dd, dd)

                if balance <= self.starting_balance * 0.5:  # ruin = lose 50%
                    ruin_count += 1
                    break

            max_drawdowns.append(max_dd)
            final_balances.append(balance)

        final_arr = np.array(final_balances)
        dd_arr = np.array(max_drawdowns)

        return {
            "sufficient_data": True,
            "n_paths": n_paths,
            "n_trades": n_trades,
            "ruin_probability": round(ruin_count / n_paths * 100, 2),
            "expected_final_balance": round(float(np.mean(final_arr)), 2),
            "median_final_balance": round(float(np.median(final_arr)), 2),
            "p5_balance": round(float(np.percentile(final_arr, 5)), 2),
            "p95_balance": round(float(np.percentile(final_arr, 95)), 2),
            "expected_max_drawdown": round(float(np.mean(dd_arr) * 100), 2),
            "p95_max_drawdown": round(float(np.percentile(dd_arr, 95) * 100), 2),
        }

    # ── Portfolio Summary ──────────────────────────────────────────────────

    def get_portfolio_state(self) -> dict:
        """Get full portfolio state for dashboard/Gemini."""
        drawdown = self.check_drawdown()
        win_trades = [r for r in self.trade_results if r > 0]
        loss_trades = [r for r in self.trade_results if r < 0]
        total = len(self.trade_results)

        return {
            "balance": round(self.balance, 2),
            "starting_balance": self.starting_balance,
            "total_pnl": round(self.balance - self.starting_balance, 2),
            "total_pnl_pct": round((self.balance - self.starting_balance) / self.starting_balance * 100, 2),
            "daily_pnl": round(self.daily_pnl, 2),
            "drawdown": drawdown,
            "positions": dict(self.positions),
            "halted": self.halted,
            "total_trades": total,
            "win_rate": round(len(win_trades) / total * 100, 1) if total else 0,
            "avg_win": round(np.mean(win_trades), 2) if win_trades else 0,
            "avg_loss": round(np.mean(loss_trades), 2) if loss_trades else 0,
            "kelly_fraction": round(self.kelly_fraction() * 100, 2),
        }
