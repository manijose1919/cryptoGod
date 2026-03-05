/**
 * Trade Exporter + Tax Reporting
 * Exports trades as CSV/JSON and calculates Canadian ACB (Adjusted Cost Base).
 */

import { getDb } from './database.js';

/**
 * Get trades within a date range.
 */
function getTradesInRange(from, to) {
  const db = getDb();
  let query = 'SELECT * FROM session_trades';
  const params = [];

  if (from && to) {
    query += ' WHERE time >= ? AND time <= ?';
    params.push(new Date(from).getTime(), new Date(to).getTime());
  } else if (from) {
    query += ' WHERE time >= ?';
    params.push(new Date(from).getTime());
  } else if (to) {
    query += ' WHERE time <= ?';
    params.push(new Date(to).getTime());
  }

  query += ' ORDER BY time ASC';
  return db.prepare(query).all(...params);
}

/**
 * Export trades as CSV.
 */
export function exportTradesCSV(from, to) {
  const trades = getTradesInRange(from, to);
  const headers = ['Date', 'Session', 'Type', 'Ticker', 'Price', 'Quantity', 'Notional', 'Strategy', 'Reason', 'PnL', 'Fee', 'Balance After'];
  const rows = trades.map(t => [
    new Date(t.time).toISOString(),
    t.session_id,
    t.type,
    t.ticker,
    t.price,
    t.quantity,
    t.notional,
    t.strategy || '',
    (t.reason || '').replace(/,/g, ';'), // escape commas
    t.pnl || 0,
    t.fee || 0,
    t.balance_after || 0,
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Export trades as JSON.
 */
export function exportTradesJSON(from, to) {
  return getTradesInRange(from, to);
}

/**
 * Calculate Canadian ACB (Adjusted Cost Base) tax report.
 *
 * ACB method:
 * - On BUY: ACB = previous ACB + (quantity * price + fees)
 *           ACB per unit = ACB / total shares
 * - On SELL: Capital Gain = Proceeds - (ACB per unit * qty sold) - sell fees
 *           ACB reduced by: ACB per unit * qty sold
 */
export function generateTaxReport(year) {
  const db = getDb();
  const yearStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
  const yearEnd = new Date(`${year}-12-31T23:59:59Z`).getTime();

  // Get ALL trades (not just this year) to build running ACB
  const allTrades = db.prepare(
    'SELECT * FROM session_trades ORDER BY time ASC'
  ).all();

  // Track ACB per ticker
  const acb = {}; // ticker -> { totalCost, totalQty }
  const taxEvents = []; // Only sells in the target year

  for (const trade of allTrades) {
    const ticker = trade.ticker;
    if (!acb[ticker]) acb[ticker] = { totalCost: 0, totalQty: 0 };

    if (trade.type === 'BUY') {
      const cost = trade.quantity * trade.price + (trade.fee || 0);
      acb[ticker].totalCost += cost;
      acb[ticker].totalQty += trade.quantity;
    } else if (trade.type === 'SELL') {
      const acbPerUnit = acb[ticker].totalQty > 0
        ? acb[ticker].totalCost / acb[ticker].totalQty
        : 0;

      const proceeds = trade.quantity * trade.price;
      const costBasis = acbPerUnit * trade.quantity;
      const capitalGain = proceeds - costBasis - (trade.fee || 0);

      // Record if in target year
      if (trade.time >= yearStart && trade.time <= yearEnd) {
        taxEvents.push({
          date: new Date(trade.time).toISOString().split('T')[0],
          ticker,
          quantity: trade.quantity,
          proceeds: proceeds.toFixed(2),
          acbPerUnit: acbPerUnit.toFixed(6),
          costBasis: costBasis.toFixed(2),
          fees: (trade.fee || 0).toFixed(2),
          capitalGain: capitalGain.toFixed(2),
        });
      }

      // Reduce ACB
      acb[ticker].totalCost -= costBasis;
      acb[ticker].totalQty -= trade.quantity;
      if (acb[ticker].totalQty < 0.000001) {
        acb[ticker] = { totalCost: 0, totalQty: 0 };
      }
    }
  }

  const totalGains = taxEvents.reduce((s, e) => s + parseFloat(e.capitalGain), 0);
  const totalFees = taxEvents.reduce((s, e) => s + parseFloat(e.fees), 0);
  const taxableGains = totalGains * 0.5; // Canada: 50% inclusion rate

  return {
    year,
    taxEvents,
    summary: {
      totalDispositions: taxEvents.length,
      totalCapitalGains: totalGains.toFixed(2),
      totalFees: totalFees.toFixed(2),
      taxableAmount: taxableGains.toFixed(2),
      inclusionRate: '50%',
      note: 'Canada capital gains: 50% inclusion rate for amounts up to $250,000',
    },
    currentACB: Object.fromEntries(
      Object.entries(acb)
        .filter(([, v]) => v.totalQty > 0)
        .map(([k, v]) => [k, { totalCost: v.totalCost.toFixed(2), totalQty: v.totalQty.toFixed(6), perUnit: (v.totalCost / v.totalQty).toFixed(6) }])
    ),
  };
}

/**
 * Generate CSV for tax report.
 */
export function generateTaxReportCSV(year) {
  const report = generateTaxReport(year);
  const headers = ['Date', 'Ticker', 'Quantity', 'Proceeds', 'ACB/Unit', 'Cost Basis', 'Fees', 'Capital Gain/Loss'];
  const rows = report.taxEvents.map(e => [
    e.date, e.ticker, e.quantity, e.proceeds, e.acbPerUnit, e.costBasis, e.fees, e.capitalGain
  ].join(','));

  const summary = [
    '',
    'Summary',
    `Total Dispositions,${report.summary.totalDispositions}`,
    `Total Capital Gains,$${report.summary.totalCapitalGains}`,
    `Total Fees,$${report.summary.totalFees}`,
    `Taxable Amount (50%),$${report.summary.taxableAmount}`,
  ];

  return [headers.join(','), ...rows, ...summary].join('\n');
}

export default { exportTradesCSV, exportTradesJSON, generateTaxReport, generateTaxReportCSV };
