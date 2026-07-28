/**
 * SystemConfigPanel — Toggle all 56 feature flags from systemConfig.js.
 * Groups flags by category with toggle switches and numeric inputs.
 */
import { useState, useEffect, useCallback } from 'react';

interface FlagGroup {
  title: string;
  description: string;
  flags: string[];
}

const FLAG_GROUPS: FlagGroup[] = [
  {
    title: 'ML GATEKEEPER',
    description: 'Controls whether ML model gates trade entries',
    flags: ['ML_GATEKEEPER_ENABLED', 'ML_GATEKEEPER_MODE', 'ML_MIN_CONFIDENCE_TO_BLOCK', 'ML_MIN_CONFIDENCE_TO_OVERRIDE', 'ML_AUTO_DOWNGRADE_THRESHOLD', 'ML_AUTO_DOWNGRADE_WINDOW'],
  },
  {
    title: 'GENETIC EVOLUTION',
    description: 'Evolves decision-tree genomes via genetic algorithm',
    flags: ['GENETIC_ENABLED', 'GENETIC_POPULATION_SIZE', 'GENETIC_MAX_DEPTH', 'GENETIC_MIN_TRADES_TO_ACTIVATE', 'GENETIC_MUTATION_RATE', 'GENETIC_ELITISM_COUNT', 'GENETIC_TOP_K_SIGNALS'],
  },
  {
    title: 'CORRELATION ENGINE',
    description: 'Portfolio correlation risk management',
    flags: ['CORRELATION_ENGINE_ENABLED', 'CORRELATION_BLOCK_THRESHOLD', 'CORRELATION_REDUCE_THRESHOLD', 'CORRELATION_MAX_CLUSTER_ALLOC', 'CORRELATION_UPDATE_INTERVAL_MS'],
  },
  {
    title: 'ADVERSARIAL BRAINS',
    description: 'Bull vs Bear dual-brain debate system',
    flags: ['ADVERSARIAL_ENABLED', 'ADVERSARIAL_MIN_MARGIN', 'ADVERSARIAL_MIN_SAMPLES'],
  },
  {
    title: 'ML & ANALYTICS',
    description: 'Core ML pipeline features',
    flags: ['FEATURE_SELECTION_ENABLED', 'LSTM_ENABLED', 'REGIME_MODELS_ENABLED', 'ONCHAIN_DATA_ENABLED', 'SHAP_ENABLED', 'HYPERPARAM_TUNING_ENABLED', 'MONTE_CARLO_ENABLED', 'SMART_EXECUTION_ENABLED', 'PORTFOLIO_OPTIMIZER_ENABLED', 'CONTINUOUS_BACKTEST_ENABLED'],
  },
  {
    title: 'DEEP LEARNING (Phases 1-3)',
    description: 'TF.js LSTM, TFT Transformer, RL Agent',
    flags: ['TF_ENABLED', 'TF_LSTM_HIDDEN_UNITS', 'TF_DROPOUT_RATE', 'TF_LEARNING_RATE', 'TF_MAX_EPOCHS', 'TFT_ENABLED', 'TFT_ATTENTION_HEADS', 'TFT_HIDDEN_DIM', 'TFT_HORIZONS', 'RL_AGENT_ENABLED', 'RL_CLIP_RATIO', 'RL_TRAINING_EPISODES'],
  },
  {
    title: 'ADVANCED ML (Phases 4-8)',
    description: 'Multi-agent, synthetic data, online learning, SHAP, features',
    flags: ['MULTI_AGENT_ENABLED', 'META_LEARNER_ALPHA', 'SYNTHETIC_DATA_ENABLED', 'SYNTHETIC_MULTIPLIER', 'SYNTHETIC_QUALITY_THRESHOLD', 'ONLINE_LEARNING_ENABLED', 'DRIFT_DETECTION_ENABLED', 'ROLLBACK_ENABLED', 'SHAP_DRIFT_TRACKING_ENABLED', 'CALIBRATION_METHOD', 'FEATURE_INTERACTIONS_ENABLED', 'MTF_FEATURES_ENABLED', 'WAVELET_FEATURES_ENABLED'],
  },
];

function isBoolFlag(value: unknown): boolean {
  return typeof value === 'boolean';
}

function isStringFlag(key: string): boolean {
  return key === 'ML_GATEKEEPER_MODE' || key === 'CALIBRATION_METHOD';
}

