/**
 * Replay Engine Service (Frontend)
 * Replays historical candle data incrementally with step/stepBack/play controls.
 */

export interface ReplayCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ReplayState {
  currentIndex: number;
  visibleCandles: ReplayCandle[];
  currentPrice: number;
  signals: string[];
  trades: { type: string; price: number; time: number; pnl?: number }[];
  pnl: number;
  isPlaying: boolean;
}

export class ReplayEngine {
  private candles: ReplayCandle[] = [];
  private stateStack: ReplayState[] = [];
  private currentIndex = 0;
  private trades: ReplayState['trades'] = [];
  private cash = 1000;
  private initialCash = 1000;
  private positionQty = 0;
  private positionEntry = 0;
  isPlaying = false;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private speed = 500; // ms per step
  private onUpdate: ((state: ReplayState) => void) | null = null;

  load(candles: ReplayCandle[], initialCash = 1000) {
    this.candles = candles;
    this.initialCash = initialCash;
    this.cash = initialCash;
    this.currentIndex = Math.min(30, candles.length - 1); // Start with some history
    this.trades = [];
    this.positionQty = 0;
    this.positionEntry = 0;
    this.stateStack = [];
  }

  setOnUpdate(cb: (state: ReplayState) => void) {
    this.onUpdate = cb;
  }

  setSpeed(ms: number) {
    this.speed = ms;
    if (this.isPlaying) {
      this.pause();
      this.play();
    }
  }

  getState(): ReplayState {
    const visible = this.candles.slice(0, this.currentIndex + 1);
    const currentPrice = visible.length > 0 ? visible[visible.length - 1].c : 0;
    const unrealizedPnl = this.positionQty > 0 ? (currentPrice - this.positionEntry) * this.positionQty : 0;
    const realizedPnl = this.trades.filter(t => t.type === 'SELL' && t.pnl).reduce((s, t) => s + (t.pnl || 0), 0);

    return {
      currentIndex: this.currentIndex,
      visibleCandles: visible,
      currentPrice,
      signals: this.getSignals(visible),
      trades: [...this.trades],
      pnl: realizedPnl + unrealizedPnl,
      isPlaying: this.isPlaying,
    };
  }

  private saveState() {
    this.stateStack.push({
      ...this.getState(),
      // Also save internal state for restoration
    });
    if (this.stateStack.length > 200) this.stateStack.shift();
  }

  step() {
    if (this.currentIndex >= this.candles.length - 1) return;
    this.saveState();
    this.currentIndex++;
    this.emitUpdate();
  }

  stepBack() {
    if (this.currentIndex <= 0) return;
    this.currentIndex--;
    this.emitUpdate();
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.playTimer = setInterval(() => {
      if (this.currentIndex >= this.candles.length - 1) {
        this.pause();
        return;
      }
      this.step();
    }, this.speed);
    this.emitUpdate();
  }

  pause() {
    this.isPlaying = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    this.emitUpdate();
  }

  jumpTo(index: number) {
    this.currentIndex = Math.max(0, Math.min(index, this.candles.length - 1));
    this.emitUpdate();
  }

  private emitUpdate() {
    this.onUpdate?.(this.getState());
  }

  private getSignals(candles: ReplayCandle[]): string[] {
    if (candles.length < 21) return [];
    const signals: string[] = [];
    const closes = candles.map(c => c.c);

    // EMA crossover
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const last9 = ema9[ema9.length - 1];
    const prev9 = ema9[ema9.length - 2];
    const last21 = ema21[ema21.length - 1];
    const prev21 = ema21[ema21.length - 2];

    if (prev9 <= prev21 && last9 > last21) signals.push('EMA Bullish Cross');
    if (prev9 >= prev21 && last9 < last21) signals.push('EMA Bearish Cross');

    // RSI
    const rsiVal = this.rsi(closes, 14);
    if (rsiVal < 30) signals.push(`RSI Oversold (${rsiVal.toFixed(0)})`);
    if (rsiVal > 70) signals.push(`RSI Overbought (${rsiVal.toFixed(0)})`);

    // Volume spike
    if (candles.length > 20) {
      const vols = candles.map(c => c.v);
      const avgVol = vols.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
      if (candles[candles.length - 1].v > avgVol * 2) signals.push('Volume Spike');
    }

    return signals;
  }

  private ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
      result.push(values[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  private rsi(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gainSum = 0, lossSum = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gainSum += diff;
      else lossSum -= diff;
    }
    if (lossSum === 0) return 100;
    const rs = (gainSum / period) / (lossSum / period);
    return 100 - (100 / (1 + rs));
  }

  destroy() {
    this.pause();
  }
}
