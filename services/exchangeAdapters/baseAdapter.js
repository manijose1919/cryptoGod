/**
 * Base Exchange Adapter Interface
 * All exchange adapters must implement this interface.
 */
export class BaseExchangeAdapter {
    getName() {
        throw new Error('getName() must be implemented');
    }

    /** Convert internal ticker (e.g. BTCUSD) to exchange-specific format */
    formatTicker(ticker) {
        throw new Error('formatTicker() must be implemented');
    }

    /** Convert exchange-specific pair format back to internal ticker (e.g. BTCUSD) */
    parseTicker(pair) {
        throw new Error('parseTicker() must be implemented');
    }

    /** Fetch OHLCV candles. Returns array of {t, o, h, l, c, v} */
    async getCandles(ticker, timeframe, limit) {
        throw new Error('getCandles() must be implemented');
    }

    /** Fetch available trading instruments. Returns array of {instrument_name, base, quote} */
    async getInstruments() {
        throw new Error('getInstruments() must be implemented');
    }

    /** Get account balance. Returns {balances, cashBalance, holdings} */
    async getBalance(sessionId) {
        throw new Error('getBalance() must be implemented');
    }

    /** Place a market buy order by notional (USD amount). Returns order result */
    async placeBuyOrder(ticker, notional, sessionId) {
        throw new Error('placeBuyOrder() must be implemented');
    }

    /** Place a market sell order by quantity. Returns order result */
    async placeSellOrder(ticker, quantity, sessionId, instrumentSpecs) {
        throw new Error('placeSellOrder() must be implemented');
    }

    /** Get taker fee as a decimal (e.g. 0.00075 for 0.075%) */
    getFeePercent() {
        throw new Error('getFeePercent() must be implemented');
    }

    /** Get maker fee as a decimal (e.g. 0.0016 for 0.16%). Defaults to taker fee. */
    getMakerFeePercent() {
        return this.getFeePercent();
    }

    /** Place a limit buy order. Returns order result with orderId. */
    async placeLimitBuyOrder(ticker, price, volume, sessionId) {
        throw new Error('placeLimitBuyOrder() not supported by this exchange');
    }

    /** Place a limit sell order. Returns order result with orderId. */
    async placeLimitSellOrder(ticker, price, volume, sessionId) {
        throw new Error('placeLimitSellOrder() not supported by this exchange');
    }

    /** Get open orders. Returns array of {orderId, ticker, side, price, volume, status}. */
    async getOpenOrders(sessionId) {
        throw new Error('getOpenOrders() not supported by this exchange');
    }

    /** Cancel an open order by ID. Returns {success, orderId}. */
    async cancelOrder(orderId, sessionId) {
        throw new Error('cancelOrder() not supported by this exchange');
    }

    /** Query order status by ID. Returns {orderId, status, filledQty, avgPrice}. */
    async getOrderStatus(orderId, sessionId) {
        throw new Error('getOrderStatus() not supported by this exchange');
    }

    /** Fetch order book depth. Returns {bids: [[price, qty, count], ...], asks: [...]} */
    async getOrderBook(ticker, depth = 10) {
        throw new Error('getOrderBook() not supported by this exchange');
    }
}
