
import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card"; // Assuming shadcn/ui or similar exists, or I will use standard divs if not sure. 
// Actually, looking at existing files, they are just .tsx files. I'll use standard Tailwind classes.

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3033/api';

interface Thought {
    time: number;
    type: string;
    asset: string;
    decision: string;
    confidence: number;
    risk: string;
    reasoning: string;
}

interface FeedItem {
    source: string;
    title: string;
    url: string;
    type: 'news' | 'social';
    publishedAt: number;
}

export const LiveFeed: React.FC = () => {
    const [thoughts, setThoughts] = useState<Thought[]>([]);
    const [feeds, setFeeds] = useState<FeedItem[]>([]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const thoughtsRes = await fetch(`${API_BASE_URL}/brain/thoughts`);
                const thoughtsData = await thoughtsRes.json();
                setThoughts(thoughtsData);

                const feedsRes = await fetch(`${API_BASE_URL}/feeds/live`);
                const feedsData = await feedsRes.json();
                setFeeds(feedsData);
            } catch (e) {
                console.error("Failed to fetch live feed data", e);
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 5000); // Poll every 5s
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 text-white">
            {/* Brain Thoughts Panel */}
            <div className="bg-gray-900 rounded-lg border border-gray-700 p-4 h-96 overflow-y-auto">
                <h2 className="text-xl font-bold mb-4 text-purple-400">AI Brain Activity</h2>
                <div className="space-y-3">
                    {thoughts.length === 0 && <p className="text-gray-500">Brain is initializing...</p>}
                    {thoughts.map((t, i) => (
                        <div key={i} className="bg-gray-800 p-3 rounded border-l-4 border-purple-500">
                            <div className="flex justify-between text-xs text-gray-400">
                                <span>{new Date(t.time).toLocaleTimeString()}</span>
                                <span>{t.type}</span>
                            </div>
                            <div className="font-bold text-lg text-white">
                                {t.asset}: <span className={t.decision === 'YES' ? 'text-green-400' : 'text-yellow-400'}>{t.decision}</span>
                            </div>
                            <div className="text-sm text-gray-300 mt-1">{t.reasoning}</div>
                            <div className="flex gap-2 mt-2 text-xs">
                                <span className="bg-gray-700 px-2 py-1 rounded">Conf: {t.confidence}%</span>
                                <span className={`px-2 py-1 rounded ${t.risk === 'High' ? 'bg-red-900' : 'bg-green-900'}`}>Risk: {t.risk}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Live Data Feed Panel */}
            <div className="bg-gray-900 rounded-lg border border-gray-700 p-4 h-96 overflow-y-auto">
                <h2 className="text-xl font-bold mb-4 text-blue-400">Live Market Intelligence</h2>
                <div className="space-y-3">
                    {feeds.length === 0 && <p className="text-gray-500">Connecting to feeds...</p>}
                    {feeds.map((f, i) => (
                        <div key={i} className="bg-gray-800 p-3 rounded hover:bg-gray-700 transition">
                            <div className="flex justify-between text-xs text-gray-400 mb-1">
                                <span className="uppercase font-bold text-blue-300">{f.source}</span>
                                <span>{new Date(f.publishedAt).toLocaleTimeString()}</span>
                            </div>
                            <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-white hover:text-blue-300 font-medium block">
                                {f.title}
                            </a>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
