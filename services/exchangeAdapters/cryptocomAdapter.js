/**
 * Crypto.com Exchange Adapter
 * Extracted from server.js — wraps all Crypto.com REST API calls.
 */
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { BaseExchangeAdapter } from './baseAdapter.js';

const API_BASE_URL = 'https://api.crypto.com/exchange/v1/';

// Session manager reference (set via init)
let _SessionManager = null;

export function setSessionManager(sm) {
    _SessionManager = sm;
}

// ── Parameter serialization for signature ──
export function paramsToStr(obj, level = 0) {
    const MAX_LEVEL = 3;
    if (level >= MAX_LEVEL) return String(obj);

    let result = '';
    for (const key of Object.keys(obj).sort()) {
        result += key;
        const val = obj[key];
        if (val === null || val === undefined) {
            result += 'null';
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (typeof item === 'object' && item !== null) {
                    result += paramsToStr(item, level + 1);
                } else {
                    result += String(item);
                }
            }
        } else if (typeof val === 'object') {
            result += paramsToStr(val, level + 1);
        } else {
            result += String(val);
        }
    }
    return result;
}

export function generateSignature(method, id, apiKey, secretKey, params, nonce) {
    const paramStr = params && Object.keys(params).length > 0
        ? paramsToStr(params, 0)
        : '';
    const sigPayload = method + String(id) + apiKey + paramStr + String(nonce);
    return crypto.createHmac('sha256', secretKey).update(sigPayload).digest('hex');
}

export async function makePublicRequest(method, params = {}) {
    const url = new URL(`${API_BASE_URL}${method}`);
    url.search = new URLSearchParams(params).toString();

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const data = await response.json();

    if (data.code != 0) {
        throw new Error(`Crypto.com API Error for ${method}: ${data.message || 'No message'}`);
    }
    return data.result;
}

