// ============================================
// TimeGate — hour-of-day + day-of-week entry filter (2026-05-06)
// ============================================
// Data-discovered overlay applied to TREND + MOMENTUM signal generation.
//
// Pattern (validated on 132K training_trades + 137 v2 production trades):
//   * Hour 12 UTC (NY open):           best WR (66.9% / 85.7% v2)
//   * Hour 14, 17, 21 UTC:             consistently profitable
//   * Hour 13, 20 UTC:                 consistently worst (33-44% WR, large negative PnL)
//   * Friday:                           catastrophic (40.5% WR, -$9.8M training)
//   * Sunday:                           best (58.8% WR, +$8.6M training)
//
// Strategy:
//   * BLOCK signals during hard-block hours (entry rejected regardless of score)
//   * BLOCK signals on Friday (full-day veto)
//   * BOOST entries during top hours by lowering the score threshold
//   * NEUTRAL hours pass through unchanged
//
// Implementation note: takes optional timestamp arg so backtests can pass
// the candle's `time` (live engine omits → uses Date.now()).
//
// SCOPE (updated 2026-07-15): checkTimeGate is called from ALL entry detectors —
// signalGenerator.ts (TREND long+short), momentumSignal.ts, scalpSignal.ts,
// breakoutSignal.ts, meanReversionSignal.ts, and sniperSignal.ts. The last three
// were ungated until 2026-07-15 (original 2026-06-30 scope was TREND+MOMENTUM,
// whose 382-trade dataset produced the 0-7 UTC edge; extension to the others is
// mechanistic, not data-backed — see CHANGELOG 2026-07-15 for the reasoning and
// rollback).
// ============================================

export const TIME_GATE_CONFIG = {
  ENABLED: true,

  // Hard-block hours (UTC) — consistently worst across both training + v2 data.
  // 2026-06-30 refresh (382 live TREND+MOMENTUM trades): the entire 0-7 UTC overnight
  // window (Asian/pre-London low liquidity) is net-negative and — crucially — held
  // out-of-sample in BOTH halves of history (1st half -$0.54/trade, 2nd half -$0.31).
  // Backtest: blocking 0-7 UTC lifts net +$96->+$154 and MORE THAN DOUBLES per-trade
  // expectancy (+$0.25 -> +$0.56). It also subsumes the apparent "Saturday is bad"
  // effect (Saturday looked bad only because of its overnight hours). 13 & 20 UTC kept
  // from the original training-data blocks (13: 44% WR; 20: 20% WR live).
  // 2026-09-04 daytrading reshape: also block 21-23 UTC. Hour 21 used to be a
  // *boosted* swing-hold window; a same-session book cannot enter after the
  // NY-afternoon flatten (20:00 UTC / 4pm EDT) or it rides overnight.
  BLOCKED_HOURS: [0, 1, 2, 3, 4, 5, 6, 7, 13, 20, 21, 22, 23] as readonly number[],

  // Hard-block days (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat)
  // Friday: 40.5% WR, -$938/trade training (worst day)
  // Monday: 49.0% WR, -$348/trade — borderline. NOT blocked (only 1 day blocked to keep
  //   gate lightweight; Friday alone trims ~$10M/year out of training PnL).
  BLOCKED_DAYS: [5] as readonly number[],

  // Boosted hours — lower entry score threshold by BOOST_AMOUNT
  // 12 UTC: 66.9% WR, +$783/trade training | +$0.71 avg v2 (BEST)
  // 14 UTC: 52.8% WR, +$524/trade training | +$0.53 avg v2
  // 17 UTC: 75% WR (small v2), +avg in training mid-tier — boosting based on v2 evidence
  // 21 UTC removed 2026-09-04 — that edge came from overnight swing holds.
  BOOSTED_HOURS: [12, 14, 17] as readonly number[],
  BOOST_AMOUNT: 5, // points to subtract from entry-score threshold (60 -> 55)
};

// Same-session flatten. Daytrading: do not carry inventory through the
// overnight window the entry gate already refuses. Friday gets an earlier
// flatten so a missed 20:00 pass cannot ride the weekend gap.
export const SESSION_FLATTEN_CONFIG = {
  ENABLED: true,
  FLATTEN_HOUR_UTC: 20,          // 4pm EDT / 3pm EST — end of NY cash session
  FRIDAY_FLATTEN_HOUR_UTC: 16,   // noon EDT Friday — weekend gap
};

export interface SessionFlattenResult {
  flatten: boolean;
  reason: string;
  hour: number;
  dayOfWeek: number;
}

export function shouldSessionFlatten(timestampMs?: number): SessionFlattenResult {
  const date = timestampMs != null ? new Date(timestampMs) : new Date();
  const hour = date.getUTCHours();
  const dow = date.getUTCDay();

  if (!SESSION_FLATTEN_CONFIG.ENABLED) {
    return { flatten: false, reason: 'flatten disabled', hour, dayOfWeek: dow };
  }

  if (dow === 5 && hour >= SESSION_FLATTEN_CONFIG.FRIDAY_FLATTEN_HOUR_UTC) {
    return {
      flatten: true,
      reason: `Friday session flatten from ${SESSION_FLATTEN_CONFIG.FRIDAY_FLATTEN_HOUR_UTC}h UTC`,
      hour,
      dayOfWeek: dow,
    };
  }

  if (hour >= SESSION_FLATTEN_CONFIG.FLATTEN_HOUR_UTC) {
    return {
      flatten: true,
      reason: `session flatten from ${SESSION_FLATTEN_CONFIG.FLATTEN_HOUR_UTC}h UTC`,
      hour,
      dayOfWeek: dow,
    };
  }

  return { flatten: false, reason: 'session open', hour, dayOfWeek: dow };
}

export interface TimeGateResult {
  allow: boolean;
  reason: string;
  scoreBoost: number; // amount to subtract from threshold (positive = easier to pass)
  hour: number;
  dayOfWeek: number;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function checkTimeGate(timestampMs?: number): TimeGateResult {
  const date = timestampMs != null ? new Date(timestampMs) : new Date();
  const hour = date.getUTCHours();
  const dow = date.getUTCDay();

  if (!TIME_GATE_CONFIG.ENABLED) {
    return { allow: true, reason: 'gate disabled', scoreBoost: 0, hour, dayOfWeek: dow };
  }

  if (TIME_GATE_CONFIG.BLOCKED_DAYS.includes(dow)) {
    return {
      allow: false,
      reason: `blocked day ${DAY_NAMES[dow]}`,
      scoreBoost: 0,
      hour,
      dayOfWeek: dow,
    };
  }

  if (TIME_GATE_CONFIG.BLOCKED_HOURS.includes(hour)) {
    return {
      allow: false,
      reason: `blocked hour ${hour}h UTC`,
      scoreBoost: 0,
      hour,
      dayOfWeek: dow,
    };
  }

  if (TIME_GATE_CONFIG.BOOSTED_HOURS.includes(hour)) {
    return {
      allow: true,
      reason: `boosted hour ${hour}h UTC`,
      scoreBoost: TIME_GATE_CONFIG.BOOST_AMOUNT,
      hour,
      dayOfWeek: dow,
    };
  }

  return { allow: true, reason: 'neutral', scoreBoost: 0, hour, dayOfWeek: dow };
}
