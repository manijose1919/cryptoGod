/**
 * Parameter Optimizer - Self-Tuning Trading Engine
 *
 * Automatically sweeps trade history to find better entry thresholds
 * and TP/SL targets, constrained to prevent wild swings.
 *
 * Two parameter groups optimized independently:
 *   Group A (Entry Thresholds): minOpportunityScore, compositeScoreFloor, strategy thresholds
 *   Group B (TP/SL Targets): takeProfitPct & stopLossPct per volatility regime
 *
 * Triggered every 50 completed trades from handleSell (first run at 30).
 * Max 15% change per cycle, values clamped to safe min/max bounds.
 * Fitness metric: recency-weighted profit factor (gross wins / gross losses).
 */

// ============================================
// SAFE BOUNDS (optimizer cannot exceed these)
// ============================================

const PARAM_BOUNDS = {
    // Group A: Entry Thresholds
    minOpportunityScore:    { min: 15, max: 50, default: 25 },
    compositeScoreFloor:    { min: 15, max: 40, default: 25 },
    TREND_BULLISH_ENTRY:    { min: 25, max: 50, default: 40 },
    MOMENTUM_BULLISH_ENTRY: { min: 55, max: 85, default: 70 },
    BREAKOUT_SQUEEZE_ENTRY: { min: 55, max: 90, default: 75 },
    ADAPTIVE_BULLISH_ENTRY: { min: 25, max: 45, default: 35 },

    // Group B: TP/SL Targets per regime
    // SL mins raised: must never go below roundTripFee + 0.8% (Kraken = 1.32%)
    // TP mins raised to maintain >= 2:1 R:R ratio
    TP_HIGH_VOL:  { min: 2.0, max: 8.0, default: 4.0 },
    TP_NORMAL:    { min: 1.5, max: 5.0, default: 3.0 },
    TP_LOW_VOL:   { min: 1.0, max: 4.0, default: 2.0 },
    SL_HIGH_VOL:  { min: 1.5, max: 4.0, default: 2.0 },
    SL_NORMAL:    { min: 1.0, max: 3.0, default: 1.5 },
    SL_LOW_VOL:   { min: 0.8, max: 2.5, default: 1.2 },
};

const MAX_CHANGE_PER_CYCLE = 0.15; // 15% max change per optimization
const MIN_TRADES_REQUIRED = 30;    // Need at least 30 trades to optimize
const ROLLING_WINDOW = 200;        // Use last 200 trades
const MIN_FITNESS_IMPROVEMENT = 0.05; // 5% minimum improvement to justify a change
const TRAIN_SPLIT = 0.7;             // 70% train, 30% validation
let currentRoundTripFee = 0.15;      // Updated from beastMode's actual exchange fee

// ============================================
// STATE
// ============================================

let currentParams = {};
let optimizationHistory = [];  // { timestamp, changedParams, profitFactorBefore, profitFactorAfter }
let lastOptimizationTime = 0;
let totalOptimizations = 0;
let tradeCountAtLastOpt = 0;
let consecutiveNoChange = 0;   // tracks how many cycles produced no changes (for adaptive step)

// Rollback: snapshot of params before last optimization + post-opt tracking
let preOptSnapshot = null;       // { params: {...}, profitFactor, tradeCount }
let postOptTradeCount = 0;       // trades since last optimization
let postOptPnlSum = 0;           // sum of PnL since last optimization
let postOptWins = 0;
let postOptLosses = 0;
let postOptGrossWins = 0;        // sum of positive PnLs (for accurate profit factor)
let postOptGrossLosses = 0;      // sum of absolute negative PnLs
const ROLLBACK_EVAL_TRADES = 20; // evaluate rollback after 20 post-opt trades

// Initialize with defaults
function initDefaults() {
    for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
        if (currentParams[key] === undefined) {
            currentParams[key] = bounds.default;
        }
    }
}
initDefaults();

// ============================================
// HELPERS
// ============================================

/** Clamp value within safe bounds, with fee-aware SL floor */
function clamp(paramName, value) {
    const bounds = PARAM_BOUNDS[paramName];
    if (!bounds) return value;
    let clamped = Math.max(bounds.min, Math.min(bounds.max, value));
    // Fee-aware guard: SL must never go below roundTripFee + 0.8% breathing room
    if (paramName.startsWith('SL_')) {
        const feeAwareSLFloor = currentRoundTripFee + 0.8;
        clamped = Math.max(clamped, feeAwareSLFloor);
    }
    return clamped;
}

