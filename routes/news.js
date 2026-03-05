/**
 * News API Router
 * Aggregates news from CryptoPanic, Reddit, and DB into a unified feed.
 */

import { Router } from 'express';
import { fetchCryptoNews, fetchCoinGeckoTrending, getSocialSentimentScore } from '../services/socialSentiment.js';
import { getEnhancedTickerSentiment } from '../services/redditSentimentService.js';
import { getJSON, setJSON } from '../services/redisCache.js';

export default function createNewsRouter(ctx) {
  const router = Router();

  // GET /news/feed — aggregated news feed
  router.get('/news/feed', async (req, res) => {
    try {
      const cacheKey = 'news:feed';
      const cached = await getJSON(cacheKey);
      if (cached) return res.json(cached);

      const [cryptoPanic, dbNews] = await Promise.allSettled([
        fetchCryptoNews('all'),
        ctx.db ? getDbNews(ctx.db) : Promise.resolve([]),
      ]);

      const feed = {
        cryptoPanic: cryptoPanic.status === 'fulfilled' ? cryptoPanic.value : [],
        dbNews: dbNews.status === 'fulfilled' ? dbNews.value : [],
        fetchedAt: new Date().toISOString(),
      };

      await setJSON(cacheKey, feed, 120); // cache 2 min
      res.json(feed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /news/trending — CoinGecko trending coins
  router.get('/news/trending', async (req, res) => {
    try {
      const cacheKey = 'news:trending';
      const cached = await getJSON(cacheKey);
      if (cached) return res.json(cached);

      const trending = await fetchCoinGeckoTrending();
      await setJSON(cacheKey, trending, 300); // cache 5 min
      res.json(trending);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /news/sentiment/:ticker — combined sentiment for a ticker
  router.get('/news/sentiment/:ticker', async (req, res) => {
    try {
      const { ticker } = req.params;
      const cacheKey = `news:sentiment:${ticker}`;
      const cached = await getJSON(cacheKey);
      if (cached) return res.json(cached);

      const [reddit, social] = await Promise.allSettled([
        getEnhancedTickerSentiment(ticker.replace('USD', '')),
        getSocialSentimentScore(),
      ]);

      const result = {
        ticker,
        reddit: reddit.status === 'fulfilled' ? reddit.value : null,
        social: social.status === 'fulfilled' ? social.value : null,
        fetchedAt: new Date().toISOString(),
      };

      await setJSON(cacheKey, result, 180); // cache 3 min
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function getDbNews(db) {
  try {
    const rows = db.prepare(
      'SELECT * FROM news_items ORDER BY published_at DESC LIMIT 50'
    ).all();
    return rows;
  } catch {
    return []; // table may not exist
  }
}
