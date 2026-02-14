import React, { useState, useEffect, useCallback } from 'react';

interface CalibrationBucket {
  binStart: number;
  binEnd: number;
  predictedAvg: number;
  actualAvg: number;
  count: number;
}

interface CalibrationData {
  buckets: CalibrationBucket[];
  ece: number;
  totalPredictions: number;
  calibrationLabel: string;
  overconfidenceRatio: number;
  timestamp: number;
}

function CalibrationChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const chartHeight = 160;
  const chartWidth = 280;
  const padding = { top: 10, right: 10, bottom: 25, left: 35 };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  return (
    <svg width={chartWidth} height={chartHeight} className="w-full h-auto">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((val) => (
        <g key={`grid-${val}`}>
          <line
            x1={padding.left}
            y1={padding.top + plotHeight * (1 - val)}
            x2={padding.left + plotWidth}
            y2={padding.top + plotHeight * (1 - val)}
            stroke="#374151"
            strokeWidth={0.5}
            strokeDasharray="2,2"
          />
          <text
            x={padding.left - 4}
            y={padding.top + plotHeight * (1 - val) + 3}
            textAnchor="end"
            fontSize={8}
            fill="#6b7280"
          >
            {(val * 100).toFixed(0)}%
          </text>
        </g>
      ))}

      {/* Perfect calibration line (diagonal) */}
      <line
        x1={padding.left}
        y1={padding.top + plotHeight}
        x2={padding.left + plotWidth}
        y2={padding.top}
        stroke="#6b7280"
        strokeWidth={1}
        strokeDasharray="4,4"
        opacity={0.7}
      />

      {/* Predicted vs Actual bars */}
      {buckets.map((bucket, i) => {
        const barWidth = plotWidth / buckets.length;
        const x = padding.left + i * barWidth;

        // Predicted bar (blue outline)
        const predHeight = bucket.predictedAvg * plotHeight;
        // Actual bar (filled)
        const actHeight = bucket.actualAvg * plotHeight;

        const isOverconfident = bucket.predictedAvg > bucket.actualAvg + 0.05;
        const isUnderconfident = bucket.predictedAvg < bucket.actualAvg - 0.05;
        const fillColor = isOverconfident ? '#f59e0b' : isUnderconfident ? '#06b6d4' : '#22c55e';

        return (
          <g key={i}>
            {/* Actual outcome bar */}
            <rect
              x={x + barWidth * 0.15}
              y={padding.top + plotHeight - actHeight}
              width={barWidth * 0.35}
              height={actHeight}
              fill={fillColor}
              opacity={0.7}
              rx={1}
            />
            {/* Predicted bar */}
            <rect
              x={x + barWidth * 0.5}
              y={padding.top + plotHeight - predHeight}
              width={barWidth * 0.35}
              height={predHeight}
              fill="none"
              stroke="#818cf8"
              strokeWidth={1.5}
              rx={1}
            />
            {/* Bucket label */}
            <text
              x={x + barWidth / 2}
              y={chartHeight - 4}
              textAnchor="middle"
              fontSize={7}
              fill="#6b7280"
            >
              {(bucket.binStart * 100).toFixed(0)}-{(bucket.binEnd * 100).toFixed(0)}
            </text>
            {/* Count label */}
            {bucket.count > 0 && (
              <text
                x={x + barWidth / 2}
                y={padding.top + plotHeight - Math.max(predHeight, actHeight) - 3}
                textAnchor="middle"
                fontSize={7}
                fill="#9ca3af"
              >
                n={bucket.count}
              </text>
            )}
          </g>
        );
      })}

      {/* Axis labels */}
      <text
        x={padding.left + plotWidth / 2}
        y={chartHeight}
        textAnchor="middle"
        fontSize={8}
        fill="#9ca3af"
      >
        Predicted Probability
      </text>
    </svg>
  );
}

function ECEGauge({ ece }: { ece: number }) {
  const clampedEce = Math.max(0, Math.min(0.5, ece));
  const percentage = (clampedEce / 0.5) * 100;

  const getColor = (val: number) => {
    if (val < 0.05) return { bg: 'bg-green-500', text: 'text-green-400' };
    if (val < 0.1) return { bg: 'bg-cyan-500', text: 'text-cyan-400' };
    if (val < 0.2) return { bg: 'bg-yellow-500', text: 'text-yellow-400' };
    return { bg: 'bg-red-500', text: 'text-red-400' };
  };

  const { bg, text } = getColor(clampedEce);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">ECE Score</span>
        <span className={`font-mono font-medium ${text}`}>{(ece * 100).toFixed(2)}%</span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${bg}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-600">
        <span>Perfect (0%)</span>
        <span>Poor (50%+)</span>
      </div>
    </div>
  );
}

