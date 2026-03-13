// ============================================
// Phoenix V2 Exchange Adapter Types
// ============================================

export interface OrderResult {
  orderId: string;
  ticker: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  status: 'filled' | 'partial' | 'pending' | 'cancelled';
  fee: number;
  orderType: 'maker' | 'taker';
}

export interface ExchangeAdapter {
  getName(): string;
  getLatestPrice(ticker: string): Promise<number>;
  placeMakerBuy(ticker: string, price: number, quantity: number): Promise<OrderResult>;
  placeMakerSell(ticker: string, price: number, quantity: number): Promise<OrderResult>;
  placeMarketSell(ticker: string, quantity: number): Promise<OrderResult>;
  placeStopLoss(ticker: string, quantity: number, stopPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
  getBestBid(ticker: string): Promise<number>;
  getBestAsk(ticker: string): Promise<number>;
}
