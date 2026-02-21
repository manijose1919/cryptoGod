
import type { Trade, SystemEvent } from '../types';

function downloadCSV(filename: string, csvContent: string) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function exportTradesToCSV(trades: Trade[]) {
    const headers = ['Time', 'Type', 'Ticker', 'Strategy', 'Price', 'Quantity', 'PnL', 'Reason'];
    const rows = trades.map(t => [
        new Date(t.time).toISOString(),
        t.type,
        t.ticker,
        t.strategy,
        t.price.toFixed(2),
        t.quantity.toFixed(6),
        t.pnl !== undefined ? t.pnl.toFixed(2) : '',
        escapeCSV(t.reason || ''),
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadCSV(`trades_${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

export function exportLogsToCSV(logs: SystemEvent[]) {
    const headers = ['Time', 'Type', 'Message'];
    const rows = logs.map(l => [
        new Date(l.time).toISOString(),
        l.type,
        escapeCSV(l.message),
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadCSV(`logs_${new Date().toISOString().slice(0, 10)}.csv`, csv);
}
