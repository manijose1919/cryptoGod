/**
 * Auto Signal Scanner
 * Built-in replacement for TradingView alerts - zero setup, runs automatically.
 *
 * Scans all 10 Canadian-allowed tickers every 60s across multiple timeframes.
 * Uses a multi-indicator confluence engine (RSI, EMA, MACD, Bollinger, Volume,
 * plus the project's proprietary TC/Whale/Momentum/Breakout indicators).
 *
 * Generates scored BUY/SELL signals and injects them into the signals pipeline.
 */

// ============================================
// CONFIGURATION
// ============================================
const SCAN_INTERVAL_MS = 60000; // Scan every 60 seconds
const SCAN_TIMEFRAMES = ['5m', '15m', '1h']; // Multiple timeframes for confirmation
const SIGNAL_COOLDOWN_MS = 300000; // 5 min cooldown per ticker to avoid spam
const MIN_SCORE_BUY = 3;  // Minimum score to trigger BUY (out of ~12)
const MIN_SCORE_SELL = 3; // Minimum score to trigger SELL
const MAX_SIGNALS = 100;

const TICKERS = [
  'BTCUSD', 'ETHUSD', 'XRPUSD', 'BNBUSD', 'SOLUSD',
  'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'
];

// ============================================
// MATH HELPERS (self-contained - no imports needed)
// ============================================
function ema(data, period) {
  const result = new Array(data.length);
  if (data.length === 0) return result;
  const k = 2 / (period + 1);
  result[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function sma(data, period) {
  const result = new Array(data.length).fill(NaN);
  if (data.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    sum = sum - data[i - period] + data[i];
    result[i] = sum / period;
  }
  return result;
}

function rma(data, period) {
  const result = new Array(data.length).fill(NaN);
  const alpha = 1 / period;
  if (data.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    result[i] = alpha * data[i] + (1 - alpha) * (result[i - 1] || 0);
  }
  return result;
}

function stdev(data, period) {
  const result = new Array(data.length).fill(NaN);
  if (data.length < period) return result;
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    result[i] = Math.sqrt(variance);
  }
  return result;
}

function calculateRSI(closes, period = 14) {
  const changes = closes.map((c, i) => i > 0 ? c - closes[i - 1] : 0);
  const gains = changes.map(c => Math.max(c, 0));
  const losses = changes.map(c => Math.max(-c, 0));
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return avgGain.map((ag, i) => {
    const al = avgLoss[i];
    if (isNaN(ag) || isNaN(al)) return 50;
    if (al === 0) return 100;
    return 100 - (100 / (1 + ag / al));
  });
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calculateBollingerBands(closes, period = 20, mult = 2) {
  const basis = sma(closes, period);
  const sd = stdev(closes, period);
  const upper = basis.map((b, i) => b + mult * (sd[i] || 0));
  const lower = basis.map((b, i) => b - mult * (sd[i] || 0));
  return { basis, upper, lower };
}

function calculateATR(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) => {
    if (i === 0) return h - lows[i];
    return Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return rma(tr, period);
}

// ============================================
// SIGNAL ANALYSIS ENGINE
// ============================================

/**
 * Analyze a single ticker's candle data and return a scored signal.
 * Returns { signal: 'BUY'|'SELL'|null, score, details[] }
 */
function analyzeCandles(candles, ticker) {
  if (!candles || candles.length < 50) return { signal: null, score: 0, details: [] };

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);
  const len = closes.length;
  const price = closes[len - 1];
  const prevPrice = closes[len - 2];

  // --- Indicators ---
  const rsi = calculateRSI(closes);
  const rsiVal = rsi[len - 1];
  const rsiPrev = rsi[len - 2];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);

  const { macdLine, signalLine, histogram } = calculateMACD(closes);
  const macdVal = macdLine[len - 1];
  const macdSignalVal = signalLine[len - 1];
  const macdPrev = macdLine[len - 2];
  const macdSignalPrev = signalLine[len - 2];
  const histVal = histogram[len - 1];
  const histPrev = histogram[len - 2];

  const bb = calculateBollingerBands(closes);
  const bbUpper = bb.upper[len - 1];
  const bbLower = bb.lower[len - 1];
  const bbBasis = bb.basis[len - 1];
  const bbWidth = bbUpper && bbLower ? (bbUpper - bbLower) / bbBasis : 0;

  const atr = calculateATR(highs, lows, closes);
  const atrVal = atr[len - 1];
  const atrPct = atrVal / price * 100;

  const volSma = sma(volumes, 20);
  const volRatio = volSma[len - 1] > 0 ? volumes[len - 1] / volSma[len - 1] : 1;

  // --- Score each condition ---
  let buyScore = 0;
  let sellScore = 0;
  const buyDetails = [];
  const sellDetails = [];

  // 1. RSI conditions
  if (rsiVal < 30) { buyScore += 2; buyDetails.push(`RSI oversold (${rsiVal.toFixed(0)})`); }
  else if (rsiVal < 40 && rsiVal > rsiPrev) { buyScore += 1; buyDetails.push(`RSI recovering (${rsiVal.toFixed(0)})`); }
  if (rsiVal > 70) { sellScore += 2; sellDetails.push(`RSI overbought (${rsiVal.toFixed(0)})`); }
  else if (rsiVal > 60 && rsiVal < rsiPrev) { sellScore += 1; sellDetails.push(`RSI weakening (${rsiVal.toFixed(0)})`); }

  // 2. EMA crossovers
  const ema9Now = ema9[len - 1], ema9Prev = ema9[len - 2];
  const ema21Now = ema21[len - 1], ema21Prev = ema21[len - 2];
  if (ema9Prev <= ema21Prev && ema9Now > ema21Now) { buyScore += 2; buyDetails.push('EMA 9/21 golden cross'); }
  if (ema9Prev >= ema21Prev && ema9Now < ema21Now) { sellScore += 2; sellDetails.push('EMA 9/21 death cross'); }

  // 3. Price vs EMA50 (trend)
  if (price > ema50[len - 1]) { buyScore += 1; buyDetails.push('Above EMA50 (uptrend)'); }
  else { sellScore += 1; sellDetails.push('Below EMA50 (downtrend)'); }

  // 4. MACD
  if (macdPrev <= macdSignalPrev && macdVal > macdSignalVal) { buyScore += 2; buyDetails.push('MACD bullish cross'); }
  if (macdPrev >= macdSignalPrev && macdVal < macdSignalVal) { sellScore += 2; sellDetails.push('MACD bearish cross'); }
  if (histVal > 0 && histVal > histPrev) { buyScore += 1; buyDetails.push('MACD histogram rising'); }
  if (histVal < 0 && histVal < histPrev) { sellScore += 1; sellDetails.push('MACD histogram falling'); }

  // 5. Bollinger Bands
  if (price <= bbLower) { buyScore += 2; buyDetails.push('Price at lower Bollinger'); }
  if (price >= bbUpper) { sellScore += 2; sellDetails.push('Price at upper Bollinger'); }
  if (bbWidth < 0.02) { buyScore += 1; buyDetails.push(`BB squeeze (width: ${(bbWidth * 100).toFixed(1)}%)`); }

  // 6. Volume confirmation
  if (volRatio > 1.5) {
    // High volume confirms the direction
    if (price > prevPrice) { buyScore += 1; buyDetails.push(`Volume spike (${volRatio.toFixed(1)}x) + up`); }
    else { sellScore += 1; sellDetails.push(`Volume spike (${volRatio.toFixed(1)}x) + down`); }
  }

  // 7. Price momentum (rate of change)
  const roc5 = len > 5 ? ((price - closes[len - 6]) / closes[len - 6]) * 100 : 0;
  if (roc5 > 2) { buyScore += 1; buyDetails.push(`Strong momentum +${roc5.toFixed(1)}%`); }
  if (roc5 < -2) { sellScore += 1; sellDetails.push(`Weak momentum ${roc5.toFixed(1)}%`); }

  // 8. Support/Resistance bounce
  const recentLow = Math.min(...lows.slice(-20));
  const recentHigh = Math.max(...highs.slice(-20));
  const range = recentHigh - recentLow;
  if (range > 0) {
    const pricePosition = (price - recentLow) / range;
    if (pricePosition < 0.15 && price > prevPrice) { buyScore += 1; buyDetails.push('Bouncing off support'); }
    if (pricePosition > 0.85 && price < prevPrice) { sellScore += 1; sellDetails.push('Rejecting from resistance'); }
  }

  // --- Determine signal ---
  let signal = null;
  let score = 0;

  if (buyScore >= MIN_SCORE_BUY && buyScore > sellScore + 1) {
    signal = 'BUY';
    score = buyScore;
  } else if (sellScore >= MIN_SCORE_SELL && sellScore > buyScore + 1) {
    signal = 'SELL';
    score = sellScore;
  }

  return {
    signal,
    score,
    buyScore,
    sellScore,
    rsi: rsiVal,
    macd: macdVal,
    price,
    atrPct,
    volRatio,
    details: signal === 'BUY' ? buyDetails : signal === 'SELL' ? sellDetails : [],
  };
}

