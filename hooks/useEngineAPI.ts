/**
 * useEngineAPI — TanStack Query hooks for the dual-engine API.
 *
 * Provides React hooks for fetching engine status, portfolio data,
 * staking, arbitrage, and short selling data from the new /api/engines/* routes.
 * Auto-refetches on configurable intervals for real-time dashboard updates.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// ─── Types ───────────────────────────────────────────────────

export interface PositionDetail {
  ticker: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  pnlPct: number;
  strategy: string;
  holdTime: number;
  regime: string;
}

export interface EngineStatus {
  state: string;
  mode: string;
  exchange: string;
  uptime: number;
  positionDetails?: PositionDetail[];
  portfolio: {
    cash: number;
    equity: number;
    pnl: number;
    pnlPct: number;
    positions: number;
    exposurePct: number;
  };
  circuitBreaker: {
    consecutiveLosses: number;
    dailyPnl: number;
    drawdownPct: number;
    isPaused: boolean;
  };
  trades: {
    total: number;
    winRate: number;
    avgPnl: number;
  };
}

export interface GlobalPortfolio {
  totalEquity: number;
  totalCash: number;
  totalPnl: number;
  totalPnlPct: number;
  totalInitialBudget: number;
  krakenEquity: number;
  cryptoComEquity: number;
  krakenPnl: number;
  cryptoComPnl: number;
  totalPositions: number;
  totalExposurePct: number;
  heatScore: number;
  maxDrawdownPct: number;
}

export interface StakingStatus {
  enabled: boolean;
  products: number;
  stakedPositions: number;
  totalStakedUsd?: number;
  estimatedAnnualYield?: number;
}

export interface ArbitrageStatus {
  enabled: boolean;
  opportunities: number;
}

export interface ShortStatus {
  enabled: boolean;
  simBalance: number;
  simPnl: number;
  simPnlPct: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  exposure: number;
  exposurePct: number;
}

export interface AllEnginesStatus {
  engines: {
    kraken?: EngineStatus;
    'crypto.com'?: EngineStatus;
  };
  global: GlobalPortfolio | null;
}

// ─── Fetch Helpers ───────────────────────────────────────────

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function postJSON<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Query Hooks ─────────────────────────────────────────────

/** Fetch status of both engines + global portfolio. Refetches every 2s. */
export function useAllEnginesStatus() {
  return useQuery<AllEnginesStatus>({
    queryKey: ['engines', 'status'],
    queryFn: () => fetchJSON('/api/engines/status'),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });
}

/** Fetch a single engine's status. */
export function useEngineStatus(exchange: 'kraken' | 'crypto.com') {
  const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
  return useQuery<EngineStatus>({
    queryKey: ['engines', exchange, 'status'],
    queryFn: () => fetchJSON(`/api/engines/${apiExchange}/status`),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });
}

/** Fetch global portfolio. Refetches every 3s. */
export function useGlobalPortfolio() {
  return useQuery<GlobalPortfolio>({
    queryKey: ['portfolio', 'global'],
    queryFn: () => fetchJSON('/api/portfolio/global'),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/** Fetch performance metrics. */
export function usePerformanceMetrics(days = 30) {
  return useQuery({
    queryKey: ['portfolio', 'performance', days],
    queryFn: () => fetchJSON(`/api/portfolio/performance?days=${days}`),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
    staleTime: 5000,
  });
}

/** Fetch staking status. */
export function useStakingStatus() {
  return useQuery<StakingStatus>({
    queryKey: ['staking', 'status'],
    queryFn: () => fetchJSON('/api/staking/status'),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    staleTime: 15000,
  });
}

/** Fetch arbitrage status and recent opportunities. */
export function useArbitrageStatus() {
  return useQuery<ArbitrageStatus>({
    queryKey: ['arbitrage', 'status'],
    queryFn: () => fetchJSON('/api/arbitrage/status'),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/** Fetch short selling status. */
export function useShortStatus() {
  return useQuery<ShortStatus>({
    queryKey: ['shorts', 'status'],
    queryFn: () => fetchJSON('/api/shorts/status'),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/** Fetch short positions. */
export function useShortPositions() {
  return useQuery({
    queryKey: ['shorts', 'positions'],
    queryFn: () => fetchJSON('/api/shorts/positions'),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/** Fetch arbitrage opportunities. */
export function useArbitrageOpportunities() {
  return useQuery({
    queryKey: ['arbitrage', 'opportunities'],
    queryFn: () => fetchJSON('/api/arbitrage/opportunities'),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/** Fetch staking products. */
export function useStakingProducts() {
  return useQuery({
    queryKey: ['staking', 'products'],
    queryFn: () => fetchJSON('/api/staking/products'),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });
}

// ─── Mutation Hooks ──────────────────────────────────────────

/** Start an engine. */
export function useStartEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ exchange, mode, budget }: { exchange: string; mode: string; budget?: number }) => {
      const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
      return postJSON(`/api/engines/${apiExchange}/start`, { mode, budget });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engines'] }),
  });
}

/** Pause an engine. */
export function usePauseEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exchange: string) => {
      const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
      return postJSON(`/api/engines/${apiExchange}/pause`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engines'] }),
  });
}

/** Resume an engine. */
export function useResumeEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exchange: string) => {
      const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
      return postJSON(`/api/engines/${apiExchange}/resume`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engines'] }),
  });
}

/** Stop an engine. */
export function useStopEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exchange: string) => {
      const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
      return postJSON(`/api/engines/${apiExchange}/stop`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engines'] }),
  });
}

/** Switch engine mode (SIMULATION / REAL). */
export function useSwitchMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ exchange, mode }: { exchange: string; mode: 'SIMULATION' | 'REAL' }) => {
      const apiExchange = exchange === 'crypto.com' ? 'crypto-com' : exchange;
      return postJSON(`/api/engines/${apiExchange}/mode`, { mode });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engines'] }),
  });
}
