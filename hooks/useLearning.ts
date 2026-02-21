
import { useEffect } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { restoreFromDatabase } from '../services/aiLearningService';
import { getAssetProfile, fetchSocialSentiment, getBestAssetsForMarket } from '../services/assetIntelligenceService';

export function useLearning() {
    const { isTradingActive, addLog } = useTradingContext();
    const { ticker, assetIntelligenceEnabled } = useSettingsContext();
    const {
        watchlistDataRef, marketRegime,
        setCurrentAssetProfile, setCurrentSentiment, setAssetRanking,
    } = useMarketDataContext();

    // Restore AI learning from database on mount
    useEffect(() => {
        restoreFromDatabase().then(result => {
            if (result.tradesLoaded > 0 || result.patternsLoaded > 0 || result.paramsRestored) {
                addLog(`AI Learning restored from previous sessions: ${result.tradesLoaded} trades, ${result.patternsLoaded} patterns, params=${result.paramsRestored}`, 'SPECIAL');
            }
        }).catch(err => {
            addLog(`AI Learning restore failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'ERROR');
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Asset intelligence: profile & sentiment
    useEffect(() => {
        if (!assetIntelligenceEnabled || !ticker) return;
        const profile = getAssetProfile(ticker);
        setCurrentAssetProfile(profile);

        if (isTradingActive) {
            fetchSocialSentiment(ticker).then(sentiment => {
                setCurrentSentiment(sentiment);
                if (sentiment && Math.random() < 0.3) {
                    addLog(`Sentiment for ${ticker}: ${sentiment.overallSentiment} (score: ${sentiment.sentimentScore})`, 'INFO');
                }
            }).catch(() => { /* Sentiment is optional */ });
        }
    }, [ticker, assetIntelligenceEnabled, isTradingActive, addLog, setCurrentAssetProfile, setCurrentSentiment]);

    // Asset intelligence: ranking
    useEffect(() => {
        if (!assetIntelligenceEnabled || !isTradingActive || !marketRegime) return;
        const availableAssets = Object.keys(watchlistDataRef.current);
        const volatilityLevel = marketRegime.volatility as 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
        const ranking = getBestAssetsForMarket(volatilityLevel, availableAssets);
        setAssetRanking(ranking);

        if (ranking.length > 0 && Math.random() < 0.1) {
            const top3 = ranking.slice(0, 3).map(r => `${r.symbol}(${r.score})`).join(', ');
            addLog(`Asset Intelligence: Best assets for ${volatilityLevel} market: ${top3}`, 'INFO');
        }
    }, [assetIntelligenceEnabled, isTradingActive, marketRegime, addLog, watchlistDataRef, setAssetRanking]);
}