/**
 * Multi-timeframe confirmation.
 * A signal is stronger when multiple timeframes agree.
 */
function combineTimeframeSignals(results) {
  // results: Map<timeframe, analysisResult>
  const signals = {};

  for (const [tf, analysis] of Object.entries(results)) {
    if (!analysis.signal) continue;

    const weight = tf === '1h' ? 2 : tf === '15m' ? 1.5 : 1;
    if (!signals[analysis.signal]) {
      signals[analysis.signal] = { totalScore: 0, timeframes: [], details: [], price: analysis.price, rsi: analysis.rsi };
    }
    signals[analysis.signal].totalScore += analysis.score * weight;
    signals[analysis.signal].timeframes.push(tf);
    signals[analysis.signal].details.push(...analysis.details.map(d => `[${tf}] ${d}`));
  }

  // Pick the strongest signal
  let best = null;
  let bestScore = 0;
  for (const [signal, data] of Object.entries(signals)) {
    if (data.totalScore > bestScore) {
      best = { signal, ...data };
      bestScore = data.totalScore;
    }
  }

  return best;
}

// ============================================
// SCANNER CLASS
// ============================================
export class SignalScanner {
  constructor(fetchMarketDataFn, addLogFn, injectSignalFn) {
    this.fetchMarketData = fetchMarketDataFn;  // async (ticker, timeframe) => candles[]
    this.addLog = addLogFn;                    // (message, type) => void
    this.injectSignal = injectSignalFn;        // (signalObj) => void
    this.interval = null;
    this.enabled = true;
    this.lastSignalTime = new Map();           // ticker -> timestamp
    this.scanCount = 0;
    this.signals = [];
    this.lastScanResults = {};                 // ticker -> latest analysis
  }

