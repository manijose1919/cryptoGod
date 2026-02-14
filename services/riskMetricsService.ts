/**
 * Risk Metrics & Kelly Criterion Service
 *
 * Provides:
 * - Real-time risk metrics (drawdown, Sharpe, Sortino, Calmar)
 * - Win/loss streak analysis
 * - Kelly Criterion position sizing
 * - Monte Carlo risk simulation
 * - Backtesting support
 */

import type { Trade } from '../types';

// ============================================
// TYPES
// ============================================
export interface RiskMetrics {
  // Drawdown metrics
  currentDrawdown: number;       // Current % below peak
  maxDrawdown: number;           // Worst historical drawdown
  maxDrawdownDuration: number;   // Longest drawdown in minutes
  peakValue: number;             // Highest portfolio value
  troughValue: number;           // Lowest value during current drawdown

  // Return metrics
  totalReturn: number;           // Total % return
  dailyReturn: number;           // Today's return
  sharpeRatio: number;           // Risk-adjusted return
  sortinoRatio: number;          // Downside risk-adjusted
  calmarRatio: number;           // Return / max drawdown

  // Trade metrics
  winRate: number;               // % winning trades
  avgWin: number;                // Average win $
  avgLoss: number;               // Average loss $
  profitFactor: number;          // Gross profit / gross loss
  expectancy: number;            // Expected $ per trade
  payoffRatio: number;           // Avg win / avg loss

  // Streak analysis
  currentStreak: number;         // Positive = wins, negative = losses
  maxWinStreak: number;
  maxLossStreak: number;
  streakRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  // Risk of ruin
  riskOfRuin: number;            // Probability of hitting stop (0-100%)
  ruinThreshold: number;         // % drawdown that triggers stop

  lastUpdated: number;
}

export interface KellyResult {
  fullKelly: number;             // Optimal fraction (can be > 1)
  halfKelly: number;
  quarterKelly: number;
  recommendedFraction: number;   // Conservative recommendation
  confidence: number;            // How confident in the edge estimate
  warning: string | null;        // Any warnings about the calculation
  impliedEdge: number;           // The edge the data suggests
}

export interface MonteCarloResult {
  medianOutcome: number;         // Median portfolio value after N trades
  worstCase5Pct: number;         // 5th percentile (worst 5%)
  bestCase95Pct: number;         // 95th percentile (best 5%)
  ruinProbability: number;       // % of simulations hitting ruin
  avgMaxDrawdown: number;        // Average max drawdown across sims
  confidenceInterval: [number, number];  // 90% confidence interval
  simulations: number;           // Number of simulations run
}

// ============================================
// EQUITY CURVE TRACKING
// ============================================
interface EquityPoint {
  timestamp: number;
  value: number;
}

let equityCurve: EquityPoint[] = [];
let peakValue = 0;
let troughValue = Infinity;
let maxDrawdown = 0;
let maxDrawdownDuration = 0;
let drawdownStartTime = 0;

/**
 * Update equity curve with new portfolio value
 */
export function updateEquityCurve(portfolioValue: number): void {
  const now = Date.now();
  equityCurve.push({ timestamp: now, value: portfolioValue });

  // Keep only last 1000 points
  if (equityCurve.length > 1000) {
    equityCurve = equityCurve.slice(-1000);
  }

  // Track peak
  if (portfolioValue > peakValue) {
    peakValue = portfolioValue;
    troughValue = portfolioValue;
    drawdownStartTime = 0;
  } else {
    // We're in drawdown
    if (portfolioValue < troughValue) {
      troughValue = portfolioValue;
    }

    if (drawdownStartTime === 0) {
      drawdownStartTime = now;
    }

    const currentDrawdown = ((peakValue - troughValue) / peakValue) * 100;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }

    const drawdownDuration = now - drawdownStartTime;
    if (drawdownDuration > maxDrawdownDuration) {
      maxDrawdownDuration = drawdownDuration;
    }
  }
}

/**
 * Reset equity tracking (new session)
 */
