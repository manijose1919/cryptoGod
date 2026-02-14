import React from 'react';
import type { Trade } from '../types';

interface TradeExplainerProps {
    trade: Trade | null;
}

export const TradeExplainer: React.FC<TradeExplainerProps> = ({ trade }) => {
    if (!trade) {
        return (
            <div className="bg-gray-800/80 backdrop-blur-md p-5 rounded-2xl border border-gray-700 shadow-xl">
                <h4 className="text-white font-bold text-lg mb-2">Last Trade</h4>
                <p className="text-gray-500 text-sm text-center py-4">No trades yet.</p>
            </div>
        );
    }

    const isWin = trade.pnl !== undefined && trade.pnl > 0;
    const pnlColor = trade.pnl !== undefined ? (isWin ? 'text-green-400' : 'text-red-400') : 'text-gray-400';

    return (
        <div className="bg-gray-800/80 backdrop-blur-md p-5 rounded-2xl border border-gray-700 shadow-xl">
            <div className="flex justify-between items-start mb-3">
                <h4 className="text-white font-bold text-lg">Last Trade</h4>
                <div className={`px-3 py-1 rounded-full text-xs font-black tracking-wider ${
                    trade.type === 'BUY' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                    {trade.type}
                </div>
            </div>
            <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                    <span className="text-gray-400">Ticker</span>
                    <span className="text-white font-bold">{trade.ticker}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-gray-400">Strategy</span>
                    <span className="text-blue-400">{trade.strategy}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-gray-400">Price</span>
                    <span className="text-white font-mono">${Number(trade.price).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-gray-400">Qty</span>
                    <span className="text-white font-mono">{Number(trade.quantity).toFixed(6)}</span>
                </div>
                {trade.pnl !== undefined && (
                    <div className="flex justify-between border-t border-gray-700 pt-2">
                        <span className="text-gray-400">P/L</span>
                        <span className={`font-bold ${pnlColor}`}>${Number(trade.pnl).toFixed(2)}</span>
                    </div>
                )}
                <div className="text-xs text-gray-500 mt-2">{trade.reason}</div>
            </div>
        </div>
    );
};