export default function SystemConfigPanel() {
  const [flags, setFlags] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [systemStats, setSystemStats] = useState<any>(null);

  const load = useCallback(() => {
    fetch('/api/system-config')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.flags) setFlags(d.flags);
        setSystemStats({ gatekeeper: d?.gatekeeper, correlation: d?.correlation, adversarial: d?.adversarial, genetic: d?.genetic });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateFlag = useCallback(async (key: string, value: any) => {
    const newFlags = { ...flags, [key]: value };
    setFlags(newFlags);
    setSaving(true);
    try {
      const res = await fetch('/api/system-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags: { [key]: value } }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.flags) setFlags(data.flags);
        setLastSaved(key);
        setTimeout(() => setLastSaved(null), 2000);
      }
    } catch {} finally { setSaving(false); }
  }, [flags]);

  const killAll = useCallback(async () => {
    if (!confirm('Disable ALL ML systems? This will stop gatekeeper, genetic, correlation, and adversarial.')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/system-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ killAll: true }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.flags) setFlags(data.flags);
      }
    } catch {} finally { setSaving(false); }
  }, []);

  return (
    <div style={{ padding: '16px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-header)', letterSpacing: '1px' }}>
          SYSTEM CONFIGURATION
        </h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {saving && <span style={{ fontSize: '10px', color: '#6366f1' }}>Saving...</span>}
          {lastSaved && <span style={{ fontSize: '10px', color: 'var(--green)' }}>Saved: {lastSaved}</span>}
          <button onClick={killAll} style={{
            fontSize: '10px', padding: '4px 10px', borderRadius: '6px',
            background: 'rgba(239,68,68,0.1)', color: 'var(--red)',
            border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer', fontWeight: 700,
          }}>
            KILL ALL
          </button>
        </div>
      </div>

      {/* System Status Summary */}
      {systemStats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '16px' }}>
          <MiniStatus label="GATEKEEPER" value={systemStats.gatekeeper?.mode || 'OFF'}
            active={flags.ML_GATEKEEPER_ENABLED} detail={`${systemStats.gatekeeper?.totalDecisions || 0} decisions`} />
          <MiniStatus label="GENETIC" value={flags.GENETIC_ENABLED ? 'ON' : 'OFF'}
            active={flags.GENETIC_ENABLED} detail={`Pop: ${systemStats.genetic?.populationSize || 0}`} />
          <MiniStatus label="CORRELATION" value={flags.CORRELATION_ENGINE_ENABLED ? 'ON' : 'OFF'}
            active={flags.CORRELATION_ENGINE_ENABLED} detail={`${systemStats.correlation?.matrixTickers || 0} pairs`} />
          <MiniStatus label="ADVERSARIAL" value={flags.ADVERSARIAL_ENABLED ? 'ON' : 'OFF'}
            active={flags.ADVERSARIAL_ENABLED} detail={`Margin: ${systemStats.adversarial?.avgMargin?.toFixed?.(1) || 0}`} />
        </div>
      )}

      {/* Flag Groups */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {FLAG_GROUPS.map(group => (
          <div key={group.title} className="glass-card" style={{ padding: '14px' }}>
            <h3 style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '4px', letterSpacing: '0.5px' }}>
              {group.title}
            </h3>
            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              {group.description}
            </div>
            <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
              {group.flags.map(key => {
                const value = flags[key];
                if (value === undefined) return null;
                return (
                  <div key={key} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '4px 0', borderBottom: '1px solid var(--border-subtle)',
                  }}>
                    <span style={{ color: 'var(--text-muted)', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {key.replace(/^(ML_|GENETIC_|CORRELATION_|ADVERSARIAL_|TF_|TFT_|RL_|SYNTHETIC_|SHAP_)/, '')}
                    </span>
                    {isBoolFlag(value) ? (
                      <button
                        onClick={() => updateFlag(key, !value)}
                        style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
                          border: 'none', cursor: 'pointer',
                          background: value ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                          color: value ? 'var(--green)' : 'var(--red)',
                        }}
                      >
                        {value ? 'ON' : 'OFF'}
                      </button>
                    ) : isStringFlag(key) ? (
                      <select
                        value={String(value)}
                        onChange={e => updateFlag(key, e.target.value)}
                        style={{
                          fontSize: '9px', padding: '2px 4px', borderRadius: '4px',
                          background: 'var(--bg-secondary)', color: 'var(--text-header)',
                          border: '1px solid var(--border-primary)',
                        }}
                      >
                        {key === 'ML_GATEKEEPER_MODE' && ['ADVISORY', 'SOFT_GATE', 'HARD_GATE'].map(o => <option key={o} value={o}>{o}</option>)}
                        {key === 'CALIBRATION_METHOD' && ['isotonic', 'platt', 'none'].map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        type="number"
                        value={value}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v)) updateFlag(key, v);
                        }}
                        style={{
                          width: '60px', fontSize: '9px', padding: '2px 4px', borderRadius: '4px',
                          background: 'var(--bg-secondary)', color: 'var(--text-header)',
                          border: '1px solid var(--border-primary)', textAlign: 'right',
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStatus({ label, value, active, detail }: { label: string; value: string; active: boolean; detail: string }) {
  return (
    <div className="glass-card" style={{ padding: '10px', textAlign: 'center' }}>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: active ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>{value}</div>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{detail}</div>
    </div>
  );
}
