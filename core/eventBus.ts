/**
 * EventBus — Decoupled event-driven communication between trading components.
 *
 * Kraken and Crypto.com engines emit events independently.
 * Telegram, ML feedback, logging, and risk management subscribe to events.
 */

import { EventEmitter } from 'node:events';

export interface TradeEvent {
  exchange: 'kraken' | 'crypto.com';
  ticker: string;
  price: number;
  quantity: number;
  usdAmount: number;
  strategy: string;
  confidence: number;
  mode: 'SIMULATION' | 'REAL';
  timestamp: number;
}

export interface EntryEvent extends TradeEvent {
  type: 'BUY';
  targetPct: number;
  stopLossPct: number;
  maxHoldHours: number;
  reason: string;
  mlConfidence?: number;
}

export interface ExitEvent extends TradeEvent {
  type: 'SELL';
  entryPrice: number;
  pnlPercent: number;
  pnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  holdDurationMs: number;
  reason: string;
  isProfit: boolean;
}

export interface SignalEvent {
  exchange: 'kraken' | 'crypto.com';
  ticker: string;
  strategy: string;
  score: number;
  confidence: number;
  regime: string;
  timestamp: number;
}

export interface RiskEvent {
  exchange: 'kraken' | 'crypto.com' | 'global';
  type: 'circuit_break' | 'drawdown_warning' | 'heat_warning' | 'position_limit';
  reason: string;
  severity: 'info' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface MLEvent {
  type: 'prediction' | 'retrain' | 'drift' | 'accuracy_change';
  exchange?: 'kraken' | 'crypto.com';
  ticker?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface SessionEvent {
  exchange: 'kraken' | 'crypto.com';
  action: 'start' | 'pause' | 'resume' | 'stop';
  mode: 'SIMULATION' | 'REAL';
  budget?: number;
  timestamp: number;
}

// Event map for type-safe subscriptions
export interface TradingEvents {
  'signal:detected': (event: SignalEvent) => void;
  'trade:entry': (event: EntryEvent) => void;
  'trade:exit': (event: ExitEvent) => void;
  'risk:alert': (event: RiskEvent) => void;
  'ml:event': (event: MLEvent) => void;
  'session:change': (event: SessionEvent) => void;
  'engine:tick': (data: { exchange: string; timestamp: number; activePositions: number }) => void;
  'engine:error': (data: { exchange: string; error: string; timestamp: number }) => void;
}

class TradingEventBus extends EventEmitter {
  private static instance: TradingEventBus;

  private constructor() {
    super();
    this.setMaxListeners(50); // Many subscribers
  }

  static getInstance(): TradingEventBus {
    if (!TradingEventBus.instance) {
      TradingEventBus.instance = new TradingEventBus();
    }
    return TradingEventBus.instance;
  }

  // Type-safe emit
  emitEvent<K extends keyof TradingEvents>(
    event: K,
    ...args: Parameters<TradingEvents[K]>
  ): boolean {
    return this.emit(event, ...args);
  }

  // Type-safe subscribe
  onEvent<K extends keyof TradingEvents>(
    event: K,
    listener: TradingEvents[K]
  ): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  // Convenience: get stats
  getStats() {
    return {
      listenerCounts: {
        'signal:detected': this.listenerCount('signal:detected'),
        'trade:entry': this.listenerCount('trade:entry'),
        'trade:exit': this.listenerCount('trade:exit'),
        'risk:alert': this.listenerCount('risk:alert'),
        'ml:event': this.listenerCount('ml:event'),
        'session:change': this.listenerCount('session:change'),
      },
    };
  }
}

export const tradingBus = TradingEventBus.getInstance();
export default tradingBus;
