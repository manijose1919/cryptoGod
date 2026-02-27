/**
 * Exchange Adapter Factory
 * Returns the correct adapter based on exchange ID.
 * Runtime switchable via setActiveExchange().
 */
import { cryptoComAdapter, setSessionManager as setCryptoComSessionManager } from './cryptocomAdapter.js';
import { krakenAdapter, setKrakenSessionManager } from './krakenAdapter.js';
import * as cryptoComWs from '../websocketService.js';
import * as krakenWs from '../krakenWebsocketService.js';

const adapters = {
    'crypto.com': cryptoComAdapter,
    'kraken': krakenAdapter,
};

const wsServices = {
    'crypto.com': cryptoComWs,
    'kraken': krakenWs,
};

let activeExchangeId = process.env.TRADING_EXCHANGE || 'kraken';

/** Get adapter by exchange ID (or active adapter if no ID given) */
export function getExchangeAdapter(exchangeId) {
    const id = exchangeId || activeExchangeId;
    const adapter = adapters[id];
    if (!adapter) {
        throw new Error(`Unknown exchange: ${id}. Available: ${Object.keys(adapters).join(', ')}`);
    }
    return adapter;
}

/** Switch the active exchange at runtime */
export function setActiveExchange(exchangeId) {
    if (!adapters[exchangeId]) {
        throw new Error(`Unknown exchange: ${exchangeId}. Available: ${Object.keys(adapters).join(', ')}`);
    }
    activeExchangeId = exchangeId;
    console.log(`[Exchange] Switched to ${exchangeId}`);
    return activeExchangeId;
}

/** Get the currently active exchange ID */
export function getActiveExchangeId() {
    return activeExchangeId;
}

/** List all available exchanges with status info */
export function listExchanges() {
    return Object.entries(adapters).map(([id, adapter]) => ({
        id,
        name: adapter.getName(),
        feePercent: adapter.getFeePercent() * 100,
        isActive: id === activeExchangeId,
        hasCredentials: id === 'crypto.com'
            ? !!(process.env.SESSION_API_KEY || process.env.CRYPTO_COM_API_KEY)
            : !!(process.env.KRAKEN_API_KEY),
    }));
}

/** Get the WebSocket service for the active (or specified) exchange */
export function getWebSocketService(exchangeId) {
    const id = exchangeId || activeExchangeId;
    return wsServices[id];
}

/** Set session manager on all adapters that need it */
export function setSessionManager(sm) {
    setCryptoComSessionManager(sm);
    setKrakenSessionManager(sm);
}
