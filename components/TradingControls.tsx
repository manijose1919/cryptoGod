
import React, { useState, useEffect, useCallback } from 'react';
import type { TradingStrategy, CoreTradingStrategy, SystemEvent, TradingMode } from '../types';
import { CORE_TRADING_STRATEGIES } from '../types';
import { STRATEGY_INFO, MICRO_TRADING } from '../constants';
import { SettingsPanel } from './SettingsPanel';

/**
 * Auto-optimize trading parameters based on budget and session goal
 */
interface OptimizedSettings {
  profitGoals: Record<CoreTradingStrategy, number>;
  maxConcurrentTrades: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  riskAmount: number;
}

function calculateOptimalSettings(budget: number, sessionGoal: number, userRiskAmount: number): OptimizedSettings {
  // Calculate goal as percentage of budget
  const goalPercent = (sessionGoal / budget) * 100;

  // Determine risk profile: conservative (<20%), moderate (20-50%), aggressive (>50%)
  const isConservative = goalPercent < 20;
  const isAggressive = goalPercent > 50;

  // Max Concurrent Trades: Based on budget size and risk profile
  // Larger budgets can handle more positions, aggressive goals need more trades
  let maxTrades = Math.floor(budget / 2000); // 1 trade per $2000
  if (isAggressive) maxTrades = Math.ceil(maxTrades * 1.5);
  if (isConservative) maxTrades = Math.floor(maxTrades * 0.75);
  maxTrades = Math.max(2, Math.min(10, maxTrades)); // Clamp between 2-10

  // Risk Amount: Use the user's selected risk amount (25%, 50%, 75%, or 100%)
  // This allows optimization to work with any risk level the user has chosen
  const riskAmount = userRiskAmount;

  // Stop Loss %: Balance between giving trades room and protecting capital
  // Conservative: tighter stops (2-2.5%), Aggressive: wider stops (4-5%)
  let stopLoss: number;
  if (isConservative) {
    stopLoss = 2 + (goalPercent / 20); // 2-3%
  } else if (isAggressive) {
    stopLoss = 3.5 + Math.min(1.5, (goalPercent - 50) / 50); // 3.5-5%
  } else {
    stopLoss = 2.5 + (goalPercent - 20) / 30; // 2.5-3.5%
  }
  stopLoss = Math.round(stopLoss * 10) / 10; // Round to 1 decimal

  // Trailing Stop %: Lock in profits, usually 50-70% of stop loss
  const trailingStopRatio = isAggressive ? 0.5 : isConservative ? 0.7 : 0.6;
  const trailingStop = Math.round(stopLoss * trailingStopRatio * 10) / 10;

  // Profit Goal per Trade per Strategy:
  // Calculate based on reaching session goal with expected number of trades
  // Assume ~55-65% win rate, need profit > losses
  const expectedWinRate = isConservative ? 0.6 : isAggressive ? 0.55 : 0.58;
  const tradeCycles = isAggressive ? 2 : isConservative ? 4 : 3; // How many full rotations of trades
  const totalExpectedTrades = maxTrades * tradeCycles;
  const expectedWins = totalExpectedTrades * expectedWinRate;
  const expectedLosses = totalExpectedTrades * (1 - expectedWinRate);

  // Account for losses in profit calculation
  // Total profit needed = sessionGoal + (expected loss amount)
  const avgLossPerTrade = (budget / maxTrades) * riskAmount * (stopLoss / 100);
  const expectedTotalLoss = expectedLosses * avgLossPerTrade;
  const targetTotalProfit = sessionGoal + expectedTotalLoss;

  // Base profit goal per winning trade
  const baseProfitGoal = Math.round(targetTotalProfit / expectedWins);

  // Adjust profit goals by strategy risk level
  const strategyMultipliers: Record<CoreTradingStrategy, number> = {
    TREND: 1.0,       // Medium risk, standard goal
    BREAKOUT: 1.3,    // High risk, higher reward target
    WHALE: 1.1,       // Medium risk, slightly higher
    CONFLUENCE: 0.8,  // Low risk, more frequent smaller wins
    MOMENTUM: 1.25,   // High risk, higher reward
    DIVERGENCE: 1.0,  // Medium risk, standard goal
    ADAPTIVE: 1.05,   // Medium risk, asset-tuned signals
  };

  const profitGoals: Record<CoreTradingStrategy, number> = {
    TREND: Math.round(baseProfitGoal * strategyMultipliers.TREND),
    BREAKOUT: Math.round(baseProfitGoal * strategyMultipliers.BREAKOUT),
    WHALE: Math.round(baseProfitGoal * strategyMultipliers.WHALE),
    CONFLUENCE: Math.round(baseProfitGoal * strategyMultipliers.CONFLUENCE),
    MOMENTUM: Math.round(baseProfitGoal * strategyMultipliers.MOMENTUM),
    DIVERGENCE: Math.round(baseProfitGoal * strategyMultipliers.DIVERGENCE),
    ADAPTIVE: Math.round(baseProfitGoal * strategyMultipliers.ADAPTIVE),
  };

  // Ensure minimum profit goals
  const minProfitGoal = Math.max(10, budget * 0.005); // At least $10 or 0.5% of budget
  for (const key of CORE_TRADING_STRATEGIES) {
    profitGoals[key] = Math.max(minProfitGoal, profitGoals[key]);
  }

  return {
    profitGoals,
    maxConcurrentTrades: maxTrades,
    stopLossPercent: stopLoss,
    trailingStopPercent: trailingStop,
    riskAmount,
  };
}

