/**
 * PortfolioManager — Cross-exchange portfolio tracking and risk management.
 *
 * Aggregates data from both Kraken and Crypto.com engines.
 * Provides global risk metrics, heat score, and position correlation.
 */

import tradingBus from './eventBus.ts';
import type { EntryEvent, ExitEvent } from './eventBus.ts';
import type { TradingEngine } from './TradingEngine.ts';

// ─── Types ───────────────────────────────────────────────────

export interface GlobalPortfolio {
  totalEquity: number;
  totalCash: number;
  totalPnl: number;
  totalPnlPct: number;
  totalInitialBudget: number;
  krakenEquity: number;
  cryptoComEquity: number;
  krakenPnl: number;
  cryptoComPnl: number;
  totalPositions: number;
  totalExposurePct: number;
  heatScore: number;         // 0-100 risk heat
  maxDrawdownPct: number;
  totalTrades: number;
  winRate: number;
}

export interface PositionCorrelation {
  ticker: string;
  exchange: string;
  weight: number;
}

// ─── Global Risk Limits ─────────────────────────────────────

const RISK_LIMITS = {
  maxGlobalExposure: 0.60,    // Max 60% of total equity deployed
  maxPerExchange: 0.40,       // Max 40% on one exchange
  maxPerTicker: 0.10,         // Max 10% in one coin (across both exchanges)
  heatWarning: 80,            // Heat > 80 → no new positions
  heatCritical: 90,           // Heat > 90 → start reducing
};

// ─── PortfolioManager ───────────────────────────────────────

class PortfolioManager {
  private engines: Map<string, TradingEngine> = new Map();
  private peakGlobalEquity = 0;
  private tradeHistory: { time: number; exchange: string; pnl: number }[] = [];

  constructor() {
    // Subscribe to trade events for tracking
    tradingBus.on('trade:exit', (event: ExitEvent) => {
      this.tradeHistory.push({
        time: event.timestamp,
        exchange: event.exchange,
        pnl: event.netPnlUsd,
      });
      // Keep last 1000 trades
      if (this.tradeHistory.length > 1000) {
        this.tradeHistory = this.tradeHistory.slice(-1000);
      }
    });
  }

  registerEngine(exchangeId: string, engine: TradingEngine): void {
    this.engines.set(exchangeId, engine);
  }

  // ─── Global Portfolio View ───────────────────────────────

  getGlobalPortfolio(): GlobalPortfolio {
    let totalEquity = 0;
    let totalCash = 0;
    let totalInitialBudget = 0;
    let totalPositions = 0;
    let krakenEquity = 0;
    let cryptoComEquity = 0;

    for (const [id, engine] of this.engines) {
      const status = engine.getStatus();
      const equity = status.equity as number;
      totalEquity += equity;
      totalCash += status.cash as number;
      totalInitialBudget += status.initialBudget as number;
      totalPositions += status.positions as number;

      if (id === 'kraken') krakenEquity = equity;
      if (id === 'crypto.com') cryptoComEquity = equity;
    }

    // Update peak
    if (totalEquity > this.peakGlobalEquity) {
      this.peakGlobalEquity = totalEquity;
    }

    const totalPnl = totalEquity - totalInitialBudget;
    const totalPnlPct = totalInitialBudget > 0 ? (totalPnl / totalInitialBudget) * 100 : 0;
    const maxDrawdownPct = this.peakGlobalEquity > 0
      ? ((this.peakGlobalEquity - totalEquity) / this.peakGlobalEquity) * 100
      : 0;

    const deployed = totalEquity - totalCash;
    const totalExposurePct = totalEquity > 0 ? (deployed / totalEquity) * 100 : 0;

    const heatScore = this.calculateHeat(totalExposurePct, maxDrawdownPct, totalPositions);

    // Aggregate trade stats from all engines
    let totalTrades = 0;
    let totalWins = 0;
    for (const [, engine] of this.engines) {
      const s = engine.getStatus();
      const trades = s.trades as { total?: number; winRate?: number } | undefined;
      if (trades?.total) {
        totalTrades += trades.total;
        totalWins += Math.round((trades.winRate || 0) / 100 * trades.total);
      }
    }
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    return {
      totalEquity,
      totalCash,
      totalPnl,
      totalPnlPct,
      totalInitialBudget,
      krakenEquity,
      cryptoComEquity,
      krakenPnl: krakenEquity - (this.engines.get('kraken')?.getStatus().initialBudget as number || 0),
      cryptoComPnl: cryptoComEquity - (this.engines.get('crypto.com')?.getStatus().initialBudget as number || 0),
      totalPositions,
      totalExposurePct,
      heatScore,
      maxDrawdownPct,
      totalTrades,
      winRate,
    };
  }

  // ─── Heat Score (0-100) ──────────────────────────────────

