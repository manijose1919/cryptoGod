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

  // References to engine instances for command handling
  private engines: Map<string, { getStatus: () => unknown; pause: () => void; resume: () => void; stop: () => void; setMode: (m: string) => void }> = new Map();

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

    const msg = [
      `${icon} <b>${exchangeName} BUY</b>`,
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

    const holdMs = event.holdDurationMs;
    const holdStr = holdMs > 3600000
      ? `${(holdMs / 3600000).toFixed(1)}h`
      : `${(holdMs / 60000).toFixed(0)}m`;

    const msg = [
      `${icon} <b>${exchangeName} SOLD — ${result}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `📊 <b>${event.ticker}</b> @ $${this.fmtPrice(event.price)}`,
      `💵 P&L: ${event.pnlUsd >= 0 ? '+' : ''}$${event.pnlUsd.toFixed(2)} (${event.pnlPercent >= 0 ? '+' : ''}${event.pnlPercent.toFixed(2)}%)`,
      `📉 Fees: -$${event.feesUsd.toFixed(2)}`,
      `📊 Net: ${event.netPnlUsd >= 0 ? '+' : ''}$${event.netPnlUsd.toFixed(2)}`,
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
    const exchangeName = event.exchange === 'global' ? 'GLOBAL' : event.exchange.toUpperCase();

    const msg = [
      `${icon} <b>RISK ALERT — ${exchangeName}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `📋 ${event.reason}`,
      `⏱️ ${new Date(event.timestamp).toLocaleTimeString()}`,
    ].join('\n');

    await this.send(msg);
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

  private startDailyDigest(): void {
    // Send digest every 24h (or at midnight UTC)
    const msUntilMidnight = this.msUntilNextMidnightUTC();
    setTimeout(() => {
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
    ].filter(Boolean).join('\n');

    await this.send(msg);

    // Reset daily stats
    this.dailyStats = this.freshDailyStats();
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
    } catch {
      // Silent fail on poll errors
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
      await this.send(lines.join('\n'));
    }

    else if (text === '/pause') {
      for (const engine of this.engines.values()) engine.pause();
      await this.send('⏸️ All engines paused');
    }

    else if (text === '/resume') {
      for (const engine of this.engines.values()) engine.resume();
      await this.send('▶️ All engines resumed');
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
      await this.send(lines.join('\n'));
    }

    else if (text === '/help') {
      await this.send([
        '🤖 <b>COMMANDS</b>',
        '/status — Bot status & P&L',
        '/pause — Pause all trading',
        '/resume — Resume trading',
        '/positions — Open positions',
        '/digest — Force daily digest',
        '/help — This message',
      ].join('\n'));
    }

    else if (text === '/digest') {
      await this.sendDailyDigest();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────

  private async send(html: string): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      console.error('[TelegramV2] Send failed:', err);
    }
  }

  private fmtPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
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
