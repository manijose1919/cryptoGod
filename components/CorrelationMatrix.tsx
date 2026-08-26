import React, { useState, useEffect } from 'react';
import { fetchCorrelationMatrix, type CorrelationMatrix as CorrMatrix } from '../services/correlationRiskService';

interface Props {
  tickers?: string[];
}

const getColor = (value: number): string => {
  if (value >= 0.8) return 'bg-red-500/80';
  if (value >= 0.6) return 'bg-orange-500/60';
  if (value >= 0.3) return 'bg-yellow-500/40';
  if (value >= 0) return 'bg-green-500/30';
  if (value >= -0.3) return 'bg-blue-500/30';
  if (value >= -0.6) return 'bg-blue-500/50';
  return 'bg-purple-500/60';
};

export const CorrelationMatrix: React.FC<Props> = () => {
  const [data, setData] = useState<CorrMatrix | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const result = await fetchCorrelationMatrix('5m', 30);
        if (!cancelled) setData(result);
      } catch (e) {
        // Silently fail
      }
      if (!cancelled) setLoading(false);
    };
    load();
    const interval = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading && !data) {
    return (
      <div className="glass-card p-4">
        <h3 className="text-sm font-semibold text-cyan-300 mb-2">Correlation Matrix</h3>
        <div className="text-xs text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!data || data.tickers.length === 0) {
    return (
      <div className="glass-card p-4">
        <h3 className="text-sm font-semibold text-cyan-300 mb-2">Correlation Matrix</h3>
        <div className="text-xs text-gray-400">No data available yet</div>
      </div>
    );
  }

  const displayTickers = data.tickers.map(t => t.replace('USD', ''));

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-cyan-300 mb-3">Correlation Matrix</h3>
      <div className="overflow-x-auto">
        <div className="inline-grid gap-px" style={{
          gridTemplateColumns: `40px repeat(${data.tickers.length}, 36px)`,
        }}>
          {/* Header row */}
          <div />
          {displayTickers.map(t => (
            <div key={`h-${t}`} className="text-[9px] text-gray-400 text-center truncate">{t}</div>
          ))}

          {/* Data rows */}
          {data.tickers.map((rowTicker, i) => (
            <React.Fragment key={rowTicker}>
              <div className="text-[9px] text-gray-400 text-right pr-1 flex items-center justify-end">
                {displayTickers[i]}
              </div>
              {data.tickers.map((colTicker, j) => {
                const val = data.matrix[i][j];
                return (
                  <div
                    key={`${i}-${j}`}
                    className={`w-9 h-7 flex items-center justify-center text-[9px] font-mono rounded-sm ${getColor(val)}`}
                    title={`${rowTicker} vs ${colTicker}: ${val.toFixed(2)}`}
                  >
                    {i === j ? '1.0' : val.toFixed(1)}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 text-[9px] text-gray-500">
        <span className="inline-block w-3 h-3 bg-red-500/80 rounded-sm" /> High
        <span className="inline-block w-3 h-3 bg-yellow-500/40 rounded-sm" /> Mid
        <span className="inline-block w-3 h-3 bg-green-500/30 rounded-sm" /> Low
        <span className="inline-block w-3 h-3 bg-blue-500/50 rounded-sm" /> Negative
      </div>
    </div>
  );
};

export default CorrelationMatrix;