/** Constrain change to max 15% per cycle */
function constrainChange(current, proposed, paramName) {
    const maxDelta = current * MAX_CHANGE_PER_CYCLE;
    const delta = proposed - current;
    const constrained = current + Math.max(-maxDelta, Math.min(maxDelta, delta));
    return clamp(paramName, constrained);
}

/**
 * Calculate recency-weighted profit factor.
 * Recent trades get exponentially higher weight.
 * @param {Array<{pnl: number, weight: number}>} weightedPnls
 */
function calcWeightedProfitFactor(weightedPnls) {
    let grossWins = 0;
    let grossLosses = 0;
    for (const { pnl, weight } of weightedPnls) {
        if (pnl > 0) grossWins += pnl * weight;
        else if (pnl < 0) grossLosses += Math.abs(pnl) * weight;
    }
    if (grossLosses === 0) return grossWins > 0 ? 10.0 : 1.0;
    return grossWins / grossLosses;
}

/** Calculate simple profit factor from raw PnL values */
function calcProfitFactor(pnls) {
    let grossWins = 0;
    let grossLosses = 0;
    for (const pnl of pnls) {
        if (pnl > 0) grossWins += pnl;
        else if (pnl < 0) grossLosses += Math.abs(pnl);
    }
    if (grossLosses === 0) return grossWins > 0 ? 10.0 : 1.0;
    return grossWins / grossLosses;
}

/** Calculate win rate from a set of PnL values */
function calcWinRate(pnls) {
    if (pnls.length === 0) return 0;
    const wins = pnls.filter(p => p > 0).length;
    return wins / pnls.length;
}

/**
 * Apply time-based recency weights to trades.
 * Uses an ADAPTIVE half-life based on the actual time span of the trade window,
 * so that even the oldest trades retain meaningful weight (~6% at the oldest point).
 * Falls back to index-based weighting if exitTime is missing.
 */
function applyRecencyWeights(trades) {
    const n = trades.length;
    if (n === 0) return [];

    const hasTimestamps = trades.some(t => t.exitTime > 0);

    let rawWeights;
    if (hasTimestamps) {
        // Compute adaptive half-life: span/4 ensures oldest trade retains ~6% weight
        const times = trades.map(t => t.exitTime || 0).filter(t => t > 0);
        const newest = Math.max(...times);
        const oldest = Math.min(...times);
        const span = newest - oldest;

        // Adaptive half-life: 1/4 of trade window span, clamped to [10min, 24hr]
        const adaptiveHalfLife = Math.max(600000, Math.min(86400000, span / 4));
        const lambda = Math.LN2 / adaptiveHalfLife;

        rawWeights = trades.map(t => {
            const age = newest - (t.exitTime || newest); // age relative to newest trade, not now
            return Math.exp(-lambda * age);
        });
    } else {
        // Fallback: index-based
        rawWeights = trades.map((_, i) => Math.exp(0.005 * i));
    }

    const totalWeight = rawWeights.reduce((s, w) => s + w, 0);
    const normFactor = n / totalWeight;
    return trades.map((trade, i) => ({
        ...trade,
        weight: rawWeights[i] * normFactor,
    }));
}

// ============================================
// GROUP A: ENTRY THRESHOLD OPTIMIZATION
// ============================================

/**
 * Simulate entry filtering with different thresholds.
 *
 * For minOpportunityScore / compositeScoreFloor: uses compositeScore directly.
 * For strategy thresholds: uses the actual triggerValue stored at entry time,
 * with correct direction logic per strategy:
 *   - TREND: enters when tcValue < threshold (lower = more bullish)
 *   - MOMENTUM: enters when momValue > threshold (higher = more bullish)
 *   - BREAKOUT: enters when bkout > threshold (higher = more squeeze)
 *   - ADAPTIVE: enters when adpValue < threshold (lower = more bullish)
 *
 * @param {Array} trades - Historical trades (with recency weights applied)
 * @param {string} paramName - Parameter being optimized
 * @param {number} testValue - Value to test
 * @returns {number} fitness score
 */
const MIN_STRATEGY_TRADES = 5; // Need at least 5 trades of a strategy to tune its threshold

/** Map strategy threshold params to their strategy name */
const PARAM_TO_STRATEGY = {
    TREND_BULLISH_ENTRY: 'TREND',
    MOMENTUM_BULLISH_ENTRY: 'MOMENTUM',
    BREAKOUT_SQUEEZE_ENTRY: 'BREAKOUT',
    ADAPTIVE_BULLISH_ENTRY: 'ADAPTIVE',
};

