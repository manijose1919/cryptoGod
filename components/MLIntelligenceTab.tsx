/**
 * MLIntelligenceTab — Full ML pipeline dashboard for the F5 tab.
 * Shows model accuracy, SHAP explanations, ensemble weights, drift alerts, feature importance.
 */
import React, { useState, useEffect } from 'react';

interface PipelineStatus {
  mlEngine: { isTrained: boolean; accuracy: number; sampleCount: number; modelType: string };
  tfEngine: { status: string; accuracy: number; epochs: number };
  tftEngine: { status: string };
  rlAgent: { status: string; episodes: number; totalSteps: number };
  onlineLearner: { weights: Record<string, number> };
  anomalyDetector: { isReady: boolean };
  featureCount: number;
  lastTrainTime: number;
}

interface ModelHistory {
  id: number;
  modelType: string;
  accuracy: number;
  trainedAt: number;
  sampleCount: number;
}

interface FeatureImportance {
  name: string;
  importance: number;
}

export default function MLIntelligenceTab() {
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [models, setModels] = useState<ModelHistory[]>([]);
  const [features, setFeatures] = useState<FeatureImportance[]>([]);
  const [thoughts, setThoughts] = useState<any[]>([]);
  const [drift, setDrift] = useState<any>(null);
  const [gatekeeper, setGatekeeper] = useState<any[]>([]);
  const [execStats, setExecStats] = useState<any>(null);

  useEffect(() => {
    const load = () => {
      fetch('/api/ml/pipeline-status').then(r => r.ok ? r.json() : null).then(d => d && setPipeline(d)).catch(() => {});
      fetch('/api/ml/status').then(r => r.ok ? r.json() : null).then(d => {
        if (d?.modelHistory) setModels(d.modelHistory.map((m: any) => ({ id: m.id || 0, modelType: m.type, accuracy: m.accuracy, sampleCount: m.samples, trainedAt: m.date })));
      }).catch(() => {});
      fetch('/api/ml/feature-importance').then(r => r.ok ? r.json() : []).then(d => Array.isArray(d) && setFeatures(d)).catch(() => {});
      fetch('/api/ml/thoughts?limit=20').then(r => r.ok ? r.json() : []).then(d => Array.isArray(d) && setThoughts(d)).catch(() => {});
      fetch('/api/ml/feature-drift').then(r => r.ok ? r.json() : null).then(d => d && setDrift(d)).catch(() => {});
      fetch('/api/ml/gatekeeper-log?limit=30').then(r => r.ok ? r.json() : []).then(d => Array.isArray(d) && setGatekeeper(d)).catch(() => {});
      fetch('/api/execution/stats').then(r => r.ok ? r.json() : null).then(d => d && setExecStats(d)).catch(() => {});
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ padding: '16px', maxWidth: '1400px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '16px', letterSpacing: '1px' }}>
        ML PIPELINE INTELLIGENCE
      </h2>

      {/* Pipeline Status Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        <StatusCard title="ENSEMBLE (RF+GBT+LR)" status={pipeline?.mlEngine?.isTrained ? 'TRAINED' : 'UNTRAINED'}
          color={pipeline?.mlEngine?.isTrained ? 'var(--green)' : 'var(--red)'}>
          <div>Accuracy: {(pipeline?.mlEngine?.accuracy || 0).toFixed(1)}%</div>
          <div>Samples: {pipeline?.mlEngine?.sampleCount || 0}</div>
          <div>Type: {pipeline?.mlEngine?.modelType || 'N/A'}</div>
        </StatusCard>

        <StatusCard title="TF.js LSTM" status={pipeline?.tfEngine?.status || 'IDLE'}
          color={pipeline?.tfEngine?.status === 'ready' ? 'var(--green)' : 'var(--text-muted)'}>
          <div>Accuracy: {(pipeline?.tfEngine?.accuracy || 0).toFixed(1)}%</div>
          <div>Epochs: {pipeline?.tfEngine?.epochs || 0}</div>
        </StatusCard>

        <StatusCard title="TFT TRANSFORMER" status={pipeline?.tftEngine?.status || 'IDLE'}
          color={pipeline?.tftEngine?.status === 'ready' ? 'var(--green)' : 'var(--text-muted)'}>
          <div>Multi-horizon attention</div>
        </StatusCard>

        <StatusCard title="RL AGENT (PPO)" status={pipeline?.rlAgent?.status || 'IDLE'}
          color={pipeline?.rlAgent?.status === 'ready' ? 'var(--green)' : 'var(--text-muted)'}>
          <div>Episodes: {pipeline?.rlAgent?.episodes || 0}</div>
          <div>Steps: {pipeline?.rlAgent?.totalSteps || 0}</div>
        </StatusCard>

        <StatusCard title="ANOMALY DETECTOR" status={pipeline?.anomalyDetector?.isReady ? 'READY' : 'INITIALIZING'}
          color={pipeline?.anomalyDetector?.isReady ? 'var(--green)' : 'var(--text-muted)'}>
          <div>Isolation Forest</div>
        </StatusCard>

        <StatusCard title="ONLINE LEARNER" status="ACTIVE" color="var(--green)">
          {pipeline?.onlineLearner?.weights && Object.entries(pipeline.onlineLearner.weights).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{k}</span><span>{(v as number).toFixed(3)}</span>
            </div>
          ))}
        </StatusCard>
      </div>

      {/* Feature Drift Alert */}
      {drift && drift.driftDetected && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '11px' }}>
          <span style={{ color: 'var(--red)', fontWeight: 700 }}>DRIFT ALERT</span>
          <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>
            Feature distribution shift detected — model may need retraining.
            Affected features: {drift.driftedFeatures?.join(', ') || 'unknown'}
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* Model History */}
        <div className="glass-card" style={{ padding: '14px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>MODEL HISTORY</h3>
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', maxHeight: '300px', overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '0.5fr 1fr 1fr 1fr 1fr', gap: '4px', padding: '4px 0', borderBottom: '1px solid var(--border-primary)', color: 'var(--text-muted)', fontWeight: 600 }}>
              <span>#</span><span>TYPE</span><span>ACCURACY</span><span>SAMPLES</span><span>TRAINED</span>
            </div>
            {models.map((m, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '0.5fr 1fr 1fr 1fr 1fr', gap: '4px', padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span>{m.id}</span>
                <span>{m.modelType}</span>
                <span style={{ color: m.accuracy > 70 ? 'var(--green)' : m.accuracy > 55 ? 'var(--yellow, #eab308)' : 'var(--red)' }}>
                  {m.accuracy.toFixed(1)}%
                </span>
                <span>{m.sampleCount}</span>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(m.trainedAt).toLocaleDateString()}</span>
              </div>
            ))}
            {models.length === 0 && <div style={{ padding: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>No models trained yet</div>}
          </div>
        </div>

        {/* Feature Importance */}
        <div className="glass-card" style={{ padding: '14px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>FEATURE IMPORTANCE (TOP 20)</h3>
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', maxHeight: '300px', overflow: 'auto' }}>
            {features.slice(0, 20).map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
                <span style={{ width: '20px', color: 'var(--text-muted)' }}>{i + 1}</span>
                <span style={{ flex: 1 }}>{f.name}</span>
                <div style={{ width: '100px', height: '6px', background: 'var(--border-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, f.importance * 100)}%`, background: '#6366f1', borderRadius: '3px' }} />
                </div>
                <span style={{ width: '40px', textAlign: 'right', color: 'var(--text-muted)' }}>{(f.importance * 100).toFixed(1)}</span>
              </div>
            ))}
            {features.length === 0 && <div style={{ padding: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>No feature data</div>}
          </div>
        </div>
      </div>

      {/* ML Thoughts / Decision Log */}
      <div className="glass-card" style={{ padding: '14px', marginTop: '16px' }}>
        <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>ML DECISION LOG</h3>
        <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', maxHeight: '250px', overflow: 'auto' }}>
          {thoughts.map((t, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, width: '55px' }}>
                {new Date(t.timestamp || t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ color: t.action?.includes('BLOCK') || t.action?.includes('DISAGREE') ? 'var(--red)' : t.action?.includes('PASS') || t.action?.includes('AGREE') ? 'var(--green)' : 'var(--text-header)', fontWeight: 600, flexShrink: 0, width: '70px' }}>
                {t.action || t.type}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>{t.ticker}</span>
              <span style={{ flex: 1, color: 'var(--text-muted)' }}>{t.reason}</span>
              <span style={{ color: '#6366f1', flexShrink: 0 }}>{t.confidence}%</span>
            </div>
          ))}
          {thoughts.length === 0 && <div style={{ padding: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>No ML decisions logged yet</div>}
        </div>
      </div>

      {/* Bottom row: Gatekeeper + Execution Quality */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>
        {/* Gatekeeper Log */}
        <div className="glass-card" style={{ padding: '14px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>GATEKEEPER LOG</h3>
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', maxHeight: '250px', overflow: 'auto' }}>
            {gatekeeper.map((g, i) => (
              <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0, width: '50px' }}>
                  {new Date(g.timestamp || g.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{
                  color: g.decision === 'BLOCK' ? 'var(--red)' : 'var(--green)',
                  fontWeight: 700, flexShrink: 0, width: '45px'
                }}>
                  {g.decision}
                </span>
                <span style={{ flexShrink: 0, width: '65px' }}>{g.ticker}</span>
                <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.reason}
                </span>
                <span style={{ color: '#6366f1', flexShrink: 0 }}>{g.confidence?.toFixed?.(0) || g.ml_confidence?.toFixed?.(0) || '?'}%</span>
              </div>
            ))}
            {gatekeeper.length === 0 && <div style={{ padding: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>No gatekeeper decisions</div>}
          </div>
        </div>

        {/* Execution Quality */}
        <div className="glass-card" style={{ padding: '14px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '10px' }}>EXECUTION QUALITY</h3>
          {execStats && execStats.totalExecutions > 0 ? (
            <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>TRADES</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-header)' }}>{execStats.totalExecutions}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>AVG SLIPPAGE</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: execStats.avgActualSlippage < 0.1 ? 'var(--green)' : 'var(--text-header)' }}>
                    {(execStats.avgActualSlippage * 100).toFixed(2)}%
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>LIMIT FILL RATE</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#6366f1' }}>
                    {(execStats.limitFillRate * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Est. vs Actual Slippage Savings</span>
                <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                  {execStats.slippageSavings > 0 ? '+' : ''}{(execStats.slippageSavings * 100).toFixed(3)}%
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>Avg Execution Time</span>
                <span>{execStats.avgExecutionTimeMs}ms</span>
              </div>
            </div>
          ) : (
            <div style={{ padding: '8px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '10px' }}>No execution data yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCard({ title, status, color, children }: { title: string; status: string; color: string; children: React.ReactNode }) {
  return (
    <div className="glass-card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-header)', letterSpacing: '0.3px' }}>{title}</span>
        <span style={{ fontSize: '9px', fontWeight: 700, color, padding: '1px 6px', borderRadius: '4px', background: `${color}15` }}>{status}</span>
      </div>
      <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  );
}
