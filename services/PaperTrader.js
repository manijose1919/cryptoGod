
/**
 * Paper Trading Service
 * Wraps an exchange service to simulate execution while using real market data.
 */
export class PaperTrader {
    constructor(exchangeService, initialBalance = 100000) {
        this.exchange = exchangeService;
        this.portfolio = {
            cash: initialBalance,
            initialBalance,
            positions: {}, // ticker -> { quantity, avgPrice, entryTime }
            history: []
        };
        this.fees = {
            maker: 0.001, // 0.1%
            taker: 0.001
        };
    }

    // Pass-through for read-only data - uses getCandlesByTicker for proper ticker->symbolId resolution
    async getCandles(ticker, interval = '1m', startTime, endTime) {
        if (this.exchange.getCandlesByTicker) {
            return this.exchange.getCandlesByTicker(ticker, interval, startTime, endTime);
        }
        return this.exchange.getCandles(ticker, interval, startTime, endTime);
    }

    async getTicker(ticker) {
        // Try getQuoteByTicker first (Questrade)
        if (this.exchange.getQuoteByTicker) {
            try {
                const quote = await this.exchange.getQuoteByTicker(ticker);
                if (quote && quote.lastTradePrice) {
                    return { price: quote.lastTradePrice, bid: quote.bidPrice, ask: quote.askPrice };
                }
            } catch (e) { /* fall through */ }
        }

        if (this.exchange.getTicker) {
            return this.exchange.getTicker(ticker);
        }

        // Fallback: use latest candle
        try {
            const candles = await this.getCandles(ticker, '1m');
            if (candles && candles.length > 0) {
                const last = candles[candles.length - 1];
                return { price: last.c ?? last.close ?? 0 };
            }
        } catch (e) { /* fall through */ }

        return { price: 0 };
    }

    // Simulated Account Info
    async getBalance() {
        const equity = await this.calculateTotalEquity();
        return {
            cash: this.portfolio.cash,
            totalEquity: equity,
            marketValue: equity - this.portfolio.cash,
            buyingPower: this.portfolio.cash,
        };
    }

    async getPositions() {
        const positions = [];
        for (const [ticker, pos] of Object.entries(this.portfolio.positions)) {
            const priceData = await this.getTicker(ticker);
            const currentPrice = priceData.price || 0;
            const marketValue = pos.quantity * currentPrice;
            const openPnl = (currentPrice - pos.avgPrice) * pos.quantity;
            positions.push({
                symbol: ticker,
                openQuantity: pos.quantity,
                averageEntryPrice: pos.avgPrice,
                currentPrice,
                currentMarketValue: marketValue,
                openPnl,
                entryTime: pos.entryTime,
            });
        }
        return positions;
    }

    async getAccountSummary() {
        const balance = await this.getBalance();
        const positions = await this.getPositions();
        const pnl = balance.totalEquity - this.portfolio.initialBalance;
        const pnlPercent = (pnl / this.portfolio.initialBalance) * 100;
        return {
            ...balance,
            positions,
            pnl,
            pnlPercent,
            tradeCount: this.portfolio.history.length,
            initialBalance: this.portfolio.initialBalance,
        };
    }

    async calculateTotalEquity() {
        let equity = this.portfolio.cash;
        for (const [ticker, pos] of Object.entries(this.portfolio.positions)) {
            const priceData = await this.getTicker(ticker);
            const price = priceData.price || priceData.lastTradePrice || priceData.c || 0;
            equity += (pos.quantity * price);
        }
        return equity;
    }

    // Simulated Execution
    async createOrder(ticker, side, quantity, type = 'MARKET', price = null) {
        // 1. Get Real Price
        const priceData = await this.getTicker(ticker);
        const currentPrice = price || priceData.price || priceData.lastTradePrice || 0;

        if (!currentPrice) throw new Error(`Could not fetch price for ${ticker}`);

        const cost = currentPrice * quantity;
        const fee = cost * this.fees.taker;
        const totalCost = cost + fee;

        // 2. Validate
        if (side === 'BUY') {
            if (this.portfolio.cash < totalCost) {
                throw new Error(`Insufficient funds (Paper): Have $${this.portfolio.cash.toFixed(2)}, Need $${totalCost.toFixed(2)}`);
            }

            // Execute Buy
            this.portfolio.cash -= totalCost;

            if (!this.portfolio.positions[ticker]) {
                this.portfolio.positions[ticker] = { quantity: 0, avgPrice: 0, entryTime: Date.now() };
            }

            const pos = this.portfolio.positions[ticker];
            const newQty = pos.quantity + quantity;
            const newAvg = ((pos.quantity * pos.avgPrice) + cost) / newQty;

            pos.quantity = newQty;
            pos.avgPrice = newAvg;

        } else if (side === 'SELL') {
            const pos = this.portfolio.positions[ticker];
            if (!pos || pos.quantity < quantity) {
                throw new Error(`Insufficient position (Paper): Have ${pos ? pos.quantity : 0}, Need ${quantity}`);
            }

            // Execute Sell
            const revenue = (currentPrice * quantity) - fee;
            this.portfolio.cash += revenue;
            pos.quantity -= quantity;

            if (pos.quantity <= 0.00001) {
                delete this.portfolio.positions[ticker];
            }
        }

        // 3. Log
        const trade = {
            id: `paper-${Date.now()}`,
            ticker,
            side,
            quantity,
            price: currentPrice,
            fee,
            timestamp: Date.now()
        };
        this.portfolio.history.push(trade);

        console.log(`[PAPER TRADE] ${side} ${quantity} ${ticker} @ ${currentPrice} (Fee: ${fee.toFixed(2)})`);
        return trade;
    }

    // Reset paper trading state
    reset(initialBalance) {
        this.portfolio = {
            cash: initialBalance || this.portfolio.initialBalance,
            initialBalance: initialBalance || this.portfolio.initialBalance,
            positions: {},
            history: []
        };
    }

    getHistory() {
        return this.portfolio.history;
    }
}