export async function makeSignedRequest(method, params = {}, sessionId = null) {
    let apiKey, secretKey;

    if (sessionId && _SessionManager) {
        const session = _SessionManager.getSession(sessionId);
        if (session) {
            apiKey = session.apiKey;
            secretKey = session.secretKey;
        }
    }

    if (!apiKey || !secretKey) {
        apiKey = process.env.SESSION_API_KEY;
        secretKey = process.env.SESSION_SECRET_KEY;
    }

    if (!apiKey || !secretKey) {
        if (!makeSignedRequest._noCredsWarn) {
            makeSignedRequest._noCredsWarn = true;
            console.warn('[Crypto.com] No API credentials — private API calls disabled');
        }
        throw new Error('API credentials not available. Please authenticate first.');
    }

    const id = Date.now();
    const nonce = Date.now();
    const sig = generateSignature(method, id, apiKey, secretKey, params, nonce);

    const response = await fetch(`${API_BASE_URL}${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, method, api_key: apiKey, params, sig, nonce }),
        signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (data.code != 0) {
        // Suppress recurring auth failures (no API keys configured)
        if (data.code === 40101) {
            if (!makeSignedRequest._authWarn) {
                makeSignedRequest._authWarn = true;
                console.warn(`[Crypto.com] Authentication not configured — private API calls disabled`);
            }
        } else {
            console.error(`[Crypto.com] ${method} failed:`, JSON.stringify(data));
        }
        throw new Error(`Crypto.com API Error (Code: ${data.code}): ${data.message || 'No message provided.'}`);
    }
    return data.result;
}

export class CryptoComAdapter extends BaseExchangeAdapter {
    getName() {
        return 'crypto.com';
    }

    formatTicker(ticker) {
        if (ticker.includes('_')) return ticker;
        if (ticker.endsWith('USDC')) return ticker.replace('USDC', '_USDC');
        if (ticker.endsWith('USDT')) return ticker.replace('USDT', '_USDT');
        if (ticker.endsWith('CAD')) return ticker.replace('CAD', '_CAD');
        if (ticker.endsWith('USD')) return ticker.replace('USD', '_USD');
        return ticker;
    }

    parseTicker(pair) {
        return pair.replace('_', '');
    }

    async getCandles(ticker, timeframe = '1m', limit = 200) {
        const instrument_name = this.formatTicker(ticker);
        const result = await makePublicRequest('public/get-candlestick', {
            instrument_name, timeframe, count: String(limit)
        });
        // Normalize to { t, o, h, l, c, v } with numeric values (Crypto.com may return strings)
        const raw = result.data || [];
        return raw.map(c => ({
            t: typeof c.t === 'number' ? c.t : parseInt(c.t),
            o: typeof c.o === 'number' ? c.o : parseFloat(c.o),
            h: typeof c.h === 'number' ? c.h : parseFloat(c.h),
            l: typeof c.l === 'number' ? c.l : parseFloat(c.l),
            c: typeof c.c === 'number' ? c.c : parseFloat(c.c),
            v: typeof c.v === 'number' ? c.v : parseFloat(c.v),
        }));
    }

    async getInstruments() {
        const result = await makePublicRequest('public/get-instruments');
        return result;
    }

    async getBalance(sessionId) {
        const balanceResult = await makeSignedRequest('private/user-balance', {}, sessionId);
        const dataArray = balanceResult?.data || [];
        const topLevel = Array.isArray(dataArray) && dataArray.length > 0 ? dataArray[0] : dataArray;

        let cashBalance = 0;
        const holdings = {};
        const positionBalances = topLevel?.position_balances || [];

        for (const pos of positionBalances) {
            const currency = pos.instrument_name;
            const qty = parseFloat(pos.quantity || '0');
            if (qty <= 0) continue;
            if (currency === 'USD' || currency === 'USDC') cashBalance += qty;
            else holdings[currency] = { quantity: qty, usdValue: 0 };
        }

        return { cashBalance, holdings };
    }

    async placeBuyOrder(ticker, notional, sessionId) {
        // Crypto.com Exchange minimum notional is $1 for most pairs
        if (notional < 1.0) {
            throw new Error(`[Crypto.com] Order $${notional.toFixed(2)} below $1 minimum for ${ticker}`);
        }

        const result = await makeSignedRequest('private/create-order', {
            instrument_name: this.formatTicker(ticker),
            side: 'BUY',
            type: 'MARKET',
            notional: notional.toFixed(2)
        }, sessionId);

        const filledQty = parseFloat(result.order_info?.cumulative_quantity || result.order_info?.filled_quantity || 0);
        const avgPx = parseFloat(result.order_info?.avg_price || 0);
        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            quantity: filledQty,
            avgPrice: avgPx,
            // TradingEngine interface compatibility
            filledPrice: avgPx,
            filledQuantity: filledQty,
            raw: result
        };
    }

    async placeSellOrder(ticker, quantity, sessionId, instrumentSpecs) {
        const instrument = this.formatTicker(ticker);
        const specs = instrumentSpecs?.get(instrument);
        let decimals = specs ? specs.quantity_decimals : 8;
        const factor = Math.pow(10, decimals);
        const sellQty = (Math.floor(quantity * factor) / factor).toString();

        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'SELL',
            type: 'MARKET',
            quantity: sellQty
        }, sessionId);

        const avgPx = parseFloat(result.order_info?.avg_price || 0);
        const filledQty = parseFloat(result.order_info?.cumulative_quantity || result.order_info?.filled_quantity || quantity);
        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            avgPrice: avgPx,
            filledQuantity: filledQty,
            // TradingEngine interface compatibility
            filledPrice: avgPx,
            quantity: filledQty,
            raw: result
        };
    }

    getFeePercent() {
        return 0.00075; // 0.075% taker per side
    }

    getMakerFeePercent() {
        return 0.00050; // 0.050% maker per side (estimate)
    }

    /**
     * Place a LIMIT buy order (saves ~33% on fees vs market order).
     */
    async placeLimitBuyOrder(ticker, price, quantity, sessionId) {
        const instrument = this.formatTicker(ticker);
        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'BUY',
            type: 'LIMIT',
            price: price.toString(),
            quantity: quantity.toString(),
            time_in_force: 'GOOD_TILL_CANCEL',
        }, sessionId);

        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            ticker,
            side: 'buy',
            price,
            quantity,
            status: 'open',
            raw: result,
        };
    }

    /**
     * Place a LIMIT sell order.
     */
    async placeLimitSellOrder(ticker, price, quantity, sessionId) {
        const instrument = this.formatTicker(ticker);
        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'SELL',
            type: 'LIMIT',
            price: price.toString(),
            quantity: quantity.toString(),
            time_in_force: 'GOOD_TILL_CANCEL',
        }, sessionId);

        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            ticker,
            side: 'sell',
            price,
            quantity,
            status: 'open',
            raw: result,
        };
    }

    /**
     * Place a stop-loss order on Crypto.com (native exchange-side protection).
     */
    async placeStopLoss(ticker, quantity, stopPrice, sessionId) {
        const instrument = this.formatTicker(ticker);
        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'SELL',
            type: 'STOP_LOSS',
            quantity: quantity.toString(),
            trigger_price: stopPrice.toString(),
        }, sessionId);

        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            ticker,
            stopPrice,
            quantity,
            status: 'open',
            raw: result,
        };
    }

    /**
     * Place a take-profit order on Crypto.com.
     */
    async placeTakeProfit(ticker, quantity, limitPrice, sessionId) {
        const instrument = this.formatTicker(ticker);
        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'SELL',
            type: 'TAKE_PROFIT',
            quantity: quantity.toString(),
            trigger_price: limitPrice.toString(),
        }, sessionId);

        return {
            orderId: result.order_id || result.order_info?.order_id || null,
            ticker,
            limitPrice,
            quantity,
            status: 'open',
            raw: result,
        };
    }

    /**
     * Cancel an open order.
     */
    async cancelOrder(orderId, ticker, sessionId) {
        const instrument = this.formatTicker(ticker);
        const result = await makeSignedRequest('private/cancel-order', {
            instrument_name: instrument,
            order_id: orderId,
        }, sessionId);

        return { success: true, orderId, raw: result };
    }

    /**
     * Get open orders.
     */
    async getOpenOrders(ticker, sessionId) {
        const params = {};
        if (ticker) params.instrument_name = this.formatTicker(ticker);

        const result = await makeSignedRequest('private/get-open-orders', params, sessionId);
        const orders = result?.data || [];

        return orders.map(o => ({
            orderId: o.order_id,
            ticker: this.parseTicker(o.instrument_name),
            side: o.side?.toLowerCase(),
            type: o.type,
            price: parseFloat(o.price || '0'),
            quantity: parseFloat(o.quantity || '0'),
            filledQuantity: parseFloat(o.cumulative_quantity || '0'),
            status: o.status,
        }));
    }

    /**
     * Get order status by ID.
     */
    async getOrderStatus(orderId, sessionId) {
        const result = await makeSignedRequest('private/get-order-detail', {
            order_id: orderId,
        }, sessionId);

        const info = result?.order_info || {};
        return {
            orderId,
            status: info.status || 'unknown',
            filledQty: parseFloat(info.cumulative_quantity || '0'),
            avgPrice: parseFloat(info.avg_price || '0'),
            fee: parseFloat(info.fee_currency_amount || '0'),
        };
    }

    async getOrderBook(ticker, depth = 10) {
        const instrument_name = this.formatTicker(ticker);
        const result = await makePublicRequest('public/get-book', {
            instrument_name, depth: String(depth)
        });
        // Crypto.com returns {bids: [[price, qty, count], ...], asks: [...]}
        return { bids: result.data?.[0]?.bids || [], asks: result.data?.[0]?.asks || [] };
    }
}

export const cryptoComAdapter = new CryptoComAdapter();
