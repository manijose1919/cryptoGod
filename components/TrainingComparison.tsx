
import { useState, useEffect } from 'react';
import * as api from '../services/historicalTrainingService';
import type { TrainingRun } from '../types';

interface ComparisonMetric {
    label: string;
    key: keyof TrainingRun;
    format: (v: any) => string;
    higherIsBetter: boolean;
}

const METRICS: ComparisonMetric[] = [
    { label: 'Total PnL', key: 'total_pnl', format: (v: number) => `$${v?.toFixed(2) ?? 'N/A'}`, higherIsBetter: true },
    { label: 'Final Equity', key: 'final_equity', format: (v: number) => `$${v?.toFixed(2) ?? 'N/A'}`, higherIsBetter: true },
    { label: 'Win Rate', key: 'win_rate', format: (v: number) => `${v?.toFixed(1) ?? 'N/A'}%`, higherIsBetter: true },
    { label: 'Total Trades', key: 'total_trades', format: (v: number) => `${v ?? 'N/A'}`, higherIsBetter: true },
    { label: 'Sharpe Ratio', key: 'sharpe_ratio', format: (v: number) => `${v?.toFixed(2) ?? 'N/A'}`, higherIsBetter: true },
    { label: 'Max Drawdown', key: 'max_drawdown', format: (v: number) => `${v?.toFixed(1) ?? 'N/A'}%`, higherIsBetter: false },
];

export function TrainingComparison() {
    const [runs, setRuns] = useState<TrainingRun[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        api.getTrainingRuns().then(r => setRuns(r)).catch(() => {});
    }, []);

    const completedRuns = runs.filter(r => r.status === 'completed');
    const selectedRuns = completedRuns.filter(r => selectedIds.has(r.run_id));

    const toggleRun = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else if (next.size < 5) next.add(id);
            return next;
        });
    };

    const getBestValue = (metric: ComparisonMetric): number | null => {
        const values = selectedRuns.map(r => (r as any)[metric.key]).filter((v: any) => v != null);
        if (values.length === 0) return null;
        return metric.higherIsBetter ? Math.max(...values) : Math.min(...values);
    };

    return (
        <div className="glass-card p-5 space-y-4">
            <h2 className="text-lg font-semibold text-cyan-300">Run Comparison</h2>

            {completedRuns.length === 0 ? (
                <p className="text-sm text-gray-400">No completed training runs to compare.</p>
            ) : (
                <>
                    <div className="flex flex-wrap gap-2">
                        {completedRuns.slice(0, 10).map(run => (
                            <button
                                key={run.run_id}
                                onClick={() => toggleRun(run.run_id)}
                                className={`text-xs px-2 py-1 rounded border transition-colors ${
                                    selectedIds.has(run.run_id)
                                        ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
                                        : 'border-gray-600 text-gray-400 hover:border-gray-400'
                                }`}
                            >
                                {run.run_id.slice(6, 18)}... ({run.total_trades}t, {run.win_rate?.toFixed(0)}%)
                            </button>
                        ))}
                    </div>

                    {selectedRuns.length >= 2 && (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-gray-700">
                                        <th className="text-left py-2 px-3 text-gray-400">Metric</th>
                                        {selectedRuns.map(run => (
                                            <th key={run.run_id} className="text-right py-2 px-3 text-gray-400 min-w-[100px]">
                                                {run.run_id.slice(6, 14)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {METRICS.map(metric => {
                                        const best = getBestValue(metric);
                                        return (
                                            <tr key={metric.key} className="border-b border-gray-800">
                                                <td className="py-2 px-3 text-gray-300">{metric.label}</td>
                                                {selectedRuns.map(run => {
                                                    const val = (run as any)[metric.key];
                                                    const isBest = val != null && val === best;
                                                    return (
                                                        <td key={run.run_id} className={`py-2 px-3 text-right font-mono ${isBest ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
                                                            {metric.format(val)}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {selectedRuns.length < 2 && selectedRuns.length > 0 && (
                        <p className="text-xs text-gray-500">Select at least 2 runs to compare.</p>
                    )}
                </>
            )}
        </div>
    );
}