function simulateEntryFilter(trades, paramName, testValue) {
    // For strategy-specific params, require minimum trades of that strategy
    const requiredStrategy = PARAM_TO_STRATEGY[paramName];
    if (requiredStrategy) {
        const stratCount = trades.filter(t => t.strategy === requiredStrategy && (t.triggerValue || 0) > 0).length;
        if (stratCount < MIN_STRATEGY_TRADES) return -1; // signal: not enough data
    }

    const keptEntries = [];

    for (const trade of trades) {
        let kept = true;

        switch (paramName) {
            case 'minOpportunityScore':
            case 'compositeScoreFloor': {
                // Only use trades with real compositeScore data (> 0).
                // Trades with score=0 (profit methods, legacy) lack real signal —
                // using a proxy (50 for win, 15 for loss) creates tautological bias.
                const score = trade.compositeScore || 0;
                if (score <= 0) break; // skip — no real data to optimize from
                if (score < testValue) kept = false;
                break;
            }
            case 'TREND_BULLISH_ENTRY': {
                // TREND: enters when tcValue < threshold (lower = more bullish)
                if (trade.strategy !== 'TREND') break; // only filter TREND trades
                const tv = trade.triggerValue;
                if (tv > 0 && tv >= testValue) kept = false;
                break;
            }
            case 'MOMENTUM_BULLISH_ENTRY': {
                // MOMENTUM: enters when momValue > threshold (higher = more bullish)
                if (trade.strategy !== 'MOMENTUM') break;
                const tv = trade.triggerValue;
                if (tv > 0 && tv <= testValue) kept = false;
                break;
            }
            case 'BREAKOUT_SQUEEZE_ENTRY': {
                // BREAKOUT: enters when bkout > threshold (higher = more squeeze)
                if (trade.strategy !== 'BREAKOUT') break;
                const tv = trade.triggerValue;
                if (tv > 0 && tv <= testValue) kept = false;
                break;
            }
            case 'ADAPTIVE_BULLISH_ENTRY': {
                // ADAPTIVE: enters when adpValue < threshold (lower = more bullish)
                if (trade.strategy !== 'ADAPTIVE') break;
                const tv = trade.triggerValue;
                if (tv > 0 && tv >= testValue) kept = false;
                break;
            }
            default:
                break;
        }

        if (kept) {
            keptEntries.push({ pnl: trade.pnl, weight: trade.weight || 1 });
        }
    }

    if (keptEntries.length < 5) return 0;

    const pf = calcWeightedProfitFactor(keptEntries);
    const retentionRate = keptEntries.length / trades.length;
    return pf * Math.sqrt(retentionRate);
}

/**
 * Get adaptive step sizes based on convergence state.
 * After 2+ no-change cycles, switch to finer grid for precision tuning.
 */
function getStepSizes() {
    if (consecutiveNoChange >= 2) {
        return [0.03, 0.05, 0.07, 0.10]; // Fine grid
    }
    return [0.10, 0.20]; // Coarse grid
}

/**
 * Optimize a single Group A parameter by testing variations
 */
function optimizeEntryParam(trades, paramName) {
    const current = currentParams[paramName];
    const steps = getStepSizes();
    const candidates = [];
    for (const step of steps) {
        candidates.push(current * (1 - step));
        candidates.push(current * (1 + step));
    }

    const currentFitness = simulateEntryFilter(trades, paramName, current);

    // -1 means not enough strategy-specific trades to optimize
    if (currentFitness < 0) return current;

    let bestValue = current;
    let bestFitness = currentFitness;

    for (const candidate of candidates) {
        const clamped = clamp(paramName, candidate);
        const fitness = simulateEntryFilter(trades, paramName, clamped);
        if (fitness > bestFitness) {
            bestFitness = fitness;
            bestValue = clamped;
        }
    }

    // Require minimum improvement to justify changing
    if (currentFitness > 0 && (bestFitness - currentFitness) / currentFitness < MIN_FITNESS_IMPROVEMENT) {
        return current; // improvement too small, keep current
    }

    return constrainChange(current, bestValue, paramName);
}

// ============================================
// GROUP B: TP/SL TARGET OPTIMIZATION
// ============================================

