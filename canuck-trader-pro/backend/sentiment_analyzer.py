"""
Sentiment Analyzer
Fetches crypto news headlines and scores them with local VADER + crypto lexicon.
No external AI API calls.
"""
import logging
import time
from typing import Dict, List

import requests

import config
from local_ai import LocalAI

logger = logging.getLogger(__name__)


class SentimentAnalyzer:
    """Fetches news and produces sentiment scores per asset using local NLP."""

    def __init__(self, ai: LocalAI):
        self.ai = ai
        self._cache: Dict[str, dict] = {}  # symbol -> {score, summary, timestamp}
        self._cache_ttl = 300  # 5 minutes
        self._headlines_cache: List[dict] = []
        self._headlines_ts = 0.0

    def _fetch_headlines(self) -> List[dict]:
        """Fetch latest crypto news headlines from CryptoCompare."""
        now = time.time()
        if self._headlines_cache and (now - self._headlines_ts) < self._cache_ttl:
            return self._headlines_cache

        all_articles = []
        for url in config.NEWS_SOURCES:
            try:
                resp = requests.get(url, timeout=10)
                resp.raise_for_status()
                data = resp.json()
                articles = data.get("Data", [])
                all_articles.extend(articles)
            except Exception as e:
                logger.warning(f"Error fetching news from {url}: {e}")

        self._headlines_cache = all_articles
        self._headlines_ts = now
        return all_articles

    def _filter_headlines_for_symbol(self, articles: List[dict], symbol: str) -> List[str]:
        """Filter headlines relevant to a specific symbol."""
        base = symbol.split("/")[0].upper()
        name_map = {
            "BTC": ["bitcoin", "btc"],
            "ETH": ["ethereum", "eth", "ether"],
            "XRP": ["ripple", "xrp"],
            "BNB": ["binance", "bnb"],
            "SOL": ["solana", "sol"],
            "ADA": ["cardano", "ada"],
            "DOGE": ["dogecoin", "doge"],
            "LINK": ["chainlink", "link"],
            "DOT": ["polkadot", "dot"],
            "AVAX": ["avalanche", "avax"],
        }
        keywords = name_map.get(base, [base.lower()])

        relevant = []
        for article in articles:
            title = article.get("title", "").lower()
            body = article.get("body", "").lower()
            text = title + " " + body
            if any(kw in text for kw in keywords):
                relevant.append(article.get("title", ""))

        if not relevant:
            relevant = [a.get("title", "") for a in articles[:5]]

        return relevant[:15]

    def get_sentiment(self, symbol: str) -> dict:
        """Get sentiment score for a symbol. Returns {score: -100..100, summary: str}."""
        now = time.time()

        if symbol in self._cache:
            cached = self._cache[symbol]
            if now - cached.get("timestamp", 0) < self._cache_ttl:
                return cached

        articles = self._fetch_headlines()
        headlines = self._filter_headlines_for_symbol(articles, symbol)

        # Score locally with VADER + crypto lexicon
        result = self.ai.score_sentiment(headlines, symbol)

        result["timestamp"] = now
        self._cache[symbol] = result
        return result

    def get_all_sentiments(self) -> Dict[str, dict]:
        """Get sentiment for all configured pairs."""
        sentiments = {}
        for symbol in config.PAIRS:
            sentiments[symbol] = self.get_sentiment(symbol)
        return sentiments

    def get_market_mood(self) -> str:
        """Overall market mood based on average sentiment."""
        sentiments = self.get_all_sentiments()
        scores = [s.get("score", 0) for s in sentiments.values()]
        if not scores:
            return "NEUTRAL"
        avg = sum(scores) / len(scores)
        if avg > 30:
            return "BULLISH"
        elif avg > 10:
            return "SLIGHTLY_BULLISH"
        elif avg < -30:
            return "BEARISH"
        elif avg < -10:
            return "SLIGHTLY_BEARISH"
        return "NEUTRAL"
