import React, { useState, useEffect, useCallback } from 'react';

interface MLDashboardProps {
  ticker: string;
  isVisible?: boolean;
}

interface MLStatus {
  hasModel: boolean;
  latestModel: {
    id: number;
    modelType: string;
    accuracy: number;
    sampleCount: number;
    trainedAt: number;
  } | null;
  predictionAccuracy: { total: number; correct: number | null; avg_confidence: number | null; accuracy_pct: number | null } | number;
  modelHistory: Array<{
    id: number;
    modelType: string;
    accuracy: number;
    trainedAt: number;
  }>;
}

interface Prediction {
  id: number;
  timestamp: number;
  prediction: string;
  confidence: number;
  actual_outcome: string | null;
  was_correct: number | null;
}

interface FeatureImportance {
  name: string;
  importance: number;
  rank: number;
}

interface FearGreed {
  value: number;
  classification: string;
}

interface CollectionStatus {
  isRunning: boolean;
  totalSnapshots: number;
  cacheStats: {
    exchangeData: number;
    derivatives: number;
    defi: string;
    news: number;
    social: number;
    fearGreed: string;
  };
}

function StatCard({ label, value, color, subtext }: { label: string; value: string | number; color: string; subtext?: string }) {
  return (
    <div className="stat-card">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold text-${color}-400`}>{value}</p>
      {subtext && <p className="text-xs text-gray-600">{subtext}</p>}
    </div>
  );
}

function AccuracyGauge({ value, size }: { value: number; size: number }) {
  const radius = 40;
  const strokeWidth = 8;
  const normalizedRadius = radius - strokeWidth / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (value / 100) * circumference;

  let fillClass = 'gauge-fill-blue';
  if (value >= 65) fillClass = 'gauge-fill-green';
  else if (value < 45) fillClass = 'gauge-fill-red';

  return (
    <svg height={size} width={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle
        className="gauge-bg"
        stroke="currentColor"
        fill="transparent"
        strokeWidth={strokeWidth}
        r={normalizedRadius}
        cx={size / 2}
        cy={size / 2}
      />
      <circle
        className={fillClass}
        stroke="currentColor"
        fill="transparent"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference + ' ' + circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        r={normalizedRadius}
        cx={size / 2}
        cy={size / 2}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dy=".3em"
        fontSize="20"
        fontWeight="bold"
        fill="currentColor"
        style={{ transform: 'rotate(90deg)', transformOrigin: 'center' }}
      >
        {value.toFixed(0)}%
      </text>
    </svg>
  );
}

function FeatureBar({ name, value, maxImportance }: { name: string; value: number; maxImportance: number }) {
  const width = Math.min((value * 100) / maxImportance, 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-32 truncate" title={name}>{name}</span>
      <div className="flex-1 progress-bar">
        <div className="progress-bar-fill progress-bar-fill-brand" style={{ width: `${width}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-10 text-right">{(value * 100).toFixed(1)}%</span>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function MLDashboard({ ticker, isVisible = true }: MLDashboardProps) {
  const [mlStatus, setMlStatus] = useState<MLStatus | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [featureImportance, setFeatureImportance] = useState<FeatureImportance[]>([]);
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMLStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/ml/status');
      if (!response.ok) throw new Error('Failed to fetch ML status');
      const data = await response.json();
      setMlStatus(data);
    } catch (err) {
      console.error('Error fetching ML status:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  const fetchPredictions = useCallback(async () => {
    try {
      const response = await fetch(`/api/ml/predictions/${ticker}`);
      if (!response.ok) throw new Error('Failed to fetch predictions');
      const data = await response.json();
      setPredictions(data.predictions || []);
    } catch (err) {
      console.error('Error fetching predictions:', err);
    }
  }, [ticker]);

  const fetchFeatureImportance = useCallback(async () => {
    try {
      const response = await fetch('/api/ml/feature-importance');
      if (!response.ok) throw new Error('Failed to fetch feature importance');
      const data = await response.json();
      setFeatureImportance(Array.isArray(data) ? data : data?.features || []);
    } catch (err) {
      console.error('Error fetching feature importance:', err);
    }
  }, []);

  const fetchFearGreed = useCallback(async () => {
    try {
      const response = await fetch('/api/sentiment/fear-greed');
      if (!response.ok) throw new Error('Failed to fetch fear & greed');
      const data = await response.json();
      setFearGreed(data);
    } catch (err) {
      console.error('Error fetching fear & greed:', err);
    }
  }, []);

  const fetchCollectionStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/multi-exchange/status');
      if (!response.ok) throw new Error('Failed to fetch collection status');
      const data = await response.json();
      setCollectionStatus(data);
    } catch (err) {
      console.error('Error fetching collection status:', err);
    }
  }, []);

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([
      fetchMLStatus(),
      fetchPredictions(),
      fetchFeatureImportance(),
      fetchFearGreed(),
      fetchCollectionStatus(),
    ]);
    setLoading(false);
  }, [fetchMLStatus, fetchPredictions, fetchFeatureImportance, fetchFearGreed, fetchCollectionStatus]);

  useEffect(() => {
    if (!isVisible) return;

    fetchAllData();
    const interval = setInterval(fetchAllData, 30000); // Poll every 30s

    return () => clearInterval(interval);
  }, [ticker, isVisible, fetchAllData]);

  if (!isVisible) return null;

  if (loading && !mlStatus) {
    return (
      <div className="glass-card p-4 animate-fade-up">
        <div className="flex items-center justify-center py-8">
          <div className="text-gray-400">Loading ML Intelligence...</div>
        </div>
      </div>
    );
  }

  if (error && !mlStatus) {
    return (
      <div className="glass-card p-4 animate-fade-up">
        <div className="flex items-center justify-center py-8">
          <div className="text-red-400">Error: {error}</div>
        </div>
      </div>
    );
  }

  const accuracy = Number(mlStatus?.latestModel?.accuracy) || 0;
  const sampleCount = Number(mlStatus?.latestModel?.sampleCount) || 0;
  const predictionCount = predictions.length;
  const fearGreedValue = Number(fearGreed?.value) || 50;
  const fearGreedClass = fearGreed?.classification || 'Neutral';

  let fgColor = 'yellow';
  if (fearGreedValue >= 75) fgColor = 'green';
  else if (fearGreedValue >= 55) fgColor = 'cyan';
  else if (fearGreedValue <= 25) fgColor = 'red';
  else if (fearGreedValue <= 45) fgColor = 'orange';

  const top10Features = featureImportance.slice(0, 10);
  const maxImportance = Math.max(...featureImportance.map(f => f.importance), 0.01);

  const isCollecting = collectionStatus?.isRunning || false;
  const snapshots = collectionStatus?.totalSnapshots || 0;
  const sources = [
    { name: 'Binance', active: isCollecting && (collectionStatus?.cacheStats?.exchangeData || 0) > 0 },
    { name: 'OKX', active: isCollecting && (collectionStatus?.cacheStats?.derivatives || 0) > 0 },
    { name: 'CoinGecko', active: isCollecting && (collectionStatus?.cacheStats?.social || 0) > 0 },
    { name: 'DeFiLlama', active: isCollecting && collectionStatus?.cacheStats?.defi === 'loaded' },
    { name: 'Fear&Greed', active: isCollecting && collectionStatus?.cacheStats?.fearGreed === 'loaded' },
  ];

  return (
    <div className="glass-card p-4 space-y-4 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="gradient-header text-lg font-bold">ML Intelligence</h2>
        <div className="flex items-center gap-2">
          <span className={`pulse-dot ${mlStatus?.hasModel ? 'pulse-dot-green' : 'pulse-dot-yellow'}`} />
          <span className="text-xs text-gray-400">
            {mlStatus?.hasModel ? 'Model Active' : 'Collecting Data...'}
          </span>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Accuracy"
          value={`${accuracy.toFixed(1)}%`}
          color="blue"
        />
        <StatCard
          label="Samples"
          value={sampleCount.toLocaleString()}
          color="purple"
        />
        <StatCard
          label="Predictions"
          value={predictionCount}
          color="cyan"
        />
        <StatCard
          label="Fear & Greed"
          value={fearGreedValue}
          color={fgColor}
          subtext={fearGreedClass}
        />
      </div>

      {/* Model Accuracy Gauge */}
      {mlStatus?.hasModel && mlStatus.latestModel && (
        <div className="flex items-center gap-6">
          <AccuracyGauge value={accuracy} size={100} />
          <div>
            <p className="text-sm text-gray-300">Model: {mlStatus.latestModel.modelType}</p>
            <p className="text-xs text-gray-500">
              Trained: {formatTime(mlStatus.latestModel.trainedAt)}
            </p>
            <p className="text-xs text-gray-500">
              Samples: {mlStatus.latestModel.sampleCount.toLocaleString()}
            </p>
          </div>
        </div>
      )}

      {/* Feature Importance */}
      {top10Features.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Top Features</h3>
          <div className="space-y-1">
            {top10Features.map(f => (
              <FeatureBar
                key={f.name}
                name={f.name}
                value={f.importance}
                maxImportance={maxImportance}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent Predictions Table */}
      {predictions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Recent Predictions</h3>
          <div className="overflow-x-auto custom-scrollbar" style={{ maxHeight: 200 }}>
            <table className="trade-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Prediction</th>
                  <th>Confidence</th>
                  <th>Actual</th>
                  <th>Correct</th>
                </tr>
              </thead>
              <tbody>
                {predictions.slice(0, 10).map((p, i) => {
                  const predictionBadgeClass = p.prediction === 'UP'
                    ? 'bg-green-500/20 text-green-400 px-2 py-0.5 rounded text-xs font-semibold'
                    : 'bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-xs font-semibold';

                  return (
                    <tr key={p.id || `pred-${i}`}>
                      <td className="text-xs">{formatTime(p.timestamp)}</td>
                      <td>
                        <span className={predictionBadgeClass}>{p.prediction}</span>
                      </td>
                      <td className="text-xs">{(Number(p.confidence) * 100).toFixed(0)}%</td>
                      <td className="text-xs">{p.actual_outcome || '-'}</td>
                      <td className="text-xs">
                        {p.was_correct === 1 ? (
                          <span className="text-green-400">✓</span>
                        ) : p.was_correct === 0 ? (
                          <span className="text-red-400">✗</span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Data Collection Status */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Data Sources</h3>
        <div className="grid grid-cols-3 gap-2">
          {sources.map(s => (
            <div key={s.name} className="glass-card-sm p-2 flex items-center gap-2">
              <span className={`pulse-dot pulse-dot-${s.active ? 'green' : 'red'}`} />
              <span className="text-xs text-gray-400">{s.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
