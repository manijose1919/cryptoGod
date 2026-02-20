import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ReplayEngine, type ReplayState, type ReplayCandle } from '../services/replayService';
import { getAvailableData, type AvailableData } from '../services/backtestService';

const NAV_LINKS = [
  { to: '/', label: 'Crypto' },
  { to: '/stocks', label: 'Stocks' },
  { to: '/performance', label: 'Performance' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/replay', label: 'Replay' },
  { to: '/training', label: 'Training' },
];

export const ReplayDashboard: React.FC = () => {
  const engineRef = useRef(new ReplayEngine());
  const [available, setAvailable] = useState<AvailableData[]>([]);
  const [ticker, setTicker] = useState('BTCUSD');
  const [timeframe, setTimeframe] = useState('5m');
  const [state, setState] = useState<ReplayState | null>(null);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(500);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAvailableData().then(setAvailable).catch(() => {});
    return () => engineRef.current.destroy();
  }, []);

  const tickers = [...new Set(available.map(d => d.ticker))];
  const timeframes = [...new Set(available.filter(d => d.ticker === ticker).map(d => d.timeframe))];

  const handleLoad = useCallback(async () => {
    setLoading(true);
    try {
      const selectedData = available.find(d => d.ticker === ticker && d.timeframe === timeframe);
      if (!selectedData) { setLoading(false); return; }

      const res = await fetch(`/api/market-data?instrument_name=${ticker}&timeframe=${timeframe}`);
      if (res.ok) {
        const data = await res.json();
        const candles: ReplayCandle[] = (data.data || []).map((c: any) => ({
          t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
        }));

        if (candles.length > 0) {
          engineRef.current.load(candles);
          engineRef.current.setOnUpdate(setState);
          setState(engineRef.current.getState());
          setLoaded(true);
        }
      }
    } catch (e) { /* ignore */ }
    setLoading(false);
  }, [available, ticker, timeframe]);

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    engineRef.current.setSpeed(newSpeed);
  };

  // Mini candlestick rendering
  const renderCandles = (candles: ReplayCandle[]) => {
    if (candles.length === 0) return null;
    const displayCandles = candles.slice(-80);
    const high = Math.max(...displayCandles.map(c => c.h));
    const low = Math.min(...displayCandles.map(c => c.l));
    const range = high - low || 1;

    return (
      <div className="h-48 flex items-end gap-px bg-gray-900/50 rounded p-1">
        {displayCandles.map((candle, i) => {
          const isGreen = candle.c >= candle.o;
          const bodyTop = ((high - Math.max(candle.o, candle.c)) / range) * 100;
          const bodyHeight = Math.max(1, (Math.abs(candle.c - candle.o) / range) * 100);
          const wickTop = ((high - candle.h) / range) * 100;
          const wickBottom = ((candle.l - low) / range) * 100;

          return (
            <div key={i} className="flex-1 min-w-[2px] relative" style={{ height: '100%' }}>
              {/* Wick */}
              <div className="absolute left-1/2 -translate-x-1/2 w-px bg-gray-500"
                style={{ top: `${wickTop}%`, bottom: `${wickBottom}%` }} />
              {/* Body */}
              <div className={`absolute left-0 right-0 rounded-sm ${isGreen ? 'bg-green-500' : 'bg-red-500'}`}
                style={{ top: `${bodyTop}%`, height: `${bodyHeight}%`, minHeight: '1px' }} />
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans">
      <nav className="flex items-center gap-4 p-4 border-b border-gray-700/50">
        {NAV_LINKS.map(link => (
          <Link key={link.to} to={link.to}
            className={`text-sm px-3 py-1 rounded ${link.to === '/replay' ? 'bg-cyan-800/50 text-cyan-300' : 'text-gray-400 hover:text-white'}`}>
            {link.label}
          </Link>
        ))}
      </nav>

      <main className="p-4 max-w-7xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-cyan-300">Replay Mode</h1>

        {/* Controls */}
        <div className="glass-card p-4">
          <div className="flex items-end gap-3">
            <div>
              <label className="text-xs text-gray-400">Ticker</label>
              <select value={ticker} onChange={e => setTicker(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {tickers.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400">Timeframe</label>
              <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {timeframes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <button onClick={handleLoad} disabled={loading} className="bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded px-4 py-1.5 text-xs font-bold">
              {loading ? 'Loading...' : 'Load Data'}
            </button>
          </div>
        </div>

        {loaded && state && (
          <>
            {/* Playback Controls */}
            <div className="glass-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button onClick={() => engineRef.current.stepBack()} className="bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5 text-xs">
                    &lt;&lt; Back
                  </button>
                  <button
                    onClick={() => state.isPlaying ? engineRef.current.pause() : engineRef.current.play()}
                    className={`rounded px-4 py-1.5 text-xs font-bold ${state.isPlaying ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-green-700 hover:bg-green-600'}`}>
                    {state.isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button onClick={() => engineRef.current.step()} className="bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5 text-xs">
                    Step &gt;&gt;
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-400">Speed:</label>
                  {[1000, 500, 200, 50].map(s => (
                    <button key={s} onClick={() => handleSpeedChange(s)}
                      className={`text-[10px] px-2 py-1 rounded ${speed === s ? 'bg-cyan-700 text-white' : 'bg-gray-700 text-gray-400'}`}>
                      {s >= 1000 ? `${s / 1000}s` : `${s}ms`}
                    </button>
                  ))}
                </div>

                <div className="text-xs text-gray-400">
                  Candle {state.currentIndex + 1} / {engineRef.current['candles']?.length || 0}
                </div>
              </div>

              {/* Timeline slider */}
              <input
                type="range"
                min={0}
                max={(engineRef.current['candles']?.length || 1) - 1}
                value={state.currentIndex}
                onChange={e => engineRef.current.jumpTo(Number(e.target.value))}
                className="w-full mt-2 accent-cyan-500"
              />
            </div>

            {/* Chart */}
            <div className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs text-cyan-300 font-semibold">{ticker} - {timeframe}</h3>
                <div className="text-lg font-bold text-white">${state.currentPrice.toFixed(2)}</div>
              </div>
              {renderCandles(state.visibleCandles)}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Signals */}
              <div className="glass-card p-4">
                <h3 className="text-xs text-cyan-300 font-semibold mb-2">Current Signals</h3>
                {state.signals.length === 0 ? (
                  <div className="text-xs text-gray-400">No signals at this candle</div>
                ) : (
                  <div className="space-y-1">
                    {state.signals.map((sig, i) => (
                      <div key={i} className="text-xs bg-cyan-900/30 rounded px-2 py-1 text-cyan-300">{sig}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* P&L */}
              <div className="glass-card p-4">
                <h3 className="text-xs text-cyan-300 font-semibold mb-2">Running P&L</h3>
                <div className={`text-2xl font-bold ${state.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${state.pnl.toFixed(2)}
                </div>
                {state.trades.length > 0 && (
                  <div className="mt-2 max-h-32 overflow-y-auto custom-scrollbar space-y-1">
                    {state.trades.slice(-10).map((t, i) => (
                      <div key={i} className={`text-[10px] ${t.type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                        {t.type} @ ${t.price.toFixed(2)} {t.pnl != null ? `(P&L: $${t.pnl.toFixed(2)})` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {!loaded && <div className="text-center text-gray-400 text-xs py-12">Load data to start replay</div>}
      </main>
    </div>
  );
};

export default ReplayDashboard;
