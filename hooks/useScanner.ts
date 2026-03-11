
import { useEffect } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { INTERVALS } from '../constants';
import type { ScannerInsights } from '../types';

export function useScanner() {
    const {
        isScannerActive, isTradingActive, scannerPaused, setScannerPaused,
        addLog, portfolioRef,
    } = useTradingContext();
    const { ticker, setTicker, strategy } = useSettingsContext();
    const { watchlistDataRef, setScannerInsights } = useMarketDataContext();

    useEffect(() => {
        if (!isScannerActive || !isTradingActive) return;

        const scannerInterval = setInterval(() => {
            const currentPortfolio = portfolioRef.current;
            const hasOpenPositions = Object.keys(currentPortfolio.positions || {}).length > 0;

            if (hasOpenPositions) {
                if (!scannerPaused) {
                    setScannerPaused(true);
                    setScannerInsights(null);
                    addLog('Scanner paused: Positions are currently open.', 'INFO');
                }
                return;
            }

            if (scannerPaused) setScannerPaused(false);

            addLog('Scanner: Analyzing market for signals...', 'INFO');
            const insights: ScannerInsights = {
                TREND: [], BREAKOUT: [], WHALE: [], CONFLUENCE: [], MOMENTUM: [], DIVERGENCE: [], ADAPTIVE: [],
            };

            for (const asset of Object.keys(watchlistDataRef.current || {})) {
                const data = watchlistDataRef.current[asset];
                if (data && data.indicatorData.length > 0) {
                    const tcValue = data.indicatorData.at(-1)?.value ?? 50;
                    const breakoutValue = data.breakoutData.at(-1)?.value ?? 50;
                    const whaleValue = data.whaleData.at(-1)?.value ?? 50;
                    const momentumValue = data.momentumData.at(-1)?.value ?? 50;
                    const confluenceScore = data.trendDashboardData?.score ?? 0;
                    const divergenceConfidence = data.divergenceData?.confidence ?? 0;

                    insights.TREND!.push({ ticker: asset, value: tcValue, score: 0 });
                    insights.BREAKOUT!.push({ ticker: asset, value: breakoutValue, score: 0 });
                    insights.WHALE!.push({ ticker: asset, value: whaleValue, score: 0 });
                    insights.MOMENTUM!.push({ ticker: asset, value: momentumValue, score: 0 });
                    insights.CONFLUENCE!.push({ ticker: asset, value: 0, score: confluenceScore });
                    insights.DIVERGENCE!.push({
                        ticker: asset,
                        value: data.divergenceData.type === 'bullish' ? divergenceConfidence : -divergenceConfidence,
                        score: divergenceConfidence,
                    });
                    const adaptiveValue = data.adaptiveData?.at(-1)?.value ?? tcValue;
                    insights.ADAPTIVE!.push({ ticker: asset, value: adaptiveValue, score: 100 - adaptiveValue });
                }
            }

            insights.TREND!.sort((a, b) => a.value - b.value);
            insights.BREAKOUT!.sort((a, b) => a.value - b.value);
            insights.WHALE!.sort((a, b) => b.value - a.value);
            insights.MOMENTUM!.sort((a, b) => b.value - a.value);
            insights.CONFLUENCE!.sort((a, b) => b.score - a.score);
            insights.DIVERGENCE!.sort((a, b) => b.value - a.value);
            insights.ADAPTIVE!.sort((a, b) => a.value - b.value);

            setScannerInsights(insights);

            const bestSignal = insights[strategy as keyof ScannerInsights]?.[0];
            if (bestSignal && bestSignal.ticker !== ticker) {
                setTicker(bestSignal.ticker);
                addLog(`Scanner switched active asset to ${bestSignal.ticker} for optimal ${strategy} signal.`, 'SPECIAL');
            }
        }, INTERVALS.SCANNER_INTERVAL_MS);

        return () => clearInterval(scannerInterval);
    }, [isScannerActive, isTradingActive, ticker, strategy, addLog, scannerPaused, portfolioRef, watchlistDataRef, setScannerInsights, setScannerPaused, setTicker]);
}
