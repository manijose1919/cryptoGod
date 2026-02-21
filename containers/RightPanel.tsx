
import { MultiTimeframeDashboard } from '../components/MultiTimeframeDashboard';
import StrategyOverview from '../components/StrategyOverview';
import { SignalHeatMap } from '../components/SignalHeatMap';
import { MarketScanner } from '../components/MarketScanner';
import { SystemLog } from '../components/SystemLog';
import { TradeExplainer } from '../components/TradeExplainer';
import VPSMonitor from '../components/VPSMonitor';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';

export function RightPanel() {
    const { trades, systemLog } = useTradingContext();
    const { ticker, setTicker } = useSettingsContext();
    const { activeWatchlistData, watchlistDataRef, mtfData, isMtfLoading, scannerInsights } = useMarketDataContext();

    return (
        <div className="lg:col-span-3 space-y-4">
            <VPSMonitor pollInterval={3000} />
            <MultiTimeframeDashboard data={mtfData} isLoading={isMtfLoading} />
            <StrategyOverview data={activeWatchlistData} />
            <SignalHeatMap watchlistData={watchlistDataRef.current} />
            <MarketScanner insights={scannerInsights} activeTicker={ticker} onSelectTicker={setTicker} />
            <SystemLog events={systemLog} />
            <div className="space-y-4">
                <TradeExplainer trade={trades.length > 0 ? trades[0] : null} />
            </div>
        </div>
    );
}