export function resetEquityTracking(initialValue: number): void {
  equityCurve = [{ timestamp: Date.now(), value: initialValue }];
  peakValue = initialValue;
  troughValue = initialValue;
  maxDrawdown = 0;
  maxDrawdownDuration = 0;
  drawdownStartTime = 0;
}

// ============================================
// RISK METRICS CALCULATION
// ============================================

/**
 * Calculate comprehensive risk metrics
 */
export function calculateRiskMetrics(
  trades: Trade[],
  currentPortfolioValue: number,
  initialBudget: number,
  ruinThreshold: number = 50  // Stop at 50% drawdown
): RiskMetrics {
  const now = Date.now();

  // Update equity curve
  updateEquityCurve(currentPortfolioValue);

  // Current drawdown
  const currentDrawdown = peakValue > 0
    ? ((peakValue - currentPortfolioValue) / peakValue) * 100
    : 0;

  // Total return
  const totalReturn = initialBudget > 0
    ? ((currentPortfolioValue - initialBudget) / initialBudget) * 100
    : 0;

  // Daily return (from equity curve)
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const dayStartPoint = equityCurve.find(p => p.timestamp >= oneDayAgo);
  const dailyReturn = dayStartPoint
    ? ((currentPortfolioValue - dayStartPoint.value) / dayStartPoint.value) * 100
    : 0;

  // Trade analysis
  const completedTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);
  const wins = completedTrades.filter(t => (t.pnl || 0) > 0);
  const losses = completedTrades.filter(t => (t.pnl || 0) <= 0);

  const winRate = completedTrades.length > 0
    ? (wins.length / completedTrades.length) * 100
    : 0;

  const avgWin = wins.length > 0
    ? wins.reduce((sum, t) => sum + (t.pnl || 0), 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0) / losses.length)
    : 0;

  const grossProfit = wins.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0));

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Expectancy: (Win% * Avg Win) - (Loss% * Avg Loss)
  const expectancy = completedTrades.length > 0
    ? (winRate / 100 * avgWin) - ((100 - winRate) / 100 * avgLoss)
    : 0;

  // Streak analysis
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let tempWinStreak = 0;
  let tempLossStreak = 0;

  for (const trade of completedTrades) {
    if ((trade.pnl || 0) > 0) {
      tempWinStreak++;
      tempLossStreak = 0;
      if (tempWinStreak > maxWinStreak) maxWinStreak = tempWinStreak;
    } else {
      tempLossStreak++;
      tempWinStreak = 0;
      if (tempLossStreak > maxLossStreak) maxLossStreak = tempLossStreak;
    }
  }

  // Current streak from most recent trades
  for (let i = completedTrades.length - 1; i >= 0; i--) {
    const pnl = completedTrades[i].pnl || 0;
    if (i === completedTrades.length - 1) {
      currentStreak = pnl > 0 ? 1 : -1;
    } else {
      const prevPnl = completedTrades[i + 1].pnl || 0;
      if ((pnl > 0 && prevPnl > 0) || (pnl <= 0 && prevPnl <= 0)) {
        currentStreak += pnl > 0 ? 1 : -1;
      } else {
        break;
      }
    }
  }

  // Streak risk assessment
  let streakRisk: RiskMetrics['streakRisk'];
  if (currentStreak <= -5 || maxLossStreak >= 8) {
    streakRisk = 'CRITICAL';
  } else if (currentStreak <= -3 || maxLossStreak >= 5) {
    streakRisk = 'HIGH';
  } else if (currentStreak <= -2 || maxLossStreak >= 3) {
    streakRisk = 'MEDIUM';
  } else {
    streakRisk = 'LOW';
  }

  // Sharpe & Sortino ratios (simplified)
  const returns = completedTrades.map(t => (t.pnl || 0) / initialBudget * 100);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);

  const downReturns = returns.filter(r => r < 0);
  const downVariance = downReturns.length > 1
    ? downReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downReturns.length
    : 0;
  const downStdDev = Math.sqrt(downVariance);

  // Annualized (assuming ~250 trading days)
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(250) : 0;
  const sortinoRatio = downStdDev > 0 ? (avgReturn / downStdDev) * Math.sqrt(250) : 0;
  const calmarRatio = maxDrawdown > 0 ? totalReturn / maxDrawdown : totalReturn > 0 ? Infinity : 0;

  // Risk of ruin (simplified probability estimate)
  const riskOfRuin = calculateRiskOfRuin(winRate / 100, payoffRatio, ruinThreshold);

  return {
    currentDrawdown,
    maxDrawdown,
    maxDrawdownDuration,
    peakValue,
    troughValue,
    totalReturn,
    dailyReturn,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    payoffRatio,
    currentStreak,
    maxWinStreak,
    maxLossStreak,
    streakRisk,
    riskOfRuin,
    ruinThreshold,
    lastUpdated: now
  };
}

