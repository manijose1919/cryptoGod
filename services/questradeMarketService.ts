
/**
 * Frontend API client for Questrade routes
 */

export interface QuestradeSymbolResult {
    symbol: string;
    symbolId: number;
    description: string;
    listingExchange: string;
    securityType: string;
}

export interface QuestradeCandle {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vwap?: number;
}

export interface PaperTradeSummary {
    cash: number;
    totalEquity: number;
    marketValue: number;
    buyingPower: number;
    positions: Array<{
        symbol: string;
        openQuantity: number;
        averageEntryPrice: number;
        currentPrice: number;
        currentMarketValue: number;
        openPnl: number;
    }>;
    pnl: number;
    pnlPercent: number;
    tradeCount: number;
    initialBalance: number;
}

export interface PaperTrade {
    id: string;
    ticker: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    fee: number;
    timestamp: number;
}

export interface QuestradeStatus {
    questrade: {
        isAuthenticated: boolean;
        isPractice: boolean;
        apiUrl: string | null;
        tokenExpiry: number | null;
        symbolsCached: number;
    };
    bot: {
        isActive: boolean;
        isPaper: boolean;
        watchlist: string[];
    };
    paperTrading: {
        cash: number;
        positions: number;
        tradeCount: number;
    };
}

async function apiCall<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || `Request failed: ${response.status}`);
    }
    return data as T;
}

export async function authenticate(refreshToken?: string, isPractice = true) {
    return apiCall<{ success: boolean; status: any }>('/api/questrade/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken, isPractice }),
    });
}

export async function getStatus(): Promise<QuestradeStatus> {
    return apiCall<QuestradeStatus>('/api/questrade/status');
}

export async function getAccounts() {
    return apiCall<{ accounts: Array<{ type: string; number: string; status: string }> }>('/api/questrade/accounts');
}

export async function getBalance(accountId: string) {
    return apiCall<any>(`/api/questrade/balance/${accountId}`);
}

export async function getPositions(accountId: string) {
    return apiCall<{ positions: any[] }>(`/api/questrade/positions/${accountId}`);
}

export async function searchSymbols(prefix: string): Promise<QuestradeSymbolResult[]> {
    const data = await apiCall<{ symbols: QuestradeSymbolResult[] }>(`/api/questrade/search?prefix=${encodeURIComponent(prefix)}`);
    return data.symbols;
}

export async function getCandles(symbol: string, interval = '5m'): Promise<QuestradeCandle[]> {
    const data = await apiCall<{ candles: QuestradeCandle[] }>(`/api/questrade/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
    return data.candles;
}

export async function getSymbolsByExchange(exchange: string): Promise<QuestradeSymbolResult[]> {
    const data = await apiCall<{ symbols: QuestradeSymbolResult[] }>(`/api/questrade/symbols?exchange=${encodeURIComponent(exchange)}`);
    return data.symbols;
}

export async function placeOrder(params: {
    accountId?: string;
    ticker: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    orderType?: 'MARKET' | 'LIMIT';
    limitPrice?: number;
}) {
    return apiCall<{ success: boolean; trade?: PaperTrade; result?: any; paper: boolean }>('/api/questrade/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
}

export async function getPaperSummary(): Promise<PaperTradeSummary> {
    return apiCall<PaperTradeSummary>('/api/questrade/paper/summary');
}

export async function getPaperHistory(): Promise<PaperTrade[]> {
    const data = await apiCall<{ trades: PaperTrade[] }>('/api/questrade/paper/history');
    return data.trades;
}

export async function resetPaperTrading(balance = 100000) {
    return apiCall<{ success: boolean }>('/api/questrade/paper/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance }),
    });
}

export async function startBot(params: { watchlist?: string[]; isPaper?: boolean; accountId?: string }) {
    return apiCall<{ success: boolean; state: any }>('/api/questrade/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
}

export async function stopBot() {
    return apiCall<{ success: boolean }>('/api/questrade/bot/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function getBrainThoughts() {
    return apiCall<Array<{ time: number; type: string; asset: string; decision?: string; confidence?: number; reasoning?: string }>>('/api/brain/thoughts');
}

export async function getLiveFeeds() {
    return apiCall<Array<{ source: string; type: string; title: string; url: string; description: string; publishedAt: number }>>('/api/feeds/live');
}
