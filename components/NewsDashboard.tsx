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

    const hasUrl = (url: string) => url && url !== '#' && url !== '';

    return (
        <div className="glass-card p-5">
            <div className="section-header mb-4">
                Social & News Intelligence: {ticker}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Trending Platforms */}
                <div>
                    <h5 className="text-xs uppercase font-bold mb-3 tracking-wider" style={{ color: 'var(--text-muted)' }}>Trending Platforms</h5>
                    <div className="space-y-3">
                        {Object.entries(trendingPlatforms || {}).length === 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No trending data available</div>
                        )}
                        {Object.entries(trendingPlatforms || {}).map(([platform, count], idx) => (
                            <div key={platform} className="glass-card-sm p-2 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${idx === 0 ? 'bg-cyan-500' : 'bg-gray-400'}`}></div>
                                    <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{platform}</span>
                                </div>
                                <div className="text-xs font-mono" style={{ color: 'var(--cyan)' }}>{count}% Activity</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Latest News */}
                <div>
                    <h5 className="text-xs uppercase font-bold mb-3 tracking-wider" style={{ color: 'var(--text-muted)' }}>Top Stories</h5>
                    <div className="space-y-3">
                        {news.length === 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No news articles available</div>
                        )}
                        {news.slice(0, 6).map((item, i) => (
                            <div key={i} className="group relative glass-card-sm p-3 hover:shadow-md transition-all">
                                <div className={`absolute left-0 top-3 bottom-3 w-1 rounded-r-sm ${
                                    item.sentiment === 'positive' ? 'bg-green-500' :
                                    item.sentiment === 'negative' ? 'bg-red-500' : 'bg-gray-400'
                                }`}></div>
                                <div className="pl-3">
                                    <div className="text-xs mb-1 flex justify-between" style={{ color: 'var(--text-muted)' }}>
                                        <span className="flex items-center gap-1">
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                                                item.sentiment === 'positive' ? 'bg-green-400' :
                                                item.sentiment === 'negative' ? 'bg-red-400' : 'bg-gray-400'
                                            }`}></span>
                                            {item.source}
                                        </span>
                                        <span>{new Date(item.publishedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                    </div>
                                    {hasUrl(item.url) ? (
                                        <a href={item.url} target="_blank" rel="noopener noreferrer"
                                            className="text-sm line-clamp-2 hover:underline flex items-start gap-1"
                                            style={{ color: 'var(--text-primary)' }}
                                        >
                                            <span className="flex-1">{item.title}</span>
                                            <svg className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--text-header)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                            </svg>
                                        </a>
                                    ) : (
                                        <span className="text-sm line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{item.title}</span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