/**
 * Simplified risk of ruin calculation
 */
function calculateRiskOfRuin(winRate: number, payoffRatio: number, ruinThreshold: number): number {
  if (winRate <= 0 || payoffRatio <= 0) return 100;
  if (winRate >= 1) return 0;

  // Using simplified formula for risk of ruin
  // RoR ≈ ((1 - edge) / (1 + edge))^units
  const edge = winRate * payoffRatio - (1 - winRate);

  if (edge <= 0) return 100;  // No edge = eventual ruin

  // Estimate units to ruin based on threshold
  const unitsToRuin = ruinThreshold / 2;  // Rough estimate

  const ror = Math.pow((1 - edge) / (1 + edge), unitsToRuin) * 100;
  return Math.min(100, Math.max(0, ror));
}

// ============================================
// KELLY CRITERION
// ============================================

/**
 * Calculate Kelly Criterion optimal bet size
 *
 * Formula: f* = W - (1-W)/R
 * Where W = win rate, R = payoff ratio (avg win / avg loss)
 */
export function calculateKellyCriterion(
  trades: Trade[],
  minTrades: number = 20
): KellyResult {
  const completedTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);

  if (completedTrades.length < minTrades) {
    return {
      fullKelly: 0,
      halfKelly: 0,
      quarterKelly: 0,
      recommendedFraction: 0.05,  // Conservative 5% default
      confidence: 0,
      warning: `Need at least ${minTrades} trades for Kelly calculation (have ${completedTrades.length})`,
      impliedEdge: 0
    };
  }

  const wins = completedTrades.filter(t => (t.pnl || 0) > 0);
  const losses = completedTrades.filter(t => (t.pnl || 0) <= 0);

  const winRate = wins.length / completedTrades.length;

  const avgWin = wins.length > 0
    ? wins.reduce((sum, t) => sum + (t.pnl || 0), 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0) / losses.length)
    : 1;  // Avoid division by zero

  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Kelly formula: f* = W - (1-W)/R
  const fullKelly = winRate - ((1 - winRate) / payoffRatio);

  // Calculate implied edge: edge = W * R - (1 - W)
  const impliedEdge = winRate * payoffRatio - (1 - winRate);

  // Fractional Kelly
  const halfKelly = fullKelly / 2;
  const quarterKelly = fullKelly / 4;

  // Confidence based on sample size and consistency
  const stdDevWinRate = Math.sqrt(winRate * (1 - winRate) / completedTrades.length);
  const confidence = Math.max(0, Math.min(100, 100 - stdDevWinRate * 500));

  // Generate warnings
  let warning: string | null = null;

  if (fullKelly > 1) {
    warning = `Full Kelly suggests ${(fullKelly * 100).toFixed(0)}% - extremely aggressive, use quarter-Kelly max`;
  } else if (fullKelly > 0.5) {
    warning = `Full Kelly > 50% - consider half-Kelly for safety`;
  } else if (fullKelly < 0) {
    warning = 'Negative Kelly indicates no edge - avoid trading or reduce size significantly';
  } else if (confidence < 50) {
    warning = 'Low confidence in estimates - use quarter-Kelly until more trades';
  }

  // Recommended fraction based on confidence and full Kelly value
  let recommendedFraction: number;

  if (fullKelly <= 0) {
    recommendedFraction = 0.01;  // Minimal if no edge
  } else if (confidence < 30) {
    recommendedFraction = Math.min(0.05, quarterKelly);  // Very conservative
  } else if (confidence < 60) {
    recommendedFraction = Math.min(0.10, quarterKelly);  // Conservative
  } else if (confidence < 80) {
    recommendedFraction = Math.min(0.15, halfKelly);  // Moderate
  } else {
    recommendedFraction = Math.min(0.25, halfKelly);  // Confident but still capped
  }

  return {
    fullKelly: Math.max(0, fullKelly),
    halfKelly: Math.max(0, halfKelly),
    quarterKelly: Math.max(0, quarterKelly),
    recommendedFraction: Math.max(0.01, recommendedFraction),
    confidence,
    warning,
    impliedEdge
  };
}