/**
 * Simulate TP/SL targets on historical trades with recency weighting.
 * For each trade with price path data, check if a different TP/SL
 * would have captured more profit or cut losses earlier.
 *
 * Uses both highestPrice and lowestPrice to determine which trigger
 * fires first. Without lowestPrice, falls back to optimistic assumption.
 */
function simulateTargets(trades, regime, testTp, testSl) {
    const regimeTrades = trades.filter(t => (t.regime || 'NORMAL') === regime);
    if (regimeTrades.length < 3) return 0;

    const simulatedEntries = [];

    for (const trade of regimeTrades) {
        const entry = trade.entryPrice;
        const highest = trade.highestPrice || trade.exitPrice;
        const lowest = trade.lowestPrice || trade.exitPrice;
        const exit = trade.exitPrice;
        if (!entry || entry <= 0) continue;

        const peakPnlPct = ((highest - entry) / entry) * 100;
        const dipPnlPct = ((lowest - entry) / entry) * 100; // negative if dipped below entry
        const actualPnlPct = ((exit - entry) / entry) * 100;
        let simPnl;

        const wouldHitTp = peakPnlPct >= testTp;
        const wouldHitSl = dipPnlPct <= -testSl;

        if (wouldHitSl && wouldHitTp) {
            // Both would trigger — determine order from actual outcome
            // If trade ended in loss, SL likely hit first; if profit, TP likely hit first
            simPnl = actualPnlPct > 0 ? (testTp - currentRoundTripFee) : -testSl;
        } else if (wouldHitTp) {
            simPnl = testTp - currentRoundTripFee; // TP hit minus actual exchange fees
        } else if (wouldHitSl) {
            simPnl = -testSl; // SL hit
        } else {
            simPnl = actualPnlPct; // Neither hit
        }

        simulatedEntries.push({ pnl: simPnl, weight: trade.weight || 1 });
    }

    if (simulatedEntries.length < 3) return 0;
    return calcWeightedProfitFactor(simulatedEntries);
}

/**
 * Optimize TP/SL for a single regime
 */
function optimizeRegimeTargets(trades, regime) {
    const tpKey = `TP_${regime}`;
    const slKey = `SL_${regime}`;
    const currentTp = currentParams[tpKey];
    const currentSl = currentParams[slKey];

    const steps = getStepSizes();
    const tpCandidates = [currentTp];
    const slCandidates = [currentSl];
    for (const step of steps) {
        tpCandidates.push(currentTp * (1 - step));
        tpCandidates.push(currentTp * (1 + step));
        slCandidates.push(currentSl * (1 - step));
        slCandidates.push(currentSl * (1 + step));
    }

    const currentFitness = simulateTargets(trades, regime, currentTp, currentSl);
    let bestTp = currentTp;
    let bestSl = currentSl;
    let bestFitness = currentFitness;

    // Grid search TP x SL combinations
    for (const tp of tpCandidates) {
        for (const sl of slCandidates) {
            const clampedTp = clamp(tpKey, tp);
            const clampedSl = clamp(slKey, sl);
            const fitness = simulateTargets(trades, regime, clampedTp, clampedSl);
            if (fitness > bestFitness) {
                bestFitness = fitness;
                bestTp = clampedTp;
                bestSl = clampedSl;
            }
        }
    }

    // Require minimum improvement to justify changing
    if (currentFitness > 0 && (bestFitness - currentFitness) / currentFitness < MIN_FITNESS_IMPROVEMENT) {
        return { tp: currentTp, sl: currentSl }; // improvement too small
    }

    return {
        tp: constrainChange(currentTp, bestTp, tpKey),
        sl: constrainChange(currentSl, bestSl, slKey),
    };
}

// ============================================
// MAIN OPTIMIZATION
// ============================================

/**
 * Run optimization on trade history
 * @param {Array} tradeHistory - Array of completed trades
 * @returns {{ changed: boolean, changedParams: string[], targets: object|null }}
 */
