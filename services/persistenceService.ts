/**
 * Persistence Service (Frontend)
 * Communicates with the backend SQLite database via /api/db/ endpoints.
 * Provides save/load functions for trades, learning data, patterns, and settings.
 */

import type { TradingStrategy } from '../types';

const API_BASE = '/api/db';

// ============================================
// GENERIC FETCH HELPER
// ============================================
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

// ============================================
// TRADES
// ============================================
export interface PersistedTrade {
  id: number;
  ticker: string;
  strategy: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  pnl: number | null;
  pnl_percent: number | null;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | null;
  reason: string | null;
  entry_time: number;
  exit_time: number | null;
  created_at: number;
}

export async function saveTrade(trade: {
  ticker: string;
  strategy: string;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  pnlPercent?: number;
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN';
  reason?: string;
  entryTime: number;
  exitTime?: number;
}): Promise<{ id: number }> {
  return apiFetch('/trades', {
    method: 'POST',
    body: JSON.stringify(trade),
  });
}

export async function loadTrades(options: {
  limit?: number;
  offset?: number;
  strategy?: string;
} = {}): Promise<{ trades: PersistedTrade[]; total: number }> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  if (options.strategy) params.set('strategy', options.strategy);
  return apiFetch(`/trades?${params.toString()}`);
}

// ============================================
// TRADE MEMORY (AI Learning)
// ============================================
export interface PersistedTradeMemory {
  id: number;
  ticker: string;
  strategy: string;
  entry_price: number;
  exit_price: number;
  entry_time: number;
  exit_time: number;
  pnl: number;
  pnl_percent: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  hold_duration: number;
  market_volatility: string;
  market_trend: string;
  market_volume: string;
  tc_value: number;
  momentum_value: number;
  whale_value: number;
  confluence_score: number;
  ai_analysis: string | null;
  created_at: number;
}

export async function saveTradeMemory(memory: {
  ticker: string;
  strategy: TradingStrategy;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPercent: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  holdDuration: number;
  marketConditions: {
    volatility: string;
    trend: string;
    volume: string;
  };
  indicators: {
    tcValue: number;
    momentumValue: number;
    whaleValue: number;
    confluenceScore: number;
  };
  aiAnalysis?: string;
}): Promise<{ id: number }> {
  return apiFetch('/trade-memory', {
    method: 'POST',
    body: JSON.stringify(memory),
  });
}

export async function loadTradeMemory(limit: number = 500): Promise<{ memories: PersistedTradeMemory[]; count: number }> {
  return apiFetch(`/trade-memory?limit=${limit}`);
}

/**
 * Convert a persisted trade memory row back into the TradeMemory format
 * used by aiLearningService.ts
 */
export function toTradeMemoryFormat(row: PersistedTradeMemory) {
  return {
    id: row.id,
    ticker: row.ticker,
    strategy: row.strategy as TradingStrategy,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    entryTime: row.entry_time,
    exitTime: row.exit_time,
    pnl: row.pnl,
    pnlPercent: row.pnl_percent,
    outcome: row.outcome,
    holdDuration: row.hold_duration,
    marketConditions: {
      volatility: row.market_volatility as 'LOW' | 'MEDIUM' | 'HIGH',
      trend: row.market_trend as 'UP' | 'DOWN' | 'SIDEWAYS',
      volume: row.market_volume as 'LOW' | 'MEDIUM' | 'HIGH',
    },
    indicators: {
      tcValue: row.tc_value,
      momentumValue: row.momentum_value,
      whaleValue: row.whale_value,
      confluenceScore: row.confluence_score,
    },
    aiAnalysis: row.ai_analysis ?? undefined,
  };
}

// ============================================
// LEARNED PATTERNS
// ============================================
export interface PersistedPattern {
  id: string;
  description: string;
  tc_range_low: number;
  tc_range_high: number;
  momentum_range_low: number;
  momentum_range_high: number;
  volatility: string;
  trend: string;
  success_rate: number;
  sample_size: number;
  recommendation: string;
  updated_at: number;
}

export async function saveLearnedPattern(pattern: {
  id: string;
  description: string;
  conditions: {
    tcRange: [number, number];
    momentumRange: [number, number];
    volatility: string;
    trend: string;
  };
  successRate: number;
  sampleSize: number;
  recommendation: string;
}): Promise<void> {
  await apiFetch(`/learned-patterns/${encodeURIComponent(pattern.id)}`, {
    method: 'PUT',
    body: JSON.stringify(pattern),
  });
}

export async function loadLearnedPatterns(): Promise<{ patterns: PersistedPattern[] }> {
  return apiFetch('/learned-patterns');
}

