/**
 * TradingIntelligencePanel — Surfaces all the backend intelligence data
 * that was previously hidden: CVaR/Kelly, Whale Flow, Microstructure,
 * Meta-RL, Liquidation Sweeps, Native SL, AB Test, Market Intelligence.
 */
import React, { useState, useEffect } from 'react';

interface SectionData {
  cvarKelly: any;
  whaleFlow: any;
  microstructure: any;
  metaRL: any;
  liquidationSweep: any;
  nativeSL: any;
  abTest: any;
  marketIntel: any;
  journalPatterns: any;
}

export default function TradingIntelligencePanel() {
  const [data, setData] = useState<Partial<SectionData>>({});

  useEffect(() => {
    const load = () => {
      const endpoints: [keyof SectionData, string][] = [
        ['cvarKelly', '/api/cvar-kelly/status'],
        ['whaleFlow', '/api/whale-flow/status'],
        ['microstructure', '/api/microstructure/status'],
        ['metaRL', '/api/meta-rl/status'],
        ['liquidationSweep', '/api/liquidation-sweep/status'],
        ['nativeSL', '/api/native-sl/status'],
        ['abTest', '/api/ml-ab-test/status'],
        ['marketIntel', '/api/market-intelligence'],
        ['journalPatterns', '/api/journal/patterns'],
      ];
      for (const [key, url] of endpoints) {
        fetch(url).then(r => r.ok ? r.json() : null)
          .then(d => d && setData(prev => ({ ...prev, [key]: d })))
          .catch(() => {});
      }
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ padding: '0' }}>
      <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '12px', letterSpacing: '0.5px' }}>
        TRADING INTELLIGENCE
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
        {/* CVaR / Kelly */}
        <IntelCard title="CVaR-KELLY SIZING" color="#6366f1" data={data.cvarKelly}>
          {data.cvarKelly && (
            <>
              <Row label="Samples" value={`${data.cvarKelly.sampleCount || 0} / ${data.cvarKelly.minRequired || 20}`} />
              <Row label="Win Rate" value={data.cvarKelly.winRate || 'N/A'} color={(parseFloat(data.cvarKelly.winRate) || 0) >= 50 ? 'var(--green)' : 'var(--red)'} />
              <Row label="CVaR (95%)" value={data.cvarKelly.cvar || 'N/A'} />
              <Row label="VaR (95%)" value={data.cvarKelly.var95 || 'N/A'} />
              <Row label="Kurtosis" value={data.cvarKelly.kurtosis || 'N/A'} />
              <Row label="Max Loss" value={data.cvarKelly.maxLoss || 'N/A'} color="var(--red)" />
              <Row label="Max Win" value={data.cvarKelly.maxWin || 'N/A'} color="var(--green)" />
              <Row label="Position Bounds" value={`${data.cvarKelly.minPositionPct} - ${data.cvarKelly.maxPositionPct}`} />
            </>
          )}
        </IntelCard>

        {/* Whale Flow */}
        <IntelCard title="WHALE FLOW" color="#3b82f6" data={data.whaleFlow}>
          {data.whaleFlow && (
            <>
              <Row label="BTC Net Flow" value={`${(data.whaleFlow.btcNetFlow || 0).toFixed(2)} BTC`}
                color={(data.whaleFlow.btcNetFlow || 0) > 0 ? 'var(--red)' : 'var(--green)'} />
              <Row label="ETH Net Flow" value={`${(data.whaleFlow.ethNetFlow || 0).toFixed(2)} ETH`}
                color={(data.whaleFlow.ethNetFlow || 0) > 0 ? 'var(--red)' : 'var(--green)'} />
              <Row label="Large Transfers" value={`${data.whaleFlow.largeTransfers || 0}`} />
              <Row label="Signal" value={data.whaleFlow.signal || 'NEUTRAL'} />
            </>
          )}
        </IntelCard>

        {/* Order Book Microstructure */}
        <IntelCard title="MICROSTRUCTURE" color="#8b5cf6" data={data.microstructure}>
          {data.microstructure && (
            <>
              <Row label="VPIN" value={`${((data.microstructure.avgVpin || 0) * 100).toFixed(1)}%`}
                color={(data.microstructure.avgVpin || 0) > 0.7 ? 'var(--red)' : 'var(--text-header)'} />
              <Row label="Avg Spread" value={`${(data.microstructure.avgSpread || 0).toFixed(2)} bps`} />
              <Row label="Imbalance" value={`${((data.microstructure.avgImbalance || 0) * 100).toFixed(1)}%`} />
              <Row label="Tracked Pairs" value={`${data.microstructure.trackedPairs || 0}`} />
            </>
          )}
        </IntelCard>

        {/* Meta-RL Agent */}
        <IntelCard title="META-RL AGENT" color="#10b981" data={data.metaRL}>
          {data.metaRL && (
            <>
              <Row label="Status" value={data.metaRL.status || 'IDLE'} />
              <Row label="Total Updates" value={`${data.metaRL.totalUpdates || 0}`} />
              {data.metaRL.regimeParams && Object.entries(data.metaRL.regimeParams).slice(0, 4).map(([regime, params]: [string, any]) => (
                <Row key={regime} label={regime} value={`Size: ${(params?.sizeMult || 1).toFixed(2)}x`} />
              ))}
            </>
          )}
        </IntelCard>

        {/* Liquidation Sweep */}
        <IntelCard title="LIQUIDATION SWEEP" color="#ef4444" data={data.liquidationSweep}>
          {data.liquidationSweep && (
            <>
              <Row label="Status" value={data.liquidationSweep.enabled ? 'MONITORING' : 'DISABLED'} />
              <Row label="Cascades Detected" value={`${data.liquidationSweep.cascadesDetected || 0}`} />
              <Row label="Entries Triggered" value={`${data.liquidationSweep.entriesTriggered || 0}`} />
              <Row label="Last Cascade" value={data.liquidationSweep.lastCascadeTime
                ? new Date(data.liquidationSweep.lastCascadeTime).toLocaleTimeString() : 'None'} />
            </>
          )}
        </IntelCard>

        {/* Native Stop Loss */}
        <IntelCard title="NATIVE STOP-LOSS" color="#f59e0b" data={data.nativeSL}>
          {data.nativeSL && (
            <>
              <Row label="Active SL Orders" value={`${data.nativeSL.activeOrders || 0}`} />
              {data.nativeSL.orders?.map((order: any, i: number) => (
                <Row key={i} label={order.ticker} value={`SL @ $${(order.stopPrice || 0).toFixed(2)}`} color="var(--red)" />
              ))}
              {(!data.nativeSL.orders || data.nativeSL.orders.length === 0) &&
                <Row label="Status" value="No active stop-loss orders" />
              }
            </>
          )}
        </IntelCard>

        {/* ML A/B Test */}
        <IntelCard title="ML A/B TEST" color="#a78bfa" data={data.abTest}>
          {data.abTest && (
            <>
              <Row label="Champion" value={data.abTest.champion?.name || 'N/A'} />
              <Row label="Champion Acc." value={`${((data.abTest.champion?.accuracy || 0) * 100).toFixed(1)}%`} color="var(--green)" />
              <Row label="Challenger" value={data.abTest.challenger?.name || 'N/A'} />
              <Row label="Challenger Acc." value={`${((data.abTest.challenger?.accuracy || 0) * 100).toFixed(1)}%`} />
              <Row label="Samples" value={`${data.abTest.challenger?.sampleCount || 0}`} />
            </>
          )}
        </IntelCard>

        {/* Journal Patterns */}
        <IntelCard title="JOURNAL PATTERNS" color="#ec4899" data={data.journalPatterns}>
          {data.journalPatterns && (
            <>
              {Array.isArray(data.journalPatterns) ? data.journalPatterns.slice(0, 5).map((p: any, i: number) => (
                <Row key={i} label={p.pattern || p.name || `Pattern ${i + 1}`} value={p.frequency || p.count || ''} />
              )) : (
                <Row label="Status" value="No patterns detected yet" />
              )}
            </>
          )}
        </IntelCard>
      </div>
    </div>
  );
}

function IntelCard({ title, color, data, children }: { title: string; color: string; data: any; children: React.ReactNode }) {
  return (
    <div className="glass-card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-header)', letterSpacing: '0.3px' }}>{title}</span>
        <span style={{
          fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
          color: data ? color : 'var(--text-muted)',
          background: data ? `${color}15` : 'transparent',
        }}>
          {data ? 'ACTIVE' : 'OFFLINE'}
        </span>
      </div>
      <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        {data ? children : <span style={{ fontSize: '9px' }}>No data available</span>}
      </div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
      <span>{label}</span>
      <span style={{ color: color || 'var(--text-header)', fontWeight: 600 }}>{value}</span>
    </div>
  );
}
