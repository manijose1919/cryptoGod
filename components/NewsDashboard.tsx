import React, { useState, useEffect } from 'react';

interface NewsItem {
    title: string;
    source: string;
    publishedAt: string;
    sentiment: string;
    url: string;
}

interface NewsDashboardProps {
    ticker: string;
}

export const NewsDashboard: React.FC<NewsDashboardProps> = ({ ticker }) => {
    const [news, setNews] = useState<NewsItem[]>([]);
    const [trendingPlatforms, setTrendingPlatforms] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState<boolean>(true);

    useEffect(() => {
        const fetchNews = async () => {
            setLoading(true);
            try {
                const [feedRes, sentimentRes, trendingRes] = await Promise.allSettled([
                    fetch('/api/news/feed').then(r => r.json()),
                    fetch(`/api/news/sentiment/${ticker}`).then(r => r.json()),
                    fetch('/api/news/trending').then(r => r.json()),
                ]);

                // Parse CryptoPanic feed into news items
                const feedData = feedRes.status === 'fulfilled' ? feedRes.value : {};
                const cryptoPanicNews = (feedData.cryptoPanic || []).map((item: any) => ({
                    title: item.title || item.headline || 'Untitled',
                    source: item.source?.title || item.source || 'CryptoPanic',
                    publishedAt: item.published_at || item.created_at || new Date().toISOString(),
                    sentiment: item.votes?.positive > item.votes?.negative ? 'positive' :
                               item.votes?.negative > item.votes?.positive ? 'negative' : 'neutral',
                    url: item.url || '#',
                }));
                const dbNews = (feedData.dbNews || []).map((item: any) => ({
                    title: item.title || 'News',
                    source: item.source || 'DB',
                    publishedAt: item.published_at || new Date().toISOString(),
                    sentiment: item.sentiment || 'neutral',
                    url: item.url || '#',
                }));
                setNews([...cryptoPanicNews, ...dbNews].slice(0, 10));

                // Trending platforms from sentiment data
                const sentData = sentimentRes.status === 'fulfilled' ? sentimentRes.value : {};
                const reddit = sentData?.reddit;
                const platforms: Record<string, number> = {};
                if (reddit?.mentionCount) platforms['Reddit'] = Math.min(reddit.mentionCount, 100);
                const trendingData = trendingRes.status === 'fulfilled' ? trendingRes.value : {};
                if (trendingData?.coins?.length) platforms['CoinGecko Trending'] = trendingData.coins.length;
                setTrendingPlatforms(platforms);
            } catch (e) {
                console.error("Failed to fetch news", e);
            } finally {
                setLoading(false);
            }
        };

        fetchNews();
        const interval = setInterval(fetchNews, 120_000); // Refresh every 2 min
        return () => clearInterval(interval);
    }, [ticker]);

    if (loading) {
        return <div className="p-4 text-center text-gray-500 animate-pulse">Loading social intelligence...</div>;
    }

    return (
        <div className="bg-gray-800/80 backdrop-blur-md p-5 rounded-2xl border border-gray-700 shadow-xl">
            <h4 className="text-white font-bold text-lg mb-5 flex items-center gap-2">
                <span className="text-xl">🌐</span>
                Social & News Intelligence: {ticker}
            </h4>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Trending Platforms */}
                <div>
                    <h5 className="text-xs text-gray-400 uppercase font-bold mb-3 tracking-wider">Trending Platforms</h5>
                    <div className="space-y-3">
                        {Object.entries(trendingPlatforms).map(([platform, count], idx) => (
                            <div key={platform} className="bg-gray-900/50 p-2 rounded-lg border border-gray-800 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${idx === 0 ? 'bg-cyan-500' : 'bg-gray-600'}`}></div>
                                    <span className="text-sm text-gray-300 font-medium">{platform}</span>
                                </div>
                                <div className="text-xs font-mono text-cyan-400">{count}% Activity</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Latest News */}
                <div>
                    <h5 className="text-xs text-gray-400 uppercase font-bold mb-3 tracking-wider">Top Stories</h5>
                    <div className="space-y-3">
                        {news.slice(0, 4).map((item, i) => (
                            <div key={i} className="group relative bg-gray-900/30 hover:bg-gray-800/50 transition-colors p-3 rounded-lg border border-gray-800/50">
                                <div className={`absolute left-0 top-3 bottom-3 w-1 rounded-r-sm ${
                                    item.sentiment === 'positive' ? 'bg-green-500' : 
                                    item.sentiment === 'negative' ? 'bg-red-500' : 'bg-gray-500'
                                }`}></div>
                                <div className="pl-3">
                                    <div className="text-xs text-gray-500 mb-1 flex justify-between">
                                        <span>{item.source}</span>
                                        <span>{new Date(item.publishedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                    </div>
                                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm text-gray-300 group-hover:text-cyan-400 transition-colors line-clamp-2">
                                        {item.title}
                                    </a>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
