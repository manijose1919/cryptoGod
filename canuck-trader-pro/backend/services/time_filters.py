"""
Time-of-Day Trading Filters

Adjusts confidence based on time-of-day volume/volatility patterns.
Crypto has predictable volume peaks at US/Asia market opens.
"""

from datetime import datetime, timezone


# Volume/activity profiles by UTC hour (relative multiplier)
HOUR_PROFILE = {
    0: 1.1, 1: 1.15, 2: 1.1, 3: 1.0,       # Asia open
    4: 0.85, 5: 0.8, 6: 0.85,                # Low
    7: 0.95, 8: 1.05, 9: 1.1, 10: 1.05,      # Europe open
    11: 0.95, 12: 0.9,
    13: 1.15, 14: 1.25, 15: 1.2, 16: 1.15,   # US open (highest)
    17: 1.0, 18: 0.9, 19: 0.85,
    20: 0.8, 21: 0.75, 22: 0.8, 23: 0.95,    # Low activity
}


def get_time_confidence_adjustment() -> dict:
    """Get confidence adjustment based on current UTC hour.

    Returns: {adjustment: int, multiplier: float, hour_utc: int, activity_level: str}
    """
    now = datetime.now(timezone.utc)
    hour = now.hour
    multiplier = HOUR_PROFILE.get(hour, 1.0)

    if multiplier >= 1.15:
        adjustment = 5
        level = "HIGH"
    elif multiplier >= 1.0:
        adjustment = 0
        level = "NORMAL"
    elif multiplier >= 0.85:
        adjustment = -3
        level = "LOW"
    else:
        adjustment = -7
        level = "VERY_LOW"

    return {
        "adjustment": adjustment,
        "multiplier": multiplier,
        "hour_utc": hour,
        "activity_level": level,
    }


def get_day_of_week_adjustment() -> dict:
    """Get confidence adjustment based on day of week.
    Weekends have lower volume and more erratic moves.
    """
    now = datetime.now(timezone.utc)
    day = now.weekday()  # 0=Monday

    if day in (5, 6):
        return {"adjustment": -5, "day": now.strftime("%A"), "note": "Weekend: lower volume"}
    elif day == 0:
        return {"adjustment": 2, "day": "Monday", "note": "Week open: fresh momentum"}
    elif day == 4:
        return {"adjustment": -2, "day": "Friday", "note": "Week close: position unwinding"}
    return {"adjustment": 0, "day": now.strftime("%A"), "note": "Normal"}


def get_combined_time_adjustment() -> dict:
    """Get combined time-of-day + day-of-week adjustment."""
    tod = get_time_confidence_adjustment()
    dow = get_day_of_week_adjustment()
    total = tod["adjustment"] + dow["adjustment"]
    return {
        "total_adjustment": max(-10, min(10, total)),
        "time_of_day": tod,
        "day_of_week": dow,
    }
