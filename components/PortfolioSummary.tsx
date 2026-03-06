
import React from 'react';
import type { PortfolioState, TradingMode, WatchlistData } from '../types';
import AnimatedNumber from './AnimatedNumber';

interface PortfolioSummaryProps {
  portfolio: PortfolioState;
  watchlistData: WatchlistData;
  tradingMode?: TradingMode;
}

const PortfolioSummaryInner: React.FC<PortfolioSummaryProps> = ({ portfolio, watchlistData, tradingMode }) => {
  const { cash, initialBudget, positions } = portfolio;
  const isRealMode = tradingMode === 'REAL';
  
  const positionsValue = Object.values(positions).reduce((acc, position) => {
// FIX: Property 'at' does not exist on type 'Candle[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2022' or later.
    const currentPrice = watchlistData[position.ticker]?.candles?.[watchlistData[position.ticker]?.candles.length - 1]?.close ?? position.openPrice;
    return acc + (position.quantity * currentPrice);
  }, 0);

  // Include wallet holdings value (crypto in exchange wallet) for REAL mode
  const walletHoldingsValue = isRealMode && portfolio.holdings
    ? Object.values(portfolio.holdings).reduce((sum, h) => sum + (h.usdValue || 0), 0)
    : 0;

  const holdingsValue = positionsValue + walletHoldingsValue;
  const totalValue = cash + holdingsValue;
  const pnl = totalValue - initialBudget;
  const pnlPercent = initialBudget > 0 ? (pnl / initialBudget) * 100 : 0;
  const pnlColor = pnl >= 0 ? 'text-green-400' : 'text-red-400';
  const formatCurrency = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

  return (
    <div className={`glass-card p-6 animate-fade-up ${isRealMode ? 'glow-red' : ''}`}>
      <h2 className={`text-xl font-semibold mb-4 ${isRealMode ? 'text-red-400' : 'gradient-header'}`}>
        {isRealMode ? 'LIVE WALLET' : 'Portfolio Summary'}
      </h2>
      <div className="space-y-3">
        <div className="flex justify-between items-baseline"><span className="text-gray-400">Total Value</span><span className="text-2xl font-bold text-white"><AnimatedNumber value={totalValue} colorize={false} className="text-white" /></span></div>
        <div className="flex justify-between items-baseline"><span className="text-gray-400">Session P/L</span><span className="text-lg font-semibold"><AnimatedNumber value={pnl} showSign /> <span className={`text-sm ${pnlColor}`}>(<AnimatedNumber value={pnlPercent} format="percent" showSign />)</span></span></div>
        <div className="pt-3 border-t border-gray-700 space-y-2">
          <div className="flex justify-between"><span className="text-gray-400">Cash</span><span className="font-mono text-white">{formatCurrency(cash)}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Holdings Value</span><span className="font-mono text-white">{formatCurrency(holdingsValue)}</span></div>
        </div>

        {isRealMode && portfolio.holdings && Object.keys(portfolio.holdings).length > 0 && (
          <div className="pt-3 border-t border-gray-700">
            <h3 className="text-gray-400 font-semibold mb-2">Wallet Holdings ({Object.keys(portfolio.holdings).length})</h3>
            <div className="space-y-1">
              {Object.entries(portfolio.holdings).map(([currency, holding]) => (
                <div key={currency} className="flex justify-between text-xs bg-gray-900/50 p-2 rounded-md">
                  <span className="font-bold text-yellow-400">{currency}</span>
                  <span className="text-gray-300">
                    {(holding.quantity || 0).toFixed(6)} {holding.price ? `@ ${formatCurrency(holding.price)}` : ''}
                  </span>
                  <span className="font-mono text-white">{formatCurrency(holding.usdValue)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-3 border-t border-gray-700">
            <h3 className="text-gray-400 font-semibold mb-2">Open Positions ({Object.keys(positions).length})</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                {Object.keys(positions).length > 0 ? (
                    Object.values(positions).map(pos => {
// FIX: Property 'at' does not exist on type 'Candle[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2022' or later.
                        const currentPrice = watchlistData[pos.ticker]?.candles?.[watchlistData[pos.ticker]?.candles.length - 1]?.close ?? pos.openPrice;
                        const positionPnl = (currentPrice - pos.openPrice) * pos.quantity;
                        const positionPnlColor = positionPnl >= 0 ? 'text-green-500' : 'text-red-500';
                        return (
                            <div key={pos.ticker} className="text-xs bg-gray-900/50 p-2 rounded-md">
                                <div className="flex justify-between font-bold">
                                    <span>{pos.ticker}</span>
                                    <span className={positionPnlColor}>{formatCurrency(positionPnl)}</span>
                                </div>
                                <div className="flex justify-between text-gray-400">
                                    <span>Qty: {(pos.quantity || 0).toFixed(4)} @ {formatCurrency(pos.openPrice)}</span>
                                    <span>{pos.entryStrategy}</span>
                                </div>
                            </div>
                        )
                    })
                ) : (
                    <p className="text-center text-xs text-gray-500 italic py-2">No open positions.</p>
                )}
            </div>
        </div>

      </div>
    </div>
  );
};

export const PortfolioSummary = React.memo(PortfolioSummaryInner);
