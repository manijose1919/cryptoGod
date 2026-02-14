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
        // Mock fetch for now - in a real app this would hit your backend
        // We'll simulate fetching the data produced by the backend service
        const fetchNews = async () => {
            setLoading(true);
            try {
                // In a real implementation, you'd have an endpoint like /api/news-analysis
                // For this demo, we'll simulate the response structure
                // based on what we implemented in the backend services
                
                // Simulate delay
                await new Promise(r => setTimeout(r, 800));

                const mockNews: NewsItem[] = [
                    { title: `${ticker} surges 10% following ETF rumors`, source: 'CoinDesk', publishedAt: new Date().toISOString(), sentiment: 'positive', url: '#' },
                    { title: `Analysts predict ${ticker} breakout`, source: 'CoinTelegraph', publishedAt: new Date(Date.now() - 3600000).toISOString(), sentiment: 'positive', url: '#' },
                    { title: `Market analysis: ${ticker} support levels hold`, source: 'Decrypt', publishedAt: new Date(Date.now() - 7200000).toISOString(), sentiment: 'neutral', url: '#' },
                    { title: `Regulatory concerns impact ${ticker} volume`, source: 'Reuters', publishedAt: new Date(Date.now() - 10800000).toISOString(), sentiment: 'negative', url: '#' },
                    { title: `${ticker} ecosystem growth accelerates`, source: 'The Block', publishedAt: new Date(Date.now() - 14400000).toISOString(), sentiment: 'positive', url: '#' },
                ];

                const mockPlatforms = {
                    'Twitter': 45,
                    'Reddit': 30,
                    'YouTube': 15,
                    'Discord': 10
                };

                setNews(mockNews);
                setTrendingPlatforms(mockPlatforms);
            } catch (e) {
                console.error("Failed to fetch news", e);
            } finally {
                setLoading(false);
            }
        };

        fetchNews();
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
