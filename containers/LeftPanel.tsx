
import { ExchangeSelector } from '../components/ExchangeSelector';
import { TradingControls } from '../components/TradingControls';
import { PortfolioSummary } from '../components/PortfolioSummary';
import { SessionSummary } from '../components/SessionSummary';
import { TradeHistory } from '../components/TradeHistory';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { setActiveExchange as setMarketServiceExchange } from '../services/marketService';

interface LeftPanelProps {
    onStart: (budget: number, ticker: string) => void;
    toggleBot: (active: boolean) => void;
    onCloseAll: () => Promise<void>;
    onStopSession: () => Promise<void>;
}

export function LeftPanel({ onStart, toggleBot, onCloseAll, onStopSession }: LeftPanelProps) {
    const { portfolio, trades, isBotActive, isTradingActive, tradingMode, setTradingMode, isApiAuthenticated, addLog, isScannerActive, setIsScannerActive } = useTradingContext();
    const {
        ticker, strategy, setStrategy, riskAmount, setRiskAmount,
        profitGoals, setProfitGoals, sessionProfitGoal, setSessionProfitGoal,
        maxConcurrentTrades, setMaxConcurrentTrades,
        stopLossPercent, setStopLossPercent, trailingStopPercent, setTrailingStopPercent,
        useTrailingStop, setUseTrailingStop,
        currentExchange, setCurrentExchange, setCurrentExchangeFees,
        microTradingEnabled, setMicroTradingEnabled,
        unlimitedTrades, setUnlimitedTrades,
        sessionDurationMinutes, setSessionDurationMinutes,
    } = useSettingsContext();
    const { watchlistDataRef, availableTickersRef } = useMarketDataContext();

    return (
        <div className="lg:col-span-3 space-y-4">
            <ExchangeSelector
                currentExchange={currentExchange}
                onExchangeChange={(exchange, fees) => {
                    setCurrentExchange(exchange);
                    setCurrentExchangeFees(fees);
                    setMarketServiceExchange(exchange);
                }}
            />
            <TradingControls
                onStart={onStart}
                activeTicker={ticker}
                isTradingActive={isTradingActive}
                strategy={strategy}
                setStrategy={setStrategy}
                isBotActive={isBotActive}
                toggleBot={toggleBot}
                addLog={addLog}
                isScannerActive={isScannerActive}
                setIsScannerActive={setIsScannerActive}
                riskAmount={riskAmount}
                setRiskAmount={setRiskAmount}
                tradingMode={tradingMode}
                setTradingMode={setTradingMode}
                isApiAuthenticated={isApiAuthenticated}
                profitGoals={profitGoals}
                setProfitGoals={(strat, val) => setProfitGoals(p => ({ ...p, [strat]: val }))}
                sessionProfitGoal={sessionProfitGoal}
                setSessionProfitGoal={setSessionProfitGoal}
                maxConcurrentTrades={maxConcurrentTrades}
                setMaxConcurrentTrades={setMaxConcurrentTrades}
                stopLossPercent={stopLossPercent}
                setStopLossPercent={setStopLossPercent}
                trailingStopPercent={trailingStopPercent}
                setTrailingStopPercent={setTrailingStopPercent}
                useTrailingStop={useTrailingStop}
                setUseTrailingStop={setUseTrailingStop}
                availableTickers={availableTickersRef.current}
                microTradingEnabled={microTradingEnabled}
                setMicroTradingEnabled={setMicroTradingEnabled}
                unlimitedTrades={unlimitedTrades}
                setUnlimitedTrades={setUnlimitedTrades}
                sessionDurationMinutes={sessionDurationMinutes}
                setSessionDurationMinutes={setSessionDurationMinutes}
                onCloseAll={onCloseAll}
                onStopSession={onStopSession}
            />
            <PortfolioSummary portfolio={portfolio} watchlistData={watchlistDataRef.current} tradingMode={tradingMode} />
            <SessionSummary trades={trades} initialBudget={portfolio.initialBudget} />
            <TradeHistory trades={trades} />
        </div>
    );
}
