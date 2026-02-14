/**
 * Backtest API Client (Frontend)
 */

const API = '/api/backtest';

export interface BacktestOptions {
  ticker: string;
  strategy: string;
  startTime: number;
  endTime: number;
  timeframe?: string;
  initialCash?: number;
  riskPercent?: number;
}

export interface BacktestResult {
  ticker: string;
  strategy: string;
  timeframe: string;
  initialCash: number;
  finalValue: number;
  totalReturn: number;
  trades: { type: string; price: number; quantity: number; time: number; pnl: number }[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  buyAndHoldReturn: number;
  error?: string;
}

export interface AvailableData {
  ticker: string;
  timeframe: string;
  candleCount: number;
  startTime: number;
  endTime: number;
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const res = await fetch(`${API}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return res.json();
}

export async function getAvailableData(): Promise<AvailableData[]> {
  const res = await fetch(`${API}/available`);
  const data = await res.json();
  return data.data || [];
}

export async function runParameterSweep(options: BacktestOptions & { riskPercents?: number[] }) {
  const res = await fetch(`${API}/sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return res.json();
}

export async function runWalkForward(options: BacktestOptions & { windows?: number }) {
  const res = await fetch(`${API}/walk-forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return res.json();
}
