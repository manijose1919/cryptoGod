
import { useEffect, useCallback } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { calculateAdaptiveData, calculateMultiAssetAnalysis } from '../services/indicatorService';
import {
    calculateEnsembleVolatility, detectVolatilityExpansion, getBestVolatilityMethodForStrategy,
} from '../services/volatilityMethodsService';
import {
    calculateSentimentFromMarketData, detectSentimentBurst, detectSentimentRegime,
    getCorrelatedMemeAssets, type SentimentSignal,
} from '../services/enhancedSentimentService';
import { calculateOnChainSignals } from '../services/onChainAnalyticsService';
import {
    calculateRiskMetrics, calculateKellyCriterion, runMonteCarloSimulation, resetEquityTracking,
} from '../services/riskMetricsService';

export function useIndicators() {
    const { isTradingActive, addLog, portfolio, trades } = useTradingContext();
    const {
        ticker, strategy, volatilityAnalysisEnabled, enhancedSentimentEnabled,
        onChainEnabled, riskMetricsEnabled,
    } = useSettingsContext();
    const {
        activeWatchlistData, watchlistDataRef, marketRegime,
        setAdaptiveData, setPredictionData,
        setEnsembleVolatility, setVolatilityExpansion,
        setSentimentSignal, setSentimentBurst, setSentimentRegime,
        setOnChainSignals,
        setRiskMetrics, setKellyResult, setMonteCarloResult,
        isRunningMonteCarlo, setIsRunningMonteCarlo,
        setMultiAssetAnalysis,
    } = useMarketDataContext();

    // Adaptive data
    useEffect(() => {
        if (!activeWatchlistData || activeWatchlistData.candles.length === 0) return;
        const adaptive = calculateAdaptiveData(activeWatchlistData.candles, ticker);
        setAdaptiveData(adaptive);
    }, [ticker, activeWatchlistData, setAdaptiveData]);

    // Prediction data
    useEffect(() => {
        if (!activeWatchlistData || activeWatchlistData.candles.length === 0) return;
        const tcValue = activeWatchlistData.indicatorData.at(-1)?.value ?? 50;
        const momValue = activeWatchlistData.momentumData.at(-1)?.value ?? 50;
        const price = activeWatchlistData.candles.at(-1)?.close ?? 0;

        setPredictionData({
            ticker,
            horizons: {
                '1h': { direction: tcValue < 45 ? 'UP' : tcValue > 55 ? 'DOWN' : 'SIDEWAYS', confidence: 75 },
                '4h': { direction: momValue > 55 ? 'UP' : momValue < 45 ? 'DOWN' : 'SIDEWAYS', confidence: 60 },
                '24h': { direction: 'UP', confidence: 45 },
            },
            levels: { support: price * 0.98, resistance: price * 1.02 },
            regime: marketRegime?.trend || 'SIDEWAYS',
            factors: [
                { name: 'Technical', impact: (50 - tcValue) },
                { name: 'Momentum', impact: (momValue - 50) },
                { name: 'Sentiment', impact: 20 },
            ],
        });
    }, [ticker, activeWatchlistData, marketRegime, setPredictionData]);

    // Volatility ensemble
    useEffect(() => {
        if (!volatilityAnalysisEnabled || !isTradingActive || !activeWatchlistData) return;
        const candles = activeWatchlistData.candles;
        if (candles.length < 30) return;

        const ensemble = calculateEnsembleVolatility(candles, 20);
        setEnsembleVolatility(ensemble);
        const expansion = detectVolatilityExpansion(candles, 5, 20);
        setVolatilityExpansion(expansion);

        if (Math.random() < 0.05) {
            const volStrategy = (['TREND', 'BREAKOUT', 'WHALE', 'CONFLUENCE', 'MOMENTUM', 'DIVERGENCE', 'ADAPTIVE'] as const).includes(strategy as any) ? strategy as 'TREND' | 'BREAKOUT' | 'WHALE' | 'CONFLUENCE' | 'MOMENTUM' | 'DIVERGENCE' | 'ADAPTIVE' : 'ADAPTIVE';
            const bestMethod = getBestVolatilityMethodForStrategy(volStrategy);
            addLog(`Volatility: ${ensemble.consensus} (${ensemble.average.toFixed(0)}%) | Best: ${bestMethod.primary} | ${expansion.signal}`, 'INFO');
        }
    }, [volatilityAnalysisEnabled, isTradingActive, activeWatchlistData, strategy, addLog, setEnsembleVolatility, setVolatilityExpansion]);

    // Enhanced sentiment
    useEffect(() => {
        if (!enhancedSentimentEnabled || !isTradingActive || !activeWatchlistData) return;
        const candles = activeWatchlistData.candles;
        if (candles.length < 20) return;

        const signal = calculateSentimentFromMarketData(candles, ticker);
        setSentimentSignal(signal);

        const correlatedAssets = getCorrelatedMemeAssets(ticker);
        const burst = detectSentimentBurst(signal, correlatedAssets);
        setSentimentBurst(burst);

        if (burst.detected && burst.magnitude > 50) {
            addLog(`Sentiment Burst: ${burst.burstType} on ${ticker} (${burst.magnitude.toFixed(0)}%) - ${burst.recommendedAction}`, 'SPECIAL');
        }

        if (Math.random() < 0.1) {
            const allSentiments: SentimentSignal[] = [];
            for (const t of Object.keys(watchlistDataRef.current)) {
                const data = watchlistDataRef.current[t];
                if (data && data.candles.length > 20) {
                    allSentiments.push(calculateSentimentFromMarketData(data.candles, t));
                }
            }
            if (allSentiments.length > 0) {
                const regime = detectSentimentRegime(allSentiments, 0);
                setSentimentRegime(regime);
            }
        }
    }, [enhancedSentimentEnabled, isTradingActive, activeWatchlistData, ticker, addLog, watchlistDataRef, setSentimentSignal, setSentimentBurst, setSentimentRegime]);

    // On-chain analytics
    useEffect(() => {
        if (!onChainEnabled || !isTradingActive || !activeWatchlistData) return;
        const candles = activeWatchlistData.candles;
        if (candles.length < 50) return;

        const signals = calculateOnChainSignals(candles, ticker);
        setOnChainSignals(signals);

        if (Math.random() < 0.05 && signals.overallSignal !== 'NEUTRAL') {
            addLog(`On-Chain: ${signals.overallSignal} | Whale: ${signals.whaleActivity.type} | Flow: ${signals.exchangeFlow.netFlow}`, 'INFO');
        }
    }, [onChainEnabled, isTradingActive, activeWatchlistData, ticker, addLog, setOnChainSignals]);

    // Risk metrics
    useEffect(() => {
        if (!riskMetricsEnabled || !isTradingActive) return;

        const calculateMetrics = () => {
            const totalValue = portfolio.cash + Object.values(portfolio.positions).reduce((sum, pos) => {
                const price = watchlistDataRef.current[pos.ticker]?.candles?.at(-1)?.close ?? pos.openPrice;
                return sum + (pos.quantity * price);
            }, 0);

            const metrics = calculateRiskMetrics(trades, totalValue, portfolio.initialBudget);
            setRiskMetrics(metrics);
            const kelly = calculateKellyCriterion(trades, 10);
            setKellyResult(kelly);

            if (metrics.streakRisk === 'CRITICAL' || metrics.streakRisk === 'HIGH') {
                if (Math.random() < 0.1) {
                    addLog(`Risk Alert: ${metrics.streakRisk} streak risk | DD: ${metrics.currentDrawdown.toFixed(1)}% | Streak: ${metrics.currentStreak}`, 'ERROR');
                }
            }
        };

        calculateMetrics();
        const interval = setInterval(calculateMetrics, 5000);
        return () => clearInterval(interval);
    }, [riskMetricsEnabled, isTradingActive, trades, portfolio, addLog, watchlistDataRef, setRiskMetrics, setKellyResult]);

    // Monte Carlo handler
    const handleRunMonteCarlo = useCallback(() => {
        if (isRunningMonteCarlo) return;
        setIsRunningMonteCarlo(true);
        setTimeout(() => {
            const result = runMonteCarloSimulation(trades, portfolio.initialBudget, 100, 1000);
            setMonteCarloResult(result);
            setIsRunningMonteCarlo(false);
            addLog(`Monte Carlo: Median ${result.medianOutcome.toFixed(0)} | Ruin Risk: ${result.ruinProbability.toFixed(1)}%`, 'INFO');
        }, 100);
    }, [trades, portfolio.initialBudget, isRunningMonteCarlo, addLog, setIsRunningMonteCarlo, setMonteCarloResult]);

    // Multi-asset analysis
    useEffect(() => {
        if (!isTradingActive) return;
        const calculateAnalysis = () => {
            const watchlistData = watchlistDataRef.current;
            if (Object.keys(watchlistData).length > 0) {
                const analysis = calculateMultiAssetAnalysis(watchlistData);
                setMultiAssetAnalysis(analysis);
            }
        };
        calculateAnalysis();
        const interval = setInterval(calculateAnalysis, 30000);
        return () => clearInterval(interval);
    }, [isTradingActive, watchlistDataRef, setMultiAssetAnalysis]);

    return { handleRunMonteCarlo, resetEquityTracking };
}
