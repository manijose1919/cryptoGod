/**
 * TickerTape — Bloomberg-style scrolling price ticker.
 * Fetches live prices from WS cache and displays with change %.
 */

import { useState, useEffect } from 'react';

interface TickerData {
  symbol: string;
  price: number;
  change: number;
}

const TICKERS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD', 'BNBUSD'];

export default function TickerTape() {
  const [data, setData] = useState<TickerData[]>([]);

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/instruments');
        if (!res.ok) return;
        const instruments = await res.json();
        const items: TickerData[] = [];
        for (const ticker of TICKERS) {
          const inst = instruments.find((i: { instrument_name: string; last?: number; change24h?: number }) =>
            i.instrument_name === ticker
          );
          if (inst?.last) {
            items.push({
              symbol: ticker.replace('USD', ''),
              price: inst.last,
              change: inst.change24h || 0,
            });
          }
        }
        if (items.length > 0) setData(items);
      } catch { /* silent */ }
    };
    fetchPrices();
    const iv = setInterval(fetchPrices, 10000);
    return () => clearInterval(iv);
  }, []);

  if (data.length === 0) return null;

  const fmt = (n: number) => n >= 1000 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toFixed(4);

  // Duplicate for infinite scroll illusion
  const items = [...data, ...data];

  return (
    <div className="ticker-tape">
      <div className="ticker-tape-inner">
        {items.map((t, i) => (
          <div key={`${t.symbol}-${i}`} className="ticker-item">
            <span className="ticker-symbol">{t.symbol}</span>
            <span className="ticker-price">{fmt(t.price)}</span>
            <span className={t.change >= 0 ? 'ticker-change-up' : 'ticker-change-down'}>
              {t.change >= 0 ? '+' : ''}{t.change.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
