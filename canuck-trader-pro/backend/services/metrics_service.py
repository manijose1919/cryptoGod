"""
Lightweight Prometheus-compatible metrics exporter.

No external dependencies — outputs Prometheus text exposition format.
Scrape via GET /metrics.
"""

import time
import logging
from collections import defaultdict

logger = logging.getLogger("metrics")


class MetricsCollector:
    """Collect and expose trading metrics in Prometheus text format."""

    def __init__(self):
        self._counters: dict[str, float] = defaultdict(float)
        self._gauges: dict[str, float] = defaultdict(float)
        self._histograms: dict[str, list] = defaultdict(list)
        self._start_time = time.time()

    # --- Counter operations ---
    def inc(self, name: str, value: float = 1.0, labels: dict | None = None):
        key = self._key(name, labels)
        self._counters[key] += value

    # --- Gauge operations ---
    def set_gauge(self, name: str, value: float, labels: dict | None = None):
        key = self._key(name, labels)
        self._gauges[key] = value

    # --- Histogram operations ---
    def observe(self, name: str, value: float, labels: dict | None = None):
        key = self._key(name, labels)
        self._histograms[key].append(value)
        # Keep last 1000 observations
        if len(self._histograms[key]) > 1000:
            self._histograms[key] = self._histograms[key][-1000:]

    # --- Export ---
    def export_text(self) -> str:
        """Return metrics in Prometheus text exposition format."""
        lines = []

        # Uptime
        uptime = time.time() - self._start_time
        lines.append("# HELP trading_uptime_seconds Bot uptime in seconds")
        lines.append("# TYPE trading_uptime_seconds gauge")
        lines.append(f"trading_uptime_seconds {uptime:.1f}")

        # Counters
        for key, val in sorted(self._counters.items()):
            name, label_str = self._parse_key(key)
            lines.append(f"# TYPE {name} counter")
            lines.append(f"{name}{label_str} {val}")

        # Gauges
        for key, val in sorted(self._gauges.items()):
            name, label_str = self._parse_key(key)
            lines.append(f"# TYPE {name} gauge")
            lines.append(f"{name}{label_str} {val}")

        # Histograms (as summary: count + sum + avg)
        for key, vals in sorted(self._histograms.items()):
            name, label_str = self._parse_key(key)
            if not vals:
                continue
            count = len(vals)
            total = sum(vals)
            avg = total / count
            lines.append(f"# TYPE {name} summary")
            lines.append(f"{name}_count{label_str} {count}")
            lines.append(f"{name}_sum{label_str} {total:.6f}")
            lines.append(f"{name}_avg{label_str} {avg:.6f}")

        return "\n".join(lines) + "\n"

    @staticmethod
    def _key(name: str, labels: dict | None) -> str:
        if not labels:
            return name
        label_parts = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
        return f"{name}{{{label_parts}}}"

    @staticmethod
    def _parse_key(key: str) -> tuple[str, str]:
        if "{" in key:
            name, rest = key.split("{", 1)
            return name, "{" + rest
        return key, ""


# Singleton
_instance: MetricsCollector | None = None


def get_metrics() -> MetricsCollector:
    global _instance
    if _instance is None:
        _instance = MetricsCollector()
    return _instance
