/**
 * WhaleTracker - Backend Node.js service for tracking whale patterns over time
 * Detects accumulation/distribution patterns and historical whale behavior
 */

class WhaleTracker {
  constructor(config = {}) {
    this.config = {
      maxHistory: config.maxHistory || 1000,
      accumulationWindow: config.accumulationWindow || 60, // minutes
      alertThreshold: config.alertThreshold || 3,
      maxAlerts: config.maxAlerts || 200,
      maxAgeMs: config.maxAgeMs || 48 * 60 * 60 * 1000, // 48 hours
    };

    // Internal data structures
    this.events = new Map(); // ticker -> Array<event>
    this.alerts = []; // Array<alert>
    this.patterns = new Map(); // ticker -> { lastCheck, pattern, confidence }
  }

  /**
   * Record a whale event from smartMoneyService
   * @param {Object} event - Whale event
   * @param {string} event.ticker - Trading pair
   * @param {string} event.type - Event type (WALL_BUY, WALL_SELL, LARGE_TRADE, OI_SPIKE, LIQUIDATION)
   * @param {number} event.size - Trade size in USD
   * @param {number} event.price - Price at event
   * @param {string} event.exchange - Exchange name
   * @param {number} event.timestamp - Event timestamp
   */
  recordEvent(event) {
    const { ticker, type, size, price, exchange, timestamp = Date.now() } = event;

    if (!ticker || !type || !size || !price) {
      console.error('WhaleTracker: Invalid event data', event);
      return;
    }

    // Initialize ticker array if needed
    if (!this.events.has(ticker)) {
      this.events.set(ticker, []);
    }

    const tickerEvents = this.events.get(ticker);

    // Add event with enriched data
    const enrichedEvent = {
      ticker,
      type,
      size,
      price,
      exchange: exchange || 'unknown',
      timestamp,
      side: this._determineSide(type),
    };

    tickerEvents.push(enrichedEvent);

    // Trim to max history
    if (tickerEvents.length > this.config.maxHistory) {
      tickerEvents.shift();
    }

    // Check for alert conditions
    this._checkAlertConditions(ticker, enrichedEvent);

    // Invalidate cached pattern for this ticker
    this.patterns.delete(ticker);
  }

  /**
   * Determine trade side from event type
   * @private
   */
  _determineSide(type) {
    if (type === 'WALL_BUY' || type === 'LARGE_BUY' || type === 'SHORT_LIQUIDATION') {
      return 'BUY';
    }
    if (type === 'WALL_SELL' || type === 'LARGE_SELL' || type === 'LONG_LIQUIDATION') {
      return 'SELL';
    }
    if (type === 'LARGE_TRADE') {
      return 'UNKNOWN';
    }
    return 'NEUTRAL';
  }

  /**
   * Check for alert conditions and generate alerts
   * @private
   */
  _checkAlertConditions(ticker, newEvent) {
    const now = Date.now();
    const window30min = 30 * 60 * 1000;
    const recentEvents = this._getEventsInWindow(ticker, window30min);

    // Alert 1: 3+ whale events same direction in 30min
    const sameSideEvents = recentEvents.filter(e => e.side === newEvent.side && e.side !== 'UNKNOWN');
    if (sameSideEvents.length >= this.config.alertThreshold) {
      this._addAlert({
        ticker,
        type: 'RAPID_WHALE_ACTIVITY',
        message: `${sameSideEvents.length} ${newEvent.side} whale events in 30 minutes`,
        severity: 'WARNING',
        timestamp: now,
        data: { count: sameSideEvents.length, side: newEvent.side },
      });
    }

    // Alert 2: Single event > 10x average
    const avg24h = this._getAverageEventSize(ticker, 24 * 60);
    if (avg24h > 0 && newEvent.size > avg24h * 10) {
      this._addAlert({
        ticker,
        type: 'MASSIVE_WHALE_EVENT',
        message: `Whale event ${(newEvent.size / avg24h).toFixed(1)}x larger than 24h average`,
        severity: 'CRITICAL',
        timestamp: now,
        data: { size: newEvent.size, avgSize: avg24h, multiplier: newEvent.size / avg24h },
      });
    }

    // Alert 3: Accumulation/distribution pattern detected
    const accumulation = this.detectAccumulation(ticker);
    if (accumulation.isAccumulating && accumulation.confidence > 0.7) {
      this._addAlert({
        ticker,
        type: 'ACCUMULATION_PATTERN',
        message: `Accumulation pattern detected (${(accumulation.confidence * 100).toFixed(0)}% confidence)`,
        severity: 'WARNING',
        timestamp: now,
        data: accumulation,
      });
    }

    const distribution = this.detectDistribution(ticker);
    if (distribution.isDistributing && distribution.confidence > 0.7) {
      this._addAlert({
        ticker,
        type: 'DISTRIBUTION_PATTERN',
        message: `Distribution pattern detected (${(distribution.confidence * 100).toFixed(0)}% confidence)`,
        severity: 'WARNING',
        timestamp: now,
        data: distribution,
      });
    }

    // Alert 4: Sudden stop in whale activity
    const events24h = this._getEventsInWindow(ticker, 24 * 60 * 60 * 1000);
    const events1h = this._getEventsInWindow(ticker, 60 * 60 * 1000);
    if (events24h.length >= 10 && events1h.length === 0) {
      // Check if there was activity 2-3 hours ago
      const events2to3h = events24h.filter(e =>
        now - e.timestamp >= 2 * 60 * 60 * 1000 &&
        now - e.timestamp <= 3 * 60 * 60 * 1000
      );
      if (events2to3h.length >= 3) {
        this._addAlert({
          ticker,
          type: 'WHALE_ACTIVITY_STOPPED',
          message: 'Heavy whale activity suddenly stopped',
          severity: 'INFO',
          timestamp: now,
          data: { events24h: events24h.length, lastEvent: events24h[events24h.length - 1] },
        });
      }
    }
  }

