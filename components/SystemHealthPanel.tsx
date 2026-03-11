import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
const SystemConfigPanel = lazy(() => import('./SystemConfigPanel'));

interface ServiceStatus {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'error' | 'degraded' | 'unknown';
  lastActive?: number;
  details?: string;
}

interface HealthData {
  status: string;
  uptime: number;
  version?: string;
  timestamp: number;
}

interface SystemStatusData {
  cpu: number;
  memory: { used: number; total: number; percentage: number };
  services: ServiceStatus[];
  cycleLatency: number;
  activeConnections?: number;
  dbSize?: number;
}

interface LatencyPoint {
  time: number;
  value: number;
}

const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  trading_engine: 'Trading Engine',
  circuit_breaker: 'Circuit Breaker',
  beast_mode: 'Beast Mode',
  websocket: 'WebSocket Feed',
  database: 'Database',
  binance_ws: 'Binance WS',
  rl_agent: 'RL Agent',
  sequence_model: 'Sequence Model',
  signal_scanner: 'Signal Scanner',
  multi_exchange: 'Multi-Exchange',
};

function StatusDot({ status }: { status: ServiceStatus['status'] }) {
  const colorMap = {
    running: 'bg-green-400 shadow-green-400/50',
    stopped: 'bg-gray-500 shadow-gray-500/50',
    error: 'bg-red-400 shadow-red-400/50',
    degraded: 'bg-yellow-400 shadow-yellow-400/50',
    unknown: 'bg-gray-600',
  };

  const isActive = status === 'running' || status === 'degraded';

  return (
    <span className="relative flex h-2.5 w-2.5">
      {isActive && (
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none ${colorMap[status]}`} />
      )}
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 shadow-lg ${colorMap[status]}`} />
    </span>
  );
}

function UsageBar({ label, value, max, unit }: {
  label: string;
  value: number;
  max: number;
  unit: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : pct > 50 ? 'bg-cyan-500' : 'bg-green-500';
  const textColor = pct > 90 ? 'text-red-400' : pct > 70 ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className={`font-mono ${textColor}`}>
          {value.toFixed(1)}{unit}
          {max > 0 && <span className="text-gray-600"> / {max.toFixed(0)}{unit}</span>}
        </span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function LatencyChart({ points }: { points: LatencyPoint[] }) {
  if (points.length < 2) return null;

  const chartHeight = 40;
  const chartWidth = 200;
  const padding = { top: 2, bottom: 2, left: 0, right: 0 };
  const plotW = chartWidth - padding.left - padding.right;
  const plotH = chartHeight - padding.top - padding.bottom;

  const values = points.map(p => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;

  const pathPoints = points.map((p, i) => {
    const x = padding.left + (i / (points.length - 1)) * plotW;
    const y = padding.top + plotH - ((p.value - minVal) / range) * plotH;
    return `${x},${y}`;
  });

  const pathD = `M ${pathPoints.join(' L ')}`;

  // Area fill
  const areaD = `${pathD} L ${padding.left + plotW},${padding.top + plotH} L ${padding.left},${padding.top + plotH} Z`;

  const lastVal = values[values.length - 1];
  const avgVal = values.reduce((s, v) => s + v, 0) / values.length;
  const color = lastVal > 500 ? '#ef4444' : lastVal > 200 ? '#eab308' : '#22c55e';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>Cycle Latency</span>
        <span>
          Last: <span style={{ color }} className="font-mono">{lastVal.toFixed(0)}ms</span>
          {' | Avg: '}
          <span className="font-mono text-gray-400">{avgVal.toFixed(0)}ms</span>
        </span>
      </div>
      <svg width={chartWidth} height={chartHeight} className="w-full h-auto">
        <defs>
          <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#latencyGradient)" />
        <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {/* Latest point */}
        <circle
          cx={padding.left + plotW}
          cy={padding.top + plotH - ((lastVal - minVal) / range) * plotH}
          r={3}
          fill={color}
        />
      </svg>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export const SystemHealthPanel: React.FC = () => {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null);
  const [apiKeyHealth, setApiKeyHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const maxLatencyPoints = useRef(60); // 5 min at 5s intervals

  const fetchHealth = useCallback(async () => {
    try {
      const [healthRes, statusRes, apiKeyRes] = await Promise.allSettled([
        fetch('/api/health'),
        fetch('/api/system/status'),
        fetch('/api/api-health'),
      ]);

      // Parse health
      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const hData = await healthRes.value.json();
        setHealth({
          status: hData.status || 'unknown',
          uptime: hData.uptime ?? hData.uptimeSeconds ?? 0,
          version: hData.version,
          timestamp: hData.timestamp ?? Date.now(),
        });
      }

      // Parse system status
      if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
        const sData = await statusRes.value.json();

        // Normalize services
        const rawServices = sData.services || sData.service_status || {};
        const serviceList: ServiceStatus[] = typeof rawServices === 'object' && !Array.isArray(rawServices)
          ? Object.entries(rawServices).map(([key, val]: [string, any]) => ({
              name: key,
              displayName: SERVICE_DISPLAY_NAMES[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              status: typeof val === 'string' ? val as ServiceStatus['status'] :
                      typeof val === 'object' ? (val.status || 'unknown') as ServiceStatus['status'] : 'unknown',
              lastActive: typeof val === 'object' ? val.lastActive ?? val.last_active : undefined,
              details: typeof val === 'object' ? val.details ?? val.error : undefined,
            }))
          : Array.isArray(rawServices)
            ? rawServices.map((s: any) => ({
                name: s.name || s.id || 'unknown',
                displayName: SERVICE_DISPLAY_NAMES[s.name] || s.name?.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) || 'Unknown',
                status: (s.status || 'unknown') as ServiceStatus['status'],
                lastActive: s.lastActive ?? s.last_active,
                details: s.details ?? s.error,
              }))
            : [];

        // Ensure expected services are in the list
        const expectedServices = ['trading_engine', 'circuit_breaker', 'beast_mode', 'websocket', 'database', 'binance_ws', 'rl_agent', 'sequence_model'];
        for (const svcName of expectedServices) {
          if (!serviceList.find(s => s.name === svcName)) {
            serviceList.push({
              name: svcName,
              displayName: SERVICE_DISPLAY_NAMES[svcName] || svcName,
              status: 'unknown',
            });
          }
        }

        const memory = sData.memory || {};
        const cpuVal = sData.cpu ?? sData.cpu_usage ?? sData.cpuPercent ?? 0;
        const latencyVal = sData.cycleLatency ?? sData.cycle_latency ?? sData.latency ?? 0;

        setSystemStatus({
          cpu: typeof cpuVal === 'number' ? cpuVal : parseFloat(cpuVal) || 0,
          memory: {
            used: memory.used ?? memory.heapUsed ?? 0,
            total: memory.total ?? memory.heapTotal ?? memory.rss ?? 0,
            percentage: memory.percentage ?? memory.percent ?? (memory.total > 0 ? (memory.used / memory.total * 100) : 0),
          },
          services: serviceList,
          cycleLatency: latencyVal,
          activeConnections: sData.activeConnections ?? sData.connections,
          dbSize: sData.dbSize ?? sData.db_size,
        });

        // Parse API key health (returns array or {services: [...]})
        if (apiKeyRes.status === 'fulfilled' && apiKeyRes.value.ok) {
          const akData = await apiKeyRes.value.json();
          setApiKeyHealth(Array.isArray(akData) ? akData : akData.services || akData);
        }

        // Track latency history
        if (latencyVal > 0) {
          setLatencyHistory(prev => {
            const next = [...prev, { time: Date.now(), value: latencyVal }];
            return next.slice(-maxLatencyPoints.current);
          });
        }
      }

      setError(null);
    } catch (err) {
      console.error('SystemHealthPanel fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch system health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const runningCount = systemStatus?.services.filter(s => s.status === 'running').length ?? 0;
  const totalServices = systemStatus?.services.length ?? 0;
  const healthColor = health?.status === 'ok' || health?.status === 'healthy' ? 'text-green-400' :
    health?.status === 'degraded' ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4 animate-fade-up">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-lg p-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-xl">&#9889;</span> System Health
          </h3>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping motion-reduce:animate-none" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
              </span>
              Live
            </span>
            <button
              onClick={fetchHealth}
              className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {loading && !health && !systemStatus ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full" />
          <span className="ml-2 text-gray-400 text-sm">Checking system health...</span>
        </div>
      ) : error && !health && !systemStatus ? (
        <div className="text-center py-6">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={fetchHealth}
            className="mt-2 text-xs px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status Banner */}
          {health && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusDot status={health.status === 'ok' || health.status === 'healthy' ? 'running' : 'error'} />
                <span className={`text-sm font-medium ${healthColor}`}>
                  {(health.status || 'unknown').toUpperCase()}
                </span>
                {health.version && (
                  <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">
                    v{health.version}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-[10px] text-gray-500">Uptime</div>
                <div className="text-xs text-white font-mono">{formatUptime(health.uptime)}</div>
              </div>
            </div>
          )}

          {/* Resource Usage */}
          {systemStatus && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Resources</h4>
              <UsageBar label="CPU" value={systemStatus.cpu} max={100} unit="%" />
              <UsageBar
                label="Memory"
                value={systemStatus.memory.used / (1024 * 1024)}
                max={systemStatus.memory.total / (1024 * 1024)}
                unit="MB"
              />
            </div>
          )}

          {/* Latency Trend */}
          {latencyHistory.length > 1 && (
            <div className="bg-gray-900/30 rounded-lg p-2">
              <LatencyChart points={latencyHistory} />
            </div>
          )}

          {/* Service Status Grid */}
          {systemStatus && systemStatus.services.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Services ({runningCount}/{totalServices} running)
              </h4>
              <div className="grid grid-cols-2 gap-1.5">
                {systemStatus.services.map((svc) => (
                  <div
                    key={svc.name}
                    className={`flex items-center gap-2 p-2 rounded ${
                      svc.status === 'error' ? 'bg-red-900/20 border border-red-500/20' :
                      svc.status === 'degraded' ? 'bg-yellow-900/20 border border-yellow-500/20' :
                      'bg-gray-900/30 border border-transparent'
                    }`}
                  >
                    <StatusDot status={svc.status} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-300 truncate">{svc.displayName}</div>
                      {svc.details && (
                        <div className="text-[10px] text-gray-600 truncate" title={svc.details}>
                          {svc.details}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* API Key Health */}
          {apiKeyHealth && (Array.isArray(apiKeyHealth) ? apiKeyHealth.length > 0 : Object.keys(apiKeyHealth).length > 0) && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">API Keys</h4>
              <div className="grid grid-cols-2 gap-1.5">
                {(Array.isArray(apiKeyHealth) ? apiKeyHealth : Object.entries(apiKeyHealth).map(([k, v]: [string, any]) => ({ ...v, label: v.label || k }))).map((info: any) => (
                  <div key={info.id || info.label} className="flex items-center gap-2 p-2 rounded bg-gray-900/30">
                    <StatusDot status={!info.configured ? 'stopped' : info.errorCount > 5 ? 'error' : info.status === 'ok' ? 'running' : 'degraded'} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-300 truncate">{info.label || info.id || 'Unknown'}</div>
                      <div className="text-[10px] text-gray-600">
                        {info.configured ? (info.errorCount > 0 ? `${info.errorCount} errors` : 'OK') : 'Not configured'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Extra Stats */}
          {systemStatus && (
            <div className="grid grid-cols-3 gap-2">
              {systemStatus.cycleLatency > 0 && (
                <div className="bg-gray-900/50 p-2 rounded text-center">
                  <div className="text-[10px] text-gray-500 uppercase">Latency</div>
                  <div className={`text-sm font-mono font-medium ${
                    systemStatus.cycleLatency > 500 ? 'text-red-400' :
                    systemStatus.cycleLatency > 200 ? 'text-yellow-400' : 'text-green-400'
                  }`}>
                    {systemStatus.cycleLatency.toFixed(0)}ms
                  </div>
                </div>
              )}
              {systemStatus.activeConnections !== undefined && (
                <div className="bg-gray-900/50 p-2 rounded text-center">
                  <div className="text-[10px] text-gray-500 uppercase">Connections</div>
                  <div className="text-sm font-medium text-white">{systemStatus.activeConnections}</div>
                </div>
              )}
              {systemStatus.dbSize !== undefined && (
                <div className="bg-gray-900/50 p-2 rounded text-center">
                  <div className="text-[10px] text-gray-500 uppercase">DB Size</div>
                  <div className="text-sm font-medium text-white">
                    {(systemStatus.dbSize / (1024 * 1024)).toFixed(1)}MB
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Feature Flags Configuration */}
      <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '11px' }}>Loading config panel...</div>}>
        <SystemConfigPanel />
      </Suspense>
    </div>
  );
};

export default SystemHealthPanel;
