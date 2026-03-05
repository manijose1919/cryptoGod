/**
 * Discord Webhook Integration
 * Sends trade alerts, drawdown warnings, and summaries to Discord via webhook.
 * No library needed — uses native fetch with embed format.
 */

const DISCORD_COLORS = {
  buy: 0x3b82f6,     // Blue
  sell_profit: 0x22c55e, // Green
  sell_loss: 0xef4444,   // Red
  warning: 0xf59e0b,    // Yellow
  info: 0x6366f1,       // Indigo
  error: 0xdc2626,      // Dark red
};

let webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
let enabled = false;

export function initDiscord() {
  webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  enabled = !!webhookUrl;
  if (enabled) {
    console.log('[Discord] Webhook configured');
  } else {
    console.log('[Discord] Not configured (set DISCORD_WEBHOOK_URL)');
  }
}

export function isEnabled() { return enabled; }

export function getStatus() {
  return { enabled, configured: !!webhookUrl };
}

/**
 * Send a rich embed to Discord
 */
export async function sendDiscordAlert(title, description, color = DISCORD_COLORS.info, fields = []) {
  if (!enabled) return;

  try {
    const embed = {
      title,
      description,
      color,
      fields: fields.map(f => ({ name: f.name, value: String(f.value), inline: f.inline !== false })),
      timestamp: new Date().toISOString(),
      footer: { text: 'CryptoGod Trading Bot' },
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error('[Discord] Send failed:', err.message);
  }
}

// Convenience wrappers matching Telegram patterns

export function alertTradeExecution(trade) {
  const isBuy = trade.type === 'BUY';
  const color = isBuy ? DISCORD_COLORS.buy : (trade.pnl >= 0 ? DISCORD_COLORS.sell_profit : DISCORD_COLORS.sell_loss);
  const fields = [
    { name: 'Ticker', value: trade.ticker },
    { name: 'Price', value: `$${Number(trade.price).toFixed(2)}` },
    { name: 'Amount', value: `$${Number(trade.usdAmount || 0).toFixed(2)}` },
  ];
  if (trade.pnl != null) {
    fields.push({ name: 'P&L', value: `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}` });
  }
  sendDiscordAlert(`${isBuy ? '📈 BUY' : '📉 SELL'} — ${trade.ticker}`, trade.reason || '', color, fields);
}

export function alertDrawdown(percent, currentValue) {
  sendDiscordAlert('⚠️ Drawdown Alert', `Portfolio down **${percent.toFixed(1)}%**\nCurrent value: $${currentValue.toFixed(2)}`, DISCORD_COLORS.warning);
}

export function alertCircuitBreaker(reason) {
  sendDiscordAlert('🛑 Circuit Breaker Triggered', reason, DISCORD_COLORS.error);
}

export function alertSessionSummary(summary) {
  const fields = [
    { name: 'Total Trades', value: summary.totalTrades || 0 },
    { name: 'Win Rate', value: `${((summary.winRate || 0) * 100).toFixed(0)}%` },
    { name: 'P&L', value: `$${(summary.totalPnl || 0).toFixed(2)}` },
  ];
  sendDiscordAlert('📊 Session Summary', '', DISCORD_COLORS.info, fields);
}

export async function sendTestMessage() {
  return sendDiscordAlert('🧪 Test Message', 'Discord webhook is working!', DISCORD_COLORS.info);
}

export default {
  initDiscord, isEnabled, getStatus, sendDiscordAlert,
  alertTradeExecution, alertDrawdown, alertCircuitBreaker, alertSessionSummary, sendTestMessage,
};
