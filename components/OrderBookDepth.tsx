/**
 * OrderBookDepth — Cumulative depth chart with bid/ask visualization.
 * Uses /api/orderbook/:ticker and /api/microstructure/analyze/:ticker
 */

import { useEffect, useState } from 'react';

interface Level {
  price: number;
  volume: number;
  cumulative: number;
}

interface OrderBookData {
  bids: { price: number; volume: number }[];
  asks: { price: number; volume: number }[];
}

interface MicrostructureData {
  vpin?: number;
  bidAskImbalance?: number;
  weightedImbalance?: number;
  spreadBps?: number;
}

export default function OrderBookDepth({ ticker }: { ticker: string }) {
  const [book, setBook] = useState<OrderBookData | null>(null);
  const [micro, setMicro] = useState<MicrostructureData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      try {
        const [bookRes, microRes] = await Promise.allSettled([
          fetch(`/api/orderbook/${ticker}`).then(r => r.json()),
          fetch(`/api/microstructure/analyze/${ticker}`).then(r => r.json()),
        ]);
        if (cancelled) return;
        if (bookRes.status === 'fulfilled') setBook(bookRes.value);
        if (microRes.status === 'fulfilled') setMicro(microRes.value);
      } catch { /* ignore */ }
      setLoading(false);
    }

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ticker]);

  if (loading) return <div className="glass-card-sm p-4 text-center text-neutral">Loading order book...</div>;
  if (!book?.bids?.length) return <div className="glass-card-sm p-4 text-center text-neutral">No order book data</div>;

  // Build cumulative levels
  const bidLevels: Level[] = [];
  let cumBid = 0;
  for (const b of book.bids.slice(0, 25)) {
    cumBid += b.volume;
    bidLevels.push({ price: b.price, volume: b.volume, cumulative: cumBid });
  }

  const askLevels: Level[] = [];
  let cumAsk = 0;
  for (const a of book.asks.slice(0, 25)) {
    cumAsk += a.volume;
    askLevels.push({ price: a.price, volume: a.volume, cumulative: cumAsk });
  }

  const maxCum = Math.max(cumBid, cumAsk) || 1;
  const midPrice = book.bids[0] && book.asks[0]
    ? (book.bids[0].price + book.asks[0].price) / 2
    : 0;

  const vpinWarning = micro?.vpin != null && micro.vpin > 0.7;
  const imbalance = micro?.bidAskImbalance ?? 0;

  return (
    <div className="glass-card-sm p-4">
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-sm font-semibold text-slate-200">Order Book Depth</h4>
        <div className="flex items-center gap-2">
          {vpinWarning && (
            <span className="badge badge-red text-xs">VPIN High</span>
          )}
          <span className={`badge text-xs ${imbalance > 0.2 ? 'badge-green' : imbalance < -0.2 ? 'badge-red' : 'badge-blue'}`}>
            Imbalance: {(imbalance * 100).toFixed(0)}%
          </span>
          {micro?.spreadBps != null && (
            <span className="badge badge-yellow text-xs">
              Spread: {micro.spreadBps.toFixed(1)}bps
            </span>
          )}
        </div>
      </div>

      {/* Mid price */}
      <div className="text-center text-xs text-slate-400 mb-2">
        Mid: ${midPrice.toFixed(midPrice > 1000 ? 2 : 6)}
      </div>

      {/* Depth bars */}
      <div className="flex gap-1" style={{ height: 120 }}>
        {/* Bids (left side, reversed) */}
        <div className="flex-1 flex flex-col-reverse gap-px">
          {bidLevels.map((l, i) => (
            <div key={i} className="relative" style={{ height: `${100 / 25}%` }}>
              <div
                className="absolute right-0 top-0 bottom-0 rounded-l"
                style={{
                  width: `${(l.cumulative / maxCum) * 100}%`,
                  background: 'rgba(34, 197, 94, 0.25)',
                  borderRight: '2px solid rgba(34, 197, 94, 0.6)',
                }}
              />
            </div>
          ))}
        </div>
        {/* Asks (right side) */}
        <div className="flex-1 flex flex-col gap-px">
          {askLevels.map((l, i) => (
            <div key={i} className="relative" style={{ height: `${100 / 25}%` }}>
              <div
                className="absolute left-0 top-0 bottom-0 rounded-r"
                style={{
                  width: `${(l.cumulative / maxCum) * 100}%`,
                  background: 'rgba(239, 68, 68, 0.25)',
                  borderLeft: '2px solid rgba(239, 68, 68, 0.6)',
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-between text-xs text-slate-500 mt-2">
        <span>Bids: {cumBid.toFixed(4)}</span>
        <span>Asks: {cumAsk.toFixed(4)}</span>
      </div>
    </div>
  );
}
