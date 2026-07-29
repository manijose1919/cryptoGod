/**
 * ArbitragePanel — Shows cross-exchange arbitrage opportunities and basis trades.
 */
import { useState, useEffect } from 'react';

interface ArbOpportunity {
  ticker: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  estProfitUsd: number;
  score: number;
}

interface BasisOpp {
  ticker: string;
  fundingAPR: number;
  estDailyIncome: number;
  longShortRatio: number;
  isActive: boolean;
  score: number;
}

export default function ArbitragePanel() {
  const [arbData, setArbData] = useState<{ enabled: boolean; opportunities: ArbOpportunity[] } | null>(null);
  const [basisData, setBasisData] = useState<{ opportunities: BasisOpp[]; simBalance: number; totalFunding: number } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    const load = () => {
      Promise.allSettled([
        fetch('/api/arbitrage/status').then(r => r.ok ? r.json() : null),
        fetch('/api/basis/opportunities').then(r => r.ok ? r.json() : null),
      ]).then(([arbRes, basisRes]) => {
        if (arbRes.status === 'fulfilled' && arbRes.value) setArbData(arbRes.value);
        if (basisRes.status === 'fulfilled' && basisRes.value) setBasisData(basisRes.value);
        setLastUpdated(new Date());
      });
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="glass-card" style={{ padding: '14px' }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px', letterSpacing: '0.5px' }}>
        ARBITRAGE & BASIS TRADING
      </h3>

      {/* Cross-Exchange Arbitrage */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>CROSS-EXCHANGE SPREADS</div>
        {arbData?.opportunities && arbData.opportunities.length > 0 ? (
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            {arbData.opportunities.slice(0, 5).map((opp, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontWeight: 600 }}>{opp.ticker}</span>
                <span style={{ color: 'var(--text-muted)' }}>{opp.buyExchange} → {opp.sellExchange}</span>
                <span style={{ color: opp.spreadPct > 0.5 ? 'var(--green)' : 'var(--yellow, #eab308)' }}>
                  {(opp.spreadPct || 0).toFixed(3)}%
                </span>
                <span style={{ color: 'var(--green)' }}>+${opp.estProfitUsd?.toFixed(2) || '?'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', padding: '6px' }}>
            {arbData?.enabled ? 'NO PROFITABLE SPREADS DETECTED' : 'SCANNING...'}
          </div>
        )}
      </div>

      {/* Basis/Funding Rate Arb */}
      <div>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
          FUNDING RATE OPPORTUNITIES
          {basisData && <span style={{ float: 'right' }}>SIM: ${(basisData.simBalance || 0).toFixed(0)} | Collected: ${(basisData.totalFunding || 0).toFixed(2)}</span>}
        </div>
        {basisData?.opportunities && basisData.opportunities.length > 0 ? (
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            {basisData.opportunities.map((opp, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontWeight: 600, color: opp.isActive ? 'var(--green)' : 'var(--text-header)' }}>
                  {opp.isActive ? '● ' : ''}{opp.ticker}
                </span>
                <span style={{ color: opp.fundingAPR > 30 ? 'var(--green)' : 'var(--text-muted)' }}>
                  {(opp.fundingAPR || 0).toFixed(1)}% APR
                </span>
                <span style={{ color: 'var(--text-muted)' }}>
                  ~${(opp.estDailyIncome || 0).toFixed(2)}/day
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>
                  L/S: {opp.longShortRatio?.toFixed(2) || '?'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', padding: '6px' }}>
            NO FUNDING RATE OPPORTUNITIES
          </div>
        )}
      </div>

      {lastUpdated && (
        <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'right' }}>
          Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}
        </div>
      )}
    </div>
  );
}
