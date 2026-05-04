/**
 * TelegramV2 — Color-coded trade notifications with daily digests and command interface.
 *
 * Subscribes to EventBus events and sends formatted Telegram messages.
 * Color scheme:
 *   🟣 Purple = Crypto.com BUY
 *   🔵 Blue = Kraken BUY
 *   🟢 Green = Sold at PROFIT
 *   🔴 Red = Sold at LOSS
 *   🟡 Yellow = Warning/Alert
 *   ⚪ White = Info/Status
 */

import tradingBus from './eventBus.ts';
import type { EntryEvent, ExitEvent, RiskEvent, SessionEvent } from './eventBus.ts';

// ─── Types ───────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

interface DailyStats {
  kraken: { trades: number; wins: number; losses: number; pnl: number; bestTrade: number; worstTrade: number };
  'crypto.com': { trades: number; wins: number; losses: number; pnl: number; bestTrade: number; worstTrade: number };
}

// ─── TelegramV2 Service ─────────────────────────────────────

class TelegramV2Service {
  private config: TelegramConfig;
  private dailyStats: DailyStats;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private commandPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateId = 0;
  private muted = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private signalsEvaluated = 0;
  private signalsActedOn = 0;
  private totalFeesToday = 0;

  // References to engine instances for command handling
  private engines: Map<string, { getStatus: () => unknown; pause: () => void; resume: () => void; stop: () => void; setMode: (m: string) => void }> = new Map();
  // Exchange adapter for /price command
  private exchangeAdapter: { getTicker?: (pair: string) => Promise<{ last: number; change24h?: number; volume24h?: number }> } | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.dailyStats = this.freshDailyStats();

    if (!config.enabled || !config.botToken || !config.chatId) {
      console.log('[TelegramV2] Disabled (missing token or chatId)');
      return;
    }

    this.subscribeToEvents();
    this.startDailyDigest();
    this.startCommandPolling();