function runOptimization(tradeHistory) {
    if (!Array.isArray(tradeHistory) || tradeHistory.length < MIN_TRADES_REQUIRED) {
        return { changed: false, changedParams: [], reason: `Need ${MIN_TRADES_REQUIRED} trades, have ${tradeHistory?.length || 0}` };
    }

    const rawTrades = tradeHistory.slice(-ROLLING_WINDOW);
    const beforePF = calcProfitFactor(rawTrades.map(t => t.pnl || 0));
    const beforeWR = calcWinRate(rawTrades.map(t => t.pnl || 0));

    // Train/test split: optimize on first 70%, validate on last 30%
    const splitIdx = Math.floor(rawTrades.length * TRAIN_SPLIT);
    const trainTrades = applyRecencyWeights(rawTrades.slice(0, splitIdx));
    const testTrades = applyRecencyWeights(rawTrades.slice(splitIdx));

    // Save snapshot for rollback
    preOptSnapshot = {
        params: { ...currentParams },
        profitFactor: beforePF,
        tradeCount: tradeHistory.length,
        timestamp: Date.now(),
    };

    const changedParams = [];
    const rejectedParams = []; // validated on train but failed on test

    // --- Group A: Entry Thresholds ---
    const entryParams = ['minOpportunityScore', 'compositeScoreFloor', 'TREND_BULLISH_ENTRY',
        'MOMENTUM_BULLISH_ENTRY', 'BREAKOUT_SQUEEZE_ENTRY', 'ADAPTIVE_BULLISH_ENTRY'];

    for (const param of entryParams) {
        const oldValue = currentParams[param];
        const proposedValue = optimizeEntryParam(trainTrades, param);
        if (Math.abs(proposedValue - oldValue) < 0.01) continue;

        // Validate: proposed must also improve on the test set
        const testFitnessCurrent = simulateEntryFilter(testTrades, param, oldValue);
        const testFitnessProposed = simulateEntryFilter(testTrades, param, proposedValue);

        if (testFitnessProposed > testFitnessCurrent) {
            currentParams[param] = proposedValue;
            changedParams.push(`${param}: ${oldValue.toFixed(2)} → ${proposedValue.toFixed(2)}`);
        } else {
            rejectedParams.push(param);
        }
    }

    // --- Group B: TP/SL Targets ---
    const regimes = ['HIGH_VOL', 'NORMAL', 'LOW_VOL'];
    for (const regime of regimes) {
        const tpKey = `TP_${regime}`;
        const slKey = `SL_${regime}`;
        const oldTp = currentParams[tpKey];
        const oldSl = currentParams[slKey];

        const { tp, sl } = optimizeRegimeTargets(trainTrades, regime);

        // Validate TP/SL together on test set
        const testFitnessCurrent = simulateTargets(testTrades, regime, oldTp, oldSl);
        const testFitnessProposed = simulateTargets(testTrades, regime, tp, sl);

        const tpChanged = Math.abs(tp - oldTp) > 0.01;
        const slChanged = Math.abs(sl - oldSl) > 0.01;

        if ((tpChanged || slChanged) && testFitnessProposed > testFitnessCurrent) {
            // TP/SL ratio guard: don't allow TP < SL (negative EV at 50% WR)
            if (tp < sl * 0.8) {
                rejectedParams.push(`${regime}_TARGETS (TP/SL ratio too low: ${(tp/sl).toFixed(2)})`);
            } else {
                if (tpChanged) {
                    currentParams[tpKey] = tp;
                    changedParams.push(`${tpKey}: ${oldTp.toFixed(3)} → ${tp.toFixed(3)}`);
                }
                if (slChanged) {
                    currentParams[slKey] = sl;
                    changedParams.push(`${slKey}: ${oldSl.toFixed(3)} → ${sl.toFixed(3)}`);
                }
            }
        } else if (tpChanged || slChanged) {
            rejectedParams.push(`${regime}_TARGETS`);
        }
    }

    const changed = changedParams.length > 0;

    // Track convergence for adaptive step sizing
    if (changed) {
        consecutiveNoChange = 0;
    } else {
        consecutiveNoChange++;
    }

    // Record history + reset post-opt counters
    totalOptimizations++;
    lastOptimizationTime = Date.now();
    tradeCountAtLastOpt = tradeHistory.length;
    postOptTradeCount = 0;
    postOptPnlSum = 0;
    postOptWins = 0;
    postOptLosses = 0;
    postOptGrossWins = 0;
    postOptGrossLosses = 0;

    if (changed || rejectedParams.length > 0) {
        optimizationHistory.push({
            timestamp: Date.now(),
            changedParams,
            rejectedParams,
            profitFactorBefore: beforePF,
            winRateBefore: beforeWR,
            tradeCount: rawTrades.length,
            trainSize: trainTrades.length,
            testSize: testTrades.length,
        });
        if (optimizationHistory.length > 20) {
            optimizationHistory = optimizationHistory.slice(-20);
        }
    }

    return {
        changed,
        changedParams,
        rejectedParams,
        targets: changed ? buildTargetOverrides() : null,
        profitFactorBefore: parseFloat(beforePF.toFixed(3)),
        winRateBefore: parseFloat((beforeWR * 100).toFixed(1)),
        tradeCount: rawTrades.length,
        trainSize: trainTrades.length,
        testSize: testTrades.length,
    };
}

