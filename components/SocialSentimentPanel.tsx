/**
 * SocialSentimentPanel — Displays live social sentiment data:
 * Fear & Greed index, CryptoPanic headlines, CoinGecko trending, per-position sentiment.
 */

import { useEffect, useState } from 'react';

interface Headline {
  title: string;
  source: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  publishedAt: string;
}

interface TrendingCoin {
  name: string;
  symbol: string;
  marketCapRank: number;
  score: number;
  krakenTicker: string;
  onKraken: boolean;
}

interface TickerSentiment {
  sentiment: number;
  mentionCount: number;
  headlines: string[];
}

interface SentimentDashboard {
  fearGreed: { value: number; classification: string };
  topHeadlines: Headline[];
  trendingCoins: TrendingCoin[];
  positionSentiments: Record<string, TickerSentiment>;
  lastUpdated: number;
}

const FG_COLORS: Record<string, string> = {
  'Extreme Fear': 'text-red-400',
  'Fear': 'text-orange-400',
  'Neutral': 'text-slate-300',
  'Greed': 'text-green-400',
  'Extreme Greed': 'text-emerald-400',
};

const SENTIMENT_COLORS = {
  positive: 'text-green-400',
  negative: 'text-red-400',
  neutral: 'text-slate-400',
};

export default function SocialSentimentPanel() {
  const [data, setData] = useState<SentimentDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSentiment() {
      try {
        const res = await fetch('/api/sentiment/dashboard');
        const json = await res.json();
        if (json && !json.error) setData(json);
      } catch { /* fail silently */ }
      setLoading(false);
    }

    fetchSentiment();
    const interval = setInterval(fetchSentiment, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="glass-card-sm p-4 text-slate-400 text-sm">Loading sentiment...</div>;
  if (!data) return <div className="glass-card-sm p-4 text-slate-500 text-sm">Sentiment data unavailable</div>;

  const fgColor = FG_COLORS[data.fearGreed.classification] || 'text-slate-300';
  const positionTickers = Object.keys(data.positionSentiments);

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="text-sm font-bold text-slate-200">Social Sentiment</h3>

      {/* Fear & Greed */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400">Fear & Greed:</span>
        <span className={`text-lg font-bold ${fgColor}`}>{data.fearGreed.value}</span>
        <span className={`text-xs ${fgColor}`}>{data.fearGreed.classification}</span>
        <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden ml-2">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${data.fearGreed.value}%`,
              background: data.fearGreed.value <= 30 ? '#ef4444' :
                           data.fearGreed.value <= 50 ? '#f59e0b' :
                           data.fearGreed.value <= 70 ? '#22c55e' : '#10b981',
            }}
          />
        </div>
      </div>

      {/* Top Headlines */}
      {data.topHeadlines.length > 0 && (
        <div>
          <div className="text-xs text-slate-400 mb-1">Top Headlines</div>
          <div className="space-y-1">
            {data.topHeadlines.map((h, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 ${SENTIMENT_COLORS[h.sentiment]}`}>
                  {h.sentiment === 'positive' ? '+' : h.sentiment === 'negative' ? '-' : '~'}
                </span>
                <span className="text-slate-300 leading-tight">{h.title}</span>
                <span className="text-slate-600 shrink-0">{h.source}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trending Coins */}
      {data.trendingCoins.length > 0 && (
        <div>
          <div className="text-xs text-slate-400 mb-1">Trending (CoinGecko)</div>
          <div className="flex flex-wrap gap-1.5">
            {data.trendingCoins.slice(0, 10).map((c, i) => (
              <span
                key={i}
                className={`text-xs px-2 py-0.5 rounded-full ${
                  c.onKraken
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : 'bg-slate-700/50 text-slate-400'
                }`}
                title={`${c.name} — Rank #${c.marketCapRank || '?'}`}
              >
                {c.symbol}
                {c.onKraken && <span className="ml-1 text-blue-400">K</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Per-Position Sentiment */}
      {positionTickers.length > 0 && (
        <div>
          <div className="text-xs text-slate-400 mb-1">Position Sentiment</div>
          <div className="grid grid-cols-2 gap-1.5">
            {positionTickers.map((ticker) => {
              const s = data.positionSentiments[ticker];
              const color = s.sentiment > 0.1 ? 'text-green-400' :
                            s.sentiment < -0.1 ? 'text-red-400' : 'text-slate-400';
              return (
                <div key={ticker} className="flex items-center justify-between text-xs bg-slate-800/40 rounded px-2 py-1">
                  <span className="text-slate-300 font-medium">{ticker.replace('USD', '')}</span>
                  <span className={color}>
                    {s.sentiment > 0 ? '+' : ''}{(s.sentiment * 100).toFixed(0)}%
                    <span className="text-slate-500 ml-1">({s.mentionCount})</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="text-[10px] text-slate-600 text-right">
        Updated {new Date(data.lastUpdated).toLocaleTimeString()}
      </div>
    </div>
  );
}
