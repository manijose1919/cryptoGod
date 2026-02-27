const BASE='http://localhost:3033/api/training';
async function go() {
  const mod = await (await fetch(BASE+'/modify-seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    seedId: 'mod_1772140204357_36785c3c',
    exitParams: { stopLoss: -0.035, takeProfit: 0.12, maxHold: 168, trailingStart: 0.08, trailingGiveBack: 0.20 },
    regimeExitOverrides: {
      UP: { takeProfit: 0.25, stopLoss: -0.06 },
      STRONG_UP: { takeProfit: 0.30, stopLoss: -0.08 },
      SIDEWAYS: { takeProfit: 0.04, stopLoss: -0.02 },
    },
  })})).json();
  console.log('Modified:', mod);

  const start = await (await fetch(BASE+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    tickers: ['BTCUSD'], initialCash: 1000, strategyFilter: ['TREND'], selectivity: 'normal', seedRunId: mod.runId
  })})).json();
  console.log('Started:', start.runId);

  for (let i=0;i<60;i++) {
    await new Promise(r=>setTimeout(r,2000));
    const st = await (await fetch(BASE+'/status')).json();
    if (!st.active) { console.log('Done:', JSON.stringify(st.stats)); break; }
  }
}
go().catch(e=>console.error(e));
