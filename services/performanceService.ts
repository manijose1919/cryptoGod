/**
 * Performance Analytics Service (Frontend)
 * Computes equity curves, strategy breakdowns, monthly P&L, and rolling metrics.
 */

export interface Trade {
  type: 'BUY' | 'SELL';
  ticker: string;
  price: number;
  quantity: number;
  strategy?: string;
  timestamp?: number;
  pnl?: number;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  drawdown: number;
  tradeIndex: number;
}

export interface StrategyStats {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
}

export interface MonthlyPnl {
  month: string; // 'YYYY-MM'
  pnl: number;
  trades: number;
  winRate: number;
}

export interface RollingMetrics {
  timestamp: number;
  sharpe: number;
  winRate: number;
  avgPnl: number;
  tradeIndex: number;
}

export function computeEquityCurve(trades: Trade[], initialBudget: number): EquityPoint[] {
  const curve: EquityPoint[] = [{ timestamp: Date.now() - 86400000, equity: initialBudget, drawdown: 0, tradeIndex: 0 }];
  let equity = initialBudget;
  let peak = initialBudget;

  const sells = trades.filter(t => t.type === 'SELL' && t.pnl != null);
  for (let i = 0; i < sells.length; i++) {
    equity += sells[i].pnl!;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    curve.push({
      timestamp: sells[i].timestamp || Date.now(),
      equity,
      drawdown,
      tradeIndex: i + 1,
    });
  }
  return curve;
}

export function computeStrategyBreakdown(trades: Trade[]): StrategyStats[] {
  const map: Record<string, Trade[]> = {};
  const sells = trades.filter(t => t.type === 'SELL' && t.pnl != null);

  for (const t of sells) {
    const s = t.strategy || 'UNKNOWN';
    if (!map[s]) map[s] = [];
    map[s].push(t);
  }

  return Object.entries(map).map(([strategy, stratTrades]) => {
    const wins = stratTrades.filter(t => t.pnl! > 0);
    const losses = stratTrades.filter(t => t.pnl! <= 0);
    const totalPnl = stratTrades.reduce((s, t) => s + t.pnl!, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl!, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl!, 0));

    return {
      strategy,
      trades: stratTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: stratTrades.length > 0 ? (wins.length / stratTrades.length) * 100 : 0,
      totalPnl,
      avgPnl: stratTrades.length > 0 ? totalPnl / stratTrades.length : 0,
      maxWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl!)) : 0,
      maxLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl!)) : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);
}

export function computeMonthlyPnL(trades: Trade[]): MonthlyPnl[] {
  const map: Record<string, { pnl: number; trades: number; wins: number }> = {};
  const sells = trades.filter(t => t.type === 'SELL' && t.pnl != null);

  for (const t of sells) {
    const date = new Date(t.timestamp || Date.now());
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!map[month]) map[month] = { pnl: 0, trades: 0, wins: 0 };
    map[month].pnl += t.pnl!;
    map[month].trades++;
    if (t.pnl! > 0) map[month].wins++;
  }

  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({
      month,
      pnl: data.pnl,
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    }));
}

export function computeRollingMetrics(trades: Trade[], window: number = 30): RollingMetrics[] {
  const sells = trades.filter(t => t.type === 'SELL' && t.pnl != null);
  if (sells.length < window) return [];

  const metrics: RollingMetrics[] = [];
  for (let i = window; i <= sells.length; i++) {
    const windowTrades = sells.slice(i - window, i);
    const pnls = windowTrades.map(t => t.pnl!);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const wins = pnls.filter(p => p > 0).length;

    metrics.push({
      timestamp: windowTrades[windowTrades.length - 1].timestamp || Date.now(),
      sharpe: stdDev > 0 ? mean / stdDev : 0,
      winRate: (wins / pnls.length) * 100,
      avgPnl: mean,
      tradeIndex: i,
    });
  }
  return metrics;
}
