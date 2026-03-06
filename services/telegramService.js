/**
 * Telegram Alert Service
 * Sends trade alerts, drawdown warnings, and session summaries via Telegram Bot API.
 * Rate-limited queue (1 msg/sec). Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars.
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';

let botToken = process.env.TELEGRAM_BOT_TOKEN || '';
let chatId = process.env.TELEGRAM_CHAT_ID || '';
let messageQueue = [];
let processing = false;
let enabled = false;

/**
 * Initialize Telegram service. Call on server start.
 */
export function initTelegram() {
  botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  chatId = process.env.TELEGRAM_CHAT_ID || '';
  enabled = !!(botToken && chatId);
  if (enabled) {
    console.log('[Telegram] Service initialized');
    processQueue();
  } else {
    console.log('[Telegram] Not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
  }
}

/**
 * Check if Telegram is configured and active.
 */
export function isEnabled() {
  return enabled;
}

/**
 * Get Telegram service status.
 */
export function getStatus() {
  return {
    enabled,
    configured: !!(botToken && chatId),
    queueLength: messageQueue.length,
  };
}

/**
 * Queue a message for sending.
 */
function queueMessage(text, parseMode = 'HTML') {
  if (!enabled) return;
  messageQueue.push({ text, parseMode });
  if (!processing) processQueue();
}

/**
 * Process the message queue at 1 msg/sec.
 */
async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try {
      await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg.text,
          parse_mode: msg.parseMode,
          disable_web_page_preview: true,
        }),
      });
    } catch (e) {
      console.error('[Telegram] Send failed:', e.message);
    }
    // Rate limit: 1 msg/sec
    await new Promise(r => setTimeout(r, 1000));
  }

  processing = false;
}

// ============================================
// ALERT FUNCTIONS
// ============================================

export function alertTradeExecution(trade) {
  const emoji = trade.type === 'BUY' ? '🟢' : '🔴';
  const pnlText = trade.pnl != null ? `\nP&L: <b>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</b>` : '';
  queueMessage(
    `${emoji} <b>${trade.type}</b> ${trade.ticker}\n` +
    `Price: $${trade.price?.toFixed(2) || '?'}\n` +
    `Strategy: ${trade.strategy || '?'}${pnlText}`
  );
}

export function alertDrawdown(percent, currentValue) {
  queueMessage(
    `⚠️ <b>DRAWDOWN ALERT</b>\n` +
    `Drawdown: <b>${percent.toFixed(1)}%</b>\n` +
    `Portfolio: $${currentValue?.toFixed(2) || '?'}`
  );
}

export function alertSessionSummary(summary) {
  queueMessage(
    `📊 <b>Session Summary</b>\n` +
    `Trades: ${summary.totalTrades || 0}\n` +
    `P&L: <b>${(summary.totalPnl || 0) >= 0 ? '+' : ''}$${(summary.totalPnl || 0).toFixed(2)}</b>\n` +
    `Win Rate: ${(summary.winRate || 0).toFixed(1)}%\n` +
    `Max Drawdown: $${(summary.maxDrawdown || 0).toFixed(2)}`
  );
}

export function alertWhaleMovement(ticker, direction, size) {
  queueMessage(
    `🐋 <b>Whale ${direction}</b> detected on ${ticker}\n` +
    `Estimated size: $${(size || 0).toLocaleString()}`
  );
}

export function alertCircuitBreaker(reason) {
  queueMessage(`🛑 <b>Circuit Breaker Triggered</b>\nReason: ${reason}`);
}

/**
 * Alert when market regime transitions (e.g., UP → DOWN).
 */
export function alertRegimeTransition(from, to, ticker) {
  const arrows = { STRONG_UP: '🟢🟢', UP: '🟢', SIDEWAYS: '🟡', DOWN: '🔴', STRONG_DOWN: '🔴🔴' };
  queueMessage(`${arrows[to] || '⚪'} <b>Regime Shift</b>\n${ticker || 'Global'}: ${from} → ${to}\n${arrows[from] || ''} → ${arrows[to] || ''}`);
}

/**
 * Alert when ML model accuracy degrades below threshold.
 */
export function alertMLDegradation(accuracy, threshold, details) {
  queueMessage(`⚠️ <b>ML Degradation</b>\nAccuracy: ${accuracy.toFixed(1)}% (threshold: ${threshold}%)\n${details || ''}`);
}

/**
 * Alert for concentration risk (single ticker exceeds % of portfolio).
 */
export function alertConcentrationRisk(ticker, pct) {
  queueMessage(`⚠️ <b>Concentration Risk</b>\n${ticker}: ${pct.toFixed(1)}% of portfolio`);
}

/**
 * Send a test message to verify configuration.
 */
export async function sendTestMessage() {
  if (!botToken || !chatId) {
    return { success: false, error: 'Not configured' };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ <b>Trading Bot Connected!</b>\nTelegram alerts are working.',
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    return { success: data.ok, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export default {
  initTelegram, isEnabled, getStatus, alertTradeExecution, alertDrawdown,
  alertSessionSummary, alertWhaleMovement, alertCircuitBreaker, sendTestMessage,
  alertRegimeTransition, alertMLDegradation, alertConcentrationRisk,
};