interface TradingControlsProps {
  onStart: (initialBudget: number, ticker: string) => void;
  activeTicker: string;
  isTradingActive: boolean;
  strategy: TradingStrategy;
  setStrategy: (strategy: TradingStrategy) => void;
  isBotActive: boolean;
  toggleBot: (isActive: boolean) => void;
  addLog: (message: string, type?: SystemEvent['type']) => void;
  isScannerActive: boolean;
  setIsScannerActive: (isActive: boolean) => void;
  riskAmount: number;
  setRiskAmount: (risk: number) => void;
  tradingMode: TradingMode;
  setTradingMode: (mode: TradingMode) => void;
  isApiAuthenticated: boolean;
  profitGoals: Record<TradingStrategy, number>;
  setProfitGoals: (strategy: TradingStrategy, value: number) => void;
  sessionProfitGoal: number;
  setSessionProfitGoal: (goal: number) => void;
  maxConcurrentTrades: number;
  setMaxConcurrentTrades: (max: number) => void;
  stopLossPercent: number;
  setStopLossPercent: (percent: number) => void;
  trailingStopPercent: number;
  setTrailingStopPercent: (percent: number) => void;
  useTrailingStop: boolean;
  setUseTrailingStop: (use: boolean) => void;
  // New props for micro-trading and pair selection
  availableTickers?: string[];
  microTradingEnabled?: boolean;
  setMicroTradingEnabled?: (enabled: boolean) => void;
  unlimitedTrades?: boolean;
  setUnlimitedTrades?: (unlimited: boolean) => void;
  // Session duration
  sessionDurationMinutes?: number;
  setSessionDurationMinutes?: (minutes: number) => void;
  // Close all positions
  onCloseAll?: () => void;
  // Stop session entirely
  onStopSession?: () => Promise<void>;
}

