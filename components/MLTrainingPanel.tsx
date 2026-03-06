import React, { useState, useEffect, useCallback } from 'react';

// ---------- Interfaces ----------

interface MLTrainingPanelProps {
  addLog?: (msg: string, type?: 'BUY' | 'SELL' | 'INFO' | 'WARN' | 'ERROR' | 'SPECIAL') => void;
}

interface PipelineStatus {
  tfEngine?: { available: boolean; modelCount?: number; lastTrainedAt?: number; accuracy?: number };
  rlAgent?: { available: boolean; episodes?: number; steps?: number };
  warRoom?: { available: boolean; totalDecisions?: number };
  syntheticData?: { available: boolean };
  onlineLearner?: { available: boolean; totalUpdates?: number };
  flags?: Record<string, boolean>;
}

interface MLModelStatus {
  hasModel: boolean;
  latestModel: {
    type: string;
    accuracy: number;
    sampleCount: number;
    createdAt: number;
  } | null;
  predictionAccuracy: { total: number; correct: number | null; avg_confidence: number | null; accuracy_pct: number | null } | number;
  modelHistory: Array<{ type: string; accuracy: number; samples: number; date: number }>;
}

interface JobStatus {
  status: string;
  jobId?: number;
  totalPairs?: number;
  completedPairs?: number;
  totalSamples?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  errors?: Array<{ ticker: string; error: string }>;
}

interface NewListingSignal {
  type: string;
  value: number;
  threshold?: number;
  weight?: number;
  severity?: string;
}

interface NewListing {
  ticker: string;
  firstSeen: number;
  ageDays: string;
  peakPrice: number;
  peakVolume: number;
  lastPrice: number;
  lastVolume: number;
  rugPullScore: number;
  signals: NewListingSignal[];
  exitedRugPull: boolean;
  cooldownUntil: number | null;
  isOnCooldown: boolean;
  hourlyVolumeCount: number;
}

interface NewListingsResponse {
  listings: NewListing[];
  stats: {
    knownTickersCount?: number;
    activeNewListings?: number;
    initialized?: boolean;
  };
}

// ---------- Helper Components ----------

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
      <span>{icon}</span> {title}
    </h4>
  );
}

function StatBox({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-gray-900/40 rounded-lg p-2.5 text-center">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">{label}</div>
      <div className={`text-sm font-bold font-mono ${color}`}>{value}</div>
    </div>
  );
}

function ProgressBar({ value, max, color = 'bg-cyan-500' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-gray-700/50 rounded-full h-2">
      <div
        className={`h-2 rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function RiskBadge({ score }: { score: number }) {
  let label: string;
  let classes: string;

  if (score >= 3) {
    label = 'HIGH RISK';
    classes = 'bg-red-500/20 text-red-400 border border-red-500/30';
  } else if (score >= 1) {
    label = 'CAUTION';
    classes = 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
  } else {
    label = 'OK';
    classes = 'bg-green-500/20 text-green-400 border border-green-500/30';
  }

  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${classes}`}>
      {label}
    </span>
  );
}

