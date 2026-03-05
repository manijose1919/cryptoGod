/**
 * Historical Training Service — Frontend API client for the Time Machine.
 */

import type {
  TrainingDownloadStatus,
  TrainingDataSummary,
  TrainingStatus,
  TrainingRun,
  TrainingResults,
  TrainingTrade,
  TrainingEquityPoint,
  WalkForwardConfig,
  WalkForwardStatus,
  WalkForwardRun,
} from '../types';

const API_BASE = '/api/training';

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- Data Download ---

export async function startDownload(tickers?: string[], yearsBack?: number, timeframes?: string[]) {
  return apiPost<{ success: boolean; tickers: string[]; yearsBack: number; timeframes: string[]; estimate: { totalRequests: number; estimatedMinutes: number; estimatedHours: string } }>('/download', { tickers, yearsBack, timeframes });
}

export async function abortDownload() {
  return apiPost<{ aborted: boolean }>('/download/abort');
}

export async function getDownloadStatus() {
  return apiGet<TrainingDownloadStatus>('/download/status');
}

export async function getDataSummary() {
  return apiGet<TrainingDataSummary>('/data/summary');
}

// --- Training ---

export async function startTraining(config?: {
  tickers?: string[];
  initialCash?: number;
  startTime?: number;
  endTime?: number;
  seedRunId?: string;
}) {
  return apiPost<{ success: boolean; runId: string; totalSteps: number; tickers: string[] }>('/start', config);
}

export async function stopTraining() {
  return apiPost<{ stopped: boolean; runId?: string }>('/stop');
}

export async function getTrainingStatus() {
  return apiGet<TrainingStatus>('/status');
}

// --- Results ---

export async function getTrainingResults(runId: string) {
  return apiGet<TrainingResults>(`/results/${runId}`);
}

export async function getTrainingRuns(limit = 20) {
  return apiGet<TrainingRun[]>(`/runs?limit=${limit}`);
}

export async function getTrainingTrades(runId: string, limit = 500) {
  return apiGet<TrainingTrade[]>(`/trades/${runId}?limit=${limit}`);
}

export async function getTrainingEquity(runId: string, limit = 2000) {
  return apiGet<TrainingEquityPoint[]>(`/equity/${runId}?limit=${limit}`);
}

// --- State Transfer ---

export async function getCurrentLiveState() {
  return apiGet<{
    adaptiveWeights: Record<string, unknown>;
    beastMode: Record<string, unknown>;
    circuitBreaker: Record<string, unknown>;
    optimizer: Record<string, unknown>;
  }>('/current-state');
}

export async function applyTrainedState(runId: string, components?: string[]) {
  return apiPost<{
    success: boolean;
    runId: string;
    applied: string[];
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
  }>('/apply', { runId, components });
}

// --- Seed Operations ---

export async function distillSeed(runId: string, options?: { minProfitPct?: number; amplifyBigWins?: boolean; profitFocused?: boolean }) {
  return apiPost<{ success: boolean; runId: string; stats: Record<string, unknown> }>('/distill', { runId, ...options });
}

export async function breedSeeds(seedIds: string[], options?: { consensusThreshold?: number }) {
  return apiPost<{ success: boolean; runId: string; stats: Record<string, unknown> }>('/breed', { seedIds, ...options });
}

// --- Walk-Forward Validation ---

export async function startWalkForward(config?: WalkForwardConfig) {
  return apiPost<{ success: boolean; id: string; totalFolds: number }>('/walk-forward/start', config);
}

export async function stopWalkForward() {
  return apiPost<{ stopped: boolean; id?: string }>('/walk-forward/stop');
}

export async function getWalkForwardStatus() {
  return apiGet<WalkForwardStatus>('/walk-forward/status');
}

export async function getWalkForwardResults(id: string) {
  return apiGet<WalkForwardRun & { folds: any[]; config: any }>(`/walk-forward/results/${id}`);
}

export async function getWalkForwardRuns(limit = 20) {
  return apiGet<Array<{ id: string; status: string; totalFolds: number; completedFolds: number; aggregateOOS: any; createdAt: number }>>(`/walk-forward/runs?limit=${limit}`);
}

export async function triggerWalkForwardRetrain(id: string) {
  return apiPost<{ success: boolean; samplesCopied?: number; reason?: string; message?: string }>(`/walk-forward/retrain/${id}`);
}
