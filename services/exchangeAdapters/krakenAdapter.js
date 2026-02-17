/**
 * Kraken Exchange Adapter
 * CSA-registered for Canadian users. REST API v0.
 * Public endpoints: /0/public/OHLC, /0/public/AssetPairs, /0/public/Ticker
 * Private endpoints: /0/private/Balance, /0/private/AddOrder
 */
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { BaseExchangeAdapter } from './baseAdapter.js';

const KRAKEN_BASE_URL = 'https://api.kraken.com';

// Timeframe mapping: internal → Kraken interval (minutes)
const TIMEFRAME_MAP = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
    '1D': 1440,
    '1d': 1440,
    '1W': 10080,
    '1w': 10080,
};

function toKrakenPair(ticker) {
    // BTCUSD → XBTUSD (Kraken REST API format)
    let pair = ticker.replace(/[_\/]/g, '');
    if (pair.startsWith('BTC')) {
        pair = 'XBT' + pair.slice(3);
    }
    return pair;
}

function fromKrakenPair(krakenPair) {
    let pair = krakenPair;
    // Remove X prefix for crypto and Z prefix for fiat
    pair = pair.replace(/^X{1,2}/, '').replace(/Z(?=USD|CAD|EUR|GBP)/, '');
    pair = pair.replace('XBT', 'BTC');
    return pair;
}

async function krakenPublicRequest(endpoint, params = {}) {
    const url = new URL(`${KRAKEN_BASE_URL}/0/public/${endpoint}`);
    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, String(val));
    }

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.error && data.error.length > 0) {
        throw new Error(`Kraken API Error: ${data.error.join(', ')}`);
    }
    return data.result;
}

function createKrakenSignature(path, nonce, postData, secret) {
    const message = nonce + postData;
    const hash = crypto.createHash('sha256').update(message).digest();
    const secretBuffer = Buffer.from(secret, 'base64');
    const hmac = crypto.createHmac('sha512', secretBuffer);
    hmac.update(Buffer.concat([Buffer.from(path), hash]));
    return hmac.digest('base64');
}

async function krakenPrivateRequest(endpoint, params = {}) {
    const apiKey = process.env.KRAKEN_API_KEY;
    const secret = process.env.KRAKEN_SECRET;

    if (!apiKey || !secret) {
        throw new Error('Kraken API credentials not configured. Set KRAKEN_API_KEY and KRAKEN_SECRET.');
    }

    const path = `/0/private/${endpoint}`;
    const nonce = Date.now() * 1000;
    const postParams = { ...params, nonce };
    const postData = new URLSearchParams(postParams).toString();
    const signature = createKrakenSignature(path, String(nonce), postData, secret);

    const response = await fetch(`${KRAKEN_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'API-Key': apiKey,
            'API-Sign': signature,
        },
        body: postData,
    });

    const data = await response.json();

    if (data.error && data.error.length > 0) {
        throw new Error(`Kraken API Error: ${data.error.join(', ')}`);
    }
    return data.result;
}

export class KrakenAdapter extends BaseExchangeAdapter {
    getName() {
        return 'kraken';
    }

    formatTicker(ticker) {
        return toKrakenPair(ticker);
    }

    parseTicker(pair) {
        return fromKrakenPair(pair);
    }

    async getCandles(ticker, timeframe = '1m', limit = 200) {
        const pair = toKrakenPair(ticker);
        const interval = TIMEFRAME_MAP[timeframe] || 1;

        // Kraken uses 'since' timestamp. Calculate from limit.
        const sinceSeconds = Math.floor(Date.now() / 1000) - (limit * interval * 60);

        const result = await krakenPublicRequest('OHLC', {
            pair,
            interval,
            since: sinceSeconds,
        });

        // Result keys are the Kraken pair name — skip the 'last' key
        const keys = Object.keys(result).filter(k => k !== 'last');
        const candles = result[keys[0]] || [];

        // Kraken format: [time, open, high, low, close, vwap, volume, count]
        // Normalize to: {t, o, h, l, c, v}
        return candles.map(c => ({
            t: c[0] * 1000, // Kraken returns seconds, we use ms
            o: parseFloat(c[1]),
            h: parseFloat(c[2]),
            l: parseFloat(c[3]),
            c: parseFloat(c[4]),
            v: parseFloat(c[6]),
        }));
    }

    async getInstruments() {
        const result = await krakenPublicRequest('AssetPairs');

        const instruments = [];
        for (const [pairName, info] of Object.entries(result)) {
            if (pairName.includes('.d')) continue; // Skip dark pool pairs

            const base = (info.base || '').replace(/^X/, '').replace('XBT', 'BTC');
            const quote = (info.quote || '').replace(/^Z/, '');

            // Only include USD pairs (Canadian compliance)
            if (quote === 'USD') {
                instruments.push({
                    instrument_name: `${base}USD`,
                    base_currency: base,
                    quote_currency: quote,
                    price_decimals: info.pair_decimals || 2,
                    quantity_decimals: info.lot_decimals || 8,
                });
            }
        }

        return { data: instruments };
    }

    async getBalance(sessionId) {
        const result = await krakenPrivateRequest('Balance');

        let cashBalance = 0;
        const holdings = {};

        for (const [asset, balance] of Object.entries(result)) {
            const qty = parseFloat(balance);
            if (qty <= 0) continue;

            const normalized = asset.replace(/^X/, '').replace(/^Z/, '').replace('XBT', 'BTC');

            if (normalized === 'USD' || asset === 'ZUSD') {
                cashBalance += qty;
            } else {
                holdings[normalized] = { quantity: qty, usdValue: 0 };
            }
        }

        return { cashBalance, holdings };
    }

    async placeBuyOrder(ticker, notional, sessionId) {
        const pair = toKrakenPair(ticker);
        // Get current price to calculate volume
        const tickerResult = await krakenPublicRequest('Ticker', { pair });
        const tickerKey = Object.keys(tickerResult)[0];
        const currentPrice = parseFloat(tickerResult[tickerKey]?.a?.[0] || '0');

        if (currentPrice <= 0) {
            throw new Error(`Could not get price for ${ticker}`);
        }

        const volume = (notional / currentPrice).toFixed(8);

        const result = await krakenPrivateRequest('AddOrder', {
            pair,
            type: 'buy',
            ordertype: 'market',
            volume,
        });

        return {
            quantity: parseFloat(volume),
            avgPrice: currentPrice,
            orderId: result.txid?.[0] || '',
            raw: result,
        };
    }

    async placeSellOrder(ticker, quantity, sessionId, instrumentSpecs) {
        const pair = toKrakenPair(ticker);
        const volume = quantity.toFixed(8);

        const result = await krakenPrivateRequest('AddOrder', {
            pair,
            type: 'sell',
            ordertype: 'market',
            volume,
        });

        const tickerResult = await krakenPublicRequest('Ticker', { pair });
        const tickerKey = Object.keys(tickerResult)[0];
        const currentPrice = parseFloat(tickerResult[tickerKey]?.b?.[0] || '0');

        return {
            avgPrice: currentPrice,
            filledQuantity: quantity,
            orderId: result.txid?.[0] || '',
            raw: result,
        };
    }

    getFeePercent() {
        return 0.0026; // 0.26% per side (Kraken base tier)
    }
}

export const krakenAdapter = new KrakenAdapter();
export { krakenPublicRequest, krakenPrivateRequest };