export const CalibrationPanel: React.FC = () => {
  const [data, setData] = useState<CalibrationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCalibration = useCallback(async () => {
    try {
      const response = await fetch('/api/calibration');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      // Normalize buckets - handle various response shapes
      const rawBuckets = result.buckets || result.calibration_curve || result.bins || [];
      const buckets: CalibrationBucket[] = rawBuckets.map((b: any, i: number) => ({
        binStart: b.binStart ?? b.bin_start ?? i * 0.1,
        binEnd: b.binEnd ?? b.bin_end ?? (i + 1) * 0.1,
        predictedAvg: b.predictedAvg ?? b.predicted_avg ?? b.predicted ?? 0,
        actualAvg: b.actualAvg ?? b.actual_avg ?? b.actual ?? 0,
        count: b.count ?? b.n ?? 0,
      }));

      // Determine calibration label
      const overconfident = buckets.filter(b => b.predictedAvg > b.actualAvg + 0.05).length;
      const underconfident = buckets.filter(b => b.predictedAvg < b.actualAvg - 0.05).length;
      const activeBuckets = buckets.filter(b => b.count > 0).length;

      let calibrationLabel = result.calibrationLabel || result.label || 'Unknown';
      if (calibrationLabel === 'Unknown' && activeBuckets > 0) {
        if (overconfident > underconfident + 2) calibrationLabel = 'Over-confident';
        else if (underconfident > overconfident + 2) calibrationLabel = 'Under-confident';
        else calibrationLabel = 'Well Calibrated';
      }

      setData({
        buckets,
        ece: result.ece ?? result.expected_calibration_error ?? 0,
        totalPredictions: result.totalPredictions ?? result.total ?? buckets.reduce((s: number, b: CalibrationBucket) => s + b.count, 0),
        calibrationLabel,
        overconfidenceRatio: activeBuckets > 0 ? overconfident / activeBuckets : 0,
        timestamp: result.timestamp ?? Date.now(),
      });
      setError(null);
    } catch (err) {
      console.error('CalibrationPanel fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch calibration data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCalibration();
    const interval = setInterval(fetchCalibration, 10000);
    return () => clearInterval(interval);
  }, [fetchCalibration]);

  const getLabelStyle = (label: string) => {
    if (label.includes('Well') || label.includes('Good')) return 'bg-green-900/40 text-green-400 border-green-500/30';
    if (label.includes('Over')) return 'bg-yellow-900/40 text-yellow-400 border-yellow-500/30';
    if (label.includes('Under')) return 'bg-cyan-900/40 text-cyan-400 border-cyan-500/30';
    return 'bg-gray-900/40 text-gray-400 border-gray-500/30';
  };

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#9881;</span> Prediction Calibration
          </h3>
          <button
            onClick={fetchCalibration}
            className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Loading calibration data...</span>
        </div>
      ) : error && !data ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchCalibration}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* Calibration Label */}
          <div className="flex items-center justify-between">
            <span className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${getLabelStyle(data.calibrationLabel)}`}>
              {data.calibrationLabel}
            </span>
            <div className="text-right">
              <div className="text-xs text-gray-500">Total Predictions</div>
              <div className="text-sm font-medium text-white">{data.totalPredictions.toLocaleString()}</div>
            </div>
          </div>

          {/* ECE Metric */}
          <ECEGauge ece={data.ece} />

          {/* Calibration Chart */}
          <div className="bg-gray-900/30 rounded-lg p-3">
            <div className="flex items-center gap-3 mb-2 text-[10px] text-gray-500">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-green-500 rounded-sm opacity-70" /> Actual
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 border border-indigo-400 rounded-sm" /> Predicted
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t border-dashed border-gray-500" /> Perfect
              </span>
            </div>
            <CalibrationChart buckets={data.buckets} />
          </div>

          {/* Bucket Details */}
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Bucket Breakdown</h4>
            <div className="grid grid-cols-5 gap-1 text-[10px] text-gray-500 font-medium px-1">
              <span>Range</span>
              <span>Predicted</span>
              <span>Actual</span>
              <span>Gap</span>
              <span className="text-right">Count</span>
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {data.buckets.filter(b => b.count > 0).map((bucket, i) => {
                const gap = bucket.predictedAvg - bucket.actualAvg;
                return (
                  <div key={i} className="grid grid-cols-5 gap-1 text-[10px] px-1 py-0.5 hover:bg-white/5 rounded">
                    <span className="text-gray-400">
                      {(bucket.binStart * 100).toFixed(0)}-{(bucket.binEnd * 100).toFixed(0)}%
                    </span>
                    <span className="text-indigo-400">{(bucket.predictedAvg * 100).toFixed(1)}%</span>
                    <span className="text-cyan-400">{(bucket.actualAvg * 100).toFixed(1)}%</span>
                    <span className={gap > 0.05 ? 'text-yellow-400' : gap < -0.05 ? 'text-cyan-400' : 'text-green-400'}>
                      {gap >= 0 ? '+' : ''}{(gap * 100).toFixed(1)}%
                    </span>
                    <span className="text-gray-500 text-right">{bucket.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default CalibrationPanel;
