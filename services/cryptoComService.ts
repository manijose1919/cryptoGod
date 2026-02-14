
import type { Candle } from '../types';
import { CRYPTO_COM_API, WEBSOCKET_CONFIG } from '../constants';

/**
 * Crypto.com Exchange API Service
 * Provides methods for interacting with the Crypto.com Exchange API
 * Both public and authenticated endpoints
 */

// Types for API responses
export interface Instrument {
    instrument_name: string;
    quote_currency: string;
    base_currency: string;
    price_decimals: number;
    quantity_decimals: number;
    margin_trading_enabled: boolean;
    margin_trading_enabled_5x: boolean;
    margin_trading_enabled_10x: boolean;
    max_quantity: string;
    min_quantity: string;
    max_price: string;
    min_price: string;
    last_update_date: number;
    tradable: boolean;
    inst_type: string;
    is_active?: boolean;
    volume_24h?: string;
}

export interface CandlestickData {
    t: number;  // timestamp
    o: number;  // open
    h: number;  // high
    l: number;  // low
    c: number;  // close
    v: number;  // volume
}

export interface TickerData {
    i: string;   // instrument_name
    b: number;   // best bid
    k: number;   // best ask
    a: number;   // 24h price change
    t: number;   // timestamp
    v: number;   // 24h volume
    h: number;   // 24h high
    l: number;   // 24h low
    c: number;   // 24h change
}

export interface OrderBook {
    bids: [number, number, number][]; // [price, quantity, count]
    asks: [number, number, number][];
    t: number;
}

export interface AccountBalance {
    currency: string;
    balance: string;
    available: string;
    order: string;
    stake: string;
}

export interface OrderInfo {
    order_id: string;
    client_oid: string;
    account_id: string;
    instrument_name: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'TAKE_PROFIT_LIMIT';
    status: string;
    quantity: string;
    filled_quantity: string;
    avg_price: string;
    create_time: number;
    update_time: number;
}

export interface TradeRecord {
    trade_id: string;
    order_id: string;
    instrument_name: string;
    side: 'BUY' | 'SELL';
    traded_price: string;
    traded_quantity: string;
    fee: string;
    fee_currency: string;
    create_time: number;
}

// API Response wrapper
interface ApiResponse<T> {
    id: number;
    method: string;
    code: number;
    message?: string;
    result?: T;
}

class CryptoComService {
    private baseUrl: string;
    private wsUrl: string;

    constructor() {
        this.baseUrl = CRYPTO_COM_API.BASE_URL;
        this.wsUrl = WEBSOCKET_CONFIG.URL;
    }

    // ============================================
    // PUBLIC API METHODS (No authentication required)
    // ============================================