export const TradingControls: React.FC<TradingControlsProps> = ({
  onStart, activeTicker, isTradingActive, strategy, setStrategy,
  isBotActive, toggleBot, addLog, isScannerActive, setIsScannerActive,
  riskAmount, setRiskAmount, tradingMode, setTradingMode, isApiAuthenticated,
  profitGoals, setProfitGoals, sessionProfitGoal, setSessionProfitGoal,
  maxConcurrentTrades, setMaxConcurrentTrades,
  stopLossPercent, setStopLossPercent, trailingStopPercent, setTrailingStopPercent,
  useTrailingStop, setUseTrailingStop,
  availableTickers = [],
  microTradingEnabled = false, setMicroTradingEnabled,
  unlimitedTrades = false, setUnlimitedTrades,
  sessionDurationMinutes = 0, setSessionDurationMinutes,
  onCloseAll,
  onStopSession
}) => {
  const [tickerInput, setTickerInput] = useState(activeTicker);
  const [budgetInput, setBudgetInput] = useState('10000');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isAutoOptimized, setIsAutoOptimized] = useState(false);
  const [closeAllConfirm, setCloseAllConfirm] = useState(false);
  const [stopSessionConfirm, setStopSessionConfirm] = useState(false);
  const [isStoppingSession, setIsStoppingSession] = useState(false);
  const [isClosingAll, setIsClosingAll] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Auto-optimize handler
  const handleAutoOptimize = useCallback(() => {
    const budget = parseFloat(budgetInput);
    if (isNaN(budget) || budget <= 0) {
      addLog('Cannot auto-optimize: Invalid budget', 'ERROR');
      return;
    }
    if (sessionProfitGoal <= 0) {
      addLog('Cannot auto-optimize: Set a session goal first', 'ERROR');
      return;
    }

    // Pass current riskAmount to optimize around user's chosen risk level
    const optimized = calculateOptimalSettings(budget, sessionProfitGoal, riskAmount);

    // Apply all optimized settings (but NOT riskAmount - respect user's selection)
    setMaxConcurrentTrades(optimized.maxConcurrentTrades);
    setStopLossPercent(optimized.stopLossPercent);
    setTrailingStopPercent(optimized.trailingStopPercent);
    // Note: riskAmount is NOT overridden - user's selection is preserved
    setUseTrailingStop(true);

    // Apply profit goals for all strategies
    for (const strat of CORE_TRADING_STRATEGIES) {
      setProfitGoals(strat, optimized.profitGoals[strat]);
    }

    setIsAutoOptimized(true);
    setShowAdvanced(true); // Show advanced settings so user can see the changes

    const goalPercent = ((sessionProfitGoal / budget) * 100).toFixed(1);
    const riskProfile = parseFloat(goalPercent) < 20 ? 'Conservative' :
                        parseFloat(goalPercent) > 50 ? 'Aggressive' : 'Moderate';

    addLog(
      `Auto-optimized for ${riskProfile} profile (${goalPercent}% target): ` +
      `Max ${optimized.maxConcurrentTrades} trades, ${optimized.stopLossPercent}% SL, ` +
      `${optimized.trailingStopPercent}% TS (using your ${(riskAmount * 100).toFixed(0)}% risk setting)`,
      'SPECIAL'
    );
  }, [budgetInput, sessionProfitGoal, riskAmount, addLog, setMaxConcurrentTrades, setStopLossPercent,
      setTrailingStopPercent, setUseTrailingStop, setProfitGoals]);

  // Reset auto-optimized flag when user manually changes settings
  useEffect(() => {
    setIsAutoOptimized(false);
  }, [stopLossPercent, trailingStopPercent, maxConcurrentTrades]);

  useEffect(() => {
    setTickerInput(isScannerActive ? activeTicker : tickerInput);
  }, [activeTicker, isScannerActive, tickerInput]);

  const handleStart = () => {
    const budget = parseFloat(budgetInput);
    if (tradingMode === 'SIMULATION' && tickerInput && !isNaN(budget) && budget > 0) {
      onStart(budget, tickerInput);
    } else if (tradingMode === 'REAL') {
      onStart(0, tickerInput);
    }
  };

  const toggleScanner = (isActive: boolean) => {
    setIsScannerActive(isActive);
    addLog(`Market scanner ${isActive ? 'activated' : 'deactivated'}.`);
  };

  const strategies: TradingStrategy[] = ['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'];

  const StrategyButton: React.FC<{ value: TradingStrategy }> = ({ value }) => {
    const info = STRATEGY_INFO[value];
    const riskColor = info.riskLevel === 'HIGH' ? 'border-red-500/50' :
                      info.riskLevel === 'MEDIUM' ? 'border-yellow-500/50' : 'border-green-500/50';

    return (
      <button
        onClick={() => setStrategy(value)}
        className={`w-full text-center px-2 py-2 text-xs font-medium rounded-md transition-colors border ${
          strategy === value
            ? 'bg-cyan-600 text-white border-cyan-400'
            : `bg-gray-700 text-gray-300 hover:bg-gray-600 ${riskColor}`
        }`}
        title={info.description}
      >
        {info.name.split(' ')[0]}
      </button>
    );
  };

  const RiskButton: React.FC<{ value: number; label: string }> = ({ value, label }) => (
    <button
      onClick={() => setRiskAmount(value)}
      className={`w-full text-center px-2 py-2 text-xs font-medium rounded-md transition-colors ${
        riskAmount === value
          ? 'bg-violet-600 text-white'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      }`}
    >
      {label}
    </button>
  );

  const startButtonText = isTradingActive
    ? 'Reset Session'
    : tradingMode === 'REAL'
      ? (isApiAuthenticated ? 'Start Real Trading' : 'Connect to Exchange')
      : 'Start Simulation';

  return (
    <div className="glass-card p-6 animate-fade-up">
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold gradient-header">Trading Panel</h2>
        <button onClick={() => setSettingsOpen(true)} className="text-gray-400 hover:text-cyan-300 transition" title="Settings">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      <div className="space-y-4">
        {/* Trading Mode Switch */}
        <div className="flex items-center justify-center p-1 bg-gray-900 rounded-lg">
          <button
            onClick={() => setTradingMode('SIMULATION')}
            disabled={isTradingActive}
            className={`w-1/2 py-2 text-sm font-bold rounded-md transition ${
              tradingMode === 'SIMULATION' ? 'bg-cyan-600 text-white' : 'text-gray-400'
            } disabled:opacity-50`}
          >
            Simulation
          </button>
          <button
            onClick={() => setTradingMode('REAL')}
            disabled={isTradingActive}
            className={`w-1/2 py-2 text-sm font-bold rounded-md transition ${
              tradingMode === 'REAL' ? 'bg-red-600 text-white' : 'text-gray-400'
            } disabled:opacity-50`}
          >
            Real Trading
          </button>
        </div>

        {tradingMode === 'SIMULATION' ? (
          <>
            <div>
              <label htmlFor="ticker" className="block text-sm font-medium text-gray-400">
                Trading Pair
              </label>
              {availableTickers.length > 0 ? (
                <select
                  id="ticker"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value)}
                  className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500 disabled:bg-gray-700"
                  disabled={isScannerActive || isTradingActive}
                >
                  {availableTickers.map((pair) => (
                    <option key={pair} value={pair}>
                      {pair}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  id="ticker"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
                  placeholder="e.g., BTCUSDC"
                  className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500 disabled:bg-gray-700"
                  disabled={isScannerActive || isTradingActive}
                />
              )}
            </div>
            <div>
              <label htmlFor="budget" className="block text-sm font-medium text-gray-400">
                Budget (USD)
              </label>
              <input
                type="number"
                id="budget"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="Any amount (e.g., 1, 10, 100)"
                className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500"
                disabled={isTradingActive}
              />
              <p className="text-xs text-gray-500 mt-1">Min: $0.01 - No maximum limit</p>
            </div>
          </>
        ) : (
          <div className="text-center p-2 bg-red-900/50 rounded-lg border border-red-500/50">
            <p className="text-sm text-yellow-300 font-semibold">Real Trading Mode Selected</p>
            <p className="text-xs text-red-200">A secure backend is required to connect to your account.</p>
          </div>
        )}

        <button
          onClick={handleStart}
          className={`w-full text-white font-bold py-2 px-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 transition-colors ${
            isTradingActive
              ? 'bg-gray-600 hover:bg-gray-500 focus:ring-gray-400'
              : tradingMode === 'REAL'
                ? 'bg-red-600 hover:bg-red-500 focus:ring-red-400'
                : 'bg-cyan-600 hover:bg-cyan-500 focus:ring-cyan-500'
          }`}
        >
          {startButtonText}
        </button>

        {isTradingActive && (
          <div className="space-y-4 pt-4 border-t border-gray-700">
            {/* Strategy Selection - 6 strategies now */}
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Scanner/Chart Strategy
              </label>
              <div className="grid grid-cols-3 gap-2">
                {strategies.map(s => (
                  <StrategyButton key={s} value={s} />
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">{STRATEGY_INFO[strategy].description}</p>
            </div>

            {/* Risk per Trade */}
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Risk per Trade
              </label>
              <div className="grid grid-cols-4 gap-2">
                <RiskButton value={0.25} label="25%" />
                <RiskButton value={0.50} label="50%" />
                <RiskButton value={0.75} label="75%" />
                <RiskButton value={1.0} label="100%" />
              </div>
            </div>

            {/* Basic Settings */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="sessionProfitGoal" className="block text-xs font-medium text-gray-400">
                  Session Goal ($)
                </label>
                <input
                  type="number"
                  id="sessionProfitGoal"
                  value={sessionProfitGoal}
                  onChange={(e) => setSessionProfitGoal(parseFloat(e.target.value) || 0)}
                  className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-1.5 px-2 text-sm text-white focus:outline-none focus:ring-violet-500 focus:border-violet-500"
                />
              </div>
              <div>
                <label htmlFor="maxConcurrentTrades" className="block text-xs font-medium text-gray-400">
                  Max Trades {unlimitedTrades && <span className="text-cyan-400">(Unlimited)</span>}
                </label>
                <input
                  type="number"
                  id="maxConcurrentTrades"
                  value={maxConcurrentTrades}
                  onChange={(e) => setMaxConcurrentTrades(parseInt(e.target.value, 10) || 1)}
                  min={1}
                  disabled={unlimitedTrades}
                  className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-1.5 px-2 text-sm text-white focus:outline-none focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50"
                />
              </div>
            </div>

            {/* Session Duration */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Session Duration
              </label>
              <div className="flex gap-1.5">
                {[
                  { label: '30m', value: 30 },
                  { label: '1h', value: 60 },
                  { label: '2h', value: 120 },
                  { label: '4h', value: 240 },
                  { label: 'No Limit', value: 0 },
                ].map(({ label, value }) => (
                  <button
                    key={value}
                    onClick={() => setSessionDurationMinutes?.(value)}
                    disabled={isBotActive}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      sessionDurationMinutes === value
                        ? 'bg-cyan-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="number"
                  value={sessionDurationMinutes || ''}
                  onChange={(e) => setSessionDurationMinutes?.(parseInt(e.target.value, 10) || 0)}
                  placeholder="Custom (min)"
                  min={0}
                  disabled={isBotActive}
                  className="block w-full bg-gray-900/50 border border-gray-600 rounded-md py-1.5 px-2 text-sm text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500 disabled:opacity-50"
                />
              </div>
              {sessionDurationMinutes > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  Bot will close all trades after {sessionDurationMinutes >= 60 ? `${(sessionDurationMinutes / 60).toFixed(1)}h` : `${sessionDurationMinutes}m`}
                </p>
              )}
            </div>

            {/* Unlimited Trades Toggle */}
            <div className="flex items-center justify-between p-2 bg-gray-900/30 rounded-lg">
              <div>
                <span className="text-sm text-gray-300">Unlimited Trades</span>
                <p className="text-xs text-gray-500">No cap on concurrent positions</p>
              </div>
              <label className="inline-flex relative items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={unlimitedTrades}
                  onChange={(e) => setUnlimitedTrades?.(e.target.checked)}
                />
                <div className="w-9 h-5 bg-gray-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-600"></div>
              </label>
            </div>

            {/* Micro-Trading Mode Toggle */}
            <div className="flex items-center justify-between p-2 bg-gradient-to-r from-purple-900/30 to-cyan-900/30 rounded-lg border border-purple-500/30">
              <div>
                <span className="text-sm text-purple-300 font-medium">Micro-Trading Mode</span>
                <p className="text-xs text-gray-400">Many small trades for slow markets</p>
              </div>
              <label className="inline-flex relative items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={microTradingEnabled}
                  onChange={(e) => setMicroTradingEnabled?.(e.target.checked)}
                />
                <div className="w-9 h-5 bg-gray-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
              </label>
            </div>
            {microTradingEnabled && (
              <div className="p-2 bg-purple-900/20 rounded-lg text-xs text-purple-300 border border-purple-500/20">
                <p className="font-medium mb-1">Micro-Trading Active:</p>
                <ul className="list-disc list-inside space-y-0.5 text-gray-400">
                  <li>Target: {MICRO_TRADING.MICRO_PROFIT_TARGET_PERCENT}% profit per trade</li>
                  <li>Stop: {MICRO_TRADING.MICRO_STOP_LOSS_PERCENT}% loss limit</li>
                  <li>Speed: {MICRO_TRADING.MICRO_BOT_LOOP_MS / 1000}s loop cycle</li>
                  <li>Optimized for low-volatility periods</li>
                </ul>
              </div>
            )}

            {/* Auto-Optimize Button */}
            <button
              onClick={handleAutoOptimize}
              disabled={sessionProfitGoal <= 0}
              className={`w-full py-2 px-4 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 ${
                isAutoOptimized
                  ? 'bg-green-600/20 border border-green-500 text-green-400'
                  : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isAutoOptimized ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Settings Optimized
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Auto-Optimize Settings
                </>
              )}
            </button>
            {sessionProfitGoal > 0 && (
              <p className="text-xs text-gray-500 text-center -mt-2">
                Target: {((sessionProfitGoal / parseFloat(budgetInput || '10000')) * 100).toFixed(1)}% return
                {((sessionProfitGoal / parseFloat(budgetInput || '10000')) * 100) < 20 && ' (Conservative)'}
                {((sessionProfitGoal / parseFloat(budgetInput || '10000')) * 100) >= 20 &&
                 ((sessionProfitGoal / parseFloat(budgetInput || '10000')) * 100) <= 50 && ' (Moderate)'}
                {((sessionProfitGoal / parseFloat(budgetInput || '10000')) * 100) > 50 && ' (Aggressive)'}
              </p>
            )}

            {/* Profit Goal for Current Strategy */}
            <div>
              <label htmlFor="profitGoal" className="block text-sm font-medium text-gray-400">
                Profit Goal for {strategy} ($)
              </label>
              <input
                type="number"
                id="profitGoal"
                value={profitGoals[strategy]}
                onChange={(e) => setProfitGoals(strategy, parseFloat(e.target.value) || 0)}
                className="mt-1 block w-full bg-gray-900/50 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-violet-500 focus:border-violet-500"
              />
            </div>

            {/* Advanced Settings Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full text-sm text-gray-400 hover:text-white flex items-center justify-center gap-1"
            >
              {showAdvanced ? '- Hide' : '+ Show'} Risk Management
            </button>

            {/* Advanced Risk Management Settings */}
            {showAdvanced && (
              <div className="space-y-3 p-3 bg-gray-900/50 rounded-lg border border-gray-700">
                <h4 className="text-sm font-medium text-gray-300">Risk Management</h4>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="stopLoss" className="block text-xs font-medium text-gray-400">
                      Stop Loss (%)
                    </label>
                    <input
                      type="number"
                      id="stopLoss"
                      value={stopLossPercent}
                      onChange={(e) => setStopLossPercent(parseFloat(e.target.value) || 0)}
                      min={0}
                      max={50}
                      step={0.5}
                      className="mt-1 block w-full bg-gray-800 border border-gray-600 rounded-md py-1.5 px-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="trailingStop" className="block text-xs font-medium text-gray-400">
                      Trailing Stop (%)
                    </label>
                    <input
                      type="number"
                      id="trailingStop"
                      value={trailingStopPercent}
                      onChange={(e) => setTrailingStopPercent(parseFloat(e.target.value) || 0)}
                      min={0}
                      max={20}
                      step={0.5}
                      disabled={!useTrailingStop}
                      className="mt-1 block w-full bg-gray-800 border border-gray-600 rounded-md py-1.5 px-2 text-sm text-white disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">Use Trailing Stop</span>
                  <label className="inline-flex relative items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={useTrailingStop}
                      onChange={(e) => setUseTrailingStop(e.target.checked)}
                    />
                    <div className="w-9 h-5 bg-gray-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600"></div>
                  </label>
                </div>

                <p className="text-xs text-gray-500">
                  Stop Loss: Exit if position drops by this %. Trailing Stop: Lock in profits by following price up.
                </p>
              </div>
            )}

            {/* Scanner Toggle */}
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-white">Auto-Select Asset</h3>
              <label htmlFor="scanner-toggle" className="inline-flex relative items-center cursor-pointer">
                <input
                  type="checkbox"
                  id="scanner-toggle"
                  className="sr-only peer"
                  checked={isScannerActive}
                  onChange={(e) => toggleScanner(e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-600 rounded-full peer peer-focus:ring-4 peer-focus:ring-cyan-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-600"></div>
              </label>
            </div>

            {/* Bot Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-medium text-white">Auto-Trading Bot</h3>
                <p className="text-xs text-gray-400">Bot uses all strategies when active.</p>
              </div>
              <div className="flex items-center">
                <span className={`mr-3 text-sm font-medium ${isBotActive ? 'text-green-400' : 'text-gray-400'}`}>
                  {isBotActive ? 'Active' : 'Idle'}
                </span>
                <label htmlFor="bot-toggle" className="inline-flex relative items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="bot-toggle"
                    className="sr-only peer"
                    checked={isBotActive}
                    onChange={(e) => toggleBot(e.target.checked)}
                    disabled={!isApiAuthenticated && tradingMode === 'REAL'}
                  />
                  <div className="w-11 h-6 bg-gray-600 rounded-full peer peer-focus:ring-4 peer-focus:ring-green-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
                </label>
              </div>
            </div>

            {/* Close All Positions Button */}
            {onCloseAll && (
              <div className="mt-3 pt-3 border-t border-gray-700">
                {!closeAllConfirm ? (
                  <button
                    onClick={() => setCloseAllConfirm(true)}
                    disabled={isClosingAll}
                    className="w-full py-2 px-4 rounded-lg text-sm font-medium bg-red-600/20 text-red-400 border border-red-600/40 hover:bg-red-600/40 hover:text-red-300 transition-colors"
                  >
                    Close All Positions
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-red-400 text-center">Sell ALL open positions at market price?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setCloseAllConfirm(false)}
                        className="flex-1 py-2 px-3 rounded-lg text-sm font-medium bg-gray-600 text-gray-300 hover:bg-gray-500 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={async () => {
                          setIsClosingAll(true);
                          try {
                            await onCloseAll();
                          } finally {
                            setIsClosingAll(false);
                            setCloseAllConfirm(false);
                          }
                        }}
                        disabled={isClosingAll}
                        className="flex-1 py-2 px-3 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                      >
                        {isClosingAll ? 'Closing...' : 'Confirm Close All'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Stop Session Button */}
            {onStopSession && (
              <div className="mt-3">
                {!stopSessionConfirm ? (
                  <button
                    onClick={() => setStopSessionConfirm(true)}
                    className="w-full py-2 px-4 rounded-lg text-sm font-medium bg-orange-600/20 text-orange-400 border border-orange-600/40 hover:bg-orange-600/40 hover:text-orange-300 transition-colors"
                  >
                    Stop Session
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-orange-400 text-center">Close all positions, stop the bot, and end the session?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setStopSessionConfirm(false)}
                        className="flex-1 py-2 px-3 rounded-lg text-sm font-medium bg-gray-600 text-gray-300 hover:bg-gray-500 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={async () => {
                          setIsStoppingSession(true);
                          try {
                            await onStopSession();
                          } finally {
                            setIsStoppingSession(false);
                            setStopSessionConfirm(false);
                          }
                        }}
                        disabled={isStoppingSession}
                        className="flex-1 py-2 px-3 rounded-lg text-sm font-medium bg-orange-600 text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
                      >
                        {isStoppingSession ? 'Stopping...' : 'Confirm Stop'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