  private calculateHeat(exposurePct: number, drawdownPct: number, positions: number): number {
    // Components:
    // 40% from exposure level
    const exposureHeat = Math.min((exposurePct / (RISK_LIMITS.maxGlobalExposure * 100)) * 40, 40);

    // 30% from drawdown
    const drawdownHeat = Math.min((drawdownPct / 15) * 30, 30); // 15% drawdown = max heat

    // 20% from position count (more positions = more risk)
    const positionHeat = Math.min((positions / 10) * 20, 20); // 10+ positions = max

    // 10% from recent loss streak
    const recentTrades = this.tradeHistory.slice(-10);
    const recentLosses = recentTrades.filter(t => t.pnl < 0).length;
    const lossHeat = (recentLosses / 10) * 10;

    return Math.round(exposureHeat + drawdownHeat + positionHeat + lossHeat);
  }

  // ─── Risk Checks ─────────────────────────────────────────

  canOpenPosition(exchange: string, ticker: string, usdAmount: number): { allowed: boolean; reason?: string } {
    const global = this.getGlobalPortfolio();

    // Heat check
    if (global.heatScore >= RISK_LIMITS.heatCritical) {
      return { allowed: false, reason: `Heat score ${global.heatScore}/100 — reducing risk` };
    }
    if (global.heatScore >= RISK_LIMITS.heatWarning) {
      return { allowed: false, reason: `Heat score ${global.heatScore}/100 — no new positions` };
    }

    // Global exposure
    if (global.totalExposurePct / 100 >= RISK_LIMITS.maxGlobalExposure) {
      return { allowed: false, reason: `Global exposure ${global.totalExposurePct.toFixed(1)}% >= ${RISK_LIMITS.maxGlobalExposure * 100}% limit` };
    }

    // Per-exchange exposure
    const engineStatus = this.engines.get(exchange)?.getStatus();
    if (engineStatus) {
      const exchangeEquity = engineStatus.equity as number;
      const exchangeDeployed = exchangeEquity - (engineStatus.cash as number);
      const exchangeExposure = exchangeEquity > 0 ? exchangeDeployed / global.totalEquity : 0;
      if (exchangeExposure >= RISK_LIMITS.maxPerExchange) {
        return { allowed: false, reason: `${exchange} exposure ${(exchangeExposure * 100).toFixed(1)}% >= ${RISK_LIMITS.maxPerExchange * 100}% limit` };
      }
    }

    // Per-ticker check (across both exchanges)
    let tickerExposure = 0;
    for (const engine of this.engines.values()) {
      const pos = engine.getPortfolio().positions[ticker];
      if (pos) {
        tickerExposure += pos.openPrice * pos.quantity;
      }
    }
    tickerExposure += usdAmount;
    if (global.totalEquity > 0 && tickerExposure / global.totalEquity >= RISK_LIMITS.maxPerTicker) {
      return { allowed: false, reason: `${ticker} exposure would be ${((tickerExposure / global.totalEquity) * 100).toFixed(1)}% >= ${RISK_LIMITS.maxPerTicker * 100}% limit` };
    }

    return { allowed: true };
  }

  // ─── Performance Metrics ─────────────────────────────────

  getPerformanceMetrics(days = 30) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = this.tradeHistory.filter(t => t.time >= cutoff);

    if (recent.length === 0) {
      return { trades: 0, winRate: 0, avgPnl: 0, sharpeRatio: 0, maxConsecutiveLosses: 0 };
    }

    const wins = recent.filter(t => t.pnl > 0).length;
    const pnls = recent.map(t => t.pnl);
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const stdDev = Math.sqrt(pnls.reduce((sum, p) => sum + (p - avgPnl) ** 2, 0) / pnls.length);
    const sharpeRatio = stdDev > 0 ? (avgPnl / stdDev) * Math.sqrt(252) : 0; // Annualized

    // Max consecutive losses
    let maxLosses = 0;
    let currentLosses = 0;
    for (const t of recent) {
      if (t.pnl < 0) {
        currentLosses++;
        maxLosses = Math.max(maxLosses, currentLosses);
      } else {
        currentLosses = 0;
      }
    }

    return {
      trades: recent.length,
      winRate: wins / recent.length,
      avgPnl,
      totalPnl: pnls.reduce((a, b) => a + b, 0),
      sharpeRatio,
      maxConsecutiveLosses: maxLosses,
      byExchange: {
        kraken: {
          trades: recent.filter(t => t.exchange === 'kraken').length,
          pnl: recent.filter(t => t.exchange === 'kraken').reduce((a, t) => a + t.pnl, 0),
        },
        'crypto.com': {
          trades: recent.filter(t => t.exchange === 'crypto.com').length,
          pnl: recent.filter(t => t.exchange === 'crypto.com').reduce((a, t) => a + t.pnl, 0),
        },
      },
    };
  }
}

export const portfolioManager = new PortfolioManager();
export default portfolioManager;