/** Build the target overrides object for beastMode.setTargetOverrides() */
function buildTargetOverrides() {
    return {
        HIGH_VOL: { tp: currentParams.TP_HIGH_VOL, sl: currentParams.SL_HIGH_VOL },
        NORMAL:   { tp: currentParams.TP_NORMAL,   sl: currentParams.SL_NORMAL },
        LOW_VOL:  { tp: currentParams.TP_LOW_VOL,  sl: currentParams.SL_LOW_VOL },
    };
}

/**
 * Set the actual round-trip fee for accurate TP/SL simulation.
 * Called when exchange changes (e.g., Kraken 0.32% vs Crypto.com 0.15%).
 */
export function setFeeForSimulation(roundTripFee) {
    if (typeof roundTripFee === 'number' && roundTripFee > 0) {
        currentRoundTripFee = roundTripFee;
    }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Called from handleSell. Decides whether to run based on trade count.
 * Runs at 30 trades (first eligible), then every 50 thereafter.
 * @param {Array} tradeHistory
 */
export function triggerOptimization(tradeHistory) {
    if (!Array.isArray(tradeHistory)) return { changed: false, changedParams: [] };
    const count = tradeHistory.length;

    // First run at 30, then every 50 trades from last opt
    const shouldRun = (tradeCountAtLastOpt === 0 && count >= MIN_TRADES_REQUIRED) ||
                      (tradeCountAtLastOpt > 0 && count - tradeCountAtLastOpt >= 50);

    if (!shouldRun) return { changed: false, changedParams: [], reason: `Next opt at ${tradeCountAtLastOpt > 0 ? tradeCountAtLastOpt + 50 : MIN_TRADES_REQUIRED} trades (have ${count})` };

    return runOptimization(tradeHistory);
}

/**
 * Get current optimized entry parameters (Group A)
 */
export function getOptimizedEntryParams() {
    return {
        minOpportunityScore: currentParams.minOpportunityScore,
        compositeScoreFloor: currentParams.compositeScoreFloor,
        TREND_BULLISH_ENTRY: currentParams.TREND_BULLISH_ENTRY,
        MOMENTUM_BULLISH_ENTRY: currentParams.MOMENTUM_BULLISH_ENTRY,
        BREAKOUT_SQUEEZE_ENTRY: currentParams.BREAKOUT_SQUEEZE_ENTRY,
        ADAPTIVE_BULLISH_ENTRY: currentParams.ADAPTIVE_BULLISH_ENTRY,
    };
}

/**
 * Get current optimized TP/SL targets for a given regime (Group B)
 * @param {string} [regime] - optional specific regime
 * @returns {object|null}
 */
export function getOptimizedTargets(regime) {
    const overrides = buildTargetOverrides();
    if (regime) return overrides[regime] || null;
    return overrides;
}

/**
 * Get optimizer status for API endpoint.
 * Accepts optional tradeHistory for live performance metrics.
 * @param {Array} [tradeHistory] - Current trade log for live stats
 */
export function getOptimizerStatus(tradeHistory) {
    const paramDetails = {};
    for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
        const current = currentParams[key];
        const devPct = ((current - bounds.default) / bounds.default * 100);
        paramDetails[key] = {
            current: parseFloat(current.toFixed(4)),
            default: bounds.default,
            min: bounds.min,
            max: bounds.max,
            deviation: (devPct >= 0 ? '+' : '') + devPct.toFixed(1) + '%',
        };
    }

    // Live performance: rolling window stats from current trade history
    let livePerformance = null;
    if (Array.isArray(tradeHistory) && tradeHistory.length > 0) {
        const recent = tradeHistory.slice(-ROLLING_WINDOW);
        const pnls = recent.map(t => t.pnl || 0);
        const wins = pnls.filter(p => p > 0).length;
        const losses = pnls.filter(p => p < 0).length;
        const totalPnl = pnls.reduce((s, p) => s + p, 0);
        const avgWin = wins > 0 ? pnls.filter(p => p > 0).reduce((s, p) => s + p, 0) / wins : 0;
        const avgLoss = losses > 0 ? pnls.filter(p => p < 0).reduce((s, p) => s + p, 0) / losses : 0;

        // Strategy breakdown
        const byStrategy = {};
        for (const t of recent) {
            const strat = t.strategy || 'UNKNOWN';
            if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0, pnl: 0 };
            if ((t.pnl || 0) > 0) byStrategy[strat].wins++;
            else if ((t.pnl || 0) < 0) byStrategy[strat].losses++;
            byStrategy[strat].pnl += (t.pnl || 0);
        }

        // Regime breakdown
        const byRegime = {};
        for (const t of recent) {
            const regime = t.regime || 'NORMAL';
            if (!byRegime[regime]) byRegime[regime] = { wins: 0, losses: 0, pnl: 0 };
            if ((t.pnl || 0) > 0) byRegime[regime].wins++;
            else if ((t.pnl || 0) < 0) byRegime[regime].losses++;
            byRegime[regime].pnl += (t.pnl || 0);
        }

        livePerformance = {
            totalTrades: recent.length,
            wins,
            losses,
            winRate: parseFloat((wins / recent.length * 100).toFixed(1)),
            profitFactor: parseFloat(calcProfitFactor(pnls).toFixed(3)),
            totalPnl: parseFloat(totalPnl.toFixed(4)),
            avgWin: parseFloat(avgWin.toFixed(4)),
            avgLoss: parseFloat(avgLoss.toFixed(4)),
            byStrategy,
            byRegime,
        };
    }

    return {
        totalOptimizations,
        lastOptimizationTime: lastOptimizationTime ? new Date(lastOptimizationTime).toISOString() : null,
        tradeCountAtLastOpt,
        nextOptAt: tradeCountAtLastOpt > 0 ? tradeCountAtLastOpt + 50 : MIN_TRADES_REQUIRED,
        minTradesRequired: MIN_TRADES_REQUIRED,
        maxChangePerCycle: MAX_CHANGE_PER_CYCLE * 100 + '%',
        rollingWindow: ROLLING_WINDOW,
        trainTestSplit: `${Math.round(TRAIN_SPLIT * 100)}/${Math.round((1 - TRAIN_SPLIT) * 100)}`,
        minFitnessImprovement: MIN_FITNESS_IMPROVEMENT * 100 + '%',
        searchMode: consecutiveNoChange >= 2 ? 'FINE (±3-10%)' : 'COARSE (±10-20%)',
        consecutiveNoChange,
        parameters: paramDetails,
        targetOverrides: buildTargetOverrides(),
        livePerformance,
        postOptTracking: preOptSnapshot ? {
            tradesSinceOpt: postOptTradeCount,
            evalAt: ROLLBACK_EVAL_TRADES,
            pnlSinceOpt: parseFloat(postOptPnlSum.toFixed(4)),
            winsSinceOpt: postOptWins,
            lossesSinceOpt: postOptLosses,
            winRate: postOptTradeCount > 0 ? parseFloat((postOptWins / postOptTradeCount * 100).toFixed(1)) : null,
            profitFactor: postOptGrossLosses > 0 ? parseFloat((postOptGrossWins / postOptGrossLosses).toFixed(3)) : (postOptGrossWins > 0 ? 10.0 : null),
        } : null,
        recentHistory: optimizationHistory.slice(-5),
    };
}