    console.log('[TelegramV2] Initialized with color-coded notifications');
  }

  registerEngine(exchangeId: string, engine: unknown): void {
    this.engines.set(exchangeId, engine as typeof this.engines extends Map<string, infer V> ? V : never);
  }

  registerExchangeAdapter(adapter: unknown): void {
    this.exchangeAdapter = adapter as typeof this.exchangeAdapter;
  }

  // For tracking signal stats from bot loop
  recordSignalEvaluated(): void { this.signalsEvaluated++; }
  recordSignalActedOn(): void { this.signalsActedOn++; }
  recordFees(amount: number): void { this.totalFeesToday += amount; }

  // ─── Event Subscriptions ─────────────────────────────────

  private subscribeToEvents(): void {
    tradingBus.on('trade:entry', (event: EntryEvent) => this.onEntry(event));
    tradingBus.on('trade:exit', (event: ExitEvent) => this.onExit(event));
    tradingBus.on('risk:alert', (event: RiskEvent) => this.onRiskAlert(event));
    tradingBus.on('session:change', (event: SessionEvent) => this.onSessionChange(event));
  }

  // ─── Entry Notification ──────────────────────────────────

  private async onEntry(event: EntryEvent): Promise<void> {
    const icon = event.exchange === 'crypto.com' ? '🟣' : '🔵';
    const exchangeName = event.exchange === 'crypto.com' ? 'CRYPTO.COM' : 'KRAKEN';
    // M6: render LONG / SHORT label based on direction (defaults to long).
    const sideLabel = event.direction === 'short' ? 'SHORT' : 'BUY';

    const msg = [
      `${icon} <b>${exchangeName} ${sideLabel}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `📊 <b>${event.ticker}</b> @ $${this.fmtPrice(event.price)}`,
      `💰 Amount: $${event.usdAmount.toFixed(2)} (${event.quantity.toFixed(6)} units)`,
      `📈 Signal: ${event.strategy} (Conf=${(event.confidence * 100).toFixed(0)}%)`,
      `🎯 Target: +${event.targetPct}% ($${(event.price * (1 + event.targetPct / 100)).toFixed(2)})`,
      `🛡️ Stop: ${event.stopLossPct}% ($${(event.price * (1 + event.stopLossPct / 100)).toFixed(2)})`,
      `⏱️ Max Hold: ${event.maxHoldHours}h`,
      `🤖 Mode: ${event.mode}`,
      event.mlConfidence ? `🧠 ML: ${(event.mlConfidence * 100).toFixed(0)}%` : '',
      `💡 ${event.reason}`,
    ].filter(Boolean).join('\n');

    await this.send(msg);
  }

  // ─── Exit Notification ───────────────────────────────────

  private async onExit(event: ExitEvent): Promise<void> {
    const isProfit = event.isProfit;
    const icon = isProfit ? '🟢' : '🔴';
    const exchangeName = event.exchange === 'crypto.com' ? 'CRYPTO.COM' : 'KRAKEN';
    const result = isProfit ? 'PROFIT ✅' : 'LOSS ❌';

    const holdMs = event.holdDurationMs ?? 0;
    const holdStr = holdMs > 3600000
      ? `${(holdMs / 3600000).toFixed(1)}h`
      : `${(holdMs / 60000).toFixed(0)}m`;

    const msg = [
      `${icon} <b>${exchangeName} SOLD — ${result}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `📊 <b>${event.ticker}</b> @ $${this.fmtPrice(event.price)}`,
      `💵 P&L: ${(event.pnlUsd ?? 0) >= 0 ? '+' : ''}$${(event.pnlUsd ?? 0).toFixed(2)} (${(event.pnlPercent ?? 0) >= 0 ? '+' : ''}${(event.pnlPercent ?? 0).toFixed(2)}%)`,
      `📉 Fees: -$${(event.feesUsd ?? 0).toFixed(2)}`,
      `📊 Net: ${(event.netPnlUsd ?? 0) >= 0 ? '+' : ''}$${(event.netPnlUsd ?? 0).toFixed(2)}`,
      `⏱️ Held: ${holdStr}`,
      `📋 Reason: ${event.reason}`,
      `💼 Mode: ${event.mode}`,
    ].join('\n');

    await this.send(msg);

    // Update daily stats
    const stats = this.dailyStats[event.exchange as keyof DailyStats];
    if (stats) {
      stats.trades++;
      stats.pnl += event.netPnlUsd;
      if (isProfit) {
        stats.wins++;
        stats.bestTrade = Math.max(stats.bestTrade, event.netPnlUsd);
      } else {
        stats.losses++;
        stats.worstTrade = Math.min(stats.worstTrade, event.netPnlUsd);
      }
    }
  }

  // ─── Risk Alert ──────────────────────────────────────────

  private async onRiskAlert(event: RiskEvent): Promise<void> {
    const icons: Record<string, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const icon = icons[event.severity] || '⚠️';
    const exchangeName = !event.exchange ? 'SYSTEM' : event.exchange === 'global' ? 'GLOBAL' : event.exchange.toUpperCase();

    const msg = [
      `${icon} <b>RISK ALERT — ${exchangeName}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `📋 ${event.reason}`,
      `⏱️ ${new Date(event.timestamp).toLocaleTimeString()}`,
    ].join('\n');

    await this.send(msg, true); // Always send risk alerts even when muted
  }

  // ─── Session Change ──────────────────────────────────────

  private async onSessionChange(event: SessionEvent): Promise<void> {
    const actions: Record<string, string> = {
      start: '▶️ STARTED',
      pause: '⏸️ PAUSED',
      resume: '▶️ RESUMED',
      stop: '⏹️ STOPPED',
    };
    const exchangeName = event.exchange === 'crypto.com' ? 'CRYPTO.COM' : 'KRAKEN';

    const msg = [
      `⚪ <b>${exchangeName} ${actions[event.action] || event.action}</b>`,
      `Mode: ${event.mode}${event.budget ? ` | Budget: $${event.budget.toFixed(2)}` : ''}`,
    ].join('\n');

    await this.send(msg);
  }

  // ─── Daily Digest ────────────────────────────────────────

  private initialDigestTimer: ReturnType<typeof setTimeout> | null = null;

  private startDailyDigest(): void {
    // Send digest every 24h (or at midnight UTC)
    const msUntilMidnight = this.msUntilNextMidnightUTC();
    this.initialDigestTimer = setTimeout(() => {
      this.sendDailyDigest();
      // Then every 24h
      this.digestTimer = setInterval(() => this.sendDailyDigest(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  private async sendDailyDigest(): Promise<void> {
    const k = this.dailyStats.kraken;
    const c = this.dailyStats['crypto.com'];
    const totalPnl = k.pnl + c.pnl;
    const totalTrades = k.trades + c.trades;
    const totalWins = k.wins + c.wins;

    const msg = [
      `📊 <b>DAILY SUMMARY — ${new Date().toISOString().split('T')[0]}</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `<b>KRAKEN:</b>`,
      k.trades > 0
        ? `  Trades: ${k.trades} (${k.wins}W/${k.losses}L) | ${k.trades > 0 ? ((k.wins / k.trades) * 100).toFixed(0) : 0}% WR`
        : `  No trades`,
      k.trades > 0
        ? `  P&L: ${k.pnl >= 0 ? '+' : ''}$${k.pnl.toFixed(2)}`
        : '',
      k.trades > 0
        ? `  Best: +$${k.bestTrade.toFixed(2)} | Worst: $${k.worstTrade.toFixed(2)}`
        : '',
      ``,
      `<b>CRYPTO.COM:</b>`,
      c.trades > 0
        ? `  Trades: ${c.trades} (${c.wins}W/${c.losses}L) | ${c.trades > 0 ? ((c.wins / c.trades) * 100).toFixed(0) : 0}% WR`
        : `  No trades`,
      c.trades > 0
        ? `  P&L: ${c.pnl >= 0 ? '+' : ''}$${c.pnl.toFixed(2)}`
        : '',
      c.trades > 0
        ? `  Best: +$${c.bestTrade.toFixed(2)} | Worst: $${c.worstTrade.toFixed(2)}`
        : '',
      ``,
      `<b>COMBINED:</b>`,
      `  Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
      `  Total Trades: ${totalTrades} (${totalWins}W/${totalTrades - totalWins}L)`,
      totalTrades > 0 ? `  Win Rate: ${((totalWins / totalTrades) * 100).toFixed(0)}%` : '',
      ``,
      `<b>ACTIVITY:</b>`,
      `  Signals Evaluated: ${this.signalsEvaluated}`,
      `  Signals Acted On: ${this.signalsActedOn}`,
      `  Total Fees Paid: $${this.totalFeesToday.toFixed(2)}`,
      this.getBestWorstCoinToday(k, c),
    ].filter(Boolean).join('\n');

    await this.send(msg, true); // Force send even if muted

    // Reset daily stats
    this.dailyStats = this.freshDailyStats();
    this.signalsEvaluated = 0;
    this.signalsActedOn = 0;
    this.totalFeesToday = 0;
  }

  // ─── Telegram Command Interface ──────────────────────────

  private startCommandPolling(): void {
    // Poll for commands every 3 seconds
    this.commandPollTimer = setInterval(() => this.pollCommands(), 3000);
  }

  private async pollCommands(): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=0`;
      const res = await fetch(url);
      const data = await res.json() as { ok: boolean; result: { update_id: number; message?: { text?: string; chat?: { id: number } } }[] };

      if (!data.ok || !data.result?.length) return;

      for (const update of data.result) {
        this.lastUpdateId = update.update_id;
        const text = update.message?.text;
        const chatId = update.message?.chat?.id?.toString();

        if (!text || chatId !== this.config.chatId) continue;

        await this.handleCommand(text.toLowerCase().trim());
      }
    } catch (err) {
      // M8: poll errors used to fail silently — if the bot token rotates
      // or Telegram rate-limits the poll, the operator never knows the
      // /status /pause commands stopped responding. Rate-limit to avoid
      // log spam during sustained outages.
      const now = Date.now();
      if (now - (this as { _lastPollErrLog?: number })._lastPollErrLog > 60_000) {
        console.warn(`[TelegramV2] Poll failed: ${(err as Error).message}`);
        (this as { _lastPollErrLog?: number })._lastPollErrLog = now;
      }
    }
  }

  private async handleCommand(text: string): Promise<void> {
    if (text === '/status') {
      const lines = ['📊 <b>BOT STATUS</b>', '━━━━━━━━━━━━━━━━━━'];
      for (const [id, engine] of this.engines) {
        const s = engine.getStatus() as Record<string, unknown>;
        lines.push(
          `\n<b>${(id as string).toUpperCase()}:</b>`,
          `  State: ${s.state} | Mode: ${s.mode}`,
          `  Equity: $${Number(s.equity).toFixed(2)} | P&L: ${Number(s.pnlUsd) >= 0 ? '+' : ''}$${Number(s.pnlUsd).toFixed(2)}`,
          `  Positions: ${s.positions}`,
        );
      }
      if (this.muted) lines.push('\n🔇 Notifications muted');
      await this.send(lines.join('\n'), true);
    }

    else if (text === '/pause') {
      for (const engine of this.engines.values()) engine.pause();
      await this.send('⏸️ All engines paused', true);
    }

    else if (text === '/resume') {
      for (const engine of this.engines.values()) engine.resume();
      await this.send('▶️ All engines resumed', true);
    }

    else if (text === '/positions') {
      const lines = ['📊 <b>OPEN POSITIONS</b>', '━━━━━━━━━━━━━━━━━━'];
      for (const [id, engine] of this.engines) {
        const s = engine.getStatus() as { positionDetails: Record<string, { ticker: string; openPrice: number; quantity: number; entryTime: number }> };
        const positions = Object.values(s.positionDetails || {});
        if (positions.length === 0) {
          lines.push(`\n<b>${(id as string).toUpperCase()}:</b> No positions`);
        } else {
          lines.push(`\n<b>${(id as string).toUpperCase()}:</b>`);
          for (const p of positions) {
            const holdH = ((Date.now() - p.entryTime) / 3600000).toFixed(1);
            lines.push(`  ${p.ticker} @ $${p.openPrice.toFixed(2)} (${p.quantity.toFixed(6)}) — ${holdH}h`);
          }
        }
      }
      await this.send(lines.join('\n'), true);
    }

    // #21 — /price command
    else if (text.startsWith('/price')) {
      const parts = text.split(/\s+/);
      const base = (parts[1] || 'BTC').toUpperCase();
      const pair = base.endsWith('USD') ? base : `${base}USD`;

      if (this.exchangeAdapter?.getTicker) {
        try {
          const ticker = await this.exchangeAdapter.getTicker(pair);
          const change = ticker.change24h != null ? `${ticker.change24h >= 0 ? '+' : ''}${ticker.change24h.toFixed(2)}%` : 'N/A';
          const vol = ticker.volume24h != null ? `$${(ticker.volume24h / 1e6).toFixed(1)}M` : 'N/A';
          await this.send([
            `💰 <b>${pair}</b>`,
            `Price: $${this.fmtPrice(ticker.last)}`,
            `24h Change: ${change}`,
            `24h Volume: ${vol}`,
          ].join('\n'), true);
        } catch {
          await this.send(`❌ Could not fetch price for ${pair}`, true);
        }
      } else {
        await this.send('❌ Exchange adapter not registered for price queries', true);
      }
    }

    // #22 — /pnl command
    else if (text === '/pnl') {
      const lines = ['💵 <b>P&L SUMMARY</b>', '━━━━━━━━━━━━━━━━━━'];
      let totalPnl = 0;
      let totalPositions = 0;
      for (const [id, engine] of this.engines) {
        const s = engine.getStatus() as Record<string, unknown>;
        const pnl = Number(s.pnlUsd) || 0;
        totalPnl += pnl;
        totalPositions += Number(s.positions) || 0;
        lines.push(`<b>${(id as string).toUpperCase()}:</b> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      }
      const todayPnl = this.dailyStats.kraken.pnl + this.dailyStats['crypto.com'].pnl;
      lines.push('');
      lines.push(`Today's P&L: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}`);
      lines.push(`Session P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
      lines.push(`Open Positions: ${totalPositions}`);
      await this.send(lines.join('\n'), true);
    }

    // #23 — /mute and /unmute
    else if (text.startsWith('/mute')) {
      this.muted = true;
      if (this.muteTimer) clearTimeout(this.muteTimer);
      const parts = text.split(/\s+/);
      const duration = parts[1]; // e.g., "8h", "30m"
      if (duration) {
        const match = duration.match(/^(\d+)(h|m)$/);
        if (match) {
          const ms = match[2] === 'h' ? parseInt(match[1]) * 3600000 : parseInt(match[1]) * 60000;
          this.muteTimer = setTimeout(() => {
            this.muted = false;
            this.send('🔔 Notifications unmuted (timer expired)', true);
          }, ms);
          await this.send(`🔇 Muted for ${duration}. Critical alerts still sent.`, true);
        } else {
          await this.send('🔇 Muted indefinitely. Use /unmute to restore. Critical alerts still sent.', true);
        }
      } else {
        await this.send('🔇 Muted indefinitely. Use /unmute to restore. Critical alerts still sent.', true);
      }
    }

    else if (text === '/unmute') {
      this.muted = false;
      if (this.muteTimer) { clearTimeout(this.muteTimer); this.muteTimer = null; }
      await this.send('🔔 Notifications unmuted', true);
    }

    // #6 — /alert command: /alert BTC 100000 or /alert BTC above 100000
    else if (text.startsWith('/alert')) {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await this.send('Usage: /alert BTC 100000 [above|below]\nExample: /alert ETH 4000 below', true);
        return;
      }
      const base = parts[1].toUpperCase();
      const targetPrice = parseFloat(parts[2]);
      const direction = (parts[3] || 'above').toLowerCase();
      if (isNaN(targetPrice)) {
        await this.send('❌ Invalid price. Usage: /alert BTC 100000', true);
        return;
      }
      const ticker = base.endsWith('USD') ? base : `${base}USD`;
      const condition = direction === 'below' ? 'CROSSES_BELOW' : 'CROSSES_ABOVE';
      try {
        const { createAlert } = await import('../services/priceAlertService.js') as { createAlert: (t: string, c: string, p: number) => { id: number } };
        const alert = createAlert(ticker, condition, targetPrice);
        await this.send(`✅ Alert #${alert.id} created: ${ticker} ${condition.replace('_', ' ').toLowerCase()} $${targetPrice}`, true);
      } catch (e: unknown) {
        await this.send(`❌ Failed to create alert: ${(e as Error).message}`, true);
      }
    }

    // #9 — /dca command: /dca BTC 50 weekly or /dca BTC 100 24h
    else if (text.startsWith('/dca')) {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await this.send('Usage: /dca BTC 50 [daily|weekly|4h|24h]\nExample: /dca ETH 100 weekly', true);
        return;
      }
      const base = parts[1].toUpperCase();
      const amount = parseFloat(parts[2]);
      const intervalStr = (parts[3] || 'daily').toLowerCase();
      if (isNaN(amount) || amount < 5) {
        await this.send('❌ Amount must be at least $5. Usage: /dca BTC 50 daily', true);
        return;
      }
      const ticker = base.endsWith('USD') ? base : `${base}USD`;
      const intervalMap: Record<string, number> = { '4h': 4, '8h': 8, '12h': 12, 'daily': 24, '24h': 24, 'weekly': 168 };
      const intervalHours = intervalMap[intervalStr] || 24;
      try {
        const { createSchedule } = await import('../services/dcaScheduler.js') as { createSchedule: (t: string, a: number, h: number) => { id: number } };
        const schedule = createSchedule(ticker, amount, intervalHours);
        await this.send(`✅ DCA #${schedule.id} created: Buy $${amount} of ${ticker} every ${intervalStr}`, true);
      } catch (e: unknown) {
        await this.send(`❌ Failed to create DCA: ${(e as Error).message}`, true);
      }
    }

    else if (text === '/help') {
      await this.send([
        '🤖 <b>COMMANDS</b>',
        '/status — Bot status & P&L',
        '/pause — Pause all trading',
        '/resume — Resume trading',
        '/positions — Open positions',
        '/price [COIN] — Current price (default: BTC)',
        '/pnl — P&L summary',
        '/alert COIN PRICE [above|below] — Price alert',
        '/dca COIN AMT [daily|weekly|4h] — DCA schedule',
        '/mute [duration] — Mute alerts (e.g., /mute 8h)',
        '/unmute — Unmute alerts',
        '/digest — Force daily digest',
        '/help — This message',
      ].join('\n'), true);
    }

    else if (text === '/digest') {
      await this.sendDailyDigest();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────

  // M7: rate-limited counter so failures (network blips, 429s) surface
  // without spamming logs every loop. User's Telegram is the primary
  // monitoring channel; silent loss is unacceptable.
  private _sendFailCount = 0;
  private _lastSendFailLog = 0;

  private async send(html: string, forceSend = false): Promise<void> {
    if (!this.config.enabled) return;
    // Mute skips non-critical messages
    if (this.muted && !forceSend) return;

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      // M7: detect non-2xx (notably 429 rate-limit). Parse Telegram's
      // retry_after if present so the operator can see what's happening.
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let retryAfter: number | null = null;
        try {
          const parsed = JSON.parse(body);
          retryAfter = parsed?.parameters?.retry_after ?? null;
        } catch {}
        this._sendFailCount++;
        const now = Date.now();
        if (now - this._lastSendFailLog > 60_000) {
          console.warn(`[TelegramV2] Send returned ${resp.status} (${this._sendFailCount} fails since last log)${retryAfter ? `, retry_after=${retryAfter}s` : ''}: ${body.slice(0, 200)}`);
          this._lastSendFailLog = now;
        }
      }
    } catch (err) {
      // Network-level failure (DNS, ECONNRESET, etc.). Same rate-limited log.
      this._sendFailCount++;
      const now = Date.now();
      if (now - this._lastSendFailLog > 60_000) {
        console.warn(`[TelegramV2] Send threw (${this._sendFailCount} fails since last log): ${(err as Error).message}`);
        this._lastSendFailLog = now;
      }
    }
  }

  private fmtPrice(price: number): string {
    if (price == null || typeof price !== 'number' || isNaN(price)) return '0.00';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
  }

  private getBestWorstCoinToday(k: DailyStats['kraken'], c: DailyStats['crypto.com']): string {
    const best = Math.max(k.bestTrade, c.bestTrade);
    const worst = Math.min(k.worstTrade, c.worstTrade);
    const parts: string[] = [];
    if (best > 0) parts.push(`  Best Trade: +$${best.toFixed(2)}`);
    if (worst < 0) parts.push(`  Worst Trade: $${worst.toFixed(2)}`);
    return parts.join('\n');
  }

  private freshDailyStats(): DailyStats {
    return {
      kraken: { trades: 0, wins: 0, losses: 0, pnl: 0, bestTrade: 0, worstTrade: 0 },
      'crypto.com': { trades: 0, wins: 0, losses: 0, pnl: 0, bestTrade: 0, worstTrade: 0 },
    };
  }

  private msUntilNextMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime() - now.getTime();
  }

  destroy(): void {
    if (this.initialDigestTimer) clearTimeout(this.initialDigestTimer);
    if (this.digestTimer) clearInterval(this.digestTimer);
    if (this.commandPollTimer) clearInterval(this.commandPollTimer);
  }
}

export function createTelegramV2(): TelegramV2Service {
  return new TelegramV2Service({
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
}

export default TelegramV2Service;
