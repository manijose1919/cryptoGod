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

// Session manager reference (set via init)
let _SessionManager = null;

export function setKrakenSessionManager(sm) {
    _SessionManager = sm;
}

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

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
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

async function krakenPrivateRequest(endpoint, params = {}, sessionId = null) {
    let apiKey, secret;

    // First: try session-based credentials (from user login)
    if (sessionId && _SessionManager) {
        const session = _SessionManager.getSession(sessionId);
        if (session) {
            apiKey = session.apiKey;
            secret = session.secretKey;
        }
    }

    // Fallback: environment variables
    if (!apiKey || !secret) {
        apiKey = process.env.KRAKEN_API_KEY;
        secret = process.env.KRAKEN_SECRET;
    }

    if (!apiKey || !secret) {
        throw new Error('Kraken API credentials not available. Please authenticate first.');
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
        signal: AbortSignal.timeout(15000),
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
        const result = await krakenPrivateRequest('Balance', {}, sessionId);
        console.log('[Kraken] Raw balance response:', JSON.stringify(result));

        let cashBalance = 0;
        let cadBalance = 0;
        const holdings = {};

        for (const [asset, balance] of Object.entries(result)) {
            const qty = parseFloat(balance);
            if (qty <= 0) continue;

            // Normalize: strip X prefix (crypto), Z prefix (fiat), XBT→BTC
            // Also handle staked/flex suffixes: ETH2.S → ETH, CAD.F → CAD, DOT.S → DOT
            let normalized = asset.replace(/^X/, '').replace(/^Z/, '').replace('XBT', 'BTC');
            const baseAsset = normalized.replace(/[\d]*\.[A-Z]+$/, '');  // Strip any suffix like .S .F .M .HOLD

            console.log(`[Kraken] Asset: ${asset} → normalized: ${normalized}, base: ${baseAsset}, qty: ${qty}`);

            // Check fiat using baseAsset (handles ZCAD, CAD, CAD.F, CAD.S, USD.F, etc.)
            if (baseAsset === 'USD' || asset === 'ZUSD') {
                cashBalance += qty;
            } else if (baseAsset === 'CAD' || asset === 'ZCAD') {
                cadBalance += qty;
            } else if (baseAsset === 'EUR' || baseAsset === 'GBP') {
                // Skip other fiat for now
            } else {
                // Merge staked + unstaked into same base asset
                if (holdings[baseAsset]) {
                    holdings[baseAsset].quantity += qty;
                } else {
                    holdings[baseAsset] = { quantity: qty, usdValue: 0 };
                }
            }
        }

        // Look up current prices for all crypto holdings
        const cryptoAssets = Object.keys(holdings);
        if (cryptoAssets.length > 0) {
            for (const asset of cryptoAssets) {
                try {
                    // Try USD pair first
                    const pair = toKrakenPair(asset + 'USD');
                    const tickerResult = await krakenPublicRequest('Ticker', { pair });
                    for (const [, data] of Object.entries(tickerResult)) {
                        const price = parseFloat(data.c?.[0] || '0');
                        if (price > 0) {
                            holdings[asset].usdValue = holdings[asset].quantity * price;
                            holdings[asset].price = price;
                        }
                    }
                } catch (e) {
                    console.warn(`[Kraken] USD price failed for ${asset}: ${e.message}, trying CAD...`);
                    // Fallback: try CAD pair and convert (~0.72 USD/CAD)
                    try {
                        const cadPair = toKrakenPair(asset + 'CAD');
                        const cadResult = await krakenPublicRequest('Ticker', { pair: cadPair });
                        for (const [, data] of Object.entries(cadResult)) {
                            const cadPrice = parseFloat(data.c?.[0] || '0');
                            if (cadPrice > 0) {
                                // Also fetch USD/CAD rate for accurate conversion
                                let usdCadRate = 1.38; // fallback estimate
                                try {
                                    const fxResult = await krakenPublicRequest('Ticker', { pair: 'USDCAD' });
                                    for (const [, fxData] of Object.entries(fxResult)) {
                                        const rate = parseFloat(fxData.c?.[0] || '0');
                                        if (rate > 0) usdCadRate = rate;
                                    }
                                } catch { /* use fallback rate */ }
                                const usdPrice = cadPrice / usdCadRate;
                                holdings[asset].usdValue = holdings[asset].quantity * usdPrice;
                                holdings[asset].price = usdPrice;
                                console.log(`[Kraken] ${asset} priced via CAD: ${cadPrice} CAD → ${usdPrice.toFixed(2)} USD`);
                            }
                        }
                    } catch (e2) {
                        console.warn(`[Kraken] CAD price also failed for ${asset}: ${e2.message}`);
                    }
                }
            }
        }

        // Convert CAD balance to USD and add to cash
        if (cadBalance > 0) {
            let usdCadRate = 1.38; // fallback
            try {
                const fxResult = await krakenPublicRequest('Ticker', { pair: 'USDCAD' });
                for (const [, data] of Object.entries(fxResult)) {
                    const rate = parseFloat(data.c?.[0] || '0');
                    if (rate > 0) usdCadRate = rate;
                }
            } catch { /* use fallback rate */ }
            const cadInUsd = cadBalance / usdCadRate;
            console.log(`[Kraken] CAD balance: ${cadBalance} CAD → ${cadInUsd.toFixed(2)} USD (rate: ${usdCadRate})`);
            cashBalance += cadInUsd;
        }

        console.log('[Kraken] Final balance:', { cashBalance, holdings });
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
        }, sessionId);

        const orderId = result.txid?.[0] || '';

        // Query actual fill price (market orders fill immediately on Kraken)
        let avgPrice = currentPrice;
        let filledQty = parseFloat(volume);
        if (orderId) {
            try {
                await new Promise(r => setTimeout(r, 500)); // Brief wait for fill to register
                const status = await this.getOrderStatus(orderId, sessionId);
                if (status.avgPrice > 0) avgPrice = status.avgPrice;
                if (status.filledQty > 0) filledQty = status.filledQty;
            } catch (e) {
                // Fall back to estimated price
            }
        }

        return {
            quantity: filledQty,
            avgPrice,
            orderId,
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
        }, sessionId);

        const orderId = result.txid?.[0] || '';

        // Query actual fill price instead of using stale ticker price
        let avgPrice = 0;
        let filledQuantity = quantity;
        if (orderId) {
            try {
                await new Promise(r => setTimeout(r, 500));
                const status = await this.getOrderStatus(orderId, sessionId);
                if (status.avgPrice > 0) avgPrice = status.avgPrice;
                if (status.filledQty > 0) filledQuantity = status.filledQty;
            } catch (e) {
                // Fall back to ticker price
            }
        }

        // Fallback: fetch current bid if order status didn't return a price
        if (avgPrice <= 0) {
            const tickerResult = await krakenPublicRequest('Ticker', { pair });
            const tickerKey = Object.keys(tickerResult)[0];
            avgPrice = parseFloat(tickerResult[tickerKey]?.b?.[0] || '0');
        }

        return {
            avgPrice,
            filledQuantity,
            orderId,
            raw: result,
        };
    }

    getFeePercent() {
        return 0.0026; // 0.26% taker fee per side (Kraken base tier)
    }

    getMakerFeePercent() {
        return 0.0016; // 0.16% maker fee per side (Kraken base tier)
    }

    /**
     * Place a limit buy order at a specific price.
     * Maker fee (0.16%) vs taker (0.26%) = significant savings.
     */
    async placeLimitBuyOrder(ticker, price, volume, sessionId) {
        const pair = toKrakenPair(ticker);

        const result = await krakenPrivateRequest('AddOrder', {
            pair,
            type: 'buy',
            ordertype: 'limit',
            price: price.toFixed(8),
            volume: volume.toFixed(8),
        }, sessionId);

        return {
            orderId: result.txid?.[0] || '',
            ticker,
            side: 'buy',
            price,
            volume: parseFloat(volume),
            status: 'open',
            raw: result,
        };
    }

    /**
     * Place a limit sell order at a specific price.
     */
    async placeLimitSellOrder(ticker, price, volume, sessionId) {
        const pair = toKrakenPair(ticker);

        const result = await krakenPrivateRequest('AddOrder', {
            pair,
            type: 'sell',
            ordertype: 'limit',
            price: price.toFixed(8),
            volume: volume.toFixed(8),
        }, sessionId);

        return {
            orderId: result.txid?.[0] || '',
            ticker,
            side: 'sell',
            price,
            volume: parseFloat(volume),
            status: 'open',
            raw: result,
        };
    }

    /**
     * Get all open orders.
     */
    async getOpenOrders(sessionId) {
        const result = await krakenPrivateRequest('OpenOrders', {}, sessionId);
        const orders = [];

        for (const [txid, order] of Object.entries(result.open || {})) {
            const descr = order.descr || {};
            orders.push({
                orderId: txid,
                ticker: fromKrakenPair(descr.pair || ''),
                side: descr.type || '',
                price: parseFloat(descr.price || '0'),
                volume: parseFloat(order.vol || '0'),
                filledVolume: parseFloat(order.vol_exec || '0'),
                status: order.status || 'open',
                openTime: order.opentm ? order.opentm * 1000 : 0,
            });
        }

        return orders;
    }

    /**
     * Cancel an open order by transaction ID.
     */
    async cancelOrder(orderId, sessionId) {
        const result = await krakenPrivateRequest('CancelOrder', {
            txid: orderId,
        }, sessionId);

        return {
            success: true,
            orderId,
            count: result.count || 0,
        };
    }

    /**
     * Query a specific order's status.
     */
    async getOrderStatus(orderId, sessionId) {
        const result = await krakenPrivateRequest('QueryOrders', {
            txid: orderId,
        }, sessionId);

        const order = result[orderId];
        if (!order) {
            return { orderId, status: 'unknown', filledQty: 0, avgPrice: 0 };
        }

        const volExec = parseFloat(order.vol_exec || '0');
        const cost = parseFloat(order.cost || '0');
        // For filled orders, derive avgPrice from cost/volume (order.price is the limit price, not fill price)
        const avgPrice = (volExec > 0 && cost > 0) ? cost / volExec : parseFloat(order.price || '0');

        return {
            orderId,
            status: order.status || 'unknown',
            filledQty: volExec,
            avgPrice,
            cost,
            fee: parseFloat(order.fee || '0'),
        };
    }

    async getOrderBook(ticker, depth = 10) {
        const pair = toKrakenPair(ticker);
        const result = await krakenPublicRequest('Depth', { pair, count: depth });
        const keys = Object.keys(result);
        const data = result[keys[0]] || {};
        // Kraken format: {asks: [[price, volume, timestamp], ...], bids: [...]}
        // Normalize to Crypto.com format: [[price, qty, count], ...]
        const bids = (data.bids || []).map(l => [l[0], l[1], 1]);
        const asks = (data.asks || []).map(l => [l[0], l[1], 1]);
        return { bids, asks };
    }
}

export const krakenAdapter = new KrakenAdapter();
export { krakenPublicRequest, krakenPrivateRequest };