/**
 * Manual trigger via API (bypasses trade count gating)
 * @param {Array} tradeHistory
 */
export function forceOptimize(tradeHistory) {
    return runOptimization(tradeHistory);
}

/**
 * Record a post-optimization trade result for rollback evaluation.
 * Called from handleSell after each trade.
 * @param {number} pnl - trade PnL
 * @returns {{ rolledBack: boolean, reason?: string }}
 */
export function recordPostOptTrade(pnl) {
    if (!preOptSnapshot) return { rolledBack: false };

    postOptTradeCount++;
    postOptPnlSum += pnl;
    if (pnl > 0) { postOptWins++; postOptGrossWins += pnl; }
    else if (pnl < 0) { postOptLosses++; postOptGrossLosses += Math.abs(pnl); }

    // Evaluate after enough post-opt trades
    if (postOptTradeCount >= ROLLBACK_EVAL_TRADES) {
        const postWR = postOptWins / postOptTradeCount;
        const postPF = postOptGrossLosses > 0 ? postOptGrossWins / postOptGrossLosses : (postOptGrossWins > 0 ? 10.0 : 1.0);

        // Rollback if post-opt performance is significantly worse
        // Net PnL negative AND win rate below 25%
        if (postOptPnlSum < 0 && postWR < 0.25 && preOptSnapshot.profitFactor > 0.5) {
            // Capture values before reset for logging
            const rollbackPnl = postOptPnlSum;
            const rollbackWR = postWR;
            const rollbackCount = postOptTradeCount;

            // Restore pre-opt params
            const rolledBackParams = [];
            for (const [key, value] of Object.entries(preOptSnapshot.params)) {
                if (PARAM_BOUNDS[key] && Math.abs(currentParams[key] - value) > 0.01) {
                    rolledBackParams.push(key);
                    currentParams[key] = value;
                }
            }

            if (rolledBackParams.length > 0) {
                optimizationHistory.push({
                    timestamp: Date.now(),
                    changedParams: [`ROLLBACK: ${rolledBackParams.join(', ')}`],
                    profitFactorBefore: preOptSnapshot.profitFactor,
                    postOptPF: postPF,
                    postOptWinRate: rollbackWR,
                    postOptPnl: rollbackPnl,
                    tradeCount: rollbackCount,
                });

                // Reset tracking
                preOptSnapshot = null;
                postOptTradeCount = 0;
                postOptPnlSum = 0;
                postOptWins = 0;
                postOptLosses = 0;
                postOptGrossWins = 0;
                postOptGrossLosses = 0;

                return {
                    rolledBack: true,
                    reason: `Post-opt performance degraded (WR: ${(rollbackWR*100).toFixed(0)}%, PnL: ${rollbackPnl.toFixed(2)}, PF: ${postPF.toFixed(2)}). Reverted ${rolledBackParams.length} params.`,
                    targets: buildTargetOverrides(),
                };
            }
        }

        // Performance is acceptable — clear snapshot, stop tracking
        preOptSnapshot = null;
        postOptTradeCount = 0;
        postOptPnlSum = 0;
        postOptWins = 0;
        postOptLosses = 0;
        postOptGrossWins = 0;
        postOptGrossLosses = 0;
    }

    return { rolledBack: false };
}

