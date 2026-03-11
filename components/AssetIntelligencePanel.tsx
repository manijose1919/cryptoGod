import React from 'react';
import type { AssetProfile, SentimentData } from '../services/assetIntelligenceService';

interface AssetIntelligencePanelProps {
    profile: AssetProfile | null;
    sentiment: SentimentData | null;
    ranking: { symbol: string; score: number; reason: string }[];
}

export const AssetIntelligencePanel: React.FC<AssetIntelligencePanelProps> = ({
    profile: currentAssetProfile,
    sentiment: currentSentiment,
    ranking: assetRanking,
}) => {
    const getSentimentColor = (sentiment: SentimentData['overallSentiment']) => {
        switch (sentiment) {
            case 'VERY_BULLISH': return 'text-green-400';
            case 'BULLISH': return 'text-green-300';
            case 'NEUTRAL': return 'text-gray-300';
            case 'BEARISH': return 'text-red-300';
            case 'VERY_BEARISH': return 'text-red-400';
            default: return 'text-gray-300';
        }
    };

    const getRiskColor = (risk: AssetProfile['riskLevel']) => {
        switch (risk) {
            case 'LOW': return 'text-green-400';
            case 'MEDIUM': return 'text-yellow-400';
            case 'HIGH': return 'text-orange-400';
            case 'EXTREME': return 'text-red-400';
            default: return 'text-gray-400';
        }
    };

    const getLiquidityColor = (liquidity: AssetProfile['liquidity']) => {
        switch (liquidity) {
            case 'VERY_HIGH': return 'text-cyan-400';
            case 'HIGH': return 'text-cyan-300';
            case 'MEDIUM_HIGH': return 'text-blue-300';
            case 'MEDIUM': return 'text-blue-400';
            case 'LOW_MEDIUM': return 'text-yellow-400';
            case 'LOW': return 'text-red-400';
            default: return 'text-gray-400';
        }
    };

    return (
        <div className="glass-card p-4 animate-fade-up">
            <h3 className="text-lg font-semibold gradient-header mb-3">Asset Intelligence</h3>

            <div className="space-y-4">
                    {/* Current Asset Profile */}
                    {currentAssetProfile ? (
                        <div className="bg-gray-900/50 p-3 rounded-lg">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-white font-medium">{currentAssetProfile.name}</span>
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                    currentAssetProfile.category === 'MAJOR' ? 'bg-blue-600' :
                                    currentAssetProfile.category === 'MEME' ? 'bg-pink-600' :
                                    currentAssetProfile.category === 'DEFI' ? 'bg-purple-600' :
                                    currentAssetProfile.category === 'GAMING' ? 'bg-green-600' :
                                    currentAssetProfile.category === 'AI' ? 'bg-cyan-600' :
                                    'bg-gray-600'
                                }`}>
                                    {currentAssetProfile.category}
                                </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                    <span className="text-gray-400">Risk:</span>
                                    <span className={`ml-1 ${getRiskColor(currentAssetProfile.riskLevel)}`}>
                                        {currentAssetProfile.riskLevel}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-gray-400">Liquidity:</span>
                                    <span className={`ml-1 ${getLiquidityColor(currentAssetProfile.liquidity)}`}>
                                        {currentAssetProfile.liquidity.replace('_', ' ')}
                                    </span>
                                </div>
                                <div className="col-span-2">
                                    <span className="text-gray-400">24h Vol:</span>
                                    <span className="ml-1 text-white">{currentAssetProfile.liquidityVolume24h}</span>
                                </div>
                                <div className="col-span-2">
                                    <span className="text-gray-400">1h Range:</span>
                                    <span className="ml-1 text-yellow-300">
                                        {currentAssetProfile.volatility['1h'][0]}% - {currentAssetProfile.volatility['1h'][1]}%
                                    </span>
                                </div>
                                <div className="col-span-2">
                                    <span className="text-gray-400">Best for:</span>
                                    <span className="ml-1 text-cyan-300 text-xs">
                                        {currentAssetProfile.bestStrategies.join(', ')}
                                    </span>
                                </div>
                                <div className="col-span-2">
                                    <span className="text-gray-400">Driver:</span>
                                    <span className="ml-1 text-gray-300 text-xs">
                                        {currentAssetProfile.primaryDriver.substring(0, 50)}...
                                    </span>
                                </div>
                            </div>
                            {/* Removed duplicate "Best for" display */}
                        </div>
                    ) : (
                        <div className="bg-gray-900/50 p-3 rounded-lg text-center text-gray-500 text-sm">
                            No profile data for this asset
                        </div>
                    )}

                    {/* Sentiment */}
                    {currentSentiment && (
                        <div className="bg-gray-900/50 p-3 rounded-lg">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-gray-400 text-sm">Social Sentiment</span>
                                <span className={`font-medium ${getSentimentColor(currentSentiment.overallSentiment)}`}>
                                    {currentSentiment.overallSentiment.replace('_', ' ')}
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="flex-1 bg-gray-700 rounded-full h-2">
                                    <div
                                        className={`h-2 rounded-full ${
                                            currentSentiment.sentimentScore > 0 ? 'bg-green-500' : 'bg-red-500'
                                        }`}
                                        style={{
                                            width: `${Math.abs(currentSentiment.sentimentScore)}%`,
                                            marginLeft: currentSentiment.sentimentScore < 0 ? 'auto' : 0
                                        }}
                                    />
                                </div>
                                <span className="text-xs text-gray-400">{currentSentiment.sentimentScore > 0 ? '+' : ''}{currentSentiment.sentimentScore}</span>
                            </div>
                            {currentSentiment.keyTopics.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {currentSentiment.keyTopics.slice(0, 3).map((topic, i) => (
                                        <span key={i} className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">
                                            {topic}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Asset Ranking */}
                    {assetRanking.length > 0 && (
                        <div className="bg-gray-900/50 p-3 rounded-lg">
                            <span className="text-gray-400 text-sm">Top Assets for Current Market</span>
                            <div className="mt-2 space-y-1">
                                {assetRanking.slice(0, 5).map((asset, i) => (
                                    <div
                                        key={asset.symbol}
                                        className="flex justify-between items-center text-xs p-1 rounded hover:bg-gray-700"
                                    >
                                        <span className="text-white">
                                            {i + 1}. {asset.symbol}
                                        </span>
                                        <span className={`${
                                            asset.score >= 70 ? 'text-green-400' :
                                            asset.score >= 50 ? 'text-yellow-400' :
                                            'text-gray-400'
                                        }`}>
                                            {asset.score}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
        </div>
    );
};
