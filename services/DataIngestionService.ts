
import fetch from 'node-fetch';
import { EventEmitter } from 'events';

// Configuration for external APIs
const CONFIG = {
    NEWS_API_KEY: process.env.NEWS_API_KEY,
    ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY,
    REDDIT_USER_AGENT: 'web:trading-dashboard:v1.0 (by /u/GeminiBot)',
};

/**
 * Data Ingestion Service
 * Aggregates data from Social Media, News, RSS, and Financial APIs.
 */
export class DataIngestionService extends EventEmitter {
    constructor() {
        super();
        this.feeds = [
            { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', type: 'rss' },
            { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss', type: 'rss' },
            { name: 'Reddit/WSB', url: 'https://www.reddit.com/r/wallstreetbets/new/.json?limit=25', type: 'reddit' },
            { name: 'Reddit/Stocks', url: 'https://www.reddit.com/r/stocks/new/.json?limit=25', type: 'reddit' },
        ];
        this.cache = new Map();
    }

    /**
     * Fetch all configured feeds
     */
    async fetchAllFeeds() {
        const results = await Promise.allSettled(this.feeds.map(feed => this.fetchFeed(feed)));
        const items = results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value);
        
        // Emit new items
        this.emit('data', items);
        return items;
    }

    async fetchFeed(feed) {
        try {
            if (feed.type === 'rss') {
                return await this.fetchRSS(feed);
            } else if (feed.type === 'reddit') {
                return await this.fetchReddit(feed);
            }
        } catch (e) {
            console.error(`Error fetching feed ${feed.name}:`, e.message);
            return [];
        }
    }

    async fetchRSS(feed) {
        const res = await fetch(feed.url);
        const text = await res.text();
        
        // Simple Regex RSS Parser (robust enough for standard feeds)
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        
        while ((match = itemRegex.exec(text)) !== null) {
            const content = match[1];
            const titleMatch = /<title>(.*?)<\/title>/.exec(content);
            const linkMatch = /<link>(.*?)<\/link>/.exec(content);
            const descMatch = /<description>([\s\S]*?)<\/description>/.exec(content);
            const dateMatch = /<pubDate>(.*?)<\/pubDate>/.exec(content);

            if (titleMatch) {
                // Clean CDATA
                const title = titleMatch[1].replace('<![CDATA[', '').replace(']]>', '');
                const description = descMatch ? descMatch[1].replace('<![CDATA[', '').replace(']]>', '') : '';
                
                items.push({
                    source: feed.name,
                    type: 'news',
                    title,
                    url: linkMatch ? linkMatch[1] : '',
                    description: description.replace(/<[^>]*>?/gm, '').slice(0, 200) + '...', // Strip HTML
                    publishedAt: dateMatch ? new Date(dateMatch[1]).getTime() : Date.now()
                });
            }
        }
        return items.slice(0, 10);
    }

    async fetchReddit(feed) {
        const res = await fetch(feed.url, {
            headers: { 'User-Agent': CONFIG.REDDIT_USER_AGENT }
        });
        
        if (!res.ok) return [];
        
        const data = await res.json();
        return data.data.children.map(child => ({
            source: feed.name,
            type: 'social',
            title: child.data.title,
            url: `https://reddit.com${child.data.permalink}`,
            description: child.data.selftext ? child.data.selftext.slice(0, 200) + '...' : '',
            score: child.data.score,
            comments: child.data.num_comments,
            publishedAt: child.data.created_utc * 1000
        }));
    }

    /**
     * Search NewsAPI (Requires Key)
     */
    async searchNews(query) {
        if (!CONFIG.NEWS_API_KEY) return [];
        
        const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&apiKey=${CONFIG.NEWS_API_KEY}&language=en&sortBy=publishedAt&pageSize=10`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.status !== 'ok') return [];
        
        return data.articles.map(a => ({
            source: a.source.name,
            type: 'news',
            title: a.title,
            url: a.url,
            description: a.description,
            publishedAt: new Date(a.publishedAt).getTime()
        }));
    }

    /**
     * Get Alpha Vantage Market Sentiment
     */
    async getAlphaVantageSentiment(ticker) {
        if (!CONFIG.ALPHA_VANTAGE_KEY) return null;
        
        const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${ticker}&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        
        // AV returns a feed, we just want summary sentiment
        if (!data.feed) return null;
        
        // Simple aggregation
        let score = 0;
        let count = 0;
        
        for (const item of data.feed) {
            const tickerSentiment = item.ticker_sentiment.find(t => t.ticker === ticker);
            if (tickerSentiment) {
                score += parseFloat(tickerSentiment.ticker_sentiment_score);
                count++;
            }
        }
        
        return count > 0 ? score / count : 0;
    }
}

export const dataIngestion = new DataIngestionService();