  /**
   * Add alert to queue
   * @private
   */
  _addAlert(alert) {
    // Deduplicate: don't add same alert type for same ticker within 15 minutes
    const dedupWindow = 15 * 60 * 1000;
    const now = Date.now();
    const isDuplicate = this.alerts.some(a =>
      a.ticker === alert.ticker &&
      a.type === alert.type &&
      now - a.timestamp < dedupWindow
    );

    if (isDuplicate) {
      return;
    }

    this.alerts.push(alert);

    // Trim to max alerts
    if (this.alerts.length > this.config.maxAlerts) {
      this.alerts.shift();
    }
  }

  /**
   * Get events within a time window
   * @private
   */
  _getEventsInWindow(ticker, windowMs) {
    const events = this.events.get(ticker) || [];
    const cutoff = Date.now() - windowMs;
    return events.filter(e => e.timestamp >= cutoff);
  }

  /**
   * Get average event size in a time window
   * @private
   */
  _getAverageEventSize(ticker, windowMinutes) {
    const events = this._getEventsInWindow(ticker, windowMinutes * 60 * 1000);
    if (events.length === 0) return 0;
    const sum = events.reduce((acc, e) => acc + e.size, 0);
    return sum / events.length;
  }

  /**
   * Detect accumulation pattern (repeated buy walls / large buys over time)
   * @param {string} ticker - Trading pair
   * @returns {Object} Accumulation analysis
   */
  detectAccumulation(ticker) {
    const windowMs = this.config.accumulationWindow * 60 * 1000;
    const events = this._getEventsInWindow(ticker, windowMs);

    if (events.length < 3) {
      return { isAccumulating: false, confidence: 0, events: [], priceRange: null, duration: 0 };
    }

    // Filter buy-side events
    const buyEvents = events.filter(e => e.side === 'BUY');
    const totalEvents = events.filter(e => e.side !== 'NEUTRAL' && e.side !== 'UNKNOWN').length;

    if (buyEvents.length < 3) {
      return { isAccumulating: false, confidence: 0, events: buyEvents, priceRange: null, duration: 0 };
    }

    // Check if price floor is rising (each buy at higher low)
    const sortedBuys = [...buyEvents].sort((a, b) => a.timestamp - b.timestamp);
    let priceFloorRising = true;
    let risingCount = 0;
    for (let i = 1; i < sortedBuys.length; i++) {
      if (sortedBuys[i].price >= sortedBuys[i - 1].price) {
        risingCount++;
      }
    }
    priceFloorRising = risingCount >= sortedBuys.length * 0.6; // 60% threshold

    // Check if volume is increasing
    const firstHalf = sortedBuys.slice(0, Math.floor(sortedBuys.length / 2));
    const secondHalf = sortedBuys.slice(Math.floor(sortedBuys.length / 2));
    const firstHalfVol = firstHalf.reduce((acc, e) => acc + e.size, 0);
    const secondHalfVol = secondHalf.reduce((acc, e) => acc + e.size, 0);
    const volumeIncreasing = secondHalfVol > firstHalfVol;

    // Calculate confidence
    let confidence = (buyEvents.length / Math.max(totalEvents, 1));
    if (priceFloorRising) confidence *= 1.5;
    if (volumeIncreasing) confidence *= 1.2;
    confidence *= Math.min(buyEvents.length / 3, 1);
    confidence = Math.min(confidence, 1);

    const isAccumulating = confidence > 0.5;

    const priceRange = {
      low: Math.min(...sortedBuys.map(e => e.price)),
      high: Math.max(...sortedBuys.map(e => e.price)),
    };

    const duration = sortedBuys.length > 0 ?
      sortedBuys[sortedBuys.length - 1].timestamp - sortedBuys[0].timestamp : 0;

    return {
      isAccumulating,
      confidence,
      events: sortedBuys,
      priceRange,
      duration,
      priceFloorRising,
      volumeIncreasing,
    };
  }

