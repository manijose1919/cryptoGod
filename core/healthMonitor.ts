/**
 * HealthMonitor — VPS system health monitoring.
 *
 * Tracks memory, uptime, event loop lag, and trading system health.
 * Exposes /api/health endpoint for monitoring.
 * Sends Telegram alerts when thresholds are exceeded.
 */

import tradingBus from './eventBus.ts';

interface HealthSnapshot {
  timestamp: number;
  uptime: number;               // Process uptime in seconds
  memoryUsage: {
    rss: number;                // Resident Set Size (MB)
    heapUsed: number;           // V8 heap used (MB)
    heapTotal: number;          // V8 heap total (MB)
    external: number;           // C++ objects (MB)
    heapUtilization: number;    // heapUsed / heapTotal
  };
  eventLoopLag: number;         // Event loop lag in ms
  tradingSystems: {
    krakenEngine: boolean;
    cryptoComEngine: boolean;
    mlPipeline: boolean;
    signalScanner: boolean;
    telegramV2: boolean;
    webSocket: boolean;
  };
  dbStats: {
    responsive: boolean;
    writeLatencyMs: number;
  };
  warnings: string[];
}

// ─── Thresholds ──────────────────────────────────────────────

const THRESHOLDS = {
  memoryRssMB: 512,          // Alert if RSS > 512MB
  heapUtilization: 0.90,     // Alert if heap > 90% utilized
  eventLoopLagMs: 100,       // Alert if loop lag > 100ms
  dbWriteLatencyMs: 500,     // Alert if DB write > 500ms
};

class HealthMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: HealthSnapshot | null = null;
  private alertCooldown = 0;         // Don't spam alerts
  private systemChecks: Map<string, boolean> = new Map();
  private eventLoopLag = 0;
  private lagTimer: ReturnType<typeof setInterval> | null = null;

  start(intervalMs = 30000): void {
    // Measure event loop lag
    let lastCheck = Date.now();
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.eventLoopLag = Math.max(0, now - lastCheck - 1000);
      lastCheck = now;
    }, 1000);

    this.interval = setInterval(() => this.check(), intervalMs);
    console.log(`[HealthMonitor] Started (checking every ${intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Register a system as healthy or unhealthy.
   */
  setSystemStatus(name: string, healthy: boolean): void {
    this.systemChecks.set(name, healthy);
  }

  private check(): void {
    const mem = process.memoryUsage();
    const warnings: string[] = [];

    const snapshot: HealthSnapshot = {
      timestamp: Date.now(),
      uptime: process.uptime(),
      memoryUsage: {
        rss: mem.rss / 1024 / 1024,
        heapUsed: mem.heapUsed / 1024 / 1024,
        heapTotal: mem.heapTotal / 1024 / 1024,
        external: mem.external / 1024 / 1024,
        heapUtilization: mem.heapUsed / mem.heapTotal,
      },
      eventLoopLag: this.eventLoopLag,
      tradingSystems: {
        krakenEngine: this.systemChecks.get('krakenEngine') ?? false,
        cryptoComEngine: this.systemChecks.get('cryptoComEngine') ?? false,
        mlPipeline: this.systemChecks.get('mlPipeline') ?? false,
        signalScanner: this.systemChecks.get('signalScanner') ?? true,
        telegramV2: this.systemChecks.get('telegramV2') ?? false,
        webSocket: this.systemChecks.get('webSocket') ?? false,
      },
      dbStats: {
        responsive: true,
        writeLatencyMs: 0,
      },
      warnings: [],
    };

    // Check thresholds
    if (snapshot.memoryUsage.rss > THRESHOLDS.memoryRssMB) {
      warnings.push(`High RSS: ${snapshot.memoryUsage.rss.toFixed(0)}MB > ${THRESHOLDS.memoryRssMB}MB`);
    }
    if (snapshot.memoryUsage.heapUtilization > THRESHOLDS.heapUtilization) {
      warnings.push(`High heap: ${(snapshot.memoryUsage.heapUtilization * 100).toFixed(0)}% > ${THRESHOLDS.heapUtilization * 100}%`);
    }
    if (snapshot.eventLoopLag > THRESHOLDS.eventLoopLagMs) {
      warnings.push(`Event loop lag: ${snapshot.eventLoopLag}ms > ${THRESHOLDS.eventLoopLagMs}ms`);
    }

    snapshot.warnings = warnings;
    this.lastSnapshot = snapshot;

    // Emit risk alert if critical
    if (warnings.length > 0 && Date.now() > this.alertCooldown) {
      this.alertCooldown = Date.now() + 300000; // 5min cooldown
      tradingBus.emit('risk:alert', {
        type: 'heat_warning',
        severity: 'medium',
        reason: `System health: ${warnings.join('; ')}`,
        data: { warnings, memory: snapshot.memoryUsage },
        timestamp: Date.now(),
      });
    }
  }

  getSnapshot(): HealthSnapshot | null {
    return this.lastSnapshot;
  }

  getStatus() {
    const snap = this.lastSnapshot;
    if (!snap) return { status: 'starting', uptime: process.uptime() };

    return {
      status: snap.warnings.length > 0 ? 'degraded' : 'healthy',
      uptime: snap.uptime,
      memory: snap.memoryUsage,
      eventLoopLag: snap.eventLoopLag,
      systems: snap.tradingSystems,
      warnings: snap.warnings,
    };
  }
}

export const healthMonitor = new HealthMonitor();
export default healthMonitor;