/**
 * Reset all parameters to defaults. Available via API.
 * @returns {{ reset: boolean, previousParams: object }}
 */
export function resetToDefaults() {
    const previous = { ...currentParams };
    for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
        currentParams[key] = bounds.default;
    }
    preOptSnapshot = null;
    postOptTradeCount = 0;
    postOptPnlSum = 0;
    postOptWins = 0;
    postOptLosses = 0;
    postOptGrossWins = 0;
    postOptGrossLosses = 0;
    consecutiveNoChange = 0;

    optimizationHistory.push({
        timestamp: Date.now(),
        changedParams: ['MANUAL RESET to defaults'],
        tradeCount: 0,
    });

    return { reset: true, previousParams: previous, targets: buildTargetOverrides() };
}

/**
 * Export state for session persistence
 */
export function exportState() {
    return {
        currentParams: { ...currentParams },
        optimizationHistory: optimizationHistory.slice(-10),
        totalOptimizations,
        lastOptimizationTime,
        tradeCountAtLastOpt,
        consecutiveNoChange,
        preOptSnapshot,
        postOptTradeCount,
        postOptPnlSum,
        postOptWins,
        postOptLosses,
        postOptGrossWins,
        postOptGrossLosses,
    };
}

/**
 * Import state from session restore
 */
export function importState(state) {
    if (!state) return;
    if (state.currentParams) {
        for (const [key, value] of Object.entries(state.currentParams)) {
            if (PARAM_BOUNDS[key]) {
                currentParams[key] = clamp(key, value);
            }
        }
    }
    if (Array.isArray(state.optimizationHistory)) {
        optimizationHistory = state.optimizationHistory;
    }
    totalOptimizations = state.totalOptimizations || 0;
    lastOptimizationTime = state.lastOptimizationTime || 0;
    tradeCountAtLastOpt = state.tradeCountAtLastOpt || 0;
    consecutiveNoChange = state.consecutiveNoChange || 0;
    preOptSnapshot = state.preOptSnapshot || null;
    postOptTradeCount = state.postOptTradeCount || 0;
    postOptPnlSum = state.postOptPnlSum || 0;
    postOptWins = state.postOptWins || 0;
    postOptLosses = state.postOptLosses || 0;
    postOptGrossWins = state.postOptGrossWins || 0;
    postOptGrossLosses = state.postOptGrossLosses || 0;
}
