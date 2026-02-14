/**
 * Config Service (Frontend)
 * Reads/writes trading configuration to the settings table via API.
 */

export interface ConfigField {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  group: string;
  min?: number;
  max?: number;
  step?: number;
  default: any;
  options?: string[];
  description?: string;
}

export const CONFIG_SCHEMA: ConfigField[] = [
  // Thresholds
  { key: 'trend_bullish_entry', label: 'Trend Bullish Entry', type: 'number', group: 'Thresholds', min: 10, max: 90, step: 5, default: 50 },
  { key: 'breakout_squeeze_entry', label: 'Breakout Squeeze Entry', type: 'number', group: 'Thresholds', min: 10, max: 90, step: 5, default: 40 },
  { key: 'whale_buying_entry', label: 'Whale Buying Entry', type: 'number', group: 'Thresholds', min: 10, max: 90, step: 1, default: 48 },
  { key: 'momentum_bullish_entry', label: 'Momentum Entry', type: 'number', group: 'Thresholds', min: 10, max: 90, step: 5, default: 50 },
  { key: 'min_signal_confidence', label: 'Min Signal Confidence', type: 'number', group: 'Thresholds', min: 0, max: 100, step: 5, default: 40 },

  // Position Sizing
  { key: 'max_position_pct', label: 'Max Position %', type: 'number', group: 'Sizing', min: 1, max: 50, step: 1, default: 20 },
  { key: 'min_trade_size', label: 'Min Trade Size ($)', type: 'number', group: 'Sizing', min: 0.1, max: 100, step: 0.5, default: 1.0 },
  { key: 'kelly_enabled', label: 'Kelly Sizing', type: 'boolean', group: 'Sizing', default: true },
  { key: 'kelly_max_fraction', label: 'Kelly Max Fraction', type: 'number', group: 'Sizing', min: 0.05, max: 0.5, step: 0.05, default: 0.25 },

  // Risk Management
  { key: 'stop_loss_pct', label: 'Stop Loss %', type: 'number', group: 'Risk', min: 0.05, max: 10, step: 0.05, default: 2.0 },
  { key: 'trailing_stop_pct', label: 'Trailing Stop %', type: 'number', group: 'Risk', min: 0.05, max: 10, step: 0.05, default: 1.5 },
  { key: 'max_concurrent_trades', label: 'Max Concurrent Trades', type: 'number', group: 'Risk', min: 1, max: 20, step: 1, default: 5 },
  { key: 'max_daily_drawdown_pct', label: 'Max Daily Drawdown %', type: 'number', group: 'Risk', min: 1, max: 30, step: 1, default: 15 },
  { key: 'max_consecutive_losses', label: 'Max Consecutive Losses', type: 'number', group: 'Risk', min: 2, max: 20, step: 1, default: 6 },

  // Strategy Weights
  { key: 'strategy_trend_weight', label: 'Trend Weight', type: 'number', group: 'Strategy Weights', min: 0, max: 2, step: 0.1, default: 1.0 },
  { key: 'strategy_breakout_weight', label: 'Breakout Weight', type: 'number', group: 'Strategy Weights', min: 0, max: 2, step: 0.1, default: 1.0 },
  { key: 'strategy_whale_weight', label: 'Whale Weight', type: 'number', group: 'Strategy Weights', min: 0, max: 2, step: 0.1, default: 1.0 },
  { key: 'strategy_momentum_weight', label: 'Momentum Weight', type: 'number', group: 'Strategy Weights', min: 0, max: 2, step: 0.1, default: 1.0 },

  // ML Settings
  { key: 'ml_enabled', label: 'ML Predictions', type: 'boolean', group: 'ML', default: true },
  { key: 'ml_min_confidence', label: 'ML Min Confidence', type: 'number', group: 'ML', min: 0, max: 100, step: 5, default: 60 },
  { key: 'regime_filter_enabled', label: 'Regime Strategy Filter', type: 'boolean', group: 'ML', default: true },
  { key: 'mtf_confluence_enabled', label: 'MTF Confluence', type: 'boolean', group: 'ML', default: true },

  // Alerts
  { key: 'telegram_enabled', label: 'Telegram Alerts', type: 'boolean', group: 'Alerts', default: false },
  { key: 'alert_on_trade', label: 'Alert on Trade', type: 'boolean', group: 'Alerts', default: true },
  { key: 'alert_on_drawdown', label: 'Alert on Drawdown', type: 'boolean', group: 'Alerts', default: true },
];

export async function loadConfig(): Promise<Record<string, any>> {
  try {
    const res = await fetch('/api/config');
    if (res.ok) return res.json();
  } catch (e) { /* ignore */ }

  // Return defaults
  const defaults: Record<string, any> = {};
  for (const field of CONFIG_SCHEMA) {
    defaults[field.key] = field.default;
  }
  return defaults;
}

export async function saveConfig(config: Record<string, any>): Promise<boolean> {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}