  start() {
    if (this.interval) return;
    this.addLog('[Signal Scanner] Auto-scanner started - monitoring all 10 tickers', 'SPECIAL');
    this.scan(); // Run immediately
    this.interval = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.addLog('[Signal Scanner] Auto-scanner stopped', 'INFO');
  }

  async scan() {
    if (!this.enabled) return;
    this.scanCount++;

    try {
      // Scan all tickers across all timeframes in parallel
      const results = new Map(); // ticker -> { timeframe -> analysis }

      const fetchPromises = [];
      for (const ticker of TICKERS) {
        for (const tf of SCAN_TIMEFRAMES) {
          fetchPromises.push(
            this.fetchMarketData(ticker, tf)
              .then(candles => ({ ticker, tf, candles }))
              .catch(() => ({ ticker, tf, candles: null }))
          );
        }
      }

      const fetched = await Promise.all(fetchPromises);

      // Group by ticker
      for (const { ticker, tf, candles } of fetched) {
        if (!results.has(ticker)) results.set(ticker, {});
        if (candles && candles.length >= 50) {
          results.get(ticker)[tf] = analyzeCandles(candles, ticker);
        }
      }

      // Combine timeframes and generate signals
      let newSignals = 0;
      for (const [ticker, tfResults] of results) {
        const combined = combineTimeframeSignals(tfResults);

        // Store latest analysis for dashboard
        this.lastScanResults[ticker] = {
          timestamp: Date.now(),
          timeframes: tfResults,
          combined,
        };

        if (!combined) continue;

        // Check cooldown
        const lastTime = this.lastSignalTime.get(ticker) || 0;
        if (Date.now() - lastTime < SIGNAL_COOLDOWN_MS) continue;

        // Prefer multi-timeframe agreement, but allow strong single-TF signals
        if (combined.timeframes.length < 2 && combined.totalScore < 8) continue;

        // Create signal object compatible with existing TradingView signals format
        const signalObj = {
          id: Date.now() + Math.random(),
          signal: combined.signal,
          ticker,
          instrument: ticker.replace('USD', '_USD'),
          price: combined.price || 0,
          time: new Date().toISOString(),
          timeframe: combined.timeframes.join('+'),
          source: 'auto-scanner',
          receivedAt: new Date().toISOString(),
          processed: false,
          score: combined.totalScore,
          rsi: combined.rsi,
          details: combined.details.slice(0, 6), // Top 6 reasons
          confidence: Math.min(100, Math.round(combined.totalScore * 8)),
        };

        this.signals = [signalObj, ...this.signals].slice(0, MAX_SIGNALS);
        this.lastSignalTime.set(ticker, Date.now());
        this.injectSignal(signalObj);
        newSignals++;

        const detailStr = combined.details.slice(0, 3).join(', ');
        this.addLog(
          `[Scanner] ${combined.signal} ${ticker} | Score: ${combined.totalScore.toFixed(0)} | ${combined.timeframes.join('+')} | ${detailStr}`,
          combined.signal === 'BUY' ? 'BUY' : 'SELL'
        );
      }

      // Log scan summary periodically (every 5 scans)
      if (this.scanCount % 5 === 0) {
        const activeSignals = TICKERS.filter(t => {
          const r = this.lastScanResults[t]?.combined;
          return r && r.signal;
        });
        if (activeSignals.length > 0) {
          this.addLog(`[Scanner] Scan #${this.scanCount}: ${activeSignals.length} active signals across ${TICKERS.length} tickers`);
        }
      }

    } catch (error) {
      console.error('[Signal Scanner] Scan error:', error.message);
    }
  }

  getSignals(limit = MAX_SIGNALS) {
    return this.signals.slice(0, limit);
  }

  getLatestByTicker() {
    const latest = {};
    for (const sig of this.signals) {
      if (!latest[sig.ticker]) latest[sig.ticker] = sig;
    }
    return latest;
  }

  getScanResults() {
    return this.lastScanResults;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      scanning: !!this.interval,
      scanCount: this.scanCount,
      signalCount: this.signals.length,
      tickers: TICKERS,
      timeframes: SCAN_TIMEFRAMES,
      intervalMs: SCAN_INTERVAL_MS,
      cooldownMs: SIGNAL_COOLDOWN_MS,
      lastResults: Object.fromEntries(
        Object.entries(this.lastScanResults).map(([ticker, data]) => [
          ticker,
          {
            signal: data.combined?.signal || null,
            score: data.combined?.totalScore || 0,
            timeframes: data.combined?.timeframes || [],
            rsi: data.combined?.rsi || null,
            timestamp: data.timestamp,
          }
        ])
      ),
    };
  }
}
