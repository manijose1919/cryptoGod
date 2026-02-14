"""
Event-Driven Trading Loop

Replaces fixed 10s polling with adaptive interval based on market activity.
- Normal: 10s polling (base interval)
- Active: 3s polling when price/volume changes exceed thresholds
- Surge: 1s polling when large moves detected

Monitors price velocity and volume spikes to trigger faster analysis.
"""
import logging
import time
from collections import defaultdict
from typing import Callable, Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Thresholds for triggering faster analysis
PRICE_CHANGE_FAST = 0.002    # 0.2% price change → switch to fast mode
PRICE_CHANGE_SURGE = 0.005   # 0.5% price change → switch to surge mode
VOLUME_SPIKE_MULT = 3.0       # 3x volume → fast mode
VOLUME_SPIKE_SURGE = 5.0      # 5x volume → surge mode

# Intervals in seconds
INTERVAL_NORMAL = 10
INTERVAL_FAST = 3
INTERVAL_SURGE = 1

# How long to stay in elevated mode before decay
FAST_DECAY_CYCLES = 10   # ~30s in fast mode before going back to normal
SURGE_DECAY_CYCLES = 5   # ~5s in surge mode before going to fast


class EventDrivenLoop:
    """Adaptive-speed trading loop that responds to market events."""

    def __init__(self):
        self._last_prices: Dict[str, float] = {}
        self._last_volumes: Dict[str, float] = {}
        self._volume_history: Dict[str, list] = defaultdict(list)
        self._current_mode = "NORMAL"
        self._mode_cycles_remaining = 0
        self._events: list = []  # recent events for logging
        self._total_fast_triggers = 0
        self._total_surge_triggers = 0

    @property
    def current_interval(self) -> float:
        if self._current_mode == "SURGE":
            return INTERVAL_SURGE
        elif self._current_mode == "FAST":
            return INTERVAL_FAST
        return INTERVAL_NORMAL

    @property
    def current_mode(self) -> str:
        return self._current_mode

    def update_prices(self, prices: Dict[str, float]) -> dict:
        """Check price changes and update loop speed.

        Call this at the start of each cycle with current prices.
        Returns event info dict.
        """
        events = []
        max_change = 0.0
        max_change_symbol = ""

        for symbol, price in prices.items():
            if symbol in self._last_prices and self._last_prices[symbol] > 0:
                change = abs(price - self._last_prices[symbol]) / self._last_prices[symbol]
                if change > max_change:
                    max_change = change
                    max_change_symbol = symbol

                if change >= PRICE_CHANGE_SURGE:
                    events.append({
                        "type": "PRICE_SURGE",
                        "symbol": symbol,
                        "change_pct": round(change * 100, 3),
                        "direction": "UP" if price > self._last_prices[symbol] else "DOWN",
                    })
                elif change >= PRICE_CHANGE_FAST:
                    events.append({
                        "type": "PRICE_MOVE",
                        "symbol": symbol,
                        "change_pct": round(change * 100, 3),
                        "direction": "UP" if price > self._last_prices[symbol] else "DOWN",
                    })

            self._last_prices[symbol] = price

        # Determine new mode
        has_surge = any(e["type"] == "PRICE_SURGE" for e in events)
        has_fast = any(e["type"] == "PRICE_MOVE" for e in events)

        if has_surge:
            self._set_mode("SURGE", SURGE_DECAY_CYCLES)
            self._total_surge_triggers += 1
        elif has_fast:
            self._set_mode("FAST", FAST_DECAY_CYCLES)
            self._total_fast_triggers += 1
        else:
            self._decay_mode()

        # Store events
        self._events = events[-10:]

        return {
            "mode": self._current_mode,
            "interval": self.current_interval,
            "events": events,
            "max_change": round(max_change * 100, 3),
            "max_change_symbol": max_change_symbol,
        }

    def update_volumes(self, volumes: Dict[str, float]):
        """Check for volume spikes that should trigger faster analysis."""
        for symbol, volume in volumes.items():
            history = self._volume_history[symbol]
            history.append(volume)
            if len(history) > 20:
                history.pop(0)

            if len(history) >= 5:
                avg_vol = np.mean(history[:-1])
                if avg_vol > 0:
                    ratio = volume / avg_vol
                    if ratio >= VOLUME_SPIKE_SURGE:
                        self._set_mode("SURGE", SURGE_DECAY_CYCLES)
                        self._total_surge_triggers += 1
                    elif ratio >= VOLUME_SPIKE_MULT:
                        self._set_mode("FAST", FAST_DECAY_CYCLES)
                        self._total_fast_triggers += 1

    def _set_mode(self, mode: str, cycles: int):
        """Set loop mode with cycle counter."""
        # Only upgrade, never downgrade mid-cycle
        mode_priority = {"NORMAL": 0, "FAST": 1, "SURGE": 2}
        if mode_priority.get(mode, 0) >= mode_priority.get(self._current_mode, 0):
            if self._current_mode != mode:
                logger.info(f"Loop mode: {self._current_mode} -> {mode} (for {cycles} cycles)")
            self._current_mode = mode
            self._mode_cycles_remaining = cycles

    def _decay_mode(self):
        """Decay back to normal mode."""
        if self._mode_cycles_remaining > 0:
            self._mode_cycles_remaining -= 1
        elif self._current_mode == "SURGE":
            self._current_mode = "FAST"
            self._mode_cycles_remaining = FAST_DECAY_CYCLES
        elif self._current_mode == "FAST":
            self._current_mode = "NORMAL"
            self._mode_cycles_remaining = 0

    def get_status(self) -> dict:
        return {
            "mode": self._current_mode,
            "interval": self.current_interval,
            "cycles_remaining": self._mode_cycles_remaining,
            "total_fast_triggers": self._total_fast_triggers,
            "total_surge_triggers": self._total_surge_triggers,
            "recent_events": self._events,
            "tracked_symbols": len(self._last_prices),
        }