function SignalTag({ signal }: { signal: NewListingSignal }) {
  const typeColors: Record<string, string> = {
    VOLUME_CRASH: 'bg-red-900/40 text-red-300',
    PRICE_DROP_FROM_PEAK: 'bg-orange-900/40 text-orange-300',
    SPREAD_WIDENING: 'bg-yellow-900/40 text-yellow-300',
    VOLUME_PRICE_DIVERGENCE: 'bg-purple-900/40 text-purple-300',
  };

  const cls = typeColors[signal.type] || 'bg-gray-700 text-gray-300';

  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${cls}`}>
      {signal.type.replace(/_/g, ' ')}
    </span>
  );
}

function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return 'Never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '--';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ---------- Main Component ----------

export const MLTrainingPanel: React.FC<MLTrainingPanelProps> = ({ addLog }) => {
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null);
  const [mlStatus, setMlStatus] = useState<MLModelStatus | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [listings, setListings] = useState<NewListing[]>([]);
  const [listingStats, setListingStats] = useState<NewListingsResponse['stats']>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [pipelineRes, mlRes, jobRes, listingsRes] = await Promise.allSettled([
        fetch('/api/ml/pipeline-status'),
        fetch('/api/ml/status'),
        fetch('/api/ml-training/sample-generation-status'),
        fetch('/api/ml-training/new-listings'),
      ]);

      if (pipelineRes.status === 'fulfilled' && pipelineRes.value.ok) {
        setPipelineStatus(await pipelineRes.value.json());
      }

      if (mlRes.status === 'fulfilled' && mlRes.value.ok) {
        setMlStatus(await mlRes.value.json());
      }

      if (jobRes.status === 'fulfilled' && jobRes.value.ok) {
        const job = await jobRes.value.json();
        setJobStatus(job);
        // If job just completed while we were generating, clear generating state
        if (generating && job && job.status !== 'running') {
          setGenerating(false);
        }
      }

      if (listingsRes.status === 'fulfilled' && listingsRes.value.ok) {
        const data: NewListingsResponse = await listingsRes.value.json();
        setListings(data.listings || []);
        setListingStats(data.stats || {});
      }

      setError(null);
    } catch (err) {
      console.error('[MLTrainingPanel] fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch ML training data');
    } finally {
      setLoading(false);
    }
  }, [generating]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleGenerateSamples = useCallback(async () => {
    setGenerating(true);
    addLog?.('[ML Training] Starting synthetic sample generation...', 'info');

    try {
      const res = await fetch('/api/ml-training/generate-samples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const result = await res.json();

      if (result.error) {
        addLog?.(`[ML Training] Error: ${result.error}`, 'error');
        setGenerating(false);
        return;
      }

      addLog?.(`[ML Training] Job ${result.jobId} started (${result.totalPairs || '?'} pairs)`, 'success');
    } catch (err) {
      addLog?.(`[ML Training] Failed to start generation: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      setGenerating(false);
    }
  }, [addLog]);

  // Derived values
  const modelAccuracy = mlStatus?.latestModel?.accuracy
    ? (mlStatus.latestModel.accuracy * 100).toFixed(1) + '%'
    : '--';

  const totalSamples = mlStatus?.latestModel?.sampleCount ?? '--';

  const predictionCount = typeof mlStatus?.predictionAccuracy === 'object'
    ? mlStatus.predictionAccuracy.total
    : typeof mlStatus?.predictionAccuracy === 'number'
      ? mlStatus.predictionAccuracy
      : '--';

  const predictionPct = typeof mlStatus?.predictionAccuracy === 'object' && mlStatus.predictionAccuracy.accuracy_pct != null
    ? mlStatus.predictionAccuracy.accuracy_pct.toFixed(1) + '%'
    : null;

  const lastTrained = mlStatus?.latestModel?.createdAt
    ? formatTimeAgo(mlStatus.latestModel.createdAt)
    : '--';

  const isJobRunning = jobStatus?.status === 'running' || generating;
  const jobProgressPct = jobStatus?.totalPairs && jobStatus.totalPairs > 0
    ? ((jobStatus.completedPairs || 0) / jobStatus.totalPairs * 100).toFixed(0)
    : null;

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-500/20 to-cyan-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            ML Training
          </h3>
          <div className="flex items-center gap-2">
            {pipelineStatus?.tfEngine?.available && (
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping motion-reduce:animate-none" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
                </span>
                Pipeline Active
              </span>
            )}
            <button
              onClick={fetchAll}
              className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {loading && !mlStatus && !jobStatus ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Loading ML training data...</span>
        </div>
      ) : error && !mlStatus && !jobStatus ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchAll}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">

          {/* ====== Section 1: ML Training Status ====== */}
          <div>
            <SectionHeader title="Model Status" icon="&#9881;" />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatBox
                label="Accuracy"
                value={modelAccuracy}
                color={
                  mlStatus?.latestModel?.accuracy
                    ? mlStatus.latestModel.accuracy >= 0.65
                      ? 'text-green-400'
                      : mlStatus.latestModel.accuracy >= 0.50
                        ? 'text-yellow-400'
                        : 'text-red-400'
                    : 'text-gray-500'
                }
              />
              <StatBox label="Samples" value={totalSamples} color="text-cyan-400" />
              <StatBox
                label="Predictions"
                value={predictionPct ? `${predictionCount} (${predictionPct})` : String(predictionCount)}
                color="text-blue-400"
              />
              <StatBox label="Last Trained" value={lastTrained} color="text-gray-300" />
            </div>

            {/* Pipeline sub-systems */}
            {pipelineStatus && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { key: 'tfEngine', label: 'TF.js LSTM' },
                  { key: 'rlAgent', label: 'RL Agent' },
                  { key: 'warRoom', label: 'War Room' },
                  { key: 'syntheticData', label: 'Synthetic' },
                  { key: 'onlineLearner', label: 'Online' },
                ].map(({ key, label }) => {
                  const sys = (pipelineStatus as Record<string, any>)[key];
                  const available = sys && sys.available !== false;
                  return (
                    <span
                      key={key}
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        available
                          ? 'bg-green-900/30 text-green-400 border border-green-500/20'
                          : 'bg-gray-800 text-gray-600 border border-gray-700'
                      }`}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Model type */}
            {mlStatus?.latestModel?.type && (
              <div className="mt-2 text-[10px] text-gray-500">
                Model: <span className="text-gray-400 font-mono">{mlStatus.latestModel.type}</span>
              </div>
            )}
          </div>

          {/* ====== Section 2: Synthetic Sample Generation ====== */}
          <div className="border-t border-white/5 pt-4">
            <SectionHeader title="Synthetic Sample Generation" icon="&#9889;" />

            {/* Generate button */}
            <button
              onClick={handleGenerateSamples}
              disabled={isJobRunning}
              className={`w-full mb-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                isJobRunning
                  ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white shadow-lg shadow-violet-500/20 hover:shadow-violet-500/40'
              }`}
            >
              {isJobRunning ? 'Generating...' : 'Generate Samples'}
            </button>

            {/* Job progress */}
            {jobStatus && jobStatus.status === 'running' && (
              <div className="space-y-2 bg-gray-900/40 rounded-lg p-3">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">
                    Progress: {jobStatus.completedPairs || 0} / {jobStatus.totalPairs || '?'} pairs
                  </span>
                  {jobProgressPct && (
                    <span className="text-cyan-400 font-mono">{jobProgressPct}%</span>
                  )}
                </div>
                <ProgressBar
                  value={jobStatus.completedPairs || 0}
                  max={jobStatus.totalPairs || 1}
                  color="bg-cyan-500"
                />
                <div className="flex justify-between text-[10px] text-gray-500">
                  <span>Samples: <span className="text-cyan-400 font-mono">{jobStatus.totalSamples ?? 0}</span></span>
                  {jobStatus.startedAt && (
                    <span>Elapsed: {formatDuration(Date.now() - jobStatus.startedAt)}</span>
                  )}
                </div>
              </div>
            )}

            {/* Last completed job result */}
            {jobStatus && jobStatus.status !== 'running' && jobStatus.status !== 'unavailable' && (
              <div className={`rounded-lg p-3 text-xs ${
                jobStatus.status === 'completed'
                  ? 'bg-green-900/20 border border-green-500/20'
                  : jobStatus.status === 'failed'
                    ? 'bg-red-900/20 border border-red-500/20'
                    : 'bg-gray-900/40'
              }`}>
                <div className="flex justify-between items-center">
                  <span className={
                    jobStatus.status === 'completed' ? 'text-green-400 font-medium' :
                    jobStatus.status === 'failed' ? 'text-red-400 font-medium' :
                    'text-gray-400'
                  }>
                    {jobStatus.status === 'completed' ? 'Last Job: Completed' :
                     jobStatus.status === 'failed' ? 'Last Job: Failed' :
                     `Last Job: ${jobStatus.status}`}
                  </span>
                  {jobStatus.completedAt && (
                    <span className="text-gray-500">{formatTimeAgo(jobStatus.completedAt)}</span>
                  )}
                </div>
                {jobStatus.status === 'completed' && (
                  <div className="mt-1 text-gray-400">
                    {jobStatus.completedPairs ?? '?'} pairs processed, {jobStatus.totalSamples ?? 0} samples generated
                    {jobStatus.startedAt && jobStatus.completedAt && (
                      <span className="text-gray-500"> in {formatDuration(jobStatus.completedAt - jobStatus.startedAt)}</span>
                    )}
                  </div>
                )}
                {jobStatus.status === 'failed' && jobStatus.error && (
                  <div className="mt-1 text-red-300">{jobStatus.error}</div>
                )}
              </div>
            )}

            {/* No data state */}
            {!jobStatus && (
              <div className="text-xs text-gray-600 text-center py-2">
                No generation jobs yet. Click above to start.
              </div>
            )}
          </div>

          {/* ====== Section 3: New Listings ====== */}
          <div className="border-t border-white/5 pt-4">
            <SectionHeader title="New Kraken Listings" icon="&#9733;" />

            {/* Stats bar */}
            {listingStats.knownTickersCount != null && (
              <div className="flex gap-3 text-[10px] text-gray-500 mb-2">
                <span>Known tickers: <span className="text-gray-400 font-mono">{listingStats.knownTickersCount}</span></span>
                <span>Active new: <span className="text-cyan-400 font-mono">{listingStats.activeNewListings ?? 0}</span></span>
                <span>
                  Detector: {listingStats.initialized
                    ? <span className="text-green-400">Active</span>
                    : <span className="text-gray-600">Inactive</span>
                  }
                </span>
              </div>
            )}

            {listings.length === 0 ? (
              <div className="text-xs text-gray-600 text-center py-4 bg-gray-900/30 rounded-lg">
                No new listings detected. The detector monitors for newly added Kraken pairs.
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {listings.map((listing) => {
                  const dropFromPeak = listing.peakPrice > 0
                    ? ((listing.lastPrice - listing.peakPrice) / listing.peakPrice * 100).toFixed(1)
                    : null;

                  return (
                    <div
                      key={listing.ticker}
                      className={`bg-gray-900/40 rounded-lg p-3 border ${
                        listing.rugPullScore >= 3
                          ? 'border-red-500/30'
                          : listing.rugPullScore >= 1
                            ? 'border-yellow-500/20'
                            : 'border-white/5'
                      }`}
                    >
                      {/* Header row */}
                      <div className="flex justify-between items-center mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">{listing.ticker}</span>
                          <RiskBadge score={listing.rugPullScore} />
                          {listing.isOnCooldown && (
                            <span className="text-[9px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                              COOLDOWN
                            </span>
                          )}
                          {listing.exitedRugPull && (
                            <span className="text-[9px] bg-red-900/40 text-red-400 px-1.5 py-0.5 rounded">
                              EXITED
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-500">
                          {listing.ageDays}d old
                        </span>
                      </div>

                      {/* Price / Volume row */}
                      <div className="grid grid-cols-3 gap-2 text-[10px] mb-1.5">
                        <div>
                          <span className="text-gray-500">Price: </span>
                          <span className="text-gray-300 font-mono">
                            ${listing.lastPrice > 0.01
                              ? listing.lastPrice.toFixed(2)
                              : listing.lastPrice.toFixed(6)}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Peak: </span>
                          <span className="text-gray-300 font-mono">
                            ${listing.peakPrice > 0.01
                              ? listing.peakPrice.toFixed(2)
                              : listing.peakPrice.toFixed(6)}
                          </span>
                        </div>
                        {dropFromPeak !== null && (
                          <div>
                            <span className="text-gray-500">vs Peak: </span>
                            <span className={`font-mono ${
                              parseFloat(dropFromPeak) >= 0 ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {parseFloat(dropFromPeak) >= 0 ? '+' : ''}{dropFromPeak}%
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Rug-pull score bar */}
                      {listing.rugPullScore > 0 && (
                        <div className="mb-1.5">
                          <div className="flex justify-between text-[10px] mb-0.5">
                            <span className="text-gray-500">Rug-Pull Score</span>
                            <span className={`font-mono ${
                              listing.rugPullScore >= 3 ? 'text-red-400' :
                              listing.rugPullScore >= 1 ? 'text-yellow-400' : 'text-green-400'
                            }`}>
                              {listing.rugPullScore}/5
                            </span>
                          </div>
                          <ProgressBar
                            value={listing.rugPullScore}
                            max={5}
                            color={
                              listing.rugPullScore >= 3 ? 'bg-red-500' :
                              listing.rugPullScore >= 1 ? 'bg-yellow-500' : 'bg-green-500'
                            }
                          />
                        </div>
                      )}

                      {/* Signal tags */}
                      {listing.signals.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {listing.signals.map((signal, i) => (
                            <SignalTag key={`${signal.type}-${i}`} signal={signal} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MLTrainingPanel;
