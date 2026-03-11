/**
 * Zustand Trading Store — Global frontend state for dual-exchange trading.
 *
 * Replaces scattered useState calls in App.tsx with a centralized store.
 * Each exchange has independent state, with a combined portfolio view.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// ─── Types ───────────────────────────────────────────────────

export type ExchangeId = 'kraken' | 'crypto.com';
export type EngineMode = 'SIMULATION' | 'REAL';
export type EngineState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR';
export type ActiveTab = 'kraken' | 'crypto.com' | 'portfolio' | 'ml' | 'settings';

export interface Position {
  ticker: string;
  quantity: number;
  openPrice: number;
  entryTime: number;
  entryStrategy: string;
  highestPrice: number;
  currentPrice?: number;
  pnlPct?: number;
  pnlUsd?: number;
}

export interface ExchangeState {
  state: EngineState;
  mode: EngineMode;
  equity: number;
  cash: number;
  initialBudget: number;
  pnlUsd: number;
  pnlPct: number;
  positions: Record<string, Position>;
  positionCount: number;
  dailyPnl: number;
  dailyTradeCount: number;
  consecutiveLosses: number;
  drawdownPct: number;
  heatScore: number;
  tickCount: number;
  uptime: number;
  lastTrade?: { ticker: string; pnl: number; time: number };
}

export interface TradeRecord {
  id: string;
  time: number;
  exchange: ExchangeId;
  ticker: string;
  type: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  usdAmount: number;
  strategy: string;
  pnl?: number;
  fees?: number;
  reason?: string;
  mode: EngineMode;
}

export interface GlobalPortfolio {
  totalEquity: number;
  totalCash: number;
  totalPnl: number;
  totalPnlPct: number;
  krakenEquity: number;
  cryptoComEquity: number;
  totalPositions: number;
  heatScore: number;
  maxDrawdownPct: number;
  totalTrades?: number;
  winRate?: number;
}

export interface SystemLog {
  id: number;
  time: number;
  message: string;
  type: 'BUY' | 'SELL' | 'INFO' | 'WARN' | 'ERROR' | 'ML' | 'RISK';
  exchange?: ExchangeId;
}

// ─── Store Interface ─────────────────────────────────────────

interface TradingStore {
  // Active tab
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;

  // Per-exchange state
  kraken: ExchangeState;
  cryptoCom: ExchangeState;
  updateExchangeState: (exchange: ExchangeId, state: Partial<ExchangeState>) => void;

  // Global portfolio
  globalPortfolio: GlobalPortfolio;
  updateGlobalPortfolio: (portfolio: Partial<GlobalPortfolio>) => void;

  // Trade history (combined)
  trades: TradeRecord[];
  addTrade: (trade: TradeRecord) => void;

  // System logs
  logs: SystemLog[];
  addLog: (log: SystemLog) => void;

  // Connection status
  wsConnected: { kraken: boolean; cryptoCom: boolean };
  setWsConnected: (exchange: ExchangeId, connected: boolean) => void;

  // Selected ticker per exchange
  selectedTicker: { kraken: string; cryptoCom: string };
  setSelectedTicker: (exchange: ExchangeId, ticker: string) => void;

  // Available tickers per exchange
  availableTickers: { kraken: string[]; cryptoCom: string[] };
  setAvailableTickers: (exchange: ExchangeId, tickers: string[]) => void;
}

// ─── Default Exchange State ──────────────────────────────────

const defaultExchangeState: ExchangeState = {
  state: 'IDLE',
  mode: 'SIMULATION',
  equity: 0,
  cash: 0,
  initialBudget: 0,
  pnlUsd: 0,
  pnlPct: 0,
  positions: {},
  positionCount: 0,
  dailyPnl: 0,
  dailyTradeCount: 0,
  consecutiveLosses: 0,
  drawdownPct: 0,
  heatScore: 0,
  tickCount: 0,
  uptime: 0,
};

// ─── Store ───────────────────────────────────────────────────

export const useTradingStore = create<TradingStore>()(
  subscribeWithSelector((set) => ({
    // Active tab
    activeTab: 'kraken' as ActiveTab,
    setActiveTab: (tab) => set({ activeTab: tab }),

    // Per-exchange state
    kraken: { ...defaultExchangeState },
    cryptoCom: { ...defaultExchangeState },
    updateExchangeState: (exchange, state) =>
      set((prev) => {
        if (exchange === 'kraken') {
          return { kraken: { ...prev.kraken, ...state } };
        }
        return { cryptoCom: { ...prev.cryptoCom, ...state } };
      }),

    // Global portfolio
    globalPortfolio: {
      totalEquity: 0,
      totalCash: 0,
      totalPnl: 0,
      totalPnlPct: 0,
      krakenEquity: 0,
      cryptoComEquity: 0,
      totalPositions: 0,
      heatScore: 0,
      maxDrawdownPct: 0,
    },
    updateGlobalPortfolio: (portfolio) =>
      set((prev) => ({ globalPortfolio: { ...prev.globalPortfolio, ...portfolio } })),

    // Trade history
    trades: [],
    addTrade: (trade) =>
      set((prev) => ({
        trades: [trade, ...prev.trades].slice(0, 500), // Keep last 500
      })),

    // System logs
    logs: [],
    addLog: (log) =>
      set((prev) => ({
        logs: [log, ...prev.logs].slice(0, 200), // Keep last 200
      })),

    // WebSocket connection status
    wsConnected: { kraken: false, cryptoCom: false },
    setWsConnected: (exchange, connected) =>
      set((prev) => ({
        wsConnected: {
          ...prev.wsConnected,
          [exchange === 'crypto.com' ? 'cryptoCom' : exchange]: connected,
        },
      })),

    // Selected ticker
    selectedTicker: { kraken: 'BTCUSD', cryptoCom: 'BTCUSD' },
    setSelectedTicker: (exchange, ticker) =>
      set((prev) => ({
        selectedTicker: {
          ...prev.selectedTicker,
          [exchange === 'crypto.com' ? 'cryptoCom' : exchange]: ticker,
        },
      })),

    // Available tickers
    availableTickers: { kraken: [], cryptoCom: [] },
    setAvailableTickers: (exchange, tickers) =>
      set((prev) => ({
        availableTickers: {
          ...prev.availableTickers,
          [exchange === 'crypto.com' ? 'cryptoCom' : exchange]: tickers,
        },
      })),
  }))
);

export default useTradingStore;
