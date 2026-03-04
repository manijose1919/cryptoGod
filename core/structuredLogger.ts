/**
 * StructuredLogger — JSON-formatted logging with levels, context, and metrics.
 *
 * Replaces scattered console.log() calls with structured output that can be:
 * - Parsed by log aggregators (PM2, journalctl)
 * - Filtered by level (DEBUG, INFO, WARN, ERROR)
 * - Searched by component and context
 * - Rate-limited to avoid log spam
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  ts: string;         // ISO timestamp
  level: LogLevel;
  component: string;  // e.g., 'TradingEngine:kraken', 'MLPipeline'
  msg: string;
  data?: Record<string, unknown>;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class StructuredLogger {
  private minLevel: LogLevel = 'INFO';
  private rateLimits: Map<string, { lastTime: number; count: number }> = new Map();
  private recentLogs: LogEntry[] = [];
  private maxRecentLogs = 500;

  setLevel(level: LogLevel): void {
    this.minLevel = level;
    console.log(`[Logger] Log level set to ${level}`);
  }

  /**
   * Log a structured message.
   * @param level - Log level
   * @param component - Component name (e.g., 'TradingEngine:kraken')
   * @param msg - Human-readable message
   * @param data - Optional structured data
   * @param rateLimitKey - Optional key to rate-limit (max 1 per 5s)
   */
  log(level: LogLevel, component: string, msg: string, data?: Record<string, unknown>, rateLimitKey?: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    // Rate limiting
    if (rateLimitKey) {
      const now = Date.now();
      const rl = this.rateLimits.get(rateLimitKey);
      if (rl && now - rl.lastTime < 5000) {
        rl.count++;
        return; // Suppress
      }
      if (rl && rl.count > 0) {
        // Log suppression notice
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'INFO',
          component: 'Logger',
          msg: `Suppressed ${rl.count} duplicate "${rateLimitKey}" messages`,
        }));
      }
      this.rateLimits.set(rateLimitKey, { lastTime: now, count: 0 });
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    // Store in recent logs ring buffer
    this.recentLogs.push(entry);
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs.shift();
    }

    // Output to console (PM2 captures stdout)
    const consoleMethod = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    consoleMethod(JSON.stringify(entry));
  }

  // Convenience methods
  debug(component: string, msg: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', component, msg, data);
  }

  info(component: string, msg: string, data?: Record<string, unknown>): void {
    this.log('INFO', component, msg, data);
  }

  warn(component: string, msg: string, data?: Record<string, unknown>): void {
    this.log('WARN', component, msg, data);
  }

  error(component: string, msg: string, data?: Record<string, unknown>): void {
    this.log('ERROR', component, msg, data);
  }

  /**
   * Get recent log entries (for dashboard API).
   */
  getRecentLogs(limit = 100, level?: LogLevel): LogEntry[] {
    let logs = this.recentLogs;
    if (level) {
      logs = logs.filter(l => LEVEL_PRIORITY[l.level] >= LEVEL_PRIORITY[level]);
    }
    return logs.slice(-limit);
  }

  /**
   * Get log stats.
   */
  getStats() {
    const counts: Record<string, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    for (const log of this.recentLogs) {
      counts[log.level]++;
    }
    return {
      totalRecent: this.recentLogs.length,
      byLevel: counts,
      rateLimitsActive: this.rateLimits.size,
      minLevel: this.minLevel,
    };
  }
}

export const logger = new StructuredLogger();
export default logger;
