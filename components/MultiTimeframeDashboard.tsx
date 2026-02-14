
import React from 'react';
import { TIME_FRAMES } from '../constants';
import type { MTFData } from '../types';

interface MultiTimeframeDashboardProps {
  data: MTFData;
  isLoading: boolean;
}

const TimeframePill: React.FC<{ timeframe: string; value: number }> = ({ timeframe, value }) => {
  let bgColor = 'bg-gray-700/50';
  let textColor = 'text-gray-300';
  let barColor = 'bg-gray-500';

  if (value > 80) {
    bgColor = 'bg-red-900/50';
    textColor = 'text-red-300';
    barColor = 'bg-red-500';
  } else if (value > 55) {
    bgColor = 'bg-yellow-900/50';
    textColor = 'text-yellow-300';
    barColor = 'bg-yellow-500';
  } else if (value < 20) {
    bgColor = 'bg-green-900/50';
    textColor = 'text-green-300';
    barColor = 'bg-green-500';
  } else if (value < 45) {
    bgColor = 'bg-cyan-900/50';
    textColor = 'text-cyan-300';
    barColor = 'bg-cyan-500';
  }

  return (
    <div className={`relative overflow-hidden rounded-lg p-3 text-left shadow-md transition-all duration-300 ${bgColor}`}>
      <div className="flex justify-between items-center">
        <span className={`font-mono text-sm ${textColor}`}>{timeframe}</span>
        <span className={`font-bold text-lg ${textColor}`}>{Number(value).toFixed(1)}</span>
      </div>
      <div className="w-full bg-gray-600/50 rounded-full h-1 mt-1.5">
          <div className={`${barColor} h-1 rounded-full`} style={{ width: `${value}%` }}></div>
      </div>
    </div>
  );
};


export const MultiTimeframeDashboard: React.FC<MultiTimeframeDashboardProps> = ({ data: mtfData, isLoading }) => {
  if (isLoading) {
    return <div className="text-center text-gray-500">Loading multi-timeframe data...</div>
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 sm:gap-4">
      {TIME_FRAMES.map(tf => (
        <TimeframePill key={tf} timeframe={tf} value={mtfData[tf] || 50} />
      ))}
    </div>
  );
};