    /**
     * Make a public API request
     */
    private async makePublicRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${endpoint}`);
        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.append(key, value);
        });

        const response = await fetch(url.toString());
        const data: ApiResponse<T> = await response.json();

        if (data.code !== 0) {
            throw new Error(`Crypto.com API Error: ${data.message || 'Unknown error'} (Code: ${data.code})`);
        }

        return data.result as T;
    }

    /**
     * Get all available trading instruments
     */
    async getInstruments(): Promise<{ instruments: Instrument[] }> {
        return this.makePublicRequest<{ instruments: Instrument[] }>(
            CRYPTO_COM_API.PUBLIC_ENDPOINTS.INSTRUMENTS
        );
    }

    /**
     * Get candlestick data for a specific instrument
     */
    async getCandlestick(
        instrumentName: string,
        timeframe: string = '1m'
    ): Promise<{ instrument_name: string; interval: string; data: CandlestickData[] }> {
        return this.makePublicRequest<{ instrument_name: string; interval: string; data: CandlestickData[] }>(
            CRYPTO_COM_API.PUBLIC_ENDPOINTS.CANDLESTICK,
            { instrument_name: instrumentName, timeframe }
        );
    }

    /**
     * Get current ticker information
     */
    async getTicker(instrumentName?: string): Promise<{ data: TickerData[] }> {
        const params: Record<string, string> = {};
        if (instrumentName) {
            params.instrument_name = instrumentName;
        }
        return this.makePublicRequest<{ data: TickerData[] }>('public/get-ticker', params);
    }

    /**
     * Get order book for a specific instrument
     */
    async getOrderBook(instrumentName: string, depth: number = 50): Promise<{ data: OrderBook[] }> {
        return this.makePublicRequest<{ data: OrderBook[] }>('public/get-book', {
            instrument_name: instrumentName,
            depth: depth.toString()
        });
    }

    /**
     * Get recent public trades
     */
    async getPublicTrades(instrumentName: string): Promise<{ data: TradeRecord[] }> {
        return this.makePublicRequest<{ data: TradeRecord[] }>('public/get-trades', {
            instrument_name: instrumentName
        });
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    /**
     * Convert API candlestick data to internal Candle format
     */
    convertToCandles(data: CandlestickData[]): Candle[] {
        return data.map(d => ({
            time: d.t,
            open: d.o,
            high: d.h,
            low: d.l,
            close: d.c,
            volume: d.v
        }));
    }

    /**
     * Get top USDC trading pairs by volume
     */
    async getTopUsdcPairs(limit: number = 20): Promise<string[]> {
        try {
            const { instruments } = await this.getInstruments();

            return instruments
                .filter(inst =>
                    inst.instrument_name.endsWith('_USDC') &&
                    inst.tradable !== false &&
                    inst.inst_type === 'CCY_PAIR'
                )
                .sort((a, b) => {
                    const volA = parseFloat(a.volume_24h || '0');
                    const volB = parseFloat(b.volume_24h || '0');
                    return volB - volA;
                })
                .slice(0, limit)
                .map(inst => inst.instrument_name.replace('_', ''));
        } catch (error) {
            console.error('Failed to fetch top USDC pairs:', error);
            throw error;
        }
    }

    /**
     * Format instrument name for API (BTCUSDC -> BTC_USDC)
     */
    formatInstrumentName(ticker: string): string {
        if (ticker.includes('_')) return ticker;
        return ticker.replace('USDC', '_USDC').replace('USD', '_USD');
    }

    /**
     * Parse instrument name from API format (BTC_USDC -> BTCUSDC)
     */
    parseInstrumentName(instrumentName: string): string {
        return instrumentName.replace('_', '');
    }

    /**
     * Get WebSocket URL for market data streaming
     */
    getWebSocketUrl(): string {
        return this.wsUrl;
    }

    /**
     * Create WebSocket subscription message for kline data
     */
    createKlineSubscription(tickers: string[], interval: string = '1m'): object {
        const channels = tickers.map(t =>
            `kline.${interval}.${this.formatInstrumentName(t)}`
        );

        return {
            id: Date.now(),
            method: 'subscribe',
            params: { channels },
            nonce: Date.now()
        };
    }

    /**
     * Create WebSocket heartbeat response
     */
    createHeartbeatResponse(id: number): object {
        return {
            id,
            method: 'public/respond-heartbeat'
        };
    }

    // ============================================
    // PRICE UTILITIES
    // ============================================

    /**
     * Calculate price change percentage
     */
    calculatePriceChange(currentPrice: number, previousPrice: number): number {
        if (previousPrice === 0) return 0;
        return ((currentPrice - previousPrice) / previousPrice) * 100;
    }

    /**
     * Format price based on instrument decimals
     */
    formatPrice(price: number, decimals: number = 2): string {
        return price.toFixed(decimals);
    }

    /**
     * Format quantity based on instrument decimals
     */
    formatQuantity(quantity: number, decimals: number = 4): string {
        return quantity.toFixed(decimals);
    }

    /**
     * Calculate notional value
     */
    calculateNotional(price: number, quantity: number): number {
        return price * quantity;
    }
}

// Export singleton instance
export const cryptoComService = new CryptoComService();

// Export class for custom instances
export { CryptoComService };
