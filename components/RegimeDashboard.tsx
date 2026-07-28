/**
 * RegimeDashboard — Shows current regime per ticker, Fear & Greed, derivatives sentiment.
 */

import { useEffect, useState } from 'react';

interface RegimeInfo {
  ticker: string;
  regime: string;
  confidence?: number;
}

const REGIME_COLORS: Record<string, string> = {
  STRONG_UP: 'badge-green',
  UP: 'badge-green',
  SIDEWAYS: 'badge-blue',
  DOWN: 'badge-red',
  STRONG_DOWN: 'badge-red',
};

const REGIME_ICONS: Record<string, string> = {
  STRONG_UP: '\u2B06\uFE0F',
  UP: '\u2197\uFE0F',
  SIDEWAYS: '\u27A1\uFE0F',
  DOWN: '\u2198\uFE0F',
  STRONG_DOWN: '\u2B07\uFE0F',
};

export default function RegimeDashboard() {
  const [regimes, setRegimes] = useState<RegimeInfo[]>([]);
  const [fearGreed, setFearGreed] = useState<{ value: number; label: string } | null>(null);
  const [derivs, setDerivs] = useState<Record<string, unknown> | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    async function fetchData() {
      const [regRes, fgRes, drvRes] = await Promise.allSettled([
        fetch('/api/signals/regime').then(r => r.json()),
        fetch('/api/fear-greed/status').then(r => r.json()),
        fetch('/api/derivatives/all').then(r => r.json()),
      ]);
      if (regRes.status === 'fulfilled') setRegimes(regRes.value?.regimes || []);
      if (fgRes.status === 'fulfilled' && fgRes.value?.enabled !== false) setFearGreed(fgRes.value);
      if (drvRes.status === 'fulfilled') setDerivs(drvRes.value);
      setLastUpdated(new Date());
    }

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold text-slate-200 mb-3">Market Regime</h3>

      {/* Fear & Greed */}
      {fearGreed && (
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs text-slate-400">Fear & Greed:</span>
          <span className={`badge text-xs ${
            fearGreed.value <= 25 ? 'badge-red' :
            fearGreed.value <= 45 ? 'badge-yellow' :
            fearGreed.value <= 55 ? 'badge-blue' :
            fearGreed.value <= 75 ? 'badge-green' : 'badge-green'
          }`}>
            {fearGreed.value} — {fearGreed.label || 'Neutral'}
          </span>
        </div>
      )}

      {/* Regime badges */}
      <div className="flex flex-wrap gap-2">
        {regimes.length > 0 ? regimes.map((r) => (
          <div key={r.ticker} className={`badge ${REGIME_COLORS[r.regime] || 'badge-blue'} text-xs`}>
            {REGIME_ICONS[r.regime] || ''} {r.ticker.replace('USD', '')}: {r.regime}
          </div>
        )) : (
          <span className="text-xs text-slate-500">No regime data available</span>
        )}
      </div>

      {/* Derivatives summary */}
      {derivs && (() => {
        // Filter out non-ticker metadata keys (e.g. "ticker", "error", "enabled")
        const tickerEntries = Object.entries(derivs).filter(
          ([_key, val]) => val && typeof val === 'object' && 'signal' in (val as Record<string, unknown>)
        );
        return tickerEntries.length > 0 ? (
          <div className="mt-3 pt-3 border-t border-slate-700/50">
            <span className="text-xs text-slate-400">Derivatives Signals</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {tickerEntries.map(([ticker, data]: [string, any]) => (
                <span key={ticker} className={`badge text-xs ${
                  data?.signal === 'BULLISH' ? 'badge-green' :
                  data?.signal === 'BEARISH' ? 'badge-red' : 'badge-blue'
                }`}>
                  {ticker.replace('USD', '')}: {data?.signal || 'N/A'}
                </span>
              ))}
            </div>
          </div>
        ) : null;
      })()}

      {lastUpdated && (
        <div className="text-[10px] text-slate-500 mt-2 text-right">
          Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}
        </div>
      )}
    </div>
  );
}