/**
 * Apply Kelly-based position sizing
 */
export function getKellyPositionSize(
  kelly: KellyResult,
  portfolioValue: number,
  kellyMode: 'FULL' | 'HALF' | 'QUARTER' | 'RECOMMENDED' = 'RECOMMENDED'
): { positionSize: number; fraction: number; reason: string } {
  let fraction: number;
  let reason: string;

  switch (kellyMode) {
    case 'FULL':
      fraction = kelly.fullKelly;
      reason = `Full Kelly: ${(fraction * 100).toFixed(1)}%`;
      break;
    case 'HALF':
      fraction = kelly.halfKelly;
      reason = `Half Kelly: ${(fraction * 100).toFixed(1)}%`;
      break;
    case 'QUARTER':
      fraction = kelly.quarterKelly;
      reason = `Quarter Kelly: ${(fraction * 100).toFixed(1)}%`;
      break;
    case 'RECOMMENDED':
    default:
      fraction = kelly.recommendedFraction;
      reason = `Recommended (${(kelly.confidence).toFixed(0)}% confidence): ${(fraction * 100).toFixed(1)}%`;
  }

  // Cap at 25% regardless of Kelly suggestion
  fraction = Math.min(0.25, Math.max(0.01, fraction));

  return {
    positionSize: portfolioValue * fraction,
    fraction,
    reason
  };
}

// ============================================
// MONTE CARLO SIMULATION
// ============================================

/**
 * Run Monte Carlo simulation to estimate risk
 */
export function runMonteCarloSimulation(
  trades: Trade[],
  initialCapital: number,
  numTrades: number = 100,
  numSimulations: number = 1000,
  ruinThreshold: number = 0.5  // 50% drawdown = ruin
): MonteCarloResult {
  const completedTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);

  if (completedTrades.length < 10) {
    return {
      medianOutcome: initialCapital,
      worstCase5Pct: initialCapital * 0.5,
      bestCase95Pct: initialCapital * 1.5,
      ruinProbability: 50,
      avgMaxDrawdown: 25,
      confidenceInterval: [initialCapital * 0.7, initialCapital * 1.3],
      simulations: 0
    };
  }

  // Extract PnL percentages
  const pnlPercentages = completedTrades.map(t => {
    const tradeValue = t.price * t.quantity;
    return ((t.pnl || 0) / tradeValue) * 100;
  });

  const outcomes: number[] = [];
  const maxDrawdowns: number[] = [];
  let ruinCount = 0;

  for (let sim = 0; sim < numSimulations; sim++) {
    let capital = initialCapital;
    let peakCap = initialCapital;
    let maxDD = 0;
    let ruined = false;

    for (let trade = 0; trade < numTrades; trade++) {
      // Random sample from historical PnL distribution
      const randomIdx = Math.floor(Math.random() * pnlPercentages.length);
      const pnlPct = pnlPercentages[randomIdx];

      // Apply PnL (assuming 10% position size for simulation)
      const positionSize = capital * 0.1;
      const tradePnl = positionSize * (pnlPct / 100);
      capital += tradePnl;

      // Track peak and drawdown
      if (capital > peakCap) {
        peakCap = capital;
      }
      const currentDD = (peakCap - capital) / peakCap;
      if (currentDD > maxDD) {
        maxDD = currentDD;
      }

      // Check for ruin
      if (capital <= initialCapital * (1 - ruinThreshold)) {
        ruined = true;
        break;
      }
    }

    outcomes.push(capital);
    maxDrawdowns.push(maxDD * 100);
    if (ruined) ruinCount++;
  }

  // Sort outcomes for percentile calculations
  outcomes.sort((a, b) => a - b);

  const medianIdx = Math.floor(numSimulations / 2);
  const pct5Idx = Math.floor(numSimulations * 0.05);
  const pct95Idx = Math.floor(numSimulations * 0.95);
  const pct10Idx = Math.floor(numSimulations * 0.10);
  const pct90Idx = Math.floor(numSimulations * 0.90);

  const avgMaxDrawdown = maxDrawdowns.reduce((a, b) => a + b, 0) / maxDrawdowns.length;

  return {
    medianOutcome: outcomes[medianIdx],
    worstCase5Pct: outcomes[pct5Idx],
    bestCase95Pct: outcomes[pct95Idx],
    ruinProbability: (ruinCount / numSimulations) * 100,
    avgMaxDrawdown,
    confidenceInterval: [outcomes[pct10Idx], outcomes[pct90Idx]],
    simulations: numSimulations
  };
}

