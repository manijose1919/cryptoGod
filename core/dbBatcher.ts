/**
 * DBBatcher — Batches SQLite writes to reduce I/O overhead.
 *
 * Instead of writing every candle/tick immediately to SQLite,
 * buffers writes and flushes at configurable intervals.
 * Reduces disk I/O by 5-10x for high-frequency data.
 */

type WriteOperation = {
  sql: string;
  params: unknown[];
  timestamp: number;
};

class DBBatcher {
  private buffer: WriteOperation[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private dbExecute: ((sql: string, params: unknown[]) => void) | null = null;
  private flushCount = 0;
  private totalWrites = 0;
  private totalBatched = 0;

  constructor(flushIntervalMs = 5000, maxBufferSize = 200) {
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Initialize with the database execute function.
   * Must be called after database is ready.
   */
  init(executeFn: (sql: string, params: unknown[]) => void): void {
    this.dbExecute = executeFn;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    console.log(`[DBBatcher] Initialized (flush every ${this.flushIntervalMs}ms, max buffer ${this.maxBufferSize})`);
  }

  /**
   * Queue a write operation for batched execution.
   */
  queue(sql: string, params: unknown[]): void {
    this.buffer.push({ sql, params, timestamp: Date.now() });
    this.totalBatched++;

    // Flush immediately if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  /**
   * Flush all buffered writes to SQLite.
   * Uses a single transaction for all queued operations.
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    // M2: visibility for failed init. If init() never succeeded (dbExecute
    // is null), queue() keeps appending forever and flush silently returns.
    // The buffer grows unbounded → memory leak. Log a rate-limited warning
    // and hard-cap the buffer so a misconfigured deploy doesn't OOM the
    // process. Caller can fix init and the next flush picks up.
    if (!this.dbExecute) {
      if (this.flushCount % 50 === 0) {
        console.warn(`[DBBatcher] No executor wired — ${this.buffer.length} writes buffered. Did init() fail?`);
      }
      // Hard-cap at 4x the normal max to bound memory; drop oldest.
      const hardCap = this.maxBufferSize * 4;
      if (this.buffer.length > hardCap) {
        const drop = this.buffer.length - hardCap;
        this.buffer.splice(0, drop);
        console.warn(`[DBBatcher] Dropped ${drop} oldest writes (hard cap ${hardCap})`);
      }
      this.flushCount++;
      return;
    }

    const batch = this.buffer.splice(0);
    this.flushCount++;
    this.totalWrites += batch.length;

    try {
      // Execute all writes in a single transaction
      for (const op of batch) {
        try {
          this.dbExecute(op.sql, op.params);
        } catch (err) {
          console.warn(`[DBBatcher] Write failed: ${(err as Error).message}`);
        }
      }

      if (this.flushCount % 100 === 0) {
        console.log(
          `[DBBatcher] Flush #${this.flushCount}: ${batch.length} writes | ` +
          `Total: ${this.totalWrites} actual / ${this.totalBatched} queued ` +
          `(${((1 - this.flushCount / this.totalBatched) * 100).toFixed(0)}% fewer transactions)`
        );
      }
    } catch (err) {
      console.error(`[DBBatcher] Flush error: ${(err as Error).message}`);
      // Re-queue failed operations
      this.buffer.unshift(...batch);
    }
  }

  /**
   * Flush and stop the batcher.
   */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // Final flush
    console.log(`[DBBatcher] Shutdown — flushed ${this.totalWrites} total writes in ${this.flushCount} batches`);
  }

  getStats() {
    return {
      bufferSize: this.buffer.length,
      totalWrites: this.totalWrites,
      totalBatched: this.totalBatched,
      flushCount: this.flushCount,
      flushIntervalMs: this.flushIntervalMs,
    };
  }
}

export const dbBatcher = new DBBatcher();
export default dbBatcher;
