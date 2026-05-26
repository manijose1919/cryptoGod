// Thin wrapper that funnels pairs-engine lifecycle events through:
//   1. SQLite (v2_pairs_alerts) so the dashboard can show them
//   2. Telegram (if configured)
// Degrades gracefully on either side — every call is fire-and-forget; no
// errors propagate.

import { recordPairsAlert } from './schema.ts';

let _tg: any = null;
async function getTelegram(): Promise<any> {
  if (!_tg) {
    try {
      // @ts-expect-error JS module without types
      _tg = await import('../../services/telegramService.js');
    } catch {
      _tg = { default: null };
    }
  }
  return _tg;
}

async function send(text: string): Promise<void> {
  try {
    const tg = await getTelegram();
    if (!tg?.isEnabled?.()) return;
    // queueMessage isn't exported but the helpers all use it. We piggy-back
    // on alertTradeExecution? No — that has a fixed shape. Instead, we use
    // an arbitrary alert via the most-general helper. The telegramService
    // doesn't have a sendRaw; we synthesize a fake "alert" through the
    // closest helper, or fall back to console log.
    //
    // Simplest robust path: if a `sendCustom` exists, use it; otherwise
    // queue via the existing CircuitBreaker channel (which is just a free-
    // form message wrapper).
    if (typeof tg.sendCustom === 'function') {
      tg.sendCustom(text);
    } else if (typeof tg.alertCircuitBreaker === 'function') {
      // alertCircuitBreaker(reason) sends "🚨 CIRCUIT BREAKER: <reason>" —
      // not ideal for non-CB events. We'll prefix our own marker so the
      // user can grep these out later.
      tg.alertCircuitBreaker(`[PAIRS] ${text}`);
    } else {
      console.log(`[PAIRS-ALERT] ${text}`);
    }
  } catch {
    /* swallow — alerts must never crash the engine */
  }
}

export function alertEntry(side: 'long_spread' | 'short_spread', z: number, beta: number, mode: 'paper' | 'live'): void {
  recordPairsAlert({ severity: 'info', kind: 'entry', message: `${side} entry @ z=${z.toFixed(2)} β=${beta.toFixed(3)} (${mode})`, data: { side, z, beta, mode } });
  void send(
    `🟢 ENTRY ${side}\n` +
    `Mode: ${mode}\n` +
    `Z-score: ${z.toFixed(2)}\n` +
    `Beta: ${beta.toFixed(3)}`,
  );
}

export function alertExit(side: 'long_spread' | 'short_spread', reason: string, pnlNet: number, holdBars: number, mode: 'paper' | 'live'): void {
  const emoji = pnlNet >= 0 ? '✅' : '❌';
  recordPairsAlert({ severity: 'info', kind: 'exit', message: `${side} exit reason=${reason} pnl=$${pnlNet.toFixed(2)} hold=${holdBars}bars (${mode})`, data: { side, reason, pnlNet, holdBars, mode } });
  void send(
    `${emoji} EXIT ${side}\n` +
    `Mode: ${mode}\n` +
    `Reason: ${reason}\n` +
    `PnL net: $${pnlNet.toFixed(2)}\n` +
    `Hold: ${holdBars} bars`,
  );
}

export function alertDrawdownKill(unrealizedPct: number, mode: 'paper' | 'live'): void {
  recordPairsAlert({ severity: 'crit', kind: 'drawdown_kill', message: `drawdown kill at ${(unrealizedPct * 100).toFixed(2)}% (${mode})`, data: { unrealizedPct, mode } });
  void send(
    `🚨 PAIRS DRAWDOWN KILL\n` +
    `Mode: ${mode}\n` +
    `Unrealized: ${(unrealizedPct * 100).toFixed(2)}%\n` +
    `Position force-closed.`,
  );
}

export function alertPause(consecutiveLosses: number, untilTs: number): void {
  recordPairsAlert({ severity: 'warn', kind: 'pause', message: `auto-pause after ${consecutiveLosses} losses, until ${new Date(untilTs).toISOString()}`, data: { consecutiveLosses, untilTs } });
  void send(
    `⏸️ PAIRS AUTO-PAUSE\n` +
    `Consecutive losses: ${consecutiveLosses}\n` +
    `Resuming: ${new Date(untilTs).toISOString()}`,
  );
}

export function alertAdfDegrade(adfTStat: number): void {
  recordPairsAlert({ severity: 'warn', kind: 'adf_degrade', message: `ADF weakening: t=${adfTStat.toFixed(2)}`, data: { adfTStat } });
  void send(
    `📉 PAIRS COINTEGRATION WEAKENING\n` +
    `ADF t-stat: ${adfTStat.toFixed(2)}\n` +
    `New entries blocked until ADF recovers.`,
  );
}

export function alertMarginLow(marginLevel: number, critical: boolean): void {
  recordPairsAlert({ severity: critical ? 'crit' : 'warn', kind: critical ? 'margin_critical' : 'margin_low', message: `margin level ${marginLevel}%`, data: { marginLevel } });
  void send(
    `${critical ? '🚨' : '⚠️'} PAIRS MARGIN ${critical ? 'CRITICAL' : 'LOW'}\n` +
    `Margin level: ${marginLevel}%\n` +
    `${critical ? 'Force-close imminent.' : 'Consider reducing position.'}`,
  );
}

export function alertStateDrift(message: string): void {
  recordPairsAlert({ severity: 'warn', kind: 'state_drift', message, data: undefined });
  void send(
    `🔄 PAIRS STATE DRIFT\n${message}\n` +
    `Engine and exchange disagree on open positions. Manual review recommended.`,
  );
}

export function alertExecutorPartialFill(legA: string, legB: string, legAFilled: boolean): void {
  recordPairsAlert({ severity: 'crit', kind: 'partial_fill', message: `partial fill: ${legAFilled ? legA : legB} filled, ${legAFilled ? legB : legA} did not — emergency close triggered`, data: { legA, legB, legAFilled } });
  void send(
    `🚨 PAIRS PARTIAL FILL\n` +
    `${legAFilled ? legA : legB} filled, ${legAFilled ? legB : legA} did not.\n` +
    `Emergency-close triggered. Verify position is flat.`,
  );
}
