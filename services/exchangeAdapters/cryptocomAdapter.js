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

    const response = await fetch(url.toString());
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
        throw new Error('API credentials not available. Please authenticate first.');
    }

    const id = Date.now();
    const nonce = Date.now();
    const sig = generateSignature(method, id, apiKey, secretKey, params, nonce);

    const response = await fetch(`${API_BASE_URL}${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, method, api_key: apiKey, params, sig, nonce })
    });

    const data = await response.json();

    if (data.code != 0) {
        console.error(`[Crypto.com] ${method} failed:`, JSON.stringify(data));
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
        return result.data;
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
        const result = await makeSignedRequest('private/create-order', {
            instrument_name: this.formatTicker(ticker),
            side: 'BUY',
            type: 'MARKET',
            notional: notional.toFixed(2)
        }, sessionId);

        return {
            quantity: result.order_info?.filled_quantity || 0,
            avgPrice: result.order_info?.avg_price || 0,
            raw: result
        };
    }

    async placeSellOrder(ticker, quantity, sessionId, instrumentSpecs) {
        const instrument = this.formatTicker(ticker);
        const specs = instrumentSpecs?.get(instrument);
        let decimals = specs ? specs.quantity_decimals : 2;
        const factor = Math.pow(10, decimals);
        const sellQty = (Math.floor(quantity * factor) / factor).toString();

        const result = await makeSignedRequest('private/create-order', {
            instrument_name: instrument,
            side: 'SELL',
            type: 'MARKET',
            quantity: sellQty
        }, sessionId);

        return {
            avgPrice: result.order_info?.avg_price || 0,
            filledQuantity: result.order_info?.filled_quantity || quantity,
            raw: result
        };
    }

    getFeePercent() {
        return 0.00075;
    }
}

export const cryptoComAdapter = new CryptoComAdapter();
