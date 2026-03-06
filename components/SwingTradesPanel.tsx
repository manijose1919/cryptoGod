import React from 'react';

interface SwingParams {
  stopLoss: number;
  takeProfit: number;
  maxHoldHours: number;
  trailingStart: number;
  trailingGiveBack: number;
}

interface SwingPosition {
  ticker: string;
  openPrice: number;
  quantity: number;
  entryTime: number;
  entryStrategy: string;
  tradeType?: string;
  swingParams?: SwingParams;
}

interface SwingTradesPanelProps {
  positions: Record<string, SwingPosition>;
  currentPrices: Record<string, number>;
}

function isSwingTrade(pos: SwingPosition): boolean {
  return pos.tradeType === 'SWING' || pos.entryStrategy === 'SWING';
}

function formatDuration(entryTime: number): string {
  const now = Date.now();
  const diffMs = now - entryTime;
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 24) {
    return `${diffHours.toFixed(1)}h`;
  }
  const diffDays = diffHours / 24;
  return `${diffDays.toFixed(1)}d`;
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function PositionCard({
  pos,
  currentPrice,
  isSwing,
}: {
  pos: SwingPosition;
  currentPrice: number;
  isSwing: boolean;
}) {
  const pnlPercent = ((currentPrice - pos.openPrice) / pos.openPrice) * 100;
  const pnlColor = pnlPercent >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="bg-gray-700 rounded-lg p-4 space-y-2">
      {/* Header: Ticker + P&L */}
      <div className="flex justify-between items-center">
        <span className="font-mono font-bold text-white text-lg">{pos.ticker}</span>
        <span className={`font-mono font-semibold text-lg ${pnlColor}`}>
          {formatPercent(pnlPercent)}
        </span>
      </div>

      {/* Price + Duration */}
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <span className="text-gray-400 block">Entry</span>
          <span className="font-mono text-white">${formatPrice(pos.openPrice)}</span>
        </div>
        <div>
          <span className="text-gray-400 block">Current</span>
          <span className="font-mono text-white">${formatPrice(currentPrice)}</span>
        </div>
        <div>
          <span className="text-gray-400 block">Hold Time</span>
          <span className="font-mono text-white">{formatDuration(pos.entryTime)}</span>
        </div>
      </div>

      {/* Swing-specific params */}
      {isSwing && pos.swingParams && (
        <div className="border-t border-gray-600 pt-2 mt-2">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-gray-400 block">Stop Loss</span>
              <span className="font-mono text-red-400">{pos.swingParams.stopLoss.toFixed(1)}%</span>
            </div>
            <div>
              <span className="text-gray-400 block">Take Profit</span>
              <span className="font-mono text-green-400">{pos.swingParams.takeProfit.toFixed(1)}%</span>
            </div>
            <div>
              <span className="text-gray-400 block">Max Hold</span>
              <span className="font-mono text-white">{pos.swingParams.maxHoldHours}h</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs mt-1">
            <div>
              <span className="text-gray-400 block">Trail Start</span>
              <span className="font-mono text-white">{pos.swingParams.trailingStart.toFixed(1)}%</span>
            </div>
            <div>
              <span className="text-gray-400 block">Trail Give-Back</span>
              <span className="font-mono text-white">{pos.swingParams.trailingGiveBack.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const SwingTradesPanel: React.FC<SwingTradesPanelProps> = ({ positions, currentPrices }) => {
  const allPositions = Object.values(positions || {});
  const swingTrades = allPositions.filter(isSwingTrade);
  const dayTrades = allPositions.filter(pos => !isSwingTrade(pos));

  if (allPositions.length === 0) {
    return (
      <div className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Positions</h2>
        <p className="text-gray-400 text-center py-8">No active positions</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-xl p-6 space-y-6">
      {/* Swing Trades Section */}
      <div>
        <h2 className="text-xl font-semibold text-white mb-3">
          Swing Trades
          <span className="ml-2 text-sm font-normal text-gray-400">({swingTrades.length})</span>
        </h2>
        {swingTrades.length > 0 ? (
          <div className="space-y-3">
            {swingTrades.map(pos => (
              <PositionCard
                key={pos.ticker}
                pos={pos}
                currentPrice={currentPrices[pos.ticker] ?? pos.openPrice}
                isSwing={true}
              />
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm py-2">No swing trades active</p>
        )}
      </div>

      {/* Day Trades Section */}
      <div>
        <h2 className="text-xl font-semibold text-white mb-3">
          Day Trades
          <span className="ml-2 text-sm font-normal text-gray-400">({dayTrades.length})</span>
        </h2>
        {dayTrades.length > 0 ? (
          <div className="space-y-3">
            {dayTrades.map(pos => (
              <PositionCard
                key={pos.ticker}
                pos={pos}
                currentPrice={currentPrices[pos.ticker] ?? pos.openPrice}
                isSwing={false}
              />
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm py-2">No day trades active</p>
        )}
      </div>
    </div>
  );
};

export default SwingTradesPanel;
