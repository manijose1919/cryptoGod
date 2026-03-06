
import { useMemo } from 'react';
import { MultiTimeframeDashboard } from '../components/MultiTimeframeDashboard';
import StrategyOverview from '../components/StrategyOverview';
import { SignalHeatMap } from '../components/SignalHeatMap';
import { MarketScanner } from '../components/MarketScanner';
import { SystemLog } from '../components/SystemLog';
import { TradeExplainer } from '../components/TradeExplainer';
import VPSMonitor from '../components/VPSMonitor';
import { MLTrainingPanel } from '../components/MLTrainingPanel';
import SwingTradesPanel from '../components/SwingTradesPanel';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';

export function RightPanel() {
    const { trades, systemLog, portfolio, addLog, tradingMode } = useTradingContext();
    const { ticker, setTicker } = useSettingsContext();
    const { activeWatchlistData, watchlistDataRef, mtfData, isMtfLoading, scannerInsights } = useMarketDataContext();

    // Derive current prices from active watchlist data (state-driven, re-computes on data updates)
    const currentPrices = useMemo(() => {
        const prices: Record<string, number> = {};
        const wd = watchlistDataRef.current;
        if (!wd) return prices;
        for (const t of Object.keys(wd)) {
            const candles = wd[t]?.candles;
            if (candles && candles.length > 0) {
                prices[t] = candles[candles.length - 1].close;
            }
        }
        return prices;
    }, [activeWatchlistData]); // Use state as dependency, not ref

    return (
        <div className="lg:col-span-3 space-y-4">
            {tradingMode === 'SIMULATION' && (
                <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-2 mb-3 text-xs text-yellow-300">
                    SIMULATION MODE — Safety limits disabled for maximum ML learning
                </div>
            )}
            <VPSMonitor pollInterval={3000} />
            <MLTrainingPanel addLog={addLog} />
            <MultiTimeframeDashboard data={mtfData} isLoading={isMtfLoading} />
            <StrategyOverview data={activeWatchlistData} />
            <SignalHeatMap watchlistData={watchlistDataRef.current} />
            <MarketScanner insights={scannerInsights} activeTicker={ticker} onSelectTicker={setTicker} />
            <SwingTradesPanel
                positions={portfolio?.positions || {}}
                currentPrices={currentPrices}
            />
            <SystemLog events={systemLog} />
            <div className="space-y-4">
                <TradeExplainer trade={trades.length > 0 ? trades[0] : null} />
            </div>
        </div>
    );
}
