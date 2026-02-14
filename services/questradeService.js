
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// Interval mapping: our shorthand -> Questrade format
const INTERVAL_MAP = {
    '1m': 'OneMinute',
    '2m': 'TwoMinutes',
    '3m': 'ThreeMinutes',
    '5m': 'FiveMinutes',
    '10m': 'TenMinutes',
    '15m': 'FifteenMinutes',
    '20m': 'TwentyMinutes',
    '30m': 'HalfHour',
    '1h': 'OneHour',
    '2h': 'TwoHours',
    '4h': 'FourHours',
    '1d': 'OneDay',
    '1w': 'OneWeek',
    '1M': 'OneMonth',
};

/**
 * Questrade API Service
 * Handles OAuth2 authentication, trading endpoints, and market data
 */
export class QuestradeService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.refreshToken = config.refreshToken || process.env.QUESTRADE_REFRESH_TOKEN;
        this.accessToken = null;
        this.apiUrl = null;
        this.isPractice = config.isPractice ?? false;
        this.tokenPath = path.resolve('./questrade_tokens.json');
        this.tokenExpiry = null;

        // Caches
        this.symbolIdCache = new Map(); // ticker -> symbolId
        this.symbolCache = new Map(); // exchange -> symbols[]
        this.symbolCacheTime = new Map(); // exchange -> timestamp

        // Quote polling
        this.pollInterval = null;
        this.activeSubscriptions = [];

        // Try to load saved tokens
        this.loadTokens();
    }

    loadTokens() {
        try {
            if (fs.existsSync(this.tokenPath)) {
                const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                this.refreshToken = data.refreshToken || this.refreshToken;
                this.accessToken = data.accessToken;
                this.apiUrl = data.apiUrl;
                this.tokenExpiry = data.tokenExpiry;
            }
        } catch (e) {
            console.error('[Questrade] Failed to load tokens:', e.message);
        }
    }

    saveTokens(data) {
        try {
            const tokenData = {
                refreshToken: data.refreshToken,
                accessToken: data.accessToken,
                apiUrl: data.apiUrl,
                tokenExpiry: Date.now() + (data.expiresIn * 1000),
            };
            fs.writeFileSync(this.tokenPath, JSON.stringify(tokenData, null, 2));
            this.refreshToken = tokenData.refreshToken;
            this.accessToken = tokenData.accessToken;
            this.apiUrl = tokenData.apiUrl;
            this.tokenExpiry = tokenData.tokenExpiry;
        } catch (e) {
            console.error('[Questrade] Failed to save tokens:', e.message);
        }
    }

    isAuthenticated() {
        const SAFETY_MARGIN = 60 * 1000; // 1 minute before expiry
        return !!(this.accessToken && this.tokenExpiry && Date.now() < (this.tokenExpiry - SAFETY_MARGIN) && this.apiUrl);
    }

    async authenticate(refreshTokenOverride) {
        if (refreshTokenOverride) {
            this.refreshToken = refreshTokenOverride;
        }

        // If we have a valid access token with safety margin, skip
        if (this.isAuthenticated()) {
            return;
        }

        if (!this.refreshToken) {
            throw new Error('Questrade Refresh Token is missing. Please set QUESTRADE_REFRESH_TOKEN in .env or provide it via the API.');
        }

        const loginUrl = this.isPractice
            ? `https://practicelogin.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${this.refreshToken}`
            : `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${this.refreshToken}`;

        const response = await fetch(loginUrl, { method: 'POST' });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Questrade Authentication Failed: ${err}`);
        }

        const data = await response.json();

        this.saveTokens({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            apiUrl: data.api_server,
            expiresIn: data.expires_in
        });

        console.log(`[Questrade] Authenticated (${this.isPractice ? 'Practice' : 'Live'})`);
        this.emit('status', 'authenticated');
    }

    async request(endpoint, method = 'GET', body = null) {
        await this.authenticate();

        const url = `${this.apiUrl}v1/${endpoint}`;
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Questrade API Error [${endpoint}]: ${response.status} - ${errText}`);
        }

        return response.json();
    }

    // --- Market Data ---

    /**
     * Map our interval shorthand to Questrade format
     */
    mapInterval(interval) {
        return INTERVAL_MAP[interval] || interval;
    }

    /**
     * Normalize Questrade candle format to our internal {o, h, l, c, v, t} format
     */
    normalizeCandles(questradeCandles) {
        if (!questradeCandles || !Array.isArray(questradeCandles)) return [];
        return questradeCandles.map(candle => ({
            t: new Date(candle.start || candle.end).getTime(),
            o: candle.open,
            h: candle.high,
            l: candle.low,
            c: candle.close,
            v: candle.volume,
            vwap: candle.VWAP || candle.vwap || 0,
        }));
    }

    /**
     * Get Candles by symbolId (raw Questrade format)
     */
    async getCandles(symbolId, interval = 'OneMinute', startTime, endTime) {
        const params = new URLSearchParams({
            startTime: startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            endTime: endTime || new Date().toISOString(),
            interval: this.mapInterval(interval)
        });
        const data = await this.request(`markets/candles/${symbolId}?${params}`);
        return data.candles || [];
    }

    /**
     * Get Candles by ticker string (convenience method)
     * Resolves ticker to symbolId, then fetches and normalizes candles
     */
    async getCandlesByTicker(ticker, interval = '1m', startTime, endTime) {
        const symbolId = await this.getSymbolId(ticker);
        const rawCandles = await this.getCandles(symbolId, interval, startTime, endTime);
        return this.normalizeCandles(rawCandles);
    }

    /**
     * Get real-time quote for a symbol
     */
    async getQuote(symbolId) {
        const data = await this.request(`markets/quotes/${symbolId}`);
        return data.quotes ? data.quotes[0] : null;
    }

    /**
     * Get quotes for multiple symbols
     */
    async getQuotes(symbolIds) {
        const ids = Array.isArray(symbolIds) ? symbolIds.join(',') : symbolIds;
        const data = await this.request(`markets/quotes?ids=${ids}`);
        return data.quotes || [];
    }

    /**
     * Get quote by ticker string
     */
    async getQuoteByTicker(ticker) {
        const symbolId = await this.getSymbolId(ticker);
        return this.getQuote(symbolId);
    }

    /**
     * Search for a symbol to get its ID
     */
    async searchSymbol(prefix) {
        const data = await this.request(`symbols/search?prefix=${encodeURIComponent(prefix)}`);
        return data.symbols || [];
    }

    async getSymbolId(ticker) {
        if (this.symbolIdCache.has(ticker)) {
            return this.symbolIdCache.get(ticker);
        }

        const symbols = await this.searchSymbol(ticker);
        const match = symbols.find(s => s.symbol === ticker);
        if (!match) throw new Error(`Symbol ${ticker} not found on Questrade`);

        this.symbolIdCache.set(ticker, match.symbolId);
        return match.symbolId;
    }

    async getSymbolIds(tickers) {
        return Promise.all(tickers.map(t => this.getSymbolId(t)));
    }

    /**
     * Get symbols for a specific exchange (cached for 1 hour)
     */
    async getSymbolsByExchange(exchange) {
        const cacheKey = exchange;
        const cachedTime = this.symbolCacheTime.get(cacheKey) || 0;

        if (Date.now() - cachedTime < 3600000 && this.symbolCache.has(cacheKey)) {
            return this.symbolCache.get(cacheKey);
        }

        // Questrade doesn't have a direct "list by exchange" endpoint,
        // so we search with common prefixes and filter by exchange
        const commonPrefixes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
                                'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

        // Only search a few popular prefixes to avoid rate limits
        const topPrefixes = ['SH', 'TD', 'RY', 'BN', 'CN', 'CP', 'ENB', 'BMO', 'BB', 'AC'];
        const allSymbols = [];

        for (const prefix of topPrefixes) {
            try {
                const symbols = await this.searchSymbol(prefix);
                const filtered = symbols.filter(s =>
                    s.listingExchange === exchange && s.securityType === 'Stock'
                );
                allSymbols.push(...filtered);
            } catch (e) {
                // Skip failed searches
            }
        }

        // Dedupe by symbolId
        const seen = new Set();
        const unique = allSymbols.filter(s => {
            if (seen.has(s.symbolId)) return false;
            seen.add(s.symbolId);
            return true;
        });

        this.symbolCache.set(cacheKey, unique);
        this.symbolCacheTime.set(cacheKey, Date.now());
        return unique;
    }

    // --- Account & Trading ---

    async getAccounts() {
        const data = await this.request('accounts');
        return data.accounts || [];
    }

    async getBalance(accountId) {
        const data = await this.request(`accounts/${accountId}/balances`);
        return data;
    }

    async getPositions(accountId) {
        const data = await this.request(`accounts/${accountId}/positions`);
        return data.positions || [];
    }

    async placeOrder(accountId, order) {
        return this.request(`accounts/${accountId}/orders`, 'POST', order);
    }

    async getOrders(accountId) {
        const data = await this.request(`accounts/${accountId}/orders`);
        return data.orders || [];
    }

    // --- Real-time Quotes (Polling) ---

    async subscribeQuotes(symbolIds) {
        this.activeSubscriptions = symbolIds;

        if (this.pollInterval) clearInterval(this.pollInterval);

        this.pollInterval = setInterval(async () => {
            try {
                const quotes = await this.getQuotes(symbolIds);
                quotes.forEach(quote => {
                    this.emit('quote', quote);
                });
            } catch (e) {
                console.error('[Questrade] Quote polling error:', e.message);
            }
        }, 1000);
    }

    /**
     * Get connection status
     */
    getStatus() {
        return {
            isAuthenticated: this.isAuthenticated(),
            isPractice: this.isPractice,
            apiUrl: this.apiUrl,
            tokenExpiry: this.tokenExpiry,
            symbolsCached: this.symbolIdCache.size,
        };
    }

    close() {
        if (this.pollInterval) clearInterval(this.pollInterval);
    }
}
