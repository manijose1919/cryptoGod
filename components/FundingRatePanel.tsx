/**
 * FundingRatePanel — Displays funding rates across exchanges and arb opportunities.
 */

import { useEffect, useState } from 'react';

interface FundingRate {
  ticker: string;
  rate: number;
  annualized: number;
  exchange: string;
  spotPrice?: number;
  futuresPrice?: number;
  basis?: number;
}

export default function FundingRatePanel() {
  const [rates, setRates] = useState<FundingRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    async function fetchRates() {
      try {
        const res = await fetch('/api/funding-rates/compare');
        const data = await res.json();
        setRates(data?.rates || []);
        setLastUpdated(new Date());
        setError(false);
      } catch { setError(true); }
      setLoading(false);
    }

    fetchRates();
    const interval = setInterval(fetchRates, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="glass-card-sm p-4 text-slate-400 text-sm">Loading funding rates...</div>;
  if (error) return <div className="glass-card-sm p-4 text-slate-500 text-sm">Unable to load funding rate data</div>;
  if (rates.length === 0) return <div className="glass-card-sm p-4 text-slate-500 text-sm">No funding rate data</div>;

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold text-slate-200 mb-3">Funding Rates</h3>

      <table className="trade-table w-full">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Rate</th>
            <th>Ann.</th>
            <th>Basis</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r, i) => {
            const isArb = Math.abs(r.annualized) > 20;
            return (
              <tr key={i}>
                <td className="font-medium">{r.ticker.replace('USD', '')}</td>
                <td className={r.rate >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {(r.rate * 100).toFixed(4)}%
                </td>
                <td className={r.annualized >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {(r.annualized || 0).toFixed(1)}%
                </td>
                <td>{r.basis != null ? `${(r.basis * 100).toFixed(2)}%` : 'N/A'}</td>
                <td>
                  {isArb ? (
                    <span className="badge badge-yellow text-xs">ARB</span>
                  ) : r.annualized > 10 ? (
                    <span className="badge badge-green text-xs">Bullish</span>
                  ) : r.annualized < -10 ? (
                    <span className="badge badge-red text-xs">Bearish</span>
                  ) : (
                    <span className="badge badge-blue text-xs">Neutral</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="text-xs text-slate-500 mt-2 flex justify-between">
        <span title="Annualized funding rates above 20% may signal arbitrage opportunities between spot and perpetual futures.">
          High annualized rates ({'>'}20%) may indicate funding rate arbitrage opportunity
        </span>
        {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}</span>}
      </div>
    </div>
  );
}