  /**
   * Detect distribution pattern (repeated sell walls / large sells)
   * @param {string} ticker - Trading pair
   * @returns {Object} Distribution analysis
   */
  detectDistribution(ticker) {
    const windowMs = this.config.accumulationWindow * 60 * 1000;
    const events = this._getEventsInWindow(ticker, windowMs);

    if (events.length < 3) {
      return { isDistributing: false, confidence: 0, events: [], priceRange: null, duration: 0 };
    }

    // Filter sell-side events
    const sellEvents = events.filter(e => e.side === 'SELL');
    const totalEvents = events.filter(e => e.side !== 'NEUTRAL' && e.side !== 'UNKNOWN').length;

    if (sellEvents.length < 3) {
      return { isDistributing: false, confidence: 0, events: sellEvents, priceRange: null, duration: 0 };
    }

    // Check if price ceiling is falling
    const sortedSells = [...sellEvents].sort((a, b) => a.timestamp - b.timestamp);
    let priceCeilingFalling = true;
    let fallingCount = 0;
    for (let i = 1; i < sortedSells.length; i++) {
      if (sortedSells[i].price <= sortedSells[i - 1].price) {
        fallingCount++;
      }
    }
    priceCeilingFalling = fallingCount >= sortedSells.length * 0.6;

    // Check if volume is increasing
    const firstHalf = sortedSells.slice(0, Math.floor(sortedSells.length / 2));
    const secondHalf = sortedSells.slice(Math.floor(sortedSells.length / 2));
    const firstHalfVol = firstHalf.reduce((acc, e) => acc + e.size, 0);
    const secondHalfVol = secondHalf.reduce((acc, e) => acc + e.size, 0);
    const volumeIncreasing = secondHalfVol > firstHalfVol;

    // Calculate confidence
    let confidence = (sellEvents.length / Math.max(totalEvents, 1));
    if (priceCeilingFalling) confidence *= 1.5;
    if (volumeIncreasing) confidence *= 1.2;
    confidence *= Math.min(sellEvents.length / 3, 1);
    confidence = Math.min(confidence, 1);

    const isDistributing = confidence > 0.5;

    const priceRange = {
      low: Math.min(...sortedSells.map(e => e.price)),
      high: Math.max(...sortedSells.map(e => e.price)),
    };

    const duration = sortedSells.length > 0 ?
      sortedSells[sortedSells.length - 1].timestamp - sortedSells[0].timestamp : 0;

    return {
      isDistributing,
      confidence,
      events: sortedSells,
      priceRange,
      duration,
      priceCeilingFalling,
      volumeIncreasing,
    };
  }

  /**
   * Get whale activity summary for a ticker
   * @param {string} ticker - Trading pair
   * @returns {Object} Activity summary
   */
  getActivitySummary(ticker) {
    const events24h = this._getEventsInWindow(ticker, 24 * 60 * 60 * 1000);

    if (events24h.length === 0) {
      return {
        totalEvents24h: 0,
        buyEvents: 0,
        sellEvents: 0,
        netFlow: 'NEUTRAL',
        avgEventSize: 0,
        largestEvent: null,
        pattern: 'QUIET',
        recentEvents: [],
      };
    }

    const buyEvents = events24h.filter(e => e.side === 'BUY');
    const sellEvents = events24h.filter(e => e.side === 'SELL');

    // Calculate net flow
    const buyVolume = buyEvents.reduce((acc, e) => acc + e.size, 0);
    const sellVolume = sellEvents.reduce((acc, e) => acc + e.size, 0);
    const totalVolume = buyVolume + sellVolume;

    let netFlow = 'NEUTRAL';
    if (totalVolume > 0) {
      const buyRatio = buyVolume / totalVolume;
      if (buyRatio > 0.6) netFlow = 'ACCUMULATION';
      else if (buyRatio < 0.4) netFlow = 'DISTRIBUTION';
    }

    // Average event size
    const avgEventSize = events24h.reduce((acc, e) => acc + e.size, 0) / events24h.length;

    // Largest event
    const largestEvent = events24h.reduce((max, e) => e.size > max.size ? e : max, events24h[0]);

    // Detect pattern
    const accumulation = this.detectAccumulation(ticker);
    const distribution = this.detectDistribution(ticker);

    let pattern = 'QUIET';
    if (accumulation.isAccumulating) {
      pattern = 'ACCUMULATING';
    } else if (distribution.isDistributing) {
      pattern = 'DISTRIBUTING';
    } else if (events24h.length >= 10 && Math.abs(buyEvents.length - sellEvents.length) <= events24h.length * 0.2) {
      pattern = 'CHURNING';
    }

    // Recent events (last 10)
    const recentEvents = events24h.slice(-10);

    return {
      totalEvents24h: events24h.length,
      buyEvents: buyEvents.length,
      sellEvents: sellEvents.length,
      netFlow,
      avgEventSize,
      largestEvent,
      pattern,
      recentEvents,
      buyVolume,
      sellVolume,
    };
  }

