#!/usr/bin/env node
/**
 * V2 Health Check — Quick status overview
 * Usage: node scripts/v2-health.mjs [host]
 * Default host: http://localhost:3033
 */

const HOST = process.argv[2] || 'http://localhost:3033';

async function main() {
  const hr = '─'.repeat(60);

  // Fetch health + trades in parallel
  const [healthRes, tradesRes] = await Promise.allSettled([
    fetch(`${HOST}/api/health`).then(r => r.json()),
    fetch(`${HOST}/api/v2/trades`).then(r => r.json()),
  ]);

  if (healthRes.status === 'rejected') {
    console.log(`\n  ❌ Cannot reach ${HOST}\n  ${healthRes.reason.message}\n`);
    process.exit(1);
  }

  const health = healthRes.value;
  const trades = tradesRes.status === 'fulfilled' ? tradesRes.value : { open: [], closed: [] };

  // Fetch live prices for open positions
  const openTickers = (trades.open || []).map(t => t.ticker);
  const livePrices = {};
  if (openTickers.length > 0) {
    try {
      const pairs = openTickers.map(t => {
        if (t === 'BTCUSD') return 'XBTUSD';
        if (t === 'DOGEUSD') return 'XDGUSD';
        return t;
      }).join(',');
      const tickerRes = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
      const tickerData = await tickerRes.json();
      if (tickerData.result) {
        for (const [key, val] of Object.entries(tickerData.result)) {
          const price = parseFloat(val.c[0]);
          // Map Kraken pair names back to our tickers
          const mapped = key.replace('XETHZ', 'ETH').replace('XXBTZ', 'BTC').replace('XDG', 'DOGE').replace('Z', '');
          for (const t of openTickers) {
            if (key.includes(t.replace('USD', '')) || mapped.includes(t.replace('USD', ''))) {
              livePrices[t] = price;
            }
          }
        }
      }
    } catch { /* offline */ }
  }

  // Header
  const v2 = health.v2 || {};
  const fg = health.fearGreed || {};
  const ml = health.ml || {};
  const upMin = Math.floor(health.uptime / 60);

  console.log(`\n${hr}`);
  console.log(`  Phoenix V2 Health Check`);
  console.log(hr);
  console.log(`  Mode:     ${v2.mode || '?'}     Uptime: ${upMin}m     Memory: ${health.memory}MB`);
  console.log(`  Loops:    ${v2.loopCount || 0}     Loop time: ${v2.lastLoopTime || 0}ms`);
  console.log(`  ML:       ${ml.ready ? '✓ active' : '✗ disabled'}     F&G: ${fg.index ?? '?'} (${fg.classification || '?'}) ${fg.positionMultiplier || 1}x`);
  console.log(hr);

  // Scan results
  const scans = v2.lastScanReasons || [];
  const passCount = scans.filter(s => s.reason?.startsWith('PASS')).length;
  console.log(`  Scan: ${passCount}/${scans.length} pass`);
  for (const s of scans) {
    const passed = s.reason?.startsWith('PASS');
    const regime = s.reason?.match(/regime=(\w+)/)?.[1] || '';
    const atr = s.reason?.match(/ATR%=([\d.]+)/)?.[1] || '';
    const mark = passed ? '  ✓' : '  ✗';
    if (passed) {
      console.log(`${mark} ${s.ticker.padEnd(10)} ${regime.padEnd(12)} ATR=${atr}%`);
    } else {
      console.log(`${mark} ${s.ticker.padEnd(10)} ${s.reason}`);
    }
  }

  // Pipeline stats
  console.log(hr);
  console.log(`  Pipeline rejections (cumulative):`);
  console.log(`    Scan:   ${v2.rejectedByScan || 0}`);
  console.log(`    Signal: ${v2.rejectedBySignal || 0}`);
  console.log(`    Risk:   ${v2.rejectedByRisk || 0}`);

  // Open positions
  const open = trades.open || [];
  console.log(hr);
  console.log(`  Open Positions: ${open.length}/${v2.openPositions || open.length}`);
  if (open.length > 0) {
    console.log(`  ${'Ticker'.padEnd(10)} ${'Entry'.padStart(10)} ${'Now'.padStart(10)} ${'PnL'.padStart(8)} ${'To TP'.padStart(8)} ${'To SL'.padStart(8)} ${'Age'.padStart(6)}`);
    for (const t of open) {
      const now = livePrices[t.ticker] || t.entryPrice;
      const pnl = ((now - t.entryPrice) / t.entryPrice * 100);
      const toTp = ((t.takeProfitTarget - now) / now * 100);
      const toSl = ((now - t.currentStop) / now * 100);
      const ageMin = Math.floor((Date.now() - t.entryTime) / 60000);
      const ageStr = ageMin >= 60 ? `${Math.floor(ageMin/60)}h${ageMin%60}m` : `${ageMin}m`;
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
      console.log(`  ${t.ticker.padEnd(10)} ${('$'+t.entryPrice.toFixed(2)).padStart(10)} ${('$'+now.toFixed(2)).padStart(10)} ${pnlStr.padStart(8)} ${('+'+toTp.toFixed(2)+'%').padStart(8)} ${('-'+toSl.toFixed(2)+'%').padStart(8)} ${ageStr.padStart(6)}`);
    }
  }

  // Closed trades
  const closed = trades.closed || [];
  if (closed.length > 0) {
    console.log(hr);
    console.log(`  Closed Trades: ${closed.length}`);
    const wins = closed.filter(t => (t.pnlNet || 0) > 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnlNet || 0), 0);
    console.log(`  Win rate: ${closed.length > 0 ? (wins/closed.length*100).toFixed(0) : 0}% (${wins}/${closed.length})   Total PnL: $${totalPnl.toFixed(2)}`);
    // Show last 5
    const recent = closed.slice(-5);
    for (const t of recent) {
      const pnl = t.pnlNet || 0;
      const holdMin = Math.floor((t.holdDurationMs || 0) / 60000);
      console.log(`  ${t.ticker.padEnd(10)} ${t.exitReason?.padEnd(14) || ''} PnL=$${pnl.toFixed(2).padStart(7)} held=${holdMin}m`);
    }
  }

  console.log(hr);
  console.log(`  Cash: $${(v2.portfolioCash || 0).toFixed(2)}   Net PnL: $${(v2.totalPnlNet || 0).toFixed(2)}`);
  console.log(`${hr}\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