/**
 * Convert a persisted pattern back to the LearnedPattern format
 */
export function toLearnedPatternFormat(row: PersistedPattern) {
  return {
    id: row.id,
    description: row.description,
    conditions: {
      tcRange: [row.tc_range_low, row.tc_range_high] as [number, number],
      momentumRange: [row.momentum_range_low, row.momentum_range_high] as [number, number],
      volatility: row.volatility,
      trend: row.trend,
    },
    successRate: row.success_rate,
    sampleSize: row.sample_size,
    recommendation: row.recommendation as 'STRONG_BUY' | 'BUY' | 'AVOID' | 'STRONG_AVOID',
  };
}

// ============================================
// PARAMETER ADJUSTMENTS
// ============================================
export async function saveParameterAdjustments(params: {
  params: Record<string, unknown>;
  winRate?: number;
  profitFactor?: number;
  totalTrades?: number;
  reason?: string;
}): Promise<{ id: number }> {
  return apiFetch('/parameter-history', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function loadLatestParameters(): Promise<{
  latest: {
    id: number;
    params_json: string;
    win_rate: number;
    profit_factor: number;
    total_trades: number;
    reason: string;
    created_at: number;
  } | null;
}> {
  return apiFetch('/parameter-history/latest');
}

export async function loadParameterHistory(limit: number = 50): Promise<{
  history: Array<{
    id: number;
    params_json: string;
    win_rate: number;
    profit_factor: number;
    total_trades: number;
    reason: string;
    created_at: number;
  }>;
}> {
  return apiFetch(`/parameter-history?limit=${limit}`);
}

// ============================================
// SESSIONS
// ============================================
export async function saveSession(session: {
  startTime: number;
  initialBudget: number;
  notes?: string;
}): Promise<{ id: number }> {
  return apiFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify(session),
  });
}

export async function updateSessionRecord(id: number, updates: {
  endTime?: number;
  finalValue?: number;
  totalTrades?: number;
  winRate?: number;
  pnl?: number;
}): Promise<void> {
  await apiFetch(`/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function loadSessions(limit: number = 50): Promise<{
  sessions: Array<{
    id: number;
    start_time: number;
    end_time: number | null;
    initial_budget: number;
    final_value: number | null;
    total_trades: number;
    win_rate: number | null;
    pnl: number | null;
    notes: string | null;
  }>;
}> {
  return apiFetch(`/sessions?limit=${limit}`);
}

// ============================================
// CANDLE HISTORY
// ============================================
export async function loadCandles(options: {
  ticker: string;
  timeframe: string;
  start?: number;
  end?: number;
  limit?: number;
}): Promise<{
  candles: Array<{
    id: number;
    ticker: string;
    timeframe: string;
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  count: number;
  total: number;
}> {
  const params = new URLSearchParams({
    ticker: options.ticker,
    timeframe: options.timeframe,
  });
  if (options.start) params.set('start', String(options.start));
  if (options.end) params.set('end', String(options.end));
  if (options.limit) params.set('limit', String(options.limit));
  return apiFetch(`/candles?${params.toString()}`);
}

// ============================================
// SETTINGS
// ============================================
export async function saveSetting(key: string, value: unknown): Promise<void> {
  await apiFetch(`/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export async function loadSetting(key: string): Promise<unknown | null> {
  const result = await apiFetch<{ key: string; value: string | null }>(`/settings/${encodeURIComponent(key)}`);
  if (result.value === null) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    return result.value;
  }
}

export async function loadAllSettings(): Promise<Record<string, unknown>> {
  const result = await apiFetch<{ settings: Array<{ key: string; value: string }> }>('/settings');
  const map: Record<string, unknown> = {};
  for (const s of result.settings) {
    try {
      map[s.key] = JSON.parse(s.value);
    } catch {
      map[s.key] = s.value;
    }
  }
  return map;
}

// ============================================
// SENTIMENT HISTORY
// ============================================
export async function saveSentimentSnapshot(snapshot: {
  ticker: string;
  source: string;
  score: number;
  rawData?: unknown;
}): Promise<{ id: number }> {
  return apiFetch('/sentiment', {
    method: 'POST',
    body: JSON.stringify(snapshot),
  });
}

export async function loadSentimentHistory(ticker: string, hours: number = 24): Promise<{
  history: Array<{
    id: number;
    ticker: string;
    source: string;
    score: number;
    raw_data: string | null;
    created_at: number;
  }>;
  count: number;
}> {
  return apiFetch(`/sentiment/${encodeURIComponent(ticker)}?hours=${hours}`);
}
