
// CenterPanel container
import { IndicatorGauge } from '../components/IndicatorGauge';
import { IndicatorChart } from '../components/IndicatorChart';
import { SignalDisplay } from '../components/SignalDisplay';
import { ConfluenceDashboard } from '../components/ConfluenceDashboard';
import { AILearningPanel } from '../components/AILearningPanel';
import { AssetIntelligencePanel } from '../components/AssetIntelligencePanel';
import { VolatilityPanel } from '../components/VolatilityPanel';
import { RiskMetricsPanel } from '../components/RiskMetricsPanel';
import { PredictiveDisplay } from '../components/PredictiveDisplay';
import { NewsDashboard } from '../components/NewsDashboard';
import { MLDashboard } from '../components/MLDashboard';
import MLThoughtProcess from '../components/MLThoughtProcess';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { SIGNAL_THRESHOLDS } from '../constants';

interface CenterPanelProps {
    handleRunMonteCarlo: () => void;
}

export function CenterPanel({ handleRunMonteCarlo }: CenterPanelProps) {
    const { trades, isTradingActive } = useTradingContext();
    const { ticker } = useSettingsContext();
    const {
        activeWatchlistData, adaptiveData, predictionData,
        ensembleVolatility, volatilityExpansion,
        riskMetrics, kellyResult, monteCarloResult, isRunningMonteCarlo,
        learningState, currentAssetProfile, currentSentiment, assetRanking,
    } = useMarketDataContext();

    return (
        <div className="lg:col-span-6 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <IndicatorGauge
                    label="Trend Clarity"
                    value={activeWatchlistData?.indicatorData.at(-1)?.value ?? null}
                    lower_threshold={SIGNAL_THRESHOLDS.TREND_BULLISH_ENTRY}
                    upper_threshold={SIGNAL_THRESHOLDS.TREND_BEARISH_EXIT}
                    higher_is_better={false}
                />
                <IndicatorGauge
                    label="Breakout Power"
                    value={activeWatchlistData?.breakoutData.at(-1)?.value ?? null}
                    lower_threshold={SIGNAL_THRESHOLDS.BREAKOUT_SQUEEZE_ENTRY}
                    upper_threshold={SIGNAL_THRESHOLDS.BREAKOUT_EXPANSION_EXIT}
                    higher_is_better={false}
                />
                <IndicatorGauge
                    label="Whale Money Flow"
                    value={activeWatchlistData?.whaleData.at(-1)?.value ?? null}
                    lower_threshold={SIGNAL_THRESHOLDS.WHALE_SELLING_EXIT}
                    upper_threshold={SIGNAL_THRESHOLDS.WHALE_BUYING_ENTRY}
                    higher_is_better={true}
                />
                <IndicatorGauge
                    label="Momentum"
                    value={activeWatchlistData?.momentumData.at(-1)?.value ?? null}
                    lower_threshold={50 - SIGNAL_THRESHOLDS.MOMENTUM_BEARISH_EXIT}
                    upper_threshold={50 + SIGNAL_THRESHOLDS.MOMENTUM_BULLISH_ENTRY}
                    higher_is_better={true}
                />
            </div>

            {isTradingActive && activeWatchlistData && (
                <IndicatorChart
                    candles={activeWatchlistData.candles}
                    tcSeries={activeWatchlistData.indicatorData}
                    breakoutSeries={activeWatchlistData.breakoutData}
                    whaleSeries={activeWatchlistData.whaleData}
                    momentumSeries={activeWatchlistData.momentumData}
                    divergenceData={activeWatchlistData.divergenceData}
                    srLevels={activeWatchlistData.srLevels}
                    volumeProfile={activeWatchlistData.volumeProfileData}
                    trades={trades.filter(t => t.ticker === ticker)}
                    bollingerBands={activeWatchlistData.bollingerBands}
                    vwap={activeWatchlistData.vwap}
                    ma50={activeWatchlistData.ma50}
                    ma200={activeWatchlistData.ma200}
                />
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <SignalDisplay
                    trendDashboard={activeWatchlistData?.trendDashboardData}
                    adaptiveData={adaptiveData}
                />
                <ConfluenceDashboard
                    trendScore={activeWatchlistData?.trendDashboardData?.score ?? 0}
                    breakoutValue={activeWatchlistData?.breakoutData?.at(-1)?.value ?? 50}
                    whaleValue={activeWatchlistData?.whaleData?.at(-1)?.value ?? 50}
                    momentumValue={activeWatchlistData?.momentumData?.at(-1)?.value ?? 50}
                    signalScore={activeWatchlistData?.signalScore}
                />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AILearningPanel learningState={learningState} />
                <AssetIntelligencePanel
                    profile={currentAssetProfile}
                    sentiment={currentSentiment}
                    ranking={assetRanking.slice(0, 5)}
                />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <VolatilityPanel
                    ensemble={ensembleVolatility}
                    expansion={volatilityExpansion}
                />
                <RiskMetricsPanel
                    metrics={riskMetrics}
                    kelly={kellyResult}
                    monteCarlo={monteCarloResult}
                    onRunMonteCarlo={handleRunMonteCarlo}
                    isRunning={isRunningMonteCarlo}
                />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <PredictiveDisplay data={predictionData} />
                <NewsDashboard ticker={ticker} />
            </div>
            <MLDashboard ticker={ticker} />
            <MLThoughtProcess pollInterval={2000} />
        </div>
    );
}