  /**
   * Get alerts for significant whale activity
   * @param {string|null} ticker - Trading pair (null for all)
   * @returns {Array} Array of alerts
   */
  getAlerts(ticker = null) {
    if (ticker) {
      return this.alerts.filter(a => a.ticker === ticker);
    }
    return [...this.alerts];
  }

  /**
   * Get whale history bucketed by hour
   * @param {string} ticker - Trading pair
   * @param {number} hours - Number of hours to look back
   * @returns {Array} Time-series of whale activity
   */
  getWhaleHistory(ticker, hours = 24) {
    const events = this._getEventsInWindow(ticker, hours * 60 * 60 * 1000);

    if (events.length === 0) {
      return [];
    }

    // Bucket by hour
    const buckets = new Map();
    const now = Date.now();

    // Initialize buckets
    for (let i = 0; i < hours; i++) {
      const bucketTime = now - (i * 60 * 60 * 1000);
      const bucketKey = Math.floor(bucketTime / (60 * 60 * 1000));
      buckets.set(bucketKey, {
        timestamp: bucketKey * 60 * 60 * 1000,
        buyEvents: 0,
        sellEvents: 0,
        buyVolume: 0,
        sellVolume: 0,
        events: [],
      });
    }

    // Fill buckets
    events.forEach(event => {
      const bucketKey = Math.floor(event.timestamp / (60 * 60 * 1000));
      if (buckets.has(bucketKey)) {
        const bucket = buckets.get(bucketKey);
        bucket.events.push(event);
        if (event.side === 'BUY') {
          bucket.buyEvents++;
          bucket.buyVolume += event.size;
        } else if (event.side === 'SELL') {
          bucket.sellEvents++;
          bucket.sellVolume += event.size;
        }
      }
    });

    // Convert to array and sort by timestamp
    return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Cleanup old events
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  cleanup(maxAgeMs = null) {
    const cutoff = Date.now() - (maxAgeMs || this.config.maxAgeMs);

    // Clean events
    for (const [ticker, events] of this.events.entries()) {
      const filtered = events.filter(e => e.timestamp >= cutoff);
      if (filtered.length === 0) {
        this.events.delete(ticker);
      } else {
        this.events.set(ticker, filtered);
      }
    }

    // Clean alerts
    this.alerts = this.alerts.filter(a => a.timestamp >= cutoff);

    // Clean patterns cache
    for (const [ticker, pattern] of this.patterns.entries()) {
      if (pattern.lastCheck < cutoff) {
        this.patterns.delete(ticker);
      }
    }
  }

  /**
   * Serialize tracker state to JSON
   * @returns {string} JSON string
   */
  serialize() {
    return JSON.stringify({
      config: this.config,
      events: Array.from(this.events.entries()),
      alerts: this.alerts,
      patterns: Array.from(this.patterns.entries()),
    });
  }

  /**
   * Deserialize tracker state from JSON
   * @param {string} json - JSON string
   */
  deserialize(json) {
    try {
      const data = JSON.parse(json);
      this.config = { ...this.config, ...data.config };
      this.events = new Map(data.events);
      this.alerts = data.alerts || [];
      this.patterns = new Map(data.patterns || []);
    } catch (error) {
      console.error('WhaleTracker: Deserialization failed', error);
    }
  }

  /**
   * Get statistics across all tracked tickers
   * @returns {Object} Global statistics
   */
  getGlobalStats() {
    const stats = {
      totalTickers: this.events.size,
      totalEvents24h: 0,
      totalAlerts: this.alerts.length,
      mostActiveTicker: null,
      mostActiveCount: 0,
    };

    for (const [ticker, events] of this.events.entries()) {
      const events24h = this._getEventsInWindow(ticker, 24 * 60 * 60 * 1000);
      stats.totalEvents24h += events24h.length;

      if (events24h.length > stats.mostActiveCount) {
        stats.mostActiveCount = events24h.length;
        stats.mostActiveTicker = ticker;
      }
    }

    return stats;
  }
}

export { WhaleTracker };
export default WhaleTracker;