/**
 * Get risk-adjusted allocation recommendation
 */
export function getRiskAdjustedAllocation(
  metrics: RiskMetrics,
  kelly: KellyResult,
  monteCarlo: MonteCarloResult
): {
  recommendedTier: 25 | 50 | 75 | 100;
  maxPositionSize: number;  // As fraction 0-1
  reasoning: string[];
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
} {
  const reasoning: string[] = [];
  let riskScore = 0;  // Higher = more risk

  // Drawdown assessment
  if (metrics.maxDrawdown > 30) {
    riskScore += 3;
    reasoning.push(`High max drawdown (${metrics.maxDrawdown.toFixed(1)}%)`);
  } else if (metrics.maxDrawdown > 15) {
    riskScore += 1;
  }

  // Current drawdown
  if (metrics.currentDrawdown > 15) {
    riskScore += 2;
    reasoning.push(`Currently in ${metrics.currentDrawdown.toFixed(1)}% drawdown`);
  }

  // Streak risk
  if (metrics.streakRisk === 'CRITICAL') {
    riskScore += 3;
    reasoning.push('Critical losing streak');
  } else if (metrics.streakRisk === 'HIGH') {
    riskScore += 2;
    reasoning.push('Elevated losing streak');
  }

  // Risk of ruin
  if (metrics.riskOfRuin > 20) {
    riskScore += 3;
    reasoning.push(`High risk of ruin (${metrics.riskOfRuin.toFixed(1)}%)`);
  } else if (metrics.riskOfRuin > 10) {
    riskScore += 1;
  }

  // Monte Carlo
  if (monteCarlo.ruinProbability > 10) {
    riskScore += 2;
    reasoning.push(`${monteCarlo.ruinProbability.toFixed(1)}% ruin probability in simulations`);
  }

  // Kelly edge
  if (kelly.impliedEdge <= 0) {
    riskScore += 3;
    reasoning.push('No positive edge detected');
  } else if (kelly.impliedEdge < 0.05) {
    riskScore += 1;
    reasoning.push('Marginal edge');
  }

  // Determine tier and position size
  let recommendedTier: 25 | 50 | 75 | 100;
  let maxPositionSize: number;
  let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  if (riskScore >= 8) {
    recommendedTier = 25;
    maxPositionSize = 0.05;
    overallRisk = 'CRITICAL';
    reasoning.push('Recommend minimum allocation and position sizing');
  } else if (riskScore >= 5) {
    recommendedTier = 25;
    maxPositionSize = 0.10;
    overallRisk = 'HIGH';
    reasoning.push('Recommend conservative allocation');
  } else if (riskScore >= 2) {
    recommendedTier = 50;
    maxPositionSize = kelly.recommendedFraction;
    overallRisk = 'MEDIUM';
    reasoning.push('Moderate allocation appropriate');
  } else {
    recommendedTier = 75;
    maxPositionSize = Math.min(0.20, kelly.halfKelly);
    overallRisk = 'LOW';
    reasoning.push('Favorable conditions for increased allocation');
  }

  return {
    recommendedTier,
    maxPositionSize,
    reasoning,
    overallRisk
  };
}
